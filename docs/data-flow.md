# Data Flow Backend -> Frontend

Tai lieu nay giai thich flow data hien tai cua source `sportz`: backend Express + PostgreSQL/Drizzle + WebSocket, frontend React/Vite.

> Luu y: source da co them production WebSocket v1. Contract moi, auth, reconnect va hardening nam trong `docs/production-websocket.md`. Mot so muc review/mismatch cuoi tai lieu nay duoc viet tu goc nhin ban dau khi source con la demo hoc socket.

## 1. Tong quan kien truc

```
PostgreSQL
  |
  | Drizzle ORM
  v
Express backend
  |-- REST API: /matches, /matches/:id/commentary
  |-- WebSocket: /ws
  |
  v
React frontend
  |-- fetch REST de lay snapshot ban dau
  |-- mo WebSocket de nhan event realtime
  v
UI: danh sach tran dau + live feed commentary
```

Co 2 duong data chinh:

1. REST API: dung de lay du lieu hien tai tu database.
2. WebSocket: dung de day event realtime tu backend sang frontend khi co thay doi.

## 2. Data model trong backend

File chinh: `backend/src/db/schema.js`

Backend co 2 bang:

### `matches`

Dai dien cho mot tran dau.

Field quan trong:

- `id`: khoa chinh.
- `sport`: mon the thao.
- `homeTeam`, `awayTeam`: ten 2 doi.
- `status`: `scheduled`, `live`, hoac `finished`.
- `startTime`, `endTime`: thoi gian bat dau/ket thuc.
- `homeScore`, `awayScore`: ti so.
- `createdAt`: thoi diem tao record.

### `commentary`

Dai dien cho mot dong dien bien cua tran dau.

Field quan trong:

- `id`: khoa chinh.
- `matchId`: lien ket toi `matches.id`.
- `minute`, `period`, `eventType`, `actor`, `team`: metadata cua su kien.
- `message`: noi dung commentary.
- `createdAt`: thoi diem tao commentary.

## 3. Backend startup flow

File chinh: `backend/src/index.js`

Khi backend chay:

1. Tao Express app.
2. Tao HTTP server bang `http.createServer(app)`.
3. Gan middleware:
   - `express.json()` de doc JSON body.
   - `cors()` de frontend goi API duoc.
4. Gan REST routes:
   - `GET /matches`
   - `POST /matches`
   - `PATCH /matches/:id/score`
   - `GET /matches/:id/commentary`
   - `POST /matches/:id/commentary`
5. Goi `attachWebSocketServer(server)` de gan WebSocket server vao cung HTTP server.
6. Luu cac ham broadcast vao `app.locals`:
   - `broadcastMatchCreated`
   - `broadcastCommentary`
7. Start server.

Mac dinh backend dang listen port `8000`:

```js
const PORT = Number(process.env.PORT || 8000);
```

## 4. REST flow: frontend lay danh sach match

Frontend goi:

```ts
fetch(`${API_BASE_URL}/matches?limit=${limit}`)
```

File frontend:

- `frontend/src/services/api.ts`
- `frontend/src/hooks/useMatchData.ts`

Backend nhan tai:

```http
GET /matches?limit=100
```

File backend:

- `backend/src/routes/matches.js`

Flow:

1. Frontend mount app.
2. `useMatchData()` chay `loadMatches()`.
3. `loadMatches()` goi `fetchMatches(100)`.
4. Backend validate query bang `listMatchQuerySchema`.
5. Backend query database:

```js
db.select().from(matches).orderBy(desc(matches.createdAt)).limit(limit)
```

6. Backend tra ve:

```json
{
  "data": [
    {
      "id": 1,
      "sport": "football",
      "homeTeam": "A",
      "awayTeam": "B",
      "status": "live",
      "homeScore": 0,
      "awayScore": 0
    }
  ]
}
```

7. Frontend set vao state `matches`.
8. UI render cac `MatchCard`.

Frontend cung lap lai viec fetch matches moi 5 giay:

```ts
setInterval(() => {
  loadMatches();
}, 5000);
```

Vay nen danh sach match hien tai chu yeu duoc dong bo bang polling REST moi 5 giay.

## 5. REST flow: frontend lay commentary cua mot match

Khi user click watch mot tran:

1. Component `MatchCard` goi `watchMatch(match.id)`.
2. `watchMatch()` trong `useMatchData.ts`:
   - clear commentary cu.
   - set loading.
   - set `activeMatchId`.
   - subscribe WebSocket cho match.
   - goi REST API lay commentary hien co.

Frontend goi:

```http
GET /matches/:id/commentary?limit=100
```

Backend route:

```js
commentaryRouter.get("/")
```

Flow mong muon:

1. Validate `:id`.
2. Validate `limit`.
3. Query bang `commentary` theo `matchId`.
4. Sort moi nhat truoc bang `createdAt desc`.
5. Tra ve `{ data: results }`.
6. Frontend set vao state `commentary`.
7. `LiveFeed` render o cot ben phai.

## 6. WebSocket connection flow

File frontend:

- `frontend/src/hooks/useWebSocket.ts`

File backend:

- `backend/src/ws/server.js`

Frontend mo WebSocket khi app mount:

```ts
connectGlobal();
```

URL duoc tao tu:

```ts
const socketUrl = `${WS_BASE_URL}?all=1`;
```

Mac dinh frontend dang de:

```ts
ws://localhost:3000/ws
```

Backend dang lang nghe WebSocket tai:

```txt
ws://localhost:8000/ws
```

Neu khong co `.env` override, frontend va backend dang lech port.

### Backend upgrade HTTP -> WebSocket

Backend dung chung HTTP server voi Express. Khi client request upgrade:

1. Backend kiem tra pathname co phai `/ws` khong.
2. Neu dung, goi `wss.handleUpgrade(...)`.
3. Tao connection WebSocket.
4. Gan `socket.subscriptions = new Set()`.
5. Gui message dau tien:

```json
{ "type": "welcome" }
```

### Heartbeat

Backend co heartbeat moi 3 giay:

1. Neu socket da khong tra loi pong tu lan truoc, terminate.
2. Neu con song, set `isAlive = false` va gui ping.
3. Khi client tra pong, backend set `isAlive = true`.

Day la pattern de don dep connection chet.

## 7. Subscribe/unsubscribe flow

Khi user watch mot tran:

Frontend gui:

```json
{
  "type": "subscribe",
  "matchId": 1
}
```

Backend xu ly trong `handleMessage()`:

1. Parse JSON.
2. Neu `type === "subscribe"` va `matchId` la integer:
   - them socket vao `matchSubsribers.get(matchId)`.
   - them `matchId` vao `socket.subscriptions`.
   - gui ack:

```json
{
  "type": "subscribed",
  "matchId": 1
}
```

Khi user unwatch:

Frontend gui:

```json
{
  "type": "unsubscribe",
  "matchId": 1
}
```

Backend:

1. Xoa socket khoi danh sach subscribers cua match.
2. Xoa `matchId` khoi `socket.subscriptions`.
3. Gui ack:

```json
{
  "type": "unsubscribed",
  "matchId": 1
}
```

Khi socket close, backend goi `cleanupSubscriptions(socket)` de xoa socket khoi tat ca match da subscribe.

## 8. Realtime commentary flow

Day la flow realtime dang ro nhat trong source hien tai.

### Tao commentary tu REST

Client/tool/API caller goi:

```http
POST /matches/:id/commentary
Content-Type: application/json

{
  "minute": 12,
  "message": "Home team has a dangerous attack"
}
```

Backend:

1. Validate `:id`.
2. Validate body bang `createCommentarySchema`.
3. Insert record vao bang `commentary`.
4. Goi:

```js
res.app.locals.broadcastCommentary(result.matchId, result);
```

### Broadcast qua WebSocket

`broadcastCommentary(matchId, comment)` goi:

```js
broadcastToMatch(matchId, {
  type: "commentary",
  data: comment,
});
```

Backend chi gui event nay toi nhung socket da subscribe dung `matchId`.

Message frontend nhan:

```json
{
  "type": "commentary",
  "data": {
    "id": 10,
    "matchId": 1,
    "minute": 12,
    "message": "Home team has a dangerous attack",
    "createdAt": "2026-06-10T..."
  }
}
```

### Frontend update UI

Trong `useMatchData.ts`, `handleWSMessage()` xu ly:

```ts
case "commentary":
  if (msg.data.matchId != latestMatchIdRef.current) return;
  setCommentary((prev) => [normalized, ...prev]);
  break;
```

Nghia la:

1. Chi hien commentary neu no thuoc match dang active.
2. Commentary moi duoc chen len dau list.
3. `LiveFeed` render lai ngay, khong can refetch REST.

## 9. Realtime match created flow

Backend da co broadcast khi tao match:

```js
res.app.locals.broadcastMatchCreated(event);
```

Message backend gui:

```json
{
  "type": "match_created",
  "data": {
    "id": 2,
    "sport": "football",
    "homeTeam": "A",
    "awayTeam": "B"
  }
}
```

Nhung frontend hien tai chua handle `match_created` trong type `WSMessage` va trong `handleWSMessage()`.

Ket qua hien tai:

- Backend co broadcast event.
- Frontend nhan duoc event nhung bo qua vi roi vao `default`.
- Danh sach match moi van duoc cap nhat nho polling `GET /matches` moi 5 giay.
- `newMatchesCount` tang khi polling thay co match id moi.

## 10. Score update flow hien tai

Frontend da co code xu ly:

```ts
case "score_update":
  setMatches(...)
```

Nhung backend hien tai chua day du flow nay.

Backend co route:

```http
PATCH /matches/:id/score
```

Muc tieu cua route:

1. Validate `:id`.
2. Validate body `{ homeScore, awayScore }`.
3. Check match ton tai.
4. Sync status theo `startTime`/`endTime`.
5. Chi cho update score neu match dang `live`.
6. Update database.
7. Broadcast score update.

Nhung trong code hien tai co mot so van de:

- `broadcastScoreUpdate` khong duoc tao trong WebSocket server va khong duoc gan vao `app.locals`.
- `backend/src/ws/server.js` khong co ham broadcast score.
- Do do frontend gan nhu chua nhan duoc `score_update` tu backend.

Vi vay trong source hien tai, ti so tren UI chu yeu den tu REST polling, chua phai realtime WebSocket.

## 11. Frontend state flow trong `useMatchData`

Hook `useMatchData()` la noi gom data REST + WebSocket thanh state cho UI.

State quan trong:

- `matches`: danh sach tran dau.
- `commentary`: live feed cua match dang watch.
- `activeMatchId`: match dang duoc user watch.
- `status`: trang thai WebSocket tu `useWebSocket`.
- `newMatchesCount`: so match moi phat hien qua polling.
- `wsError`: loi WebSocket neu server gui message `error`.

Flow khi app load:

1. `loadMatches()` fetch REST.
2. `connectGlobal()` mo WebSocket.
3. UI render list match.
4. Moi 5 giay, `loadMatches()` fetch lai.

Flow khi user watch match:

1. `watchMatch(id)` clear feed cu.
2. Subscribe WebSocket match id.
3. Fetch commentary cu qua REST.
4. Neu co commentary moi tu WebSocket, chen vao dau feed.

Flow khi user unwatch:

1. Gui unsubscribe WebSocket.
2. Clear `activeMatchId`.
3. Clear commentary.

## 12. Nhung mismatch/bug nen biet khi hoc flow

Day la cac diem dang co trong source hien tai, nen doc de tranh bi roi khi test.

### 1. Frontend port mac dinh khong khop backend

Frontend mac dinh:

```ts
http://localhost:3000
ws://localhost:3000/ws
```

Backend mac dinh:

```txt
http://localhost:8000
ws://localhost:8000/ws
```

Nen tao file env cho frontend hoac sua constants:

```env
VITE_API_BASE_URL=http://localhost:8000
VITE_WS_BASE_URL=ws://localhost:8000/ws
```

### 2. Frontend co message `setSubscriptions`, backend khong xu ly

Khi reconnect, frontend gui:

```json
{
  "type": "setSubscriptions",
  "matchIds": [...]
}
```

Backend hien chi xu ly:

- `subscribe`
- `unsubscribe`

Nen sau reconnect, nen gui lai tung message `subscribe`, hoac backend can implement `setSubscriptions`.

### 3. Backend broadcast `match_created`, frontend chua handle

Neu muon realtime match list that su, frontend can them:

- type `match_created` vao `WSMessage`.
- case `"match_created"` trong `handleWSMessage`.
- chen match moi vao `matches`.

### 4. Score realtime chua hoan chinh

Frontend san sang nhan `score_update`, nhung backend chua co `broadcastScoreUpdate`.

Can them vao `attachWebSocketServer()`:

```js
function broadcastScoreUpdate(matchId, score) {
  broadcastToMatch(matchId, { type: "score_update", matchId, data: score });
}
```

Va return/gan vao `app.locals`.

### 5. `GET /matches/:id/commentary` dang destructuring sai

Trong `backend/src/routes/commentary.js`:

```js
const { id: matchId } = paramsResult.data.id;
```

`paramsResult.data.id` la number, nen khong destructure duoc thanh object. Nen sua thanh:

```js
const { id: matchId } = paramsResult.data;
```

### 6. `POST /matches/:id/commentary` catch dang rong

Neu insert fail, route hien tai khong tra response loi ro rang:

```js
} catch (error) {}
```

Nen tra `500` de client khong bi treo request.

### 7. `createCommentarySchema.message` optional nhung database bat buoc

Schema database de `message` la `notNull()`, nhung validation dang:

```js
message: z.string().optional()
```

Nen doi thanh:

```js
message: z.string().min(1)
```

### 8. `PATCH /matches/:id/score` update query co loi `.returning`

Trong `backend/src/routes/matches.js`:

```js
.where(eq(matches.id, matchId)).returning;
```

Nen la:

```js
.where(eq(matches.id, matchId))
.returning();
```

## 13. Cach test flow bang tay

### Start backend

```bash
cd backend
pnpm dev
```

Backend can `DATABASE_URL`.

### Start frontend

```bash
cd frontend
pnpm dev
```

Dam bao frontend env tro ve backend port dung:

```env
VITE_API_BASE_URL=http://localhost:8000
VITE_WS_BASE_URL=ws://localhost:8000/ws
```

### Test REST matches

```bash
curl http://localhost:8000/matches?limit=10
```

### Test WebSocket commentary

1. Mo frontend.
2. Click watch mot match.
3. Tao commentary:

```bash
curl -X POST http://localhost:8000/matches/1/commentary \
  -H "Content-Type: application/json" \
  -d '{"minute":12,"message":"A dangerous attack from home team"}'
```

Neu flow dung:

- Backend insert commentary.
- Backend broadcast `commentary` toi socket dang subscribe match `1`.
- Frontend nhan message.
- `LiveFeed` hien commentary moi ngay lap tuc.

## 14. Tom tat ngan gon

- REST API lay snapshot: danh sach match va commentary cu.
- WebSocket day event moi: commentary realtime, match created da co backend broadcast nhung frontend chua dung.
- Frontend `useMatchData` la noi merge REST data va WebSocket events vao React state.
- Hien tai flow realtime commentary la flow chinh nen hoc truoc.
- Score realtime va match created realtime can sua them de hoan chinh.
