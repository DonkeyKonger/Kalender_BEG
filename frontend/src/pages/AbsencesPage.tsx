import { CalendarDays, CalendarX, ChevronLeft, ChevronRight, PlusCircle, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { AbsenceTypeBadge, StatusBadge, absenceTypeLabels } from "../components/StatusBadge";
import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import type { Absence, AbsenceCreate, AbsenceStatus } from "../types/absence";
import type { AbsenceType } from "../types/matrix";
import type { Person } from "../types/person";
import {
  formatDayHeader,
  formatDayNumber,
  getDefaultPlanningRange,
  isWeekendDate,
  toDateInputValue,
} from "../utils/dateRange";

const absenceStatusLabels: Record<AbsenceStatus, string> = {
  active: "Aktiv",
  cancelled: "Storniert",
};

type EditableAbsence = AbsenceCreate & { id: number };
type DrawerState = { mode: "new" } | { mode: "edit"; absenceId: number } | null;
type AbsenceViewMode = "planning" | "year";
type AbsenceCell = {
  date: string;
  absences: Absence[];
};
type PersonAbsenceRow = {
  person: Person;
  cells: AbsenceCell[];
};

function emptyAbsence(personId = 0, date = toDateInputValue(new Date())): AbsenceCreate {
  return {
    person_id: personId,
    absence_type: "vacation",
    start_date: date,
    end_date: date,
    status: "active",
    note: null,
  };
}

export function AbsencesPage() {
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "project_manager";
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditableAbsence>>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [createForm, setCreateForm] = useState<AbsenceCreate>(emptyAbsence);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [viewMode, setViewMode] = useState<AbsenceViewMode>("planning");
  const [year, setYear] = useState(new Date().getFullYear());
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [savingAbsenceId, setSavingAbsenceId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const matrixScrollRef = useRef<HTMLDivElement | null>(null);
  const planningRange = useMemo(() => getDefaultPlanningRange(), []);
  const today = useMemo(() => toDateInputValue(new Date()), []);

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    setIsLoading(true);
    setError(null);
    try {
      const [absenceData, personData] = await Promise.all([
        api.absences(),
        api.persons({ isActive: null }),
      ]);
      setAbsences(absenceData);
      setDrafts(toEditableAbsences(absenceData));
      setPeople(personData.sort(comparePeople));
    } catch (requestError) {
      setError(readApiError(requestError, "Abwesenheiten konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }

  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);

  const visibleDays = useMemo(() => {
    if (viewMode === "year") {
      return daysBetween(`${year}-01-01`, `${year}-12-31`);
    }
    return daysBetween(planningRange.start, planningRange.end);
  }, [planningRange.end, planningRange.start, viewMode, year]);

  const filteredPeople = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    const peopleWithVisibleAbsence = new Set(
      absences
        .filter((absence) => absenceOverlapsDays(absence, visibleDays))
        .map((absence) => absence.person_id),
    );
    return people
      .filter((person) => person.is_active || peopleWithVisibleAbsence.has(person.id))
      .filter((person) => {
        if (!needle) {
          return true;
        }
        return personSearchText(person).includes(needle)
          || absences.some((absence) => absence.person_id === person.id && absenceSearchText(absence).includes(needle));
      })
      .sort(comparePeople);
  }, [absences, people, searchTerm, visibleDays]);

  const rows = useMemo(
    () => buildAbsenceRows(filteredPeople, absences, visibleDays),
    [absences, filteredPeople, visibleDays],
  );

  const selectedAbsence = drawer?.mode === "edit"
    ? absences.find((absence) => absence.id === drawer.absenceId) ?? null
    : null;
  const selectedDraft = drawer?.mode === "edit" && selectedAbsence
    ? drafts[selectedAbsence.id] ?? toEditableAbsence(selectedAbsence)
    : null;

  useEffect(() => {
    if (!matrixScrollRef.current || viewMode !== "planning") {
      return;
    }
    const todayIndex = visibleDays.findIndex((day) => day === today);
    if (todayIndex >= 0) {
      matrixScrollRef.current.scrollLeft = todayIndex * ABSENCE_DAY_WIDTH;
    }
  }, [today, viewMode, visibleDays]);

  async function createAbsence() {
    const validationError = validateAbsencePayload(createForm);
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }
    setSavingAbsenceId(0);
    setError(null);
    setMessage(null);
    try {
      const created = await api.createAbsence(normalizeAbsencePayload(createForm));
      setAbsences((current) => [...current, created].sort(compareAbsences));
      setDrafts((current) => ({ ...current, [created.id]: toEditableAbsence(created) }));
      setCreateForm(emptyAbsence());
      setDrawer(null);
      setMessage("Abwesenheit angelegt.");
    } catch (requestError) {
      setError(readApiError(requestError, "Abwesenheit konnte nicht angelegt werden."));
    } finally {
      setSavingAbsenceId(null);
    }
  }

  async function saveAbsence(absenceId: number) {
    const draft = drafts[absenceId];
    if (!draft) {
      return;
    }
    const validationError = validateAbsencePayload(draft);
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }
    setSavingAbsenceId(absenceId);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.updateAbsence(absenceId, normalizeAbsencePayload(draft));
      replaceAbsence(updated);
      setMessage("Abwesenheit gespeichert.");
    } catch (requestError) {
      setError(readApiError(requestError, "Abwesenheit konnte nicht gespeichert werden."));
    } finally {
      setSavingAbsenceId(null);
    }
  }

  async function deleteAbsence(absenceId: number) {
    setSavingAbsenceId(absenceId);
    setError(null);
    setMessage(null);
    try {
      await api.deleteAbsence(absenceId);
      setAbsences((current) => current.filter((absence) => absence.id !== absenceId));
      setDrafts((current) => {
        const next = { ...current };
        delete next[absenceId];
        return next;
      });
      setDrawer(null);
      setMessage("Abwesenheit geloescht.");
    } catch (requestError) {
      setError(readApiError(requestError, "Abwesenheit konnte nicht geloescht werden."));
    } finally {
      setSavingAbsenceId(null);
    }
  }

  function replaceAbsence(updated: Absence) {
    setAbsences((current) =>
      current.map((absence) => absence.id === updated.id ? updated : absence).sort(compareAbsences),
    );
    setDrafts((current) => ({ ...current, [updated.id]: toEditableAbsence(updated) }));
  }

  function updateDraft(absenceId: number, values: Partial<EditableAbsence>) {
    setDrafts((current) => ({
      ...current,
      [absenceId]: { ...current[absenceId], ...values },
    }));
  }

  function openCreateDrawer(personId = 0, date = today) {
    setCreateForm(emptyAbsence(personId, date));
    setDrawer({ mode: "new" });
  }

  function closeDrawer() {
    setDrawer(null);
  }

  return (
    <section className="absences-page">
      <div className="page-header entity-page-header">
        <div>
          <p className="eyebrow">Personaldecke</p>
          <h1>Abwesenheiten</h1>
          <p className="matrix-range">
            {viewMode === "year" ? `Jahresansicht ${year}` : planningRange.label}
          </p>
        </div>
        {canEdit && (
          <button className="icon-button" type="button" onClick={() => openCreateDrawer()}>
            <PlusCircle aria-hidden="true" size={17} />
            <span>Neue Abwesenheit</span>
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      <div className="absence-matrix-toolbar">
        <input
          className="entity-search"
          placeholder="Person, Typ oder Notiz suchen"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
        />
        <div className="segmented-control" aria-label="Ansicht wechseln">
          <button
            className={viewMode === "planning" ? "is-active" : ""}
            type="button"
            onClick={() => setViewMode("planning")}
          >
            Planung
          </button>
          <button
            className={viewMode === "year" ? "is-active" : ""}
            type="button"
            onClick={() => setViewMode("year")}
          >
            Jahr
          </button>
        </div>
        {viewMode === "year" && (
          <div className="absence-year-control">
            <button className="icon-only-button" type="button" aria-label="Vorjahr" onClick={() => setYear((current) => current - 1)}>
              <ChevronLeft aria-hidden="true" size={16} />
            </button>
            <strong>{year}</strong>
            <button className="icon-only-button" type="button" aria-label="Naechstes Jahr" onClick={() => setYear((current) => current + 1)}>
              <ChevronRight aria-hidden="true" size={16} />
            </button>
          </div>
        )}
      </div>

      <div className="absence-type-legend compact" aria-label="Legende Abwesenheitstypen">
        {Object.keys(absenceTypeLabels).map((type) => (
          <AbsenceTypeBadge key={type} type={type as AbsenceType} />
        ))}
      </div>

      {isLoading && <div className="matrix-state">Abwesenheiten werden geladen...</div>}

      {!isLoading && (
        <AbsenceMatrix
          canEdit={canEdit}
          days={visibleDays}
          mode={viewMode}
          rows={rows}
          scrollRef={matrixScrollRef}
          today={today}
          onCreate={openCreateDrawer}
          onOpenAbsence={(absenceId) => setDrawer({ mode: "edit", absenceId })}
        />
      )}

      <EntityDetailDrawer
        isOpen={drawer?.mode === "new"}
        title="Neue Abwesenheit"
        subtitle="Krankheit, Urlaub, Schule, Frei oder Sonstiges eintragen"
        onClose={closeDrawer}
        footer={canEdit ? (
          <button className="icon-button" disabled={savingAbsenceId === 0} type="button" onClick={() => void createAbsence()}>
            <CalendarX aria-hidden="true" size={17} />
            <span>Abwesenheit anlegen</span>
          </button>
        ) : undefined}
      >
        <AbsenceFields
          draft={createForm}
          people={people}
          onChange={(values) => setCreateForm((current) => ({ ...current, ...values }))}
        />
      </EntityDetailDrawer>

      <EntityDetailDrawer
        isOpen={drawer?.mode === "edit" && Boolean(selectedAbsence && selectedDraft)}
        title={selectedAbsence ? peopleById.get(selectedAbsence.person_id)?.display_name ?? "Abwesenheit bearbeiten" : "Abwesenheit"}
        subtitle={selectedAbsence ? `${absenceTypeLabels[selectedAbsence.absence_type]} · ${formatDateRange(selectedAbsence)}` : undefined}
        onClose={closeDrawer}
        footer={selectedAbsence && canEdit ? (
          <>
            <button
              className="icon-button secondary"
              disabled={savingAbsenceId === selectedAbsence.id}
              type="button"
              onClick={() => void deleteAbsence(selectedAbsence.id)}
            >
              <Trash2 aria-hidden="true" size={16} />
              <span>Loeschen</span>
            </button>
            <button
              className="icon-button"
              disabled={savingAbsenceId === selectedAbsence.id}
              type="button"
              onClick={() => void saveAbsence(selectedAbsence.id)}
            >
              <Save aria-hidden="true" size={16} />
              <span>Speichern</span>
            </button>
          </>
        ) : undefined}
      >
        {selectedAbsence && selectedDraft && (
          <>
            <div className="absence-drawer-summary">
              <AbsenceTypeBadge type={selectedAbsence.absence_type} />
              <StatusBadge tone={selectedAbsence.status === "active" ? "active" : "inactive"}>
                {absenceStatusLabels[selectedAbsence.status]}
              </StatusBadge>
            </div>
            <AbsenceFields
              draft={selectedDraft}
              people={people}
              disabled={!canEdit}
              onChange={(values) => updateDraft(selectedAbsence.id, values)}
            />
          </>
        )}
      </EntityDetailDrawer>
    </section>
  );
}

function AbsenceMatrix({
  canEdit,
  days,
  mode,
  rows,
  scrollRef,
  today,
  onCreate,
  onOpenAbsence,
}: {
  canEdit: boolean;
  days: string[];
  mode: AbsenceViewMode;
  rows: PersonAbsenceRow[];
  scrollRef: RefObject<HTMLDivElement | null>;
  today: string;
  onCreate: (personId?: number, date?: string) => void;
  onOpenAbsence: (absenceId: number) => void;
}) {
  if (!rows.length) {
    return (
      <div className="empty-panel">
        <CalendarDays aria-hidden="true" size={22} />
        <p>Keine passenden Personen oder Abwesenheiten gefunden.</p>
      </div>
    );
  }

  return (
    <div
      className={mode === "year" ? "absence-matrix-scroll is-year" : "absence-matrix-scroll"}
      ref={scrollRef}
      role="region"
      aria-label="Abwesenheitsmatrix"
    >
      <table className="absence-matrix">
        <thead>
          <tr>
            <th className="absence-person-col">Person</th>
            {days.map((day) => (
              <th className={absenceDayClassName(day, today)} key={day}>
                <span>{formatDayHeader(day)}</span>
                <strong>{formatDayNumber(day)}</strong>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.person.id}>
              <th className="absence-person-col" scope="row">
                <span>{row.person.display_name}</span>
                <small>{row.person.short_code}</small>
              </th>
              {row.cells.map((cell) => (
                <td
                  className={absenceCellClassName(cell.date, today)}
                  key={`${row.person.id}-${cell.date}`}
                  onClick={() => {
                    if (canEdit && !cell.absences.length) {
                      onCreate(row.person.id, cell.date);
                    }
                  }}
                >
                  <div className="absence-cell-stack">
                    {cell.absences.map((absence) => (
                      <button
                        className={absenceBlockClassName(absence)}
                        key={absence.id}
                        title={`${absenceTypeLabels[absence.absence_type]}: ${formatDateRange(absence)}${absence.note ? ` - ${absence.note}` : ""}`}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenAbsence(absence.id);
                        }}
                      >
                        {mode === "year" ? absenceTypeShortLabel(absence.absence_type) : absenceTypeLabels[absence.absence_type]}
                      </button>
                    ))}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AbsenceFields({
  draft,
  people,
  disabled = false,
  onChange,
}: {
  draft: AbsenceCreate;
  people: Person[];
  disabled?: boolean;
  onChange: (values: Partial<AbsenceCreate>) => void;
}) {
  return (
    <div className="absence-form-grid">
      <label className="drawer-field absence-person-field">
        <span>Person</span>
        <select
          disabled={disabled}
          value={draft.person_id || ""}
          onChange={(event) => onChange({ person_id: Number(event.target.value) })}
        >
          <option value="">Person waehlen</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.display_name}{person.is_active ? "" : " (inaktiv)"}
            </option>
          ))}
        </select>
      </label>
      <label className="drawer-field">
        <span>Typ</span>
        <select
          disabled={disabled}
          value={draft.absence_type}
          onChange={(event) => onChange({ absence_type: event.target.value as AbsenceType })}
        >
          {Object.entries(absenceTypeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="drawer-field">
        <span>Von</span>
        <input
          disabled={disabled}
          type="date"
          value={draft.start_date}
          onChange={(event) => onChange({ start_date: event.target.value })}
        />
      </label>
      <label className="drawer-field">
        <span>Bis</span>
        <input
          disabled={disabled}
          min={draft.start_date}
          type="date"
          value={draft.end_date}
          onChange={(event) => onChange({ end_date: event.target.value })}
        />
      </label>
      <label className="drawer-field">
        <span>Status</span>
        <select
          disabled={disabled}
          value={draft.status}
          onChange={(event) => onChange({ status: event.target.value as AbsenceStatus })}
        >
          {Object.entries(absenceStatusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="drawer-field absence-note-field">
        <span>Notiz</span>
        <textarea
          disabled={disabled}
          value={draft.note ?? ""}
          onChange={(event) => onChange({ note: event.target.value || null })}
        />
      </label>
    </div>
  );
}

const ABSENCE_DAY_WIDTH = 42;
const DAY_MS = 24 * 60 * 60 * 1000;

function buildAbsenceRows(people: Person[], absences: Absence[], days: string[]): PersonAbsenceRow[] {
  return people.map((person) => ({
    person,
    cells: days.map((date) => ({
      date,
      absences: absences
        .filter((absence) => absence.person_id === person.id && absence.start_date <= date && absence.end_date >= date)
        .sort(compareAbsences),
    })),
  }));
}

function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  const current = parseLocalDate(start);
  const last = parseLocalDate(end);
  while (current <= last) {
    days.push(toDateInputValue(current));
    current.setTime(current.getTime() + DAY_MS);
  }
  return days;
}

function absenceOverlapsDays(absence: Absence, days: string[]): boolean {
  const firstDay = days[0];
  const lastDay = days.at(-1);
  if (!firstDay || !lastDay) {
    return false;
  }
  return absence.start_date <= lastDay && absence.end_date >= firstDay;
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toEditableAbsences(absences: Absence[]): Record<string, EditableAbsence> {
  return Object.fromEntries(
    absences.map((absence) => [String(absence.id), toEditableAbsence(absence)]),
  );
}

function toEditableAbsence(absence: Absence): EditableAbsence {
  return {
    id: absence.id,
    person_id: absence.person_id,
    absence_type: absence.absence_type,
    start_date: absence.start_date,
    end_date: absence.end_date,
    status: absence.status,
    note: absence.note,
  };
}

function validateAbsencePayload(absence: AbsenceCreate): string | null {
  if (!absence.person_id) {
    return "Bitte eine Person waehlen.";
  }
  if (absence.end_date < absence.start_date) {
    return "Enddatum liegt vor Startdatum.";
  }
  return null;
}

function normalizeAbsencePayload(absence: AbsenceCreate): AbsenceCreate {
  return {
    ...absence,
    note: absence.note?.trim() || null,
  };
}

function compareAbsences(left: Absence, right: Absence): number {
  return left.start_date.localeCompare(right.start_date) || left.end_date.localeCompare(right.end_date) || left.id - right.id;
}

function comparePeople(left: Person, right: Person): number {
  return left.display_name.localeCompare(right.display_name, "de") || left.id - right.id;
}

function personSearchText(person: Person): string {
  return [
    person.display_name,
    person.first_name,
    person.last_name,
    person.short_code,
    person.person_type,
  ].filter(Boolean).join(" ").toLowerCase();
}

function absenceSearchText(absence: Absence): string {
  return [
    absenceTypeLabels[absence.absence_type],
    absenceStatusLabels[absence.status],
    absence.start_date,
    absence.end_date,
    absence.note,
  ].filter(Boolean).join(" ").toLowerCase();
}

function absenceTypeShortLabel(type: AbsenceType): string {
  const labels: Record<AbsenceType, string> = {
    vacation: "U",
    sick: "K",
    school: "S",
    free: "F",
    other: "O",
  };
  return labels[type];
}

function absenceBlockClassName(absence: Absence): string {
  return [
    "absence-block",
    `absence-block-${absence.absence_type}`,
    absence.status === "cancelled" ? "is-cancelled" : "",
  ].filter(Boolean).join(" ");
}

function absenceDayClassName(date: string, today: string): string {
  return ["absence-day-col", isWeekendDate(date) ? "weekend" : "", date === today ? "today" : ""].filter(Boolean).join(" ");
}

function absenceCellClassName(date: string, today: string): string {
  return ["absence-day-cell", isWeekendDate(date) ? "weekend" : "", date === today ? "today" : ""].filter(Boolean).join(" ");
}

function formatDateRange(absence: Absence): string {
  if (absence.start_date === absence.end_date) {
    return formatDate(absence.start_date);
  }
  return `${formatDate(absence.start_date)} - ${formatDate(absence.end_date)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short" }).format(new Date(`${value}T00:00:00`));
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
