import { decryptSecretValue, encryptSecretValue } from '../encryption.js';
import { ApiError } from '../errors.js';

const FEISHU_HOOK_PATH = /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{8,200}$/;
const MAX_PREVIEW = 300;

function webhookContext(userId: number) {
  return `feishu-webhook:${Number(userId)}`;
}

/** Only the official Feishu bot endpoint is accepted, which also blocks SSRF. */
export function normalizeFeishuWebhookUrl(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError('飞书 Webhook 链接格式无效', 400, 'invalid_feishu_webhook');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'open.feishu.cn' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !FEISHU_HOOK_PATH.test(url.pathname)
  ) {
    throw new ApiError('请填写 open.feishu.cn 的机器人 Webhook 链接', 400, 'invalid_feishu_webhook');
  }
  return `${url.origin}${url.pathname}`;
}

export async function getUserFeishuWebhook(env: any, userId: number) {
  const row = await env.DB.prepare(
    'SELECT webhook_ciphertext, enabled FROM user_feishu_webhooks WHERE user_id = ?'
  )
    .bind(Number(userId))
    .first<{ webhook_ciphertext: string; enabled: number }>();
  if (!row) return { enabled: false, webhookUrl: '' };
  let webhookUrl = '';
  try {
    webhookUrl = await decryptSecretValue(env, row.webhook_ciphertext, webhookContext(userId));
  } catch {
    console.warn(JSON.stringify({ message: 'feishu webhook decrypt failed', userId: Number(userId) }));
  }
  return { enabled: Boolean(Number(row.enabled)) && Boolean(webhookUrl), webhookUrl };
}

export async function saveUserFeishuWebhook(
  env: any,
  userId: number,
  { webhookUrl, enabled = true }: { webhookUrl: unknown; enabled?: unknown }
) {
  const normalized = normalizeFeishuWebhookUrl(webhookUrl);
  if (!normalized) {
    await env.DB.prepare('DELETE FROM user_feishu_webhooks WHERE user_id = ?').bind(Number(userId)).run();
    return { enabled: false, webhookUrl: '' };
  }
  if (typeof enabled !== 'boolean') {
    throw new ApiError('飞书通知开关无效', 400, 'invalid_feishu_enabled');
  }
  const ciphertext = await encryptSecretValue(env, normalized, webhookContext(userId));
  await env.DB.prepare(
    `INSERT INTO user_feishu_webhooks (user_id, webhook_ciphertext, enabled)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       webhook_ciphertext = excluded.webhook_ciphertext,
       enabled = excluded.enabled,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(Number(userId), ciphertext, enabled ? 1 : 0)
    .run();
  return { enabled, webhookUrl: normalized };
}

export async function sendFeishuText(
  webhookUrl: string,
  text: string,
  { fetchImpl = fetch, timeoutMs = 8000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
) {
  const normalized = normalizeFeishuWebhookUrl(webhookUrl);
  const response = await fetchImpl(normalized, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`feishu_http_${response.status}`);
  }
  const payload = await response.json().catch(() => ({}));
  const code = Number(payload?.code ?? payload?.StatusCode);
  if (Number.isFinite(code) && code !== 0) {
    throw new Error(`feishu_code_${code}`);
  }
  return true;
}

function notificationText(room: any, message: any) {
  const senderName =
    message?.sender?.displayName || message?.sender?.username || '有成员';
  const content = String(message?.content || '').trim();
  const preview = (content || (message?.attachment ? '[附件]' : '')).slice(0, MAX_PREVIEW);
  const target =
    room.kind === 'dm'
      ? '私聊消息'
      : `群组 @ 提醒 · ${room.name || '未命名群组'}`;
  return [`SlimChat ${target}`, `来自：${senderName}`, `内容：${preview || '（无文本）'}`].join('\n');
}

/**
 * Sends Feishu notifications only when:
 * 1. the recipient has no WebSocket client online,
 * 2. the message is a DM or the recipient is explicitly mentioned,
 * 3. the recipient enabled a webhook.
 */
export async function notifyFeishuIfOffline(
  env: any,
  { userId, room, message }: { userId: number; room: any; message: any },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
) {
  const mentioned = (message?.mentionUserIds || []).includes(Number(userId));
  if (room.kind !== 'dm' && !mentioned) return false;

  const online = Boolean(env.HUB?.isUserOnline?.(Number(userId)));
  if (online) return false;

  const config = await getUserFeishuWebhook(env, userId);
  if (!config.enabled || !config.webhookUrl) return false;

  await sendFeishuText(config.webhookUrl, notificationText(room, message), options);
  return true;
}
/**
 * Call reminders are intentionally not gated by online status: a ringing call is
 * time-sensitive, so every incoming DM call sends one Feishu reminder to the callee.
 */
export async function notifyFeishuCall(
  env: any,
  { userId, callerName }: { userId: number; callerName?: string; roomId?: number },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
) {
  const config = await getUserFeishuWebhook(env, userId);
  if (!config.enabled || !config.webhookUrl) return false;

  const lines = [
    'SlimChat 语音通话来电',
    `来自：${callerName || '有成员'}`,
    '请尽快接听，避免漏接。'
  ];

  await sendFeishuText(config.webhookUrl, lines.join('\n'), options);
  return true;
}
