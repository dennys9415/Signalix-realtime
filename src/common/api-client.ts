import { config } from '../config/config';
import type {
  ApiResponse,
  ChatDTO,
  ExactUsernameLookupResponse,
  MessageStatusDTO,
  PresenceDTO,
  SendMessageResponse,
} from '@signalix/contracts';
import { MessageStatus, MessageType, PresenceStatus } from '@signalix/contracts';

async function call<T>(
  method: string,
  path: string,
  accessToken: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${config.apiBaseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const json = (await res.json()) as ApiResponse<T>;

  if (!json.success || json.data === undefined) {
    throw new Error(json.error?.message ?? `API ${method} ${path} returned ${res.status}`);
  }

  return json.data;
}

export function sendMessage(
  accessToken: string,
  payload: {
    chatId?: string;
    recipientUsername?: string;
    ciphertext: string;
    messageType: MessageType.TEXT;
    tempId?: string;
  },
): Promise<SendMessageResponse> {
  return call<SendMessageResponse>('POST', '/api/v1/messages/send', accessToken, payload);
}

export function updateMessageStatus(
  accessToken: string,
  messageId: string,
  status: MessageStatus.DELIVERED | MessageStatus.READ,
): Promise<MessageStatusDTO> {
  return call<MessageStatusDTO>(
    'POST',
    `/api/v1/messages/${messageId}/status`,
    accessToken,
    { status },
  );
}

export function updatePresence(
  accessToken: string,
  status: PresenceStatus,
): Promise<PresenceDTO> {
  return call<PresenceDTO>('POST', '/api/v1/presence/status', accessToken, { status });
}

export function getUserChats(
  accessToken: string,
): Promise<{ chats: ChatDTO[] }> {
  return call<{ chats: ChatDTO[] }>('GET', '/api/v1/chats', accessToken);
}

export function lookupUser(
  accessToken: string,
  username: string,
): Promise<ExactUsernameLookupResponse> {
  return call<ExactUsernameLookupResponse>(
    'GET',
    `/api/v1/users/lookup/${encodeURIComponent(username)}`,
    accessToken,
  );
}

