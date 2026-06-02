import type WebSocket from 'ws';

export function send(ws: WebSocket, event: string, payload: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event, payload }));
  }
}

export function parseMessage(raw: WebSocket.RawData): { event: string; payload: unknown } {
  const data = JSON.parse(raw.toString()) as { event?: unknown; payload?: unknown };
  if (typeof data.event !== 'string') throw new Error('Missing or invalid event field');
  return { event: data.event, payload: data.payload ?? {} };
}
