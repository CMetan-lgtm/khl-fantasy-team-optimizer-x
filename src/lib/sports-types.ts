import type { FantasyPlayer, Position } from "./fantasy";

export const CONNECTED_TEAM_ID = "587717";
export const SPORTS_SYNC_INTERVAL = 5 * 60 * 1000;
export const SPORTS_DATA_VERSION = 7;

export interface LeagueStanding {
  rank: number;
  teamId: string;
  teamName: string;
  manager: string;
  seasonPoints: number;
  tourPoints: number;
  isCurrent: boolean;
}

export interface SportsProfile {
  teamId: string;
  teamName: string;
  week?: string;
  deadline?: string;
  rank?: number;
  totalTeams?: number;
  teamValue?: number;
  balance?: number;
  budgetLimit?: number;
  /** Transfers still available this week (Sports.ru «Трансферы» = remaining). */
  transfersLeft?: number;
  transfersUsed?: number;
  weeklyTransfersLimit?: number;
  supporterLeague?: string;
  supporterLeagueRank?: number;
  league?: string;
  leagueId?: string;
  leagueUrl?: string;
  leagueRank?: number;
  leagueTotal?: number;
  leagueSeasonPoints?: number;
  leagueTourPoints?: number;
  leaderName?: string;
  leaderManager?: string;
  leaderPoints?: number;
  gapToFirst?: number;
  leagueStandings?: LeagueStanding[];
  profileUrl: string;
  rosterUrl: string;
  fetchedAt?: string;
}

export interface RatedPlayer {
  rank: number;
  name: string;
  club: string;
  position: Position;
  seasonPoints: number;
  profileUrl?: string;
}

export interface SportsSyncData {
  version: number;
  profile: SportsProfile;
  roster: FantasyPlayer[];
  candidates: FantasyPlayer[];
  ratedPlayers: RatedPlayer[];
  fetchedAt: string;
  rosterFetchedAt: string;
  rosterStatus: "synced";
  sourceUrl: string;
  candidateSource: string;
  candidateTeamIds: string[];
  poolStats?: { leagueTeams: number; leaguePlayers: number; detailed: number; games: number };
  warnings: string[];
  cached: boolean;
  stale: boolean;
  nextRefreshSeconds: number;
}

export interface SportsSyncFailure {
  error: string;
  code: "SOURCE_UNAVAILABLE" | "INVALID_TEAM_ID";
}
