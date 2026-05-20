import { RotateCcw, Save, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import type {
  MatrixCell,
  MatrixEntryInput,
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
} from "../utils/dateRange";

const statusLabels: Record<SiteStatus, string> = {
  active: "Aktiv",
  paused: "Pause",
  closed: "Zu",
  archived: "Archiv",
};

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
  const [includeWeekends, setIncludeWeekends] = useState(false);
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
  const isEditable = user ? canEditMatrix(user.role) : false;

  const loadMatrix = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [matrixData, personData] = await Promise.all([
        api.matrix({
          start: defaultRange.start,
          end: defaultRange.end,
          includeWeekends,
        }),
        api.persons(),
      ]);
      setMatrix(matrixData);
      setPeople(personData);
    } catch (requestError) {
      setError(readApiError(requestError, "Matrixdaten konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }, [defaultRange.end, defaultRange.start, includeWeekends]);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

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
  }, [draftEntries, activeCell?.endDate]);

  function openCell(row: MatrixRow, cell: MatrixCell) {
    if (!isEditable) {
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
      setSaveStatus((current) => ({ ...current, [activeCell.key]: "saved" }));
      setCellMessage((current) => ({
        ...current,
        [activeCell.key]: response.warnings[0]?.message ?? "Gespeichert",
      }));
      replaceMatrixCells(activeCell.siteId, response.updated_cells);
    } catch (requestError) {
      setSaveStatus((current) => ({ ...current, [activeCell.key]: "error" }));
      setCellMessage((current) => ({
        ...current,
        [activeCell.key]: readApiError(requestError, "Speichern fehlgeschlagen."),
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

  return (
    <section className="matrix-page">
      <div className="matrix-toolbar">
        <div>
          <p className="eyebrow">Planung</p>
          <h1>Planmatrix</h1>
          <p className="matrix-range">{defaultRange.label}</p>
        </div>
        <div className="matrix-actions">
          <button
            className="icon-button secondary"
            disabled={!undoStack.length}
            type="button"
            onClick={() => void undoLast()}
          >
            <RotateCcw aria-hidden="true" size={17} />
            <span>Undo</span>
          </button>
          <label className="switch-control">
            <input
              type="checkbox"
              checked={includeWeekends}
              onChange={(event) => setIncludeWeekends(event.target.checked)}
            />
            <span>Wochenenden</span>
          </label>
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
          selectedPersonId={selectedPersonId}
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
  onAddExternal: () => void;
  onAddPerson: () => void;
  onEndDateChange: (date: string) => void;
  onExternalNameChange: (value: string) => void;
  onOpenCell: (row: MatrixRow, cell: MatrixCell) => void;
  onRemoveEntry: (key: string) => void;
  onSave: () => void;
  onSelectedPersonChange: (value: string) => void;
  people: Person[];
  saveStatus: Record<CellKey, SaveStatus>;
  selectedPersonId: string;
};

function MatrixTable(props: MatrixTableProps) {
  return (
    <div className="matrix-scroll" role="region" aria-label="Planmatrix">
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
                className={isWeekendDate(day.date) ? "day-col weekend" : "day-col"}
                key={day.date}
              >
                <span>{formatDayHeader(day.date)}</span>
                <strong>{formatDayNumber(day.date)}</strong>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.matrix.rows.map((row) => (
            <MatrixTableRow key={row.site.id} row={row} {...props} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

type MatrixTableRowProps = MatrixTableProps & { row: MatrixRow };

function MatrixTableRow({ row, ...props }: MatrixTableRowProps) {
  return (
    <tr>
      <th className="sticky-col site-col row-heading" scope="row">
        <span
          className="site-color"
          style={{ backgroundColor: row.site.color ?? "#94a3b8" }}
        />
        <Link className="matrix-site-link" to={`/sites/${row.site.id}`}>
          <strong>{row.site.name}</strong>
          {row.site.site_number && <small>{row.site.site_number}</small>}
        </Link>
      </th>
      <td className="sticky-col location-col compact-text">{row.site.location ?? ""}</td>
      <td className="sticky-col pm-col compact-text">
        {row.site.project_manager?.short_code ?? ""}
      </td>
      <td className="sticky-col info-col compact-text">{row.site.info ?? ""}</td>
      <td className="sticky-col status-col">
        <span className={`status-badge status-${row.site.status}`}>
          {statusLabels[row.site.status]}
        </span>
      </td>
      {row.cells.map((cell, index) => {
        const key = cellKey(row.site.id, cell.date);
        const isActive = props.activeCell?.key === key;
        return (
          <td
            className={isWeekendDate(cell.date) ? "matrix-cell weekend" : "matrix-cell"}
            key={cell.date}
            onClick={() => props.onOpenCell(row, cell)}
          >
            {isActive ? <CellEditor cell={cell} {...props} /> : <CellDisplay cell={cell} />}
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

function CellDisplay({ cell }: { cell: MatrixCell }) {
  return (
    <div className="cell-stack">
      {cell.assignments.map((assignment) => (
        <span
          className="person-chip"
          key={assignment.id}
          title={assignment.person.display_name}
        >
          {assignment.person.short_code}
        </span>
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

function CellEditor(props: MatrixTableProps & { cell: MatrixCell }) {
  const activeCell = props.activeCell;
  if (!activeCell) {
    return null;
  }

  return (
    <div className="cell-editor" onClick={(event) => event.stopPropagation()}>
      <div className="editor-chip-list">
        {props.draftEntries.map((entry) => (
          <button key={entry.key} type="button" onClick={() => props.onRemoveEntry(entry.key)}>
            <span>{entry.label}</span>
            <X aria-hidden="true" size={12} />
          </button>
        ))}
      </div>
      <select
        value={props.selectedPersonId}
        onChange={(event) => props.onSelectedPersonChange(event.target.value)}
      >
        <option value="">Person</option>
        {props.people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.display_name}
          </option>
        ))}
      </select>
      <button type="button" onClick={props.onAddPerson}>+</button>
      <input
        placeholder="Extern"
        value={props.externalName}
        onChange={(event) => props.onExternalNameChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            props.onAddExternal();
          }
        }}
      />
      <input
        aria-label="Bis Datum"
        min={activeCell.date}
        type="date"
        value={activeCell.endDate}
        onChange={(event) => props.onEndDateChange(event.target.value)}
      />
      <button className="save-cell-button" type="button" onClick={props.onSave}>
        <Save aria-hidden="true" size={13} />
      </button>
    </div>
  );
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
  if (typeof error.detail === "object" && error.detail && "message" in error.detail) {
    return String(error.detail.message);
  }
  return error.message;
}
