import solver, { type Model, type SolveResult } from "javascript-lp-solver";
import {
  clubKey,
  isPlayerReady,
  playerIdentity,
  playerMissingData,
  POSITION_ORDER,
  projectPlayers,
  type FantasyPlayer,
  type OptimizationResult,
  type OptimizerSettings,
  type Position,
  type ProjectedPlayer,
  type TransferSuggestion,
} from "./fantasy";

const EXPECTED: Record<Position, number> = { G: 2, D: 6, F: 9 };
const EPSILON = 0.000001;
/** A preparation move must add at least this many discounted points over the next weeks. */
const PREP_MIN_GAIN = 1;

export interface WeeklyContext {
  weekNumber?: number;
  /** Actual current-tour team score from the league table, if available. */
  bankedTeamPoints?: number;
}

/** When to execute one transfer inside the current week. */
export interface SwapTiming {
  /** Points from this roster slot for the rest of the week. */
  points: number;
  /** Keep the outgoing player until his game on this date is over. */
  afterDate?: string;
  /** First counted game of the incoming player. */
  beforeDate?: string;
  /** Expected points of each player before the transfer (they change the prices). */
  outPointsBefore: number;
  inPointsBefore: number;
}

/**
 * Transfers take effect immediately and players lock only around their own games, so the
 * best moment for a swap can be after the outgoing player's game and before the incoming one's.
 */
export function bestSwapTiming(outgoing: ProjectedPlayer, incoming: ProjectedPlayer): SwapTiming {
  const inGames = incoming.remainingGames;
  const outGames = outgoing.remainingGames;
  let best: SwapTiming = {
    points: incoming.pointsWeek1,
    beforeDate: inGames?.[0]?.date,
    outPointsBefore: 0,
    inPointsBefore: 0,
  };
  if (!outGames?.length || !inGames) return best;
  const dates = [...new Set(outGames.map((game) => game.date))].sort();
  for (const date of dates) {
    const outPointsBefore = outGames.filter((game) => game.date <= date).reduce((sum, game) => sum + game.points, 0);
    const after = inGames.filter((game) => game.date > date);
    const inPointsBefore = inGames.filter((game) => game.date <= date).reduce((sum, game) => sum + game.points, 0);
    const points = outPointsBefore + after.reduce((sum, game) => sum + game.points, 0);
    if (points > best.points + 1e-9) best = { points, afterDate: date, beforeDate: after[0]?.date, outPointsBefore, inPointsBefore };
  }
  return best;
}

interface SlotOption {
  slot: number;
  out: ProjectedPlayer;
  player: ProjectedPlayer;
  swap: boolean;
  variable: string;
  week: number;
  future: number;
  timing: SwapTiming;
  /** Index in the week's timeline: 0 = now, k = after the k-th game date. */
  time: number;
  priceIn: number;
  priceOut: number;
}

function empty(reason: string, candidatesAvailable = 0): OptimizationResult {
  return {
    ready: false,
    reason,
    swaps: [],
    baselineWeekPoints: 0,
    projectedWeekPoints: 0,
    baselineHorizonPoints: 0,
    projectedHorizonPoints: 0,
    gainWeek: 0,
    gainHorizon: 0,
    currentCost: 0,
    finalCost: 0,
    remainingBudget: 0,
    transfersUsed: 0,
    transfersAvailable: 0,
    candidatesAvailable,
    candidatesConsidered: 0,
    candidatePoolTrimmed: false,
    warnings: [],
    horizonWeeks: 1,
    exact: false,
  };
}

function solve(model: Model): SolveResult {
  const result = solver.Solve(model) as SolveResult;
  if (!result.feasible || result.isIntegral === false) {
    throw new Error("Не удалось подтвердить допустимое оптимальное решение за отведённое время.");
  }
  return result;
}

function pickOptions(result: SolveResult, options: SlotOption[], slots: number): SlotOption[] | null {
  const picked: SlotOption[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const chosen = options.filter((option) => option.slot === slot && Number(result[option.variable] ?? 0) > 0.5);
    if (chosen.length !== 1) return null;
    picked.push(chosen[0]);
  }
  return picked;
}

function withConstraints(model: Model, extra: Model["constraints"], optimize: string, opType: "max" | "min"): Model {
  return { ...model, optimize, opType, constraints: { ...model.constraints, ...extra } };
}

const sum = (options: SlotOption[], key: "week" | "future") => options.reduce((total, option) => total + option[key], 0);

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

/** Orders swaps so that cash stays non-negative and the club limit holds after every single transfer. */
function executionOrder(
  swaps: SlotOption[],
  balance: number,
  owned: ProjectedPlayer[],
  clubLimit: number,
): { order: SlotOption[]; feasible: boolean; minCash: number; maxClub: number } {
  const groups = [...new Set(swaps.map((swap) => swap.time))].sort((a, b) => a - b).map((time) => swaps.filter((swap) => swap.time === time));
  const clubs = new Map<string, number>();
  owned.forEach((player) => clubs.set(clubKey(player.club), (clubs.get(clubKey(player.club)) ?? 0) + 1));
  let cash = balance;
  let minCash = balance;
  let maxClub = Math.max(0, ...clubs.values());
  let feasible = true;
  const order: SlotOption[] = [];
  const urgency = (swap: SlotOption) => swap.timing.beforeDate ?? "9999-99-99";
  for (const group of groups) {
    const sorted = [...group].sort((a, b) => urgency(a).localeCompare(urgency(b)) || (a.priceIn - a.priceOut) - (b.priceIn - b.priceOut));
    const candidatesOrders = group.length <= 6 ? [sorted, ...permutations(sorted)] : [sorted];
    let chosen: SlotOption[] | null = null;
    for (const candidate of candidatesOrders) {
      let localCash = cash;
      const localClubs = new Map(clubs);
      let ok = true;
      for (const swap of candidate) {
        localCash += swap.priceOut - swap.priceIn;
        const outKey = clubKey(swap.out.club);
        const inKey = clubKey(swap.player.club);
        localClubs.set(outKey, (localClubs.get(outKey) ?? 0) - 1);
        localClubs.set(inKey, (localClubs.get(inKey) ?? 0) + 1);
        if (localCash < -EPSILON || (localClubs.get(inKey) ?? 0) > clubLimit) { ok = false; break; }
      }
      if (ok) { chosen = candidate; break; }
    }
    if (!chosen) { feasible = false; chosen = sorted; }
    for (const swap of chosen) {
      cash += swap.priceOut - swap.priceIn;
      const outKey = clubKey(swap.out.club);
      const inKey = clubKey(swap.player.club);
      clubs.set(outKey, (clubs.get(outKey) ?? 0) - 1);
      clubs.set(inKey, (clubs.get(inKey) ?? 0) + 1);
      minCash = Math.min(minCash, cash);
      maxClub = Math.max(maxClub, clubs.get(inKey) ?? 0);
      order.push(swap);
    }
  }
  return { order, feasible, minCash, maxClub };
}

/**
 * Exact binary optimisation for the current tour. Priorities, in order:
 * 1) maximum expected points in the remaining games of this week;
 * 2) the fewest transfers that achieve it;
 * 3) among equal plans, the best discounted forecast for the next weeks;
 * 4) the cheapest final roster.
 * Unused transfers may then be offered as optional preparation moves that do not cost
 * a single expected point this week but improve the next weeks.
 */
export function recommendTransfers(
  sourcePlayers: FantasyPlayer[],
  inputSettings: OptimizerSettings,
  context: WeeklyContext = {},
): OptimizationResult {
  const budget = Math.max(0, Number(inputSettings.budget) || 0);
  const transfersAvailable = Math.max(0, Math.min(5, Math.floor(Number(inputSettings.transfersAvailable) || 0)));
  const clubLimit = Math.max(1, Math.min(3, Math.floor(inputSettings.clubLimit || 3)));
  const ownedRaw = sourcePlayers.filter((player) => player.owned);
  const counts: Record<Position, number> = { G: 0, D: 0, F: 0 };
  ownedRaw.forEach((player) => { counts[player.position] += 1; });
  if (ownedRaw.length !== 17 || POSITION_ORDER.some((position) => counts[position] !== EXPECTED[position])) {
    return empty("Нужен полный состав: 2 вратаря, 6 защитников и 9 нападающих.");
  }
  if (new Set(ownedRaw.map(playerIdentity)).size !== 17) return empty("В составе есть повторяющийся игрок.");
  const incomplete = ownedRaw.filter((player) => !isPlayerReady(player));
  if (incomplete.length) return empty(`Не хватает данных состава: ${[...new Set(incomplete.flatMap(playerMissingData))].join(", ")}.`);
  if (ownedRaw.some((player) => player.remainingGamesKnown === false)) {
    return empty("Календарь оставшихся матчей текущей недели ещё не подтверждён. Обновите данные Sports.ru.");
  }
  const currentCost = ownedRaw.reduce((total, player) => total + player.price, 0);
  if (currentCost > budget + EPSILON) return empty("Стоимость состава выше доступного бюджета.");
  const currentClubs = new Map<string, number>();
  ownedRaw.forEach((player) => currentClubs.set(clubKey(player.club), (currentClubs.get(clubKey(player.club)) ?? 0) + 1));
  if ([...currentClubs.values()].some((count) => count > clubLimit)) return empty(`Превышен лимит ${clubLimit} игроков из клуба.`);

  const projected = projectPlayers(sourcePlayers, 1);
  const byId = new Map(projected.map((player) => [player.id, player]));
  const owned = ownedRaw.map((player) => byId.get(player.id)).filter((player): player is ProjectedPlayer => Boolean(player));
  const ownedIds = new Set(owned.map((player) => player.id));
  const ownedIdentities = new Set(owned.map(playerIdentity));
  const candidates = projected.filter((player) => !player.owned && !player.locked && !ownedIds.has(player.id) && !ownedIdentities.has(playerIdentity(player)) && isPlayerReady(player));
  const earnedFromPlayers = owned.reduce((total, player) => total + (player.earnedWeekPoints ?? 0), 0);
  const earned = Math.max(earnedFromPlayers, Number(context.bankedTeamPoints) || 0);
  const remainingBefore = owned.reduce((total, player) => total + player.pointsWeek1, 0);
  const futureBefore = owned.reduce((total, player) => total + player.futurePoints, 0);
  const weekNumber = context.weekNumber ?? owned.find((player) => player.weekNumber)?.weekNumber;
  const balance = budget - currentCost;

  const warnings = [
    "Прогноз — ожидание, а не гарантия: соперники по лиге тоже набирают очки. Факт тура показывается отдельно из таблицы лиги.",
  ];
  const goalieEstimates = [...owned, ...candidates].filter((player) => player.position === "G" && player.availabilityEstimated).length;
  if (goalieEstimates) warnings.push(`Для вратарей (${goalieEstimates}) вероятность старта оценена по последним матчам, а не по подтверждённому протоколу.`);
  const lockedCount = sourcePlayers.filter((player) => player.locked).length;
  if (lockedCount) warnings.push(`Sports.ru временно закрыл трансферы для ${lockedCount} игроков. После их матчей обновите данные.`);

  // ---- Options: keep the player in each slot or replace him with a same-position candidate.
  const timeline = new Set<string>();
  const options: SlotOption[] = [];
  owned.forEach((current, slot) => {
    options.push({
      slot, out: current, player: current, swap: false, variable: `k_${slot}`,
      week: current.pointsWeek1, future: current.futurePoints, timing: { points: current.pointsWeek1, outPointsBefore: 0, inPointsBefore: 0 },
      time: 0, priceIn: 0, priceOut: 0,
    });
    if (current.locked) return;
    candidates.forEach((candidate, candidateIndex) => {
      if (candidate.position !== current.position) return;
      const timing = bestSwapTiming(current, candidate);
      if (timing.afterDate) timeline.add(timing.afterDate);
      options.push({
        slot, out: current, player: candidate, swap: true, variable: `x_${slot}_${candidateIndex}`,
        week: timing.points, future: candidate.futurePoints, timing, time: 0,
        // Conservative cash: the incoming price may grow before the transfer, the outgoing one is not counted on.
        priceIn: candidate.price + Math.max(0, timing.inPointsBefore),
        priceOut: current.price,
      });
    });
  });
  const dates = [...timeline].sort();
  options.forEach((option) => { option.time = option.timing.afterDate ? dates.indexOf(option.timing.afterDate) + 1 : 0; });
  const times = [...new Set(options.filter((option) => option.swap).map((option) => option.time))].sort((a, b) => a - b);
  if (!times.length) times.push(0);

  const finish = (core: SlotOption[], prep: SlotOption[], exact: boolean): OptimizationResult => {
    const coreSwaps = core.filter((option) => option.swap);
    const ordered = executionOrder([...coreSwaps, ...prep], balance, owned, clubLimit);
    const final = [...core.filter((option) => !prep.some((item) => item.slot === option.slot)), ...prep].map((option) => option.player);
    const remainingAfter = core.reduce((total, option) => total + option.week, 0);
    const futureAfterCore = sum(core, "future");
    const futureAfterAll = final.reduce((total, player) => total + player.futurePoints, 0);
    const finalCost = final.reduce((total, player) => total + player.price, 0);
    const gain = remainingAfter - remainingBefore;
    const finalCounts: Record<Position, number> = { G: 0, D: 0, F: 0 };
    final.forEach((player) => { finalCounts[player.position] += 1; });
    let step = 0;
    let cash = balance;
    const toSuggestion = (option: SlotOption, kind: TransferSuggestion["kind"]): TransferSuggestion => {
      step += 1;
      cash += option.priceOut - option.priceIn;
      return {
        outgoing: option.out,
        incoming: option.player,
        gain: option.week - option.out.pointsWeek1,
        futureGain: option.player.futurePoints - option.out.futurePoints,
        priceDifference: option.player.price - option.out.price,
        kind,
        executeAfter: option.timing.afterDate,
        executeBefore: option.timing.beforeDate,
        step,
        cashAfter: cash,
      };
    };
    const swaps: TransferSuggestion[] = [];
    const prepSwaps: TransferSuggestion[] = [];
    for (const option of ordered.order) {
      if (prep.includes(option)) prepSwaps.push(toSuggestion(option, "prep"));
      else swaps.push(toSuggestion(option, option.timing.afterDate ? "timed" : "now"));
    }
    const usedTransfers = swaps.length + prepSwaps.length;
    const lockedOk = [...swaps, ...prepSwaps].every((swap) => !swap.outgoing.locked && !swap.incoming.locked);
    const checks = [
      { label: "Цель", ok: true, detail: `${weekNumber ? `Неделя ${weekNumber}` : "Текущий тур"}: максимум очков в оставшихся матчах; следующие недели — только при равенстве.` },
      { label: "Очки тура", ok: true, detail: `${earned.toFixed(1).replace(".", ",")} уже набрано + ${remainingAfter.toFixed(1).replace(".", ",")} ожидается в оставшихся матчах.` },
      { label: "Прирост", ok: gain >= -EPSILON, detail: gain >= -EPSILON ? "План не снижает ожидаемые очки текущего тура." : "Обнаружено снижение прогноза — план отклонён." },
      { label: "Бюджет", ok: ordered.minCash >= -EPSILON, detail: `Баланс не уходит в минус ни на одном шаге: минимум ≈ ${Math.round(ordered.minCash)}, после замен ≈ ${Math.round(cash)}.` },
      { label: "Трансферы", ok: usedTransfers <= transfersAvailable, detail: `${swaps.length} основных${prepSwaps.length ? ` + ${prepSwaps.length} на следующую неделю` : ""} из ${transfersAvailable} доступных.` },
      { label: "Позиции", ok: POSITION_ORDER.every((position) => finalCounts[position] === EXPECTED[position]), detail: "2 вратаря · 6 защитников · 9 нападающих." },
      { label: "Клубы", ok: ordered.maxClub <= clubLimit, detail: `Не более ${clubLimit} игроков из одного клуба после каждой замены.` },
      { label: "Блокировки", ok: lockedOk, detail: "Заблокированные Sports.ru игроки не участвуют в обменах." },
      { label: "Поиск", ok: exact, detail: exact ? `Точный бинарный расчёт по ${candidates.length} кандидатам с полными данными.` : "Оптимальность не подтверждена." },
    ];
    const executionNote = !ordered.feasible
      ? "Пошагово выполнить все замены без временного минуса не получается: сначала продайте игроков, освобождающих бюджет, затем покупайте."
      : swaps.some((swap) => swap.executeAfter)
        ? "Часть замен выгоднее делать позже: сначала дождитесь матча уходящего игрока."
        : undefined;
    if (!ordered.feasible) warnings.push(executionNote!);
    const absent = final.filter((player) => (player.absenceStreak ?? 0) >= 2);
    if (absent.length) warnings.push(`Пропускали матчи: ${absent.map((player) => `${player.name} (${player.absenceStreak})`).join(", ")}. Риск учтён в прогнозе, но проверьте новости клуба.`);
    return {
      ready: true,
      swaps,
      prepSwaps,
      prepGain: futureAfterAll - futureAfterCore,
      futureGain: futureAfterCore - futureBefore,
      executionNote,
      baselineWeekPoints: earned + remainingBefore,
      projectedWeekPoints: earned + remainingAfter,
      baselineHorizonPoints: earned + remainingBefore,
      projectedHorizonPoints: earned + remainingAfter,
      gainWeek: gain,
      gainHorizon: gain,
      currentCost,
      finalCost,
      remainingBudget: budget - finalCost,
      transfersUsed: usedTransfers,
      transfersAvailable,
      candidatesAvailable: candidates.length,
      candidatesConsidered: candidates.length,
      candidatePoolTrimmed: false,
      warnings,
      horizonWeeks: 1,
      earnedWeekPoints: earned,
      remainingBefore,
      remainingAfter,
      weekNumber,
      exact,
      checks,
    };
  };

  const keepAll = options.filter((option) => !option.swap);
  if (transfersAvailable === 0 || candidates.length === 0) {
    if (!candidates.length) warnings.push("Сейчас нет доступных кандидатов с полными данными. Замены не рекомендуются.");
    return finish(keepAll, [], true);
  }

  // ---- Binary model.
  const constraints: Model["constraints"] = { transfers: { max: transfersAvailable } };
  owned.forEach((_player, slot) => { constraints[`slot_${slot}`] = { equal: 1 }; });
  candidates.forEach((_player, index) => { constraints[`cand_${index}`] = { max: 1 }; });
  times.forEach((time) => { constraints[`cash_${time}`] = { max: balance }; });
  const clubOwned = new Map<string, number>();
  owned.forEach((player) => clubOwned.set(clubKey(player.club), (clubOwned.get(clubKey(player.club)) ?? 0) + 1));
  const clubCandidates = new Map<string, number>();
  candidates.forEach((player) => clubCandidates.set(clubKey(player.club), (clubCandidates.get(clubKey(player.club)) ?? 0) + 1));
  const bindingClubs = [...new Set([...clubOwned.keys(), ...clubCandidates.keys()])]
    .filter((club) => (clubOwned.get(club) ?? 0) + Math.min(transfersAvailable, clubCandidates.get(club) ?? 0) > clubLimit);
  bindingClubs.forEach((club, clubIndex) => times.forEach((time) => {
    constraints[`club_${clubIndex}_${time}`] = { max: clubLimit - (clubOwned.get(club) ?? 0) };
  }));
  const variables: Model["variables"] = {};
  const binaries: Record<string, 1> = {};
  const candidateIndex = new Map(candidates.map((player, index) => [player.id, index]));
  for (const option of options) {
    const coefficients: Record<string, number> = {
      week: option.week,
      future: option.future,
      cost: option.player.price,
      transfers: option.swap ? 1 : 0,
      [`slot_${option.slot}`]: 1,
    };
    if (option.swap) {
      coefficients[`cand_${candidateIndex.get(option.player.id)}`] = 1;
      times.forEach((time) => {
        if (option.time > time) return;
        coefficients[`cash_${time}`] = option.priceIn - option.priceOut;
        const inClub = bindingClubs.indexOf(clubKey(option.player.club));
        const outClub = bindingClubs.indexOf(clubKey(option.out.club));
        if (inClub !== outClub) {
          if (inClub >= 0) coefficients[`club_${inClub}_${time}`] = (coefficients[`club_${inClub}_${time}`] ?? 0) + 1;
          if (outClub >= 0) coefficients[`club_${outClub}_${time}`] = (coefficients[`club_${outClub}_${time}`] ?? 0) - 1;
        }
      });
    }
    variables[option.variable] = coefficients;
    binaries[option.variable] = 1;
  }
  const model: Model = { optimize: "week", opType: "max", constraints, variables, binaries, options: { timeout: 8000, tolerance: 0 } };

  try {
    const slots = owned.length;
    const first = pickOptions(solve(model), options, slots);
    if (!first) throw new Error("Решение не прошло проверку состава.");
    const bestWeek = sum(first, "week");
    let core = first;
    const noCoreGain = bestWeek <= remainingBefore + EPSILON;
    if (noCoreGain) {
      core = keepAll;
    } else {
      const weekFloor = { week: { min: bestWeek - EPSILON } };
      const fewer = pickOptions(solve(withConstraints(model, weekFloor, "transfers", "min")), options, slots);
      if (fewer) core = fewer;
      const minTransfers = core.filter((option) => option.swap).length;
      const bestFuture = pickOptions(solve(withConstraints(model, { ...weekFloor, transfers: { max: minTransfers } }, "future", "max")), options, slots);
      if (bestFuture && sum(bestFuture, "week") >= bestWeek - 0.00001) {
        core = bestFuture;
        const futureValue = sum(bestFuture, "future");
        const cheaper = pickOptions(solve(withConstraints(model, { ...weekFloor, transfers: { max: minTransfers }, future: { min: futureValue - EPSILON } }, "cost", "min")), options, slots);
        if (cheaper && sum(cheaper, "week") >= bestWeek - 0.00001 && sum(cheaper, "future") >= futureValue - 0.00001) core = cheaper;
      }
    }

    // ---- Optional preparation moves with the remaining transfers.
    let prep: SlotOption[] = [];
    const coreSwaps = core.filter((option) => option.swap);
    const spare = transfersAvailable - coreSwaps.length;
    if (spare > 0) {
      const coreWeek = sum(core, "week");
      const fixedSlots = new Set(coreSwaps.map((option) => option.slot));
      const usedCandidates = new Set(coreSwaps.map((option) => option.player.id));
      const prepVariables: Model["variables"] = {};
      const prepBinaries: Record<string, 1> = {};
      for (const option of options) {
        if (fixedSlots.has(option.slot) && !coreSwaps.includes(option)) continue;
        if (!fixedSlots.has(option.slot) && option.swap && usedCandidates.has(option.player.id)) continue;
        const coefficients = { ...variables[option.variable] };
        coefficients.prepValue = option.future - (option.swap && !fixedSlots.has(option.slot) ? PREP_MIN_GAIN : 0);
        prepVariables[option.variable] = coefficients;
        prepBinaries[option.variable] = 1;
      }
      const prepModel: Model = {
        ...model,
        optimize: "prepValue",
        opType: "max",
        variables: prepVariables,
        binaries: prepBinaries,
        constraints: { ...constraints, week: { min: coreWeek - EPSILON } },
      };
      const prepResult = pickOptions(solve(prepModel), options.filter((option) => prepVariables[option.variable]), slots);
      if (prepResult) {
        const extra = prepResult.filter((option) => option.swap && !fixedSlots.has(option.slot));
        const futureGain = extra.reduce((total, option) => total + option.future - option.out.futurePoints, 0);
        if (extra.length && futureGain >= PREP_MIN_GAIN * extra.length - EPSILON && sum(prepResult, "week") >= coreWeek - 0.00001) prep = extra;
      }
    }
    if (noCoreGain) {
      warnings.push(prep.length
        ? "В этом туре ни одна замена не добавит очков. Ниже — необязательные замены на следующую неделю: текущий прогноз они не снижают."
        : "Ни одна допустимая комбинация не повышает прогноз текущего тура. Не тратьте трансферы ради лимита.");
    }
    const result = finish(core, prep, true);
    const failedChecks = result.checks?.filter((check) => !check.ok) ?? [];
    if (failedChecks.length) return empty(`Контрольная проверка не пройдена: ${failedChecks.map((check) => `${check.label} — ${check.detail}`).join(" ")}`);
    return result;
  } catch (cause) {
    return empty(cause instanceof Error ? cause.message : "Не удалось подтвердить недельный расчёт.");
  }
}
