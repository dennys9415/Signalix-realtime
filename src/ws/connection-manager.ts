import type WebSocket from 'ws';

export interface Connection {
  ws: WebSocket;
  userId: string;
  deviceId: string;
  accessToken: string;
}

// userId  -> all active device connections for that user
const byUserId = new Map<string, Set<Connection>>();
// deviceId -> single connection
const byDeviceId = new Map<string, Connection>();
// chatId  -> Set of userIds that participate in that chat
const chatParticipants = new Map<string, Set<string>>();

export function addConnection(conn: Connection): void {
  // Evict any stale connection with the same deviceId (e.g., page refresh where the
  // new connection arrives before the old socket's close event fires).
  const stale = byDeviceId.get(conn.deviceId);
  if (stale) {
    const staleUserConns = byUserId.get(stale.userId);
    if (staleUserConns) {
      staleUserConns.delete(stale);
      if (staleUserConns.size === 0) byUserId.delete(stale.userId);
    }
  }

  byDeviceId.set(conn.deviceId, conn);
  if (!byUserId.has(conn.userId)) {
    byUserId.set(conn.userId, new Set());
  }
  byUserId.get(conn.userId)!.add(conn);
}

export function removeConnection(deviceId: string): Connection | undefined {
  const conn = byDeviceId.get(deviceId);
  if (!conn) return undefined;

  byDeviceId.delete(deviceId);
  const userConns = byUserId.get(conn.userId);
  if (userConns) {
    userConns.delete(conn);
    if (userConns.size === 0) byUserId.delete(conn.userId);
  }
  return conn;
}

export function getByUserId(userId: string): Set<Connection> {
  return byUserId.get(userId) ?? new Set();
}

export function isUserOnline(userId: string): boolean {
  return (byUserId.get(userId)?.size ?? 0) > 0;
}

export function learnChatParticipants(chatId: string, ...userIds: string[]): void {
  if (!chatParticipants.has(chatId)) {
    chatParticipants.set(chatId, new Set());
  }
  const set = chatParticipants.get(chatId)!;
  for (const id of userIds) set.add(id);
}

export function getChatParticipants(chatId: string): Set<string> {
  return chatParticipants.get(chatId) ?? new Set();
}

// Returns all userIds that share at least one known chat with userId.
export function getContactIds(userId: string): Set<string> {
  const contacts = new Set<string>();
  for (const participants of chatParticipants.values()) {
    if (participants.has(userId)) {
      for (const id of participants) {
        if (id !== userId) contacts.add(id);
      }
    }
  }
  return contacts;
}
