import {
  AlertCircle,
  CalendarClock,
  FileText,
  HeartPulse,
  MapPin,
  Plane,
  RefreshCcw,
  UserCircle,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { SiteStatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { MobileAssignment, MobileAssignmentsResponse } from "../types/mobile";

const CACHE_KEY = "kb_mobile_assignments_cache_v1";

type MobileViewMode = "two_weeks" | "year";

type CachePayload = {
  loadedAt: string;
  mode: MobileViewMode;
  data: MobileAssignmentsResponse;
};

type DailyAssignment = {
  key: string;
  date: string;
  assignment: MobileAssignment;
};

type PlaceholderContent = {
  title: string;
  text: string;
};

export function MyAssignmentsPage() {
  const [mode, setMode] = useState<MobileViewMode>("two_weeks");
  const [data, setData] = useState<MobileAssignmentsResponse | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFromCache, setIsFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placeholder, setPlaceholder] = useState<PlaceholderContent | null>(null);

  const range = useMemo(() => getRange(mode), [mode]);

  const loadAssignments = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setIsFromCache(false);
    try {
      const response = await api.myAssignments(range);
      const timestamp = new Date().toISOString();
      const cachePayload: CachePayload = { loadedAt: timestamp, mode, data: response };
      localStorage.setItem(CACHE_KEY, JSON.stringify(cachePayload));
      setData(response);
      setLoadedAt(timestamp);
    } catch (requestError) {
      const cached = readCache();
      if (cached) {
        setData(cached.data);
        setLoadedAt(cached.loadedAt);
        setIsFromCache(true);
        setError("Offline-Anzeige: zuletzt geladene Einsätze werden angezeigt.");
      } else {
        setError(readApiError(requestError, "Einsätze konnten nicht geladen werden."));
      }
    } finally {
      setIsLoading(false);
    }
  }, [mode, range]);

  useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  const today = toIsoDate(startOfToday());
  const tomorrow = toIsoDate(addDays(startOfToday(), 1));
  const dailyAssignments = useMemo(
    () => expandAssignmentsByDay(data?.assignments ?? [], range.start, range.end),
    [data?.assignments, range.end, range.start],
  );
  const nextFourteenDays = useMemo(() => getDayRange(today, 14), [today]);
  const dailyByDate = useMemo(() => groupDailyAssignments(dailyAssignments), [dailyAssignments]);
  const yearGroups = useMemo(
    () => groupAssignmentsForLongView(data?.assignments ?? [], range.start, range.end),
    [data?.assignments, range.end, range.start],
  );

  return (
    <section className="mobile-page mobile-home-page">
      <header className="mobile-home-hero">
        <div>
          <p className="eyebrow">Heute</p>
          <h1>Kalender Baustellen</h1>
          <p>Deine Einsätze, Meldungen und Aufmaße für den Arbeitstag.</p>
        </div>
        <button className="icon-button secondary mobile-refresh-button" type="button" onClick={() => void loadAssignments()}>
          <RefreshCcw aria-hidden="true" size={17} />
          <span>Aktualisieren</span>
        </button>
      </header>

      {loadedAt && (
        <p className={isFromCache ? "cache-note warning" : "cache-note"}>
          Stand: {formatDateTime(loadedAt)}{isFromCache ? " - Lesecache" : ""}
        </p>
      )}
      {error && <p className={isFromCache ? "form-info" : "form-error"}>{error}</p>}
      {isLoading && <div className="empty-panel">Einsätze werden geladen...</div>}

      {!isLoading && (
        <>
          <section className="mobile-home-section">
            <div className="mobile-section-heading">
              <h2>Übersicht</h2>
              <span>Jetzt wichtig</span>
            </div>
            <button
              className="mobile-message-card"
              type="button"
              onClick={() => setPlaceholder({
                title: "Nachrichten und Aufgaben",
                text: "Diese Funktion ist vorbereitet und wird später Hinweise, Aufgaben, Lohn- und Aufmaßmeldungen öffnen.",
              })}
            >
              <AlertCircle aria-hidden="true" size={20} />
              <span>
                <strong>Keine offenen Pflichtmeldungen</strong>
                <small>Nachrichten, Aufgaben und Hinweise erscheinen später hier.</small>
              </span>
            </button>
            <div className="mobile-focus-grid">
              <DayFocusCard date={today} label="Einsatz heute" assignments={dailyByDate.get(today) ?? []} />
              <DayFocusCard date={tomorrow} label="Einsatz morgen" assignments={dailyByDate.get(tomorrow) ?? []} />
            </div>
          </section>

          <section className="mobile-home-section">
            <div className="mobile-section-heading">
              <h2>Meine Einsätze</h2>
              <span>{mode === "two_weeks" ? "Nächste 14 Tage" : "Ganzes Jahr"}</span>
            </div>
            <div className="mobile-segment" role="group" aria-label="Zeitraum">
              <button
                className={mode === "two_weeks" ? "active" : ""}
                type="button"
                onClick={() => setMode("two_weeks")}
              >
                14 Tage
              </button>
              <button
                className={mode === "year" ? "active" : ""}
                type="button"
                onClick={() => setMode("year")}
              >
                Jahr
              </button>
            </div>
            {mode === "two_weeks" ? (
              <div className="mobile-day-list">
                {nextFourteenDays.map((date) => (
                  <DayListCard date={date} assignments={dailyByDate.get(date) ?? []} key={date} />
                ))}
              </div>
            ) : (
              <div className="mobile-day-list">
                {yearGroups.length ? yearGroups.map((group) => (
                  <AssignmentRangeCard group={group} key={group.key} />
                )) : <p className="empty-inline">Keine Einsätze im Zeitraum.</p>}
              </div>
            )}
          </section>

          <section className="mobile-home-section">
            <div className="mobile-section-heading">
              <h2>Melden & Einreichen</h2>
              <span>Vorbereitet</span>
            </div>
            <div className="mobile-action-list">
              <PlaceholderAction
                icon={FileText}
                title="Lohnzettel einreichen"
                text="Hier können später Lohnzettel eingereicht werden."
                onOpen={() => setPlaceholder({
                  title: "Lohnzettel einreichen",
                  text: "Hier können später Lohnzettel eingereicht werden. Die automatische Zuordnung zur Baustelle wird vorbereitet.",
                })}
              />
              <PlaceholderAction
                icon={Plane}
                title="Urlaubsantrag"
                text="Diese Funktion ist vorbereitet und wird später aktiviert."
                onOpen={() => setPlaceholder({
                  title: "Urlaubsantrag",
                  text: "Hier werden später Urlaubsanträge erfasst und an das Büro übergeben.",
                })}
              />
              <PlaceholderAction
                icon={HeartPulse}
                title="Krankmeldung"
                text="Diese Funktion ist vorbereitet und wird später aktiviert."
                onOpen={() => setPlaceholder({
                  title: "Krankmeldung",
                  text: "Hier werden später Krankmeldungen erfasst und mit der persönlichen Akte verknüpft.",
                })}
              />
            </div>
          </section>

          <section className="mobile-home-section">
            <div className="mobile-section-heading">
              <h2>Persönliche Akte</h2>
              <span>Später</span>
            </div>
            <PlaceholderAction
              icon={UserCircle}
              title="Persönliche Informationen"
              text="Diese persönliche Akte wird später Resturlaub, Krankheitstage und weitere Informationen anzeigen."
              onOpen={() => setPlaceholder({
                title: "Persönliche Akte",
                text: "Diese persönliche Akte wird später Resturlaub, Krankheitstage, Statistiken sowie Wagen- und Werkzeugzuordnung anzeigen.",
              })}
            />
          </section>
        </>
      )}

      {placeholder ? <MobilePlaceholderDialog content={placeholder} onClose={() => setPlaceholder(null)} /> : null}
    </section>
  );
}

function DayFocusCard({
  date,
  label,
  assignments,
}: {
  date: string;
  label: string;
  assignments: DailyAssignment[];
}) {
  return (
    <article className="mobile-focus-card">
      <div className="mobile-focus-card-head">
        <span>{label}</span>
        <strong>{formatShortDate(date)}</strong>
      </div>
      {assignments.length ? assignments.map((daily) => (
        <AssignmentCard assignment={daily.assignment} date={date} compact key={daily.key} />
      )) : (
        <p className="empty-inline">Kein Einsatz geplant.</p>
      )}
    </article>
  );
}

function DayListCard({ date, assignments }: { date: string; assignments: DailyAssignment[] }) {
  return (
    <article className="mobile-day-card">
      <div className="mobile-day-card-date">
        <strong>{formatWeekday(date)}</strong>
        <span>{formatShortDate(date)}</span>
      </div>
      <div className="mobile-day-card-content">
        {assignments.length ? assignments.map((daily) => (
          <AssignmentCard assignment={daily.assignment} date={date} compact key={daily.key} />
        )) : <span className="mobile-day-empty">Kein Einsatz geplant</span>}
      </div>
    </article>
  );
}

function AssignmentRangeCard({ group }: { group: AssignmentRangeGroup }) {
  return (
    <Link className="assignment-card assignment-card-link mobile-range-card" to={`/me/assignments/${group.assignment.id}`} state={{ assignment: group.assignment }}>
      <div>
        <p className="assignment-date"><CalendarClock aria-hidden="true" size={15} />{formatRangeLabel(group.start, group.end)}</p>
        <h3>{group.assignment.site.name}</h3>
        <p className="muted-text">{[group.assignment.site.site_number, group.assignment.site.customer].filter(Boolean).join(" · ")}</p>
      </div>
      <SiteStatusBadge status={group.assignment.site.status} />
    </Link>
  );
}

function PlaceholderAction({
  icon: Icon,
  title,
  text,
  onOpen,
}: {
  icon: typeof FileText;
  title: string;
  text: string;
  onOpen: () => void;
}) {
  return (
    <button className="mobile-action-card" type="button" onClick={onOpen}>
      <Icon aria-hidden="true" size={20} />
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
    </button>
  );
}

function MobilePlaceholderDialog({ content, onClose }: { content: PlaceholderContent; onClose: () => void }) {
  return (
    <div className="mobile-dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="mobile-placeholder-dialog" role="dialog" aria-modal="true" aria-labelledby="mobile-placeholder-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="mobile-placeholder-title">{content.title}</h2>
        <p>{content.text}</p>
        <button className="primary-action" type="button" onClick={onClose}>Schließen</button>
      </div>
    </div>
  );
}

function AssignmentCard({ assignment, date, compact = false }: { assignment: MobileAssignment; date?: string; compact?: boolean }) {
  return (
    <Link className={`assignment-card assignment-card-link${compact ? " is-compact" : ""}`} to={`/me/assignments/${assignment.id}`} state={{ assignment }}>
      <div className="assignment-card-main">
        <div>
          <p className="assignment-date">
            <CalendarClock aria-hidden="true" size={15} />
            {date ? formatShortDate(date) : formatAssignmentRange(assignment)}
          </p>
          <h3>{assignment.site.name}</h3>
          <p className="muted-text">{[assignment.site.site_number, assignment.site.customer].filter(Boolean).join(" · ")}</p>
        </div>
        <SiteStatusBadge status={assignment.site.status} />
      </div>

      {!compact ? (
        <div className="assignment-detail-list">
          {(assignment.site.location || assignment.site.address) && (
            <p><MapPin aria-hidden="true" size={16} /><span>{[assignment.site.location, assignment.site.address].filter(Boolean).join(" - ")}</span></p>
          )}
          {assignment.site.project_manager && (
            <p><UserRound aria-hidden="true" size={16} /><span>{assignment.site.project_manager.display_name}</span></p>
          )}
        </div>
      ) : null}

      {assignment.note && !compact ? <p className="assignment-note">{assignment.note}</p> : null}
    </Link>
  );
}

type AssignmentRangeGroup = {
  key: string;
  assignment: MobileAssignment;
  start: string;
  end: string;
};

function getRange(mode: MobileViewMode): { start: string; end: string } {
  const today = startOfToday();
  return {
    start: toIsoDate(today),
    end: toIsoDate(addDays(today, mode === "year" ? 365 : 13)),
  };
}

function expandAssignmentsByDay(assignments: MobileAssignment[], start: string, end: string): DailyAssignment[] {
  const days: DailyAssignment[] = [];
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  for (const assignment of assignments) {
    const first = maxDate(parseIsoDate(assignment.start_date), startDate);
    const last = minDate(parseIsoDate(assignment.end_date), endDate);
    if (first > last) {
      continue;
    }
    for (let day = first; day <= last; day = addDays(day, 1)) {
      const date = toIsoDate(day);
      days.push({ key: `${assignment.id}:${date}`, date, assignment });
    }
  }
  return days.sort((left, right) => left.date.localeCompare(right.date));
}

function groupDailyAssignments(entries: DailyAssignment[]): Map<string, DailyAssignment[]> {
  const grouped = new Map<string, DailyAssignment[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.date) ?? [];
    list.push(entry);
    grouped.set(entry.date, list);
  }
  return grouped;
}

function groupAssignmentsForLongView(assignments: MobileAssignment[], start: string, end: string): AssignmentRangeGroup[] {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  return assignments
    .map((assignment) => ({
      key: String(assignment.id),
      assignment,
      start: toIsoDate(maxDate(parseIsoDate(assignment.start_date), startDate)),
      end: toIsoDate(minDate(parseIsoDate(assignment.end_date), endDate)),
    }))
    .filter((group) => group.start <= group.end)
    .sort((left, right) => left.start.localeCompare(right.start));
}

function getDayRange(start: string, count: number): string[] {
  const startDate = parseIsoDate(start);
  return Array.from({ length: count }, (_, index) => toIsoDate(addDays(startDate, index)));
}

function readCache(): CachePayload | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) as CachePayload : null;
  } catch {
    return null;
  }
}

function readApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  if (typeof error.detail === "string") {
    return error.detail;
  }
  return error.message;
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function parseIsoDate(date: string): Date {
  return new Date(`${date}T00:00:00`);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function maxDate(left: Date, right: Date): Date {
  return left > right ? left : right;
}

function minDate(left: Date, right: Date): Date {
  return left < right ? left : right;
}

function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(parseIsoDate(date));
}

function formatShortDate(date: string): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" }).format(parseIsoDate(date));
}

function formatWeekday(date: string): string {
  return new Intl.DateTimeFormat("de-DE", { weekday: "short" }).format(parseIsoDate(date));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatRangeLabel(start: string, end: string): string {
  return start === end ? formatDate(start) : `${formatDate(start)} bis ${formatDate(end)}`;
}

function formatAssignmentRange(assignment: MobileAssignment): string {
  return formatRangeLabel(assignment.start_date, assignment.end_date);
}
