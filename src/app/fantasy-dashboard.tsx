"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  getDatasetReadiness,
  mergeSportsPlayers,
  isPlayerReady,
  normalizePlayer,
  parseDataInput,
  playerIdentity,
  playerMissingData,
  POSITION_LABELS,
  POSITION_ORDER,
  planMonth,
  projectPlayers,
  csvTemplate,
  type FantasyPlayer,
  type MonthlyPlan,
  type OptimizationResult,
  type OptimizerSettings,
  type Position,
  type ProjectedPlayer,
  type TransferSuggestion,
} from "@/lib/fantasy";

import { recommendTransfers } from "@/lib/weekly-optimizer";
import { compareCandidatesToRoster, type CandidateComparison } from "@/lib/candidate-comparison";
import { useSportsSync } from "@/hooks/use-sports-sync";
import { CONNECTED_TEAM_ID, type SportsProfile as TeamProfile, type RatedPlayer, type SportsSyncData } from "@/lib/sports-types";

type TabId = "overview" | "roster" | "market" | "method";
type RosterView = "owned" | "candidates" | "all";
type IconName =
  | "logo"
  | "home"
  | "people"
  | "chart"
  | "book"
  | "upload"
  | "plus"
  | "refresh"
  | "external"
  | "link"
  | "search"
  | "edit"
  | "trash"
  | "close"
  | "arrow"
  | "check"
  | "target"
  | "calendar"
  | "shield"
  | "clock"
  | "download"
  | "file"
  | "alert"
  | "trophy"
  | "chevron"
  | "spark"
  | "lock"
  | "wallet"
  | "more"
  | "info";

interface EditorForm {
  name: string;
  club: string;
  position: Position;
  price: string;
  seasonPoints: string;
  gamesPlayed: string;
  fantasyAvg: string;
  last5Points: string;
  last5Games: string;
  gamesNextWeek: string;
  gamesWeek2: string;
  gamesWeek3: string;
  availability: string;
  scheduleFactor: string;
  owned: boolean;
}

const PROFILE_SNAPSHOT: TeamProfile = {
  teamId: "587717",
  teamName: "Царь Леонидс",
  week: "неделя 8",
  deadline: "2 ноября, 04:00",
  rank: 1310,
  totalTeams: 2900,
  teamValue: 21702,
  balance: 473,
  budgetLimit: 22175,
  transfersLeft: 5,
  transfersUsed: 0,
  weeklyTransfersLimit: 5,
  supporterLeague: "Динамо Москва",
  supporterLeagueRank: 65,
  league: "Улитки Кокарева",
  leagueId: "27340",
  leagueUrl: "https://www.sports.ru/fantasy/hockey/league/27340.html",
  leagueRank: 23,
  leagueTotal: 50,
  leagueSeasonPoints: 22175,
  leagueTourPoints: 0,
  leaderName: "Царь Леонидас",
  leaderManager: "Максим Алдошин",
  leaderPoints: 22621,
  gapToFirst: 446,
  leagueStandings: [
    { rank: 1, teamId: "586510", teamName: "Царь Леонидас", manager: "Максим Алдошин", seasonPoints: 22621, tourPoints: 0, isCurrent: false },
    { rank: 2, teamId: "588204", teamName: "Люберецкая ледовая банда", manager: "Тамара Харинская", seasonPoints: 22609, tourPoints: 0, isCurrent: false },
    { rank: 23, teamId: "587717", teamName: "Царь Леонидс", manager: "DeNRem1", seasonPoints: 22175, tourPoints: 0, isCurrent: true },
  ],
  profileUrl: "https://www.sports.ru/fantasy/hockey/team/587717.html",
  rosterUrl: "https://www.sports.ru/fantasy/hockey/team/stat/587717.html",
};

const EMPTY_RATINGS: RatedPlayer[] = [];

const DEFAULT_SETTINGS: OptimizerSettings = {
  budget: 22175,
  transfersAvailable: 5,
  clubLimit: 3,
  horizonWeeks: 1,
};

const NAV_ITEMS: Array<{ id: TabId; label: string; icon: IconName }> = [
  { id: "overview", label: "Обзор и расчёт", icon: "home" },
  { id: "roster", label: "Состав и пул", icon: "people" },
  { id: "market", label: "Рейтинг игроков", icon: "chart" },
  { id: "method", label: "Правила и тактика", icon: "book" },
];

const SCORING_ROWS: Array<{ action: string; goalie: string; defender: string; forward: string; group?: string }> = [
  { action: "Победа команды в основное время", goalie: "+3", defender: "+3", forward: "+3", group: "Командный результат" },
  { action: "Победа в овертайме или по буллитам", goalie: "+2", defender: "+2", forward: "+2", group: "Командный результат" },
  { action: "Поражение в овертайме или по буллитам", goalie: "+1", defender: "+1", forward: "+1", group: "Командный результат" },
  { action: "Гол", goalie: "—", defender: "+10", forward: "+10", group: "Полевые игроки" },
  { action: "Голевая передача", goalie: "—", defender: "+5", forward: "+5", group: "Полевые игроки" },
  { action: "Очко «плюс-минус»", goalie: "—", defender: "+2", forward: "+2", group: "Полевые игроки" },
  { action: "Штрафная минута", goalie: "—", defender: "−1", forward: "−1", group: "Полевые игроки" },
  { action: "Больше 10 минут на льду", goalie: "—", defender: "+2", forward: "+2", group: "Время на льду" },
  { action: "Меньше 10 минут на льду", goalie: "—", defender: "+1", forward: "+1", group: "Время на льду" },
  { action: "Больше 40 минут на льду", goalie: "+2", defender: "—", forward: "—", group: "Время на льду" },
  { action: "Меньше 40 минут на льду", goalie: "+1", defender: "—", forward: "—", group: "Время на льду" },
  { action: "Сухой матч: полный матч вратаря", goalie: "+20", defender: "—", forward: "—", group: "Сухие матчи" },
  { action: "Сухой матч: защитник играл больше 10 минут", goalie: "—", defender: "+10", forward: "—", group: "Сухие матчи" },
  { action: "Сухой матч: защитник играл меньше 10 минут", goalie: "—", defender: "+5", forward: "—", group: "Сухие матчи" },
  { action: "Пропущенная шайба", goalie: "−3", defender: "—", forward: "—", group: "Вратари" },
  { action: "Каждые 2 сейва", goalie: "+1", defender: "—", forward: "—", group: "Вратари" },
];

function Icon({ name, size = 20, strokeWidth = 1.8 }: { name: IconName; size?: number; strokeWidth?: number }) {
  const shared = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
    focusable: false as const,
  };
  let content: ReactNode;
  switch (name) {
    case "logo":
      content = <><path d="M12 2.5v19M3.8 7.25l16.4 9.5M3.8 16.75l16.4-9.5" /><path d="m9.4 4 2.6 2.4L14.6 4M9.4 20l2.6-2.4 2.6 2.4M3.4 10.7l3.4-1 .8-3.4M20.6 13.3l-3.4 1-.8 3.4M3.4 13.3l3.4 1 .8 3.4M20.6 10.7l-3.4-1-.8-3.4" /></>;
      break;
    case "home":
      content = <><path d="M3.5 10.5 12 3.8l8.5 6.7" /><path d="M5.5 9v11h4.8v-6.2h3.4V20h4.8V9" /></>;
      break;
    case "people":
      content = <><circle cx="9" cy="8" r="3.4" /><path d="M2.8 20c.5-3.6 2.7-5.5 6.2-5.5s5.7 1.9 6.2 5.5" /><path d="M15.6 4.9a3.2 3.2 0 0 1 0 6.3M17 14.7c2.3.5 3.7 2.2 4.1 5.1" /></>;
      break;
    case "chart":
      content = <><path d="M4 20h16" /><path d="M6.5 16.5v-4.5" /><path d="M11.5 16.5V7.5" /><path d="M16.5 16.5v-7" /><path d="m5 8.5 5-3 4 2 5-3.5" /></>;
      break;
    case "book":
      content = <><path d="M5 4.5h11a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z" /><path d="M5 16.5a3 3 0 0 1 3-3h11M9 8h6M9 10.5h4" /></>;
      break;
    case "upload":
      content = <><path d="M12 15.5V4.5" /><path d="m7.5 9 4.5-4.5L16.5 9" /><path d="M4.5 15v4.5h15V15" /></>;
      break;
    case "plus":
      content = <><path d="M12 5v14M5 12h14" /></>;
      break;
    case "refresh":
      content = <><path d="M20 7v5h-5" /><path d="M4.5 16.5A8 8 0 0 0 18 19l2-2" /><path d="M4 17v-5h5" /><path d="M19.5 7.5A8 8 0 0 0 6 5L4 7" /></>;
      break;
    case "external":
      content = <><path d="M13.5 4.5h6v6" /><path d="m19.5 4.5-9 9" /><path d="M18 13.5v5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>;
      break;
    case "link":
      content = <><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></>;
      break;
    case "search":
      content = <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m15.5 15.5 4.2 4.2" /></>;
      break;
    case "edit":
      content = <><path d="m14 5 5 5" /><path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20z" /></>;
      break;
    case "trash":
      content = <><path d="M4.5 7h15M9 7V4.5h6V7M7 7l.8 13h8.4L17 7M10 10.5v6M14 10.5v6" /></>;
      break;
    case "close":
      content = <><path d="m6 6 12 12M18 6 6 18" /></>;
      break;
    case "arrow":
      content = <><path d="M5 12h14M13 6l6 6-6 6" /></>;
      break;
    case "check":
      content = <><path d="m5 12.5 4.2 4.2L19 7" /></>;
      break;
    case "target":
      content = <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" /></>;
      break;
    case "calendar":
      content = <><rect x="4" y="5.5" width="16" height="15" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16M8 14h2M13 14h3M8 17h2" /></>;
      break;
    case "shield":
      content = <><path d="M12 3.5 19 6v5.4c0 4.3-2.8 7.5-7 9.1-4.2-1.6-7-4.8-7-9.1V6z" /><path d="m9 12 2 2 4-4.2" /></>;
      break;
    case "clock":
      content = <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></>;
      break;
    case "download":
      content = <><path d="M12 4.5v11" /><path d="m7.5 11.5 4.5 4.5 4.5-4.5" /><path d="M4.5 19.5h15" /></>;
      break;
    case "file":
      content = <><path d="M6 3.5h8l4.5 4.5v12H6z" /><path d="M14 3.5V8h4.5M9 12h6M9 15.5h6" /></>;
      break;
    case "alert":
      content = <><path d="M12 3.5 21 20H3z" /><path d="M12 9v4.5M12 17h.01" /></>;
      break;
    case "trophy":
      content = <><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4v2a4 4 0 0 0 4 4M16 6h4v2a4 4 0 0 1-4 4M12 13v4M8.5 20h7M9.5 17h5" /></>;
      break;
    case "chevron":
      content = <><path d="m9 5 7 7-7 7" /></>;
      break;
    case "spark":
      content = <><path d="m12 3 1.6 6.1L20 11l-6.4 1.9L12 19l-1.6-6.1L4 11l6.4-1.9z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>;
      break;
    case "lock":
      content = <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2.5" /></>;
      break;
    case "wallet":
      content = <><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><path d="M4 7.5V18a2 2 0 0 0 2 2h14V8H6.5A2.5 2.5 0 0 1 4 7.5z" /><path d="M16 14h.01" /></>;
      break;
    case "more":
      content = <><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>;
      break;
    case "info":
      content = <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8h.01" /></>;
      break;
  }
  return <svg {...shared}>{content}</svg>;
}

function formatNumber(value: number | undefined | null, maximumFractionDigits = 0): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits }).format(value);
}

function formatPoints(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(value);
}

function formatSigned(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${formatPoints(Math.abs(value))}`;
}

/** "2026-11-04" → "04.11" without time-zone conversion (the dates are already Moscow dates). */
function formatDay(value?: string): string {
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return parts ? `${parts[3]}.${parts[2]}` : "";
}

function pointsWord(value: number): string {
  const whole = Math.floor(Math.abs(value));
  if (!Number.isInteger(Math.abs(value))) return "очка";
  const last = whole % 10;
  const lastTwo = whole % 100;
  if (last === 1 && lastTwo !== 11) return "очко";
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return "очка";
  return "очков";
}

function swapsWord(count: number): string {
  const last = count % 10;
  const lastTwo = count % 100;
  if (last === 1 && lastTwo !== 11) return "замена";
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return "замены";
  return "замен";
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toLocaleUpperCase("ru-RU");
}

function surname(name: string): string {
  const words = name.trim().split(/\s+/);
  return words[words.length - 1] ?? name;
}

function roleShort(position: Position): string {
  return position === "G" ? "ВР" : position === "D" ? "ЗАЩ" : "НАП";
}

function capitalize(value: string): string {
  return value ? value[0].toLocaleUpperCase("ru-RU") + value.slice(1) : value;
}

function storagePlayer(value: unknown): FantasyPlayer | null {
  if (!value || typeof value !== "object") return null;
  const player = value as Record<string, unknown>;
  return normalizePlayer(player, Boolean(player.owned));
}

function IconButton({
  label,
  icon,
  onClick,
  danger = false,
}: {
  label: string;
  icon: IconName;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button className={`x-icon-btn${danger ? " x-icon-btn-danger" : ""}`} type="button" onClick={onClick} aria-label={label} title={label}>
      <Icon name={icon} size={18} />
    </button>
  );
}

function Avatar({ name, position, size = "md" }: { name: string; position?: Position; size?: "xs" | "sm" | "md" }) {
  return <span className={`x-avatar x-avatar-${size}${position ? ` role-${position}` : " x-avatar-team"}`} aria-hidden="true">{initials(name)}</span>;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
}

function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: Array<{ id: T; label: ReactNode }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    refs.current[next]?.focus();
    onChange(items[next].id);
  }
  return (
    <div className={`x-tabs${className ? ` ${className}` : ""}`} role="tablist" aria-label={label}>
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={`x-tab${selected ? " selected" : ""}`}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => move(event, index)}
          >
            <span className="x-tab-label">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function PlayerEditor({
  player,
  onClose,
  onSave,
}: {
  player: FantasyPlayer | null;
  onClose: () => void;
  onSave: (player: FantasyPlayer) => void;
}) {
  const [form, setForm] = useState<EditorForm>(() => ({
    name: player?.name ?? "",
    club: player?.club ?? "",
    position: player?.position ?? "F",
    price: player?.priceKnown ? String(player.price) : "",
    seasonPoints: player && (player.seasonPointsKnown ?? player.statsKnown) ? String(player.seasonPoints) : "",
    gamesPlayed: player?.gamesPlayed ? String(player.gamesPlayed) : "",
    fantasyAvg: player?.fantasyAvg !== null && player?.fantasyAvg !== undefined ? String(player.fantasyAvg) : "",
    last5Points: player?.last5Games ? String(player.last5Points) : "",
    last5Games: player?.last5Games ? String(player.last5Games) : "",
    gamesNextWeek: player?.scheduleKnown ? String(player.gamesNextWeek) : "",
    gamesWeek2: player?.scheduleKnown ? String(player.gamesWeek2) : "",
    gamesWeek3: player?.scheduleKnown ? String(player.gamesWeek3) : "",
    availability: String(Math.round((player?.availability ?? 1) * 100)),
    scheduleFactor: String(player?.scheduleFactor ?? 1),
    owned: player?.owned ?? false,
  }));
  const [error, setError] = useState("");
  useEscape(onClose);
  const fromSource = Boolean(player?.sportsId);

  function update<K extends keyof EditorForm>(key: K, value: EditorForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function save() {
    const name = form.name.trim();
    const club = form.club.trim();
    if (!name || !club) {
      setError("Укажите фамилию игрока и клуб.");
      return;
    }
    const parse = (value: string) => {
      const result = Number(value.replace(/[\u00a0\u202f\s]/g, "").replace(/,/g, "."));
      return Number.isFinite(result) ? result : 0;
    };
    const price = Math.max(0, parse(form.price));
    const seasonPoints = parse(form.seasonPoints);
    const gamesPlayed = Math.max(0, parse(form.gamesPlayed));
    const manualRate = form.fantasyAvg.trim() ? parse(form.fantasyAvg) : null;
    const recentGames = Math.max(0, parse(form.last5Games));
    const availability = Math.max(0, Math.min(100, parse(form.availability))) / 100;
    const scheduleFactor = Math.max(0.7, Math.min(1.3, parse(form.scheduleFactor || "1")));
    const scheduleKnown = form.gamesNextWeek.trim() !== "";
    const statsKnown = (gamesPlayed > 0 && form.seasonPoints.trim() !== "") || manualRate !== null;
    const id = player?.id ?? `${form.position}:${club.toLocaleLowerCase("ru-RU")}:${name.toLocaleLowerCase("ru-RU")}`;
    onSave({
      ...player,
      id,
      name,
      club,
      position: form.position,
      price,
      seasonPoints,
      gamesPlayed,
      fantasyAvg: manualRate,
      last5Points: parse(form.last5Points),
      last5Games: recentGames,
      gamesNextWeek: Math.max(0, parse(form.gamesNextWeek)),
      gamesWeek2: Math.max(0, parse(form.gamesWeek2)),
      gamesWeek3: Math.max(0, parse(form.gamesWeek3)),
      availability,
      scheduleFactor,
      owned: form.owned,
      priceKnown: form.price.trim() !== "" && price > 0,
      statsKnown,
      scheduleKnown,
      source: player?.source,
    });
  }

  const field = (key: keyof EditorForm, label: string, placeholder: string, options: { wide?: boolean; editable?: boolean } = {}) => (
    <label className={`x-field${options.wide ? " x-field-wide" : ""}${fromSource && !options.editable ? " x-field-readonly" : ""}`}>
      <span>{label}</span>
      <input inputMode={key === "name" || key === "club" ? undefined : "decimal"} readOnly={fromSource && !options.editable} value={String(form[key])} onChange={(event) => update(key, event.target.value as never)} placeholder={placeholder} />
    </label>
  );

  return (
    <div className="x-modal-mask" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="x-modal" role="dialog" aria-modal="true" aria-labelledby="player-modal-title">
        <header className="x-modal-head">
          <button type="button" className="x-icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="close" /></button>
          <h2 id="player-modal-title">{player ? "Карточка игрока" : "Новый кандидат"}</h2>
          <button className="x-pill x-pill-primary x-pill-sm" type="button" onClick={save}>Сохранить</button>
        </header>
        <div className="x-modal-body">
          <div className="x-modal-identity">
            <Avatar name={form.name || "?"} position={form.position} />
            <div>
              <b>{form.name || "Имя игрока"}</b>
              <span>{form.club || "Клуб"} · {POSITION_LABELS[form.position]}</span>
            </div>
          </div>
          <p className="x-modal-note"><Icon name={fromSource ? "refresh" : "people"} size={18} /><span>{fromSource ? "Данные получены из Sports.ru. Здесь меняются только допущения прогноза — при следующей синхронизации вернутся автоматические оценки." : "Игрок добавится в пул кандидатов. Ваш состав загружается из Sports.ru автоматически."}</span></p>
          <div className="x-form-grid">
            <label className={`x-field x-field-wide${fromSource ? " x-field-readonly" : ""}`}>
              <span>Имя игрока</span>
              <input autoFocus readOnly={fromSource} value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Например, Иван Иванов" />
            </label>
            <label className={`x-field${fromSource ? " x-field-readonly" : ""}`}>
              <span>Клуб</span>
              <input readOnly={fromSource} value={form.club} onChange={(event) => update("club", event.target.value)} placeholder="Клуб КХЛ" />
            </label>
            <label className={`x-field${fromSource ? " x-field-readonly" : ""}`}>
              <span>Позиция</span>
              <select disabled={fromSource} value={form.position} onChange={(event) => update("position", event.target.value as Position)}>
                {POSITION_ORDER.map((position) => <option key={position} value={position}>{POSITION_LABELS[position]}</option>)}
              </select>
            </label>
            <h3 className="x-form-section">Цена и результативность</h3>
            {field("price", "Цена игрока", "Например, 1250")}
            {field("seasonPoints", "Очки Fantasy за сезон", "Итого по сезону")}
            {field("gamesPlayed", "Матчи сезона", "GP")}
            {field("fantasyAvg", "Или среднее очков за матч", "Если нет GP и суммы")}
            {field("last5Points", "Очки за последние матчи", "Сумма Fantasy")}
            {field("last5Games", "Число матчей в форме", "Обычно до 5")}
            <h3 className="x-form-section">Календарь и доступность</h3>
            {field("gamesNextWeek", "Матчи в текущем туре", "Обязательное поле")}
            {field("gamesWeek2", "Матчи в следующем туре", "Для плана на месяц")}
            {field("gamesWeek3", "Матчи через два тура", "Для плана на месяц")}
            {field("availability", "Вероятность участия, %", "100", { editable: true })}
            {field("scheduleFactor", "Поправка на соперников, 0,7–1,3", "1 = без поправки", { wide: true, editable: true })}
          </div>
          <p className="x-form-footnote">Для точного сравнения нужны актуальные цена, матчи в календаре и очки Fantasy. Пустые поля не подменяются выдуманными значениями.</p>
          {error && <p className="x-form-error" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}

function ImportModal({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (players: FantasyPlayer[], settings: Partial<OptimizerSettings> | undefined, merge: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [merge, setMerge] = useState(false);
  const [error, setError] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  useEscape(onClose);

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setSelectedFile(file.name);
    setError("");
    try {
      setText(await file.text());
    } catch {
      setError("Не получилось открыть файл. Попробуйте сохранить его как UTF-8 CSV или JSON.");
    }
  }

  function importText() {
    try {
      const parsed = parseDataInput(text, false);
      onImport(parsed.players, parsed.settings, merge);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось прочитать данные.");
    }
  }

  function downloadTemplate() {
    const file = new Blob(["\ufeff", csvTemplate()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "khl-fantasy-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="x-modal-mask" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="x-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <header className="x-modal-head">
          <button type="button" className="x-icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="close" /></button>
          <h2 id="import-title">Дополнительные кандидаты</h2>
          <button className="x-pill x-pill-primary x-pill-sm" type="button" onClick={importText} disabled={!text.trim()}>Импортировать</button>
        </header>
        <div className="x-modal-body">
          <p className="x-modal-lead">Состав уже загружается из Sports.ru. Здесь можно добавить кандидатов из CSV или JSON — игроки вашей команды не изменятся.</p>
          <div className="x-import-toolbar">
            <label className="x-pill x-pill-outline x-file-picker">
              <Icon name="file" size={18} /> Выбрать файл
              <input type="file" accept=".csv,.tsv,.json,text/csv,application/json" onChange={readFile} />
            </label>
            <button className="x-pill x-pill-ghost" type="button" onClick={downloadTemplate}><Icon name="download" size={18} /> CSV-шаблон</button>
            {selectedFile && <span className="x-file-name">{selectedFile}</span>}
          </div>
          <label className="x-field x-field-area">
            <span>Или вставьте CSV / JSON</span>
            <textarea
              value={text}
              onChange={(event) => { setText(event.target.value); setError(""); }}
              placeholder={'name;club;position;price;seasonPoints;gamesPlayed;last5Points;last5Games;gamesNextWeek;gamesWeek2;gamesWeek3;availability;scheduleFactor;owned\nИгрок;Клуб;Нападающий;1250;145;32;24;5;3;2;3;100;1;да'}
              rows={7}
            />
          </label>
          <label className="x-check-row">
            <input type="checkbox" checked={merge} onChange={(event) => setMerge(event.target.checked)} />
            <span><b>Добавить к текущему списку</b><small>Совпадающие игроки обновятся.</small></span>
          </label>
          <p className="x-modal-note"><Icon name="info" size={18} /><span>Обязательные поля: <b>name, club, position, price, seasonPoints + gamesPlayed</b> (или fantasyAvg) и <b>gamesNextWeek</b>. Остальные туры, форма, доступность и поправка на соперников уточняют прогноз.</span></p>
          {error && <p className="x-form-error" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}

function VerifiedMark() {
  return (
    <svg className="x-verified" viewBox="0 0 22 22" width="16" height="16" aria-hidden="true">
      <path fill="currentColor" d="M20.4 11c0-1.3-.8-2.4-1.9-2.9.4-1.2.1-2.6-.8-3.5-.9-.9-2.3-1.2-3.5-.8C13.7 2.6 12.4 1.8 11 1.8S8.3 2.6 7.8 3.8c-1.2-.4-2.6-.1-3.5.8-.9.9-1.2 2.3-.8 3.5C2.4 8.6 1.6 9.7 1.6 11s.8 2.4 1.9 2.9c-.4 1.2-.1 2.6.8 3.5.9.9 2.3 1.2 3.5.8.5 1.2 1.8 2 3.2 2s2.7-.8 3.2-2c1.2.4 2.6.1 3.5-.8.9-.9 1.2-2.3.8-3.5 1.1-.5 1.9-1.6 1.9-2.9z" />
      <path fill="#fff" d="M9.6 15.2 6.2 11.8l1.3-1.3 2.1 2.1 4.9-4.9 1.3 1.3z" />
    </svg>
  );
}

function PlayerDataBadge({ player }: { player: FantasyPlayer }) {
  const missing = playerMissingData(player);
  if (!missing.length) {
    return (
      <span className="x-badge x-badge-ready" title="Цена, очки и календарь получены">
        <VerifiedMark />
        <span className="sr-only">Данные полные</span>
      </span>
    );
  }
  return (
    <span className="x-badge x-badge-incomplete" title={`Не хватает: ${missing.join(", ")}`}>
      <Icon name="alert" size={13} /> Не все данные
    </span>
  );
}

function comparisonStatusText(comparison: CandidateComparison): string {
  if (comparison.status === "improves") return comparison.timing?.afterDate ? "Одиночная замена · с ожиданием матча" : "Вариант одной замены";
  if (comparison.status === "no-transfers") return "Потенциал · трансферы закончились";
  if (comparison.status === "locked") return "Потенциал · покупка закрыта";
  return "Не менять: прироста нет";
}

function CandidateComparisonCell({ candidate, comparison }: { candidate: FantasyPlayer; comparison?: CandidateComparison }) {
  if (!comparison) {
    return (
      <div className="candidate-match-empty">
        <b>Сравнение появится после загрузки состава</b>
      </div>
    );
  }
  if (!comparison.outgoing || comparison.outgoingPoints === null || comparison.candidatePoints === null || comparison.gain === null) {
    return (
      <div className="candidate-match-empty" data-testid={`candidate-comparison-${candidate.id}`}>
        <b>{comparison.status === "locked" ? "Трансфер закрыт" : comparison.status === "no-transfers" ? "Нет трансферов" : "Подходящей замены нет"}</b>
        <small>{comparison.reason}</small>
      </div>
    );
  }

  const profitable = comparison.status === "improves";
  const blocked = comparison.status === "locked" || comparison.status === "no-transfers";
  const alreadyScored = comparison.outgoingEarnedPoints ?? 0;
  const outgoing = comparison.outgoing;
  return (
    <div className={`candidate-match${profitable ? " candidate-match-positive" : " candidate-match-neutral"}`} data-testid={`candidate-comparison-${candidate.id}`}>
      <div className="candidate-match-player">
        <Avatar name={outgoing.name} position={outgoing.position} size="xs" />
        <span className="candidate-match-who">
          <b>{outgoing.name}</b>
          <small>Из моей команды · {roleShort(outgoing.position)} · {outgoing.club}</small>
        </span>
      </div>
      <div className="candidate-match-scores">
        <span><small>Мой игрок ещё</small><b>{formatPoints(comparison.outgoingPoints)}</b></span>
        <span className="candidate-match-arrow" aria-hidden="true"><Icon name="arrow" size={15} /></span>
        <span><small>Кандидат ещё</small><b>{formatPoints(comparison.candidatePoints)}</b></span>
        <strong className={profitable ? "candidate-match-gain" : "candidate-match-loss"}>{formatSigned(comparison.gain)}</strong>
      </div>
      {profitable && comparison.timing?.afterDate && (
        <p className="candidate-match-timing">
          <Icon name="clock" size={14} />
          <span>Менять после {formatDay(comparison.timing.afterDate)}: {outgoing.name} сначала сыграет свой матч{comparison.timing.beforeDate ? `, успеть до ${formatDay(comparison.timing.beforeDate)}` : ""}</span>
        </p>
      )}
      <div className="candidate-match-footer">
        <small>Мой уже набрал {formatPoints(alreadyScored)} · без замены за тур ≈ {formatPoints(alreadyScored + comparison.outgoingPoints)}</small>
        <span className="candidate-match-status">{comparisonStatusText(comparison)}</span>
        {blocked && <small className="candidate-match-blocked">{comparison.reason}</small>}
      </div>
    </div>
  );
}

function PlayerActions({ player, onEdit, onRemove }: { player: FantasyPlayer; onEdit: (player: FantasyPlayer) => void; onRemove: (player: FantasyPlayer) => void }) {
  return (
    <div className="pt-actions">
      <IconButton label="Редактировать игрока" icon="edit" onClick={() => onEdit(player)} />
      {player.playerSourceUrl && (
        <a className="x-icon-btn" href={player.playerSourceUrl} target="_blank" rel="noreferrer" aria-label="Карточка игрока на Sports.ru" title="Статистика Sports.ru">
          <Icon name="external" size={17} />
        </a>
      )}
      {!player.sportsId && <IconButton label="Удалить кандидата" icon="trash" danger onClick={() => onRemove(player)} />}
    </div>
  );
}

function PlayerMetrics({ player, projection, comparisons }: { player: FantasyPlayer; projection?: ProjectedPlayer; comparisons?: boolean }) {
  const seasonKnown = player.seasonPointsKnown ?? player.statsKnown;
  return (
    <dl className="pt-metrics">
      <div>
        <dt>Сезон</dt>
        <dd>{seasonKnown ? formatNumber(player.seasonPoints) : "—"}<small>{player.gamesPlayed ? `${formatNumber(player.gamesPlayed)} игр` : "очков"}</small></dd>
      </div>
      <div>
        <dt>Форма</dt>
        <dd>{player.last5Games ? formatPoints(player.last5Points / player.last5Games) : "—"}<small>за матч</small></dd>
      </div>
      <div>
        <dt>Матчи</dt>
        <dd>{player.scheduleKnown ? formatNumber(player.gamesNextWeek) : "—"}<small>{player.scheduleKnown ? "осталось в туре" : "нет данных"}</small></dd>
      </div>
      <div>
        <dt>{comparisons && !player.owned ? "Прогноз кандидата" : "Прогноз"}</dt>
        <dd className={projection && projection.horizonPoints > 0 ? "pt-positive" : ""}>
          {projection ? formatPoints(projection.horizonPoints) : "—"}
          <small>{projection ? `${formatPoints(projection.blendedRate)} / матч` : "очков"}</small>
        </dd>
      </div>
    </dl>
  );
}

function CandidateMobileCard({
  player,
  projection,
  comparison,
  onEdit,
}: {
  player: FantasyPlayer;
  projection?: ProjectedPlayer;
  comparison?: CandidateComparison;
  onEdit: (player: FantasyPlayer) => void;
}) {
  const ready = projection && isPlayerReady(player);
  return (
    <article className="candidate-mobile-card" data-testid={`candidate-card-${player.id}`}>
      <Avatar name={player.name} position={player.position} />
      <div className="candidate-mobile-body">
        <div className="candidate-mobile-top">
          <span className="candidate-mobile-identity">
            <b>{player.name}</b>
            <PlayerDataBadge player={player} />
            {player.locked && <span className="pt-lock" title="Трансфер закрыт"><Icon name="lock" size={14} /></span>}
          </span>
          <span className="candidate-mobile-price">{player.priceKnown ? formatNumber(player.price) : "Цена —"}</span>
        </div>
        <span className="pt-sub">{player.club} · {POSITION_LABELS[player.position]}</span>
        <div className="candidate-mobile-metrics">
          <span><small>Осталось матчей</small><b>{player.scheduleKnown ? formatNumber(player.gamesNextWeek) : "—"}</b></span>
          <span><small>Прогноз кандидата</small><b>{ready ? formatPoints(projection.pointsWeek1) : "—"} <em>очков</em></b></span>
        </div>
        <CandidateComparisonCell candidate={player} comparison={comparison} />
        <div className="candidate-mobile-bottom">
          <button className="x-link-btn" type="button" onClick={() => onEdit(player)}>Карточка игрока <Icon name="arrow" size={14} /></button>
        </div>
      </div>
    </article>
  );
}

function PlayerTable({
  players,
  projections,
  comparisons,
  showComparisons,
  showCandidateCards,
  onEdit,
  onRemove,
}: {
  players: FantasyPlayer[];
  projections: Map<string, ProjectedPlayer>;
  comparisons?: Map<string, CandidateComparison>;
  showComparisons?: boolean;
  showCandidateCards?: boolean;
  onEdit: (player: FantasyPlayer) => void;
  onRemove: (player: FantasyPlayer) => void;
}) {
  if (!players.length) {
    return (
      <div className="x-empty">
        <b>Здесь пока никого</b>
        <span>Измените поиск или фильтр. Кандидатов можно добавить вручную или загрузить CSV / JSON.</span>
      </div>
    );
  }
  const ordered = [...players].sort((a, b) => {
    if (a.owned !== b.owned) return Number(b.owned) - Number(a.owned);
    if (showComparisons && !a.owned && !b.owned) {
      const left = comparisons?.get(a.id);
      const right = comparisons?.get(b.id);
      const leftUseful = left?.status === "improves" && (left.gain ?? 0) > 0 ? 1 : 0;
      const rightUseful = right?.status === "improves" && (right.gain ?? 0) > 0 ? 1 : 0;
      if (leftUseful !== rightUseful) return rightUseful - leftUseful;
      if ((left?.gain ?? -Infinity) !== (right?.gain ?? -Infinity)) return (right?.gain ?? -Infinity) - (left?.gain ?? -Infinity);
    }
    return POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position) || a.name.localeCompare(b.name, "ru");
  });
  return (
    <>
      <div className={`table-scroll${showCandidateCards ? " candidate-desktop-table" : ""}`}>
        <table className={`players-table${showComparisons ? " players-table-comparisons" : ""}`}>
          <caption className="sr-only">{showComparisons ? "Игроки и сравнение с вашим составом" : "Игроки состава"}</caption>
          <tbody>
            {ordered.map((player) => {
              const projection = isPlayerReady(player) ? projections.get(player.id) : undefined;
              return (
                <tr key={player.id} className={player.owned ? "pt-owned" : "pt-candidate"}>
                  <td>
                    <div className="pt-row">
                      <Avatar name={player.name} position={player.position} />
                      <div className="pt-body">
                        <div className="pt-head">
                          <span className="pt-identity">
                            <b className="pt-name">{player.name}</b>
                            <PlayerDataBadge player={player} />
                            {player.locked && <span className="pt-lock" title="Трансфер закрыт до конца матча"><Icon name="lock" size={14} /><span className="sr-only">Трансфер закрыт</span></span>}
                          </span>
                          <PlayerActions player={player} onEdit={onEdit} onRemove={onRemove} />
                        </div>
                        <span className="pt-sub">
                          <span className={`pt-role role-text-${player.position}`}>{roleShort(player.position)}</span> · {player.club} · {player.priceKnown ? formatNumber(player.price) : "цена не указана"}
                          {player.owned && player.earnedWeekPoints ? ` · в туре уже ${formatPoints(player.earnedWeekPoints)}` : ""}
                        </span>
                        <PlayerMetrics player={player} projection={projection} comparisons={showComparisons} />
                        {showComparisons && (
                          <div className="candidate-comparison-cell">
                            {player.owned ? <div className="candidate-match-empty candidate-match-owned"><b>В вашем составе</b></div> : <CandidateComparisonCell candidate={player} comparison={comparisons?.get(player.id)} />}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {showCandidateCards && (
        <div className="candidate-mobile-list">
          {ordered.filter((player) => !player.owned).map((player) => (
            <CandidateMobileCard key={player.id} player={player} projection={projections.get(player.id)} comparison={comparisons?.get(player.id)} onEdit={onEdit} />
          ))}
        </div>
      )}
    </>
  );
}

function swapTimingLabel(swap: TransferSuggestion): string {
  if (swap.kind === "timed" && swap.executeAfter) {
    return `После ${formatDay(swap.executeAfter)}${swap.executeBefore ? ` · успеть до ${formatDay(swap.executeBefore)}` : ""}`;
  }
  return swap.executeBefore ? `Сейчас · успеть до ${formatDay(swap.executeBefore)}` : "Сейчас";
}

function PlayerLine({ player, prefix }: { player: ProjectedPlayer; prefix?: string }) {
  return (
    <span className="x-player-line">
      {prefix && <span className="x-player-line-prefix">{prefix}</span>}
      <Avatar name={player.name} position={player.position} size="xs" />
      <b>{player.name}</b>
      <span>{roleShort(player.position)} · {player.club} · {formatNumber(player.price)}</span>
    </span>
  );
}

function SwapPost({ swap, index, last }: { swap: TransferSuggestion; index: number; last: boolean }) {
  const timed = swap.kind === "timed" && Boolean(swap.executeAfter);
  return (
    <article className={`swap-row x-thread-item${last ? " x-thread-last" : ""}`}>
      <div className="x-rail">
        <Avatar name={swap.incoming.name} position={swap.incoming.position} />
      </div>
      <div className="x-post-body">
        <div className="x-post-meta">
          <span className="swap-step">Шаг {swap.step ?? index + 1}</span>
          <span className={`swap-when${timed ? " swap-when-timed" : ""}`}><Icon name="clock" size={14} /> {swapTimingLabel(swap)}</span>
        </div>
        <div className="swap-incoming">
          <b>{swap.incoming.name}</b>
          <span>{POSITION_LABELS[swap.incoming.position]} · {swap.incoming.club} · {formatNumber(swap.incoming.price)} · осталось матчей: {swap.incoming.gamesNextWeek}</span>
        </div>
        <div className="swap-outgoing">
          <PlayerLine player={swap.outgoing} prefix="Вместо" />
        </div>
        {timed && (
          <p className="swap-why">{swap.outgoing.name} сначала сыграет {formatDay(swap.executeAfter)} — эти очки останутся у вас, а новичок успеет к своему матчу.</p>
        )}
        <div className="x-action-bar swap-stats">
          <span className="swap-gain"><Icon name="spark" size={16} /> <b>{formatSigned(swap.gain)}</b> в туре</span>
          {swap.futureGain !== undefined && Math.abs(swap.futureGain) >= 0.05 && (
            <span className={swap.futureGain >= 0 ? "swap-future-up" : "swap-future-down"}><Icon name="calendar" size={16} /> {formatSigned(swap.futureGain)} дальше</span>
          )}
          {swap.cashAfter !== undefined && <span><Icon name="wallet" size={16} /> баланс {formatNumber(swap.cashAfter)}</span>}
        </div>
      </div>
    </article>
  );
}

function SwapThread({ result }: { result: OptimizationResult }) {
  const core = [...result.swaps].sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
  const prep = result.prepSwaps ?? [];
  const nextWeek = result.weekNumber ? result.weekNumber + 1 : null;
  const headline = core.length
    ? `Рекомендуется ${core.length} ${swapsWord(core.length)}`
    : prep.length
      ? "В этом туре менять некого"
      : "Состав уже оптимален в этом пуле";
  return (
    <section className="recommendation-card" aria-label="Рекомендация на неделю">
      <article className={`x-thread-item x-post-lead${core.length ? "" : " x-thread-last"}`}>
        <div className="x-rail">
          <span className="x-avatar x-avatar-md x-avatar-brand" aria-hidden="true"><Icon name="logo" size={22} /></span>
        </div>
        <div className="x-post-body">
          <div className="x-post-meta">
            <b>Ледовый штаб</b>
            <VerifiedMark />
            <span className="x-dim">· Только текущая неделя{result.weekNumber ? ` ${result.weekNumber}` : ""} · {result.exact === false ? "приближённый расчёт" : "точный расчёт"}</span>
          </div>
          <h3 className="x-post-title">{headline}</h3>
          <p className="x-post-text">
            {core.length
              ? "Пары подобраны с сохранением позиции, бюджета на каждом шаге и лимита клубов. Выполняйте шаги по порядку."
              : "Не расходуйте трансфер, если он не повышает прогноз набора очков в этом туре."}
          </p>
          <div className="x-score">
            <div><small>Состав сейчас</small><b>{formatPoints(result.baselineWeekPoints)}</b></div>
            <Icon name="arrow" size={18} />
            <div><small>После замен</small><b>{formatPoints(result.projectedWeekPoints)}</b></div>
            <div className={`x-score-gain${result.gainWeek > 0.05 ? " is-up" : ""}`}><small>прибавка</small><b>{formatSigned(result.gainWeek)}</b></div>
          </div>
          <div className="weekly-score-breakdown">
            <span>Уже набрано: <b>{formatPoints(result.earnedWeekPoints ?? 0)}</b></span>
            <span>Осталось набрать по прогнозу: <b>{formatPoints(result.remainingAfter ?? result.projectedWeekPoints)}</b></span>
            <span>Стоимость: <b>{formatNumber(result.finalCost)}</b> · остаток <b>{formatNumber(result.remainingBudget)}</b></span>
          </div>
          <div className="x-action-bar">
            <span><Icon name="refresh" size={16} /> {result.transfersUsed} из {result.transfersAvailable} трансферов</span>
            <span><Icon name="people" size={16} /> {result.candidatesConsidered} из {result.candidatesAvailable} кандидатов</span>
            {result.futureGain !== undefined && Math.abs(result.futureGain) >= 0.05 && <span><Icon name="calendar" size={16} /> {formatSigned(result.futureGain)} на следующих неделях</span>}
          </div>
        </div>
      </article>

      {core.map((swap, index) => <SwapPost key={`${swap.outgoing.id}-${swap.incoming.id}`} swap={swap} index={index} last={index === core.length - 1} />)}

      {result.executionNote && (
        <p className="x-note x-note-info"><Icon name="info" size={16} /><span>{result.executionNote}</span></p>
      )}

      {prep.length > 0 && (
        <div className="prep-section">
          <div className="prep-head">
            <b>Подготовка к неделе{nextWeek ? ` ${nextWeek}` : " следующей"} · необязательно</b>
            <span>Свободные трансферы: в этом туре очков не меньше, а на следующей неделе — больше{result.prepGain ? ` (${formatSigned(result.prepGain)})` : ""}.</span>
          </div>
          {prep.map((swap) => (
            <div className="prep-row" key={`prep-${swap.outgoing.id}-${swap.incoming.id}`}>
              <Avatar name={swap.incoming.name} position={swap.incoming.position} size="sm" />
              <div>
                <b>{swap.incoming.name}</b>
                <span>вместо {swap.outgoing.name} · {roleShort(swap.incoming.position)} · {swap.incoming.club} · {formatNumber(swap.incoming.price)}</span>
                <small>{formatSigned(swap.gain)} в туре · {formatSigned(swap.futureGain ?? 0)} дальше · {swapTimingLabel(swap)}</small>
              </div>
            </div>
          ))}
        </div>
      )}

      {result.checks && (
        <div className="weekly-checks" aria-label="Проверка недельного расчёта">
          <div className="weekly-checks-head">
            <b>Проверка расчёта</b>
            <span>{result.checks.filter((check) => check.ok).length} из {result.checks.length} условий выполнены</span>
          </div>
          {result.checks.map((check) => (
            <div className={check.ok ? "weekly-check weekly-check-ok" : "weekly-check weekly-check-bad"} key={check.label}>
              <Icon name={check.ok ? "check" : "alert"} size={15} />
              <span><b>{check.label}</b><small>{check.detail}</small></span>
            </div>
          ))}
        </div>
      )}
      {result.warnings.length > 0 && (
        <ul className="x-warnings">
          {result.warnings.map((warning) => <li className="optimizer-warning" key={warning}><Icon name="alert" size={15} /><span>{warning}</span></li>)}
        </ul>
      )}
    </section>
  );
}

function MonthPlanCard({ plan, startWeek }: { plan: MonthlyPlan; startWeek: number | null }) {
  const hasSwaps = plan.weeks.some((week) => week.swaps.length);
  return (
    <section className="month-plan">
      <div className="month-head">
        <span className="x-dim">{startWeek ? `Недели ${startWeek}–${startWeek + 3}` : "Четыре ближайшие недели"} · до 5 замен в каждой</span>
        <h3>{hasSwaps ? "Последовательность замен на месяц" : "На месяц состав уже лучший в этом пуле"}</h3>
        <p>Каждая неделя считается точно с учётом следующих (вес 1 · ½ · ¼ · ⅛), затем план пересчитывается уже с новым составом и ценами.</p>
        <div className="x-score">
          <div><small>Без замен</small><b>{formatPoints(plan.baselineMonthPoints)}</b></div>
          <Icon name="arrow" size={18} />
          <div><small>После плана</small><b>{formatPoints(plan.projectedMonthPoints)}</b></div>
          <div className={`x-score-gain${plan.gainMonth > 0.05 ? " is-up" : ""}`}><small>за месяц</small><b>{formatSigned(plan.gainMonth)}</b></div>
        </div>
        <span className="month-total-transfers">{plan.transfersUsed} трансферов за месяц</span>
      </div>
      <ol className="month-weeks">
        {plan.weeks.map((week, index) => (
          <li className={`month-week x-thread-item${index === plan.weeks.length - 1 ? " x-thread-last" : ""}`} key={week.offset}>
            <div className="x-rail"><span className="month-week-num">{week.weekNumber ?? week.offset + 1}</span></div>
            <div className="x-post-body">
              <header className="month-week-head">
                <span><b>{capitalize(week.label)}</b><small>{week.transfersUsed} из {week.transfersAvailable} замен · {formatPoints(week.projectedPoints)} очков</small></span>
                <strong className={week.gain > 0.05 ? "is-up" : ""}>{formatSigned(week.gain)}</strong>
              </header>
              {week.swaps.length === 0 ? (
                <p className="month-week-empty">Трансферы не нужны: состав уже лучший на оставшиеся недели.</p>
              ) : (
                <ul className="month-swaps">
                  {week.swaps.map((swap) => (
                    <li className="month-swap" key={`${week.offset}-${swap.outgoing.id}-${swap.incoming.id}`}>
                      <span className="month-swap-pair">
                        <span className="month-swap-out">{swap.outgoing.name}</span>
                        <Icon name="arrow" size={14} />
                        <b>{swap.incoming.name}</b>
                      </span>
                      <small>
                        {roleShort(swap.incoming.position)} · {swap.incoming.club} · {formatNumber(swap.incoming.price)} · {formatSigned(swap.weekGain)} на этой неделе
                        {swap.futureGames > 0 ? ` · ещё ${swap.futureGames} матчей дальше` : " · только под этот тур"}
                        {swap.leavesInWeek !== null ? ` · продать на неделе ${plan.weeks[swap.leavesInWeek]?.weekNumber ?? swap.leavesInWeek + 1}` : ""}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
              {week.keptFromEarlier.length > 0 && <p className="month-kept">Остаются с прошлых недель: {week.keptFromEarlier.join(", ")}</p>}
            </div>
          </li>
        ))}
      </ol>
      {plan.warnings.length > 0 && (
        <ul className="x-warnings">
          {plan.warnings.map((warning) => <li className="optimizer-warning" key={warning}><Icon name="alert" size={15} /><span>{warning}</span></li>)}
        </ul>
      )}
    </section>
  );
}

function LeagueModule({
  profile,
  variant,
  weeksLeft,
  onWeeksLeft,
  tourFact,
}: {
  profile: TeamProfile;
  variant: "main" | "side";
  weeksLeft: number | null;
  onWeeksLeft: (value: number | null) => void;
  tourFact: number;
}) {
  if (!profile.league) return null;
  const leagueHasScore = profile.leagueSeasonPoints !== undefined && profile.leaderPoints !== undefined;
  const leagueGap = profile.gapToFirst ?? (leagueHasScore ? Math.max(0, (profile.leaderPoints ?? 0) - (profile.leagueSeasonPoints ?? 0)) : null);
  const standings = (profile.leagueStandings ?? [])
    .filter((standing) => standing.rank <= 2 || standing.isCurrent)
    .sort((a, b) => a.rank - b.rank);
  const inputId = `weeks-left-${variant}`;
  const share = Math.max(2, Math.min(100, ((profile.leagueSeasonPoints ?? 0) / Math.max(1, profile.leaderPoints ?? 1)) * 100));
  return (
    <section className={`x-module league-module league-module-${variant}`} aria-label="Ваша лига">
      <h2 className="x-module-title">Ваша лига</h2>
      <div className="league-body">
        <div className="league-head">
          <span className="league-name"><Icon name="trophy" size={16} /> {profile.league}</span>
          {profile.leagueRank ? <span className="x-dim">{profile.leagueRank} из {profile.leagueTotal ?? "—"}</span> : null}
        </div>
        <p className="league-gap">{leagueGap === 0 ? "Вы на первом месте" : <>До первого места <b>{leagueGap === null ? "—" : formatNumber(leagueGap)}</b></>}</p>
        {leagueHasScore && (
          <>
            <div className="league-track" aria-hidden="true"><span style={{ width: `${share}%` }} /></div>
            <p className="league-caption">Вы <b>{formatNumber(profile.leagueSeasonPoints)}</b> · лидер «{profile.leaderName ?? "таблицы"}» <b>{formatNumber(profile.leaderPoints)}</b></p>
          </>
        )}
      </div>
      {standings.length > 0 && (
        <ol className="league-table">
          {standings.map((standing) => (
            <li className={`league-row${standing.isCurrent ? " league-row-current" : ""}`} key={standing.teamId}>
              <span className="league-rank">{standing.rank}</span>
              <span className="x-avatar x-avatar-sm x-avatar-team" aria-hidden="true">{initials(standing.teamName)}</span>
              <span className="league-team"><b>{standing.teamName}</b><small>@{standing.manager}</small></span>
              <strong>{formatNumber(standing.seasonPoints)}</strong>
            </li>
          ))}
        </ol>
      )}
      <div className="league-pace">
        <label htmlFor={inputId}>До конца сезона, туров</label>
        <input
          id={inputId}
          className="x-input-sm"
          type="number"
          min="1"
          max="40"
          inputMode="numeric"
          value={weeksLeft ?? ""}
          placeholder="—"
          onChange={(event: ChangeEvent<HTMLInputElement>) => onWeeksLeft(event.target.value.trim() ? Math.max(1, Math.min(40, Number(event.target.value) || 1)) : null)}
        />
        <small>{weeksLeft && leagueGap !== null ? (leagueGap === 0 ? "Вы лидируете — удерживайте темп" : `Цель: отыгрывать ≈ ${formatNumber(Math.ceil(leagueGap / weeksLeft))} очков за тур`) : "Укажите, чтобы рассчитать темп погони"}</small>
      </div>
      {variant === "main" && (
        <p className="league-fact">Факт тура по очкам игроков: <b>{formatPoints(tourFact)}</b>. Таблица лиги: {formatPoints(profile.leagueTourPoints ?? 0)} — может обновляться с задержкой.</p>
      )}
      {profile.leagueUrl && (
        <a className="x-module-link" href={profile.leagueUrl} target="_blank" rel="noreferrer">Открыть таблицу лиги</a>
      )}
    </section>
  );
}

export default function FantasyDashboard() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const automaticRoster = useRef<FantasyPlayer[]>([]);
  const appliedSnapshot = useRef("");
  const scrollToPlan = useRef(false);
  const [players, setPlayers] = useState<FantasyPlayer[]>([]);
  const [settings, setSettings] = useState<OptimizerSettings>(DEFAULT_SETTINGS);
  const [weeksLeft, setWeeksLeft] = useState<number | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<FantasyPlayer | null>(null);
  const [addingPlayer, setAddingPlayer] = useState(false);
  const [calculation, setCalculation] = useState<{ value: OptimizationResult; players: FantasyPlayer[]; settings: OptimizerSettings } | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [planningMonth, setPlanningMonth] = useState(false);
  const [monthCalculation, setMonthCalculation] = useState<{ value: MonthlyPlan; players: FantasyPlayer[]; settings: OptimizerSettings } | null>(null);
  const [search, setSearch] = useState("");
  const [sideQuery, setSideQuery] = useState("");
  const [positionFilter, setPositionFilter] = useState<Position | "all">("all");
  const [rosterView, setRosterView] = useState<RosterView>("owned");
  const [marketSearch, setMarketSearch] = useState("");
  const [marketPosition, setMarketPosition] = useState<Position | "all">("all");
  const applySnapshot = useCallback((data: SportsSyncData) => {
    automaticRoster.current = data.roster;
    if (appliedSnapshot.current === data.fetchedAt) return;
    appliedSnapshot.current = data.fetchedAt;
    setPlayers((previous) => mergeSportsPlayers(previous, data.roster, data.candidates));
    setSettings((current) => ({
      ...current,
      budget: data.profile.budgetLimit ?? current.budget,
      transfersAvailable: Math.max(0, Math.min(5, data.profile.transfersLeft ?? 5 - (data.profile.transfersUsed ?? 0))),
    }));
  }, []);
  const { data: sportsData, status: profileState, error: profileError, refresh } = useSportsSync(CONNECTED_TEAM_ID, applySnapshot);
  const profile = sportsData?.profile ?? PROFILE_SNAPSHOT;
  const ratedPlayers = sportsData?.ratedPlayers ?? EMPTY_RATINGS;
  const lastSync = sportsData?.fetchedAt ?? "";
  const synced = profileState === "synced";
  const marketState = sportsData ? (ratedPlayers.length ? "ready" : "error") : profileState === "loading" ? "loading" : "error";
  const result = calculation?.players === players && calculation?.settings === settings ? calculation.value : null;
  const monthPlan = monthCalculation?.players === players && monthCalculation.settings === settings ? monthCalculation.value : null;
  const startWeek = Number(profile.week?.match(/\d+/)?.[0]) || null;

  useEffect(() => {
    // Hydrate the optional local cache after the server-rendered first frame.
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem("khl-fantasy-planner-v1");
        if (raw) {
          const saved = JSON.parse(raw) as { players?: unknown[]; settings?: Partial<OptimizerSettings>; weeksLeft?: number | null };
          if (saved.weeksLeft !== undefined) setWeeksLeft(saved.weeksLeft);
          if (!appliedSnapshot.current) {
            if (Array.isArray(saved.players)) setPlayers(saved.players.map(storagePlayer).filter((player): player is FantasyPlayer => Boolean(player)));
            if (saved.settings) setSettings((current) => ({ ...current, ...saved.settings, horizonWeeks: 1 }));
          }
        }
      } catch {
        // Storage may be disabled; live synchronization remains available.
      }
      setStorageReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem("khl-fantasy-planner-v1", JSON.stringify({ players, settings, weeksLeft, savedAt: new Date().toISOString() }));
    } catch {
      // Keep the planner usable if browser storage is unavailable or full.
    }
  }, [players, settings, weeksLeft, storageReady]);

  useEffect(() => {
    if (!scrollToPlan.current || !result) return;
    scrollToPlan.current = false;
    document.getElementById("week-plan")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result]);

  const readiness = useMemo(() => getDatasetReadiness(players), [players]);
  const projections = useMemo(() => projectPlayers(players, 1), [players]);
  const projectionMap = useMemo(() => new Map(projections.map((player) => [player.id, player])), [projections]);
  const candidateComparisons = useMemo(
    () => compareCandidatesToRoster(players, settings, synced),
    [players, settings, synced],
  );
  const ownedPlayers = useMemo(() => players.filter((player) => player.owned), [players]);
  const candidatePlayers = useMemo(() => players.filter((player) => !player.owned), [players]);
  const filteredPlayers = useMemo(() => {
    const text = search.trim().toLocaleLowerCase("ru-RU");
    return players.filter((player) => {
      const searchMatch = !text || `${player.name} ${player.club}`.toLocaleLowerCase("ru-RU").includes(text);
      const positionMatch = positionFilter === "all" || player.position === positionFilter;
      const ownershipMatch = rosterView === "all" || (rosterView === "owned" ? player.owned : !player.owned);
      return searchMatch && positionMatch && ownershipMatch;
    });
  }, [players, positionFilter, search, rosterView]);
  const filteredRatedPlayers = useMemo(() => {
    const text = marketSearch.trim().toLocaleLowerCase("ru-RU");
    return ratedPlayers.filter((player) => {
      const matchText = !text || `${player.name} ${player.club}`.toLocaleLowerCase("ru-RU").includes(text);
      const matchPosition = marketPosition === "all" || player.position === marketPosition;
      return matchText && matchPosition;
    });
  }, [marketPosition, marketSearch, ratedPlayers]);
  const topCandidates = useMemo(() => candidatePlayers
    .map((player) => ({ player, comparison: candidateComparisons.get(player.id) }))
    .filter((item): item is { player: FantasyPlayer; comparison: CandidateComparison } => Boolean(item.comparison?.outgoing) && (item.comparison?.gain ?? 0) > 0.05)
    .sort((a, b) => (b.comparison.gain ?? 0) - (a.comparison.gain ?? 0))
    .slice(0, 3), [candidatePlayers, candidateComparisons]);
  const improvingCount = useMemo(() => [...candidateComparisons.values()].filter((item) => item.status === "improves").length, [candidateComparisons]);
  const sideMatches = useMemo(() => {
    const text = sideQuery.trim().toLocaleLowerCase("ru-RU");
    if (!text) return [];
    return players.filter((player) => `${player.name} ${player.club}`.toLocaleLowerCase("ru-RU").includes(text)).slice(0, 6);
  }, [players, sideQuery]);
  const weeklyTransferLimit = profile.weeklyTransfersLimit ?? 5;
  const transfersLeft = Math.max(0, Math.min(weeklyTransferLimit, profile.transfersLeft ?? weeklyTransferLimit - (profile.transfersUsed ?? 0)));
  const rankPercent = profile.rank && profile.totalTeams ? Math.max(1, Math.round((profile.rank / profile.totalTeams) * 100)) : null;
  const manager = profile.leagueStandings?.find((standing) => standing.isCurrent)?.manager;
  const tourFact = Math.max(profile.leagueTourPoints ?? 0, ownedPlayers.reduce((sum, player) => sum + (player.earnedWeekPoints ?? 0), 0));
  const lockedOwned = ownedPlayers.filter((player) => player.locked).length;
  const syncTime = lastSync
    ? new Date(lastSync).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" })
    : "";

  function changeSettings<K extends keyof OptimizerSettings>(key: K, value: OptimizerSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function syncSports() {
    void refresh(true);
  }

  function goRoster(view: RosterView) {
    setActiveTab("roster");
    setRosterView(view);
  }

  function openInRoster(player: FantasyPlayer) {
    setActiveTab("roster");
    setRosterView(player.owned ? "owned" : "candidates");
    setPositionFilter("all");
    setSearch(player.name);
    setSideQuery("");
  }

  function savePlayer(player: FantasyPlayer) {
    const duplicate = players.find((item) => item.id !== editingPlayer?.id && playerIdentity(item) === playerIdentity(player));
    if (duplicate?.sportsId) {
      // Open the existing official card instead of replacing it with a manual duplicate.
      setEditingPlayer(duplicate);
      setAddingPlayer(false);
      return;
    }
    if (duplicate) player.id = duplicate.id;
    // Ownership is supplied by Sports.ru, never by edits or an imported CSV.
    player.owned = automaticRoster.current.some((item) => item.id === player.id);
    setPlayers((current) => {
      const index = current.findIndex((item) => item.id === (editingPlayer?.id ?? player.id));
      if (index < 0) return [...current, player];
      const next = [...current];
      next[index] = player;
      return next;
    });
    setEditingPlayer(null);
    setAddingPlayer(false);
  }

  function removePlayer(player: FantasyPlayer) {
    if (player.owned && player.sportsId) return;
    if (!window.confirm(`Удалить ${player.name} из списка?`)) return;
    setPlayers((current) => current.filter((item) => item.id !== player.id));
  }

  function importPlayers(imported: FantasyPlayer[], importedSettings: Partial<OptimizerSettings> | undefined, merge: boolean) {
    setPlayers((current) => {
      const autoRoster = automaticRoster.current.length ? automaticRoster.current : current.filter((player) => player.owned && player.sportsId);
      const autoCandidates = sportsData?.candidates ?? current.filter((player) => !player.owned && player.sportsId);
      const manualCandidates = imported.map((player) => ({ ...player, owned: false, sportsId: undefined }));
      const previousManual = merge ? current.filter((player) => !player.owned && !player.sportsId) : [];
      const map = new Map([...previousManual, ...manualCandidates].map((player) => [playerIdentity(player), player]));
      return mergeSportsPlayers([...map.values()], autoRoster, autoCandidates);
    });
    if (importedSettings?.horizonWeeks) setSettings((current) => ({ ...current, horizonWeeks: 1 }));
    setShowImport(false);
    setActiveTab("roster");
    setRosterView("candidates");
    setSearch("");
  }

  function exportPlayers() {
    const payload = JSON.stringify({ version: 1, teamId: profile.teamId, settings, players }, null, 2);
    const url = URL.createObjectURL(new Blob(["\ufeff", payload], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `khl-fantasy-${profile.teamId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function calculate() {
    if (profileState !== "synced") return;
    setCalculating(true);
    scrollToPlan.current = true;
    window.setTimeout(() => {
      setCalculation({ value: recommendTransfers(players, { ...settings, horizonWeeks: 1 }, { weekNumber: startWeek ?? undefined, bankedTeamPoints: profile.leagueTourPoints }), players, settings });
      setCalculating(false);
    }, 20);
  }

  function startWeekCalculation() {
    setActiveTab("overview");
    if (synced && readiness.canOptimize) calculate();
    else if (profileState !== "loading") syncSports();
  }

  function calculateMonth() {
    if (profileState !== "synced") return;
    setPlanningMonth(true);
    window.setTimeout(() => {
      setMonthCalculation({ value: planMonth(players, settings, startWeek ?? undefined), players, settings });
      setPlanningMonth(false);
    }, 20);
  }

  function addRatedPlayer(player: RatedPlayer) {
    const existing = players.find((item) => playerIdentity(item) === playerIdentity(player));
    if (existing) {
      setEditingPlayer(existing);
      return;
    }
    const newPlayer: FantasyPlayer = {
      id: `sports:${player.position}:${player.club.toLocaleLowerCase("ru-RU")}:${player.name.toLocaleLowerCase("ru-RU")}`,
      name: player.name,
      club: player.club,
      position: player.position,
      price: 0,
      seasonPoints: player.seasonPoints,
      gamesPlayed: 0,
      fantasyAvg: null,
      last5Points: 0,
      last5Games: 0,
      gamesNextWeek: 0,
      gamesWeek2: 0,
      gamesWeek3: 0,
      availability: 1,
      scheduleFactor: 1,
      owned: false,
      priceKnown: false,
      statsKnown: false,
      scheduleKnown: false,
      source: "Публичный рейтинг Sports.ru",
    };
    setPlayers((current) => [...current, newPlayer]);
    setActiveTab("roster");
    setEditingPlayer(newPlayer);
  }

  function selectTab(tab: TabId) {
    setActiveTab(tab);
    window.scrollTo({ top: 0 });
  }

  const pageTitles: Record<TabId, { title: string; subtitle: string }> = {
    overview: { title: "Обзор и расчёт", subtitle: `${profile.teamName} · ${profile.week ?? "Фэнтези КХЛ"}` },
    roster: { title: "Состав и пул", subtitle: `${ownedPlayers.length} из 17 в составе · ${candidatePlayers.length} кандидатов` },
    market: { title: "Рейтинг игроков", subtitle: ratedPlayers.length ? `${ratedPlayers.length} игроков · очки Fantasy за сезон` : "Публичный рейтинг Sports.ru" },
    method: { title: "Правила и тактика", subtitle: "Как считаются замены" },
  };
  const pageTitle = pageTitles[activeTab];

  const connectionCell = (
    <>
      <section className={`team-connection team-connection-${profileState}`} aria-live="polite">
        <span className={`connection-symbol${profileState === "loading" ? " connection-spinning" : ""}`}>
          <Icon name={synced ? "check" : profileState === "loading" ? "refresh" : "clock"} size={18} strokeWidth={2.2} />
        </span>
        <div className="connection-copy">
          <b>
            {profileState === "loading" ? "Загружаем вашу команду из Sports.ru" : synced ? "Команда подключена" : profileState === "stale" ? "Показан сохранённый снимок" : "Синхронизация временно недоступна"}
            {sportsData && <span className="connection-count">{sportsData.roster.length} / 17 игроков</span>}
          </b>
          <p>
            <a href={profile.profileUrl} target="_blank" rel="noreferrer">{profile.teamName} · № {profile.teamId}</a>
            <span> · Состав, цены, статистика и календарь — автоматически, каждые 5 минут</span>
            {syncTime ? <span> · {profileState === "stale" || profileState === "error" ? "последний снимок" : "обновлено"} {syncTime} МСК</span> : <span> · первое подключение…</span>}
          </p>
        </div>
      </section>
      {profileError && <div className="x-note x-note-danger sync-note" role="alert"><Icon name="alert" size={16} /><span>{profileError} Последний успешный состав не удалён.</span></div>}
      {sportsData?.stale && <div className="x-note x-note-warning sync-note" role="alert"><Icon name="alert" size={16} /><span>Показан сохранённый состав, а не свежие данные. Расчёт новых замен приостановлен до успешного обновления цен и блокировок.</span></div>}
      {sportsData && sportsData.warnings.length > 0 && (
        <details className="sync-details">
          <summary>Подробности синхронизации · {sportsData.warnings.length}</summary>
          <ul>{sportsData.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </details>
      )}
    </>
  );

  const composerPrompt = profileState === "loading"
    ? "Загружаем вашу команду…"
    : readiness.canOptimize
      ? `Что меняем${startWeek ? ` в туре ${startWeek}` : " в этом туре"}?`
      : readiness.ownedCount === 17 ? "Состав загружен — проверяем данные" : "Сайт сам подтянет вашу команду";
  const composerText = readiness.canOptimize
    ? `Все 17 игроков, цены и матчи тура получены автоматически. Для сравнения готовы ${readiness.readyCandidateCount} кандидатов. Расчёт учитывает только этот тур и уже набранные очки.`
    : profileState === "loading"
      ? `Загружаем состав № ${profile.teamId}, затем карточки игроков со статистикой и календарём. Ничего вводить вручную не нужно.`
      : "Не все карточки статистики или кандидаты доступны в источнике. Сайт повторит загрузку автоматически, либо нажмите «Обновить данные».";
  const canCalculate = synced && readiness.canOptimize;

  return (
    <div className="x-app">
      <header className="x-nav">
        <div className="x-nav-inner">
          <a className="x-logo" href="#overview" aria-label="Ледовый штаб — главная" onClick={(event) => { event.preventDefault(); selectTab("overview"); }}>
            <Icon name="logo" size={30} strokeWidth={2} />
          </a>
          <nav className="x-nav-list" aria-label="Разделы приложения">
            {NAV_ITEMS.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  className={`x-nav-item${active ? " is-active" : ""}`}
                  onClick={() => selectTab(item.id)}
                  title={item.id === "roster" && improvingCount > 0 ? `${item.label} · есть выгодные кандидаты` : item.label}
                >
                  <span className="x-nav-icon">
                    <Icon name={item.icon} size={26} strokeWidth={active ? 2.4 : 1.8} />
                    {item.id === "roster" && improvingCount > 0 && <span className="x-nav-dot" aria-hidden="true" />}
                  </span>
                  <span className="x-nav-label">{item.label}</span>
                </button>
              );
            })}
          </nav>
          <button className="x-pill x-pill-primary x-pill-lg x-nav-cta" type="button" aria-label="Рассчитать неделю" onClick={startWeekCalculation} disabled={calculating}>
            <span className="x-nav-cta-icon"><Icon name="spark" size={22} strokeWidth={2.2} /></span>
            <span className="x-nav-cta-label">Рассчитать неделю</span>
          </button>
          <a className="x-account" href={profile.profileUrl} target="_blank" rel="noreferrer" aria-label={`Команда ${profile.teamName} на Sports.ru`}>
            <Avatar name={profile.teamName} size="sm" />
            <span className="x-account-copy"><b>{profile.teamName}</b><small>@{manager ?? `team${profile.teamId}`}</small></span>
            <span className="x-account-more"><Icon name="more" size={18} /></span>
          </a>
        </div>
      </header>

      <main className="x-main" id="main">
        <div className="x-sticky">
          <div className="x-sticky-title">
            <span className="x-mobile-logo" aria-hidden="true"><Icon name="logo" size={24} strokeWidth={2} /></span>
            <div>
              <h1>{pageTitle.title}</h1>
              <span>{pageTitle.subtitle}</span>
            </div>
          </div>
          {activeTab === "roster" && (
            <Tabs
              className="roster-view-tabs"
              label="Показать игроков"
              value={rosterView}
              onChange={setRosterView}
              items={[
                { id: "owned", label: <>Моя команда <span className="x-tab-count">{ownedPlayers.length}</span></> },
                { id: "candidates", label: <>Кандидаты <span className="x-tab-count">{candidatePlayers.length}</span></> },
                { id: "all", label: "Все игроки" },
              ]}
            />
          )}
          {activeTab === "market" && (
            <Tabs
              label="Позиция"
              value={marketPosition}
              onChange={setMarketPosition}
              items={[
                { id: "all", label: "Все" },
                { id: "G", label: "Вратари" },
                { id: "D", label: "Защитники" },
                { id: "F", label: "Нападающие" },
              ]}
            />
          )}
        </div>

        {activeTab === "overview" && (
          <>
            <section className="x-profile" aria-label="Профиль команды">
              <div className="x-banner" aria-hidden="true" />
              <div className="x-profile-top">
                <span className="x-profile-avatar" aria-hidden="true">{initials(profile.teamName)}</span>
                <div className="x-profile-actions">
                  <a className="x-icon-btn x-icon-btn-outline" href={profile.profileUrl} target="_blank" rel="noreferrer" aria-label="Команда на Sports.ru" title="Команда на Sports.ru"><Icon name="external" size={18} /></a>
                  <button className={`x-icon-btn x-icon-btn-outline${profileState === "loading" ? " is-spinning" : ""}`} type="button" onClick={syncSports} aria-label="Обновить состав" title="Обновить состав, цены и статистику Sports.ru" disabled={profileState === "loading"}><Icon name="refresh" size={18} /></button>
                  <button className="x-pill x-pill-outline" type="button" onClick={() => goRoster("owned")}>Мой состав</button>
                </div>
              </div>
              <div className="x-profile-info">
                <h2 className="x-profile-name">{profile.teamName} {synced && <VerifiedMark />}</h2>
                <span className="x-handle">@{manager ?? `team${profile.teamId}`} · ID {profile.teamId}</span>
                <p className="x-bio">Фэнтези КХЛ на Sports.ru. Каждый трансфер должен приносить очки: прогноз, бюджет, позиции и лимит клубов проверяются автоматически.</p>
                <ul className="x-profile-meta">
                  {profile.week && <li><Icon name="calendar" size={17} /> {capitalize(profile.week)}{profile.deadline ? ` · дедлайн ${profile.deadline}` : ""}</li>}
                  {profile.league && <li><Icon name="trophy" size={17} /> «{profile.league}» · {profile.leagueRank ?? "—"} из {profile.leagueTotal ?? "—"}</li>}
                  {profile.supporterLeague && <li><Icon name="shield" size={17} /> {profile.supporterLeague}{profile.supporterLeagueRank ? ` · ${profile.supporterLeagueRank}-е место` : ""}</li>}
                </ul>
                <div className="x-profile-stats" aria-label="Показатели команды">
                  <span><b>{profile.rank ? `№ ${formatNumber(profile.rank)}` : "—"}</b> из {profile.totalTeams ? formatNumber(profile.totalTeams) : "—"}{rankPercent ? ` · топ ${rankPercent}%` : ""}</span>
                  <span><b>{formatNumber(profile.teamValue)}</b> стоимость</span>
                  <span><b>{formatNumber(profile.balance)}</b> баланс</span>
                  <span><b>{formatNumber(transfersLeft)}/{weeklyTransferLimit}</b> трансферов</span>
                </div>
              </div>
            </section>

            {connectionCell}

            <section className="x-composer" aria-label="Расчёт недели">
              <Avatar name={profile.teamName} />
              <div className="x-composer-body">
                <p className="x-composer-prompt">{composerPrompt}</p>
                <p className="x-composer-text">{composerText}</p>
                {ownedPlayers.length > 0 && (
                  <div className="synced-roster-preview" aria-label="Автоматически загруженный состав">
                    {ownedPlayers.map((player) => (
                      <button
                        key={player.id}
                        type="button"
                        className={`x-chip role-chip-${player.position}`}
                        title={`${player.name} · ${player.club} · ${formatNumber(player.price)}${player.locked ? " · трансфер заблокирован" : ""}`}
                        onClick={() => goRoster("owned")}
                      >
                        <span className="x-chip-role">{roleShort(player.position)}</span>
                        {surname(player.name)}
                        {player.locked && <Icon name="lock" size={11} />}
                      </button>
                    ))}
                  </div>
                )}
                <div className="x-composer-checks">
                  <span className={readiness.ownedCount === 17 ? "check-done" : "check-pending"}><Icon name={readiness.ownedCount === 17 ? "check" : "clock"} size={14} /> Состав {readiness.ownedCount}/17</span>
                  <span className={readiness.incompleteOwned.length === 0 && readiness.ownedCount > 0 ? "check-done" : "check-pending"}><Icon name={readiness.incompleteOwned.length === 0 && readiness.ownedCount > 0 ? "check" : "clock"} size={14} /> Цены, очки и календарь</span>
                  <span className={readiness.readyCandidateCount > 0 ? "check-done" : "check-pending"}><Icon name={readiness.readyCandidateCount > 0 ? "check" : "clock"} size={14} /> Пул: {readiness.readyCandidateCount}</span>
                </div>
                <div className="x-composer-bar">
                  <span className="x-composer-hint"><Icon name="lock" size={15} /> Замены не отправляются в Sports.ru</span>
                  <button className="x-pill x-pill-primary" type="button" disabled={profileState === "loading" || calculating} onClick={canCalculate ? calculate : syncSports}>
                    {profileState === "loading" ? "Загружаем…" : calculating ? "Считаем…" : canCalculate ? "Рассчитать неделю" : "Обновить данные"}
                  </button>
                </div>
              </div>
            </section>

            <section className="x-section week-section" id="week-plan" aria-labelledby="week-title">
              <div className="x-section-head">
                <h2 id="week-title">Замены на неделю{startWeek ? ` ${startWeek}` : ""}</h2>
                <button className="x-pill x-pill-outline x-pill-sm" type="button" onClick={calculate} disabled={calculating || !synced || !result}>Пересчитать</button>
              </div>
              {calculating && !result ? (
                <div className="x-loading" role="status"><span className="x-spinner" /> Перебираем комбинации замен…</div>
              ) : result ? (
                result.ready ? <SwapThread result={result} /> : (
                  <div className="x-cell x-cell-error">
                    <Icon name="alert" size={20} />
                    <div>
                      <b>Расчёт пока невозможен</b>
                      <p>{result.reason}</p>
                      <button className="x-link-btn" type="button" onClick={() => goRoster("owned")}>Проверить данные состава <Icon name="arrow" size={14} /></button>
                    </div>
                  </div>
                )
              ) : (
                <div className="x-empty x-empty-compact">
                  <b>{canCalculate ? "План замен ещё не рассчитан" : "Ждём данные для расчёта"}</b>
                  <span>{canCalculate ? "Нажмите «Рассчитать неделю» — точный перебор по всему пулу займёт несколько секунд." : "Как только состав, цены и календарь загрузятся, расчёт станет доступен."}</span>
                </div>
              )}
            </section>

            <details className="month-experiment">
              <summary>
                <span className="month-summary-icon"><Icon name="calendar" size={18} /></span>
                <span><b>Сценарий на месяц</b><small>Дополнительно · не недельная рекомендация</small></span>
                <span className="month-summary-chevron"><Icon name="chevron" size={18} /></span>
              </summary>
              <div className="month-experiment-body">
                <div className="month-experiment-intro">
                  <p>Один тур не показывает весь выигрыш. Калькулятор проверит до пяти замен на каждую из четырёх недель: игрок берётся, только если он полезен и дальше, либо план прямо скажет, когда его продать.</p>
                  <button className="x-pill x-pill-outline x-pill-sm" type="button" onClick={calculateMonth} disabled={planningMonth || !synced}>{planningMonth ? "Считаем месяц…" : "Рассчитать месяц"}</button>
                </div>
                {monthPlan && (monthPlan.ready ? <MonthPlanCard plan={monthPlan} startWeek={startWeek} /> : (
                  <div className="x-cell x-cell-error"><Icon name="alert" size={20} /><div><b>Месячный план пока невозможен</b><p>{monthPlan.reason}</p></div></div>
                ))}
              </div>
            </details>

            <div className="x-inline-league">
              <LeagueModule profile={profile} variant="main" weeksLeft={weeksLeft} onWeeksLeft={setWeeksLeft} tourFact={tourFact} />
            </div>

            <section className="x-section settings-section" aria-labelledby="settings-title">
              <div className="x-section-head"><h2 id="settings-title">Условия расчёта</h2></div>
              <div className="x-setting-row">
                <div><b>Общий бюджет команды</b><small>Автоматически: стоимость состава + баланс</small></div>
                <input className="x-input-sm" aria-label="Бюджет" readOnly title="Актуальный бюджет из Sports.ru" inputMode="numeric" value={settings.budget} />
              </div>
              <div className="x-setting-row">
                <div><b>Доступно трансферов</b><small>Максимум 5 за игровую неделю · по Sports.ru осталось {transfersLeft}</small></div>
                <input
                  className="x-input-sm"
                  aria-label="Доступно трансферов"
                  inputMode="numeric"
                  value={settings.transfersAvailable}
                  onChange={(event) => changeSettings("transfersAvailable", Math.max(0, Math.min(transfersLeft, Math.floor(Number(event.target.value) || 0))))}
                />
              </div>
              <div className="x-setting-row">
                <div><b>Горизонт</b><small>Цель — очки текущего тура; следующие недели решают только при равенстве</small></div>
                <span className="x-tag"><Icon name="check" size={14} /> 1 неделя</span>
              </div>
              <p className="x-section-foot"><Icon name="shield" size={15} /> 2 ВР · 6 ЗАЩ · 9 НАП · не более 3 игроков из клуба · блокировка за 30 минут до матча</p>
            </section>

            <footer className="x-footer">
              <span>{synced ? `Данные Sports.ru обновлены ${syncTime} МСК` : "Стартовый снимок профиля — данные обновятся автоматически"}</span>
              <span>Прогноз — оценка, не гарантия результата. Проверяйте статусы и дедлайны в Sports.ru.</span>
            </footer>
          </>
        )}

        {activeTab === "roster" && (
          <>
            {connectionCell}
            <div className="roster-health" aria-label="Позиции в составе">
              {POSITION_ORDER.map((position) => {
                const full = readiness.ownedByPosition[position] === readiness.expectedByPosition[position];
                return (
                  <span className={`roster-health-item${full ? " is-full" : ""}`} key={position}>
                    <span className={`x-chip-role role-text-${position}`}>{roleShort(position)}</span>
                    <b>{readiness.ownedByPosition[position]}/{readiness.expectedByPosition[position]}</b>
                    <Icon name={full ? "check" : "alert"} size={14} />
                  </span>
                );
              })}
              <span className="roster-health-item"><span className="x-chip-role">ПУЛ</span><b>{readiness.readyCandidateCount}/{readiness.candidateCount}</b><small>готовы</small></span>
            </div>
            <div className="x-toolbar">
              <div className="x-toolbar-filters">
                <label className="x-search">
                  <Icon name="search" size={18} />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Имя или клуб" aria-label="Поиск по имени или клубу" />
                  {search && <button className="x-search-clear" type="button" aria-label="Очистить поиск" onClick={() => setSearch("")}><Icon name="close" size={14} /></button>}
                </label>
                <select className="x-select" value={positionFilter} onChange={(event) => setPositionFilter(event.target.value as Position | "all")} aria-label="Фильтр по позиции">
                  <option value="all">Все позиции</option>
                  <option value="G">Вратари</option>
                  <option value="D">Защитники</option>
                  <option value="F">Нападающие</option>
                </select>
              </div>
              <div className="x-toolbar-actions">
                <button className="x-pill x-pill-primary x-pill-sm" type="button" onClick={syncSports} disabled={profileState === "loading"}><Icon name="refresh" size={16} /> Обновить состав</button>
                <button className="x-pill x-pill-outline x-pill-sm" type="button" onClick={() => setShowImport(true)}><Icon name="upload" size={16} /> Доп. кандидаты</button>
                <button className="x-pill x-pill-outline x-pill-sm" type="button" onClick={exportPlayers} disabled={!players.length}><Icon name="download" size={16} /> Экспорт JSON</button>
                <button className="x-pill x-pill-outline x-pill-sm" type="button" onClick={() => { setAddingPlayer(true); setEditingPlayer(null); }}><Icon name="plus" size={16} /> Добавить кандидата</button>
              </div>
            </div>
            {rosterView !== "owned" && sportsData && <p className="x-note candidate-source-note"><Icon name="people" size={16} /><span>{sportsData.candidateSource}</span></p>}
            {rosterView !== "owned" && (
              <p className="x-note x-note-info candidate-comparison-note">
                <Icon name="target" size={16} />
                <span><b>Кого заменить?</b> Для каждого кандидата — лучший подходящий игрок вашей команды и очки обоих за оставшиеся матчи недели. Уже набранные очки вашего игрока сохраняются. Это проверка одной замены, а не план нескольких обменов: его даёт «Рассчитать неделю». Если трансферы закончились или покупка закрыта, разница показана только для ориентировки.</span>
              </p>
            )}
            {readiness.incompleteOwned.length > 0 && <p className="x-note x-note-warning inline-alert"><Icon name="alert" size={16} /><span>{readiness.incompleteOwned.length} карточек состава ещё не получили всю статистику из Sports.ru. Следующее обновление автоматически повторит загрузку.</span></p>}
            <div className="x-list-caption">
              <b>{rosterView === "owned" ? "Текущий состав Sports.ru" : rosterView === "candidates" ? "Пул для сравнения" : "Все игроки"}</b>
              <span>{filteredPlayers.length} игроков{lockedOwned ? ` · ${lockedOwned} в составе заблокированы для трансферов` : ""}</span>
            </div>
            <PlayerTable players={filteredPlayers} projections={projectionMap} comparisons={candidateComparisons} showComparisons={rosterView !== "owned"} showCandidateCards={rosterView === "candidates"} onEdit={setEditingPlayer} onRemove={removePlayer} />
            <p className="x-note roster-privacy-note"><Icon name="lock" size={16} /><span>Сайт читает публичный состав Sports.ru и хранит резервный снимок на сервере. Пароль не нужен; трансферы в вашей команде сайт не выполняет.</span></p>
          </>
        )}

        {activeTab === "market" && (
          <>
            {connectionCell}
            <div className="x-toolbar x-toolbar-single">
              <label className="x-search">
                <Icon name="search" size={18} />
                <input value={marketSearch} onChange={(event) => setMarketSearch(event.target.value)} placeholder="Поиск по рейтингу" aria-label="Поиск по рейтингу" />
                {marketSearch && <button className="x-search-clear" type="button" aria-label="Очистить поиск" onClick={() => setMarketSearch("")}><Icon name="close" size={14} /></button>}
              </label>
            </div>
            <article className="x-cell market-intro">
              <span className="x-avatar x-avatar-md x-avatar-brand" aria-hidden="true"><Icon name="chart" size={20} /></span>
              <div>
                <b>Рейтинг Sports.ru — ориентир, а не прогноз</b>
                <p>Пул для замен уже собирается автоматически из составов всех соперников вашей лиги — с ценами, формой и календарём. Этот рейтинг помогает найти дополнительных кандидатов за его пределами.</p>
                <a className="x-link" href="https://www.sports.ru/fantasy/hockey/tournament/ratings/best/107.html" target="_blank" rel="noreferrer">Источник рейтинга <Icon name="external" size={13} /></a>
              </div>
            </article>
            {marketState === "loading" && <div className="x-loading" role="status"><span className="x-spinner" /> Читаем открытый рейтинг Sports.ru…</div>}
            {marketState === "error" && ratedPlayers.length === 0 && (
              <div className="x-empty">
                <b>Открытый рейтинг пока недоступен</b>
                <span>Повторите синхронизацию или добавьте кандидатов вручную. Оптимизатор работает и без рейтинга.</span>
                <button className="x-pill x-pill-outline x-pill-sm" type="button" onClick={syncSports}><Icon name="refresh" size={15} /> Повторить синхронизацию</button>
              </div>
            )}
            {ratedPlayers.length > 0 && (
              <ol className="market-list" aria-label="Лучшие игроки сезона">
                {filteredRatedPlayers.map((rated) => {
                  const existing = players.find((player) => playerIdentity(player) === playerIdentity(rated));
                  return (
                    <li className="market-row" key={`${rated.rank}-${rated.name}-${rated.club}`}>
                      <span className="market-rank">{rated.rank}</span>
                      <Avatar name={rated.name} position={rated.position} />
                      <span className="market-identity">
                        <b>{rated.name}</b>
                        <small><span className={`role-text-${rated.position}`}>{roleShort(rated.position)}</span> · {rated.club}{existing?.owned ? " · в вашем составе" : ""}</small>
                      </span>
                      <span className="market-points"><b>{formatNumber(rated.seasonPoints)}</b><small>очков</small></span>
                      {existing ? (
                        <button className="x-pill x-pill-ghost x-pill-sm market-action" type="button" title="Открыть карточку игрока" onClick={() => setEditingPlayer(existing)}><Icon name="check" size={16} /><span className="market-action-label">В списке</span></button>
                      ) : (
                        <button className="x-pill x-pill-light x-pill-sm market-action" type="button" title="Добавить в пул кандидатов" onClick={() => addRatedPlayer(rated)}><Icon name="plus" size={16} /><span className="market-action-label">В пул</span></button>
                      )}
                    </li>
                  );
                })}
                {filteredRatedPlayers.length === 0 && <li className="x-empty x-empty-compact"><b>Никого не нашли</b><span>Измените запрос или позицию.</span></li>}
              </ol>
            )}
            <p className="x-note"><Icon name="info" size={16} /><span>Сезонный рейтинг показывает накопленные очки, а не прогноз одного тура. Добавленный игрок попадёт в пул после заполнения цены и календаря.</span></p>
          </>
        )}

        {activeTab === "method" && (
          <>
            <article className="x-article">
              <h2>Считайте будущие матчи, а не громкие фамилии</h2>
              <p>Цель — набирать больше очков на дистанции. Ни одна модель не гарантирует первое место, но дисциплинированный прогноз лучше интуитивных замен.</p>
            </article>
            <section className="x-section" aria-labelledby="facts-title">
              <div className="x-section-head"><h2 id="facts-title">Правила Fantasy КХЛ</h2></div>
              <div className="method-facts">
                <div className="method-fact"><Icon name="people" size={20} /><div><b>2 ВР · 6 ЗАЩ · 9 НАП</b><p>Стартовый бюджет — 20 000; цена меняется после матчей. Позиция игрока фиксирована.</p></div></div>
                <div className="method-fact"><Icon name="shield" size={20} /><div><b>Не больше 3 из клуба</b><p>Лимит проверяется после каждой замены, а не только в итоговом составе.</p></div></div>
                <div className="method-fact"><Icon name="refresh" size={20} /><div><b>До 5 трансферов за неделю</b><p>Замена вступает в силу сразу. Игрок блокируется за 30 минут до своего матча.</p></div></div>
                <div className="method-fact"><Icon name="clock" size={20} /><div><b>Неделя — с понедельника, 04:00</b><p>Клубы проводят разное число матчей, поэтому календарь — половина прогноза.</p></div></div>
              </div>
            </section>
            <section className="x-section" aria-labelledby="scoring-title">
              <div className="x-section-head">
                <h2 id="scoring-title">За что начисляют очки</h2>
                <a className="x-pill x-pill-outline x-pill-sm" href="https://www.sports.ru/fantasy/hockey/tournament/rules/107.html" target="_blank" rel="noreferrer">Полные правила</a>
              </div>
              <div className="table-scroll">
                <table className="scoring-table">
                  <thead><tr><th>Действие</th><th>ВР</th><th>ЗАЩ</th><th>НАП</th></tr></thead>
                  <tbody>
                    {SCORING_ROWS.map((row) => (
                      <tr key={row.action}>
                        <td>{row.action}</td>
                        {[row.goalie, row.defender, row.forward].map((value, index) => (
                          <td key={index} className={value.startsWith("+") ? "scoring-positive" : value.startsWith("−") ? "scoring-negative" : ""}>{value}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="x-section-foot">По правилам турнира Sports.ru. Очки могут начисляться с задержкой до 24 часов после матча.</p>
            </section>
            <section className="x-section" aria-labelledby="model-title">
              <div className="x-section-head"><h2 id="model-title">Как работает калькулятор</h2></div>
              <ol className="model-steps">
                <li className="model-step"><span>1</span><div><b>Очки за матч: свежая форма + цена</b><p>Последние матчи весят больше (полураспад — 6 игр), а короткая выборка сглаживается к уровню, который рынок заложил в цену игрока. Так «горячая» серия из трёх матчей не перевешивает сезон.</p></div></li>
                <li className="model-step"><span>2</span><div><b>Вероятность выхода на лёд</b><p>Пропущенные матчи снижают шанс сыграть, но он постепенно восстанавливается в следующих неделях. Для вратарей — вероятность старта по последним играм.</p></div></li>
                <li className="model-step"><span>3</span><div><b>Соперники и календарь</b><p>Каждый оставшийся матч умножается на силу соперника по забитым и пропущенным шайбам; поправка ограничена, чтобы не переобучиться на малой выборке.</p></div></li>
                <li className="model-step"><span>4</span><div><b>Точный подбор и время замены</b><p>Целочисленная оптимизация по всему пулу: позиции, бюджет на каждом шаге, 3 из клуба, блокировки. Для каждой пары выбирается момент — сразу или после матча уходящего игрока, — и порядок, при котором баланс не уходит в минус.</p></div></li>
                <li className="model-step"><span>5</span><div><b>Месяц — сценарий, а не приказ</b><p>Неделя за неделей: точный расчёт с учётом следующих туров (вес 1 · ½ · ¼ · ⅛), затем пересчёт с новым составом и ценами.</p></div></li>
              </ol>
              <div className="model-formula"><small>Оценка игрока</small><code>Σ по оставшимся матчам: очки/матч × вероятность выхода × сила соперника</code></div>
            </section>
            <section className="x-section" aria-labelledby="tactics-title">
              <div className="x-section-head"><h2 id="tactics-title">Как подниматься в таблице</h2></div>
              <div className="tactics-list">
                <div className="tactic"><b>Смотрите расписание до дедлайна</b><p>Игрок с тремя матчами чаще ценнее громкой фамилии с одним.</p></div>
                <div className="tactic"><b>Меняйте после матча своего игрока</b><p>Если ваш игрок играет раньше новичка, сначала заберите его очки — калькулятор подскажет дату.</p></div>
                <div className="tactic"><b>Сверяйте цену с прогнозом</b><p>Дорогой игрок полезен, только если прирост очков оправдывает бюджет и не ослабляет другие позиции.</p></div>
                <div className="tactic"><b>Не обязаны тратить все пять</b><p>Трансфер — лимит, а не цель. Свободные ходы лучше вложить в подготовку к следующей неделе.</p></div>
              </div>
            </section>
            <nav className="x-sources" aria-label="Источники">
              <a href="https://www.sports.ru/fantasy/hockey/tournament/rules/107.html" target="_blank" rel="noreferrer">Правила Fantasy КХЛ <Icon name="external" size={13} /></a>
              <a href={profile.profileUrl} target="_blank" rel="noreferrer">Профиль команды <Icon name="external" size={13} /></a>
              <a href="https://www.sports.ru/fantasy/hockey/tournament/ratings/best/107.html" target="_blank" rel="noreferrer">Рейтинг игроков <Icon name="external" size={13} /></a>
            </nav>
          </>
        )}
      </main>

      <aside className="x-side" aria-label="Дополнительно">
        <div className="x-side-search">
          <label className="x-search">
            <Icon name="search" size={18} />
            <input
              value={sideQuery}
              onChange={(event) => setSideQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && sideQuery.trim()) {
                  setActiveTab("roster");
                  setRosterView("all");
                  setPositionFilter("all");
                  setSearch(sideQuery.trim());
                  setSideQuery("");
                }
                if (event.key === "Escape") setSideQuery("");
              }}
              placeholder="Поиск игрока или клуба"
              aria-label="Поиск игрока или клуба"
            />
          </label>
          {sideQuery.trim() && (
            <div className="x-search-results">
              {sideMatches.length ? sideMatches.map((player) => (
                <button key={player.id} type="button" className="x-search-result" onClick={() => openInRoster(player)}>
                  <Avatar name={player.name} position={player.position} size="sm" />
                  <span><b>{player.name}</b><small>{roleShort(player.position)} · {player.club} · {player.owned ? "в составе" : "кандидат"}</small></span>
                </button>
              )) : <p className="x-search-empty">Никого не нашли по запросу «{sideQuery.trim()}»</p>}
            </div>
          )}
        </div>
        <LeagueModule profile={profile} variant="side" weeksLeft={weeksLeft} onWeeksLeft={setWeeksLeft} tourFact={tourFact} />
        <section className="x-module" aria-label="Кого взять">
          <h2 className="x-module-title">Кого взять</h2>
          {topCandidates.length ? topCandidates.map(({ player, comparison }) => (
            <div className="x-follow-row" key={player.id}>
              <Avatar name={player.name} position={player.position} size="sm" />
              <span className="x-follow-copy">
                <b>{player.name}</b>
                <small>вместо {comparison.outgoing ? surname(comparison.outgoing.name) : "—"} · <em className={comparison.status === "improves" ? "is-up" : ""}>{formatSigned(comparison.gain)}</em>{comparison.status === "improves" ? "" : " · потенциал"}</small>
              </span>
              <button className="x-pill x-pill-light x-pill-sm" type="button" aria-label={`Сравнить: ${player.name}`} onClick={() => openInRoster(player)}>Сравнить</button>
            </div>
          )) : (
            <p className="x-module-empty">{players.length ? "Одиночная замена сейчас не добавит очков." : "Появится после загрузки состава."}</p>
          )}
          <button className="x-module-link" type="button" onClick={() => goRoster("candidates")}>Показать всех кандидатов</button>
        </section>
        <footer className="x-side-footer">
          <a href="https://www.sports.ru/fantasy/hockey/tournament/rules/107.html" target="_blank" rel="noreferrer">Правила</a>
          <a href={profile.profileUrl} target="_blank" rel="noreferrer">Sports.ru</a>
          <button type="button" onClick={() => selectTab("method")}>Как считаем</button>
          <span>© {startWeek ? `Тур ${startWeek}` : "Фэнтези КХЛ"} · Ледовый штаб</span>
        </footer>
      </aside>

      <nav className="x-bottom-bar" aria-label="Разделы">
        {NAV_ITEMS.map((item) => {
          const active = activeTab === item.id;
          return (
            <button key={item.id} type="button" aria-label={item.label} aria-current={active ? "page" : undefined} className={active ? "is-active" : ""} onClick={() => selectTab(item.id)}>
              <Icon name={item.icon} size={26} strokeWidth={active ? 2.4 : 1.8} />
              {item.id === "roster" && improvingCount > 0 && <span className="x-nav-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </nav>
      <button className="x-fab" type="button" aria-label="Рассчитать неделю" onClick={startWeekCalculation} disabled={calculating}>
        <Icon name="spark" size={24} strokeWidth={2.2} />
      </button>

      {showImport && <ImportModal onClose={() => setShowImport(false)} onImport={importPlayers} />}
      {(addingPlayer || editingPlayer) && <PlayerEditor key={editingPlayer?.id ?? "new-player"} player={editingPlayer} onClose={() => { setEditingPlayer(null); setAddingPlayer(false); }} onSave={savePlayer} />}
    </div>
  );
}
