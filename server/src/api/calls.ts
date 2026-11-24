import { authorizeVoiceCall } from '../calls/access.ts';
import { turnConfigured } from '../calls/turn.ts';
import { CALL_STUN } from '../../../shared/voice-call.ts';
import { parseJsonRequest } from '../utils.js';

export function registerCallRoutes(app) {
  app.get('/api/calls/:roomId/config', async (c) => {
    await authorizeVoiceCall(c.env.DB, Number(c.req.param('roomId')), c.get('session').userId);
    return c.json({ iceServers: CALL_STUN, turnAvailable: turnConfigured(c.env) });
  });

  app.post('/api/calls/:roomId/action', async (c) => {
    const roomId = Number(c.req.param('roomId'));
    const userId = c.get('session').userId;
    await authorizeVoiceCall(c.env.DB, roomId, userId);
    const action = await parseJsonRequest(c.req.raw);
    return c.json(await c.env.CALLS.action(c.env, roomId, userId, action));
  });

  app.get('/api/calls/:roomId/ice', async (c) => {
    const roomId = Number(c.req.param('roomId'));
    const userId = c.get('session').userId;
    await authorizeVoiceCall(c.env.DB, roomId, userId);
    const ice = await c.env.CALLS.getIce(c.env, roomId, userId, {
      callId: String(c.req.query('callId') || ''),
      clientId: String(c.req.query('clientId') || '')
    });
    return c.json(ice);
  });
}
