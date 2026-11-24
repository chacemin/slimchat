import { authorizeVoiceCall } from '../src/calls/access.ts';
import { generateCallIceServers, turnConfigured } from '../src/calls/turn.ts';
import { callExpired, nextCallState, type CallState } from '../src/calls/state.ts';
import {
  CALL_RING_MS,
  CALL_MAX_MS,
  CALL_HEARTBEAT_MS,
  type CallAction
} from '../../shared/voice-call.ts';
import { ApiError } from '../src/errors.js';

interface Lease {
  callId: string;
  expiresAt: number;
}

/**
 * In-memory replacement for the VOICE_CALL Durable Object.
 * One call per DM room, one call seat per user, all inside this process.
 */
export class CallService {
  private calls = new Map<number, CallState>();
  private leases = new Map<number, Lease>();
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => {});
    return next;
  }

  private emit(env: any, call: CallState, type: string, extra: Record<string, unknown> = {}, target?: number) {
    const payload = {
      type,
      callId: call.id,
      roomId: call.roomId,
      callerId: call.callerId,
      calleeId: call.calleeId,
      callerClient: call.callerClient,
      calleeClient: call.calleeClient,
      mode: call.mode,
      revision: call.revision,
      expiresAt: call.createdAt + CALL_RING_MS,
      ...extra
    };
    for (const userId of target ? [target] : [call.callerId, call.calleeId]) {
      env.HUB.notifyUser(userId, payload);
    }
  }

  private claim(userId: number, callId: string, expiresAt: number) {
    const current = this.leases.get(Number(userId));
    if (current && current.expiresAt > Date.now() && current.callId !== callId) return false;
    this.leases.set(Number(userId), { callId, expiresAt });
    return true;
  }

  private release(userId: number, callId: string) {
    const current = this.leases.get(Number(userId));
    if (!current || current.callId !== callId) return;
    this.leases.delete(Number(userId));
  }

  private async end(env: any, call: CallState, reason: string) {
    if (this.calls.get(call.roomId)?.id === call.id) this.calls.delete(call.roomId);
    this.release(call.callerId, call.id);
    this.release(call.calleeId, call.id);
    this.emit(env, call, 'call_ended', { reason });
  }

  async getIce(
    env: any,
    roomId: number,
    userId: number,
    { callId, clientId }: { callId: string; clientId: string }
  ) {
    return this.serial(async () => {
      await authorizeVoiceCall(env.DB, roomId, userId);
      const call = this.calls.get(roomId);
      if (!call || call.id !== callId || call.phase !== 'accepted') {
        throw new ApiError('通话已结束', 410);
      }
      const expected = userId === call.callerId ? call.callerClient : call.calleeClient;
      if (expected !== clientId) {
        throw new ApiError('通话已被其他窗口接听', 409);
      }
      return generateCallIceServers(env);
    });
  }

  async action(env: any, roomId: number, userId: number, action: CallAction) {
    return this.serial(async () => {
      const access = await authorizeVoiceCall(env.DB, roomId, userId);
      const existing = this.calls.get(roomId);
      if (existing && callExpired(existing, Date.now())) {
        await this.end(
          env,
          existing,
          existing.phase === 'accepted' && Date.now() >= existing.createdAt + CALL_MAX_MS
            ? 'limit'
            : 'timeout'
        );
      }
      if (!action || typeof action !== 'object') {
        throw new ApiError('无效的通话请求', 400);
      }
      if (
        ['start', 'accept', 'restart'].includes(action.type) &&
        action.mode === 'relay' &&
        !turnConfigured(env)
      ) {
        throw new ApiError('TURN 尚未配置', 503);
      }

      const previous = this.calls.get(roomId) || null;
      const next = nextCallState(previous, action, userId, access.peerId, roomId, Date.now());
      if (!next) {
        if (previous) await this.end(env, previous, action.type === 'reject' ? 'rejected' : 'hangup');
        return { ok: true };
      }

      if (['start', 'accept', 'heartbeat'].includes(action.type)) {
        const expiresAt =
          next.phase === 'ringing'
            ? next.createdAt + CALL_RING_MS
            : Math.min(
                next.createdAt + CALL_MAX_MS,
                Math.min(next.callerSeen, next.calleeSeen) + CALL_HEARTBEAT_MS
              );
        const ok = [next.callerId, next.calleeId].every((id) => this.claim(id, next.id, expiresAt));
        if (!ok) {
          this.release(next.callerId, next.id);
          this.release(next.calleeId, next.id);
          if (previous) await this.end(env, previous, 'unavailable');
          throw new ApiError('对方正在通话', 409);
        }
      }

      this.calls.set(roomId, next);

      if (action.type === 'start') {
        this.emit(env, next, 'call_invite', { users: access.users });
      } else if (action.type === 'accept' || action.type === 'restart') {
        if (next !== previous) this.emit(env, next, 'call_negotiate');
      } else if (action.type !== 'heartbeat') {
        const signal =
          action.type === 'ice'
            ? {
                type: 'ice',
                candidate: {
                  candidate: action.candidate?.candidate,
                  sdpMid: action.candidate?.sdpMid,
                  sdpMLineIndex: action.candidate?.sdpMLineIndex,
                  usernameFragment: action.candidate?.usernameFragment
                }
              }
            : { type: action.type, sdp: action.sdp };
        this.emit(env, next, 'call_signal', { signal }, userId === next.callerId ? next.calleeId : next.callerId);
      }

      return { ok: true, call: next };
    });
  }

  /** Called by the scheduler to expire ringing calls and dead heartbeats. */
  async sweep(env: any) {
    for (const call of [...this.calls.values()]) {
      if (!callExpired(call, Date.now())) continue;
      await this.serial(async () => {
        const current = this.calls.get(call.roomId);
        if (!current || current.id !== call.id) return;
        await this.end(
          env,
          current,
          current.phase === 'accepted' && Date.now() >= current.createdAt + CALL_MAX_MS
            ? 'limit'
            : 'timeout'
        );
      });
    }
  }

  stats() {
    return {
      activeCalls: this.calls.size,
      activeLeases: this.leases.size
    };
  }

  clear() {
    this.calls.clear();
    this.leases.clear();
  }
}
