import {
  clubKey,
  isPlayerReady,
  playerIdentity,
  projectPlayers,
  type FantasyPlayer,
  type OptimizerSettings,
  type Position,
  type ProjectedPlayer,
} from "./fantasy";
import { bestSwapTiming } from "./weekly-optimizer";

export type ComparisonStatus =
  | "improves"
  | "no-gain"
  | "locked"
  | "no-transfers"
  | "missing-data"
  | "no-schedule"
  | "roster-incomplete"
  | "duplicate"
  | "no-position"
  | "no-budget"
  | "club-limit";

export interface CandidateComparison {
  status: ComparisonStatus;
  reason: string;
  /** Forecast points the candidate can earn in REMAINING matches this week. */
  candidatePoints: number | null;
  /** The currently owned player that is best to replace in an isolated, legal one-for-one trade. */
  outgoing: ProjectedPlayer | null;
  /** Forecast for the outgoing player's REMAINING games. */
  outgoingPoints: number | null;
  /** Points already scored by the outgoing player this week: these cannot be lost by a transfer. */
  outgoingEarnedPoints: number | null;
  gain: number | null;
  costAfter: number | null;
  /** Set when the swap is worth more after the outgoing player's next game than right now. */
  timing?: { afterDate?: string; beforeDate?: string } | null;
}

const EXPECTED: Record<Position, number> = { G: 2, D: 6, F: 9 };
const EPSILON = 0.000001;

function unavailable(status: ComparisonStatus, reason: string, candidatePoints: number | null): CandidateComparison {
  return {
    status,
    reason,
    candidatePoints,
    outgoing: null,
    outgoingPoints: null,
    outgoingEarnedPoints: null,
    gain: null,
    costAfter: null,
  };
}

/**
 * Independent one-for-one comparisons for the candidate list. Unlike the exact weekly
 * optimizer, this does not combine several simultaneous swaps or spend its transfer budget.
 * Missing data, transfer locks and an invalid current roster never become recommendations.
 */
export function compareCandidatesToRoster(
  players: FantasyPlayer[],
  settings: Pick<OptimizerSettings, "budget" | "clubLimit" | "transfersAvailable">,
  fresh = true,
): Map<string, CandidateComparison> {
  const comparisons = new Map<string, CandidateComparison>();
  const owned = players.filter((player) => player.owned);
  const candidates = players.filter((player) => !player.owned);
  const projections = projectPlayers(players, 1);
  const projectedById = new Map(projections.map((player) => [player.id, player]));
  const ownedIdentities = new Set(owned.map(playerIdentity));
  const counts: Record<Position, number> = { G: 0, D: 0, F: 0 };
  const clubs = new Map<string, number>();
  for (const player of owned) {
    counts[player.position] += 1;
    const key = clubKey(player.club);
    clubs.set(key, (clubs.get(key) ?? 0) + 1);
  }
  const validRoster = owned.length === 17 &&
    new Set(owned.map(playerIdentity)).size === 17 &&
    (Object.keys(EXPECTED) as Position[]).every((position) => counts[position] === EXPECTED[position]) &&
    owned.every((player) => isPlayerReady(player) && player.remainingGamesKnown !== false);
  const totalCost = owned.reduce((sum, player) => sum + player.price, 0);
  const budget = Number(settings.budget);
  const clubLimit = Math.min(3, Math.max(1, Math.floor(Number(settings.clubLimit) || 3)));

  for (const candidate of candidates) {
    const projection = projectedById.get(candidate.id);
    const candidatePoints = projection && isPlayerReady(candidate) && candidate.remainingGamesKnown !== false
      ? projection.pointsWeek1
      : null;

    if (!fresh) {
      comparisons.set(candidate.id, unavailable("no-schedule", "Дождитесь свежих данных Sports.ru, чтобы сравнить оставшиеся матчи.", candidatePoints));
      continue;
    }
    if (!validRoster || !Number.isFinite(budget) || totalCost > budget + EPSILON) {
      comparisons.set(candidate.id, unavailable("roster-incomplete", "Сначала дождитесь актуального состава, цен и расписания 17 игроков.", candidatePoints));
      continue;
    }
    if (ownedIdentities.has(playerIdentity(candidate))) {
      comparisons.set(candidate.id, unavailable("duplicate", "Этот хоккеист уже есть в вашем составе.", candidatePoints));
      continue;
    }
    if (candidatePoints === null || !projection) {
      comparisons.set(candidate.id, unavailable("missing-data", "Не хватает цены, статистики или календаря кандидата.", null));
      continue;
    }
    // Even if a transfer is currently unavailable, show an honest hypothetical comparison.
    // The blocked status must not be mistaken for an actionable recommendation.
    const blockingStatus: "locked" | "no-transfers" | null = candidate.locked
      ? "locked"
      : settings.transfersAvailable <= 0 ? "no-transfers" : null;

    const possibleOutgoing = owned.filter((player) => player.position === candidate.position && !player.locked);
    if (possibleOutgoing.length === 0) {
      comparisons.set(candidate.id, unavailable("no-position", "Нет доступного для продажи игрока той же позиции.", candidatePoints));
      continue;
    }
    const candidateClub = clubKey(candidate.club);
    const affordable = possibleOutgoing.filter((player) => totalCost - player.price + candidate.price <= budget + EPSILON);
    if (affordable.length === 0) {
      comparisons.set(candidate.id, unavailable("no-budget", "Для замены одного игрока недостаточно бюджета.", candidatePoints));
      continue;
    }
    const allowed = affordable.filter((player) =>
      (clubs.get(candidateClub) ?? 0) + (clubKey(player.club) === candidateClub ? 0 : 1) <= clubLimit,
    );
    if (allowed.length === 0) {
      comparisons.set(candidate.id, unavailable("club-limit", `После покупки получится больше ${clubLimit} игроков из клуба «${candidate.club}».`, candidatePoints));
      continue;
    }

    // Best partner for this candidate: the largest gain for the rest of the week, either right now or
    // after the outgoing player's next game; ties go to the weaker future and the bigger refund.
    const choices = allowed
      .map((player) => projectedById.get(player.id))
      .filter((player): player is ProjectedPlayer => Boolean(player))
      .map((player) => {
        const now = candidatePoints - player.pointsWeek1;
        const timing = bestSwapTiming(player, projection);
        const timedPrice = candidate.price + Math.max(0, timing.inPointsBefore);
        const timed = timing.afterDate && totalCost - player.price + timedPrice <= budget + EPSILON
          ? timing.points - player.pointsWeek1
          : -Infinity;
        return { player, gain: Math.max(now, timed), timed: timed > now + EPSILON ? timing : null };
      })
      .sort((a, b) => b.gain - a.gain || a.player.futurePoints - b.player.futurePoints || b.player.price - a.player.price || a.player.name.localeCompare(b.player.name, "ru"));
    const best = choices[0];
    if (!best) {
      comparisons.set(candidate.id, unavailable("roster-incomplete", "Нет актуального прогноза для игрока состава.", candidatePoints));
      continue;
    }
    const { player: outgoing, gain, timed } = best;
    comparisons.set(candidate.id, {
      status: gain > EPSILON ? blockingStatus ?? "improves" : "no-gain",
      reason: gain <= EPSILON
        ? "Этот кандидат не увеличит прогноз очков на оставшуюся неделю."
        : blockingStatus === "no-transfers"
          ? "По очкам замена могла бы помочь, но на этой неделе трансферы закончились."
          : blockingStatus === "locked"
            ? "По очкам замена могла бы помочь, но Sports.ru временно закрыл покупку кандидата."
            : timed
              ? "Выгоднее менять после ближайшего матча вашего игрока — так очки принесут оба."
              : "Возможная одиночная замена. Итоговый план из нескольких замен считайте отдельно.",
      candidatePoints,
      outgoing,
      outgoingPoints: outgoing.pointsWeek1,
      outgoingEarnedPoints: outgoing.earnedWeekPoints ?? 0,
      gain,
      costAfter: totalCost - outgoing.price + candidate.price,
      timing: timed ? { afterDate: timed.afterDate, beforeDate: timed.beforeDate } : null,
    });
  }
  return comparisons;
}
