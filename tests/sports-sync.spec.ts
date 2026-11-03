import { test, expect } from "@playwright/test";
import { parseLegacyRoster, enrichPlayer, parseSportsProfile, buildTeamStrength, estimateAvailability, opponentFactor, type GameResult } from "../src/lib/sports-source";
import { availabilityByWeek, mergeSportsPlayers, planMonth, projectPlayers, type FantasyPlayer, type Fixture, type Position } from "../src/lib/fantasy";
import { bestSwapTiming, recommendTransfers } from "../src/lib/weekly-optimizer";
import { compareCandidatesToRoster } from "../src/lib/candidate-comparison";
import type { SportsSyncData } from "../src/lib/sports-types";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000";
const stamp = "2026-10-26T14:00:00.000Z";
const positions: Position[] = ["G", "G", ...Array<Position>(6).fill("D"), ...Array<Position>(9).fill("F")];

function legacyRows() {
  return positions.map((position, index) => ({
    id: String(80000 + index), now_id: 107, name: `Игрок ${index}`, club: `Клуб ${index % 6}`,
    amplua: position === "G" ? "1" : position === "D" ? "2" : "3",
    price: "1000", points: "1000", season: "1000", delta: "+100", lock: index === 0 ? "1" : "0",
  }));
}

function readyRoster(): FantasyPlayer[] {
  return parseLegacyRoster({ players: legacyRows() }, true, stamp).map((player) => ({
    ...player, locked: false, seasonPoints: 100, gamesPlayed: 10, last5Points: 50, last5Games: 5,
    statsKnown: true, seasonPointsKnown: true, scheduleKnown: true, remainingGamesKnown: true, gamesNextWeek: 2,
  }));
}

test.describe("Candidate-to-roster weekly comparisons", () => {
  const settings = { budget: 17000, clubLimit: 3, transfersAvailable: 5 };

  test("suggests the lowest-scoring eligible teammate and preserves points already earned", () => {
    const roster = readyRoster();
    roster[8] = { ...roster[8], gamesNextWeek: 0, earnedWeekPoints: 12 };
    const candidate: FantasyPlayer = { ...roster[8], id: "candidate-forward", name: "Новый бомбардир", club: "Новый клуб", owned: false, gamesNextWeek: 3, earnedWeekPoints: 0 };
    const comparison = compareCandidatesToRoster([...roster, candidate], settings).get(candidate.id);
    expect(comparison?.status).toBe("improves");
    expect(comparison?.outgoing?.id).toBe(roster[8].id);
    expect(comparison?.outgoingPoints).toBe(0);
    expect(comparison?.outgoingEarnedPoints).toBe(12);
    expect(comparison?.gain).toBeCloseTo(comparison!.candidatePoints! - comparison!.outgoingPoints!);
    expect(comparison?.costAfter).toBe(17000);
    expect(comparison!.candidatePoints).toBeGreaterThan(comparison!.outgoingPoints!);
  });

  test("never pairs different positions or sells a locked player", () => {
    const roster = readyRoster();
    roster[0] = { ...roster[0], locked: true, gamesNextWeek: 0 };
    const goalie: FantasyPlayer = { ...roster[1], id: "new-goalie", name: "Вратарь-кандидат", club: "Новый клуб", owned: false, gamesNextWeek: 4 };
    const comparison = compareCandidatesToRoster([...roster, goalie], settings).get(goalie.id);
    expect(comparison?.outgoing?.position).toBe("G");
    expect(comparison?.outgoing?.id).toBe(roster[1].id);
    roster[1] = { ...roster[1], locked: true };
    expect(compareCandidatesToRoster([...roster, goalie], settings).get(goalie.id)?.status).toBe("no-position");
  });

  test("requires enough budget for a single purchase", () => {
    const roster = readyRoster();
    const expensive: FantasyPlayer = { ...roster[8], id: "expensive", name: "Дорогой кандидат", club: "Новый клуб", owned: false, price: 1800 };
    const comparison = compareCandidatesToRoster([...roster, expensive], settings).get(expensive.id);
    expect(comparison?.status).toBe("no-budget");
    expect(comparison?.outgoing).toBeNull();
    expect(comparison?.candidatePoints).not.toBeNull();
  });

  test("blocks club limit unless the replaced player belongs to the candidate's club", () => {
    const roster = readyRoster();
    const candidate: FantasyPlayer = { ...roster[12], id: "same-club", name: "Ещё игрок клуба 0", club: "Клуб 0", owned: false, gamesNextWeek: 5 };
    roster[12] = { ...roster[12], locked: true };
    expect(compareCandidatesToRoster([...roster, candidate], settings).get(candidate.id)?.status).toBe("club-limit");
    roster[12] = { ...roster[12], locked: false };
    expect(compareCandidatesToRoster([...roster, candidate], settings).get(candidate.id)?.outgoing?.id).toBe(roster[12].id);
  });

  test("explains no gain, missing statistics, lock, zero transfers and stale data", () => {
    const roster = readyRoster();
    const weak: FantasyPlayer = { ...roster[8], id: "weak", name: "Слабый кандидат", club: "Новый клуб", owned: false, gamesNextWeek: 0 };
    const noGain = compareCandidatesToRoster([...roster, weak], settings).get(weak.id);
    expect(noGain?.status).toBe("no-gain");
    expect(noGain?.outgoing).not.toBeNull();
    expect(noGain!.gain).toBeLessThan(0);
    const locked = { ...weak, locked: true, gamesNextWeek: 4 };
    const blockedComparison = compareCandidatesToRoster([...roster, locked], settings).get(weak.id);
    expect(blockedComparison?.status).toBe("locked");
    expect(blockedComparison?.outgoing).not.toBeNull();
    const missing = { ...weak, priceKnown: false };
    expect(compareCandidatesToRoster([...roster, missing], settings).get(weak.id)?.status).toBe("missing-data");
    const noTransfers = compareCandidatesToRoster([...roster, { ...weak, gamesNextWeek: 4 }], { ...settings, transfersAvailable: 0 }).get(weak.id);
    expect(noTransfers?.status).toBe("no-transfers");
    expect(noTransfers?.outgoing).not.toBeNull();
    expect(noTransfers?.gain).toBeGreaterThan(0);
    expect(compareCandidatesToRoster([...roster, weak], settings, false).get(weak.id)?.status).toBe("no-schedule");
  });
});

test.describe("Sports.ru source validation", () => {
  test("reads the profile «Трансферы» value as transfers LEFT this week", () => {
    const page = (left: number) => `<html><head><title>Царь Леонидс: профиль</title></head><body><script>$.Sports.Registry.set('tournament_id', 107).set('team_id', 587717)</script>
      <table class="profile-table"><tr><th>Текущая неделя</th><td>неделя 9</td></tr></table>
      <table class="profile-table"><tr><th>Стоимость команды</th><td>21902</td></tr><tr><th>Баланс</th><td>473</td></tr><tr><th>Трансферы</th><td>${left}</td></tr></table></body></html>`;
    const full = parseSportsProfile(page(5), "587717");
    expect(full.transfersLeft).toBe(5);
    expect(full.transfersUsed).toBe(0);
    const spent = parseSportsProfile(page(0), "587717");
    expect(spent.transfersLeft).toBe(0);
    expect(spent.transfersUsed).toBe(5);
    expect(parseSportsProfile(page(2), "587717").transfersLeft).toBe(2);
  });

  test("validates 17 positions and never treats legacy price as fantasy points", () => {
    const roster = parseLegacyRoster({ players: legacyRows() }, true, stamp);
    expect(roster).toHaveLength(17);
    expect(roster.filter((p) => p.position === "G")).toHaveLength(2);
    expect(roster.filter((p) => p.position === "D")).toHaveLength(6);
    expect(roster.filter((p) => p.position === "F")).toHaveLength(9);
    expect(roster[0].locked).toBe(true);
    expect(roster[0].seasonPoints).toBe(0);
    expect(roster[0].statsKnown).toBe(false);
    expect(roster[0].price).toBe(1000);
  });

  test("rejects incomplete, duplicate and wrong-tournament rosters", () => {
    expect(() => parseLegacyRoster({ players: legacyRows().slice(1) }, true, stamp)).toThrow();
    const duplicate = legacyRows(); duplicate[1].id = duplicate[0].id;
    expect(() => parseLegacyRoster({ players: duplicate }, true, stamp)).toThrow();
    const wrongTournament = legacyRows(); wrongTournament[0].now_id = 123;
    expect(() => parseLegacyRoster({ players: wrongTournament }, true, stamp)).toThrow();
    expect(() => parseLegacyRoster({ error: "unavailable" }, true, stamp)).toThrow();
  });

  test("reads scored matches, form and future weeks rather than roster prices", () => {
    const player = parseLegacyRoster({ players: legacyRows() }, true, stamp)[0];
    const html = `<div class="short-info"><h1>Иван Игрок</h1></div>
      <table class="profile-table"><tr><th>Команда</th><td><a href="https://www.sports.ru/hockey/club/example/">Клуб 0</a></td></tr><tr><th>Амплуа</th><td>Вратарь</td></tr><tr><th>В среднем очков за матч</th><td>10.5</td></tr></table>
      <div id="stat"><select id="slt"><option selected>2026/2027</option></select><table class="stat-table"><thead><tr><td>Дата</td><td>МИН</td><td>О</td><td>С</td></tr></thead><tbody>
      <tr><td>26.10.2026</td><td>60:00</td><td>14</td><td>1000</td></tr><tr><td>24.10.2026</td><td>00:00</td><td>0</td><td>986</td></tr><tr><td>20.10.2026</td><td>59:58</td><td>7</td><td>986</td></tr></tbody></table></div>
      <div id="calendar"><table class="stat-table"><thead><tr><td>Дата</td><td>Соперник</td><td>Счет</td></tr></thead><tbody>
      <tr><td>26.10.2026 | неделя 8</td><td>Соперник</td><td>3 : 2</td></tr><tr><td>28.10.2026 | неделя 8</td><td>Соперник</td><td>:</td></tr><tr><td>29.10.2026 | неделя 8</td><td>Соперник</td><td>3 : 2</td></tr><tr><td>05.11.2026 | неделя 9</td><td>Соперник</td><td>:</td></tr><tr><td>13.11.2026 | неделя 10</td><td>Соперник</td><td>:</td></tr></tbody></table></div>`;
    const enriched = enrichPlayer(html, player, 8, stamp);
    expect(enriched.seasonPoints).toBe(21);
    expect(enriched.gamesPlayed).toBe(2);
    expect(enriched.last5Points).toBe(21);
    expect(enriched.last5Games).toBe(2);
    expect(enriched.earnedWeekPoints).toBe(14);
    expect(enriched.weekGamesPlayed).toBe(1);
    expect(enriched.remainingGamesKnown).toBe(true);
    expect(enriched.gamesNextWeek).toBe(1);
    expect(enriched.gamesWeek2).toBe(1);
    expect(enriched.gamesWeek3).toBe(1);
    expect(enriched.availability).toBeCloseTo(2 / 3);
    expect(enriched.locked).toBe(true);
    expect(enriched.price).toBe(1000);
  });

  test("authoritative sync removes sold players and keeps manual candidates without duplicates", () => {
    const roster = readyRoster();
    const oldOwned = { ...roster[0], id: "old", sportsId: "90000", name: "Проданный игрок" };
    const manual = { ...roster[1], id: "manual", sportsId: undefined, name: "Мой кандидат", owned: false };
    const staleCopy = { ...roster[0], price: 200, owned: false };
    const merged = mergeSportsPlayers([oldOwned, manual, staleCopy], roster, []);
    expect(merged.filter((p) => p.owned)).toHaveLength(17);
    expect(merged).toHaveLength(18);
    expect(merged.some((p) => p.id === "old")).toBe(false);
    expect(merged.find((p) => p.id === roster[0].id)?.price).toBe(1000);
  });

  test("month plan prefers a player who keeps scoring over a one-week spike", () => {
    const roster = readyRoster().map((player, index) => ({
      ...player,
      gamesNextWeek: 1,
      gamesWeek2: 1,
      gamesWeek3: 1,
      gamesWeek4: 1,
      name: index === 16 ? "Слабый" : player.name,
    }));
    const durable = { ...roster[16], id: "durable", name: "Долгий", club: "Новый клуб", owned: false, gamesNextWeek: 2, gamesWeek2: 2, gamesWeek3: 2, gamesWeek4: 2 };
    const spike = { ...roster[16], id: "spike", name: "Короткий", club: "Другой клуб", owned: false, gamesNextWeek: 3, gamesWeek2: 0, gamesWeek3: 0, gamesWeek4: 0 };
    const plan = planMonth([...roster, durable, spike], { budget: 17000, transfersAvailable: 5, clubLimit: 3, horizonWeeks: 1 }, 8);
    expect(plan.ready).toBe(true);
    expect(plan.weeks).toHaveLength(4);
    expect(plan.gainMonth).toBeGreaterThan(0);
    expect(plan.weeks.flatMap((week) => week.swaps).map((swap) => swap.incoming.name)).toContain("Долгий");
    const spikeMove = plan.weeks.flatMap((week) => week.swaps).find((swap) => swap.incoming.name === "Короткий");
    if (spikeMove) expect(spikeMove.leavesInWeek).not.toBeNull();
    expect(plan.weeks.every((week) => week.transfersUsed <= 5)).toBe(true);
  });

  test("month sequence can rent a huge week and sell that player later", () => {
    const roster = readyRoster().map((player, index) => ({
      ...player,
      locked: index === 16,
      gamesNextWeek: 1,
      gamesWeek2: 1,
      gamesWeek3: 1,
      gamesWeek4: 1,
      name: index === 16 ? "Слабый" : player.name,
    }));
    const durable = { ...roster[16], id: "durable", name: "Долгий", club: "Новый клуб", owned: false, locked: false, gamesNextWeek: 2, gamesWeek2: 2, gamesWeek3: 2, gamesWeek4: 2 };
    const spike = { ...roster[16], id: "spike", name: "Вспышка", club: "Ещё клуб", owned: false, locked: false, gamesNextWeek: 8, gamesWeek2: 0, gamesWeek3: 0, gamesWeek4: 0 };
    const plan = planMonth([...roster, durable, spike], { budget: 17000, transfersAvailable: 5, clubLimit: 3, horizonWeeks: 1 }, 8);
    expect(plan.ready).toBe(true);
    expect(plan.weeks[0].swaps.some((swap) => swap.outgoing.name === "Слабый")).toBe(false);
    expect(plan.weeks.flatMap((week) => week.swaps).some((swap) => swap.incoming.name === "Вспышка")).toBe(true);
    expect(plan.gainMonth).toBeGreaterThanOrEqual(0);
    expect(plan.weeks.every((week) => week.transfersUsed <= week.transfersAvailable)).toBe(true);
    const spikeMove = plan.weeks.flatMap((week) => week.swaps).find((swap) => swap.incoming.name === "Вспышка");
    expect(spikeMove?.futureGames).toBe(0);
    expect(spikeMove?.leavesInWeek).not.toBeNull();
  });

  test("weekly optimizer ignores all future weeks even if a future-only player looks excellent", () => {
    const roster = readyRoster();
    const futureStar = { ...roster[0], id: "future", name: "Только будущий", club: "Будущий клуб", owned: false, gamesNextWeek: 0, gamesWeek2: 9, gamesWeek3: 9, gamesWeek4: 9, seasonPoints: 1000 };
    const result = recommendTransfers([...roster, futureStar], { budget: 17000, transfersAvailable: 5, clubLimit: 3, horizonWeeks: 3 });
    expect(result.ready).toBe(true);
    expect(result.horizonWeeks).toBe(1);
    expect(result.swaps.some((swap) => swap.incoming.id === "future")).toBe(false);
    expect(result.gainWeek).toBeGreaterThanOrEqual(0);
    expect(result.exact).toBe(true);
  });

  test("weekly forecast keeps already earned tour points and forecasts only remaining games", () => {
    const roster = readyRoster().map((player, index) => ({ ...player, earnedWeekPoints: index === 0 ? 30 : 0, gamesNextWeek: 1 }));
    const candidate = { ...roster[1], id: "candidate", name: "Кандидат", club: "Новый клуб", owned: false, seasonPoints: 300, gamesNextWeek: 1 };
    const result = recommendTransfers([...roster, candidate], { budget: 17000, transfersAvailable: 1, clubLimit: 3, horizonWeeks: 1 }, { weekNumber: 8, bankedTeamPoints: 30 });
    expect(result.ready).toBe(true);
    expect(result.earnedWeekPoints).toBe(30);
    expect(result.baselineWeekPoints).toBeCloseTo(30 + result.remainingBefore!);
    expect(result.projectedWeekPoints).toBeCloseTo(30 + result.remainingAfter!);
    expect(result.gainWeek).toBeCloseTo(result.remainingAfter! - result.remainingBefore!);
    expect(result.weekNumber).toBe(8);
  });

  test("weekly optimizer never recommends a negative-gain plan and can return zero transfers", () => {
    const roster = readyRoster();
    const worse = { ...roster[0], id: "worse", owned: false, seasonPoints: 1, last5Points: 1, price: 2000 };
    const result = recommendTransfers([...roster, worse], { budget: 18000, transfersAvailable: 5, clubLimit: 3, horizonWeeks: 1 });
    expect(result.ready).toBe(true);
    expect(result.swaps).toHaveLength(0);
    expect(result.gainWeek).toBe(0);
  });

  test("exact weekly result matches an independent brute-force optimum", () => {
    const roster = readyRoster().map((player, index) => ({ ...player, locked: index === 0, seasonPoints: 70 + index * 7, gamesNextWeek: 1 + (index % 3), price: 900 + index * 20 }));
    const candidates = Array.from({ length: 5 }, (_, index) => ({ ...roster[index + 2], id: `c-${index}`, name: `Кандидат ${index}`, club: `Новый клуб ${index}`, owned: false, locked: false, seasonPoints: 130 + index * 31, gamesNextWeek: 1 + (index % 3), price: 850 + index * 45 }));
    const settings = { budget: 18500, transfersAvailable: 3, clubLimit: 3, horizonWeeks: 1 as const };
    const result = recommendTransfers([...roster, ...candidates], settings);
    const projected = projectPlayers([...roster, ...candidates], 1);
    const ownedIds = new Set(roster.map((player) => player.id));
    let best = -Infinity;
    const visit = (start: number, picked: typeof projected) => {
      if (picked.length === 17) {
        if (picked.some((player) => player.locked && player.owned) !== true && !picked.some((player) => player.id === roster[0].id)) return;
        const counts = { G: 0, D: 0, F: 0 };
        const clubs = new Map<string, number>();
        let cost = 0;
        let transfers = 0;
        let score = 0;
        for (const player of picked) {
          counts[player.position] += 1;
          clubs.set(player.club, (clubs.get(player.club) ?? 0) + 1);
          cost += player.price;
          if (!ownedIds.has(player.id)) transfers += 1;
          score += player.pointsWeek1;
        }
        if (counts.G === 2 && counts.D === 6 && counts.F === 9 && cost <= settings.budget && transfers <= settings.transfersAvailable && Math.max(...clubs.values()) <= 3) best = Math.max(best, score);
        return;
      }
      for (let index = start; index <= projected.length - (17 - picked.length); index += 1) visit(index + 1, [...picked, projected[index]]);
    };
    visit(0, []);
    expect(result.ready).toBe(true);
    expect(result.exact).toBe(true);
    expect(result.remainingAfter).toBeCloseTo(best, 5);
  });

  test("optimizer respects locked players, cash, positions and five-transfer limit", () => {
    const roster = readyRoster(); roster[0].locked = true;
    const candidates = positions.slice(0, 12).map((position, index) => ({
      ...roster[index], id: `candidate-${index}`, sportsId: undefined, owned: false,
      name: `Кандидат ${index}`, club: `Новый клуб ${index}`, position,
      price: 900, seasonPoints: 220, last5Points: 110, locked: index === 2,
    }));
    const result = recommendTransfers([...roster, ...candidates], { budget: 17500, transfersAvailable: 5, clubLimit: 3, horizonWeeks: 1 });
    expect(result.ready).toBe(true);
    expect(result.transfersUsed).toBeLessThanOrEqual(5);
    expect(result.transfersUsed).toBeGreaterThan(0);
    expect(result.finalCost).toBeLessThanOrEqual(17500);
    expect(result.gainHorizon).toBeGreaterThanOrEqual(0);
    for (const swap of result.swaps) {
      expect(swap.outgoing.locked).toBe(false);
      expect(swap.incoming.locked).toBe(false);
      expect(swap.outgoing.position).toBe(swap.incoming.position);
    }
    const sold = new Set(result.swaps.map((swap) => swap.outgoing.id));
    const final = [...roster.filter((p) => !sold.has(p.id)), ...result.swaps.map((s) => s.incoming)];
    expect(final).toHaveLength(17);
    const clubs = new Map<string, number>();
    for (const player of final) clubs.set(player.club, (clubs.get(player.club) ?? 0) + 1);
    expect(Math.max(...clubs.values())).toBeLessThanOrEqual(3);
  });
});

test.describe("Forecast model and transfer timing", () => {
  const fixture = (date: string): Fixture => ({ date, week: 8, opponent: "Соперник", home: true, factor: 1 });
  const timedRoster = (date: string) => readyRoster().map((player) => ({ ...player, weekNumber: 8, gamesNextWeek: 1, fixtures: [fixture(date)] }));

  test("availability falls with missed games and recovers gradually over the next weeks", () => {
    const healthy = estimateAvailability("F", [1, 1, 1, 1, 1, 1]);
    expect(healthy.streak).toBe(0);
    expect(healthy.availability).toBeGreaterThan(0.95);
    expect(healthy.note).toBeUndefined();
    const injured = estimateAvailability("D", [0, 0, 0, 1, 1, 1, 1, 1]);
    expect(injured.streak).toBe(3);
    expect(injured.availability).toBeLessThan(0.5);
    expect(injured.note).toContain("3 последних матча");
    const weeks = availabilityByWeek({ position: "D", availability: injured.availability, absenceStreak: 3 });
    expect(weeks[0]).toBeCloseTo(injured.availability);
    for (let week = 1; week < weeks.length; week += 1) expect(weeks[week]).toBeGreaterThan(weeks[week - 1]);
    expect(weeks[3]).toBeLessThan(1);
    const rotating = estimateAvailability("G", [1, 0, 1, 1, 0, 1, 1, 0, 1]);
    expect(rotating.availability).toBeGreaterThan(0.5);
    expect(rotating.availability).toBeLessThan(0.8);
  });

  test("opponent strength lifts skaters against leaky defences and stays within bounds", () => {
    const results: GameResult[] = [];
    for (let day = 1; day <= 10; day += 1) {
      const date = `2026-10-${String(day).padStart(2, "0")}`;
      results.push({ date, home: "Снайперы", away: "Дырявые", homeGoals: 6, awayGoals: 1 });
      results.push({ date, home: "Стена", away: "Середняк", homeGoals: 2, awayGoals: 1 });
    }
    const strength = buildTeamStrength(results);
    expect(opponentFactor("F", "Дырявые", strength)).toBeGreaterThan(1.05);
    expect(opponentFactor("D", "Дырявые", strength)).toBeGreaterThan(1.05);
    expect(opponentFactor("F", "Стена", strength)).toBeLessThan(1);
    expect(opponentFactor("G", "Снайперы", strength)).toBeLessThan(1);
    expect(opponentFactor("F", "Неизвестный клуб", strength)).toBe(1);
    for (const team of ["Снайперы", "Дырявые", "Стена", "Середняк"]) {
      for (const position of ["G", "D", "F"] as Position[]) {
        const factor = opponentFactor(position, team, strength);
        expect(factor).toBeGreaterThanOrEqual(0.8);
        expect(factor).toBeLessThanOrEqual(1.2);
      }
    }
  });

  test("a swap waits for the outgoing player's game when the newcomer plays later", () => {
    const roster = timedRoster("2026-10-27");
    const candidate: FantasyPlayer = { ...roster[16], id: "late", sportsId: undefined, name: "Поздний", club: "Новый клуб", owned: false, fixtures: [fixture("2026-10-29")] };
    const projected = projectPlayers([...roster, candidate], 1);
    const timing = bestSwapTiming(projected[16], projected[17]);
    expect(timing.afterDate).toBe("2026-10-27");
    expect(timing.beforeDate).toBe("2026-10-29");
    expect(timing.points).toBeCloseTo(projected[16].pointsWeek1 + projected[17].pointsWeek1);
    const result = recommendTransfers([...roster, candidate], { budget: 17000, transfersAvailable: 1, clubLimit: 3, horizonWeeks: 1 }, { weekNumber: 8 });
    expect(result.ready).toBe(true);
    expect(result.swaps).toHaveLength(1);
    expect(result.swaps[0].kind).toBe("timed");
    expect(result.swaps[0].executeAfter).toBe("2026-10-27");
    expect(result.swaps[0].executeBefore).toBe("2026-10-29");
    expect(result.gainWeek).toBeCloseTo(projected[17].pointsWeek1);
    expect(result.checks?.every((check) => check.ok)).toBe(true);
  });

  test("spare transfers become optional preparation moves that keep this week's forecast", () => {
    const roster = readyRoster().map((player, index) => ({ ...player, gamesNextWeek: index === 16 ? 0 : 1, gamesWeek2: index === 16 ? 0 : 1, gamesWeek3: 1, gamesWeek4: 1 }));
    const nextWeekStar: FantasyPlayer = { ...roster[16], id: "next", sportsId: undefined, name: "Следующая неделя", club: "Новый клуб", owned: false, gamesNextWeek: 0, gamesWeek2: 4 };
    const result = recommendTransfers([...roster, nextWeekStar], { budget: 17000, transfersAvailable: 2, clubLimit: 3, horizonWeeks: 1 });
    expect(result.ready).toBe(true);
    expect(result.swaps).toHaveLength(0);
    expect(result.gainWeek).toBe(0);
    expect(result.prepSwaps?.map((swap) => swap.incoming.id)).toEqual(["next"]);
    expect(result.prepSwaps?.[0].outgoing.id).toBe(roster[16].id);
    expect(result.prepSwaps?.[0].kind).toBe("prep");
    expect(result.prepGain).toBeGreaterThan(1);
    expect(result.transfersUsed).toBe(1);
  });

  test("transfers are ordered so the balance never goes below zero", () => {
    const roster = readyRoster().map((player, index) => ({ ...player, price: index === 2 ? 1400 : 1000, seasonPoints: index === 2 ? 50 : 100 }));
    const pricey: FantasyPlayer = { ...roster[3], id: "pricey", sportsId: undefined, name: "Дорогой защитник", club: "Клуб А", owned: false, price: 1300, seasonPoints: 300 };
    const bargain: FantasyPlayer = { ...roster[3], id: "bargain", sportsId: undefined, name: "Недорогой защитник", club: "Клуб Б", owned: false, price: 1000, seasonPoints: 200 };
    const result = recommendTransfers([...roster, pricey, bargain], { budget: 17400, transfersAvailable: 2, clubLimit: 3, horizonWeeks: 1 });
    expect(result.ready).toBe(true);
    expect(result.swaps).toHaveLength(2);
    expect(result.swaps.map((swap) => swap.step)).toEqual([1, 2]);
    for (const swap of result.swaps) expect(swap.cashAfter!).toBeGreaterThanOrEqual(-0.000001);
    expect(result.swaps[1].cashAfter).toBeCloseTo(100);
    expect(result.checks?.find((check) => check.label === "Бюджет")?.ok).toBe(true);
  });

  test("candidate comparison finds the teammate whose game comes first", () => {
    const roster = timedRoster("2026-10-30");
    roster[16] = { ...roster[16], fixtures: [fixture("2026-10-27")] };
    const candidate: FantasyPlayer = { ...roster[15], id: "late", sportsId: undefined, name: "Поздний", club: "Новый клуб", owned: false, fixtures: [fixture("2026-10-29")] };
    const comparison = compareCandidatesToRoster([...roster, candidate], { budget: 17000, clubLimit: 3, transfersAvailable: 5 }).get(candidate.id);
    expect(comparison?.status).toBe("improves");
    expect(comparison?.outgoing?.id).toBe(roster[16].id);
    expect(comparison?.timing?.afterDate).toBe("2026-10-27");
    expect(comparison?.gain).toBeCloseTo(comparison!.candidatePoints!);
  });

  test("month plan stays fast, legal and cash-positive with a large candidate pool", () => {
    const roster = readyRoster().map((player) => ({ ...player, gamesWeek2: 2, gamesWeek3: 2, gamesWeek4: 2 }));
    const pool: FantasyPlayer[] = Array.from({ length: 90 }, (_, index) => ({
      ...roster[index % 17], id: `pool-${index}`, sportsId: undefined, name: `Игрок пула ${index}`, club: `Клуб пула ${index % 15}`,
      owned: false, locked: false, seasonPoints: 60 + ((index * 37) % 120), price: 800 + ((index * 53) % 700),
      gamesNextWeek: 1 + (index % 3), gamesWeek2: index % 4, gamesWeek3: 1 + (index % 2), gamesWeek4: 2,
    }));
    const started = Date.now();
    const plan = planMonth([...roster, ...pool], { budget: 17000, transfersAvailable: 5, clubLimit: 3, horizonWeeks: 1 }, 8);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(plan.ready).toBe(true);
    expect(plan.weeks).toHaveLength(4);
    expect(plan.gainMonth).toBeGreaterThan(0);
    let current = roster.map((player) => player.id);
    const byId = new Map([...roster, ...pool].map((player) => [player.id, player]));
    for (const week of plan.weeks) {
      expect(week.transfersUsed).toBeLessThanOrEqual(5);
      expect(week.remainingBudget).toBeGreaterThanOrEqual(-0.001);
      const sold = new Set(week.swaps.map((swap) => swap.outgoing.id));
      current = [...current.filter((id) => !sold.has(id)), ...week.swaps.map((swap) => swap.incoming.id)];
      expect(new Set(current).size).toBe(17);
      const clubs = new Map<string, number>();
      const counts = { G: 0, D: 0, F: 0 };
      for (const id of current) {
        const player = byId.get(id)!;
        counts[player.position] += 1;
        clubs.set(player.club, (clubs.get(player.club) ?? 0) + 1);
      }
      expect(counts).toEqual({ G: 2, D: 6, F: 9 });
      expect(Math.max(...clubs.values())).toBeLessThanOrEqual(3);
      for (const swap of week.swaps) expect(swap.outgoing.position).toBe(swap.incoming.position);
    }
  });
});

test.describe("Live automatic connection", () => {
  test.setTimeout(120_000);

  test("API returns the real team and reuses its database snapshot", async ({ request }) => {
    const response = await request.get(`${BASE}/api/sports?teamId=587717`, { timeout: 100_000 });
    expect(response.ok()).toBe(true);
    const data = await response.json() as SportsSyncData;
    expect(data.profile.teamName).toBe("Царь Леонидс");
    expect(data.roster).toHaveLength(17);
    expect(data.roster.every((player) => player.owned && player.sportsId && player.priceKnown)).toBe(true);
    expect(data.roster.reduce((sum, player) => sum + player.price, 0)).toBe(data.profile.teamValue);
    const second = await request.get(`${BASE}/api/sports?teamId=587717`);
    expect((await second.json()).cached).toBe(true);
    const invalid = await request.get(`${BASE}/api/sports?teamId=https://example.com`);
    expect(invalid.status()).toBe(400);
  });

  test("fresh browser automatically shows 17 players, computes swaps and survives reload", async ({ page }) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(BASE);
    await expect(page.locator(".team-connection-synced")).toBeVisible({ timeout: 100_000 });
    await expect(page.locator(".synced-roster-preview button")).toHaveCount(17);
    await expect(page.getByText("Для точного плана нужен ваш состав", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: "/tmp/khl-auto-overview.png", fullPage: true });
    await page.getByRole("button", { name: "Мой состав", exact: true }).click();
    await expect(page.locator(".players-table tbody tr")).toHaveCount(17);
    await expect(page.locator(".roster-view-tabs .selected")).toContainText("Моя команда");
    await page.screenshot({ path: "/tmp/khl-auto-roster.png", fullPage: true });
    await page.getByRole("button", { name: "Обзор и расчёт", exact: true }).click();
    await expect(page.locator(".horizon-selector")).toHaveCount(0);
    await expect(page.locator(".month-experiment")).not.toHaveAttribute("open", "");
    await page.getByRole("button", { name: "Рассчитать неделю", exact: true }).first().click();
    await expect(page.locator(".recommendation-card")).toBeVisible({ timeout: 30_000 });
    expect(await page.locator(".swap-row").count()).toBeLessThanOrEqual(5);
    await expect(page.locator(".weekly-checks")).toBeVisible();
    await expect(page.locator(".weekly-check-bad")).toHaveCount(0);
    await expect(page.locator(".recommendation-card")).toContainText("Только текущая неделя");
    await page.reload();
    await expect(page.locator(".team-connection-synced")).toBeVisible({ timeout: 100_000 });
    await page.getByRole("button", { name: "Мой состав", exact: true }).click();
    await expect(page.locator(".players-table tbody tr")).toHaveCount(17);
    expect(browserErrors).toEqual([]);
  });

  test("candidate list shows the suggested teammate, both forecasts and already earned points", async ({ page, request }) => {
    const response = await request.get(`${BASE}/api/sports?teamId=587717`, { timeout: 100_000 });
    const data = await response.json() as SportsSyncData;
    const ownedForward = data.roster.find((player) => player.position === "F" && !player.locked);
    const candidateForward = data.candidates.find((player) => player.position === "F" && player.statsKnown);
    expect(ownedForward).toBeDefined();
    expect(candidateForward).toBeDefined();
    const candidate: FantasyPlayer = {
      ...candidateForward!, id: "test-comparison-forward", sportsId: undefined,
      name: "Сравниваемый кандидат", club: "Новый независимый клуб", owned: false,
      price: ownedForward!.price, priceKnown: true, statsKnown: true, scheduleKnown: true,
      locked: false, gamesNextWeek: 4, seasonPoints: 300, gamesPlayed: 20,
      last5Points: 65, last5Games: 5, availability: 1, remainingGamesKnown: true,
    };
    const snapshot: SportsSyncData = {
      ...data,
      profile: { ...data.profile, transfersLeft: 5, transfersUsed: 0 },
      roster: data.roster.map((player) => player.id === ownedForward!.id
        ? { ...player, gamesNextWeek: 0, earnedWeekPoints: 7, locked: false }
        : player.position === "F" ? { ...player, gamesNextWeek: 5 } : player),
      candidates: [candidate, ...data.candidates],
    };
    await page.route("**/api/sports?**", (route) => route.fulfill({ json: snapshot }));
    await page.goto(BASE);
    await expect(page.locator(".team-connection-synced")).toBeVisible();
    await page.getByRole("button", { name: /Состав и пул/ }).click();
    await page.locator(".roster-view-tabs button").filter({ hasText: "Кандидаты" }).click();
    const row = page.locator(".players-table-comparisons tbody tr").filter({ hasText: candidate.name });
    await expect(row).toBeVisible();
    await expect(row.locator(".candidate-match-positive")).toBeVisible();
    await expect(row.locator(".candidate-match-player")).toContainText(ownedForward!.name);
    await expect(row).toContainText("Мой игрок ещё");
    await expect(row).toContainText("Кандидат ещё");
    await expect(row).toContainText("Мой уже набрал 7,0");
    await expect(row.locator(".candidate-match-gain")).toContainText("+");
    await expect(page.locator(".candidate-comparison-note")).toContainText("проверка одной замены");
  });

  test("when transfers are spent, candidates still show a comparison but not an actionable trade", async ({ page, request }) => {
    const response = await request.get(`${BASE}/api/sports?teamId=587717`, { timeout: 100_000 });
    const data = await response.json() as SportsSyncData;
    const ownedForward = data.roster.find((player) => player.position === "F" && !player.locked);
    const candidateForward = data.candidates.find((player) => player.position === "F" && player.statsKnown);
    expect(ownedForward).toBeDefined();
    expect(candidateForward).toBeDefined();
    const candidate: FantasyPlayer = {
      ...candidateForward!, id: "hypothetical-forward", sportsId: undefined, owned: false,
      name: "Гипотетический кандидат", club: "Тестовый независимый клуб",
      price: ownedForward!.price, priceKnown: true, statsKnown: true, scheduleKnown: true,
      locked: false, gamesNextWeek: 5, seasonPoints: 300, gamesPlayed: 20,
      last5Points: 70, last5Games: 5, availability: 1, remainingGamesKnown: true,
    };
    const snapshot: SportsSyncData = {
      ...data,
      profile: { ...data.profile, transfersLeft: 0, transfersUsed: 5 },
      roster: data.roster.map((player) => player.id === ownedForward!.id
        ? { ...player, gamesNextWeek: 0, earnedWeekPoints: 9, locked: false }
        : player),
      candidates: [candidate, ...data.candidates],
    };
    await page.route("**/api/sports?**", (route) => route.fulfill({ json: snapshot }));
    await page.goto(BASE);
    await expect(page.locator(".team-connection-synced")).toBeVisible();
    await page.getByRole("button", { name: /Состав и пул/ }).click();
    await page.locator(".roster-view-tabs button").filter({ hasText: "Кандидаты" }).click();
    const row = page.locator(".players-table-comparisons tbody tr").filter({ hasText: candidate.name });
    await expect(row.locator(".candidate-match-neutral")).toBeVisible();
    await expect(row.locator(".candidate-match-player")).toContainText(ownedForward!.name);
    await expect(row).toContainText("Мой уже набрал 9,0");
    await expect(row).toContainText("трансферы закончились");
    await expect(row.locator(".candidate-match-positive")).toHaveCount(0);
  });

  test("mobile candidate cards show an owned-player comparison without horizontal scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE);
    await expect(page.locator(".team-connection-synced")).toBeVisible({ timeout: 100_000 });
    await page.getByRole("button", { name: /Состав и пул/ }).click();
    await page.locator(".roster-view-tabs button").filter({ hasText: "Кандидаты" }).click();
    await expect(page.locator(".candidate-mobile-list")).toBeVisible();
    expect(await page.locator(".candidate-mobile-card").count()).toBeGreaterThan(0);
    await expect(page.locator(".candidate-desktop-table")).toBeHidden();
    await expect(page.locator(".candidate-mobile-card").first()).toContainText("Прогноз кандидата");
    await expect(page.locator(".candidate-mobile-card").first().locator(".candidate-match, .candidate-match-empty")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test("refresh replaces actual membership, and a later network failure does not erase the roster", async ({ page, request }) => {
    const response = await request.get(`${BASE}/api/sports?teamId=587717`, { timeout: 100_000 });
    let snapshot = await response.json() as SportsSyncData;
    let fail = false;
    await page.route("**/api/sports?**", async (route) => {
      await route.fulfill(fail ? { status: 502, json: { error: "Тест: источник временно недоступен" } } : { json: snapshot });
    });
    await page.goto(BASE);
    await expect(page.locator(".team-connection-synced")).toBeVisible();
    const outgoing = snapshot.roster[0];
    const incoming = snapshot.candidates.find((p) => p.position === outgoing.position)!;
    expect(incoming).toBeTruthy();
    snapshot = {
      ...snapshot,
      fetchedAt: new Date(Date.now() + 1000).toISOString(),
      roster: snapshot.roster.map((player) => player.id === outgoing.id ? { ...incoming, owned: true } : player),
      candidates: [...snapshot.candidates.filter((p) => p.id !== incoming.id), { ...outgoing, owned: false }],
    };
    await page.getByRole("button", { name: "Обновить состав", exact: true }).click();
    await expect(page.locator(".team-connection-synced")).toBeVisible();
    await page.getByRole("button", { name: "Мой состав", exact: true }).click();
    await expect(page.locator(".players-table tbody tr")).toHaveCount(17);
    await expect(page.locator(".players-table").getByText(incoming.name, { exact: true })).toBeVisible();
    await expect(page.locator(".players-table").getByText(outgoing.name, { exact: true })).toHaveCount(0);
    fail = true;
    await page.getByRole("button", { name: "Обновить состав", exact: true }).first().click();
    await expect(page.locator(".team-connection-error")).toBeVisible();
    await expect(page.locator(".players-table tbody tr")).toHaveCount(17);
    await page.getByRole("button", { name: "Обзор и расчёт", exact: true }).click();
    await expect(page.getByRole("button", { name: "Пересчитать", exact: true })).toBeDisabled();
  });

  test("automatically refreshes after five minutes without user action", async ({ page, request }) => {
    const response = await request.get(`${BASE}/api/sports?teamId=587717`, { timeout: 100_000 });
    const snapshot = await response.json() as SportsSyncData;
    let requests = 0;
    await page.route("**/api/sports?**", async (route) => {
      requests += 1;
      await route.fulfill({ json: snapshot });
    });
    await page.clock.install();
    await page.goto(BASE);
    await expect(page.locator(".team-connection-synced")).toBeVisible();
    expect(requests).toBe(1);
    await page.clock.fastForward("05:01");
    await expect.poll(() => requests).toBe(2);
    await expect(page.locator(".synced-roster-preview button")).toHaveCount(17);
  });

  test("stale database fallback is labelled and cannot trigger a new transfer calculation", async ({ page, request }) => {
    const response = await request.get(`${BASE}/api/sports?teamId=587717`, { timeout: 100_000 });
    const snapshot = await response.json() as SportsSyncData;
    await page.route("**/api/sports?**", (route) => route.fulfill({ json: { ...snapshot, cached: true, stale: true } }));
    await page.goto(BASE);
    await expect(page.locator(".team-connection-stale")).toBeVisible();
    await expect(page.locator(".team-connection-synced")).toHaveCount(0);
    await expect(page.locator(".synced-roster-preview button")).toHaveCount(17);
    await expect(page.getByRole("button", { name: "Пересчитать", exact: true })).toBeDisabled();
    await expect(page.getByText("Показан сохранённый состав, а не свежие данные.", { exact: false })).toBeVisible();
  });

  test("mobile layout keeps the connected roster within the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE);
    await expect(page.locator(".team-connection-synced")).toBeVisible({ timeout: 100_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByRole("button", { name: "Мой состав", exact: true }).click();
    await expect(page.locator(".players-table tbody tr")).toHaveCount(17);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: "/tmp/khl-auto-mobile.png", fullPage: true });
  });
});
