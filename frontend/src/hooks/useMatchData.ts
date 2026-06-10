import { useCallback, useEffect, useRef, useState } from "react";
import { MATCHES_RECOVERY_POLL_INTERVAL } from "../constants";
import { fetchMatchCommentary, fetchMatches } from "../services/api";
import type { Commentary, Match, WSMessage } from "../types";
import { useWebSocket } from "./useWebSocket";

interface UseMatchData {
  matches: Match[];
  isLoading: boolean;
  error: string | null;
  commentary: Commentary[];
  isCommentaryLoading: boolean;
  wsError: string | null;
  status: ReturnType<typeof useWebSocket>["status"];
  activeMatchId: string | number | null;
  newMatchesCount: number;
  dismissNewMatches: () => void;
  watchMatch: (id: string | number) => void;
  unwatchMatch: (id: string | number) => void;
  reloadMatches: () => void;
}

export const useMatchData = (): UseMatchData => {
  const [matches, setMatches] = useState<Match[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commentary, setCommentary] = useState<Commentary[]>([]);
  const [isCommentaryLoading, setIsCommentaryLoading] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);
  const [activeMatchId, setActiveMatchId] = useState<string | number | null>(
    null,
  );
  const [newMatchesCount, setNewMatchesCount] = useState(0);
  const latestMatchIdRef = useRef<string | number | null>(null);
  const subscribedMatchIdsRef = useRef(new Set<string>());
  const hasLoadedRef = useRef(false);
  const knownMatchIdsRef = useRef(new Set<string>());
  const processedEventIdsRef = useRef(new Set<string>());
  const newMatchesTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const rememberEvent = useCallback((eventId?: string) => {
    if (!eventId) return true;
    if (processedEventIdsRef.current.has(eventId)) return false;

    processedEventIdsRef.current.add(eventId);
    if (processedEventIdsRef.current.size > 500) {
      const oldestEventId = processedEventIdsRef.current.values().next().value;
      if (oldestEventId) {
        processedEventIdsRef.current.delete(oldestEventId);
      }
    }
    return true;
  }, []);

  const handleWSMessage = useCallback((msg: WSMessage) => {
    switch (msg.type) {
      case "match_created": {
        if (!rememberEvent(msg.eventId)) return;
        const nextMatchId = String(msg.data.id);
        const wasKnown = knownMatchIdsRef.current.has(nextMatchId);
        knownMatchIdsRef.current.add(nextMatchId);
        setMatches((prevMatches) => {
          if (prevMatches.some((match) => String(match.id) === nextMatchId)) {
            return prevMatches;
          }
          return [msg.data, ...prevMatches];
        });
        if (!wasKnown) {
          setNewMatchesCount((prev) => prev + 1);
          if (newMatchesTimeoutRef.current) {
            clearTimeout(newMatchesTimeoutRef.current);
          }
          newMatchesTimeoutRef.current = setTimeout(() => {
            setNewMatchesCount(0);
            newMatchesTimeoutRef.current = null;
          }, 5000);
        }
        break;
      }
      case "score_update":
        if (!rememberEvent(msg.eventId)) return;
        if (!subscribedMatchIdsRef.current.has(String(msg.matchId))) {
          return;
        }
        setMatches((prevMatches) =>
          prevMatches.map((m) => {
            // Loose equality check for ID (string vs number)

            if (m.id == msg.matchId) {
              return {
                ...m,
                homeScore: msg.data.homeScore,
                awayScore: msg.data.awayScore,
                status: msg.data.status ?? m.status,
              };
            }
            return m;
          }),
        );
        break;
      case "commentary_created": {
        if (!rememberEvent(msg.eventId)) return;
        if (
          latestMatchIdRef.current == null ||
          msg.matchId != latestMatchIdRef.current ||
          msg.data.matchId != latestMatchIdRef.current
        ) {
          return;
        }
        const normalized = {
          ...msg.data,
          eventId: msg.eventId,
          createdAt: msg.data.createdAt ?? new Date().toISOString(),
        };
        setCommentary((prev) => {
          if (
            prev.some(
              (item) =>
                String(item.id) === String(normalized.id) ||
                (item.eventId && item.eventId === normalized.eventId),
            )
          ) {
            return prev;
          }
          return [normalized, ...prev];
        });
        break;
      }
      case "error":
        setWsError(`${msg.code}: ${msg.message}`);
        break;
      case "subscribed":
      case "unsubscribed":
      case "subscriptions":
      case "welcome":
      case "pong":
        break;
      default:
        break;
    }
  }, [rememberEvent]);

  const {
    status,
    connectionEpoch,
    connectGlobal,
    subscribeMatch,
    unsubscribeMatch,
  } = useWebSocket(handleWSMessage);

  const loadCommentary = useCallback(async (id: string | number) => {
    setIsCommentaryLoading(true);
    try {
      const data = await fetchMatchCommentary(id);
      if (latestMatchIdRef.current == id) {
        setCommentary(data.data || []);
      }
    } catch {
      if (latestMatchIdRef.current == id) {
        setCommentary([]);
      }
    } finally {
      if (latestMatchIdRef.current == id) {
        setIsCommentaryLoading(false);
      }
    }
  }, []);

  const loadMatches = useCallback(async () => {
    if (!hasLoadedRef.current) {
      setIsLoading(true);
    }
    setError(null);
    try {
      const data = await fetchMatches(100);
      const nextMatches = data.data || [];
      const nextMatchIds = new Set(
        nextMatches.map((match) => String(match.id)),
      );
      setMatches((prevMatches) => {
        const prevById = new Map(
          prevMatches.map((match) => [String(match.id), match]),
        );
        return nextMatches.map((match) => {
          const matchId = String(match.id);
          const prev = prevById.get(matchId);
          if (prev && !subscribedMatchIdsRef.current.has(matchId)) {
            return {
              ...match,
              homeScore: prev.homeScore,
              awayScore: prev.awayScore,
            };
          }
          return match;
        });
      });
      if (knownMatchIdsRef.current.size > 0) {
        let newCount = 0;
        nextMatchIds.forEach((matchId) => {
          if (!knownMatchIdsRef.current.has(matchId)) {
            newCount += 1;
          }
        });
        if (newCount > 0) {
          setNewMatchesCount((prev) => prev + newCount);
          if (newMatchesTimeoutRef.current) {
            clearTimeout(newMatchesTimeoutRef.current);
          }
          newMatchesTimeoutRef.current = setTimeout(() => {
            setNewMatchesCount(0);
            newMatchesTimeoutRef.current = null;
          }, 5000);
        }
      }
      knownMatchIdsRef.current = nextMatchIds;

      nextMatches.forEach((match) => {
        const matchId = String(match.id);
        if (
          subscribedMatchIdsRef.current.has(matchId) &&
          match.status.toLowerCase() === "finished"
        ) {
          subscribedMatchIdsRef.current.delete(matchId);
          unsubscribeMatch(match.id);
          if (latestMatchIdRef.current == match.id) {
            setActiveMatchId(null);
            latestMatchIdRef.current = null;
            setCommentary([]);
            setIsCommentaryLoading(false);
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load matches";
      setError(msg);
    } finally {
      if (!hasLoadedRef.current) {
        setIsLoading(false);
        hasLoadedRef.current = true;
      }
    }
  }, [unsubscribeMatch]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      loadMatches();
    }, 0);
    return () => clearTimeout(timeout);
  }, [loadMatches]);

  useEffect(() => {
    const interval = setInterval(() => {
      loadMatches();
    }, MATCHES_RECOVERY_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [loadMatches]);

  useEffect(() => {
    connectGlobal();
  }, [connectGlobal]);

  useEffect(() => {
    latestMatchIdRef.current = activeMatchId;
  }, [activeMatchId]);

  useEffect(() => {
    if (connectionEpoch === 0 || !hasLoadedRef.current) return;

    const timeout = setTimeout(() => {
      loadMatches();
      if (latestMatchIdRef.current != null) {
        loadCommentary(latestMatchIdRef.current);
      }
    }, 0);
    return () => clearTimeout(timeout);
  }, [connectionEpoch, loadCommentary, loadMatches]);

  useEffect(() => {
    return () => {
      if (newMatchesTimeoutRef.current) {
        clearTimeout(newMatchesTimeoutRef.current);
      }
    };
  }, []);

  const dismissNewMatches = useCallback(() => {
    if (newMatchesTimeoutRef.current) {
      clearTimeout(newMatchesTimeoutRef.current);
      newMatchesTimeoutRef.current = null;
    }
    setNewMatchesCount(0);
  }, []);

  const watchMatch = useCallback(
    (id: string | number) => {
      setCommentary([]);
      setIsCommentaryLoading(true);
      setWsError(null);
      latestMatchIdRef.current = id;
      if (activeMatchId != null && activeMatchId != id) {
        const previousId = String(activeMatchId);
        subscribedMatchIdsRef.current.delete(previousId);
        unsubscribeMatch(activeMatchId);
      }
      setActiveMatchId(id);
      const matchId = String(id);
      subscribedMatchIdsRef.current.add(matchId);
      subscribeMatch(id);
      loadCommentary(id);
    },
    [activeMatchId, loadCommentary, subscribeMatch, unsubscribeMatch],
  );

  const unwatchMatch = useCallback(
    (id: string | number) => {
      unsubscribeMatch(id);
      const matchId = String(id);
      subscribedMatchIdsRef.current.delete(matchId);
      if (activeMatchId == id) {
        setActiveMatchId(null);
        latestMatchIdRef.current = null;
        setCommentary([]);
        setIsCommentaryLoading(false);
      }
    },
    [activeMatchId, unsubscribeMatch],
  );

  return {
    matches,
    isLoading,
    error,
    commentary,
    isCommentaryLoading,
    wsError,
    status,
    activeMatchId,
    newMatchesCount,
    dismissNewMatches,
    watchMatch,
    unwatchMatch,
    reloadMatches: loadMatches,
  };
};
