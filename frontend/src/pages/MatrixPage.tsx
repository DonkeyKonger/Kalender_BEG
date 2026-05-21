import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { MatrixCellEditor } from "../components/MatrixCellEditor";
import { siteStatusLabels } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type {
  MatrixCell,
  MatrixCellMark,
  MatrixEntryInput,
  MatrixPerson,
  MatrixResponse,
  MatrixRow,
  SiteStatus,
} from "../types/matrix";
import type { Person } from "../types/person";
import { calendarPersonCode, canEditMatrix } from "../types/person";
import {
  formatDayHeader,
  formatDayNumber,
  getDefaultPlanningRange,
  isWeekendDate,
  toDateInputValue,
} from "../utils/dateRange";

type CellKey = `${number}-${string}`;
type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
type DraftEntry = MatrixEntryInput & { key: string; label: string };
type ActiveCell = { siteId: number; date: string; endDate: string; key: CellKey };
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
type UndoItem = {
  siteId: number;
  date: string;
  endDate: string;
  before: DraftEntry[];
  after: DraftEntry[];
};

export function MatrixPage() {
  const { user } = useAuth();
  const defaultRange = useMemo(() => getDefaultPlanningRange(), []);
  const [matrix, setMatrix] = useState<MatrixResponse | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
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
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [externalName, setExternalName] = useState("");
  const [saveStatus, setSaveStatus] = useState<Record<CellKey, SaveStatus>>({});
  const [cellMessage, setCellMessage] = useState<Record<CellKey, string>>({});
  const [undoStack, setUndoStack] = useState<UndoItem[]>([]);
  const autosaveRef = useRef<number | null>(null);
  const cellMessageTimeoutsRef = useRef<Record<CellKey, number>>({});
  const skipNextDraftAutosaveRef = useRef(false);
  const matrixScrollRef = useRef<HTMLDivElement | null>(null);
  const selectionAnchorRef = useRef<EditorAnchor | null>(null);
  const didSetInitialProjectManagerFilter = useRef(false);
  const today = useMemo(() => toDateInputValue(new Date()), []);
  const [projectManagerFilter, setProjectManagerFilter] = useState<string>("all");
  const [isCompactView, setIsCompactView] = useState(false);
  const [siteInfoDrafts, setSiteInfoDrafts] = useState<Record<number, string>>({});
  const [savingInfoSiteId, setSavingInfoSiteId] = useState<number | null>(null);
  const [savingStatusSiteId, setSavingStatusSiteId] = useState<number | null>(null);
  const isEditable = user ? canEditMatrix(user.role) : false;
  const dayColumnWidth = matrixDayColumnWidth(isCompactView);
  const selectedCellRange = useMemo(() => {
    if (!matrix || !selectionStartCell || !selectionEndCell) {
      return null;
    }
    return buildCellRange(selectionStartCell, selectionEndCell, matrix.days);
  }, [matrix, selectionEndCell, selectionStartCell]);
  const highlightedCellRange = isSelecting ? selectedCellRange : activeEditorRange;
  const activeEditorContext = useMemo(() => {
    if (!matrix || !activeCell) {
      return null;
    }
    return matrixEditorContext(matrix, activeCell);
  }, [activeCell, matrix]);

  const loadMatrix = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [matrixData, personData] = await Promise.all([
        api.matrix({
          start: defaultRange.start,
          end: defaultRange.end,
          includeWeekends: true,
        }),
        api.persons(),
      ]);
      setMatrix(matrixData);
      setSiteInfoDrafts(siteInfoDraftsFromRows(matrixData.rows));
      setPeople(personData);
    } catch (requestError) {
      setError(readApiError(requestError, "Matrixdaten konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }, [defaultRange.end, defaultRange.start]);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

  useEffect(() => {
    if (!user?.id) {
      return;
    }
    setIsCompactView(localStorage.getItem(matrixCompactPreferenceKey(user.id)) === "true");
  }, [user?.id]);

  useEffect(() => {
    if (!matrix || didSetInitialProjectManagerFilter.current) {
      return;
    }
    didSetInitialProjectManagerFilter.current = true;
    if (user?.person_id && matrix.rows.some((row) => row.site.project_manager_person_id === user.person_id)) {
      setProjectManagerFilter(String(user.person_id));
    }
  }, [matrix, user?.person_id]);

  useEffect(() => {
    if (!matrix || !matrixScrollRef.current) {
      return;
    }
    const todayIndex = matrix.days.findIndex((day) => day.date === today);
    if (todayIndex < 0) {
      return;
    }
    matrixScrollRef.current.scrollLeft = todayIndex * dayColumnWidth;
  }, [dayColumnWidth, matrix, today]);

  useEffect(() => {
    return () => {
      Object.values(cellMessageTimeoutsRef.current).forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, []);

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

  function updateCompactView(value: boolean) {
    setIsCompactView(value);
    if (user) {
      localStorage.setItem(matrixCompactPreferenceKey(user.id), String(value));
    }
  }

  function openCell(row: MatrixRow, cell: MatrixCell, extendRange = false, anchor?: EditorAnchor) {
    if (!isEditable) {
      return;
    }
    if (extendRange && activeCell?.siteId === row.site.id) {
      const [startDate, endDate] = sortDates(activeCell.date, cell.date);
      const range = rangeFromDates(row.site.id, startDate, endDate, matrix?.days ?? []);
      openEditorForRange(row, cell, range, anchor);
      return;
    }
    openEditorForRange(row, cell, singleCellRange(row.site.id, cell.date, matrix?.days ?? []), anchor);
  }

  function openEditorForRange(row: MatrixRow, cell: MatrixCell, range: CellRange, anchor?: EditorAnchor) {
    const key = cellKey(row.site.id, range.startDate);
    const entries = entriesFromCell(cell);
    skipNextDraftAutosaveRef.current = true;
    setActiveCell({ siteId: row.site.id, date: range.startDate, endDate: range.endDate, key });
    setActiveEditorRange(range);
    setEditorAnchor(anchor ?? null);
    setDraftEntries(entries);
    setInitialEntries(entries);
    setSelectedPersonId("");
    setExternalName("");
    if (range.startDate !== range.endDate) {
      setCellMessage((current) => ({
        ...current,
        [key]: "Zeitraum gewaehlt - mit Speichern bestaetigen",
      }));
    }
  }

  function addSelectedPerson(personId = selectedPersonId) {
    const person = people.find((item) => item.id === Number(personId));
    if (!person) {
      return;
    }
    setDraftEntries((current) => addDraftEntry(current, {
      key: `p-${person.id}`,
      label: calendarPersonCode(person),
      person_id: person.id,
    }));
    setSelectedPersonId("");
  }

  function addExternalPerson() {
    const cleaned = externalName.trim();
    if (!cleaned) {
      return;
    }
    setDraftEntries((current) => addDraftEntry(current, {
      key: `x-${cleaned.toLowerCase()}`,
      label: cleaned,
      external_name: cleaned,
    }));
    setExternalName("");
  }

  function closeActiveEditor() {
    setActiveCell(null);
    setEditorAnchor(null);
    setActiveEditorRange(null);
    clearSelection();
    setSelectedPersonId("");
    setExternalName("");
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

  async function saveActiveCell(options: { closeOnSuccess?: boolean } = {}) {
    if (!activeCell) {
      return;
    }
    if (autosaveRef.current) {
      window.clearTimeout(autosaveRef.current);
      autosaveRef.current = null;
    }
    const unchanged = sameEntries(initialEntries, draftEntries);
    if (unchanged && activeCell.endDate === activeCell.date) {
      setSaveStatus((current) => ({ ...current, [activeCell.key]: "idle" }));
      if (options.closeOnSuccess) {
        closeActiveEditor();
      }
      return;
    }
    const entries = draftEntries.map(toMatrixEntryInput);
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
      if (!sameEntries(initialEntries, draftEntries)) {
        setUndoStack((current) => [
          ...current,
          {
            siteId: activeCell.siteId,
            date: activeCell.date,
            endDate: activeCell.endDate,
            before: initialEntries,
            after: draftEntries,
          },
        ]);
      }
      setInitialEntries(draftEntries);
      setError(null);
      if (response.warnings[0]?.message) {
        setSaveStatus((current) => ({ ...current, [activeCell.key]: "saved" }));
        setCellMessage((current) => ({
          ...current,
          [activeCell.key]: response.warnings[0].message,
        }));
      } else {
        showTemporaryCellFeedback(activeCell.key, "Gespeichert");
      }
      replaceMatrixCells(activeCell.siteId, response.updated_cells);
      if (options.closeOnSuccess) {
        closeActiveEditor();
      } else {
        setActiveEditorRange(null);
        clearSelection();
      }
    } catch (requestError) {
      setSaveStatus((current) => ({ ...current, [activeCell.key]: "error" }));
      const message = readApiError(requestError, "Speichern fehlgeschlagen.");
      setError(message);
      setCellMessage((current) => ({
        ...current,
        [activeCell.key]: message,
      }));
    }
  }

  function startCellSelection(row: MatrixRow, cell: MatrixCell, cellIndex: number, event: MatrixCellMouseEvent) {
    if (!isEditable || event.button !== 0) {
      return;
    }
    event.preventDefault();
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

  async function undoLast() {
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

  async function deleteAssignmentFromCell(row: MatrixRow, cell: MatrixCell, personId: number) {
    if (!isEditable) {
      return;
    }
    const key = cellKey(row.site.id, cell.date);
    const before = entriesFromCell(cell);
    const after = before.filter((entry) => entry.person_id !== personId);
    clearTemporaryCellFeedback(key);
    setSaveStatus((current) => ({ ...current, [key]: "saving" }));
    setCellMessage((current) => ({ ...current, [key]: "" }));
    try {
      const response = await api.patchMatrixCell({
        siteId: row.site.id,
        date: cell.date,
        entries: after.map(toMatrixEntryInput),
      });
      setUndoStack((current) => [
        ...current,
        { siteId: row.site.id, date: cell.date, endDate: cell.date, before, after },
      ]);
      setError(null);
      showTemporaryCellFeedback(key, "Monteur entfernt");
      replaceMatrixCells(row.site.id, response.updated_cells);
    } catch (requestError) {
      const message = readApiError(requestError, "Monteur konnte nicht entfernt werden.");
      setError(message);
      setSaveStatus((current) => ({ ...current, [key]: "error" }));
      setCellMessage((current) => ({ ...current, [key]: message }));
    }
  }


  async function clearCellMark(row: MatrixRow, cell: MatrixCell) {
    if (!isEditable || !cell.mark) {
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
      setCellMessage((current) => ({ ...current, [key]: message }));
    }
  }

  async function cycleCellMark(row: MatrixRow, cell: MatrixCell) {
    if (!isEditable) {
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
      setCellMessage((current) => ({ ...current, [key]: message }));
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
    if (!currentRow) {
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
    if (!currentRow || currentRow.site.status === status) {
      return;
    }
    setSavingStatusSiteId(siteId);
    try {
      const updated = await api.updateSite(siteId, { status });
      setError(null);
      updateMatrixSiteStatus(updated.id, updated.status);
      if (updated.status === "closed" || updated.status === "archived") {
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

  const projectManagerOptions = useMemo(() => {
    if (!matrix) {
      return [];
    }
    return projectManagerOptionsFromRows(matrix.rows);
  }, [matrix]);

  const visibleRowGroups = useMemo(() => {
    if (!matrix) {
      return [];
    }
    return groupMatrixRows(matrix.rows, projectManagerFilter);
  }, [matrix, projectManagerFilter]);

  return (
    <section className={isCompactView ? "matrix-page is-compact" : "matrix-page"}>
      <div className="matrix-toolbar">
        <div>
          <p className="eyebrow">Planung</p>
          <h1>Planmatrix</h1>
          <p className="matrix-range">{defaultRange.label}</p>
        </div>
        <div className="matrix-actions">
          {projectManagerOptions.length > 0 && (
            <div className="matrix-pm-filter" aria-label="Projektleiter filtern">
              <button
                className={projectManagerFilter === "all" ? "is-active" : ""}
                type="button"
                onClick={() => setProjectManagerFilter("all")}
              >
                Alle
              </button>
              {projectManagerOptions.map((manager) => (
                <button
                  className={projectManagerFilter === String(manager.id) ? "is-active" : ""}
                  key={manager.id}
                  type="button"
                  onClick={() => setProjectManagerFilter(String(manager.id))}
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
          <button
            className="icon-button secondary"
            disabled={!undoStack.length}
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
            activeCell={activeCell}
            cellMessage={cellMessage}
            dayColumnWidth={dayColumnWidth}
            draftEntries={draftEntries}
            isCompactView={isCompactView}
            isEditable={isEditable}
            matrix={matrix}
            matrixScrollRef={matrixScrollRef}
            onDeleteAssignment={deleteAssignmentFromCell}
            onClearCellMark={clearCellMark}
            onCycleCellMark={cycleCellMark}
            onInfoChange={(siteId, value) => setSiteInfoDrafts((current) => ({ ...current, [siteId]: value }))}
            onInfoSave={(siteId) => void saveSiteInfo(siteId)}
            onStatusChange={(siteId, status) => void saveSiteStatus(siteId, status)}
            onAddExternal={addExternalPerson}
            onAddPerson={addSelectedPerson}
            onEndDateChange={(endDate) => {
              if (activeCell) {
                setActiveCell({ ...activeCell, endDate });
              }
            }}
            onExternalNameChange={setExternalName}
            highlightedCellRange={highlightedCellRange}
            onCellMouseDown={startCellSelection}
            onCellMouseEnter={extendCellSelection}
            onCellMouseUp={finishCellSelection}
            onOpenCell={openCell}
            onRemoveEntry={(key) =>
              setDraftEntries((items) => items.filter((item) => item.key !== key))
            }
            onSave={() => void saveActiveCell()}
            onSelectedPersonChange={setSelectedPersonId}
            people={people}
            saveStatus={saveStatus}
            savingInfoSiteId={savingInfoSiteId}
            savingStatusSiteId={savingStatusSiteId}
            selectedPersonId={selectedPersonId}
            siteInfoDrafts={siteInfoDrafts}
            today={today}
            visibleRowGroups={visibleRowGroups}
            externalName={externalName}
          />

          {activeCell && editorAnchor && activeEditorContext && (
            <MatrixCellEditorPopup
              activeCell={activeCell}
              anchor={editorAnchor}
              cellMessage={cellMessage[activeCell.key]}
              context={activeEditorContext}
              draftEntries={draftEntries}
              externalName={externalName}
              onAddExternal={addExternalPerson}
              onAddPerson={addSelectedPerson}
              onClose={closeOrSaveActiveEditor}
              onEndDateChange={(endDate) => setActiveCell({ ...activeCell, endDate })}
              onExternalNameChange={setExternalName}
              onRemoveEntry={(key) =>
                setDraftEntries((items) => items.filter((item) => item.key !== key))
              }
              onSave={() => void saveActiveCell()}
              onSelectedPersonChange={setSelectedPersonId}
              people={people}
              saveStatus={saveStatus[activeCell.key]}
              selectedPersonId={selectedPersonId}
            />
          )}
        </>
      )}
    </section>
  );
}

type MatrixCellEditorPopupProps = {
  activeCell: ActiveCell;
  anchor: EditorAnchor;
  cellMessage?: string;
  context: MatrixEditorContext;
  draftEntries: DraftEntry[];
  externalName: string;
  onAddExternal: () => void;
  onAddPerson: (personId?: string) => void;
  onClose: () => void;
  onEndDateChange: (date: string) => void;
  onExternalNameChange: (value: string) => void;
  onRemoveEntry: (key: string) => void;
  onSave: () => void;
  onSelectedPersonChange: (value: string) => void;
  people: Person[];
  saveStatus?: SaveStatus;
  selectedPersonId: string;
};

function MatrixCellEditorPopup({
  activeCell,
  anchor,
  cellMessage,
  context,
  draftEntries,
  externalName,
  onAddExternal,
  onAddPerson,
  onClose,
  onEndDateChange,
  onExternalNameChange,
  onRemoveEntry,
  onSave,
  onSelectedPersonChange,
  people,
  saveStatus,
  selectedPersonId,
}: MatrixCellEditorPopupProps) {
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
      className="matrix-cell-editor-popup"
      ref={popupRef}
      style={{ left: position.left, top: position.top }}
      onClick={(event) => event.stopPropagation()}
    >
      <MatrixCellEditor
        activeCell={activeCell}
        cellMessage={cellMessage}
        context={context}
        draftEntries={draftEntries}
        externalName={externalName}
        onAddExternal={onAddExternal}
        onAddPerson={onAddPerson}
        onClose={onClose}
        onEndDateChange={onEndDateChange}
        onExternalNameChange={onExternalNameChange}
        onRemoveEntry={onRemoveEntry}
        onSave={onSave}
        onSelectedPersonChange={onSelectedPersonChange}
        people={people}
        saveStatus={saveStatus}
        selectedPersonId={selectedPersonId}
      />
    </div>,
    document.body,
  );
}

type MatrixTableProps = {
  activeCell: ActiveCell | null;
  cellMessage: Record<CellKey, string>;
  dayColumnWidth: number;
  highlightedCellRange: CellRange | null;
  draftEntries: DraftEntry[];
  externalName: string;
  isCompactView: boolean;
  isEditable: boolean;
  matrix: MatrixResponse;
  matrixScrollRef: RefObject<HTMLDivElement | null>;
  onAddExternal: () => void;
  onDeleteAssignment: (row: MatrixRow, cell: MatrixCell, personId: number) => void;
  onClearCellMark: (row: MatrixRow, cell: MatrixCell) => void;
  onCycleCellMark: (row: MatrixRow, cell: MatrixCell) => void;
  onAddPerson: () => void;
  onEndDateChange: (date: string) => void;
  onExternalNameChange: (value: string) => void;
  onInfoChange: (siteId: number, value: string) => void;
  onInfoSave: (siteId: number) => void;
  onStatusChange: (siteId: number, status: SiteStatus) => void;
  onCellMouseDown: (row: MatrixRow, cell: MatrixCell, cellIndex: number, event: MatrixCellMouseEvent) => void;
  onCellMouseEnter: (row: MatrixRow, cell: MatrixCell, cellIndex: number, event: MatrixCellMouseEvent) => void;
  onCellMouseUp: (row: MatrixRow, cell: MatrixCell, cellIndex: number, event: MatrixCellMouseEvent) => void;
  onOpenCell: (row: MatrixRow, cell: MatrixCell, extendRange?: boolean, anchor?: EditorAnchor) => void;
  onRemoveEntry: (key: string) => void;
  onSave: () => void;
  onSelectedPersonChange: (value: string) => void;
  people: Person[];
  saveStatus: Record<CellKey, SaveStatus>;
  savingInfoSiteId: number | null;
  savingStatusSiteId: number | null;
  selectedPersonId: string;
  siteInfoDrafts: Record<number, string>;
  today: string;
  visibleRowGroups: MatrixRowGroup[];
};

function MatrixTable(props: MatrixTableProps) {
  const tableWidth = matrixTableWidth(props.matrix.days.length, props.isCompactView);
  const tableStyle = {
    width: tableWidth,
    minWidth: tableWidth,
    "--day-column-width": `${props.dayColumnWidth}px`,
  } as CSSProperties;

  return (
    <div className="matrix-scroll" ref={props.matrixScrollRef} role="region" aria-label="Planmatrix">
      <table className="matrix-table" style={tableStyle}>
        <colgroup>
          <col className="site-col-width" />
          <col className="pm-col-width" />
          <col className="info-col-width" />
          <col className="status-col-width" />
          {props.matrix.days.map((day) => (
            <col className="day-col-width" key={day.date} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="sticky-col site-col">Baustelle</th>
            <th className="sticky-col pm-col">PL</th>
            <th className="sticky-col info-col">Info</th>
            <th className="sticky-col status-col">Status</th>
            {props.matrix.days.map((day) => (
              <th
                className={dayHeaderClassName(day.date, props.today)}
                key={day.date}
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
            ))}
          </tr>
        </thead>
        <tbody>
          {props.visibleRowGroups.map((group) => (
            <MatrixTableGroup group={group} key={group.key} {...props} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixTableGroup({ group, ...props }: MatrixTableProps & { group: MatrixRowGroup }) {
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
    </>
  );
}

type MatrixTableRowProps = MatrixTableProps & { row: MatrixRow };

function MatrixTableRow({ row, ...props }: MatrixTableRowProps) {
  return (
    <tr>
      <th className="sticky-col site-col row-heading" scope="row">
        <div className="row-heading-content">
          <span
            className="site-color"
            style={{ backgroundColor: row.site.color ?? "#94a3b8" }}
          />
          <Link className="matrix-site-link" to={`/sites/${row.site.id}`}>
            <strong>{row.site.name}</strong>
            {row.site.site_number && <small className="matrix-site-number">{row.site.site_number}</small>}
            {row.site.location && <span className="matrix-site-location">{row.site.location}</span>}
            <span className="matrix-site-compact-meta">{siteCompactMeta(row.site.site_number, row.site.location)}</span>
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
        <MatrixStatusSelect
          disabled={!props.isEditable || props.savingStatusSiteId === row.site.id}
          status={row.site.status}
          onChange={(status) => props.onStatusChange(row.site.id, status)}
        />
      </td>
      {row.cells.map((cell, cellIndex) => {
        const key = cellKey(row.site.id, cell.date);
        return (
          <td
            className={matrixCellClassName(cell, props.today, isCellInCellRange(row.site.id, cellIndex, props.highlightedCellRange))}
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
              event.stopPropagation();
              props.onClearCellMark(row, cell);
            }}
          >
            <CellDisplay
              cell={cell}
              cellIndex={cellIndex}
              dayColumnWidth={props.dayColumnWidth}
              isEditable={props.isEditable}
              rowCells={row.cells}
              onDeleteAssignment={(personId) => props.onDeleteAssignment(row, cell, personId)}
            />
            {props.saveStatus[key] && <span className={`save-dot ${props.saveStatus[key]}`} />}
            {props.cellMessage[key] && (
              <small className="cell-message">{props.cellMessage[key]}</small>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function MatrixStatusSelect({
  disabled,
  status,
  onChange,
}: {
  disabled: boolean;
  status: SiteStatus;
  onChange: (status: SiteStatus) => void;
}) {
  return (
    <select
      aria-label="Baustellenstatus"
      className={`matrix-status-select status-${status}`}
      disabled={disabled}
      value={status}
      onChange={(event) => onChange(event.target.value as SiteStatus)}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {SITE_STATUS_OPTIONS.map((option) => (
        <option key={option} value={option}>{siteStatusLabels[option]}</option>
      ))}
    </select>
  );
}

function CellDisplay({
  cell,
  cellIndex,
  dayColumnWidth,
  isEditable,
  rowCells,
  onDeleteAssignment,
}: {
  cell: MatrixCell;
  cellIndex: number;
  dayColumnWidth: number;
  isEditable: boolean;
  rowCells: MatrixCell[];
  onDeleteAssignment: (personId: number) => void;
}) {
  const visibleAssignmentCount = cell.assignments.filter(
    (assignment) => assignmentRunSpan(rowCells, cellIndex, assignment.person.id) > 0,
  ).length;

  return (
    <div
      className="cell-stack"
      style={{ "--assignment-layers": Math.max(1, visibleAssignmentCount) } as CSSProperties}
    >
      {cell.assignments.map((assignment) => {
        const span = assignmentRunSpan(rowCells, cellIndex, assignment.person.id);
        if (span === 0) {
          return null;
        }
        const layer = assignmentRunLayer(cell.assignments, rowCells, cellIndex, assignment.person.id);
        return (
          <button
            className={span > 1 ? "person-chip is-assignment-run" : "person-chip"}
            key={assignment.id}
            style={{
              "--assignment-layer": layer,
              width: span > 1 ? `${span * dayColumnWidth - 8}px` : undefined,
            } as CSSProperties}
            title={isEditable ? `${assignment.person.display_name} - Rechtsklick entfernt den Monteur am Starttag` : assignment.person.display_name}
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              if (!isEditable) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              onDeleteAssignment(assignment.person.id);
            }}
          >
            {assignment.person.short_code}
          </button>
        );
      })}
      {cell.absences.map((absence) => (
        <span
          className="absence-chip"
          key={`${absence.person.id}-${absence.absence_type}-${cell.date}`}
          title={`${absence.person.display_name}: ${absence.absence_type}`}
        >
          {absence.person.short_code}
        </span>
      ))}
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
  return (
    <label className="matrix-info-editor">
      <span className="sr-only">Info</span>
      <textarea
        className={matrixInfoTextClassName(value)}
        disabled={disabled || isSaving}
        placeholder="Info"
        title={value || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onSave}
        onClick={(event) => event.stopPropagation()}
      />
    </label>
  );
}

const DAY_COLUMN_WIDTH = 104;
const COMPACT_DAY_COLUMN_WIDTH = 88;
const EDITOR_POPUP_HEIGHT = 560;
const EDITOR_POPUP_WIDTH = 390;
const FIXED_MATRIX_COLUMNS_WIDTH = 552;
const COMPACT_FIXED_MATRIX_COLUMNS_WIDTH = 488;
const MATRIX_CELL_MARKS: Array<MatrixCellMark | null> = [null, "orange", "red", "blue"];
const SITE_STATUS_OPTIONS: SiteStatus[] = ["active", "paused", "closed", "archived"];
type ProjectManagerOption = {
  id: number;
  name: string;
  shortCode: string;
};

type MatrixEditorContext = {
  siteName: string;
  siteNumber: string | null;
  location: string | null;
  dateLabel: string;
};

type MatrixRowGroup = {
  key: string;
  label: string;
  rows: MatrixRow[];
  showHeading: boolean;
};

function matrixEditorContext(matrix: MatrixResponse, activeCell: ActiveCell): MatrixEditorContext {
  const row = matrix.rows.find((item) => item.site.id === activeCell.siteId);
  return {
    siteName: row?.site.name ?? "Baustelle",
    siteNumber: row?.site.site_number ?? null,
    location: row?.site.location ?? null,
    dateLabel: formatEditorDateRange(activeCell.date, activeCell.endDate),
  };
}

function formatEditorDateRange(startDate: string, endDate: string): string {
  if (startDate === endDate) {
    return formatEditorDate(startDate);
  }
  return formatEditorDate(startDate) + " - " + formatEditorDate(endDate);
}

function formatEditorDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function anchorFromRect(rect: DOMRect): EditorAnchor {
  return {
    bottom: rect.bottom,
    left: rect.left,
    top: rect.top,
    width: rect.width,
  };
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

function matrixDayColumnWidth(isCompactView: boolean): number {
  return isCompactView ? COMPACT_DAY_COLUMN_WIDTH : DAY_COLUMN_WIDTH;
}

function matrixTableWidth(dayCount: number, isCompactView: boolean): string {
  const fixedWidth = isCompactView ? COMPACT_FIXED_MATRIX_COLUMNS_WIDTH : FIXED_MATRIX_COLUMNS_WIDTH;
  return `${fixedWidth + dayCount * matrixDayColumnWidth(isCompactView)}px`;
}

function matrixCompactPreferenceKey(userId: number): string {
  return `kb_matrix_compact_view_${userId}`;
}

function siteCompactMeta(siteNumber: string | null, location: string | null): string {
  return [siteNumber, location].filter(Boolean).join(" · ");
}

function projectManagerOptionsFromRows(rows: MatrixRow[]): ProjectManagerOption[] {
  const options = new Map<number, ProjectManagerOption>();
  rows.forEach((row) => {
    const manager = row.site.project_manager;
    if (!manager) {
      return;
    }
    options.set(manager.id, {
      id: manager.id,
      name: manager.display_name,
      shortCode: manager.short_code,
    });
  });
  return [...options.values()].sort((left, right) => left.name.localeCompare(right.name, "de"));
}

function groupMatrixRows(rows: MatrixRow[], projectManagerFilter: string): MatrixRowGroup[] {
  const filteredRows = projectManagerFilter === "all"
    ? rows
    : rows.filter((row) => String(row.site.project_manager_person_id ?? "") === projectManagerFilter);
  const sortedRows = filteredRows.slice().sort(compareMatrixRowsByNumber);
  if (projectManagerFilter !== "all") {
    return [{ key: projectManagerFilter, label: "", rows: sortedRows, showHeading: false }];
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

function dayHeaderClassName(date: string, today: string): string {
  return ["day-col", isWeekendDate(date) ? "weekend" : "", date === today ? "today" : ""].filter(Boolean).join(" ");
}

function matrixCellClassName(cell: MatrixCell, today: string, isRangeSelected: boolean): string {
  return [
    "matrix-cell",
    isWeekendDate(cell.date) ? "weekend" : "",
    cell.date === today ? "today" : "",
    cell.mark ? `mark-${cell.mark}` : "",
    isRangeSelected ? "is-range-selected" : "",
  ].filter(Boolean).join(" ");
}

function nextMatrixCellMark(current: MatrixCellMark | null): MatrixCellMark | null {
  const currentIndex = MATRIX_CELL_MARKS.indexOf(current);
  return MATRIX_CELL_MARKS[(currentIndex + 1) % MATRIX_CELL_MARKS.length];
}

function isCellInCellRange(siteId: number, dayIndex: number, range: CellRange | null): boolean {
  return Boolean(range && range.siteId === siteId && dayIndex >= range.startIndex && dayIndex <= range.endIndex);
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

function singleCellRange(siteId: number, date: string, visibleDays: MatrixResponse["days"]): CellRange {
  const dayIndex = Math.max(0, visibleDays.findIndex((day) => day.date === date));
  return { siteId, startDate: date, endDate: date, startIndex: dayIndex, endIndex: dayIndex, dates: [date] };
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

function assignmentRunSpan(cells: MatrixCell[], cellIndex: number, personId: number): number {
  const previousHasPerson = cells[cellIndex - 1]?.assignments.some((assignment) => assignment.person.id === personId);
  if (previousHasPerson) {
    return 0;
  }
  let span = 1;
  for (let index = cellIndex + 1; index < cells.length; index += 1) {
    const hasPerson = cells[index].assignments.some((assignment) => assignment.person.id === personId);
    if (!hasPerson) {
      break;
    }
    span += 1;
  }
  return span;
}

function assignmentRunLayer(assignments: MatrixCell["assignments"], cells: MatrixCell[], cellIndex: number, personId: number): number {
  return assignments
    .slice(0, assignments.findIndex((assignment) => assignment.person.id === personId))
    .filter((assignment) => assignmentRunSpan(cells, cellIndex, assignment.person.id) > 0)
    .length;
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
  if (item.code === "site_closed_or_archived") {
    return "Diese Baustelle ist geschlossen oder archiviert.";
  }
  return String(item.message);
}

function formatConflictDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short" }).format(new Date(`${value}T00:00:00`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
