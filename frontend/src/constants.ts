const DEFAULT_API_BASE_URL = "http://localhost:8000";
const DEFAULT_WS_BASE_URL = "ws://localhost:8000/ws";
const DEFAULT_WS_AUTH_TOKEN = "dev-token";

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL;
export const WS_BASE_URL =
  import.meta.env.VITE_WS_BASE_URL || DEFAULT_WS_BASE_URL;
export const WS_AUTH_TOKEN =
  import.meta.env.VITE_WS_AUTH_TOKEN || DEFAULT_WS_AUTH_TOKEN;

// Exponential backoff configuration
export const MAX_RECONNECT_DELAY = 30000; // 30 seconds
export const INITIAL_RECONNECT_DELAY = 1000; // 1 second
export const MATCHES_RECOVERY_POLL_INTERVAL = 30000; // 30 seconds
