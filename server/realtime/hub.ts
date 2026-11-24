import type { ServerWebSocket } from 'bun';
import { deleteRoomMessage, MessageDeletionError } from '../src/message-deletion.js';
import {
  MessagePinningError,
  pinRoomMessage,
  unpinRoomMessage
} from '../src/message-pinning.js';
import {
  MessageSubmissionError,
  submitRoomMessageIdempotent
} from '../src/message-submission.js';
import { projectUnreadMessage } from '../src/unread-projection.js';
import { validateSession } from '../src/session.js';
import { authorizeRoom } from '../src/room-access.js';

const MESSAGE_SIZE_LIMIT = 10 * 1024;

export interface SocketData {
  userId: number;
  token: string;
  scope: 'room' | 'inbox';
  roomKey?: string;
  roomKind?: string;
  roomId?: number;
  roomName?: string;
  alive: boolean;
}

export type Client = ServerWebSocket<SocketData>;

function send(ws: Client, frame: unknown) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(frame));
  } catch {
    // A broken socket is removed by the close handler.
  }
}

function sendError(ws: Client, message: string, clientMessageId?: string) {
  send(ws, { protocolVersion: 1, type: 'error', error: message, clientMessageId });
}

function frameLength(raw: string | Buffer | ArrayBuffer | Uint8Array) {
  if (typeof raw === 'string') return new TextEncoder().encode(raw).length;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return Number.MAX_SAFE_INTEGER;
}

function frameText(raw: string | Buffer | ArrayBuffer | Uint8Array) {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  return '';
}

/**
 * In-process replacement for the CHANNEL_ROOM / USER_INBOX Durable Objects.
 * State is intentionally memory-only; /api/v1/rooms/:kind/:id/sync repairs
 * anything missed across a restart.
 */
export class RealtimeHub {
  private rooms = new Map<string, Set<Client>>();
  private inboxes = new Map<number, Set<Client>>();
  private all = new Set<Client>();

  join(ws: Client) {
    ws.data.alive = true;
    this.all.add(ws);
    if (ws.data.scope === 'room' && ws.data.roomKey) {
      const set = this.rooms.get(ws.data.roomKey) ?? new Set<Client>();
      set.add(ws);
      this.rooms.set(ws.data.roomKey, set);
      send(ws, {
        protocolVersion: 1,
        type: 'ready',
        room: {
          id: Number(ws.data.roomId),
          kind: ws.data.roomKind,
          name: ws.data.roomName || ''
        }
      });
      return;
    }
    const set = this.inboxes.get(ws.data.userId) ?? new Set<Client>();
    set.add(ws);
    this.inboxes.set(ws.data.userId, set);
    send(ws, { protocolVersion: 1, type: 'ready' });
  }

  leave(ws: Client) {
    this.all.delete(ws);
    if (ws.data.scope === 'room' && ws.data.roomKey) {
      const set = this.rooms.get(ws.data.roomKey);
      set?.delete(ws);
      if (set && set.size === 0) this.rooms.delete(ws.data.roomKey);
      return;
    }
    const set = this.inboxes.get(ws.data.userId);
    set?.delete(ws);
    if (set && set.size === 0) this.inboxes.delete(ws.data.userId);
  }

  broadcast(roomKey: string, frame: unknown, except?: Client) {
    for (const ws of this.rooms.get(roomKey) ?? []) {
      if (ws !== except) send(ws, frame);
    }
  }

  notifyUser(userId: number, frame: unknown) {
    for (const ws of this.inboxes.get(Number(userId)) ?? []) send(ws, frame);
  }

  kickUser(userId: number, code = 4401, reason = 'session_revoked') {
    for (const ws of this.all) {
      if (ws.data.userId !== Number(userId)) continue;
      try {
        ws.close(code, reason);
      } catch {
        // ignore
      }
    }
  }

  async heartbeat(env: any) {
    for (const ws of [...this.all]) {
      if (!ws.data.alive) {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        this.leave(ws);
        continue;
      }
      ws.data.alive = false;
      try {
        ws.ping();
      } catch {
        // ping is best effort
      }
      try {
        const auth = await validateSession(env, ws.data.token);
        if (!auth.ok) {
          ws.close(auth.status === 403 ? 4403 : 4401, 'session_invalid');
          this.leave(ws);
        }
      } catch {
        // keep the connection; a transient DB error must not disconnect everyone
      }
    }
  }

  stats() {
    return {
      rooms: this.rooms.size,
      inboxes: this.inboxes.size,
      connections: this.all.size
    };
  }

  async onMessage(env: any, ws: Client, raw: string | Buffer | ArrayBuffer | Uint8Array) {
    if (frameLength(raw) > MESSAGE_SIZE_LIMIT) {
      sendError(ws, `消息过大，最大 ${Math.round(MESSAGE_SIZE_LIMIT / 1024)}KB`);
      return;
    }
    if (ws.data.scope !== 'room') return;
    let payload: any;
    try {
      payload = JSON.parse(frameText(raw));
    } catch {
      sendError(ws, 'Invalid message payload');
      return;
    }
    if (!payload || !['send', 'delete_message', 'pin_message', 'unpin_message'].includes(payload.type)) {
      sendError(ws, 'Unsupported message type');
      return;
    }

    const auth = await validateSession(env, ws.data.token);
    if (!auth.ok) {
      ws.close(auth.status === 403 ? 4403 : 4401, 'session_invalid');
      return;
    }
    const access = await authorizeRoom(env.DB, auth.session, ws.data.roomKind, Number(ws.data.roomId));
    if (!access.ok) {
      sendError(ws, '无权访问该会话');
      ws.close(4403, 'forbidden');
      return;
    }
    const meta = {
      principal: { userId: auth.session.userId, isAdmin: auth.session.isAdmin },
      room: access.room
    };

    try {
      if (payload.type === 'delete_message') {
        const result = await deleteRoomMessage(env, meta, payload);
        this.broadcast(ws.data.roomKey!, JSON.parse(result.packet));
        if (result.cleanupPromise) void result.cleanupPromise;
        return;
      }
      if (payload.type === 'pin_message') {
        const result = await pinRoomMessage(env, meta, payload);
        this.broadcast(ws.data.roomKey!, JSON.parse(result.packet));
        return;
      }
      if (payload.type === 'unpin_message') {
        const result = await unpinRoomMessage(env, meta, payload);
        this.broadcast(ws.data.roomKey!, JSON.parse(result.packet));
        return;
      }

      if (
        payload.clientMessageId !== undefined &&
        (typeof payload.clientMessageId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            payload.clientMessageId
          ))
      ) {
        throw new MessageSubmissionError('clientMessageId 必须是 UUID');
      }
      const result = await submitRoomMessageIdempotent(env, meta, payload);
      if (!result.created) {
        send(ws, JSON.parse(result.packet));
        return;
      }
      this.broadcast(ws.data.roomKey!, JSON.parse(result.packet));
      void projectUnreadMessage(env, {
        room: access.room,
        senderId: meta.principal.userId,
        message: result.message,
        replyToSenderId: result.replyToSenderId
      });
    } catch (error) {
      if (
        error instanceof MessageSubmissionError ||
        error instanceof MessageDeletionError ||
        error instanceof MessagePinningError
      ) {
        sendError(
          ws,
          error.message,
          payload.type === 'send' ? payload.clientMessageId : undefined
        );
        return;
      }
      console.error(
        JSON.stringify({
          message: 'room message action failed',
          roomId: Number(ws.data.roomId || 0),
          error: error instanceof Error ? error.message : String(error)
        })
      );
      sendError(ws, '消息操作失败', payload.type === 'send' ? payload.clientMessageId : undefined);
    }
  }
}
