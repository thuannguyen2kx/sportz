export interface Match {
  id: string | number;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  status: string;
  startTime: string;
  endTime?: string;
  homeScore: number;
  awayScore: number;
  createdAt?: string;
}

export interface MatchResponse {
  data: Match[];
}

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface Commentary {
  id: string | number;
  matchId: string | number;
  minute?: number;
  sequence?: number;
  period?: string;
  eventType?: string;
  actor?: string;
  team?: string;
  message: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  createdAt?: string;
  eventId?: string;
}

export interface CommentaryResponse {
  data: Commentary[];
}

interface WSEventBase {
  eventId: string;
  occurredAt: string;
}

export interface WSMessageMatchCreated extends WSEventBase {
  type: "match_created";
  data: Match;
}

export interface WSMessageCommentaryCreated extends WSEventBase {
  type: "commentary_created";
  matchId: string | number;
  data: Commentary;
}

export interface WSMessageScore extends WSEventBase {
  type: "score_update";
  matchId: string | number;
  data: {
    homeScore: number;
    awayScore: number;
    status?: string;
  };
}

export interface WSMessageWelcome {
  type: "welcome";
  occurredAt: string;
  userId: string;
  heartbeatIntervalMs: number;
  maxSubscriptions: number;
}

export interface WSMessagePong {
  type: "pong";
  occurredAt: string;
}

export interface WSMessageError {
  type: "error";
  code: string;
  message: string;
}

export interface WSMessageSubscribed {
  type: "subscribed";
  matchId: string | number;
}

export interface WSMessageUnsubscribed {
  type: "unsubscribed";
  matchId: string | number;
}

export interface WSMessageSubscriptions {
  type: "subscriptions";
  matchIds: Array<string | number>;
}

export type WSMessage =
  | WSMessageMatchCreated
  | WSMessageCommentaryCreated
  | WSMessageScore
  | WSMessageWelcome
  | WSMessagePong
  | WSMessageError
  | WSMessageSubscribed
  | WSMessageUnsubscribed
  | WSMessageSubscriptions;

export type WSClientMessage =
  | { type: "subscribe_match"; matchId: string | number }
  | { type: "unsubscribe_match"; matchId: string | number }
  | { type: "set_subscriptions"; matchIds: Array<string | number> }
  | { type: "ping" };
