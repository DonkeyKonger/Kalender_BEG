import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { MatrixCellEditor } from "../components/MatrixCellEditor";
import { SiteStatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type {
  MatrixCell,
  MatrixCellMark,
  MatrixEntryInput,
  MatrixResponse,
  MatrixRow,
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
  const [draftEntries, setDraftEntries] = useState<DraftEntry[]>([]);
  const [initialEntries, setInitialEntries] = useState<DraftEntry[]>([]);
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [externalName, setExternalName] = useState("");
  const [saveStatus, setSaveStatus] = useState<Record<CellKey, SaveStatus>>({});
  const [cellMessage, setCellMessage] = useState<Record<CellKey, string>>({});
  const [undoStack, setUndoStack] = useState<UndoItem[]>([]);
  const autosaveRef = useRef<number | null>(null);
  const matrixScrollRef = useRef<HTMLDivElement | null>(null);
  const didSetInitialProjectManagerFilter = useRef(false);
  const today = useMemo(() => toDateInputValue(new Date()), []);
  const [projectManagerFilter, setProjectManagerFilter] = useState<string>("all");
  const [siteInfoDrafts, setSiteInfoDrafts] = useState<Record<number, string>>({});
  const [savingInfoSiteId, setSavingInfoSiteId] = useState<number | null>(null);
  const isEditable = user ? canEditMatrix(user.role) : false;

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
    matrixScrollRef.current.scrollLeft = todayIndex * DAY_COLUMN_WIDTH;
  }, [matrix, today]);

  useEffect(() => {
    if (!activeCell) {
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

  function openCell(row: MatrixRow, cell: MatrixCell, extendRange = false) {
    if (!isEditable) {
      return;
    }
    if (extendRange && activeCell?.siteId === row.site.id) {
      const [startDate, endDate] = sortDates(activeCell.date, cell.date);
      const key = cellKey(row.site.id, startDate);
      setActiveCell({ siteId: row.site.id, date: startDate, endDate, key });
      setCellMessage((current) => ({
        ...current,
        [key]: "Zeitraum gewaehlt - mit Speichern bestaetigen",
      }));
      return;
    }
    const key = cellKey(row.site.id, cell.date);
    const entries = entriesFromCell(cell);
    setActiveCell({ siteId: row.site.id, date: cell.date, endDate: cell.date, key });
    setDraftEntries(entries);
    setInitialEntries(entries);
    setSelectedPersonId("");
    setExternalName("");
  }

  function addSelectedPerson() {
    const person = people.find((item) => item.id === Number(selectedPersonId));
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

  async function saveActiveCell() {
    if (!activeCell) {
      return;
    }
    const unchanged = sameEntries(initialEntries, draftEntries);
    if (unchanged && activeCell.endDate === activeCell.date) {
      setSaveStatus((current) => ({ ...current, [activeCell.key]: "idle" }));
      return;
    }
    const entries = draftEntries.map(toMatrixEntryInput);
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
      setSaveStatus((current) => ({ ...current, [activeCell.key]: "saved" }));
      setCellMessage((current) => ({
        ...current,
        [activeCell.key]: response.warnings[0]?.message ?? "Gespeichert",
      }));
      replaceMatrixCells(activeCell.siteId, response.updated_cells);
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
      setSaveStatus((current) => ({ ...current, [key]: "saved" }));
      setCellMessage((current) => ({ ...current, [key]: "Monteur entfernt" }));
      replaceMatrixCells(row.site.id, response.updated_cells);
    } catch (requestError) {
      const message = readApiError(requestError, "Monteur konnte nicht entfernt werden.");
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
    setSaveStatus((current) => ({ ...current, [key]: "saving" }));
    setCellMessage((current) => ({ ...current, [key]: "" }));
    try {
      const response = await api.patchMatrixCellMark({
        siteId: row.site.id,
        date: cell.date,
        mark: nextMark,
      });
      setError(null);
      setSaveStatus((current) => ({ ...current, [key]: "saved" }));
      setCellMessage((current) => ({ ...current, [key]: nextMark ? "Markierung gespeichert" : "Markierung entfernt" }));
      replaceMatrixCells(row.site.id, response.updated_cells);
    } catch (requestError) {
      const message = readApiError(requestError, "Markierung konnte nicht gespeichert werden.");
      setError(message);
      setSaveStatus((current) => ({ ...current, [key]: "error" }));
      setCellMessage((current) => ({ ...current, [key]: message }));
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
    <section className="matrix-page">
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
                  {manager.shortCode || manager.name}
                </button>
              ))}
            </div>
          )}
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
        <MatrixTable
          activeCell={activeCell}
          cellMessage={cellMessage}
          draftEntries={draftEntries}
          isEditable={isEditable}
          matrix={matrix}
          matrixScrollRef={matrixScrollRef}
          onDeleteAssignment={deleteAssignmentFromCell}
          onCycleCellMark={cycleCellMark}
          onInfoChange={(siteId, value) => setSiteInfoDrafts((current) => ({ ...current, [siteId]: value }))}
          onInfoSave={(siteId) => void saveSiteInfo(siteId)}
          onAddExternal={addExternalPerson}
          onAddPerson={addSelectedPerson}
          onEndDateChange={(endDate) => {
            if (activeCell) {
              setActiveCell({ ...activeCell, endDate });
            }
          }}
          onExternalNameChange={setExternalName}
          onOpenCell={openCell}
          onRemoveEntry={(key) =>
            setDraftEntries((items) => items.filter((item) => item.key !== key))
          }
          onSave={() => void saveActiveCell()}
          onSelectedPersonChange={setSelectedPersonId}
          people={people}
          saveStatus={saveStatus}
          savingInfoSiteId={savingInfoSiteId}
          selectedPersonId={selectedPersonId}
          siteInfoDrafts={siteInfoDrafts}
          today={today}
          visibleRowGroups={visibleRowGroups}
          externalName={externalName}
        />
      )}
    </section>
  );
}

type MatrixTableProps = {
  activeCell: ActiveCell | null;
  cellMessage: Record<CellKey, string>;
  draftEntries: DraftEntry[];
  externalName: string;
  isEditable: boolean;
  matrix: MatrixResponse;
  matrixScrollRef: RefObject<HTMLDivElement | null>;
  onAddExternal: () => void;
  onDeleteAssignment: (row: MatrixRow, cell: MatrixCell, personId: number) => void;
  onCycleCellMark: (row: MatrixRow, cell: MatrixCell) => void;
  onAddPerson: () => void;
  onEndDateChange: (date: string) => void;
  onExternalNameChange: (value: string) => void;
  onInfoChange: (siteId: number, value: string) => void;
  onInfoSave: (siteId: number) => void;
  onOpenCell: (row: MatrixRow, cell: MatrixCell, extendRange?: boolean) => void;
  onRemoveEntry: (key: string) => void;
  onSave: () => void;
  onSelectedPersonChange: (value: string) => void;
  people: Person[];
  saveStatus: Record<CellKey, SaveStatus>;
  savingInfoSiteId: number | null;
  selectedPersonId: string;
  siteInfoDrafts: Record<number, string>;
  today: string;
  visibleRowGroups: MatrixRowGroup[];
};

function MatrixTable(props: MatrixTableProps) {
  return (
    <div className="matrix-scroll" ref={props.matrixScrollRef} role="region" aria-label="Planmatrix">
      <table className="matrix-table">
        <thead>
          <tr>
            <th className="sticky-col site-col">Baustelle</th>
            <th className="sticky-col location-col">Ort</th>
            <th className="sticky-col pm-col">PL</th>
            <th className="sticky-col info-col">Info</th>
            <th className="sticky-col status-col">Status</th>
            {props.matrix.days.map((day) => (
              <th
                className={dayHeaderClassName(day.date, props.today)}
                key={day.date}
              >
                <span>{formatDayHeader(day.date)}</span>
                <strong>{formatDayNumber(day.date)}</strong>
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
          <th colSpan={5 + props.matrix.days.length}>{group.label}</th>
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
            {row.site.site_number && <small>{row.site.site_number}</small>}
          </Link>
        </div>
      </th>
      <td className="sticky-col location-col compact-text">{row.site.location ?? ""}</td>
      <td className="sticky-col pm-col compact-text">
        {row.site.project_manager?.short_code ?? ""}
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
        <SiteStatusBadge status={row.site.status} />
      </td>
      {row.cells.map((cell, cellIndex) => {
        const key = cellKey(row.site.id, cell.date);
        const isActive = props.activeCell?.key === key;
        return (
          <td
            className={matrixCellClassName(cell, props.today, isCellInActiveRange(row.site.id, cell.date, props.activeCell))}
            key={cell.date}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
              }
            }}
            onClick={(event) => props.onOpenCell(row, cell, event.shiftKey)}
            onMouseDown={(event) => {
              if (event.button !== 1) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              props.onCycleCellMark(row, cell);
            }}
          >
            {isActive && props.activeCell ? (
              <MatrixCellEditor
                activeCell={props.activeCell}
                draftEntries={props.draftEntries}
                externalName={props.externalName}
                onAddExternal={props.onAddExternal}
                onAddPerson={props.onAddPerson}
                onEndDateChange={props.onEndDateChange}
                onExternalNameChange={props.onExternalNameChange}
                onRemoveEntry={props.onRemoveEntry}
                onSave={props.onSave}
                onSelectedPersonChange={props.onSelectedPersonChange}
                people={props.people}
                selectedPersonId={props.selectedPersonId}
              />
            ) : (
              <CellDisplay cell={cell} cellIndex={cellIndex} isEditable={props.isEditable} rowCells={row.cells} onDeleteAssignment={(personId) => props.onDeleteAssignment(row, cell, personId)} />
            )}
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

function CellDisplay({
  cell,
  cellIndex,
  isEditable,
  rowCells,
  onDeleteAssignment,
}: {
  cell: MatrixCell;
  cellIndex: number;
  isEditable: boolean;
  rowCells: MatrixCell[];
  onDeleteAssignment: (personId: number) => void;
}) {
  return (
    <div className="cell-stack">
      {cell.assignments.map((assignment) => (
        <button
          className={`person-chip ${assignmentConnectionClass(rowCells, cellIndex, assignment.person.id)}`}
          key={assignment.id}
          title={isEditable ? `${assignment.person.display_name} - Rechtsklick entfernt den Monteur` : assignment.person.display_name}
          type="button"
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
      ))}
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
        disabled={disabled || isSaving}
        placeholder="Info"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onSave}
        onClick={(event) => event.stopPropagation()}
      />
    </label>
  );
}

const DAY_COLUMN_WIDTH = 104;
const MATRIX_CELL_MARKS: Array<MatrixCellMark | null> = [null, "orange", "red", "blue"];
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

function isCellInActiveRange(siteId: number, date: string, activeCell: ActiveCell | null): boolean {
  if (!activeCell || activeCell.siteId !== siteId) {
    return false;
  }
  const [startDate, endDate] = sortDates(activeCell.date, activeCell.endDate);
  return date >= startDate && date <= endDate;
}

function sortDates(left: string, right: string): [string, string] {
  return left <= right ? [left, right] : [right, left];
}

function assignmentConnectionClass(cells: MatrixCell[], cellIndex: number, personId: number): string {
  const hasPrevious = Boolean(cells[cellIndex - 1]?.assignments.some((assignment) => assignment.person.id === personId));
  const hasNext = Boolean(cells[cellIndex + 1]?.assignments.some((assignment) => assignment.person.id === personId));
  if (hasPrevious && hasNext) {
    return "is-connected-middle";
  }
  if (hasPrevious) {
    return "is-connected-end";
  }
  if (hasNext) {
    return "is-connected-start";
  }
  return "is-connected-single";
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
