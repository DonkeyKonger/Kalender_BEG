import { ChevronLeft, ChevronRight, ChevronsUpDown, RefreshCw } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "../auth/AuthContext";
import { StatusBadge, absenceTypeLabels, type StatusBadgeTone } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import {
  formatGermanDateKey as formatDate,
  formatGermanDateKeyRange as formatRangeLabel,
  formatGermanDateTimeShort as formatDateTime,
  formatGermanTimeShort as formatTime,
  formatGermanWeekdayShort as formatWeekday,
  formatHalfHourDeltaFromMinutes as formatHalfHourDelta,
  formatHalfHourFromMinutes as formatHalfHour,
  formatVerboseMinutes as formatMinutes,
} from "../lib/formatters";
import type { Absence } from "../types/absence";
import type { GpsRecentLocationPoint } from "../types/gps";
import type { AbsenceType } from "../types/matrix";
import type { Person } from "../types/person";
import type { SiteSummary } from "../types/site";
import type { TimeEntry, TimeEntryGpsStatus, TimeEntryPayrollCorrection, TimeEntryWeeklyReview, TimeReviewDecision } from "../types/timeEntry";

type TimeSubtab = "review" | "gpsVerification" | "evaluation";
type TimeReviewIssue = {
  id: number;
  entry: TimeEntry;
  workDate: string;
  personName: string;
  siteLabel: string;
  manualMinutes: number | null;
  gpsMinutes: number | null;
  deviationMinutes: number | null;
  finalMinutes: number | null;
  status: TimeReviewCaseStatus;
  statusLabel: string;
  statusTone: StatusBadgeTone;
  systemHint: string;
  priority: number;
  detail: string;
};
type TimeReviewCaseStatus = "auto_plausible" | "needs_review" | "critical" | "not_verifiable" | "verified" | "clarification";
type ReviewSummaryFilter = "all" | "matches" | "needs_review" | "verified";
type ReviewEditorMode = "corrected" | "assign_site" | null;
type ReviewDecisionFormState = {
  hours: string;
  site_id: string;
};
type PayrollDatePickerState = {
  entryId: number;
  left: number;
  top: number;
};
type PayrollCorrectionFormState = {
  start_time: string;
  end_time: string;
  hours: string;
};
type CalendarWeekSelection = {
  year: number;
  week: number;
};
type CalendarWeekOption = CalendarWeekSelection & {
  label: string;
  start: string;
  end: string;
  isCurrent: boolean;
};
type TimeReviewTableRow = {
  id: number;
  entry: TimeEntry;
  issue: TimeReviewIssue | null;
  workDate: string;
  personName: string;
  siteLabel: string;
  siteNumber: string;
  siteName: string;
  manualMinutes: number | null;
  gpsMinutes: number | null;
  deviationMinutes: number | null;
  correctedMinutes: number | null;
  statusLabel: string;
  statusTone: StatusBadgeTone;
  systemHint: string;
  canConfirm: boolean;
};
type TimeReviewWorkerSummary = {
  personId: number;
  personName: string;
  entryCount: number;
  dayCount: number;
  openIssueCount: number;
  reviewedEntryCount: number;
  totalMinutes: number;
  submittedMinutes: number;
  absenceType: AbsenceType | null;
  isReviewed: boolean;
  entries: TimeEntry[];
};
type TimeReviewCheckState = "ok" | "warning" | "unknown";
type TimeReviewEntryCheck = {
  entry: TimeEntry;
  locationCheck: TimeReviewCheckState;
  timeCheck: TimeReviewCheckState;
};
type TimeReviewWeekDay = {
  date: string;
  weekdayLabel: string;
  absenceType: AbsenceType | null;
  entries: TimeReviewEntryCheck[];
};
type TimeReviewDiagnosticRow = {
  source: string;
  start: string;
  end: string;
  total: string;
};
type LocationReviewDiagnosticRow = {
  source: string;
  siteName: string;
  siteNumber: string;
  location: string;
  isManualReview?: boolean;
};
type TimeReviewPerfApiCall = {
  name: string;
  durationMs: number;
  ok: boolean;
  rows?: number;
  details?: string;
};
type TimeReviewPerfCalculation = {
  name: string;
  durationMs: number;
  details?: string;
};
type TimeReviewPerfState = {
  apiCalls: TimeReviewPerfApiCall[];
  calculations: TimeReviewPerfCalculation[];
  completedApiCalls: Set<string>;
  expectedApiCalls: string[];
  flushScheduled: boolean;
  from: CalendarWeekSelection;
  hasLogged: boolean;
  renderCountAtStart: number;
  startedAt: number;
  to: CalendarWeekSelection;
};
type FinalHoursEntry = {
  id: number;
  workDate: string;
  personName: string;
  siteLabel: string;
  siteKey: string;
  finalMinutes: number | null;
  statusLabel: string;
  basisLabel: string;
  originalMinutes: number | null;
  gpsMinutes: number | null;
  deviationMinutes: number | null;
  note: string;
  reviewedAt: string | null;
  reviewedByUserId: number | null;
};
const GPS_TIME_TOLERANCE_MINUTES = 15;
const GPS_NOT_CHECKABLE_NOTICE = "GPS nicht eindeutig prüfbar";
const TIME_REVIEW_PERF_STORAGE_KEY = "beg_time_review_perf";
const TIME_REVIEW_API_OPEN_ENTRIES = "timeEntries(open review)";
const TIME_REVIEW_API_ALL_ENTRIES = "timeEntries(all week)";
const TIME_REVIEW_API_ABSENCES = "absences";
const TIME_REVIEW_API_WEEKLY_REVIEWS = "weekly reviews";
const OFFICE_ONLY_TIME_ENTRY_NOTE = "Büroprüfung ohne Monteur-Zeitmeldung.";
const timeSubtabs: { key: TimeSubtab; label: string }[] = [
  { key: "review", label: "Stundenprüfung" },
  { key: "gpsVerification", label: "GPS-Prüfung" },
  { key: "evaluation", label: "Auswertung" },
];

const gpsStatusLabels: Record<TimeEntryGpsStatus, string> = {
  matched: "passt",
  missing: "fehlt",
  partial: "teilweise",
  mismatch: "abweichend",
  not_checkable: "nicht pruefbar",
};

export function TimeEntriesPage() {
  const { user } = useAuth();
  const [people, setPeople] = useState<Person[]>([]);
  const [activeTimeSubtab, setActiveTimeSubtab] = useState<TimeSubtab>("review");
  const [reviewEntries, setReviewEntries] = useState<TimeEntry[]>([]);
  const [reviewAllEntries, setReviewAllEntries] = useState<TimeEntry[]>([]);
  const [reviewAbsences, setReviewAbsences] = useState<Absence[]>([]);
  const [reviewWeeklyReviews, setReviewWeeklyReviews] = useState<TimeEntryWeeklyReview[]>([]);
  const [reviewWeekCompletionReviews, setReviewWeekCompletionReviews] = useState<TimeEntryWeeklyReview[]>([]);
  const [recentGpsPoints, setRecentGpsPoints] = useState<GpsRecentLocationPoint[]>([]);
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [isLoadingPeople, setIsLoadingPeople] = useState(true);
  const [isLoadingReviewEntries, setIsLoadingReviewEntries] = useState(false);
  const [isLoadingReviewAllEntries, setIsLoadingReviewAllEntries] = useState(false);
  const [isLoadingRecentGps, setIsLoadingRecentGps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewEntriesError, setReviewEntriesError] = useState<string | null>(null);
  const [reviewAllEntriesError, setReviewAllEntriesError] = useState<string | null>(null);
  const [recentGpsError, setRecentGpsError] = useState<string | null>(null);
  const [reviewActionEntryId, setReviewActionEntryId] = useState<number | null>(null);
  const [reviewActionError, setReviewActionError] = useState<string | null>(null);
  const [expandedReviewEntryId, setExpandedReviewEntryId] = useState<number | null>(null);
  const [reviewEditorMode, setReviewEditorMode] = useState<ReviewEditorMode>(null);
  const [reviewDecisionForm, setReviewDecisionForm] = useState<ReviewDecisionFormState>({ hours: "", site_id: "" });
  const [isSavingReviewDecision, setIsSavingReviewDecision] = useState(false);
  const [payrollDatePicker, setPayrollDatePicker] = useState<PayrollDatePickerState | null>(null);
  const [payrollReviewActionEntryId, setPayrollReviewActionEntryId] = useState<number | null>(null);
  const [payrollDateActionEntryId, setPayrollDateActionEntryId] = useState<number | null>(null);
  const [payrollDateError, setPayrollDateError] = useState<string | null>(null);
  const [selectedReviewWeek, setSelectedReviewWeek] = useState<CalendarWeekSelection>(() => currentIsoWeek());
  const [selectedEvaluationWeek, setSelectedEvaluationWeek] = useState<CalendarWeekSelection>(() => currentIsoWeek());
  const [selectedReviewPersonId, setSelectedReviewPersonId] = useState<number | null>(null);
  const [timeReviewDiagnosticEntry, setTimeReviewDiagnosticEntry] = useState<TimeEntry | null>(null);
  const [timeReviewPopupTop, setTimeReviewPopupTop] = useState<number | null>(null);
  const [locationReviewDiagnosticEntry, setLocationReviewDiagnosticEntry] = useState<TimeEntry | null>(null);
  const [locationReviewSiteId, setLocationReviewSiteId] = useState("");
  const [locationReviewSiteSearch, setLocationReviewSiteSearch] = useState("");
  const [isLocationReviewPickerOpen, setIsLocationReviewPickerOpen] = useState(false);
  const [locationReviewError, setLocationReviewError] = useState<string | null>(null);
  const [isSavingLocationReview, setIsSavingLocationReview] = useState(false);
  const [locationReviewPopupTop, setLocationReviewPopupTop] = useState<number | null>(null);
  const [payrollCorrectionForm, setPayrollCorrectionForm] = useState<PayrollCorrectionFormState>({ start_time: "", end_time: "", hours: "" });
  const [payrollCorrectionError, setPayrollCorrectionError] = useState<string | null>(null);
  const [isSavingPayrollCorrection, setIsSavingPayrollCorrection] = useState(false);
  const [isDownloadingAllReviewWeekXlsx, setIsDownloadingAllReviewWeekXlsx] = useState(false);
  const [isDownloadingReviewWeekXlsx, setIsDownloadingReviewWeekXlsx] = useState(false);
  const [markingReviewWeekPersonId, setMarkingReviewWeekPersonId] = useState<number | null>(null);
  const [reviewHoursDownloadError, setReviewHoursDownloadError] = useState<string | null>(null);
  const [reviewWeekScrollState, setReviewWeekScrollState] = useState({ canScrollLeft: false, canScrollRight: false });
  const [evaluationWeekScrollState, setEvaluationWeekScrollState] = useState({ canScrollLeft: false, canScrollRight: false });
  const canManageTimeEntries = user?.role === "admin" || user?.role === "project_manager" || user?.role === "office";
  const canViewGpsVerification = user?.role === "admin";
  const visibleTimeSubtabs = canViewGpsVerification
    ? timeSubtabs
    : timeSubtabs.filter((tab) => tab.key !== "gpsVerification");
  const reviewWeekStripRef = useRef<HTMLDivElement | null>(null);
  const evaluationWeekStripRef = useRef<HTMLDivElement | null>(null);
  const timeReviewWorkerPanelRef = useRef<HTMLDivElement | null>(null);
  const hasAutoScrolledVisibleReviewWeekRef = useRef(false);
  const hasAutoScrolledVisibleEvaluationWeekRef = useRef(false);
  const timeReviewPerfRef = useRef<TimeReviewPerfState | null>(null);
  const timeReviewRenderCountRef = useRef(0);
  timeReviewRenderCountRef.current += 1;

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
    if (!canViewGpsVerification && activeTimeSubtab === "gpsVerification") {
      setActiveTimeSubtab("review");
    }
  }, [activeTimeSubtab, canViewGpsVerification]);

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

  const currentReviewWeek = useMemo(() => currentIsoWeek(), []);
  const reviewWeekRange = useMemo(
    () => isoWeekRange(selectedReviewWeek.year, selectedReviewWeek.week),
    [selectedReviewWeek.week, selectedReviewWeek.year],
  );
  const evaluationWeekRange = useMemo(
    () => isoWeekRange(selectedEvaluationWeek.year, selectedEvaluationWeek.week),
    [selectedEvaluationWeek.week, selectedEvaluationWeek.year],
  );
  const reviewDataRange = activeTimeSubtab === "evaluation" ? evaluationWeekRange : reviewWeekRange;
  const reviewWeekOptions = useMemo(
    () => buildCalendarWeekOptions(currentReviewWeek),
    [currentReviewWeek],
  );
  const payrollReviewWorkerIds = useMemo(
    () => people.filter(isPayrollReviewWorker).map((person) => person.id),
    [people],
  );
  const completedReviewWeekKeys = useMemo(
    () => buildCompletedReviewWeekKeys(reviewWeekCompletionReviews, payrollReviewWorkerIds),
    [payrollReviewWorkerIds, reviewWeekCompletionReviews],
  );
  const siteOptions = useMemo(
    () => [...sites].sort((left, right) => siteOptionLabel(left).localeCompare(siteOptionLabel(right), "de")),
    [sites],
  );
  const locationReviewSiteOptions = useMemo(
    () => siteOptions.filter(isSelectableLocationReviewSite),
    [siteOptions],
  );
  const locationReviewSiteSearchResults = useMemo(
    () => filterLocationReviewSites(locationReviewSiteOptions, locationReviewSiteSearch).slice(0, 8),
    [locationReviewSiteOptions, locationReviewSiteSearch],
  );
  const evaluationTimeReviewIssues = useMemo(() => buildTimeReviewIssues(reviewAllEntries), [reviewAllEntries]);
  const reviewedWorkerIds = useMemo(
    () => new Set(reviewWeeklyReviews.map((review) => review.person_id)),
    [reviewWeeklyReviews],
  );
  const timeReviewWorkers = useMemo(() => {
    const perfStart = timeReviewPerfNow();
    const result = buildTimeReviewWorkerSummaries(people, reviewAllEntries, reviewEntries, reviewAbsences, reviewedWorkerIds);
    recordTimeReviewPerfCalculation(timeReviewPerfRef, "worker summaries", perfStart, {
      details: `${people.length} Personen · ${reviewAllEntries.length} Einträge · ${reviewAbsences.length} Abwesenheiten · ${result.length} Monteure`,
    });
    return result;
  }, [people, reviewAbsences, reviewAllEntries, reviewEntries, reviewedWorkerIds]);
  const selectedReviewWorker = useMemo(
    () => timeReviewWorkers.find((worker) => worker.personId === selectedReviewPersonId) ?? null,
    [selectedReviewPersonId, timeReviewWorkers],
  );
  const selectedReviewWeekDays = useMemo(() => {
    const perfStart = timeReviewPerfNow();
    const result = buildTimeReviewWeekDays(
      selectedReviewWorker?.entries ?? [],
      reviewAbsences,
      selectedReviewWorker?.personId ?? null,
      reviewWeekRange.start,
    );
    recordTimeReviewPerfCalculation(timeReviewPerfRef, "selected worker week rows", perfStart, {
      details: `${selectedReviewWorker?.entries.length ?? 0} Einträge · ${reviewAbsences.length} Abwesenheiten`,
    });
    return result;
  }, [reviewAbsences, reviewWeekRange.start, selectedReviewWorker]);
  const selectedReviewWeekDayOptions = useMemo(
    () => buildReviewWeekDayOptions(reviewWeekRange.start),
    [reviewWeekRange.start],
  );
  const payrollDatePickerEntry = useMemo(
    () => payrollDatePicker ? findEntryInReviewWeekDays(selectedReviewWeekDays, payrollDatePicker.entryId) : null,
    [payrollDatePicker, selectedReviewWeekDays],
  );
  const finalHoursEntries = useMemo(() => buildFinalHoursEntries(reviewAllEntries), [reviewAllEntries]);
  const finalHoursTotals = useMemo(() => calculateFinalHoursTotals(finalHoursEntries), [finalHoursEntries]);
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
    if (selectedReviewPersonId !== null && !timeReviewWorkers.some((worker) => worker.personId === selectedReviewPersonId)) {
      setSelectedReviewPersonId(null);
    }
  }, [selectedReviewPersonId, timeReviewWorkers]);

  useEffect(() => {
    setTimeReviewDiagnosticEntry(null);
    setTimeReviewPopupTop(null);
    setLocationReviewDiagnosticEntry(null);
    setLocationReviewPopupTop(null);
    setPayrollDateError(null);
    setPayrollDateActionEntryId(null);
  }, [selectedReviewPersonId, selectedReviewWeek.week, selectedReviewWeek.year]);

  useEffect(() => {
    if (!timeReviewDiagnosticEntry) {
      setPayrollCorrectionForm({ start_time: "", end_time: "", hours: "" });
      setPayrollCorrectionError(null);
      setIsSavingPayrollCorrection(false);
      return;
    }
    setPayrollCorrectionForm({
      start_time: timeInputValue(timeReviewDiagnosticEntry.payroll_corrected_start_time),
      end_time: timeInputValue(timeReviewDiagnosticEntry.payroll_corrected_end_time),
      hours: timeReviewDiagnosticEntry.payroll_corrected_work_minutes !== null
        ? formatDecimalHours(timeReviewDiagnosticEntry.payroll_corrected_work_minutes)
        : "",
    });
    setPayrollCorrectionError(null);
  }, [timeReviewDiagnosticEntry]);

  useEffect(() => {
    if (!locationReviewDiagnosticEntry) {
      setLocationReviewSiteId("");
      setLocationReviewSiteSearch("");
      setIsLocationReviewPickerOpen(false);
      setLocationReviewError(null);
      setIsSavingLocationReview(false);
      return;
    }
    setLocationReviewSiteId(locationReviewDiagnosticEntry.site_id ? String(locationReviewDiagnosticEntry.site_id) : "");
    setLocationReviewSiteSearch("");
    setIsLocationReviewPickerOpen(false);
    setLocationReviewError(null);
  }, [locationReviewDiagnosticEntry]);

  useEffect(() => {
    if (!payrollDatePicker) {
      return;
    }

    function closeOnPointerDown(event: PointerEvent): void {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".time-review-day-move-button, .time-review-day-move-popover")) {
        return;
      }
      setPayrollDatePicker(null);
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setPayrollDatePicker(null);
      }
    }

    function closePicker(): void {
      setPayrollDatePicker(null);
    }

    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closePicker);
    window.addEventListener("scroll", closePicker, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closePicker);
      window.removeEventListener("scroll", closePicker, true);
    };
  }, [payrollDatePicker]);

  useEffect(() => {
    if (!timeReviewDiagnosticEntry && !locationReviewDiagnosticEntry) {
      return;
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setTimeReviewDiagnosticEntry(null);
        setTimeReviewPopupTop(null);
        setLocationReviewDiagnosticEntry(null);
        setLocationReviewPopupTop(null);
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [locationReviewDiagnosticEntry, timeReviewDiagnosticEntry]);

  useEffect(() => {
    if (activeTimeSubtab !== "review" && activeTimeSubtab !== "evaluation") {
      return;
    }

    let ignore = false;
    const perfStart = timeReviewPerfNow();
    let perfRows: number | undefined;
    let perfOk = false;
    setIsLoadingReviewEntries(true);
    setReviewEntriesError(null);

    api.timeEntries({
      dateFrom: reviewDataRange.start,
      dateTo: reviewDataRange.end,
      includeGpsStatus: true,
      reviewOpenOnly: true,
    })
      .then((entryData) => {
        perfRows = entryData.length;
        perfOk = true;
        if (!ignore) {
          setReviewEntries(entryData);
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setReviewEntries([]);
          setReviewEntriesError(readApiError(requestError, "Stundenpruefung konnte nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoadingReviewEntries(false);
          recordTimeReviewPerfApiCall(timeReviewPerfRef, timeReviewRenderCountRef, TIME_REVIEW_API_OPEN_ENTRIES, perfStart, {
            details: `${reviewDataRange.start} bis ${reviewDataRange.end}`,
            ok: perfOk,
            rows: perfRows,
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, reviewDataRange.end, reviewDataRange.start]);

  useLayoutEffect(() => {
    if (activeTimeSubtab !== "review") {
      hasAutoScrolledVisibleReviewWeekRef.current = false;
      return;
    }
    if (hasAutoScrolledVisibleReviewWeekRef.current) {
      return;
    }
    const animationFrameId = window.requestAnimationFrame(() => {
      scrollWeekStripToSelection(reviewWeekStripRef.current, reviewWeekOptions, selectedReviewWeek);
      updateReviewWeekScrollState();
      hasAutoScrolledVisibleReviewWeekRef.current = true;
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [activeTimeSubtab, reviewWeekOptions, selectedReviewWeek]);

  useLayoutEffect(() => {
    if (activeTimeSubtab !== "evaluation") {
      hasAutoScrolledVisibleEvaluationWeekRef.current = false;
      return;
    }
    if (hasAutoScrolledVisibleEvaluationWeekRef.current) {
      return;
    }
    const animationFrameId = window.requestAnimationFrame(() => {
      scrollWeekStripToSelection(evaluationWeekStripRef.current, reviewWeekOptions, selectedEvaluationWeek);
      updateEvaluationWeekScrollState();
      hasAutoScrolledVisibleEvaluationWeekRef.current = true;
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [activeTimeSubtab, reviewWeekOptions, selectedEvaluationWeek]);

  useEffect(() => {
    if (activeTimeSubtab !== "review") {
      return;
    }
    const container = reviewWeekStripRef.current;
    if (!container) {
      return;
    }
    updateReviewWeekScrollState();
    container.addEventListener("scroll", updateReviewWeekScrollState, { passive: true });
    window.addEventListener("resize", updateReviewWeekScrollState);
    return () => {
      container.removeEventListener("scroll", updateReviewWeekScrollState);
      window.removeEventListener("resize", updateReviewWeekScrollState);
    };
  }, [activeTimeSubtab, reviewWeekOptions]);

  useEffect(() => {
    if (activeTimeSubtab !== "evaluation") {
      return;
    }
    const container = evaluationWeekStripRef.current;
    if (!container) {
      return;
    }
    updateEvaluationWeekScrollState();
    container.addEventListener("scroll", updateEvaluationWeekScrollState, { passive: true });
    window.addEventListener("resize", updateEvaluationWeekScrollState);
    return () => {
      container.removeEventListener("scroll", updateEvaluationWeekScrollState);
      window.removeEventListener("resize", updateEvaluationWeekScrollState);
    };
  }, [activeTimeSubtab, reviewWeekOptions]);

  useEffect(() => {
    if (activeTimeSubtab !== "review") {
      setReviewAbsences([]);
      return;
    }

    let ignore = false;
    const perfStart = timeReviewPerfNow();
    let perfRows: number | undefined;
    let perfOk = false;
    api.absences({ start: reviewWeekRange.start, end: reviewWeekRange.end })
      .then((absenceData) => {
        perfRows = absenceData.length;
        perfOk = true;
        if (!ignore) {
          setReviewAbsences(absenceData);
        }
      })
      .catch(() => {
        if (!ignore) {
          setReviewAbsences([]);
        }
      })
      .finally(() => {
        if (!ignore) {
          recordTimeReviewPerfApiCall(timeReviewPerfRef, timeReviewRenderCountRef, TIME_REVIEW_API_ABSENCES, perfStart, {
            details: `${reviewWeekRange.start} bis ${reviewWeekRange.end}`,
            ok: perfOk,
            rows: perfRows,
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, reviewWeekRange.end, reviewWeekRange.start]);

  useEffect(() => {
    if (activeTimeSubtab !== "review" || !canManageTimeEntries) {
      setReviewWeeklyReviews([]);
      return;
    }

    let ignore = false;
    const perfStart = timeReviewPerfNow();
    let perfRows: number | undefined;
    let perfOk = false;
    setReviewWeeklyReviews([]);
    api.timeEntryWeeklyReviews({
      isoYear: selectedReviewWeek.year,
      isoWeek: selectedReviewWeek.week,
    })
      .then((weeklyReviews) => {
        perfRows = weeklyReviews.length;
        perfOk = true;
        if (!ignore) {
          setReviewWeeklyReviews(weeklyReviews);
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setReviewWeeklyReviews([]);
          setReviewActionError(readApiError(requestError, "Wochenpruefstatus konnte nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!ignore) {
          recordTimeReviewPerfApiCall(timeReviewPerfRef, timeReviewRenderCountRef, TIME_REVIEW_API_WEEKLY_REVIEWS, perfStart, {
            details: `KW ${selectedReviewWeek.week}/${selectedReviewWeek.year}`,
            ok: perfOk,
            rows: perfRows,
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, canManageTimeEntries, selectedReviewWeek.week, selectedReviewWeek.year]);

  useEffect(() => {
    if (activeTimeSubtab !== "review" || !canManageTimeEntries || payrollReviewWorkerIds.length === 0) {
      setReviewWeekCompletionReviews([]);
      return;
    }

    let ignore = false;
    const years = Array.from(new Set(reviewWeekOptions.map((option) => option.year)));
    Promise.all(years.map((isoYear) => api.timeEntryWeeklyReviews({ isoYear })))
      .then((reviewsByYear) => {
        if (!ignore) {
          setReviewWeekCompletionReviews(reviewsByYear.flat());
        }
      })
      .catch(() => {
        if (!ignore) {
          setReviewWeekCompletionReviews([]);
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, canManageTimeEntries, payrollReviewWorkerIds.length, reviewWeekOptions]);

  useEffect(() => {
    if (activeTimeSubtab !== "review" && activeTimeSubtab !== "evaluation") {
      return;
    }

    let ignore = false;
    const perfStart = timeReviewPerfNow();
    let perfRows: number | undefined;
    let perfOk = false;
    setIsLoadingReviewAllEntries(true);
    setReviewAllEntriesError(null);

    api.timeEntries({
      dateFrom: reviewDataRange.start,
      dateTo: reviewDataRange.end,
      includeGpsStatus: true,
    })
      .then((entryData) => {
        perfRows = entryData.length;
        perfOk = true;
        if (!ignore) {
          setReviewAllEntries(entryData);
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setReviewAllEntries([]);
          setReviewAllEntriesError(readApiError(requestError, "Auswertung konnte nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoadingReviewAllEntries(false);
          recordTimeReviewPerfApiCall(timeReviewPerfRef, timeReviewRenderCountRef, TIME_REVIEW_API_ALL_ENTRIES, perfStart, {
            details: `${reviewDataRange.start} bis ${reviewDataRange.end}`,
            ok: perfOk,
            rows: perfRows,
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, reviewDataRange.end, reviewDataRange.start]);

  function openReviewIssue(issue: TimeReviewIssue, mode: ReviewEditorMode = null): void {
    setExpandedReviewEntryId(issue.id);
    setReviewEditorMode(mode);
    setReviewDecisionForm({
      hours: formatDecimalHours(issue.finalMinutes ?? issue.manualMinutes ?? issue.gpsMinutes ?? 0),
      site_id: issue.entry.site_id ? String(issue.entry.site_id) : "",
    });
    setReviewActionError(null);
  }

  function closeReviewIssue(): void {
    if (isSavingReviewDecision) {
      return;
    }
    setExpandedReviewEntryId(null);
    setReviewEditorMode(null);
    setReviewDecisionForm({ hours: "", site_id: "" });
  }

  function applyUpdatedTimeEntry(updatedEntry: TimeEntry): void {
    setReviewEntries((current) => replaceTimeEntryInList(current, updatedEntry));
    setReviewAllEntries((current) => replaceTimeEntryInList(current, updatedEntry));
  }

  function applyCreatedTimeEntryFromMissingDay(missingEntry: TimeEntry, createdEntry: TimeEntry): TimeEntry {
    const hydratedEntry = mergeTimeEntryReviewUpdate(missingEntry, createdEntry);
    const shouldRemainInOpenReview = timeReviewIssue(hydratedEntry) !== null;
    setReviewEntries((current) => {
      const withoutMissingEntry = current.filter((entry) => entry.id !== missingEntry.id);
      return shouldRemainInOpenReview ? upsertTimeEntryInList(withoutMissingEntry, hydratedEntry) : withoutMissingEntry;
    });
    setReviewAllEntries((current) => upsertTimeEntryInList(current, hydratedEntry));
    return hydratedEntry;
  }

  function applyCreatedTimeEntryFromGpsSuggestion(suggestionEntry: TimeEntry, createdEntry: TimeEntry): void {
    const hydratedEntry = mergeTimeEntryReviewUpdate(suggestionEntry, createdEntry);
    const shouldRemainInOpenReview = timeReviewIssue(hydratedEntry) !== null;
    setReviewEntries((current) => {
      const withoutSuggestion = current.filter((entry) => entry.id !== suggestionEntry.id);
      return shouldRemainInOpenReview ? upsertTimeEntryInList(withoutSuggestion, hydratedEntry) : withoutSuggestion;
    });
    setReviewAllEntries((current) => upsertTimeEntryInList(current, hydratedEntry));
  }

  function selectReviewWeek(option: CalendarWeekSelection): void {
    if (option.year === selectedReviewWeek.year && option.week === selectedReviewWeek.week) {
      return;
    }
    startTimeReviewPerfSession(timeReviewPerfRef, timeReviewRenderCountRef.current, selectedReviewWeek, option, canManageTimeEntries);
    const scrollPosition = { left: window.scrollX, top: window.scrollY };
    setSelectedReviewWeek({ year: option.year, week: option.week });
    window.requestAnimationFrame(() => {
      window.scrollTo({ ...scrollPosition, behavior: "auto" });
    });
  }

  function selectEvaluationWeek(option: CalendarWeekSelection): void {
    if (option.year === selectedEvaluationWeek.year && option.week === selectedEvaluationWeek.week) {
      return;
    }
    const scrollPosition = { left: window.scrollX, top: window.scrollY };
    setSelectedEvaluationWeek({ year: option.year, week: option.week });
    window.requestAnimationFrame(() => {
      window.scrollTo({ ...scrollPosition, behavior: "auto" });
    });
  }

  function updateReviewWeekScrollState(): void {
    const container = reviewWeekStripRef.current;
    if (!container) {
      setReviewWeekScrollState({ canScrollLeft: false, canScrollRight: false });
      return;
    }
    const maxScrollLeft = container.scrollWidth - container.clientWidth;
    setReviewWeekScrollState({
      canScrollLeft: container.scrollLeft > 1,
      canScrollRight: container.scrollLeft < maxScrollLeft - 1,
    });
  }

  function updateEvaluationWeekScrollState(): void {
    const container = evaluationWeekStripRef.current;
    if (!container) {
      setEvaluationWeekScrollState({ canScrollLeft: false, canScrollRight: false });
      return;
    }
    const maxScrollLeft = container.scrollWidth - container.clientWidth;
    setEvaluationWeekScrollState({
      canScrollLeft: container.scrollLeft > 1,
      canScrollRight: container.scrollLeft < maxScrollLeft - 1,
    });
  }

  function scrollReviewWeeks(direction: -1 | 1): void {
    const container = reviewWeekStripRef.current;
    if (!container) {
      return;
    }
    const scrollAmount = Math.min(420, Math.max(260, container.clientWidth * 0.75));
    container.scrollBy({ left: direction * scrollAmount, behavior: "smooth" });
  }

  function scrollEvaluationWeeks(direction: -1 | 1): void {
    const container = evaluationWeekStripRef.current;
    if (!container) {
      return;
    }
    const scrollAmount = Math.min(420, Math.max(260, container.clientWidth * 0.75));
    container.scrollBy({ left: direction * scrollAmount, behavior: "smooth" });
  }

  async function decideReviewIssue(
    issue: TimeReviewIssue,
    decision: TimeReviewDecision,
    options: { finalMinutes?: number | null; reviewedSiteId?: number | null } = {},
  ): Promise<void> {
    if (!canManageTimeEntries || reviewActionEntryId !== null || isSavingReviewDecision) {
      return;
    }
    setReviewActionEntryId(issue.id);
    setReviewActionError(null);
    try {
      if (issue.entry.is_gps_suggestion) {
        const finalMinutes = options.finalMinutes ?? issue.gpsMinutes;
        const reviewedSiteId = options.reviewedSiteId ?? issue.entry.site_id;
        if (finalMinutes === null) {
          setReviewActionError("GPS-Zeit ist nicht berechenbar.");
          return;
        }
        if (reviewedSiteId === null) {
          setReviewActionError("Bitte eine Baustelle auswählen.");
          return;
        }
        const createdEntry = await api.createTimeEntry({
          person_id: issue.entry.person_id,
          site_id: reviewedSiteId,
          work_date: issue.entry.work_date,
          work_minutes: finalMinutes,
          break_minutes: 0,
          travel_minutes: 0,
          note: "Aus GPS-Vorschlag in der Stundenprüfung übernommen.",
        });
        const reviewedEntry = await api.decideTimeEntryReview(createdEntry.id, {
          decision: "accept_gps",
          final_work_minutes: finalMinutes,
          reviewed_site_id: reviewedSiteId,
        });
        setExpandedReviewEntryId(null);
        setReviewEditorMode(null);
        setReviewDecisionForm({ hours: "", site_id: "" });
        applyCreatedTimeEntryFromGpsSuggestion(issue.entry, reviewedEntry);
        return;
      }
      const updatedEntry = await api.decideTimeEntryReview(issue.id, {
        decision,
        final_work_minutes: options.finalMinutes ?? null,
        reviewed_site_id: options.reviewedSiteId ?? null,
      });
      setExpandedReviewEntryId(null);
      setReviewEditorMode(null);
      setReviewDecisionForm({ hours: "", site_id: "" });
      applyUpdatedTimeEntry(updatedEntry);
    } catch (requestError) {
      setReviewActionError(readApiError(requestError, "Prüfentscheidung konnte nicht gespeichert werden."));
    } finally {
      setReviewActionEntryId(null);
    }
  }

  async function confirmReviewRow(row: TimeReviewTableRow): Promise<void> {
    if (!canManageTimeEntries || reviewActionEntryId !== null || isSavingReviewDecision || !row.canConfirm) {
      return;
    }
    setReviewActionEntryId(row.id);
    setReviewActionError(null);
    try {
      const updatedEntry = await api.decideTimeEntryReview(row.id, {
        decision: "accept_manual",
        final_work_minutes: null,
        reviewed_site_id: null,
      });
      setExpandedReviewEntryId(null);
      setReviewEditorMode(null);
      setReviewDecisionForm({ hours: "", site_id: "" });
      applyUpdatedTimeEntry(updatedEntry);
    } catch (requestError) {
      setReviewActionError(readApiError(requestError, "Prüfentscheidung konnte nicht gespeichert werden."));
    } finally {
      setReviewActionEntryId(null);
    }
  }

  async function saveReviewDecision(issue: TimeReviewIssue, modeOverride?: ReviewEditorMode): Promise<void> {
    const decisionMode = modeOverride ?? reviewEditorMode;
    if (!decisionMode || isSavingReviewDecision) {
      return;
    }
    let finalMinutes: number | null = null;
    if (decisionMode === "corrected") {
      const parsedHours = parseHoursToMinutes(reviewDecisionForm.hours);
      if (!parsedHours.ok) {
        setReviewActionError(parsedHours.error);
        return;
      }
      finalMinutes = parsedHours.value;
    }
    let reviewedSiteId: number | null = null;
    if (reviewDecisionForm.site_id) {
      const parsedSiteId = Number(reviewDecisionForm.site_id);
      if (!Number.isInteger(parsedSiteId) || parsedSiteId <= 0) {
        setReviewActionError("Bitte eine gültige Baustelle auswählen.");
        return;
      }
      reviewedSiteId = parsedSiteId;
    }
    if (decisionMode === "assign_site" && reviewedSiteId === null) {
      setReviewActionError("Bitte eine Baustelle auswählen.");
      return;
    }

    setIsSavingReviewDecision(true);
    setReviewActionError(null);
    try {
      await decideReviewIssue(issue, decisionMode === "corrected" ? "corrected" : "assign_site", {
        finalMinutes,
        reviewedSiteId,
      });
    } finally {
      setIsSavingReviewDecision(false);
    }
  }

  async function togglePayrollRowReview(entry: TimeEntry): Promise<void> {
    if (!canManageTimeEntries || payrollReviewActionEntryId !== null || entry.id < 0) {
      return;
    }
    setPayrollReviewActionEntryId(entry.id);
    setReviewActionError(null);
    try {
      const updatedEntry = await api.setTimeEntryPayrollReview(entry.id, entry.payroll_reviewed_at === null);
      applyUpdatedTimeEntry(updatedEntry);
    } catch (requestError) {
      setReviewActionError(readApiError(requestError, "Zeilenprüfung konnte nicht gespeichert werden."));
    } finally {
      setPayrollReviewActionEntryId(null);
    }
  }

  function payrollPanelTop(): number | null {
    const panelTop = timeReviewWorkerPanelRef.current?.getBoundingClientRect().top;
    return typeof panelTop === "number" ? Math.max(24, Math.round(panelTop)) : null;
  }

  function openTimeReviewDiagnostic(entry: TimeEntry): void {
    setTimeReviewPopupTop(payrollPanelTop());
    setTimeReviewDiagnosticEntry(entry);
  }

  function closeTimeReviewDiagnostic(): void {
    setTimeReviewDiagnosticEntry(null);
    setTimeReviewPopupTop(null);
  }

  function openLocationReviewDiagnostic(entry: TimeEntry): void {
    setLocationReviewPopupTop(payrollPanelTop());
    setLocationReviewDiagnosticEntry(entry);
  }

  function closeLocationReviewDiagnostic(): void {
    setLocationReviewDiagnosticEntry(null);
    setLocationReviewPopupTop(null);
  }

  async function createTimeEntryForMissingDay(missingEntry: TimeEntry): Promise<TimeEntry> {
    if (missingEntry.person_id <= 0) {
      throw new Error("Monteur fehlt für die Büroprüfung.");
    }
    const createdEntry = await api.createTimeEntry({
      person_id: missingEntry.person_id,
      site_id: null,
      work_date: missingEntry.work_date,
      work_minutes: 0,
      break_minutes: 0,
      travel_minutes: 0,
      note: OFFICE_ONLY_TIME_ENTRY_NOTE,
    });
    return applyCreatedTimeEntryFromMissingDay(missingEntry, createdEntry);
  }

  function togglePayrollDatePicker(entry: TimeEntry, button: HTMLButtonElement): void {
    if (!canManageTimeEntries || payrollDateActionEntryId !== null || entry.id < 0) {
      return;
    }
    setPayrollDatePicker((current) => {
      if (current?.entryId === entry.id) {
        return null;
      }
      const rect = button.getBoundingClientRect();
      const popoverWidth = 96;
      return {
        entryId: entry.id,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8)),
        top: rect.bottom + 4,
      };
    });
  }

  function closePayrollDatePicker(): void {
    setPayrollDatePicker(null);
  }

  async function movePayrollEntryDate(entry: TimeEntry, targetWorkDate: string): Promise<void> {
    if (!canManageTimeEntries || payrollDateActionEntryId !== null || entry.id < 0) {
      return;
    }
    if (entry.work_date === targetWorkDate) {
      closePayrollDatePicker();
      return;
    }
    closePayrollDatePicker();
    setPayrollDateActionEntryId(entry.id);
    setPayrollDateError(null);
    try {
      const updatedEntry = await api.setTimeEntryPayrollDateCorrection(entry.id, { work_date: targetWorkDate });
      applyUpdatedTimeEntry(updatedEntry);
    } catch (requestError) {
      setPayrollDateError(readApiError(requestError, "Tag konnte nicht geändert werden."));
    } finally {
      setPayrollDateActionEntryId(null);
    }
  }

  async function savePayrollTimeCorrection(): Promise<void> {
    if (!canManageTimeEntries || !timeReviewDiagnosticEntry || isSavingPayrollCorrection) {
      return;
    }
    const payload = buildPayrollCorrectionPayload(payrollCorrectionForm);
    if (!payload.ok) {
      setPayrollCorrectionError(payload.error);
      return;
    }

    setIsSavingPayrollCorrection(true);
    setPayrollCorrectionError(null);
    try {
      const targetEntry = timeReviewDiagnosticEntry.id < 0
        ? await createTimeEntryForMissingDay(timeReviewDiagnosticEntry)
        : timeReviewDiagnosticEntry;
      const updatedEntry = await api.setTimeEntryPayrollCorrection(targetEntry.id, payload.payload);
      applyUpdatedTimeEntry(updatedEntry);
      setTimeReviewDiagnosticEntry((currentEntry) => (
        currentEntry?.id === timeReviewDiagnosticEntry.id || currentEntry?.id === updatedEntry.id
          ? mergeTimeEntryReviewUpdate(targetEntry, updatedEntry)
          : currentEntry
      ));
    } catch (requestError) {
      setPayrollCorrectionError(readApiError(requestError, "Bürozeit konnte nicht gespeichert werden."));
    } finally {
      setIsSavingPayrollCorrection(false);
    }
  }

  async function saveLocationReviewSite(): Promise<void> {
    if (!canManageTimeEntries || !locationReviewDiagnosticEntry || isSavingLocationReview) {
      return;
    }

    const parsedSiteId = Number(locationReviewSiteId);
    if (!Number.isInteger(parsedSiteId) || parsedSiteId <= 0) {
      setLocationReviewError("Bitte eine gültige Baustelle auswählen.");
      return;
    }

    setIsSavingLocationReview(true);
    setLocationReviewError(null);
    try {
      const targetEntry = locationReviewDiagnosticEntry.id < 0
        ? await createTimeEntryForMissingDay(locationReviewDiagnosticEntry)
        : locationReviewDiagnosticEntry;
      const updatedEntry = await api.decideTimeEntryReview(targetEntry.id, {
        decision: "assign_site",
        final_work_minutes: null,
        reviewed_site_id: parsedSiteId,
      });
      const selectedSite = sites.find((site) => site.id === parsedSiteId) ?? null;
      const hydratedEntry: TimeEntry = selectedSite
        ? {
            ...updatedEntry,
            site_id: selectedSite.id,
            site_name: selectedSite.name,
            site_number: selectedSite.site_number,
          }
        : updatedEntry;
      applyUpdatedTimeEntry(hydratedEntry);
      setLocationReviewDiagnosticEntry((currentEntry) => (
        currentEntry?.id === locationReviewDiagnosticEntry.id || currentEntry?.id === hydratedEntry.id
          ? mergeTimeEntryReviewUpdate(targetEntry, hydratedEntry)
          : currentEntry
      ));
      setLocationReviewSiteId(String(parsedSiteId));
    } catch (requestError) {
      setLocationReviewError(readApiError(requestError, "Ort konnte nicht gespeichert werden."));
    } finally {
      setIsSavingLocationReview(false);
    }
  }

  async function downloadAllReviewWeekXlsx(): Promise<void> {
    if (isDownloadingAllReviewWeekXlsx) {
      return;
    }
    setIsDownloadingAllReviewWeekXlsx(true);
    setReviewHoursDownloadError(null);
    try {
      const blob = await api.weeklyAllWorkersTimeEntriesXlsx({ weekStart: reviewWeekRange.start });
      downloadBlobFile(
        blob,
        `Lohnpruefung_KW${String(selectedReviewWeek.week).padStart(2, "0")}_${selectedReviewWeek.year}_Alle_Monteure.xlsx`,
      );
    } catch (requestError) {
      setReviewHoursDownloadError(readApiError(requestError, "Arbeitsstunden-Excel konnte nicht erstellt werden."));
    } finally {
      setIsDownloadingAllReviewWeekXlsx(false);
    }
  }

  async function downloadSelectedReviewWeekXlsx(): Promise<void> {
    if (!selectedReviewWorker || !selectedReviewWorker.isReviewed || isDownloadingReviewWeekXlsx) {
      return;
    }
    setIsDownloadingReviewWeekXlsx(true);
    setReviewHoursDownloadError(null);
    try {
      const blob = await api.weeklyWorkerTimeEntriesXlsx({
        personId: selectedReviewWorker.personId,
        weekStart: reviewWeekRange.start,
      });
      const filename = [
        "Lohnpruefung",
        `KW${String(selectedReviewWeek.week).padStart(2, "0")}`,
        String(selectedReviewWeek.year),
        sanitizeFilenamePart(selectedReviewWorker.personName),
      ].filter(Boolean).join("_");
      downloadBlobFile(blob, `${filename}.xlsx`);
    } catch (requestError) {
      setReviewHoursDownloadError(readApiError(requestError, "Monteurwochen-Excel konnte nicht erstellt werden."));
    } finally {
      setIsDownloadingReviewWeekXlsx(false);
    }
  }

  async function markSelectedReviewWeekReviewed(): Promise<void> {
    if (!canManageTimeEntries || !selectedReviewWorker || markingReviewWeekPersonId !== null || selectedReviewWorker.isReviewed) {
      return;
    }
    setMarkingReviewWeekPersonId(selectedReviewWorker.personId);
    setReviewActionError(null);
    try {
      const weeklyReview = await api.markTimeEntryWeeklyReview({
        personId: selectedReviewWorker.personId,
        isoYear: selectedReviewWeek.year,
        isoWeek: selectedReviewWeek.week,
      });
      setReviewWeeklyReviews((current) => {
        const withoutCurrent = current.filter((review) => !(
          review.person_id === weeklyReview.person_id
          && review.iso_year === weeklyReview.iso_year
          && review.iso_week === weeklyReview.iso_week
        ));
        return [...withoutCurrent, weeklyReview];
      });
      setReviewWeekCompletionReviews((current) => {
        const withoutCurrent = current.filter((review) => !(
          review.person_id === weeklyReview.person_id
          && review.iso_year === weeklyReview.iso_year
          && review.iso_week === weeklyReview.iso_week
        ));
        return [...withoutCurrent, weeklyReview];
      });
    } catch (requestError) {
      setReviewActionError(readApiError(requestError, "Monteurwoche konnte nicht als geprüft markiert werden."));
    } finally {
      setMarkingReviewWeekPersonId(null);
    }
  }

  return (
    <section className="time-entries-page is-figma-times-workspace">
      <div className="page-header entity-page-header">
        <div>
          <h1>Lohnprüfung</h1>
          <p className="page-subtitle">Arbeitszeiten der Monteure prüfen</p>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="project-record-subtabs time-main-subtabs" role="tablist" aria-label="Zeiten Bereiche">
        {visibleTimeSubtabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTimeSubtab === tab.key}
            className={activeTimeSubtab === tab.key ? "is-active" : ""}
            onClick={() => setActiveTimeSubtab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTimeSubtab === "review" && (
        <div className="time-entries-main time-review-main">
          <div className="time-week-nav-panel" aria-label="Kalenderwochen">
            <div className="time-week-nav-title">
              <span>Kalenderwoche</span>
              <strong>KW {selectedReviewWeek.week}</strong>
            </div>
            <div className="time-week-strip-shell">
              <button
                className="time-week-scroll-button"
                disabled={!reviewWeekScrollState.canScrollLeft}
                type="button"
                aria-label="Kalenderwochen nach links scrollen"
                onClick={() => scrollReviewWeeks(-1)}
              >
                <ChevronLeft aria-hidden="true" size={16} />
              </button>
              <div className="time-week-strip" ref={reviewWeekStripRef}>
                {reviewWeekOptions.map((option, index) => (
                  <button
                    className={[
                      option.year === selectedReviewWeek.year && option.week === selectedReviewWeek.week ? "is-active" : "",
                      option.isCurrent ? "is-current" : "",
                      completedReviewWeekKeys.has(reviewWeekKey(option)) ? "is-fully-reviewed" : "",
                    ].filter(Boolean).join(" ")}
                    data-week-index={index}
                    key={`${option.year}-${option.week}`}
                    title={`${formatRangeLabel(option.start, option.end)} · ${option.year}`}
                    type="button"
                    onClick={() => selectReviewWeek(option)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button
                className="time-week-scroll-button"
                disabled={!reviewWeekScrollState.canScrollRight}
                type="button"
                aria-label="Kalenderwochen nach rechts scrollen"
                onClick={() => scrollReviewWeeks(1)}
              >
                <ChevronRight aria-hidden="true" size={16} />
              </button>
            </div>
          </div>

          <div className="time-review-worker-panel" ref={timeReviewWorkerPanelRef}>
            <div className="time-review-worker-head">
              <div>
                <h2>Lohnprüfung pro Monteur</h2>
                <p>KW {selectedReviewWeek.week} · {formatRangeLabel(reviewWeekRange.start, reviewWeekRange.end)}</p>
              </div>
              <button
                className="icon-button secondary time-review-download-button"
                type="button"
                disabled={isDownloadingAllReviewWeekXlsx}
                onClick={() => void downloadAllReviewWeekXlsx()}
              >
                {isDownloadingAllReviewWeekXlsx ? "Excel wird erstellt..." : "Alle Arbeitsstunden Downloaden (Excel)"}
              </button>
            </div>

            {reviewActionError && <p className="time-table-note">{reviewActionError}</p>}
            {reviewHoursDownloadError && <p className="time-table-note">{reviewHoursDownloadError}</p>}
            {isLoadingPeople && timeReviewWorkers.length === 0 && (
              <div className="empty-panel">Monteure werden geladen...</div>
            )}
            {!isLoadingPeople && (isLoadingReviewEntries || isLoadingReviewAllEntries) && timeReviewWorkers.length === 0 && (
              <div className="empty-panel">Stundenprüfung wird geladen...</div>
            )}
            {!isLoadingReviewEntries && reviewEntriesError && <div className="empty-panel">{reviewEntriesError}</div>}
            {!isLoadingReviewAllEntries && reviewAllEntriesError && <div className="empty-panel">{reviewAllEntriesError}</div>}
            {!isLoadingPeople && !isLoadingReviewEntries && !isLoadingReviewAllEntries && !reviewEntriesError && !reviewAllEntriesError && timeReviewWorkers.length === 0 && (
              <div className="empty-panel">Keine aktiven internen Monteure für die Lohnprüfung gefunden.</div>
            )}

            {timeReviewWorkers.length > 0 && (
              <div className="time-review-worker-bubbles" aria-label="Monteure mit gemeldeten Zeiten">
                {timeReviewWorkers.map((worker) => (
                  <button
                    className={[
                      "time-review-worker-bubble",
                      selectedReviewWorker?.personId === worker.personId ? "is-active" : "",
                      worker.isReviewed ? "is-reviewed" : "",
                      worker.submittedMinutes <= 0 ? "has-no-submissions" : "",
                      worker.absenceType ? `has-absence-${worker.absenceType}` : "",
                    ].filter(Boolean).join(" ")}
                    key={worker.personId}
                    type="button"
                    onClick={() => setSelectedReviewPersonId(worker.personId)}
                  >
                    <span className="time-review-worker-name">{worker.personName}</span>
                    <small>
                      {worker.submittedMinutes > 0
                        ? `${formatSubmittedHours(worker.submittedMinutes)} Std. erfasst`
                        : "Keine Meldung"}
                    </small>
                    {worker.isReviewed && <span className="time-review-worker-check" aria-label="geprüft">✓</span>}
                  </button>
                ))}
              </div>
            )}

            {selectedReviewWorker ? (
              <div className="time-review-worker-detail">
                <div className="time-review-worker-detail-head">
                  <div>
                    <span>KW {selectedReviewWeek.week} · {formatRangeLabel(reviewWeekRange.start, reviewWeekRange.end)}</span>
                    <h3>{selectedReviewWorker.personName}</h3>
                  </div>
                  <div className="time-review-worker-detail-status">
                    {selectedReviewWorker.isReviewed ? <StatusBadge tone="active">Geprüft</StatusBadge> : <StatusBadge tone="warning">Offen</StatusBadge>}
                  </div>
                </div>
                {payrollDateError && <p className="time-review-week-error">{payrollDateError}</p>}
                <div className="time-review-week-check-table" role="table" aria-label={`Lohnprüfung ${selectedReviewWorker.personName} KW ${selectedReviewWeek.week}`}>
                  <div className="time-review-week-check-head" role="row">
                    <span role="columnheader" aria-label="Tag ändern"></span>
                    <span role="columnheader">Tag</span>
                    <span role="columnheader">Baustelle</span>
                    <span role="columnheader">Montagebeginn</span>
                    <span role="columnheader">Montageende</span>
                    <span role="columnheader">Pause</span>
                    <span role="columnheader">Montagezeit</span>
                    <span role="columnheader">Ort</span>
                    <span role="columnheader">Arbeitszeit</span>
                    <span role="columnheader">Geprüft</span>
                  </div>
                  {selectedReviewWeekDays.map((day) => (
                    day.entries.length > 0 ? day.entries.map((check, index) => (
                      <div
                        className={[
                          "time-review-week-check-row",
                          isTravelTimeEntry(check.entry) ? "is-travel-time" : "",
                        ].filter(Boolean).join(" ")}
                        key={`${day.date}-${check.entry.id}`}
                        role="row"
                      >
                        <div className="time-review-week-move" role="cell">
                          <button
                            className="time-review-day-move-button"
                            type="button"
                            aria-label="Zeiteintrag auf anderen Tag verschieben"
                            aria-haspopup="listbox"
                            aria-expanded={payrollDatePicker?.entryId === check.entry.id}
                            disabled={!canManageTimeEntries || payrollDateActionEntryId !== null || check.entry.id < 0}
                            onClick={(event) => togglePayrollDatePicker(check.entry, event.currentTarget)}
                          >
                            <ChevronsUpDown aria-hidden="true" size={14} />
                          </button>
                        </div>
                        <div className="time-review-week-day" role="cell">
                          {index === 0 && (
                            <>
                              <strong>{day.weekdayLabel}</strong>
                              <span>{formatDate(day.date)}</span>
                            </>
                          )}
                          {check.entry.original_work_date && check.entry.original_work_date !== check.entry.work_date && (
                            <small className="time-review-day-shift-note">vom {formatWeekday(check.entry.original_work_date)} verschoben</small>
                          )}
                        </div>
                        <div className="time-review-week-site" role="cell">
                          <strong>{timeEntrySiteName(check.entry)}</strong>
                          {check.entry.site_number && <span>{check.entry.site_number}</span>}
                          {day.absenceType && (
                            <StatusBadge tone={day.absenceType} className="time-review-absence-badge">
                              {absenceTypeLabels[day.absenceType]}
                            </StatusBadge>
                          )}
                        </div>
                        <div className="time-review-week-time" role="cell">{renderPayrollClock(check.entry, "start")}</div>
                        <div className="time-review-week-time" role="cell">{renderPayrollClock(check.entry, "end")}</div>
                        <div className="time-review-week-time" role="cell">{renderTimeReviewBreakMinutes(check.entry)}</div>
                        <div className="time-review-week-time" role="cell">{renderPayrollWorkMinutes(check.entry)}</div>
                        <div role="cell">
                          {renderTimeReviewCheckMark(check.locationCheck, {
                            onClick: () => openLocationReviewDiagnostic(check.entry),
                            label: "Ort-Diagnose öffnen",
                          })}
                        </div>
                        <div role="cell">
                          {renderTimeReviewCheckMark(check.timeCheck, {
                            onClick: () => openTimeReviewDiagnostic(check.entry),
                            label: "Arbeitszeit-Diagnose öffnen",
                          })}
                        </div>
                        <div role="cell">
                          {renderPayrollReviewMark(check.entry, {
                            disabled: !canManageTimeEntries || payrollReviewActionEntryId !== null || check.entry.id < 0,
                            isBusy: payrollReviewActionEntryId === check.entry.id,
                            onToggle: () => void togglePayrollRowReview(check.entry),
                          })}
                        </div>
                      </div>
                    )) : (() => {
                      const missingEntry = buildMissingTimeReviewEntry(selectedReviewWorker, day.date);
                      return (
                        <div className="time-review-week-check-row is-empty" key={day.date} role="row">
                          <div className="time-review-week-move" role="cell"></div>
                          <div className="time-review-week-day" role="cell">
                            <strong>{day.weekdayLabel}</strong>
                            <span>{formatDate(day.date)}</span>
                          </div>
                          <div className="time-review-week-site" role="cell">
                            {day.absenceType ? (
                              <StatusBadge tone={day.absenceType} className="time-review-absence-badge">
                                {absenceTypeLabels[day.absenceType]}
                              </StatusBadge>
                            ) : (
                              <strong>Keine Zeitmeldung</strong>
                            )}
                          </div>
                          <div className="time-review-week-time" role="cell">-</div>
                          <div className="time-review-week-time" role="cell">-</div>
                          <div className="time-review-week-time" role="cell">-</div>
                          <div className="time-review-week-time" role="cell">-</div>
                          <div role="cell">
                            {renderTimeReviewCheckMark("unknown", {
                              onClick: () => openLocationReviewDiagnostic(missingEntry),
                              label: "Ort-Diagnose öffnen",
                            })}
                          </div>
                          <div role="cell">
                            {renderTimeReviewCheckMark("unknown", {
                              onClick: () => openTimeReviewDiagnostic(missingEntry),
                              label: "Arbeitszeit-Diagnose öffnen",
                            })}
                          </div>
                          <div role="cell">{renderPayrollReviewEmptyMark()}</div>
                        </div>
                      );
                    })()
                  ))}
                </div>
                {payrollDatePicker && payrollDatePickerEntry && (
                  <div
                    className="time-review-day-move-popover"
                    role="listbox"
                    aria-label="Zieltag auswählen"
                    style={{ left: `${payrollDatePicker.left}px`, top: `${payrollDatePicker.top}px` }}
                  >
                    {selectedReviewWeekDayOptions.map((option) => (
                      <button
                        className={option.date === payrollDatePickerEntry.work_date ? "is-selected" : ""}
                        key={option.date}
                        type="button"
                        role="option"
                        aria-selected={option.date === payrollDatePickerEntry.work_date}
                        onClick={() => void movePayrollEntryDate(payrollDatePickerEntry, option.date)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="time-review-worker-detail-actions">
                  <div className="time-review-worker-detail-action-stack">
                    <button
                      className="icon-button secondary"
                      type="button"
                      disabled={!canManageTimeEntries || selectedReviewWorker.isReviewed || markingReviewWeekPersonId === selectedReviewWorker.personId}
                      onClick={() => void markSelectedReviewWeekReviewed()}
                    >
                      {selectedReviewWorker.isReviewed
                        ? "Monteurwoche geprüft"
                        : markingReviewWeekPersonId === selectedReviewWorker.personId
                          ? "Monteurwoche wird geprüft..."
                          : "Monteurwoche als geprüft markieren"}
                    </button>
                    {selectedReviewWorker.isReviewed && (
                      <button
                        className="icon-button secondary time-review-week-xlsx-button"
                        type="button"
                        disabled={isDownloadingReviewWeekXlsx}
                        onClick={() => void downloadSelectedReviewWeekXlsx()}
                      >
                        {isDownloadingReviewWeekXlsx ? "Excel wird erstellt..." : "Monteurwoche Downloaden (Excel)"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : timeReviewWorkers.length > 0 ? (
              <div className="time-review-worker-empty-detail">Monteur auswählen, um die Lohnprüfung für KW {selectedReviewWeek.week} zu öffnen.</div>
            ) : null}
          </div>
        </div>
      )}

      {activeTimeSubtab === "evaluation" && (
        <div className="time-entries-main time-review-main time-evaluation-main">
          <div className="time-week-nav-panel" aria-label="Kalenderwochen Auswertung">
            <div className="time-week-nav-title">
              <span>Kalenderwoche</span>
              <strong>KW {selectedEvaluationWeek.week}</strong>
            </div>
            <div className="time-week-strip-shell">
              <button
                className="time-week-scroll-button"
                disabled={!evaluationWeekScrollState.canScrollLeft}
                type="button"
                aria-label="Kalenderwochen nach links scrollen"
                onClick={() => scrollEvaluationWeeks(-1)}
              >
                <ChevronLeft aria-hidden="true" size={16} />
              </button>
              <div className="time-week-strip" ref={evaluationWeekStripRef}>
                {reviewWeekOptions.map((option, index) => (
                  <button
                    className={[
                      option.year === selectedEvaluationWeek.year && option.week === selectedEvaluationWeek.week ? "is-active" : "",
                      option.isCurrent ? "is-current" : "",
                      completedReviewWeekKeys.has(reviewWeekKey(option)) ? "is-fully-reviewed" : "",
                    ].filter(Boolean).join(" ")}
                    data-week-index={index}
                    key={`${option.year}-${option.week}`}
                    title={`${formatRangeLabel(option.start, option.end)} · ${option.year}`}
                    type="button"
                    onClick={() => selectEvaluationWeek(option)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button
                className="time-week-scroll-button"
                disabled={!evaluationWeekScrollState.canScrollRight}
                type="button"
                aria-label="Kalenderwochen nach rechts scrollen"
                onClick={() => scrollEvaluationWeeks(1)}
              >
                <ChevronRight aria-hidden="true" size={16} />
              </button>
            </div>
          </div>
          <div className="time-final-hours-panel">
            <div className="time-entries-toolbar">
              <div>
                <h2>Auswertung</h2>
                <p>KW {selectedEvaluationWeek.week} · {formatRangeLabel(evaluationWeekRange.start, evaluationWeekRange.end)}</p>
              </div>
            </div>
            {reviewAllEntriesError && <p className="time-table-note">{reviewAllEntriesError}</p>}
            <div className="time-summary-strip">
              <div><span>Gesamtsumme</span><strong>{formatMinutes(finalHoursTotals.totalMinutes)}</strong></div>
              <div><span>Offene Prüffälle</span><strong>{evaluationTimeReviewIssues.length}</strong></div>
              <div><span>Monteure</span><strong>{finalHoursTotals.byPerson.length}</strong></div>
              <div><span>Baustellen</span><strong>{finalHoursTotals.bySite.length}</strong></div>
            </div>
            <div className="time-final-summary-grid">
              <FinalSummaryList title="Summe je Monteur" rows={finalHoursTotals.byPerson} />
              <FinalSummaryList title="Summe je Baustelle" rows={finalHoursTotals.bySite} />
            </div>
          </div>
        </div>
      )}

      {activeTimeSubtab === "gpsVerification" && canViewGpsVerification && (
        <div className="time-entries-main">
          <div className="gps-verification-panel">
            <div className="gps-verification-header">
              <div>
                <h2>GPS-Prüfung</h2>
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
                    <th>Plausibilität</th>
                    <th>Abstand</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoadingRecentGps && (
                    <tr>
                      <td className="time-empty-row" colSpan={5}>
                        GPS-Prüfdaten werden geladen...
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
        </div>
      )}

      {timeReviewDiagnosticEntry && (
        <div
          className="time-review-diagnostic-backdrop"
          role="presentation"
          onClick={closeTimeReviewDiagnostic}
        >
          <div
            className="time-review-diagnostic-popover"
            role="dialog"
            aria-label="Arbeitszeit-Diagnose"
            aria-modal="true"
            style={timeReviewPopupTop === null ? undefined : {
              maxHeight: `calc(100vh - ${timeReviewPopupTop}px - 24px)`,
              top: `${timeReviewPopupTop}px`,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="time-review-diagnostic-head">
              <div>
                <span>Diagnose</span>
                <h4>Arbeitszeit-Prüfung</h4>
              </div>
              <button
                className="time-review-diagnostic-close"
                type="button"
                aria-label="Diagnose schließen"
                onClick={closeTimeReviewDiagnostic}
              >
                ×
              </button>
            </div>
            <div className="time-review-diagnostic-table" role="table" aria-label="Arbeitszeit-Diagnosewerte">
              <div className="time-review-diagnostic-row is-head" role="row">
                <span role="columnheader">Quelle</span>
                <span role="columnheader">Anfang Arbeitszeit</span>
                <span role="columnheader">Ende Arbeitszeit</span>
                <span role="columnheader">Gesamtstunden</span>
              </div>
              {timeReviewDiagnosticRows(timeReviewDiagnosticEntry).map((row) => (
                <div className="time-review-diagnostic-row" key={row.source} role="row">
                  <strong role="cell">{row.source}</strong>
                  <span role="cell">{row.start}</span>
                  <span role="cell">{row.end}</span>
                  <span role="cell">{row.total}</span>
                </div>
              ))}
              <div className="time-review-diagnostic-row is-editable" role="row">
                <strong role="cell">Stunden Büro geprüft</strong>
                <label role="cell">
                  <span className="sr-only">Anfang Arbeitszeit Büro geprüft</span>
                  <input
                    type="time"
                    value={payrollCorrectionForm.start_time}
                    onChange={(event) => setPayrollCorrectionForm((current) => ({ ...current, start_time: event.target.value }))}
                    disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                  />
                </label>
                <label role="cell">
                  <span className="sr-only">Ende Arbeitszeit Büro geprüft</span>
                  <input
                    type="time"
                    value={payrollCorrectionForm.end_time}
                    onChange={(event) => setPayrollCorrectionForm((current) => ({ ...current, end_time: event.target.value }))}
                    disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                  />
                </label>
                <label role="cell">
                  <span className="sr-only">Gesamtstunden Büro geprüft</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="-"
                    value={payrollCorrectionForm.hours}
                    onChange={(event) => setPayrollCorrectionForm((current) => ({ ...current, hours: event.target.value }))}
                    disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                  />
                </label>
              </div>
            </div>
            {isCurrentLocalDateInput(timeReviewDiagnosticEntry.work_date) && (
              <p className="time-review-diagnostic-note">GPS-Auswertung für den aktuellen Tag erst ab morgen verfügbar.</p>
            )}
            <div className="time-review-diagnostic-actions">
              {payrollCorrectionError && <p className="time-review-diagnostic-error">{payrollCorrectionError}</p>}
              <button
                className="icon-button secondary time-review-diagnostic-save"
                type="button"
                disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                onClick={() => void savePayrollTimeCorrection()}
              >
                {isSavingPayrollCorrection ? "Bürozeit wird gespeichert..." : "Bürozeit speichern"}
              </button>
            </div>
          </div>
        </div>
      )}

      {locationReviewDiagnosticEntry && (
        <div
          className="time-review-diagnostic-backdrop is-location"
          role="presentation"
          onClick={closeLocationReviewDiagnostic}
        >
          <div
            className="time-review-diagnostic-popover is-location"
            role="dialog"
            aria-label="Ort-Diagnose"
            aria-modal="true"
            style={locationReviewPopupTop === null ? undefined : {
              maxHeight: `calc(100vh - ${locationReviewPopupTop}px - 24px)`,
              top: `${locationReviewPopupTop}px`,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="time-review-diagnostic-head">
              <div>
                <span>Diagnose</span>
                <h4>Ort-Prüfung | {formatTimeEntryRange(locationReviewDiagnosticEntry)}</h4>
              </div>
              <button
                className="time-review-diagnostic-close"
                type="button"
                aria-label="Diagnose schließen"
                onClick={closeLocationReviewDiagnostic}
              >
                ×
              </button>
            </div>
            <div className="time-review-diagnostic-table" role="table" aria-label="Ort-Diagnosewerte">
              <div className="time-review-diagnostic-row is-head is-location" role="row">
                <span role="columnheader">Quelle</span>
                <span role="columnheader">Erkannte / eingetragene Baustelle</span>
                <span role="columnheader">Kommission</span>
                <span role="columnheader">Ort / Adresse</span>
              </div>
              {locationReviewDiagnosticRows(locationReviewDiagnosticEntry, sites).map((row) => (
                <div className={`time-review-diagnostic-row is-location ${row.isManualReview ? "is-manual-review" : ""}`} key={row.source} role="row">
                  <strong role="cell">{row.source}</strong>
                  <span role="cell">{row.siteName}</span>
                  <span role="cell">{row.siteNumber}</span>
                  <span role="cell">{row.location}</span>
                </div>
              ))}
            </div>
            <div className="time-review-location-decision">
              <div className="time-review-location-summary is-actions-only">
                <button
                  className="time-review-location-change"
                  type="button"
                  aria-expanded={isLocationReviewPickerOpen}
                  disabled={!canManageTimeEntries || isSavingLocationReview}
                  onClick={() => setIsLocationReviewPickerOpen((current) => !current)}
                >
                  {isLocationReviewPickerOpen ? "Auswahl schliessen" : "Baustelle manuell anpassen"}
                </button>
              </div>
              {isLocationReviewPickerOpen && (
                <div className="time-review-location-picker" aria-label="Baustelle manuell auswählen">
                  <section className="time-review-location-picker-panel">
                    <label className="time-review-location-search">
                      <span>Baustelle suchen</span>
                      <input
                        type="search"
                        placeholder="Kommission oder Baustellenname"
                        value={locationReviewSiteSearch}
                        onChange={(event) => setLocationReviewSiteSearch(event.target.value)}
                        disabled={!canManageTimeEntries || isSavingLocationReview}
                      />
                    </label>
                    {locationReviewSiteSearch.trim() && (
                      <div className="time-review-location-suggestions" role="listbox" aria-label="Baustellenvorschläge">
                        {locationReviewSiteSearchResults.length ? (
                          locationReviewSiteSearchResults.map((site) => (
                            <button
                              className={String(site.id) === locationReviewSiteId ? "is-selected" : ""}
                              key={site.id}
                              type="button"
                              role="option"
                              aria-selected={String(site.id) === locationReviewSiteId}
                              disabled={!canManageTimeEntries || isSavingLocationReview}
                              onClick={() => {
                                setLocationReviewSiteId(String(site.id));
                                setLocationReviewSiteSearch("");
                              }}
                            >
                              <strong>{site.site_number || `Baustelle ${site.id}`}</strong>
                              <span>{site.name}</span>
                            </button>
                          ))
                        ) : (
                          <p>Keine passende Baustelle gefunden.</p>
                        )}
                      </div>
                    )}
                  </section>

                  <section className="time-review-location-picker-panel">
                    <div className="time-review-location-list-head">
                      <span>Alle auswählbaren Baustellen</span>
                      <small>{locationReviewSiteOptions.length}</small>
                    </div>
                    <div className="time-review-location-site-list" role="listbox" aria-label="Alle auswählbaren Baustellen">
                      {locationReviewSiteOptions.map((site) => (
                        <button
                          className={String(site.id) === locationReviewSiteId ? "is-selected" : ""}
                          key={site.id}
                          type="button"
                          role="option"
                          aria-selected={String(site.id) === locationReviewSiteId}
                          disabled={!canManageTimeEntries || isSavingLocationReview}
                          onClick={() => setLocationReviewSiteId(String(site.id))}
                        >
                          <strong>{site.site_number || `Baustelle ${site.id}`}</strong>
                          <span>{site.name}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </div>
            <div className="time-review-diagnostic-actions">
              {locationReviewError && <p className="time-review-diagnostic-error">{locationReviewError}</p>}
              <button
                className="icon-button secondary time-review-diagnostic-save"
                type="button"
                disabled={!canManageTimeEntries || isSavingLocationReview}
                onClick={() => void saveLocationReviewSite()}
              >
                {isSavingLocationReview ? "Ort wird gespeichert..." : "Ort speichern"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function isTimeReviewPerfEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(TIME_REVIEW_PERF_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function timeReviewPerfNow(): number | null {
  if (!isTimeReviewPerfEnabled() || typeof performance === "undefined") {
    return null;
  }
  return performance.now();
}

function startTimeReviewPerfSession(
  perfRef: { current: TimeReviewPerfState | null },
  renderCountAtStart: number,
  from: CalendarWeekSelection,
  to: CalendarWeekSelection,
  includeWeeklyReviews: boolean,
): void {
  const startedAt = timeReviewPerfNow();
  if (startedAt === null) {
    perfRef.current = null;
    return;
  }
  perfRef.current = {
    apiCalls: [],
    calculations: [],
    completedApiCalls: new Set(),
    expectedApiCalls: [
      TIME_REVIEW_API_OPEN_ENTRIES,
      TIME_REVIEW_API_ALL_ENTRIES,
      TIME_REVIEW_API_ABSENCES,
      ...(includeWeeklyReviews ? [TIME_REVIEW_API_WEEKLY_REVIEWS] : []),
    ],
    flushScheduled: false,
    from,
    hasLogged: false,
    renderCountAtStart,
    startedAt,
    to,
  };
}

function recordTimeReviewPerfApiCall(
  perfRef: { current: TimeReviewPerfState | null },
  renderCountRef: { current: number },
  name: string,
  startedAt: number | null,
  result: { details?: string; ok: boolean; rows?: number },
): void {
  const state = perfRef.current;
  if (!state || startedAt === null || !state.expectedApiCalls.includes(name)) {
    return;
  }
  state.apiCalls.push({
    name,
    details: result.details,
    durationMs: performance.now() - startedAt,
    ok: result.ok,
    rows: result.rows,
  });
  state.completedApiCalls.add(name);
  scheduleTimeReviewPerfFlush(perfRef, renderCountRef);
}

function recordTimeReviewPerfCalculation(
  perfRef: { current: TimeReviewPerfState | null },
  name: string,
  startedAt: number | null,
  result: { details?: string } = {},
): void {
  const state = perfRef.current;
  if (!state || startedAt === null) {
    return;
  }
  state.calculations.push({
    name,
    details: result.details,
    durationMs: performance.now() - startedAt,
  });
}

function scheduleTimeReviewPerfFlush(
  perfRef: { current: TimeReviewPerfState | null },
  renderCountRef: { current: number },
): void {
  const state = perfRef.current;
  if (!state || state.hasLogged || state.flushScheduled) {
    return;
  }
  const isComplete = state.expectedApiCalls.every((name) => state.completedApiCalls.has(name));
  if (!isComplete) {
    return;
  }
  state.flushScheduled = true;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      flushTimeReviewPerfSession(perfRef, renderCountRef);
    });
  });
}

function flushTimeReviewPerfSession(
  perfRef: { current: TimeReviewPerfState | null },
  renderCountRef: { current: number },
): void {
  const state = perfRef.current;
  if (!state || state.hasLogged) {
    return;
  }
  state.hasLogged = true;
  const totalDurationMs = performance.now() - state.startedAt;
  const renderCount = renderCountRef.current - state.renderCountAtStart;
  console.groupCollapsed(
    `[Lohnprüfung KW-Wechsel] KW ${state.from.week}/${state.from.year} → KW ${state.to.week}/${state.to.year}`,
  );
  console.info("selectedWeek", { nachher: state.to, vorher: state.from });
  console.info("total duration", formatPerfMs(totalDurationMs));
  console.info("render count", renderCount);
  console.info("Stammdaten-Refetch", "Personen und Baustellen hängen nicht am KW-Wechsel; geloggt werden die week-spezifischen Requests.");
  console.table(state.apiCalls.map((call) => ({
    Request: call.name,
    Dauer: formatPerfMs(call.durationMs),
    Ergebnis: call.ok ? "ok" : "Fehler",
    Zeilen: call.rows ?? "-",
    Details: call.details ?? "",
  })));
  console.table(state.calculations.map((calculation) => ({
    Berechnung: calculation.name,
    Dauer: formatPerfMs(calculation.durationMs),
    Details: calculation.details ?? "",
  })));
  console.groupEnd();
}

function formatPerfMs(value: number): string {
  return `${Math.round(value)} ms`;
}

function renderReviewTableRows({
  rows,
  expandedReviewEntryId,
  reviewDecisionForm,
  reviewActionEntryId,
  isSavingReviewDecision,
  siteOptions,
  canManageTimeEntries,
  showDecisionColumn,
  onConfirm,
  onOpenIssue,
  onCloseIssue,
  onSaveDecision,
  onReviewDecisionFormChange,
  onDecideIssue,
}: {
  rows: TimeReviewTableRow[];
  expandedReviewEntryId: number | null;
  reviewDecisionForm: ReviewDecisionFormState;
  reviewActionEntryId: number | null;
  isSavingReviewDecision: boolean;
  siteOptions: SiteSummary[];
  canManageTimeEntries: boolean;
  showDecisionColumn: boolean;
  onConfirm: (row: TimeReviewTableRow) => Promise<void>;
  onOpenIssue: (issue: TimeReviewIssue, mode?: ReviewEditorMode) => void;
  onCloseIssue: () => void;
  onSaveDecision: (issue: TimeReviewIssue, modeOverride?: ReviewEditorMode) => Promise<void>;
  onReviewDecisionFormChange: (updater: (current: ReviewDecisionFormState) => ReviewDecisionFormState) => void;
  onDecideIssue: (
    issue: TimeReviewIssue,
    decision: TimeReviewDecision,
    options?: { finalMinutes?: number | null; reviewedSiteId?: number | null },
  ) => Promise<void>;
}) {
  let currentPersonId: number | null = null;
  let currentWorkDate: string | null = null;
  let dayGroupIndex = -1;

  return rows.map((row, index) => {
    const issue = row.issue;
    const isExpanded = showDecisionColumn && expandedReviewEntryId === row.id && issue !== null;
    const isBusy = reviewActionEntryId === row.id || isSavingReviewDecision;
    const previousRow = rows[index - 1] ?? null;
    const nextRow = rows[index + 1] ?? null;
    const isSamePersonAsPrevious = previousRow?.entry.person_id === row.entry.person_id;
    const isSamePersonAsNext = nextRow?.entry.person_id === row.entry.person_id;
    const showPersonGroup = !isSamePersonAsPrevious;
    const showDayGroup = showPersonGroup || previousRow?.workDate !== row.workDate;
    const hasNextSameDay = isSamePersonAsNext && nextRow?.workDate === row.workDate;
    if (currentPersonId !== row.entry.person_id) {
      currentPersonId = row.entry.person_id;
      currentWorkDate = row.workDate;
      dayGroupIndex = 0;
    } else if (currentWorkDate !== row.workDate) {
      currentWorkDate = row.workDate;
      dayGroupIndex += 1;
    }
    const isWeekend = isWeekendDate(row.workDate);
    const isCheckedRow = isCheckedReviewRow(row);
    const rowClassName = [
      "time-review-entry-row",
      isExpanded ? "is-expanded" : "",
      showDayGroup ? "is-day-start" : "is-same-day-continuation same-day-continuation",
      hasNextSameDay ? "has-same-day-next same-day-has-next" : "",
      dayGroupIndex % 2 === 0 ? "is-day-group-even" : "is-day-group-odd",
      isWeekend ? "is-weekend-row" : "",
      isCheckedRow ? "is-review-checked" : "",
      row.entry.is_gps_suggestion ? "is-gps-suggestion" : "",
    ].filter(Boolean).join(" ");

    return (
      <Fragment key={row.id}>
        {showPersonGroup && (
          <tr className="time-review-group-row">
            <td colSpan={showDecisionColumn ? 9 : 8}>{row.personName}</td>
          </tr>
        )}
        <tr className={rowClassName}>
          <td className="time-review-day-cell">
            <span className="time-review-day-value">
              {formatWeekday(row.workDate)}
              {isWeekend && <span className="time-review-weekend-badge">WE</span>}
            </span>
          </td>
          <td className="time-review-site-number-cell">{row.siteNumber}</td>
          <td>
            <span className="time-review-site-name-cell">{row.siteName}</span>
          </td>
          <td className="time-review-note-cell">{renderReviewNote(row)}</td>
          <td>{formatHalfHour(row.manualMinutes)}</td>
          <td>{formatHalfHour(row.gpsMinutes)}</td>
          <td>
            <span className={Math.abs(row.deviationMinutes ?? 0) > 60 ? "time-review-delta is-critical" : "time-review-delta"}>
              {formatHalfHourDelta(row.deviationMinutes)}
            </span>
          </td>
          <td>{formatHalfHour(row.correctedMinutes)}</td>
          {showDecisionColumn && (
            <td>
              <div className="time-review-table-actions">
                {issue ? (
                  <>
                    <button
                      className="time-table-action time-review-action-correction-primary"
                      disabled={isBusy}
                      type="button"
                      onClick={() => {
                        if (isExpanded) {
                          onCloseIssue();
                        } else {
                          onOpenIssue(issue, "corrected");
                        }
                      }}
                    >
                      Korrektur
                    </button>
                    {canManageTimeEntries && row.canConfirm && (
                      <button
                        className="time-table-action time-review-action-confirm-secondary"
                        disabled={isBusy}
                        type="button"
                        onClick={() => void onConfirm(row)}
                      >
                        Bestätigen
                      </button>
                    )}
                    {!canManageTimeEntries && <StatusBadge tone={row.statusTone}>{row.statusLabel}</StatusBadge>}
                  </>
                ) : (
                  canManageTimeEntries && row.canConfirm ? (
                    <button
                      className="time-table-action time-table-action-primary"
                      disabled={isBusy}
                      type="button"
                      onClick={() => void onConfirm(row)}
                    >
                      Bestätigen
                    </button>
                  ) : (
                    <StatusBadge tone={row.statusTone}>{row.statusLabel}</StatusBadge>
                  )
                )}
              </div>
            </td>
          )}
        </tr>
        {isExpanded && issue && (
          <tr className="time-review-detail-row">
            <td colSpan={9}>
              <div className="time-review-correction-panel">
                {canManageTimeEntries && (
                  <>
                    <div className="time-review-correction-block time-review-correction-block-gps">
                      <span>GPS</span>
                      <button
                        className="time-table-action"
                        disabled={isBusy || issue.gpsMinutes === null}
                        type="button"
                        onClick={() => void onDecideIssue(issue, "accept_gps", { finalMinutes: issue.gpsMinutes })}
                      >
                        Übernehmen
                      </button>
                    </div>
                    <div className="time-review-correction-block time-review-correction-block-site">
                      <span>Baustelle zuordnen</span>
                      <div className="time-review-correction-control-row">
                        <select
                          value={reviewDecisionForm.site_id}
                          onChange={(event) => onReviewDecisionFormChange((current) => ({ ...current, site_id: event.target.value }))}
                        >
                          <option value="">Nicht zugeordnet</option>
                          {siteOptions.map((site) => (
                            <option key={site.id} value={site.id}>{siteOptionLabel(site)}</option>
                          ))}
                        </select>
                        <button
                          className="time-table-action"
                          disabled={isBusy}
                          type="button"
                          onClick={() => void onSaveDecision(issue, "assign_site")}
                        >
                          Zuordnen
                        </button>
                      </div>
                    </div>
                    <div className="time-review-correction-block time-review-correction-block-time">
                      <span>Zeit manuell anpassen</span>
                      <input
                        inputMode="decimal"
                        placeholder="z. B. 8,5"
                        value={reviewDecisionForm.hours}
                        onChange={(event) => onReviewDecisionFormChange((current) => ({ ...current, hours: event.target.value }))}
                      />
                    </div>
                    <div className="time-review-correction-block time-review-correction-block-save">
                      <span>&nbsp;</span>
                      <button
                        className="time-table-action time-table-action-primary"
                        disabled={isBusy}
                        type="button"
                        onClick={() => void onSaveDecision(issue, "corrected")}
                      >
                        Zeit übernehmen
                      </button>
                    </div>
                  </>
                )}
                {!canManageTimeEntries && (
                  <StatusBadge tone={issue.statusTone}>{issue.statusLabel}</StatusBadge>
                )}
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  });
}

function FinalSummaryList({ title, rows }: { title: string; rows: { label: string; minutes: number }[] }) {
  return (
    <div className="time-final-summary-list">
      <h3>{title}</h3>
      {rows.length ? rows.map((row) => (
        <div key={row.label}>
          <span>{row.label}</span>
          <strong>{formatMinutes(row.minutes)}</strong>
        </div>
      )) : <p>Keine Summen vorhanden.</p>}
    </div>
  );
}

function renderReviewNote(row: TimeReviewTableRow) {
  const className = isProblematicReviewRow(row)
    ? "time-review-note-instruction is-attention"
    : "time-review-note-instruction";
  return <span className={className}>{buildTimeReviewInstruction(row)}</span>;
}

function renderReviewedLogItems(rows: TimeReviewTableRow[]) {
  return rows.map((row) => {
    const log = buildTimeReviewLog(row);
    return (
      <article className={["time-review-log-item", log.isChanged ? "is-changed" : ""].filter(Boolean).join(" ")} key={row.id}>
        <div className="time-review-log-status">
          <StatusBadge tone={log.isChanged ? "warning" : "active"}>{log.statusLabel}</StatusBadge>
          {row.entry.reviewed_at && <span>{formatDateTime(row.entry.reviewed_at)}</span>}
        </div>
        <div className="time-review-log-main">
          <div>
            <h3>
              {formatWeekday(row.workDate)} · {row.personName} · {row.siteNumber} · {row.siteName}
            </h3>
            <p>Prüfhinweis: {buildTimeReviewInstruction(row)}</p>
          </div>
          <div className="time-review-log-change">
            {log.changeParts ? (
              <>
                <span>{log.changeParts.label}</span>
                <strong>{log.changeParts.from}</strong>
                <span aria-hidden="true">→</span>
                <strong>{log.changeParts.to}</strong>
              </>
            ) : (
              <span>{log.changeText}</span>
            )}
          </div>
        </div>
        <div className="time-review-log-facts">
          <span>Gemeldet: {formatHalfHour(log.reportedMinutes)}</span>
          <span>GPS: {formatHalfHour(row.gpsMinutes)}</span>
          <span>Gültig: {formatHalfHour(log.validMinutes)}</span>
          {row.correctedMinutes !== null && <span>Korrigiert: {formatHalfHour(row.correctedMinutes)}</span>}
          {row.entry.reviewed_by_user_id !== null && <span>Geprüft von: Benutzer #{row.entry.reviewed_by_user_id}</span>}
          {row.entry.note && <span>Notiz: {row.entry.note}</span>}
        </div>
      </article>
    );
  });
}

function buildTimeReviewLog(row: TimeReviewTableRow): {
  changeParts: { label: string; from: string; to: string } | null;
  changeText: string;
  isChanged: boolean;
  reportedMinutes: number | null;
  statusLabel: string;
  validMinutes: number | null;
} {
  const entry = row.entry;
  const reportedMinutes = entry.original_work_minutes ?? (entry.is_gps_suggestion ? null : entry.work_minutes);
  const validMinutes = entry.work_minutes;
  const correctedMinutes = entry.corrected_work_minutes;
  const hasTimeChange = correctedMinutes !== null && reportedMinutes !== null && correctedMinutes !== reportedMinutes;
  const hasGpsDecision = entry.time_review_method === "accept_gps";
  const hasManualCorrection = entry.time_review_method === "manual_correction" || entry.time_review_status === "corrected";
  const hasSiteDecision = entry.time_review_method === "assign_site";

  if (hasGpsDecision && row.gpsMinutes !== null) {
    return {
      changeParts: null,
      changeText: `GPS-Zeit übernommen: ${formatHalfHour(row.gpsMinutes)}`,
      isChanged: true,
      reportedMinutes,
      statusLabel: "korrigiert",
      validMinutes,
    };
  }
  if (hasTimeChange) {
    return {
      changeParts: {
        label: "Arbeitszeit geändert:",
        from: formatHalfHour(reportedMinutes),
        to: formatHalfHour(correctedMinutes),
      },
      changeText: "",
      isChanged: true,
      reportedMinutes,
      statusLabel: "korrigiert",
      validMinutes,
    };
  }
  if (hasManualCorrection && correctedMinutes !== null) {
    return {
      changeParts: null,
      changeText: `Korrektur: ${formatHalfHour(correctedMinutes)}`,
      isChanged: true,
      reportedMinutes,
      statusLabel: "korrigiert",
      validMinutes,
    };
  }
  if (hasSiteDecision) {
    return {
      changeParts: null,
      changeText: `Einsatzort geprüft/korrigiert: ${timeEntrySiteLabel(entry)}`,
      isChanged: true,
      reportedMinutes,
      statusLabel: "korrigiert",
      validMinutes,
    };
  }
  return {
    changeParts: null,
    changeText: "Keine Änderung vorgenommen.",
    isChanged: false,
    reportedMinutes,
    statusLabel: "geprüft",
    validMinutes,
  };
}

function buildTimeReviewInstruction(row: TimeReviewTableRow): string {
  const entry = row.entry;
  const hasGpsSignal = Boolean(entry.gps_first_seen_at || entry.gps_last_seen_at || entry.gps_total_points);
  const hasPlannedSite = entry.planned_site_labels.length > 0;
  const gpsLocationType = entry.gps_detected_location_type;

  if (entry.is_gps_suggestion) {
    return "GPS erkannt: kein manueller Eintrag vorhanden.";
  }
  if (entry.gps_status === "missing" || (row.gpsMinutes === null && !hasGpsSignal)) {
    return "GPS fehlt: Arbeitszeit kann nicht automatisch geprüft werden.";
  }
  if (entry.gps_not_checkable || entry.gps_status === "not_checkable" || entry.review_notices.includes(GPS_NOT_CHECKABLE_NOTICE)) {
    return "GPS nicht eindeutig: Standort liegt im Radius mehrerer Baustellen.";
  }
  if (row.gpsMinutes !== null && row.gpsMinutes <= 60) {
    return "GPS fehlt: Arbeitszeit kann nicht automatisch geprüft werden.";
  }
  if (hasPlannedSite && gpsLocationType === "company") {
    return "Einsatzort prüfen: automatisch erkannter Einsatzort weicht von geplantem Einsatzort ab.";
  }
  if (hasPlannedSite && gpsLocationType === "site" && entry.planned_vs_gps_mismatch) {
    return "Einsatzort prüfen: automatisch erkannter Einsatzort zeigt andere Baustelle als geplant.";
  }
  if (entry.planned_vs_gps_mismatch) {
    return "Einsatzort prüfen: automatisch erkannter Einsatzort weicht von geplantem Einsatzort ab.";
  }
  if (entry.manual_vs_gps_mismatch) {
    return "Einsatzort prüfen: Einsatzort in Stundenerfassung weicht von automatisch erkanntem Einsatzort ab.";
  }
  if (entry.manual_vs_planned_mismatch) {
    return "Planung prüfen: Einsatzort in Stundenerfassung weicht von der Kalenderplanung ab.";
  }
  if (row.deviationMinutes !== null && Math.abs(row.deviationMinutes) > GPS_TIME_TOLERANCE_MINUTES) {
    return "Zeit prüfen: automatisch erkannte Zeit weicht deutlich von gemeldeter Zeit ab.";
  }
  if (isWeekendDate(row.workDate)) {
    return "Wochenendeinsatz prüfen, falls nicht bewusst geplant.";
  }
  if (entry.time_review_status !== "open") {
    return row.systemHint || "manuell geprüft";
  }
  return "automatisch geprüft";
}

function currentIsoWeek(): CalendarWeekSelection {
  return isoWeekFromDate(new Date());
}

function buildCalendarWeekOptions(currentWeek: CalendarWeekSelection): CalendarWeekOption[] {
  const optionForWeek = (year: number, week: number): CalendarWeekOption => {
    const range = isoWeekRange(year, week);
    return {
      year,
      week,
      label: year === currentWeek.year ? `KW ${week}` : `KW ${week}/${year}`,
      start: range.start,
      end: range.end,
      isCurrent: year === currentWeek.year && week === currentWeek.week,
    };
  };

  return [
    ...numberRange(1, 54).map((week) => optionForWeek(currentWeek.year, week)),
    ...numberRange(1, 5).map((week) => optionForWeek(currentWeek.year + 1, week)),
  ];
}

function buildCompletedReviewWeekKeys(reviews: TimeEntryWeeklyReview[], workerIds: number[]): Set<string> {
  const result = new Set<string>();
  if (!workerIds.length) {
    return result;
  }
  const workerIdSet = new Set(workerIds);
  const reviewedWorkersByWeek = new Map<string, Set<number>>();
  reviews.forEach((review) => {
    if (!workerIdSet.has(review.person_id)) {
      return;
    }
    const key = reviewWeekKey({ year: review.iso_year, week: review.iso_week });
    const reviewedWorkers = reviewedWorkersByWeek.get(key) ?? new Set<number>();
    reviewedWorkers.add(review.person_id);
    reviewedWorkersByWeek.set(key, reviewedWorkers);
  });
  reviewedWorkersByWeek.forEach((reviewedWorkers, key) => {
    if (workerIds.every((workerId) => reviewedWorkers.has(workerId))) {
      result.add(key);
    }
  });
  return result;
}

function reviewWeekKey(selection: CalendarWeekSelection): string {
  return `${selection.year}-${selection.week}`;
}

function scrollWeekStripToSelection(
  container: HTMLDivElement | null,
  options: CalendarWeekOption[],
  selection: CalendarWeekSelection,
): void {
  if (!container) {
    return;
  }
  const selectedWeekIndex = options.findIndex(
    (option) => option.year === selection.year && option.week === selection.week,
  );
  if (selectedWeekIndex < 0) {
    return;
  }

  const firstVisibleIndex = Math.max(0, selectedWeekIndex - 5);
  const targetButton = container.querySelector<HTMLButtonElement>(`[data-week-index="${firstVisibleIndex}"]`);
  if (!targetButton) {
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const targetRect = targetButton.getBoundingClientRect();
  container.scrollLeft = Math.max(0, container.scrollLeft + targetRect.left - containerRect.left);
}

function numberRange(start: number, end: number): number[] {
  if (end < start) {
    return [];
  }
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function isoWeekFromDate(input: Date): CalendarWeekSelection {
  const utcDate = new Date(Date.UTC(input.getFullYear(), input.getMonth(), input.getDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const isoYear = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return { year: isoYear, week };
}

function isoWeekRange(year: number, week: number): { start: string; end: string } {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    start: toUtcDateInputValue(monday),
    end: toUtcDateInputValue(sunday),
  };
}

function toUtcDateInputValue(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatSubmittedHours(minutes: number): string {
  return formatDecimalHoursValue(minutes / 60);
}

function addDaysToDateInput(value: string, days: number): string {
  const date = parseDateInput(value);
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
}

function parseDateInput(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function isWeekendDate(value: string): boolean {
  const day = parseDateInput(value).getDay();
  return day === 0 || day === 6;
}

function buildTimeReviewIssues(entries: TimeEntry[]): TimeReviewIssue[] {
  return entries
    .map((entry) => timeReviewIssue(entry))
    .filter((issue): issue is TimeReviewIssue => issue !== null)
    .sort((left, right) => (
      left.priority - right.priority
      || left.personName.localeCompare(right.personName, "de", { sensitivity: "base" })
      || left.workDate.localeCompare(right.workDate)
      || left.id - right.id
    ));
}

function replaceTimeEntryInList(entries: TimeEntry[], updatedEntry: TimeEntry): TimeEntry[] {
  const entryIndex = entries.findIndex((entry) => entry.id === updatedEntry.id);
  if (entryIndex < 0) {
    return entries;
  }
  const nextEntries = [...entries];
  nextEntries[entryIndex] = mergeTimeEntryReviewUpdate(entries[entryIndex], updatedEntry);
  return nextEntries;
}

function upsertTimeEntryInList(entries: TimeEntry[], updatedEntry: TimeEntry): TimeEntry[] {
  const entryIndex = entries.findIndex((entry) => entry.id === updatedEntry.id);
  if (entryIndex < 0) {
    return [...entries, updatedEntry];
  }
  const nextEntries = [...entries];
  nextEntries[entryIndex] = mergeTimeEntryReviewUpdate(entries[entryIndex], updatedEntry);
  return nextEntries;
}

function mergeTimeEntryReviewUpdate(previousEntry: TimeEntry, updatedEntry: TimeEntry): TimeEntry {
  return {
    ...updatedEntry,
    gps_status: updatedEntry.gps_status ?? previousEntry.gps_status,
    gps_matched_points: updatedEntry.gps_matched_points ?? previousEntry.gps_matched_points,
    gps_total_points: updatedEntry.gps_total_points ?? previousEntry.gps_total_points,
    gps_first_seen_at: updatedEntry.gps_first_seen_at ?? previousEntry.gps_first_seen_at,
    gps_last_seen_at: updatedEntry.gps_last_seen_at ?? previousEntry.gps_last_seen_at,
    gps_work_minutes: updatedEntry.gps_work_minutes ?? previousEntry.gps_work_minutes,
    original_site_id: updatedEntry.original_site_id ?? previousEntry.original_site_id,
    original_site_name: updatedEntry.original_site_name ?? previousEntry.original_site_name,
    original_site_number: updatedEntry.original_site_number ?? previousEntry.original_site_number,
    planned_site_labels: updatedEntry.planned_site_labels.length ? updatedEntry.planned_site_labels : previousEntry.planned_site_labels,
    gps_detected_site_id: updatedEntry.gps_detected_site_id ?? previousEntry.gps_detected_site_id,
    gps_detected_site_name: updatedEntry.gps_detected_site_name ?? previousEntry.gps_detected_site_name,
    gps_detected_site_number: updatedEntry.gps_detected_site_number ?? previousEntry.gps_detected_site_number,
    gps_detected_location_type: updatedEntry.gps_detected_location_type ?? previousEntry.gps_detected_location_type,
    planned_vs_gps_mismatch: updatedEntry.planned_vs_gps_mismatch || previousEntry.planned_vs_gps_mismatch,
    manual_vs_planned_mismatch: updatedEntry.manual_vs_planned_mismatch || previousEntry.manual_vs_planned_mismatch,
    manual_vs_gps_mismatch: updatedEntry.manual_vs_gps_mismatch || previousEntry.manual_vs_gps_mismatch,
    gps_not_checkable: updatedEntry.gps_not_checkable || previousEntry.gps_not_checkable,
    mismatch_notice: updatedEntry.mismatch_notice ?? previousEntry.mismatch_notice,
    review_notices: updatedEntry.review_notices.length ? updatedEntry.review_notices : previousEntry.review_notices,
    has_manual_entry: isOfficeOnlyTimeEntry(updatedEntry) ? false : updatedEntry.has_manual_entry,
  };
}

function buildTimeReviewTableRows(
  openIssues: TimeReviewIssue[],
  allEntries: TimeEntry[],
  status: ReviewSummaryFilter,
  personFilter: string,
): TimeReviewTableRow[] {
  const rows = reviewRowsForStatus(openIssues, allEntries, status);
  const personNeedle = personFilter.trim().toLowerCase();
  return rows
    .filter((row) => !personNeedle || row.personName.toLowerCase().includes(personNeedle))
    .sort((left, right) => (
      left.personName.localeCompare(right.personName, "de", { sensitivity: "base" })
      || left.workDate.localeCompare(right.workDate)
      || left.id - right.id
    ));
}

function buildTimeReviewWorkerSummaries(
  people: Person[],
  allEntries: TimeEntry[],
  openEntries: TimeEntry[],
  absences: Absence[],
  reviewedWorkerIds: Set<number>,
): TimeReviewWorkerSummary[] {
  const openEntryIds = new Set(openEntries.map((entry) => entry.id));
  const summaries = new Map<number, TimeReviewWorkerSummary>();
  const absenceTypeByPersonId = highestPriorityAbsenceTypeByPerson(absences);

  people
    .filter(isPayrollReviewWorker)
    .forEach((person) => {
      summaries.set(person.id, {
        personId: person.id,
        personName: person.display_name,
        entryCount: 0,
        dayCount: 0,
        openIssueCount: 0,
        reviewedEntryCount: 0,
        totalMinutes: 0,
        submittedMinutes: 0,
        absenceType: absenceTypeByPersonId.get(person.id) ?? null,
        isReviewed: false,
        entries: [],
      });
    });

  allEntries.forEach((entry) => {
    const existing = summaries.get(entry.person_id);
    if (!existing) {
      return;
    }
    existing.entries.push(entry);
  });

  return Array.from(summaries.values())
    .map((summary) => {
      const dayCount = new Set(summary.entries.map((entry) => entry.work_date)).size;
      const openIssueCount = summary.entries.filter((entry) => openEntryIds.has(entry.id)).length;
      const reviewedEntryCount = summary.entries.filter((entry) => !openEntryIds.has(entry.id)).length;
      const totalMinutes = summary.entries.reduce((sum, entry) => sum + (effectivePayrollWorkMinutes(entry) ?? 0), 0);
      const submittedMinutes = summary.entries.reduce((sum, entry) => (
        entry.is_gps_suggestion ? sum : sum + (effectivePayrollWorkMinutes(entry) ?? 0)
      ), 0);
      return {
        ...summary,
        entryCount: summary.entries.length,
        dayCount,
        openIssueCount,
        reviewedEntryCount,
        totalMinutes,
        submittedMinutes,
        absenceType: absenceTypeByPersonId.get(summary.personId) ?? null,
        isReviewed: reviewedWorkerIds.has(summary.personId),
        entries: summary.entries.slice().sort(compareTimeReviewWorkerEntries),
      };
    })
    .sort((left, right) => left.personName.localeCompare(right.personName, "de", { sensitivity: "base" }));
}

function isPayrollReviewWorker(person: Person): boolean {
  if (!person.is_active || person.person_type !== "internal") {
    return false;
  }
  const activeRoles = person.user_roles ?? [];
  if (!activeRoles.length) {
    return true;
  }
  return activeRoles.length === 1 && activeRoles[0] === "monteur";
}

function highestPriorityAbsenceTypeByPerson(absences: Absence[]): Map<number, AbsenceType> {
  const result = new Map<number, AbsenceType>();
  absences
    .filter((absence) => absence.status === "active")
    .forEach((absence) => {
      const currentType = result.get(absence.person_id);
      if (!currentType || absenceTypePriority(absence.absence_type) < absenceTypePriority(currentType)) {
        result.set(absence.person_id, absence.absence_type);
      }
    });
  return result;
}

function absenceTypePriority(type: AbsenceType): number {
  const priorities: Record<AbsenceType, number> = {
    sick: 1,
    vacation: 2,
    school: 3,
    free: 4,
    other: 5,
  };
  return priorities[type];
}

function compareTimeReviewWorkerEntries(left: TimeEntry, right: TimeEntry): number {
  return left.work_date.localeCompare(right.work_date)
    || compareTimeEntryStartTimes(left, right)
    || timeEntrySiteLabel(left).localeCompare(timeEntrySiteLabel(right), "de")
    || left.id - right.id;
}

function compareTimeEntryStartTimes(left: TimeEntry, right: TimeEntry): number {
  const leftStart = timeEntryStartSortValue(left.start_time);
  const rightStart = timeEntryStartSortValue(right.start_time);
  return leftStart - rightStart;
}

function timeEntryStartSortValue(value: string | null): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const clockMatch = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (clockMatch) {
    return Number(clockMatch[1]) * 60 + Number(clockMatch[2]);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed.getHours() * 60 + parsed.getMinutes();
}

function buildTimeReviewWeekDays(
  entries: TimeEntry[],
  absences: Absence[],
  personId: number | null,
  weekStart: string,
): TimeReviewWeekDay[] {
  const entriesByDate = new Map<string, TimeEntry[]>();
  for (const entry of entries) {
    const dayEntries = entriesByDate.get(entry.work_date) ?? [];
    dayEntries.push(entry);
    entriesByDate.set(entry.work_date, dayEntries);
  }

  return numberRange(0, 6).map((dayOffset) => {
    const date = addDaysToDateInput(weekStart, dayOffset);
    const dayEntries = (entriesByDate.get(date) ?? []).slice().sort(compareTimeReviewWorkerEntries);
    const absenceType = personId === null ? null : highestPriorityAbsenceTypeForPersonDate(absences, personId, date);
    return {
      date,
      weekdayLabel: formatWeekday(date),
      absenceType,
      entries: dayEntries
        .map((entry) => ({
          entry,
          locationCheck: classifyTimeReviewLocationCheck(entry),
          timeCheck: classifyTimeReviewTimeCheck(entry, { hasMultipleEntriesOnDay: dayEntries.length > 1 }),
        })),
    };
  }).filter((day, index) => index < 5 || day.entries.length > 0 || day.absenceType !== null);
}

function buildReviewWeekDayOptions(weekStart: string): Array<{ date: string; label: string }> {
  return numberRange(0, 6).map((dayOffset) => {
    const date = addDaysToDateInput(weekStart, dayOffset);
    return { date, label: formatWeekday(date) };
  });
}

function buildMissingTimeReviewEntry(worker: TimeReviewWorkerSummary | null, workDate: string): TimeEntry {
  const personId = worker?.personId ?? 0;
  return {
    id: missingTimeReviewEntryId(personId, workDate),
    person_id: personId,
    person_name: worker?.personName ?? "",
    person_type: "internal",
    site_id: null,
    site_name: null,
    site_number: null,
    original_site_id: null,
    original_site_name: null,
    original_site_number: null,
    assignment_id: null,
    work_date: workDate,
    original_work_date: null,
    start_time: null,
    end_time: null,
    break_minutes: 0,
    travel_minutes: 0,
    work_minutes: 0,
    original_work_minutes: null,
    corrected_work_minutes: null,
    payroll_corrected_start_time: null,
    payroll_corrected_end_time: null,
    payroll_corrected_work_minutes: null,
    project_mounting_multiplier: 1,
    project_mounting_external_person_count: 0,
    project_mounting_participant_ids: [],
    project_mounting_participant_names: [],
    project_mounting_base_work_minutes: null,
    project_mounting_work_minutes: null,
    project_mounting_break_minutes: null,
    project_mounting_travel_minutes: null,
    note: OFFICE_ONLY_TIME_ENTRY_NOTE,
    source: "manual",
    status: "draft",
    time_review_status: "open",
    time_review_method: null,
    gps_status: null,
    gps_matched_points: null,
    gps_total_points: null,
    gps_first_seen_at: null,
    gps_last_seen_at: null,
    gps_work_minutes: null,
    created_by_user_id: null,
    reviewed_by_user_id: null,
    reviewed_at: null,
    payroll_reviewed_by_user_id: null,
    payroll_reviewed_at: null,
    created_at: `${workDate}T00:00:00Z`,
    updated_at: `${workDate}T00:00:00Z`,
    review_source: "manual",
    is_gps_suggestion: false,
    has_manual_entry: false,
    gps_suggestion_key: null,
    planned_site_labels: [],
    gps_detected_site_id: null,
    gps_detected_site_name: null,
    gps_detected_site_number: null,
    gps_detected_location_type: null,
    planned_vs_gps_mismatch: false,
    manual_vs_planned_mismatch: false,
    manual_vs_gps_mismatch: false,
    gps_not_checkable: false,
    mismatch_notice: null,
    review_notices: [],
    payroll_review_state: {
      state: "open",
      is_auto_plausible: false,
    },
  };
}

function missingTimeReviewEntryId(personId: number, workDate: string): number {
  const dateNumber = Number(workDate.replaceAll("-", ""));
  return -(dateNumber + (personId * 100000000));
}

function findEntryInReviewWeekDays(days: TimeReviewWeekDay[], entryId: number): TimeEntry | null {
  for (const day of days) {
    const match = day.entries.find((check) => check.entry.id === entryId);
    if (match) {
      return match.entry;
    }
  }
  return null;
}

function highestPriorityAbsenceTypeForPersonDate(
  absences: Absence[],
  personId: number,
  date: string,
): AbsenceType | null {
  let result: AbsenceType | null = null;
  absences
    .filter((absence) => (
      absence.status === "active"
      && absence.person_id === personId
      && absence.start_date <= date
      && absence.end_date >= date
    ))
    .forEach((absence) => {
      if (!result || absenceTypePriority(absence.absence_type) < absenceTypePriority(result)) {
        result = absence.absence_type;
      }
    });
  return result;
}

function classifyTimeReviewLocationCheck(entry: TimeEntry): TimeReviewCheckState {
  if (
    entry.gps_not_checkable
    || entry.gps_status === "not_checkable"
    || entry.review_notices.includes(GPS_NOT_CHECKABLE_NOTICE)
  ) {
    return "unknown";
  }

  if (!hasGpsSiteMatch(entry)) {
    return "unknown";
  }

  if (entry.site_id !== null && entry.gps_detected_site_id !== null) {
    return entry.site_id === entry.gps_detected_site_id ? "ok" : "warning";
  }

  if (entry.site_number && entry.gps_detected_site_number) {
    return normalizeComparableSiteValue(entry.site_number) === normalizeComparableSiteValue(entry.gps_detected_site_number)
      ? "ok"
      : "warning";
  }

  if (entry.site_name && entry.gps_detected_site_name) {
    return normalizeComparableSiteValue(entry.site_name) === normalizeComparableSiteValue(entry.gps_detected_site_name)
      ? "ok"
      : "warning";
  }

  if (entry.manual_vs_gps_mismatch) {
    return "warning";
  }

  return "unknown";
}

function classifyTimeReviewTimeCheck(entry: TimeEntry, options: { hasMultipleEntriesOnDay?: boolean } = {}): TimeReviewCheckState {
  if (hasPayrollTimeCorrection(entry)) {
    return "ok";
  }
  if (entry.time_review_status !== "open") {
    return entry.time_review_status === "not_verifiable" || entry.time_review_status === "clarification" ? "unknown" : "ok";
  }
  if (entry.is_gps_suggestion) {
    return "warning";
  }
  const manualMinutes = Number.isFinite(entry.work_minutes) ? entry.work_minutes : null;
  const gpsMinutes = entry.gps_work_minutes;
  if (manualMinutes !== null && manualMinutes > 12 * 60) {
    return "warning";
  }
  if (manualMinutes === null || gpsMinutes === null) {
    return "unknown";
  }
  if (options.hasMultipleEntriesOnDay) {
    return "unknown";
  }
  return Math.abs(gpsMinutes - manualMinutes) <= GPS_TIME_TOLERANCE_MINUTES ? "ok" : "warning";
}

function renderTimeReviewCheckMark(
  state: TimeReviewCheckState,
  options: { onClick?: () => void; label?: string; onWarningClick?: () => void; warningLabel?: string } = {},
) {
  const label = timeReviewCheckLabel(state);
  const clickHandler = options.onClick ?? (state === "warning" ? options.onWarningClick : undefined);
  if (clickHandler) {
    const actionLabel = options.label ?? options.warningLabel ?? "Diagnose öffnen";
    return (
      <button
        className={`time-review-check-mark is-${state} is-clickable`}
        type="button"
        aria-label={`${actionLabel}: ${label}`}
        title={`${actionLabel}: ${label}`}
        onClick={clickHandler}
      >
        {state === "ok" ? "✓" : state === "warning" ? "!" : "-"}
      </button>
    );
  }
  return (
    <span className={`time-review-check-mark is-${state}`} aria-label={label} title={label}>
      {state === "ok" ? "✓" : state === "warning" ? "!" : "-"}
    </span>
  );
}

function renderPayrollWorkMinutes(entry: TimeEntry) {
  const workMinutes = effectivePayrollWorkMinutes(entry);
  if (hasPayrollTimeCorrection(entry)) {
    return (
      <span className="time-review-payroll-corrected-time" title="Büro-geprüfte Zeit">
        {formatTimeEntryMinutes(workMinutes, "hours")}
      </span>
    );
  }
  return formatTimeEntryMinutes(workMinutes, "hours");
}

function renderTimeReviewBreakMinutes(entry: TimeEntry): string {
  if (isOfficeOnlyTimeEntry(entry)) {
    return "-";
  }
  return formatTimeEntryMinutes(entry.break_minutes, "minutes");
}

function renderPayrollClock(entry: TimeEntry, field: "start" | "end") {
  const value = field === "start" ? effectivePayrollStartTime(entry) : effectivePayrollEndTime(entry);
  if (hasPayrollTimeCorrection(entry)) {
    return (
      <span className="time-review-payroll-corrected-time" title="Büro-geprüfte Zeit">
        {formatTimeEntryClock(value)}
      </span>
    );
  }
  return formatTimeEntryClock(value);
}

function hasPayrollTimeCorrection(entry: TimeEntry): boolean {
  return (
    entry.payroll_corrected_start_time !== null
    || entry.payroll_corrected_end_time !== null
    || entry.payroll_corrected_work_minutes !== null
  );
}

function effectivePayrollStartTime(entry: TimeEntry): string | null {
  return entry.payroll_corrected_start_time ?? (isOfficeOnlyTimeEntry(entry) ? null : entry.start_time);
}

function effectivePayrollEndTime(entry: TimeEntry): string | null {
  return entry.payroll_corrected_end_time ?? (isOfficeOnlyTimeEntry(entry) ? null : entry.end_time);
}

function effectivePayrollWorkMinutes(entry: TimeEntry): number | null {
  const correctedMinutes = effectivePayrollCorrectedWorkMinutes(entry);
  if (correctedMinutes !== null) {
    return roundMinutesToQuarterHour(correctedMinutes + (entry.travel_minutes || 0));
  }
  return isOfficeOnlyTimeEntry(entry) ? null : roundMinutesToQuarterHour(entry.work_minutes + (entry.travel_minutes || 0));
}

function effectivePayrollCorrectedWorkMinutes(entry: TimeEntry): number | null {
  if (entry.payroll_corrected_work_minutes !== null) {
    return entry.payroll_corrected_work_minutes;
  }
  const startMinutes = clockValueToMinutes(entry.payroll_corrected_start_time);
  const endMinutes = clockValueToMinutes(entry.payroll_corrected_end_time);
  if (startMinutes === null || endMinutes === null || endMinutes < startMinutes) {
    return null;
  }
  return endMinutes - startMinutes;
}

function roundMinutesToQuarterHour(minutes: number): number {
  return Math.round(minutes / 15) * 15;
}

function timeReviewDiagnosticRows(entry: TimeEntry): TimeReviewDiagnosticRow[] {
  const hasSubmittedTime = !isOfficeOnlyTimeEntry(entry);
  return [
    {
      source: "Eingetragene Monteursstunden",
      start: hasSubmittedTime ? formatTimeEntryClock(entry.start_time) : "-",
      end: hasSubmittedTime ? formatTimeEntryClock(entry.end_time) : "-",
      total: hasSubmittedTime ? formatTimeEntryMinutes(entry.work_minutes, "hours") : "-",
    },
    {
      source: "Erkannte Handy GPS Stunden",
      start: formatTimeEntryClock(entry.gps_first_seen_at),
      end: formatTimeEntryClock(entry.gps_last_seen_at),
      total: formatTimeEntryMinutes(entry.gps_work_minutes, "hours"),
    },
    {
      source: "Erkannte Fahrzeug GPS Stunden",
      start: "-",
      end: "-",
      total: "-",
    },
  ];
}

function locationReviewDiagnosticRows(entry: TimeEntry, sites: SiteSummary[]): LocationReviewDiagnosticRow[] {
  const hasSubmittedSite = !isOfficeOnlyTimeEntry(entry);
  const originalSite = hasSubmittedSite ? findSiteSummary(sites, entry.original_site_id ?? entry.site_id) : null;
  const reviewedSite = findSiteSummary(sites, entry.site_id);
  const gpsSite = hasGpsSiteMatch(entry) ? findSiteSummary(sites, entry.gps_detected_site_id) : null;
  const rows: LocationReviewDiagnosticRow[] = [
    {
      source: "Eingetragene Monteursbaustelle",
      siteName: hasSubmittedSite ? displayDiagnosticValue(originalTimeEntrySiteName(entry)) : "-",
      siteNumber: hasSubmittedSite ? displayDiagnosticValue(entry.original_site_id !== null ? entry.original_site_number : entry.site_number) : "-",
      location: siteLocationLabel(originalSite),
    },
    {
      source: "Erkannte Handy-GPS-Baustelle",
      siteName: hasGpsSiteMatch(entry) ? displayDiagnosticValue(entry.gps_detected_site_name) : "-",
      siteNumber: hasGpsSiteMatch(entry) ? displayDiagnosticValue(entry.gps_detected_site_number) : "-",
      location: hasGpsSiteMatch(entry) ? siteLocationLabel(gpsSite) : "-",
    },
    {
      source: "Erkannte Fahrzeug-GPS-Baustelle",
      siteName: "-",
      siteNumber: "-",
      location: "-",
    },
  ];
  if (hasManualLocationReview(entry)) {
    rows.push({
      source: "manuell geprüfte Baustelle",
      siteName: displayDiagnosticValue(timeEntrySiteName(entry)),
      siteNumber: displayDiagnosticValue(entry.site_number),
      location: siteLocationLabel(reviewedSite),
      isManualReview: true,
    });
  }
  return rows;
}

function hasManualLocationReview(entry: TimeEntry): boolean {
  return entry.time_review_method === "assign_site";
}

function hasGpsSiteMatch(entry: TimeEntry): boolean {
  return (
    entry.gps_detected_location_type === "site"
    && Boolean(entry.gps_detected_site_id || entry.gps_detected_site_name || entry.gps_detected_site_number)
  );
}

function normalizeComparableSiteValue(value: string): string {
  return value.trim().toLocaleLowerCase("de-DE");
}

function findSiteSummary(sites: SiteSummary[], siteId: number | null): SiteSummary | null {
  if (siteId === null) {
    return null;
  }
  return sites.find((site) => site.id === siteId) ?? null;
}

function siteLocationLabel(site: SiteSummary | null): string {
  if (!site) {
    return "-";
  }
  return [site.location, site.city].filter(Boolean).join(" · ") || "-";
}

function displayDiagnosticValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed || "-";
}

function isOfficeOnlyTimeEntry(entry: TimeEntry): boolean {
  return (
    entry.note === OFFICE_ONLY_TIME_ENTRY_NOTE
    || (
      entry.id < 0
      && !entry.is_gps_suggestion
      && !entry.has_manual_entry
      && entry.work_minutes === 0
      && !entry.start_time
      && !entry.end_time
    )
  );
}

function isTravelTimeEntry(entry: TimeEntry): boolean {
  return !isOfficeOnlyTimeEntry(entry) && entry.work_minutes === 0 && (entry.travel_minutes || 0) > 0;
}

function renderPayrollReviewMark(
  entry: TimeEntry,
  options: { disabled: boolean; isBusy: boolean; onToggle: () => void },
) {
  const isReviewed = entry.payroll_reviewed_at !== null;
  return (
    <button
      className={["time-review-payroll-mark", isReviewed ? "is-reviewed" : ""].filter(Boolean).join(" ")}
      type="button"
      disabled={options.disabled}
      aria-label={isReviewed ? "Zeilenprüfung entfernen" : "Zeile als geprüft markieren"}
      title={isReviewed ? "Zeilenprüfung entfernen" : "Zeile als geprüft markieren"}
      onClick={options.onToggle}
    >
      {options.isBusy ? "..." : isReviewed ? "✓" : "-"}
    </button>
  );
}

function renderPayrollReviewEmptyMark() {
  return (
    <span className="time-review-payroll-mark is-empty" aria-label="Keine Zeitzeile">
      -
    </span>
  );
}

function formatTimeEntryClock(value: string | null): string {
  if (!value) {
    return "-";
  }
  const clockMatch = /^(\d{2}:\d{2})(?::\d{2})?$/.exec(value);
  if (clockMatch) {
    return clockMatch[1];
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "-" : formatTime(value);
}

function formatTimeEntryRange(entry: TimeEntry): string {
  if (!entry.start_time && !entry.end_time) {
    return "-";
  }
  return `${formatTimeEntryClock(entry.start_time)} - ${formatTimeEntryClock(entry.end_time)}`;
}

function formatTimeEntryMinutes(value: number | null | undefined, mode: "hours" | "minutes"): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  if (mode === "minutes") {
    return `${value} min`;
  }
  return `${formatSubmittedHours(value)} Std.`;
}

function timeReviewCheckLabel(state: TimeReviewCheckState): string {
  if (state === "ok") {
    return "Passt";
  }
  if (state === "warning") {
    return "Prüfen";
  }
  return "nicht prüfbar";
}

function reviewRowsForStatus(
  openIssues: TimeReviewIssue[],
  allEntries: TimeEntry[],
  status: ReviewSummaryFilter,
): TimeReviewTableRow[] {
  if (status === "needs_review") {
    return openIssues.map(timeReviewIssueToTableRow);
  }

  const autoPlausibleRows: TimeReviewTableRow[] = [];
  const verifiedRows: TimeReviewTableRow[] = [];

  for (const entry of allEntries) {
    if (isAutoPlausibleEntry(entry)) {
      autoPlausibleRows.push(timeEntryToTableRow(entry, "Passt", "active"));
    } else if (entry.time_review_status !== "open") {
      verifiedRows.push(timeEntryToTableRow(entry, finalStatusLabel(entry), "active"));
    }
  }

  if (status === "all") {
    return [
      ...autoPlausibleRows,
      ...openIssues.map(timeReviewIssueToTableRow),
      ...verifiedRows,
    ];
  }
  if (status === "matches") {
    return autoPlausibleRows;
  }
  return verifiedRows;
}

function timeReviewIssueToTableRow(issue: TimeReviewIssue): TimeReviewTableRow {
  return {
    id: issue.id,
    entry: issue.entry,
    issue,
    workDate: issue.workDate,
    personName: issue.personName,
    siteLabel: issue.siteLabel,
    siteNumber: timeEntrySiteNumber(issue.entry),
    siteName: timeEntrySiteName(issue.entry),
    manualMinutes: issue.manualMinutes,
    gpsMinutes: issue.gpsMinutes,
    deviationMinutes: issue.deviationMinutes,
    correctedMinutes: issue.entry.corrected_work_minutes,
    statusLabel: issue.statusLabel,
    statusTone: issue.statusTone,
    systemHint: issue.systemHint,
    canConfirm: issue.manualMinutes !== null && !issue.entry.is_gps_suggestion,
  };
}

function timeEntryToTableRow(entry: TimeEntry, statusLabel: string, statusTone: StatusBadgeTone): TimeReviewTableRow {
  const manualMinutes = entry.is_gps_suggestion ? null : Number.isFinite(entry.work_minutes) ? entry.work_minutes : null;
  const gpsMinutes = entry.gps_work_minutes;
  return {
    id: entry.id,
    entry,
    issue: null,
    workDate: entry.work_date,
    personName: entry.person_name,
    siteLabel: timeEntrySiteLabel(entry),
    siteNumber: timeEntrySiteNumber(entry),
    siteName: timeEntrySiteName(entry),
    manualMinutes,
    gpsMinutes,
    deviationMinutes: manualMinutes !== null && gpsMinutes !== null ? gpsMinutes - manualMinutes : null,
    correctedMinutes: entry.corrected_work_minutes,
    statusLabel,
    statusTone,
    systemHint: finalBasisLabel(entry),
    canConfirm: entry.time_review_status === "open" && manualMinutes !== null,
  };
}

function isAutoPlausibleEntry(entry: TimeEntry): boolean {
  if (entry.payroll_review_state) {
    return entry.payroll_review_state.is_auto_plausible;
  }
  return (
    entry.time_review_status === "open"
    && !entry.is_gps_suggestion
    && !hasBackendReviewNotice(entry)
    && entry.gps_work_minutes !== null
    && Math.abs(entry.gps_work_minutes - entry.work_minutes) <= GPS_TIME_TOLERANCE_MINUTES
  );
}

function timeReviewIssue(entry: TimeEntry): TimeReviewIssue | null {
  if (entry.time_review_status !== "open") {
    return null;
  }
  const manualMinutes = entry.is_gps_suggestion ? null : Number.isFinite(entry.work_minutes) ? entry.work_minutes : null;
  const gpsMinutes = entry.gps_work_minutes;
  if (manualMinutes === null && gpsMinutes === null) {
    return null;
  }
  const deviationMinutes = manualMinutes !== null && gpsMinutes !== null ? gpsMinutes - manualMinutes : null;
  if (isAutoPlausibleEntry(entry)) {
    return null;
  }

  const classification = classifyTimeReviewCase(entry, manualMinutes, gpsMinutes, deviationMinutes);
  return {
    id: entry.id,
    entry,
    workDate: entry.work_date,
    personName: entry.person_name,
    siteLabel: timeEntrySiteLabel(entry),
    manualMinutes,
    gpsMinutes,
    deviationMinutes,
    finalMinutes: entry.corrected_work_minutes ?? entry.work_minutes ?? gpsMinutes,
    ...classification,
  };
}

function hasBackendReviewNotice(entry: TimeEntry): boolean {
  return (
    entry.review_notices.length > 0
    || entry.planned_vs_gps_mismatch
    || entry.manual_vs_planned_mismatch
    || entry.manual_vs_gps_mismatch
    || entry.gps_not_checkable
  );
}

function sourceConflictNotices(entry: TimeEntry): string[] {
  const notices = entry.review_notices.filter((notice) => notice !== GPS_NOT_CHECKABLE_NOTICE);
  if (notices.length) {
    return notices;
  }
  return [
    entry.planned_vs_gps_mismatch ? "GPS-Aufenthalt weicht von Planungsmatrix ab" : "",
    entry.manual_vs_gps_mismatch ? "Gemeldete Baustelle weicht von GPS ab" : "",
    entry.manual_vs_planned_mismatch ? "Stundeneingabe weicht von Planungsmatrix ab" : "",
  ].filter(Boolean);
}

function isProblematicReviewRow(row: TimeReviewTableRow): boolean {
  return row.issue !== null || row.entry.is_gps_suggestion || hasBackendReviewNotice(row.entry);
}

function isCheckedReviewRow(row: TimeReviewTableRow): boolean {
  return (
    buildTimeReviewInstruction(row) === "automatisch geprüft"
    || row.entry.time_review_status === "manually_approved"
    || row.entry.time_review_status === "corrected"
  );
}

function reviewSourceSummary(_entry: TimeEntry, hint: string): string {
  return hint;
}

function classifyTimeReviewCase(
  entry: TimeEntry,
  manualMinutes: number | null,
  gpsMinutes: number | null,
  deviationMinutes: number | null,
): Pick<TimeReviewIssue, "status" | "statusLabel" | "statusTone" | "systemHint" | "priority" | "detail"> {
  if (entry.is_gps_suggestion) {
    return {
      status: "needs_review",
      statusLabel: "Prüfung empfohlen",
      statusTone: "planned",
      priority: 2,
      systemHint: "GPS erkannt · kein manueller Eintrag",
      detail: "Bitte GPS-Zeit übernehmen, manuell anpassen oder eine reguläre Arbeitszeit erfassen.",
    };
  }
  if (sourceConflictNotices(entry).length > 0) {
    return {
      status: "needs_review",
      statusLabel: "Prüfung empfohlen",
      statusTone: "planned",
      priority: 2,
      systemHint: reviewSourceSummary(entry, sourceConflictNotices(entry).join(" · ")),
      detail: "Planungsmatrix, Stundenzettel und GPS passen fachlich nicht zusammen.",
    };
  }
  if (!entry.site_id && manualMinutes !== null) {
    return {
      status: "critical",
      statusLabel: "Kritisch",
      statusTone: "warning",
      priority: 1,
      systemHint: reviewSourceSummary(entry, "Arbeitszeit ist vorhanden, aber keine Baustelle zugeordnet."),
      detail: "Bitte Baustelle zuordnen oder bewusst als nicht zuordenbar klären.",
    };
  }
  if (manualMinutes === null && gpsMinutes !== null) {
    return {
      status: "needs_review",
      statusLabel: "Prüfung empfohlen",
      statusTone: "planned",
      priority: 2,
      systemHint: reviewSourceSummary(entry, "GPS-Zeit ist vorhanden, aber keine manuelle Arbeitszeit erfasst."),
      detail: "Bitte Arbeitszeit nachtragen, GPS-Zeit übernehmen oder zur Klärung markieren.",
    };
  }
  if (gpsMinutes === null) {
    const hasGpsSignals = Boolean(entry.gps_first_seen_at);
    return {
      status: "not_verifiable",
      statusLabel: "Nicht prüfbar",
      statusTone: "neutral",
      priority: 3,
      systemHint: reviewSourceSummary(entry, hasGpsSignals
        ? "GPS-Signale sind vorhanden, aber die GPS-Arbeitszeit ist nicht berechenbar."
        : (entry.review_notices[0] ?? "Keine GPS-Daten für diesen Tag vorhanden.")),
      detail: hasGpsSignals
        ? "Es gibt nur einen GPS-Punkt oder eine unvollständige GPS-Kette."
        : "Bitte manuelle Zeit übernehmen, zur Klärung markieren oder als nicht prüfbar bestätigen.",
    };
  }
  if (manualMinutes !== null && manualMinutes > 12 * 60) {
    return {
      status: "critical",
      statusLabel: "Kritisch",
      statusTone: "warning",
      priority: 1,
      systemHint: reviewSourceSummary(entry, "Die gemeldete Arbeitszeit ist ungewöhnlich lang."),
      detail: "Bitte die Stunden menschlich bestätigen oder korrigieren.",
    };
  }
  if (deviationMinutes !== null && Math.abs(deviationMinutes) > 60) {
    return {
      status: "critical",
      statusLabel: "Kritisch",
      statusTone: "warning",
      priority: 1,
      systemHint: reviewSourceSummary(entry, "GPS-Zeit und gemeldete Zeit weichen deutlich voneinander ab."),
      detail: `Abweichung: ${formatHumanDeviation(deviationMinutes)}.`,
    };
  }
  return {
    status: "needs_review",
    statusLabel: "Prüfung empfohlen",
    statusTone: "planned",
    priority: 2,
    systemHint: reviewSourceSummary(entry, "GPS-Zeit weicht mehr als 15 Minuten ab."),
    detail: `Abweichung: ${formatHumanDeviation(deviationMinutes)}.`,
  };
}

function formatHumanDeviation(minutes: number | null): string {
  if (minutes === null) {
    return "-";
  }
  const sign = minutes > 0 ? "+" : minutes < 0 ? "-" : "";
  return `${sign}${formatMinutes(Math.abs(minutes))}`;
}

function calculateReviewSummary(openIssues: TimeReviewIssue[], entries: TimeEntry[]) {
  let autoPlausible = 0;
  let verified = 0;
  let needsReview = 0;
  let critical = 0;
  let notVerifiable = 0;

  for (const entry of entries) {
    if (entry.time_review_status !== "open") {
      verified += 1;
      continue;
    }
    if (isAutoPlausibleEntry(entry)) {
      autoPlausible += 1;
    }
  }
  for (const issue of openIssues) {
    if (issue.status === "needs_review") {
      needsReview += 1;
    } else if (issue.status === "critical") {
      critical += 1;
    } else if (issue.status === "not_verifiable") {
      notVerifiable += 1;
    }
  }
  const reviewRecommended = openIssues.length;
  return {
    all: autoPlausible + reviewRecommended + verified,
    autoPlausible,
    verified,
    reviewRecommended,
    needsReview,
    critical,
    notVerifiable,
  };
}

function sanitizeFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|.]+/g, " ")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function downloadBlobFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildFinalHoursEntries(entries: TimeEntry[]): FinalHoursEntry[] {
  return entries
    .map((entry) => {
      const originalMinutes = entry.original_work_minutes ?? entry.work_minutes;
      const gpsMinutes = entry.gps_work_minutes;
      const finalMinutes = effectivePayrollWorkMinutes(entry);
      return {
        id: entry.id,
        workDate: entry.work_date,
        personName: entry.person_name,
        siteLabel: timeEntrySiteLabel(entry),
        siteKey: timeEntrySiteLabel(entry),
        finalMinutes,
        statusLabel: finalStatusLabel(entry),
        basisLabel: finalBasisLabel(entry),
        originalMinutes,
        gpsMinutes,
        deviationMinutes: gpsMinutes === null ? null : gpsMinutes - originalMinutes,
        note: entry.note || finalNoteLabel(entry),
        reviewedAt: entry.reviewed_at,
        reviewedByUserId: entry.reviewed_by_user_id,
      };
    })
    .sort((left, right) => (
      left.workDate.localeCompare(right.workDate)
      || left.personName.localeCompare(right.personName, "de", { sensitivity: "base" })
      || left.id - right.id
    ));
}

function calculateFinalHoursTotals(entries: FinalHoursEntry[]): {
  totalMinutes: number;
  byPerson: { label: string; minutes: number }[];
  bySite: { label: string; minutes: number }[];
} {
  const byPerson = new Map<string, number>();
  const bySite = new Map<string, number>();
  let totalMinutes = 0;
  for (const entry of entries) {
    const minutes = entry.finalMinutes ?? 0;
    totalMinutes += minutes;
    byPerson.set(entry.personName, (byPerson.get(entry.personName) ?? 0) + minutes);
    bySite.set(entry.siteKey, (bySite.get(entry.siteKey) ?? 0) + minutes);
  }
  return {
    totalMinutes,
    byPerson: mapTotalsToRows(byPerson),
    bySite: mapTotalsToRows(bySite),
  };
}

function mapTotalsToRows(totals: Map<string, number>): { label: string; minutes: number }[] {
  return [...totals.entries()]
    .map(([label, minutes]) => ({ label, minutes }))
    .sort((left, right) => left.label.localeCompare(right.label, "de", { sensitivity: "base" }));
}

function finalStatusLabel(entry: TimeEntry): string {
  if (entry.time_review_status === "open") {
    if (isAutoPlausibleEntry(entry)) {
      return "automatisch plausibel";
    }
    return "offen";
  }
  if (entry.time_review_status === "manually_approved") {
    return "geprüft";
  }
  if (entry.time_review_status === "corrected") {
    return "korrigiert";
  }
  if (entry.time_review_status === "not_verifiable") {
    return "nicht prüfbar";
  }
  if (entry.time_review_status === "clarification") {
    return "zur Klärung";
  }
  if (entry.time_review_status === "auto_closed_by_deadline") {
    return "automatisch abgeschlossen";
  }
  return entry.time_review_status;
}

function finalBasisLabel(entry: TimeEntry): string {
  if (hasPayrollTimeCorrection(entry)) {
    return "Bürozeit geprüft";
  }
  if (entry.time_review_method === "accept_manual" || entry.time_review_method === "manual_confirmed") {
    return "manuelle Zeit übernommen";
  }
  if (entry.time_review_method === "accept_gps") {
    return "GPS-Zeit übernommen";
  }
  if (entry.time_review_method === "manual_correction") {
    return "korrigiert";
  }
  if (entry.time_review_method === "assign_site") {
    return "Baustelle zugeordnet";
  }
  if (entry.time_review_method === "mark_not_verifiable") {
    return "nicht prüfbar markiert";
  }
  if (entry.time_review_method === "clarification") {
    return "zur Klärung";
  }
  if (entry.time_review_method === "deadline") {
    return "Monatsfrist";
  }
  if (isAutoPlausibleEntry(entry)) {
    return "automatisch plausibel";
  }
  return "offen";
}

function finalNoteLabel(entry: TimeEntry): string {
  if (!entry.site_id) {
    return "Baustelle fehlt oder wurde noch nicht zugeordnet.";
  }
  if (entry.time_review_status === "clarification") {
    return "Fall ist bewusst zur Klärung markiert.";
  }
  if (entry.time_review_status === "not_verifiable") {
    return "GPS konnte nicht verlässlich geprüft werden.";
  }
  return "-";
}

function formatDecimalHours(minutes: number): string {
  return formatDecimalHoursValue(minutes / 60);
}

function formatDecimalHoursValue(hours: number): string {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(hours);
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

function buildPayrollCorrectionPayload(
  form: PayrollCorrectionFormState,
): { ok: true; payload: TimeEntryPayrollCorrection } | { ok: false; error: string } {
  const startTime = parseOptionalClockValue(form.start_time, "Anfang Arbeitszeit");
  if (!startTime.ok) {
    return startTime;
  }
  const endTime = parseOptionalClockValue(form.end_time, "Ende Arbeitszeit");
  if (!endTime.ok) {
    return endTime;
  }
  const workMinutes = parseOptionalHoursToMinutes(form.hours);
  if (!workMinutes.ok) {
    return workMinutes;
  }
  if (startTime.value && endTime.value && startTime.value >= endTime.value) {
    return { ok: false, error: "Ende Arbeitszeit muss nach dem Anfang liegen." };
  }
  const calculatedWorkMinutes = workMinutes.value ?? (
    startTime.value && endTime.value
      ? (clockValueToMinutes(endTime.value) ?? 0) - (clockValueToMinutes(startTime.value) ?? 0)
      : null
  );
  if (!startTime.value && !endTime.value && calculatedWorkMinutes === null) {
    return { ok: false, error: "Bitte mindestens eine Bürozeit eintragen." };
  }
  return {
    ok: true,
    payload: {
      payroll_corrected_start_time: startTime.value,
      payroll_corrected_end_time: endTime.value,
      payroll_corrected_work_minutes: calculatedWorkMinutes,
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

function parseOptionalHoursToMinutes(value: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  const parsed = parseHoursToMinutes(trimmed);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, value: parsed.value };
}

function parseOptionalClockValue(value: string, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
    return { ok: false, error: `${label} muss im Format HH:MM eingetragen werden.` };
  }
  return { ok: true, value: trimmed };
}

function clockValueToMinutes(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const clockMatch = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!clockMatch) {
    return null;
  }
  return Number(clockMatch[1]) * 60 + Number(clockMatch[2]);
}

function timeInputValue(value: string | null): string {
  if (!value) {
    return "";
  }
  const clockMatch = /^(\d{2}:\d{2})(?::\d{2})?$/.exec(value);
  return clockMatch ? clockMatch[1] : "";
}

function isCurrentLocalDateInput(value: string): boolean {
  return value === toDateInputValue(new Date());
}

function timeEntrySiteLabel(entry: TimeEntry): string {
  const linkedSiteLabel = [entry.site_name, entry.site_number].filter(Boolean).join(" · ");
  return linkedSiteLabel || manualTimeEntrySiteText(entry) || "-";
}

function timeEntrySiteNumber(entry: TimeEntry): string {
  return entry.site_number || "-";
}

function timeEntrySiteName(entry: TimeEntry): string {
  return entry.site_name || manualTimeEntrySiteText(entry) || "-";
}

function originalTimeEntrySiteName(entry: TimeEntry): string {
  if (isOfficeOnlyTimeEntry(entry)) {
    return "-";
  }
  if (entry.original_site_id !== null) {
    return entry.original_site_name || "-";
  }
  return timeEntrySiteName(entry);
}

function manualTimeEntrySiteText(entry: TimeEntry): string {
  if (entry.site_id !== null || !entry.note || isOfficeOnlyTimeEntry(entry)) {
    return "";
  }
  return entry.note.replace(/^Manuelle Baustelle:\s*/i, "").trim();
}

function siteOptionLabel(site: SiteSummary): string {
  return [site.site_number, site.name].filter(Boolean).join(" · ") || `Baustelle ${site.id}`;
}

function isSelectableLocationReviewSite(site: SiteSummary): boolean {
  return site.status === "active" || site.status === "paused" || site.status === "planned";
}

function filterLocationReviewSites(sites: SiteSummary[], query: string): SiteSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  return sites.filter((site) => locationReviewSiteSearchText(site).includes(needle));
}

function locationReviewSiteSearchText(site: SiteSummary): string {
  return [
    site.site_number,
    site.name,
    site.location,
    site.city,
    site.customer,
  ].filter(Boolean).join(" ").toLowerCase();
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
