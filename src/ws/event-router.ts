import type WebSocket from 'ws';
import {
  ClientEvent,
  ServerEvent,
  ErrorCode,
  MessageStatus,
  MessageType,
  PresenceStatus,
} from '@signalix/contracts';
import type {
  ClientChatCreatedPayload,
  ClientMessageDeleteForEveryonePayload,
  ClientMessageEditPayload,
  ClientMessageReactionRemovePayload,
  ClientMessageReactionSetPayload,
  ClientMessageSendPayload,
  MessageStatusPayload,
  ServerChatCreatedPayload,
  ServerMessageDeletedForEveryonePayload,
  ServerMessageEditedPayload,
  ServerMessageNewPayload,
  ServerMessageReactionUpdatedPayload,
  ServerMessageSentPayload,
  TypingPayload,
  WsAuthenticatePayload,
  WsAuthenticatedPayload,
  WsErrorPayload,
  WsHeartbeatPayload,
} from '@signalix/contracts';
import { verifyAccessToken } from '../auth/jwt';
import * as cm from './connection-manager';
import type { Connection } from './connection-manager';
import * as api from '../common/api-client';
import * as presence from '../presence/presence.service';
import { send, parseMessage } from '../common/ws-helpers';

const AUTH_TIMEOUT_MS = 30_000;
const TYPING_EXPIRE_MS = 5_000;

// Key: `${userId}:${chatId}` — auto-fires server.typing.stop when client misses the stop event
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sendError(ws: WebSocket, code: ErrorCode, message: string): void {
  const payload: WsErrorPayload = {
    code,
    message,
    timestamp: new Date().toISOString(),
  };
  send(ws, ServerEvent.ERROR, payload);
}

export function handleConnection(ws: WebSocket): void {
  let conn: Connection | null = null;

  const authTimeout = setTimeout(() => {
    if (!conn) {
      sendError(ws, ErrorCode.WS_AUTH_REQUIRED, 'Authentication timeout');
      ws.terminate();
    }
  }, AUTH_TIMEOUT_MS);

  ws.on('message', (raw) => {
    void (async () => {
      let event: string;
      let payload: unknown;

      try {
        ({ event, payload } = parseMessage(raw));
      } catch {
        sendError(ws, ErrorCode.WS_INVALID_EVENT, 'Invalid message format');
        return;
      }

      try {
        if (!conn) {
          if (event !== ClientEvent.AUTHENTICATE) {
            sendError(ws, ErrorCode.WS_AUTH_REQUIRED, 'Send client.authenticate first');
            return;
          }
          conn = await onAuthenticate(ws, payload as WsAuthenticatePayload);
          if (conn) clearTimeout(authTimeout);
          return;
        }

        await routeEvent(conn, event, payload);
      } catch (err) {
        console.error(`[ws] Unhandled error for event "${event}":`, err);
        sendError(ws, ErrorCode.INTERNAL_ERROR, 'Internal error');
      }
    })();
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (conn) {
      void onDisconnect(conn);
    }
  });

  ws.on('error', (err: Error) => {
    console.error('[ws] Socket error:', err.message);
  });
}

async function onAuthenticate(
  ws: WebSocket,
  payload: WsAuthenticatePayload,
): Promise<Connection | null> {
  let jwtPayload;
  try {
    jwtPayload = verifyAccessToken(payload?.accessToken ?? '');
  } catch {
    sendError(ws, ErrorCode.UNAUTHORIZED, 'Invalid or expired access token');
    ws.close();
    return null;
  }

  const conn: Connection = {
    ws,
    userId: jwtPayload.sub,
    deviceId: jwtPayload.deviceId,
    accessToken: payload.accessToken,
  };

  cm.addConnection(conn);

  const authPayload: WsAuthenticatedPayload = {
    userId: conn.userId,
    deviceId: conn.deviceId,
    connectedAt: new Date().toISOString(),
  };
  send(ws, ServerEvent.AUTHENTICATED, authPayload);

  // Background: preload chats for routing, then broadcast online
  void initConnection(conn);

  console.log(`[ws] Connected  user=${conn.userId} device=${conn.deviceId}`);
  return conn;
}

async function initConnection(conn: Connection): Promise<void> {
  try {
    const { chats } = await api.getUserChats(conn.accessToken);
    for (const chat of chats) {
      cm.learnChatParticipants(
        chat.id,
        ...chat.participants.map((p) => p.userId),
      );
    }
  } catch (err) {
    console.warn('[ws] Failed to preload chats:', (err as Error).message);
  }

  await presence.onUserOnline(conn);
}

async function onDisconnect(conn: Connection): Promise<void> {
  cm.removeConnection(conn.deviceId);
  await presence.onUserOffline(conn);
  console.log(`[ws] Disconnected user=${conn.userId} device=${conn.deviceId}`);
}

async function routeEvent(conn: Connection, event: string, payload: unknown): Promise<void> {
  switch (event) {
    case ClientEvent.MESSAGE_SEND:
      await onMessageSend(conn, payload as ClientMessageSendPayload);
      break;
    case ClientEvent.MESSAGE_DELIVERED:
      await onMessageStatus(
        conn,
        payload as Partial<MessageStatusPayload>,
        MessageStatus.DELIVERED,
      );
      break;
    case ClientEvent.MESSAGE_READ:
      await onMessageStatus(
        conn,
        payload as Partial<MessageStatusPayload>,
        MessageStatus.READ,
      );
      break;
    case ClientEvent.MESSAGE_DELETE_FOR_EVERYONE:
      await onMessageDeleteForEveryone(conn, payload as Partial<ClientMessageDeleteForEveryonePayload>);
      break;
    case ClientEvent.MESSAGE_EDIT:
      await onMessageEdit(conn, payload as Partial<ClientMessageEditPayload>);
      break;
    case ClientEvent.MESSAGE_REACTION_SET:
      await onMessageReactionSet(conn, payload as Partial<ClientMessageReactionSetPayload>);
      break;
    case ClientEvent.MESSAGE_REACTION_REMOVE:
      await onMessageReactionRemove(conn, payload as Partial<ClientMessageReactionRemovePayload>);
      break;
    case ClientEvent.TYPING_START:
      onTypingStart(conn, payload as Partial<TypingPayload>);
      break;
    case ClientEvent.TYPING_STOP:
      onTypingStop(conn, payload as Partial<TypingPayload>);
      break;
    case ClientEvent.HEARTBEAT:
      onHeartbeat(conn, payload as Partial<WsHeartbeatPayload>);
      break;
    case ClientEvent.PRESENCE_UPDATE:
      await onPresenceUpdate(conn, payload as { status?: PresenceStatus });
      break;
    case ClientEvent.CHAT_CREATED:
      await onChatCreated(conn, payload as Partial<ClientChatCreatedPayload>);
      break;
    default:
      sendError(conn.ws, ErrorCode.WS_INVALID_EVENT, `Unknown event: ${event}`);
  }
}

async function onMessageSend(
  conn: Connection,
  payload: ClientMessageSendPayload,
): Promise<void> {
  // v0.10.0 — group E2EE sends carry the body inside `recipients[]` and
  // the top-level `ciphertext` is an empty sentinel. Accept either form.
  const hasRecipients = Array.isArray(payload?.recipients) && payload.recipients.length > 0;
  if (!hasRecipients && !payload?.ciphertext) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'ciphertext is required');
    return;
  }

  // Resolve recipient userId before API call so we can populate the routing cache
  let recipientId: string | null = null;
  if (payload.recipientUsername) {
    try {
      const lookup = await api.lookupUser(conn.accessToken, payload.recipientUsername);
      if (!lookup.user) {
        sendError(conn.ws, ErrorCode.USER_NOT_FOUND, 'User not found');
        return;
      }
      recipientId = lookup.user.id;
    } catch (err) {
      sendError(conn.ws, ErrorCode.INTERNAL_ERROR, (err as Error).message);
      return;
    }
  }

  let result;
  try {
    result = await api.sendMessage(conn.accessToken, {
      chatId: payload.chatId,
      recipientUsername: payload.recipientUsername,
      ciphertext: payload.ciphertext,
      messageType: payload.messageType ?? MessageType.TEXT,
      tempId: payload.tempId,
      replyToMessageId: payload.replyToMessageId,
      isForwarded: payload.isForwarded,
      // v0.9.0 E2EE beta — forward the encryption envelope to the API
      // exactly as the sender posted it. The API persists these onto the
      // messages row; without this forwarding the column defaults
      // (`encryption_version = 0`, others NULL) would silently strip the
      // envelope and recipients would see the raw JSON ciphertext.
      encryptionVersion: payload.encryptionVersion,
      senderDeviceId: payload.senderDeviceId,
      recipientDeviceId: payload.recipientDeviceId,
      preKeyId: payload.preKeyId,
      signedPreKeyId: payload.signedPreKeyId,
      // v0.10.0 — group E2EE per-recipient payloads.
      recipients: payload.recipients,
    });
  } catch (err) {
    sendError(conn.ws, ErrorCode.INTERNAL_ERROR, (err as Error).message);
    return;
  }

  const { message, chatId, tempId } = result;

  // Populate routing cache
  cm.learnChatParticipants(chatId, conn.userId);
  if (recipientId) cm.learnChatParticipants(chatId, recipientId);

  // Confirm delivery to sender
  const sentPayload: ServerMessageSentPayload = {
    messageId: message.id,
    chatId,
    senderId: conn.userId,
    ...(tempId ? { tempId } : {}),
    timestamp: message.createdAt,
    ...(message.linkPreview && { linkPreview: message.linkPreview }),
  };
  send(conn.ws, ServerEvent.MESSAGE_SENT, sentPayload);

  // Broadcast new message to all chat participants except the sending device.
  // Envelope fields are spread when present so the recipient can decrypt:
  // without these, the client would see the raw JSON envelope as the
  // message body and never invoke the decrypt path.
  //
  // v0.10.0 — fan-out encrypted sends (direct + group): `recipientPayloads`
  // is keyed by **deviceId**, so a multi-device recipient (Brave + Chrome
  // on the same account) receives the envelope encrypted to *that* device.
  // Connections whose deviceId isn't in the map (sender's other devices
  // that didn't get an envelope, or non-recipients) get the empty
  // top-level row so they render the failure placeholder rather than the
  // wrong ciphertext.
  const recipientPayloads = result.recipientPayloads;
  const hasFanout = !!recipientPayloads && Object.keys(recipientPayloads).length > 0;

  for (const participantId of cm.getChatParticipants(chatId)) {
    for (const participantConn of cm.getByUserId(participantId)) {
      // Skip the device that sent the message; deliver to sender's other devices
      if (participantConn.deviceId === conn.deviceId) continue;

      const override = recipientPayloads?.[participantConn.deviceId];

      const newPayload: ServerMessageNewPayload = {
        messageId: message.id,
        chatId,
        senderId: conn.userId,
        ciphertext: override?.ciphertext ?? message.ciphertext,
        messageType: message.messageType,
        timestamp: message.createdAt,
        ...(message.replyTo && { replyTo: message.replyTo }),
        ...(message.isForwarded && { isForwarded: true }),
        ...(message.linkPreview && { linkPreview: message.linkPreview }),
        ...(override
          ? {
              encryptionVersion: override.encryptionVersion,
              ...(override.senderDeviceId !== undefined && { senderDeviceId: override.senderDeviceId }),
              ...(override.recipientDeviceId !== undefined && { recipientDeviceId: override.recipientDeviceId }),
              ...(override.preKeyId !== undefined && { preKeyId: override.preKeyId }),
              ...(override.signedPreKeyId !== undefined && { signedPreKeyId: override.signedPreKeyId }),
            }
          : {
              // Without an override the participant is in fan-out mode but has
              // no per-device envelope (most likely: a recipient device that
              // wasn't registered when the sender resolved the bundle list).
              // We still ship the top-level envelope so legacy v0.9.x sends
              // keep flowing; for v0.10.0 fan-out the top level is empty and
              // the receiver renders the placeholder via decryptStoredMessage.
              ...(message.encryptionVersion !== undefined && { encryptionVersion: message.encryptionVersion }),
              ...(message.senderDeviceId !== undefined && { senderDeviceId: message.senderDeviceId }),
              ...(message.recipientDeviceId !== undefined && { recipientDeviceId: message.recipientDeviceId }),
              ...(message.preKeyId !== undefined && { preKeyId: message.preKeyId }),
              ...(message.signedPreKeyId !== undefined && { signedPreKeyId: message.signedPreKeyId }),
            }),
      };

      send(participantConn.ws, ServerEvent.MESSAGE_NEW, newPayload);
      if (hasFanout && process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.info('[signalix-rt] fan-out delivery', {
          messageId: message.id,
          toUserId: participantId,
          toDeviceId: participantConn.deviceId,
          matchedOverride: !!override,
          ciphertextLen: newPayload.ciphertext.length,
        });
      }
    }
  }
}

async function onMessageStatus(
  conn: Connection,
  payload: Partial<MessageStatusPayload>,
  status: MessageStatus.DELIVERED | MessageStatus.READ,
): Promise<void> {
  if (!payload.messageId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'messageId is required');
    return;
  }
  if (!payload.chatId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'chatId is required');
    return;
  }

  let statusResult;
  try {
    statusResult = await api.updateMessageStatus(conn.accessToken, payload.messageId, status);
  } catch (err) {
    sendError(conn.ws, ErrorCode.INTERNAL_ERROR, (err as Error).message);
    return;
  }

  // Broadcast the status update to all other participants in the chat
  const statusPayload: MessageStatusPayload = {
    messageId: payload.messageId,
    chatId: payload.chatId,
    userId: conn.userId,
    status,
    timestamp: statusResult.timestamp,
  };

  const serverEvent =
    status === MessageStatus.READ ? ServerEvent.MESSAGE_READ : ServerEvent.MESSAGE_DELIVERED;

  for (const participantId of cm.getChatParticipants(payload.chatId)) {
    if (participantId === conn.userId) continue;
    for (const participantConn of cm.getByUserId(participantId)) {
      send(participantConn.ws, serverEvent, statusPayload);
    }
  }
}

async function onMessageDeleteForEveryone(
  conn: Connection,
  payload: Partial<ClientMessageDeleteForEveryonePayload>,
): Promise<void> {
  if (!payload.messageId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'messageId is required');
    return;
  }
  if (!payload.chatId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'chatId is required');
    return;
  }

  let result;
  try {
    result = await api.deleteMessageForEveryone(conn.accessToken, payload.messageId);
  } catch (err) {
    sendError(conn.ws, ErrorCode.INTERNAL_ERROR, (err as Error).message);
    return;
  }

  const broadcast: ServerMessageDeletedForEveryonePayload = {
    messageId: result.messageId,
    chatId: result.chatId,
    deletedAt: result.deletedAt,
  };

  // Broadcast to all participants in the chat (including sender's other devices)
  for (const participantId of cm.getChatParticipants(payload.chatId)) {
    for (const participantConn of cm.getByUserId(participantId)) {
      // Skip the sending device — it already applied an optimistic update
      if (participantConn.deviceId === conn.deviceId) continue;
      send(participantConn.ws, ServerEvent.MESSAGE_DELETED_FOR_EVERYONE, broadcast);
    }
  }
}

function onHeartbeat(conn: Connection, payload: Partial<WsHeartbeatPayload>): void {
  const ackPayload: WsHeartbeatPayload = {
    timestamp: payload.timestamp ?? new Date().toISOString(),
  };
  send(conn.ws, ServerEvent.HEARTBEAT_ACK, ackPayload);
}

async function onMessageEdit(
  conn: Connection,
  payload: Partial<ClientMessageEditPayload>,
): Promise<void> {
  if (!payload.messageId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'messageId is required');
    return;
  }
  if (!payload.chatId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'chatId is required');
    return;
  }
  // v0.10.0 — empty ciphertext is valid for group encrypted edits (body lives
  // in recipients[]); reject only when both are missing.
  const hasEditRecipients = Array.isArray(payload.recipients) && payload.recipients.length > 0;
  if (!hasEditRecipients && !payload.ciphertext) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'ciphertext is required');
    return;
  }

  let result;
  try {
    result = await api.editMessage(conn.accessToken, payload.messageId, {
      ciphertext: payload.ciphertext ?? '',
      encryptionVersion: payload.encryptionVersion,
      senderDeviceId: payload.senderDeviceId,
      recipientDeviceId: payload.recipientDeviceId,
      preKeyId: payload.preKeyId,
      signedPreKeyId: payload.signedPreKeyId,
      recipients: payload.recipients,
    });
  } catch (err) {
    sendError(conn.ws, ErrorCode.INTERNAL_ERROR, (err as Error).message);
    return;
  }

  // v0.10.0 — per-device fan-out broadcast for encrypted edits (direct +
  // group). Same keying semantics as onMessageSend.
  const editRecipientPayloads = result.recipientPayloads;
  for (const participantId of cm.getChatParticipants(payload.chatId)) {
    for (const participantConn of cm.getByUserId(participantId)) {
      if (participantConn.deviceId === conn.deviceId) continue;
      const override = editRecipientPayloads?.[participantConn.deviceId];
      const broadcast: ServerMessageEditedPayload = {
        messageId: result.messageId,
        chatId: result.chatId,
        ciphertext: override?.ciphertext ?? result.ciphertext,
        editedAt: result.editedAt,
        ...(override
          ? {
              encryptionVersion: override.encryptionVersion,
              ...(override.senderDeviceId !== undefined && { senderDeviceId: override.senderDeviceId }),
              ...(override.recipientDeviceId !== undefined && { recipientDeviceId: override.recipientDeviceId }),
              ...(override.preKeyId !== undefined && { preKeyId: override.preKeyId }),
              ...(override.signedPreKeyId !== undefined && { signedPreKeyId: override.signedPreKeyId }),
            }
          : {}),
      };
      send(participantConn.ws, ServerEvent.MESSAGE_EDITED, broadcast);
    }
  }
}

async function onMessageReactionSet(
  conn: Connection,
  payload: Partial<ClientMessageReactionSetPayload>,
): Promise<void> {
  if (!payload.messageId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'messageId is required');
    return;
  }
  if (!payload.chatId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'chatId is required');
    return;
  }
  if (!payload.emoji) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'emoji is required');
    return;
  }

  let result;
  try {
    result = await api.setReaction(conn.accessToken, payload.messageId, payload.emoji);
  } catch (err) {
    sendError(conn.ws, ErrorCode.INTERNAL_ERROR, (err as Error).message);
    return;
  }

  const broadcast: ServerMessageReactionUpdatedPayload = {
    messageId: result.messageId,
    chatId: result.chatId,
    reactions: result.reactions,
  };

  for (const participantId of cm.getChatParticipants(payload.chatId)) {
    for (const participantConn of cm.getByUserId(participantId)) {
      send(participantConn.ws, ServerEvent.MESSAGE_REACTION_UPDATED, broadcast);
    }
  }
}

async function onMessageReactionRemove(
  conn: Connection,
  payload: Partial<ClientMessageReactionRemovePayload>,
): Promise<void> {
  if (!payload.messageId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'messageId is required');
    return;
  }
  if (!payload.chatId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'chatId is required');
    return;
  }

  let result;
  try {
    result = await api.removeReaction(conn.accessToken, payload.messageId);
  } catch (err) {
    sendError(conn.ws, ErrorCode.INTERNAL_ERROR, (err as Error).message);
    return;
  }

  const broadcast: ServerMessageReactionUpdatedPayload = {
    messageId: result.messageId,
    chatId: result.chatId,
    reactions: result.reactions,
  };

  for (const participantId of cm.getChatParticipants(payload.chatId)) {
    for (const participantConn of cm.getByUserId(participantId)) {
      send(participantConn.ws, ServerEvent.MESSAGE_REACTION_UPDATED, broadcast);
    }
  }
}

function onTypingStart(conn: Connection, payload: Partial<TypingPayload>): void {
  const chatId = payload?.chatId;
  if (!chatId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'chatId is required');
    return;
  }

  const key = `${conn.userId}:${chatId}`;
  const existing = typingTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    typingTimers.delete(key);
    const stopPayload: TypingPayload = { chatId, userId: conn.userId, timestamp: new Date().toISOString() };
    for (const participantId of cm.getChatParticipants(chatId)) {
      for (const participantConn of cm.getByUserId(participantId)) {
        if (participantConn.deviceId === conn.deviceId) continue;
        send(participantConn.ws, ServerEvent.TYPING_STOP, stopPayload);
      }
    }
  }, TYPING_EXPIRE_MS);

  typingTimers.set(key, timer);

  const startPayload: TypingPayload = { chatId, userId: conn.userId, timestamp: new Date().toISOString() };
  for (const participantId of cm.getChatParticipants(chatId)) {
    for (const participantConn of cm.getByUserId(participantId)) {
      if (participantConn.deviceId === conn.deviceId) continue;
      send(participantConn.ws, ServerEvent.TYPING_START, startPayload);
    }
  }
}

function onTypingStop(conn: Connection, payload: Partial<TypingPayload>): void {
  const chatId = payload?.chatId;
  if (!chatId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'chatId is required');
    return;
  }

  const key = `${conn.userId}:${chatId}`;
  const existing = typingTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    typingTimers.delete(key);
  }

  const stopPayload: TypingPayload = { chatId, userId: conn.userId, timestamp: new Date().toISOString() };
  for (const participantId of cm.getChatParticipants(chatId)) {
    for (const participantConn of cm.getByUserId(participantId)) {
      if (participantConn.deviceId === conn.deviceId) continue;
      send(participantConn.ws, ServerEvent.TYPING_STOP, stopPayload);
    }
  }
}

async function onPresenceUpdate(
  conn: Connection,
  payload: { status?: PresenceStatus },
): Promise<void> {
  const status = payload?.status;
  if (!status || !Object.values(PresenceStatus).includes(status)) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'Valid status is required');
    return;
  }

  try {
    await api.updatePresence(conn.accessToken, status);
  } catch (err) {
    sendError(conn.ws, ErrorCode.INTERNAL_ERROR, (err as Error).message);
  }
}

/**
 * v0.10.2 — broadcast a newly-created chat to all of its participants.
 *
 * Triggered by the creating client right after the REST `POST /chats/group`
 * (or any future "chat created via REST" endpoint) returns. The realtime
 * server doesn't trust the client to ship the chat shape over the wire —
 * instead it re-fetches the canonical `ChatDTO` via `GET /chats/:chatId`
 * with the caller's JWT, which doubles as the participation check: the
 * API throws FORBIDDEN if the caller isn't a participant, so a hostile
 * client can't fan out a chat they don't actually belong to.
 *
 * Every connected participant (including the creator's own connections,
 * minus the originating device) receives `server.chat.created`. The
 * creating frontend deduplicates by `chat.id` since it already inserted
 * the chat from the REST response.
 */
async function onChatCreated(
  conn: Connection,
  payload: Partial<ClientChatCreatedPayload>,
): Promise<void> {
  if (!payload?.chatId) {
    sendError(conn.ws, ErrorCode.VALIDATION_ERROR, 'chatId is required');
    return;
  }

  let result: { chat: import('@signalix/contracts').ChatDTO };
  try {
    result = await api.getChatById(conn.accessToken, payload.chatId);
  } catch (err) {
    // Most likely the caller isn't a participant (FORBIDDEN) or the
    // chat was deleted between create + broadcast (NOT_FOUND). Surface
    // the failure to the originator only; nothing to fan out.
    sendError(conn.ws, ErrorCode.INTERNAL_ERROR, (err as Error).message);
    return;
  }

  const { chat } = result;
  const broadcast: ServerChatCreatedPayload = { chat };

  // Seed the routing cache so subsequent MESSAGE_SEND broadcasts to this
  // chat reach every participant without waiting for them to next call
  // GET /chats. Mirrors what authenticated-connect preload does.
  for (const participant of chat.participants) {
    cm.learnChatParticipants(chat.id, participant.userId);
  }

  for (const participant of chat.participants) {
    for (const participantConn of cm.getByUserId(participant.userId)) {
      if (participantConn.deviceId === conn.deviceId) continue;
      send(participantConn.ws, ServerEvent.CHAT_CREATED, broadcast);
    }
  }
}
