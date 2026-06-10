# Production WebSocket V1

Tai lieu nay mo ta contract production v1 dang duoc implement trong source.

## Local configuration

Backend WebSocket chay chung HTTP server tai:

```txt
ws://localhost:8000/ws
```

Frontend can tro ve backend:

```env
VITE_API_BASE_URL=http://localhost:8000
VITE_WS_BASE_URL=ws://localhost:8000/ws
VITE_WS_AUTH_TOKEN=dev-token
```

Backend production nen set:

```env
JWT_SECRET=<hs256-secret>
WS_MAX_PAYLOAD_BYTES=65536
WS_HEARTBEAT_INTERVAL_MS=30000
WS_MAX_SUBSCRIPTIONS_PER_SOCKET=50
WS_RATE_LIMIT_WINDOW_MS=10000
WS_RATE_LIMIT_MAX_MESSAGES=40
```

Neu backend chua co `JWT_SECRET`, server chi chap nhan dev token `WS_DEV_TOKEN` hoac `dev-token`.

## Auth

Client connect bang query token:

```txt
ws://localhost:8000/ws?token=<jwt-or-dev-token>
```

Production token la JWT HS256. Backend verify `exp` va signature bang `JWT_SECRET`.

## Client messages

```json
{ "type": "subscribe_match", "matchId": 1 }
```

```json
{ "type": "unsubscribe_match", "matchId": 1 }
```

```json
{ "type": "set_subscriptions", "matchIds": [1, 2] }
```

```json
{ "type": "ping" }
```

## Server messages

```json
{
  "type": "welcome",
  "occurredAt": "2026-06-10T00:00:00.000Z",
  "userId": "user-id",
  "heartbeatIntervalMs": 30000,
  "maxSubscriptions": 50
}
```

```json
{
  "type": "match_created",
  "eventId": "...",
  "occurredAt": "...",
  "data": {}
}
```

```json
{
  "type": "score_update",
  "eventId": "...",
  "occurredAt": "...",
  "matchId": 1,
  "data": {
    "homeScore": 1,
    "awayScore": 0,
    "status": "live"
  }
}
```

```json
{
  "type": "commentary_created",
  "eventId": "...",
  "occurredAt": "...",
  "matchId": 1,
  "data": {}
}
```

## Runtime behavior

- Frontend queues subscribe/unsubscribe neu socket chua open.
- Khi reconnect thanh cong, frontend gui `set_subscriptions` de restore match dang watch.
- Frontend dedupe event bang `eventId`; commentary con dedupe them bang `commentary.id`.
- REST van la snapshot/recovery path; polling recovery giam con 30 giay.
- Backend validate message bang Zod, rate-limit incoming messages, gioi han so subscription tren moi socket.
- Backend heartbeat bang WebSocket ping/pong va graceful shutdown khi process nhan `SIGINT`/`SIGTERM`.
