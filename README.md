# Signalix Realtime

WebSocket server for Signalix v0.1. Handles real-time message delivery, presence, and heartbeat. Calls `Signalix-api` for all persistence — it never touches the database directly.

## Stack

- **Node.js 22**, TypeScript (strict)
- **`ws`** — WebSocket server
- **`jsonwebtoken`** — JWT verification (shared secret with API)
- **`@signalix/contracts`** — event names and payload types

## Local setup

### Prerequisites

- Node.js 22+
- `Signalix-api` running and reachable (default `http://localhost:4000`)
- `Signalix-contracts` built (see below)

### 1. Build contracts

```bash
# From the monorepo root (proyect/)
cd Signalix-contracts
npm install
npm run build
cd ..
```

### 2. Configure env

```bash
cd Signalix-realtime
cp .env.example .env
```

Edit `.env`:

| Variable       | Required | Description                                               |
|----------------|----------|-----------------------------------------------------------|
| `PORT`         | no       | WebSocket listen port (default `5000`)                    |
| `NODE_ENV`     | no       | `development` or `production`                             |
| `JWT_SECRET`   | **yes**  | Must be identical to `Signalix-api` `JWT_SECRET`          |
| `API_BASE_URL` | **yes**  | Base URL of the REST API, e.g. `http://localhost:4000`    |

### 3. Run

```bash
npm install
npm run dev       # ts-node watch (if configured) or:
npm run build && npm start
```

WebSocket server listens at `ws://localhost:5000`.

### Typecheck

```bash
npm run typecheck   # tsc --noEmit
```

## WebSocket protocol

All frames are JSON: `{ "event": "<event-name>", "payload": { ... } }`.

### Connection lifecycle

```
client connects
  → client sends   client.authenticate   { accessToken }
  ← server sends   server.authenticated  { userId, deviceId, connectedAt }
  → (background)   server preloads chats and marks user online
  ← server sends   server.user.online    to contacts

client closes / disconnects
  → server marks user offline (if no other devices remain)
  ← server sends   server.user.offline   to contacts
```

Authentication must complete within 30 seconds or the server closes the socket.

### Client → Server events

| Event                    | Payload fields                                              |
|--------------------------|-------------------------------------------------------------|
| `client.authenticate`    | `accessToken`                                               |
| `client.message.send`    | `ciphertext`, `messageType`, `chatId?`, `recipientUsername?`, `tempId?` |
| `client.message.delivered` | `messageId`, `chatId`                                     |
| `client.message.read`    | `messageId`, `chatId`                                       |
| `client.presence.update` | `status` (`online` \| `offline` \| `away`)                 |
| `client.heartbeat`       | `timestamp`                                                 |

Either `chatId` **or** `recipientUsername` must be provided in `client.message.send`, not both.

### Server → Client events

| Event                    | Payload fields                                              |
|--------------------------|-------------------------------------------------------------|
| `server.authenticated`   | `userId`, `deviceId`, `connectedAt`                         |
| `server.message.sent`    | `messageId`, `chatId`, `senderId`, `tempId?`, `timestamp`   |
| `server.message.new`     | `messageId`, `chatId`, `senderId`, `ciphertext`, `messageType`, `timestamp` |
| `server.message.delivered` | `messageId`, `chatId`, `userId`, `status`, `timestamp`    |
| `server.message.read`    | `messageId`, `chatId`, `userId`, `status`, `timestamp`      |
| `server.user.online`     | `userId`, `deviceId`, `timestamp`                           |
| `server.user.offline`    | `userId`, `deviceId`, `timestamp`                           |
| `server.heartbeat.ack`   | `timestamp`                                                 |
| `server.error`           | `code`, `message`                                           |

## Project structure

```
src/
  server.ts                  # WebSocket server bootstrap
  config/config.ts           # Env vars (PORT, JWT_SECRET, API_BASE_URL)
  auth/jwt.ts                # verifyAccessToken()
  ws/
    connection-manager.ts    # In-memory userId/deviceId → socket map + chat participant cache
    event-router.ts          # Per-socket event lifecycle and routing
  presence/
    presence.service.ts      # USER_ONLINE / USER_OFFLINE broadcasts via API
  common/
    api-client.ts            # Typed HTTP calls to Signalix-api
    ws-helpers.ts            # send() and parseMessage() utilities
```

## Docker

Build from the **monorepo root** (required — Dockerfile needs both `Signalix-contracts/` and `Signalix-realtime/` in build context):

```bash
# From proyect/
docker build -f Signalix-realtime/Dockerfile -t signalix-realtime .
```

Use `Signalix-infra` Docker Compose for local development — it handles build context, service dependencies, and shared `JWT_SECRET` automatically.

## Known v0.1 limitations

- **Single instance only.** Chat participant routing is in-memory (`chatId → Set<userId>`). A second server instance would have an empty cache and miss messages. Redis Pub/Sub is the v0.2 fix.
- **Cache is not persisted across restarts.** After a restart, the routing cache is empty. Clients recover missed messages by polling `GET /api/v1/chats/:chatId/messages` on reconnect.
- **No typing indicators.** `client.typing.start` / `client.typing.stop` events are defined in contracts but not routed in v0.1.
- **No direct DB access.** All reads and writes go through `Signalix-api`. If the API is unavailable, the realtime service cannot authenticate connections or persist messages.
- **Access token forwarded as-is.** The realtime service forwards the user's access token to the API on their behalf. Token rotation (on 401) is not implemented in the realtime layer.
