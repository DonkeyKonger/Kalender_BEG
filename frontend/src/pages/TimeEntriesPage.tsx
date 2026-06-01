import { Clock3, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "../auth/AuthContext";
import { StatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { AssignmentRead } from "../types/matrix";
import type { Person } from "../types/person";
import type { SiteSummary } from "../types/site";
import type { TimeEntry, TimeEntryCreate, TimeEntryStatus } from "../types/timeEntry";

type RangeMode = "week" | "month" | "custom";
type TimeEntryFormState = {
  work_date: string;
  site_id: string;
  hours: string;
  minutes: string;
  break_minutes: string;
  travel_minutes: string;
  status: TimeEntryStatus;
  note: string;
};

const timeEntryStatusLabels: Record<TimeEntryStatus, string> = {
  draft: "Entwurf",
  submitted: "Gemeldet",
  reviewed: "Geprueft",
};

export function TimeEntriesPage() {
  const { user } = useAuth();
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
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [entryForm, setEntryForm] = useState<TimeEntryFormState>(() => emptyTimeEntryForm(toDateInputValue(new Date())));
  const [formError, setFormError] = useState<string | null>(null);
  const [isSavingEntry, setIsSavingEntry] = useState(false);
  const canManageTimeEntries = user?.role === "admin" || user?.role === "project_manager" || user?.role === "office";

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
  const siteOptions = useMemo(
    () => [...sites].sort((left, right) => siteSelectLabel(left).localeCompare(siteSelectLabel(right), "de")),
    [sites],
  );
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

  function openCreateForm() {
    if (!selectedPersonId) {
      return;
    }
    setEditingEntry(null);
    setEntryForm(emptyTimeEntryForm(defaultEntryDate(dateFrom, dateTo)));
    setFormError(null);
    setIsEditorOpen(true);
  }

  function openEditForm(entry: TimeEntry) {
    setEditingEntry(entry);
    setEntryForm(timeEntryToForm(entry));
    setFormError(null);
    setIsEditorOpen(true);
  }

  function closeEditor() {
    if (isSavingEntry) {
      return;
    }
    setIsEditorOpen(false);
    setEditingEntry(null);
    setFormError(null);
  }

  async function saveTimeEntry() {
    if (!selectedPersonId) {
      setFormError("Bitte zuerst einen Monteur auswaehlen.");
      return;
    }
    const payloadResult = buildTimeEntryPayload(entryForm, selectedPersonId);
    if (!payloadResult.ok) {
      setFormError(payloadResult.error);
      return;
    }

    setIsSavingEntry(true);
    setFormError(null);
    try {
      if (editingEntry) {
        await api.updateTimeEntry(editingEntry.id, payloadResult.payload);
      } else {
        await api.createTimeEntry(payloadResult.payload);
      }
      setIsEditorOpen(false);
      setEditingEntry(null);
      await loadEntries(selectedPersonId, dateFrom, dateTo);
    } catch (requestError) {
      setFormError(readApiError(requestError, "Arbeitszeit konnte nicht gespeichert werden."));
    } finally {
      setIsSavingEntry(false);
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
            <div className="time-toolbar-actions">
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
              {canManageTimeEntries && (
                <button className="icon-button time-add-button" disabled={!selectedPersonId} type="button" onClick={openCreateForm}>
                  <Plus aria-hidden="true" size={16} />
                  Arbeitszeit erfassen
                </button>
              )}
            </div>
          </div>

          {isEditorOpen && (
            <div className="time-entry-editor">
              <div className="time-entry-editor-header">
                <div>
                  <h3>{editingEntry ? "Arbeitszeit bearbeiten" : "Arbeitszeit erfassen"}</h3>
                  <p>{selectedPerson?.display_name ?? "Ausgewaehlter Monteur"}</p>
                </div>
                <button className="icon-button secondary" disabled={isSavingEntry} type="button" onClick={closeEditor}>
                  Schliessen
                </button>
              </div>
              {formError && <p className="form-error">{formError}</p>}
              <div className="time-entry-form-grid">
                <label>
                  <span>Datum</span>
                  <input
                    type="date"
                    value={entryForm.work_date}
                    onChange={(event) => setEntryForm((current) => ({ ...current, work_date: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Gemeldete Baustelle</span>
                  <select
                    value={entryForm.site_id}
                    onChange={(event) => setEntryForm((current) => ({ ...current, site_id: event.target.value }))}
                  >
                    <option value="">Keine Baustelle</option>
                    {siteOptions.map((site) => (
                      <option key={site.id} value={site.id}>
                        {siteSelectLabel(site)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Arbeitszeit Stunden</span>
                  <input
                    inputMode="numeric"
                    min="0"
                    type="number"
                    value={entryForm.hours}
                    onChange={(event) => setEntryForm((current) => ({ ...current, hours: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Arbeitszeit Minuten</span>
                  <input
                    inputMode="numeric"
                    max="59"
                    min="0"
                    type="number"
                    value={entryForm.minutes}
                    onChange={(event) => setEntryForm((current) => ({ ...current, minutes: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Pause (Min.)</span>
                  <input
                    inputMode="numeric"
                    min="0"
                    type="number"
                    value={entryForm.break_minutes}
                    onChange={(event) => setEntryForm((current) => ({ ...current, break_minutes: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Fahrtzeit (Min.)</span>
                  <input
                    inputMode="numeric"
                    min="0"
                    type="number"
                    value={entryForm.travel_minutes}
                    onChange={(event) => setEntryForm((current) => ({ ...current, travel_minutes: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Status</span>
                  <select
                    value={entryForm.status}
                    onChange={(event) => setEntryForm((current) => ({ ...current, status: event.target.value as TimeEntryStatus }))}
                  >
                    <option value="draft">Entwurf</option>
                    <option value="submitted">Gemeldet</option>
                    <option value="reviewed">Geprueft</option>
                  </select>
                </label>
                <label className="time-entry-note-field">
                  <span>Notiz</span>
                  <textarea
                    rows={2}
                    value={entryForm.note}
                    onChange={(event) => setEntryForm((current) => ({ ...current, note: event.target.value }))}
                  />
                </label>
              </div>
              <div className="time-entry-editor-actions">
                <button className="icon-button secondary" disabled={isSavingEntry} type="button" onClick={closeEditor}>
                  Abbrechen
                </button>
                <button className="icon-button" disabled={isSavingEntry} type="button" onClick={() => void saveTimeEntry()}>
                  {isSavingEntry ? "Speichert..." : "Speichern"}
                </button>
              </div>
            </div>
          )}

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
                      {canManageTimeEntries && <th>Aktion</th>}
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
                        {canManageTimeEntries && (
                          <td>
                            <button className="time-table-action" type="button" onClick={() => openEditForm(entry)}>
                              <Pencil aria-hidden="true" size={14} />
                              Bearbeiten
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-panel">
                <Clock3 aria-hidden="true" size={18} />
                <p>Fuer diesen Zeitraum sind noch keine Arbeitszeiten erfasst.</p>
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

function defaultEntryDate(dateFrom: string, dateTo: string): string {
  const today = toDateInputValue(new Date());
  if (today >= dateFrom && today <= dateTo) {
    return today;
  }
  return dateFrom;
}

function emptyTimeEntryForm(workDate: string): TimeEntryFormState {
  return {
    work_date: workDate,
    site_id: "",
    hours: "8",
    minutes: "0",
    break_minutes: "0",
    travel_minutes: "0",
    status: "draft",
    note: "",
  };
}

function timeEntryToForm(entry: TimeEntry): TimeEntryFormState {
  const splitWork = splitMinutes(entry.work_minutes);
  return {
    work_date: entry.work_date,
    site_id: entry.site_id ? String(entry.site_id) : "",
    hours: String(splitWork.hours),
    minutes: String(splitWork.minutes),
    break_minutes: String(entry.break_minutes ?? 0),
    travel_minutes: String(entry.travel_minutes ?? 0),
    status: entry.status,
    note: entry.note ?? "",
  };
}

function splitMinutes(totalMinutes: number): { hours: number; minutes: number } {
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}

function buildTimeEntryPayload(
  form: TimeEntryFormState,
  personId: number,
): { ok: true; payload: TimeEntryCreate } | { ok: false; error: string } {
  if (!form.work_date) {
    return { ok: false, error: "Bitte ein Datum auswaehlen." };
  }

  const hours = parseWholeMinutesField(form.hours, "Arbeitszeit Stunden");
  if (!hours.ok) {
    return hours;
  }
  const minutes = parseWholeMinutesField(form.minutes, "Arbeitszeit Minuten");
  if (!minutes.ok) {
    return minutes;
  }
  if (minutes.value > 59) {
    return { ok: false, error: "Arbeitszeit Minuten darf maximal 59 sein." };
  }

  const breakMinutes = parseWholeMinutesField(form.break_minutes, "Pause");
  if (!breakMinutes.ok) {
    return breakMinutes;
  }
  const travelMinutes = parseWholeMinutesField(form.travel_minutes, "Fahrtzeit");
  if (!travelMinutes.ok) {
    return travelMinutes;
  }

  let siteId: number | null = null;
  if (form.site_id) {
    const parsedSiteId = Number(form.site_id);
    if (!Number.isInteger(parsedSiteId) || parsedSiteId <= 0) {
      return { ok: false, error: "Bitte eine gueltige Baustelle auswaehlen." };
    }
    siteId = parsedSiteId;
  }

  return {
    ok: true,
    payload: {
      person_id: personId,
      site_id: siteId,
      work_date: form.work_date,
      work_minutes: hours.value * 60 + minutes.value,
      break_minutes: breakMinutes.value,
      travel_minutes: travelMinutes.value,
      note: form.note.trim() || null,
      source: "manual",
      status: form.status,
    },
  };
}

function parseWholeMinutesField(value: string, label: string): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: 0 };
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { ok: false, error: `${label} muss eine ganze Zahl ab 0 sein.` };
  }
  return { ok: true, value: parsed };
}

function siteSelectLabel(site: SiteSummary): string {
  return [site.site_number, site.name].filter(Boolean).join(" · ");
}
