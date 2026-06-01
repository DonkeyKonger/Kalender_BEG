import { Clock3, Pencil, Plus, RefreshCw } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

import { useAuth } from "../auth/AuthContext";
import { StatusBadge, type StatusBadgeTone } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { GpsRecentLocationPoint } from "../types/gps";
import type { AssignmentRead } from "../types/matrix";
import type { Person } from "../types/person";
import type { SiteSummary } from "../types/site";
import type { TimeEntry, TimeEntryCreate, TimeEntryGpsStatus, TimeEntryStatus } from "../types/timeEntry";

type RangeMode = "week" | "month";
type PlanningMatchStatus = "matches" | "needs_review" | "without_plan" | "missing_reported_site" | "unknown" | "not_checkable";
type TimeEntryFormState = {
  work_date: string;
  site_id: string;
  hours: string;
  break_minutes: string;
  travel_minutes: string;
  note: string;
};

const timeEntryStatusLabels: Record<TimeEntryStatus, string> = {
  draft: "Entwurf",
  submitted: "Gemeldet",
  reviewed: "Geprueft",
};

const planningStatusLabels: Record<PlanningMatchStatus, string> = {
  matches: "Passt",
  needs_review: "Pruefen",
  without_plan: "Ohne Planung",
  missing_reported_site: "Unvollstaendig",
  unknown: "-",
  not_checkable: "nicht pruefbar",
};

const planningStatusTitles: Record<PlanningMatchStatus, string> = {
  matches: "Gemeldete Baustelle entspricht der Planung.",
  needs_review: "Gemeldete Baustelle weicht von der Planung ab.",
  without_plan: "Fuer diesen Tag wurde keine Baustelle geplant.",
  missing_reported_site: "Es gibt eine Planung, aber keine gemeldete Baustelle.",
  unknown: "Planungshinweis ist mit den vorhandenen Daten nicht bestimmbar.",
  not_checkable: "Geplante Baustellen konnten nicht geladen werden.",
};

const gpsStatusLabels: Record<TimeEntryGpsStatus, string> = {
  matched: "passt",
  missing: "fehlt",
  partial: "teilweise",
  mismatch: "abweichend",
  not_checkable: "nicht pruefbar",
};

const gpsStatusTitles: Record<TimeEntryGpsStatus, string> = {
  matched: "GPS-Punkte liegen im Baustellenradius.",
  missing: "Fuer diesen Zeitraum liegen keine GPS-Punkte vor.",
  partial: "Ein Teil der GPS-Punkte passt zur Baustelle.",
  mismatch: "GPS-Punkte liegen ueberwiegend ausserhalb des Baustellenradius.",
  not_checkable: "GPS-Plausibilitaet ist fuer diese Zeile nicht pruefbar.",
};

export function TimeEntriesPage() {
  const { user } = useAuth();
  const [people, setPeople] = useState<Person[]>([]);
  const [selectedPersonId, setSelectedPersonId] = useState<number | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRead[]>([]);
  const [recentGpsPoints, setRecentGpsPoints] = useState<GpsRecentLocationPoint[]>([]);
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [rangeMode, setRangeMode] = useState<RangeMode>("week");
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoadingPeople, setIsLoadingPeople] = useState(true);
  const [isLoadingEntries, setIsLoadingEntries] = useState(false);
  const [isLoadingAssignments, setIsLoadingAssignments] = useState(false);
  const [isLoadingRecentGps, setIsLoadingRecentGps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);
  const [recentGpsError, setRecentGpsError] = useState<string | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [entryForm, setEntryForm] = useState<TimeEntryFormState>(() => emptyTimeEntryForm(toDateInputValue(new Date())));
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSavingEntry, setIsSavingEntry] = useState(false);
  const [entriesRefreshKey, setEntriesRefreshKey] = useState(0);
  const canManageTimeEntries = user?.role === "admin" || user?.role === "project_manager" || user?.role === "office";
  const canViewGpsVerification = canManageTimeEntries;

  useEffect(() => {
    void loadPeople();
  }, []);

  useEffect(() => {
    if (!canViewGpsVerification) {
      setRecentGpsPoints([]);
      return;
    }
    void loadRecentGpsPoints();
  }, [canViewGpsVerification]);

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

  async function loadRecentGpsPoints(): Promise<void> {
    setIsLoadingRecentGps(true);
    setRecentGpsError(null);
    try {
      const pointData = await api.recentGpsLocationPoints({ limit: 20 });
      setRecentGpsPoints(pointData);
    } catch (requestError) {
      setRecentGpsPoints([]);
      setRecentGpsError(readApiError(requestError, "GPS-Pruefdaten konnten nicht geladen werden."));
    } finally {
      setIsLoadingRecentGps(false);
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
  const editorPersonName = editingEntry?.person_name ?? selectedPerson?.display_name ?? "Ausgewaehlter Monteur";

  const activeRange = useMemo(
    () => (rangeMode === "week" ? currentWeekRange() : currentMonthRange()),
    [rangeMode],
  );
  const siteById = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const siteOptions = useMemo(
    () => [...sites].sort((left, right) => siteOptionLabel(left).localeCompare(siteOptionLabel(right), "de")),
    [sites],
  );
  const plannedSitesByDate = useMemo(
    () => buildPlannedSitesByDate(assignments, activeRange.start, activeRange.end),
    [activeRange.end, activeRange.start, assignments],
  );
  const timeTableColumnCount = canManageTimeEntries ? 11 : 10;

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
      includeGpsStatus: true,
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
  }, [activeRange.end, activeRange.start, entriesRefreshKey, selectedPersonId]);

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

  function openCreateForm() {
    if (!selectedPersonId) {
      return;
    }
    setEditingEntry(null);
    setEntryForm(emptyTimeEntryForm(defaultEntryDate(activeRange.start, activeRange.end)));
    setFormError(null);
    setNotice(null);
    setIsEditorOpen(true);
  }

  function openEditForm(entry: TimeEntry) {
    setEditingEntry(entry);
    setEntryForm(timeEntryToForm(entry));
    setFormError(null);
    setNotice(null);
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
    const targetPersonId = editingEntry?.person_id ?? selectedPersonId;
    if (!targetPersonId) {
      setFormError("Bitte zuerst einen Monteur auswaehlen.");
      return;
    }
    const payloadResult = buildTimeEntryPayload(entryForm, targetPersonId);
    if (!payloadResult.ok) {
      setFormError(payloadResult.error);
      return;
    }

    setIsSavingEntry(true);
    setFormError(null);
    setNotice(null);
    try {
      if (editingEntry) {
        await api.updateTimeEntry(editingEntry.id, payloadResult.payload);
      } else {
        await api.createTimeEntry(payloadResult.payload);
      }
      setIsEditorOpen(false);
      setEditingEntry(null);
      if (payloadResult.payload.work_date < activeRange.start || payloadResult.payload.work_date > activeRange.end) {
        setNotice("Arbeitszeit gespeichert, liegt aber ausserhalb des aktuellen Zeitraums.");
      }
      setEntriesRefreshKey((current) => current + 1);
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
            <div className="time-toolbar-actions">
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
              {canManageTimeEntries && (
                <button className="icon-button time-add-button" disabled={!selectedPersonId} type="button" onClick={openCreateForm}>
                  <Plus aria-hidden="true" size={16} />
                  Arbeitszeit erfassen
                </button>
              )}
            </div>
          </div>

          {notice && <p className="time-table-note">{notice}</p>}

          {isEditorOpen && (
            <div className="time-entry-editor">
              <div className="time-entry-editor-header">
                <div>
                  <h3>{editingEntry ? "Arbeitszeit bearbeiten" : "Arbeitszeit erfassen"}</h3>
                  <p>{editorPersonName}</p>
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
                  <span>Baustelle</span>
                  <select
                    value={entryForm.site_id}
                    onChange={(event) => setEntryForm((current) => ({ ...current, site_id: event.target.value }))}
                  >
                    <option value="">Keine Baustelle</option>
                    {siteOptions.map((site) => (
                      <option key={site.id} value={site.id}>
                        {siteOptionLabel(site)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Arbeitszeit (Std.)</span>
                  <input
                    inputMode="decimal"
                    placeholder="z. B. 8,5"
                    value={entryForm.hours}
                    onChange={(event) => setEntryForm((current) => ({ ...current, hours: event.target.value }))}
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
                      <th>Planung</th>
                      <th>GPS</th>
                      {canManageTimeEntries && <th>Aktion</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {isLoadingEntries && (
                      <tr>
                        <td className="time-empty-row" colSpan={timeTableColumnCount}>
                          Arbeitszeiten werden geladen...
                        </td>
                      </tr>
                    )}
                    {!isLoadingEntries && entriesError && (
                      <tr>
                        <td className="time-empty-row" colSpan={timeTableColumnCount}>
                          {entriesError}
                        </td>
                      </tr>
                    )}
                    {!isLoadingEntries && !entriesError && entries.length === 0 && (
                      <tr>
                        <td className="time-empty-row" colSpan={timeTableColumnCount}>
                          Fuer diesen Zeitraum sind noch keine Arbeitszeiten erfasst.
                        </td>
                      </tr>
                    )}
                    {!isLoadingEntries && !entriesError && entries.map((entry) => {
                      const plannedSiteIds = plannedSitesByDate.get(entry.work_date);
                      const planningStatus = getPlanningMatchStatus(entry, plannedSiteIds, {
                        isLoadingAssignments,
                        assignmentsUnavailable: Boolean(assignmentsError),
                      });
                      const plannedSiteText = isLoadingAssignments
                        ? "wird geladen..."
                        : plannedSiteLabel(plannedSiteIds, siteById);
                      return (
                        <Fragment key={entry.id}>
                          <tr>
                            <td>{formatDate(entry.work_date)}</td>
                            <td>{formatWeekday(entry.work_date)}</td>
                            <td>{plannedSiteText}</td>
                            <td>{reportedSiteLabel(entry)}</td>
	                            <td>{formatMinutes(entry.work_minutes)}</td>
	                            <td>{formatMinutes(entry.break_minutes)}</td>
	                            <td>{formatMinutes(entry.travel_minutes)}</td>
                          <td>
                            <StatusBadge tone={timeEntryStatusTone(entry.status)}>
                              {timeEntryStatusLabels[entry.status] ?? entry.status}
                            </StatusBadge>
                          </td>
                          <td>
                            <span title={planningStatusTitles[planningStatus]}>
                              <StatusBadge tone={planningStatusTone(planningStatus)}>
                                {planningStatusLabels[planningStatus]}
                              </StatusBadge>
                            </span>
                          </td>
                          <td>
                            {entry.gps_status ? (
                              <span title={gpsStatusTitle(entry)}>
                                <StatusBadge tone={gpsStatusTone(entry.gps_status)}>
                                  {gpsStatusLabels[entry.gps_status]}
                                </StatusBadge>
                              </span>
                            ) : "-"}
                          </td>
                          {canManageTimeEntries && (
                            <td>
                              <button className="time-table-action" type="button" onClick={() => openEditForm(entry)}>
                                <Pencil aria-hidden="true" size={14} />
                                Bearbeiten
                              </button>
                            </td>
                          )}
                        </tr>
                        {entry.gps_first_seen_at && (
                          <tr className="time-gps-comparison-row">
                            <td>{formatDate(entry.work_date)}</td>
                            <td>{formatGpsSignalRange(entry)}</td>
                            <td>{plannedSiteText}</td>
                            <td>-</td>
                            <td>{formatGpsWorkMinutes(entry)}</td>
                            <td>-</td>
                            <td>-</td>
                            <td>
                              <StatusBadge tone="neutral">GPS berechnet</StatusBadge>
                            </td>
                            <td>
                              <StatusBadge tone="neutral">Kontrollwert</StatusBadge>
                            </td>
                            <td>
                              {entry.gps_status ? (
                                <span title={gpsStatusTitle(entry)}>
                                  <StatusBadge tone={gpsStatusTone(entry.gps_status)}>
                                    {gpsStatusLabels[entry.gps_status]}
                                  </StatusBadge>
                                </span>
                              ) : "-"}
                            </td>
                            {canManageTimeEntries && <td>-</td>}
                          </tr>
                        )}
	                      </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {canViewGpsVerification && (
            <div className="gps-verification-panel">
              <div className="gps-verification-header">
                <div>
                  <h2>GPS-Pruefung</h2>
                  <p>Letzte mobile Standortsendungen mit geplanter Baustelle und Geofence-Status.</p>
                </div>
                <button className="time-table-action" disabled={isLoadingRecentGps} type="button" onClick={() => void loadRecentGpsPoints()}>
                  <RefreshCw aria-hidden="true" size={14} />
                  Aktualisieren
                </button>
              </div>
              {recentGpsError && <p className="time-table-note">{recentGpsError}</p>}
              <div className="time-table-scroll">
                <table className="time-entries-table gps-verification-table">
                  <thead>
                    <tr>
                      <th>Monteur</th>
                      <th>Zeitpunkt</th>
                      <th>Geplante Baustelle</th>
                      <th>Plausibilitaet</th>
                      <th>Abstand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoadingRecentGps && (
                      <tr>
                        <td className="time-empty-row" colSpan={5}>
                          GPS-Pruefdaten werden geladen...
                        </td>
                      </tr>
                    )}
                    {!isLoadingRecentGps && !recentGpsError && recentGpsPoints.length === 0 && (
                      <tr>
                        <td className="time-empty-row" colSpan={5}>
                          Noch keine mobilen Standortsendungen vorhanden.
                        </td>
                      </tr>
                    )}
                    {!isLoadingRecentGps && !recentGpsError && recentGpsPoints.map((point) => (
                      <tr key={point.id}>
                        <td>{point.person_name}</td>
                        <td>{formatDateTime(point.captured_at)}</td>
                        <td>{point.planned_site_label ?? "-"}</td>
                        <td>
                          <StatusBadge tone={gpsStatusTone(point.plausibility_status)}>
                            {gpsStatusLabels[point.plausibility_status]}
                          </StatusBadge>
                        </td>
                        <td>{formatDistance(point.distance_to_planned_site_m, point.geofence_radius_m)}</td>
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

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
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

function formatGpsSignalRange(entry: TimeEntry): string {
  if (!entry.gps_first_seen_at) {
    return "GPS";
  }
  if (!entry.gps_last_seen_at || entry.gps_first_seen_at === entry.gps_last_seen_at) {
    return `GPS ${formatTime(entry.gps_first_seen_at)}`;
  }
  return `GPS ${formatTime(entry.gps_first_seen_at)}-${formatTime(entry.gps_last_seen_at)}`;
}

function formatGpsWorkMinutes(entry: TimeEntry): string {
  if (entry.gps_work_minutes === null) {
    return "nicht berechenbar";
  }
  return formatMinutes(entry.gps_work_minutes);
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
    break_minutes: "0",
    travel_minutes: "0",
    note: "",
  };
}

function timeEntryToForm(entry: TimeEntry): TimeEntryFormState {
  return {
    work_date: entry.work_date,
    site_id: entry.site_id ? String(entry.site_id) : "",
    hours: formatDecimalHours(entry.work_minutes),
    break_minutes: String(entry.break_minutes ?? 0),
    travel_minutes: String(entry.travel_minutes ?? 0),
    note: entry.note ?? "",
  };
}

function formatDecimalHours(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : String(Number(hours.toFixed(2))).replace(".", ",");
}

function formatDistance(distanceMeters: number | null, radiusMeters: number | null): string {
  if (distanceMeters === null) {
    return "-";
  }
  const distanceLabel = distanceMeters >= 1000
    ? `${formatDecimalNumber(distanceMeters / 1000, 1)} km`
    : `${Math.round(distanceMeters)} m`;
  if (radiusMeters === null) {
    return distanceLabel;
  }
  return `${distanceLabel} / Radius ${radiusMeters} m`;
}

function formatDecimalNumber(value: number, fractionDigits: number): string {
  return value.toLocaleString("de-DE", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  });
}

function buildTimeEntryPayload(
  form: TimeEntryFormState,
  personId: number,
): { ok: true; payload: TimeEntryCreate } | { ok: false; error: string } {
  if (!form.work_date) {
    return { ok: false, error: "Bitte ein Datum auswaehlen." };
  }

  const workMinutes = parseHoursToMinutes(form.hours);
  if (!workMinutes.ok) {
    return workMinutes;
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
      work_minutes: workMinutes.value,
      break_minutes: breakMinutes.value,
      travel_minutes: travelMinutes.value,
      note: form.note.trim() || null,
      source: "manual",
    },
  };
}

function parseHoursToMinutes(value: string): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed) {
    return { ok: false, error: "Bitte eine Arbeitszeit eintragen." };
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, error: "Arbeitszeit muss eine Zahl ab 0 sein." };
  }
  return { ok: true, value: Math.round(parsed * 60) };
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

function siteOptionLabel(site: SiteSummary): string {
  return [site.site_number, site.name].filter(Boolean).join(" · ") || `Baustelle ${site.id}`;
}

function getPlanningMatchStatus(
  entry: TimeEntry,
  plannedSiteIds: number[] | undefined,
  options: { isLoadingAssignments: boolean; assignmentsUnavailable: boolean },
): PlanningMatchStatus {
  if (options.isLoadingAssignments || options.assignmentsUnavailable) {
    return "not_checkable";
  }
  const hasPlannedSites = Boolean(plannedSiteIds?.length);
  const reportedSiteId = entry.site_id;
  if (!hasPlannedSites && !reportedSiteId) {
    return "unknown";
  }
  if (!hasPlannedSites && reportedSiteId) {
    return "without_plan";
  }
  if (hasPlannedSites && !reportedSiteId) {
    return "missing_reported_site";
  }
  if (plannedSiteIds?.includes(reportedSiteId as number)) {
    return "matches";
  }
  return "needs_review";
}

function planningStatusTone(status: PlanningMatchStatus): StatusBadgeTone {
  if (status === "matches") {
    return "active";
  }
  if (status === "needs_review" || status === "missing_reported_site") {
    return "warning";
  }
  if (status === "without_plan") {
    return "planned";
  }
  return "neutral";
}

function gpsStatusTone(status: TimeEntryGpsStatus): StatusBadgeTone {
  if (status === "matched") {
    return "active";
  }
  if (status === "partial") {
    return "planned";
  }
  if (status === "mismatch") {
    return "warning";
  }
  return "neutral";
}

function gpsStatusTitle(entry: TimeEntry): string {
  if (!entry.gps_status) {
    return "GPS-Plausibilitaet wurde nicht berechnet.";
  }
  const baseTitle = gpsStatusTitles[entry.gps_status];
  if (entry.gps_total_points === null || entry.gps_matched_points === null) {
    return baseTitle;
  }
  return `${baseTitle} ${entry.gps_matched_points} von ${entry.gps_total_points} Punkten im Radius.`;
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
