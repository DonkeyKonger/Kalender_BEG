import { Clock3 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { StatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { AssignmentRead } from "../types/matrix";
import type { Person } from "../types/person";
import type { SiteSummary } from "../types/site";
import type { TimeEntry, TimeEntryStatus } from "../types/timeEntry";

type RangeMode = "week" | "month" | "custom";

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
  const [rangeMode, setRangeMode] = useState<RangeMode>("month");
  const [dateFrom, setDateFrom] = useState(() => currentMonthRange().start);
  const [dateTo, setDateTo] = useState(() => currentMonthRange().end);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoadingPeople, setIsLoadingPeople] = useState(true);
  const [isLoadingEntries, setIsLoadingEntries] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const loadEntries = useCallback(async (personId: number, from: string, to: string) => {
    setIsLoadingEntries(true);
    setError(null);
    try {
      const [entryData, assignmentData, siteData] = await Promise.all([
        api.timeEntries({ personId, dateFrom: from, dateTo: to }),
        api.assignments({ personId, start: from, end: to }),
        sites.length ? Promise.resolve(sites) : api.siteSummaries(),
      ]);
      setEntries(entryData);
      setAssignments(assignmentData);
      setSites(siteData);
    } catch (requestError) {
      setError(readApiError(requestError, "Arbeitszeiten konnten nicht geladen werden."));
    } finally {
      setIsLoadingEntries(false);
    }
  }, [sites]);

  useEffect(() => {
    if (selectedPersonId === null) {
      setEntries([]);
      setAssignments([]);
      return;
    }
    void loadEntries(selectedPersonId, dateFrom, dateTo);
  }, [dateFrom, dateTo, loadEntries, selectedPersonId]);

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
  const siteById = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const assignmentsByDate = useMemo(
    () => buildAssignmentDateMap(assignments, dateFrom, dateTo),
    [assignments, dateFrom, dateTo],
  );

  function applyRangeMode(nextMode: RangeMode) {
    setRangeMode(nextMode);
    if (nextMode === "week") {
      const range = currentWeekRange();
      setDateFrom(range.start);
      setDateTo(range.end);
    }
    if (nextMode === "month") {
      const range = currentMonthRange();
      setDateFrom(range.start);
      setDateTo(range.end);
    }
  }

  return (
    <section className="time-entries-page">
      <div className="page-header entity-page-header">
        <div>
          <p className="eyebrow">Zeiten</p>
          <h1>Arbeitszeiten</h1>
          <p className="page-subtitle">Personenbezogene Wochen- und Monatspruefung fuer manuell gemeldete Zeiten.</p>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="time-entries-layout">
        <aside className="time-entries-sidebar">
          <div className="time-panel-header">
            <div>
              <h2>Monteure</h2>
              <p>Auswahl begrenzt die geladenen Zeiten.</p>
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
              <h2>{selectedPerson?.display_name ?? "Arbeitszeiten"}</h2>
              <p>GPS-Plausibilisierung wird spaeter im Backend getrennt ausgewertet.</p>
            </div>
            <div className="time-range-controls">
              <div className="matrix-pm-filter" aria-label="Zeitraum">
                <button className={rangeMode === "week" ? "is-active" : ""} type="button" onClick={() => applyRangeMode("week")}>
                  Woche
                </button>
                <button className={rangeMode === "month" ? "is-active" : ""} type="button" onClick={() => applyRangeMode("month")}>
                  Monat
                </button>
                <button className={rangeMode === "custom" ? "is-active" : ""} type="button" onClick={() => setRangeMode("custom")}>
                  Frei
                </button>
              </div>
              <label>
                <span>Von</span>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(event) => {
                    setRangeMode("custom");
                    setDateFrom(event.target.value);
                  }}
                />
              </label>
              <label>
                <span>Bis</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(event) => {
                    setRangeMode("custom");
                    setDateTo(event.target.value);
                  }}
                />
              </label>
            </div>
          </div>

          <div className="time-summary-strip">
            <div>
              <span>Eintraege</span>
              <strong>{entries.length}</strong>
            </div>
            <div>
              <span>Arbeitszeit</span>
              <strong>{formatMinutes(sumMinutes(entries, "work_minutes"))}</strong>
            </div>
            <div>
              <span>Pause</span>
              <strong>{formatMinutes(sumMinutes(entries, "break_minutes"))}</strong>
            </div>
            <div>
              <span>Fahrtzeit</span>
              <strong>{formatMinutes(sumMinutes(entries, "travel_minutes"))}</strong>
            </div>
          </div>

          <div className="time-table-panel">
            {isLoadingEntries ? (
              <div className="matrix-state">Arbeitszeiten werden geladen...</div>
            ) : entries.length ? (
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
                      <th>Hinweis / GPS spaeter</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{formatDate(entry.work_date)}</td>
                        <td>{formatWeekday(entry.work_date)}</td>
                        <td>{plannedSiteLabel(assignmentsByDate.get(entry.work_date), siteById)}</td>
                        <td>{reportedSiteLabel(entry)}</td>
                        <td>{formatMinutes(entry.work_minutes)}</td>
                        <td>{formatMinutes(entry.break_minutes)}</td>
                        <td>{formatMinutes(entry.travel_minutes)}</td>
                        <td><StatusBadge tone={entry.status === "reviewed" ? "active" : "neutral"}>{timeEntryStatusLabels[entry.status]}</StatusBadge></td>
                        <td>{entry.note || "Plausibilisierung spaeter"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-panel">
                <Clock3 aria-hidden="true" size={18} />
                <p>Keine Arbeitszeiten fuer diesen Zeitraum vorhanden.</p>
              </div>
            )}
          </div>
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

function buildAssignmentDateMap(assignments: AssignmentRead[], dateFrom: string, dateTo: string): Map<string, AssignmentRead> {
  const result = new Map<string, AssignmentRead>();
  for (const assignment of assignments) {
    for (const day of daysBetween(maxDateString(assignment.start_date, dateFrom), minDateString(assignment.end_date, dateTo))) {
      if (!result.has(day)) {
        result.set(day, assignment);
      }
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

function parseDateInput(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function maxDateString(left: string, right: string): string {
  return left > right ? left : right;
}

function minDateString(left: string, right: string): string {
  return left < right ? left : right;
}

function plannedSiteLabel(assignment: AssignmentRead | undefined, siteById: Map<number, SiteSummary>): string {
  if (!assignment) {
    return "-";
  }
  const site = siteById.get(assignment.site_id);
  if (!site) {
    return `Baustelle ${assignment.site_id}`;
  }
  return [site.site_number, site.name].filter(Boolean).join(" · ");
}

function reportedSiteLabel(entry: TimeEntry): string {
  return [entry.site_number, entry.site_name].filter(Boolean).join(" · ") || "-";
}

function sumMinutes(entries: TimeEntry[], field: "work_minutes" | "break_minutes" | "travel_minutes"): number {
  return entries.reduce((sum, entry) => sum + entry[field], 0);
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${rest} Min.`;
  }
  return `${hours} Std. ${rest} Min.`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(parseDateInput(value));
}

function formatWeekday(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { weekday: "short" }).format(parseDateInput(value));
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
