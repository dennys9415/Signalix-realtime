import { WebSocketServer } from 'ws';
import { config } from './config/config';
import { handleConnection } from './ws/event-router';

const wss = new WebSocketServer({ port: config.port });

wss.on('connection', (ws) => {
  handleConnection(ws);
});

wss.on('listening', () => {
  console.log(`Signalix realtime server running on port ${config.port}`);
});

wss.on('error', (err: Error) => {
  console.error('WebSocket server error:', err.message);
  process.exit(1);
});
