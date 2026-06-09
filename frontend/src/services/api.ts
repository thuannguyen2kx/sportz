import { API_BASE_URL } from "../constants";
import type { CommentaryResponse, MatchResponse } from "../types";

export const fetchMatches = async (limit = 50): Promise<MatchResponse> => {
  const response = await fetch(`${API_BASE_URL}/matches?limit=${limit}`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data;
};

export const fetchMatchCommentary = async (
  matchId: string | number,
  limit = 100,
): Promise<CommentaryResponse> => {
  const response = await fetch(
    `${API_BASE_URL}/matches/${matchId}/commentary?limit=${limit}`,
    {
      method: "GET",
    },
  );

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data;
};
