import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { createD1Adapter } from './support/d1.js';
import { authorizeVoiceCall } from '../server/src/calls/access.ts';
import { generateCallIceServers } from '../server/src/calls/turn.ts';
import { callExpired, nextCallState } from '../server/src/calls/state.ts';
import { createVoiceCallClient } from '../frontend/src/calls/client.ts';
import { CALL_RING_MS, CALL_MAX_MS } from '../shared/voice-call.ts';

const callId = '00000000-0000-0000-0000-000000000001';
const callerClient = '00000000-0000-0000-0000-000000000002';
const calleeClient = '00000000-0000-0000-0000-000000000003';
const start = { type: 'start', callId, clientId: callerClient, mode: 'auto' };
const ringing = () => nextCallState(null, start, 1, 2, 4, 100);
const accepted = () => nextCallState(ringing(), { type: 'accept', callId, clientId: calleeClient, mode: 'auto' }, 2, 1, 4, 200);

test('call state defaults to P2P and only the callee can accept once', () => {
  assert.equal(ringing().mode, 'auto');
  assert.equal(accepted().calleeClient, calleeClient);
  assert.equal(accepted().revision, 1);
  assert.throws(() => nextCallState(ringing(), { type: 'accept', callId, clientId: callerClient, mode: 'auto' }, 1, 2, 4, 200), /处理/);
  assert.throws(() => nextCallState(accepted(), { type: 'accept', callId, clientId: calleeClient, mode: 'auto' }, 2, 1, 4, 200), /处理/);
});

test('busy calls, outsiders, and other tabs cannot take over a call', () => {
  assert.throws(() => nextCallState(ringing(), start, 1, 2, 4, 200), /正在通话/);
  assert.throws(() => nextCallState(accepted(), { type: 'hangup', callId, clientId: callerClient }, 3, 1, 4, 200), /双方/);
  assert.throws(() => nextCallState(accepted(), { type: 'hangup', callId, clientId: callerClient }, 2, 1, 4, 200), /其他窗口/);
});

test('only caller sends offers, only callee sends answers, and old revisions are refused', () => {
  const offer = { type: 'offer', callId, clientId: callerClient, revision: 1, sdp: 'v=0\r\n' };
  assert.equal(nextCallState(accepted(), offer, 1, 2, 4, 200).revision, 1);
  assert.throws(() => nextCallState(accepted(), { ...offer, clientId: calleeClient }, 2, 1, 4, 200), /信令/);
  assert.throws(() => nextCallState(accepted(), { ...offer, revision: 0 }, 1, 2, 4, 200), /更新/);
  assert.throws(() => nextCallState(accepted(), { ...offer, sdp: 'bad' }, 1, 2, 4, 200), /信令/);
});

test('relay switches advance negotiation revision and stale actions cannot end a new call', () => {
  const next = nextCallState(accepted(), { type: 'restart', callId, clientId: calleeClient, mode: 'relay' }, 2, 1, 4, 200);
  assert.equal(next.mode, 'relay');
  assert.equal(next.revision, 2);
  assert.equal(nextCallState(next, { type: 'restart', callId, clientId: callerClient, mode: 'relay' }, 1, 2, 4, 200), next);
  assert.equal(nextCallState(accepted(), { type: 'hangup', callId, clientId: calleeClient }, 2, 1, 4, 200), null);
  assert.throws(() => nextCallState(accepted(), { type: 'hangup', callId: callerClient, clientId: calleeClient }, 2, 1, 4, 200), /结束/);
});

test('call timeouts cover ringing, missing heartbeats, and maximum duration', () => {
  assert.equal(callExpired(ringing(), 100 + CALL_RING_MS), true);
  assert.equal(callExpired(accepted(), 201), false);
  assert.equal(callExpired(accepted(), 75_200), true);
  const call = { ...accepted(), callerSeen: CALL_MAX_MS + 100, calleeSeen: CALL_MAX_MS + 100 };
  assert.equal(callExpired(call, CALL_MAX_MS + 100), true);
});

test('local coturn credentials stay in-process and support a shared secret', async () => {
  const staticIce = await generateCallIceServers({ CONFIG: {
    turnUrl: 'turn:127.0.0.1:3478', turnUsername: 'local', turnCredential: 'secret'
  } });
  assert.deepEqual(staticIce.iceServers, [
    { urls: 'turn:127.0.0.1:3478', username: 'local', credential: 'secret' }
  ]);
  const sharedIce = await generateCallIceServers({ CONFIG: {
    turnUrl: 'turns:127.0.0.1:5349', turnSharedSecret: 'shared-secret'
  } });
  assert.match(sharedIce.iceServers[0].username, /^\d+:slimchat$/);
  assert.ok(sharedIce.iceServers[0].credential);
  assert.deepEqual((await generateCallIceServers({ CONFIG: {} })).iceServers, []);
});

test('call authorization excludes groups, nonparticipants, disabled peers, and either block direction', async () => {
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  database.run("INSERT INTO users(id,username,display_name,password_hash,password_salt) VALUES (1,'alice','Alice','h','s'),(2,'bob','Bob','h','s'),(3,'admin','Admin','h','s')");
  database.run("INSERT INTO channels(id,name,kind,dm_key,created_by) VALUES (10,'dm','dm','1:2',1)");
  database.run('INSERT INTO channel_members(channel_id,user_id) VALUES(10,1),(10,2)');
  const db = createD1Adapter(database);
  assert.equal((await authorizeVoiceCall(db, 10, 1)).peerId, 2);
  await assert.rejects(authorizeVoiceCall(db, 10, 3), /双方/);
  await assert.rejects(authorizeVoiceCall(db, 1, 1), /双方/);
  database.run('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES(2,1)');
  await assert.rejects(authorizeVoiceCall(db, 10, 1), /拉黑/);
  await assert.rejects(authorizeVoiceCall(db, 10, 2), /拉黑/);
  database.run('DELETE FROM user_blocks');
  database.run('UPDATE users SET is_disabled=1 WHERE id=2');
  await assert.rejects(authorizeVoiceCall(db, 10, 1), /不可用/);
  database.close();
});

function clientHarness(options = {}) {
  const states = [];
  const actions = [];
  const peers = [];
  const errors = [];
  const track = { stopped: false, enabled: true, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const api = { callConfig: async () => ({ turnAvailable: true }), callIce: async () => ({ iceServers: [{ urls: 'turn:relay' }] }), callAction: async (_id, body) => { actions.push(body); } };
  const createPeer = config => {
    const peer = { config, connectionState: 'new', remoteDescription: null, addTrack() {}, close() { this.closed = true; }, createOffer: async () => ({ type: 'offer', sdp: 'v=0' }), createAnswer: async () => ({ type: 'answer', sdp: 'v=0' }), async setLocalDescription(value) { this.localDescription = value; }, async setRemoteDescription(value) { this.remoteDescription = value; }, addIceCandidate: async () => {} };
    peers.push(peer); return peer;
  };
  const client = createVoiceCallClient({ api, userId: 1, clientId: callerClient, getMedia: async () => stream, createPeer, onChange: value => states.push(value), onError: error => errors.push(error), ...options });
  return { client, states, actions, peers, errors, track, stream };
}
const room = { id: 4, kind: 'dm', name: 'Bob', otherUser: { id: 2 } };

test('browser client starts with STUN only, negotiates audio, switches relay and releases microphone', async () => {
  const h = clientHarness();
  try {
    await h.client.start(room, 'auto');
    const current = h.states.at(-1).call;
    const event = { ...current, type: 'call_negotiate', callerClient, calleeClient, revision: 1, mode: 'auto' };
    await h.client.receive(event);
    assert.equal(h.peers[0].config.iceTransportPolicy, 'all');
    assert.equal(h.peers[0].config.iceServers.some(server => String(server.urls).startsWith('turn:')), false);
    await h.client.switchMode('relay');
    assert.equal(h.actions.at(-1).type, 'restart');
    await h.client.receive({ ...event, revision: 2, mode: 'relay' });
    assert.equal(h.peers[0].closed, true);
    assert.equal(h.peers[1].config.iceTransportPolicy, 'relay');
    h.peers[1].connectionState = 'connected'; h.peers[1].onconnectionstatechange();
    assert.equal(h.states.at(-1).route, 'TURN');
    h.client.toggleMute(); assert.equal(h.track.enabled, false);
    await h.client.hangup();
    assert.equal(h.track.stopped, true);
    assert.equal(h.states.at(-1).phase, 'idle');
  } finally { h.client.reset(); }
});

test('a cancelled microphone prompt releases its late stream without initiating a call', async () => {
  let resolveMedia;
  const h = clientHarness({ getMedia: () => new Promise(resolve => { resolveMedia = resolve; }) });
  const pending = h.client.start(room, 'auto');
  await new Promise(resolve => setTimeout(resolve, 0));
  await h.client.hangup();
  resolveMedia(h.stream);
  await pending;
  assert.equal(h.track.stopped, true);
  assert.equal(h.actions.some(action => action.type === 'start'), false);
});

test('incoming calls require acceptance, and another tab accepting dismisses the local prompt', async () => {
  const h = clientHarness({ userId: 2, clientId: calleeClient });
  await h.client.receive({ type: 'call_invite', callId, roomId: 4, callerId: 1, calleeId: 2, mode: 'auto', users: [{ id: 1, name: 'Alice' }], expiresAt: Date.now() + CALL_RING_MS });
  assert.equal(h.states.at(-1).phase, 'incoming');
  assert.equal(h.peers.length, 0);
  await h.client.receive({ type: 'call_negotiate', callId, callerId: 1, calleeId: 2, callerClient, calleeClient: callerClient, revision: 1, mode: 'auto' });
  assert.equal(h.states.at(-1).phase, 'idle');
  h.client.reset();
});

test('failed P2P starts one automatic relay renegotiation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = clientHarness();
  try {
    await h.client.start(room, 'auto');
    await h.client.receive({ ...h.states.at(-1).call, type: 'call_negotiate', callerClient, calleeClient, revision: 1, mode: 'auto' });
    context.mock.timers.tick(12_000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.ok(h.actions.some(action => action.type === 'restart' && action.mode === 'relay'));
  } finally { h.client.reset(); }
});
