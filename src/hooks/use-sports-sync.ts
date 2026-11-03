"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SPORTS_SYNC_INTERVAL, type SportsSyncData } from "@/lib/sports-types";

export type SportsSyncState = "loading" | "synced" | "stale" | "error";

export function useSportsSync(teamId: string, onSnapshot?: (data: SportsSyncData) => void) {
  const [data, setData] = useState<SportsSyncData | null>(null);
  const [status, setStatus] = useState<SportsSyncState>("loading");
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const lastAttempt = useRef(0);

  const refresh = useCallback(async (force = true) => {
    if (active.current || !mounted.current) return;
    const controller = new AbortController();
    active.current = controller;
    lastAttempt.current = Date.now();
    setStatus("loading");
    setError("");
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 85_000);
    try {
      const response = await fetch(`/api/sports?teamId=${encodeURIComponent(teamId)}${force ? "&refresh=1" : ""}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json() as SportsSyncData & { error?: string };
      if (!response.ok || !payload.profile || payload.profile.teamId !== teamId || payload.rosterStatus !== "synced" || payload.roster?.length !== 17) {
        throw new Error(payload.error ?? "Состав получен не полностью. Сохранённые игроки не изменены.");
      }
      if (!mounted.current || controller.signal.aborted) return;
      onSnapshot?.(payload);
      setData(payload);
      setStatus(payload.stale ? "stale" : "synced");
    } catch (cause) {
      if (!mounted.current || (controller.signal.aborted && !timedOut)) return;
      setStatus("error");
      setError(timedOut ? "Sports.ru отвечает слишком долго. Повторим синхронизацию автоматически." : cause instanceof Error ? cause.message : "Синхронизация Sports.ru временно недоступна.");
    } finally {
      window.clearTimeout(timeout);
      if (active.current === controller) active.current = null;
    }
  }, [teamId, onSnapshot]);

  useEffect(() => {
    mounted.current = true;
    // Start the first sync right after mount (outside the effect body, so React does not cascade renders).
    queueMicrotask(() => { void refresh(false); });
    const whenVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastAttempt.current >= 60_000) void refresh(false);
    };
    const whenOnline = () => { void refresh(false); };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(false);
    }, SPORTS_SYNC_INTERVAL);
    document.addEventListener("visibilitychange", whenVisible);
    window.addEventListener("online", whenOnline);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", whenVisible);
      window.removeEventListener("online", whenOnline);
      active.current?.abort();
      active.current = null;
    };
  }, [refresh]);

  return { data, status, error, refresh };
}
