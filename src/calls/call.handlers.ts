import { CallEndReason, CallType, ErrorCode, ServerEvent } from '@signalix/contracts';
import type {
  ClientCallAcceptPayload,
  ClientCallHangupPayload,
  ClientCallIceCandidatePayload,
  ClientCallInvitePayload,
  ClientCallMediaUpdatePayload,
  ClientCallRejectPayload,
  ClientCallRingingPayload,
  ServerCallAcceptedPayload,
  ServerCallAnsweredElsewherePayload,
  ServerCallEndedPayload,
  ServerCallIceCandidatePayload,
  ServerCallIncomingPayload,
  ServerCallMediaUpdatePayload,
  ServerCallRingingPayload,
} from '@signalix/contracts';
import * as cm from '../ws/connection-manager';
import type { Connection } from '../ws/connection-manager';
import * as api from '../common/api-client';
import { send, sendError } from '../common/ws-helpers';

/**
 * v0.17.0 — 1:1 call signaling. See Signalix-contracts/protocol/call-flow.md.
 *
 * Sessions live in memory (single realtime instance, same as the chat
 * routing cache). The API owns the persisted call log; every lifecycle
 * transition here is mirrored to it with the acting user's own JWT.
 */

const RING_TIMEOUT_MS = 45_000;

interface CallSession {
  callId: string;
  chatId: string;
  callType: CallType;
  state: 'ringing' | 'active';
  callerId: string;
  callerDeviceId: string;
  callerToken: string;
  calleeId: string;
  /** Set when a callee device accepts. Until then every callee device rings. */
  calleeDeviceId: string | null;
  ringTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, CallSession>();

function now(): string {
  return new Date().toISOString();
}

function isUserInCall(userId: string): boolean {
  for (const s of sessions.values()) {
    if (s.callerId === userId || s.calleeId === userId) return true;
  }
  return false;
}

function sendToDevice(deviceId: string | null, event: ServerEvent, payload: unknown): void {
  if (!deviceId) return;
  const conn = cm.getByDeviceId(deviceId);
  if (conn) send(conn.ws, event, payload);
}

/** The device on the other end of an active call, or null if `conn` isn't in it. */
function peerDeviceOf(session: CallSession, conn: Connection): string | null {
  if (session.state !== 'active') return null;
  if (conn.deviceId === session.callerDeviceId) return session.calleeDeviceId;
  if (conn.deviceId === session.calleeDeviceId) return session.callerDeviceId;
  return null;
}

function persistEnd(token: string, callId: string, reason: CallEndReason): void {
  api.endCall(token, callId, reason).catch((err: Error) => {
    console.warn(`[calls] Failed to persist end of ${callId}:`, err.message);
  });
}

/**
 * Tear down a session and tell every involved device except `excludeDeviceId`.
 * While ringing that is all callee devices; once active only the accepting one.
 */
function endSession(
  session: CallSession,
  reason: CallEndReason,
  opts: { token: string; endedBy?: string; excludeDeviceId?: string },
): void {
  if (session.ringTimer) clearTimeout(session.ringTimer);
  sessions.delete(session.callId);

  const payload: ServerCallEndedPayload = {
    callId: session.callId,
    reason,
    ...(opts.endedBy && { endedBy: opts.endedBy }),
    timestamp: now(),
  };

  const targets = new Set<string>([session.callerDeviceId]);
  if (session.calleeDeviceId) {
    targets.add(session.calleeDeviceId);
  } else {
    for (const c of cm.getByUserId(session.calleeId)) targets.add(c.deviceId);
  }
  if (opts.excludeDeviceId) targets.delete(opts.excludeDeviceId);
  for (const deviceId of targets) sendToDevice(deviceId, ServerEvent.CALL_ENDED, payload);

  persistEnd(opts.token, session.callId, reason);
  console.log(`[calls] Ended ${session.callId} reason=${reason}`);
}

/** Tell the caller its invite never started ringing. */
function rejectInvite(conn: Connection, callId: string, reason: CallEndReason): void {
  const payload: ServerCallEndedPayload = { callId, reason, timestamp: now() };
  send(conn.ws, ServerEvent.CALL_ENDED, payload);
}

export async function onCallInvite(
  conn: Connection,
  payload: Partial<ClientCallInvitePayload>,
): Promise<void> {
  const { callId, chatId, callType, offer } = payload ?? {};
  if (!callId || !chatId || !offer?.sdp || offer.type !== 'offer') {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'callId, chatId and offer are required');
    return;
  }
  if (callType !== CallType.AUDIO && callType !== CallType.VIDEO) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'callType must be audio or video');
    return;
  }
  if (sessions.has(callId)) {
    sendError(conn.ws, ErrorCode.CONFLICT, 'Call id already in use');
    return;
  }
  if (isUserInCall(conn.userId)) {
    rejectInvite(conn, callId, CallEndReason.FAILED);
    return;
  }

  let calleeId: string;
  try {
    const { call } = await api.createCall(conn.accessToken, { callId, chatId, callType });
    calleeId = call.calleeId;
  } catch (err) {
    console.warn(`[calls] createCall failed for ${callId}:`, (err as Error).message);
    rejectInvite(conn, callId, CallEndReason.FAILED);
    return;
  }

  cm.learnChatParticipants(chatId, conn.userId, calleeId);

  if (isUserInCall(calleeId)) {
    rejectInvite(conn, callId, CallEndReason.BUSY);
    persistEnd(conn.accessToken, callId, CallEndReason.BUSY);
    return;
  }
  const calleeConns = cm.getByUserId(calleeId);
  if (calleeConns.size === 0) {
    rejectInvite(conn, callId, CallEndReason.UNAVAILABLE);
    persistEnd(conn.accessToken, callId, CallEndReason.UNAVAILABLE);
    return;
  }

  const session: CallSession = {
    callId,
    chatId,
    callType,
    state: 'ringing',
    callerId: conn.userId,
    callerDeviceId: conn.deviceId,
    callerToken: conn.accessToken,
    calleeId,
    calleeDeviceId: null,
    ringTimer: null,
  };
  session.ringTimer = setTimeout(() => {
    if (sessions.get(callId) === session && session.state === 'ringing') {
      endSession(session, CallEndReason.MISSED, { token: session.callerToken });
    }
  }, RING_TIMEOUT_MS);
  sessions.set(callId, session);

  const incoming: ServerCallIncomingPayload = {
    callId,
    chatId,
    callType,
    callerId: conn.userId,
    callerDeviceId: conn.deviceId,
    offer,
    timestamp: now(),
  };
  for (const calleeConn of calleeConns) send(calleeConn.ws, ServerEvent.CALL_INCOMING, incoming);
  console.log(`[calls] Ringing ${callId} ${callType} ${conn.userId} → ${calleeId} (${calleeConns.size} devices)`);
}

export function onCallRinging(conn: Connection, payload: Partial<ClientCallRingingPayload>): void {
  const session = payload?.callId ? sessions.get(payload.callId) : undefined;
  if (!session || session.state !== 'ringing' || conn.userId !== session.calleeId) return;

  const ringing: ServerCallRingingPayload = {
    callId: session.callId,
    deviceId: conn.deviceId,
    timestamp: now(),
  };
  sendToDevice(session.callerDeviceId, ServerEvent.CALL_RINGING, ringing);
}

export async function onCallAccept(
  conn: Connection,
  payload: Partial<ClientCallAcceptPayload>,
): Promise<void> {
  const session = payload?.callId ? sessions.get(payload.callId) : undefined;
  if (!session || conn.userId !== session.calleeId) {
    sendError(conn.ws, ErrorCode.NOT_FOUND, 'Call not found');
    return;
  }
  if (!payload.answer?.sdp || payload.answer.type !== 'answer') {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'answer is required');
    return;
  }
  if (session.state !== 'ringing') {
    // Lost the race against another callee device (or the call just ended).
    const elsewhere: ServerCallAnsweredElsewherePayload = { callId: session.callId, timestamp: now() };
    send(conn.ws, ServerEvent.CALL_ANSWERED_ELSEWHERE, elsewhere);
    return;
  }

  // Claim the call synchronously so a second accept can't slip in while
  // the API round trip is pending.
  session.state = 'active';
  session.calleeDeviceId = conn.deviceId;
  if (session.ringTimer) {
    clearTimeout(session.ringTimer);
    session.ringTimer = null;
  }

  try {
    await api.acceptCall(conn.accessToken, session.callId);
  } catch (err) {
    console.warn(`[calls] acceptCall failed for ${session.callId}:`, (err as Error).message);
    if (sessions.get(session.callId) === session) {
      endSession(session, CallEndReason.FAILED, { token: conn.accessToken });
    }
    return;
  }
  // The caller may have hung up while the API call was in flight.
  if (sessions.get(session.callId) !== session) return;

  const accepted: ServerCallAcceptedPayload = {
    callId: session.callId,
    deviceId: conn.deviceId,
    answer: payload.answer,
    timestamp: now(),
  };
  sendToDevice(session.callerDeviceId, ServerEvent.CALL_ACCEPTED, accepted);

  const elsewhere: ServerCallAnsweredElsewherePayload = { callId: session.callId, timestamp: now() };
  for (const other of cm.getByUserId(session.calleeId)) {
    if (other.deviceId !== conn.deviceId) send(other.ws, ServerEvent.CALL_ANSWERED_ELSEWHERE, elsewhere);
  }
}

export function onCallReject(conn: Connection, payload: Partial<ClientCallRejectPayload>): void {
  const session = payload?.callId ? sessions.get(payload.callId) : undefined;
  if (!session || session.state !== 'ringing' || conn.userId !== session.calleeId) return;

  endSession(session, CallEndReason.REJECTED, {
    token: conn.accessToken,
    endedBy: conn.userId,
    excludeDeviceId: conn.deviceId,
  });
}

export function onCallHangup(conn: Connection, payload: Partial<ClientCallHangupPayload>): void {
  const session = payload?.callId ? sessions.get(payload.callId) : undefined;
  if (!session) return;

  const isCaller = conn.deviceId === session.callerDeviceId;
  const isActiveCallee = conn.deviceId === session.calleeDeviceId;
  // While ringing, a callee device hanging up is a decline.
  if (!isCaller && !isActiveCallee) {
    if (session.state === 'ringing' && conn.userId === session.calleeId) onCallReject(conn, payload);
    return;
  }

  let reason: CallEndReason;
  if (payload.reason === CallEndReason.FAILED) reason = CallEndReason.FAILED;
  else if (session.state === 'active') reason = CallEndReason.COMPLETED;
  else reason = CallEndReason.CANCELLED;

  endSession(session, reason, {
    token: conn.accessToken,
    endedBy: conn.userId,
    excludeDeviceId: conn.deviceId,
  });
}

export function onCallIceCandidate(
  conn: Connection,
  payload: Partial<ClientCallIceCandidatePayload>,
): void {
  const session = payload?.callId ? sessions.get(payload.callId) : undefined;
  if (!session || !payload.candidate) return;

  const relay: ServerCallIceCandidatePayload = {
    callId: session.callId,
    fromDeviceId: conn.deviceId,
    candidate: payload.candidate,
  };
  sendToDevice(peerDeviceOf(session, conn), ServerEvent.CALL_ICE_CANDIDATE, relay);
}

export function onCallMediaUpdate(
  conn: Connection,
  payload: Partial<ClientCallMediaUpdatePayload>,
): void {
  const session = payload?.callId ? sessions.get(payload.callId) : undefined;
  if (!session) return;

  const update: ServerCallMediaUpdatePayload = {
    callId: session.callId,
    userId: conn.userId,
    audioEnabled: payload.audioEnabled !== false,
    videoEnabled: payload.videoEnabled === true,
  };
  sendToDevice(peerDeviceOf(session, conn), ServerEvent.CALL_MEDIA_UPDATE, update);
}

/** A socket closed: end every call that depended on that device. */
export function onDeviceDisconnected(conn: Connection): void {
  for (const session of [...sessions.values()]) {
    if (conn.deviceId === session.callerDeviceId) {
      const reason = session.state === 'active' ? CallEndReason.FAILED : CallEndReason.CANCELLED;
      endSession(session, reason, { token: conn.accessToken, excludeDeviceId: conn.deviceId });
    } else if (conn.deviceId === session.calleeDeviceId) {
      endSession(session, CallEndReason.FAILED, { token: conn.accessToken, excludeDeviceId: conn.deviceId });
    } else if (
      session.state === 'ringing' &&
      conn.userId === session.calleeId &&
      cm.getByUserId(session.calleeId).size === 0
    ) {
      // Last ringing device went away — nobody left to answer.
      endSession(session, CallEndReason.MISSED, { token: session.callerToken });
    }
  }
}
