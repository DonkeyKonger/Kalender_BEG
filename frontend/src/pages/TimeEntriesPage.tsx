import { Clock3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { StatusBadge, type StatusBadgeTone } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { AssignmentRead } from "../types/matrix";
import type { Person } from "../types/person";
import type { SiteSummary } from "../types/site";
import type { TimeEntry, TimeEntryStatus } from "../types/timeEntry";

type RangeMode = "week" | "month";

const timeEntryStatusLabels: Record<TimeEntryStatus, string> = {
  draft: "Entwurf",
  submitted: "Gemeldet",
  reviewed: "Geprueft",
};

export function TimeEntriesPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [selectedPersonId, setSelectedPersonId] = useState<number | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRead[]>([]);
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [rangeMode, setRangeMode] = useState<RangeMode>("week");
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoadingPeople, setIsLoadingPeople] = useState(true);
  const [isLoadingEntries, setIsLoadingEntries] = useState(false);
  const [isLoadingAssignments, setIsLoadingAssignments] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);

  useEffect(() => {
    void loadPeople();
  }, []);

  useEffect(() => {
    if (selectedPersonId === null && people.length) {
      setSelectedPersonId(people[0].id);
    }
  }, [people, selectedPersonId]);

  async function loadPeople() {
    setIsLoadingPeople(true);
    setError(null);
    try {
      const personData = await api.persons({ isActive: true });
      setPeople(personData.sort(comparePeople));
    } catch (requestError) {
      setError(readApiError(requestError, "Monteure konnten nicht geladen werden."));
    } finally {
      setIsLoadingPeople(false);
    }
  }

  const filteredPeople = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) {
      return people;
    }
    return people.filter((person) => personSearchText(person).includes(needle));
  }, [people, searchTerm]);

  const selectedPerson = useMemo(
    () => people.find((person) => person.id === selectedPersonId) ?? null,
    [people, selectedPersonId],
  );

  const activeRange = useMemo(
    () => (rangeMode === "week" ? currentWeekRange() : currentMonthRange()),
    [rangeMode],
  );
  const siteById = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const plannedSitesByDate = useMemo(
    () => buildPlannedSitesByDate(assignments, activeRange.start, activeRange.end),
    [activeRange.end, activeRange.start, assignments],
  );

  useEffect(() => {
    let ignore = false;
    api.siteSummaries()
      .then((siteData) => {
        if (!ignore) {
          setSites(siteData);
        }
      })
      .catch(() => {
        if (!ignore) {
          setSites([]);
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (selectedPersonId === null) {
      setEntries([]);
      setEntriesError(null);
      return;
    }

    let ignore = false;
    setIsLoadingEntries(true);
    setEntriesError(null);

    api.timeEntries({
      personId: selectedPersonId,
      dateFrom: activeRange.start,
      dateTo: activeRange.end,
    })
      .then((entryData) => {
        if (!ignore) {
          setEntries(entryData);
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setEntries([]);
          setEntriesError(readApiError(requestError, "Arbeitszeiten konnten nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoadingEntries(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeRange.end, activeRange.start, selectedPersonId]);

  useEffect(() => {
    if (selectedPersonId === null) {
      setAssignments([]);
      setAssignmentsError(null);
      return;
    }

    let ignore = false;
    setIsLoadingAssignments(true);
    setAssignmentsError(null);

    api.assignments({
      personId: selectedPersonId,
      start: activeRange.start,
      end: activeRange.end,
    })
      .then((assignmentData) => {
        if (!ignore) {
          setAssignments(assignmentData);
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setAssignments([]);
          setAssignmentsError(readApiError(requestError, "Geplante Baustellen konnten nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoadingAssignments(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeRange.end, activeRange.start, selectedPersonId]);

  return (
    <section className="time-entries-page">
      <div className="page-header entity-page-header">
        <div>
          <p className="eyebrow">Arbeitszeiten</p>
          <h1>Zeiten</h1>
          <p className="page-subtitle">Arbeitszeiten der Monteure wochen- oder monatsweise pruefen.</p>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="time-entries-layout">
        <aside className="time-entries-sidebar">
          <div className="time-panel-header">
            <div>
              <h2>Monteure</h2>
              <p>Person auswaehlen, um den Zeitraum vorzubereiten.</p>
            </div>
          </div>
          <input
            className="entity-search"
            placeholder="Monteur suchen"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
          {isLoadingPeople ? (
            <div className="matrix-state">Monteure werden geladen...</div>
          ) : (
            <div className="time-person-list">
              {filteredPeople.map((person) => (
                <button
                  className={person.id === selectedPersonId ? "is-active" : ""}
                  key={person.id}
                  type="button"
                  onClick={() => setSelectedPersonId(person.id)}
                >
                  <strong>{person.display_name}</strong>
                  <span>{person.short_code || `${person.first_name} ${person.last_name}`.trim()}</span>
                </button>
              ))}
              {!filteredPeople.length && <p className="detail-empty">Keine Monteure gefunden.</p>}
            </div>
          )}
        </aside>

        <div className="time-entries-main">
          <div className="time-entries-toolbar">
            <div>
              <h2>{selectedPerson?.display_name ?? "Monteur auswaehlen"}</h2>
              <p>{formatRangeLabel(activeRange.start, activeRange.end)}</p>
            </div>
            <div className="time-range-controls">
              <div className="matrix-pm-filter" aria-label="Zeitraum">
                <button className={rangeMode === "week" ? "is-active" : ""} type="button" onClick={() => setRangeMode("week")}>
                  Aktuelle Woche
                </button>
                <button className={rangeMode === "month" ? "is-active" : ""} type="button" onClick={() => setRangeMode("month")}>
                  Aktueller Monat
                </button>
              </div>
            </div>
          </div>

          {!selectedPerson ? (
            <div className="empty-panel">
              <Clock3 aria-hidden="true" size={18} />
              <p>Bitte Monteur auswaehlen.</p>
            </div>
          ) : (
            <div className="time-table-panel">
              {assignmentsError && <p className="time-table-note">{assignmentsError}</p>}
              <div className="time-table-scroll">
                <table className="time-entries-table">
                  <thead>
                    <tr>
                      <th>Datum</th>
                      <th>Tag</th>
                      <th>Geplante Baustelle</th>
                      <th>Gemeldete Baustelle</th>
                      <th>Arbeitszeit</th>
                      <th>Pause</th>
                      <th>Fahrtzeit</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoadingEntries && (
                      <tr>
                        <td className="time-empty-row" colSpan={8}>
                          Arbeitszeiten werden geladen...
                        </td>
                      </tr>
                    )}
                    {!isLoadingEntries && entriesError && (
                      <tr>
                        <td className="time-empty-row" colSpan={8}>
                          {entriesError}
                        </td>
                      </tr>
                    )}
                    {!isLoadingEntries && !entriesError && entries.length === 0 && (
                      <tr>
                        <td className="time-empty-row" colSpan={8}>
                          Fuer diesen Zeitraum sind noch keine Arbeitszeiten erfasst.
                        </td>
                      </tr>
                    )}
                    {!isLoadingEntries && !entriesError && entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{formatDate(entry.work_date)}</td>
                        <td>{formatWeekday(entry.work_date)}</td>
                        <td>
                          {isLoadingAssignments
                            ? "wird geladen..."
                            : plannedSiteLabel(plannedSitesByDate.get(entry.work_date), siteById)}
                        </td>
                        <td>{reportedSiteLabel(entry)}</td>
                        <td>{formatMinutes(entry.work_minutes)}</td>
                        <td>{formatMinutes(entry.break_minutes)}</td>
                        <td>{formatMinutes(entry.travel_minutes)}</td>
                        <td>
                          <StatusBadge tone={timeEntryStatusTone(entry.status)}>
                            {timeEntryStatusLabels[entry.status] ?? entry.status}
                          </StatusBadge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function currentMonthRange(): { start: string; end: string } {
  const today = new Date();
  return {
    start: toDateInputValue(new Date(today.getFullYear(), today.getMonth(), 1)),
    end: toDateInputValue(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
  };
}

function currentWeekRange(): { start: string; end: string } {
  const today = new Date();
  const mondayOffset = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: toDateInputValue(monday), end: toDateInputValue(sunday) };
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInput(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function buildPlannedSitesByDate(assignments: AssignmentRead[], dateFrom: string, dateTo: string): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const assignment of assignments) {
    const start = maxDateString(assignment.start_date, dateFrom);
    const end = minDateString(assignment.end_date, dateTo);
    for (const day of daysBetween(start, end)) {
      const siteIds = result.get(day) ?? [];
      if (!siteIds.includes(assignment.site_id)) {
        siteIds.push(assignment.site_id);
      }
      result.set(day, siteIds);
    }
  }
  return result;
}

function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  const cursor = parseDateInput(start);
  const last = parseDateInput(end);
  while (cursor <= last) {
    days.push(toDateInputValue(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function maxDateString(left: string, right: string): string {
  return left > right ? left : right;
}

function minDateString(left: string, right: string): string {
  return left < right ? left : right;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(parseDateInput(value));
}

function formatWeekday(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { weekday: "short" }).format(parseDateInput(value));
}

function formatRangeLabel(start: string, end: string): string {
  return `${formatDate(start)} bis ${formatDate(end)}`;
}

function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) {
    return "-";
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${rest} Min.`;
  }
  return `${hours} Std. ${rest} Min.`;
}

function reportedSiteLabel(entry: TimeEntry): string {
  return [entry.site_number, entry.site_name].filter(Boolean).join(" · ") || "-";
}

function plannedSiteLabel(siteIds: number[] | undefined, siteById: Map<number, SiteSummary>): string {
  if (!siteIds?.length) {
    return "-";
  }
  if (siteIds.length === 1) {
    return fullSiteLabel(siteIds[0], siteById);
  }
  return siteIds.map((siteId) => compactSiteLabel(siteId, siteById)).join(", ");
}

function fullSiteLabel(siteId: number, siteById: Map<number, SiteSummary>): string {
  const site = siteById.get(siteId);
  if (!site) {
    return `Baustelle ${siteId}`;
  }
  return [site.site_number, site.name].filter(Boolean).join(" · ") || `Baustelle ${siteId}`;
}

function compactSiteLabel(siteId: number, siteById: Map<number, SiteSummary>): string {
  const site = siteById.get(siteId);
  if (!site) {
    return `Baustelle ${siteId}`;
  }
  return site.site_number || site.name || `Baustelle ${siteId}`;
}

function timeEntryStatusTone(status: TimeEntryStatus): StatusBadgeTone {
  if (status === "reviewed") {
    return "active";
  }
  if (status === "submitted") {
    return "planned";
  }
  return "neutral";
}

function comparePeople(left: Person, right: Person): number {
  return left.display_name.localeCompare(right.display_name, "de");
}

function personSearchText(person: Person): string {
  return [
    person.display_name,
    person.first_name,
    person.last_name,
    person.short_code,
  ].filter(Boolean).join(" ").toLowerCase();
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
