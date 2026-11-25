import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { createD1Adapter } from './support/d1.js';
import {
  getUserFeishuWebhook,
  normalizeFeishuWebhookUrl,
  notifyFeishuCall,
  notifyFeishuIfOffline,
  saveUserFeishuWebhook
} from '../server/src/integrations/feishu.ts';
import { createUnreadProjection } from '../server/src/unread-projection.js';
import { CallService } from '../server/calls/service.ts';

const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/7f3d2393-e21e-4b38-9a45-ed61dbd689eb';
const keyring = JSON.stringify({
  activeKeyId: 'test',
  keys: { test: Buffer.alloc(32, 9).toString('base64') }
});

async function fixture() {
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  database.run(
    "INSERT INTO users (id, username, display_name, password_hash, password_salt) VALUES (1, 'alice', 'Alice', 'h', 's')"
  );
  const env = {
    DB: createD1Adapter(database),
    ENCRYPTION_KEYRING: keyring,
    CONFIG: { publicOrigin: 'http://127.0.0.1:8787' },
    HUB: { isUserOnline: () => false }
  };
  return { database, env };
}

test('Feishu webhook URL only accepts the official bot endpoint', () => {
  assert.equal(normalizeFeishuWebhookUrl(WEBHOOK), WEBHOOK);
  assert.equal(normalizeFeishuWebhookUrl(''), '');
  for (const invalid of [
    'http://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh',
    'https://example.com/open-apis/bot/v2/hook/abcdefgh',
    'https://open.feishu.cn/other/abcdefgh',
    'https://open.feishu.cn/open-apis/bot/v2/hook/abc?x=1'
  ]) {
    assert.throws(() => normalizeFeishuWebhookUrl(invalid), /飞书 Webhook|open\.feishu\.cn/);
  }
});

test('Feishu webhook is encrypted at rest and round-trips', async () => {
  const { database, env } = await fixture();
  await saveUserFeishuWebhook(env, 1, { webhookUrl: WEBHOOK, enabled: true });
  const row = database.exec('SELECT webhook_ciphertext, enabled FROM user_feishu_webhooks WHERE user_id = 1')[0].values[0];
  assert.equal(String(row[0]).includes('7f3d2393'), false);
  assert.equal(Number(row[1]), 1);
  assert.deepEqual(await getUserFeishuWebhook(env, 1), { enabled: true, webhookUrl: WEBHOOK });
});

test('Feishu sends only DMs and @mentions, and only while offline', async () => {
  const { env } = await fixture();
  await saveUserFeishuWebhook(env, 1, { webhookUrl: WEBHOOK, enabled: true });
  const sent = [];
  const fetchImpl = async (url, options) => {
    sent.push({ url, body: JSON.parse(String(options.body)) });
    return Response.json({ code: 0, msg: 'success' });
  };
  const message = {
    id: 10,
    content: 'hello there',
    sender: { kind: 'local', displayName: 'Bob' },
    mentionUserIds: []
  };

  assert.equal(
    await notifyFeishuIfOffline({ ...env, HUB: { isUserOnline: () => true } }, {
      userId: 1,
      room: { id: 3, kind: 'dm', name: 'Bob' },
      message
    }, { fetchImpl }),
    false
  );
  assert.equal(sent.length, 0);

  assert.equal(
    await notifyFeishuIfOffline(env, {
      userId: 1,
      room: { id: 4, kind: 'private', name: 'Team' },
      message
    }, { fetchImpl }),
    false
  );
  assert.equal(sent.length, 0);

  assert.equal(
    await notifyFeishuIfOffline(env, {
      userId: 1,
      room: { id: 3, kind: 'dm', name: 'Bob' },
      message
    }, { fetchImpl }),
    true
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, WEBHOOK);
  assert.match(sent[0].body.content.text, /私聊消息/);
  assert.match(sent[0].body.content.text, /Bob/);
  assert.match(sent[0].body.content.text, /hello there/);
  assert.doesNotMatch(sent[0].body.content.text, /https?:\/\//);

  assert.equal(
    await notifyFeishuIfOffline(env, {
      userId: 1,
      room: { id: 4, kind: 'private', name: 'Team' },
      message: { ...message, mentionUserIds: [1] }
    }, { fetchImpl }),
    true
  );
  assert.equal(sent.length, 2);
  assert.match(sent[1].body.content.text, /群组 @ 提醒/);
});

test('disabled Feishu webhook does not send', async () => {
  const { env } = await fixture();
  await saveUserFeishuWebhook(env, 1, { webhookUrl: WEBHOOK, enabled: false });
  let called = false;
  const result = await notifyFeishuIfOffline(env, {
    userId: 1,
    room: { id: 3, kind: 'dm', name: 'Bob' },
    message: { id: 1, content: 'hi', sender: { displayName: 'Bob' }, mentionUserIds: [] }
  }, { fetchImpl: async () => { called = true; return Response.json({ code: 0 }); } });
  assert.equal(result, false);
  assert.equal(called, false);
});

test('unread projection invokes the Feishu notifier for each recipient', async () => {
  const calls = [];
  const project = createUnreadProjection({
    listMemberIds: async () => [1, 2],
    countUnread: async () => 1,
    countMentions: async () => 1,
    notifyInbox: async () => {},
    notifyFeishu: async (_env, payload) => { calls.push(payload.userId); },
    logFailure: () => {}
  });
  await project({ DB: {} }, {
    room: { id: 3, kind: 'dm', name: 'Bob' },
    senderId: 1,
    message: { id: 5, content: 'hi', sender: { displayName: 'Alice' }, mentionUserIds: [] }
  });
  assert.deepEqual(calls, [2]);
});

test('every incoming DM voice call sends a Feishu reminder to the callee', async () => {
  const { env } = await fixture();
  await saveUserFeishuWebhook(env, 1, { webhookUrl: WEBHOOK, enabled: true });
  const sent = [];
  const fetchImpl = async (url, options) => {
    sent.push({ url, body: JSON.parse(String(options.body)) });
    return Response.json({ code: 0 });
  };
  assert.equal(
    await notifyFeishuCall({ ...env, HUB: { isUserOnline: () => true } }, {
      userId: 1,
      callerName: 'Bob',
      roomId: 3
    }, { fetchImpl }),
    true
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.content.text, /语音通话来电/);
  assert.match(sent[0].body.content.text, /Bob/);
  assert.doesNotMatch(sent[0].body.content.text, /https?:\/\//);
});

test('call start invokes the call notifier once for the callee', async () => {
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  database.run(
    "INSERT INTO users (id, username, display_name, password_hash, password_salt) VALUES (1, 'alice', 'Alice', 'h', 's'), (2, 'bob', 'Bob', 'h', 's')"
  );
  database.run("INSERT INTO channels (id, name, kind, dm_key, created_by) VALUES (4, 'dm', 'dm', '1:2', 1)");
  database.run('INSERT INTO channel_members (channel_id, user_id) VALUES (4, 1), (4, 2)');
  const notified = [];
  const env = {
    DB: createD1Adapter(database),
    ENCRYPTION_KEYRING: keyring,
    CONFIG: { publicOrigin: 'http://127.0.0.1:8787' },
    HUB: { notifyUser() {}, isUserOnline: () => true }
  };
  const service = new CallService({
    notifyCall: async (_env, payload) => { notified.push(payload); }
  });
  await service.action(env, 4, 1, {
    type: 'start',
    callId: '00000000-0000-0000-0000-000000000001',
    clientId: '00000000-0000-0000-0000-000000000002',
    mode: 'auto'
  });
  assert.deepEqual(notified, [{ userId: 2, callerName: 'Alice', roomId: 4 }]);
});
