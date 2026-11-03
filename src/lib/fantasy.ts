import solver, { type Model, type SolveResult } from "javascript-lp-solver";

export type Position = "G" | "D" | "F";
export type HorizonWeeks = 1 | 2 | 3;

export const POSITION_LABELS: Record<Position, string> = {
  G: "Вратарь",
  D: "Защитник",
  F: "Нападающий",
};

export const POSITION_ORDER: Position[] = ["G", "D", "F"];

/** One scheduled game inside the four-week planning window. */
export interface Fixture {
  /** Moscow calendar date, YYYY-MM-DD. */
  date: string;
  /** Sports.ru fantasy week number. */
  week: number;
  opponent: string;
  home: boolean | null;
  /** Opponent-strength multiplier for this player's position (1 = league average). */
  factor: number;
}

export interface FantasyPlayer {
  id: string;
  name: string;
  club: string;
  position: Position;
  price: number;
  seasonPoints: number;
  gamesPlayed: number;
  fantasyAvg: number | null;
  last5Points: number;
  last5Games: number;
  gamesNextWeek: number;
  gamesWeek2: number;
  gamesWeek3: number;
  gamesWeek4?: number;
  availability: number;
  scheduleFactor: number;
  owned: boolean;
  priceKnown: boolean;
  statsKnown: boolean;
  scheduleKnown: boolean;
  source?: string;
  sportsId?: string;
  locked?: boolean;
  seasonPointsKnown?: boolean;
  sourceUpdatedAt?: string;
  playerSourceUrl?: string;
  statsSeason?: string;
  availabilityEstimated?: boolean;
  earnedWeekPoints?: number;
  weekGamesPlayed?: number;
  weekNumber?: number;
  remainingGamesKnown?: boolean;
  /** Price before the season: Sports.ru price = initial price + season fantasy points. */
  initialPrice?: number;
  /** Fantasy points in PLAYED games, newest first. */
  pointHistory?: number[];
  /** 1 = played, 0 = missed team game, newest first. */
  participation?: number[];
  /** Consecutive most recent team games without ice time. */
  absenceStreak?: number;
  availabilityNote?: string;
  /** Average opponent multiplier for each of the four planning weeks. */
  weekFactors?: number[];
  fixtures?: Fixture[];
  /** Share of Sports.ru managers who picked the player, %. */
  selectedBy?: number;
}

export interface RemainingGame {
  date: string;
  points: number;
}

export interface ProjectedPlayer extends FantasyPlayer {
  seasonRate: number;
  recentRate: number | null;
  /** Expected fantasy points per played game after shrinkage to the price prior. */
  blendedRate: number;
  priorRate: number;
  pointsWeek1: number;
  pointsWeek2: number;
  pointsWeek3: number;
  pointsWeek4: number;
  pointsByWeek: number[];
  availabilityByWeek: number[];
  /** Discounted forecast after the current week: next week ×1, then ×0.5 and ×0.25. */
  futurePoints: number;
  /** Per-game forecast for the rest of the current week when exact dates are known. */
  remainingGames: RemainingGame[] | null;
  horizonPoints: number;
  pointsPer1000: number;
  confidence: "low" | "medium" | "high";
}

export interface OptimizerSettings {
  budget: number;
  transfersAvailable: number;
  clubLimit: number;
  horizonWeeks: HorizonWeeks;
}

export interface TransferSuggestion {
  outgoing: ProjectedPlayer;
  incoming: ProjectedPlayer;
  gain: number;
  priceDifference: number;
  /** Discounted gain over the next weeks (tie-break and preparation moves). */
  futureGain?: number;
  kind?: "now" | "timed" | "prep";
  /** Keep the outgoing player until this game date is over. */
  executeAfter?: string;
  /** Complete the transfer before the incoming player's first counted game. */
  executeBefore?: string;
  step?: number;
  cashAfter?: number;
}

export interface OptimizationResult {
  ready: boolean;
  reason?: string;
  swaps: TransferSuggestion[];
  baselineWeekPoints: number;
  projectedWeekPoints: number;
  baselineHorizonPoints: number;
  projectedHorizonPoints: number;
  gainWeek: number;
  gainHorizon: number;
  currentCost: number;
  finalCost: number;
  remainingBudget: number;
  transfersUsed: number;
  transfersAvailable: number;
  candidatesAvailable: number;
  candidatesConsidered: number;
  candidatePoolTrimmed: boolean;
  warnings: string[];
  horizonWeeks: HorizonWeeks;
  earnedWeekPoints?: number;
  remainingBefore?: number;
  remainingAfter?: number;
  weekNumber?: number;
  exact?: boolean;
  checks?: Array<{ label: string; ok: boolean; detail: string }>;
  /** Optional moves for unused transfers: neutral now, better next week. */
  prepSwaps?: TransferSuggestion[];
  prepGain?: number;
  futureGain?: number;
  executionNote?: string;
}

export interface DatasetReadiness {
  ownedCount: number;
  candidateCount: number;
  readyCandidateCount: number;
  ownedByPosition: Record<Position, number>;
  expectedByPosition: Record<Position, number>;
  incompleteOwned: FantasyPlayer[];
  incompleteCandidates: FantasyPlayer[];
  canOptimize: boolean;
}

export interface ParsedImport {
  players: FantasyPlayer[];
  settings?: Partial<OptimizerSettings>;
}

const EXPECTED_ROSTER: Record<Position, number> = { G: 2, D: 6, F: 9 };
const CLUB_LIMIT = 3;
const MAX_WEEKLY_TRANSFERS = 5;

function normalizeHeader(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/[\s_\-./()%:]+/g, "").trim();
}

function field(
  record: Record<string, unknown>,
  aliases: string[],
): { found: boolean; value: unknown } {
  const normalized = new Map(
    Object.entries(record).map(([key, value]) => [normalizeHeader(key), value]),
  );
  for (const alias of aliases) {
    const key = normalizeHeader(alias);
    if (normalized.has(key)) return { found: true, value: normalized.get(key) };
  }
  return { found: false, value: undefined };
}

function parseNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const cleaned = String(value)
    .replace(/[\u00a0\u202f\s]/g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.+\-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const text = String(value).trim().toLocaleLowerCase("ru-RU");
  if (["1", "true", "yes", "да", "в составе", "мой", "owned", "current"].includes(text)) return true;
  if (["0", "false", "no", "нет", "пул", "кандидат", "candidate"].includes(text)) return false;
  return fallback;
}

export function normalizePosition(value: unknown): Position | null {
  const text = String(value ?? "").trim().toLocaleLowerCase("ru-RU");
  if (["g", "goalie", "goalkeeper", "в", "вр", "вратарь", "голкипер"].includes(text)) return "G";
  if (["d", "def", "defender", "защ", "защитник"].includes(text)) return "D";
  if (
    [
      "f",
      "forward",
      "attacker",
      "нап",
      "нападающий",
      "полузащитник",
      "форвард",
    ].includes(text)
  ) {
    return "F";
  }
  return null;
}

export function playerIdentity(player: Pick<FantasyPlayer, "name" | "club" | "position">): string {
  return `${normalizeHeader(player.name)}|${normalizeHeader(player.club)}|${player.position}`;
}

function finiteArray(value: unknown, maxLength: number, min = -1000, max = 1000): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value
    .slice(0, maxLength)
    .map((item) => (typeof item === "number" ? item : Number(item)))
    .filter((item) => Number.isFinite(item))
    .map((item) => Math.max(min, Math.min(max, item)));
  return numbers.length ? numbers : undefined;
}

function fixturesFrom(value: unknown): Fixture[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fixtures: Fixture[] = [];
  for (const item of value.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const date = typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : null;
    const week = Number(row.week);
    const factor = Number(row.factor);
    if (!date || !Number.isInteger(week)) continue;
    fixtures.push({
      date,
      week,
      opponent: typeof row.opponent === "string" ? row.opponent.slice(0, 60) : "",
      home: typeof row.home === "boolean" ? row.home : null,
      factor: Number.isFinite(factor) ? Math.max(0.7, Math.min(1.3, factor)) : 1,
    });
  }
  return fixtures.length ? fixtures : undefined;
}

export function normalizePlayer(
  source: Record<string, unknown>,
  fallbackOwned = false,
): FantasyPlayer | null {
  const nameField = field(source, ["name", "player", "игрок", "фамилия", "хоккеист"]);
  const clubField = field(source, ["club", "team", "клуб", "команда"]);
  const positionField = field(source, ["position", "pos", "позиция", "амплуа"]);
  const name = String(nameField.value ?? "").trim();
  const club = String(clubField.value ?? "").trim();
  const position = normalizePosition(positionField.value);
  if (!name || !club || !position) return null;

  const priceField = field(source, ["price", "cost", "salary", "цена", "стоимость", "стоимость игрока"]);
  const seasonPointsField = field(source, [
    "seasonPoints",
    "season_points",
    "fantasyPoints",
    "points",
    "очки сезона",
    "очки в сезоне",
    "сезонные очки",
    "очки",
  ]);
  const gamesPlayedField = field(source, ["gamesPlayed", "games_played", "gp", "matches", "матчи сезона", "игры сезона", "матчи", "игры"]);
  const avgField = field(source, ["fantasyAvg", "avgFantasyPoints", "pointsPerGame", "fantasy points per game", "средние очки за матч", "очки за матч"]);
  const recentPointsField = field(source, ["last5Points", "recentPoints", "formPoints", "очки последних 5", "очки за 5 матчей", "форма очки"]);
  const recentGamesField = field(source, ["last5Games", "recentGames", "formGames", "матчи последних 5", "игры за 5 матчей", "форма матчи"]);
  const nextWeekField = field(source, [
    "gamesNextWeek",
    "games_next_week",
    "gamesWeek1",
    "nextWeekGames",
    "игр на неделе",
    "игр на этой неделе",
    "матчей на неделе",
    "матчей на этой неделе",
    "календарь неделя 1",
  ]);
  const week2Field = field(source, ["gamesWeek2", "gamesNextWeek2", "gamesFollowingWeek", "игры неделя 2", "матчи неделя 2"]);
  const week3Field = field(source, ["gamesWeek3", "gamesNextWeek3", "игры неделя 3", "матчи неделя 3"]);
  const week4Field = field(source, ["gamesWeek4", "gamesNextWeek4", "игры неделя 4", "матчи неделя 4"]);
  const availabilityField = field(source, ["availability", "available", "доступность", "вероятность участия", "старт %"]);
  const scheduleFactorField = field(source, ["scheduleFactor", "opponentMultiplier", "calendarFactor", "сила календаря", "множитель календаря"]);
  const ownedField = field(source, ["owned", "current", "inTeam", "в составе", "мой игрок", "моя команда"]);
  const idField = field(source, ["id", "playerId", "player_id"]);
  const priceKnownField = field(source, ["priceKnown"]);
  const statsKnownField = field(source, ["statsKnown"]);
  const scheduleKnownField = field(source, ["scheduleKnown"]);
  const sourceField = field(source, ["source", "источник"]);

  const price = Math.max(0, parseNumber(priceField.value));
  const seasonPoints = parseNumber(seasonPointsField.value);
  const gamesPlayed = Math.max(0, parseNumber(gamesPlayedField.value));
  const avgRate = parseNumber(avgField.value, Number.NaN);
  const availabilityRaw = availabilityField.found ? parseNumber(availabilityField.value, 100) : 100;
  const availability = Math.max(0, Math.min(1, availabilityRaw > 1 ? availabilityRaw / 100 : availabilityRaw));
  const scheduleFactor = Math.max(0.7, Math.min(1.3, parseNumber(scheduleFactorField.value, 1)));
  const id = String(idField.value ?? `${position}:${normalizeHeader(club)}:${normalizeHeader(name)}`);

  const explicitStatsKnown = statsKnownField.found
    ? parseBoolean(statsKnownField.value, false)
    : ((seasonPointsField.found && String(seasonPointsField.value ?? "").trim() !== "" && gamesPlayed > 0) ||
      (avgField.found && Number.isFinite(avgRate)));
  const priceKnown = priceKnownField.found
    ? parseBoolean(priceKnownField.value, price > 0)
    : priceField.found && price > 0;
  const scheduleKnown = scheduleKnownField.found
    ? parseBoolean(scheduleKnownField.value, false)
    : nextWeekField.found && String(nextWeekField.value ?? "").trim() !== "";

  return {
    id,
    name,
    club,
    position,
    price,
    seasonPoints,
    gamesPlayed,
    fantasyAvg: Number.isFinite(avgRate) ? avgRate : null,
    last5Points: parseNumber(recentPointsField.value),
    last5Games: Math.max(0, parseNumber(recentGamesField.value)),
    gamesNextWeek: Math.max(0, parseNumber(nextWeekField.value)),
    gamesWeek2: Math.max(0, parseNumber(week2Field.value)),
    gamesWeek3: Math.max(0, parseNumber(week3Field.value)),
    gamesWeek4: Math.max(0, parseNumber(week4Field.value)),
    availability,
    scheduleFactor,
    owned: parseBoolean(ownedField.value, fallbackOwned),
    priceKnown,
    statsKnown: explicitStatsKnown,
    scheduleKnown,
    source: sourceField.found ? String(sourceField.value ?? "") : undefined,
    sportsId: /^\d+$/.test(String(source.sportsId ?? "")) ? String(source.sportsId) : undefined,
    locked: parseBoolean(source.locked, false),
    seasonPointsKnown: source.seasonPointsKnown === undefined ? explicitStatsKnown : parseBoolean(source.seasonPointsKnown, false),
    sourceUpdatedAt: typeof source.sourceUpdatedAt === "string" ? source.sourceUpdatedAt : undefined,
    playerSourceUrl: typeof source.playerSourceUrl === "string" && source.playerSourceUrl.startsWith("https://www.sports.ru/fantasy/hockey/player/info/107/") ? source.playerSourceUrl : undefined,
    statsSeason: typeof source.statsSeason === "string" ? source.statsSeason : undefined,
    availabilityEstimated: parseBoolean(source.availabilityEstimated, false),
    earnedWeekPoints: parseNumber(source.earnedWeekPoints),
    weekGamesPlayed: parseNumber(source.weekGamesPlayed),
    weekNumber: parseNumber(source.weekNumber),
    remainingGamesKnown: parseBoolean(source.remainingGamesKnown, false),
    initialPrice: parseNumber(source.initialPrice, 0) > 0 ? parseNumber(source.initialPrice) : undefined,
    pointHistory: finiteArray(source.pointHistory, 120, -100, 200),
    participation: finiteArray(source.participation, 20, 0, 1),
    absenceStreak: Number.isFinite(Number(source.absenceStreak)) && source.absenceStreak !== undefined && source.absenceStreak !== null && String(source.absenceStreak).trim() !== ""
      ? Math.max(0, Math.min(99, Math.floor(Number(source.absenceStreak))))
      : undefined,
    availabilityNote: typeof source.availabilityNote === "string" ? source.availabilityNote.slice(0, 160) : undefined,
    weekFactors: finiteArray(source.weekFactors, 4, 0.7, 1.3),
    fixtures: fixturesFrom(source.fixtures),
    selectedBy: Number.isFinite(Number(source.selectedBy)) && source.selectedBy !== undefined && source.selectedBy !== null && String(source.selectedBy).trim() !== ""
      ? Math.max(0, Math.min(100, Number(source.selectedBy)))
      : undefined,
  };
}

/** A successful remote roster is authoritative; manual candidate rows remain local. */
export function mergeSportsPlayers(
  existing: FantasyPlayer[],
  roster: FantasyPlayer[],
  candidates: FantasyPlayer[],
): FantasyPlayer[] {
  const next = new Map<string, FantasyPlayer>();
  const identities = new Set<string>();
  for (const player of [...roster.map((p) => ({ ...p, owned: true })), ...candidates.map((p) => ({ ...p, owned: false }))]) {
    if (next.has(player.id) || identities.has(playerIdentity(player))) continue;
    next.set(player.id, player);
    identities.add(playerIdentity(player));
  }
  for (const player of existing) {
    // Never leave an old, sold player marked as owned, nor retain stale automatic prices.
    if (player.owned || player.sportsId || identities.has(playerIdentity(player)) || next.has(player.id)) continue;
    next.set(player.id, player);
  }
  return [...next.values()];
}

export function playerMissingData(player: FantasyPlayer): string[] {
  const missing: string[] = [];
  if (!player.priceKnown || player.price <= 0) missing.push("цена");
  if (!player.statsKnown || (player.gamesPlayed <= 0 && player.fantasyAvg === null)) missing.push("очки и матчи сезона");
  if (!player.scheduleKnown) missing.push("календарь ближайшего тура");
  return missing;
}

export function isPlayerReady(player: FantasyPlayer): boolean {
  return playerMissingData(player).length === 0;
}

export function getDatasetReadiness(players: FantasyPlayer[]): DatasetReadiness {
  const owned = players.filter((player) => player.owned);
  const candidates = players.filter((player) => !player.owned);
  const ownedByPosition: Record<Position, number> = { G: 0, D: 0, F: 0 };
  for (const player of owned) ownedByPosition[player.position] += 1;
  const incompleteOwned = owned.filter((player) => !isPlayerReady(player));
  const incompleteCandidates = candidates.filter((player) => !isPlayerReady(player));
  const readyCandidateCount = candidates.length - incompleteCandidates.length;
  const correctRoster = POSITION_ORDER.every((position) => ownedByPosition[position] === EXPECTED_ROSTER[position]);
  return {
    ownedCount: owned.length,
    candidateCount: candidates.length,
    readyCandidateCount,
    ownedByPosition,
    expectedByPosition: { ...EXPECTED_ROSTER },
    incompleteOwned,
    incompleteCandidates,
    canOptimize: owned.length === 17 && correctRoster && incompleteOwned.length === 0 && readyCandidateCount > 0,
  };
}

const HALF_LIFE_GAMES = 6;
const GAME_DECAY = Math.pow(0.5, 1 / HALF_LIFE_GAMES);
/** Prior strength in effective games. Backtested on Sports.ru KHL data: strong shrinkage beats raw averages. */
const PRIOR_GAMES = 30;
/** Weights used for post-current-week tie-breaks and preparation moves. */
export const FUTURE_WEEK_WEIGHTS = [0, 1, 0.5, 0.25];
/** Skaters who missed recent games usually return gradually, not instantly. */
const RETURN_RECOVERY = 0.6;

export function effectiveGames(games: number): number {
  if (!(games > 0)) return 0;
  return (1 - Math.pow(GAME_DECAY, games)) / (1 - GAME_DECAY);
}

function weightedRate(values: number[]): { rate: number; weight: number } {
  let total = 0;
  let weight = 0;
  values.forEach((value, index) => {
    const itemWeight = Math.pow(GAME_DECAY, index);
    total += value * itemWeight;
    weight += itemWeight;
  });
  return { rate: weight > 0 ? total / weight : 0, weight };
}

/** Uses per-game history only when it still matches the visible season totals (manual edits win). */
function consistentHistory(player: FantasyPlayer): number[] | null {
  const history = player.pointHistory;
  if (!Array.isArray(history) || history.length === 0 || history.length !== player.gamesPlayed) return null;
  const total = history.reduce((sum, value) => sum + value, 0);
  return Math.abs(total - player.seasonPoints) <= 0.51 ? history : null;
}

function observedRate(player: FantasyPlayer): { rate: number; weight: number } | null {
  if (!player.statsKnown) return null;
  const history = consistentHistory(player);
  if (history) return weightedRate(history);
  if (player.gamesPlayed > 0) return { rate: player.seasonPoints / player.gamesPlayed, weight: effectiveGames(player.gamesPlayed) };
  if (player.fantasyAvg !== null && Number.isFinite(player.fantasyAvg)) return { rate: player.fantasyAvg, weight: effectiveGames(5) };
  return null;
}

interface PositionPrior {
  intercept: number;
  slope: number;
  mean: number;
}

/** Weighted least squares: points per game ~ initial Sports.ru price, per position. */
function fitPriors(players: FantasyPlayer[]): Record<Position, PositionPrior> {
  const priors = {} as Record<Position, PositionPrior>;
  for (const position of POSITION_ORDER) {
    const all: Array<{ x: number | null; y: number; w: number }> = [];
    for (const player of players) {
      if (player.position !== position || !player.statsKnown) continue;
      if (player.gamesPlayed > 0) {
        all.push({ x: player.initialPrice && player.initialPrice > 0 ? player.initialPrice : null, y: player.seasonPoints / player.gamesPlayed, w: player.gamesPlayed });
      } else if (player.fantasyAvg !== null && Number.isFinite(player.fantasyAvg)) {
        all.push({ x: null, y: player.fantasyAvg, w: 3 });
      }
    }
    const totalWeight = all.reduce((sum, item) => sum + item.w, 0);
    const mean = totalWeight > 0 ? all.reduce((sum, item) => sum + item.y * item.w, 0) / totalWeight : 0;
    const fit = all.filter((item): item is { x: number; y: number; w: number } => item.x !== null && item.w >= 3);
    let slope = 0;
    let intercept = mean;
    if (fit.length >= 8) {
      const weight = fit.reduce((sum, item) => sum + item.w, 0);
      const mx = fit.reduce((sum, item) => sum + item.w * item.x, 0) / weight;
      const my = fit.reduce((sum, item) => sum + item.w * item.y, 0) / weight;
      const sxx = fit.reduce((sum, item) => sum + item.w * (item.x - mx) ** 2, 0);
      const sxy = fit.reduce((sum, item) => sum + item.w * (item.x - mx) * (item.y - my), 0);
      if (sxx > 0) {
        slope = Math.max(0, sxy / sxx);
        intercept = my - slope * mx;
      }
    }
    priors[position] = { intercept, slope, mean };
  }
  return priors;
}

function priorFor(player: FantasyPlayer, prior: PositionPrior): number {
  if (prior.slope > 0 && player.initialPrice && player.initialPrice > 0) {
    return Math.max(0, prior.intercept + prior.slope * player.initialPrice);
  }
  return prior.mean;
}

/** Probability of playing in each planning week. Skaters with a recent absence recover gradually. */
export function availabilityByWeek(player: Pick<FantasyPlayer, "availability" | "absenceStreak" | "position">): number[] {
  const base = Math.max(0, Math.min(1, Number.isFinite(player.availability) ? player.availability : 1));
  const recovering = player.position !== "G" && (player.absenceStreak ?? 0) >= 1;
  return Array.from({ length: MONTH_WEEKS }, (_, week) => (recovering ? 1 - (1 - base) * Math.pow(RETURN_RECOVERY, week) : base));
}

function weekFactor(player: FantasyPlayer, week: number): number {
  const value = player.weekFactors?.[week];
  return value !== undefined && Number.isFinite(value) ? Math.max(0.7, Math.min(1.3, value)) : 1;
}

export function projectPlayers(
  players: FantasyPlayer[],
  horizonWeeks: HorizonWeeks = 1,
): ProjectedPlayer[] {
  const priors = fitPriors(players);
  return players.map((player) => {
    const seasonRate = player.statsKnown
      ? (player.gamesPlayed > 0 ? player.seasonPoints / player.gamesPlayed : player.fantasyAvg ?? 0)
      : 0;
    const recentRate = player.last5Games > 0 ? player.last5Points / player.last5Games : null;
    const priorRate = priorFor(player, priors[player.position]);
    const observed = observedRate(player);
    const blendedRate = observed
      ? Math.max(-20, (observed.rate * observed.weight + priorRate * PRIOR_GAMES) / (observed.weight + PRIOR_GAMES))
      : 0;
    const availability = availabilityByWeek(player);
    const games = gamesByWeek(player);
    const scheduleFactor = Number.isFinite(player.scheduleFactor) ? player.scheduleFactor : 1;
    const pointsByWeek = games.map((count, week) => blendedRate * count * availability[week] * weekFactor(player, week) * scheduleFactor);
    let remainingGames: RemainingGame[] | null = games[0] === 0 && player.scheduleKnown ? [] : null;
    if (player.weekNumber && player.fixtures?.length && games[0] > 0) {
      const current = player.fixtures.filter((fixture) => fixture.week === player.weekNumber).sort((a, b) => a.date.localeCompare(b.date));
      if (current.length === games[0]) {
        remainingGames = current.map((fixture) => ({ date: fixture.date, points: blendedRate * availability[0] * fixture.factor * scheduleFactor }));
        pointsByWeek[0] = remainingGames.reduce((sum, game) => sum + game.points, 0);
      }
    }
    const [pointsWeek1, pointsWeek2, pointsWeek3, pointsWeek4] = pointsByWeek;
    const futurePoints = pointsByWeek.reduce((sum, points, week) => sum + points * (FUTURE_WEEK_WEIGHTS[week] ?? 0), 0);
    const horizonPoints = pointsWeek1 +
      (horizonWeeks >= 2 ? pointsWeek2 * 0.65 : 0) +
      (horizonWeeks >= 3 ? pointsWeek3 * 0.4 : 0);
    const confidence: ProjectedPlayer["confidence"] = !player.statsKnown || player.gamesPlayed < 8
      ? "low"
      : player.gamesPlayed < 22
        ? "medium"
        : "high";
    return {
      ...player,
      seasonRate,
      recentRate,
      blendedRate,
      priorRate,
      pointsWeek1,
      pointsWeek2,
      pointsWeek3,
      pointsWeek4,
      pointsByWeek,
      availabilityByWeek: availability,
      futurePoints,
      remainingGames,
      horizonPoints,
      pointsPer1000: player.price > 0 ? (horizonPoints / player.price) * 1000 : 0,
      confidence,
    };
  });
}

export function clubKey(club: string): string {
  return normalizeHeader(club.replace(/ё/g, "е").replace(/Ё/g, "Е"));
}

export const MONTH_WEEKS = 4;

export interface MonthlySwap {
  outgoing: ProjectedPlayer;
  incoming: ProjectedPlayer;
  weekGain: number;
  remainingGain: number;
  futureGames: number;
  priceDifference: number;
  leavesInWeek: number | null;
}

export interface MonthlyWeekPlan {
  offset: number;
  weekNumber: number | null;
  label: string;
  swaps: MonthlySwap[];
  baselinePoints: number;
  projectedPoints: number;
  gain: number;
  transfersUsed: number;
  transfersAvailable: number;
  rosterCost: number;
  remainingBudget: number;
  keptFromEarlier: string[];
}

export interface MonthlyPlan {
  ready: boolean;
  reason?: string;
  weeks: MonthlyWeekPlan[];
  baselineMonthPoints: number;
  projectedMonthPoints: number;
  gainMonth: number;
  transfersUsed: number;
  warnings: string[];
  exact?: boolean;
}

export function gamesByWeek(player: Pick<FantasyPlayer, "gamesNextWeek" | "gamesWeek2" | "gamesWeek3" | "gamesWeek4">): number[] {
  return [player.gamesNextWeek, player.gamesWeek2, player.gamesWeek3, player.gamesWeek4 ?? 0];
}

export function weeklyPoints(player: Pick<ProjectedPlayer, "pointsByWeek">, weekIndex: number): number {
  return player.pointsByWeek[weekIndex] ?? 0;
}

function remainingPoints(player: ProjectedPlayer, fromWeek: number): number {
  let total = 0;
  for (let week = fromWeek; week < MONTH_WEEKS; week += 1) total += weeklyPoints(player, week);
  return total;
}

function futureGameCount(player: FantasyPlayer, fromWeek: number): number {
  return gamesByWeek(player).slice(fromWeek + 1).reduce((sum, games) => sum + games, 0);
}

function emptyMonth(reason: string): MonthlyPlan {
  return {
    ready: false,
    reason,
    weeks: [],
    baselineMonthPoints: 0,
    projectedMonthPoints: 0,
    gainMonth: 0,
    transfersUsed: 0,
    warnings: [],
  };
}

function monthSettings(settings: OptimizerSettings) {
  return {
    budget: Math.max(0, Number(settings.budget) || 0),
    transfersAvailable: Math.max(0, Math.min(MAX_WEEKLY_TRANSFERS, Math.floor(settings.transfersAvailable))),
    clubLimit: Math.max(1, Math.min(3, Math.floor(settings.clubLimit || CLUB_LIMIT))),
  };
}

/** Weight of the following weeks when a transfer is chosen: a player who keeps scoring saves later transfers. */
export const MONTH_LOOKAHEAD = [1, 0.5, 0.25, 0.125];
/** A transfer has to be worth at least this much, so equal options do not cause churn. */
const MONTH_TRANSFER_COST = 0.05;

function lookaheadValue(player: ProjectedPlayer, week: number): number {
  let total = 0;
  for (let offset = 0; week + offset < MONTH_WEEKS; offset += 1) total += MONTH_LOOKAHEAD[offset] * weeklyPoints(player, week + offset);
  return total;
}

/** Strongest candidates for one week of the month: by look-ahead value, by this week and by value for money. */
function monthWeekPool(pool: ProjectedPlayer[], week: number): ProjectedPlayer[] {
  const picked = new Map<string, ProjectedPlayer>();
  // Later weeks are a rougher scenario, so a smaller pool keeps the exact choice fast.
  const limits: Record<Position, [number, number, number]> = week < 2
    ? { G: [6, 3, 2], D: [12, 5, 4], F: [18, 8, 6] }
    : { G: [4, 2, 1], D: [8, 3, 3], F: [12, 5, 4] };
  for (const position of POSITION_ORDER) {
    const list = pool.filter((player) => player.position === position && lookaheadValue(player, week) > 0);
    const [byValue, byWeek, byPrice] = limits[position];
    const add = (player: ProjectedPlayer) => picked.set(player.id, player);
    [...list].sort((a, b) => lookaheadValue(b, week) - lookaheadValue(a, week) || a.price - b.price).slice(0, byValue).forEach(add);
    [...list].sort((a, b) => weeklyPoints(b, week) - weeklyPoints(a, week) || a.price - b.price).slice(0, byWeek).forEach(add);
    [...list].sort((a, b) => lookaheadValue(b, week) / Math.max(1, b.price) - lookaheadValue(a, week) / Math.max(1, a.price)).slice(0, byPrice).forEach(add);
  }
  return [...picked.values()];
}

interface MonthWeekProblem {
  roster: ProjectedPlayer[];
  pool: ProjectedPlayer[];
  week: number;
  price: (player: ProjectedPlayer) => number;
  balance: number;
  transfers: number;
  clubLimit: number;
  blocked: Set<string>;
}

/**
 * One week of the month: exact binary choice of up to N same-position swaps that maximises
 * look-ahead points under the cash balance and the club limit (positions hold by construction).
 */
function bestMonthWeekSwaps(problem: MonthWeekProblem): Array<{ outgoing: ProjectedPlayer; incoming: ProjectedPlayer }> | null {
  const { roster, week, price, balance, transfers, clubLimit, blocked } = problem;
  if (transfers <= 0) return [];
  const rosterIds = new Set(roster.map((player) => player.id));
  const candidates = monthWeekPool(problem.pool.filter((player) => !rosterIds.has(player.id) && !blocked.has(player.id)), week);
  if (!candidates.length) return [];
  const clubOwned = new Map<string, number>();
  roster.forEach((player) => clubOwned.set(clubKey(player.club), (clubOwned.get(clubKey(player.club)) ?? 0) + 1));
  const clubCandidates = new Map<string, number>();
  candidates.forEach((player) => clubCandidates.set(clubKey(player.club), (clubCandidates.get(clubKey(player.club)) ?? 0) + 1));
  const binding = [...new Set([...clubOwned.keys(), ...clubCandidates.keys()])]
    .filter((club) => (clubOwned.get(club) ?? 0) + Math.min(transfers, clubCandidates.get(club) ?? 0) > clubLimit);
  const constraints: Model["constraints"] = { transfers: { max: transfers }, cash: { max: Math.max(0, balance) } };
  binding.forEach((club, index) => { constraints[`club_${index}`] = { max: clubLimit - (clubOwned.get(club) ?? 0) }; });
  const variables: Model["variables"] = {};
  const binaries: Record<string, 1> = {};
  const swaps = new Map<string, { outgoing: ProjectedPlayer; incoming: ProjectedPlayer }>();
  roster.forEach((current, slot) => {
    if (blocked.has(current.id)) return;
    constraints[`slot_${slot}`] = { max: 1 };
    const currentValue = lookaheadValue(current, week);
    candidates.forEach((candidate, index) => {
      if (candidate.position !== current.position) return;
      const gain = lookaheadValue(candidate, week) - currentValue - MONTH_TRANSFER_COST;
      const cashDelta = price(candidate) - price(current);
      // A losing swap is only useful when it frees cash for another one.
      if (gain <= 0 && cashDelta >= 0) return;
      const name = `x_${slot}_${index}`;
      const coefficients: Record<string, number> = { value: gain, [`slot_${slot}`]: 1, [`cand_${index}`]: 1, transfers: 1, cash: cashDelta };
      const inClub = binding.indexOf(clubKey(candidate.club));
      const outClub = binding.indexOf(clubKey(current.club));
      if (inClub !== outClub) {
        if (inClub >= 0) coefficients[`club_${inClub}`] = 1;
        if (outClub >= 0) coefficients[`club_${outClub}`] = -1;
      }
      variables[name] = coefficients;
      binaries[name] = 1;
      swaps.set(name, { outgoing: current, incoming: candidate });
    });
  });
  if (!swaps.size) return [];
  candidates.forEach((_candidate, index) => { constraints[`cand_${index}`] = { max: 1 }; });
  let result: SolveResult;
  try {
    result = solver.Solve({ optimize: "value", opType: "max", constraints, variables, binaries, options: { timeout: 700, tolerance: 0.01 } }) as SolveResult;
  } catch {
    return null;
  }
  if (!result.feasible || result.isIntegral === false) return null;
  const chosen = [...swaps.entries()].filter(([name]) => Number(result[name] ?? 0) > 0.5).map(([, swap]) => swap);
  const slots = new Set(chosen.map((swap) => swap.outgoing.id));
  const incoming = new Set(chosen.map((swap) => swap.incoming.id));
  if (slots.size !== chosen.length || incoming.size !== chosen.length || chosen.length > transfers) return null;
  return chosen;
}

function monthPrecheck(sourcePlayers: FantasyPlayer[], budget: number): MonthlyPlan | null {
  const ownedRaw = sourcePlayers.filter((player) => player.owned);
  const counts: Record<Position, number> = { G: 0, D: 0, F: 0 };
  ownedRaw.forEach((player) => { counts[player.position] += 1; });
  if (ownedRaw.length !== 17 || POSITION_ORDER.some((position) => counts[position] !== EXPECTED_ROSTER[position])) {
    return emptyMonth("Для плана на месяц нужен полный состав: 2 вратаря, 6 защитников и 9 нападающих.");
  }
  if (ownedRaw.some((player) => !isPlayerReady(player))) {
    return emptyMonth("Месячный план ждёт цену, очки и календарь по каждому игроку состава.");
  }
  const rosterCost = ownedRaw.reduce((sum, player) => sum + player.price, 0);
  if (rosterCost > budget + 0.001) return emptyMonth("Стоимость состава выше доступного бюджета.");
  return null;
}

/**
 * Four-week transfer plan. Week by week it picks the exact best set of up to five swaps for the
 * points of that week plus a decaying share of the following weeks, then carries the roster on.
 * Cash follows the Sports.ru rule that a price grows by the points the player scores, so the
 * team value grows with the points of the players who are held.
 */
export function planMonth(sourcePlayers: FantasyPlayer[], inputSettings: OptimizerSettings, startWeek?: number): MonthlyPlan {
  const limits = monthSettings(inputSettings);
  const invalid = monthPrecheck(sourcePlayers, limits.budget);
  if (invalid) return invalid;
  const projected = projectPlayers(sourcePlayers, 1);
  const original = projected.filter((player) => player.owned);
  const originalIds = new Set(original.map((player) => player.id));
  const everyone = projected.filter((player) => originalIds.has(player.id) || isPlayerReady(player));
  const earnedBefore = (player: ProjectedPlayer, week: number) => {
    let total = 0;
    for (let past = 0; past < week; past += 1) total += weeklyPoints(player, past);
    return total;
  };
  const originalWeekly = Array.from({ length: MONTH_WEEKS }, (_, week) => original.reduce((sum, player) => sum + weeklyPoints(player, week), 0));
  let roster = original;
  let wealth = limits.budget;
  const acquired = new Set<string>();
  const weeks: MonthlyWeekPlan[] = [];
  for (let week = 0; week < MONTH_WEEKS; week += 1) {
    const price = (player: ProjectedPlayer) => player.price + earnedBefore(player, week);
    const rosterIds = new Set(roster.map((player) => player.id));
    const transfersAvailable = week === 0 ? limits.transfersAvailable : MAX_WEEKLY_TRANSFERS;
    const cost = roster.reduce((sum, player) => sum + price(player), 0);
    const blocked = new Set(week === 0 ? everyone.filter((player) => player.locked).map((player) => player.id) : []);
    const chosen = bestMonthWeekSwaps({
      roster,
      pool: everyone.filter((player) => !rosterIds.has(player.id)),
      week,
      price,
      balance: wealth - cost,
      transfers: transfersAvailable,
      clubLimit: limits.clubLimit,
      blocked,
    });
    if (!chosen) return emptyMonth(`Не удалось подтвердить план на ${week + 1}-ю неделю месяца. Попробуйте пересчитать позже.`);
    const swaps: MonthlySwap[] = chosen.map(({ outgoing, incoming }) => ({
      outgoing,
      incoming,
      weekGain: weeklyPoints(incoming, week) - weeklyPoints(outgoing, week),
      remainingGain: remainingPoints(incoming, week) - remainingPoints(outgoing, week),
      futureGames: futureGameCount(incoming, week),
      priceDifference: price(incoming) - price(outgoing),
      leavesInWeek: null,
    })).sort((a, b) => POSITION_ORDER.indexOf(a.incoming.position) - POSITION_ORDER.indexOf(b.incoming.position) || b.remainingGain - a.remainingGain);
    const soldIds = new Set(swaps.map((swap) => swap.outgoing.id));
    const keptFromEarlier = roster.filter((player) => acquired.has(player.id) && !soldIds.has(player.id)).map((player) => player.name);
    roster = [...roster.filter((player) => !soldIds.has(player.id)), ...swaps.map((swap) => swap.incoming)];
    swaps.forEach((swap) => acquired.add(swap.incoming.id));
    const rosterCost = roster.reduce((sum, player) => sum + price(player), 0);
    const projectedPoints = roster.reduce((sum, player) => sum + weeklyPoints(player, week), 0);
    const weekNumber = Number.isInteger(startWeek) ? (startWeek as number) + week : null;
    weeks.push({
      offset: week,
      weekNumber,
      label: weekNumber ? `Неделя ${weekNumber}` : `Неделя ${week + 1} месяца`,
      swaps,
      baselinePoints: originalWeekly[week],
      projectedPoints,
      gain: projectedPoints - originalWeekly[week],
      transfersUsed: swaps.length,
      transfersAvailable,
      rosterCost,
      remainingBudget: wealth - rosterCost,
      keptFromEarlier,
    });
    wealth += projectedPoints;
  }
  for (const week of weeks) {
    for (const swap of week.swaps) {
      const later = weeks.find((item) => item.offset > week.offset && item.swaps.some((other) => other.outgoing.id === swap.incoming.id));
      swap.leavesInWeek = later ? later.offset : null;
    }
  }
  const projectedMonthPoints = weeks.reduce((sum, week) => sum + week.projectedPoints, 0);
  const baselineMonthPoints = originalWeekly.reduce((sum, value) => sum + value, 0);
  const warnings = [
    "Каждую неделю выбирается лучший набор до 5 замен по очкам этой недели и, с меньшим весом, следующих; цены растут на прогнозные очки игроков.",
    "План на будущие недели — сценарий: календарь известен, а травмы, ротация вратарей и блокировки — нет. Каждую неделю пересчитывайте заново.",
  ];
  if (weeks.every((week) => week.swaps.length === 0)) warnings.push("Состав уже лучший в этом пуле на четыре недели вперёд.");
  if (everyone.filter((player) => gamesByWeek(player).slice(1).every((games) => games === 0)).length > everyone.length / 2) {
    warnings.push("У большей части игроков нет матчей после ближайшей недели. Проверьте, что календарь обновился, иначе план месяца совпадёт с планом одного тура.");
  }
  return {
    ready: true,
    weeks,
    baselineMonthPoints,
    projectedMonthPoints,
    gainMonth: projectedMonthPoints - baselineMonthPoints,
    transfersUsed: weeks.reduce((sum, week) => sum + week.transfersUsed, 0),
    warnings,
    exact: false,
  };
}

function splitDelimitedRow(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let insideQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (insideQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (character === delimiter && !insideQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  values.push(current.trim());
  return values;
}

function toSettings(value: unknown): Partial<OptimizerSettings> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const settings = value as Record<string, unknown>;
  const budgetField = field(settings, ["budget", "budgetLimit", "лимит бюджета", "бюджет"]);
  const transfersField = field(settings, ["transfersAvailable", "maxTransfers", "доступно трансферов"]);
  const horizonField = field(settings, ["horizonWeeks", "horizon", "период прогноза"]);
  const result: Partial<OptimizerSettings> = {};
  if (budgetField.found) result.budget = parseNumber(budgetField.value);
  if (transfersField.found) result.transfersAvailable = parseNumber(transfersField.value);
  if (horizonField.found) {
    const weeks = Math.max(1, Math.min(3, Math.floor(parseNumber(horizonField.value, 1))));
    result.horizonWeeks = weeks as HorizonWeeks;
  }
  return Object.keys(result).length ? result : undefined;
}

export function parseDataInput(text: string, defaultOwned = false): ParsedImport {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Добавьте CSV/JSON-текст или выберите файл.");

  let rawPlayers: unknown[];
  let settings: Partial<OptimizerSettings> | undefined;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Не удалось прочитать JSON. Проверьте запятые, кавычки и скобки.");
    }
    if (Array.isArray(parsed)) {
      rawPlayers = parsed;
    } else if (parsed && typeof parsed === "object") {
      const object = parsed as Record<string, unknown>;
      settings = toSettings(object.settings ?? object);
      if (Array.isArray(object.players)) {
        rawPlayers = object.players;
      } else {
        const roster = Array.isArray(object.roster) ? object.roster : [];
        const candidates = Array.isArray(object.candidates) ? object.candidates : [];
        rawPlayers = [
          ...roster.map((player) => ({ ...(player as Record<string, unknown>), owned: true })),
          ...candidates.map((player) => ({ ...(player as Record<string, unknown>), owned: false })),
        ];
      }
    } else {
      throw new Error("JSON должен содержать массив игроков или объект с массивом players.");
    }
  } else {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error("В CSV нужны заголовки и хотя бы одна строка игрока.");
    const header = lines[0];
    const delimiter = [";", "\t", ","].sort((a, b) => header.split(b).length - header.split(a).length)[0];
    const columns = splitDelimitedRow(header, delimiter);
    rawPlayers = lines.slice(1).map((line) => {
      const values = splitDelimitedRow(line, delimiter);
      return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
    });
  }

  const players = rawPlayers
    .filter((player): player is Record<string, unknown> => Boolean(player) && typeof player === "object" && !Array.isArray(player))
    .map((player) => normalizePlayer(player, defaultOwned))
    .filter((player): player is FantasyPlayer => Boolean(player));
  if (players.length === 0) {
    throw new Error("Не найдено строк с именем, клубом и позицией. Проверьте заголовки или формат JSON.");
  }
  const seen = new Set<string>();
  for (const player of players) {
    if (seen.has(player.id)) player.id = `${player.id}:${seen.size}`;
    seen.add(player.id);
  }
  return { players, settings };
}

export function csvTemplate(): string {
  return [
    "name;club;position;price;seasonPoints;gamesPlayed;last5Points;last5Games;gamesNextWeek;gamesWeek2;gamesWeek3;availability;scheduleFactor;owned",
  ].join("\n");
}
