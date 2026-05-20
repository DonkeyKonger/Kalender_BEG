import { CalendarX, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import type { Absence, AbsenceCreate, AbsenceStatus } from "../types/absence";
import type { AbsenceType } from "../types/matrix";
import type { Person } from "../types/person";
import { toDateInputValue } from "../utils/dateRange";

const absenceTypeLabels: Record<AbsenceType, string> = {
  vacation: "Urlaub",
  sick: "Krankheit",
  school: "Schule",
  free: "Frei",
  other: "Sonstiges",
};

const absenceStatusLabels: Record<AbsenceStatus, string> = {
  active: "Aktiv",
  cancelled: "Storniert",
};

type EditableAbsence = AbsenceCreate & { id: number };

function emptyAbsence(): AbsenceCreate {
  const today = toDateInputValue(new Date());
  return {
    person_id: 0,
    absence_type: "vacation",
    start_date: today,
    end_date: today,
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
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [savingAbsenceId, setSavingAbsenceId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
      setPeople(personData);
    } catch (requestError) {
      setError(readApiError(requestError, "Abwesenheiten konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }

  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);

  const filteredAbsences = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) {
      return absences;
    }
    return absences.filter((absence) => absenceSearchText(absence, peopleById).includes(needle));
  }, [absences, peopleById, searchTerm]);

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

  return (
    <section className="absences-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Stammdaten</p>
          <h1>Abwesenheiten</h1>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      <input
        className="absence-search"
        placeholder="Abwesenheit suchen"
        value={searchTerm}
        onChange={(event) => setSearchTerm(event.target.value)}
      />

      {canEdit && (
        <section className="absence-create-panel">
          <h2>
            <CalendarX aria-hidden="true" size={18} />
            Neue Abwesenheit
          </h2>
          <AbsenceFields
            draft={createForm}
            people={people}
            onChange={(values) => setCreateForm((current) => ({ ...current, ...values }))}
          />
          <button
            className="icon-button"
            disabled={savingAbsenceId === 0}
            type="button"
            onClick={() => void createAbsence()}
          >
            <CalendarX aria-hidden="true" size={17} />
            <span>Abwesenheit anlegen</span>
          </button>
        </section>
      )}

      {isLoading && <div className="matrix-state">Abwesenheiten werden geladen...</div>}

      {!isLoading && (
        <div className="absence-list">
          {filteredAbsences.map((absence) => {
            const draft = drafts[absence.id] ?? toEditableAbsence(absence);
            const person = peopleById.get(absence.person_id);
            return (
              <article className="absence-row" key={absence.id}>
                <div className="absence-row-meta">
                  <strong>{person?.display_name ?? `Person #${absence.person_id}`}</strong>
                  <span>
                    {absenceTypeLabels[absence.absence_type]} - {formatDateRange(absence)}
                  </span>
                  <span className={absence.status === "active" ? "active-text" : "inactive-text"}>
                    {absenceStatusLabels[absence.status]}
                  </span>
                  {absence.note && <small>{absence.note}</small>}
                </div>

                {canEdit && (
                  <>
                    <AbsenceFields
                      draft={draft}
                      compact
                      people={people}
                      onChange={(values) => updateDraft(absence.id, values)}
                    />
                    <div className="absence-actions">
                      <button
                        className="icon-button secondary"
                        disabled={savingAbsenceId === absence.id}
                        type="button"
                        onClick={() => void saveAbsence(absence.id)}
                      >
                        <Save aria-hidden="true" size={16} />
                        <span>Speichern</span>
                      </button>
                      <button
                        className="icon-button secondary"
                        disabled={savingAbsenceId === absence.id}
                        type="button"
                        onClick={() => void deleteAbsence(absence.id)}
                      >
                        <Trash2 aria-hidden="true" size={16} />
                        <span>Loeschen</span>
                      </button>
                    </div>
                  </>
                )}
              </article>
            );
          })}
          {!filteredAbsences.length && <p className="empty-inline">Keine Abwesenheiten gefunden.</p>}
        </div>
      )}
    </section>
  );
}

function AbsenceFields({
  draft,
  people,
  compact = false,
  onChange,
}: {
  draft: AbsenceCreate;
  people: Person[];
  compact?: boolean;
  onChange: (values: Partial<AbsenceCreate>) => void;
}) {
  return (
    <div className={compact ? "absence-form-grid compact" : "absence-form-grid"}>
      <label>
        <span>Person</span>
        <select
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
      <label>
        <span>Typ</span>
        <select
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
      <label>
        <span>Von</span>
        <input
          type="date"
          value={draft.start_date}
          onChange={(event) => onChange({ start_date: event.target.value })}
        />
      </label>
      <label>
        <span>Bis</span>
        <input
          min={draft.start_date}
          type="date"
          value={draft.end_date}
          onChange={(event) => onChange({ end_date: event.target.value })}
        />
      </label>
      <label>
        <span>Status</span>
        <select
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
      <label className="absence-note-field">
        <span>Notiz</span>
        <textarea
          value={draft.note ?? ""}
          onChange={(event) => onChange({ note: event.target.value || null })}
        />
      </label>
    </div>
  );
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
  return left.start_date.localeCompare(right.start_date) || left.id - right.id;
}

function absenceSearchText(absence: Absence, peopleById: Map<number, Person>): string {
  const person = peopleById.get(absence.person_id);
  return [
    person?.display_name,
    absenceTypeLabels[absence.absence_type],
    absenceStatusLabels[absence.status],
    absence.start_date,
    absence.end_date,
    absence.note,
  ].filter(Boolean).join(" ").toLowerCase();
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
