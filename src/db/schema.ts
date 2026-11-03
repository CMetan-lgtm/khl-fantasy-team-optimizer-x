import { jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import type { SportsSyncData } from "@/lib/sports-types";

// Only public Sports.ru data is cached. No Sports.ru credentials are requested or stored.
export const sportsTeamSnapshots = pgTable("sports_team_snapshots", {
  teamId: varchar("team_id", { length: 12 }).primaryKey(),
  payload: jsonb("payload").$type<SportsSyncData>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
