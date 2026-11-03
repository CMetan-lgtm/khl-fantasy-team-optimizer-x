import { load } from "cheerio";
import { effectiveGames, normalizePosition, type FantasyPlayer, type Fixture, type Position } from "./fantasy";
import {
  SPORTS_DATA_VERSION,
  SPORTS_SYNC_INTERVAL,
  type LeagueStanding,
  type RatedPlayer,
  type SportsProfile,
  type SportsSyncData,
} from "./sports-types";

const ROOT = "https://www.sports.ru/fantasy/hockey";
const REQUEST_TIMEOUT = 10_000;
const text = (value: string) => value.replace(/\s+/g, " ").trim();
const nameKey = (value: string) => text(value).toLocaleLowerCase("ru-RU").replace(/ё/g, "е");

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const cleaned = value.replace(/[\s\u00a0\u202f]/g, "").replace(/,/g, ".").replace(/−/g, "-");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(cleaned)) return undefined;
  return Number(cleaned);
}

function rankFrom(value = ""): { place?: number; total?: number } {
  const match = value.match(/([\d\s]+)\s+из\s+([\d\s]+)/i);
  return match ? { place: numeric(match[1]), total: numeric(match[2]) } : {};
}

async function sourceText(path: string): Promise<string> {
  // All callers supply fixed route prefixes and validated numeric IDs, never arbitrary URLs.
  const response = await fetch(`${ROOT}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; KHLFantasyPlanner/2.0)",
      Accept: "application/json,text/html;q=0.9",
      "Accept-Language": "ru-RU,ru;q=0.9",
    },
  });
  if (!response.ok) throw new Error(`Sports.ru: HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.hostname !== "www.sports.ru" && finalUrl.hostname !== "sports.ru") {
    throw new Error("Sports.ru перенаправил запрос на другой сайт.");
  }
  const body = await response.text();
  if (body.length > 4_000_000) throw new Error("Слишком большой ответ Sports.ru.");
  return body;
}

export function parseSportsProfile(html: string, teamId: string): SportsProfile {
  const $ = load(html);
  const title = text($("title").text());
  const registryTeam = html.match(/\.set\(['"]team_id['"],\s*(\d+)\)/)?.[1];
  const tournament = html.match(/\.set\(['"]tournament_id['"],\s*(\d+)\)/)?.[1];
  if (registryTeam !== teamId || tournament !== "107") {
    throw new Error("Страница не соответствует указанной команде турнира КХЛ.");
  }
  const rows = $("table.profile-table tr").toArray().map((row) => ({
    label: text($(row).children("th").text()),
    value: text($(row).children("td").text()),
    href: $(row).find("a").first().attr("href"),
  }));
  const find = (label: string) => rows.find((row) => row.label === label);
  const overallRank = rankFrom(find("Место")?.value);
  const leagueIndex = rows.findIndex((row) => row.label === "Лига");
  const fanIndex = rows.findIndex((row) => row.label === "Лига болельщиков");
  const leagueRank = rankFrom(leagueIndex >= 0 ? rows.slice(leagueIndex + 1).find((row) => row.label === "Место")?.value : "");
  const fanRank = rankFrom(fanIndex >= 0 ? rows.slice(fanIndex + 1).find((row) => row.label === "Место")?.value : "");
  const leagueId = find("Лига")?.href?.match(/\/league\/(\d+)\.html/)?.[1];
  const teamValue = numeric(find("Стоимость команды")?.value);
  const balance = numeric(find("Баланс")?.value);
  if (!title || teamValue === undefined || balance === undefined) {
    throw new Error("В профиле Sports.ru не найдены стоимость команды и баланс.");
  }
  const transfersLeftRaw = numeric(find("Трансферы")?.value);
  return {
    teamId,
    teamName: title.split(":")[0].trim(),
    week: find("Текущая неделя")?.value,
    deadline: find("Дедлайн")?.value,
    rank: overallRank.place,
    totalTeams: overallRank.total,
    teamValue,
    balance,
    budgetLimit: teamValue + balance,
    // Sports.ru shows the number of transfers LEFT this week, not used.
    transfersLeft: transfersLeftRaw === undefined ? undefined : Math.max(0, Math.min(5, transfersLeftRaw)),
    transfersUsed: transfersLeftRaw === undefined ? undefined : Math.max(0, 5 - Math.min(5, transfersLeftRaw)),
    weeklyTransfersLimit: 5,
    supporterLeague: find("Лига болельщиков")?.value,
    supporterLeagueRank: fanRank.place,
    league: find("Лига")?.value,
    leagueId,
    leagueUrl: leagueId ? `${ROOT}/league/${leagueId}.html` : undefined,
    leagueRank: leagueRank.place,
    leagueTotal: leagueRank.total,
    profileUrl: `${ROOT}/team/${teamId}.html`,
    rosterUrl: `${ROOT}/team/stat/${teamId}.html`,
  };
}

export function parseLeague(html: string, teamId: string): LeagueStanding[] {
  const $ = load(html);
  const result: LeagueStanding[] = [];
  $("table.stat-table tbody tr").each((_index, row) => {
    const cells = $(row).children("td");
    const anchor = $(row).find('a[href*="/fantasy/hockey/team/"]').first();
    const id = anchor.attr("href")?.match(/\/team\/(\d+)\.html/)?.[1];
    const rank = numeric(text(cells.eq(0).text()));
    const seasonPoints = numeric(text(cells.last().text()));
    const tourPoints = numeric(text(cells.eq(cells.length - 2).text()));
    if (!id || rank === undefined || seasonPoints === undefined || tourPoints === undefined) return;
    result.push({
      rank,
      teamId: id,
      teamName: text(anchor.text()),
      manager: text($(row).find('a[href*="/profile/"]').first().text()),
      seasonPoints,
      tourPoints,
      isCurrent: id === teamId,
    });
  });
  return result.sort((a, b) => a.rank - b.rank);
}

export function parseRatings(html: string): RatedPlayer[] {
  const $ = load(html);
  const result: RatedPlayer[] = [];
  $("table.ratings-table tbody tr").each((_index, row) => {
    const nameLink = $(row).find("a.name").first();
    const name = text(nameLink.text());
    const club = text($(row).find('a[href*="/hockey/club/"]').text());
    const info = text($(row).find(".overBox").text());
    const position = normalizePosition(info.match(/вратарь|защитник|полузащитник|нападающий/i)?.[0]);
    const points = numeric(text($(row).children("td").last().text()));
    const rank = numeric(text($(row).find(".number").text()));
    if (!name || !club || !position || points === undefined || rank === undefined) return;
    const href = nameLink.attr("href");
    result.push({ rank, name, club, position, seasonPoints: points, profileUrl: href?.startsWith("https://www.sports.ru/") ? href : undefined });
  });
  return result;
}

/** Verified read endpoint: /fantasy/hockey/team/json/{teamID}.json. */
export function parseLegacyRoster(payload: unknown, owned: boolean, fetchedAt: string): FantasyPlayer[] {
  if (!payload || typeof payload !== "object" || !("players" in payload) || !Array.isArray(payload.players)) {
    throw new Error("Sports.ru не вернул список игроков команды.");
  }
  const roles: Record<string, Position> = { "1": "G", "2": "D", "3": "F" };
  const roster = payload.players.map((value: unknown): FantasyPlayer => {
    if (!value || typeof value !== "object") throw new Error("Некорректная строка состава.");
    const row = value as Record<string, unknown>;
    const sportsId = String(row.id ?? "");
    const position = roles[String(row.amplua)];
    const price = numeric(row.price);
    const delta = numeric(typeof row.delta === "string" ? row.delta.replace(/^\+/, "") : row.delta);
    if (!/^\d{1,12}$/.test(sportsId) || String(row.now_id) !== "107" || !position || price === undefined || price <= 0 || !row.name || !row.club) {
      throw new Error("Sports.ru вернул неполную карточку игрока КХЛ.");
    }
    return {
      id: `sports:107:${sportsId}`,
      sportsId,
      name: text(String(row.name)),
      club: text(String(row.club)),
      position,
      price,
      // Legacy `points`/`season` are NOT Fantasy scoring: currently they repeat the price.
      // Only the named «О» column in each player's statistics is used below.
      seasonPoints: 0,
      gamesPlayed: 0,
      fantasyAvg: null,
      last5Points: 0,
      last5Games: 0,
      gamesNextWeek: 0,
      gamesWeek2: 0,
      gamesWeek3: 0,
      gamesWeek4: 0,
      availability: 1,
      scheduleFactor: 1,
      owned,
      priceKnown: true,
      seasonPointsKnown: false,
      statsKnown: false,
      scheduleKnown: false,
      earnedWeekPoints: 0,
      weekGamesPlayed: 0,
      remainingGamesKnown: false,
      locked: String(row.lock) === "1",
      // Sports.ru price = initial price + season fantasy points (`delta`).
      initialPrice: delta !== undefined && price - delta > 0 ? price - delta : undefined,
      source: "Sports.ru · автоматическая синхронизация",
      sourceUpdatedAt: fetchedAt,
      playerSourceUrl: `${ROOT}/player/info/107/${sportsId}.html`,
    };
  });
  const counts = { G: 0, D: 0, F: 0 };
  roster.forEach((player) => { counts[player.position] += 1; });
  if (roster.length !== 17 || new Set(roster.map((player) => player.id)).size !== 17 || counts.G !== 2 || counts.D !== 6 || counts.F !== 9) {
    throw new Error("Sports.ru вернул неполный состав. Сохранённая команда не будет перезаписана.");
  }
  return roster;
}

interface MatchStat {
  date: string;
  points: number;
  minutes: number;
  opponent?: string;
  home?: boolean;
  homeGoals?: number;
  awayGoals?: number;
}

interface CalendarGame {
  date: string;
  week: number | null;
  opponent: string;
  home: boolean | null;
  completed: boolean;
}

export interface ParsedPlayerPage {
  fullName: string;
  position: Position | null;
  club: string;
  fields: Map<string, string>;
  matches: MatchStat[];
  calendar: CalendarGame[];
  calendarKnown: boolean;
  pointsKnown: boolean;
  season?: string;
}

export interface GameResult {
  date: string;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
}

export interface TeamStrength {
  leagueGoals: number;
  teams: Map<string, { goalsFor: number; goalsAgainst: number; games: number }>;
}

function dateKey(value: string): string | null {
  const parts = value.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return parts ? `${parts[3]}-${parts[2]}-${parts[1]}` : null;
}

function sideOf(value: string): boolean | null {
  if (/^дома$/i.test(value)) return true;
  if (/^в гостях$/i.test(value)) return false;
  return null;
}

export function parsePlayerPage(html: string): ParsedPlayerPage {
  const $ = load(html);
  const fields = new Map<string, string>();
  $("table.profile-table tr").each((_index, row) => {
    fields.set(text($(row).children("th").text()), text($(row).children("td").text()));
  });
  const table = $("#stat table.stat-table").first();
  const headers = table.find("thead tr").first().children("td,th").toArray().map((cell) => text($(cell).text()));
  const pointsIndex = headers.indexOf("О");
  const minutesIndex = headers.indexOf("МИН");
  const dateIndex = headers.indexOf("Дата");
  const opponentIndex = headers.indexOf("Соперник");
  const scoreIndex = headers.indexOf("Счет");
  const matches: MatchStat[] = [];
  if (pointsIndex >= 0 && minutesIndex >= 0 && dateIndex >= 0) {
    table.find("tbody tr").each((_index, row) => {
      const cells = $(row).children("td");
      const date = dateKey(cells.eq(dateIndex).text());
      const points = numeric(text(cells.eq(pointsIndex).text()));
      const time = text(cells.eq(minutesIndex).text()).match(/^(\d+):(\d{2})$/);
      if (!date || points === undefined || !time) return;
      const match: MatchStat = { date, points, minutes: Number(time[1]) + Number(time[2]) / 60 };
      if (opponentIndex >= 0) {
        match.opponent = text(cells.eq(opponentIndex).text()) || undefined;
        const side = sideOf(text(cells.eq(opponentIndex + 1).text()));
        if (side !== null) match.home = side;
      }
      const score = scoreIndex >= 0 ? text(cells.eq(scoreIndex).text()).match(/^(\d+)\s*:\s*(\d+)/) : null;
      if (score) {
        match.homeGoals = Number(score[1]);
        match.awayGoals = Number(score[2]);
      }
      matches.push(match);
    });
  }
  matches.sort((a, b) => b.date.localeCompare(a.date));
  const calendarTable = $("#calendar table.stat-table").first();
  const calendarHeaders = calendarTable.find("thead tr").first().children("td,th").toArray().map((cell) => text($(cell).text()));
  const calendarOpponent = calendarHeaders.indexOf("Соперник");
  const calendar: CalendarGame[] = [];
  calendarTable.find("tbody tr").each((_index, row) => {
    const cells = $(row).children("td");
    const label = text(cells.first().text());
    const date = dateKey(label);
    if (!date) return;
    const week = Number(label.match(/неделя\s+(\d+)/i)?.[1]);
    const opponent = calendarOpponent >= 0 ? text(cells.eq(calendarOpponent).text()) : "";
    calendar.push({
      date,
      week: Number.isInteger(week) ? week : null,
      opponent,
      home: calendarOpponent >= 0 ? sideOf(text(cells.eq(calendarOpponent + 1).text())) : null,
      completed: /\d\s*:\s*\d/.test(text(cells.last().text())),
    });
  });
  return {
    fullName: text($(".short-info h1").text()),
    position: normalizePosition(fields.get("Амплуа")),
    club: text($("table.profile-table").first().find('a[href*="/hockey/club/"]').text()),
    fields,
    matches,
    calendar,
    calendarKnown: calendarHeaders.includes("Дата") && calendarHeaders.includes("Соперник"),
    pointsKnown: pointsIndex >= 0,
    season: text($("#slt option:selected").text()) || undefined,
  };
}

/** Completed games found on player pages, deduplicated across teammates and opponents. */
export function gameResults(pages: Array<{ page: ParsedPlayerPage; club: string }>): GameResult[] {
  const games = new Map<string, GameResult>();
  for (const { page, club } of pages) {
    for (const match of page.matches) {
      if (!match.opponent || match.home === undefined || match.homeGoals === undefined || match.awayGoals === undefined) continue;
      const home = match.home ? club : match.opponent;
      const away = match.home ? match.opponent : club;
      const key = `${match.date}|${nameKey(home)}|${nameKey(away)}`;
      if (!games.has(key)) games.set(key, { date: match.date, home, away, homeGoals: match.homeGoals, awayGoals: match.awayGoals });
    }
  }
  return [...games.values()];
}

/** Goals for/against per game, shrunk by five league-average games. */
export function buildTeamStrength(results: GameResult[]): TeamStrength {
  const raw = new Map<string, { goalsFor: number; goalsAgainst: number; games: number }>();
  const add = (team: string, goalsFor: number, goalsAgainst: number) => {
    const key = nameKey(team);
    const item = raw.get(key) ?? { goalsFor: 0, goalsAgainst: 0, games: 0 };
    item.goalsFor += goalsFor;
    item.goalsAgainst += goalsAgainst;
    item.games += 1;
    raw.set(key, item);
  };
  for (const game of results) {
    add(game.home, game.homeGoals, game.awayGoals);
    add(game.away, game.awayGoals, game.homeGoals);
  }
  const totalGames = [...raw.values()].reduce((sum, item) => sum + item.games, 0);
  const leagueGoals = totalGames ? [...raw.values()].reduce((sum, item) => sum + item.goalsFor, 0) / totalGames : 0;
  const teams = new Map<string, { goalsFor: number; goalsAgainst: number; games: number }>();
  for (const [key, item] of raw) {
    teams.set(key, {
      goalsFor: (item.goalsFor + leagueGoals * 5) / (item.games + 5),
      goalsAgainst: (item.goalsAgainst + leagueGoals * 5) / (item.games + 5),
      games: item.games,
    });
  }
  return { leagueGoals, teams };
}

/**
 * Backtested opponent effect: skaters score more against leaky defences
 * (forwards ≈ +13%, defenders ≈ +9% per standard deviation); goalies get a mild,
 * conservative adjustment for the opponent's attack.
 */
export function opponentFactor(position: Position, opponent: string, strength?: TeamStrength): number {
  const team = strength?.teams.get(nameKey(opponent));
  if (!strength || !team || strength.leagueGoals <= 0) return 1;
  if (position === "G") return Math.min(1.15, Math.max(0.85, 1 - 0.3 * (team.goalsFor / strength.leagueGoals - 1)));
  const beta = position === "F" ? 0.5 : 0.4;
  return Math.min(1.2, Math.max(0.8, 1 + beta * (team.goalsAgainst / strength.leagueGoals - 1)));
}

function weightedShare(sequence: number[], decay: number): number {
  let total = 0;
  let weight = 0;
  sequence.forEach((value, index) => {
    const itemWeight = Math.pow(decay, index);
    total += value * itemWeight;
    weight += itemWeight;
  });
  return weight > 0 ? total / weight : 1;
}

function gamesWord(count: number): string {
  const last = count % 10;
  const lastTwo = count % 100;
  if (last === 1 && lastTwo !== 11) return "матч";
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return "матча";
  return "матчей";
}

/**
 * Availability from the participation pattern (Brier score in the backtest: 0.089 → 0.056).
 * Missed team games appear on Sports.ru as 00:00 rows for skaters and goalies.
 */
export function estimateAvailability(position: Position, participation: number[]): { availability: number; streak: number; note?: string } {
  const sequence = participation.slice(0, 12);
  const playedIndex = sequence.findIndex((value) => value > 0);
  const streak = playedIndex < 0 ? sequence.length : playedIndex;
  if (sequence.length < 3) return { availability: streak === 0 ? 1 : 0.5, streak, note: streak ? `не играл в ${streak} последних ${gamesWord(streak)}` : undefined };
  let availability: number;
  if (position === "G") {
    availability = weightedShare(sequence, 0.9) * (streak < 3 ? 1 : Math.pow(0.7, streak - 2));
  } else if (streak === 0) {
    availability = 0.5 + 0.5 * weightedShare(sequence, 0.7);
  } else {
    availability = Math.max(0.03, Math.min(weightedShare(sequence, 0.7), 0.7 * Math.pow(0.8, streak - 1)));
  }
  availability = Math.max(0, Math.min(1, availability));
  let note: string | undefined;
  if (streak >= 1) note = `пропустил ${streak === 1 ? "последний матч" : `${streak} последних ${gamesWord(streak)}`}`;
  else if (position === "G" && availability < 0.75) note = `выходит примерно в ${Math.round(availability * 100)}% матчей`;
  return { availability, streak, note };
}

function moscowToday(fetchedAt: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(fetchedAt));
}

function fantasyWeekWindow(fetchedAt: string): { start: string; end: string } {
  // Fantasy weeks run Monday 04:00 to Monday 04:00 (Moscow).
  const moscowParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(fetchedAt));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(moscowParts.find((item) => item.type === type)?.value ?? 0);
  const localMs = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  const localDay = new Date(localMs).getUTCDay();
  let weekStartMs = Date.UTC(part("year"), part("month") - 1, part("day") - ((localDay + 6) % 7), 4, 0);
  if (localMs < weekStartMs) weekStartMs -= 7 * 24 * 60 * 60 * 1000;
  return {
    start: new Date(weekStartMs).toISOString().slice(0, 10),
    end: new Date(weekStartMs + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
}

export function buildPlayerFromPage(
  page: ParsedPlayerPage,
  player: FantasyPlayer,
  currentWeek: number,
  fetchedAt: string,
  strength?: TeamStrength,
): FantasyPlayer {
  if (!page.fullName || page.position !== player.position || nameKey(page.club) !== nameKey(player.club)) {
    throw new Error("Карточка статистики не соответствует игроку состава.");
  }
  const matches = page.matches;
  const played = matches.filter((match) => match.minutes > 0);
  const recent = played.slice(0, 5);
  const officialRate = numeric(page.fields.get("В среднем очков за матч"));
  const statsKnown = played.length > 0 && page.pointsKnown;
  const scheduleKnown = Number.isInteger(currentWeek) && currentWeek > 0 && page.calendarKnown;
  const weeks = [0, 0, 0, 0];
  const factorSums = [0, 0, 0, 0];
  const fixtures: Fixture[] = [];
  const today = moscowToday(fetchedAt);
  if (scheduleKnown) {
    for (const game of page.calendar) {
      // Do not count completed games or old calendar rows as future fixtures.
      if (game.completed || game.date < today || game.week === null) continue;
      const offset = game.week - currentWeek;
      if (offset < 0 || offset >= 4) continue;
      const factor = opponentFactor(player.position, game.opponent, strength);
      weeks[offset] += 1;
      factorSums[offset] += factor;
      fixtures.push({ date: game.date, week: game.week, opponent: game.opponent, home: game.home, factor: Math.round(factor * 1000) / 1000 });
    }
  }
  const window = fantasyWeekWindow(fetchedAt);
  const currentWeekMatches = matches.filter((match) => match.date >= window.start && match.date < window.end);
  const participation = matches.slice(0, 12).map((match) => (match.minutes > 0 ? 1 : 0));
  const estimate = matches.length ? estimateAvailability(player.position, participation) : { availability: 1, streak: 0, note: undefined };
  const seasonPoints = matches.reduce((total, match) => total + match.points, 0);
  const initialPrice = numeric(page.fields.get("Первоначальная стоимость"));
  const selectedBy = numeric(page.fields.get("Выбрали")?.match(/[\d.,]+/)?.[0]);
  return {
    ...player,
    name: page.fullName,
    seasonPoints,
    seasonPointsKnown: page.pointsKnown && matches.length > 0,
    gamesPlayed: played.length,
    fantasyAvg: statsKnown ? null : officialRate ?? null,
    last5Points: recent.reduce((total, match) => total + match.points, 0),
    last5Games: recent.length,
    statsKnown: statsKnown || officialRate !== undefined,
    gamesNextWeek: weeks[0],
    gamesWeek2: weeks[1],
    gamesWeek3: weeks[2],
    gamesWeek4: weeks[3],
    scheduleKnown,
    earnedWeekPoints: currentWeekMatches.reduce((total, match) => total + match.points, 0),
    weekGamesPlayed: currentWeekMatches.filter((match) => match.minutes > 0).length,
    weekNumber: Number.isInteger(currentWeek) && currentWeek > 0 ? currentWeek : undefined,
    remainingGamesKnown: scheduleKnown,
    availability: estimate.availability,
    availabilityEstimated: true,
    absenceStreak: estimate.streak,
    availabilityNote: estimate.note,
    participation,
    pointHistory: played.slice(0, 120).map((match) => match.points),
    initialPrice: initialPrice && initialPrice > 0 ? initialPrice : player.price - seasonPoints > 0 ? player.price - seasonPoints : player.initialPrice,
    selectedBy,
    weekFactors: weeks.map((count, index) => (count ? Math.round((factorSums[index] / count) * 1000) / 1000 : 1)),
    fixtures,
    sourceUpdatedAt: fetchedAt,
    statsSeason: page.season,
  };
}

export function enrichPlayer(html: string, player: FantasyPlayer, currentWeek: number, fetchedAt: string, strength?: TeamStrength): FantasyPlayer {
  return buildPlayerFromPage(parsePlayerPage(html), player, currentWeek, fetchedAt, strength);
}

const CANDIDATE_DETAIL_TTL = 15 * 60 * 1000;
const detailCache = new Map<string, { html: string; fetchedAt: string }>();
const detailRequests = new Map<string, Promise<{ html: string; fetchedAt: string }>>();
const rosterCache = new Map<string, { players: FantasyPlayer[]; fetchedAt: number }>();

async function playerDetails(sportsId: string, maxAge = SPORTS_SYNC_INTERVAL): Promise<{ html: string; fetchedAt: string }> {
  const previous = detailCache.get(sportsId);
  if (previous && Date.now() - Date.parse(previous.fetchedAt) < maxAge) return previous;
  const inFlight = detailRequests.get(sportsId);
  if (inFlight) return inFlight;
  const request = sourceText(`/player/info/107/${sportsId}.html`).then((html) => {
    const result = { html, fetchedAt: new Date().toISOString() };
    detailCache.delete(sportsId);
    detailCache.set(sportsId, result);
    if (detailCache.size > 600) detailCache.delete(detailCache.keys().next().value as string);
    return result;
  }).finally(() => detailRequests.delete(sportsId));
  detailRequests.set(sportsId, request);
  return request;
}

async function mapConcurrent<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await task(items[current]);
    }
  }));
  return results;
}

async function getRoster(teamId: string, owned: boolean, maxAge = 0): Promise<FantasyPlayer[]> {
  const cached = rosterCache.get(teamId);
  if (maxAge > 0 && cached && Date.now() - cached.fetchedAt < maxAge) return cached.players.map((player) => ({ ...player, owned }));
  const body = await sourceText(`/team/json/${teamId}.json`);
  let data: unknown;
  try { data = JSON.parse(body); } catch { throw new Error("Вместо состава Sports.ru вернул не JSON."); }
  const players = parseLegacyRoster(data, owned, new Date().toISOString());
  rosterCache.set(teamId, { players, fetchedAt: Date.now() });
  if (rosterCache.size > 200) rosterCache.delete(rosterCache.keys().next().value as string);
  return players;
}

interface LoadedPage {
  player: FantasyPlayer;
  page: ParsedPlayerPage | null;
  fetchedAt: string;
}

const POOL_LIMITS: Record<Position, { week: number; month: number; value: number }> = {
  G: { week: 6, month: 6, value: 3 },
  D: { week: 14, month: 14, value: 6 },
  F: { week: 20, month: 20, value: 8 },
};

/**
 * Cheap pre-ranking of the whole league pool from roster JSON (season points = price − initial price)
 * and club calendars, so detailed pages are fetched only for realistic candidates.
 */
function preselectCandidates(
  candidates: FantasyPlayer[],
  clubPages: Map<string, ParsedPlayerPage>,
  currentWeek: number,
  fetchedAt: string,
  strength: TeamStrength,
): FantasyPlayer[] {
  const today = moscowToday(fetchedAt);
  const clubInfo = new Map<string, { games: number; weeks: Array<Array<{ opponent: string }>> }>();
  for (const [club, page] of clubPages) {
    const weeks: Array<Array<{ opponent: string }>> = [[], [], [], []];
    for (const game of page.calendar) {
      if (game.completed || game.date < today || game.week === null) continue;
      const offset = game.week - currentWeek;
      if (offset >= 0 && offset < 4) weeks[offset].push({ opponent: game.opponent });
    }
    clubInfo.set(club, { games: page.matches.length, weeks });
  }
  const rows = candidates.map((player) => {
    const info = clubInfo.get(nameKey(player.club));
    const seasonPoints = player.initialPrice ? player.price - player.initialPrice : 0;
    const games = info?.games ?? 0;
    return { player, info, perGame: games > 0 ? seasonPoints / games : 0, games };
  });
  const priors = new Map<Position, { a: number; b: number }>();
  for (const position of ["G", "D", "F"] as Position[]) {
    const sample = rows.filter((row) => row.player.position === position && row.games >= 3 && row.player.initialPrice);
    const weight = sample.reduce((sum, row) => sum + row.games, 0);
    if (!weight) { priors.set(position, { a: 0, b: 0 }); continue; }
    const mx = sample.reduce((sum, row) => sum + row.games * row.player.initialPrice!, 0) / weight;
    const my = sample.reduce((sum, row) => sum + row.games * row.perGame, 0) / weight;
    const sxx = sample.reduce((sum, row) => sum + row.games * (row.player.initialPrice! - mx) ** 2, 0);
    const sxy = sample.reduce((sum, row) => sum + row.games * (row.player.initialPrice! - mx) * (row.perGame - my), 0);
    const b = sxx > 0 && sample.length >= 8 ? Math.max(0, sxy / sxx) : 0;
    priors.set(position, { a: my - b * mx, b });
  }
  const scored = rows.filter((row) => row.info && nameKey(row.player.club) !== "без клуба").map((row) => {
    const prior = priors.get(row.player.position)!;
    const priorRate = Math.max(0, prior.a + prior.b * (row.player.initialPrice ?? row.player.price));
    const n = effectiveGames(row.games);
    const rate = (row.perGame * n + priorRate * 30) / (n + 30);
    const weekPoints = row.info!.weeks.map((games) => games.reduce((sum, game) => sum + rate * opponentFactor(row.player.position, game.opponent, strength), 0));
    return { player: row.player, week: weekPoints[0], month: weekPoints[0] + weekPoints[1] + 0.5 * weekPoints[2] + 0.25 * weekPoints[3] };
  });
  const selected = new Map<string, FantasyPlayer>();
  for (const position of ["G", "D", "F"] as Position[]) {
    const list = scored.filter((row) => row.player.position === position);
    const limits = POOL_LIMITS[position];
    const add = (row: { player: FantasyPlayer }) => selected.set(row.player.id, row.player);
    [...list].sort((a, b) => b.week - a.week).slice(0, limits.week).forEach(add);
    [...list].sort((a, b) => b.month - a.month).slice(0, limits.month).forEach(add);
    [...list].sort((a, b) => b.week / Math.max(1, b.player.price) - a.week / Math.max(1, a.player.price)).slice(0, limits.value).forEach(add);
  }
  return [...selected.values()];
}

export async function fetchSportsTeam(teamId: string): Promise<SportsSyncData> {
  if (!/^\d{1,12}$/.test(teamId)) throw new Error("Некорректный ID команды.");
  const warnings: string[] = [];
  const [profileHtml, roster, ratings] = await Promise.all([
    sourceText(`/team/${teamId}.html`),
    getRoster(teamId, true),
    sourceText("/tournament/ratings/best/107.html").then(parseRatings).catch(() => [] as RatedPlayer[]),
  ]);
  const profile = parseSportsProfile(profileHtml, teamId);
  const currentWeek = Number(profile.week?.match(/\d+/)?.[0]);
  const totalPrice = roster.reduce((total, player) => total + player.price, 0);
  if (profile.teamValue !== undefined && Math.abs(totalPrice - profile.teamValue) > 0.01) {
    throw new Error("Sports.ru обновляет цены: сумма состава и стоимость профиля пока различаются. Повторим при следующей синхронизации.");
  }
  let standings: LeagueStanding[] = [];
  if (profile.leagueId) {
    try {
      standings = parseLeague(await sourceText(`/league/${profile.leagueId}.html`), teamId);
      const current = standings.find((standing) => standing.isCurrent);
      const leader = standings.find((standing) => standing.rank === 1);
      if (current && leader) {
        profile.leagueRank = current.rank;
        profile.leagueSeasonPoints = current.seasonPoints;
        profile.leagueTourPoints = current.tourPoints;
        profile.leaderName = leader.teamName;
        profile.leaderManager = leader.manager;
        profile.leaderPoints = leader.seasonPoints;
        profile.gapToFirst = Math.max(0, leader.seasonPoints - current.seasonPoints);
        profile.leagueStandings = standings.filter((standing) => standing.rank <= 3 || Math.abs(standing.rank - current.rank) <= 1);
      }
    } catch {
      warnings.push("Таблица лиги временно недоступна. Ваш состав загружен отдельно.");
    }
  }

  // 1. Own roster pages and every league roster (the candidate universe) in parallel.
  const leagueIds = standings.map((standing) => standing.teamId).filter((id) => id !== teamId);
  const sourceTeamIds: string[] = [];
  const loadPage = async (player: FantasyPlayer, maxAge: number): Promise<LoadedPage> => {
    try {
      const detail = await playerDetails(player.sportsId!, maxAge);
      return { player, page: parsePlayerPage(detail.html), fetchedAt: detail.fetchedAt };
    } catch {
      return { player, page: null, fetchedAt: new Date().toISOString() };
    }
  };
  const [ownPages, leagueRosters] = await Promise.all([
    mapConcurrent(roster, 6, (player) => loadPage(player, SPORTS_SYNC_INTERVAL)),
    mapConcurrent(leagueIds, 6, async (id) => {
      try {
        const list = await getRoster(id, false, SPORTS_SYNC_INTERVAL);
        sourceTeamIds.push(id);
        return list;
      } catch { return [] as FantasyPlayer[]; }
    }),
  ]);
  const ownedIds = new Set(roster.map((player) => player.id));
  const universe = new Map<string, FantasyPlayer>();
  for (const list of leagueRosters) for (const player of list) if (!ownedIds.has(player.id) && !universe.has(player.id)) universe.set(player.id, { ...player, owned: false });

  // 2. One page per uncovered club gives that club's calendar and results.
  const clubPages = new Map<string, ParsedPlayerPage>();
  for (const item of ownPages) if (item.page && item.page.calendarKnown) clubPages.set(nameKey(item.player.club), item.page);
  const probes = new Map<string, FantasyPlayer>();
  for (const player of [...universe.values()].sort((a, b) => (b.price - (b.initialPrice ?? b.price)) - (a.price - (a.initialPrice ?? a.price)))) {
    const club = nameKey(player.club);
    if (club === "без клуба" || clubPages.has(club) || probes.has(club)) continue;
    probes.set(club, player);
  }
  const probePages = await mapConcurrent([...probes.values()], 6, (player) => loadPage(player, CANDIDATE_DETAIL_TTL));
  for (const item of probePages) if (item.page && item.page.calendarKnown) clubPages.set(nameKey(item.player.club), item.page);
  const firstPass = [...ownPages, ...probePages].filter((item) => item.page).map((item) => ({ page: item.page!, club: item.player.club }));
  const roughStrength = buildTeamStrength(gameResults(firstPass));

  // 3. Detailed pages for the realistic candidates of the whole league pool.
  const fetchedAtPool = new Date().toISOString();
  const shortlisted = preselectCandidates([...universe.values()], clubPages, currentWeek, fetchedAtPool, roughStrength)
    .filter((player) => !probes.has(nameKey(player.club)) || probes.get(nameKey(player.club))!.id !== player.id);
  const candidatePages = await mapConcurrent(shortlisted, 6, (player) => loadPage(player, CANDIDATE_DETAIL_TTL));
  const allPages = [...ownPages, ...probePages, ...candidatePages];
  const strength = buildTeamStrength(gameResults(allPages.filter((item) => item.page).map((item) => ({ page: item.page!, club: item.player.club }))));

  let incompleteStats = 0;
  const enriched = allPages.map((item) => {
    if (!item.page) {
      if (item.player.owned) incompleteStats += 1;
      return item.player;
    }
    try {
      return buildPlayerFromPage(item.page, item.player, currentWeek, item.fetchedAt, strength);
    } catch {
      if (item.player.owned) incompleteStats += 1;
      return item.player;
    }
  });
  const ownedPlayers = enriched.filter((player) => player.owned);
  const candidates = enriched.filter((player) => !player.owned);
  if (incompleteStats) warnings.push(`Для ${incompleteStats} игроков состава Sports.ru не вернул статистику. Состав и цены сохранены; недостающие данные загрузятся при следующем обновлении.`);
  if (!universe.size) warnings.push("Автоматический пул кандидатов пока недоступен. Состав команды уже синхронизирован; повторите обновление позже.");
  const fetchedAt = new Date().toISOString();
  profile.fetchedAt = fetchedAt;
  return {
    version: SPORTS_DATA_VERSION,
    profile,
    roster: ownedPlayers,
    candidates,
    ratedPlayers: ratings,
    fetchedAt,
    rosterFetchedAt: roster[0].sourceUpdatedAt ?? fetchedAt,
    rosterStatus: "synced",
    sourceUrl: `${ROOT}/team/json/${teamId}.json`,
    candidateSource: `Пул — составы всех ${sourceTeamIds.length} соперников лиги «${profile.league ?? "КХЛ"}»: ${universe.size} хоккеистов. Подробная статистика и календарь загружены для ${candidates.length} самых перспективных.`,
    candidateTeamIds: sourceTeamIds.sort(),
    poolStats: { leagueTeams: sourceTeamIds.length, leaguePlayers: universe.size, detailed: candidates.length, games: gameResults(allPages.filter((item) => item.page).map((item) => ({ page: item.page!, club: item.player.club }))).length },
    warnings,
    cached: false,
    stale: false,
    nextRefreshSeconds: SPORTS_SYNC_INTERVAL / 1000,
  };
}
