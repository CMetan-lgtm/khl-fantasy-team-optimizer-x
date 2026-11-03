import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sportsTeamSnapshots } from "@/db/schema";
import { fetchSportsTeam } from "@/lib/sports-source";
import { CONNECTED_TEAM_ID, SPORTS_DATA_VERSION, SPORTS_SYNC_INTERVAL, type SportsSyncData } from "@/lib/sports-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 90;

const activeRequests = new Map<string, Promise<SportsSyncData>>();
/** Last good snapshot per team in this server process — keeps caching working without a database. */
const memorySnapshots = new Map<string, SportsSyncData>();
const headers = { "Cache-Control": "no-store, max-age=0" };

async function storedSnapshot(teamId: string): Promise<SportsSyncData | null> {
  const memory = memorySnapshots.get(teamId);
  if (memory?.version === SPORTS_DATA_VERSION && memory.roster?.length === 17) return memory;
  try {
    const [row] = await db.select({ payload: sportsTeamSnapshots.payload })
      .from(sportsTeamSnapshots).where(eq(sportsTeamSnapshots.teamId, teamId)).limit(1);
    const data = row?.payload;
    return data?.version === SPORTS_DATA_VERSION && data.roster?.length === 17 ? data : null;
  } catch {
    // A database outage must not prevent a read-only live synchronization.
    return null;
  }
}

async function synchronize(teamId: string): Promise<SportsSyncData> {
  const running = activeRequests.get(teamId);
  if (running) return running;
  const request = fetchSportsTeam(teamId).then(async (data) => {
    memorySnapshots.set(teamId, data);
    try {
      await db.insert(sportsTeamSnapshots).values({ teamId, payload: data, updatedAt: new Date(data.fetchedAt) })
        .onConflictDoUpdate({ target: sportsTeamSnapshots.teamId, set: { payload: data, updatedAt: new Date(data.fetchedAt) } });
    } catch {
      data.warnings.push("Состав получен из Sports.ru, но резервное сохранение на сервере временно недоступно.");
    }
    return data;
  }).finally(() => activeRequests.delete(teamId));
  activeRequests.set(teamId, request);
  return request;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const teamId = params.get("teamId") ?? CONNECTED_TEAM_ID;
  if (!/^\d{1,12}$/.test(teamId)) {
    return Response.json({ error: "Некорректный ID команды.", code: "INVALID_TEAM_ID" }, { status: 400, headers });
  }
  const previous = await storedSnapshot(teamId);
  const refresh = params.get("refresh") === "1";
  const age = previous ? Date.now() - Date.parse(previous.fetchedAt) : Infinity;
  // Manual refresh fetches a new roster, with a 15-second floor against request floods.
  if (previous && age >= 0 && age < (refresh ? 15_000 : SPORTS_SYNC_INTERVAL)) {
    return Response.json({ ...previous, cached: true, stale: false }, { headers });
  }
  try {
    return Response.json(await synchronize(teamId), { headers });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Источник временно недоступен.";
    if (previous) {
      return Response.json({
        ...previous,
        cached: true,
        stale: true,
        warnings: [...previous.warnings, `Не удалось обновить состав: ${message} Показан последний успешный снимок; автоматическая попытка повторится через 5 минут.`],
      }, { headers });
    }
    return Response.json({
      error: `Не удалось автоматически получить состав Sports.ru. ${message} Повторим запрос через 5 минут.`,
      code: "SOURCE_UNAVAILABLE",
    }, { status: 502, headers });
  }
}
