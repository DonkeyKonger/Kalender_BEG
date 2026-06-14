import { ChevronLeft, ChevronRight, Clock3, Pencil, Plus, RefreshCw } from "lucide-react";
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
import type { AbsenceType, AssignmentRead } from "../types/matrix";
import type { Person } from "../types/person";
import type { SiteSummary } from "../types/site";
import type { TimeEntry, TimeEntryCreate, TimeEntryGpsStatus, TimeEntryStatus, TimeEntryWeeklyReview, TimeReviewDecision } from "../types/timeEntry";

type RangeMode = "week" | "month";
type TimeSubtab = "review" | "gpsVerification" | "workerTimes" | "evaluation" | "export";
type PlanningMatchStatus = "matches" | "needs_review" | "without_plan" | "missing_reported_site" | "unknown" | "not_checkable";
type TimeEntryFormState = {
  work_date: string;
  site_id: string;
  hours: string;
  break_minutes: string;
  travel_minutes: string;
  note: string;
};
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
type ExportMonthSelection = {
  year: number;
  month: number;
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
type ExportPreviewStatus = "auto_checked" | "manually_checked" | "corrected" | "not_exportable";
type ExportPreviewRow = {
  id: number;
  entry: TimeEntry;
  workDate: string;
  personName: string;
  siteNumber: string;
  siteName: string;
  reportedMinutes: number | null;
  gpsMinutes: number | null;
  correctedMinutes: number | null;
  validMinutes: number | null;
  status: ExportPreviewStatus;
  statusLabel: string;
  statusTone: StatusBadgeTone;
  isExportable: boolean;
  instruction: string;
};
type ExportPreviewSummary = {
  autoChecked: number;
  manuallyChecked: number;
  corrected: number;
  open: number;
  exportable: number;
  notExportable: number;
};

const GPS_TIME_TOLERANCE_MINUTES = 15;
const GPS_NOT_CHECKABLE_NOTICE = "GPS nicht eindeutig prüfbar";
const EXPORT_MONTH_LABELS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];
const timeSubtabs: { key: TimeSubtab; label: string }[] = [
  { key: "review", label: "Stundenprüfung" },
  { key: "gpsVerification", label: "GPS-Prüfung" },
  { key: "workerTimes", label: "Monteurszeiten" },
  { key: "evaluation", label: "Auswertung" },
  { key: "export", label: "Export" },
];

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
  const [activeTimeSubtab, setActiveTimeSubtab] = useState<TimeSubtab>("review");
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [reviewEntries, setReviewEntries] = useState<TimeEntry[]>([]);
  const [reviewAllEntries, setReviewAllEntries] = useState<TimeEntry[]>([]);
  const [reviewAbsences, setReviewAbsences] = useState<Absence[]>([]);
  const [reviewWeeklyReviews, setReviewWeeklyReviews] = useState<TimeEntryWeeklyReview[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRead[]>([]);
  const [recentGpsPoints, setRecentGpsPoints] = useState<GpsRecentLocationPoint[]>([]);
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [rangeMode, setRangeMode] = useState<RangeMode>("week");
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoadingPeople, setIsLoadingPeople] = useState(true);
  const [isLoadingEntries, setIsLoadingEntries] = useState(false);
  const [isLoadingReviewEntries, setIsLoadingReviewEntries] = useState(false);
  const [isLoadingReviewAllEntries, setIsLoadingReviewAllEntries] = useState(false);
  const [isLoadingAssignments, setIsLoadingAssignments] = useState(false);
  const [isLoadingRecentGps, setIsLoadingRecentGps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [reviewEntriesError, setReviewEntriesError] = useState<string | null>(null);
  const [reviewAllEntriesError, setReviewAllEntriesError] = useState<string | null>(null);
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);
  const [recentGpsError, setRecentGpsError] = useState<string | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [entryForm, setEntryForm] = useState<TimeEntryFormState>(() => emptyTimeEntryForm(toDateInputValue(new Date())));
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSavingEntry, setIsSavingEntry] = useState(false);
  const [entriesRefreshKey, setEntriesRefreshKey] = useState(0);
  const [reviewActionEntryId, setReviewActionEntryId] = useState<number | null>(null);
  const [reviewActionError, setReviewActionError] = useState<string | null>(null);
  const [expandedReviewEntryId, setExpandedReviewEntryId] = useState<number | null>(null);
  const [reviewEditorMode, setReviewEditorMode] = useState<ReviewEditorMode>(null);
  const [reviewDecisionForm, setReviewDecisionForm] = useState<ReviewDecisionFormState>({ hours: "", site_id: "" });
  const [isSavingReviewDecision, setIsSavingReviewDecision] = useState(false);
  const [selectedReviewWeek, setSelectedReviewWeek] = useState<CalendarWeekSelection>(() => currentIsoWeek());
  const [selectedReviewPersonId, setSelectedReviewPersonId] = useState<number | null>(null);
  const [isDownloadingReviewHours, setIsDownloadingReviewHours] = useState(false);
  const [markingReviewWeekPersonId, setMarkingReviewWeekPersonId] = useState<number | null>(null);
  const [reviewHoursDownloadError, setReviewHoursDownloadError] = useState<string | null>(null);
  const [selectedExportMonth, setSelectedExportMonth] = useState<ExportMonthSelection>(() => currentExportMonth());
  const [isDownloadingExport, setIsDownloadingExport] = useState(false);
  const [exportDownloadError, setExportDownloadError] = useState<string | null>(null);
  const [reviewWeekScrollState, setReviewWeekScrollState] = useState({ canScrollLeft: false, canScrollRight: false });
  const canManageTimeEntries = user?.role === "admin" || user?.role === "project_manager" || user?.role === "office";
  const canViewGpsVerification = canManageTimeEntries;
  const visibleTimeSubtabs = canViewGpsVerification
    ? timeSubtabs
    : timeSubtabs.filter((tab) => tab.key !== "gpsVerification");
  const reviewWeekStripRef = useRef<HTMLDivElement | null>(null);
  const hasAutoScrolledVisibleReviewWeekRef = useRef(false);

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
  const currentReviewWeek = useMemo(() => currentIsoWeek(), []);
  const reviewWeekRange = useMemo(
    () => isoWeekRange(selectedReviewWeek.year, selectedReviewWeek.week),
    [selectedReviewWeek.week, selectedReviewWeek.year],
  );
  const exportMonthRange = useMemo(
    () => monthRange(selectedExportMonth.year, selectedExportMonth.month),
    [selectedExportMonth.month, selectedExportMonth.year],
  );
  const reviewDataRange = activeTimeSubtab === "export" ? exportMonthRange : reviewWeekRange;
  const exportMonthLabel = `${EXPORT_MONTH_LABELS[selectedExportMonth.month - 1]} ${selectedExportMonth.year}`;
  const exportYearOptions = useMemo(
    () => buildExportYearOptions(selectedExportMonth.year),
    [selectedExportMonth.year],
  );
  const reviewWeekOptions = useMemo(
    () => buildCalendarWeekOptions(currentReviewWeek),
    [currentReviewWeek],
  );
  const currentExportMonthSelection = useMemo(() => currentExportMonth(), []);
  const siteById = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const siteOptions = useMemo(
    () => [...sites].sort((left, right) => siteOptionLabel(left).localeCompare(siteOptionLabel(right), "de")),
    [sites],
  );
  const plannedSitesByDate = useMemo(
    () => buildPlannedSitesByDate(assignments, activeRange.start, activeRange.end),
    [activeRange.end, activeRange.start, assignments],
  );
  const timeReviewIssues = useMemo(() => buildTimeReviewIssues(reviewEntries), [reviewEntries]);
  const reviewedWorkerIds = useMemo(
    () => new Set(reviewWeeklyReviews.map((review) => review.person_id)),
    [reviewWeeklyReviews],
  );
  const timeReviewWorkers = useMemo(
    () => buildTimeReviewWorkerSummaries(people, reviewAllEntries, reviewEntries, reviewAbsences, reviewedWorkerIds),
    [people, reviewAbsences, reviewAllEntries, reviewEntries, reviewedWorkerIds],
  );
  const selectedReviewWorker = useMemo(
    () => timeReviewWorkers.find((worker) => worker.personId === selectedReviewPersonId) ?? null,
    [selectedReviewPersonId, timeReviewWorkers],
  );
  const selectedReviewWeekDays = useMemo(
    () => buildTimeReviewWeekDays(
      selectedReviewWorker?.entries ?? [],
      reviewAbsences,
      selectedReviewWorker?.personId ?? null,
      reviewWeekRange.start,
    ),
    [reviewAbsences, reviewWeekRange.start, selectedReviewWorker],
  );
  const finalHoursEntries = useMemo(() => buildFinalHoursEntries(reviewAllEntries), [reviewAllEntries]);
  const finalHoursTotals = useMemo(() => calculateFinalHoursTotals(finalHoursEntries), [finalHoursEntries]);
  const exportPreviewRows = useMemo(
    () => buildExportPreviewRows(reviewAllEntries, reviewEntries),
    [reviewAllEntries, reviewEntries],
  );
  const exportPreviewSummary = useMemo(() => calculateExportPreviewSummary(exportPreviewRows), [exportPreviewRows]);
  const exportableRows = useMemo(
    () => exportPreviewRows.filter((row) => row.isExportable),
    [exportPreviewRows],
  );
  const notExportableRows = useMemo(
    () => exportPreviewRows.filter((row) => !row.isExportable),
    [exportPreviewRows],
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
    if (selectedReviewPersonId !== null && !timeReviewWorkers.some((worker) => worker.personId === selectedReviewPersonId)) {
      setSelectedReviewPersonId(null);
    }
  }, [selectedReviewPersonId, timeReviewWorkers]);

  useEffect(() => {
    if (activeTimeSubtab !== "review" && activeTimeSubtab !== "evaluation" && activeTimeSubtab !== "export") {
      return;
    }

    let ignore = false;
    setIsLoadingReviewEntries(true);
    setReviewEntriesError(null);

    api.timeEntries({
      dateFrom: reviewDataRange.start,
      dateTo: reviewDataRange.end,
      includeGpsStatus: true,
      reviewOpenOnly: true,
    })
      .then((entryData) => {
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
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, entriesRefreshKey, reviewDataRange.end, reviewDataRange.start]);

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
    if (activeTimeSubtab !== "review") {
      setReviewAbsences([]);
      return;
    }

    let ignore = false;
    api.absences({ start: reviewWeekRange.start, end: reviewWeekRange.end })
      .then((absenceData) => {
        if (!ignore) {
          setReviewAbsences(absenceData);
        }
      })
      .catch(() => {
        if (!ignore) {
          setReviewAbsences([]);
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
    setReviewWeeklyReviews([]);
    api.timeEntryWeeklyReviews({
      isoYear: selectedReviewWeek.year,
      isoWeek: selectedReviewWeek.week,
    })
      .then((weeklyReviews) => {
        if (!ignore) {
          setReviewWeeklyReviews(weeklyReviews);
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setReviewWeeklyReviews([]);
          setReviewActionError(readApiError(requestError, "Wochenpruefstatus konnte nicht geladen werden."));
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, canManageTimeEntries, selectedReviewWeek.week, selectedReviewWeek.year]);

  useEffect(() => {
    if (activeTimeSubtab !== "review" && activeTimeSubtab !== "evaluation" && activeTimeSubtab !== "export") {
      return;
    }

    let ignore = false;
    setIsLoadingReviewAllEntries(true);
    setReviewAllEntriesError(null);

    api.timeEntries({
      dateFrom: reviewDataRange.start,
      dateTo: reviewDataRange.end,
      includeGpsStatus: true,
    })
      .then((entryData) => {
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
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeTimeSubtab, entriesRefreshKey, reviewDataRange.end, reviewDataRange.start]);

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
    setEntries((current) => replaceTimeEntryInList(current, updatedEntry));
    setReviewEntries((current) => replaceTimeEntryInList(current, updatedEntry));
    setReviewAllEntries((current) => replaceTimeEntryInList(current, updatedEntry));
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
    const scrollPosition = { left: window.scrollX, top: window.scrollY };
    setSelectedReviewWeek({ year: option.year, week: option.week });
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

  function scrollReviewWeeks(direction: -1 | 1): void {
    const container = reviewWeekStripRef.current;
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

  async function downloadTimeExportXlsx(): Promise<void> {
    if (!exportableRows.length || isDownloadingExport) {
      return;
    }
    setIsDownloadingExport(true);
    setExportDownloadError(null);
    try {
      const blob = await api.monthlyTimeEntriesXlsx({
        year: selectedExportMonth.year,
        month: selectedExportMonth.month,
      });
      downloadBlobFile(blob, `zeiten_export_${selectedExportMonth.year}_${String(selectedExportMonth.month).padStart(2, "0")}.xlsx`);
    } catch (requestError) {
      setExportDownloadError(readApiError(requestError, "XLSX-Export konnte nicht erstellt werden."));
    } finally {
      setIsDownloadingExport(false);
    }
  }

  async function downloadWeeklyWorkerHoursPdf(): Promise<void> {
    if (isDownloadingReviewHours) {
      return;
    }
    setIsDownloadingReviewHours(true);
    setReviewHoursDownloadError(null);
    try {
      const blob = await api.weeklyWorkerHoursPdf({ weekStart: reviewWeekRange.start });
      downloadBlobFile(blob, `arbeitsstunden_kw${String(selectedReviewWeek.week).padStart(2, "0")}_${selectedReviewWeek.year}.pdf`);
    } catch (requestError) {
      setReviewHoursDownloadError(readApiError(requestError, "Arbeitsstunden-PDF konnte nicht erstellt werden."));
    } finally {
      setIsDownloadingReviewHours(false);
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
          <h1>Zeiten</h1>
          <p className="page-subtitle">Arbeitszeiten der Monteure wochen- oder monatsweise pruefen.</p>
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

          <div className="time-review-worker-panel">
            <div className="time-review-worker-head">
              <div>
                <h2>Lohnprüfung pro Monteur</h2>
                <p>KW {selectedReviewWeek.week} · {formatRangeLabel(reviewWeekRange.start, reviewWeekRange.end)}</p>
              </div>
              <button
                className="icon-button secondary time-review-download-button"
                type="button"
                disabled={isDownloadingReviewHours}
                onClick={() => void downloadWeeklyWorkerHoursPdf()}
              >
                {isDownloadingReviewHours ? "Arbeitsstunden werden erstellt..." : "Arbeitsstunden downloaden"}
              </button>
            </div>

            {reviewActionError && <p className="time-table-note">{reviewActionError}</p>}
            {reviewHoursDownloadError && <p className="time-table-note">{reviewHoursDownloadError}</p>}
            {(isLoadingReviewEntries || isLoadingReviewAllEntries) && timeReviewWorkers.length > 0 && (
              <p className="time-table-note">Kalenderwoche wird geladen...</p>
            )}
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
                        ? `${formatSubmittedHours(worker.submittedMinutes)} Std. eingereicht`
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
                <div className="time-review-week-check-table" role="table" aria-label={`Lohnprüfung ${selectedReviewWorker.personName} KW ${selectedReviewWeek.week}`}>
                  <div className="time-review-week-check-head" role="row">
                    <span role="columnheader">Tag</span>
                    <span role="columnheader">Baustelle</span>
                    <span role="columnheader">Montagebeginn</span>
                    <span role="columnheader">Montageende</span>
                    <span role="columnheader">Pause</span>
                    <span role="columnheader">Montagezeit</span>
                    <span role="columnheader">Ort passt</span>
                    <span role="columnheader">Arbeitszeit passt</span>
                  </div>
                  {selectedReviewWeekDays.map((day) => (
                    day.entries.length > 0 ? day.entries.map((check, index) => (
                      <div className="time-review-week-check-row" key={`${day.date}-${check.entry.id}`} role="row">
                        <div className="time-review-week-day" role="cell">
                          {index === 0 && (
                            <>
                              <strong>{day.weekdayLabel}</strong>
                              <span>{formatDate(day.date)}</span>
                            </>
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
                        <div className="time-review-week-time" role="cell">{formatTimeEntryClock(check.entry.start_time)}</div>
                        <div className="time-review-week-time" role="cell">{formatTimeEntryClock(check.entry.end_time)}</div>
                        <div className="time-review-week-time" role="cell">{formatTimeEntryMinutes(check.entry.break_minutes, "minutes")}</div>
                        <div className="time-review-week-time" role="cell">{formatTimeEntryMinutes(check.entry.work_minutes, "hours")}</div>
                        <div role="cell">{renderTimeReviewCheckMark(check.locationCheck)}</div>
                        <div role="cell">{renderTimeReviewCheckMark(check.timeCheck)}</div>
                      </div>
                    )) : (
                      <div className="time-review-week-check-row is-empty" key={day.date} role="row">
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
                        <div role="cell">{renderTimeReviewCheckMark("unknown")}</div>
                        <div role="cell">{renderTimeReviewCheckMark("unknown")}</div>
                      </div>
                    )
                  ))}
                </div>
                <div className="time-review-worker-detail-actions">
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
                </div>
              </div>
            ) : timeReviewWorkers.length > 0 ? (
              <div className="time-review-worker-empty-detail">Monteur auswählen, um die Lohnprüfung für KW {selectedReviewWeek.week} zu öffnen.</div>
            ) : null}
          </div>
        </div>
      )}

      {activeTimeSubtab === "evaluation" && (
        <div className="time-entries-main">
          <div className="time-final-hours-panel">
            <div className="time-entries-toolbar">
              <div>
                <h2>Auswertung</h2>
                <p>Summen, Lohnbasis und spätere Stundenzettel-Auswertung.</p>
              </div>
            </div>
            {reviewAllEntriesError && <p className="time-table-note">{reviewAllEntriesError}</p>}
            {isLoadingReviewAllEntries && <p className="time-table-note">Auswertung wird geladen...</p>}
            <div className="time-summary-strip">
              <div><span>Gesamtsumme</span><strong>{formatMinutes(finalHoursTotals.totalMinutes)}</strong></div>
              <div><span>Offene Prüffälle</span><strong>{timeReviewIssues.length}</strong></div>
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

      {activeTimeSubtab === "export" && (
        <div className="time-entries-main time-export-main">
          <div className="time-export-period-panel" aria-label="Exportmonat">
            <div className="time-export-period-header">
              <div>
                <span>Exportmonat</span>
                <strong>{exportMonthLabel}</strong>
              </div>
              <label>
                Jahr
                <select
                  value={selectedExportMonth.year}
                  onChange={(event) => {
                    setSelectedExportMonth((current) => ({ ...current, year: Number(event.target.value) }));
                    setExportDownloadError(null);
                  }}
                >
                  {exportYearOptions.map((year) => (
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="time-export-month-grid">
              {EXPORT_MONTH_LABELS.map((label, index) => {
                const month = index + 1;
                return (
                <button
                  className={[
                    month === selectedExportMonth.month ? "is-active" : "",
                    currentExportMonthSelection.year === selectedExportMonth.year && currentExportMonthSelection.month === month ? "is-current" : "",
                  ].filter(Boolean).join(" ")}
                  key={label}
                  type="button"
                  onClick={() => {
                    setSelectedExportMonth((current) => ({ ...current, month }));
                    setExportDownloadError(null);
                  }}
                >
                  {label}
                </button>
                );
              })}
            </div>
          </div>

          <div className="time-export-panel">
            <div className="time-entries-toolbar">
              <div>
                <h2>Exportvorschau</h2>
                <p>{exportMonthLabel} · {formatRangeLabel(exportMonthRange.start, exportMonthRange.end)}.</p>
              </div>
            </div>

            {reviewAllEntriesError && <p className="time-table-note">{reviewAllEntriesError}</p>}
            {reviewEntriesError && <p className="time-table-note">{reviewEntriesError}</p>}
            {(isLoadingReviewAllEntries || isLoadingReviewEntries) && <p className="time-table-note">Exportvorschau wird geladen...</p>}

            <div className="time-summary-strip">
              <div><span>Automatisch geprüft</span><strong>{exportPreviewSummary.autoChecked}</strong></div>
              <div><span>Manuell geprüft</span><strong>{exportPreviewSummary.manuallyChecked}</strong></div>
              <div><span>Korrigiert</span><strong>{exportPreviewSummary.corrected}</strong></div>
              <div><span>Offen / Prüfung empfohlen</span><strong>{exportPreviewSummary.open}</strong></div>
              <div><span>Exportierbar</span><strong>{exportPreviewSummary.exportable}</strong></div>
              <div><span>Nicht exportierbar</span><strong>{exportPreviewSummary.notExportable}</strong></div>
            </div>

            <p className={notExportableRows.length ? "time-export-readiness is-blocked" : "time-export-readiness is-ready"}>
              {notExportableRows.length
                ? "Export noch nicht vollständig bereit: Es gibt noch Einträge mit Prüfung empfohlen."
                : "Export bereit: Alle Einträge sind automatisch oder manuell geprüft."}
            </p>

            <div className="time-export-download-panel">
              {notExportableRows.length > 0 && (
                <p>
                  Achtung: Es gibt noch offene Einträge mit Prüfung empfohlen. Der XLSX-Export enthält nur automatisch oder manuell geprüfte Zeiten.
                </p>
              )}
              {exportDownloadError && <p>{exportDownloadError}</p>}
              <div className="time-export-download-actions">
                <div>
                  <strong>{exportPreviewSummary.exportable}</strong>
                  <span>exportierbare Einträge</span>
                </div>
                <div>
                  <strong>{exportPreviewSummary.notExportable}</strong>
                  <span>offene Einträge</span>
                </div>
                <button
                  className="icon-button"
                  disabled={exportableRows.length === 0 || isDownloadingExport}
                  type="button"
                  onClick={() => void downloadTimeExportXlsx()}
                >
                  {isDownloadingExport ? "XLSX wird erstellt..." : "Geprüfte Zeiten als XLSX exportieren"}
                </button>
              </div>
            </div>

            {notExportableRows.length > 0 && (
              <div className="time-export-open-panel">
                <h3>Diese Einträge sind noch nicht exportierbar</h3>
                <div className="time-export-open-list">
                  {notExportableRows.map((row) => (
                    <div key={row.id}>
                      <strong>{formatDate(row.workDate)} · {row.personName}</strong>
                      <span>{row.siteNumber} · {row.siteName}</span>
                      <small>{row.instruction}</small>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!reviewAllEntriesError && exportPreviewRows.length === 0 && !isLoadingReviewAllEntries && (
              <div className="empty-panel">Keine Zeiten im ausgewählten Zeitraum vorhanden.</div>
            )}

            {!reviewAllEntriesError && exportPreviewRows.length > 0 && (
              <div className="time-table-scroll">
                <table className="time-entries-table time-export-preview-table">
                  <thead>
                    <tr>
                      <th>Datum</th>
                      <th>Tag</th>
                      <th>Monteur</th>
                      <th>Baustellennr.</th>
                      <th>Baustellenname</th>
                      <th>Gemeldete Zeit</th>
                      <th>GPS-Zeit</th>
                      <th>Korrigierte Zeit</th>
                      <th>Gültige Arbeitszeit</th>
                      <th>Exportstatus</th>
                      <th>Prüfhinweis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exportPreviewRows.map((row) => (
                      <tr className={row.status === "corrected" ? "is-corrected" : ""} key={row.id}>
                        <td>{formatDate(row.workDate)}</td>
                        <td>{formatWeekday(row.workDate)}</td>
                        <td>{row.personName}</td>
                        <td>{row.siteNumber}</td>
                        <td>{row.siteName}</td>
                        <td>{formatHalfHour(row.reportedMinutes)}</td>
                        <td>{formatHalfHour(row.gpsMinutes)}</td>
                        <td>{formatHalfHour(row.correctedMinutes)}</td>
                        <td><strong>{formatHalfHour(row.validMinutes)}</strong></td>
                        <td><StatusBadge tone={row.statusTone}>{row.statusLabel}</StatusBadge></td>
                        <td>{row.instruction}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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

      {activeTimeSubtab === "workerTimes" && (
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
        </div>
      </div>
      )}
    </section>
  );
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

function currentMonthRange(): { start: string; end: string } {
  const today = new Date();
  return {
    start: toDateInputValue(new Date(today.getFullYear(), today.getMonth(), 1)),
    end: toDateInputValue(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
  };
}

function currentExportMonth(): ExportMonthSelection {
  const today = new Date();
  return { year: today.getFullYear(), month: today.getMonth() + 1 };
}

function monthRange(year: number, month: number): { start: string; end: string } {
  return {
    start: toDateInputValue(new Date(year, month - 1, 1)),
    end: toDateInputValue(new Date(year, month, 0)),
  };
}

function buildExportYearOptions(selectedYear: number): number[] {
  const currentYear = new Date().getFullYear();
  const years = new Set([currentYear - 1, currentYear, currentYear + 1, selectedYear]);
  return [...years].sort((left, right) => left - right);
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
  const hours = minutes / 60;
  return Number.isInteger(hours)
    ? String(hours)
    : hours.toLocaleString("de-DE", { maximumFractionDigits: 1 });
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

function isWeekendDate(value: string): boolean {
  const day = parseDateInput(value).getDay();
  return day === 0 || day === 6;
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
      const totalMinutes = summary.entries.reduce((sum, entry) => sum + (entry.corrected_work_minutes ?? entry.work_minutes ?? 0), 0);
      const submittedMinutes = summary.entries.reduce((sum, entry) => (
        entry.is_gps_suggestion ? sum : sum + entry.work_minutes
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
    || timeEntrySiteLabel(left).localeCompare(timeEntrySiteLabel(right), "de")
    || left.id - right.id;
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

  return numberRange(0, 4).map((dayOffset) => {
    const date = addDaysToDateInput(weekStart, dayOffset);
    return {
      date,
      weekdayLabel: formatWeekday(date),
      absenceType: personId === null ? null : highestPriorityAbsenceTypeForPersonDate(absences, personId, date),
      entries: (entriesByDate.get(date) ?? [])
        .slice()
        .sort(compareTimeReviewWorkerEntries)
        .map((entry) => ({
          entry,
          locationCheck: classifyTimeReviewLocationCheck(entry),
          timeCheck: classifyTimeReviewTimeCheck(entry),
        })),
    };
  });
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
  const hasGpsSignal = Boolean(entry.gps_first_seen_at || entry.gps_last_seen_at || entry.gps_total_points);
  if (
    entry.gps_not_checkable
    || entry.gps_status === "not_checkable"
    || entry.review_notices.includes(GPS_NOT_CHECKABLE_NOTICE)
  ) {
    return "unknown";
  }
  if (entry.gps_status === "missing" || !hasGpsSignal) {
    return entry.time_review_status !== "open" && entry.time_review_status !== "not_verifiable" ? "ok" : "unknown";
  }
  if (
    entry.gps_status === "mismatch"
    || entry.planned_vs_gps_mismatch
    || entry.manual_vs_gps_mismatch
    || entry.manual_vs_planned_mismatch
    || (entry.gps_detected_location_type === "company" && Boolean(entry.site_id || entry.planned_site_labels.length))
  ) {
    return "warning";
  }
  if (entry.gps_status === "matched" || entry.time_review_status !== "open") {
    return "ok";
  }
  return "unknown";
}

function classifyTimeReviewTimeCheck(entry: TimeEntry): TimeReviewCheckState {
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
  return Math.abs(gpsMinutes - manualMinutes) <= GPS_TIME_TOLERANCE_MINUTES ? "ok" : "warning";
}

function renderTimeReviewCheckMark(state: TimeReviewCheckState) {
  const label = timeReviewCheckLabel(state);
  return (
    <span className={`time-review-check-mark is-${state}`} aria-label={label} title={label}>
      {state === "ok" ? "✓" : state === "warning" ? "!" : "-"}
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
  if (!hasBackendReviewNotice(entry) && deviationMinutes !== null && Math.abs(deviationMinutes) <= GPS_TIME_TOLERANCE_MINUTES) {
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
    if (
      entry.gps_work_minutes !== null
      && !hasBackendReviewNotice(entry)
      && Math.abs(entry.gps_work_minutes - entry.work_minutes) <= GPS_TIME_TOLERANCE_MINUTES
    ) {
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

function buildExportPreviewRows(entries: TimeEntry[], openEntries: TimeEntry[]): ExportPreviewRow[] {
  const entryById = new Map<number, TimeEntry>();
  for (const entry of entries) {
    entryById.set(entry.id, entry);
  }
  for (const entry of openEntries) {
    if (entry.is_gps_suggestion) {
      entryById.set(entry.id, entry);
    }
  }
  return [...entryById.values()]
    .map(timeEntryToExportPreviewRow)
    .sort((left, right) => (
      left.workDate.localeCompare(right.workDate)
      || left.personName.localeCompare(right.personName, "de", { sensitivity: "base" })
      || left.siteNumber.localeCompare(right.siteNumber, "de", { sensitivity: "base" })
      || left.id - right.id
    ));
}

function timeEntryToExportPreviewRow(entry: TimeEntry): ExportPreviewRow {
  const reportedMinutes = entry.is_gps_suggestion ? null : entry.original_work_minutes ?? entry.work_minutes;
  const correctedMinutes = entry.corrected_work_minutes;
  const validMinutes = correctedMinutes ?? reportedMinutes;
  const status = exportPreviewStatus(entry);
  const tableRow = timeEntryToTableRow(entry, exportPreviewStatusLabel(status), exportPreviewStatusTone(status));
  return {
    id: entry.id,
    entry,
    workDate: entry.work_date,
    personName: entry.person_name,
    siteNumber: timeEntrySiteNumber(entry),
    siteName: timeEntrySiteName(entry),
    reportedMinutes,
    gpsMinutes: entry.gps_work_minutes,
    correctedMinutes,
    validMinutes,
    status,
    statusLabel: exportPreviewStatusLabel(status),
    statusTone: exportPreviewStatusTone(status),
    isExportable: status !== "not_exportable",
    instruction: buildTimeReviewInstruction(tableRow),
  };
}

function exportPreviewStatus(entry: TimeEntry): ExportPreviewStatus {
  if (entry.is_gps_suggestion) {
    return "not_exportable";
  }
  if (isAutoPlausibleEntry(entry)) {
    return "auto_checked";
  }
  if (
    entry.time_review_status === "corrected"
    || entry.corrected_work_minutes !== null
    || entry.time_review_method === "accept_gps"
    || entry.time_review_method === "manual_correction"
    || entry.time_review_method === "assign_site"
  ) {
    return "corrected";
  }
  if (
    entry.time_review_status === "manually_approved"
    || entry.time_review_status === "not_verifiable"
    || entry.time_review_status === "auto_closed_by_deadline"
  ) {
    return "manually_checked";
  }
  return "not_exportable";
}

function exportPreviewStatusLabel(status: ExportPreviewStatus): string {
  if (status === "auto_checked") {
    return "automatisch geprüft";
  }
  if (status === "manually_checked") {
    return "manuell geprüft";
  }
  if (status === "corrected") {
    return "korrigiert";
  }
  return "offen / nicht exportierbar";
}

function exportPreviewStatusTone(status: ExportPreviewStatus): StatusBadgeTone {
  if (status === "not_exportable") {
    return "warning";
  }
  if (status === "corrected") {
    return "planned";
  }
  return "active";
}

function calculateExportPreviewSummary(rows: ExportPreviewRow[]): ExportPreviewSummary {
  return rows.reduce<ExportPreviewSummary>((summary, row) => {
    if (row.status === "auto_checked") {
      summary.autoChecked += 1;
    } else if (row.status === "manually_checked") {
      summary.manuallyChecked += 1;
    } else if (row.status === "corrected") {
      summary.corrected += 1;
    } else {
      summary.open += 1;
    }
    if (row.isExportable) {
      summary.exportable += 1;
    } else {
      summary.notExportable += 1;
    }
    return summary;
  }, {
    autoChecked: 0,
    manuallyChecked: 0,
    corrected: 0,
    open: 0,
    exportable: 0,
    notExportable: 0,
  });
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
      return {
        id: entry.id,
        workDate: entry.work_date,
        personName: entry.person_name,
        siteLabel: timeEntrySiteLabel(entry),
        siteKey: timeEntrySiteLabel(entry),
        finalMinutes: entry.work_minutes,
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
    if (
      entry.gps_work_minutes !== null
      && !hasBackendReviewNotice(entry)
      && Math.abs(entry.gps_work_minutes - entry.work_minutes) <= GPS_TIME_TOLERANCE_MINUTES
    ) {
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
  if (
    entry.gps_work_minutes !== null
    && !hasBackendReviewNotice(entry)
    && Math.abs(entry.gps_work_minutes - entry.work_minutes) <= GPS_TIME_TOLERANCE_MINUTES
  ) {
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

function timeEntrySiteLabel(entry: TimeEntry): string {
  return [entry.site_name, entry.site_number].filter(Boolean).join(" · ") || "-";
}

function timeEntrySiteNumber(entry: TimeEntry): string {
  return entry.site_number || "-";
}

function timeEntrySiteName(entry: TimeEntry): string {
  return entry.site_name || "-";
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
