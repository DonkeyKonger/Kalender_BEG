import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { MatrixCellEditor } from "../components/MatrixCellEditor";
import { SiteStatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type {
  MatrixCell,
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
        <SiteStatusBadge status={row.site.status} />
      </td>
      {row.cells.map((cell) => {
        const key = cellKey(row.site.id, cell.date);
        const isActive = props.activeCell?.key === key;
        return (
          <td
            className={isWeekendDate(cell.date) ? "matrix-cell weekend" : "matrix-cell"}
            key={cell.date}
            onClick={() => props.onOpenCell(row, cell)}
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
              <CellDisplay cell={cell} />
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
