import { CalendarClock, CalendarX, ClipboardCheck, PlusCircle, Save, Trash2, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { EntityCard } from "../components/EntityCard";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { StatusBadge } from "../components/StatusBadge";
import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import type { Absence, AbsenceCreate, AbsenceStatus } from "../types/absence";
import type { AbsenceType } from "../types/matrix";
import type { Person } from "../types/person";
import { toDateInputValue } from "../utils/dateRange";

const absenceTypeLabels: Record<AbsenceType, string> = {
  vacation: "Urlaub",
  sick: "Krank",
  school: "Schule",
  free: "Frei",
  other: "Sonstiges",
};

const absenceStatusLabels: Record<AbsenceStatus, string> = {
  active: "Aktiv",
  cancelled: "Storniert",
};

type EditableAbsence = AbsenceCreate & { id: number };
type DrawerState = { mode: "new" } | { mode: "edit"; absenceId: number } | null;
type FocusMode = "past" | "today" | "future" | "all";

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
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [focusMode, setFocusMode] = useState<FocusMode>("today");
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
      setPeople(personData.sort(comparePeople));
    } catch (requestError) {
      setError(readApiError(requestError, "Abwesenheiten konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }

  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);
  const today = toDateInputValue(new Date());

  const focusBuckets = useMemo(() => ({
    past: absences.filter((absence) => isPastAbsence(absence, today)),
    today: absences.filter((absence) => isCurrentAbsence(absence, today)),
    future: absences.filter((absence) => isFutureRelevantAbsence(absence, today)),
  }), [absences, today]);

  const focusedAbsences = useMemo(() => {
    if (focusMode === "all") {
      return absences;
    }
    return focusBuckets[focusMode];
  }, [absences, focusBuckets, focusMode]);

  const filteredAbsences = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    const list = focusedAbsences;
    if (!needle) {
      return list.slice().sort((left, right) => compareAbsencesForFocus(left, right, focusMode));
    }
    return list
      .filter((absence) => absenceSearchText(absence, peopleById).includes(needle))
      .sort((left, right) => compareAbsencesForFocus(left, right, focusMode));
  }, [focusedAbsences, focusMode, peopleById, searchTerm]);

  const selectedAbsence = drawer?.mode === "edit"
    ? absences.find((absence) => absence.id === drawer.absenceId) ?? null
    : null;
  const selectedDraft = drawer?.mode === "edit" && selectedAbsence
    ? drafts[selectedAbsence.id] ?? toEditableAbsence(selectedAbsence)
    : null;

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

  function closeDrawer() {
    setDrawer(null);
  }

  return (
    <section className="absences-page">
      <div className="page-header entity-page-header">
        <div>
          <p className="eyebrow">Personaldecke</p>
          <h1>Abwesenheiten</h1>
        </div>
        {canEdit && (
          <button className="icon-button" type="button" onClick={() => setDrawer({ mode: "new" })}>
            <PlusCircle aria-hidden="true" size={17} />
            <span>Neue Abwesenheit</span>
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      <div className="absence-focus-grid" aria-label="Arbeitsbereiche fuer Abwesenheiten">
        <FocusCard
          icon={<ClipboardCheck aria-hidden="true" size={20} />}
          title="Rueckblick pruefen"
          description="Vergangene Krankmeldungen und Urlaube fuer das Buero."
          count={focusBuckets.past.length}
          isActive={focusMode === "past"}
          onClick={() => setFocusMode("past")}
        />
        <FocusCard
          icon={<CalendarClock aria-hidden="true" size={20} />}
          title="Heute pruefen"
          description="Aktuelle Ausfaelle fuer Projektleiter und Tagesplanung."
          count={focusBuckets.today.length}
          isActive={focusMode === "today"}
          onClick={() => setFocusMode("today")}
        />
        <FocusCard
          icon={<TrendingUp aria-hidden="true" size={20} />}
          title="Vorschau planen"
          description="Kommende Engstellen und Einsatzmoeglichkeiten erkennen."
          count={focusBuckets.future.length}
          isActive={focusMode === "future"}
          onClick={() => setFocusMode("future")}
        />
      </div>

      <div className="absence-toolbar">
        <input
          className="entity-search"
          placeholder="Abwesenheit suchen"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
        />
        <button
          className={focusMode === "all" ? "absence-filter-button is-active" : "absence-filter-button"}
          type="button"
          onClick={() => setFocusMode(focusMode === "all" ? "today" : "all")}
        >
          Alle anzeigen
        </button>
      </div>

      <div className="absence-type-legend" aria-label="Legende Abwesenheitstypen">
        {Object.entries(absenceTypeLabels).map(([type, label]) => (
          <AbsenceTypeBubble key={type} type={type as AbsenceType}>{label}</AbsenceTypeBubble>
        ))}
      </div>

      {isLoading && <div className="matrix-state">Abwesenheiten werden geladen...</div>}

      {!isLoading && (
        <div className="entity-card-list absence-card-list" role="list">
          {filteredAbsences.map((absence) => {
            const person = peopleById.get(absence.person_id);
            return (
              <EntityCard
                key={absence.id}
                title={person?.display_name ?? `Person #${absence.person_id}`}
                subtitle={`${absenceTypeLabels[absence.absence_type]} · ${formatDateRange(absence)}`}
                meta={absenceCardMeta(absence, today)}
                color={absenceTypeColor(absence.absence_type)}
                icon={<CalendarX aria-hidden="true" size={17} />}
                status={<AbsenceStatus absence={absence} />}
                isInactive={absence.status === "cancelled"}
                onClick={() => setDrawer({ mode: "edit", absenceId: absence.id })}
              />
            );
          })}
          {!filteredAbsences.length && (
            <div className="empty-panel">
              <p>{absences.length ? "Keine Treffer in diesem Arbeitsbereich." : "Noch keine Abwesenheiten vorhanden."}</p>
            </div>
          )}
        </div>
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
              <AbsenceTypeBubble type={selectedAbsence.absence_type}>{absenceTypeLabels[selectedAbsence.absence_type]}</AbsenceTypeBubble>
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

function FocusCard({
  icon,
  title,
  description,
  count,
  isActive,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  count: number;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button className={isActive ? "absence-focus-card is-active" : "absence-focus-card"} type="button" onClick={onClick}>
      <span className="absence-focus-icon">{icon}</span>
      <span className="absence-focus-body">
        <span className="absence-focus-title">{title}</span>
        <span className="absence-focus-description">{description}</span>
      </span>
      <span className="absence-focus-count">{count}</span>
    </button>
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

function AbsenceStatus({ absence }: { absence: Absence }) {
  if (absence.status === "cancelled") {
    return <StatusBadge tone="inactive">Storniert</StatusBadge>;
  }
  return <AbsenceTypeBubble type={absence.absence_type}>{absenceTypeLabels[absence.absence_type]}</AbsenceTypeBubble>;
}

function AbsenceTypeBubble({ type, children }: { type: AbsenceType; children: ReactNode }) {
  return <span className={`absence-type-bubble absence-type-${type}`}>{children}</span>;
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

function compareAbsencesForFocus(left: Absence, right: Absence, focusMode: FocusMode): number {
  if (focusMode === "past") {
    return right.end_date.localeCompare(left.end_date) || right.id - left.id;
  }
  return compareAbsences(left, right);
}

function comparePeople(left: Person, right: Person): number {
  return left.display_name.localeCompare(right.display_name, "de") || left.id - right.id;
}

function absenceSearchText(absence: Absence, peopleById: Map<number, Person>): string {
  const person = peopleById.get(absence.person_id);
  return [
    person?.display_name,
    person?.first_name,
    person?.last_name,
    absenceTypeLabels[absence.absence_type],
    absenceStatusLabels[absence.status],
    absence.start_date,
    absence.end_date,
    absence.note,
  ].filter(Boolean).join(" ").toLowerCase();
}

function absenceCardMeta(absence: Absence, today: string): string[] {
  const items = [absence.status === "cancelled" ? "Storniert" : absenceTimingLabel(absence, today)];
  if (absence.note) {
    items.push(absence.note);
  }
  return items;
}

function absenceTimingLabel(absence: Absence, today: string): string {
  if (isCurrentAbsence(absence, today)) {
    return "Heute relevant";
  }
  if (isPastAbsence(absence, today)) {
    return `Beendet am ${formatDate(absence.end_date)}`;
  }
  return `Startet am ${formatDate(absence.start_date)}`;
}

function isPastAbsence(absence: Absence, today: string): boolean {
  return absence.status === "active" && absence.end_date < today;
}

function isCurrentAbsence(absence: Absence, today: string): boolean {
  return absence.status === "active" && absence.start_date <= today && absence.end_date >= today;
}

function isFutureRelevantAbsence(absence: Absence, today: string): boolean {
  return absence.status === "active" && absence.end_date >= today;
}

function absenceTypeColor(type: AbsenceType): string {
  const colors: Record<AbsenceType, string> = {
    vacation: "#18a058",
    sick: "#d92d20",
    school: "#2563eb",
    free: "#7c3aed",
    other: "#64748b",
  };
  return colors[type];
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
