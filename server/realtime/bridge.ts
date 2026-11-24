import { deleteRoomMessage } from '../src/message-deletion.js';
import { pinRoomMessage, unpinRoomMessage } from '../src/message-pinning.js';
import {
  MessageSubmissionError,
  submitRoomMessageIdempotent
} from '../src/message-submission.js';
import { projectUnreadMessage } from '../src/unread-projection.js';
import { validateSession } from '../src/session.js';

export function roomKey(room: { kind: string; id: number | string }) {
  return `${room.kind}:${Number(room.id)}`;
}

/** Direct replacement for the internal /notify HTTP hop into USER_INBOX. */
export async function notifyUserInbox(env: any, userId: number, payload: unknown) {
  env.HUB.notifyUser(Number(userId), payload);
  return { ok: true };
}

/**
 * HTTP compatibility for the mobile /api/v1 message routes. It shares the exact
 * same submission, idempotency and broadcast path as the WebSocket frames.
 */
export async function submitClientRoomAction(
  env: any,
  { room, principal, action }: { room: any; principal: any; action: any }
) {
  const meta = { principal, room };
  try {
    if (action?.type === 'send') {
      const result = await submitRoomMessageIdempotent(env, meta, action);
      if (result.created) {
        env.HUB.broadcast(roomKey(room), JSON.parse(result.packet));
        void projectUnreadMessage(env, {
          room,
          senderId: principal.userId,
          message: result.message,
          replyToSenderId: result.replyToSenderId
        });
      }
      return Response.json({ created: result.created, message: result.message });
    }
    if (action?.type === 'delete_message') {
      const result = await deleteRoomMessage(env, meta, action);
      env.HUB.broadcast(roomKey(room), JSON.parse(result.packet));
      if (result.cleanupPromise) void result.cleanupPromise;
      return Response.json({ ok: true, messageId: result.messageId });
    }
    if (action?.type === 'pin_message') {
      const result = await pinRoomMessage(env, meta, action);
      env.HUB.broadcast(roomKey(room), JSON.parse(result.packet));
      return Response.json({ ok: true, message: result.message });
    }
    if (action?.type === 'unpin_message') {
      const result = await unpinRoomMessage(env, meta, action);
      env.HUB.broadcast(roomKey(room), JSON.parse(result.packet));
      return Response.json({ ok: true, messageId: result.messageId });
    }
    return Response.json(
      { error: { code: 'invalid_request', message: '不支持的消息操作' } },
      { status: 400 }
    );
  } catch (error: any) {
    return Response.json(
      { error: { code: error?.code || 'invalid_request', message: error?.message || '消息操作失败' } },
      { status: error?.status || (error instanceof MessageSubmissionError ? 400 : 500) }
    );
  }
}
