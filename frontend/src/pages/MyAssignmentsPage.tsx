import { CalendarClock, History, MapPin, Phone, RefreshCcw, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../lib/api";
import type { MobileAssignment, MobileAssignmentsResponse } from "../types/mobile";

const CACHE_KEY = "kb_mobile_assignments_cache_v1";

type MobileViewMode = "default" | "history";

type CachePayload = {
  loadedAt: string;
  mode: MobileViewMode;
  data: MobileAssignmentsResponse;
};

export function MyAssignmentsPage() {
  const [mode, setMode] = useState<MobileViewMode>("default");
  const [data, setData] = useState<MobileAssignmentsResponse | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFromCache, setIsFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => getRange(mode), [mode]);

  const loadAssignments = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setIsFromCache(false);
    try {
      const response = mode === "history"
        ? await api.myAssignmentHistory(range)
        : await api.myAssignments(range);
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
        setError("Offline-Anzeige: zuletzt geladene Einsaetze werden angezeigt.");
      } else {
        setError(readApiError(requestError, "Einsaetze konnten nicht geladen werden."));
      }
    } finally {
      setIsLoading(false);
    }
  }, [mode, range]);

  useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  const sections = useMemo(() => groupAssignments(data?.assignments ?? []), [data]);

  return (
    <section className="mobile-page">
      <div className="mobile-header">
        <div>
          <p className="eyebrow">Mobil</p>
          <h1>Meine Einsaetze</h1>
          <p>{formatRangeLabel(data?.start_date ?? range.start, data?.end_date ?? range.end)}</p>
        </div>
        <button className="icon-button secondary" type="button" onClick={() => void loadAssignments()}>
          <RefreshCcw aria-hidden="true" size={17} />
          <span>Aktualisieren</span>
        </button>
      </div>

      <div className="mobile-segment" role="group" aria-label="Zeitraum">
        <button
          className={mode === "default" ? "active" : ""}
          type="button"
          onClick={() => setMode("default")}
        >
          14 Tage
        </button>
        <button
          className={mode === "history" ? "active" : ""}
          type="button"
          onClick={() => setMode("history")}
        >
          <History aria-hidden="true" size={15} />
          <span>Letztes Jahr</span>
        </button>
      </div>

      {loadedAt && (
        <p className={isFromCache ? "cache-note warning" : "cache-note"}>
          Stand: {formatDateTime(loadedAt)}{isFromCache ? " - Lesecache" : ""}
        </p>
      )}
      {error && <p className={isFromCache ? "form-info" : "form-error"}>{error}</p>}
      {isLoading && <div className="empty-panel">Einsaetze werden geladen...</div>}

      {!isLoading && data && (
        <div className="assignment-sections">
          <AssignmentSection title="Heute" assignments={sections.today} emptyText="Heute ist kein Einsatz geplant." />
          <AssignmentSection title="Kommend" assignments={sections.upcoming} emptyText="Keine kommenden Einsaetze im Zeitraum." />
          <AssignmentSection title="Vergangen" assignments={sections.past} emptyText="Keine vergangenen Einsaetze im Zeitraum." />
        </div>
      )}
    </section>
  );
}

function AssignmentSection({
  title,
  assignments,
  emptyText,
}: {
  title: string;
  assignments: MobileAssignment[];
  emptyText: string;
}) {
  return (
    <section className="assignment-section">
      <h2>{title}</h2>
      {assignments.length ? (
        <div className="assignment-list">
          {assignments.map((assignment) => (
            <AssignmentCard assignment={assignment} key={assignment.id} />
          ))}
        </div>
      ) : (
        <p className="empty-inline">{emptyText}</p>
      )}
    </section>
  );
}

function AssignmentCard({ assignment }: { assignment: MobileAssignment }) {
  return (
    <article className="assignment-card">
      <div className="assignment-card-main">
        <div>
          <p className="assignment-date"><CalendarClock aria-hidden="true" size={15} />{formatAssignmentRange(assignment)}</p>
          <h3>{assignment.site.name}</h3>
          {assignment.site.site_number && <p className="muted-text">{assignment.site.site_number}</p>}
        </div>
        <span className={`status-badge status-${assignment.site.status}`}>{siteStatusLabel(assignment.site.status)}</span>
      </div>

      <div className="assignment-detail-list">
        {(assignment.site.location || assignment.site.address) && (
          <p><MapPin aria-hidden="true" size={16} /><span>{[assignment.site.location, assignment.site.address].filter(Boolean).join(" - ")}</span></p>
        )}
        {assignment.site.project_manager && (
          <p><UserRound aria-hidden="true" size={16} /><span>{assignment.site.project_manager.display_name}</span></p>
        )}
        {assignment.site.project_manager?.phone && (
          <p><Phone aria-hidden="true" size={16} /><span>{assignment.site.project_manager.phone}</span></p>
        )}
      </div>

      {assignment.site.info && <p className="assignment-note">{assignment.site.info}</p>}
      {assignment.note && <p className="assignment-note">{assignment.note}</p>}
    </article>
  );
}

function getRange(mode: MobileViewMode): { start: string; end: string } {
  const today = startOfToday();
  if (mode === "history") {
    return {
      start: toIsoDate(addDays(today, -365)),
      end: toIsoDate(today),
    };
  }
  return {
    start: toIsoDate(addDays(today, -14)),
    end: toIsoDate(addDays(today, 14)),
  };
}

function groupAssignments(assignments: MobileAssignment[]) {
  const today = toIsoDate(startOfToday());
  return {
    today: assignments.filter((item) => item.start_date <= today && item.end_date >= today),
    upcoming: assignments.filter((item) => item.start_date > today),
    past: assignments.filter((item) => item.end_date < today).reverse(),
  };
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

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${date}T00:00:00`));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatRangeLabel(start: string, end: string): string {
  return `${formatDate(start)} bis ${formatDate(end)}`;
}

function formatAssignmentRange(assignment: MobileAssignment): string {
  return assignment.start_date === assignment.end_date
    ? formatDate(assignment.start_date)
    : formatRangeLabel(assignment.start_date, assignment.end_date);
}

function siteStatusLabel(status: MobileAssignment["site"]["status"]): string {
  const labels = {
    active: "Aktiv",
    paused: "Pause",
    closed: "Zu",
    archived: "Archiv",
  };
  return labels[status];
}
