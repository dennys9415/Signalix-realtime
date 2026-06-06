# Signalix Realtime

**Version: v0.5.0**

WebSocket server for Signalix. Handles real-time message delivery, delivery/read receipts, typing indicators, reactions, edits, deletions, presence broadcasts, and heartbeat. Calls `Signalix-api` for all persistence — it never touches the database directly.

## Stack

- **Node.js 22**, TypeScript (strict)
- **`ws`** — WebSocket server
- **`jsonwebtoken`** — JWT verification (shared secret with API)
- **`@signalix/contracts`** — event names and payload types

## Architecture

```
Signalix-frontend  ──WebSocket──►  Signalix-realtime  ──HTTP──►  Signalix-api  ──SQL──►  PostgreSQL
```

The realtime server is stateless in terms of persistence. All message storage, user lookups, and presence updates flow through REST calls to `Signalix-api`.

## Local setup

### Prerequisites

- Node.js 22+
- `Signalix-api` running and reachable (default `http://localhost:4000`)
- `Signalix-contracts` built (see step 1)

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

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | WebSocket listen port (default `5000`) |
| `NODE_ENV` | no | `development` or `production` |
| `JWT_SECRET` | **yes** | Must be identical to `Signalix-api` `JWT_SECRET` |
| `API_BASE_URL` | **yes** | Base URL of the REST API, e.g. `http://localhost:4000` |

### 3. Run

```bash
npm install
npm run start:dev   # ts-node-dev, watch mode
# or
npm run build && npm start
```

WebSocket server listens at `ws://localhost:5000`.

### Typecheck

```bash
npm run typecheck   # tsc --noEmit
```

### Build

```bash
npm run build   # outputs to dist/
```

## WebSocket protocol

All frames are JSON: `{ "event": "<event-name>", "payload": { ... } }`.

### Connection lifecycle

```
client connects
  → client sends   client.authenticate     { accessToken }
  ← server sends   server.authenticated    { userId, deviceId, connectedAt }
  → (background)   server preloads chats, marks user online
  ← server sends   server.user.online      to contacts

(exchange messages, status updates, heartbeats)

client closes / disconnects
  → server marks user offline (if no other devices remain)
  ← server sends   server.user.offline     to contacts
```

Authentication must complete within 30 seconds or the server closes the socket.

### Client → Server events

| Event | Payload |
|---|---|
| `client.authenticate` | `accessToken` |
| `client.message.send` | `ciphertext`, `messageType`, `chatId?`, `recipientUsername?`, `tempId?`, `replyToMessageId?`, `isForwarded?` |
| `client.message.delivered` | `messageId`, `chatId` |
| `client.message.read` | `messageId`, `chatId` |
| `client.message.edit` | `messageId`, `chatId`, `ciphertext` |
| `client.message.delete_for_everyone` | `messageId`, `chatId` |
| `client.message.reaction_set` | `messageId`, `chatId`, `emoji` |
| `client.message.reaction_remove` | `messageId`, `chatId` |
| `client.typing.start` | `chatId` |
| `client.typing.stop` | `chatId` |
| `client.presence.update` | `status` (`online` \| `offline` \| `away`) |
| `client.heartbeat` | `timestamp` |

Either `chatId` **or** `recipientUsername` must be provided in `client.message.send`, not both. The frontend's draft chats use `recipientUsername` only — the `draft:<userId>` client-side IDs are never sent to the server.

### Server → Client events

| Event | Payload |
|---|---|
| `server.authenticated` | `userId`, `deviceId`, `connectedAt` |
| `server.message.sent` | `messageId`, `chatId`, `senderId`, `tempId?`, `timestamp`, `linkPreview?` |
| `server.message.new` | `messageId`, `chatId`, `senderId`, `ciphertext`, `messageType`, `timestamp`, `replyTo?`, `isForwarded?`, `linkPreview?` |
| `server.message.delivered` | `messageId`, `chatId`, `userId`, `status`, `timestamp` |
| `server.message.read` | `messageId`, `chatId`, `userId`, `status`, `timestamp` |
| `server.message.edited` | `messageId`, `chatId`, `ciphertext`, `editedAt` |
| `server.message.deleted_for_everyone` | `messageId`, `chatId`, `deletedAt` |
| `server.message.reaction_updated` | `messageId`, `chatId`, `reactions[]` |
| `server.typing.start` | `chatId`, `userId` |
| `server.typing.stop` | `chatId`, `userId` |
| `server.user.online` | `userId`, `deviceId`, `timestamp` |
| `server.user.offline` | `userId`, `deviceId`, `timestamp` |
| `server.heartbeat.ack` | `timestamp` |
| `server.error` | `code`, `message` |

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

## v0.5.0 changelog

### Added since v0.2.0
- **Typing indicators** — `client.typing.start` / `client.typing.stop` are now routed to the other chat participants as `server.typing.start` / `server.typing.stop`
- **Message edit** — `client.message.edit` → API persistence → `server.message.edited` broadcast
- **Delete for everyone** — `client.message.delete_for_everyone` → API soft-delete → `server.message.deleted_for_everyone` broadcast
- **Reactions** — `client.message.reaction_set` / `client.message.reaction_remove` → API persistence → `server.message.reaction_updated` broadcast with full reaction list
- **Reply / Forward routing** — `replyToMessageId` and `isForwarded` flow through `client.message.send` and are echoed in `server.message.new`
- **Link previews in events** — `linkPreview` is attached to `server.message.sent` and `server.message.new` when the API produces one
- **Group chat routing** — chat participant cache supports `chatId → Set<userId>` for any participant count; `server.message.new` fans out to all participants
- **First-message-from-draft** — frontend drafts (`draft:<userId>`) are translated to `recipientUsername`-only sends, so the realtime layer transparently creates the chat and delivers `server.message.new` to the recipient

### v0.5.0 stabilization
- Routing cache is refreshed when a new direct chat is created from a `recipientUsername` send, so subsequent messages reach the recipient without a reconnect.

## Known limitations

- **Single instance only.** Chat participant routing is in-memory (`chatId → Set<userId>`). A second server instance has an empty cache and misses messages. Horizontal scaling requires Redis Pub/Sub (planned).
- **Cache is not persisted across restarts.** After a restart the routing cache is empty. Clients recover missed messages by polling `GET /api/v1/chats/:chatId/messages` on reconnect.
- **No direct DB access.** All reads and writes go through `Signalix-api`. If the API is unavailable, the realtime service cannot authenticate connections or persist messages.
- **Access token forwarded as-is.** Token rotation (on 401) is not implemented in the realtime layer.

## Planned

- Redis Pub/Sub for horizontal scaling
- Token refresh in the realtime layer
- Per-participant read receipts in group chats
