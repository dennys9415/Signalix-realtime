import type WebSocket from 'ws';
import { ErrorCode, ServerEvent } from '@signalix/contracts';
import type { WsErrorPayload } from '@signalix/contracts';

export function send(ws: WebSocket, event: string, payload: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event, payload }));
  }
}

export function sendError(ws: WebSocket, code: ErrorCode, message: string): void {
  const payload: WsErrorPayload = {
    code,
    message,
    timestamp: new Date().toISOString(),
  };
  send(ws, ServerEvent.ERROR, payload);
}

export function parseMessage(raw: WebSocket.RawData): { event: string; payload: unknown } {
  const data = JSON.parse(raw.toString()) as { event?: unknown; payload?: unknown };
  if (typeof data.event !== 'string') throw new Error('Missing or invalid event field');
  return { event: data.event, payload: data.payload ?? {} };
}
