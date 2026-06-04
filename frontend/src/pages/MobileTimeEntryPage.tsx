import { ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import type { MobileAssignment } from "../types/mobile";
import type { Site } from "../types/site";
import type { TimeEntry, TimeEntryCreate } from "../types/timeEntry";

type MobileTimeView = "month" | "day";

type CalendarDay = {
  date: string;
  day: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
};

type TimeFormState = {
  siteId: string;
  startTime: string;
  endTime: string;
};

type SiteSelectionMode = "planned" | "other";

type MobileTimeSiteOption = {
  id: number;
  site_number: string | null;
  name: string;
};

type DayWorkSummary = {
  key: string;
  siteLabel: string;
  minutes: number;
};

type TimeOverlapConflictEntry = {
  id: number;
  site_id: number | null;
  site_label: string;
  start_time: string | null;
  end_time: string | null;
};

type TimeOverlapConflict = {
  message: string;
  conflicts: TimeOverlapConflictEntry[];
};

const WEEKDAY_LABELS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const BREAK_THRESHOLD_MINUTES = 510;

export function MobileTimeEntryPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const personId = user?.person_id ?? null;
  const today = useMemo(() => toIsoDate(new Date()), []);
  const currentMonth = useMemo(() => startOfMonth(parseDateInput(today)), [today]);

  const [activeView, setActiveView] = useState<MobileTimeView>("month");
  const [visibleMonth, setVisibleMonth] = useState(currentMonth);
  const [selectedDate, setSelectedDate] = useState(today);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [assignments, setAssignments] = useState<MobileAssignment[]>([]);
  const [activeSites, setActiveSites] = useState<Site[]>([]);
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  const [form, setForm] = useState<TimeFormState>({ siteId: "", startTime: "", endTime: "" });
  const [siteSelectionMode, setSiteSelectionMode] = useState<SiteSelectionMode>("planned");
  const [timeConflict, setTimeConflict] = useState<TimeOverlapConflict | null>(null);
  const [suggestionMessage, setSuggestionMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const loadRange = useMemo(
    () => ({
      start: toIsoDate(startOfMonth(addMonths(visibleMonth, -1))),
      end: toIsoDate(endOfMonth(addMonths(visibleMonth, 1))),
    }),
    [visibleMonth],
  );

  const loadTimeData = useCallback(async () => {
    if (personId === null) {
      setIsLoading(false);
      setLoadError("Für deinen Benutzer ist kein Monteurprofil hinterlegt.");
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      const [timeEntries, assignmentResponse, sites] = await Promise.all([
        api.timeEntries({ personId, dateFrom: loadRange.start, dateTo: loadRange.end }),
        api.myAssignmentHistory({ start: loadRange.start, end: loadRange.end }),
        api.sites({ includeClosed: false }),
      ]);
      setEntries(timeEntries.filter(isEditableManualEntry).sort(compareEntries));
      setAssignments(assignmentResponse.assignments);
      setActiveSites(sites);
    } catch (error) {
      setLoadError(getErrorMessage(error, "Arbeitszeiten konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }, [loadRange.end, loadRange.start, personId]);

  useEffect(() => {
    void loadTimeData();
  }, [loadTimeData]);

  const entriesByDate = useMemo(() => {
    const grouped = new Map<string, TimeEntry[]>();
    for (const entry of entries) {
      const rows = grouped.get(entry.work_date) ?? [];
      rows.push(entry);
      grouped.set(entry.work_date, rows);
    }
    return grouped;
  }, [entries]);

  const selectedDateEntries = entriesByDate.get(selectedDate) ?? [];
  const editingEntry = selectedDateEntries.find((entry) => entry.id === editingEntryId) ?? null;
  const assignmentsForSelectedDate = useMemo(
    () => assignments.filter((assignment) => assignmentCoversDate(assignment, selectedDate)),
    [assignments, selectedDate],
  );
  const plannedSiteIds = useMemo(
    () => uniqueNumbers(assignmentsForSelectedDate.map((assignment) => assignment.site.id)),
    [assignmentsForSelectedDate],
  );
  const siteById = useMemo(() => buildSiteOptionMap(assignments, entries, activeSites), [activeSites, assignments, entries]);
  const prefillEntry = useMemo(
    () => (editingEntry ? null : findPrefillEntry(entries, selectedDate)),
    [editingEntry, entries, selectedDate],
  );

  useEffect(() => {
    const existingStart = normalizeTimeInput(editingEntry?.start_time);
    const existingEnd = normalizeTimeInput(editingEntry?.end_time);
    const suggestedStart = normalizeTimeInput(prefillEntry?.start_time);
    const suggestedEnd = normalizeTimeInput(prefillEntry?.end_time);
    const plannedSiteId = plannedSiteIds.length === 1 ? String(plannedSiteIds[0]) : "";
    const initialSiteId = editingEntry
      ? editingEntry.site_id !== null ? String(editingEntry.site_id) : ""
      : plannedSiteId;

    setForm({
      siteId: initialSiteId,
      startTime: existingStart ?? suggestedStart ?? "",
      endTime: existingEnd ?? suggestedEnd ?? "",
    });
    setSiteSelectionMode(initialSiteId && !plannedSiteIds.includes(Number(initialSiteId)) ? "other" : "planned");
    setSuggestionMessage(!editingEntry && suggestedStart && suggestedEnd ? "Zeiten vom letzten Eintrag vorgeschlagen." : null);
    setTimeConflict(null);
    setFormError(null);
    setSaveMessage(null);
  }, [editingEntry, plannedSiteIds, prefillEntry]);

  const relevantSiteIds = useMemo(() => {
    const ids = new Set<number>();
    for (const assignment of assignments) {
      ids.add(assignment.site.id);
    }
    for (const entry of entries) {
      if (entry.site_id !== null) {
        ids.add(entry.site_id);
      }
    }
    for (const site of activeSites) {
      ids.add(site.id);
    }
    return ids;
  }, [activeSites, assignments, entries]);

  const plannedSiteOptions = useMemo(
    () => plannedSiteIds
      .map((siteId) => siteById.get(siteId))
      .filter((site): site is MobileTimeSiteOption => Boolean(site))
      .sort(compareSites),
    [plannedSiteIds, siteById],
  );

  const otherSiteOptions = useMemo(
    () => Array.from(siteById.values())
      .filter((site) => relevantSiteIds.has(site.id))
      .sort(compareSites),
    [relevantSiteIds, siteById],
  );
  const visibleSiteOptions = siteSelectionMode === "planned" ? plannedSiteOptions : otherSiteOptions;

  const calendarDays = useMemo(() => buildMonthGrid(visibleMonth, today), [today, visibleMonth]);
  const weekDays = useMemo(() => buildWeekDays(selectedDate, today), [selectedDate, today]);
  const grossMinutes = calculateGrossMinutes(form.startTime, form.endTime);
  const breakMinutes = calculateBreakMinutes(form.startTime, form.endTime);
  const netMinutes = calculateNetMinutes(form.startTime, form.endTime);
  const timeValidationMessage = getTimeValidationMessage(form.startTime, form.endTime);
  const selectedAssignmentId = findAssignmentIdForSite(assignmentsForSelectedDate, form.siteId);

  function showMonth(month: Date) {
    const monthStart = startOfMonth(month);
    setVisibleMonth(monthStart);
    setSelectedDate(toIsoDate(monthStart));
    setEditingEntryId(null);
    setActiveView("month");
  }

  function showToday() {
    setVisibleMonth(currentMonth);
    setSelectedDate(today);
    setEditingEntryId(null);
    setActiveView("month");
  }

  function openDay(date: string) {
    setSelectedDate(date);
    const dateMonth = startOfMonth(parseDateInput(date));
    if (dateMonth.getFullYear() !== visibleMonth.getFullYear() || dateMonth.getMonth() !== visibleMonth.getMonth()) {
      setVisibleMonth(dateMonth);
    }
    setEditingEntryId(null);
    setActiveView("day");
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveCurrentForm();
  }

  async function saveCurrentForm(options: { replaceEntryId?: number; skipLocalConflict?: boolean } = {}) {
    setSaveMessage(null);
    setFormError(null);
    setTimeConflict(null);

    if (personId === null) {
      setFormError("Für deinen Benutzer ist kein Monteurprofil hinterlegt.");
      return;
    }
    if (!form.startTime || !form.endTime) {
      setFormError("Bitte Startzeit und Endzeit eintragen.");
      return;
    }
    if (timeValidationMessage || breakMinutes === null || netMinutes === null) {
      setFormError(timeValidationMessage ?? "Die Arbeitszeit konnte nicht berechnet werden.");
      return;
    }

    const targetEntryId = options.replaceEntryId ?? editingEntry?.id ?? null;
    if (!options.skipLocalConflict) {
      const localConflict = findTimeOverlapConflict({
        entries: selectedDateEntries,
        siteById,
        startTime: form.startTime,
        endTime: form.endTime,
        excludeEntryId: targetEntryId,
      });
      if (localConflict) {
        setTimeConflict(localConflict);
        return;
      }
    }

    const payload: TimeEntryCreate = {
      person_id: personId,
      site_id: form.siteId ? Number(form.siteId) : null,
      assignment_id: selectedAssignmentId,
      work_date: selectedDate,
      start_time: form.startTime,
      end_time: form.endTime,
      break_minutes: breakMinutes,
      travel_minutes: editingEntry?.travel_minutes ?? 0,
      work_minutes: netMinutes,
      note: editingEntry?.note ?? null,
      source: "manual",
      status: "submitted",
    };

    setIsSaving(true);
    try {
      const savedEntry = targetEntryId
        ? await api.updateTimeEntry(targetEntryId, payload)
        : await api.createTimeEntry(payload);
      setEntries((currentEntries) => upsertEntry(currentEntries, savedEntry));
      if (targetEntryId) {
        setEditingEntryId(savedEntry.id);
        setSaveMessage(options.replaceEntryId ? "Alter Eintrag wurde ersetzt." : "Eintrag aktualisiert.");
      } else {
        resetFormForNewEntry(plannedSiteIds);
        setSaveMessage("Zeit hinzugefügt.");
      }
    } catch (error) {
      const apiConflict = parseApiOverlapConflict(error, siteById);
      if (apiConflict) {
        setTimeConflict(apiConflict);
      } else {
        setFormError(getErrorMessage(error, "Arbeitszeit konnte nicht gespeichert werden."));
      }
    } finally {
      setIsSaving(false);
    }
  }

  function startNewEntry() {
    resetFormForNewEntry(plannedSiteIds);
    setEditingEntryId(null);
    setFormError(null);
    setSaveMessage(null);
    setTimeConflict(null);
  }

  function switchSiteSelectionMode(mode: SiteSelectionMode) {
    setSiteSelectionMode(mode);
    setForm((currentForm) => {
      if (mode === "planned") {
        const plannedSiteId = plannedSiteIds.length === 1 ? String(plannedSiteIds[0]) : "";
        return { ...currentForm, siteId: plannedSiteId };
      }
      return currentForm;
    });
    setFormError(null);
    setSaveMessage(null);
    setTimeConflict(null);
  }

  function editEntry(entry: TimeEntry) {
    setEditingEntryId(entry.id);
    setFormError(null);
    setSaveMessage(null);
    setTimeConflict(null);
  }

  function resetFormForNewEntry(nextPlannedSiteIds: number[]) {
    const plannedSiteId = nextPlannedSiteIds.length === 1 ? String(nextPlannedSiteIds[0]) : "";
    setForm({ siteId: plannedSiteId, startTime: "", endTime: "" });
    setSiteSelectionMode("planned");
    setSuggestionMessage(null);
  }

  return (
    <section className={classNames("mobile-page", "mobile-time-page", activeView === "day" && "is-day-view")}>
      {activeView === "month" ? (
        <header className="mobile-calendar-nav">
          <button className="mobile-calendar-back" type="button" onClick={() => navigate("/me/assignments")}>
            <ArrowLeft aria-hidden="true" size={18} />
            <span>Zurück</span>
          </button>
          <button className="mobile-calendar-today" type="button" onClick={showToday}>Heute</button>
        </header>
      ) : (
        <header className="mobile-calendar-nav">
          <button className="mobile-calendar-back" type="button" onClick={() => setActiveView("month")}>
            <ArrowLeft aria-hidden="true" size={18} />
            <span>Monat</span>
          </button>
          <strong>{formatMonth(visibleMonth)}</strong>
        </header>
      )}

      {loadError ? <p className="form-error">{loadError}</p> : null}
      {isLoading ? <div className="empty-panel">Kalender wird geladen...</div> : null}

      {!isLoading && activeView === "month" ? (
        <>
          <section className="mobile-time-month-hero" aria-label="Monatsnavigation">
            <button type="button" aria-label="Vorheriger Monat" onClick={() => showMonth(addMonths(visibleMonth, -1))}>
              <ChevronLeft aria-hidden="true" size={21} />
            </button>
            <div>
              <span>Lohnzeit erfassen</span>
              <h1>{formatMonth(visibleMonth)}</h1>
            </div>
            <button type="button" aria-label="Nächster Monat" onClick={() => showMonth(addMonths(visibleMonth, 1))}>
              <ChevronRight aria-hidden="true" size={21} />
            </button>
          </section>

          <section className="mobile-time-calendar-panel" aria-label="Monatskalender">
            <div className="mobile-calendar-weekdays" aria-hidden="true">
              {WEEKDAY_LABELS.map((weekday) => <span key={weekday}>{weekday}</span>)}
            </div>
            <div className="mobile-calendar-grid">
              {calendarDays.map((day) => {
                const dayEntries = entriesByDate.get(day.date) ?? [];
                const daySummaries = buildDayWorkSummaries(dayEntries, siteById);
                const hasPlannedAssignment = assignments.some((assignment) => assignmentCoversDate(assignment, day.date));
                return (
                  <button
                    className={classNames(
                      "mobile-calendar-day",
                      day.isToday && "is-today",
                      selectedDate === day.date && "is-selected",
                      daySummaries.length > 0 && "has-entry",
                      hasPlannedAssignment && "has-plan",
                      day.isWeekend && "is-weekend",
                      !day.isCurrentMonth && "is-outside-month",
                    )}
                    key={day.date}
                    type="button"
                    onClick={() => openDay(day.date)}
                  >
                    <span className="mobile-calendar-day-number">{day.day}</span>
                    <span className="mobile-calendar-day-events">
                      {daySummaries.slice(0, 2).map((summary) => (
                        <span className="mobile-calendar-event-chip" key={summary.key}>
                          <span>{summary.siteLabel}</span>
                          <strong>{formatHoursFromMinutes(summary.minutes)}</strong>
                        </span>
                      ))}
                      {daySummaries.length > 2 ? <span className="mobile-calendar-more-chip">+{daySummaries.length - 2}</span> : null}
                      {daySummaries.length === 0 && hasPlannedAssignment ? <span className="mobile-calendar-day-plan">Einsatz</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </>
      ) : null}

      {!isLoading && activeView === "day" ? (
        <>
          <section className="mobile-week-strip" aria-label="Woche auswählen">
            {weekDays.map((day) => (
              <button
                className={classNames(
                  "mobile-week-day",
                  day.date === selectedDate && "is-selected",
                  day.isToday && "is-today",
                  day.isWeekend && "is-weekend",
                )}
                key={day.date}
                type="button"
                onClick={() => openDay(day.date)}
              >
                <span>{formatWeekdayShort(day.date)}</span>
                <strong>{day.day}</strong>
              </button>
            ))}
          </section>

          <section className="mobile-time-entry-panel mobile-time-day-panel" aria-label="Arbeitszeit erfassen">
	            <div className="mobile-time-entry-heading">
	              <span>{formatCalendarWeek(selectedDate)}</span>
	              <h1>{formatDetailDate(selectedDate)}</h1>
	              {editingEntry ? <p>Gespeicherter Eintrag wird bearbeitet.</p> : null}
	              {!editingEntry && suggestionMessage ? <p>{suggestionMessage}</p> : null}
	            </div>

	            <div className="mobile-time-plan-note">
	              {plannedSiteIds.length === 0 ? "Keine Baustelle geplant. Du kannst eine Baustelle auswählen." : null}
	              {plannedSiteIds.length === 1 ? `Geplant: ${formatSiteLabel(plannedSiteIds[0], siteById)}` : null}
	              {plannedSiteIds.length > 1 ? `Mehrere Einsätze geplant: ${plannedSiteIds.map((siteId) => formatSiteLabel(siteId, siteById)).join(", ")}` : null}
	            </div>

	            <form className="mobile-time-form" onSubmit={(event) => void handleSave(event)}>
	              <label className="mobile-time-field">
	                <span>Baustelle</span>
	                <div className="mobile-time-site-mode" aria-label="Baustellen-Auswahlmodus">
	                  <button
	                    className={classNames(siteSelectionMode === "planned" && "active")}
	                    type="button"
	                    onClick={() => switchSiteSelectionMode("planned")}
	                  >
	                    Geplante Baustelle
	                  </button>
	                  <button
	                    className={classNames(siteSelectionMode === "other" && "active")}
	                    type="button"
	                    onClick={() => switchSiteSelectionMode("other")}
	                  >
	                    Andere Baustelle auswählen
	                  </button>
	                </div>
	                <select value={form.siteId} onChange={(event) => {
	                  setForm((currentForm) => ({ ...currentForm, siteId: event.target.value }));
	                  setFormError(null);
	                  setSaveMessage(null);
	                  setTimeConflict(null);
	                }}>
	                  <option value="">
	                    {siteSelectionMode === "planned" && plannedSiteOptions.length === 0
	                      ? "Keine Baustelle geplant"
	                      : "Keine Baustelle ausgewählt"}
	                  </option>
	                  {visibleSiteOptions.map((site) => (
	                    <option key={site.id} value={site.id}>{siteOptionLabel(site)}</option>
	                  ))}
	                </select>
	              </label>
	              {siteSelectionMode === "other" && plannedSiteIds.length > 0 ? (
	                <p className="form-info mobile-time-deviation-note">
	                  Andere Baustelle: Die spätere Prüfung erkennt die Abweichung zur Planmatrix.
	                </p>
	              ) : null}

              <div className="mobile-time-form-grid">
                <label className="mobile-time-field">
                  <span>Startzeit</span>
                  <input
                    required
                    type="time"
                    value={form.startTime}
                    onChange={(event) => {
                      setForm((currentForm) => ({ ...currentForm, startTime: event.target.value }));
                      setFormError(null);
                      setSaveMessage(null);
                    }}
                  />
                </label>
                <label className="mobile-time-field">
                  <span>Endzeit</span>
                  <input
                    required
                    type="time"
                    value={form.endTime}
                    onChange={(event) => {
                      setForm((currentForm) => ({ ...currentForm, endTime: event.target.value }));
                      setFormError(null);
                      setSaveMessage(null);
                    }}
                  />
                </label>
              </div>

              <div className="mobile-time-summary">
                <div>
                  <span>Pause automatisch</span>
                  <strong>{breakMinutes !== null ? formatHoursFromMinutes(breakMinutes) : "-"}</strong>
                </div>
                <div>
                  <span>Arbeitszeit netto</span>
                  <strong>{netMinutes !== null ? formatHoursFromMinutes(netMinutes) : "-"}</strong>
                </div>
                <div>
                  <span>Brutto</span>
                  <strong>{grossMinutes !== null ? formatHoursFromMinutes(grossMinutes) : "-"}</strong>
                </div>
              </div>

	              {timeValidationMessage && form.startTime && form.endTime ? <p className="form-error">{timeValidationMessage}</p> : null}
	              {formError ? <p className="form-error">{formError}</p> : null}
	              {timeConflict ? (
	                <div className="mobile-time-conflict" role="alert">
	                  <strong>{timeConflict.message}</strong>
	                  {timeConflict.conflicts.map((conflict) => (
	                    <p key={conflict.id}>
	                      {conflict.site_label} · {formatTimeRange(conflict.start_time, conflict.end_time)}
	                    </p>
	                  ))}
	                  <div className="mobile-time-conflict-actions">
	                    <button type="button" onClick={() => setTimeConflict(null)}>Abbrechen</button>
	                    {timeConflict.conflicts[0] ? (
	                      <button type="button" onClick={() => {
	                        const conflictEntry = selectedDateEntries.find((entry) => entry.id === timeConflict.conflicts[0]?.id);
	                        if (conflictEntry) {
	                          editEntry(conflictEntry);
	                        }
	                      }}>
	                        Vorhandenen Eintrag bearbeiten
	                      </button>
	                    ) : null}
	                    {timeConflict.conflicts.length === 1 ? (
	                      <button type="button" onClick={() => void saveCurrentForm({ replaceEntryId: timeConflict.conflicts[0].id, skipLocalConflict: true })}>
	                        Alten Eintrag ersetzen
	                      </button>
	                    ) : null}
	                  </div>
	                </div>
	              ) : null}
	              {saveMessage ? (
	                <p className="form-info mobile-time-save-message">
	                  <CheckCircle2 aria-hidden="true" size={16} />
                  {saveMessage}
                </p>
	              ) : null}

	              <button className="primary-action mobile-time-save-button" disabled={isSaving} type="submit">
	                {isSaving ? "Speichert..." : editingEntry ? "Eintrag aktualisieren" : "Zeit hinzufügen"}
	              </button>
	              {editingEntry ? (
	                <button className="mobile-time-secondary-button" type="button" onClick={startNewEntry}>
	                  Neuer Eintrag
	                </button>
	              ) : null}
	            </form>

	            <section className="mobile-time-day-entries" aria-label="Gespeicherte Zeiten">
	              <div className="mobile-time-day-entries-heading">
	                <span>Einträge an diesem Tag</span>
	                <strong>{selectedDateEntries.length}</strong>
	              </div>
	              {selectedDateEntries.length === 0 ? (
	                <p>Noch keine Zeit für diesen Tag erfasst.</p>
	              ) : (
	                <div className="mobile-time-entry-bubbles">
	                  {selectedDateEntries.map((entry) => (
	                    <button
	                      className={classNames("mobile-time-entry-bubble", editingEntry?.id === entry.id && "is-editing")}
	                      key={entry.id}
	                      type="button"
	                      onClick={() => editEntry(entry)}
	                    >
	                      <strong>{formatEntryBubbleTitle(entry, siteById)}</strong>
	                      <span>{formatTimeRange(entry.start_time, entry.end_time)} · {formatHoursFromMinutes(entry.work_minutes)}</span>
	                    </button>
	                  ))}
	                </div>
	              )}
	            </section>
	          </section>
        </>
      ) : null}
    </section>
  );
}

function isEditableManualEntry(entry: TimeEntry): boolean {
  return entry.source !== "gps_suggestion" && !entry.is_gps_suggestion;
}

function compareEntries(first: TimeEntry, second: TimeEntry): number {
  if (first.work_date !== second.work_date) {
    return first.work_date.localeCompare(second.work_date);
  }
  return first.id - second.id;
}

function compareSites(first: MobileTimeSiteOption, second: MobileTimeSiteOption): number {
  const firstLabel = siteOptionLabel(first);
  const secondLabel = siteOptionLabel(second);
  return firstLabel.localeCompare(secondLabel, "de");
}

function buildSiteOptionMap(assignments: MobileAssignment[], entries: TimeEntry[], activeSites: Site[]): Map<number, MobileTimeSiteOption> {
  const sites = new Map<number, MobileTimeSiteOption>();
  for (const site of activeSites) {
    sites.set(site.id, {
      id: site.id,
      site_number: site.site_number,
      name: site.name,
    });
  }
  for (const assignment of assignments) {
    sites.set(assignment.site.id, {
      id: assignment.site.id,
      site_number: assignment.site.site_number,
      name: assignment.site.name,
    });
  }
  for (const entry of entries) {
    if (entry.site_id !== null && entry.site_name) {
      sites.set(entry.site_id, {
        id: entry.site_id,
        site_number: entry.site_number,
        name: entry.site_name,
      });
    }
  }
  return sites;
}

function buildDayWorkSummaries(entries: TimeEntry[], siteById: Map<number, MobileTimeSiteOption>): DayWorkSummary[] {
  const summaries = new Map<string, DayWorkSummary>();
  for (const entry of entries) {
    const key = entry.site_id !== null ? `site:${entry.site_id}` : "without-site";
    const siteLabel = entry.site_id !== null
      ? compactSiteLabel(entry.site_id, siteById, entry.site_name)
      : "Ohne Baustelle";
    const current = summaries.get(key);
    if (current) {
      current.minutes += entry.work_minutes;
    } else {
      summaries.set(key, { key, siteLabel, minutes: entry.work_minutes });
    }
  }
  return Array.from(summaries.values()).sort((first, second) => first.siteLabel.localeCompare(second.siteLabel, "de"));
}

function findTimeOverlapConflict({
  entries,
  siteById,
  startTime,
  endTime,
  excludeEntryId,
}: {
  entries: TimeEntry[];
  siteById: Map<number, MobileTimeSiteOption>;
  startTime: string;
  endTime: string;
  excludeEntryId: number | null;
}): TimeOverlapConflict | null {
  const start = parseTimeMinutes(startTime);
  const end = parseTimeMinutes(endTime);
  if (start === null || end === null || end <= start) {
    return null;
  }
  const conflicts = entries
    .filter((entry) => entry.id !== excludeEntryId)
    .filter((entry) => {
      const entryStart = parseTimeMinutes(entry.start_time);
      const entryEnd = parseTimeMinutes(entry.end_time);
      return entryStart !== null && entryEnd !== null && start < entryEnd && end > entryStart;
    })
    .map((entry) => timeOverlapConflictEntry(entry, siteById));

  if (conflicts.length === 0) {
    return null;
  }
  return {
    message: "Der neue Eintrag überschneidet sich mit einem vorhandenen Zeiteintrag.",
    conflicts,
  };
}

function timeOverlapConflictEntry(entry: TimeEntry, siteById: Map<number, MobileTimeSiteOption>): TimeOverlapConflictEntry {
  return {
    id: entry.id,
    site_id: entry.site_id,
    site_label: entry.site_id !== null ? formatSiteLabel(entry.site_id, siteById) : "Ohne Baustelle",
    start_time: entry.start_time,
    end_time: entry.end_time,
  };
}

function upsertEntry(entries: TimeEntry[], savedEntry: TimeEntry): TimeEntry[] {
  const nextEntries = entries.filter((entry) => entry.id !== savedEntry.id);
  nextEntries.push(savedEntry);
  return nextEntries.filter(isEditableManualEntry).sort(compareEntries);
}

function findPrefillEntry(entries: TimeEntry[], selectedDate: string): TimeEntry | null {
  const previousDay = addDays(parseDateInput(selectedDate), -1);
  const previousDayValue = toIsoDate(previousDay);
  const directPrevious = entries.find((entry) => entry.work_date === previousDayValue && entry.start_time && entry.end_time);
  if (directPrevious) {
    return directPrevious;
  }
  return [...entries]
    .filter((entry) => entry.work_date < selectedDate && entry.start_time && entry.end_time)
    .sort((first, second) => second.work_date.localeCompare(first.work_date) || second.id - first.id)[0] ?? null;
}

function assignmentCoversDate(assignment: MobileAssignment, date: string): boolean {
  return assignment.start_date <= date && assignment.end_date >= date;
}

function findAssignmentIdForSite(assignments: MobileAssignment[], siteId: string): number | null {
  if (!siteId) {
    return null;
  }
  const parsedSiteId = Number(siteId);
  return assignments.find((assignment) => assignment.site.id === parsedSiteId)?.id ?? null;
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
}

function calculateGrossMinutes(startTime: string, endTime: string): number | null {
  const start = parseTimeMinutes(startTime);
  const end = parseTimeMinutes(endTime);
  if (start === null || end === null || end <= start) {
    return null;
  }
  return end - start;
}

function calculateBreakMinutes(startTime: string, endTime: string): number | null {
  const grossMinutes = calculateGrossMinutes(startTime, endTime);
  if (grossMinutes === null) {
    return null;
  }
  return grossMinutes < BREAK_THRESHOLD_MINUTES ? 30 : 60;
}

function calculateNetMinutes(startTime: string, endTime: string): number | null {
  const grossMinutes = calculateGrossMinutes(startTime, endTime);
  const breakMinutes = calculateBreakMinutes(startTime, endTime);
  if (grossMinutes === null || breakMinutes === null) {
    return null;
  }
  return Math.max(grossMinutes - breakMinutes, 0);
}

function getTimeValidationMessage(startTime: string, endTime: string): string | null {
  if (!startTime || !endTime) {
    return null;
  }
  if (parseTimeMinutes(startTime) === null || parseTimeMinutes(endTime) === null) {
    return "Bitte gültige Uhrzeiten eintragen.";
  }
  if (calculateGrossMinutes(startTime, endTime) === null) {
    return "Endzeit muss nach Startzeit liegen.";
  }
  return null;
}

function parseTimeMinutes(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

function normalizeTimeInput(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{2}):(\d{2})/.exec(value);
  return match ? `${match[1]}:${match[2]}` : null;
}

function buildMonthGrid(month: Date, today: string): CalendarDay[] {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(monthStart);
  const leadingDays = (monthStart.getDay() + 6) % 7;
  const gridStart = addDays(monthStart, -leadingDays);
  const totalCells = Math.ceil((leadingDays + monthEnd.getDate()) / 7) * 7;
  return Array.from({ length: totalCells }, (_, index) => {
    const date = addDays(gridStart, index);
    const dateValue = toIsoDate(date);
    return {
      date: dateValue,
      day: date.getDate(),
      isCurrentMonth: date.getMonth() === monthStart.getMonth() && date.getFullYear() === monthStart.getFullYear(),
      isToday: dateValue === today,
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
    };
  });
}

function buildWeekDays(selectedDate: string, today: string): CalendarDay[] {
  const selected = parseDateInput(selectedDate);
  const mondayOffset = (selected.getDay() + 6) % 7;
  const weekStart = addDays(selected, -mondayOffset);
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart, index);
    const dateValue = toIsoDate(date);
    return {
      date: dateValue,
      day: date.getDate(),
      isCurrentMonth: true,
      isToday: dateValue === today,
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
    };
  });
}

function parseDateInput(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function endOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth() + 1, 0);
}

function addMonths(value: Date, count: number): Date {
  return new Date(value.getFullYear(), value.getMonth() + count, 1);
}

function addDays(value: Date, count: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + count);
}

function formatMonth(value: Date): string {
  return new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" }).format(value);
}

function formatDetailDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(parseDateInput(value));
}

function formatWeekdayShort(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { weekday: "short" }).format(parseDateInput(value)).replace(".", "");
}

function formatCalendarWeek(value: string): string {
  const { week, year } = getIsoWeek(parseDateInput(value));
  return `KW ${week} · ${year}`;
}

function formatHoursFromMinutes(minutes: number): string {
  return `${(minutes / 60).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}

function formatSiteLabel(siteId: number, siteById: Map<number, MobileTimeSiteOption>): string {
  const site = siteById.get(siteId);
  if (!site) {
    return `Baustelle ${siteId}`;
  }
  return siteOptionLabel(site);
}

function compactSiteLabel(siteId: number, siteById: Map<number, MobileTimeSiteOption>, fallbackName: string | null): string {
  const site = siteById.get(siteId);
  const label = site?.name ?? fallbackName ?? site?.site_number;
  return label || `Baustelle ${siteId}`;
}

function formatEntryBubbleTitle(entry: TimeEntry, siteById: Map<number, MobileTimeSiteOption>): string {
  if (entry.site_id === null) {
    return "Ohne Baustelle";
  }
  return formatSiteLabel(entry.site_id, siteById);
}

function formatTimeRange(startTime: string | null | undefined, endTime: string | null | undefined): string {
  const start = normalizeTimeInput(startTime);
  const end = normalizeTimeInput(endTime);
  if (!start || !end) {
    return "ohne Uhrzeit";
  }
  return `${start}–${end}`;
}

function siteOptionLabel(site: MobileTimeSiteOption): string {
  return [site.site_number, site.name].filter(Boolean).join(" - ") || `Baustelle ${site.id}`;
}

function getIsoWeek(value: Date): { week: number; year: number } {
  const date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return {
    week: Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7),
    year: date.getUTCFullYear(),
  };
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message || fallback;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}

function parseApiOverlapConflict(error: unknown, siteById: Map<number, MobileTimeSiteOption>): TimeOverlapConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409 || !isRecord(error.detail)) {
    return null;
  }
  if (error.detail.code !== "time_entry_overlap") {
    return null;
  }
  const rawConflicts = Array.isArray(error.detail.conflicts) ? error.detail.conflicts : [];
  const conflicts = rawConflicts
    .filter(isRecord)
    .map((conflict): TimeOverlapConflictEntry | null => {
      const id = typeof conflict.id === "number" ? conflict.id : null;
      if (id === null) {
        return null;
      }
      const siteId = typeof conflict.site_id === "number" ? conflict.site_id : null;
      const siteLabel = typeof conflict.site_label === "string"
        ? conflict.site_label
        : siteId !== null ? formatSiteLabel(siteId, siteById) : "Ohne Baustelle";
      return {
        id,
        site_id: siteId,
        site_label: siteLabel,
        start_time: typeof conflict.start_time === "string" ? conflict.start_time : null,
        end_time: typeof conflict.end_time === "string" ? conflict.end_time : null,
      };
    })
    .filter((conflict): conflict is TimeOverlapConflictEntry => conflict !== null);

  return {
    message: typeof error.detail.message === "string"
      ? error.detail.message
      : "Der neue Eintrag überschneidet sich mit einem vorhandenen Zeiteintrag.",
    conflicts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}
