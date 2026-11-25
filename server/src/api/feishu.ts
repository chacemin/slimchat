import {
  getUserFeishuWebhook,
  normalizeFeishuWebhookUrl,
  saveUserFeishuWebhook,
  sendFeishuText
} from '../integrations/feishu.ts';
import { errorResponse, parseJsonRequest } from '../utils.js';

export function registerFeishuRoutes(app) {
  app.get('/api/me/feishu-webhook', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(await getUserFeishuWebhook(c.env, c.get('session').userId));
  });

  app.put('/api/me/feishu-webhook', async (c) => {
    const payload = await parseJsonRequest(c.req.raw);
    if (Object.keys(payload).some((key) => !['webhookUrl', 'enabled'].includes(key))) {
      return errorResponse('请求包含不允许修改的字段');
    }
    if (typeof payload.webhookUrl !== 'string') {
      return errorResponse('请填写飞书 Webhook 链接');
    }
    const enabled = payload.enabled === undefined ? true : payload.enabled;
    const config = await saveUserFeishuWebhook(c.env, c.get('session').userId, {
      webhookUrl: payload.webhookUrl,
      enabled
    });
    return c.json(config);
  });

  app.post('/api/me/feishu-webhook/test', async (c) => {
    const payload = await parseJsonRequest(c.req.raw);
    if (Object.keys(payload).some((key) => !['webhookUrl'].includes(key))) {
      return errorResponse('请求包含不允许修改的字段');
    }
    const userId = c.get('session').userId;
    let webhookUrl = String(payload.webhookUrl || '').trim();
    if (!webhookUrl) {
      webhookUrl = (await getUserFeishuWebhook(c.env, userId)).webhookUrl;
    }
    if (!webhookUrl) {
      return errorResponse('请先填写并保存飞书 Webhook 链接');
    }
    const normalized = normalizeFeishuWebhookUrl(webhookUrl);
    try {
      await sendFeishuText(
        normalized,
        'SlimChat 飞书通知测试：如果你收到这条消息，说明 Webhook 配置可用。'
      );
      return c.json({ ok: true });
    } catch {
      return errorResponse('飞书 Webhook 发送失败，请检查链接或机器人配置', 502);
    }
  });
}
