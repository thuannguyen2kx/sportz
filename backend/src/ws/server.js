import crypto from "crypto";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

const CLOSE_CODES = {
  UNAUTHORIZED: 4401,
  RATE_LIMITED: 4429,
  SERVER_SHUTDOWN: 1012,
};

const ERROR_CODES = {
  INVALID_MESSAGE: "invalid_message",
  RATE_LIMITED: "rate_limited",
  TOO_MANY_SUBSCRIPTIONS: "too_many_subscriptions",
  INTERNAL_ERROR: "internal_error",
};

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET = 50;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 10000;
const DEFAULT_RATE_LIMIT_MAX_MESSAGES = 40;
const DEV_TOKEN = process.env.WS_DEV_TOKEN || "dev-token";

const matchSubscribers = new Map();

const messageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe_match"),
    matchId: z.coerce.number().int().positive(),
  }),
  z.object({
    type: z.literal("unsubscribe_match"),
    matchId: z.coerce.number().int().positive(),
  }),
  z.object({
    type: z.literal("set_subscriptions"),
    matchIds: z.array(z.coerce.number().int().positive()).max(100),
  }),
  z.object({
    type: z.literal("ping"),
  }),
]);

function readPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const config = {
  maxPayloadBytes: readPositiveInt(
    process.env.WS_MAX_PAYLOAD_BYTES,
    DEFAULT_MAX_PAYLOAD_BYTES,
  ),
  heartbeatIntervalMs: readPositiveInt(
    process.env.WS_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  ),
  maxSubscriptionsPerSocket: readPositiveInt(
    process.env.WS_MAX_SUBSCRIPTIONS_PER_SOCKET,
    DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET,
  ),
  rateLimitWindowMs: readPositiveInt(
    process.env.WS_RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
  ),
  rateLimitMaxMessages: readPositiveInt(
    process.env.WS_RATE_LIMIT_MAX_MESSAGES,
    DEFAULT_RATE_LIMIT_MAX_MESSAGES,
  ),
};

function log(level, message, meta = {}) {
  const entry = {
    level,
    message,
    service: "websocket",
    timestamp: new Date().toISOString(),
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function createEvent(type, data, extra = {}) {
  return {
    type,
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    ...extra,
    data,
  };
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function verifyJwtHs256(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  let header;
  let payload;

  try {
    header = JSON.parse(base64UrlDecode(encodedHeader));
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return null;
  }

  if (header.alg !== "HS256") return null;
  if (payload.exp && Date.now() >= payload.exp * 1000) return null;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return null;
  }

  return {
    id: payload.sub || payload.userId || "unknown",
    claims: payload,
  };
}

function verifySocketToken(token) {
  if (!token) return null;

  if (process.env.JWT_SECRET) {
    return verifyJwtHs256(token, process.env.JWT_SECRET);
  }

  if (token === DEV_TOKEN) {
    return {
      id: "development",
      claims: { sub: "development" },
    };
  }

  return null;
}

function getTokenFromRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const queryToken = url.searchParams.get("token");
  if (queryToken) return queryToken;

  const protocolHeader = req.headers["sec-websocket-protocol"];
  if (!protocolHeader) return null;

  return protocolHeader
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("token."))
    ?.slice("token.".length);
}

function rejectUpgrade(socket, statusCode, reason) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`,
  );
  socket.destroy();
}

function sendJson(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function sendError(socket, code, message) {
  sendJson(socket, { type: "error", code, message });
}

function subscribe(matchId, socket) {
  if (!matchSubscribers.has(matchId)) {
    matchSubscribers.set(matchId, new Set());
  }

  matchSubscribers.get(matchId).add(socket);
  socket.subscriptions.add(matchId);
}

function unsubscribe(matchId, socket) {
  const subscribers = matchSubscribers.get(matchId);

  if (subscribers) {
    subscribers.delete(socket);

    if (subscribers.size === 0) {
      matchSubscribers.delete(matchId);
    }
  }

  socket.subscriptions.delete(matchId);
}

function replaceSubscriptions(nextMatchIds, socket) {
  const uniqueMatchIds = Array.from(new Set(nextMatchIds));

  for (const matchId of Array.from(socket.subscriptions)) {
    if (!uniqueMatchIds.includes(matchId)) {
      unsubscribe(matchId, socket);
    }
  }

  for (const matchId of uniqueMatchIds) {
    subscribe(matchId, socket);
  }

  return Array.from(socket.subscriptions);
}

function cleanupSubscriptions(socket) {
  for (const matchId of Array.from(socket.subscriptions)) {
    unsubscribe(matchId, socket);
  }
}

function checkRateLimit(socket) {
  const now = Date.now();
  if (now - socket.rateLimit.windowStartedAt > config.rateLimitWindowMs) {
    socket.rateLimit.windowStartedAt = now;
    socket.rateLimit.count = 0;
  }

  socket.rateLimit.count += 1;
  return socket.rateLimit.count <= config.rateLimitMaxMessages;
}

function assertSubscriptionLimit(socket, nextSize) {
  if (nextSize <= config.maxSubscriptionsPerSocket) return true;

  sendError(
    socket,
    ERROR_CODES.TOO_MANY_SUBSCRIPTIONS,
    `Maximum subscriptions per socket is ${config.maxSubscriptionsPerSocket}`,
  );
  return false;
}

function broadcastToAll(wss, payload) {
  const message = JSON.stringify(payload);
  let sentCount = 0;

  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    client.send(message);
    sentCount += 1;
  }

  return sentCount;
}

function broadcastToMatch(matchId, payload) {
  const subscribers = matchSubscribers.get(matchId);
  if (!subscribers || subscribers.size === 0) return 0;

  const message = JSON.stringify(payload);
  let sentCount = 0;

  for (const client of subscribers) {
    if (client.readyState !== WebSocket.OPEN) continue;
    client.send(message);
    sentCount += 1;
  }

  return sentCount;
}

function handleParsedMessage(socket, message) {
  if (message.type === "ping") {
    sendJson(socket, { type: "pong", occurredAt: new Date().toISOString() });
    return;
  }

  if (message.type === "subscribe_match") {
    const nextSize = socket.subscriptions.has(message.matchId)
      ? socket.subscriptions.size
      : socket.subscriptions.size + 1;

    if (!assertSubscriptionLimit(socket, nextSize)) return;

    subscribe(message.matchId, socket);
    sendJson(socket, { type: "subscribed", matchId: message.matchId });
    log("info", "socket_subscribed", {
      matchId: message.matchId,
      userId: socket.user.id,
      subscriptionCount: socket.subscriptions.size,
    });
    return;
  }

  if (message.type === "unsubscribe_match") {
    unsubscribe(message.matchId, socket);
    sendJson(socket, { type: "unsubscribed", matchId: message.matchId });
    log("info", "socket_unsubscribed", {
      matchId: message.matchId,
      userId: socket.user.id,
      subscriptionCount: socket.subscriptions.size,
    });
    return;
  }

  if (message.type === "set_subscriptions") {
    const uniqueMatchIds = Array.from(new Set(message.matchIds));
    if (!assertSubscriptionLimit(socket, uniqueMatchIds.length)) return;

    const subscriptions = replaceSubscriptions(uniqueMatchIds, socket);
    sendJson(socket, { type: "subscriptions", matchIds: subscriptions });
    log("info", "socket_subscriptions_replaced", {
      userId: socket.user.id,
      subscriptionCount: subscriptions.length,
    });
  }
}

function handleMessage(socket, data) {
  if (!checkRateLimit(socket)) {
    sendError(
      socket,
      ERROR_CODES.RATE_LIMITED,
      "Too many WebSocket messages",
    );
    socket.close(CLOSE_CODES.RATE_LIMITED, ERROR_CODES.RATE_LIMITED);
    return;
  }

  let rawMessage;

  try {
    rawMessage = JSON.parse(data.toString());
  } catch {
    sendError(socket, ERROR_CODES.INVALID_MESSAGE, "Invalid JSON");
    return;
  }

  const parsed = messageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    sendError(socket, ERROR_CODES.INVALID_MESSAGE, "Invalid message payload");
    return;
  }

  try {
    handleParsedMessage(socket, parsed.data);
  } catch (error) {
    log("error", "socket_message_failed", {
      error: error instanceof Error ? error.message : String(error),
      userId: socket.user?.id,
    });
    sendError(socket, ERROR_CODES.INTERNAL_ERROR, "Internal WebSocket error");
  }
}

export function attachWebSocketServer(server) {
  if (!process.env.JWT_SECRET) {
    log("warn", "jwt_secret_missing_using_dev_token", {
      tokenHint: "Set JWT_SECRET for production. Current dev token is WS_DEV_TOKEN or dev-token.",
    });
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayloadBytes,
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);

    if (pathname !== "/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const user = verifySocketToken(getTokenFromRequest(req));
    if (!user) {
      log("warn", "socket_auth_failed", {
        remoteAddress: req.socket.remoteAddress,
      });
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket, req) => {
    socket.isAlive = true;
    socket.subscriptions = new Set();
    socket.rateLimit = {
      count: 0,
      windowStartedAt: Date.now(),
    };

    socket.on("pong", () => {
      socket.isAlive = true;
    });

    sendJson(socket, {
      type: "welcome",
      occurredAt: new Date().toISOString(),
      userId: socket.user.id,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      maxSubscriptions: config.maxSubscriptionsPerSocket,
    });

    log("info", "socket_connected", {
      userId: socket.user.id,
      remoteAddress: req.socket.remoteAddress,
    });

    socket.on("message", (data) => {
      handleMessage(socket, data);
    });

    socket.on("close", (code, reason) => {
      cleanupSubscriptions(socket);
      log("info", "socket_disconnected", {
        userId: socket.user.id,
        code,
        reason: reason.toString(),
      });
    });

    socket.on("error", (error) => {
      log("error", "socket_error", {
        userId: socket.user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }

      ws.isAlive = false;
      ws.ping();
    }
  }, config.heartbeatIntervalMs);

  wss.on("close", () => clearInterval(interval));

  function close() {
    clearInterval(interval);
    for (const client of wss.clients) {
      client.close(CLOSE_CODES.SERVER_SHUTDOWN, "server_shutdown");
    }
    wss.close();
  }

  function broadcastMatchCreated(match) {
    const payload = createEvent("match_created", match);
    const sentCount = broadcastToAll(wss, payload);
    log("info", "broadcast_match_created", {
      matchId: match.id,
      sentCount,
    });
  }

  function broadcastScoreUpdate(matchId, score) {
    const payload = createEvent("score_update", score, { matchId });
    const sentCount = broadcastToMatch(matchId, payload);
    log("info", "broadcast_score_update", {
      matchId,
      sentCount,
    });
  }

  function broadcastCommentaryCreated(matchId, comment) {
    const payload = createEvent("commentary_created", comment, { matchId });
    const sentCount = broadcastToMatch(matchId, payload);
    log("info", "broadcast_commentary_created", {
      matchId,
      commentaryId: comment.id,
      sentCount,
    });
  }

  return {
    broadcastMatchCreated,
    broadcastScoreUpdate,
    broadcastCommentaryCreated,
    close,
  };
}
