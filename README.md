# Signalix Realtime

**Version: v0.15.0**

> v0.10.0 turns on **per-recipient broadcast** for group encrypted text messages. `event-router.onMessageSend` and `onMessageEdit` now read `recipientPayloads` off the API response and deliver each participant only their own ciphertext + envelope; non-recipients get the empty sentinel and render the failure placeholder. Direct E2EE flow is unchanged. The WS protocol is additive — `recipients?` is optional on `client.message.send` and `client.message.edit`; older clients keep working.

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

## v0.15.0 changelog — Key backup & device recovery (realtime no-op)

### Not changed
- Backup/restore is entirely client-side. No WS event additions, no payload changes, no env var changes.

## v0.14.0 changelog — Read receipts (realtime no-op)

### Not changed
- The status fan-out path (`onMessageStatus` → `api.updateMessageStatus` → `server.message.read` / `server.message.delivered` broadcast to other participants) was already in place since v0.1.0 and handles the frontend's new "mark all unread" loop without changes. Heartbeat handling was also already wired (`client.heartbeat` → `server.heartbeat.ack`); the v0.14.0 client just now fires it on a 30s interval.
- No new events, no payload changes, no env var changes.

## v0.13.0 changelog — Message search (realtime no-op)

### Not changed
- Search lives entirely in `Signalix-api` (SQL WHERE extension) and `Signalix-frontend` (client-side store walk + UI). The realtime layer has no role.

## v0.12.0 changelog — Safety number / device verification UI (realtime no-op)

### Not changed
- The verification feature has no realtime touchpoints — no new WS events, no new payloads, no env var changes.

## v0.11.0 changelog — Media / file / voice E2EE beta (realtime no-op)

### Not changed
- v0.11.0 lands entirely in `Signalix-frontend` (encrypt-then-upload + render-side decrypt) and `Signalix-api` (`POST /media/encrypted-blob` + lifted TEXT-only guard on `recipients[]`). The realtime layer's per-device fan-out already handles IMAGE / FILE / AUDIO unchanged — the wire shape is identical to v0.10.x text messages, only the metadata inside the encrypted envelope shifted.
- No new events, no new payload fields, no env var changes.

## v0.10.1 changelog — Per-device routing + chat-created broadcast

### Added
- **`onChatCreated` handler** for `client.chat.created`. Re-fetches the canonical ChatDTO via `api.getChatById(chatId, conn.accessToken)` (which doubles as a participation check — the API throws FORBIDDEN if the caller isn't a member). Seeds `cm.learnChatParticipants` so subsequent message sends already know the routing; then fans `server.chat.created` out to every participant connection (skipping the originating device).
- **`api-client.getChatById(accessToken, chatId)`** — typed wrapper for the new `GET /api/v1/chats/:chatId` endpoint.
- **Per-device `recipientPayloads` lookup** in `onMessageSend` + `onMessageEdit`. The override is keyed by `participantConn.deviceId` (was `participantId`), so a recipient logged in on two browsers gets the envelope encrypted to *that* device, not last-write-wins.
- **Dev-only `[signalix-rt] fan-out delivery` log** at each per-device send (gated by `NODE_ENV !== 'production'`).

### Fixed
- The `recipientPayloads` map used to be looked up by user id, which silently collapsed a multi-device recipient down to whichever entry the API's response builder wrote last. Now both devices receive their own envelope.

### Not changed
- No new env vars, no protocol break beyond the additive event. WS event name registry still gated through `@signalix/contracts`.

## v0.10.0 changelog — Group E2EE beta

### Added
- **`event-router.onMessageSend` per-recipient broadcast.** When `result.recipientPayloads` is present (group encrypted send from the API), the router builds a personalized `server.message.new` payload per participant: each recipient gets `ciphertext + envelope` encrypted to their device; non-recipients (sender's other devices, or anyone not in the map) get the top-level row (empty sentinel for group encrypted sends).
- **`event-router.onMessageEdit` per-recipient broadcast.** Symmetric path for edits. Accepts `payload.recipients` and forwards it + envelope fields through `api.editMessage`. Builds the per-recipient `server.message.edited` from `result.recipientPayloads`.
- **Empty `ciphertext` accepted** when `recipients[]` is present (group encrypted body lives in the per-recipient map).
- **`common/api-client.sendMessage`** signature widened with `recipients?: GroupRecipientPayloadDTO[]`.
- **`common/api-client.editMessage`** now takes a payload object (was positional `ciphertext`). Forwards envelope fields + `recipients`.

### Not changed
- No new events, no new env vars, no protocol break. `recipients` is an additive optional field on existing payloads.
- Direct E2EE flow — unchanged. The per-recipient loop falls back to the top-level message envelope when `recipientPayloads` is absent.
- Routing cache, presence, typing, status, heartbeat, reactions, delete-for-everyone — untouched.

## v0.9.1 changelog — E2EE hardening

### Not changed
- The realtime service is untouched in v0.9.1. All E2EE-hardening work lives in `Signalix-api` (signature verification, byte-length checks) and `Signalix-frontend` (bundle validation, one-time pre-key consumption, reset detection, decrypt failure cache, safety-number foundation). The WS protocol, event-router code, and `common/api-client` payload types are byte-for-byte identical to v0.9.0.
- No new env vars, no new events, no payload changes, no infra changes.

## v0.9.0 changelog — Signal Protocol Beta

### Fixed (post-initial-cut)
- **`event-router.onMessageSend` now forwards the encryption envelope fields end-to-end.** The first cut of v0.9.0 missed two lines:
  - `api.sendMessage(...)` call didn't extract `payload.{encryptionVersion, senderDeviceId, recipientDeviceId, preKeyId, signedPreKeyId}` from the incoming WS frame → the API persisted rows with `encryption_version = 0` and the envelope columns NULL, defeating decryption.
  - `ServerMessageNewPayload` construction didn't spread the same fields from the API's returned `MessageDTO` → recipients received the JSON envelope as raw ciphertext without the `encryptionVersion >= 1` flag that triggers the client decrypt path, so the chat UI rendered `{"v":1,"c":"…","iv":"…","eph":"…"}` verbatim.
- **`common/api-client.sendMessage` payload type widened** with the five optional envelope fields so the typecheck-supported wire shape now matches what event-router forwards.

### Not changed
- The realtime service is otherwise untouched. v0.9.0 turns on real E2EE for direct text messages, but the WS protocol is identical to v0.8.0 — the encryption envelope fields on `client.message.send` and `server.message.new` are populated with real values by the v0.9.0 frontend; the WS layer forwards them. v0.7.x / v0.8.0 clients keep working (they'll see opaque ciphertext for direct text from v0.9.0+ peers, but no protocol error).

## v0.8.0 changelog

### Not changed
- The realtime service is untouched. v0.8.0's encryption foundation lives entirely in the REST API + frontend. The new optional envelope fields on `client.message.send` / `server.message.new` are additive properties on the existing payloads (already contracts-defined since v0.8.0); the WS layer just forwards them. No new events, no new env vars, no protocol break for v0.7.x clients.

## v0.7.1 changelog

### Not changed
- v0.7.1 search work is REST-only (`/messages/search`, `/chats/:chatId/search`). No realtime change.

## v0.7.0 changelog

### Not changed
- Group improvements (avatar, description, transfer ownership) are entirely REST-driven and persisted by `Signalix-api`. The realtime service is untouched — no new events, no payload changes.

## v0.6.1 changelog

### Fixed
- **`common/api-client.ts`** — `sendMessage()` payload typing was hard-coded to `MessageType.TEXT | MessageType.IMAGE | MessageType.FILE`. AUDIO messages from the frontend would type-error here in strict mode (or be silently coerced). Replaced with the new `SendableMessageType` alias from contracts so voice notes round-trip through realtime → API without an extra mapping step.

### Not changed
- Connection routing, presence broadcasts and event-router behaviour are untouched. AUDIO follows the same `client.message.send → POST /messages/send → server.message.new` path as every other message type.

## v0.6.0 changelog

### Not changed
- The realtime service stayed identical for the PWA + Web Push work — push dispatch lives in the API (it queries `presence.status` post-persist), not in the WS layer. No new events, no new payloads, no new env vars.

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
