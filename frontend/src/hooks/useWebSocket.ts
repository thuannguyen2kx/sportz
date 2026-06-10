import { useCallback, useEffect, useRef, useState } from "react";
import {
  INITIAL_RECONNECT_DELAY,
  MAX_RECONNECT_DELAY,
  WS_AUTH_TOKEN,
  WS_BASE_URL,
} from "../constants";
import type { ConnectionStatus, WSClientMessage, WSMessage } from "../types";

interface UseWebSocketReturn {
  status: ConnectionStatus;
  connectionEpoch: number;
  connectGlobal: () => void;
  subscribeMatch: (matchId: string | number) => void;
  unsubscribeMatch: (matchId: string | number) => void;
  disconnect: () => void;
}

const buildSocketUrl = () => {
  const url = new URL(WS_BASE_URL);
  url.searchParams.set("token", WS_AUTH_TOKEN);
  return url.toString();
};

const normalizeId = (matchId: string | number) => String(matchId);

export const useWebSocket = (
  onMessage: (msg: WSMessage) => void,
): UseWebSocketReturn => {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [connectionEpoch, setConnectionEpoch] = useState(0);

  const ws = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const initConnectionRef = useRef<() => void>(() => {});
  const isIntentionalClose = useRef(false);
  const subscribedMatchIdsRef = useRef(new Set<string>());
  const pendingMessagesRef = useRef<WSClientMessage[]>([]);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
  }, []);

  const sendNow = useCallback((message: WSClientMessage) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(message));
      return true;
    }
    return false;
  }, []);

  const queueOrSend = useCallback(
    (message: WSClientMessage) => {
      if (sendNow(message)) return;
      pendingMessagesRef.current.push(message);
    },
    [sendNow],
  );

  const flushSubscriptions = useCallback(() => {
    sendNow({
      type: "set_subscriptions",
      matchIds: Array.from(subscribedMatchIdsRef.current),
    });

    const queued = pendingMessagesRef.current;
    pendingMessagesRef.current = [];
    queued.forEach((message) => {
      sendNow(message);
    });
  }, [sendNow]);

  const cleanupSocket = useCallback(() => {
    if (!ws.current) return;

    ws.current.onopen = null;
    ws.current.onmessage = null;
    ws.current.onerror = null;
    ws.current.onclose = null;
  }, []);

  const scheduleReconnect = useCallback((delay: number) => {
    reconnectTimeout.current = setTimeout(() => {
      reconnectAttempts.current += 1;
      initConnectionRef.current();
    }, delay);
  }, []);

  const initConnection = useCallback(() => {
    cleanupSocket();
    if (ws.current) {
      isIntentionalClose.current = true;
      ws.current.close();
    }

    setStatus(reconnectAttempts.current > 0 ? "reconnecting" : "connecting");
    isIntentionalClose.current = false;

    try {
      const socket = new WebSocket(buildSocketUrl());
      ws.current = socket;

      socket.onopen = () => {
        setStatus("connected");
        reconnectAttempts.current = 0;
        setConnectionEpoch((prev) => prev + 1);
        flushSubscriptions();
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WSMessage;
          onMessageRef.current(data);
        } catch (error) {
          console.error("[WebSocket] Failed to parse message:", error);
        }
      };

      socket.onerror = () => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          setStatus("error");
        }
      };

      socket.onclose = (event) => {
        if (isIntentionalClose.current) {
          setStatus("disconnected");
          return;
        }

        if (event.code === 4401) {
          setStatus("error");
          return;
        }

        setStatus("disconnected");

        const baseDelay = Math.min(
          INITIAL_RECONNECT_DELAY * 2 ** reconnectAttempts.current,
          MAX_RECONNECT_DELAY,
        );
        const jitter = Math.floor(Math.random() * Math.min(1000, baseDelay));
        const delay = baseDelay + jitter;

        scheduleReconnect(delay);
      };
    } catch (error) {
      console.error("[WebSocket] Connection creation failed:", error);
      setStatus("error");
    }
  }, [cleanupSocket, flushSubscriptions, scheduleReconnect]);

  useEffect(() => {
    initConnectionRef.current = initConnection;
  }, [initConnection]);

  const connectGlobal = useCallback(() => {
    clearReconnectTimer();
    reconnectAttempts.current = 0;
    if (
      ws.current &&
      (ws.current.readyState === WebSocket.OPEN ||
        ws.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    initConnection();
  }, [clearReconnectTimer, initConnection]);

  const subscribeMatch = useCallback(
    (matchId: string | number) => {
      subscribedMatchIdsRef.current.add(normalizeId(matchId));
      queueOrSend({ type: "subscribe_match", matchId });
    },
    [queueOrSend],
  );

  const unsubscribeMatch = useCallback(
    (matchId: string | number) => {
      subscribedMatchIdsRef.current.delete(normalizeId(matchId));
      queueOrSend({ type: "unsubscribe_match", matchId });
    },
    [queueOrSend],
  );

  const disconnect = useCallback(() => {
    isIntentionalClose.current = true;
    clearReconnectTimer();
    pendingMessagesRef.current = [];
    cleanupSocket();

    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }

    setStatus("disconnected");
  }, [cleanupSocket, clearReconnectTimer]);

  useEffect(() => {
    return () => {
      isIntentionalClose.current = true;
      clearReconnectTimer();
      cleanupSocket();
      if (ws.current) {
        ws.current.close();
      }
    };
  }, [cleanupSocket, clearReconnectTimer]);

  return {
    status,
    connectionEpoch,
    connectGlobal,
    subscribeMatch,
    unsubscribeMatch,
    disconnect,
  };
};
