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
  ClientMessageSendPayload,
  MessageStatusPayload,
  ServerMessageNewPayload,
  ServerMessageSentPayload,
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
    case ClientEvent.HEARTBEAT:
      onHeartbeat(conn, payload as Partial<WsHeartbeatPayload>);
      break;
    case ClientEvent.PRESENCE_UPDATE:
      await onPresenceUpdate(conn, payload as { status?: PresenceStatus });
      break;
    default:
      sendError(conn.ws, ErrorCode.WS_INVALID_EVENT, `Unknown event: ${event}`);
  }
}

async function onMessageSend(
  conn: Connection,
  payload: ClientMessageSendPayload,
): Promise<void> {
  if (!payload?.ciphertext) {
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
      messageType: MessageType.TEXT,
      tempId: payload.tempId,
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
  };
  send(conn.ws, ServerEvent.MESSAGE_SENT, sentPayload);

  // Broadcast new message to all chat participants except the sending device
  const newPayload: ServerMessageNewPayload = {
    messageId: message.id,
    chatId,
    senderId: conn.userId,
    ciphertext: message.ciphertext,
    messageType: message.messageType,
    timestamp: message.createdAt,
  };

  for (const participantId of cm.getChatParticipants(chatId)) {
    for (const participantConn of cm.getByUserId(participantId)) {
      // Skip the device that sent the message; deliver to sender's other devices
      if (participantConn.deviceId === conn.deviceId) continue;
      send(participantConn.ws, ServerEvent.MESSAGE_NEW, newPayload);
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

function onHeartbeat(conn: Connection, payload: Partial<WsHeartbeatPayload>): void {
  const ackPayload: WsHeartbeatPayload = {
    timestamp: payload.timestamp ?? new Date().toISOString(),
  };
  send(conn.ws, ServerEvent.HEARTBEAT_ACK, ackPayload);
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
