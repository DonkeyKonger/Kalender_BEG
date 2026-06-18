import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { absenceTypeLabels, siteStatusLabels } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import { SiteCreateDrawer } from "./SitesPage";
import type { Absence } from "../types/absence";
import type {
  MatrixAssignment,
  MatrixCell,
  MatrixCellMark,
  MatrixEntryInput,
  MatrixPerson,
  MatrixResponse,
  MatrixRow,
  AbsenceType,
  SiteStatus,
} from "../types/matrix";
import type { Person } from "../types/person";
import { calendarPersonCode, canEditMatrix } from "../types/person";
import {
  formatDayHeader,
  formatDayNumber,
  getDefaultPlanningRange,
  getIsoWeekInfo,
  getLowerSaxonyPublicHolidayMap,
  isWeekendDate,
  toDateInputValue,
  type HolidayInfo,
  type PlanningRange,
} from "../utils/dateRange";

type CellKey = `${number}-${string}`;
type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
type MatrixKeyboardEvent = KeyboardEvent | ReactKeyboardEvent<HTMLElement>;
type DraftEntry = MatrixEntryInput & { key: string; label: string };
type AssignmentSuggestion =
  | { kind: "person"; person: Person }
  | { kind: "create_external"; key: "create-external"; displayName: string };
type ActiveCell = { siteId: number; date: string; endDate: string; key: CellKey };
type ActiveAbsenceCell = { date: string; endDate: string };
type EditorAnchor = { bottom: number; left: number; top: number; width: number };
type SelectionCell = { siteId: number; date: string; dayIndex: number };
type CellRange = {
  siteId: number;
  startDate: string;
  endDate: string;
  startIndex: number;
  endIndex: number;
  dates: string[];
};
type MatrixCellMouseEvent = ReactMouseEvent<HTMLTableCellElement>;
type AssignmentDragMode = "move" | "copy";
type AssignmentDragTarget = SelectionCell;
type AssignmentResizeEdge = "start" | "end";
type AssignmentDragState = {
  assignment: MatrixAssignment;
  sourceSiteId: number;
  sourceStartDate: string;
  sourceEndDate: string;
  segmentStartDate: string;
  segmentEndDate: string;
  durationDays: number;
  mode: AssignmentDragMode;
  pointerOffsetX: number;
  pointerOffsetY: number;
  originX: number;
  originY: number;
  left: number;
  top: number;
  width: number;
  height: number;
  target: AssignmentDragTarget | null;
};
type AssignmentResizeState = {
  assignment: MatrixAssignment;
  edge: AssignmentResizeEdge;
  siteId: number;
  originalStartDate: string;
  originalEndDate: string;
  previewStartDate: string;
  previewEndDate: string;
  rowY: number;
};
type PlanningAbsenceItem = { absence: Absence };
type CellTypingPreview = { siteId: number; date: string; text: string };
type CalendarWeekGroup = { isoYear: number; week: number; dayCount: number; width: number };
type UpdatedMatrixSiteCells = { site_id: number; cells: MatrixCell[] };

type UndoItem = {
  siteId: number;
  date: string;
  endDate: string;
  before: DraftEntry[];
  after: DraftEntry[];
};

const CELL_ERROR_MESSAGE = "Nicht möglich";
const ERROR_AUTO_HIDE_MS = 5000;
const MAX_VISIBLE_ABSENCES_PER_DAY = 4;

export function MatrixPage() {
  const { user } = useAuth();
  const defaultRange = useMemo(() => getDefaultPlanningRange(), []);
  const [matrix, setMatrix] = useState<MatrixResponse | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const [editorAnchor, setEditorAnchor] = useState<EditorAnchor | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStartCell, setSelectionStartCell] = useState<SelectionCell | null>(null);
  const [selectionEndCell, setSelectionEndCell] = useState<SelectionCell | null>(null);
  const [activeEditorRange, setActiveEditorRange] = useState<CellRange | null>(null);
  const [draftEntries, setDraftEntries] = useState<DraftEntry[]>([]);
  const [initialEntries, setInitialEntries] = useState<DraftEntry[]>([]);
  const [personSearchSeed, setPersonSearchSeed] = useState("");
  const [highlightedPersonIndex, setHighlightedPersonIndex] = useState(-1);
  const [activeAbsenceCell, setActiveAbsenceCell] = useState<ActiveAbsenceCell | null>(null);
  const [absenceEditorAnchor, setAbsenceEditorAnchor] = useState<EditorAnchor | null>(null);
  const [selectedAbsencePersonId, setSelectedAbsencePersonId] = useState("");
  const [selectedAbsenceType, setSelectedAbsenceType] = useState<AbsenceType>("vacation");
  const [saveStatus, setSaveStatus] = useState<Record<CellKey, SaveStatus>>({});
  const [cellMessage, setCellMessage] = useState<Record<CellKey, string>>({});
  const [undoStack, setUndoStack] = useState<UndoItem[]>([]);
  const autosaveRef = useRef<number | null>(null);
  const cellMessageTimeoutsRef = useRef<Record<CellKey, number>>({});
  const errorTimeoutRef = useRef<number | null>(null);
  const skipNextDraftAutosaveRef = useRef(false);
  const activeCellRef = useRef<ActiveCell | null>(null);
  const activeEditorRangeRef = useRef<CellRange | null>(null);
  const matrixScrollRef = useRef<HTMLDivElement | null>(null);
  const selectionAnchorRef = useRef<EditorAnchor | null>(null);
  const assignmentDragRef = useRef<AssignmentDragState | null>(null);
  const assignmentResizeRef = useRef<AssignmentResizeState | null>(null);
  const didSetInitialProjectManagerFilter = useRef(false);
  const rangeScrollKeyRef = useRef<string | null>(null);
  const interactionWeekSnapKeyRef = useRef<string | null>(null);
  const rangeScrollFrameRef = useRef<number | null>(null);
  const rangeScrollSecondFrameRef = useRef<number | null>(null);
  const rangeScrollFallbackTimeoutRef = useRef<number | null>(null);
  const initialScrollSnapResetTimeoutRef = useRef<number | null>(null);
  const isApplyingWeekSnapRef = useRef(false);
  const hasLoadedPeopleRef = useRef(false);
  const today = useMemo(() => toDateInputValue(new Date()), []);
  const [projectManagerFilter, setProjectManagerFilter] = useState<string>("all");
  const [isCompactView, setIsCompactView] = useState(false);
  const [isYearView, setIsYearView] = useState(false);
  const [siteInfoDrafts, setSiteInfoDrafts] = useState<Record<number, string>>({});
  const [assignmentDrag, setAssignmentDrag] = useState<AssignmentDragState | null>(null);
  const [assignmentResize, setAssignmentResize] = useState<AssignmentResizeState | null>(null);
  const [savingInfoSiteId, setSavingInfoSiteId] = useState<number | null>(null);
  const [savingStatusSiteId, setSavingStatusSiteId] = useState<number | null>(null);
  const [isSavingAbsence, setIsSavingAbsence] = useState(false);
  const [isSiteCreateDrawerOpen, setIsSiteCreateDrawerOpen] = useState(false);
  const [siteCreateProjectManagerId, setSiteCreateProjectManagerId] = useState<number | null>(null);
  const isEditable = user ? canEditMatrix(user.role) : false;
  const matrixIsEditable = isEditable && !isYearView;
  const activeRange = useMemo(
    () => isYearView ? getYearPlanningRange(today) : defaultRange,
    [defaultRange, isYearView, today],
  );
  const dayColumnWidth = matrixDayColumnWidth(isCompactView);
  const selectedCellRange = useMemo(() => {
    if (!matrix || !selectionStartCell || !selectionEndCell) {
      return null;
    }
    return buildCellRange(selectionStartCell, selectionEndCell, matrix.days);
  }, [matrix, selectionEndCell, selectionStartCell]);
  const highlightedCellRange = isSelecting ? selectedCellRange : activeEditorRange;
  const assignmentResizeRange = useMemo(() => {
    if (!matrix || !assignmentResize) {
      return null;
    }
    return rangeFromDates(
      assignmentResize.siteId,
      assignmentResize.previewStartDate,
      assignmentResize.previewEndDate,
      matrix.days,
    );
  }, [assignmentResize, matrix]);
  const typingPreview = activeCell && editorAnchor && personSearchSeed
    ? { siteId: activeCell.siteId, date: activeCell.date, text: personSearchSeed }
    : null;
  const isDraggingAssignment = assignmentDrag !== null;
  const isResizingAssignment = assignmentResize !== null;
  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);
  const assignmentSuggestions = useMemo(() => {
    const rawQuery = personSearchSeed.trim();
    const query = rawQuery.toLowerCase();
    if (!query) {
      return [];
    }
    const assignedKeys = new Set(draftEntries.map((entry) => entry.key));
    const matches = people
      .filter((person) => person.is_active)
      .filter((person) => !assignedKeys.has(`p-${person.id}`))
      .filter((person) => personMatchesQuery(person, query));
    const internalMatches = matches
      .filter((person) => person.person_type === "internal")
      .sort(compareAssignmentPeople)
      .slice(0, 6);
    const externalMatches = matches
      .filter((person) => person.person_type !== "internal")
      .sort(compareAssignmentPeople)
      .slice(0, Math.max(0, 8 - internalMatches.length));
    const createExternalSuggestion: AssignmentSuggestion = {
      kind: "create_external",
      key: "create-external",
      displayName: rawQuery,
    };
    return [
      ...internalMatches.map((person): AssignmentSuggestion => ({ kind: "person", person })),
      ...externalMatches.map((person): AssignmentSuggestion => ({ kind: "person", person })),
      createExternalSuggestion,
    ];
  }, [draftEntries, people, personSearchSeed]);

  const loadMatrix = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const shouldLoadPeople = !hasLoadedPeopleRef.current;
      const projectManagerPersonId = matrixProjectManagerPersonIdFromFilter(projectManagerFilter);
      const [matrixData, personData, absenceData] = await Promise.all([
        api.matrix({
          start: activeRange.start,
          end: activeRange.end,
          includeWeekends: true,
          yearView: isYearView,
          projectManagerPersonId,
        }),
        shouldLoadPeople ? api.persons() : Promise.resolve<Person[] | null>(null),
        api.absences({ start: activeRange.start, end: activeRange.end }),
      ]);
      setMatrix(matrixData);
      setSiteInfoDrafts(siteInfoDraftsFromRows(matrixData.rows));
      if (personData) {
        setPeople(personData);
        hasLoadedPeopleRef.current = personData.length > 0;
      }
      setAbsences(absenceData);
    } catch (requestError) {
      setError(readApiError(requestError, "Matrixdaten konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }, [activeRange.end, activeRange.start, isYearView, projectManagerFilter]);

  const refreshMatrixOnly = useCallback(async () => {
    const projectManagerPersonId = matrixProjectManagerPersonIdFromFilter(projectManagerFilter);
    const matrixData = await api.matrix({
      start: activeRange.start,
      end: activeRange.end,
      includeWeekends: true,
      yearView: isYearView,
      projectManagerPersonId,
    });
    setMatrix(matrixData);
    setSiteInfoDrafts(siteInfoDraftsFromRows(matrixData.rows));
  }, [activeRange.end, activeRange.start, isYearView, projectManagerFilter]);

  const refreshAbsencesOnly = useCallback(async () => {
    const absenceData = await api.absences({ start: activeRange.start, end: activeRange.end });
    setAbsences(absenceData);
  }, [activeRange.end, activeRange.start]);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

  useEffect(() => {
    if (!user?.id) {
      return;
    }
    setIsCompactView(localStorage.getItem(matrixCompactPreferenceKey(user.id)) === "true");
  }, [user?.id]);

  const clearScheduledMatrixRangeScroll = useCallback(() => {
    if (rangeScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(rangeScrollFrameRef.current);
      rangeScrollFrameRef.current = null;
    }
    if (rangeScrollSecondFrameRef.current !== null) {
      window.cancelAnimationFrame(rangeScrollSecondFrameRef.current);
      rangeScrollSecondFrameRef.current = null;
    }
    if (rangeScrollFallbackTimeoutRef.current !== null) {
      window.clearTimeout(rangeScrollFallbackTimeoutRef.current);
      rangeScrollFallbackTimeoutRef.current = null;
    }
  }, []);

  const updateProjectManagerFilter = useCallback((nextFilter: string) => {
    rangeScrollKeyRef.current = null;
    interactionWeekSnapKeyRef.current = null;
    clearScheduledMatrixRangeScroll();
    if (initialScrollSnapResetTimeoutRef.current) {
      window.clearTimeout(initialScrollSnapResetTimeoutRef.current);
      initialScrollSnapResetTimeoutRef.current = null;
    }
    isApplyingWeekSnapRef.current = false;
    setProjectManagerFilter(nextFilter);
  }, [clearScheduledMatrixRangeScroll]);

  useEffect(() => {
    if (!matrix || didSetInitialProjectManagerFilter.current) {
      return;
    }
    didSetInitialProjectManagerFilter.current = true;
    if (user?.person_id && matrix.project_managers.some((manager) => manager.id === user.person_id)) {
      updateProjectManagerFilter(String(user.person_id));
    }
  }, [matrix, updateProjectManagerFilter, user?.person_id]);

  const scheduleScrollToCurrentWeek = useCallback(() => {
    if (!matrix || !matrixScrollRef.current) {
      return;
    }
    const firstDay = matrix.days[0]?.date ?? "";
    const lastDay = matrix.days.at(-1)?.date ?? "";
    if (firstDay !== activeRange.start || lastDay !== activeRange.end) {
      return;
    }

    const scrollKey = [
      isYearView ? "year" : "standard",
      projectManagerFilter,
      isCompactView ? "compact" : "normal",
      activeRange.start,
      activeRange.end,
      matrix.days.length,
      firstDay,
      lastDay,
    ].join(":");
    if (rangeScrollKeyRef.current === scrollKey) {
      return;
    }

    clearScheduledMatrixRangeScroll();
    if (initialScrollSnapResetTimeoutRef.current) {
      window.clearTimeout(initialScrollSnapResetTimeoutRef.current);
      initialScrollSnapResetTimeoutRef.current = null;
    }

    if (isYearView) {
      const scrollElement = matrixScrollRef.current;
      scrollElement.scrollLeft = 0;
      rangeScrollKeyRef.current = scrollKey;
      return;
    }

    if (!matrix.days.some((day) => day.date === today)) {
      return;
    }

    const desiredScrollLeft = matrixScrollOffsetForDate(matrix.days, matrixWeekStartDate(today), isCompactView);
    const expectedTableWidth = matrixNumericTableWidth(matrix.days, isCompactView);
    let attempt = 0;
    const applyScroll = () => {
      const scrollElement = matrixScrollRef.current;
      if (!scrollElement) {
        return;
      }
      attempt += 1;
      const maxScrollLeft = Math.max(0, scrollElement.scrollWidth - scrollElement.clientWidth);
      const targetScrollLeft = Math.min(desiredScrollLeft, maxScrollLeft);
      const isLikelyBeforeLayout = expectedTableWidth > scrollElement.clientWidth && maxScrollLeft === 0;
      if (isLikelyBeforeLayout && attempt < 5) {
        rangeScrollFallbackTimeoutRef.current = window.setTimeout(() => {
          rangeScrollFallbackTimeoutRef.current = null;
          applyScroll();
        }, 80);
        return;
      }
      isApplyingWeekSnapRef.current = true;
      scrollElement.scrollLeft = targetScrollLeft;

      const wasApplied = Math.abs(scrollElement.scrollLeft - targetScrollLeft) <= 2;
      if (wasApplied || attempt >= 3) {
        if (wasApplied && !isLikelyBeforeLayout) {
          rangeScrollKeyRef.current = scrollKey;
        }
        initialScrollSnapResetTimeoutRef.current = window.setTimeout(() => {
          isApplyingWeekSnapRef.current = false;
          initialScrollSnapResetTimeoutRef.current = null;
        }, 120);
        return;
      }

      rangeScrollFallbackTimeoutRef.current = window.setTimeout(() => {
        rangeScrollFallbackTimeoutRef.current = null;
        applyScroll();
      }, 80);
    };

    rangeScrollFrameRef.current = window.requestAnimationFrame(() => {
      rangeScrollFrameRef.current = null;
      rangeScrollSecondFrameRef.current = window.requestAnimationFrame(() => {
        rangeScrollSecondFrameRef.current = null;
        applyScroll();
      });
    });
  }, [
    activeRange.end,
    activeRange.start,
    clearScheduledMatrixRangeScroll,
    isCompactView,
    isYearView,
    matrix,
    projectManagerFilter,
    today,
  ]);

  useEffect(() => {
    scheduleScrollToCurrentWeek();
  }, [scheduleScrollToCurrentWeek]);

  const handleMatrixFirstInteraction = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!matrix || isYearView || isApplyingWeekSnapRef.current) {
      return;
    }
    const scrollElement = event.currentTarget;
    const firstDay = matrix.days[0]?.date ?? "";
    const lastDay = matrix.days.at(-1)?.date ?? "";
    const snapKey = [
      projectManagerFilter,
      isCompactView ? "compact" : "normal",
      activeRange.start,
      activeRange.end,
      matrix.days.length,
      firstDay,
      lastDay,
    ].join(":");
    if (interactionWeekSnapKeyRef.current === snapKey) {
      return;
    }
    const leftVisibleDate = matrixDateAtScrollOffset(matrix.days, scrollElement.scrollLeft, isCompactView);
    if (!leftVisibleDate) {
      return;
    }
    const weekStartDate = matrixWeekStartDate(leftVisibleDate);
    const targetScrollLeft = matrixScrollOffsetForDate(matrix.days, weekStartDate, isCompactView);
    interactionWeekSnapKeyRef.current = snapKey;
    if (Math.abs(scrollElement.scrollLeft - targetScrollLeft) < 2) {
      return;
    }
    isApplyingWeekSnapRef.current = true;
    scrollElement.scrollLeft = targetScrollLeft;
    initialScrollSnapResetTimeoutRef.current = window.setTimeout(() => {
      isApplyingWeekSnapRef.current = false;
      initialScrollSnapResetTimeoutRef.current = null;
    }, 80);
  }, [activeRange.end, activeRange.start, isCompactView, isYearView, matrix, projectManagerFilter]);

  useEffect(() => {
    return () => {
      clearScheduledMatrixRangeScroll();
      Object.values(cellMessageTimeoutsRef.current).forEach((timeoutId) => window.clearTimeout(timeoutId));
      if (errorTimeoutRef.current) {
        window.clearTimeout(errorTimeoutRef.current);
      }
      if (initialScrollSnapResetTimeoutRef.current) {
        window.clearTimeout(initialScrollSnapResetTimeoutRef.current);
      }
      isApplyingWeekSnapRef.current = false;
    };
  }, [clearScheduledMatrixRangeScroll]);

  useEffect(() => {
    if (errorTimeoutRef.current) {
      window.clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
    if (!error) {
      return undefined;
    }
    errorTimeoutRef.current = window.setTimeout(() => {
      setError(null);
      errorTimeoutRef.current = null;
    }, ERROR_AUTO_HIDE_MS);
    return () => {
      if (errorTimeoutRef.current) {
        window.clearTimeout(errorTimeoutRef.current);
        errorTimeoutRef.current = null;
      }
    };
  }, [error]);

  useEffect(() => {
    if (!activeCell) {
      return;
    }
    if (skipNextDraftAutosaveRef.current) {
      skipNextDraftAutosaveRef.current = false;
      return;
    }
    setSaveStatus((current) => ({ ...current, [activeCell.key]: "dirty" }));
    if (autosaveRef.current) {
      window.clearTimeout(autosaveRef.current);
    }
    autosaveRef.current = window.setTimeout(() => {
      void saveActiveCell();
    }, 700);
    return () => {
      if (autosaveRef.current) {
        window.clearTimeout(autosaveRef.current);
      }
    };
  }, [draftEntries]);

  useEffect(() => {
    if (!editorAnchor) {
      setHighlightedPersonIndex(-1);
      return;
    }
    setHighlightedPersonIndex(assignmentSuggestions.length === 1 ? 0 : -1);
  }, [assignmentSuggestions.length, editorAnchor, personSearchSeed]);

  const handleMatrixKeyboard = useCallback((event: MatrixKeyboardEvent) => {
    if (!matrixIsEditable || isSelecting || assignmentDrag || activeAbsenceCell) {
      return;
    }
    if (!(activeCell ?? activeCellRef.current) || !(activeEditorRange ?? activeEditorRangeRef.current)) {
      return;
    }
    if (isKeyboardEventFromFormControl(event)) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (editorAnchor) {
        closeKeyboardEntry();
      } else {
        closeActiveEditor();
      }
      return;
    }
    if (editorAnchor) {
      if (event.key === "ArrowDown" && assignmentSuggestions.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        setHighlightedPersonIndex((current) => (current < 0 ? 0 : (current + 1) % assignmentSuggestions.length));
        return;
      }
      if (event.key === "ArrowUp" && assignmentSuggestions.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        setHighlightedPersonIndex((current) => (current < 0 ? assignmentSuggestions.length - 1 : current <= 0 ? assignmentSuggestions.length - 1 : current - 1));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const selectedPerson = highlightedPersonIndex >= 0
          ? assignmentSuggestions[highlightedPersonIndex]
          : assignmentSuggestions.length === 1 ? assignmentSuggestions[0] : null;
        if (selectedPerson) {
          void applyAssignmentSuggestion(selectedPerson);
        }
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        setPersonSearchSeed((current) => current.slice(0, -1));
        return;
      }
      if (isSearchStartKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        setPersonSearchSeed((current) => current + event.key);
      }
      return;
    }
    if (!isSearchStartKey(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setPersonSearchSeed(event.key);
    setEditorAnchor(selectionAnchorRef.current ?? fallbackEditorAnchor(matrixScrollRef.current));
  }, [activeAbsenceCell, activeCell, activeEditorRange, assignmentDrag, assignmentSuggestions, editorAnchor, highlightedPersonIndex, isSelecting, matrixIsEditable]);

  useEffect(() => {
    document.addEventListener("keydown", handleMatrixKeyboard);
    return () => document.removeEventListener("keydown", handleMatrixKeyboard);
  }, [handleMatrixKeyboard]);

  function updateCompactView(value: boolean) {
    setIsCompactView(value);
    if (user) {
      localStorage.setItem(matrixCompactPreferenceKey(user.id), String(value));
    }
  }

  function updateYearView(value: boolean) {
    if (activeCell) {
      closeOrSaveActiveEditor();
    }
    closeAbsenceEditor();
    clearSelection();
    updateAssignmentDrag(null);
    updateAssignmentResize(null);
    setIsSiteCreateDrawerOpen(false);
    setIsYearView(value);
  }

  function openEditorForRange(row: MatrixRow, cell: MatrixCell, range: CellRange, anchor?: EditorAnchor) {
    closeAbsenceEditor();
    matrixScrollRef.current?.focus({ preventScroll: true });
    const key = cellKey(row.site.id, range.startDate);
    const nextActiveCell = { siteId: row.site.id, date: range.startDate, endDate: range.endDate, key };
    const entries = entriesFromCell(cell);
    skipNextDraftAutosaveRef.current = true;
    selectionAnchorRef.current = anchor ?? selectionAnchorRef.current;
    activeCellRef.current = nextActiveCell;
    activeEditorRangeRef.current = range;
    setActiveCell(nextActiveCell);
    setActiveEditorRange(range);
    setEditorAnchor(null);
    setPersonSearchSeed("");
    setHighlightedPersonIndex(-1);
    setDraftEntries(entries);
    setInitialEntries(entries);
  }

  function addSelectedPersonAndSave(personId: string) {
    const person = people.find((item) => item.id === Number(personId));
    if (!person || !activeCell) {
      return;
    }
    const nextEntries = addDraftEntry(draftEntries, {
      key: `p-${person.id}`,
      label: calendarPersonCode(person),
      person_id: person.id,
    });
    skipNextDraftAutosaveRef.current = true;
    setDraftEntries(nextEntries);
    setPersonSearchSeed("");
    setHighlightedPersonIndex(-1);
    void saveActiveCell({ closeOnSuccess: true }, nextEntries);
  }

  async function createExternalPersonAndSave(displayName: string) {
    if (!activeCell) {
      return;
    }
    try {
      const person = await api.createExternalPerson(displayName);
      setPeople((current) => {
        const nextPeople = upsertPerson(current, person);
        hasLoadedPeopleRef.current = nextPeople.length > 0;
        return nextPeople;
      });
      const nextEntries = addDraftEntry(draftEntries, {
        key: `p-${person.id}`,
        label: calendarPersonCode(person),
        person_id: person.id,
      });
      skipNextDraftAutosaveRef.current = true;
      setDraftEntries(nextEntries);
      setPersonSearchSeed("");
      setHighlightedPersonIndex(-1);
      void saveActiveCell({ closeOnSuccess: true }, nextEntries);
    } catch (requestError) {
      setError(readApiError(requestError, "Externe Person konnte nicht angelegt werden."));
    }
  }

  function applyAssignmentSuggestion(suggestion: AssignmentSuggestion) {
    if (suggestion.kind === "create_external") {
      void createExternalPersonAndSave(suggestion.displayName);
      return;
    }
    addSelectedPersonAndSave(String(suggestion.person.id));
  }
  function openAbsenceCell(date: string, anchor: EditorAnchor) {
    if (!matrixIsEditable) {
      return;
    }
    closeActiveEditor();
    setActiveAbsenceCell({ date, endDate: date });
    setAbsenceEditorAnchor(anchor);
    setSelectedAbsencePersonId("");
    setSelectedAbsenceType("vacation");
  }

  function closeAbsenceEditor() {
    setActiveAbsenceCell(null);
    setAbsenceEditorAnchor(null);
    setSelectedAbsencePersonId("");
    setSelectedAbsenceType("vacation");
  }

  async function saveAbsenceFromEditor() {
    if (!activeAbsenceCell || !selectedAbsencePersonId) {
      setError("Bitte eine Person fuer die Fehlzeit auswaehlen.");
      return;
    }
    const [startDate, endDate] = sortDates(activeAbsenceCell.date, activeAbsenceCell.endDate);
    setIsSavingAbsence(true);
    try {
      await api.createAbsence({
        person_id: Number(selectedAbsencePersonId),
        absence_type: selectedAbsenceType,
        start_date: startDate,
        end_date: endDate,
        status: "active",
        note: null,
      });
      setError(null);
      closeAbsenceEditor();
      await Promise.all([refreshAbsencesOnly(), refreshMatrixOnly()]);
    } catch (requestError) {
      setError(readApiError(requestError, "Fehlzeit konnte nicht gespeichert werden."));
    } finally {
      setIsSavingAbsence(false);
    }
  }

  async function deleteAbsenceDayFromPlanning(absence: Absence, date: string) {
    if (!matrixIsEditable || date < absence.start_date || date > absence.end_date) {
      return;
    }
    try {
      const affectedAbsences = activeAbsencesForPersonOnDay(absences, absence.person_id, date);
      const targetAbsences = affectedAbsences.length > 0 ? affectedAbsences : [absence];
      for (const targetAbsence of targetAbsences) {
        await deleteSingleAbsenceDayFromPlanning(targetAbsence, date);
      }
      setError(null);
      await Promise.all([refreshAbsencesOnly(), refreshMatrixOnly()]);
    } catch (requestError) {
      setError(readApiError(requestError, "Fehlzeit konnte nicht fuer diesen Tag entfernt werden."));
      await Promise.all([refreshAbsencesOnly(), refreshMatrixOnly()]);
    }
  }

  async function deleteSingleAbsenceDayFromPlanning(absence: Absence, date: string) {
    if (absence.start_date === absence.end_date) {
      await api.deleteAbsence(absence.id);
    } else if (date === absence.start_date) {
      await api.updateAbsence(absence.id, { start_date: addIsoDays(date, 1) });
    } else if (date === absence.end_date) {
      await api.updateAbsence(absence.id, { end_date: addIsoDays(date, -1) });
    } else {
      let rightAbsence: Absence | null = null;
      try {
        rightAbsence = await api.createAbsence({
          person_id: absence.person_id,
          absence_type: absence.absence_type,
          start_date: addIsoDays(date, 1),
          end_date: absence.end_date,
          status: absence.status,
          note: absence.note,
        });
        await api.updateAbsence(absence.id, { end_date: addIsoDays(date, -1) });
      } catch (splitError) {
        if (rightAbsence) {
          await api.deleteAbsence(rightAbsence.id).catch(() => undefined);
        }
        throw splitError;
      }
    }
  }

  function closeActiveEditor() {
    activeCellRef.current = null;
    activeEditorRangeRef.current = null;
    setActiveCell(null);
    setEditorAnchor(null);
    setActiveEditorRange(null);
    setPersonSearchSeed("");
    setHighlightedPersonIndex(-1);
    clearSelection();
  }

  function closeKeyboardEntry() {
    setEditorAnchor(null);
    setPersonSearchSeed("");
    setHighlightedPersonIndex(-1);
  }

  function closeOrSaveActiveEditor() {
    if (!activeCell) {
      return;
    }
    const hasChanges = !sameEntries(initialEntries, draftEntries);
    if (!hasChanges) {
      closeActiveEditor();
      return;
    }
    void saveActiveCell({ closeOnSuccess: true });
  }

  async function saveActiveCell(options: { closeOnSuccess?: boolean } = {}, entriesForSave = draftEntries) {
    if (!activeCell) {
      return;
    }
    if (autosaveRef.current) {
      window.clearTimeout(autosaveRef.current);
      autosaveRef.current = null;
    }
    const unchanged = sameEntries(initialEntries, entriesForSave);
    if (unchanged && activeCell.endDate === activeCell.date) {
      setSaveStatus((current) => ({ ...current, [activeCell.key]: "idle" }));
      if (options.closeOnSuccess) {
        closeActiveEditor();
      }
      return;
    }
    const entries = entriesForSave.map(toMatrixEntryInput);
    clearTemporaryCellFeedback(activeCell.key);
    setSaveStatus((current) => ({ ...current, [activeCell.key]: "saving" }));
    setCellMessage((current) => ({ ...current, [activeCell.key]: "" }));

    try {
      const response = activeCell.endDate === activeCell.date
        ? await api.patchMatrixCell({
            siteId: activeCell.siteId,
            date: activeCell.date,
            entries,
          })
        : await api.patchMatrixRange({
            siteId: activeCell.siteId,
            startDate: activeCell.date,
            endDate: activeCell.endDate,
            entries,
          });
      if (!sameEntries(initialEntries, entriesForSave)) {
        setUndoStack((current) => [
          ...current,
          {
            siteId: activeCell.siteId,
            date: activeCell.date,
            endDate: activeCell.endDate,
            before: initialEntries,
            after: entriesForSave,
          },
        ]);
      }
      setInitialEntries(entriesForSave);
      setError(null);
      if (response.warnings[0]?.message) {
        showTemporaryCellFeedback(activeCell.key, "");
      } else {
        showTemporaryCellFeedback(activeCell.key, "Gespeichert");
      }
      replaceMatrixCells(activeCell.siteId, response.updated_cells);
      if (options.closeOnSuccess) {
        closeActiveEditor();
      } else {
        activeEditorRangeRef.current = null;
        setActiveEditorRange(null);
        clearSelection();
      }
    } catch (requestError) {
      setSaveStatus((current) => ({ ...current, [activeCell.key]: "error" }));
      const message = readApiError(requestError, "Speichern fehlgeschlagen.");
      setError(message);
      setCellMessage((current) => ({
        ...current,
        [activeCell.key]: CELL_ERROR_MESSAGE,
      }));
    }
  }

  function startCellSelection(row: MatrixRow, cell: MatrixCell, cellIndex: number, event: MatrixCellMouseEvent) {
    if (!matrixIsEditable || event.button !== 0) {
      return;
    }
    event.preventDefault();
    matrixScrollRef.current?.focus({ preventScroll: true });
    if (activeCell) {
      closeActiveEditor();
    }
    const selectionCell = { siteId: row.site.id, date: cell.date, dayIndex: cellIndex };
    selectionAnchorRef.current = anchorFromRect(event.currentTarget.getBoundingClientRect());
    setIsSelecting(true);
    setSelectionStartCell(selectionCell);
    setSelectionEndCell(selectionCell);
  }

  function extendCellSelection(row: MatrixRow, cell: MatrixCell, cellIndex: number, event: MatrixCellMouseEvent) {
    if (!isSelecting || !selectionStartCell || row.site.id !== selectionStartCell.siteId) {
      return;
    }
    selectionAnchorRef.current = anchorFromRect(event.currentTarget.getBoundingClientRect());
    setSelectionEndCell({ siteId: row.site.id, date: cell.date, dayIndex: cellIndex });
  }

  function finishCellSelection(row: MatrixRow, cell: MatrixCell, cellIndex: number, event: MatrixCellMouseEvent) {
    if (!isSelecting || !selectionStartCell || row.site.id !== selectionStartCell.siteId) {
      return;
    }
    event.preventDefault();
    const endCell = { siteId: row.site.id, date: cell.date, dayIndex: cellIndex };
    const range = buildCellRange(selectionStartCell, endCell, matrix?.days ?? []);
    setIsSelecting(false);
    setSelectionEndCell(endCell);
    selectionAnchorRef.current = anchorFromRect(event.currentTarget.getBoundingClientRect());
    const startCell = row.cells[range.startIndex] ?? cell;
    openEditorForRange(row, startCell, range, selectionAnchorRef.current);
  }

  function clearSelection() {
    setIsSelecting(false);
    setSelectionStartCell(null);
    setSelectionEndCell(null);
    selectionAnchorRef.current = null;
  }

  useEffect(() => {
    if (!isSelecting) {
      return;
    }
    function cancelSelection(event: KeyboardEvent) {
      if (event.key === "Escape") {
        clearSelection();
      }
    }
    document.addEventListener("keydown", cancelSelection);
    return () => document.removeEventListener("keydown", cancelSelection);
  }, [isSelecting]);

  useEffect(() => {
    if (!assignmentDrag) {
      return undefined;
    }

    function handlePointerMove(event: PointerEvent) {
      const current = assignmentDragRef.current;
      if (!current) {
        return;
      }
      event.preventDefault();
      const left = event.clientX - current.pointerOffsetX;
      const top = event.clientY - current.pointerOffsetY;
      const target = findMatrixCellAtPoint(left + 4, event.clientY);
      updateAssignmentDrag({
        ...current,
        left,
        top,
        mode: event.shiftKey ? "copy" : "move",
        target,
      });
    }

    function handlePointerUp(event: PointerEvent) {
      const current = assignmentDragRef.current;
      if (!current) {
        return;
      }
      event.preventDefault();
      updateAssignmentDrag(null);
      void finishAssignmentDrag({
        ...current,
        mode: event.shiftKey ? "copy" : "move",
        target: findMatrixCellAtPoint(current.left + 4, event.clientY) ?? current.target,
      });
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        updateAssignmentDrag(null);
      }
    }

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerUp);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerUp);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDraggingAssignment]);

  useEffect(() => {
    if (!assignmentResize) {
      return undefined;
    }

    function handlePointerMove(event: PointerEvent) {
      const current = assignmentResizeRef.current;
      if (!current) {
        return;
      }
      event.preventDefault();
      const target = findMatrixCellAtPoint(event.clientX, current.rowY);
      updateAssignmentResize(resizeStateForTarget(current, target));
    }

    function handlePointerUp(event: PointerEvent) {
      const current = assignmentResizeRef.current;
      if (!current) {
        return;
      }
      event.preventDefault();
      const target = findMatrixCellAtPoint(event.clientX, current.rowY);
      const finalResize = resizeStateForTarget(current, target);
      updateAssignmentResize(null);
      void finishAssignmentResize(finalResize);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        updateAssignmentResize(null);
      }
    }

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerUp);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerUp);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isResizingAssignment]);

  async function undoLast() {
    if (isYearView) {
      return;
    }
    const item = undoStack.at(-1);
    if (!item) {
      return;
    }
    setUndoStack((current) => current.slice(0, -1));
    const entries = item.before.map(toMatrixEntryInput);
    try {
      const response = item.endDate === item.date
        ? await api.patchMatrixCell({ siteId: item.siteId, date: item.date, entries })
        : await api.patchMatrixRange({
            siteId: item.siteId,
            startDate: item.date,
            endDate: item.endDate,
            entries,
          });
      replaceMatrixCells(item.siteId, response.updated_cells);
    } catch (requestError) {
      setError(readApiError(requestError, "Undo konnte nicht ausgefuehrt werden."));
    }
  }

  function replaceMatrixCells(siteId: number, updatedCells: MatrixCell[]) {
    if (!updatedCells.length) {
      return;
    }
    const cellsByDate = new Map(updatedCells.map((cell) => [cell.date, cell]));
    setMatrix((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        rows: current.rows.map((row) => {
          if (row.site.id !== siteId) {
            return row;
          }
          return {
            ...row,
            cells: row.cells.map((cell) => cellsByDate.get(cell.date) ?? cell),
          };
        }),
      };
    });
  }

  async function replaceMatrixSiteCellsOrRefresh(updatedSiteCells: UpdatedMatrixSiteCells[] | undefined) {
    if (!updatedSiteCells?.length) {
      await refreshMatrixOnly();
      return;
    }
    updatedSiteCells.forEach((item) => {
      replaceMatrixCells(item.site_id, item.cells);
    });
  }

  async function deleteAssignmentFromCell(row: MatrixRow, cell: MatrixCell, assignment: MatrixAssignment) {
    if (!matrixIsEditable) {
      return;
    }
    const key = cellKey(row.site.id, cell.date);
    clearTemporaryCellFeedback(key);
    setSaveStatus((current) => ({ ...current, [key]: "saving" }));
    setCellMessage((current) => ({ ...current, [key]: "" }));
    try {
      const response = await api.deleteAssignment(assignment.id);
      setError(null);
      showTemporaryCellFeedback(key, assignment.start_date === assignment.end_date ? "Monteur entfernt" : "Einsatz entfernt");
      await replaceMatrixSiteCellsOrRefresh(response.updated_site_cells);
    } catch (requestError) {
      const message = readApiError(requestError, "Einsatz konnte nicht entfernt werden.");
      setError(message);
      setSaveStatus((current) => ({ ...current, [key]: "error" }));
      setCellMessage((current) => ({ ...current, [key]: CELL_ERROR_MESSAGE }));
    }
  }


  function updateAssignmentDrag(nextDrag: AssignmentDragState | null) {
    assignmentDragRef.current = nextDrag;
    setAssignmentDrag(nextDrag);
  }

  function updateAssignmentResize(nextResize: AssignmentResizeState | null) {
    assignmentResizeRef.current = nextResize;
    setAssignmentResize(nextResize);
  }

  function startAssignmentDrag(
    row: MatrixRow,
    cell: MatrixCell,
    assignment: MatrixAssignment,
    segmentStartDate: string,
    segmentEndDate: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (!matrixIsEditable || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (activeCell) {
      closeActiveEditor();
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const nextDrag: AssignmentDragState = {
      assignment,
      sourceSiteId: row.site.id,
      sourceStartDate: segmentStartDate,
      sourceEndDate: segmentEndDate,
      segmentStartDate,
      segmentEndDate,
      durationDays: inclusiveDateDistance(segmentStartDate, segmentEndDate),
      mode: event.shiftKey ? "copy" : "move",
      pointerOffsetX: event.clientX - rect.left,
      pointerOffsetY: event.clientY - rect.top,
      originX: event.clientX,
      originY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      target: { siteId: row.site.id, date: cell.date, dayIndex: row.cells.findIndex((item) => item.date === cell.date) },
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateAssignmentDrag(nextDrag);
  }

  function startAssignmentResize(
    row: MatrixRow,
    assignment: MatrixAssignment,
    edge: AssignmentResizeEdge,
    event: ReactPointerEvent<HTMLSpanElement>,
  ) {
    if (!matrixIsEditable || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (activeCell) {
      closeActiveEditor();
    }
    updateAssignmentDrag(null);
    const chip = event.currentTarget.closest(".person-chip");
    const rect = (chip instanceof HTMLElement ? chip : event.currentTarget).getBoundingClientRect();
    const nextResize: AssignmentResizeState = {
      assignment,
      edge,
      siteId: row.site.id,
      originalStartDate: assignment.start_date,
      originalEndDate: assignment.end_date,
      previewStartDate: assignment.start_date,
      previewEndDate: assignment.end_date,
      rowY: rect.top + rect.height / 2,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateAssignmentResize(nextResize);
  }

  async function finishAssignmentDrag(drag: AssignmentDragState) {
    const movedDistance = Math.abs(drag.left + drag.pointerOffsetX - drag.originX)
      + Math.abs(drag.top + drag.pointerOffsetY - drag.originY);
    if (movedDistance < 6 || !drag.target) {
      return;
    }
    const targetStartDate = drag.target.date;
    const targetEndDate = addIsoDays(targetStartDate, drag.durationDays - 1);
    if (
      drag.mode === "move"
      && drag.target.siteId === drag.sourceSiteId
      && targetStartDate === drag.sourceStartDate
      && targetEndDate === drag.sourceEndDate
    ) {
      return;
    }

    const key = cellKey(drag.target.siteId, targetStartDate);
    clearTemporaryCellFeedback(key);
    setSaveStatus((current) => ({ ...current, [key]: "saving" }));
    setCellMessage((current) => ({ ...current, [key]: "" }));
    try {
      let response: Awaited<ReturnType<typeof api.createAssignment>>;
      if (drag.mode === "copy") {
        response = await api.createAssignment({
          site_id: drag.target.siteId,
          person_id: drag.assignment.person.id,
          start_date: targetStartDate,
          end_date: targetEndDate,
          assignment_type: drag.assignment.assignment_type,
          note: drag.assignment.note,
        });
      } else if (isFullAssignmentDrag(drag)) {
        response = await api.updateAssignment(drag.assignment.id, {
          site_id: drag.target.siteId,
          start_date: targetStartDate,
          end_date: targetEndDate,
        });
      } else {
        response = await api.moveAssignmentSegment(drag.assignment.id, {
          segment_start_date: drag.segmentStartDate,
          segment_end_date: drag.segmentEndDate,
          target_site_id: drag.target.siteId,
          target_start_date: targetStartDate,
        });
      }
      setError(null);
      showTemporaryCellFeedback(key, drag.mode === "copy" ? "Einsatz kopiert" : "Einsatz verschoben");
      await replaceMatrixSiteCellsOrRefresh(response.updated_site_cells);
    } catch (requestError) {
      const message = readApiError(requestError, drag.mode === "copy"
        ? "Einsatz konnte nicht kopiert werden."
        : "Einsatz konnte nicht verschoben werden.");
      setError(message);
      setSaveStatus((current) => ({ ...current, [key]: "error" }));
      setCellMessage((current) => ({ ...current, [key]: CELL_ERROR_MESSAGE }));
    }
  }

  async function finishAssignmentResize(resize: AssignmentResizeState) {
    if (resize.previewStartDate === resize.originalStartDate && resize.previewEndDate === resize.originalEndDate) {
      return;
    }
    const key = cellKey(resize.siteId, resize.previewStartDate);
    clearTemporaryCellFeedback(key);
    setSaveStatus((current) => ({ ...current, [key]: "saving" }));
    setCellMessage((current) => ({ ...current, [key]: "" }));
    try {
      const response = await api.updateAssignment(resize.assignment.id, {
        site_id: resize.siteId,
        start_date: resize.previewStartDate,
        end_date: resize.previewEndDate,
      });
      setError(null);
      showTemporaryCellFeedback(key, "Einsatz angepasst");
      await replaceMatrixSiteCellsOrRefresh(response.updated_site_cells);
    } catch (requestError) {
      setError(readApiError(requestError, "Einsatz konnte nicht angepasst werden."));
      setSaveStatus((current) => ({ ...current, [key]: "error" }));
      setCellMessage((current) => ({ ...current, [key]: CELL_ERROR_MESSAGE }));
    }
  }


  async function clearCellMark(row: MatrixRow, cell: MatrixCell) {
    if (!matrixIsEditable || !cell.mark) {
      return;
    }
    const key = cellKey(row.site.id, cell.date);
    clearTemporaryCellFeedback(key);
    setSaveStatus((current) => ({ ...current, [key]: "saving" }));
    setCellMessage((current) => ({ ...current, [key]: "" }));
    try {
      const response = await api.patchMatrixCellMark({
        siteId: row.site.id,
        date: cell.date,
        mark: null,
      });
      setError(null);
      showTemporaryCellFeedback(key, "Markierung entfernt");
      replaceMatrixCells(row.site.id, response.updated_cells);
    } catch (requestError) {
      const message = readApiError(requestError, "Markierung konnte nicht entfernt werden.");
      setError(message);
      setSaveStatus((current) => ({ ...current, [key]: "error" }));
      setCellMessage((current) => ({ ...current, [key]: CELL_ERROR_MESSAGE }));
    }
  }

  async function cycleCellMark(row: MatrixRow, cell: MatrixCell) {
    if (!matrixIsEditable) {
      return;
    }
    const key = cellKey(row.site.id, cell.date);
    const nextMark = nextMatrixCellMark(cell.mark);
    clearTemporaryCellFeedback(key);
    setSaveStatus((current) => ({ ...current, [key]: "saving" }));
    setCellMessage((current) => ({ ...current, [key]: "" }));
    try {
      const response = await api.patchMatrixCellMark({
        siteId: row.site.id,
        date: cell.date,
        mark: nextMark,
      });
      setError(null);
      showTemporaryCellFeedback(key, nextMark ? "Markierung gespeichert" : "Markierung entfernt");
      replaceMatrixCells(row.site.id, response.updated_cells);
    } catch (requestError) {
      const message = readApiError(requestError, "Markierung konnte nicht gespeichert werden.");
      setError(message);
      setSaveStatus((current) => ({ ...current, [key]: "error" }));
      setCellMessage((current) => ({ ...current, [key]: CELL_ERROR_MESSAGE }));
    }
  }

  function handleMatrixContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".person-chip") || target?.closest(".matrix-cell-editor-popup") || target?.closest(".assignment-autocomplete")) {
      return;
    }
    event.preventDefault();
    if (activeCell) {
      closeOrSaveActiveEditor();
    }
    if (activeAbsenceCell) {
      closeAbsenceEditor();
    }
  }

  function showTemporaryCellFeedback(key: CellKey, message: string) {
    clearTemporaryCellFeedback(key);
    setSaveStatus((current) => ({ ...current, [key]: "saved" }));
    setCellMessage((current) => ({ ...current, [key]: message }));
    cellMessageTimeoutsRef.current[key] = window.setTimeout(() => {
      setCellMessage((current) => {
        if (current[key] !== message) {
          return current;
        }
        const next = { ...current };
        delete next[key];
        return next;
      });
      setSaveStatus((current) => {
        if (current[key] !== "saved") {
          return current;
        }
        const next = { ...current };
        delete next[key];
        return next;
      });
      delete cellMessageTimeoutsRef.current[key];
    }, 3000);
  }

  function clearTemporaryCellFeedback(key: CellKey) {
    const timeoutId = cellMessageTimeoutsRef.current[key];
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      delete cellMessageTimeoutsRef.current[key];
    }
  }

  async function saveSiteInfo(siteId: number) {
    const currentRow = matrix?.rows.find((row) => row.site.id === siteId);
    if (!matrixIsEditable || !currentRow) {
      return;
    }
    const nextInfo = siteInfoDrafts[siteId]?.trim() || null;
    if ((currentRow.site.info ?? null) === nextInfo) {
      return;
    }
    setSavingInfoSiteId(siteId);
    try {
      const updated = await api.updateSite(siteId, { info: nextInfo });
      setError(null);
      updateMatrixSiteInfo(updated.id, updated.info);
      setSiteInfoDrafts((current) => ({ ...current, [updated.id]: updated.info ?? "" }));
    } catch (requestError) {
      setError(readApiError(requestError, "Info konnte nicht gespeichert werden."));
      setSiteInfoDrafts((current) => ({ ...current, [siteId]: currentRow.site.info ?? "" }));
    } finally {
      setSavingInfoSiteId(null);
    }
  }

  async function saveSiteStatus(siteId: number, status: SiteStatus) {
    const currentRow = matrix?.rows.find((row) => row.site.id === siteId);
    if (!matrixIsEditable || !currentRow || currentRow.site.status === status) {
      return;
    }
    setSavingStatusSiteId(siteId);
    try {
      const updated = await api.updateSite(siteId, { status });
      setError(null);
      updateMatrixSiteStatus(updated.id, updated.status);
      if (updated.status === "completed" || updated.status === "deleted") {
        void loadMatrix();
      }
    } catch (requestError) {
      setError(readApiError(requestError, "Status konnte nicht gespeichert werden."));
    } finally {
      setSavingStatusSiteId(null);
    }
  }

  function updateMatrixSiteInfo(siteId: number, info: string | null) {
    setMatrix((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        rows: current.rows.map((row) => row.site.id === siteId
          ? { ...row, site: { ...row.site, info } }
          : row),
      };
    });
  }

  function updateMatrixSiteStatus(siteId: number, status: SiteStatus) {
    setMatrix((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        rows: current.rows.map((row) => row.site.id === siteId
          ? { ...row, site: { ...row.site, status } }
          : row),
      };
    });
  }

  function openSiteCreateDrawer(projectManagerPersonId: number | null) {
    setSiteCreateProjectManagerId(projectManagerPersonId);
    setIsSiteCreateDrawerOpen(true);
  }

  const projectManagerOptions = useMemo(() => {
    if (!matrix) {
      return [];
    }
    return projectManagerOptionsFromPeople(matrix.project_managers);
  }, [matrix]);

  const visibleRowGroups = useMemo(() => {
    if (!matrix) {
      return [];
    }
    return groupMatrixRows(matrix.rows, projectManagerFilter);
  }, [matrix, projectManagerFilter]);

  return (
    <section className={["matrix-page", isCompactView ? "is-compact" : "", isYearView ? "is-year-view" : ""].filter(Boolean).join(" ")}>
      <div className="matrix-toolbar">
        <div>
          <p className="eyebrow">Planung</p>
          <h1>Baustellenkalender</h1>
          <p className="matrix-range">{activeRange.label}</p>
        </div>
        <div className="matrix-actions">
          {projectManagerOptions.length > 0 && (
            <div className="matrix-pm-filter" aria-label="Projektleiter filtern">
              <button
                className={projectManagerFilter === "all" ? "is-active" : ""}
                type="button"
                onClick={() => updateProjectManagerFilter("all")}
              >
                Alle
              </button>
              {projectManagerOptions.map((manager) => (
                <button
                  className={projectManagerFilter === String(manager.id) ? "is-active" : ""}
                  key={manager.id}
                  type="button"
                  onClick={() => updateProjectManagerFilter(String(manager.id))}
                >
                  {isCompactView ? compactProjectManagerFilterLabel(manager) : manager.shortCode || manager.name}
                </button>
              ))}
            </div>
          )}
          <label className="switch-control matrix-compact-toggle">
            <input
              checked={isCompactView}
              type="checkbox"
              onChange={(event) => updateCompactView(event.target.checked)}
            />
            <span>Kompakte Ansicht</span>
          </label>
          <label className="switch-control matrix-year-toggle">
            <input
              checked={isYearView}
              type="checkbox"
              onChange={(event) => updateYearView(event.target.checked)}
            />
            <span>Jahresansicht</span>
          </label>
          <button
            className="icon-button secondary"
            disabled={isYearView || !undoStack.length}
            type="button"
            onClick={() => void undoLast()}
          >
            <RotateCcw aria-hidden="true" size={17} />
            <span>Undo</span>
          </button>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}
      {isLoading && <div className="matrix-state">Matrix wird geladen...</div>}
      {!isLoading && matrix && (
        <>
          <MatrixTable
            absences={absences}
            canCreateSites={matrixIsEditable}
            cellMessage={cellMessage}
            dayColumnWidth={dayColumnWidth}
            isCompactView={isCompactView}
            isEditable={matrixIsEditable}
            assignmentDragTarget={assignmentDrag?.target ?? null}
            assignmentResize={assignmentResize}
            assignmentResizeRange={assignmentResizeRange}
            matrix={matrix}
            matrixScrollRef={matrixScrollRef}
            peopleById={peopleById}
            onDeleteAbsence={deleteAbsenceDayFromPlanning}
            onDeleteAssignment={deleteAssignmentFromCell}
            onStartAssignmentDrag={startAssignmentDrag}
            onStartAssignmentResize={startAssignmentResize}
            onClearCellMark={clearCellMark}
            onCreateSiteForGroup={openSiteCreateDrawer}
            onCycleCellMark={cycleCellMark}
            onMatrixKeyDown={handleMatrixKeyboard}
            onMatrixContextMenu={handleMatrixContextMenu}
            onMatrixFirstInteraction={handleMatrixFirstInteraction}
            onInfoChange={(siteId, value) => setSiteInfoDrafts((current) => ({ ...current, [siteId]: value }))}
            onInfoSave={(siteId) => void saveSiteInfo(siteId)}
            onStatusChange={(siteId, status) => void saveSiteStatus(siteId, status)}
            highlightedCellRange={highlightedCellRange}
            onCellMouseDown={startCellSelection}
            onCellMouseEnter={extendCellSelection}
            onCellMouseUp={finishCellSelection}
            onOpenAbsenceCell={openAbsenceCell}
            saveStatus={saveStatus}
            savingInfoSiteId={savingInfoSiteId}
            savingStatusSiteId={savingStatusSiteId}
            siteInfoDrafts={siteInfoDrafts}
            today={today}
            typingPreview={typingPreview}
            visibleRowGroups={visibleRowGroups}
          />

          <SiteCreateDrawer
            canEdit={matrixIsEditable}
            initialProjectManagerPersonId={siteCreateProjectManagerId}
            isOpen={isSiteCreateDrawerOpen}
            onClose={() => setIsSiteCreateDrawerOpen(false)}
            onCreated={() => {
              setError(null);
              void refreshMatrixOnly();
            }}
          />

          {editorAnchor && assignmentSuggestions.length > 0 && (
            <AssignmentAutocompleteDropdown
              anchor={editorAnchor}
              highlightedIndex={highlightedPersonIndex}
              items={assignmentSuggestions}
              onClose={closeKeyboardEntry}
              onHighlight={setHighlightedPersonIndex}
              onSelect={applyAssignmentSuggestion}
            />
          )}

          {activeAbsenceCell && absenceEditorAnchor && (
            <AbsenceCellEditorPopup
              activeCell={activeAbsenceCell}
              anchor={absenceEditorAnchor}
              absenceType={selectedAbsenceType}
              isSaving={isSavingAbsence}
              onAbsenceTypeChange={setSelectedAbsenceType}
              onClose={closeAbsenceEditor}
              onEndDateChange={(endDate) => setActiveAbsenceCell({ ...activeAbsenceCell, endDate })}
              onSave={() => void saveAbsenceFromEditor()}
              onSelectedPersonChange={setSelectedAbsencePersonId}
              people={people}
              selectedPersonId={selectedAbsencePersonId}
            />
          )}

          {assignmentDrag && typeof document !== "undefined" && createPortal(
            <div
              className={`assignment-drag-ghost ${assignmentDrag.mode === "copy" ? "is-copy" : "is-move"}`}
              style={{
                height: assignmentDrag.height,
                left: assignmentDrag.left,
                top: assignmentDrag.top,
                width: assignmentDrag.width,
              }}
            >
              <span className="person-chip-label">{assignmentDrag.assignment.person.short_code}</span>
            </div>,
            document.body,
          )}
        </>
      )}
    </section>
  );
}

type AssignmentAutocompleteDropdownProps = {
  anchor: EditorAnchor;
  highlightedIndex: number;
  items: AssignmentSuggestion[];
  onClose: () => void;
  onHighlight: (index: number) => void;
  onSelect: (suggestion: AssignmentSuggestion) => void;
};

function AssignmentAutocompleteDropdown({
  anchor,
  highlightedIndex,
  items,
  onClose,
  onHighlight,
  onSelect,
}: AssignmentAutocompleteDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || dropdownRef.current?.contains(target)) {
        return;
      }
      onClose();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="assignment-autocomplete"
      ref={dropdownRef}
      role="listbox"
      style={autocompleteDropdownPosition(anchor)}
    >
      {items.map((item, index) => {
        const isCreateAction = item.kind === "create_external";
        const key = isCreateAction ? item.key : item.person.id;
        return (
          <button
            aria-selected={highlightedIndex === index}
            className={[
              "assignment-autocomplete-item",
              highlightedIndex === index ? "is-active" : "",
              isCreateAction ? "is-create-action" : "",
            ].filter(Boolean).join(" ")}
            key={key}
            role="option"
            type="button"
            onClick={() => onSelect(item)}
            onMouseEnter={() => onHighlight(index)}
          >
            {isCreateAction ? (
              <>
                <span className="assignment-autocomplete-name">Extern anlegen</span>
                <span className="assignment-autocomplete-short">{item.displayName}</span>
              </>
            ) : (
              <>
                <span className="assignment-autocomplete-name">{item.person.display_name}</span>
                <span className="assignment-autocomplete-short">
                  {item.person.person_type === "internal" ? item.person.short_code : `Extern · ${item.person.short_code}`}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
type AbsenceCellEditorPopupProps = {
  activeCell: ActiveAbsenceCell;
  anchor: EditorAnchor;
  absenceType: AbsenceType;
  isSaving: boolean;
  onAbsenceTypeChange: (value: AbsenceType) => void;
  onClose: () => void;
  onEndDateChange: (date: string) => void;
  onSave: () => void;
  onSelectedPersonChange: (value: string) => void;
  people: Person[];
  selectedPersonId: string;
};

function AbsenceCellEditorPopup({
  activeCell,
  anchor,
  absenceType,
  isSaving,
  onAbsenceTypeChange,
  onClose,
  onEndDateChange,
  onSave,
  onSelectedPersonChange,
  people,
  selectedPersonId,
}: AbsenceCellEditorPopupProps) {
  const popupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (popupRef.current?.contains(event.target as Node)) {
        return;
      }
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  if (typeof document === "undefined") {
    return null;
  }

  const position = editorPopupPosition(anchor);

  return createPortal(
    <div
      className="matrix-cell-editor-popup absence-cell-editor-popup"
      ref={popupRef}
      style={{ left: position.left, top: position.top }}
      onClick={(event) => event.stopPropagation()}
    >
      <AbsenceCellEditor
        activeCell={activeCell}
        absenceType={absenceType}
        isSaving={isSaving}
        onAbsenceTypeChange={onAbsenceTypeChange}
        onClose={onClose}
        onEndDateChange={onEndDateChange}
        onSave={onSave}
        onSelectedPersonChange={onSelectedPersonChange}
        people={people}
        selectedPersonId={selectedPersonId}
      />
    </div>,
    document.body,
  );
}

function AbsenceCellEditor({
  activeCell,
  absenceType,
  isSaving,
  onAbsenceTypeChange,
  onClose,
  onEndDateChange,
  onSave,
  onSelectedPersonChange,
  people,
  selectedPersonId,
}: Omit<AbsenceCellEditorPopupProps, "anchor">) {
  const [personQuery, setPersonQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const suggestionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedPerson = people.find((person) => person.id === Number(selectedPersonId)) ?? null;
  const suggestions = useMemo(() => {
    const query = personQuery.trim().toLowerCase();
    if (!query) {
      return [];
    }
    return people
      .filter((person) => person.is_active)
      .filter((person) => [person.display_name, person.first_name, person.last_name, person.short_code]
        .some((value) => value.toLowerCase().includes(query)))
      .slice(0, 6);
  }, [people, personQuery]);

  useEffect(() => {
    setHighlightedIndex(suggestions.length > 0 ? 0 : -1);
  }, [personQuery, suggestions.length]);

  useEffect(() => {
    if (highlightedIndex < 0) {
      return;
    }
    suggestionRefs.current[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  function choosePerson(person: Person) {
    onSelectedPersonChange(String(person.id));
    setPersonQuery("");
    setHighlightedIndex(-1);
  }

  return (
    <div className="cell-editor absence-cell-editor" onClick={(event) => event.stopPropagation()}>
      <header className="cell-editor-header">
        <p className="cell-editor-eyebrow">Fehlzeit eintragen</p>
        <h2>{formatShortDate(activeCell.date)}</h2>
        <div className="cell-editor-context">
          <span>{activeCell.endDate === activeCell.date ? "Ein Tag" : `${formatShortDate(activeCell.date)} - ${formatShortDate(activeCell.endDate)}`}</span>
        </div>
      </header>

      <section className="cell-editor-section">
        <label className="cell-editor-label" htmlFor="matrix-absence-person-search">Person</label>
        {selectedPerson && (
          <div className="absence-selected-person">
            <span>{selectedPerson.display_name}</span>
            <small>{selectedPerson.short_code}</small>
          </div>
        )}
        <input
          id="matrix-absence-person-search"
          placeholder="Person suchen..."
          value={personQuery}
          aria-activedescendant={highlightedIndex >= 0 ? `matrix-absence-person-suggestion-${suggestions[highlightedIndex]?.id}` : undefined}
          aria-controls="matrix-absence-person-suggestions"
          aria-expanded={suggestions.length > 0}
          role="combobox"
          onChange={(event) => setPersonQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && suggestions.length > 0) {
              event.preventDefault();
              setHighlightedIndex((current) => (current + 1) % suggestions.length);
              return;
            }
            if (event.key === "ArrowUp" && suggestions.length > 0) {
              event.preventDefault();
              setHighlightedIndex((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
              return;
            }
            if (event.key === "Enter") {
              const selectedSuggestion = highlightedIndex >= 0 ? suggestions[highlightedIndex] : suggestions[0];
              if (selectedSuggestion) {
                event.preventDefault();
                choosePerson(selectedSuggestion);
              }
              return;
            }
            if (event.key === "Escape" && (personQuery || suggestions.length > 0)) {
              event.preventDefault();
              event.stopPropagation();
              setPersonQuery("");
              setHighlightedIndex(-1);
            }
          }}
        />
        {personQuery && suggestions.length === 0 && (
          <p className="cell-editor-empty">Keine passende Person gefunden</p>
        )}
        {suggestions.length > 0 && (
          <div
            className="cell-editor-suggestions"
            id="matrix-absence-person-suggestions"
            role="listbox"
            aria-label="Personenvorschlaege Fehlzeiten"
          >
            {suggestions.map((person, index) => (
              <button
                aria-selected={highlightedIndex === index}
                className={highlightedIndex === index ? "is-highlighted" : ""}
                id={`matrix-absence-person-suggestion-${person.id}`}
                key={person.id}
                ref={(element) => {
                  suggestionRefs.current[index] = element;
                }}
                role="option"
                type="button"
                onClick={() => choosePerson(person)}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <span>{person.display_name}</span>
                <small>{person.short_code}</small>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="cell-editor-section absence-editor-grid">
        <label className="cell-editor-label" htmlFor="matrix-absence-type">Typ</label>
        <select
          id="matrix-absence-type"
          value={absenceType}
          onChange={(event) => onAbsenceTypeChange(event.target.value as AbsenceType)}
        >
          {Object.entries(absenceTypeLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <label className="cell-editor-label" htmlFor="matrix-absence-end-date">Bis Datum</label>
        <input
          id="matrix-absence-end-date"
          min={activeCell.date}
          type="date"
          value={activeCell.endDate}
          onChange={(event) => onEndDateChange(event.target.value)}
        />
      </section>

      <footer className="cell-editor-actions">
        <button className="secondary" type="button" onClick={onClose}>Abbrechen</button>
        <button disabled={!selectedPersonId || isSaving} type="button" onClick={onSave}>
          {isSaving ? "Speichert..." : "Speichern"}
        </button>
      </footer>
    </div>
  );
}

type MatrixTableProps = {
  absences: Absence[];
  canCreateSites: boolean;
  cellMessage: Record<CellKey, string>;
  dayColumnWidth: number;
  highlightedCellRange: CellRange | null;
  isCompactView: boolean;
  isEditable: boolean;
  assignmentDragTarget: AssignmentDragTarget | null;
  assignmentResize: AssignmentResizeState | null;
  assignmentResizeRange: CellRange | null;
  matrix: MatrixResponse;
  matrixScrollRef: RefObject<HTMLDivElement | null>;
  peopleById: Map<number, Person>;
  onDeleteAbsence: (absence: Absence, date: string) => void;
  onDeleteAssignment: (row: MatrixRow, cell: MatrixCell, assignment: MatrixAssignment) => void;
  onClearCellMark: (row: MatrixRow, cell: MatrixCell) => void;
  onCreateSiteForGroup: (projectManagerPersonId: number | null) => void;
  onCycleCellMark: (row: MatrixRow, cell: MatrixCell) => void;
  onInfoChange: (siteId: number, value: string) => void;
  onInfoSave: (siteId: number) => void;
  onMatrixContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMatrixFirstInteraction: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onMatrixKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onStatusChange: (siteId: number, status: SiteStatus) => void;
  onStartAssignmentDrag: (row: MatrixRow, cell: MatrixCell, assignment: MatrixAssignment, segmentStartDate: string, segmentEndDate: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onStartAssignmentResize: (row: MatrixRow, assignment: MatrixAssignment, edge: AssignmentResizeEdge, event: ReactPointerEvent<HTMLSpanElement>) => void;
  onCellMouseDown: (row: MatrixRow, cell: MatrixCell, cellIndex: number, event: MatrixCellMouseEvent) => void;
  onCellMouseEnter: (row: MatrixRow, cell: MatrixCell, cellIndex: number, event: MatrixCellMouseEvent) => void;
  onCellMouseUp: (row: MatrixRow, cell: MatrixCell, cellIndex: number, event: MatrixCellMouseEvent) => void;
  onOpenAbsenceCell: (date: string, anchor: EditorAnchor) => void;
  saveStatus: Record<CellKey, SaveStatus>;
  savingInfoSiteId: number | null;
  savingStatusSiteId: number | null;
  siteInfoDrafts: Record<number, string>;
  today: string;
  typingPreview: CellTypingPreview | null;
  visibleRowGroups: MatrixRowGroup[];
};

function MatrixTable(props: MatrixTableProps) {
  const tableWidth = matrixTableWidth(props.matrix.days, props.isCompactView);
  const holidayMap = useMemo(() => matrixHolidayMap(props.matrix.days), [props.matrix.days]);
  const weekGroups = useMemo(
    () => matrixWeekGroups(props.matrix.days, props.isCompactView),
    [props.isCompactView, props.matrix.days],
  );
  const matrixCssVars = {
    "--day-column-width": `${props.dayColumnWidth}px`,
    "--weekend-column-width": `${matrixWeekendColumnWidth(props.isCompactView)}px`,
    "--fixed-columns-width": `${props.isCompactView ? COMPACT_FIXED_MATRIX_COLUMNS_WIDTH : FIXED_MATRIX_COLUMNS_WIDTH}px`,
  } as CSSProperties;
  const tableStyle = {
    ...matrixCssVars,
    width: tableWidth,
    minWidth: tableWidth,
  } as CSSProperties;

  return (
    <div
      className="matrix-scroll"
      ref={props.matrixScrollRef}
      role="region"
      aria-label="Planmatrix"
      style={matrixCssVars}
      tabIndex={0}
      onContextMenu={props.onMatrixContextMenu}
      onKeyDown={props.onMatrixKeyDown}
      onPointerDownCapture={props.onMatrixFirstInteraction}
    >
      <table className="matrix-table" style={tableStyle}>
        <colgroup>
          <col className="site-number-col-width" />
          <col className="site-col-width" />
          <col className="pm-col-width" />
          <col className="info-col-width" />
          <col className="status-col-width" />
          {props.matrix.days.map((day) => (
            <col className={dayColumnWidthClassName(day.date)} key={day.date} />
          ))}
        </colgroup>
        <thead>
          <tr className="matrix-week-row">
            <th className="sticky-col site-number-col matrix-week-fixed" aria-hidden="true" />
            <th className="sticky-col site-col matrix-week-fixed" aria-hidden="true" />
            <th className="sticky-col pm-col matrix-week-fixed" aria-hidden="true" />
            <th className="sticky-col info-col matrix-week-fixed" aria-hidden="true" />
            <th className="sticky-col status-col matrix-week-fixed" aria-hidden="true" />
            {weekGroups.map((group) => (
              <th
                className="matrix-week-cell"
                colSpan={group.dayCount}
                key={String(group.isoYear) + "-" + String(group.week)}
                scope="colgroup"
                style={matrixWeekCellStyle(group.width)}
              >
                KW {group.week}
              </th>
            ))}
          </tr>
          <tr className="matrix-day-row">
            <th className="sticky-col site-number-col">Nummer</th>
            <th className="sticky-col site-col">Baustelle</th>
            <th className="sticky-col pm-col">PL</th>
            <th className="sticky-col info-col">Info</th>
            <th className="sticky-col status-col">Status</th>
            {props.matrix.days.map((day) => {
              const holiday = holidayMap.get(day.date) ?? null;
              return (
                <th
                  className={dayHeaderClassName(day.date, props.today, holiday)}
                  key={day.date}
                  title={holiday?.name}
                >
                  {props.isCompactView ? (
                    <strong>{formatDayHeader(day.date)} {formatDayNumber(day.date)}</strong>
                  ) : (
                    <>
                      <span>{formatDayHeader(day.date)}</span>
                      <strong>{formatDayNumber(day.date)}</strong>
                    </>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          <MatrixAbsencePlanningRow {...props} holidayMap={holidayMap} />
          {props.visibleRowGroups.map((group) => (
            <MatrixTableGroup group={group} holidayMap={holidayMap} key={group.key} {...props} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

type MatrixTableCalendarProps = MatrixTableProps & { holidayMap: ReadonlyMap<string, HolidayInfo> };

function MatrixAbsencePlanningRow(props: MatrixTableCalendarProps) {
  const absencePlanning = useMemo(() => {
    const itemsByDate = new Map(
      props.matrix.days.map((day) => [day.date, absencePlanningItemsForDay(props.absences, day.date)]),
    );
    const rowCount = Math.max(
      1,
      ...Array.from(itemsByDate.values()).map((items) => {
        if (items.length > MAX_VISIBLE_ABSENCES_PER_DAY) {
          return MAX_VISIBLE_ABSENCES_PER_DAY + 1;
        }
        return items.length;
      }),
    );
    return { itemsByDate, rowCount };
  }, [props.absences, props.matrix.days]);
  const rowStyle = { "--absence-rows": absencePlanning.rowCount } as CSSProperties;

  return (
    <tr className="matrix-absence-row" style={rowStyle}>
      <td className="sticky-col site-number-col matrix-absence-empty" />
      <th className="sticky-col site-col row-heading matrix-absence-heading" scope="row">
        <div className="row-heading-content">
          <span className="matrix-absence-icon" />
          <strong>Fehlzeiten</strong>
        </div>
      </th>
      <td className="sticky-col pm-col matrix-absence-empty" />
      <td className="sticky-col info-col matrix-absence-empty" />
      <td className="sticky-col status-col matrix-absence-empty" />
      {props.matrix.days.map((day, cellIndex) => {
        const date = day.date;
        const dayAbsenceItems = absencePlanning.itemsByDate.get(date) ?? [];
        const visibleAbsenceItems = dayAbsenceItems.slice(0, MAX_VISIBLE_ABSENCES_PER_DAY);
        const hiddenAbsenceCount = Math.max(0, dayAbsenceItems.length - visibleAbsenceItems.length);
        const hasOverflow = hiddenAbsenceCount > 0;
        return (
          <td
            className={[matrixAbsenceCellClassName(date, props.today, props.holidayMap.get(date) ?? null), hasOverflow ? "has-absence-overflow" : ""].filter(Boolean).join(" ")}
            data-matrix-date={date}
            data-matrix-day-index={cellIndex}
            key={`absence-${date}`}
            onClick={(event) => {
              if (!props.isEditable) {
                return;
              }
              props.onOpenAbsenceCell(date, anchorFromRect(event.currentTarget.getBoundingClientRect()));
            }}
          >
            <div className="absence-planning-stack">
              {visibleAbsenceItems.map((item) => {
                const person = props.peopleById.get(item.absence.person_id);
                return (
                  <button
                    className={absencePlanningBlockClassName(item)}
                    key={item.absence.id}
                    title={absencePlanningTitle(item, person)}
                    type="button"
                    onClick={(event) => event.stopPropagation()}
                    onContextMenu={(event) => {
                      if (!props.isEditable) {
                        return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      props.onDeleteAbsence(item.absence, date);
                    }}
                  >
                    <span>{absencePersonLabel(person)}</span>
                  </button>
                );
              })}
              {hasOverflow && (
                <>
                  <button className="absence-planning-more" type="button" onClick={(event) => event.stopPropagation()}>
                    +{hiddenAbsenceCount} mehr
                  </button>
                  <div className="absence-overflow-popover" role="tooltip" onClick={(event) => event.stopPropagation()}>
                    <strong>Fehlzeiten {formatDayNumber(date)}</strong>
                    <div className="absence-overflow-list">
                      {dayAbsenceItems.map((item) => {
                        const person = props.peopleById.get(item.absence.person_id);
                        return (
                          <button
                            className={absenceOverflowItemClassName(item)}
                            key={item.absence.id}
                            type="button"
                            title="Rechtsklick entfernt nur diesen Tag"
                            onClick={(event) => event.stopPropagation()}
                            onContextMenu={(event) => {
                              if (!props.isEditable) {
                                return;
                              }
                              event.preventDefault();
                              event.stopPropagation();
                              props.onDeleteAbsence(item.absence, date);
                            }}
                          >
                            <span>{person?.display_name ?? "Person"}</span>
                            <em>{absenceTypeLabels[item.absence.absence_type]}</em>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          </td>
        );
      })}
    </tr>
  );
}

function MatrixTableGroup({ group, ...props }: MatrixTableCalendarProps & { group: MatrixRowGroup }) {
  const projectManagerPersonId = matrixGroupProjectManagerPersonId(group);

  return (
    <>
      {group.showHeading && (
        <tr className="matrix-group-row">
          <th colSpan={4 + props.matrix.days.length}>{group.label}</th>
        </tr>
      )}
      {group.rows.map((row) => (
        <MatrixTableRow key={row.site.id} row={row} {...props} />
      ))}
      {props.canCreateSites && (
        <MatrixAddSiteRow
          days={props.matrix.days}
          holidayMap={props.holidayMap}
          projectManagerPersonId={projectManagerPersonId}
          today={props.today}
          onCreateSite={props.onCreateSiteForGroup}
        />
      )}
    </>
  );
}

type MatrixAddSiteRowProps = {
  days: MatrixResponse["days"];
  holidayMap: ReadonlyMap<string, HolidayInfo>;
  projectManagerPersonId: number | null;
  today: string;
  onCreateSite: (projectManagerPersonId: number | null) => void;
};

function MatrixAddSiteRow({
  days,
  holidayMap,
  projectManagerPersonId,
  today,
  onCreateSite,
}: MatrixAddSiteRowProps) {
  return (
    <tr className="matrix-add-site-row">
      <td className="sticky-col site-number-col matrix-add-site-empty" />
      <th className="sticky-col site-col row-heading" scope="row">
        <button
          className="matrix-add-site-button"
          type="button"
          onClick={() => onCreateSite(projectManagerPersonId)}
        >
          Baustelle hinzufügen
        </button>
      </th>
      <td className="sticky-col pm-col matrix-add-site-empty" />
      <td className="sticky-col info-col matrix-add-site-empty" />
      <td className="sticky-col status-col matrix-add-site-empty" />
      {days.map((day) => (
        <td
          aria-hidden="true"
          className={matrixAddSiteCellClassName(day.date, today, holidayMap.get(day.date) ?? null)}
          key={`add-site-${day.date}`}
        />
      ))}
    </tr>
  );
}

type MatrixTableRowProps = MatrixTableCalendarProps & { row: MatrixRow };

function MatrixTableRow({ row, ...props }: MatrixTableRowProps) {
  const assignmentRunLayout = useMemo(() => buildAssignmentRunLayout(row.cells), [row.cells]);
  const hasSiteAddress = matrixSiteHasAddress(row.site);

  return (
    <tr>
      <td className="sticky-col site-number-col matrix-site-number-cell">
        {row.site.site_number || "-"}
      </td>
      <th className="sticky-col site-col row-heading" scope="row">
        <div className="row-heading-content">
          <span
            className="site-color"
            style={{ backgroundColor: row.site.color ?? "#94a3b8" }}
          />
          <Link className="matrix-site-link" to={`/sites/${row.site.id}`} state={{ returnTo: "matrix" }}>
            <strong>{row.site.name}</strong>
            {!hasSiteAddress && (
              <small className="matrix-site-number">
                <span className="matrix-site-missing-address">Keine Adresse hinterlegt</span>
              </small>
            )}
            {row.site.location && <span className="matrix-site-location">{row.site.location}</span>}
            <span className={`matrix-site-compact-meta${!hasSiteAddress ? " is-missing-address" : ""}`}>
              {siteCompactMeta(row.site.site_number, row.site.location)}
            </span>
          </Link>
        </div>
      </th>
      <td className="sticky-col pm-col compact-text">
        {compactProjectManagerCode(row.site.project_manager)}
      </td>
      <td className="sticky-col info-col compact-text matrix-info-cell">
        <MatrixInfoEditor
          disabled={!props.isEditable}
          isSaving={props.savingInfoSiteId === row.site.id}
          value={props.siteInfoDrafts[row.site.id] ?? row.site.info ?? ""}
          onChange={(value) => props.onInfoChange(row.site.id, value)}
          onSave={() => props.onInfoSave(row.site.id)}
        />
      </td>
      <td className="sticky-col status-col">
        <MatrixStatusPicker
          disabled={!props.isEditable || props.savingStatusSiteId === row.site.id}
          status={row.site.status}
          onChange={(status) => props.onStatusChange(row.site.id, status)}
        />
      </td>
      {row.cells.map((cell, cellIndex) => {
        const key = cellKey(row.site.id, cell.date);
        return (
          <td
            className={matrixCellClassName(
              cell,
              props.today,
              isCellInCellRange(row.site.id, cellIndex, props.highlightedCellRange),
              isAssignmentDragTarget(row.site.id, cellIndex, props.assignmentDragTarget),
              props.holidayMap.get(cell.date) ?? null,
              isCellInCellRange(row.site.id, cellIndex, props.assignmentResizeRange),
            )}
            data-matrix-date={cell.date}
            data-matrix-day-index={cellIndex}
            data-matrix-site-id={row.site.id}
            key={cell.date}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
              }
            }}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                event.stopPropagation();
                props.onCycleCellMark(row, cell);
                return;
              }
              props.onCellMouseDown(row, cell, cellIndex, event);
            }}
            onMouseEnter={(event) => props.onCellMouseEnter(row, cell, cellIndex, event)}
            onMouseUp={(event) => props.onCellMouseUp(row, cell, cellIndex, event)}
            onContextMenu={(event) => {
              if (!props.isEditable || !cell.mark) {
                return;
              }
              event.preventDefault();
              props.onClearCellMark(row, cell);
            }}
          >
            <CellDisplay
              cell={cell}
              cellIndex={cellIndex}
              assignmentRunLayout={assignmentRunLayout}
              isCompactView={props.isCompactView}
              isEditable={props.isEditable}
              rowCells={row.cells}
              assignmentResize={props.assignmentResize}
              typingPreviewText={typingPreviewTextForCell(props.typingPreview, row.site.id, cell.date)}
              onDeleteAssignment={(assignment) => props.onDeleteAssignment(row, cell, assignment)}
              onStartAssignmentDrag={(assignment, segmentStartDate, segmentEndDate, event) => props.onStartAssignmentDrag(row, cell, assignment, segmentStartDate, segmentEndDate, event)}
              onStartAssignmentResize={(assignment, edge, event) => props.onStartAssignmentResize(row, assignment, edge, event)}
            />
            {props.saveStatus[key] && <span className={`save-dot ${props.saveStatus[key]}`} />}
            {props.saveStatus[key] === "error" && props.cellMessage[key] && (
              <small className="cell-message">{props.cellMessage[key]}</small>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function MatrixStatusPicker({
  disabled,
  status,
  onChange,
}: {
  disabled: boolean;
  status: SiteStatus;
  onChange: (status: SiteStatus) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<EditorAnchor | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function closeMenu() {
      setIsOpen(false);
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || pickerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      closeMenu();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMenu();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", closeMenu, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [isOpen]);

  function toggleMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    if (disabled) {
      return;
    }
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    setMenuAnchor(anchorFromRect(event.currentTarget.getBoundingClientRect()));
    setIsOpen(true);
  }

  function chooseStatus(nextStatus: SiteStatus) {
    setIsOpen(false);
    if (nextStatus !== status) {
      onChange(nextStatus);
    }
  }

  return (
    <div
      className={`matrix-status-picker ${isOpen ? "is-open" : ""}`}
      ref={pickerRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setIsOpen(false);
        }
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`Baustellenstatus: ${siteStatusLabels[status]}`}
        className={`matrix-status-chip status-${status}`}
        disabled={disabled}
        type="button"
        onClick={toggleMenu}
      >
        <span className="matrix-status-dot" aria-hidden="true" />
        <span>{siteStatusLabels[status]}</span>
      </button>
      {isOpen && !disabled && menuAnchor && createPortal(
        <div
          className="matrix-status-menu"
          ref={menuRef}
          role="menu"
          style={statusMenuPosition(menuAnchor)}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {SITE_STATUS_OPTIONS.map((option) => (
            <button
              className={`matrix-status-menu-item status-${option}`}
              key={option}
              role="menuitemradio"
              aria-checked={option === status}
              type="button"
              onClick={() => chooseStatus(option)}
            >
              <span className="matrix-status-dot" aria-hidden="true" />
              <span>{siteStatusLabels[option]}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function CellDisplay({
  assignmentRunLayout,
  assignmentResize,
  cell,
  cellIndex,
  isCompactView,
  isEditable,
  rowCells,
  typingPreviewText,
  onDeleteAssignment,
  onStartAssignmentDrag,
  onStartAssignmentResize,
}: {
  assignmentRunLayout: AssignmentRunLayout;
  assignmentResize: AssignmentResizeState | null;
  cell: MatrixCell;
  cellIndex: number;
  isCompactView: boolean;
  isEditable: boolean;
  rowCells: MatrixCell[];
  typingPreviewText?: string;
  onDeleteAssignment: (assignment: MatrixAssignment) => void;
  onStartAssignmentDrag: (assignment: MatrixAssignment, segmentStartDate: string, segmentEndDate: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onStartAssignmentResize: (assignment: MatrixAssignment, edge: AssignmentResizeEdge, event: ReactPointerEvent<HTMLSpanElement>) => void;
}) {
  const stackLayerCount = assignmentRunLayout.maxLayers + (typingPreviewText ? 1 : 0);

  return (
    <div
      className="cell-stack"
      style={{
        "--assignment-layers": stackLayerCount,
        "--typing-layer": assignmentRunLayout.maxLayers,
      } as CSSProperties}
    >
      {cell.assignments.map((assignment) => {
        const runKey = assignmentRunKey(assignment.id, cellIndex);
        const span = assignmentRunLayout.spansByRunKey.get(runKey) ?? 0;
        if (span === 0) {
          return null;
        }
        const layer = assignmentRunLayout.layersByRunKey.get(runKey) ?? 0;
        const segmentStartDate = cell.date;
        const segmentEndDate = rowCells[cellIndex + span - 1]?.date ?? cell.date;
        const absenceConflict = assignmentAbsenceConflict(cell, assignment);
        const isResizing = assignmentResize?.assignment.id === assignment.id;
        const canResizeStart = isEditable && isAssignmentResizeEdgeVisible(rowCells, cellIndex, assignment, span, "start");
        const canResizeEnd = isEditable && isAssignmentResizeEdgeVisible(rowCells, cellIndex, assignment, span, "end");
        return (
          <button
            className={assignmentChipClassName(
              span,
              absenceConflict !== null,
              isResizing,
              assignment.person.person_type !== "internal",
              assignment.assignment_type === "self_planned",
            )}
            key={assignment.id}
            style={{
              "--assignment-layer": layer,
              "--assignment-span": span,
              width: span > 1 ? `${assignmentRunWidth(rowCells, cellIndex, span, isCompactView) - 8}px` : undefined,
            } as CSSProperties}
            title={assignmentChipTitle(assignment, absenceConflict, isEditable)}
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => onStartAssignmentDrag(assignment, segmentStartDate, segmentEndDate, event)}
            onContextMenu={(event) => {
              if (!isEditable) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              onDeleteAssignment(assignment);
            }}
          >
            {canResizeStart && (
              <span
                className="assignment-resize-handle left"
                title="Start ziehen"
                onPointerDown={(event) => onStartAssignmentResize(assignment, "start", event)}
              />
            )}
            <span className="person-chip-label">{assignment.person.short_code}</span>
            {canResizeEnd && (
              <span
                className="assignment-resize-handle right"
                title="Ende ziehen"
                onPointerDown={(event) => onStartAssignmentResize(assignment, "end", event)}
              />
            )}
          </button>
        );
      })}
      {typingPreviewText && (
        <span className="matrix-cell-typing-preview" title={typingPreviewText}>
          {typingPreviewText}
        </span>
      )}
    </div>
  );
}

function MatrixInfoEditor({
  disabled,
  isSaving,
  value,
  onChange,
  onSave,
}: {
  disabled: boolean;
  isSaving: boolean;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const displayValue = matrixInfoDisplayValue(value);
  return (
    <label className="matrix-info-editor">
      <span className="sr-only">Info</span>
      <textarea
        className={matrixInfoTextClassName(displayValue)}
        disabled={disabled || isSaving}
        title={displayValue || undefined}
        value={displayValue}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onSave}
        onClick={(event) => event.stopPropagation()}
      />
    </label>
  );
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const DAY_COLUMN_WIDTH = 124;
const COMPACT_DAY_COLUMN_WIDTH = 88;
const WEEKEND_DAY_COLUMN_WIDTH = 70;
const COMPACT_WEEKEND_DAY_COLUMN_WIDTH = 53;
const EDITOR_POPUP_HEIGHT = 560;
const EDITOR_POPUP_WIDTH = 390;
const ASSIGNMENT_AUTOCOMPLETE_HEIGHT = 240;
const ASSIGNMENT_AUTOCOMPLETE_WIDTH = 280;
const STATUS_MENU_HEIGHT = 142;
const STATUS_MENU_WIDTH = 128;
const FIXED_MATRIX_COLUMNS_WIDTH = 614;
const COMPACT_FIXED_MATRIX_COLUMNS_WIDTH = 476;
const MATRIX_CELL_MARKS: Array<MatrixCellMark | null> = [null, "orange", "red", "blue"];
const SITE_STATUS_OPTIONS: SiteStatus[] = ["active", "paused", "planned", "completed", "deleted"];
type ProjectManagerOption = {
  id: number;
  name: string;
  shortCode: string;
};
type MatrixRowGroup = {
  key: string;
  label: string;
  rows: MatrixRow[];
  showHeading: boolean;
};

function anchorFromRect(rect: DOMRect): EditorAnchor {
  return {
    bottom: rect.bottom,
    left: rect.left,
    top: rect.top,
    width: rect.width,
  };
}

function fallbackEditorAnchor(container: HTMLElement | null): EditorAnchor {
  const rect = container?.getBoundingClientRect();
  if (!rect) {
    return { bottom: 160, left: 24, top: 120, width: 280 };
  }
  return {
    bottom: rect.top + 104,
    left: rect.left + 24,
    top: rect.top + 72,
    width: 280,
  };
}

function isSearchStartKey(event: MatrixKeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  return event.key.length === 1 && event.key.trim().length > 0;
}

function isKeyboardEventFromFormControl(event: MatrixKeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) {
    return false;
  }
  return Boolean(target.closest("input, textarea, select, button, a, [contenteditable='true'], .matrix-cell-editor-popup, .absence-cell-editor-popup"));
}

function editorPopupPosition(anchor: EditorAnchor): { left: number; top: number } {
  const gap = 6;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const preferredLeft = anchor.left;
  const left = Math.max(8, Math.min(preferredLeft, viewportWidth - EDITOR_POPUP_WIDTH - 8));
  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - EDITOR_POPUP_HEIGHT - gap;
  const top = belowTop + EDITOR_POPUP_HEIGHT > viewportHeight
    ? Math.max(8, aboveTop)
    : belowTop;

  return { left, top };
}

function autocompleteDropdownPosition(anchor: EditorAnchor): CSSProperties {
  const gap = 5;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.max(220, Math.min(ASSIGNMENT_AUTOCOMPLETE_WIDTH, viewportWidth - 16));
  const left = Math.max(8, Math.min(anchor.left, viewportWidth - width - 8));
  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - ASSIGNMENT_AUTOCOMPLETE_HEIGHT - gap;
  const top = belowTop + ASSIGNMENT_AUTOCOMPLETE_HEIGHT > viewportHeight
    ? Math.max(8, aboveTop)
    : belowTop;

  return { left, top, width };
}

function statusMenuPosition(anchor: EditorAnchor): CSSProperties {
  const gap = 6;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const preferredLeft = anchor.left + anchor.width - STATUS_MENU_WIDTH;
  const left = Math.max(8, Math.min(preferredLeft, viewportWidth - STATUS_MENU_WIDTH - 8));
  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - STATUS_MENU_HEIGHT - gap;
  const top = belowTop + STATUS_MENU_HEIGHT > viewportHeight
    ? Math.max(8, aboveTop)
    : belowTop;

  return { left, top };
}

function matrixDayColumnWidth(isCompactView: boolean): number {
  return isCompactView ? COMPACT_DAY_COLUMN_WIDTH : DAY_COLUMN_WIDTH;
}

function matrixWeekendColumnWidth(isCompactView: boolean): number {
  return isCompactView ? COMPACT_WEEKEND_DAY_COLUMN_WIDTH : WEEKEND_DAY_COLUMN_WIDTH;
}

function matrixColumnWidthForDate(date: string, isCompactView: boolean): number {
  return isWeekendDate(date) ? matrixWeekendColumnWidth(isCompactView) : matrixDayColumnWidth(isCompactView);
}

function matrixTableWidth(days: MatrixResponse["days"], isCompactView: boolean): string {
  return `${matrixNumericTableWidth(days, isCompactView)}px`;
}

function matrixNumericTableWidth(days: MatrixResponse["days"], isCompactView: boolean): number {
  const fixedWidth = isCompactView ? COMPACT_FIXED_MATRIX_COLUMNS_WIDTH : FIXED_MATRIX_COLUMNS_WIDTH;
  const daysWidth = days.reduce((total, day) => total + matrixColumnWidthForDate(day.date, isCompactView), 0);
  return fixedWidth + daysWidth;
}

function matrixHolidayMap(days: MatrixResponse["days"]): Map<string, HolidayInfo> {
  return getLowerSaxonyPublicHolidayMap(days.map((day) => Number(day.date.slice(0, 4))));
}

function matrixWeekGroups(days: MatrixResponse["days"], isCompactView: boolean): CalendarWeekGroup[] {
  return days.reduce<CalendarWeekGroup[]>((groups, day) => {
    const isoWeek = getIsoWeekInfo(day.date);
    const width = matrixColumnWidthForDate(day.date, isCompactView);
    const currentGroup = groups[groups.length - 1];
    if (currentGroup && currentGroup.isoYear === isoWeek.isoYear && currentGroup.week === isoWeek.week) {
      currentGroup.dayCount += 1;
      currentGroup.width += width;
      return groups;
    }
    groups.push({ isoYear: isoWeek.isoYear, week: isoWeek.week, dayCount: 1, width });
    return groups;
  }, []);
}

function matrixWeekCellStyle(width: number): CSSProperties {
  return { width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` };
}

function matrixScrollOffsetForDate(days: MatrixResponse["days"], targetDate: string, isCompactView: boolean): number {
  return days.reduce((offset, day) => {
    if (day.date >= targetDate) {
      return offset;
    }
    return offset + matrixColumnWidthForDate(day.date, isCompactView);
  }, 0);
}

function matrixDateAtScrollOffset(days: MatrixResponse["days"], scrollLeft: number, isCompactView: boolean): string | null {
  let offset = 0;
  for (const day of days) {
    const width = matrixColumnWidthForDate(day.date, isCompactView);
    if (offset + width > scrollLeft + 1) {
      return day.date;
    }
    offset += width;
  }
  const lastDay = days[days.length - 1];
  return lastDay ? lastDay.date : null;
}

function matrixWeekStartDate(dateValue: string): string {
  const [year, month, day] = dateValue.split("-");
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  const weekday = date.getDay();
  const mondayOffset = weekday === 0 ? 6 : weekday - 1;
  date.setDate(date.getDate() - mondayOffset);
  return toDateInputValue(date);
}

function assignmentRunWidth(cells: MatrixCell[], startIndex: number, span: number, isCompactView: boolean): number {
  return cells.slice(startIndex, startIndex + span)
    .reduce((width, cell) => width + matrixColumnWidthForDate(cell.date, isCompactView), 0);
}

function matrixCompactPreferenceKey(userId: number): string {
  return `kb_matrix_compact_view_${userId}`;
}

function getYearPlanningRange(referenceDate: string): PlanningRange {
  const year = Number(referenceDate.slice(0, 4));
  return {
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    label: `01.01.${year} - 31.12.${year}`,
  };
}

function siteCompactMeta(siteNumber: string | null, location: string | null): string {
  return [siteNumber, location || "Keine Adresse hinterlegt"].filter(Boolean).join(" · ");
}

function matrixSiteHasAddress(site: MatrixRow["site"]): boolean {
  return Boolean(site.location?.trim());
}

function projectManagerOptionsFromPeople(people: MatrixPerson[]): ProjectManagerOption[] {
  return people
    .map((person) => ({
      id: person.id,
      name: person.display_name,
      shortCode: person.short_code,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "de"));
}

function matrixProjectManagerPersonIdFromFilter(projectManagerFilter: string): number | undefined {
  if (projectManagerFilter === "all") {
    return undefined;
  }
  const personId = Number(projectManagerFilter);
  return Number.isFinite(personId) ? personId : undefined;
}

function groupMatrixRows(rows: MatrixRow[], projectManagerFilter: string): MatrixRowGroup[] {
  const filteredRows = projectManagerFilter === "all"
    ? rows
    : rows.filter((row) => String(row.site.project_manager_person_id ?? "") === projectManagerFilter);
  const sortedRows = filteredRows.slice().sort(compareMatrixRowsByNumber);
  if (projectManagerFilter !== "all") {
    return sortedRows.length
      ? [{ key: projectManagerFilter, label: "", rows: sortedRows, showHeading: true }]
      : [];
  }
  const groups = new Map<string, MatrixRowGroup>();
  sortedRows.forEach((row) => {
    const key = row.site.project_manager_person_id ? String(row.site.project_manager_person_id) : "unassigned";
    const label = row.site.project_manager?.display_name ?? "Ohne Projektleiter";
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
      return;
    }
    groups.set(key, { key, label, rows: [row], showHeading: true });
  });
  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label, "de"));
}

function matrixGroupProjectManagerPersonId(group: MatrixRowGroup): number | null {
  const firstProjectManagerPersonId = group.rows[0]?.site.project_manager_person_id ?? null;
  if (firstProjectManagerPersonId === null) {
    return null;
  }
  return group.rows.every((row) => row.site.project_manager_person_id === firstProjectManagerPersonId)
    ? firstProjectManagerPersonId
    : null;
}

function compareMatrixRowsByNumber(left: MatrixRow, right: MatrixRow): number {
  return compareSiteNumbers(left.site.site_number, right.site.site_number)
    || left.site.name.localeCompare(right.site.name, "de")
    || left.site.id - right.site.id;
}

function compareSiteNumbers(left: string | null, right: string | null): number {
  const leftNumber = parseSiteNumber(left);
  const rightNumber = parseSiteNumber(right);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber;
  }
  if (leftNumber !== null) {
    return -1;
  }
  if (rightNumber !== null) {
    return 1;
  }
  return (left ?? "").localeCompare(right ?? "", "de");
}

function parseSiteNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const matches = value.match(/\d+/g);
  return matches?.length ? Number(matches[matches.length - 1]) : null;
}

function siteInfoDraftsFromRows(rows: MatrixRow[]): Record<number, string> {
  return Object.fromEntries(rows.map((row) => [row.site.id, row.site.info ?? ""]));
}

function dayColumnWidthClassName(date: string): string {
  return [
    "day-col-width",
    isWeekendDate(date) ? "weekend" : "",
  ].filter(Boolean).join(" ");
}

function typingPreviewTextForCell(preview: CellTypingPreview | null, siteId: number, date: string): string {
  return preview && preview.siteId === siteId && preview.date === date ? preview.text : "";
}

function dayHeaderClassName(date: string, today: string, holiday: HolidayInfo | null): string {
  return [
    "day-col",
    isWeekendDate(date) ? "weekend" : "",
    holiday ? "is-holiday" : "",
    isWeekStartDate(date) ? "is-week-start" : "",
    date === today ? "today" : "",
  ].filter(Boolean).join(" ");
}

function matrixCellClassName(
  cell: MatrixCell,
  today: string,
  isRangeSelected: boolean,
  isDragTarget: boolean,
  holiday: HolidayInfo | null,
  isResizePreview: boolean,
): string {
  return [
    "matrix-cell",
    isWeekendDate(cell.date) ? "weekend" : "",
    holiday ? "is-holiday" : "",
    isWeekStartDate(cell.date) ? "is-week-start" : "",
    cell.date === today ? "today" : "",
    cell.mark ? `mark-${cell.mark}` : "",
    isRangeSelected ? "is-range-selected" : "",
    isDragTarget ? "is-drag-target" : "",
    isResizePreview ? "is-resize-preview" : "",
  ].filter(Boolean).join(" ");
}

function matrixAddSiteCellClassName(date: string, today: string, holiday: HolidayInfo | null): string {
  return [
    "matrix-cell",
    "matrix-add-site-day",
    isWeekendDate(date) ? "weekend" : "",
    holiday ? "is-holiday" : "",
    isWeekStartDate(date) ? "is-week-start" : "",
    date === today ? "today" : "",
  ].filter(Boolean).join(" ");
}

function isWeekStartDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day).getDay() === 1;
}

function nextMatrixCellMark(current: MatrixCellMark | null): MatrixCellMark | null {
  const currentIndex = MATRIX_CELL_MARKS.indexOf(current);
  return MATRIX_CELL_MARKS[(currentIndex + 1) % MATRIX_CELL_MARKS.length];
}

function isCellInCellRange(siteId: number, dayIndex: number, range: CellRange | null): boolean {
  return Boolean(range && range.siteId === siteId && dayIndex >= range.startIndex && dayIndex <= range.endIndex);
}

function isAssignmentDragTarget(siteId: number, dayIndex: number, target: AssignmentDragTarget | null): boolean {
  return Boolean(target && target.siteId === siteId && target.dayIndex === dayIndex);
}

function buildCellRange(start: SelectionCell, end: SelectionCell, visibleDays: MatrixResponse["days"]): CellRange {
  const startIndex = Math.min(start.dayIndex, end.dayIndex);
  const endIndex = Math.max(start.dayIndex, end.dayIndex);
  const dates = visibleDays.slice(startIndex, endIndex + 1).map((day) => day.date);
  return {
    siteId: start.siteId,
    startDate: dates[0] ?? start.date,
    endDate: dates.at(-1) ?? end.date,
    startIndex,
    endIndex,
    dates,
  };
}

function rangeFromDates(siteId: number, startDate: string, endDate: string, visibleDays: MatrixResponse["days"]): CellRange {
  const [sortedStartDate, sortedEndDate] = sortDates(startDate, endDate);
  const startIndex = Math.max(0, visibleDays.findIndex((day) => day.date === sortedStartDate));
  const endIndex = Math.max(startIndex, visibleDays.findIndex((day) => day.date === sortedEndDate));
  return {
    siteId,
    startDate: sortedStartDate,
    endDate: sortedEndDate,
    startIndex,
    endIndex,
    dates: visibleDays.slice(startIndex, endIndex + 1).map((day) => day.date),
  };
}

function sortDates(left: string, right: string): [string, string] {
  return left <= right ? [left, right] : [right, left];
}

function assignmentRunSpan(cells: MatrixCell[], cellIndex: number, assignmentId: number): number {
  const cell = cells[cellIndex];
  const assignment = cell?.assignments.find((item) => item.id === assignmentId);
  if (!cell || !assignment) {
    return 0;
  }
  const signature = assignmentVisualSignature(cell, assignment);
  const previousCell = cells[cellIndex - 1];
  const previousAssignment = previousCell?.assignments.find((item) => item.id === assignmentId);
  if (previousCell && previousAssignment && assignmentVisualSignature(previousCell, previousAssignment) === signature) {
    return 0;
  }
  let span = 1;
  for (let index = cellIndex + 1; index < cells.length; index += 1) {
    const nextCell = cells[index];
    const nextAssignment = nextCell.assignments.find((item) => item.id === assignmentId);
    if (!nextAssignment || assignmentVisualSignature(nextCell, nextAssignment) !== signature) {
      break;
    }
    span += 1;
  }
  return span;
}

type AssignmentRunLayout = {
  layersByRunKey: Map<string, number>;
  maxLayers: number;
  spansByRunKey: Map<string, number>;
};

function buildAssignmentRunLayout(cells: MatrixCell[]): AssignmentRunLayout {
  const layerEndIndexes: number[] = [];
  const layersByRunKey = new Map<string, number>();
  const spansByRunKey = new Map<string, number>();

  cells.forEach((cell, cellIndex) => {
    cell.assignments.forEach((assignment) => {
      const span = assignmentRunSpan(cells, cellIndex, assignment.id);
      if (span === 0) {
        return;
      }

      const endIndex = cellIndex + span - 1;
      let layer = 0;
      while (layerEndIndexes[layer] !== undefined && layerEndIndexes[layer] >= cellIndex) {
        layer += 1;
      }
      layerEndIndexes[layer] = endIndex;
      const runKey = assignmentRunKey(assignment.id, cellIndex);
      layersByRunKey.set(runKey, layer);
      spansByRunKey.set(runKey, span);
    });
  });

  return {
    layersByRunKey,
    maxLayers: Math.max(1, layerEndIndexes.length),
    spansByRunKey,
  };
}

function assignmentRunKey(assignmentId: number, cellIndex: number): string {
  return `${assignmentId}:${cellIndex}`;
}

function isFullAssignmentDrag(drag: AssignmentDragState): boolean {
  return drag.segmentStartDate === drag.assignment.start_date && drag.segmentEndDate === drag.assignment.end_date;
}

function resizeStateForTarget(resize: AssignmentResizeState, target: AssignmentDragTarget | null): AssignmentResizeState {
  if (!target || target.siteId !== resize.siteId) {
    return resize;
  }
  if (resize.edge === "start") {
    return {
      ...resize,
      previewStartDate: target.date <= resize.originalEndDate ? target.date : resize.originalEndDate,
    };
  }
  return {
    ...resize,
    previewEndDate: target.date >= resize.originalStartDate ? target.date : resize.originalStartDate,
  };
}

function assignmentAbsenceConflict(cell: MatrixCell, assignment: MatrixAssignment): MatrixCell["absences"][number] | null {
  const matchingAbsences = cell.absences
    .filter((absence) => absence.person.id === assignment.person.id)
    .sort((left, right) => matrixAbsenceTypePriority(left.absence_type) - matrixAbsenceTypePriority(right.absence_type));
  return matchingAbsences[0] ?? null;
}

function assignmentVisualSignature(cell: MatrixCell, assignment: MatrixAssignment): string {
  const absenceConflict = assignmentAbsenceConflict(cell, assignment);
  return absenceConflict ? "absence-" + absenceConflict.absence_type : "normal";
}

function matrixAbsenceTypePriority(absenceType: AbsenceType): number {
  if (absenceType === "sick" || absenceType === "vacation") {
    return 0;
  }
  if (absenceType === "school" || absenceType === "free") {
    return 1;
  }
  return 2;
}

function assignmentChipClassName(
  span: number,
  hasAbsenceConflict: boolean,
  isResizing: boolean,
  isExternalPerson: boolean,
  isSelfPlanned: boolean,
): string {
  return [
    "person-chip",
    span > 1 ? "is-assignment-run" : "",
    isSelfPlanned ? "is-self-planned" : "",
    isExternalPerson ? "is-external-person" : "",
    hasAbsenceConflict ? "is-absence-conflict" : "",
    isResizing ? "is-resizing" : "",
  ].filter(Boolean).join(" ");
}

function isAssignmentResizeEdgeVisible(
  cells: MatrixCell[],
  cellIndex: number,
  assignment: MatrixAssignment,
  span: number,
  edge: AssignmentResizeEdge,
): boolean {
  if (edge === "start") {
    return cells[cellIndex]?.date === assignment.start_date;
  }
  return cells[cellIndex + span - 1]?.date === assignment.end_date;
}

function assignmentChipTitle(assignment: MatrixAssignment, absenceConflict: MatrixCell["absences"][number] | null, isEditable: boolean): string {
  const actionHint = isEditable ? " - ziehen zum Verschieben, Shift+Ziehen kopiert, Rechtsklick entfernt den ganzen Einsatz" : "";
  const selfPlannedHint = assignment.assignment_type === "self_planned" ? " - vom Monteur selbst nachgetragen" : "";
  if (!absenceConflict) {
    return `${assignment.person.display_name}${selfPlannedHint}${actionHint}`;
  }
  return `${assignment.person.display_name}${selfPlannedHint} - Konflikt: ${absenceTypeLabels[absenceConflict.absence_type]} am Einsatztag${actionHint}`;
}

function compactProjectManagerCode(person: MatrixPerson | null): string {
  if (!person) {
    return "";
  }
  return compactCodeFromText(person.short_code || person.display_name);
}

function compactProjectManagerFilterLabel(manager: ProjectManagerOption): string {
  return compactCodeFromText(manager.shortCode || manager.name);
}

function compactCodeFromText(value: string): string {
  const parts = value.split(/[.\s-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0].slice(0, 1)}${parts[1].slice(0, 1)}`.toUpperCase();
  }
  const letters = value.replace(/[^A-Za-zÄÖÜäöüß]/g, "");
  return letters.slice(0, 2).toUpperCase();
}

function matrixInfoDisplayValue(value: string): string {
  return value.trim().toLowerCase() === "info" ? "" : value;
}

function matrixInfoTextClassName(value: string): string {
  const length = value.trim().length;
  if (length > 130) {
    return "info-text-extreme";
  }
  if (length > 90) {
    return "info-text-very-long";
  }
  if (length > 55) {
    return "info-text-long";
  }
  return "";
}

function findMatrixCellAtPoint(x: number, y: number): AssignmentDragTarget | null {
  const element = document.elementsFromPoint(x, y).find((item): item is HTMLElement => {
    return item instanceof HTMLElement && Boolean(item.dataset.matrixSiteId && item.dataset.matrixDate);
  });
  if (!element?.dataset.matrixSiteId || !element.dataset.matrixDate) {
    return null;
  }
  return {
    siteId: Number(element.dataset.matrixSiteId),
    date: element.dataset.matrixDate,
    dayIndex: Number(element.dataset.matrixDayIndex ?? 0),
  };
}

function inclusiveDateDistance(startDate: string, endDate: string): number {
  return Math.max(1, Math.round((isoDateToTime(endDate) - isoDateToTime(startDate)) / DAY_IN_MS) + 1);
}

function addIsoDays(value: string, days: number): string {
  const date = new Date(isoDateToTime(value));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function activeAbsencesForDay(absences: Absence[], date: string): Absence[] {
  return absences
    .filter((absence) => absence.status === "active" && absence.start_date <= date && absence.end_date >= date)
    .sort(comparePlanningAbsences);
}

function activeAbsencesForPersonOnDay(absences: Absence[], personId: number, date: string): Absence[] {
  return activeAbsencesForDay(absences, date).filter((absence) => absence.person_id === personId);
}

function absencePlanningItemsForDay(absences: Absence[], date: string): PlanningAbsenceItem[] {
  const bestAbsenceByPerson = new Map<number, Absence>();
  activeAbsencesForDay(absences, date).forEach((absence) => {
    const current = bestAbsenceByPerson.get(absence.person_id);
    if (!current || absenceTypeSortPriority(absence) < absenceTypeSortPriority(current)) {
      bestAbsenceByPerson.set(absence.person_id, absence);
    }
  });
  return Array.from(bestAbsenceByPerson.values())
    .map((absence) => ({ absence }))
    .sort((left, right) => comparePlanningAbsences(left.absence, right.absence));
}

function absenceTypeSortPriority(absence: Absence): number {
  if (absence.absence_type === "sick") {
    return 0;
  }
  if (absence.absence_type === "vacation") {
    return 1;
  }
  if (absence.absence_type === "school") {
    return 2;
  }
  if (absence.absence_type === "free") {
    return 3;
  }
  return 4;
}

function absencePersonLabel(person: Person | undefined): string {
  return person ? calendarPersonCode(person) : "Person";
}

function absencePlanningTitle(item: PlanningAbsenceItem, person: Person | undefined): string {
  return `${person?.display_name ?? "Person"}: ${absenceTypeLabels[item.absence.absence_type]} ${formatAbsenceDateRange(item.absence)}`;
}

function absencePlanningBlockClassName(item: PlanningAbsenceItem): string {
  return [
    "absence-planning-chip",
    `absence-block-${item.absence.absence_type}`,
    item.absence.status === "cancelled" ? "is-cancelled" : "",
  ].filter(Boolean).join(" ");
}

function absenceOverflowItemClassName(item: PlanningAbsenceItem): string {
  return [
    "absence-overflow-item",
    `absence-overflow-${item.absence.absence_type}`,
    item.absence.status === "cancelled" ? "is-cancelled" : "",
  ].filter(Boolean).join(" ");
}

function matrixAbsenceCellClassName(date: string, today: string, holiday: HolidayInfo | null): string {
  return [
    "matrix-cell",
    "matrix-absence-cell",
    isWeekendDate(date) ? "weekend" : "",
    holiday ? "is-holiday" : "",
    isWeekStartDate(date) ? "is-week-start" : "",
    date === today ? "today" : "",
  ].filter(Boolean).join(" ");
}

function comparePlanningAbsences(left: Absence, right: Absence): number {
  return left.start_date.localeCompare(right.start_date)
    || left.end_date.localeCompare(right.end_date)
    || left.person_id - right.person_id
    || left.id - right.id;
}

function formatAbsenceDateRange(absence: Absence): string {
  if (absence.start_date === absence.end_date) {
    return formatShortDate(absence.start_date);
  }
  return `${formatShortDate(absence.start_date)} - ${formatShortDate(absence.end_date)}`;
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short" }).format(new Date(`${value}T00:00:00`));
}

function isoDateToTime(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function entriesFromCell(cell: MatrixCell): DraftEntry[] {
  return cell.assignments.map((assignment) => ({
    key: `p-${assignment.person.id}`,
    label: assignment.person.short_code,
    person_id: assignment.person.id,
  }));
}

function addDraftEntry(entries: DraftEntry[], entry: DraftEntry): DraftEntry[] {
  if (entries.some((item) => item.key === entry.key)) {
    return entries;
  }
  return [...entries, entry];
}

function upsertPerson(people: Person[], person: Person): Person[] {
  const exists = people.some((item) => item.id === person.id);
  const next = exists
    ? people.map((item) => item.id === person.id ? person : item)
    : [...people, person];
  return next.sort(compareAssignmentPeople);
}

function personMatchesQuery(person: Person, query: string): boolean {
  return [
    person.display_name,
    person.first_name,
    person.last_name,
    person.short_code,
    calendarPersonCode(person),
  ].some((value) => value.toLowerCase().includes(query));
}

function compareAssignmentPeople(left: Person, right: Person): number {
  const typePriority = personTypePriority(left.person_type) - personTypePriority(right.person_type);
  return typePriority || left.display_name.localeCompare(right.display_name);
}

function personTypePriority(personType: Person["person_type"]): number {
  return personType === "internal" ? 0 : 1;
}

function toMatrixEntryInput(entry: DraftEntry): MatrixEntryInput {
  return entry.person_id ? { person_id: entry.person_id } : { external_name: entry.external_name };
}

function sameEntries(left: DraftEntry[], right: DraftEntry[]): boolean {
  return (
    JSON.stringify(left.map(toMatrixEntryInput))
    === JSON.stringify(right.map(toMatrixEntryInput))
  );
}

function cellKey(siteId: number, date: string): CellKey {
  return `${siteId}-${date}`;
}

function readApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  if (typeof error.detail === "string") {
    return error.detail;
  }
  const conflictMessage = readConflictDetail(error.detail);
  if (conflictMessage) {
    return conflictMessage;
  }
  return error.message;
}

function readConflictDetail(detail: unknown): string | null {
  if (!isRecord(detail)) {
    return null;
  }
  const blockers = Array.isArray(detail.blockers) ? detail.blockers : [];
  const warnings = Array.isArray(detail.warnings) ? detail.warnings : [];
  const messages = [...blockers, ...warnings]
    .map(formatConflictMessage)
    .filter(Boolean);
  if (messages.length > 0) {
    return `Nicht gespeichert: ${messages.slice(0, 2).join(" ")}`;
  }
  return typeof detail.message === "string" ? detail.message : null;
}

function formatConflictMessage(item: unknown): string {
  if (!isRecord(item) || typeof item.message !== "string") {
    return "";
  }
  const date = typeof item.date === "string" ? ` (${formatConflictDate(item.date)})` : "";
  return `${humanConflictMessage(item)}${date}`;
}

function humanConflictMessage(item: Record<string, unknown>): string {
  if (item.code === "absence_vacation") {
    return "Die Person hat Urlaub und kann nicht eingeplant werden.";
  }
  if (item.code === "absence_sick") {
    return "Die Person ist krankgemeldet und kann nicht eingeplant werden.";
  }
  if (item.code === "too_many_assignments") {
    return "Die Person hat an diesem Tag bereits zwei Einsaetze.";
  }
  if (item.code === "person_inactive") {
    return "Diese Person ist deaktiviert und darf nicht eingeplant werden.";
  }
  if (item.code === "site_completed_or_deleted") {
    return "Diese Baustelle ist abgeschlossen oder geloescht.";
  }
  return String(item.message);
}

function formatConflictDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short" }).format(new Date(`${value}T00:00:00`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
