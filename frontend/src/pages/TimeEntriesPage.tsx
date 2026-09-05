import { AlertTriangle, ArrowRight, CalendarPlus, CarFront, Check, ChevronLeft, ChevronRight, ChevronsUpDown, Download, LockKeyhole, MoreHorizontal, Search, Settings2, Trash2, Wrench, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { canEditMainPage, canManagePayrollMonthClose } from "../auth/permissions";
import { DashboardNotePicker } from "../components/DashboardNotePickers";
import { PayrollSetupDialog } from "../components/PayrollSetupDialog";
import { PayrollSiteCockpit } from "../components/PayrollSiteCockpit";
import { PayrollOvernightStatusControl } from "../components/PayrollOvernightStatusControl";
import { StatusBadge, absenceTypeLabels, type StatusBadgeTone } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import {
  formatPayrollMonthWorkDateContext,
  payrollMonthKey,
  payrollWorkDateLock,
  payrollMonthFilename,
  payrollMonthSelectionsForDateRange,
  payrollSnapshotVersion,
} from "../lib/payrollMonth";
import {
  buildCalendarMonthWindowOptions,
  calendarMonthRange,
  currentCalendarMonth,
  type CalendarMonthSelection,
} from "../lib/calendarMonth";
import {
  applyPayrollTimeBasisChange,
  buildPayrollManualEntryPayload,
  calculatePayrollTime,
  isOfficeOnlyPayrollEntry,
  isTravelOnlyPayrollEntry,
  OFFICE_ONLY_TIME_ENTRY_NOTE,
  parsePayrollBreakMinutes,
  roundMinutesToQuarterHour,
  resolvePayrollCorrectionWorkMinutes,
  type PayrollCorrectionDraft,
  type PayrollTimeBasisField,
} from "../lib/payrollTimeCorrection";
import {
  formatGermanDateKey as formatDate,
  formatGermanDateKeyRange as formatRangeLabel,
  formatGermanDetailDate as formatDetailDate,
  formatGermanTimeShort as formatTime,
  formatGermanWeekdayShort as formatWeekday,
  formatVerboseMinutes as formatMinutes,
} from "../lib/formatters";
import { applyOvernightStatusToWorkDate, summarizeOvernightStatuses } from "../lib/overnightStatus";
import {
  payrollWeekPersonsById,
  payrollWeekTotalMinutes,
  vacationCreditMinutesForDate,
} from "../lib/payrollWeek";
import { resolveViewportPopoverPosition, type ViewportPopoverPosition } from "../lib/viewportPopover";
import {
  centeredWeekWindowStart,
  clampWeekWindowStart,
  PAYROLL_WEEK_VISIBLE_COUNT,
} from "../lib/weekStrip";
import type { Absence } from "../types/absence";
import type { AbsenceType } from "../types/matrix";
import type { Person } from "../types/person";
import type { PayrollMonthBlocker, PayrollMonthLockStatus, PayrollMonthPeriod, PayrollMonthPersonApproval } from "../types/payrollMonth";
import type { SiteSummary } from "../types/site";
import type { OvernightStatus, PayrollSiteCockpit as PayrollSiteCockpitData, TimeEntry, TimeEntryPayrollCorrection, TimeEntryPayrollDeleteResult, TimeEntryPayrollWeek, TimeEntryPayrollWeekPerson, TimeEntryWeeklyReview } from "../types/timeEntry";

type TimeSubtab = "review" | "evaluation";
type EvaluationSubtab = "workers" | "sites";
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
type TimeReviewDialogMode = "create" | "edit";
type PayrollDatePickerState = {
  entryId: number;
  triggerTop: number;
  triggerBottom: number;
  triggerLeft: number;
  position: ViewportPopoverPosition | null;
};
type PayrollReviewStatusMenuState = {
  triggerTop: number;
  triggerBottom: number;
  triggerLeft: number;
  triggerRight: number;
  position: ViewportPopoverPosition | null;
};
type PayrollDeleteDialogState = {
  entry: TimeEntry;
  weeklyReviewed: boolean;
};
type PayrollCorrectionFormState = PayrollCorrectionDraft;
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
  isReset: boolean;
  entries: TimeEntry[];
};
type TimeReviewWorkerFilter = "all" | "open" | "missing" | "reviewed";
type TimeReviewWorkerStatus = Exclude<TimeReviewWorkerFilter, "all">;
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
  overnightStatus: OvernightStatus | null;
  hasOvernightStatusConflict: boolean;
  vacationCreditMinutes: number;
  entries: TimeReviewEntryCheck[];
};
type TimeReviewMonthWeekGroup = {
  key: string;
  week: number;
  totalMinutes: number;
  days: TimeReviewWeekDay[];
};
type TimeReviewDiagnosticRow = {
  source: string;
  start: string;
  end: string;
  break: string;
  total: string;
};
type LocationReviewDiagnosticRow = {
  source: string;
  siteName: string;
  siteNumber: string;
  location: string;
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
type PayrollMonthDialog = "lock" | "reopen" | null;
type PayrollPersonMonthDialog = "approve" | "reopen" | null;
const GPS_TIME_TOLERANCE_MINUTES = 15;
const GPS_NOT_CHECKABLE_NOTICE = "GPS nicht eindeutig prüfbar";
const TIME_REVIEW_PERF_STORAGE_KEY = "beg_time_review_perf";
const TIME_REVIEW_API_REVIEW_WEEK = "review week";
const TIME_REVIEW_API_ABSENCES = "absences";
const TIME_REVIEW_API_PAYROLL_WEEK = "payroll week";
const TIME_REVIEW_API_WEEKLY_REVIEWS = "weekly reviews";
const TIME_REVIEW_API_MONTH_LOCKS = "month locks";
const EMPTY_REVIEW_ENTRIES: TimeEntry[] = [];
const EMPTY_REVIEW_ABSENCES: Absence[] = [];
const timeSubtabs: { key: TimeSubtab; label: string }[] = [
  { key: "review", label: "Stundenprüfung" },
  { key: "evaluation", label: "Auswertung" },
];

export function TimeEntriesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [people, setPeople] = useState<Person[]>([]);
  const [activeTimeSubtab, setActiveTimeSubtab] = useState<TimeSubtab>("review");
  const [activeEvaluationSubtab, setActiveEvaluationSubtab] = useState<EvaluationSubtab>("workers");
  const [reviewEntries, setReviewEntries] = useState<TimeEntry[]>([]);
  const [reviewAllEntries, setReviewAllEntries] = useState<TimeEntry[]>([]);
  const [reviewAbsences, setReviewAbsences] = useState<Absence[]>([]);
  const [reviewAllEntriesRangeKey, setReviewAllEntriesRangeKey] = useState<string | null>(null);
  const [reviewAbsencesRangeKey, setReviewAbsencesRangeKey] = useState<string | null>(null);
  const [reviewPayrollWeek, setReviewPayrollWeek] = useState<TimeEntryPayrollWeek | null>(null);
  const [reviewWeeklyReviews, setReviewWeeklyReviews] = useState<TimeEntryWeeklyReview[]>([]);
  const [reviewWeekCompletionReviews, setReviewWeekCompletionReviews] = useState<TimeEntryWeeklyReview[]>([]);
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [isLoadingSites, setIsLoadingSites] = useState(true);
  const [sitesError, setSitesError] = useState<string | null>(null);
  const [isLoadingPeople, setIsLoadingPeople] = useState(true);
  const [isLoadingReviewEntries, setIsLoadingReviewEntries] = useState(false);
  const [isLoadingReviewAllEntries, setIsLoadingReviewAllEntries] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewEntriesError, setReviewEntriesError] = useState<string | null>(null);
  const [reviewAllEntriesError, setReviewAllEntriesError] = useState<string | null>(null);
  const [reviewPayrollWeekError, setReviewPayrollWeekError] = useState<string | null>(null);
  const [reviewActionError, setReviewActionError] = useState<string | null>(null);
  const [payrollDatePicker, setPayrollDatePicker] = useState<PayrollDatePickerState | null>(null);
  const [payrollDeleteDialog, setPayrollDeleteDialog] = useState<PayrollDeleteDialogState | null>(null);
  const [isDeletingPayrollEntry, setIsDeletingPayrollEntry] = useState(false);
  const [payrollDeleteError, setPayrollDeleteError] = useState<string | null>(null);
  const [payrollReviewActionEntryId, setPayrollReviewActionEntryId] = useState<number | null>(null);
  const [payrollDateActionEntryId, setPayrollDateActionEntryId] = useState<number | null>(null);
  const [payrollDateError, setPayrollDateError] = useState<string | null>(null);
  const [payrollOvernightSavingKey, setPayrollOvernightSavingKey] = useState<string | null>(null);
  const [selectedReviewWeek, setSelectedReviewWeek] = useState<CalendarWeekSelection>(() => currentIsoWeek());
  const [selectedEvaluationMonth, setSelectedEvaluationMonth] = useState<CalendarMonthSelection>(() => currentCalendarMonth());
  const [selectedReviewPersonId, setSelectedReviewPersonId] = useState<number | null>(null);
  const [selectedEvaluationPersonId, setSelectedEvaluationPersonId] = useState<number | null>(null);
  const [payrollSiteCockpit, setPayrollSiteCockpit] = useState<PayrollSiteCockpitData | null>(null);
  const [payrollSiteCockpitError, setPayrollSiteCockpitError] = useState<string | null>(null);
  const [isLoadingPayrollSiteCockpit, setIsLoadingPayrollSiteCockpit] = useState(false);
  const [payrollSiteCockpitRefreshKey, setPayrollSiteCockpitRefreshKey] = useState(0);
  const [expandedEvaluationDayKeys, setExpandedEvaluationDayKeys] = useState<Set<string>>(() => new Set());
  const [timeReviewDiagnosticEntry, setTimeReviewDiagnosticEntry] = useState<TimeEntry | null>(null);
  const [timeReviewDialogMode, setTimeReviewDialogMode] = useState<TimeReviewDialogMode | null>(null);
  const [timeReviewPopupTop, setTimeReviewPopupTop] = useState<number | null>(null);
  const [locationReviewDiagnosticEntry, setLocationReviewDiagnosticEntry] = useState<TimeEntry | null>(null);
  const [locationReviewSiteId, setLocationReviewSiteId] = useState("");
  const [hasLocationReviewSitePreview, setHasLocationReviewSitePreview] = useState(false);
  const [locationReviewSiteSearch, setLocationReviewSiteSearch] = useState("");
  const [isLocationReviewPickerOpen, setIsLocationReviewPickerOpen] = useState(false);
  const [locationReviewActiveSiteId, setLocationReviewActiveSiteId] = useState("");
  const [locationReviewError, setLocationReviewError] = useState<string | null>(null);
  const [isSavingLocationReview, setIsSavingLocationReview] = useState(false);
  const [locationReviewPopupTop, setLocationReviewPopupTop] = useState<number | null>(null);
  const [payrollCorrectionForm, setPayrollCorrectionForm] = useState<PayrollCorrectionFormState>({
    start_time: "",
    end_time: "",
    break_minutes: "",
    hours: "",
  });
  const [payrollManualWorkDate, setPayrollManualWorkDate] = useState("");
  const [payrollManualSiteId, setPayrollManualSiteId] = useState("");
  const [payrollManualSiteError, setPayrollManualSiteError] = useState<string | null>(null);
  const [payrollCorrectionError, setPayrollCorrectionError] = useState<string | null>(null);
  const [isSavingPayrollCorrection, setIsSavingPayrollCorrection] = useState(false);
  const [isDownloadingAllReviewWeekXlsx, setIsDownloadingAllReviewWeekXlsx] = useState(false);
  const [isDownloadingReviewWeekXlsx, setIsDownloadingReviewWeekXlsx] = useState(false);
  const [isDownloadingAllPayrollMonthXlsx, setIsDownloadingAllPayrollMonthXlsx] = useState(false);
  const [isDownloadingPayrollMonthXlsx, setIsDownloadingPayrollMonthXlsx] = useState(false);
  const [payrollMonthDownloadError, setPayrollMonthDownloadError] = useState<string | null>(null);
  const [payrollMonthPeriod, setPayrollMonthPeriod] = useState<PayrollMonthPeriod | null>(null);
  const [isLoadingPayrollMonthPeriod, setIsLoadingPayrollMonthPeriod] = useState(false);
  const [payrollMonthPeriodError, setPayrollMonthPeriodError] = useState<string | null>(null);
  const [payrollMonthDialog, setPayrollMonthDialog] = useState<PayrollMonthDialog>(null);
  const [payrollPersonMonthDialog, setPayrollPersonMonthDialog] = useState<PayrollPersonMonthDialog>(null);
  const [hasAcknowledgedPayrollPersonBlockers, setHasAcknowledgedPayrollPersonBlockers] = useState(false);
  const [payrollMonthReopenReason, setPayrollMonthReopenReason] = useState("");
  const [payrollPersonMonthReopenReason, setPayrollPersonMonthReopenReason] = useState("");
  const [isUpdatingPayrollMonth, setIsUpdatingPayrollMonth] = useState(false);
  const [isUpdatingPayrollPersonMonth, setIsUpdatingPayrollPersonMonth] = useState(false);
  const [isPayrollPersonLogExpanded, setIsPayrollPersonLogExpanded] = useState(false);
  const [reviewWeekPayrollMonthStatuses, setReviewWeekPayrollMonthStatuses] = useState<Record<string, PayrollMonthLockStatus>>({});
  const [reviewWeekPayrollMonthStatusRangeKey, setReviewWeekPayrollMonthStatusRangeKey] = useState<string | null>(null);
  const [isLoadingReviewWeekPayrollMonthStatuses, setIsLoadingReviewWeekPayrollMonthStatuses] = useState(false);
  const [reviewWeekPayrollMonthStatusError, setReviewWeekPayrollMonthStatusError] = useState<string | null>(null);
  const [isPayrollSetupOpen, setIsPayrollSetupOpen] = useState(false);
  const [payrollMonthPeriodRefreshKey, setPayrollMonthPeriodRefreshKey] = useState(0);
  const [markingReviewWeekPersonId, setMarkingReviewWeekPersonId] = useState<number | null>(null);
  const [isReviewWeekActionsMenuOpen, setIsReviewWeekActionsMenuOpen] = useState(false);
  const [reviewWeekActionsMenuPosition, setReviewWeekActionsMenuPosition] = useState<PayrollReviewStatusMenuState | null>(null);
  const [reviewWeekStatusMenuPersonId, setReviewWeekStatusMenuPersonId] = useState<number | null>(null);
  const [reviewWeekStatusMenuPosition, setReviewWeekStatusMenuPosition] = useState<PayrollReviewStatusMenuState | null>(null);
  const [reviewHoursDownloadError, setReviewHoursDownloadError] = useState<string | null>(null);
  const [reviewWorkerSearch, setReviewWorkerSearch] = useState("");
  const [reviewWorkerFilter, setReviewWorkerFilter] = useState<TimeReviewWorkerFilter>("all");
  const [evaluationWorkerSearch, setEvaluationWorkerSearch] = useState("");
  const [evaluationWorkerFilter, setEvaluationWorkerFilter] = useState<TimeReviewWorkerFilter>("all");
  const [reviewWeekScrollState, setReviewWeekScrollState] = useState({ canScrollLeft: false, canScrollRight: false });
  const [evaluationMonthScrollState, setEvaluationMonthScrollState] = useState({ canScrollLeft: false, canScrollRight: false });
  const canManageTimeEntries = canEditMainPage(user, "payroll");
  const canManagePayrollClose = canManagePayrollMonthClose(user);
  const visibleTimeSubtabs = timeSubtabs;
  const reviewWeekStripRef = useRef<HTMLDivElement | null>(null);
  const evaluationMonthStripRef = useRef<HTMLDivElement | null>(null);
  const timeReviewWorkerPanelRef = useRef<HTMLDivElement | null>(null);
  const reviewWeekActionsMenuControlRef = useRef<HTMLDivElement | null>(null);
  const reviewWeekActionsMenuRef = useRef<HTMLDivElement | null>(null);
  const reviewWeekActionsMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const reviewWeekStatusMenuControlRef = useRef<HTMLDivElement | null>(null);
  const reviewWeekStatusMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const reviewWeekStatusMenuRef = useRef<HTMLDivElement | null>(null);
  const payrollDatePickerMenuRef = useRef<HTMLDivElement | null>(null);
  const locationReviewPickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const hasAutoScrolledVisibleReviewWeekRef = useRef(false);
  const lastAlignedReviewWeekKeyRef = useRef<string | null>(null);
  const timeReviewPerfRef = useRef<TimeReviewPerfState | null>(null);
  const timeReviewRenderCountRef = useRef(0);
  timeReviewRenderCountRef.current += 1;

  useEffect(() => {
    if (reviewWeekStatusMenuPersonId === null) {
      return undefined;
    }
    function closeStatusMenuOnOutsideClick(event: MouseEvent) {
      if (
        event.target instanceof Node
        && (
          reviewWeekStatusMenuControlRef.current?.contains(event.target)
          || reviewWeekStatusMenuRef.current?.contains(event.target)
        )
      ) {
        return;
      }
      setReviewWeekStatusMenuPersonId(null);
      setReviewWeekStatusMenuPosition(null);
    }
    function closeStatusMenuOnViewportChange() {
      setReviewWeekStatusMenuPersonId(null);
      setReviewWeekStatusMenuPosition(null);
    }
    function closeStatusMenuOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      closeStatusMenuOnViewportChange();
      reviewWeekStatusMenuTriggerRef.current?.focus();
    }
    document.addEventListener("mousedown", closeStatusMenuOnOutsideClick);
    document.addEventListener("keydown", closeStatusMenuOnEscape);
    window.addEventListener("resize", closeStatusMenuOnViewportChange);
    window.addEventListener("scroll", closeStatusMenuOnViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", closeStatusMenuOnOutsideClick);
      document.removeEventListener("keydown", closeStatusMenuOnEscape);
      window.removeEventListener("resize", closeStatusMenuOnViewportChange);
      window.removeEventListener("scroll", closeStatusMenuOnViewportChange, true);
    };
  }, [reviewWeekStatusMenuPersonId]);

  useLayoutEffect(() => {
    if (!reviewWeekStatusMenuPosition || reviewWeekStatusMenuPosition.position || !reviewWeekStatusMenuRef.current) {
      return;
    }
    const menu = reviewWeekStatusMenuRef.current;
    const bounds = menu.getBoundingClientRect();
    const position = resolveViewportPopoverPosition({
      triggerTop: reviewWeekStatusMenuPosition.triggerTop,
      triggerBottom: reviewWeekStatusMenuPosition.triggerBottom,
      triggerLeft: reviewWeekStatusMenuPosition.triggerRight - Math.max(bounds.width, menu.scrollWidth),
      menuWidth: Math.max(bounds.width, menu.scrollWidth),
      menuHeight: menu.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setReviewWeekStatusMenuPosition((current) => (
      current && current.position === null ? { ...current, position } : current
    ));
  }, [reviewWeekStatusMenuPosition]);

  useEffect(() => {
    if (!reviewWeekStatusMenuPosition?.position) {
      return;
    }
    reviewWeekStatusMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [reviewWeekStatusMenuPosition?.position]);

  useEffect(() => {
    if (!isReviewWeekActionsMenuOpen) {
      return undefined;
    }
    function closeActionsMenuOnOutsideClick(event: PointerEvent) {
      if (
        event.target instanceof Node
        && (
          reviewWeekActionsMenuControlRef.current?.contains(event.target)
          || reviewWeekActionsMenuRef.current?.contains(event.target)
        )
      ) {
        return;
      }
      setIsReviewWeekActionsMenuOpen(false);
      setReviewWeekActionsMenuPosition(null);
    }
    function closeActionsMenuOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      setIsReviewWeekActionsMenuOpen(false);
      setReviewWeekActionsMenuPosition(null);
      reviewWeekActionsMenuTriggerRef.current?.focus();
    }
    function closeActionsMenuOnViewportChange() {
      setIsReviewWeekActionsMenuOpen(false);
      setReviewWeekActionsMenuPosition(null);
    }
    document.addEventListener("pointerdown", closeActionsMenuOnOutsideClick);
    document.addEventListener("keydown", closeActionsMenuOnEscape);
    window.addEventListener("resize", closeActionsMenuOnViewportChange);
    window.addEventListener("scroll", closeActionsMenuOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeActionsMenuOnOutsideClick);
      document.removeEventListener("keydown", closeActionsMenuOnEscape);
      window.removeEventListener("resize", closeActionsMenuOnViewportChange);
      window.removeEventListener("scroll", closeActionsMenuOnViewportChange, true);
    };
  }, [isReviewWeekActionsMenuOpen]);

  useLayoutEffect(() => {
    if (!reviewWeekActionsMenuPosition || reviewWeekActionsMenuPosition.position || !reviewWeekActionsMenuRef.current) {
      return;
    }
    const menu = reviewWeekActionsMenuRef.current;
    const bounds = menu.getBoundingClientRect();
    const position = resolveViewportPopoverPosition({
      triggerTop: reviewWeekActionsMenuPosition.triggerTop,
      triggerBottom: reviewWeekActionsMenuPosition.triggerBottom,
      triggerLeft: reviewWeekActionsMenuPosition.triggerRight - Math.max(bounds.width, menu.scrollWidth),
      menuWidth: Math.max(bounds.width, menu.scrollWidth),
      menuHeight: menu.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setReviewWeekActionsMenuPosition((current) => (
      current && current.position === null ? { ...current, position } : current
    ));
  }, [reviewWeekActionsMenuPosition]);

  useEffect(() => {
    if (!reviewWeekActionsMenuPosition?.position) {
      return;
    }
    reviewWeekActionsMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [reviewWeekActionsMenuPosition?.position]);

  useEffect(() => {
    setReviewWeekStatusMenuPersonId(null);
    setReviewWeekStatusMenuPosition(null);
    setIsReviewWeekActionsMenuOpen(false);
    setReviewWeekActionsMenuPosition(null);
  }, [selectedReviewPersonId, selectedReviewWeek.week, selectedReviewWeek.year]);

  useEffect(() => {
    void loadPeople();
  }, []);

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

  const currentReviewWeek = useMemo(() => currentIsoWeek(), []);
  const reviewWeekRange = useMemo(
    () => isoWeekRange(selectedReviewWeek.year, selectedReviewWeek.week),
    [selectedReviewWeek.week, selectedReviewWeek.year],
  );
  const reviewWeekRangeKey = reviewDataRangeKey(reviewWeekRange);
  const evaluationMonthRange = useMemo(
    () => calendarMonthRange(selectedEvaluationMonth),
    [selectedEvaluationMonth],
  );
  const evaluationRangeKey = reviewDataRangeKey(evaluationMonthRange);
  const isPayrollSiteCockpitReady = payrollSiteCockpit !== null
    && reviewDataRangeKey({ start: payrollSiteCockpit.date_from, end: payrollSiteCockpit.date_to }) === evaluationRangeKey;
  const reviewDataRange = activeTimeSubtab === "evaluation" ? evaluationMonthRange : reviewWeekRange;
  const reviewWeekOptions = useMemo(
    () => buildCalendarWeekOptions(currentReviewWeek),
    [currentReviewWeek],
  );
  const evaluationMonthOptions = useMemo(
    () => buildCalendarMonthWindowOptions(selectedEvaluationMonth),
    [selectedEvaluationMonth],
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
  const locationReviewActiveSiteOptions = useMemo(
    () => locationReviewSiteSearch.trim() ? locationReviewSiteSearchResults : locationReviewSiteOptions,
    [locationReviewSiteOptions, locationReviewSiteSearch, locationReviewSiteSearchResults],
  );
  const locationReviewActiveListboxId = locationReviewSiteSearch.trim()
    ? "time-review-location-search-results"
    : "time-review-location-all-options";
  const locationReviewActiveOptionId = locationReviewActiveSiteId
    ? `${locationReviewActiveListboxId}-option-${locationReviewActiveSiteId}`
    : undefined;
  const payrollManualSiteOptions = useMemo(
    () => siteOptions
      .filter((site) => site.status !== "deleted")
      .map((site) => ({
        value: String(site.id),
        label: manualTimeEntrySiteOptionLabel(site),
        searchText: locationReviewSiteSearchText(site),
      })),
    [siteOptions],
  );
  const payrollManualTimeCalculation = calculatePayrollTime(payrollCorrectionForm);
  const reviewedWorkerIds = useMemo(
    () => new Set(reviewWeeklyReviews.filter(isWeeklyReviewReviewed).map((review) => review.person_id)),
    [reviewWeeklyReviews],
  );
  const resetWorkerIds = useMemo(
    () => new Set(reviewWeeklyReviews.filter(isWeeklyReviewReset).map((review) => review.person_id)),
    [reviewWeeklyReviews],
  );
  const payrollWeekPersons = useMemo(
    () => payrollWeekPersonsById(reviewPayrollWeek?.persons ?? []),
    [reviewPayrollWeek],
  );
  const timeReviewWorkers = useMemo(() => {
    const perfStart = timeReviewPerfNow();
    const result = buildTimeReviewWorkerSummaries(
      people,
      reviewAllEntries,
      reviewEntries,
      reviewAbsences,
      reviewedWorkerIds,
      resetWorkerIds,
      payrollWeekPersons,
    );
    recordTimeReviewPerfCalculation(timeReviewPerfRef, "worker summaries", perfStart, {
      details: `${people.length} Personen · ${reviewAllEntries.length} Einträge · ${reviewAbsences.length} Abwesenheiten · ${result.length} Monteure`,
    });
    return result;
  }, [payrollWeekPersons, people, reviewAbsences, reviewAllEntries, reviewEntries, resetWorkerIds, reviewedWorkerIds]);
  const reviewWorkerFilterCounts = useMemo(
    () => countTimeReviewWorkersByFilter(timeReviewWorkers),
    [timeReviewWorkers],
  );
  const filteredTimeReviewWorkers = useMemo(
    () => filterTimeReviewWorkers(timeReviewWorkers, reviewWorkerSearch, reviewWorkerFilter),
    [reviewWorkerFilter, reviewWorkerSearch, timeReviewWorkers],
  );
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
      selectedReviewWorker ? payrollWeekPersons.get(selectedReviewWorker.personId) : null,
    );
    recordTimeReviewPerfCalculation(timeReviewPerfRef, "selected worker week rows", perfStart, {
      details: `${selectedReviewWorker?.entries.length ?? 0} Einträge · ${reviewAbsences.length} Abwesenheiten`,
    });
    return result;
  }, [payrollWeekPersons, reviewAbsences, reviewWeekRange.start, selectedReviewWorker]);
  const selectedReviewWeekDayOptions = useMemo(
    () => buildReviewWeekDayOptions(reviewWeekRange.start),
    [reviewWeekRange.start],
  );
  const areReviewWeekPayrollMonthStatusesReady = reviewWeekPayrollMonthStatusRangeKey === reviewWeekRangeKey
    && !isLoadingReviewWeekPayrollMonthStatuses
    && reviewWeekPayrollMonthStatusError === null;
  const writableReviewWeekDayOptions = useMemo(
    () => areReviewWeekPayrollMonthStatusesReady
      ? selectedReviewWeekDayOptions.filter((option) => {
          return payrollWorkDateLock(reviewWeekPayrollMonthStatuses, option.date, selectedReviewWorker?.personId ?? null) === null;
        })
      : [],
    [areReviewWeekPayrollMonthStatusesReady, reviewWeekPayrollMonthStatuses, selectedReviewWeekDayOptions, selectedReviewWorker?.personId],
  );
  const payrollManualDateOptions = useMemo(
    () => writableReviewWeekDayOptions.map((option) => ({
      value: option.date,
      label: formatPayrollManualEntryDate(option.date),
      searchText: `${option.date} ${option.label} ${formatPayrollManualEntryDate(option.date)}`,
    })),
    [writableReviewWeekDayOptions],
  );
  const payrollDatePickerEntry = useMemo(
    () => payrollDatePicker ? findEntryInReviewWeekDays(selectedReviewWeekDays, payrollDatePicker.entryId) : null,
    [payrollDatePicker, selectedReviewWeekDays],
  );
  const isEvaluationDataReady = activeTimeSubtab === "evaluation"
    && activeEvaluationSubtab === "workers"
    && reviewAllEntriesRangeKey === evaluationRangeKey
    && reviewAbsencesRangeKey === evaluationRangeKey;
  const evaluationEntries = isEvaluationDataReady ? reviewAllEntries : EMPTY_REVIEW_ENTRIES;
  const evaluationAbsences = isEvaluationDataReady ? reviewAbsences : EMPTY_REVIEW_ABSENCES;
  const evaluationReviewedWorkerIds = useMemo(
    () => reviewedWorkersWithAllEntriesReviewed(evaluationEntries),
    [evaluationEntries],
  );
  const evaluationWorkers = useMemo(
    () => buildTimeReviewWorkerSummaries(
      people,
      evaluationEntries,
      evaluationEntries.filter((entry) => entry.payroll_reviewed_at === null),
      evaluationAbsences,
      evaluationReviewedWorkerIds,
      new Set<number>(),
      new Map<number, TimeEntryPayrollWeekPerson>(),
    ),
    [evaluationAbsences, evaluationEntries, evaluationReviewedWorkerIds, people],
  );
  const evaluationWorkerFilterCounts = useMemo(
    () => countTimeReviewWorkersByFilter(evaluationWorkers),
    [evaluationWorkers],
  );
  const filteredEvaluationWorkers = useMemo(
    () => filterTimeReviewWorkers(evaluationWorkers, evaluationWorkerSearch, evaluationWorkerFilter),
    [evaluationWorkerFilter, evaluationWorkerSearch, evaluationWorkers],
  );
  const selectedEvaluationWorker = useMemo(
    () => evaluationWorkers.find((worker) => worker.personId === selectedEvaluationPersonId) ?? null,
    [evaluationWorkers, selectedEvaluationPersonId],
  );
  const selectedEvaluationMonthDays = useMemo(
    () => buildTimeReviewMonthDays(
      selectedEvaluationWorker?.entries ?? [],
      evaluationAbsences,
      selectedEvaluationWorker?.personId ?? null,
      evaluationMonthRange.start,
      evaluationMonthRange.end,
    ),
    [evaluationAbsences, evaluationMonthRange.end, evaluationMonthRange.start, selectedEvaluationWorker],
  );
  const evaluationMonthDayOptions = useMemo(
    () => buildReviewPeriodDayOptions(evaluationMonthRange.start, evaluationMonthRange.end),
    [evaluationMonthRange.end, evaluationMonthRange.start],
  );
  const isEvaluationWorkerReview = activeTimeSubtab === "evaluation" && activeEvaluationSubtab === "workers";
  const activeReviewWorker = isEvaluationWorkerReview ? selectedEvaluationWorker : selectedReviewWorker;
  const activeReviewDays = isEvaluationWorkerReview ? selectedEvaluationMonthDays : selectedReviewWeekDays;
  const activeReviewDayOptions = isEvaluationWorkerReview ? evaluationMonthDayOptions : selectedReviewWeekDayOptions;
  const activePayrollDatePickerEntry = useMemo(
    () => payrollDatePicker ? findEntryInReviewWeekDays(activeReviewDays, payrollDatePicker.entryId) : null,
    [activeReviewDays, payrollDatePicker],
  );
  const isPayrollMonthLocked = payrollMonthPeriod?.status === "LOCKED";
  const payrollMonthVersion = payrollSnapshotVersion(payrollMonthPeriod);
  const arePayrollMonthExportsAvailable = isPayrollMonthLocked
    && payrollMonthVersion !== null
    && payrollMonthPeriod.artifacts_ready;
  const selectedPayrollPersonApproval = useMemo(
    () => selectedEvaluationWorker && payrollMonthPeriod
      ? payrollMonthPeriod.person_approvals.find((item) => item.person_id === selectedEvaluationWorker.personId) ?? null
      : null,
    [payrollMonthPeriod, selectedEvaluationWorker],
  );
  const isSelectedPayrollPersonApproved = selectedPayrollPersonApproval?.status === "APPROVED";
  const selectedPayrollPersonBlockers = isSelectedPayrollPersonApproved
    ? []
    : selectedPayrollPersonApproval?.blockers ?? [];
  const canApproveSelectedPayrollPerson = Boolean(
    selectedEvaluationWorker
    && selectedPayrollPersonApproval?.can_approve
    && !isUpdatingPayrollPersonMonth,
  );
  const canReopenSelectedPayrollPerson = Boolean(
    selectedEvaluationWorker
    && selectedPayrollPersonApproval?.can_reopen
    && !isUpdatingPayrollPersonMonth,
  );
  const payrollPersonApprovalDisabledReason = !selectedEvaluationWorker
    ? "Bitte zuerst einen Monteur auswählen."
    : isLoadingPayrollMonthPeriod
      ? "Der Monatsstatus wird noch geladen."
      : isUpdatingPayrollPersonMonth
        ? "Der Monteurmonat wird gerade verarbeitet."
        : !canManagePayrollClose
          ? "Für den Monatsabschluss fehlt die allgemeine Lohnprüfungsberechtigung."
          : !payrollMonthPeriod || !selectedPayrollPersonApproval
            ? "Der Status dieses Monteurmonats ist derzeit nicht verfügbar."
            : isPayrollMonthLocked
              ? "Der Gesamtmonat ist bereits abgeschlossen. Öffne ihn zuerst wieder."
              : isSelectedPayrollPersonApproved && !selectedPayrollPersonApproval.can_reopen
                ? "Dieser Monteurmonat kann im aktuellen Stand nicht wieder geöffnet werden."
                : !isSelectedPayrollPersonApproved && !selectedPayrollPersonApproval.can_approve
                  ? "Dieser Monteurmonat kann im aktuellen Stand nicht abgeschlossen werden."
                  : null;
  const payrollPersonApprovalSummary = payrollMonthPeriod?.person_approval_summary ?? null;
  useEffect(() => {
    let ignore = false;
    setIsLoadingSites(true);
    setSitesError(null);
    api.siteSummaries()
      .then((siteData) => {
        if (!ignore) {
          setSites(siteData);
          setSitesError(null);
        }
      })
      .catch(() => {
        if (!ignore) {
          setSites([]);
          setSitesError("Baustellen konnten nicht geladen werden.");
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoadingSites(false);
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
    if (!isEvaluationDataReady) {
      return;
    }
    if (selectedEvaluationPersonId !== null && !evaluationWorkers.some((worker) => worker.personId === selectedEvaluationPersonId)) {
      setSelectedEvaluationPersonId(null);
    }
  }, [evaluationWorkers, isEvaluationDataReady, selectedEvaluationPersonId]);

  useEffect(() => {
    setExpandedEvaluationDayKeys(new Set());
  }, [selectedEvaluationMonth.month, selectedEvaluationMonth.year, selectedEvaluationPersonId]);

  useEffect(() => {
    setPayrollMonthDialog(null);
    setPayrollPersonMonthDialog(null);
    setPayrollMonthReopenReason("");
    setPayrollPersonMonthReopenReason("");
    setPayrollMonthDownloadError(null);
  }, [selectedEvaluationMonth.month, selectedEvaluationMonth.year]);

  useEffect(() => {
    setPayrollPersonMonthDialog(null);
    setPayrollPersonMonthReopenReason("");
    setIsPayrollPersonLogExpanded(false);
    setPayrollMonthPeriodError(null);
  }, [selectedEvaluationMonth.month, selectedEvaluationMonth.year, selectedEvaluationPersonId]);

  useEffect(() => {
    setTimeReviewDiagnosticEntry(null);
    setTimeReviewDialogMode(null);
    setTimeReviewPopupTop(null);
    setLocationReviewDiagnosticEntry(null);
    setLocationReviewPopupTop(null);
    setPayrollDateError(null);
    setPayrollDateActionEntryId(null);
    setPayrollOvernightSavingKey(null);
    setPayrollDeleteDialog(null);
    setPayrollDeleteError(null);
    setIsDeletingPayrollEntry(false);
  }, [selectedReviewPersonId, selectedReviewWeek.week, selectedReviewWeek.year]);

  useEffect(() => {
    if (!timeReviewDiagnosticEntry) {
      setPayrollCorrectionForm({ start_time: "", end_time: "", break_minutes: "", hours: "" });
      setPayrollManualWorkDate("");
      setPayrollManualSiteId("");
      setPayrollManualSiteError(null);
      setPayrollCorrectionError(null);
      setIsSavingPayrollCorrection(false);
      return;
    }
    setPayrollManualWorkDate(timeReviewDiagnosticEntry.work_date);
    setPayrollManualSiteId(timeReviewDialogMode === "create" ? "" : String(timeReviewDiagnosticEntry.site_id ?? ""));
    setPayrollManualSiteError(null);
    if (timeReviewDialogMode === "create") {
      setPayrollCorrectionForm({ start_time: "", end_time: "", break_minutes: "0", hours: "" });
      setPayrollCorrectionError(null);
      return;
    }
    const initialForm: PayrollCorrectionFormState = {
      start_time: timeInputValue(effectivePayrollStartTime(timeReviewDiagnosticEntry)),
      end_time: timeInputValue(effectivePayrollEndTime(timeReviewDiagnosticEntry)),
      break_minutes: String(
        timeReviewDiagnosticEntry.payroll_corrected_break_minutes ?? timeReviewDiagnosticEntry.break_minutes ?? 0,
      ),
      hours: timeReviewDiagnosticEntry.payroll_corrected_work_minutes !== null
        ? formatDecimalHours(timeReviewDiagnosticEntry.payroll_corrected_work_minutes)
        : "",
    };
    const initialCalculation = calculatePayrollTime(initialForm);
    setPayrollCorrectionForm(
      initialCalculation.status === "valid"
        ? { ...initialForm, hours: initialCalculation.formattedHours }
        : initialForm,
    );
    setPayrollCorrectionError(null);
  }, [timeReviewDiagnosticEntry, timeReviewDialogMode]);

  useEffect(() => {
    if (!locationReviewDiagnosticEntry) {
      setLocationReviewSiteId("");
      setHasLocationReviewSitePreview(false);
      setLocationReviewSiteSearch("");
      setIsLocationReviewPickerOpen(false);
      setLocationReviewActiveSiteId("");
      setLocationReviewError(null);
      setIsSavingLocationReview(false);
      return;
    }
    setLocationReviewSiteId(locationReviewDiagnosticEntry.site_id ? String(locationReviewDiagnosticEntry.site_id) : "");
    setHasLocationReviewSitePreview(false);
    setLocationReviewSiteSearch("");
    setIsLocationReviewPickerOpen(false);
    setLocationReviewActiveSiteId("");
    setLocationReviewError(null);
  }, [locationReviewDiagnosticEntry]);

  useEffect(() => {
    if (!isLocationReviewPickerOpen) {
      return;
    }
    setLocationReviewActiveSiteId((currentSiteId) => {
      if (locationReviewActiveSiteOptions.some((site) => String(site.id) === currentSiteId)) {
        return currentSiteId;
      }
      if (locationReviewActiveSiteOptions.some((site) => String(site.id) === locationReviewSiteId)) {
        return locationReviewSiteId;
      }
      return locationReviewActiveSiteOptions[0] ? String(locationReviewActiveSiteOptions[0].id) : "";
    });
  }, [isLocationReviewPickerOpen, locationReviewActiveSiteOptions, locationReviewSiteId]);

  useEffect(() => {
    if (!isLocationReviewPickerOpen || !locationReviewActiveOptionId) {
      return;
    }
    document.getElementById(locationReviewActiveOptionId)?.scrollIntoView({ block: "nearest" });
  }, [isLocationReviewPickerOpen, locationReviewActiveOptionId]);

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

  useLayoutEffect(() => {
    if (!payrollDatePicker || payrollDatePicker.position || !payrollDatePickerMenuRef.current) {
      return;
    }
    const menu = payrollDatePickerMenuRef.current;
    const bounds = menu.getBoundingClientRect();
    const position = resolveViewportPopoverPosition({
      triggerTop: payrollDatePicker.triggerTop,
      triggerBottom: payrollDatePicker.triggerBottom,
      triggerLeft: payrollDatePicker.triggerLeft,
      menuWidth: Math.max(bounds.width, menu.scrollWidth),
      menuHeight: menu.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setPayrollDatePicker((current) => (
      current?.entryId === payrollDatePicker.entryId && current.position === null
        ? { ...current, position }
        : current
    ));
  }, [payrollDatePicker]);

  useEffect(() => {
    if (!payrollDeleteDialog) {
      return;
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape" && !isDeletingPayrollEntry) {
        setPayrollDeleteDialog(null);
        setPayrollDeleteError(null);
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isDeletingPayrollEntry, payrollDeleteDialog]);

  useEffect(() => {
    if (!timeReviewDiagnosticEntry && !locationReviewDiagnosticEntry) {
      return;
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setTimeReviewDiagnosticEntry(null);
        setTimeReviewDialogMode(null);
        setTimeReviewPopupTop(null);
        setLocationReviewDiagnosticEntry(null);
        setLocationReviewPopupTop(null);
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [locationReviewDiagnosticEntry, timeReviewDiagnosticEntry]);

  useEffect(() => {
    if (activeTimeSubtab !== "review") {
      return;
    }

    let ignore = false;
    const perfStart = timeReviewPerfNow();
    let perfRows: number | undefined;
    let perfOk = false;
    setIsLoadingReviewEntries(true);
    setIsLoadingReviewAllEntries(true);
    setReviewEntriesError(null);
    setReviewAllEntriesError(null);

    api.timeEntryReviewWeek({
      dateFrom: reviewDataRange.start,
      dateTo: reviewDataRange.end,
    })
      .then((reviewWeek) => {
        perfRows = reviewWeek.entries.length;
        perfOk = true;
        if (!ignore) {
          setReviewEntries(reviewWeek.open_entries);
          setReviewAllEntries(reviewWeek.entries);
          setReviewAllEntriesRangeKey(reviewDataRangeKey(reviewDataRange));
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setReviewEntries([]);
          setReviewAllEntries([]);
          setReviewAllEntriesRangeKey(reviewDataRangeKey(reviewDataRange));
          setReviewEntriesError(readApiError(requestError, "Stundenpruefung konnte nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoadingReviewEntries(false);
          setIsLoadingReviewAllEntries(false);
          recordTimeReviewPerfApiCall(timeReviewPerfRef, timeReviewRenderCountRef, TIME_REVIEW_API_REVIEW_WEEK, perfStart, {
            details: `${reviewDataRange.start} bis ${reviewDataRange.end}`,
            ok: perfOk,
            rows: perfRows,
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, reviewDataRange]);

  useLayoutEffect(() => {
    if (activeTimeSubtab !== "review") {
      hasAutoScrolledVisibleReviewWeekRef.current = false;
      lastAlignedReviewWeekKeyRef.current = null;
      return;
    }
    const selectionKey = reviewWeekKey(selectedReviewWeek);
    const isInitialAlignment = !hasAutoScrolledVisibleReviewWeekRef.current;
    if (!isInitialAlignment && lastAlignedReviewWeekKeyRef.current === selectionKey) {
      return;
    }
    let layoutFrameId: number | null = null;
    const renderFrameId = window.requestAnimationFrame(() => {
      layoutFrameId = window.requestAnimationFrame(() => {
        const didAlign = scrollWeekStripToSelection(
          reviewWeekStripRef.current,
          reviewWeekOptions,
          selectedReviewWeek,
          {
            alignment: isInitialAlignment ? "center" : "nearest",
            visibleCount: PAYROLL_WEEK_VISIBLE_COUNT,
          },
        );
        if (didAlign) {
          updateReviewWeekScrollState();
          hasAutoScrolledVisibleReviewWeekRef.current = true;
          lastAlignedReviewWeekKeyRef.current = selectionKey;
        }
      });
    });

    return () => {
      window.cancelAnimationFrame(renderFrameId);
      if (layoutFrameId !== null) {
        window.cancelAnimationFrame(layoutFrameId);
      }
    };
  }, [activeTimeSubtab, reviewWeekOptions, selectedReviewWeek]);

  useLayoutEffect(() => {
    if (activeTimeSubtab !== "review") {
      return;
    }

    let renderFrameId: number | null = null;
    let layoutFrameId: number | null = null;
    function realignReviewWeekStripAfterPageShow(): void {
      renderFrameId = window.requestAnimationFrame(() => {
        layoutFrameId = window.requestAnimationFrame(() => {
          if (scrollWeekStripToSelection(
            reviewWeekStripRef.current,
            reviewWeekOptions,
            selectedReviewWeek,
            { alignment: "center", visibleCount: PAYROLL_WEEK_VISIBLE_COUNT },
          )) {
            updateReviewWeekScrollState();
            hasAutoScrolledVisibleReviewWeekRef.current = true;
            lastAlignedReviewWeekKeyRef.current = reviewWeekKey(selectedReviewWeek);
          }
        });
      });
    }

    window.addEventListener("pageshow", realignReviewWeekStripAfterPageShow);
    return () => {
      window.removeEventListener("pageshow", realignReviewWeekStripAfterPageShow);
      if (renderFrameId !== null) {
        window.cancelAnimationFrame(renderFrameId);
      }
      if (layoutFrameId !== null) {
        window.cancelAnimationFrame(layoutFrameId);
      }
    };
  }, [activeTimeSubtab, reviewWeekOptions, selectedReviewWeek]);

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

  useLayoutEffect(() => {
    if (activeTimeSubtab !== "evaluation") {
      return;
    }
    const container = evaluationMonthStripRef.current;
    alignEvaluationMonthsToSelection(container, selectedEvaluationMonth);
    updateEvaluationMonthScrollState();
  }, [activeTimeSubtab, selectedEvaluationMonth.month, selectedEvaluationMonth.year]);

  useEffect(() => {
    if (activeTimeSubtab !== "evaluation") {
      return;
    }
    const container = evaluationMonthStripRef.current;
    if (!container) {
      return;
    }
    updateEvaluationMonthScrollState();
    const alignVisibleMonths = () => {
      alignEvaluationMonthsToSelection(container, selectedEvaluationMonth, "auto");
      updateEvaluationMonthScrollState();
    };
    container.addEventListener("scroll", updateEvaluationMonthScrollState, { passive: true });
    window.addEventListener("resize", alignVisibleMonths);
    return () => {
      container.removeEventListener("scroll", updateEvaluationMonthScrollState);
      window.removeEventListener("resize", alignVisibleMonths);
    };
  }, [activeTimeSubtab, selectedEvaluationMonth.month, selectedEvaluationMonth.year]);

  useEffect(() => {
    const needsDetailedEntries = activeTimeSubtab === "review"
      || (activeTimeSubtab === "evaluation" && activeEvaluationSubtab === "workers");
    if (!needsDetailedEntries) {
      setReviewAbsences([]);
      setReviewAbsencesRangeKey(null);
      return;
    }

    let ignore = false;
    const perfStart = timeReviewPerfNow();
    let perfRows: number | undefined;
    let perfOk = false;
    api.absences({ start: reviewDataRange.start, end: reviewDataRange.end })
      .then((absenceData) => {
        perfRows = absenceData.length;
        perfOk = true;
        if (!ignore) {
          setReviewAbsences(absenceData);
          setReviewAbsencesRangeKey(reviewDataRangeKey(reviewDataRange));
        }
      })
      .catch(() => {
        if (!ignore) {
          setReviewAbsences([]);
          setReviewAbsencesRangeKey(reviewDataRangeKey(reviewDataRange));
        }
      })
      .finally(() => {
        if (!ignore) {
          recordTimeReviewPerfApiCall(timeReviewPerfRef, timeReviewRenderCountRef, TIME_REVIEW_API_ABSENCES, perfStart, {
            details: `${reviewDataRange.start} bis ${reviewDataRange.end}`,
            ok: perfOk,
            rows: perfRows,
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeEvaluationSubtab, activeTimeSubtab, reviewDataRange]);

  useEffect(() => {
    if (activeTimeSubtab !== "review") {
      setReviewPayrollWeek(null);
      setReviewPayrollWeekError(null);
      return;
    }

    let ignore = false;
    const perfStart = timeReviewPerfNow();
    let perfRows: number | undefined;
    let perfOk = false;
    setReviewPayrollWeek(null);
    setReviewPayrollWeekError(null);
    api.timeEntryPayrollWeek({
      isoYear: selectedReviewWeek.year,
      isoWeek: selectedReviewWeek.week,
    })
      .then((payrollWeek) => {
        perfRows = payrollWeek.persons.length;
        perfOk = true;
        if (!ignore) {
          setReviewPayrollWeek(payrollWeek);
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setReviewPayrollWeek(null);
          setReviewPayrollWeekError(readApiError(
            requestError,
            "Urlaubsstunden konnten nicht geladen werden.",
          ));
        }
      })
      .finally(() => {
        if (!ignore) {
          recordTimeReviewPerfApiCall(
            timeReviewPerfRef,
            timeReviewRenderCountRef,
            TIME_REVIEW_API_PAYROLL_WEEK,
            perfStart,
            {
              details: `KW ${selectedReviewWeek.week}/${selectedReviewWeek.year}`,
              ok: perfOk,
              rows: perfRows,
            },
          );
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, selectedReviewWeek.week, selectedReviewWeek.year]);

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
    if (activeTimeSubtab !== "evaluation" || activeEvaluationSubtab !== "workers") {
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
          setReviewAllEntriesRangeKey(reviewDataRangeKey(reviewDataRange));
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setReviewAllEntries([]);
          setReviewAllEntriesRangeKey(reviewDataRangeKey(reviewDataRange));
          setReviewAllEntriesError(readApiError(requestError, "Auswertung konnte nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoadingReviewAllEntries(false);
          recordTimeReviewPerfApiCall(timeReviewPerfRef, timeReviewRenderCountRef, TIME_REVIEW_API_REVIEW_WEEK, perfStart, {
            details: `${reviewDataRange.start} bis ${reviewDataRange.end}`,
            ok: perfOk,
            rows: perfRows,
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeEvaluationSubtab, activeTimeSubtab, reviewDataRange]);

  useEffect(() => {
    if (activeTimeSubtab !== "review") {
      return;
    }

    let ignore = false;
    const monthSelections = payrollMonthSelectionsForDateRange(reviewWeekRange.start, reviewWeekRange.end);
    const perfStart = timeReviewPerfNow();
    let perfOk = false;
    setIsLoadingReviewWeekPayrollMonthStatuses(true);
    setReviewWeekPayrollMonthStatuses({});
    setReviewWeekPayrollMonthStatusRangeKey(null);
    setReviewWeekPayrollMonthStatusError(null);
    Promise.all(monthSelections.map((selection) => api.payrollMonthLockStatus(selection)))
      .then((periods) => {
        perfOk = true;
        if (!ignore) {
          setReviewWeekPayrollMonthStatuses(Object.fromEntries(
            periods.map((period) => [payrollMonthKey(period), period]),
          ));
          setReviewWeekPayrollMonthStatusRangeKey(reviewWeekRangeKey);
        }
      })
      .catch(() => {
        if (!ignore) {
          setReviewWeekPayrollMonthStatusError(
            "Monatssperren konnten nicht geladen werden. Die Tagesbearbeitung bleibt vorsorglich gesperrt.",
          );
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoadingReviewWeekPayrollMonthStatuses(false);
          recordTimeReviewPerfApiCall(timeReviewPerfRef, timeReviewRenderCountRef, TIME_REVIEW_API_MONTH_LOCKS, perfStart, {
            details: `${monthSelections.length} Monate · ${reviewWeekRange.start} bis ${reviewWeekRange.end}`,
            ok: perfOk,
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, reviewWeekRange.end, reviewWeekRange.start, reviewWeekRangeKey]);

  useEffect(() => {
    if (activeTimeSubtab !== "evaluation") {
      return;
    }

    let ignore = false;
    setIsLoadingPayrollMonthPeriod(true);
    setPayrollMonthPeriod(null);
    setPayrollMonthPeriodError(null);
    api.payrollMonthPeriod(selectedEvaluationMonth)
      .then((period) => {
        if (!ignore) {
          setPayrollMonthPeriod(period);
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setPayrollMonthPeriodError(readApiError(requestError, "Monatsstatus konnte nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoadingPayrollMonthPeriod(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, payrollMonthPeriodRefreshKey, selectedEvaluationMonth]);

  useEffect(() => {
    if (activeTimeSubtab !== "evaluation" || activeEvaluationSubtab !== "sites") {
      return;
    }

    const controller = new AbortController();
    setIsLoadingPayrollSiteCockpit(true);
    setPayrollSiteCockpitError(null);
    setPayrollSiteCockpit(null);
    api.payrollSiteCockpit({
      dateFrom: evaluationMonthRange.start,
      dateTo: evaluationMonthRange.end,
      signal: controller.signal,
    })
      .then((cockpit) => {
        if (controller.signal.aborted) {
          return;
        }
        setPayrollSiteCockpit(cockpit);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setPayrollSiteCockpitError(readApiError(requestError, "Baustellen-Cockpit konnte nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoadingPayrollSiteCockpit(false);
        }
      });

    return () => controller.abort();
  }, [
    activeEvaluationSubtab,
    activeTimeSubtab,
    evaluationMonthRange.end,
    evaluationMonthRange.start,
    payrollSiteCockpitRefreshKey,
  ]);

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

  function selectEvaluationMonth(option: CalendarMonthSelection): void {
    if (option.year === selectedEvaluationMonth.year && option.month === selectedEvaluationMonth.month) {
      return;
    }
    const scrollPosition = { left: window.scrollX, top: window.scrollY };
    setSelectedEvaluationMonth({ year: option.year, month: option.month });
    window.requestAnimationFrame(() => {
      window.scrollTo({ ...scrollPosition, behavior: "auto" });
    });
  }

  function selectEvaluationYear(year: number): void {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return;
    }
    selectEvaluationMonth({ year, month: selectedEvaluationMonth.month });
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

  function scrollReviewWeeks(direction: -1 | 1): void {
    const container = reviewWeekStripRef.current;
    if (!container) {
      return;
    }
    scrollWeekStripByWholeWeek(container, direction);
  }

  function updateEvaluationMonthScrollState(): void {
    const container = evaluationMonthStripRef.current;
    if (!container) {
      setEvaluationMonthScrollState({ canScrollLeft: false, canScrollRight: false });
      return;
    }
    const maxScrollLeft = container.scrollWidth - container.clientWidth;
    setEvaluationMonthScrollState({
      canScrollLeft: container.scrollLeft > 1,
      canScrollRight: container.scrollLeft < maxScrollLeft - 1,
    });
  }

  function scrollEvaluationMonths(direction: -1 | 1): void {
    const container = evaluationMonthStripRef.current;
    if (!container) {
      return;
    }
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const visibleCount = evaluationMonthVisibleButtonCount(container, buttons);
    const startIndex = evaluationMonthStartIndex(container, buttons);
    const targetIndex = Math.max(0, Math.min(buttons.length - visibleCount, startIndex + direction * visibleCount));
    container.scrollTo({ left: buttons[targetIndex]?.offsetLeft ?? 0, behavior: "smooth" });
  }

  function toggleEvaluationDay(date: string): void {
    setExpandedEvaluationDayKeys((current) => {
      const next = new Set(current);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }
      return next;
    });
  }

  function reviewWeekWorkDateLockLabel(workDate: string): string | null {
    if (activeTimeSubtab !== "review" || reviewWeekPayrollMonthStatusRangeKey !== reviewWeekRangeKey) {
      return null;
    }
    const lock = payrollWorkDateLock(reviewWeekPayrollMonthStatuses, workDate, selectedReviewWorker?.personId ?? null);
    return lock === "month" ? "Monat abgeschlossen" : lock === "person" ? "Monteurmonat abgeschlossen" : null;
  }

  function isReviewWeekWorkDateReadOnly(workDate: string, personId: number | null = selectedReviewWorker?.personId ?? null): boolean {
    if (activeTimeSubtab !== "review") {
      return false;
    }
    if (!areReviewWeekPayrollMonthStatusesReady) {
      return true;
    }
    return payrollWorkDateLock(reviewWeekPayrollMonthStatuses, workDate, personId) !== null;
  }

  async function togglePayrollRowReview(entry: TimeEntry): Promise<void> {
    if (
      !canManageTimeEntries
      || isReviewWeekWorkDateReadOnly(entry.work_date, entry.person_id)
      || payrollReviewActionEntryId !== null
      || entry.id < 0
    ) {
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
    if (isReviewWeekWorkDateReadOnly(entry.work_date, entry.person_id)) {
      return;
    }
    setTimeReviewPopupTop(payrollPanelTop());
    // Missing-day and GPS suggestion rows use negative client-only IDs and must first create a real entry.
    setTimeReviewDialogMode(entry.id < 0 ? "create" : "edit");
    setTimeReviewDiagnosticEntry(entry);
  }

  function openManualTimeEntryDialog(): void {
    if (!canManageTimeEntries || !activeReviewWorker || (!isEvaluationWorkerReview && activeReviewWorker.isReviewed)) {
      return;
    }
    const writableDays = isEvaluationWorkerReview
      ? activeReviewDays
      : activeReviewDays.filter((day) => !isReviewWeekWorkDateReadOnly(day.date));
    const initialDay = writableDays.find((day) => day.entries.length === 0 && day.absenceType === null)
      ?? writableDays[0];
    if (!initialDay) {
      return;
    }
    const workDate = initialDay?.date ?? (isEvaluationWorkerReview ? evaluationMonthRange.start : reviewWeekRange.start);
    setTimeReviewPopupTop(payrollPanelTop());
    setTimeReviewDialogMode("create");
    setTimeReviewDiagnosticEntry(buildMissingTimeReviewEntry(activeReviewWorker, workDate));
  }

  function closeTimeReviewDiagnostic(): void {
    setTimeReviewDiagnosticEntry(null);
    setTimeReviewDialogMode(null);
    setTimeReviewPopupTop(null);
  }

  function openLocationReviewDiagnostic(entry: TimeEntry): void {
    if (isReviewWeekWorkDateReadOnly(entry.work_date, entry.person_id)) {
      return;
    }
    setLocationReviewPopupTop(payrollPanelTop());
    setLocationReviewDiagnosticEntry(entry);
  }

  function closeLocationReviewDiagnostic(): void {
    setHasLocationReviewSitePreview(false);
    setLocationReviewDiagnosticEntry(null);
    setLocationReviewPopupTop(null);
  }

  function closeLocationReviewPicker(): void {
    setIsLocationReviewPickerOpen(false);
    setLocationReviewActiveSiteId("");
    window.requestAnimationFrame(() => locationReviewPickerTriggerRef.current?.focus());
  }

  function toggleLocationReviewPicker(): void {
    if (isLocationReviewPickerOpen) {
      closeLocationReviewPicker();
      return;
    }
    setIsLocationReviewPickerOpen(true);
  }

  function selectLocationReviewSite(siteId: string, clearSearch = false): void {
    if (!canManageTimeEntries || isSavingLocationReview) {
      return;
    }
    setLocationReviewSiteId(siteId);
    setHasLocationReviewSitePreview(true);
    setLocationReviewActiveSiteId(siteId);
    if (clearSearch) {
      setLocationReviewSiteSearch("");
    }
  }

  function moveLocationReviewActiveSite(direction: 1 | -1): void {
    if (!locationReviewActiveSiteOptions.length) {
      return;
    }
    setLocationReviewActiveSiteId((currentSiteId) => {
      const currentIndex = locationReviewActiveSiteOptions.findIndex((site) => String(site.id) === currentSiteId);
      const nextIndex = currentIndex < 0
        ? (direction === 1 ? 0 : locationReviewActiveSiteOptions.length - 1)
        : Math.max(0, Math.min(locationReviewActiveSiteOptions.length - 1, currentIndex + direction));
      return String(locationReviewActiveSiteOptions[nextIndex].id);
    });
  }

  function selectActiveLocationReviewSite(): void {
    const activeSite = locationReviewActiveSiteOptions.find((site) => String(site.id) === locationReviewActiveSiteId);
    if (!activeSite) {
      return;
    }
    selectLocationReviewSite(String(activeSite.id), Boolean(locationReviewSiteSearch.trim()));
    closeLocationReviewPicker();
  }

  function handleLocationReviewPickerKeyDown(event: ReactKeyboardEvent<HTMLInputElement | HTMLDivElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveLocationReviewActiveSite(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      selectActiveLocationReviewSite();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeLocationReviewPicker();
    }
  }

  async function createTimeEntryForMissingDay(missingEntry: TimeEntry, siteId: number): Promise<TimeEntry> {
    if (missingEntry.person_id <= 0) {
      throw new Error("Monteur fehlt für die Büroprüfung.");
    }
    const createdEntry = await api.createTimeEntry({
      person_id: missingEntry.person_id,
      site_id: siteId,
      work_date: missingEntry.work_date,
      work_minutes: 0,
      break_minutes: 0,
      travel_minutes: 0,
      note: OFFICE_ONLY_TIME_ENTRY_NOTE,
    });
    return applyCreatedTimeEntryFromMissingDay(missingEntry, createdEntry);
  }

  function togglePayrollDatePicker(entry: TimeEntry, button: HTMLButtonElement): void {
    if (
      !canManageTimeEntries
      || isReviewWeekWorkDateReadOnly(entry.work_date, entry.person_id)
      || payrollDateActionEntryId !== null
      || entry.id < 0
    ) {
      return;
    }
    setPayrollDatePicker((current) => {
      if (current?.entryId === entry.id) {
        return null;
      }
      const rect = button.getBoundingClientRect();
      return {
        entryId: entry.id,
        triggerTop: rect.top,
        triggerBottom: rect.bottom,
        triggerLeft: rect.left,
        position: null,
      };
    });
  }

  function closePayrollDatePicker(): void {
    setPayrollDatePicker(null);
  }

  function openPayrollDeleteDialog(entry: TimeEntry): void {
    if (
      !canManageTimeEntries
      || isReviewWeekWorkDateReadOnly(entry.work_date, entry.person_id)
      || payrollDateActionEntryId !== null
      || entry.id < 0
    ) {
      return;
    }
    closePayrollDatePicker();
    setPayrollDeleteDialog({
      entry,
      weeklyReviewed: !isEvaluationWorkerReview && selectedReviewWorker?.isReviewed === true,
    });
    setPayrollDeleteError(null);
  }

  function closePayrollDeleteDialog(): void {
    if (isDeletingPayrollEntry) {
      return;
    }
    setPayrollDeleteDialog(null);
    setPayrollDeleteError(null);
  }

  async function confirmPayrollEntryDeletion(): Promise<void> {
    if (
      !canManageTimeEntries
      || !payrollDeleteDialog
      || isReviewWeekWorkDateReadOnly(payrollDeleteDialog.entry.work_date, payrollDeleteDialog.entry.person_id)
      || isDeletingPayrollEntry
    ) {
      return;
    }
    setIsDeletingPayrollEntry(true);
    setPayrollDeleteError(null);
    try {
      const result = await api.deleteTimeEntryFromPayrollReview(payrollDeleteDialog.entry.id);
      setReviewEntries((current) => current.filter((entry) => entry.id !== result.entry_id));
      setReviewAllEntries((current) => current.filter((entry) => entry.id !== result.entry_id));
      if (result.weekly_review_reset) {
        setReviewWeeklyReviews((current) => resetMatchingWeeklyReview(current, result));
        setReviewWeekCompletionReviews((current) => resetMatchingWeeklyReview(current, result));
      }
      if (!isEvaluationWorkerReview) {
        await refreshSelectedReviewPayrollWeekSummary();
      }
      setPayrollDeleteDialog(null);
    } catch (requestError) {
      setPayrollDeleteError(readApiError(requestError, "Zeiteintrag konnte nicht gelöscht werden."));
    } finally {
      setIsDeletingPayrollEntry(false);
    }
  }

  async function movePayrollEntryDate(entry: TimeEntry, targetWorkDate: string): Promise<void> {
    if (
      !canManageTimeEntries
      || isReviewWeekWorkDateReadOnly(entry.work_date, entry.person_id)
      || isReviewWeekWorkDateReadOnly(targetWorkDate, entry.person_id)
      || payrollDateActionEntryId !== null
      || entry.id < 0
    ) {
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

  async function updatePayrollOvernightStatus(
    personId: number,
    workDate: string,
    overnightStatus: OvernightStatus,
  ): Promise<void> {
    const dayKey = `${personId}:${workDate}`;
    if (
      !canManageTimeEntries
      || activeReviewWorker?.personId !== personId
      || (!isEvaluationWorkerReview && activeReviewWorker.isReviewed)
      || isReviewWeekWorkDateReadOnly(workDate, personId)
      || payrollOvernightSavingKey !== null
    ) {
      return;
    }
    setPayrollOvernightSavingKey(dayKey);
    setReviewActionError(null);
    try {
      const savedDay = await api.setTimeEntryDayOvernightStatus({
        personId,
        workDate,
        overnightStatus,
      });
      setReviewEntries((current) => applyOvernightStatusToWorkDate(current, savedDay));
      setReviewAllEntries((current) => applyOvernightStatusToWorkDate(current, savedDay));
    } catch (requestError) {
      setReviewActionError(readApiError(requestError, "Übernachtungsstatus konnte nicht gespeichert werden."));
      const [dayStatusResult, weeklyReviewsResult] = await Promise.allSettled([
        api.timeEntryDayStatus({ personId, workDate }),
        ...(isEvaluationWorkerReview ? [] : [api.timeEntryWeeklyReviews({
          isoYear: selectedReviewWeek.year,
          isoWeek: selectedReviewWeek.week,
        })]),
      ]);
      if (dayStatusResult.status === "fulfilled") {
        setReviewEntries((current) => applyOvernightStatusToWorkDate(current, dayStatusResult.value));
        setReviewAllEntries((current) => applyOvernightStatusToWorkDate(current, dayStatusResult.value));
      }
      if (weeklyReviewsResult?.status === "fulfilled") {
        setReviewWeeklyReviews(weeklyReviewsResult.value);
      }
    } finally {
      setPayrollOvernightSavingKey(null);
    }
  }

  async function savePayrollTimeCorrection(): Promise<void> {
    if (
      !canManageTimeEntries
      || !timeReviewDiagnosticEntry
      || isReviewWeekWorkDateReadOnly(timeReviewDiagnosticEntry.work_date, timeReviewDiagnosticEntry.person_id)
      || isSavingPayrollCorrection
    ) {
      return;
    }
    if (timeReviewDialogMode === "create" || timeReviewDiagnosticEntry.id < 0) {
      await createPayrollManualTimeEntry(timeReviewDiagnosticEntry);
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
      const updatedEntry = await api.setTimeEntryPayrollCorrection(timeReviewDiagnosticEntry.id, payload.payload);
      applyUpdatedTimeEntry(updatedEntry);
      if (!isEvaluationWorkerReview) {
        void refreshSelectedReviewPayrollWeekSummary();
      }
      setTimeReviewDiagnosticEntry((currentEntry) => (
        currentEntry?.id === timeReviewDiagnosticEntry.id || currentEntry?.id === updatedEntry.id
          ? mergeTimeEntryReviewUpdate(timeReviewDiagnosticEntry, updatedEntry)
          : currentEntry
      ));
    } catch (requestError) {
      setPayrollCorrectionError(readApiError(requestError, "Bürozeit konnte nicht gespeichert werden."));
    } finally {
      setIsSavingPayrollCorrection(false);
    }
  }

  function submitPayrollManualTimeEntry(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void savePayrollTimeCorrection();
  }

  async function createPayrollManualTimeEntry(missingEntry: TimeEntry): Promise<void> {
    const result = buildPayrollManualEntryPayload({
      personId: missingEntry.person_id,
      draft: {
        ...payrollCorrectionForm,
        site_id: payrollManualSiteId,
        travel_minutes: "0",
        work_date: payrollManualWorkDate,
      },
      allowedWorkDates: (isEvaluationWorkerReview ? activeReviewDayOptions : writableReviewWeekDayOptions)
        .map((option) => option.date),
      allowedSiteIds: payrollManualSiteOptions.map((option) => Number(option.value)),
    });
    if (!result.ok) {
      setPayrollManualSiteError(result.field === "site" ? result.error : null);
      setPayrollCorrectionError(result.field === "site" ? null : result.error);
      return;
    }

    setIsSavingPayrollCorrection(true);
    setPayrollManualSiteError(null);
    setPayrollCorrectionError(null);
    try {
      const createdEntry = await api.createTimeEntry(result.payload);
      applyCreatedTimeEntryFromMissingDay(missingEntry, createdEntry);
      await refreshSelectedReviewPayrollWeekSummary();
      closeTimeReviewDiagnostic();
    } catch (requestError) {
      setPayrollCorrectionError(readApiError(requestError, "Zeiteintrag konnte nicht gespeichert werden."));
    } finally {
      setIsSavingPayrollCorrection(false);
    }
  }

  function updatePayrollTimeBasis(field: PayrollTimeBasisField, value: string): void {
    setPayrollCorrectionError(null);
    setPayrollCorrectionForm((current) => applyPayrollTimeBasisChange(current, field, value));
  }

  async function refreshSelectedReviewPayrollWeekSummary(): Promise<void> {
    try {
      const payrollWeek = await api.timeEntryPayrollWeek({
        isoYear: selectedReviewWeek.year,
        isoWeek: selectedReviewWeek.week,
      });
      setReviewPayrollWeek(payrollWeek);
      setReviewPayrollWeekError(null);
    } catch (requestError) {
      setReviewPayrollWeekError(readApiError(requestError, "Wochensumme konnte nicht aktualisiert werden."));
    }
  }

  async function saveLocationReviewSite(): Promise<void> {
    if (
      !canManageTimeEntries
      || !locationReviewDiagnosticEntry
      || isReviewWeekWorkDateReadOnly(locationReviewDiagnosticEntry.work_date, locationReviewDiagnosticEntry.person_id)
      || isSavingLocationReview
    ) {
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
        ? await createTimeEntryForMissingDay(locationReviewDiagnosticEntry, parsedSiteId)
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
      setHasLocationReviewSitePreview(false);
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

  async function downloadAllPayrollMonthXlsx(): Promise<void> {
    if (!payrollMonthPeriod || !arePayrollMonthExportsAvailable || payrollMonthVersion === null || isDownloadingAllPayrollMonthXlsx) {
      return;
    }
    setIsDownloadingAllPayrollMonthXlsx(true);
    setPayrollMonthDownloadError(null);
    try {
      const blob = await api.payrollMonthlyWorkersXlsx({
        ...selectedEvaluationMonth,
        version: payrollMonthVersion,
      });
      downloadBlobFile(
        blob,
        payrollMonthFilename(
          `Lohnabrechnung_${selectedEvaluationMonth.year}_${String(selectedEvaluationMonth.month).padStart(2, "0")}_Alle_Monteure`,
          payrollMonthPeriod,
        ),
      );
    } catch (requestError) {
      setPayrollMonthDownloadError(readApiError(requestError, "Monatsabrechnungen konnten nicht erstellt werden."));
    } finally {
      setIsDownloadingAllPayrollMonthXlsx(false);
    }
  }

  async function downloadSelectedPayrollMonthXlsx(): Promise<void> {
    if (!payrollMonthPeriod || !isSelectedPayrollPersonApproved || !selectedEvaluationWorker || isDownloadingPayrollMonthXlsx) {
      return;
    }
    setIsDownloadingPayrollMonthXlsx(true);
    setPayrollMonthDownloadError(null);
    try {
      const blob = await api.payrollMonthlyWorkerXlsx({
        personId: selectedEvaluationWorker.personId,
        ...selectedEvaluationMonth,
        ...(payrollMonthVersion === null ? {} : { version: payrollMonthVersion }),
      });
      downloadBlobFile(
        blob,
        payrollMonthFilename(
          `Lohnabrechnung_${selectedEvaluationMonth.year}_${String(selectedEvaluationMonth.month).padStart(2, "0")}_${sanitizeFilenamePart(selectedEvaluationWorker.personName)}`,
          payrollMonthPeriod,
        ),
      );
    } catch (requestError) {
      setPayrollMonthDownloadError(readApiError(requestError, "Monatsabrechnung konnte nicht erstellt werden."));
    } finally {
      setIsDownloadingPayrollMonthXlsx(false);
    }
  }

  async function confirmPayrollMonthLock(): Promise<void> {
    if (!canManagePayrollClose || !payrollMonthPeriod || payrollMonthPeriod.status !== "OPEN" || !payrollMonthPeriod.can_lock || isUpdatingPayrollMonth) {
      return;
    }
    setIsUpdatingPayrollMonth(true);
    setPayrollMonthPeriodError(null);
    try {
      const updatedPeriod = await api.lockPayrollMonth(selectedEvaluationMonth);
      setPayrollMonthPeriod(updatedPeriod);
      setPayrollMonthDialog(null);
    } catch (requestError) {
      setPayrollMonthPeriodError(readApiError(requestError, "Monat konnte nicht abgeschlossen werden."));
    } finally {
      setIsUpdatingPayrollMonth(false);
    }
  }

  async function confirmPayrollMonthReopen(): Promise<void> {
    const reason = payrollMonthReopenReason.trim();
    if (!canManagePayrollClose || !payrollMonthPeriod || payrollMonthPeriod.status !== "LOCKED" || !payrollMonthPeriod.can_reopen || !reason || isUpdatingPayrollMonth) {
      return;
    }
    setIsUpdatingPayrollMonth(true);
    setPayrollMonthPeriodError(null);
    try {
      const updatedPeriod = await api.reopenPayrollMonth({
        ...selectedEvaluationMonth,
        reason,
      });
      setPayrollMonthPeriod(updatedPeriod);
      setPayrollMonthDialog(null);
      setPayrollMonthReopenReason("");
    } catch (requestError) {
      setPayrollMonthPeriodError(readApiError(requestError, "Monat konnte nicht wieder geöffnet werden."));
    } finally {
      setIsUpdatingPayrollMonth(false);
    }
  }

  async function confirmPayrollPersonMonthApproval(): Promise<void> {
    if (!selectedEvaluationWorker || !canApproveSelectedPayrollPerson) {
      return;
    }
    setIsUpdatingPayrollPersonMonth(true);
    setPayrollMonthPeriodError(null);
    try {
      const updatedPeriod = await api.approvePayrollPersonMonth({
        ...selectedEvaluationMonth,
        personId: selectedEvaluationWorker.personId,
        acknowledgedBlockerCount: selectedPayrollPersonBlockers.length,
      });
      setPayrollMonthPeriod(updatedPeriod);
      setPayrollPersonMonthDialog(null);
      setHasAcknowledgedPayrollPersonBlockers(false);
      setIsPayrollPersonLogExpanded(false);
    } catch (requestError) {
      setPayrollMonthPeriodError(readApiError(requestError, "Monteurmonat konnte nicht abgeschlossen werden."));
    } finally {
      setIsUpdatingPayrollPersonMonth(false);
    }
  }

  async function confirmPayrollPersonMonthReopen(): Promise<void> {
    const reason = payrollPersonMonthReopenReason.trim();
    if (!selectedEvaluationWorker || !canReopenSelectedPayrollPerson || !reason) {
      return;
    }
    setIsUpdatingPayrollPersonMonth(true);
    setPayrollMonthPeriodError(null);
    try {
      const updatedPeriod = await api.reopenPayrollPersonMonth({
        ...selectedEvaluationMonth,
        personId: selectedEvaluationWorker.personId,
        reason,
      });
      setPayrollMonthPeriod(updatedPeriod);
      setPayrollPersonMonthDialog(null);
      setPayrollPersonMonthReopenReason("");
      setIsPayrollPersonLogExpanded(false);
    } catch (requestError) {
      setPayrollMonthPeriodError(readApiError(requestError, "Monteurmonat konnte nicht wieder geöffnet werden."));
    } finally {
      setIsUpdatingPayrollPersonMonth(false);
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
        return upsertWeeklyReview(current, weeklyReview);
      });
      setReviewWeekCompletionReviews((current) => {
        return upsertWeeklyReview(current, weeklyReview);
      });
    } catch (requestError) {
      setReviewActionError(readApiError(requestError, "Monteurwoche konnte nicht als geprüft markiert werden."));
    } finally {
      setMarkingReviewWeekPersonId(null);
    }
  }

  async function resetSelectedReviewWeekReview(): Promise<void> {
    if (!canManageTimeEntries || !selectedReviewWorker || !selectedReviewWorker.isReviewed || markingReviewWeekPersonId !== null) {
      return;
    }
    setReviewWeekStatusMenuPersonId(null);
    setReviewWeekStatusMenuPosition(null);
    setMarkingReviewWeekPersonId(selectedReviewWorker.personId);
    setReviewActionError(null);
    try {
      const weeklyReview = await api.resetTimeEntryWeeklyReview({
        personId: selectedReviewWorker.personId,
        isoYear: selectedReviewWeek.year,
        isoWeek: selectedReviewWeek.week,
      });
      setReviewWeeklyReviews((current) => upsertWeeklyReview(current, weeklyReview));
      setReviewWeekCompletionReviews((current) => upsertWeeklyReview(current, weeklyReview));
    } catch (requestError) {
      setReviewActionError(readApiError(requestError, "Monteurwoche konnte nicht zurückgesetzt werden."));
    } finally {
      setMarkingReviewWeekPersonId(null);
    }
  }

  return (
    <section className={`time-entries-page is-figma-times-workspace${activeTimeSubtab === "review" || (activeTimeSubtab === "evaluation" && activeEvaluationSubtab === "workers") ? " is-payroll-review-workspace" : ""}`}>
      <div className="page-header entity-page-header">
        <div>
          <h1>Lohnprüfung</h1>
          <p className="page-subtitle">Arbeitszeiten der Monteure prüfen</p>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="time-payroll-navigation-row">
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
        {activeTimeSubtab === "evaluation" && (
          <div className="project-record-subtabs time-evaluation-subtabs" role="tablist" aria-label="Monatsauswertung Bereiche">
            {([
              ["workers", "Monteure"],
              ["sites", "Baustellen (Beta)"],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeEvaluationSubtab === tab}
                className={activeEvaluationSubtab === tab ? "is-active" : ""}
                onClick={() => setActiveEvaluationSubtab(tab)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeTimeSubtab === "review" && (
        <div className="time-entries-main time-review-main">
          <div className="time-week-nav-panel time-review-week-nav" aria-label="Kalenderwochen">
            <div className="time-review-week-nav-row">
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
                    aria-current={option.isCurrent ? "date" : undefined}
                    aria-label={`KW ${option.week} ${option.year}${option.isCurrent ? ", aktuelle Kalenderwoche" : ""}${option.year === selectedReviewWeek.year && option.week === selectedReviewWeek.week ? ", ausgewählt" : ""}`}
                    aria-pressed={option.year === selectedReviewWeek.year && option.week === selectedReviewWeek.week}
                    title={`${formatRangeLabel(option.start, option.end)} · ${option.year}${option.isCurrent ? " · aktuelle Kalenderwoche" : ""}`}
                    type="button"
                    onClick={() => selectReviewWeek(option)}
                  >
                    <strong>{option.label}</strong>
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
          </div>

          <div className="time-review-workspace-layout" ref={timeReviewWorkerPanelRef}>
            <aside className="time-review-queue-panel" aria-label="Prüfwarteschlange">
              <div className="time-review-queue-head">
                <h2>Prüfwarteschlange</h2>
                <span>KW {selectedReviewWeek.week}</span>
              </div>
              <label className="time-review-queue-search">
                <Search aria-hidden="true" size={15} />
                <input
                  type="search"
                  value={reviewWorkerSearch}
                  placeholder="Monteur suchen..."
                  aria-label="Monteur suchen"
                  onChange={(event) => setReviewWorkerSearch(event.currentTarget.value)}
                />
              </label>
              <div className="time-review-queue-filters" role="group" aria-label="Statusfilter">
                {([
                  ["all", "Alle"],
                  ["open", "Offen"],
                  ["missing", "Keine Meldung"],
                  ["reviewed", "Geprüft"],
                ] as const).map(([filter, label]) => (
                  <button
                    className={reviewWorkerFilter === filter ? "is-active" : ""}
                    key={filter}
                    type="button"
                    aria-pressed={reviewWorkerFilter === filter}
                    onClick={() => setReviewWorkerFilter(filter)}
                  >
                    <span>{label}</span>
                    <small>{reviewWorkerFilterCounts[filter]}</small>
                  </button>
                ))}
              </div>
              <div className="time-review-queue-list" role="listbox" aria-label="Monteure für die Lohnprüfung">
                <div className="time-review-queue-columns" aria-hidden="true">
                  <span>Monteur</span>
                  <span>Std. erfasst</span>
                  <span>Status</span>
                </div>
                {isLoadingPeople && timeReviewWorkers.length === 0 && (
                  <div className="time-review-queue-state">Monteure werden geladen...</div>
                )}
                {!isLoadingPeople && (isLoadingReviewEntries || isLoadingReviewAllEntries) && timeReviewWorkers.length === 0 && (
                  <div className="time-review-queue-state">Stundenprüfung wird geladen...</div>
                )}
                {!isLoadingReviewEntries && reviewEntriesError && <div className="time-review-queue-state is-error">{reviewEntriesError}</div>}
                {!isLoadingReviewAllEntries && reviewAllEntriesError && <div className="time-review-queue-state is-error">{reviewAllEntriesError}</div>}
                {!isLoadingPeople && !isLoadingReviewEntries && !isLoadingReviewAllEntries && !reviewEntriesError && !reviewAllEntriesError && timeReviewWorkers.length === 0 && (
                  <div className="time-review-queue-state">Keine aktiven internen Monteure gefunden.</div>
                )}
                {timeReviewWorkers.length > 0 && filteredTimeReviewWorkers.length === 0 && (
                  <div className="time-review-queue-state">Keine Monteure für diesen Filter.</div>
                )}
                {filteredTimeReviewWorkers.map((worker) => {
                  const workerStatus = timeReviewWorkerStatus(worker);
                  return (
                    <button
                      className={[
                        "time-review-queue-row",
                        selectedReviewWorker?.personId === worker.personId ? "is-active" : "",
                      ].filter(Boolean).join(" ")}
                      key={worker.personId}
                      type="button"
                      role="option"
                      aria-selected={selectedReviewWorker?.personId === worker.personId}
                      onClick={() => setSelectedReviewPersonId(worker.personId)}
                    >
                      <span className="time-review-worker-name">{worker.personName}</span>
                      <span className="time-review-queue-hours">
                        {worker.submittedMinutes > 0 ? `${formatSubmittedHours(worker.submittedMinutes)} Std.` : "–"}
                      </span>
                      <span
                        className={`time-review-queue-status${workerStatus === "reviewed" ? " time-review-reviewed-indicator" : ""} is-${workerStatus}`}
                        aria-label={timeReviewWorkerStatusLabel(workerStatus)}
                        title={timeReviewWorkerStatusLabel(workerStatus)}
                      >
                        {workerStatus === "reviewed" ? "✓" : workerStatus === "open" ? "!" : "–"}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="time-review-queue-footer">
                <span>{filteredTimeReviewWorkers.length} von {timeReviewWorkers.length} Monteuren</span>
              </div>
            </aside>

            <div className="time-review-detail-shell">
              {reviewActionError && <p className="time-table-note">{reviewActionError}</p>}
              {reviewHoursDownloadError && <p className="time-table-note">{reviewHoursDownloadError}</p>}
              {reviewPayrollWeekError && <p className="time-table-note">{reviewPayrollWeekError}</p>}
              {isLoadingReviewWeekPayrollMonthStatuses && (
                <p className="time-table-note" role="status">Monatssperren werden geprüft...</p>
              )}
              {reviewWeekPayrollMonthStatusError && (
                <p className="time-table-note" role="alert">{reviewWeekPayrollMonthStatusError}</p>
              )}

            {selectedReviewWorker ? (
              <div className={`time-review-worker-detail${selectedReviewWorker.isReviewed ? " is-reviewed" : ""}`}>
                <div className="time-review-worker-detail-head">
                  <div className="time-review-worker-identity">
                    <h3>{selectedReviewWorker.personName}</h3>
                    <span
                      className="time-review-worker-hours"
                      aria-label={`Erfasste Stunden: ${formatSubmittedHours(selectedReviewWorker.submittedMinutes)} Stunden`}
                      title={`Erfasste Stunden: ${formatSubmittedHours(selectedReviewWorker.submittedMinutes)} Stunden`}
                    >
                      <strong>{formatSubmittedHours(selectedReviewWorker.submittedMinutes)} Std.</strong>
                    </span>
                  </div>
                  <div className="time-review-worker-detail-actions">
                    <div className="time-review-worker-detail-action-stack">
                      {canManageTimeEntries && (
                        <button
                          className="icon-button secondary time-review-manual-create-button"
                          type="button"
                          aria-haspopup="dialog"
                          title={selectedReviewWorker.isReviewed
                            ? "Geprüfte Woche zuerst zurücksetzen."
                            : payrollManualDateOptions.length === 0
                              ? "In dieser Woche ist aktuell kein bearbeitbarer Tag verfügbar."
                              : "Zeit für diese Monteurwoche manuell erfassen"}
                          disabled={selectedReviewWorker.isReviewed
                            || payrollManualDateOptions.length === 0
                            || markingReviewWeekPersonId === selectedReviewWorker.personId}
                          onClick={openManualTimeEntryDialog}
                        >
                          <CalendarPlus aria-hidden="true" size={15} />
                          Zeit erfassen
                        </button>
                      )}
                      <div className="time-review-week-actions-control" ref={reviewWeekActionsMenuControlRef}>
                        <button
                          aria-controls={isReviewWeekActionsMenuOpen ? "time-review-week-actions-menu" : undefined}
                          aria-expanded={isReviewWeekActionsMenuOpen}
                          aria-haspopup="menu"
                          aria-label="Weitere Aktionen für die Monteurwoche"
                          className="icon-button secondary time-review-week-actions-button"
                          ref={reviewWeekActionsMenuTriggerRef}
                          type="button"
                          onClick={(event) => {
                            if (isReviewWeekActionsMenuOpen) {
                              setIsReviewWeekActionsMenuOpen(false);
                              setReviewWeekActionsMenuPosition(null);
                              return;
                            }
                            const bounds = event.currentTarget.getBoundingClientRect();
                            setReviewWeekActionsMenuPosition({
                              triggerTop: bounds.top,
                              triggerBottom: bounds.bottom,
                              triggerLeft: bounds.left,
                              triggerRight: bounds.right,
                              position: null,
                            });
                            setIsReviewWeekActionsMenuOpen(true);
                          }}
                        >
                          <MoreHorizontal aria-hidden="true" size={17} />
                          Mehr
                        </button>
                        {isReviewWeekActionsMenuOpen && reviewWeekActionsMenuPosition && typeof document !== "undefined" && createPortal(
                          <div
                            className={`time-review-day-move-popover time-review-week-actions-menu${reviewWeekActionsMenuPosition.position ? ` is-open-${reviewWeekActionsMenuPosition.position.placement}` : ""}`}
                            id="time-review-week-actions-menu"
                            ref={reviewWeekActionsMenuRef}
                            role="menu"
                            aria-label="Excel-Exporte"
                            style={{
                              left: `${reviewWeekActionsMenuPosition.position?.left ?? reviewWeekActionsMenuPosition.triggerLeft}px`,
                              top: `${reviewWeekActionsMenuPosition.position?.top ?? reviewWeekActionsMenuPosition.triggerBottom + 6}px`,
                              maxHeight: reviewWeekActionsMenuPosition.position ? `${reviewWeekActionsMenuPosition.position.maxHeight}px` : undefined,
                              maxWidth: reviewWeekActionsMenuPosition.position ? `${reviewWeekActionsMenuPosition.position.maxWidth}px` : undefined,
                              visibility: reviewWeekActionsMenuPosition.position ? "visible" : "hidden",
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                setIsReviewWeekActionsMenuOpen(false);
                                reviewWeekActionsMenuTriggerRef.current?.focus();
                                return;
                              }
                              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                                return;
                              }
                              event.preventDefault();
                              const menuItems = Array.from(
                                event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
                              );
                              const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
                              const nextIndex = event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? menuItems.length - 1
                                  : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length;
                              menuItems[nextIndex]?.focus();
                            }}
                          >
                            {selectedReviewWorker.isReviewed && (
                              <button
                                type="button"
                                role="menuitem"
                                disabled={isDownloadingReviewWeekXlsx}
                                onClick={() => {
                                  setIsReviewWeekActionsMenuOpen(false);
                                  setReviewWeekActionsMenuPosition(null);
                                  void downloadSelectedReviewWeekXlsx();
                                }}
                              >
                                <Download aria-hidden="true" size={15} />
                                {isDownloadingReviewWeekXlsx ? "Excel wird erstellt..." : "Diese Woche als Excel"}
                              </button>
                            )}
                            <button
                              type="button"
                              role="menuitem"
                              disabled={isDownloadingAllReviewWeekXlsx}
                              onClick={() => {
                                setIsReviewWeekActionsMenuOpen(false);
                                setReviewWeekActionsMenuPosition(null);
                                void downloadAllReviewWeekXlsx();
                              }}
                            >
                              <Download aria-hidden="true" size={15} />
                              {isDownloadingAllReviewWeekXlsx ? "Excel wird erstellt..." : "Alle Arbeitsstunden als Excel"}
                            </button>
                          </div>
                          ,
                          document.body,
                        )}
                      </div>
                      <span className="time-review-week-action-separator" aria-hidden="true" />
                      <div
                        className="time-review-week-review-control"
                        ref={reviewWeekStatusMenuControlRef}
                      >
                          <button
                            aria-controls={selectedReviewWorker.isReviewed && reviewWeekStatusMenuPersonId === selectedReviewWorker.personId
                              ? "time-review-week-review-menu"
                              : undefined}
                            aria-expanded={selectedReviewWorker.isReviewed
                              ? reviewWeekStatusMenuPersonId === selectedReviewWorker.personId
                              : undefined}
                            aria-haspopup={selectedReviewWorker.isReviewed ? "menu" : undefined}
                            aria-label={markingReviewWeekPersonId === selectedReviewWorker.personId
                              ? selectedReviewWorker.isReviewed
                                ? "Monteurwoche wird zurückgesetzt"
                                : "Monteurwoche wird geprüft"
                              : selectedReviewWorker.isReviewed
                                ? "Monteurwoche geprüft, Status ändern"
                                : "Monteurwoche als geprüft markieren"}
                            aria-pressed={selectedReviewWorker.isReviewed}
                            className={`time-review-week-review-button${selectedReviewWorker.isReviewed ? " is-reviewed" : ""}`}
                            title={selectedReviewWorker.isReviewed
                              ? "Monteurwoche geprüft – klicken, um den Status zu ändern"
                              : "Monteurwoche als geprüft markieren"}
                            type="button"
                            disabled={!canManageTimeEntries || markingReviewWeekPersonId === selectedReviewWorker.personId}
                            ref={reviewWeekStatusMenuTriggerRef}
                            onClick={(event) => {
                              if (selectedReviewWorker.isReviewed) {
                                if (reviewWeekStatusMenuPersonId === selectedReviewWorker.personId) {
                                  setReviewWeekStatusMenuPersonId(null);
                                  setReviewWeekStatusMenuPosition(null);
                                  return;
                                }
                                const bounds = event.currentTarget.getBoundingClientRect();
                                setReviewWeekStatusMenuPosition({
                                  triggerTop: bounds.top,
                                  triggerBottom: bounds.bottom,
                                  triggerLeft: bounds.left,
                                  triggerRight: bounds.right,
                                  position: null,
                                });
                                setReviewWeekStatusMenuPersonId(selectedReviewWorker.personId);
                                return;
                              }
                              void markSelectedReviewWeekReviewed();
                            }}
                          >
                          {selectedReviewWorker.isReviewed && (
                            <span className="time-review-reviewed-indicator is-week-review" aria-hidden="true">✓</span>
                          )}
                          </button>
                          {selectedReviewWorker.isReviewed && reviewWeekStatusMenuPersonId === selectedReviewWorker.personId && reviewWeekStatusMenuPosition && typeof document !== "undefined" && createPortal(
                            <div
                              className="time-review-day-move-popover time-review-week-review-menu"
                              id="time-review-week-review-menu"
                              ref={reviewWeekStatusMenuRef}
                              role="menu"
                              aria-label="Lohnprüfstatus Aktionen"
                              style={{
                                left: `${reviewWeekStatusMenuPosition.position?.left ?? reviewWeekStatusMenuPosition.triggerLeft}px`,
                                top: `${reviewWeekStatusMenuPosition.position?.top ?? reviewWeekStatusMenuPosition.triggerBottom + 6}px`,
                                maxHeight: reviewWeekStatusMenuPosition.position ? `${reviewWeekStatusMenuPosition.position.maxHeight}px` : undefined,
                                maxWidth: reviewWeekStatusMenuPosition.position ? `${reviewWeekStatusMenuPosition.position.maxWidth}px` : undefined,
                                visibility: reviewWeekStatusMenuPosition.position ? "visible" : "hidden",
                              }}
                            >
                              <button
                                type="button"
                                role="menuitem"
                                disabled={markingReviewWeekPersonId === selectedReviewWorker.personId}
                                style={{ background: "#fff8eb", color: "#9a5b00" }}
                                onClick={() => void resetSelectedReviewWeekReview()}
                              >
                                {markingReviewWeekPersonId === selectedReviewWorker.personId ? "Wird zurückgesetzt..." : "Zurücksetzen"}
                              </button>
                            </div>
                            ,
                            document.body,
                          )}
                      </div>
                    </div>
                  </div>
                </div>
                {payrollDateError && <p className="time-review-week-error">{payrollDateError}</p>}
                <div className="time-review-week-check-table" role="table" aria-label={`Lohnprüfung ${selectedReviewWorker.personName} KW ${selectedReviewWeek.week}`}>
                  <PayrollReviewTableHeaders />
                  {selectedReviewWeekDays.map((day) => {
                    const payrollDayLockLabel = reviewWeekWorkDateLockLabel(day.date);
                    const isLockedPayrollDay = payrollDayLockLabel !== null;
                    const isReadOnlyPayrollDay = isReviewWeekWorkDateReadOnly(day.date);
                    return (
                    <section
                      aria-label={`${day.weekdayLabel}, ${formatDate(day.date)}${payrollDayLockLabel ? `, ${payrollDayLockLabel}` : ""}`}
                      className={`time-review-day-group${isLockedPayrollDay ? " is-payroll-month-locked" : ""}`}
                      key={day.date}
                      role="rowgroup"
                    >
                      <div className="time-review-day-group-head" role="row">
                        <span
                          className="time-review-day-group-label"
                          role="rowheader"
                          title={`${day.weekdayLabel}, ${formatDate(day.date)}`}
                        >
                          <span className="time-review-day-group-summary">
                            <strong className="time-review-day-group-weekday">{day.weekdayLabel}</strong>
                            {day.entries.length > 0 && (
                              <PayrollOvernightStatusControl
                                editable={canManageTimeEntries && !selectedReviewWorker.isReviewed && !isReadOnlyPayrollDay}
                                hasConflict={day.hasOvernightStatusConflict}
                                saving={payrollOvernightSavingKey === `${selectedReviewWorker.personId}:${day.date}`}
                                status={day.overnightStatus}
                                onChange={(overnightStatus) => updatePayrollOvernightStatus(
                                  selectedReviewWorker.personId,
                                  day.date,
                                  overnightStatus,
                                )}
                              />
                            )}
                          </span>
                          {isLockedPayrollDay && (
                            <span className="time-review-day-month-lock-badge">
                              <LockKeyhole aria-hidden="true" size={12} />
                              {payrollDayLockLabel}
                            </span>
                          )}
                        </span>
                        <span
                          className="time-review-day-group-total time-review-work-time-cell"
                          role="cell"
                          aria-label={`Gesamtarbeitszeit ${formatTimeEntryMinutes(timeReviewDayTotalMinutes(day), "hours")}`}
                        >
                          {formatTimeEntryMinutes(timeReviewDayTotalMinutes(day), "hours")}
                        </span>
                      </div>
                      <div className="time-review-day-group-entries">
                    {day.entries.length > 0 ? day.entries.map((check) => (
                      <div
                        className="time-review-week-check-row"
                        key={`${day.date}-${check.entry.id}`}
                        role="row"
                      >
                        <div className="time-review-week-move" role="cell">
                          <button
                            className="time-review-day-move-button"
                            type="button"
                            aria-label="Aktionen für Zeiteintrag öffnen"
                            aria-haspopup="menu"
                            aria-expanded={payrollDatePicker?.entryId === check.entry.id}
                            disabled={!canManageTimeEntries || isReadOnlyPayrollDay || payrollDateActionEntryId !== null || check.entry.id < 0}
                            onClick={(event) => togglePayrollDatePicker(check.entry, event.currentTarget)}
                          >
                            <ChevronsUpDown aria-hidden="true" size={14} />
                          </button>
                        </div>
                        <div className="time-review-week-day" role="cell">
                          {check.entry.original_work_date && check.entry.original_work_date !== check.entry.work_date && (
                            <small className="time-review-day-shift-note">vom {formatWeekday(check.entry.original_work_date)} verschoben</small>
                          )}
                        </div>
                        <div
                          className="time-review-week-type"
                          role="cell"
                          aria-label={isTravelTimeEntry(check.entry) ? "Eintragstyp Fahrt" : "Eintragstyp Arbeit"}
                        >
                          {isTravelTimeEntry(check.entry) ? (
                            <span className="time-review-entry-type is-travel" title="Fahrzeit">
                              <CarFront aria-hidden="true" size={14} />
                              <span>Fahrt</span>
                            </span>
                          ) : (
                            <span className="time-review-entry-type is-work" title="Arbeitszeit">
                              <Wrench aria-hidden="true" size={14} />
                              <span>Arbeit</span>
                            </span>
                          )}
                        </div>
                        <div className="time-review-week-site" role="cell">
                          <strong>{timeReviewSiteName(check.entry)}</strong>
                          {check.entry.site_number && <span>{check.entry.site_number}</span>}
                          {day.absenceType && (
                            <StatusBadge tone={day.absenceType} className="time-review-absence-badge">
                              {absenceTypeLabels[day.absenceType]}
                            </StatusBadge>
                          )}
                        </div>
                        <div className="time-review-week-time time-review-week-time-start" role="cell">{renderPayrollClock(check.entry, "start")}{hasPayrollTimeRange(check.entry) && <ArrowRight className="time-review-time-range-arrow" aria-hidden="true" size={13} strokeWidth={1.8} />}</div>
                        <div className="time-review-week-time time-review-week-time-end" role="cell">{renderPayrollClock(check.entry, "end")}</div>
                        <div className="time-review-week-time time-review-week-break" role="cell">{renderTimeReviewBreakMinutes(check.entry)}</div>
                        <div className="time-review-week-time time-review-week-total" role="cell">{renderPayrollWorkMinutes(check.entry)}</div>
                        <div role="cell">
                          {renderTimeReviewCheckMark(check.locationCheck, {
                            onClick: isReadOnlyPayrollDay ? undefined : () => openLocationReviewDiagnostic(check.entry),
                            label: "Ort-Diagnose öffnen",
                          })}
                        </div>
                        <div className="time-review-work-time-cell" role="cell">
                          {renderTimeReviewCheckMark(check.timeCheck, {
                            onClick: isReadOnlyPayrollDay ? undefined : () => openTimeReviewDiagnostic(check.entry),
                            label: "Arbeitszeit-Diagnose öffnen",
                          })}
                        </div>
                        <div role="cell">
                          {renderPayrollReviewMark(check.entry, {
                            disabled: !canManageTimeEntries || isReadOnlyPayrollDay || payrollReviewActionEntryId !== null || check.entry.id < 0,
                            isBusy: payrollReviewActionEntryId === check.entry.id,
                            onToggle: () => void togglePayrollRowReview(check.entry),
                          })}
                        </div>
                      </div>
                    )) : (() => {
                      const missingEntry = buildMissingTimeReviewEntry(selectedReviewWorker, day.date);
                      const hasVacationCredit = day.absenceType === "vacation" && day.vacationCreditMinutes > 0;
                      return (
                        <div className="time-review-week-check-row is-empty" key={day.date} role="row">
                          <div className="time-review-week-move" role="cell"></div>
                          <div className="time-review-week-day" role="cell"></div>
                          <div className="time-review-week-type" role="cell" aria-label="Keine Zeitmeldung"></div>
                          <div className="time-review-week-site" role="cell">
                            {day.absenceType ? (
                              <StatusBadge tone={day.absenceType} className="time-review-absence-badge">
                                {absenceTypeLabels[day.absenceType]}
                              </StatusBadge>
                            ) : (
                              <strong>Keine Zeitmeldung</strong>
                            )}
                          </div>
                          <div className="time-review-week-time time-review-week-total" role="cell">-</div>
                          <div className="time-review-week-time time-review-week-break" role="cell">-</div>
                          <div className="time-review-week-time" role="cell">-</div>
                          <div className="time-review-week-time" role="cell">-</div>
                          <div role="cell">
                            {hasVacationCredit ? "-" : renderTimeReviewCheckMark("unknown", {
                              onClick: isReadOnlyPayrollDay ? undefined : () => openLocationReviewDiagnostic(missingEntry),
                              label: "Ort-Diagnose öffnen",
                            })}
                          </div>
                          <div
                            aria-label={hasVacationCredit ? "Keine zusätzliche Arbeitszeit" : undefined}
                            className={`time-review-work-time-cell${hasVacationCredit ? " time-review-week-time" : ""}`}
                            role="cell"
                          >
                            {hasVacationCredit
                              ? null
                              : renderTimeReviewCheckMark("unknown", {
                                onClick: isReadOnlyPayrollDay ? undefined : () => openTimeReviewDiagnostic(missingEntry),
                                label: "Arbeitszeit-Diagnose öffnen",
                              })}
                          </div>
                          <div role="cell">{renderPayrollReviewEmptyMark()}</div>
                        </div>
                      );
                    })()}
                      </div>
                    </section>
                    );
                  })}
                </div>
                {payrollDatePicker && payrollDatePickerEntry && typeof document !== "undefined" && createPortal(
                  <div
                    className={`time-review-day-move-popover${payrollDatePicker.position ? ` is-open-${payrollDatePicker.position.placement}` : ""}`}
                    ref={payrollDatePickerMenuRef}
                    role="menu"
                    aria-label="Aktionen für Zeiteintrag"
                    style={{
                      left: `${payrollDatePicker.position?.left ?? payrollDatePicker.triggerLeft}px`,
                      top: `${payrollDatePicker.position?.top ?? payrollDatePicker.triggerBottom + 4}px`,
                      maxHeight: payrollDatePicker.position ? `${payrollDatePicker.position.maxHeight}px` : undefined,
                      maxWidth: payrollDatePicker.position ? `${payrollDatePicker.position.maxWidth}px` : undefined,
                      visibility: payrollDatePicker.position ? "visible" : "hidden",
                    }}
                  >
                    {selectedReviewWeekDayOptions.map((option) => (
                      <button
                        className={option.date === payrollDatePickerEntry.work_date ? "is-selected" : ""}
                        disabled={isReviewWeekWorkDateReadOnly(option.date)}
                        key={option.date}
                        type="button"
                        role="menuitemradio"
                        aria-checked={option.date === payrollDatePickerEntry.work_date}
                        title={reviewWeekWorkDateLockLabel(option.date) ?? undefined}
                        onClick={() => void movePayrollEntryDate(payrollDatePickerEntry, option.date)}
                      >
                        {option.label}
                      </button>
                    ))}
                    <button
                      className="time-review-day-delete-action"
                      type="button"
                      role="menuitem"
                      onClick={() => openPayrollDeleteDialog(payrollDatePickerEntry)}
                    >
                      <Trash2 aria-hidden="true" size={13} />
                      Eintrag löschen
                    </button>
                  </div>,
                  document.body,
                )}
              </div>
            ) : timeReviewWorkers.length > 0 ? (
              <div className="time-review-worker-empty-detail">Monteur auswählen, um die Lohnprüfung für KW {selectedReviewWeek.week} zu öffnen.</div>
            ) : null}
            </div>
          </div>
        </div>
      )}

      {activeTimeSubtab === "evaluation" && (
        <div className={`time-entries-main time-review-main time-evaluation-main${activeEvaluationSubtab === "workers" ? " has-person-month-close" : ""}`}>
          {activeEvaluationSubtab === "workers" && (
            <PayrollPersonMonthClosePanel
              approval={selectedPayrollPersonApproval}
              blockers={selectedPayrollPersonBlockers}
              canApprove={canApproveSelectedPayrollPerson}
              canReopen={canReopenSelectedPayrollPerson}
              disabledReason={payrollPersonApprovalDisabledReason}
              isDownloadingWorkerExport={isDownloadingPayrollMonthXlsx}
              isExportAvailable={Boolean(selectedPayrollPersonApproval?.export_ready)}
              isLoading={isLoadingPayrollMonthPeriod}
              isLogExpanded={isPayrollPersonLogExpanded}
              isUpdating={isUpdatingPayrollPersonMonth}
              month={selectedEvaluationMonth}
              selectedWorker={selectedEvaluationWorker}
              onDownloadWorkerExport={() => void downloadSelectedPayrollMonthXlsx()}
              onOpenApprove={() => {
                setHasAcknowledgedPayrollPersonBlockers(false);
                setPayrollPersonMonthDialog("approve");
              }}
              onOpenReopen={() => setPayrollPersonMonthDialog("reopen")}
              onOpenWorkingTime={(personId) => navigate(`/persons?workingTimePersonId=${personId}`)}
              onToggleLog={() => setIsPayrollPersonLogExpanded((current) => !current)}
            />
          )}
          <div className="time-week-nav-panel time-evaluation-month-nav" aria-label="Monat für die Auswertung auswählen">
            <div className="time-evaluation-period-controls">
              <div className="time-evaluation-period-selection">
                <div className="time-evaluation-month-strip-shell" role="group" aria-label={"Monat im Jahr " + selectedEvaluationMonth.year + " auswählen"}>
                  <button className="time-week-scroll-button" disabled={!evaluationMonthScrollState.canScrollLeft} type="button" aria-label="Monate nach links scrollen" onClick={() => scrollEvaluationMonths(-1)}>
                    <ChevronLeft aria-hidden="true" size={16} />
                  </button>
                  <div className="time-evaluation-month-strip" ref={evaluationMonthStripRef}>
                    {evaluationMonthOptions.map((option) => (
                      <button
                        className={[
                          option.year === selectedEvaluationMonth.year && option.month === selectedEvaluationMonth.month ? "is-active" : "",
                          option.isCurrent ? "is-current" : "",
                        ].filter(Boolean).join(" ")}
                        data-month={option.month}
                        data-year={option.year}
                        key={`${option.year}-${option.month}`}
                        title={`${option.label} ${option.year} · ${formatRangeLabel(calendarMonthRange(option).start, calendarMonthRange(option).end)}`}
                        type="button"
                        aria-current={option.isCurrent ? "date" : undefined}
                        aria-pressed={option.year === selectedEvaluationMonth.year && option.month === selectedEvaluationMonth.month}
                        onClick={() => selectEvaluationMonth(option)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <button className="time-week-scroll-button" disabled={!evaluationMonthScrollState.canScrollRight} type="button" aria-label="Monate nach rechts scrollen" onClick={() => scrollEvaluationMonths(1)}>
                    <ChevronRight aria-hidden="true" size={16} />
                  </button>
                </div>
                <div className="time-evaluation-year-navigation" role="group" aria-label="Auswertungsjahr">
                  <button
                    className="time-week-scroll-button"
                    disabled={selectedEvaluationMonth.year <= 2000}
                    type="button"
                    aria-label="Vorheriges Jahr auswählen"
                    onClick={() => selectEvaluationYear(selectedEvaluationMonth.year - 1)}
                  >
                    <ChevronLeft aria-hidden="true" size={16} />
                  </button>
                  <span aria-live="polite">{selectedEvaluationMonth.year}</span>
                  <button
                    className="time-week-scroll-button"
                    disabled={selectedEvaluationMonth.year >= 2100}
                    type="button"
                    aria-label="Nächstes Jahr auswählen"
                    onClick={() => selectEvaluationYear(selectedEvaluationMonth.year + 1)}
                  >
                    <ChevronRight aria-hidden="true" size={16} />
                  </button>
                </div>
              </div>
              <div className="time-evaluation-period-actions is-compact" role="group" aria-labelledby="time-evaluation-export-heading">
                <div className="payroll-month-total-status" role="status">
                  <span>Gesamtstatus</span>
                  <strong>
                    {isLoadingPayrollMonthPeriod
                      ? "Monatsstatus wird geladen..."
                      : payrollPersonApprovalSummary
                        ? `${payrollPersonApprovalSummary.approved_count} von ${payrollPersonApprovalSummary.total_count} Monteuren geprüft`
                        : "Monatsstatus nicht verfügbar"}
                  </strong>
                </div>
                <div className="payroll-month-compact-actions">
                  <label
                    className={`payroll-month-lock-toggle${isPayrollMonthLocked ? " is-locked" : ""}`}
                    title={payrollMonthPeriod?.status === "OPEN" && !payrollMonthPeriod.can_lock
                      ? "Der Gesamtmonat kann erst abgeschlossen werden, wenn alle Monteure geprüft sind und keine technischen Prüfpunkte offen sind."
                      : undefined}
                  >
                    <input
                      aria-describedby="time-evaluation-monthly-download-status"
                      checked={isPayrollMonthLocked}
                      disabled={isLoadingPayrollMonthPeriod
                        || isUpdatingPayrollMonth
                        || !canManagePayrollClose
                        || !payrollMonthPeriod
                        || (payrollMonthPeriod.status === "OPEN" && !payrollMonthPeriod.can_lock)
                        || (payrollMonthPeriod.status === "LOCKED" && !payrollMonthPeriod.can_reopen)}
                      type="checkbox"
                      onChange={() => setPayrollMonthDialog(isPayrollMonthLocked ? "reopen" : "lock")}
                    />
                    <span className="payroll-month-lock-box" aria-hidden="true">
                      {isPayrollMonthLocked ? <Check size={13} strokeWidth={3} /> : null}
                    </span>
                    <span>Gesamtmonat geprüft</span>
                  </label>
                  {canManagePayrollClose && (
                    <button
                      className="payroll-month-setup-button"
                      title="Regelmäßige Arbeitszeit und Eröffnungssalden verwalten"
                      type="button"
                      onClick={() => setIsPayrollSetupOpen(true)}
                    >
                      <Settings2 aria-hidden="true" size={14} />
                      Stundenkonto einrichten
                    </button>
                  )}
                  <button
                    aria-describedby="time-evaluation-monthly-download-status"
                    className="time-evaluation-monthly-download-button"
                    disabled={!arePayrollMonthExportsAvailable || isDownloadingAllPayrollMonthXlsx}
                    title={arePayrollMonthExportsAvailable
                      ? `Abgeschlossene Monatsabrechnungen aller Monteure (v${payrollMonthVersion}) herunterladen`
                      : "Der Download ist nach einem erfolgreichen Monatsabschluss verfügbar."}
                    type="button"
                    onClick={() => void downloadAllPayrollMonthXlsx()}
                  >
                    <Download aria-hidden="true" size={14} />
                    <span>{isDownloadingAllPayrollMonthXlsx ? "Wird erstellt..." : "Alle Monteure"}</span>
                  </button>
                </div>
                {payrollMonthPeriodError && <p className="payroll-month-status-error" role="alert">{payrollMonthPeriodError}</p>}
                <span aria-live="polite" className="sr-only" id="time-evaluation-monthly-download-status">
                  {isDownloadingAllPayrollMonthXlsx || isDownloadingPayrollMonthXlsx
                    ? "Die Excel-Monatsabrechnung wird erstellt."
                    : arePayrollMonthExportsAvailable
                      ? `Excel-Monatsabrechnungen aus Snapshot v${payrollMonthVersion} sind zum Download verfügbar.`
                      : "Excel-Monatsabrechnungen sind erst nach dem Monatsabschluss verfügbar."}
                </span>
                <h3 className="sr-only" id="time-evaluation-export-heading">Monatsabrechnung</h3>
              </div>
            </div>
          </div>
          {activeEvaluationSubtab === "workers" ? (
            <>
              <MonthlyPayrollWorkerWorkspace
              days={selectedEvaluationMonthDays}
              expandedDayKeys={expandedEvaluationDayKeys}
              filteredWorkers={filteredEvaluationWorkers}
              filter={evaluationWorkerFilter}
              filterCounts={evaluationWorkerFilterCounts}
              isLoading={isLoadingPeople || isLoadingReviewAllEntries || !isEvaluationDataReady}
              isReady={isEvaluationDataReady}
              canManageTimeEntries={canManageTimeEntries && !isPayrollMonthLocked && !isSelectedPayrollPersonApproved}
              onChangeFilter={setEvaluationWorkerFilter}
              onChangeSearch={setEvaluationWorkerSearch}
              onOpenLocationDiagnostic={openLocationReviewDiagnostic}
              onOpenEntryActions={togglePayrollDatePicker}
              onOpenTimeDiagnostic={openTimeReviewDiagnostic}
              onUpdateOvernight={(personId, workDate, status) => updatePayrollOvernightStatus(personId, workDate, status)}
              onSelectWorker={setSelectedEvaluationPersonId}
              onToggleDay={toggleEvaluationDay}
              onToggleReview={(entry) => void togglePayrollRowReview(entry)}
              search={evaluationWorkerSearch}
              selectedWorker={selectedEvaluationWorker}
              />
              {payrollMonthDownloadError && <p className="time-table-note">{payrollMonthDownloadError}</p>}
              {payrollDatePicker && activePayrollDatePickerEntry && typeof document !== "undefined" && createPortal(
                <div
                  className={`time-review-day-move-popover${payrollDatePicker.position ? ` is-open-${payrollDatePicker.position.placement}` : ""}`}
                  ref={payrollDatePickerMenuRef}
                  role="menu"
                  aria-label="Aktionen für Zeiteintrag"
                  style={{
                    left: `${payrollDatePicker.position?.left ?? payrollDatePicker.triggerLeft}px`,
                    top: `${payrollDatePicker.position?.top ?? payrollDatePicker.triggerBottom + 4}px`,
                    maxHeight: payrollDatePicker.position ? `${payrollDatePicker.position.maxHeight}px` : undefined,
                    maxWidth: payrollDatePicker.position ? `${payrollDatePicker.position.maxWidth}px` : undefined,
                    visibility: payrollDatePicker.position ? "visible" : "hidden",
                  }}
                >
                  {activeReviewDayOptions.map((option) => (
                    <button className={option.date === activePayrollDatePickerEntry.work_date ? "is-selected" : ""} key={option.date} type="button" role="menuitemradio" aria-checked={option.date === activePayrollDatePickerEntry.work_date} onClick={() => void movePayrollEntryDate(activePayrollDatePickerEntry, option.date)}>
                      {option.label}
                    </button>
                  ))}
                  <button className="time-review-day-delete-action" type="button" role="menuitem" onClick={() => openPayrollDeleteDialog(activePayrollDatePickerEntry)}><Trash2 aria-hidden="true" size={13} />Eintrag löschen</button>
                </div>,
                document.body,
              )}
            </>
          ) : (
            <PayrollSiteCockpit
              data={isPayrollSiteCockpitReady ? payrollSiteCockpit : null}
              error={payrollSiteCockpitError}
              isLoading={isLoadingPayrollSiteCockpit || (!isPayrollSiteCockpitReady && payrollSiteCockpitError === null)}
              onRetry={() => setPayrollSiteCockpitRefreshKey((current) => current + 1)}
            />
          )}
        </div>
      )}

      {timeReviewDiagnosticEntry && (
        <div
          className="time-review-diagnostic-backdrop"
          role="presentation"
          onClick={closeTimeReviewDiagnostic}
        >
          <div
            className={`time-review-diagnostic-popover${timeReviewDialogMode === "create" ? " is-create" : ""}`}
            role="dialog"
            aria-label={timeReviewDialogMode === "create" ? "Zeit manuell eintragen" : "Arbeitszeit-Diagnose"}
            aria-modal="true"
            style={timeReviewPopupTop === null ? undefined : {
              maxHeight: `calc(100vh - ${timeReviewPopupTop}px - 24px)`,
              top: `${timeReviewPopupTop}px`,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="time-review-diagnostic-head">
              <div>
                <span>Lohnprüfung</span>
                <h4 id="time-review-diagnostic-title">{timeReviewDialogMode === "create" ? "Zeit manuell eintragen" : "Arbeitszeit manuell anpassen"}</h4>
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
            {timeReviewDialogMode === "create" ? (
              <form
                className="time-review-manual-form"
                id="payroll-manual-time-entry-form"
                aria-labelledby="time-review-diagnostic-title"
                onSubmit={submitPayrollManualTimeEntry}
              >
                <div className="time-review-manual-context">
                  <div>
                    <span>Monteur</span>
                    <strong>{timeReviewDiagnosticEntry.person_name}</strong>
                  </div>
                  <div className="time-review-manual-field">
                    <span id="payroll-manual-date-label">Datum</span>
                    <DashboardNotePicker
                      emptyOptionLabel="Datum auswählen"
                      emptyText="Kein Datum gefunden"
                      disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                      error={null}
                      errorText="Datum konnte nicht geladen werden."
                      includeEmptyOption={false}
                      labelId="payroll-manual-date-label"
                      listLabel="Datum auswählen"
                      loading={false}
                      loadingText="Datum wird geladen..."
                      options={payrollManualDateOptions}
                      searchable={false}
                      value={payrollManualWorkDate}
                      onChange={(value) => {
                        setPayrollManualWorkDate(value);
                        setPayrollCorrectionError(null);
                      }}
                    />
                  </div>
                </div>
                <div className="time-review-manual-site-field">
                  <span id="payroll-manual-site-label">Baustelle *</span>
                  <DashboardNotePicker
                    emptyOptionLabel="Baustelle auswählen"
                    emptyText="Keine Baustelle gefunden"
                    disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                    error={sitesError}
                    errorText="Baustellen konnten nicht geladen werden."
                    includeEmptyOption={false}
                    labelId="payroll-manual-site-label"
                    listLabel="Baustelle auswählen"
                    loading={isLoadingSites}
                    loadingText="Baustellen werden geladen..."
                    options={payrollManualSiteOptions}
                    searchLabel="Baustelle suchen"
                    searchPlaceholder="Nummer, Name oder Ort suchen…"
                    value={payrollManualSiteId}
                    onChange={(value) => {
                      setPayrollManualSiteId(value);
                      setPayrollManualSiteError(null);
                      setPayrollCorrectionError(null);
                    }}
                  />
                  {payrollManualSiteError && (
                    <small className="time-review-manual-field-error" role="alert">{payrollManualSiteError}</small>
                  )}
                </div>
                <div className="time-review-manual-time-grid">
                  <label>
                    <span>Anfang Arbeitszeit</span>
                    <input
                      type="time"
                      value={payrollCorrectionForm.start_time}
                      onChange={(event) => updatePayrollTimeBasis("start_time", event.target.value)}
                      disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                    />
                  </label>
                  <label>
                    <span>Ende Arbeitszeit</span>
                    <input
                      type="time"
                      value={payrollCorrectionForm.end_time}
                      onChange={(event) => updatePayrollTimeBasis("end_time", event.target.value)}
                      disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                    />
                  </label>
                  <label>
                    <span>Pause (Min.)</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      value={payrollCorrectionForm.break_minutes}
                      onChange={(event) => updatePayrollTimeBasis("break_minutes", event.target.value)}
                      disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                    />
                  </label>
                  <label>
                    <span>Gesamtstunden</span>
                    <input
                      className="time-review-manual-calculated-hours"
                      type="text"
                      value={payrollManualTimeCalculation.status === "valid" ? payrollManualTimeCalculation.formattedHours : "–"}
                      readOnly
                    />
                  </label>
                </div>
              </form>
            ) : (
              <div className="time-review-diagnostic-table" role="table" aria-label="Arbeitszeit-Diagnosewerte">
                <div className="time-review-diagnostic-row is-head" role="row">
                  <span role="columnheader" aria-label="Zeilenbezeichnung" />
                  <span role="columnheader">Anfang Arbeitszeit</span>
                  <span role="columnheader">Ende Arbeitszeit</span>
                  <span role="columnheader">Pause</span>
                  <span role="columnheader">Gesamtstunden</span>
                </div>
                {timeReviewDiagnosticRows(timeReviewDiagnosticEntry).map((row) => (
                  <div className="time-review-diagnostic-row" key={row.source} role="row">
                    <strong role="cell">{row.source}</strong>
                    <span role="cell">{row.start}</span>
                    <span role="cell">{row.end}</span>
                    <span role="cell">{row.break}</span>
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
                      onChange={(event) => updatePayrollTimeBasis("start_time", event.target.value)}
                      disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                    />
                  </label>
                  <label role="cell">
                    <span className="sr-only">Ende Arbeitszeit Büro geprüft</span>
                    <input
                      type="time"
                      value={payrollCorrectionForm.end_time}
                      onChange={(event) => updatePayrollTimeBasis("end_time", event.target.value)}
                      disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                    />
                  </label>
                  <label role="cell">
                    <span className="sr-only">Pause Büro geprüft in Minuten</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      placeholder="Min."
                      value={payrollCorrectionForm.break_minutes}
                      onChange={(event) => updatePayrollTimeBasis("break_minutes", event.target.value)}
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
                      onChange={(event) => {
                        setPayrollCorrectionError(null);
                        setPayrollCorrectionForm((current) => ({ ...current, hours: event.target.value }));
                      }}
                      readOnly={calculatePayrollTime(payrollCorrectionForm).status === "valid"}
                      disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                    />
                  </label>
                </div>
              </div>
            )}
            {timeReviewDialogMode === "edit" && isCurrentLocalDateInput(timeReviewDiagnosticEntry.work_date) && (
              <p className="time-review-diagnostic-note">GPS-Auswertung für den aktuellen Tag erst ab morgen verfügbar.</p>
            )}
            <div className="time-review-diagnostic-actions">
              {payrollCorrectionError && <p className="time-review-diagnostic-error">{payrollCorrectionError}</p>}
              <button
                className="icon-button secondary time-review-diagnostic-cancel"
                type="button"
                disabled={isSavingPayrollCorrection}
                onClick={closeTimeReviewDiagnostic}
              >
                Abbrechen
              </button>
              <button
                className="icon-button time-review-diagnostic-save"
                form={timeReviewDialogMode === "create" ? "payroll-manual-time-entry-form" : undefined}
                type={timeReviewDialogMode === "create" ? "submit" : "button"}
                disabled={!canManageTimeEntries || isSavingPayrollCorrection}
                onClick={timeReviewDialogMode === "create" ? undefined : () => void savePayrollTimeCorrection()}
              >
                {timeReviewDialogMode === "create"
                  ? (isSavingPayrollCorrection ? "Zeit wird gespeichert..." : "Zeit speichern")
                  : (isSavingPayrollCorrection ? "Bürozeit wird gespeichert..." : "Bürozeit speichern")}
              </button>
            </div>
          </div>
        </div>
      )}

      {payrollDeleteDialog && (
        <div className="time-review-delete-backdrop" role="presentation" onClick={closePayrollDeleteDialog}>
          <div
            className="time-review-delete-dialog"
            role="alertdialog"
            aria-labelledby="time-review-delete-title"
            aria-describedby="time-review-delete-description"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="time-review-delete-head">
              <div>
                <span>Lohnprüfung</span>
                <h4 id="time-review-delete-title">Zeiteintrag löschen?</h4>
              </div>
              <button
                type="button"
                aria-label="Dialog schließen"
                disabled={isDeletingPayrollEntry}
                onClick={closePayrollDeleteDialog}
              >
                ×
              </button>
            </div>
            <div className="time-review-delete-content" id="time-review-delete-description">
              <strong>{payrollDeleteDialog.entry.person_name}</strong>
              <span>{formatDetailDate(payrollDeleteDialog.entry.work_date)}</span>
              {payrollDeleteSiteLabel(payrollDeleteDialog.entry) && (
                <span>{payrollDeleteSiteLabel(payrollDeleteDialog.entry)}</span>
              )}
              {payrollDeleteTimeRange(payrollDeleteDialog.entry) && (
                <span>{payrollDeleteTimeRange(payrollDeleteDialog.entry)}</span>
              )}
              {effectivePayrollWorkMinutes(payrollDeleteDialog.entry) !== null && (
                <span>{formatTimeEntryMinutes(effectivePayrollWorkMinutes(payrollDeleteDialog.entry), "hours")}</span>
              )}
              <p>Dieser Zeiteintrag wird vollständig gelöscht.</p>
              {payrollDeleteDialog.weeklyReviewed && (
                <p className="time-review-delete-warning">
                  <strong>Diese Monteurwoche wurde bereits geprüft.</strong>
                  Durch das Löschen wird der Prüfstatus zurückgesetzt und die Stundenkonto-Buchung neutralisiert. Die Woche muss anschließend erneut geprüft werden.
                </p>
              )}
              {payrollDeleteError && <p className="time-review-delete-error">{payrollDeleteError}</p>}
            </div>
            <div className="time-review-delete-actions">
              <button type="button" disabled={isDeletingPayrollEntry} onClick={closePayrollDeleteDialog}>
                Abbrechen
              </button>
              <button
                className="is-destructive"
                type="button"
                disabled={isDeletingPayrollEntry}
                onClick={() => void confirmPayrollEntryDeletion()}
              >
                {isDeletingPayrollEntry ? "Eintrag wird gelöscht..." : "Eintrag löschen"}
              </button>
            </div>
          </div>
        </div>
      )}

      {payrollPersonMonthDialog && selectedEvaluationWorker && (
        <div
          className="payroll-month-dialog-backdrop"
          role="presentation"
          onClick={isUpdatingPayrollPersonMonth ? undefined : () => {
            setPayrollPersonMonthDialog(null);
            setHasAcknowledgedPayrollPersonBlockers(false);
          }}
        >
          <div
            aria-describedby="payroll-person-month-dialog-description"
            aria-labelledby="payroll-person-month-dialog-title"
            aria-modal="true"
            className="payroll-month-dialog"
            role="alertdialog"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <span>Lohnprüfung</span>
              <h2 id="payroll-person-month-dialog-title">
                {payrollPersonMonthDialog === "approve"
                  ? "Monteurmonat abschließen"
                  : "Monteurmonat wieder öffnen"}
              </h2>
            </header>
            <div className="payroll-month-dialog-content" id="payroll-person-month-dialog-description">
              {payrollPersonMonthDialog === "approve" ? (
                <>
                  <p>Möchtest du die Monatsabrechnung von {selectedEvaluationWorker.personName} für {formatPayrollMonthLabel(selectedEvaluationMonth)} als geprüft markieren?</p>
                  <p>Der aktuelle Stand wird eingefroren. {selectedPayrollPersonBlockers.length > 0 ? `${selectedPayrollPersonBlockers.length} offene Hinweise werden dabei nachvollziehbar als bewusst akzeptiert dokumentiert.` : "Es liegen keine offenen Hinweise vor."}</p>
                  {selectedPayrollPersonBlockers.length > 0 && (
                    <label className="payroll-person-month-acknowledgement">
                      <input
                        checked={hasAcknowledgedPayrollPersonBlockers}
                        disabled={isUpdatingPayrollPersonMonth}
                        type="checkbox"
                        onChange={(event) => setHasAcknowledgedPayrollPersonBlockers(event.target.checked)}
                      />
                      <span>Ich habe die offenen Hinweise geprüft und bestätige den aktuellen Stand trotzdem.</span>
                    </label>
                  )}
                </>
              ) : (
                <>
                  <p>Die bestehende Freigabe von {selectedEvaluationWorker.personName} für {formatPayrollMonthLabel(selectedEvaluationMonth)} bleibt im Audit-Protokoll erhalten. Danach muss der Monteurmonat erneut geprüft werden.</p>
                  <label>
                    <span>Begründung *</span>
                    <textarea
                      autoFocus
                      disabled={isUpdatingPayrollPersonMonth}
                      maxLength={1000}
                      placeholder="Warum muss der Monteurmonat wieder geöffnet werden?"
                      rows={4}
                      value={payrollPersonMonthReopenReason}
                      onChange={(event) => setPayrollPersonMonthReopenReason(event.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
            {payrollMonthPeriodError && <p className="payroll-month-dialog-error" role="alert">{payrollMonthPeriodError}</p>}
            <footer>
              <button
                className="secondary"
                disabled={isUpdatingPayrollPersonMonth}
                type="button"
                onClick={() => {
                  setPayrollPersonMonthDialog(null);
                  setHasAcknowledgedPayrollPersonBlockers(false);
                }}
              >
                Abbrechen
              </button>
              <button
                className={payrollPersonMonthDialog === "reopen" ? "is-warning" : ""}
                disabled={
                  isUpdatingPayrollPersonMonth
                  || (payrollPersonMonthDialog === "reopen" && !payrollPersonMonthReopenReason.trim())
                  || (payrollPersonMonthDialog === "approve" && selectedPayrollPersonBlockers.length > 0 && !hasAcknowledgedPayrollPersonBlockers)
                }
                type="button"
                onClick={() => void (payrollPersonMonthDialog === "approve" ? confirmPayrollPersonMonthApproval() : confirmPayrollPersonMonthReopen())}
              >
                {isUpdatingPayrollPersonMonth
                  ? "Wird verarbeitet..."
                  : payrollPersonMonthDialog === "approve"
                    ? "Monteurmonat abschließen"
                    : "Monteurmonat wieder öffnen"}
              </button>
            </footer>
          </div>
        </div>
      )}

      {payrollMonthDialog && payrollMonthPeriod && (
        <div
          className="payroll-month-dialog-backdrop"
          role="presentation"
          onClick={isUpdatingPayrollMonth ? undefined : () => setPayrollMonthDialog(null)}
        >
          <div
            aria-describedby="payroll-month-dialog-description"
            aria-labelledby="payroll-month-dialog-title"
            aria-modal="true"
            className="payroll-month-dialog"
            role="alertdialog"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <span>Lohnprüfung</span>
              <h2 id="payroll-month-dialog-title">
                {payrollMonthDialog === "lock"
                  ? `Monat ${formatPayrollMonthLabel(selectedEvaluationMonth)} abschließen?`
                  : `Monat ${formatPayrollMonthLabel(selectedEvaluationMonth)} wieder öffnen?`}
              </h2>
            </header>
            <div className="payroll-month-dialog-content" id="payroll-month-dialog-description">
              {payrollMonthDialog === "lock" ? (
                <>
                  <p>Alle abrechnungsrelevanten Daten dieses Monats werden anschließend in sämtlichen Ansichten gesperrt.</p>
                  <p>Die Excel-Dateien werden unveränderlich aus dem abgeschlossenen Snapshot erzeugt.</p>
                </>
              ) : (
                <>
                  <p>Die bestehende Abrechnungsversion bleibt im Protokoll erhalten, ist danach aber nicht mehr die aktuelle freigegebene Version. Nach den Änderungen muss der Monat erneut geprüft und gesperrt werden.</p>
                  <label>
                    <span>Begründung *</span>
                    <textarea
                      autoFocus
                      disabled={isUpdatingPayrollMonth}
                      maxLength={1000}
                      placeholder="Warum muss der Monat wieder geöffnet werden?"
                      rows={4}
                      value={payrollMonthReopenReason}
                      onChange={(event) => setPayrollMonthReopenReason(event.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
            {payrollMonthPeriodError && <p className="payroll-month-dialog-error" role="alert">{payrollMonthPeriodError}</p>}
            <footer>
              <button
                className="secondary"
                disabled={isUpdatingPayrollMonth}
                type="button"
                onClick={() => setPayrollMonthDialog(null)}
              >
                Abbrechen
              </button>
              <button
                className={payrollMonthDialog === "reopen" ? "is-warning" : ""}
                disabled={isUpdatingPayrollMonth || (payrollMonthDialog === "reopen" && !payrollMonthReopenReason.trim())}
                type="button"
                onClick={() => void (payrollMonthDialog === "lock" ? confirmPayrollMonthLock() : confirmPayrollMonthReopen())}
              >
                {isUpdatingPayrollMonth
                  ? "Wird verarbeitet..."
                  : payrollMonthDialog === "lock"
                    ? "Monat verbindlich abschließen"
                    : "Monat wieder öffnen"}
              </button>
            </footer>
          </div>
        </div>
      )}

      <PayrollSetupDialog
        open={isPayrollSetupOpen && canManagePayrollClose}
        onClose={() => setIsPayrollSetupOpen(false)}
        onSetupChanged={() => setPayrollMonthPeriodRefreshKey((current) => current + 1)}
      />

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
                <span>Lohnprüfung</span>
                <h4>Ort manuell korrigieren – {formatTimeEntryRange(locationReviewDiagnosticEntry)}</h4>
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
              {locationReviewDiagnosticRows(
                locationReviewDiagnosticEntry,
                sites,
                hasLocationReviewSitePreview ? locationReviewSiteId : null,
              ).map((row) => (
                <div className="time-review-diagnostic-row is-location" key={row.source} role="row">
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
                  ref={locationReviewPickerTriggerRef}
                  className="time-review-location-change"
                  type="button"
                  aria-expanded={isLocationReviewPickerOpen}
                  aria-controls={isLocationReviewPickerOpen ? "time-review-location-picker" : undefined}
                  disabled={!canManageTimeEntries || isSavingLocationReview}
                  onClick={toggleLocationReviewPicker}
                >
                  {isLocationReviewPickerOpen ? "Auswahl schliessen" : "Baustelle manuell anpassen"}
                </button>
              </div>
              {isLocationReviewPickerOpen && (
                <div className="time-review-location-picker" id="time-review-location-picker" aria-label="Baustelle manuell auswählen">
                  <section className="time-review-location-picker-panel">
                    <label className="time-review-location-search">
                      <span>Baustelle suchen</span>
                      <input
                        aria-activedescendant={locationReviewActiveOptionId}
                        aria-autocomplete="list"
                        aria-controls={locationReviewActiveListboxId}
                        aria-expanded={isLocationReviewPickerOpen}
                        role="combobox"
                        type="search"
                        placeholder="Kommission oder Baustellenname"
                        value={locationReviewSiteSearch}
                        onChange={(event) => setLocationReviewSiteSearch(event.target.value)}
                        onKeyDown={handleLocationReviewPickerKeyDown}
                        disabled={!canManageTimeEntries || isSavingLocationReview}
                      />
                    </label>
                    {locationReviewSiteSearch.trim() && (
                      <div
                        className="time-review-location-suggestions"
                        id="time-review-location-search-results"
                        role="listbox"
                        aria-label="Baustellenvorschläge"
                        aria-activedescendant={locationReviewActiveSiteId
                          ? `time-review-location-search-results-option-${locationReviewActiveSiteId}`
                          : undefined}
                        tabIndex={0}
                        onKeyDown={handleLocationReviewPickerKeyDown}
                      >
                        {locationReviewSiteSearchResults.length ? (
                          locationReviewSiteSearchResults.map((site) => (
                            <div
                              className={`time-review-location-option${String(site.id) === locationReviewSiteId ? " is-selected" : ""}${String(site.id) === locationReviewActiveSiteId ? " is-active" : ""}`}
                              id={`time-review-location-search-results-option-${site.id}`}
                              key={site.id}
                              role="option"
                              aria-selected={String(site.id) === locationReviewSiteId}
                              aria-disabled={!canManageTimeEntries || isSavingLocationReview}
                              onClick={() => selectLocationReviewSite(String(site.id), true)}
                            >
                              <strong>{site.site_number || `Baustelle ${site.id}`}</strong>
                              <span>{site.name}</span>
                            </div>
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
                    <div
                      className="time-review-location-site-list"
                      id="time-review-location-all-options"
                      role="listbox"
                      aria-label="Alle auswählbaren Baustellen"
                      aria-activedescendant={locationReviewActiveSiteId
                        ? `time-review-location-all-options-option-${locationReviewActiveSiteId}`
                        : undefined}
                      tabIndex={0}
                      onKeyDown={handleLocationReviewPickerKeyDown}
                    >
                      {locationReviewSiteOptions.map((site) => (
                        <div
                          className={`time-review-location-option${String(site.id) === locationReviewSiteId ? " is-selected" : ""}${String(site.id) === locationReviewActiveSiteId ? " is-active" : ""}`}
                          id={`time-review-location-all-options-option-${site.id}`}
                          key={site.id}
                          role="option"
                          aria-selected={String(site.id) === locationReviewSiteId}
                          aria-disabled={!canManageTimeEntries || isSavingLocationReview}
                          onClick={() => selectLocationReviewSite(String(site.id))}
                        >
                          <strong>{site.site_number || `Baustelle ${site.id}`}</strong>
                          <span>{site.name}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </div>
            <div className="time-review-diagnostic-actions">
              {locationReviewError && <p className="time-review-diagnostic-error">{locationReviewError}</p>}
              <button
                className="icon-button secondary time-review-diagnostic-cancel"
                type="button"
                disabled={isSavingLocationReview}
                onClick={closeLocationReviewDiagnostic}
              >
                Abbrechen
              </button>
              <button
                className="icon-button time-review-diagnostic-save"
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

function formatPayrollMonthLabel(selection: CalendarMonthSelection): string {
  return new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" }).format(
    new Date(selection.year, selection.month - 1, 1),
  );
}

function formatPayrollApprovalTimestamp(value: string): string {
  return `${formatDetailDate(value)} um ${formatTime(value)}`;
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
      TIME_REVIEW_API_REVIEW_WEEK,
      TIME_REVIEW_API_ABSENCES,
      TIME_REVIEW_API_PAYROLL_WEEK,
      TIME_REVIEW_API_MONTH_LOCKS,
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

function PayrollReviewTableHeaders() {
  return (
    <>
      <div className="time-review-week-check-group-head" role="row">
        <span aria-hidden="true"></span>
        <span className="time-review-column-group is-order" role="columnheader" aria-colspan={3} aria-label="Spaltengruppe Auftrag">Auftrag</span>
        <span className="time-review-column-group is-work-time" role="columnheader" aria-colspan={4} aria-label="Spaltengruppe Arbeitszeit">Arbeitszeit</span>
        <span className="time-review-column-group is-status" role="columnheader" aria-colspan={3} aria-label="Spaltengruppe Prüfung und Status">Prüfung / Status</span>
      </div>
      <div className="time-review-week-check-head" role="row">
        <span role="columnheader" aria-label="Tag ändern"></span>
        <span className="time-review-column-day" role="columnheader" aria-label="Tag" title="Tag"><span className="time-review-column-label-full">Tag</span><span className="time-review-column-label-short" aria-hidden="true">TG</span></span>
        <span className="time-review-column-type" role="columnheader" aria-label="Eintragstyp" title="Eintragstyp"><span className="time-review-column-label-full">Typ</span><span className="time-review-column-label-short" aria-hidden="true">TYP</span></span>
        <span role="columnheader" aria-label="Baustelle" title="Baustelle"><span className="time-review-column-label-full">Baustelle</span><span className="time-review-column-label-short" aria-hidden="true">BS</span></span>
        <span className="time-review-column-work-time-start" role="columnheader" aria-label="Beginn" title="Beginn"><span className="time-review-column-label-full">Beginn</span><span className="time-review-column-label-short" aria-hidden="true">MA</span></span>
        <span role="columnheader" aria-label="Ende" title="Ende"><span className="time-review-column-label-full">Ende</span><span className="time-review-column-label-short" aria-hidden="true">ME</span></span>
        <span role="columnheader" aria-label="Pause" title="Pause"><span className="time-review-column-label-full">Pause</span><span className="time-review-column-label-short" aria-hidden="true">PA</span></span>
        <span role="columnheader" aria-label="Montagezeit" title="Montagezeit"><span className="time-review-column-label-full">Montagezeit</span><span className="time-review-column-label-short" aria-hidden="true">MZ</span></span>
        <span className="time-review-column-status-start" role="columnheader" aria-label="Ort" title="Ort"><span className="time-review-column-label-full">Ort</span><span className="time-review-column-label-short" aria-hidden="true">O</span></span>
        <span role="columnheader" aria-label="Arbeitszeit" title="Arbeitszeit"><span className="time-review-column-label-full">Arbeitszeit</span><span className="time-review-column-label-short" aria-hidden="true">AZ</span></span>
        <span role="columnheader" aria-label="Geprüft" title="Geprüft"><span className="time-review-column-label-full">Geprüft</span><span className="time-review-column-label-short" aria-hidden="true">GP</span></span>
      </div>
    </>
  );
}

function PayrollPersonMonthClosePanel({
  approval,
  blockers,
  canApprove,
  canReopen,
  disabledReason,
  isDownloadingWorkerExport,
  isExportAvailable,
  isLoading,
  isLogExpanded,
  isUpdating,
  month,
  onDownloadWorkerExport,
  onOpenApprove,
  onOpenReopen,
  onOpenWorkingTime,
  onToggleLog,
  selectedWorker,
}: {
  approval: PayrollMonthPersonApproval | null;
  blockers: PayrollMonthBlocker[];
  canApprove: boolean;
  canReopen: boolean;
  disabledReason: string | null;
  isDownloadingWorkerExport: boolean;
  isExportAvailable: boolean;
  isLoading: boolean;
  isLogExpanded: boolean;
  isUpdating: boolean;
  month: CalendarMonthSelection;
  onDownloadWorkerExport: () => void;
  onOpenApprove: () => void;
  onOpenReopen: () => void;
  onOpenWorkingTime: (personId: number) => void;
  onToggleLog: () => void;
  selectedWorker: TimeReviewWorkerSummary | null;
}) {
  const isApproved = approval?.status === "APPROVED";
  const canToggleApproval = selectedWorker !== null && (isApproved ? canReopen : canApprove);
  const statusClass = isApproved ? "is-approved" : blockers.length > 0 ? "is-warning" : selectedWorker ? "is-ready" : "is-neutral";
  const statusText = selectedWorker
    ? isApproved
      ? "Monteurmonat geprüft"
      : blockers.length > 0
        ? `${blockers.length} ${blockers.length === 1 ? "Prüfpunkt offen" : "Prüfpunkte offen"}`
        : "Keine offenen Prüfpunkte"
    : "Monteur auswählen";
  const firstBlocker = blockers[0] ?? null;
  const visibleBlockers = isLogExpanded ? blockers : blockers.slice(0, 1);
  const canToggleLog = blockers.length > 1;
  const approvedMeta = approval?.approved_at
    ? `Geprüft am ${formatPayrollApprovalTimestamp(approval.approved_at)}${approval.approved_by_name ? ` von ${approval.approved_by_name}` : ""}.`
    : null;
  const downloadDisabled = !selectedWorker || !isExportAvailable || isDownloadingWorkerExport;
  const downloadTitle = !selectedWorker
    ? "Monteur auswählen, um die Monatsabrechnung herunterzuladen."
    : isExportAvailable
      ? "Geprüfte Einzelabrechnung des Monteurmonats herunterladen."
      : isApproved
        ? approval?.export_message ?? "Für diesen geprüften Stand ist keine Excel-Datei verfügbar."
        : "Der Download ist nach dem Monteurabschluss verfügbar.";

  useEffect(() => {
    if (!isLogExpanded) {
      return;
    }

    function closeLogOnEscape(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        onToggleLog();
      }
    }

    document.addEventListener("keydown", closeLogOnEscape);
    return () => document.removeEventListener("keydown", closeLogOnEscape);
  }, [isLogExpanded, onToggleLog]);

  return (
    <section className="payroll-person-month-close" aria-busy={isLoading || isUpdating}>
      <div className="payroll-person-month-close-main">
        <div className="payroll-person-month-identity">
          <span>Monteurabschluss</span>
          <h2>{selectedWorker?.personName ?? "Monteur auswählen"}</h2>
          <p>
            {selectedWorker
              ? `${formatPayrollMonthLabel(month)} · ${formatSubmittedHours(selectedWorker.submittedMinutes)} Std.`
              : "Wähle links einen Monteur aus, um den Monatsabschluss zu prüfen."}
          </p>
        </div>
        <div className={`payroll-person-month-status ${statusClass}`} role="status">
          {statusText}
        </div>
        <div className="payroll-person-month-actions">
          <label
            className={`payroll-person-month-toggle${isApproved ? " is-checked" : ""}`}
            title={disabledReason ?? undefined}
          >
            <input
              aria-describedby={disabledReason ? "payroll-person-month-toggle-reason" : undefined}
              checked={isApproved}
              disabled={!canToggleApproval || isUpdating}
              type="checkbox"
              onChange={() => (isApproved ? onOpenReopen() : onOpenApprove())}
            />
            <span className="payroll-person-month-check" aria-hidden="true">
              {isApproved ? <Check size={13} strokeWidth={3} /> : null}
            </span>
            <span>Monteurmonat geprüft</span>
          </label>
          {disabledReason && selectedWorker ? (
            <small className="payroll-person-month-disabled-reason" id="payroll-person-month-toggle-reason">
              {disabledReason}
            </small>
          ) : null}
          <button
            className="time-evaluation-monthly-download-button payroll-person-month-download-button"
            disabled={downloadDisabled}
            title={downloadTitle}
            type="button"
            onClick={onDownloadWorkerExport}
          >
            <Download aria-hidden="true" size={14} />
            <span>{isDownloadingWorkerExport ? "Wird erstellt..." : "Excel herunterladen"}</span>
          </button>
          {isApproved && !isExportAvailable && approval?.export_message ? (
            <small className="payroll-person-month-export-status">{approval.export_message}</small>
          ) : null}
        </div>
      </div>
      <div className="payroll-person-month-log-anchor">
        <div className={`payroll-person-month-log ${statusClass}`}>
          <div className="payroll-person-month-log-summary">
            {statusClass === "is-warning" ? <AlertTriangle aria-hidden="true" size={15} /> : <Check aria-hidden="true" size={15} />}
            <span>
              {selectedWorker
                ? isApproved
                  ? blockers.length > 0
                    ? `${blockers.length} ${blockers.length === 1 ? "Prüfpunkt wurde" : "Prüfpunkte wurden"} im Monteurabschluss geprüft.`
                    : approvedMeta ?? "Monteurabschluss wurde geprüft."
                  : firstBlocker
                    ? `${blockers.length} ${blockers.length === 1 ? "Hinweis zum Stand" : "Hinweise zum Stand"} · ${firstBlocker.code === "schedule_missing" ? "Regelmäßige Arbeitszeit fehlt · " : ""}${formatPayrollBlockerDateContext(firstBlocker)} · ${firstBlocker.message}`
                    : "Keine offenen Hinweise. Der Monteurmonat kann abgeschlossen werden."
                : "Wähle links einen Monteur aus, um den Monatsabschluss zu prüfen."}
            </span>
          </div>
          <div className="payroll-person-month-log-actions">
            {!isApproved && firstBlocker?.code === "schedule_missing" && firstBlocker.person_id ? (
              <button type="button" onClick={() => onOpenWorkingTime(firstBlocker.person_id!)}>Arbeitszeit festlegen</button>
            ) : null}
            {canToggleLog && (
              <button
                aria-controls="payroll-person-month-log-flyout"
                aria-expanded={isLogExpanded}
                type="button"
                onClick={onToggleLog}
              >
                {isLogExpanded ? "Weniger anzeigen" : "Alle anzeigen"}
                <ChevronRight aria-hidden="true" size={14} />
              </button>
            )}
          </div>
        </div>
        {isLogExpanded && visibleBlockers.length > 1 && (
          <div
            aria-label={`Alle ${visibleBlockers.length} Prüfpunkte`}
            className="payroll-person-month-log-flyout"
            id="payroll-person-month-log-flyout"
            role="region"
          >
            <div className="payroll-person-month-log-flyout-header">
              <strong>Prüfpunkte ({visibleBlockers.length})</strong>
              <button aria-label="Prüfpunkte schließen" type="button" onClick={onToggleLog}>
                <X aria-hidden="true" size={15} />
              </button>
            </div>
            <div className="payroll-person-month-log-list" role="list">
              {visibleBlockers.map((blocker, index) => (
                <div className="payroll-person-month-log-entry" key={`${blocker.code}-${blocker.work_date ?? "month"}-${index}`} role="listitem">
                  <span>{formatPayrollBlockerDateContext(blocker)}</span>
                  <strong>{blocker.code === "schedule_missing" ? "Regelmäßige Arbeitszeit fehlt" : "Prüfhinweis"}</strong>
                  <p>{blocker.message}</p>
                  {blocker.code === "schedule_missing" && blocker.person_id ? (
                    <button type="button" onClick={() => onOpenWorkingTime(blocker.person_id!)}>Arbeitszeit festlegen</button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function formatPayrollBlockerDateContext(blocker: PayrollMonthBlocker): string {
  const start = formatPayrollMonthWorkDateContext(blocker.work_date);
  if (!blocker.work_date_end || blocker.work_date_end === blocker.work_date) {
    return start;
  }
  return `${start} bis ${formatDetailDate(blocker.work_date_end)}`;
}

function MonthlyPayrollWorkerWorkspace({
  canManageTimeEntries,
  days,
  expandedDayKeys,
  filteredWorkers,
  filter,
  filterCounts,
  isLoading,
  isReady,
  onChangeFilter,
  onChangeSearch,
  onOpenEntryActions,
  onOpenLocationDiagnostic,
  onOpenTimeDiagnostic,
  onUpdateOvernight,
  onSelectWorker,
  onToggleDay,
  onToggleReview,
  search,
  selectedWorker,
}: {
  canManageTimeEntries: boolean;
  days: TimeReviewWeekDay[];
  expandedDayKeys: Set<string>;
  filteredWorkers: TimeReviewWorkerSummary[];
  filter: TimeReviewWorkerFilter;
  filterCounts: Record<TimeReviewWorkerFilter, number>;
  isLoading: boolean;
  isReady: boolean;
  onChangeFilter: (filter: TimeReviewWorkerFilter) => void;
  onChangeSearch: (value: string) => void;
  onOpenEntryActions: (entry: TimeEntry, button: HTMLButtonElement) => void;
  onOpenLocationDiagnostic: (entry: TimeEntry) => void;
  onOpenTimeDiagnostic: (entry: TimeEntry) => void;
  onUpdateOvernight: (personId: number, workDate: string, status: OvernightStatus) => Promise<void>;
  onSelectWorker: (personId: number) => void;
  onToggleDay: (date: string) => void;
  onToggleReview: (entry: TimeEntry) => void;
  search: string;
  selectedWorker: TimeReviewWorkerSummary | null;
}) {
  if (!isReady) {
    return (
      <div className="time-review-workspace-layout time-evaluation-worker-workspace" aria-busy="true">
        <div className="time-evaluation-workspace-loading" role="status">Monatsauswertung wird geladen...</div>
      </div>
    );
  }

  const weekGroups = groupTimeReviewMonthDays(days);

  return (
    <div className="time-review-workspace-layout time-evaluation-worker-workspace">
      <aside className="time-review-queue-panel" aria-label="Monteursliste für die Monatsauswertung">
        <label className="time-review-queue-search">
          <Search aria-hidden="true" size={15} />
          <input type="search" value={search} placeholder="Monteur suchen..." aria-label="Monteur suchen" onChange={(event) => onChangeSearch(event.currentTarget.value)} />
        </label>
        <div className="time-review-queue-filters" role="group" aria-label="Statusfilter">
          {([
            ["all", "Alle"],
            ["open", "Offen"],
            ["missing", "Keine Meldung"],
            ["reviewed", "Geprüft"],
          ] as const).map(([nextFilter, label]) => (
            <button className={filter === nextFilter ? "is-active" : ""} key={nextFilter} type="button" aria-pressed={filter === nextFilter} onClick={() => onChangeFilter(nextFilter)}>
              <span>{label}</span><small>{filterCounts[nextFilter]}</small>
            </button>
          ))}
        </div>
        <div className="time-review-queue-list" role="listbox" aria-label="Monteure für die Monatsauswertung">
          <div className="time-review-queue-columns" aria-hidden="true"><span>Monteur</span><span>Std. erfasst</span><span>Status</span></div>
          {isLoading && <div className="time-review-queue-state">Monatsauswertung wird geladen...</div>}
          {!isLoading && filteredWorkers.map((worker) => {
            const status = timeReviewWorkerStatus(worker);
            return (
              <button className={["time-review-queue-row", selectedWorker?.personId === worker.personId ? "is-active" : ""].filter(Boolean).join(" ")} key={worker.personId} type="button" role="option" aria-selected={selectedWorker?.personId === worker.personId} onClick={() => onSelectWorker(worker.personId)}>
                <span className="time-review-worker-name">{worker.personName}</span>
                <span className="time-review-queue-hours">{worker.submittedMinutes > 0 ? formatSubmittedHours(worker.submittedMinutes) + " Std." : "–"}</span>
                <span className={`time-review-queue-status${status === "reviewed" ? " time-review-reviewed-indicator" : ""} is-${status}`} aria-label={timeReviewWorkerStatusLabel(status)}>{status === "reviewed" ? "✓" : status === "open" ? "!" : "–"}</span>
              </button>
            );
          })}
          {!isLoading && !filteredWorkers.length && <div className="time-review-queue-state">Keine Monteure für diesen Filter.</div>}
        </div>
      </aside>
      <div className="time-review-detail-shell">
        {selectedWorker ? (
          <div className="time-review-worker-detail">
            <div className="time-review-week-check-table" role="table" aria-label={"Monatsprüfung " + selectedWorker.personName}>
              <PayrollReviewTableHeaders />
              {weekGroups.map((weekGroup) => (
                <div className="time-evaluation-week-group" key={weekGroup.key}>
                  <div className="time-evaluation-week-group-head">
                    <span className="time-evaluation-week-group-label">KW {weekGroup.week}</span>
                    <span className="time-evaluation-week-group-total time-review-work-time-cell">{formatMonthlyWeekHours(weekGroup.totalMinutes)} Std.</span>
                  </div>
                  {weekGroup.days.map((day) => {
                    const isExpanded = expandedDayKeys.has(day.date);
                    const dayPanelId = `evaluation-month-day-${day.date}`;
                    return (
                    <section className="time-review-day-group" key={day.date} role="rowgroup" aria-label={day.weekdayLabel + ", " + formatDate(day.date)}>
                  <div className="time-review-day-group-head" role="row">
                    <span className="time-review-day-group-label time-evaluation-day-group-label" role="rowheader">
                      <button className="time-evaluation-day-toggle" type="button" aria-expanded={isExpanded} aria-controls={dayPanelId} onClick={() => onToggleDay(day.date)}>
                        <ChevronRight className="time-evaluation-day-toggle-icon" aria-hidden="true" size={15} />
                        <span className="time-evaluation-day-toggle-label"><strong className="time-review-day-group-weekday">{day.weekdayLabel}</strong><span>{formatDate(day.date)}</span></span>
                      </button>
                      <span className="time-evaluation-day-status">
                        {day.entries.length > 0 && <PayrollOvernightStatusControl editable={canManageTimeEntries} hasConflict={day.hasOvernightStatusConflict} saving={false} status={day.overnightStatus} onChange={(status) => onUpdateOvernight(selectedWorker.personId, day.date, status)} />}
                        {!day.entries.length && day.absenceType && <StatusBadge tone={day.absenceType} className="time-review-absence-badge">{absenceTypeLabels[day.absenceType]}</StatusBadge>}
                      </span>
                    </span>
                    <span className="time-review-day-group-total time-review-work-time-cell" role="cell">{formatTimeEntryMinutes(timeReviewDayTotalMinutes(day), "hours")}</span>
                  </div>
                  {isExpanded && <div className="time-review-day-group-entries" id={dayPanelId}>
                    {day.entries.length > 0 ? day.entries.map((check) => (
                      <div className="time-review-week-check-row" key={check.entry.id} role="row">
                        <div className="time-review-week-move" role="cell"><button className="time-review-day-move-button" type="button" aria-label="Aktionen für Zeiteintrag öffnen" aria-haspopup="menu" disabled={!canManageTimeEntries || check.entry.id < 0} onClick={(event) => onOpenEntryActions(check.entry, event.currentTarget)}><ChevronsUpDown aria-hidden="true" size={14} /></button></div><div className="time-review-week-day" role="cell"></div>
                        <div className="time-review-week-type" role="cell">{isTravelTimeEntry(check.entry) ? <span className="time-review-entry-type is-travel"><CarFront aria-hidden="true" size={14} /><span>Fahrt</span></span> : <span className="time-review-entry-type is-work"><Wrench aria-hidden="true" size={14} /><span>Arbeit</span></span>}</div>
                        <div className="time-review-week-site" role="cell"><strong>{timeReviewSiteName(check.entry)}</strong>{check.entry.site_number && <span>{check.entry.site_number}</span>}</div>
                        <div className="time-review-week-time time-review-week-time-start" role="cell">{renderPayrollClock(check.entry, "start")}{hasPayrollTimeRange(check.entry) && <ArrowRight className="time-review-time-range-arrow" aria-hidden="true" size={13} strokeWidth={1.8} />}</div><div className="time-review-week-time time-review-week-time-end" role="cell">{renderPayrollClock(check.entry, "end")}</div><div className="time-review-week-time time-review-week-break" role="cell">{renderTimeReviewBreakMinutes(check.entry)}</div><div className="time-review-week-time time-review-week-total" role="cell">{renderPayrollWorkMinutes(check.entry)}</div>
                        <div role="cell">{renderTimeReviewCheckMark(check.locationCheck, { onClick: () => onOpenLocationDiagnostic(check.entry), label: "Ort-Diagnose öffnen" })}</div>
                        <div className="time-review-work-time-cell" role="cell">{renderTimeReviewCheckMark(check.timeCheck, { onClick: () => onOpenTimeDiagnostic(check.entry), label: "Arbeitszeit-Diagnose öffnen" })}</div>
                        <div role="cell">{renderPayrollReviewMark(check.entry, { disabled: !canManageTimeEntries || check.entry.id < 0, isBusy: false, onToggle: () => onToggleReview(check.entry) })}</div>
                      </div>
                    )) : <div className="time-review-week-check-row is-empty" role="row">
                      <div className="time-review-week-move" role="cell"></div><div className="time-review-week-day" role="cell"></div><div className="time-review-week-type" role="cell" aria-label="Keine Zeitmeldung"></div>
                      <div className="time-review-week-site" role="cell"><strong>Keine Zeitmeldung</strong></div>
                      <div className="time-review-week-time" role="cell">-</div><div className="time-review-week-time" role="cell">-</div><div className="time-review-week-time time-review-week-break" role="cell">-</div><div className="time-review-week-time time-review-week-total" role="cell">-</div>
                      <div role="cell">-</div><div className="time-review-work-time-cell" role="cell">-</div><div role="cell">{renderPayrollReviewEmptyMark()}</div>
                    </div>}
                  </div>}
                    </section>
                    );
                  })}
                </div>
              ))}
            </div>
            {!days.length && <div className="time-review-worker-empty-detail">Keine Zeitmeldungen in diesem Monat.</div>}
          </div>
        ) : <div className="time-review-worker-empty-detail">Monteur auswählen, um die Monatsauswertung zu öffnen.</div>}
      </div>
    </div>
  );
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
    if (!workerIdSet.has(review.person_id) || !isWeeklyReviewReviewed(review)) {
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

function isWeeklyReviewReviewed(review: TimeEntryWeeklyReview): boolean {
  return review.status === "reviewed";
}

function isWeeklyReviewReset(review: TimeEntryWeeklyReview): boolean {
  return review.status === "reset";
}

function upsertWeeklyReview(current: TimeEntryWeeklyReview[], next: TimeEntryWeeklyReview): TimeEntryWeeklyReview[] {
  const withoutCurrent = current.filter((review) => !(
    review.person_id === next.person_id
    && review.iso_year === next.iso_year
    && review.iso_week === next.iso_week
  ));
  return [...withoutCurrent, next];
}

function reviewWeekKey(selection: CalendarWeekSelection): string {
  return `${selection.year}-${selection.week}`;
}

function reviewDataRangeKey(range: { start: string; end: string }): string {
  return `${range.start}:${range.end}`;
}

function evaluationMonthVisibleButtonCount(
  container: HTMLDivElement,
  buttons: HTMLButtonElement[],
): number {
  const firstButton = buttons[0];
  const secondButton = buttons[1];
  if (!firstButton || !secondButton) {
    return Math.max(1, buttons.length);
  }
  const step = secondButton.offsetLeft - firstButton.offsetLeft;
  return Math.max(1, Math.min(buttons.length, Math.floor((container.clientWidth - firstButton.offsetWidth) / step) + 1));
}

function evaluationMonthStartIndex(container: HTMLDivElement, buttons: HTMLButtonElement[]): number {
  const firstButton = buttons[0];
  const secondButton = buttons[1];
  if (!firstButton || !secondButton) {
    return 0;
  }
  const step = secondButton.offsetLeft - firstButton.offsetLeft;
  return Math.max(0, Math.min(buttons.length - 1, Math.round(container.scrollLeft / step)));
}

function alignEvaluationMonthsToSelection(
  container: HTMLDivElement | null,
  selection: CalendarMonthSelection,
  behavior: ScrollBehavior = "auto",
): void {
  if (!container) {
    return;
  }
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const selectedIndex = buttons.findIndex((button) => (
    Number(button.dataset.year) === selection.year
    && Number(button.dataset.month) === selection.month
  ));
  if (selectedIndex < 0) {
    return;
  }
  const visibleCount = evaluationMonthVisibleButtonCount(container, buttons);
  const maxStartIndex = Math.max(0, buttons.length - visibleCount);
  const targetIndex = Math.min(maxStartIndex, Math.max(0, selectedIndex - 1));
  container.scrollTo({ left: buttons[targetIndex]?.offsetLeft ?? 0, behavior });
}

function scrollWeekStripToSelection(
  container: HTMLDivElement | null,
  options: CalendarWeekOption[],
  selection: CalendarWeekSelection,
  settings: { alignment?: "center" | "nearest"; visibleCount?: number } = {},
): boolean {
  if (!container) {
    return false;
  }
  const selectedWeekIndex = options.findIndex(
    (option) => option.year === selection.year && option.week === selection.week,
  );
  if (selectedWeekIndex < 0) {
    return false;
  }

  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-week-index]"));
  const firstButton = buttons[0];
  const selectedButton = buttons[selectedWeekIndex];
  if (!firstButton || !selectedButton || container.clientWidth <= 0 || firstButton.offsetWidth <= 0) {
    return false;
  }

  const visibleCount = settings.visibleCount ?? 5;
  const selectedStart = selectedButton.offsetLeft - firstButton.offsetLeft;
  const selectedEnd = selectedStart + selectedButton.offsetWidth;
  if (
    settings.alignment === "nearest"
    && selectedStart >= container.scrollLeft - 1
    && selectedEnd <= container.scrollLeft + container.clientWidth + 1
  ) {
    return true;
  }

  const requestedStart = settings.alignment === "nearest"
    ? selectedStart < container.scrollLeft
      ? selectedWeekIndex
      : selectedWeekIndex - visibleCount + 1
    : centeredWeekWindowStart(selectedWeekIndex, options.length, visibleCount);
  const firstVisibleIndex = clampWeekWindowStart(requestedStart, options.length, visibleCount);
  const targetButton = buttons[firstVisibleIndex];
  if (!targetButton) {
    return false;
  }
  container.scrollTo({
    left: Math.max(0, targetButton.offsetLeft - firstButton.offsetLeft),
    behavior: "auto",
  });
  return true;
}

function scrollWeekStripByWholeWeek(container: HTMLDivElement, direction: -1 | 1): void {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-week-index]"));
  const firstButton = buttons[0];
  if (!firstButton) {
    return;
  }
  const weekStep = buttons[1]
    ? buttons[1].offsetLeft - firstButton.offsetLeft
    : firstButton.offsetWidth;
  container.scrollBy({ left: direction * weekStep, behavior: "smooth" });
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

function formatWeekdayLong(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { weekday: "long" }).format(parseDateInput(value));
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

function buildTimeReviewWorkerSummaries(
  people: Person[],
  allEntries: TimeEntry[],
  openEntries: TimeEntry[],
  absences: Absence[],
  reviewedWorkerIds: Set<number>,
  resetWorkerIds: Set<number>,
  payrollWeekPersons: Map<number, TimeEntryPayrollWeekPerson>,
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
        isReset: false,
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
      const fallbackTotalMinutes = summary.entries.reduce(
        (sum, entry) => sum + (effectivePayrollWorkMinutes(entry) ?? 0),
        0,
      );
      const fallbackSubmittedMinutes = summary.entries.reduce((sum, entry) => (
        entry.is_gps_suggestion ? sum : sum + (effectivePayrollWorkMinutes(entry) ?? 0)
      ), 0);
      const payrollWeekPerson = payrollWeekPersons.get(summary.personId);
      const totalMinutes = payrollWeekTotalMinutes(payrollWeekPerson, fallbackTotalMinutes);
      const submittedMinutes = payrollWeekTotalMinutes(payrollWeekPerson, fallbackSubmittedMinutes);
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
        isReset: resetWorkerIds.has(summary.personId),
        entries: summary.entries.slice().sort(compareTimeReviewWorkerEntries),
      };
    })
    .sort((left, right) => left.personName.localeCompare(right.personName, "de", { sensitivity: "base" }));
}

function timeReviewWorkerStatus(worker: TimeReviewWorkerSummary): TimeReviewWorkerStatus {
  if (worker.isReviewed) {
    return "reviewed";
  }
  return worker.submittedMinutes > 0 ? "open" : "missing";
}

function reviewedWorkersWithAllEntriesReviewed(entries: TimeEntry[]): Set<number> {
  const reviewStateByPerson = new Map<number, { hasEntries: boolean; allReviewed: boolean }>();
  entries.forEach((entry) => {
    const current = reviewStateByPerson.get(entry.person_id) ?? { hasEntries: false, allReviewed: true };
    current.hasEntries = true;
    current.allReviewed = current.allReviewed && entry.payroll_reviewed_at !== null;
    reviewStateByPerson.set(entry.person_id, current);
  });
  return new Set(
    [...reviewStateByPerson.entries()]
      .filter(([, state]) => state.hasEntries && state.allReviewed)
      .map(([personId]) => personId),
  );
}

function timeReviewWorkerStatusLabel(status: TimeReviewWorkerStatus): string {
  if (status === "reviewed") {
    return "Geprüft";
  }
  if (status === "open") {
    return "Offen";
  }
  return "Keine Meldung";
}

function countTimeReviewWorkersByFilter(workers: TimeReviewWorkerSummary[]): Record<TimeReviewWorkerFilter, number> {
  const counts: Record<TimeReviewWorkerFilter, number> = {
    all: workers.length,
    open: 0,
    missing: 0,
    reviewed: 0,
  };
  workers.forEach((worker) => {
    counts[timeReviewWorkerStatus(worker)] += 1;
  });
  return counts;
}

function filterTimeReviewWorkers(
  workers: TimeReviewWorkerSummary[],
  search: string,
  filter: TimeReviewWorkerFilter,
): TimeReviewWorkerSummary[] {
  const normalizedSearch = search.trim().toLocaleLowerCase("de-DE");
  return workers.filter((worker) => (
    (!normalizedSearch || worker.personName.toLocaleLowerCase("de-DE").includes(normalizedSearch))
    && (filter === "all" || timeReviewWorkerStatus(worker) === filter)
  ));
}

function timeReviewDayTotalMinutes(day: TimeReviewWeekDay): number {
  if (day.entries.length === 0) {
    return day.vacationCreditMinutes;
  }
  return day.entries.reduce((total, check) => total + (effectivePayrollWorkMinutes(check.entry) ?? 0), 0);
}

function groupTimeReviewMonthDays(days: TimeReviewWeekDay[]): TimeReviewMonthWeekGroup[] {
  const groups = new Map<string, TimeReviewMonthWeekGroup>();
  days.forEach((day) => {
    const isoWeek = isoWeekFromDate(parseDateInput(day.date));
    const key = `${isoWeek.year}-${isoWeek.week}`;
    const group = groups.get(key) ?? {
      key,
      week: isoWeek.week,
      totalMinutes: 0,
      days: [],
    };
    group.totalMinutes += timeReviewDayTotalMinutes(day);
    group.days.push(day);
    groups.set(key, group);
  });
  return Array.from(groups.values());
}

function formatMonthlyWeekHours(minutes: number): string {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(minutes / 60);
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
  payrollWeekPerson: TimeEntryPayrollWeekPerson | null | undefined,
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
    const overnightSummary = summarizeOvernightStatuses(dayEntries.map((entry) => entry.overnight_status));
    return {
      date,
      weekdayLabel: formatWeekdayLong(date),
      absenceType,
      overnightStatus: overnightSummary.status,
      hasOvernightStatusConflict: overnightSummary.hasConflict,
      vacationCreditMinutes: vacationCreditMinutesForDate(payrollWeekPerson, date),
      entries: dayEntries
        .map((entry) => ({
          entry,
          locationCheck: classifyTimeReviewLocationCheck(entry),
          timeCheck: classifyTimeReviewTimeCheck(entry, { hasMultipleEntriesOnDay: dayEntries.length > 1 }),
        })),
    };
  }).filter((day, index) => index < 5 || day.entries.length > 0 || day.absenceType !== null);
}

function buildTimeReviewMonthDays(
  entries: TimeEntry[],
  absences: Absence[],
  personId: number | null,
  monthStart: string,
  monthEnd: string,
): TimeReviewWeekDay[] {
  return buildTimeReviewPeriodDays(entries, absences, personId, monthStart, monthEnd)
    .filter((day) => day.entries.length > 0 || day.absenceType !== null || isPayrollWeekday(day.date));
}

function isPayrollWeekday(value: string): boolean {
  const day = parseDateInput(value).getDay();
  return day !== 0 && day !== 6;
}

function buildTimeReviewPeriodDays(
  entries: TimeEntry[],
  absences: Absence[],
  personId: number | null,
  start: string,
  end: string,
): TimeReviewWeekDay[] {
  const entriesByDate = new Map<string, TimeEntry[]>();
  for (const entry of entries) {
    const dayEntries = entriesByDate.get(entry.work_date) ?? [];
    dayEntries.push(entry);
    entriesByDate.set(entry.work_date, dayEntries);
  }
  return buildReviewPeriodDayOptions(start, end).map(({ date }) => {
    const dayEntries = (entriesByDate.get(date) ?? []).slice().sort(compareTimeReviewWorkerEntries);
    const absenceType = personId === null ? null : highestPriorityAbsenceTypeForPersonDate(absences, personId, date);
    const overnightSummary = summarizeOvernightStatuses(dayEntries.map((entry) => entry.overnight_status));
    return {
      date,
      weekdayLabel: formatWeekdayLong(date),
      absenceType,
      overnightStatus: overnightSummary.status,
      hasOvernightStatusConflict: overnightSummary.hasConflict,
      vacationCreditMinutes: 0,
      entries: dayEntries.map((entry) => ({
        entry,
        locationCheck: classifyTimeReviewLocationCheck(entry),
        timeCheck: classifyTimeReviewTimeCheck(entry, { hasMultipleEntriesOnDay: dayEntries.length > 1 }),
      })),
    };
  });
}

function buildReviewWeekDayOptions(weekStart: string): Array<{ date: string; label: string }> {
  return buildReviewPeriodDayOptions(weekStart, addDaysToDateInput(weekStart, 6));
}

function buildReviewPeriodDayOptions(start: string, end: string): Array<{ date: string; label: string }> {
  const options: Array<{ date: string; label: string }> = [];
  for (let date = start; date <= end; date = addDaysToDateInput(date, 1)) {
    options.push({ date, label: formatWeekday(date) });
  }
  return options;
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
    overnight_status: null,
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
    payroll_corrected_break_minutes: null,
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
  if (hasManualLocationReview(entry)) {
    return "ok";
  }

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
  if (
    isOfficeOnlyTimeEntry(entry)
    && entry.payroll_corrected_break_minutes === null
    && !hasDirectOfficeTime(entry)
  ) {
    return "-";
  }
  return formatTimeEntryMinutes(
    entry.payroll_corrected_break_minutes ?? entry.break_minutes,
    "minutes",
  );
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

function hasPayrollTimeRange(entry: TimeEntry): boolean {
  return Boolean(effectivePayrollStartTime(entry) && effectivePayrollEndTime(entry));
}

function hasPayrollTimeCorrection(entry: TimeEntry): boolean {
  return (
    entry.payroll_corrected_start_time !== null
    || entry.payroll_corrected_end_time !== null
    || entry.payroll_corrected_break_minutes !== null
    || entry.payroll_corrected_work_minutes !== null
  );
}

function effectivePayrollStartTime(entry: TimeEntry): string | null {
  return entry.payroll_corrected_start_time ?? entry.start_time;
}

function effectivePayrollEndTime(entry: TimeEntry): string | null {
  return entry.payroll_corrected_end_time ?? entry.end_time;
}

function effectivePayrollWorkMinutes(entry: TimeEntry): number | null {
  const correctedMinutes = effectivePayrollCorrectedWorkMinutes(entry);
  if (correctedMinutes !== null) {
    return roundMinutesToQuarterHour(correctedMinutes + (entry.travel_minutes || 0));
  }
  if (isOfficeOnlyTimeEntry(entry) && !hasDirectOfficeTime(entry)) {
    return null;
  }
  return roundMinutesToQuarterHour(entry.work_minutes + (entry.travel_minutes || 0));
}

function hasDirectOfficeTime(entry: TimeEntry): boolean {
  return (
    entry.start_time !== null
    || entry.end_time !== null
    || entry.work_minutes > 0
    || (entry.travel_minutes || 0) > 0
  );
}

function effectivePayrollCorrectedWorkMinutes(entry: TimeEntry): number | null {
  if (entry.payroll_corrected_work_minutes !== null) {
    return entry.payroll_corrected_work_minutes;
  }
  const startMinutes = clockValueToMinutes(entry.payroll_corrected_start_time);
  const endMinutes = clockValueToMinutes(entry.payroll_corrected_end_time);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) {
    return null;
  }
  const grossMinutes = endMinutes > startMinutes
    ? endMinutes - startMinutes
    : endMinutes + 24 * 60 - startMinutes;
  const pauseMinutes = entry.payroll_corrected_break_minutes ?? entry.break_minutes ?? 0;
  return Math.max(0, grossMinutes - pauseMinutes);
}

function timeReviewDiagnosticRows(entry: TimeEntry): TimeReviewDiagnosticRow[] {
  const hasSubmittedTime = !isOfficeOnlyTimeEntry(entry);
  return [
    {
      source: "Mobile Erfassung",
      start: hasSubmittedTime ? formatTimeEntryClock(entry.start_time) : "-",
      end: hasSubmittedTime ? formatTimeEntryClock(entry.end_time) : "-",
      break: hasSubmittedTime ? formatTimeEntryMinutes(entry.break_minutes, "minutes") : "-",
      total: hasSubmittedTime ? formatTimeEntryMinutes(entry.work_minutes, "hours") : "-",
    },
    {
      source: "GPS-Erfassung",
      start: formatTimeEntryClock(entry.gps_first_seen_at),
      end: formatTimeEntryClock(entry.gps_last_seen_at),
      break: "-",
      total: formatTimeEntryMinutes(entry.gps_work_minutes, "hours"),
    },
    {
      source: "Büroerfassung",
      start: formatTimeEntryClock(entry.payroll_corrected_start_time),
      end: formatTimeEntryClock(entry.payroll_corrected_end_time),
      break: formatTimeEntryMinutes(entry.payroll_corrected_break_minutes, "minutes"),
      total: formatTimeEntryMinutes(effectivePayrollCorrectedWorkMinutes(entry), "hours"),
    },
  ];
}

function locationReviewDiagnosticRows(
  entry: TimeEntry,
  sites: SiteSummary[],
  previewOfficeSiteId: string | null = null,
): LocationReviewDiagnosticRow[] {
  const hasSubmittedSite = !isOfficeOnlyTimeEntry(entry);
  const hasManualOfficeReview = hasManualLocationReview(entry);
  const originalSite = hasSubmittedSite ? findSiteSummary(sites, entry.original_site_id ?? entry.site_id) : null;
  const parsedPreviewOfficeSiteId = previewOfficeSiteId === null ? null : Number(previewOfficeSiteId);
  const previewedOfficeSite = parsedPreviewOfficeSiteId !== null
    && Number.isInteger(parsedPreviewOfficeSiteId)
    && parsedPreviewOfficeSiteId > 0
    ? findSiteSummary(sites, parsedPreviewOfficeSiteId)
    : null;
  const reviewedSite = previewedOfficeSite ?? (hasManualOfficeReview ? findSiteSummary(sites, entry.site_id) : null);
  const hasOfficeReview = hasManualOfficeReview || previewedOfficeSite !== null;
  const gpsSite = hasGpsSiteMatch(entry) ? findSiteSummary(sites, entry.gps_detected_site_id) : null;
  const rows: LocationReviewDiagnosticRow[] = [
    {
      source: "Mobile Erfassung",
      siteName: hasSubmittedSite ? displayDiagnosticValue(originalTimeEntrySiteName(entry)) : "-",
      siteNumber: hasSubmittedSite ? displayDiagnosticValue(entry.original_site_id !== null ? entry.original_site_number : entry.site_number) : "-",
      location: siteLocationLabel(originalSite),
    },
    {
      source: "GPS-Erfassung",
      siteName: hasGpsSiteMatch(entry) ? displayDiagnosticValue(entry.gps_detected_site_name) : "-",
      siteNumber: hasGpsSiteMatch(entry) ? displayDiagnosticValue(entry.gps_detected_site_number) : "-",
      location: hasGpsSiteMatch(entry) ? siteLocationLabel(gpsSite) : "-",
    },
    {
      source: "Büroerfassung",
      siteName: hasOfficeReview ? displayDiagnosticValue(previewedOfficeSite?.name ?? timeEntrySiteName(entry)) : "-",
      siteNumber: hasOfficeReview ? displayDiagnosticValue(previewedOfficeSite?.site_number ?? entry.site_number) : "-",
      location: hasOfficeReview ? siteLocationLabel(reviewedSite) : "-",
    },
  ];
  return rows;
}

function hasManualLocationReview(entry: TimeEntry): boolean {
  return entry.original_site_id !== null && entry.original_site_id !== entry.site_id;
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
  return isOfficeOnlyPayrollEntry(entry);
}

function isTravelTimeEntry(entry: TimeEntry): boolean {
  return isTravelOnlyPayrollEntry(entry);
}

function renderPayrollReviewMark(
  entry: TimeEntry,
  options: { disabled: boolean; isBusy: boolean; onToggle: () => void },
) {
  const isReviewed = entry.payroll_reviewed_at !== null;
  return (
    <button
      className={[
        "time-review-payroll-mark",
        isReviewed ? "is-reviewed time-review-reviewed-indicator" : "is-pending time-review-pending-indicator",
      ].join(" ")}
      type="button"
      disabled={options.disabled}
      aria-label={isReviewed ? "Zeilenprüfung entfernen" : "Zeile als geprüft markieren"}
      title={isReviewed ? "Zeilenprüfung entfernen" : "Zeile als geprüft markieren"}
      onClick={options.onToggle}
    >
      {options.isBusy ? "..." : isReviewed ? "✓" : null}
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
  return `${formatTimeEntryClock(entry.start_time)}–${formatTimeEntryClock(entry.end_time)}`;
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

function formatDecimalHours(minutes: number): string {
  return formatDecimalHoursValue(minutes / 60);
}

function formatDecimalHoursValue(hours: number): string {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(hours);
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
  const breakMinutes = parsePayrollBreakMinutes(form.break_minutes);
  if (form.break_minutes.trim() && breakMinutes === null) {
    return { ok: false, error: "Pause muss als ganze, nicht negative Minutenzahl eingetragen werden." };
  }
  const workMinutes = parseOptionalHoursToMinutes(form.hours);
  if (!workMinutes.ok) {
    return workMinutes;
  }
  const timeCalculation = calculatePayrollTime(form);
  if (timeCalculation.status === "invalid") {
    return { ok: false, error: timeCalculation.error };
  }
  const calculatedWorkMinutes = resolvePayrollCorrectionWorkMinutes(form, workMinutes.value);
  if (!startTime.value && !endTime.value && calculatedWorkMinutes === null) {
    return { ok: false, error: "Bitte mindestens eine Bürozeit eintragen." };
  }
  return {
    ok: true,
    payload: {
      payroll_corrected_start_time: startTime.value,
      payroll_corrected_end_time: endTime.value,
      payroll_corrected_break_minutes: breakMinutes,
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
  return { ok: true, value: roundMinutesToQuarterHour(Math.round(parsed * 60)) };
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

function timeEntrySiteName(entry: TimeEntry): string {
  return entry.site_name || manualTimeEntrySiteText(entry) || "-";
}

function timeReviewSiteName(entry: TimeEntry): string {
  const siteName = timeEntrySiteName(entry);
  return isTravelTimeEntry(entry) && !entry.site_name && /^fahrtzeit$/i.test(siteName) ? "-" : siteName;
}

function payrollDeleteSiteLabel(entry: TimeEntry): string {
  return [entry.site_name, entry.site_number].filter(Boolean).join(" · ") || manualTimeEntrySiteText(entry);
}

function payrollDeleteTimeRange(entry: TimeEntry): string {
  const start = effectivePayrollStartTime(entry);
  const end = effectivePayrollEndTime(entry);
  if (!start && !end) {
    return "";
  }
  return `${formatTimeEntryClock(start)} – ${formatTimeEntryClock(end)}`;
}

function resetMatchingWeeklyReview(
  reviews: TimeEntryWeeklyReview[],
  result: TimeEntryPayrollDeleteResult,
): TimeEntryWeeklyReview[] {
  return reviews.map((review) => (
    review.person_id === result.person_id
    && review.iso_year === result.iso_year
    && review.iso_week === result.iso_week
      ? { ...review, status: "reset" }
      : review
  ));
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

function manualTimeEntrySiteOptionLabel(site: SiteSummary): string {
  return [site.site_number, site.name, site.location || site.city].filter(Boolean).join(" · ")
    || `Baustelle ${site.id}`;
}

function formatPayrollManualEntryDate(workDate: string): string {
  return `${formatWeekday(workDate)}, ${formatDate(workDate, "numeric")}`;
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

function comparePeople(left: Person, right: Person): number {
  return left.display_name.localeCompare(right.display_name, "de");
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
