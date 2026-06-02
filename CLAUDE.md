# Claude Instructions — Signalix Realtime

This is `Signalix-realtime`, the WebSocket server for Signalix v0.1.

## Absolute Rules

1. Use `@signalix/contracts` for all event names and payloads. Never invent local duplicates.
2. Never connect to PostgreSQL directly. Use `Signalix-api` for all persistence.
3. Never duplicate business logic from the API (message validation, auth issuance, etc.).
4. JWT verification uses `JWT_SECRET` only — never trust unsigned or unverified tokens.
5. All API calls forward the user's own access token from the WebSocket session.
6. Do not implement Redis, Kafka, or NATS in v0.1.
7. Do not implement typing indicators in v0.1 (contracts define them; implementation is v0.2).

## Technology

- Node.js 22
- TypeScript (strict)
- `ws` — WebSocket server
- `jsonwebtoken` — JWT verification
- `@signalix/contracts` — event names and payload types

## Module Layout

```
src/
  server.ts               — bootstrap WebSocket server
  config/config.ts        — env vars (PORT, JWT_SECRET, API_BASE_URL)
  auth/jwt.ts             — verifyAccessToken()
  ws/
    connection-manager.ts — in-memory userId/deviceId → WebSocket map + chat participant cache
    event-router.ts       — per-socket event lifecycle and routing
  presence/
    presence.service.ts   — API calls + USER_ONLINE/USER_OFFLINE broadcasts
  common/
    api-client.ts         — typed HTTP calls to Signalix-api
    ws-helpers.ts         — send() and parseMessage()
```

## Connection Lifecycle

```
connect → client.authenticate → server.authenticated
        → (background) preload chats, mark online, broadcast USER_ONLINE
        → route events
        → close → mark offline, broadcast USER_OFFLINE
```

## Routing Strategy

The server maintains an in-memory `chatId → Set<userId>` cache populated:
- On connect: by preloading `GET /api/v1/chats`
- On first message: from `recipientUsername` lookup

After a server restart the cache is empty; clients recover missed messages via
`GET /api/v1/chats/:chatId/messages` (documented offline-recovery flow).

## What Is NOT Implemented in v0.1

- Typing indicators (contracts exist; feature is v0.2)
- Redis Pub/Sub (single-instance only in v0.1)
- Multi-instance horizontal scaling
- Direct database access
- Group chat events
