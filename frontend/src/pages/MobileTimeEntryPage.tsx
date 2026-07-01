import { ArrowLeft, Building2, Car, ChevronLeft, ChevronRight, Clock3, LockKeyhole, Pencil, Pause } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import {
  formatGermanMonthYear as formatMonth,
  formatGermanWeekdayShortCompact as formatWeekdayShort,
  formatHoursFromMinutes,
} from "../lib/formatters";
import type { MobileAssignment, MobileSite } from "../types/mobile";
import type { TimeEntry, TimeEntryCreate, TimeEntryWeeklyReview } from "../types/timeEntry";

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
  breakMinutesOverride: number | null;
};

type TimeEntrySheetMode = "closed" | "site" | "manual" | "travel";
type TimePickerTarget = "start" | "end";

type MobileTimeSiteOption = {
  id: number;
  site_number: string | null;
  name: string;
  location: string | null;
};

type MobileTimeRecentSiteOption = MobileTimeSiteOption & {
  lastPlannedDate: string;
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
const BREAK_OPTION_MINUTES = [0, 15, 30, 45, 60, 90];
const TIME_PICKER_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const TIME_PICKER_MINUTES = Array.from({ length: 12 }, (_, index) => index * 5);

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
  const [weeklyReviews, setWeeklyReviews] = useState<TimeEntryWeeklyReview[]>([]);
  const [assignments, setAssignments] = useState<MobileAssignment[]>([]);
  const [activeSites, setActiveSites] = useState<MobileSite[]>([]);
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  const [form, setForm] = useState<TimeFormState>({ siteId: "", startTime: "", endTime: "", breakMinutesOverride: null });
  const [sheetMode, setSheetMode] = useState<TimeEntrySheetMode>("closed");
  const [isBreakPickerOpen, setIsBreakPickerOpen] = useState(false);
  const [manualSiteText, setManualSiteText] = useState("");
  const [timeConflict, setTimeConflict] = useState<TimeOverlapConflict | null>(null);
  const [suggestionMessage, setSuggestionMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assignmentLoadError, setAssignmentLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingEntryId, setDeletingEntryId] = useState<number | null>(null);
  const [timePickerTarget, setTimePickerTarget] = useState<TimePickerTarget | null>(null);
  const [timePickerDraftHour, setTimePickerDraftHour] = useState(7);
  const [timePickerDraftMinute, setTimePickerDraftMinute] = useState(0);
  const [timePickerInitialValue, setTimePickerInitialValue] = useState<{ hour: number; minute: number } | null>(null);
  const hourWheelRef = useRef<HTMLDivElement | null>(null);
  const minuteWheelRef = useRef<HTMLDivElement | null>(null);
  const hourWheelScrollTimeoutRef = useRef<number | null>(null);
  const minuteWheelScrollTimeoutRef = useRef<number | null>(null);

  const timeEntryLoadRange = useMemo(
    () => ({
      start: toIsoDate(startOfMonth(addMonths(visibleMonth, -1))),
      end: toIsoDate(endOfMonth(addMonths(visibleMonth, 1))),
    }),
    [visibleMonth],
  );
  const assignmentLoadRange = useMemo(
    () => ({
      start: toIsoDate(startOfMonth(addMonths(visibleMonth, -6))),
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
    setAssignmentLoadError(null);
    try {
      const weeklyReviewRequests = isoYearsInRange(timeEntryLoadRange.start, timeEntryLoadRange.end)
        .map((isoYear) => api.myTimeEntryWeeklyReviews({ isoYear }));
      const [timeEntriesResult, assignmentResult, sitesResult, weeklyReviewsResult] = await Promise.allSettled([
        api.timeEntries({ personId, dateFrom: timeEntryLoadRange.start, dateTo: timeEntryLoadRange.end }),
        api.myAssignmentHistory({ start: assignmentLoadRange.start, end: assignmentLoadRange.end }),
        api.mySites(),
        Promise.all(weeklyReviewRequests).then((reviewGroups) => reviewGroups.flat()),
      ]);

      if (timeEntriesResult.status === "fulfilled") {
        setEntries(timeEntriesResult.value.filter(isEditableManualEntry).sort(compareEntries));
      } else {
        setEntries([]);
        setLoadError(getErrorMessage(timeEntriesResult.reason, "Arbeitszeiten konnten nicht geladen werden."));
      }

      if (weeklyReviewsResult.status === "fulfilled") {
        setWeeklyReviews(weeklyReviewsResult.value);
      } else {
        setWeeklyReviews([]);
        setLoadError(getErrorMessage(weeklyReviewsResult.reason, "Prüfstatus konnte nicht geladen werden."));
      }

      if (assignmentResult.status === "fulfilled") {
        setAssignments(assignmentResult.value.assignments);
      } else {
        setAssignments([]);
        setAssignmentLoadError(getErrorMessage(assignmentResult.reason, "Planung konnte nicht geladen werden."));
      }

      if (sitesResult.status === "fulfilled") {
        setActiveSites(sitesResult.value);
      } else {
        setActiveSites([]);
      }
    } catch (error) {
      setLoadError(getErrorMessage(error, "Arbeitszeiten konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }, [assignmentLoadRange.end, assignmentLoadRange.start, personId, timeEntryLoadRange.end, timeEntryLoadRange.start]);

  useEffect(() => {
    void loadTimeData();
  }, [loadTimeData]);

  useEffect(() => {
    if (!timePickerTarget || !timePickerInitialValue) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      scrollWheelOptionIntoView(hourWheelRef.current, "hour", timePickerInitialValue.hour);
      scrollWheelOptionIntoView(minuteWheelRef.current, "minute", timePickerInitialValue.minute);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [timePickerInitialValue, timePickerTarget]);

  useEffect(() => () => {
    if (hourWheelScrollTimeoutRef.current !== null) {
      window.clearTimeout(hourWheelScrollTimeoutRef.current);
    }
    if (minuteWheelScrollTimeoutRef.current !== null) {
      window.clearTimeout(minuteWheelScrollTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    setFormError(null);
    setTimeConflict(null);
    setDeletingEntryId(null);
  }, [selectedDate]);

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
  const reviewedWeekKeys = useMemo(
    () => new Set(
      weeklyReviews
        .filter((review) => personId === null || review.person_id === personId)
        .map((review) => isoWeekKey(review.iso_year, review.iso_week)),
    ),
    [personId, weeklyReviews],
  );
  const isSelectedWeekLocked = reviewedWeekKeys.has(isoWeekKeyFromDate(selectedDate));
  const hasSelectedDateLockedEntries = isSelectedWeekLocked || selectedDateEntries.some(isLockedTimeEntry);
  const isSelectedDateFullyLocked = isSelectedWeekLocked || (selectedDateEntries.length > 0 && selectedDateEntries.every(isLockedTimeEntry));
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

  const plannedSiteOptions = useMemo(
    () => plannedSiteIds
      .map((siteId) => siteById.get(siteId))
      .filter((site): site is MobileTimeSiteOption => Boolean(site))
      .sort(compareSites),
    [plannedSiteIds, siteById],
  );

  const recentSiteOptions = useMemo(
    () => buildRecentPlannedSiteOptions({
      assignments,
      selectedDate,
      plannedSiteIds,
      siteById,
    }),
    [assignments, plannedSiteIds, selectedDate, siteById],
  );

  const calendarDays = useMemo(() => buildMonthGrid(visibleMonth, today), [today, visibleMonth]);
  const weekDays = useMemo(() => buildWeekDays(selectedDate, today), [selectedDate, today]);
  const grossMinutes = calculateGrossMinutes(form.startTime, form.endTime);
  const automaticBreakMinutes = calculateBreakMinutes(form.startTime, form.endTime);
  const breakMinutes = form.breakMinutesOverride ?? automaticBreakMinutes;
  const netMinutes = calculateNetMinutes(form.startTime, form.endTime, breakMinutes);
  const timeValidationMessage = getTimeValidationMessage(form.startTime, form.endTime);
  const breakValidationMessage = getBreakValidationMessage(grossMinutes, breakMinutes);

  function showMonth(month: Date) {
    const monthStart = startOfMonth(month);
    setVisibleMonth(monthStart);
    setSelectedDate(toIsoDate(monthStart));
    setEditingEntryId(null);
    closeTimeEntrySheet();
    setActiveView("month");
  }

  function showToday() {
    setVisibleMonth(currentMonth);
    setSelectedDate(today);
    setEditingEntryId(null);
    closeTimeEntrySheet();
    setActiveView("month");
  }

  function openDay(date: string) {
    setSelectedDate(date);
    const dateMonth = startOfMonth(parseDateInput(date));
    if (dateMonth.getFullYear() !== visibleMonth.getFullYear() || dateMonth.getMonth() !== visibleMonth.getMonth()) {
      setVisibleMonth(dateMonth);
    }
    setEditingEntryId(null);
    closeTimeEntrySheet();
    setActiveView("day");
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveCurrentForm();
  }

  function openSiteEntry(siteId: number) {
    if (isSelectedDateFullyLocked) {
      return;
    }
    const suggestedStart = normalizeTimeInput(prefillEntry?.start_time);
    const suggestedEnd = normalizeTimeInput(prefillEntry?.end_time);
    setEditingEntryId(null);
    setForm({
      siteId: String(siteId),
      startTime: suggestedStart ?? "",
      endTime: suggestedEnd ?? "",
      breakMinutesOverride: null,
    });
    setManualSiteText("");
    setSheetMode("site");
    setSuggestionMessage(suggestedStart && suggestedEnd ? "Zeiten vom letzten Eintrag vorgeschlagen." : null);
    setFormError(null);
    setTimeConflict(null);
    setIsBreakPickerOpen(false);
  }

  function openManualEntry(initialText = "") {
    if (isSelectedDateFullyLocked) {
      return;
    }
    const suggestedStart = normalizeTimeInput(prefillEntry?.start_time);
    const suggestedEnd = normalizeTimeInput(prefillEntry?.end_time);
    setEditingEntryId(null);
    setForm({
      siteId: "",
      startTime: suggestedStart ?? "",
      endTime: suggestedEnd ?? "",
      breakMinutesOverride: null,
    });
    setManualSiteText(initialText);
    setSheetMode("manual");
    setSuggestionMessage(suggestedStart && suggestedEnd ? "Zeiten vom letzten Eintrag vorgeschlagen." : null);
    setFormError(null);
    setTimeConflict(null);
    setIsBreakPickerOpen(false);
  }

  function openTravelTimeEntry() {
    if (isSelectedDateFullyLocked) {
      return;
    }
    const suggestedStart = normalizeTimeInput(prefillEntry?.end_time) ?? normalizeTimeInput(prefillEntry?.start_time);
    setEditingEntryId(null);
    setForm({
      siteId: plannedSiteOptions[0] ? String(plannedSiteOptions[0].id) : "",
      startTime: suggestedStart ?? "",
      endTime: "",
      breakMinutesOverride: 0,
    });
    setManualSiteText("");
    setSheetMode("travel");
    setSuggestionMessage(null);
    setFormError(null);
    setTimeConflict(null);
    setIsBreakPickerOpen(false);
  }

  function closeTimeEntrySheet() {
    setSheetMode("closed");
    setEditingEntryId(null);
    setForm({ siteId: "", startTime: "", endTime: "", breakMinutesOverride: null });
    setIsBreakPickerOpen(false);
    setManualSiteText("");
    setSuggestionMessage(null);
    setFormError(null);
    setTimeConflict(null);
    setTimePickerTarget(null);
    setTimePickerInitialValue(null);
  }

  async function saveCurrentForm(options: { replaceEntryId?: number; skipLocalConflict?: boolean } = {}) {
    setFormError(null);
    setTimeConflict(null);

    if (personId === null) {
      setFormError("Für deinen Benutzer ist kein Monteurprofil hinterlegt.");
      return;
    }
    if (isSelectedDateFullyLocked) {
      setFormError("Diese Woche wurde vom Büro geprüft und ist gesperrt.");
      return;
    }
    if (!form.startTime || !form.endTime) {
      setFormError("Bitte Startzeit und Endzeit eintragen.");
      return;
    }
    if (sheetMode === "site" && !form.siteId) {
      setFormError("Bitte eine Baustelle auswählen.");
      return;
    }
    if (sheetMode === "manual" && !manualSiteText.trim()) {
      setFormError("Bitte Baustelle oder Ort beschreiben.");
      return;
    }
    const isTravelTimeEntry = sheetMode === "travel";
    const effectiveBreakMinutes = isTravelTimeEntry ? 0 : breakMinutes;
    const effectiveWorkMinutes = isTravelTimeEntry ? 0 : netMinutes;
    const effectiveTravelMinutes = isTravelTimeEntry ? grossMinutes : editingEntry?.travel_minutes ?? 0;
    if (
      timeValidationMessage
      || (!isTravelTimeEntry && breakValidationMessage)
      || effectiveBreakMinutes === null
      || effectiveWorkMinutes === null
      || effectiveTravelMinutes === null
    ) {
      setFormError(timeValidationMessage ?? breakValidationMessage ?? "Die Arbeitszeit konnte nicht berechnet werden.");
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

    const isManualEntry = sheetMode === "manual";
    const nextSiteId = isManualEntry || !form.siteId ? null : Number(form.siteId);
    const nextAssignmentId = isManualEntry || !form.siteId ? null : findAssignmentIdForSite(assignmentsForSelectedDate, form.siteId);
    const nextNote = isManualEntry
      ? `Manuelle Baustelle: ${manualSiteText.trim()}`
      : isTravelTimeEntry
        ? "Fahrtzeit"
        : editingEntry?.note ?? null;

    const payload: TimeEntryCreate = {
      person_id: personId,
      site_id: nextSiteId,
      assignment_id: nextAssignmentId,
      work_date: selectedDate,
      start_time: form.startTime,
      end_time: form.endTime,
      break_minutes: effectiveBreakMinutes,
      travel_minutes: effectiveTravelMinutes,
      work_minutes: effectiveWorkMinutes,
      note: nextNote,
      source: "manual",
      status: "submitted",
    };

    setIsSaving(true);
    try {
      const savedEntry = targetEntryId
        ? await api.updateTimeEntry(targetEntryId, payload)
        : await api.createTimeEntry(payload);
      setEntries((currentEntries) => upsertEntry(currentEntries, savedEntry));
      closeTimeEntrySheet();
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

  async function deleteEntry(entry: TimeEntry) {
    if (deletingEntryId !== null) {
      return;
    }
    if (isSelectedDateFullyLocked || isLockedTimeEntry(entry)) {
      return;
    }
    if (!window.confirm("Zeiteintrag löschen?")) {
      return;
    }
    setDeletingEntryId(entry.id);
    try {
      await api.deleteTimeEntry(entry.id);
      setEntries((currentEntries) => currentEntries.filter((currentEntry) => currentEntry.id !== entry.id));
      if (editingEntryId === entry.id) {
        closeTimeEntrySheet();
      }
    } catch (error) {
      window.alert(getErrorMessage(error, "Zeiteintrag konnte nicht gelöscht werden."));
    } finally {
      setDeletingEntryId(null);
    }
  }

  function editEntry(entry: TimeEntry) {
    if (isSelectedDateFullyLocked || isLockedTimeEntry(entry)) {
      return;
    }
    const startTime = normalizeTimeInput(entry.start_time) ?? "";
    const endTime = normalizeTimeInput(entry.end_time) ?? "";
    const automaticEntryBreakMinutes = calculateBreakMinutes(startTime, endTime);
    setEditingEntryId(entry.id);
    setForm({
      siteId: entry.site_id !== null ? String(entry.site_id) : "",
      startTime,
      endTime,
      breakMinutesOverride: entry.break_minutes === automaticEntryBreakMinutes ? null : entry.break_minutes,
    });
    setManualSiteText(entry.site_id === null ? extractManualSiteText(entry.note) : "");
    setSheetMode(isTravelOnlyTimeEntry(entry) ? "travel" : entry.site_id === null ? "manual" : "site");
    setSuggestionMessage(null);
    setFormError(null);
    setTimeConflict(null);
    setIsBreakPickerOpen(false);
  }

  function openTimePicker(target: TimePickerTarget): void {
    const parsedTime = parseTimePickerValue(target === "start" ? form.startTime : form.endTime, target);
    setTimePickerDraftHour(parsedTime.hour);
    setTimePickerDraftMinute(parsedTime.minute);
    setTimePickerInitialValue(parsedTime);
    setTimePickerTarget(target);
  }

  function applyTimePickerValue(): void {
    if (!timePickerTarget) {
      return;
    }
    const selectedHour = getCenteredTimePickerValue(hourWheelRef.current, "hour") ?? timePickerDraftHour;
    const selectedMinute = getCenteredTimePickerValue(minuteWheelRef.current, "minute") ?? timePickerDraftMinute;
    const value = formatTimePickerValue(selectedHour, selectedMinute);
    setForm((currentForm) => ({
      ...currentForm,
      [timePickerTarget === "start" ? "startTime" : "endTime"]: value,
    }));
    setFormError(null);
    setTimeConflict(null);
    setTimePickerTarget(null);
    setTimePickerInitialValue(null);
  }

  function handleTimeWheelScroll(attribute: "hour" | "minute"): void {
    const timeoutRef = attribute === "hour" ? hourWheelScrollTimeoutRef : minuteWheelScrollTimeoutRef;
    const container = attribute === "hour" ? hourWheelRef.current : minuteWheelRef.current;
    const setValue = attribute === "hour" ? setTimePickerDraftHour : setTimePickerDraftMinute;
    updateTimePickerDraftFromWheel(container, attribute, setValue);
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = window.setTimeout(() => {
      const selectedValue = getCenteredTimePickerValue(container, attribute);
      if (selectedValue === null) {
        return;
      }
      scrollWheelOptionIntoView(container, attribute, selectedValue);
      setValue(selectedValue);
    }, 90);
  }

  const sheetSiteLabel = sheetMode === "manual"
    ? manualSiteText.trim() || "Baustelle abweichend von Planung"
    : sheetMode === "travel"
      ? "Fahrtzeit erfassen"
      : form.siteId ? formatSiteLabel(Number(form.siteId), siteById) : "Baustelle";

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
      {assignmentLoadError ? <p className="form-error">{assignmentLoadError}</p> : null}
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
                const isDayLocked = reviewedWeekKeys.has(isoWeekKeyFromDate(day.date)) || dayEntries.some(isLockedTimeEntry);
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
                      isDayLocked && "is-locked",
                    )}
                    key={day.date}
                    title={isDayLocked ? "Vom Büro geprüft" : undefined}
                    type="button"
                    onClick={() => openDay(day.date)}
                  >
                    <span className="mobile-calendar-day-number">{day.day}</span>
                    {isDayLocked ? (
                      <span className="mobile-calendar-day-lock" aria-label="Vom Büro geprüft">
                        <LockKeyhole aria-hidden="true" size={11} />
                      </span>
                    ) : null}
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
            {weekDays.map((day) => {
              const isDayLocked = reviewedWeekKeys.has(isoWeekKeyFromDate(day.date)) || (entriesByDate.get(day.date) ?? []).some(isLockedTimeEntry);
              return (
                <button
                  className={classNames(
                    "mobile-week-day",
                    day.date === selectedDate && "is-selected",
                    day.isToday && "is-today",
                    day.isWeekend && "is-weekend",
                    isDayLocked && "is-locked",
                  )}
                  key={day.date}
                  type="button"
                  onClick={() => openDay(day.date)}
                >
                  <span>{formatWeekdayShort(day.date)}</span>
                  <strong>{day.day}</strong>
                  {isDayLocked ? (
                    <small className="mobile-week-day-lock" aria-label="Vom Büro geprüft">
                      <LockKeyhole aria-hidden="true" size={10} />
                    </small>
                  ) : null}
                </button>
              );
            })}
          </section>

          <section className="mobile-time-entry-panel mobile-time-day-panel" aria-label="Arbeitszeit erfassen">
            <div className="mobile-time-site-picker">
              <section className="mobile-time-picker-section is-primary" aria-label="Geplante Baustellen">
                <div className="mobile-time-picker-heading">
                  <span>Heute geplant</span>
                </div>
                {plannedSiteOptions.length ? (
                  <div className="mobile-time-site-grid">
                    {plannedSiteOptions.map((site) => (
                      <article className="mobile-time-site-card is-planned" key={site.id}>
                        <div className="mobile-time-site-card-head">
                          <span className="mobile-time-site-icon" aria-hidden="true">
                            <Building2 size={19} />
                          </span>
                          <div className="mobile-time-site-copy">
                            <strong>{site.site_number || site.name}</strong>
                            <span>{site.site_number ? site.name : formatSiteMeta(site) || "Baustelle"}</span>
                            {site.site_number && site.location ? <small>{site.location}</small> : null}
                          </div>
                        </div>
                        <button
                          className="mobile-time-site-action"
                          disabled={isSelectedDateFullyLocked}
                          title={isSelectedDateFullyLocked ? "Diese Woche wurde vom Büro geprüft." : "Zeit erfassen"}
                          type="button"
                          onClick={() => openSiteEntry(site.id)}
                        >
                          <Clock3 aria-hidden="true" size={18} />
                          Zeit erfassen
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="mobile-time-picker-empty">Keine geplante Baustelle für diesen Tag.</p>
                )}
              </section>

              <section className="mobile-time-picker-section mobile-time-quick-section" aria-label="Schnellerfassung">
                <div className="mobile-time-picker-heading">
                  <span>Schnellerfassung</span>
                </div>
                <div className="mobile-time-manual-actions">
                  <button
                    className="mobile-time-manual-card"
                    disabled={isSelectedDateFullyLocked}
                    title={isSelectedDateFullyLocked ? "Diese Woche wurde vom Büro geprüft." : "Fahrtzeit erfassen"}
                    type="button"
                    onClick={() => openTravelTimeEntry()}
                  >
                    <span className="mobile-time-quick-icon" aria-hidden="true">
                      <Car size={21} />
                    </span>
                    <strong>Fahrtzeit</strong>
                    <span>erfassen</span>
                  </button>
                  <button
                    className="mobile-time-manual-card"
                    disabled={isSelectedDateFullyLocked}
                    title={isSelectedDateFullyLocked ? "Diese Woche wurde vom Büro geprüft." : "Manuell erfassen"}
                    type="button"
                    onClick={() => openManualEntry()}
                  >
                    <span className="mobile-time-quick-icon" aria-hidden="true">
                      <Pencil size={21} />
                    </span>
                    <strong>Manuell</strong>
                    <span>erfassen</span>
                  </button>
                </div>
              </section>

              <section className="mobile-time-day-entries" aria-label="Gespeicherte Zeiten">
                <div className="mobile-time-day-entries-heading">
                  <span>Heute erfasst</span>
                  {hasSelectedDateLockedEntries ? <strong>Vom Büro geprüft</strong> : null}
                </div>
                {selectedDateEntries.length === 0 ? (
                  <div className="mobile-time-empty-state">
                    <span aria-hidden="true">
                      <Pause size={24} />
                    </span>
                    <strong>Noch nichts erfasst</strong>
                    <p>Zeiten werden hier nach der Erfassung angezeigt.</p>
                  </div>
                ) : (
                  <div className="mobile-time-entry-bubbles">
                    {selectedDateEntries.map((entry) => {
                      const isDeleting = deletingEntryId === entry.id;
                      const isLocked = isSelectedWeekLocked || isLockedTimeEntry(entry);
                      return (
                        <article
                          className={classNames(
                            "mobile-time-entry-bubble",
                            editingEntry?.id === entry.id && "is-editing",
                            isLocked && "is-locked",
                          )}
                          key={entry.id}
                        >
                          <button
                            className="mobile-time-entry-bubble-open"
                            disabled={isLocked}
                            type="button"
                            onClick={() => editEntry(entry)}
                          >
                            <strong>{formatEntryBubbleTitle(entry, siteById)}</strong>
                            <span>{formatEntryBubbleMeta(entry)}</span>
                          </button>
                          {isLocked ? (
                            <span className="mobile-time-entry-lock-badge">
                              <LockKeyhole aria-hidden="true" size={12} />
                              Geprüft
                            </span>
                          ) : (
                            <button
                              aria-label={`${formatEntryBubbleTitle(entry, siteById)} löschen`}
                              className="mobile-time-entry-delete"
                              disabled={deletingEntryId !== null || isSaving}
                              title="Zeiteintrag löschen"
                              type="button"
                              onClick={() => deleteEntry(entry)}
                            >
                              {isDeleting ? "..." : "×"}
                            </button>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="mobile-time-picker-section is-secondary" aria-label="Vergangene geplante Baustellen">
                <div className="mobile-time-picker-heading">
                  <span>Baustellen der letzten 6 Monate</span>
                </div>
                {recentSiteOptions.length ? (
                  <div className="mobile-time-recent-strip">
                    {recentSiteOptions.map((site) => (
                      <button
                        className="mobile-time-site-card is-recent"
                        disabled={isSelectedDateFullyLocked}
                        key={site.id}
                        title={isSelectedDateFullyLocked ? "Diese Woche wurde vom Büro geprüft." : undefined}
                        type="button"
                        onClick={() => openSiteEntry(site.id)}
                      >
                        <strong>{site.site_number || site.name}</strong>
                        <span>{site.site_number ? site.name : formatSiteMeta(site) || "Baustelle"}</span>
                        <small>zuletzt {formatShortDate(site.lastPlannedDate)}</small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mobile-time-picker-empty">Keine vergangenen Baustellen gefunden.</p>
                )}
              </section>
            </div>
          </section>

          {sheetMode !== "closed" ? (
            <div className="mobile-dialog-backdrop mobile-time-sheet-backdrop" role="presentation" onClick={closeTimeEntrySheet}>
              <div
                className="mobile-project-email-dialog mobile-time-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="mobile-time-sheet-title"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="mobile-project-email-dialog-head mobile-time-sheet-heading">
                  <span>{editingEntry ? "Eintrag bearbeiten" : "Zeit erfassen"}</span>
                  <h2 id="mobile-time-sheet-title">{sheetSiteLabel}</h2>
                  {suggestionMessage ? <p>{suggestionMessage}</p> : null}
                </div>

                <form className="mobile-time-form" onSubmit={(event) => void handleSave(event)}>
                  {sheetMode === "manual" ? (
                    <label className="mobile-time-field">
                      <span>Baustelle / Ort beschreiben</span>
                      <input
                        autoFocus
                        required
                        type="text"
                        value={manualSiteText}
                        onChange={(event) => {
                          setManualSiteText(event.target.value);
                          setFormError(null);
                        }}
                        placeholder="z. B. Musterstraße 12, Kunde, Ort"
                      />
                    </label>
                  ) : null}

                  <div className="mobile-time-form-grid">
                    <div className="mobile-time-field">
                      <span>Startzeit</span>
                      <button className="mobile-time-value-button" type="button" onClick={() => openTimePicker("start")}>
                        {form.startTime || "--:--"}
                      </button>
                    </div>
                    <div className="mobile-time-field">
                      <span>Endzeit</span>
                      <button className="mobile-time-value-button" type="button" onClick={() => openTimePicker("end")}>
                        {form.endTime || "--:--"}
                      </button>
                    </div>
                  </div>

                  {sheetMode === "travel" ? (
                    <div className="mobile-time-summary is-travel">
                      <div>
                        <span>Fahrtzeit</span>
                        <strong>{grossMinutes !== null ? formatHoursFromMinutes(grossMinutes) : "-"}</strong>
                      </div>
                    </div>
                  ) : (
                    <div className="mobile-time-summary">
                      <button
                        className="mobile-time-summary-card mobile-time-break-card"
                        type="button"
                        onClick={() => setIsBreakPickerOpen(true)}
                      >
                        <span>{form.breakMinutesOverride === null ? "Pause automatisch" : "Pause manuell"}</span>
                        <strong>{breakMinutes !== null ? formatBreakHoursFromMinutes(breakMinutes) : "-"}</strong>
                      </button>
                      <div>
                        <span>Arbeitszeit netto</span>
                        <strong>{netMinutes !== null ? formatHoursFromMinutes(netMinutes) : "-"}</strong>
                      </div>
                      <div>
                        <span>Brutto</span>
                        <strong>{grossMinutes !== null ? formatHoursFromMinutes(grossMinutes) : "-"}</strong>
                      </div>
                    </div>
                  )}
                  {timeValidationMessage && form.startTime && form.endTime ? <p className="form-error">{timeValidationMessage}</p> : null}
                  {breakValidationMessage ? <p className="form-error">{breakValidationMessage}</p> : null}
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

                  <div className="mobile-time-sheet-actions">
                    <button className="mobile-time-secondary-button" type="button" onClick={closeTimeEntrySheet}>
                      Zurück
                    </button>
                    <button className="primary-action mobile-time-save-button" disabled={isSaving} type="submit">
                      {isSaving ? "Speichert..." : editingEntry ? "Eintrag aktualisieren" : "Zeit hinzufügen"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          ) : null}

          {isBreakPickerOpen && sheetMode !== "closed" ? (
            <div
              className="mobile-time-break-modal-backdrop"
              role="presentation"
              onClick={(event) => {
                event.stopPropagation();
                setIsBreakPickerOpen(false);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div
                className="mobile-time-break-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="mobile-time-break-modal-title"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <div className="mobile-time-break-modal-head">
                  <span>Pause</span>
                  <h2 id="mobile-time-break-modal-title">Pause anpassen</h2>
                  <p>{form.breakMinutesOverride === null ? "Automatischer Vorschlag aktiv." : "Manueller Pausenwert aktiv."}</p>
                </div>
                <div className="mobile-time-break-modal-options" aria-label="Pause auswählen">
                  {BREAK_OPTION_MINUTES.map((minutes) => {
                    const isDisabled = grossMinutes !== null && minutes > grossMinutes;
                    const isActive = breakMinutes === minutes && form.breakMinutesOverride !== null;
                    return (
                      <button
                        className={isActive ? "is-active" : ""}
                        disabled={isDisabled}
                        key={minutes}
                        type="button"
                        onClick={() => {
                          setForm((currentForm) => ({ ...currentForm, breakMinutesOverride: minutes }));
                          setFormError(null);
                          setTimeConflict(null);
                          setIsBreakPickerOpen(false);
                        }}
                      >
                        {formatBreakHoursFromMinutes(minutes)}
                      </button>
                    );
                  })}
                  <button
                    className={form.breakMinutesOverride === null ? "is-active" : ""}
                    type="button"
                    onClick={() => {
                      setForm((currentForm) => ({ ...currentForm, breakMinutesOverride: null }));
                      setFormError(null);
                      setTimeConflict(null);
                      setIsBreakPickerOpen(false);
                    }}
                  >
                    Auto
                  </button>
                </div>
                <div className="mobile-time-break-modal-actions">
                  <button type="button" onClick={() => setIsBreakPickerOpen(false)}>Abbrechen</button>
                </div>
              </div>
            </div>
          ) : null}

          {timePickerTarget ? (
            <div
              className="mobile-time-picker-backdrop"
              role="presentation"
              onClick={(event) => {
                event.stopPropagation();
                setTimePickerTarget(null);
                setTimePickerInitialValue(null);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div
                className="mobile-time-picker-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="mobile-time-picker-title"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <div className="mobile-time-picker-title">
                  <span>{timePickerTarget === "start" ? "Startzeit" : "Endzeit"}</span>
                  <strong id="mobile-time-picker-title">{formatTimePickerValue(timePickerDraftHour, timePickerDraftMinute)}</strong>
                </div>
                <div className="mobile-time-picker-wheels" aria-label="Uhrzeit auswählen">
                  <div className="mobile-time-picker-wheel-frame">
                    <div
                      className="mobile-time-picker-wheel"
                      aria-label="Stunde"
                      ref={hourWheelRef}
                      onScroll={() => handleTimeWheelScroll("hour")}
                    >
                      {TIME_PICKER_HOURS.map((hour) => (
                        <button
                          className={classNames(hour === timePickerDraftHour && "is-selected")}
                          data-hour={hour}
                          key={hour}
                          type="button"
                          onClick={() => {
                            setTimePickerDraftHour(hour);
                            scrollWheelOptionIntoView(hourWheelRef.current, "hour", hour);
                          }}
                        >
                          {String(hour).padStart(2, "0")}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mobile-time-picker-wheel-frame">
                    <div
                      className="mobile-time-picker-wheel"
                      aria-label="Minute"
                      ref={minuteWheelRef}
                      onScroll={() => handleTimeWheelScroll("minute")}
                    >
                      {TIME_PICKER_MINUTES.map((minute) => (
                        <button
                          className={classNames(minute === timePickerDraftMinute && "is-selected")}
                          data-minute={minute}
                          key={minute}
                          type="button"
                          onClick={() => {
                            setTimePickerDraftMinute(minute);
                            scrollWheelOptionIntoView(minuteWheelRef.current, "minute", minute);
                          }}
                        >
                          {String(minute).padStart(2, "0")}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="mobile-time-picker-actions">
                  <button type="button" onClick={() => {
                    setTimePickerTarget(null);
                    setTimePickerInitialValue(null);
                  }}>Abbrechen</button>
                  <button type="button" onClick={applyTimePickerValue}>Übernehmen</button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function isEditableManualEntry(entry: TimeEntry): boolean {
  return entry.source !== "gps_suggestion" && !entry.is_gps_suggestion;
}

function isLockedTimeEntry(entry: TimeEntry): boolean {
  return (
    entry.time_review_status !== "open"
    || entry.status === "reviewed"
    || entry.reviewed_by_user_id !== null
    || entry.reviewed_at !== null
    || entry.payroll_reviewed_by_user_id !== null
    || entry.payroll_reviewed_at !== null
    || entry.payroll_corrected_start_time !== null
    || entry.payroll_corrected_end_time !== null
    || entry.payroll_corrected_work_minutes !== null
  );
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

function buildSiteOptionMap(assignments: MobileAssignment[], entries: TimeEntry[], activeSites: MobileSite[]): Map<number, MobileTimeSiteOption> {
  const sites = new Map<number, MobileTimeSiteOption>();
  for (const site of activeSites) {
    sites.set(site.id, {
      id: site.id,
      site_number: site.site_number,
      name: site.name,
      location: site.location,
    });
  }
  for (const assignment of assignments) {
    sites.set(assignment.site.id, {
      id: assignment.site.id,
      site_number: assignment.site.site_number,
      name: assignment.site.name,
      location: assignment.site.location,
    });
  }
  for (const entry of entries) {
    if (entry.site_id !== null && entry.site_name) {
      const existingSite = sites.get(entry.site_id);
      sites.set(entry.site_id, {
        id: entry.site_id,
        site_number: entry.site_number,
        name: entry.site_name,
        location: existingSite?.location ?? null,
      });
    }
  }
  return sites;
}

function buildRecentPlannedSiteOptions({
  assignments,
  selectedDate,
  plannedSiteIds,
  siteById,
}: {
  assignments: MobileAssignment[];
  selectedDate: string;
  plannedSiteIds: number[];
  siteById: Map<number, MobileTimeSiteOption>;
}): MobileTimeRecentSiteOption[] {
  const cutoffDate = toIsoDate(addMonths(parseDateInput(selectedDate), -6));
  const excludedSiteIds = new Set(plannedSiteIds);
  const latestBySite = new Map<number, MobileTimeRecentSiteOption>();
  for (const assignment of assignments) {
    if (excludedSiteIds.has(assignment.site.id) || assignment.end_date >= selectedDate || assignment.end_date < cutoffDate) {
      continue;
    }
    const site = siteById.get(assignment.site.id) ?? {
      id: assignment.site.id,
      site_number: assignment.site.site_number,
      name: assignment.site.name,
      location: assignment.site.location,
    };
    const current = latestBySite.get(site.id);
    if (!current || assignment.end_date > current.lastPlannedDate) {
      latestBySite.set(site.id, { ...site, lastPlannedDate: assignment.end_date });
    }
  }
  return Array.from(latestBySite.values())
    .sort((first, second) => second.lastPlannedDate.localeCompare(first.lastPlannedDate) || compareSites(first, second))
    .slice(0, 3);
}

function buildDayWorkSummaries(entries: TimeEntry[], siteById: Map<number, MobileTimeSiteOption>): DayWorkSummary[] {
  const summaries = new Map<string, DayWorkSummary>();
  for (const entry of entries) {
    const isTravelOnly = isTravelOnlyTimeEntry(entry);
    const key = isTravelOnly ? "travel-time" : entry.site_id !== null ? `site:${entry.site_id}` : "without-site";
    const siteLabel = isTravelOnly
      ? "Fahrtzeit"
      : entry.site_id !== null
        ? compactSiteLabel(entry.site_id, siteById, entry.site_name)
        : extractManualSiteText(entry.note) || "Manuelle Baustelle";
    const minutes = timeEntryTotalMinutes(entry);
    const current = summaries.get(key);
    if (current) {
      current.minutes += minutes;
    } else {
      summaries.set(key, { key, siteLabel, minutes });
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
    site_label: entry.site_id !== null ? formatSiteLabel(entry.site_id, siteById) : extractManualSiteText(entry.note) || "Manuelle Baustelle",
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

function calculateNetMinutes(startTime: string, endTime: string, breakMinutesOverride?: number | null): number | null {
  const grossMinutes = calculateGrossMinutes(startTime, endTime);
  const breakMinutes = breakMinutesOverride ?? calculateBreakMinutes(startTime, endTime);
  if (grossMinutes === null || breakMinutes === null) {
    return null;
  }
  return Math.max(grossMinutes - breakMinutes, 0);
}

function formatBreakHoursFromMinutes(minutes: number): string {
  if (minutes === 0) {
    return "0 h";
  }
  const hours = minutes / 60;
  const fractionDigits = Number.isInteger(hours) || minutes % 30 === 0 ? 1 : 2;
  return `${hours.toLocaleString("de-DE", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })} h`;
}

function getBreakValidationMessage(grossMinutes: number | null, breakMinutes: number | null): string | null {
  if (grossMinutes === null || breakMinutes === null) {
    return null;
  }
  if (breakMinutes < 0) {
    return "Pause darf nicht negativ sein.";
  }
  if (breakMinutes > grossMinutes) {
    return "Pause darf nicht größer als die Bruttozeit sein.";
  }
  return null;
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

function parseTimePickerValue(value: string, target: TimePickerTarget): { hour: number; minute: number } {
  const minutes = parseTimeMinutes(value);
  if (minutes === null) {
    return target === "start" ? { hour: 7, minute: 0 } : { hour: 16, minute: 0 };
  }
  const hour = Math.floor(minutes / 60);
  const minute = Math.round((minutes % 60) / 5) * 5;
  if (minute >= 60) {
    return { hour: Math.min(hour + 1, 23), minute: 0 };
  }
  return { hour, minute };
}

function formatTimePickerValue(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function scrollWheelOptionIntoView(container: HTMLDivElement | null, attribute: "hour" | "minute", value: number): void {
  const option = container?.querySelector<HTMLElement>(`[data-${attribute}="${value}"]`);
  option?.scrollIntoView({ block: "center" });
}

function updateTimePickerDraftFromWheel(
  container: HTMLDivElement | null,
  attribute: "hour" | "minute",
  setValue: (value: number) => void,
): void {
  const centeredValue = getCenteredTimePickerValue(container, attribute);
  if (centeredValue !== null) {
    setValue(centeredValue);
  }
}

function getCenteredTimePickerValue(container: HTMLDivElement | null, attribute: "hour" | "minute"): number | null {
  if (!container) {
    return null;
  }
  const containerRect = container.getBoundingClientRect();
  const centerY = containerRect.top + containerRect.height / 2;
  const options = Array.from(container.querySelectorAll<HTMLElement>(`[data-${attribute}]`));
  let centeredValue: number | null = null;
  let smallestDistance = Number.POSITIVE_INFINITY;

  for (const option of options) {
    const optionRect = option.getBoundingClientRect();
    const optionCenterY = optionRect.top + optionRect.height / 2;
    const distance = Math.abs(optionCenterY - centerY);
    const rawValue = option.dataset[attribute];
    const numericValue = rawValue !== undefined ? Number(rawValue) : Number.NaN;
    if (Number.isFinite(numericValue) && distance < smallestDistance) {
      smallestDistance = distance;
      centeredValue = numericValue;
    }
  }

  return centeredValue;
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

function isoYearsInRange(start: string, end: string): number[] {
  const years = new Set<number>();
  let current = parseDateInput(start);
  const endDate = parseDateInput(end);
  while (current <= endDate) {
    years.add(isoWeekParts(current).year);
    current = addDays(current, 7);
  }
  years.add(isoWeekParts(endDate).year);
  return Array.from(years).sort((first, second) => first - second);
}

function isoWeekKeyFromDate(dateValue: string): string {
  const parts = isoWeekParts(parseDateInput(dateValue));
  return isoWeekKey(parts.year, parts.week);
}

function isoWeekKey(year: number, week: number): string {
  return `${year}-${String(week).padStart(2, "0")}`;
}

function isoWeekParts(value: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

function formatSiteLabel(siteId: number, siteById: Map<number, MobileTimeSiteOption>): string {
  const site = siteById.get(siteId);
  if (!site) {
    return `Baustelle ${siteId}`;
  }
  return siteOptionLabel(site);
}

function formatShortDate(value: string): string {
  const date = parseDateInput(value);
  return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${date.getFullYear()}`;
}

function compactSiteLabel(siteId: number, siteById: Map<number, MobileTimeSiteOption>, fallbackName: string | null): string {
  const site = siteById.get(siteId);
  const label = site?.name ?? fallbackName ?? site?.site_number;
  return label || `Baustelle ${siteId}`;
}

function extractManualSiteText(note: string | null | undefined): string {
  if (!note) {
    return "";
  }
  return note.replace(/^Manuelle Baustelle:\s*/i, "").trim();
}

function isTravelOnlyTimeEntry(entry: TimeEntry): boolean {
  return entry.work_minutes === 0 && entry.travel_minutes > 0;
}

function timeEntryTotalMinutes(entry: TimeEntry): number {
  return entry.work_minutes + (entry.travel_minutes || 0);
}

function formatEntryBubbleTitle(entry: TimeEntry, siteById: Map<number, MobileTimeSiteOption>): string {
  if (isTravelOnlyTimeEntry(entry)) {
    return "Fahrtzeit";
  }
  if (entry.site_id === null) {
    return extractManualSiteText(entry.note) || "Manuelle Baustelle";
  }
  return formatSiteLabel(entry.site_id, siteById);
}

function formatEntryBubbleMeta(entry: TimeEntry): string {
  const minutes = timeEntryTotalMinutes(entry);
  const suffix = isTravelOnlyTimeEntry(entry) ? "Fahrtzeit" : "netto";
  return `${formatTimeRange(entry.start_time, entry.end_time)} · ${formatHoursFromMinutes(minutes)} ${suffix}`;
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

function formatSiteMeta(site: MobileTimeSiteOption): string {
  return [site.site_number, site.location].filter(Boolean).join(" · ");
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
