import { ServerEvent, PresenceStatus } from '@signalix/contracts';
import type { PresenceEventPayload } from '@signalix/contracts';
import * as cm from '../ws/connection-manager';
import * as api from '../common/api-client';
import { send } from '../common/ws-helpers';
import type { Connection } from '../ws/connection-manager';

export async function onUserOnline(conn: Connection): Promise<void> {
  api.updatePresence(conn.accessToken, PresenceStatus.ONLINE).catch((err: Error) => {
    console.warn('[presence] Failed to mark online via API:', err.message);
  });

  broadcastPresenceEvent(conn, ServerEvent.USER_ONLINE);
}

export async function onUserOffline(conn: Connection): Promise<void> {
  // Only mark offline when the user has no remaining connections
  if (!cm.isUserOnline(conn.userId)) {
    api.updatePresence(conn.accessToken, PresenceStatus.OFFLINE).catch((err: Error) => {
      console.warn('[presence] Failed to mark offline via API:', err.message);
    });

    broadcastPresenceEvent(conn, ServerEvent.USER_OFFLINE);
  }
}

function broadcastPresenceEvent(conn: Connection, event: ServerEvent.USER_ONLINE | ServerEvent.USER_OFFLINE): void {
  const payload: PresenceEventPayload = {
    userId: conn.userId,
    deviceId: conn.deviceId,
    timestamp: new Date().toISOString(),
  };

  for (const contactId of cm.getContactIds(conn.userId)) {
    for (const contactConn of cm.getByUserId(contactId)) {
      send(contactConn.ws, event, payload);
    }
  }
}
