import { Clock3, Pencil, Plus, RefreshCw } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "../auth/AuthContext";
import { StatusBadge, type StatusBadgeTone } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { TimeGpsTestDataGenerateRequest, TimeGpsTestDataGenerateResponse } from "../types/devTestData";
import type { GpsRecentLocationPoint } from "../types/gps";
import type { AssignmentRead } from "../types/matrix";
import type { Person } from "../types/person";
import type { SiteSummary } from "../types/site";
import type { TimeEntry, TimeEntryCreate, TimeEntryGpsStatus, TimeEntryStatus, TimeReviewDecision } from "../types/timeEntry";

type RangeMode = "week" | "month";
type TimeSubtab = "review" | "gpsVerification" | "workerTimes" | "evaluation";
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
type TimeReviewTableRow = {
  id: number;
  entry: TimeEntry;
  issue: TimeReviewIssue | null;
  workDate: string;
  personName: string;
  siteLabel: string;
  manualMinutes: number | null;
  gpsMinutes: number | null;
  deviationMinutes: number | null;
  correctedMinutes: number | null;
  statusLabel: string;
  statusTone: StatusBadgeTone;
  systemHint: string;
  canConfirm: boolean;
};
type TestDataRangeMode = "week" | "month" | "custom";
type TestDataFormState = {
  rangeMode: TestDataRangeMode;
  start_date: string;
  end_date: string;
  error_rate_percent: string;
  seed: string;
  clear_previous_test_data: boolean;
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
const timeSubtabs: { key: TimeSubtab; label: string }[] = [
  { key: "review", label: "Stundenprüfung" },
  { key: "gpsVerification", label: "GPS-Prüfung" },
  { key: "workerTimes", label: "Monteurszeiten" },
  { key: "evaluation", label: "Auswertung" },
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
  const [reviewStatusFilter, setReviewStatusFilter] = useState<ReviewSummaryFilter>("all");
  const [reviewPersonFilter, setReviewPersonFilter] = useState("");
  const [isCheckingTestDataTool, setIsCheckingTestDataTool] = useState(false);
  const [isTestDataToolEnabled, setIsTestDataToolEnabled] = useState(false);
  const [testDataForm, setTestDataForm] = useState<TestDataFormState>(() => defaultTestDataForm());
  const [testDataSummary, setTestDataSummary] = useState<TimeGpsTestDataGenerateResponse | null>(null);
  const [lastTestDataBatchId, setLastTestDataBatchId] = useState<string | null>(() => localStorage.getItem("kb_time_gps_test_batch_id"));
  const [testDataMessage, setTestDataMessage] = useState<string | null>(null);
  const [testDataError, setTestDataError] = useState<string | null>(null);
  const [isGeneratingTestData, setIsGeneratingTestData] = useState(false);
  const [isClearingTestData, setIsClearingTestData] = useState(false);
  const canManageTimeEntries = user?.role === "admin" || user?.role === "project_manager" || user?.role === "office";
  const canUseTestDataTool = user?.role === "admin";
  const canViewGpsVerification = canManageTimeEntries;
  const visibleTimeSubtabs = canViewGpsVerification
    ? timeSubtabs
    : timeSubtabs.filter((tab) => tab.key !== "gpsVerification");
  const reviewWeekStripRef = useRef<HTMLDivElement | null>(null);
  const hasAutoScrolledReviewWeekRef = useRef(false);

  useEffect(() => {
    void loadPeople();
  }, []);

  useEffect(() => {
    if (!canUseTestDataTool) {
      setIsTestDataToolEnabled(false);
      return;
    }

    let ignore = false;
    setIsCheckingTestDataTool(true);
    setTestDataError(null);
    api.timeGpsTestDataStatus()
      .then((status) => {
        if (ignore) {
          return;
        }
        setIsTestDataToolEnabled(status.enabled);
        if (!status.enabled) {
          setTestDataError(status.message ?? "Testdaten-Generator ist in dieser Umgebung deaktiviert.");
        }
      })
      .catch(() => {
        if (!ignore) {
          setIsTestDataToolEnabled(false);
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsCheckingTestDataTool(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [canUseTestDataTool]);

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
  const reviewWeekOptions = useMemo(
    () => buildCalendarWeekOptions(currentReviewWeek),
    [currentReviewWeek],
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
  const timeReviewIssues = useMemo(() => buildTimeReviewIssues(reviewEntries), [reviewEntries]);
  const reviewTableRows = useMemo(
    () => buildTimeReviewTableRows(timeReviewIssues, reviewAllEntries, reviewStatusFilter, reviewPersonFilter),
    [reviewAllEntries, reviewPersonFilter, reviewStatusFilter, timeReviewIssues],
  );
  const reviewSummary = useMemo(
    () => calculateReviewSummary(timeReviewIssues, reviewAllEntries),
    [reviewAllEntries, timeReviewIssues],
  );
  const finalHoursEntries = useMemo(() => buildFinalHoursEntries(reviewAllEntries), [reviewAllEntries]);
  const finalHoursTotals = useMemo(() => calculateFinalHoursTotals(finalHoursEntries), [finalHoursEntries]);
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
    if (activeTimeSubtab !== "review" && activeTimeSubtab !== "evaluation") {
      return;
    }

    let ignore = false;
    setIsLoadingReviewEntries(true);
    setReviewEntriesError(null);

    api.timeEntries({
      dateFrom: reviewWeekRange.start,
      dateTo: reviewWeekRange.end,
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
  }, [activeTimeSubtab, entriesRefreshKey, reviewWeekRange.end, reviewWeekRange.start]);

  useLayoutEffect(() => {
    if (activeTimeSubtab !== "review") {
      return;
    }
    if (hasAutoScrolledReviewWeekRef.current) {
      return;
    }
    const selectedWeekIndex = reviewWeekOptions.findIndex(
      (option) => option.year === selectedReviewWeek.year && option.week === selectedReviewWeek.week,
    );
    if (selectedWeekIndex < 0) {
      return;
    }
    const firstVisibleIndex = Math.max(0, selectedWeekIndex - 5);
    const targetButton = reviewWeekStripRef.current?.querySelector<HTMLButtonElement>(
      `[data-week-index="${firstVisibleIndex}"]`,
    );
    targetButton?.scrollIntoView({ block: "nearest", inline: "start" });
    hasAutoScrolledReviewWeekRef.current = true;
  }, [activeTimeSubtab, reviewWeekOptions, selectedReviewWeek.week, selectedReviewWeek.year]);

  useEffect(() => {
    if (activeTimeSubtab !== "review" && activeTimeSubtab !== "evaluation") {
      return;
    }

    let ignore = false;
    setIsLoadingReviewAllEntries(true);
    setReviewAllEntriesError(null);

    api.timeEntries({
      dateFrom: reviewWeekRange.start,
      dateTo: reviewWeekRange.end,
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
  }, [activeTimeSubtab, entriesRefreshKey, reviewWeekRange.end, reviewWeekRange.start]);

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

  function updateTestDataRangeMode(mode: TestDataRangeMode): void {
    const nextRange = mode === "week" ? currentWeekRange() : mode === "month" ? currentMonthRange() : null;
    setTestDataForm((current) => ({
      ...current,
      rangeMode: mode,
      start_date: nextRange?.start ?? current.start_date,
      end_date: nextRange?.end ?? current.end_date,
    }));
  }

  function refreshTimeDataAfterTestDataChange(): void {
    setEntriesRefreshKey((current) => current + 1);
    if (canViewGpsVerification) {
      void loadRecentGpsPoints();
    }
  }

  async function generateTestDataBatch(): Promise<void> {
    if (!canUseTestDataTool || isGeneratingTestData || isClearingTestData) {
      return;
    }
    const payloadResult = buildTestDataGeneratePayload(testDataForm);
    if (!payloadResult.ok) {
      setTestDataError(payloadResult.error);
      setTestDataMessage(null);
      return;
    }

    setIsGeneratingTestData(true);
    setTestDataError(null);
    setTestDataMessage(null);
    try {
      const summary = await api.generateTimeGpsTestData(payloadResult.payload);
      setTestDataSummary(summary);
      setLastTestDataBatchId(summary.batch_id);
      localStorage.setItem("kb_time_gps_test_batch_id", summary.batch_id);
      setTestDataMessage("Testdaten erzeugt. Stundenprüfung und GPS-Prüfung wurden aktualisiert.");
      refreshTimeDataAfterTestDataChange();
    } catch (requestError) {
      setTestDataError(readApiError(requestError, "Testdaten konnten nicht erzeugt werden."));
    } finally {
      setIsGeneratingTestData(false);
    }
  }

  async function deleteLastTestDataBatch(): Promise<void> {
    if (!lastTestDataBatchId || isGeneratingTestData || isClearingTestData) {
      return;
    }
    const confirmed = window.confirm(`Testdaten-Batch ${lastTestDataBatchId} löschen? Normale Daten bleiben erhalten.`);
    if (!confirmed) {
      return;
    }

    setIsClearingTestData(true);
    setTestDataError(null);
    setTestDataMessage(null);
    try {
      await api.deleteTimeGpsTestDataBatch(lastTestDataBatchId);
      localStorage.removeItem("kb_time_gps_test_batch_id");
      setLastTestDataBatchId(null);
      setTestDataSummary(null);
      setTestDataMessage("Letzter Testdaten-Batch wurde gelöscht.");
      refreshTimeDataAfterTestDataChange();
    } catch (requestError) {
      setTestDataError(readApiError(requestError, "Testdaten konnten nicht gelöscht werden."));
    } finally {
      setIsClearingTestData(false);
    }
  }

  async function deleteAllTestData(): Promise<void> {
    if (isGeneratingTestData || isClearingTestData) {
      return;
    }
    const confirmed = window.confirm("Alle Generator-Testdaten löschen? Normale Daten bleiben erhalten.");
    if (!confirmed) {
      return;
    }

    setIsClearingTestData(true);
    setTestDataError(null);
    setTestDataMessage(null);
    try {
      await api.deleteAllTimeGpsTestData();
      localStorage.removeItem("kb_time_gps_test_batch_id");
      setLastTestDataBatchId(null);
      setTestDataSummary(null);
      setTestDataMessage("Alle Generator-Testdaten wurden gelöscht.");
      refreshTimeDataAfterTestDataChange();
    } catch (requestError) {
      setTestDataError(readApiError(requestError, "Testdaten konnten nicht gelöscht werden."));
    } finally {
      setIsClearingTestData(false);
    }
  }

  return (
    <section className="time-entries-page is-figma-times-workspace">
      <div className="page-header entity-page-header">
        <div>
          <p className="eyebrow">Arbeitszeiten</p>
          <h1>Zeiten</h1>
          <p className="page-subtitle">Arbeitszeiten der Monteure wochen- oder monatsweise pruefen.</p>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      {canUseTestDataTool && isCheckingTestDataTool && (
        <div className="time-test-data-status">Testdaten-Werkzeug wird geprüft...</div>
      )}

      {canUseTestDataTool && isTestDataToolEnabled && (
        <details className="time-test-data-panel">
          <summary>
            <span>
              <strong>Testdaten für Zeitprüfung</strong>
              <small>Nur für Staging/Entwicklung</small>
            </span>
          </summary>
          <div className="time-test-data-content">
            <p>
              Erzeugt realistische GPS- und Arbeitszeitdaten für die Prüfung. Normale Daten werden nicht gelöscht.
            </p>
            <div className="time-test-data-form">
              <div className="matrix-pm-filter" aria-label="Testdaten-Zeitraum">
                <button
                  className={testDataForm.rangeMode === "week" ? "is-active" : ""}
                  type="button"
                  onClick={() => updateTestDataRangeMode("week")}
                >
                  Aktuelle Woche
                </button>
                <button
                  className={testDataForm.rangeMode === "month" ? "is-active" : ""}
                  type="button"
                  onClick={() => updateTestDataRangeMode("month")}
                >
                  Aktueller Monat
                </button>
                <button
                  className={testDataForm.rangeMode === "custom" ? "is-active" : ""}
                  type="button"
                  onClick={() => updateTestDataRangeMode("custom")}
                >
                  Eigener Zeitraum
                </button>
              </div>
              <label>
                <span>Startdatum</span>
                <input
                  type="date"
                  value={testDataForm.start_date}
                  onChange={(event) => setTestDataForm((current) => ({ ...current, rangeMode: "custom", start_date: event.target.value }))}
                />
              </label>
              <label>
                <span>Enddatum</span>
                <input
                  type="date"
                  value={testDataForm.end_date}
                  onChange={(event) => setTestDataForm((current) => ({ ...current, rangeMode: "custom", end_date: event.target.value }))}
                />
              </label>
              <label>
                <span>Fehlerquote (%)</span>
                <input
                  inputMode="decimal"
                  value={testDataForm.error_rate_percent}
                  onChange={(event) => setTestDataForm((current) => ({ ...current, error_rate_percent: event.target.value }))}
                />
              </label>
              <label>
                <span>Seed</span>
                <input
                  inputMode="numeric"
                  placeholder="optional"
                  value={testDataForm.seed}
                  onChange={(event) => setTestDataForm((current) => ({ ...current, seed: event.target.value }))}
                />
              </label>
              <label className="time-test-data-checkbox">
                <input
                  checked={testDataForm.clear_previous_test_data}
                  type="checkbox"
                  onChange={(event) => setTestDataForm((current) => ({ ...current, clear_previous_test_data: event.target.checked }))}
                />
                <span>Vorherige Generator-Testdaten löschen</span>
              </label>
            </div>
            {testDataError && <p className="form-error">{testDataError}</p>}
            {testDataMessage && <p className="time-table-note">{testDataMessage}</p>}
            <div className="time-test-data-actions">
              <button
                className="icon-button"
                disabled={isGeneratingTestData || isClearingTestData}
                type="button"
                onClick={() => void generateTestDataBatch()}
              >
                {isGeneratingTestData ? "Erzeugt..." : "Testdaten erzeugen"}
              </button>
              <button
                className="icon-button secondary"
                disabled={!lastTestDataBatchId || isGeneratingTestData || isClearingTestData}
                type="button"
                onClick={() => void deleteLastTestDataBatch()}
              >
                Letzten Batch löschen
              </button>
              <button
                className="time-table-action"
                disabled={isGeneratingTestData || isClearingTestData}
                type="button"
                onClick={() => void deleteAllTestData()}
              >
                Alle Testdaten löschen
              </button>
              <button className="time-table-action" type="button" onClick={refreshTimeDataAfterTestDataChange}>
                Stundenprüfung aktualisieren
              </button>
            </div>
            {lastTestDataBatchId && <p className="time-test-data-batch">Letzter Batch: {lastTestDataBatchId}</p>}
            {testDataSummary && (
              <div className="time-test-data-result">
                <div className="time-summary-strip">
                  <div><span>Batch</span><strong>{testDataSummary.batch_id}</strong></div>
                  <div><span>Arbeitszeiten</span><strong>{testDataSummary.work_time_entries_created}</strong></div>
                  <div><span>GPS-Punkte</span><strong>{testDataSummary.gps_points_created}</strong></div>
                  <div><span>Offene Prüffälle</span><strong>{testDataSummary.expected_open_review_cases}</strong></div>
                  <div><span>Geprüfte Fälle</span><strong>{testDataSummary.expected_checked_cases}</strong></div>
                </div>
                <div className="time-test-data-scenarios" aria-label="Szenarien-Zusammenfassung">
                  {Object.entries(testDataSummary.scenarios).map(([scenario, count]) => (
                    <span key={scenario}>{scenarioLabel(scenario)}: {count}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>
      )}

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
          </div>

          <div className="time-review-summary-cards">
            <ReviewSummaryCard
              active={reviewStatusFilter === "all"}
              label="Alle"
              onClick={() => setReviewStatusFilter("all")}
              tone="warning"
              value={reviewSummary.all}
            />
            <ReviewSummaryCard
              active={reviewStatusFilter === "matches"}
              label="Passt"
              onClick={() => setReviewStatusFilter("matches")}
              tone="active"
              value={reviewSummary.autoPlausible}
            />
            <ReviewSummaryCard
              active={reviewStatusFilter === "needs_review"}
              label="Prüfung empfohlen"
              onClick={() => setReviewStatusFilter("needs_review")}
              tone="planned"
              value={reviewSummary.reviewRecommended}
            />
            <ReviewSummaryCard
              active={reviewStatusFilter === "verified"}
              label="Manuell geprüft"
              onClick={() => setReviewStatusFilter("verified")}
              tone="active"
              value={reviewSummary.verified}
            />
          </div>

          <div className="time-review-filters">
            <label>
              <span>Monteur</span>
              <input
                placeholder="Alle Monteure"
                value={reviewPersonFilter}
                onChange={(event) => setReviewPersonFilter(event.target.value)}
              />
            </label>
          </div>

          <div className="time-review-table-panel">
            {reviewActionError && <p className="time-table-note">{reviewActionError}</p>}
            {isLoadingReviewEntries && reviewTableRows.length > 0 && (
              <p className="time-table-note">Kalenderwoche wird geladen...</p>
            )}
            {isLoadingReviewEntries && reviewTableRows.length === 0 && <div className="empty-panel">Stundenprüfung wird geladen...</div>}
            {!isLoadingReviewEntries && reviewEntriesError && <div className="empty-panel">{reviewEntriesError}</div>}
            {!isLoadingReviewEntries && !reviewEntriesError && reviewTableRows.length === 0 && (
              <div className="empty-panel">
                {reviewStatusFilter === "all"
                  ? "Keine Zeitprüffälle in dieser Kalenderwoche."
                  : `Keine Fälle für diesen Status in KW ${selectedReviewWeek.week}.`}
              </div>
            )}
            {!reviewEntriesError && reviewTableRows.length > 0 && (
              <div className="time-table-scroll">
                <table className="time-entries-table time-review-compact-table">
                  <thead>
                    <tr>
                      <th>Baustelle</th>
                      <th>Gemeldete Zeit</th>
                      <th>GPS-Zeit</th>
                      <th>Zeitdifferenz</th>
                      <th>Korrigierte Zeit</th>
                      <th>Entscheidung</th>
                    </tr>
                  </thead>
                  <tbody>
                    {renderReviewTableRows({
                      rows: reviewTableRows,
                      expandedReviewEntryId,
                      reviewDecisionForm,
                      reviewActionEntryId,
                      isSavingReviewDecision,
                      siteOptions,
                      canManageTimeEntries,
                      onConfirm: confirmReviewRow,
                      onOpenIssue: openReviewIssue,
                      onCloseIssue: closeReviewIssue,
                      onSaveDecision: saveReviewDecision,
                      onReviewDecisionFormChange: setReviewDecisionForm,
                      onDecideIssue: decideReviewIssue,
                    })}
                  </tbody>
                </table>
              </div>
            )}
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

function ReviewSummaryCard({
  active,
  label,
  onClick,
  tone,
  value,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  tone: StatusBadgeTone;
  value: number;
}) {
  return (
    <button
      className={`time-review-summary-card time-review-summary-card-${tone}${active ? " is-active" : ""}`}
      type="button"
      onClick={onClick}
    >
      <span>{label}</span>
      <strong>{value}</strong>
    </button>
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
  return rows.map((row, index) => {
    const issue = row.issue;
    const isExpanded = expandedReviewEntryId === row.id && issue !== null;
    const isBusy = reviewActionEntryId === row.id || isSavingReviewDecision;
    const previousRow = rows[index - 1] ?? null;
    const nextRow = rows[index + 1] ?? null;
    const showPersonGroup = previousRow?.personName !== row.personName;
    const showDayGroup = showPersonGroup || previousRow?.workDate !== row.workDate;
    const hasNextSameDay = nextRow?.personName === row.personName && nextRow.workDate === row.workDate;
    const rowClassName = [
      "time-review-entry-row",
      isExpanded ? "is-expanded" : "",
      showDayGroup ? "is-day-start" : "is-same-day-continuation",
      hasNextSameDay ? "has-same-day-next" : "",
    ].filter(Boolean).join(" ");

    return (
      <Fragment key={row.id}>
        {showPersonGroup && (
          <tr className="time-review-group-row">
            <td colSpan={6}>{row.personName}</td>
          </tr>
        )}
        <tr className={rowClassName}>
          <td>
            <div className="time-review-site-cell">
              <strong>{row.siteLabel}</strong>
              <span>{formatWeekday(row.workDate)} {formatDate(row.workDate)} · {row.systemHint}</span>
            </div>
          </td>
          <td>{formatHalfHour(row.manualMinutes)}</td>
          <td>{formatHalfHour(row.gpsMinutes)}</td>
          <td>
            <span className={Math.abs(row.deviationMinutes ?? 0) > 60 ? "time-review-delta is-critical" : "time-review-delta"}>
              {formatHalfHourDelta(row.deviationMinutes)}
            </span>
          </td>
          <td>{formatHalfHour(row.correctedMinutes)}</td>
          <td>
            <div className="time-review-table-actions">
              {canManageTimeEntries && row.canConfirm ? (
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
              )}
              {issue && (
                <button
                  className="time-table-action"
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
              )}
            </div>
          </td>
        </tr>
        {isExpanded && issue && (
          <tr className="time-review-detail-row">
            <td colSpan={6}>
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

function defaultTestDataForm(): TestDataFormState {
  const weekRange = currentWeekRange();
  return {
    rangeMode: "week",
    start_date: weekRange.start,
    end_date: weekRange.end,
    error_rate_percent: "30",
    seed: defaultTestDataSeed(),
    clear_previous_test_data: false,
  };
}

function defaultTestDataSeed(): string {
  const today = new Date();
  return `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
}

function buildTestDataGeneratePayload(
  form: TestDataFormState,
): { ok: true; payload: TimeGpsTestDataGenerateRequest } | { ok: false; error: string } {
  if (!form.start_date || !form.end_date) {
    return { ok: false, error: "Bitte einen Zeitraum auswaehlen." };
  }
  if (form.end_date < form.start_date) {
    return { ok: false, error: "Das Enddatum darf nicht vor dem Startdatum liegen." };
  }

  const errorRatePercent = Number(form.error_rate_percent.trim().replace(",", "."));
  if (!Number.isFinite(errorRatePercent) || errorRatePercent < 0 || errorRatePercent > 100) {
    return { ok: false, error: "Die Fehlerquote muss zwischen 0 und 100 Prozent liegen." };
  }

  let seed: number | null = null;
  const seedValue = form.seed.trim();
  if (seedValue) {
    const parsedSeed = Number(seedValue);
    if (!Number.isInteger(parsedSeed)) {
      return { ok: false, error: "Der Seed muss eine ganze Zahl sein." };
    }
    seed = parsedSeed;
  }

  return {
    ok: true,
    payload: {
      start_date: form.start_date,
      end_date: form.end_date,
      error_rate: errorRatePercent / 100,
      seed,
      clear_previous_test_data: form.clear_previous_test_data,
    },
  };
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

function formatHalfHour(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) {
    return "-";
  }
  const roundedHours = Math.round(minutes / 30) / 2;
  const normalizedHours = Object.is(roundedHours, -0) ? 0 : roundedHours;
  return `${normalizedHours.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}

function formatHalfHourDelta(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) {
    return "-";
  }
  const roundedSteps = Math.round(minutes / 30);
  if (roundedSteps === 0) {
    return "0,0 h";
  }
  const prefix = minutes > 0 ? "+" : minutes < 0 ? "-" : "";
  return `${prefix}${formatHalfHour(Math.abs(minutes))}`;
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

function mergeTimeEntryReviewUpdate(previousEntry: TimeEntry, updatedEntry: TimeEntry): TimeEntry {
  return {
    ...updatedEntry,
    gps_status: updatedEntry.gps_status ?? previousEntry.gps_status,
    gps_matched_points: updatedEntry.gps_matched_points ?? previousEntry.gps_matched_points,
    gps_total_points: updatedEntry.gps_total_points ?? previousEntry.gps_total_points,
    gps_first_seen_at: updatedEntry.gps_first_seen_at ?? previousEntry.gps_first_seen_at,
    gps_last_seen_at: updatedEntry.gps_last_seen_at ?? previousEntry.gps_last_seen_at,
    gps_work_minutes: updatedEntry.gps_work_minutes ?? previousEntry.gps_work_minutes,
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

function reviewRowsForStatus(
  openIssues: TimeReviewIssue[],
  allEntries: TimeEntry[],
  status: ReviewSummaryFilter,
): TimeReviewTableRow[] {
  if (status === "all") {
    return [
      ...allEntries.filter(isAutoPlausibleEntry).map((entry) => timeEntryToTableRow(entry, "Passt", "active")),
      ...openIssues.map(timeReviewIssueToTableRow),
      ...allEntries
        .filter((entry) => entry.time_review_status !== "open")
        .map((entry) => timeEntryToTableRow(entry, finalStatusLabel(entry), "active")),
    ];
  }
  if (status === "needs_review") {
    return openIssues.map(timeReviewIssueToTableRow);
  }
  if (status === "matches") {
    return allEntries.filter(isAutoPlausibleEntry).map((entry) => timeEntryToTableRow(entry, "Passt", "active"));
  }
  return allEntries
    .filter((entry) => entry.time_review_status !== "open")
    .map((entry) => timeEntryToTableRow(entry, finalStatusLabel(entry), "active"));
}

function timeReviewIssueToTableRow(issue: TimeReviewIssue): TimeReviewTableRow {
  return {
    id: issue.id,
    entry: issue.entry,
    issue,
    workDate: issue.workDate,
    personName: issue.personName,
    siteLabel: issue.siteLabel,
    manualMinutes: issue.manualMinutes,
    gpsMinutes: issue.gpsMinutes,
    deviationMinutes: issue.deviationMinutes,
    correctedMinutes: issue.entry.corrected_work_minutes,
    statusLabel: issue.statusLabel,
    statusTone: issue.statusTone,
    systemHint: issue.systemHint,
    canConfirm: issue.manualMinutes !== null,
  };
}

function timeEntryToTableRow(entry: TimeEntry, statusLabel: string, statusTone: StatusBadgeTone): TimeReviewTableRow {
  const manualMinutes = Number.isFinite(entry.work_minutes) ? entry.work_minutes : null;
  const gpsMinutes = entry.gps_work_minutes;
  return {
    id: entry.id,
    entry,
    issue: null,
    workDate: entry.work_date,
    personName: entry.person_name,
    siteLabel: timeEntrySiteLabel(entry),
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
    && entry.gps_work_minutes !== null
    && Math.abs(entry.gps_work_minutes - entry.work_minutes) <= GPS_TIME_TOLERANCE_MINUTES
  );
}

function timeReviewIssue(entry: TimeEntry): TimeReviewIssue | null {
  if (entry.time_review_status !== "open") {
    return null;
  }
  const manualMinutes = Number.isFinite(entry.work_minutes) ? entry.work_minutes : null;
  const gpsMinutes = entry.gps_work_minutes;
  if (manualMinutes === null && gpsMinutes === null) {
    return null;
  }
  const deviationMinutes = manualMinutes !== null && gpsMinutes !== null ? gpsMinutes - manualMinutes : null;
  if (deviationMinutes !== null && Math.abs(deviationMinutes) <= GPS_TIME_TOLERANCE_MINUTES) {
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

function classifyTimeReviewCase(
  entry: TimeEntry,
  manualMinutes: number | null,
  gpsMinutes: number | null,
  deviationMinutes: number | null,
): Pick<TimeReviewIssue, "status" | "statusLabel" | "statusTone" | "systemHint" | "priority" | "detail"> {
  if (!entry.site_id && manualMinutes !== null) {
    return {
      status: "critical",
      statusLabel: "Kritisch",
      statusTone: "warning",
      priority: 1,
      systemHint: "Arbeitszeit ist vorhanden, aber keine Baustelle zugeordnet.",
      detail: "Bitte Baustelle zuordnen oder bewusst als nicht zuordenbar klären.",
    };
  }
  if (manualMinutes === null && gpsMinutes !== null) {
    return {
      status: "needs_review",
      statusLabel: "Prüfung empfohlen",
      statusTone: "planned",
      priority: 2,
      systemHint: "GPS-Zeit ist vorhanden, aber keine manuelle Arbeitszeit erfasst.",
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
      systemHint: hasGpsSignals
        ? "GPS-Signale sind vorhanden, aber die GPS-Arbeitszeit ist nicht berechenbar."
        : "Keine GPS-Daten für diesen Tag vorhanden.",
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
      systemHint: "Die gemeldete Arbeitszeit ist ungewöhnlich lang.",
      detail: "Bitte die Stunden menschlich bestätigen oder korrigieren.",
    };
  }
  if (deviationMinutes !== null && Math.abs(deviationMinutes) > 60) {
    return {
      status: "critical",
      statusLabel: "Kritisch",
      statusTone: "warning",
      priority: 1,
      systemHint: "GPS-Zeit und gemeldete Zeit weichen deutlich voneinander ab.",
      detail: `Abweichung: ${formatHumanDeviation(deviationMinutes)}.`,
    };
  }
  return {
    status: "needs_review",
    statusLabel: "Prüfung empfohlen",
    statusTone: "planned",
    priority: 2,
    systemHint: "GPS-Zeit weicht mehr als 15 Minuten ab.",
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
  for (const entry of entries) {
    if (entry.time_review_status !== "open") {
      verified += 1;
      continue;
    }
    if (
      entry.gps_work_minutes !== null
      && Math.abs(entry.gps_work_minutes - entry.work_minutes) <= GPS_TIME_TOLERANCE_MINUTES
    ) {
      autoPlausible += 1;
    }
  }
  const reviewRecommended = openIssues.length;
  return {
    all: autoPlausible + reviewRecommended + verified,
    autoPlausible,
    verified,
    reviewRecommended,
    needsReview: openIssues.filter((issue) => issue.status === "needs_review").length,
    critical: openIssues.filter((issue) => issue.status === "critical").length,
    notVerifiable: openIssues.filter((issue) => issue.status === "not_verifiable").length,
  };
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

function scenarioLabel(scenario: string): string {
  const labels: Record<string, string> = {
    absence_conflict: "Abwesenheit + Arbeitszeit",
    already_reviewed: "Bereits geprüft",
    critical_deviation: "Kritische Abweichung",
    extreme_hours: "Extreme Arbeitszeit",
    missing_gps: "Kein GPS",
    new_device: "Neues Gerät",
    offline_resync: "Offline nachgesendet",
    outside_geofence: "Außerhalb Geofence",
    partial_gps: "GPS teilweise",
    plausible_normal: "Plausibel",
    poor_accuracy: "Ungenaue GPS-Punkte",
    review_recommended: "Prüfung empfohlen",
    site_without_coordinates: "Baustelle ohne Koordinaten",
    small_deviation: "Kleine Abweichung",
    two_sites: "Zwei Baustellen",
    weekend_work: "Wochenende",
    wrong_site: "Andere Baustelle",
  };
  return labels[scenario] ?? scenario;
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
