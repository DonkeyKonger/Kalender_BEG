import { CalendarDays, CalendarX, ChevronLeft, ChevronRight, PlusCircle, Save, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";

import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { AbsenceTypeBadge, StatusBadge, absenceTypeLabels } from "../components/StatusBadge";
import { useAuth } from "../auth/AuthContext";
import { canEditMainPage } from "../auth/permissions";
import { ApiError, api } from "../lib/api";
import type { Absence, AbsenceCreate, AbsenceStatus } from "../types/absence";
import type { AbsenceType } from "../types/matrix";
import { calendarPersonCode, type Person } from "../types/person";
import {
  formatDayHeader,
  formatDayNumber,
  getDefaultPlanningRange,
  getIsoWeekInfo,
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
type AbsenceSelectionRange = {
  personId: number;
  startDate: string;
  endDate: string;
};
type ActiveAbsenceSelection = AbsenceSelectionRange & {
  anchorKey: string;
  anchorRect: AbsencePopupAnchorRect;
  isSelecting: boolean;
};
type AbsenceSelectionPopup = AbsenceSelectionRange & {
  anchorKey: string;
  x: number;
  y: number;
};
type AbsencePopupAnchorRect = {
  bottom: number;
  left: number;
  top: number;
};
type AbsenceCell = {
  date: string;
  absences: Absence[];
};
type PersonAbsenceRow = {
  person: Person;
  cells: AbsenceCell[];
};
type AbsencePersonGroupKey = "project-managers" | "office" | "workers" | "external" | "other";
type PersonAbsenceGroup = {
  key: AbsencePersonGroupKey;
  label: string;
  rows: PersonAbsenceRow[];
};
type AbsenceWeekGroup = {
  isoYear: number;
  week: number;
  dayCount: number;
};
type AbsenceMonthGroup = {
  year: number;
  month: number;
  label: string;
  dayCount: number;
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
  const canEdit = canEditMainPage(user, "absences");
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
  const [activeSelection, setActiveSelection] = useState<ActiveAbsenceSelection | null>(null);
  const [selectionPopup, setSelectionPopup] = useState<AbsenceSelectionPopup | null>(null);
  const [isSavingSelection, setIsSavingSelection] = useState(false);
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

  const personGroups = useMemo(
    () => buildGroupedAbsenceRows(filteredPeople, absences, visibleDays),
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

  useEffect(() => {
    if (!activeSelection?.isSelecting) {
      return;
    }

    function handleMouseUp(): void {
      setActiveSelection((current) => {
        if (!current) {
          return null;
        }
        setSelectionPopup({
          anchorKey: current.anchorKey,
          personId: current.personId,
          startDate: current.startDate,
          endDate: current.endDate,
          ...boundedAbsencePopupPosition(current.anchorRect),
        });
        return { ...current, isSelecting: false };
      });
    }

    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [activeSelection?.isSelecting]);

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

  async function createAbsencesFromSelection(absenceType: AbsenceType) {
    if (!selectionPopup || isSavingSelection) {
      return;
    }
    const { startDate, endDate } = normalizedDateRange(selectionPopup.startDate, selectionPopup.endDate);
    const selectedDays = daysBetween(startDate, endDate);
    const openDays = selectedDays.filter((date) => !hasAbsenceForPersonDate(absences, selectionPopup.personId, date));
    const skippedCount = selectedDays.length - openDays.length;
    if (!openDays.length) {
      setError("Im markierten Bereich ist bereits ueberall eine Abwesenheit eingetragen.");
      setMessage(null);
      return;
    }

    setIsSavingSelection(true);
    setError(null);
    setMessage(null);
    try {
      const createdAbsences = await Promise.all(
        openDays.map((date) => api.createAbsence({
          person_id: selectionPopup.personId,
          absence_type: absenceType,
          start_date: date,
          end_date: date,
          status: "active",
          note: null,
        })),
      );
      setAbsences((current) => [...current, ...createdAbsences].sort(compareAbsences));
      setDrafts((current) => ({
        ...current,
        ...toEditableAbsences(createdAbsences),
      }));
      setActiveSelection(null);
      setSelectionPopup(null);
      setMessage(skippedCount > 0
        ? `Abwesenheiten angelegt. ${skippedCount} bereits belegte Tage wurden uebersprungen.`
        : "Abwesenheiten angelegt.");
    } catch (requestError) {
      setError(readApiError(requestError, "Abwesenheiten konnten nicht angelegt werden."));
    } finally {
      setIsSavingSelection(false);
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

  async function deleteAbsenceDay(absence: Absence, date: string) {
    if (!window.confirm(`${absenceTypeLabels[absence.absence_type]} am ${formatDate(date)} loeschen?`)) {
      return;
    }
    setSavingAbsenceId(absence.id);
    setError(null);
    setMessage(null);
    try {
      const { updated, created } = await removeAbsenceDate(absence, date);
      setAbsences((current) => {
        const withoutOriginal = current.filter((item) => item.id !== absence.id);
        return [...withoutOriginal, ...updated, ...created].sort(compareAbsences);
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[absence.id];
        for (const item of [...updated, ...created]) {
          next[item.id] = toEditableAbsence(item);
        }
        return next;
      });
      setMessage("Abwesenheit geloescht.");
    } catch (requestError) {
      setError(readApiError(requestError, "Abwesenheit konnte nicht geloescht werden."));
    } finally {
      setSavingAbsenceId(null);
    }
  }

  async function removeAbsenceDate(absence: Absence, date: string): Promise<{ updated: Absence[]; created: Absence[] }> {
    if (absence.start_date === absence.end_date) {
      await api.deleteAbsence(absence.id);
      return { updated: [], created: [] };
    }
    if (date === absence.start_date) {
      const updated = await api.updateAbsence(absence.id, { start_date: addDays(date, 1) });
      return { updated: [updated], created: [] };
    }
    if (date === absence.end_date) {
      const updated = await api.updateAbsence(absence.id, { end_date: addDays(date, -1) });
      return { updated: [updated], created: [] };
    }

    const originalEndDate = absence.end_date;
    const updated = await api.updateAbsence(absence.id, { end_date: addDays(date, -1) });
    const created = await api.createAbsence({
      person_id: absence.person_id,
      absence_type: absence.absence_type,
      start_date: addDays(date, 1),
      end_date: originalEndDate,
      status: absence.status,
      note: absence.note,
    });
    return { updated: [updated], created: [created] };
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
    setActiveSelection(null);
    setSelectionPopup(null);
    setCreateForm(emptyAbsence(personId, date));
    setDrawer({ mode: "new" });
  }

  function closeDrawer() {
    setDrawer(null);
  }

  function startSelection(personId: number, date: string, event: ReactMouseEvent<HTMLTableCellElement>) {
    if (!canEdit || event.button !== 0) {
      return;
    }
    event.preventDefault();
    const anchorKey = buildAbsenceCellKey(personId, date);
    if (selectionPopup?.anchorKey === anchorKey) {
      setActiveSelection(null);
      setSelectionPopup(null);
      return;
    }
    setDrawer(null);
    setError(null);
    setMessage(null);
    setSelectionPopup(null);
    setActiveSelection({
      anchorKey,
      anchorRect: toAbsencePopupAnchorRect(event.currentTarget.getBoundingClientRect()),
      personId,
      startDate: date,
      endDate: date,
      isSelecting: true,
    });
  }

  function extendSelection(personId: number, date: string) {
    setActiveSelection((current) => {
      if (!current?.isSelecting || current.personId !== personId) {
        return current;
      }
      return { ...current, endDate: date };
    });
  }

  const visibleSelection = selectionPopup ?? activeSelection;

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
          activeSelection={visibleSelection}
          canEdit={canEdit}
          days={visibleDays}
          mode={viewMode}
          personGroups={personGroups}
          scrollRef={matrixScrollRef}
          today={today}
          onDeleteAbsenceDay={(absence, date) => void deleteAbsenceDay(absence, date)}
          onExtendSelection={extendSelection}
          onOpenAbsence={(absenceId) => setDrawer({ mode: "edit", absenceId })}
          onStartSelection={startSelection}
        />
      )}

      {selectionPopup ? (
        <div
          className="absence-selection-popover"
          style={{ left: selectionPopup.x, top: selectionPopup.y }}
        >
          <strong>Abwesenheit eintragen</strong>
          <span>{formatAbsenceSelectionLabel(selectionPopup)}</span>
          <div>
            {Object.entries(absenceTypeLabels).map(([type, label]) => (
              <button
                className={`absence-selection-type absence-block-${type}`}
                disabled={isSavingSelection}
                key={type}
                type="button"
                onClick={() => void createAbsencesFromSelection(type as AbsenceType)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className="absence-selection-cancel"
            disabled={isSavingSelection}
            type="button"
            onClick={() => {
              setActiveSelection(null);
              setSelectionPopup(null);
            }}
          >
            Abbrechen
          </button>
        </div>
      ) : null}

      <EntityDetailDrawer
        isOpen={drawer?.mode === "new"}
        title="Neue Abwesenheit"
        subtitle="Krankheit, Urlaub, Schule, Überstunden oder Sonstiges eintragen"
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
  activeSelection,
  canEdit,
  days,
  mode,
  personGroups,
  scrollRef,
  today,
  onDeleteAbsenceDay,
  onExtendSelection,
  onOpenAbsence,
  onStartSelection,
}: {
  activeSelection: AbsenceSelectionRange | null;
  canEdit: boolean;
  days: string[];
  mode: AbsenceViewMode;
  personGroups: PersonAbsenceGroup[];
  scrollRef: RefObject<HTMLDivElement | null>;
  today: string;
  onDeleteAbsenceDay: (absence: Absence, date: string) => void;
  onExtendSelection: (personId: number, date: string) => void;
  onOpenAbsence: (absenceId: number) => void;
  onStartSelection: (personId: number, date: string, event: ReactMouseEvent<HTMLTableCellElement>) => void;
}) {
  const monthGroups = useMemo(() => buildAbsenceMonthGroups(days), [days]);
  const weekGroups = useMemo(() => buildAbsenceWeekGroups(days), [days]);
  const hasRows = personGroups.some((group) => group.rows.length > 0);
  const [highlightedPersonId, setHighlightedPersonId] = useState<number | null>(null);

  useEffect(() => {
    if (highlightedPersonId === null) {
      return;
    }

    function clearHighlightOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setHighlightedPersonId(null);
      }
    }

    window.addEventListener("keydown", clearHighlightOnEscape);
    return () => window.removeEventListener("keydown", clearHighlightOnEscape);
  }, [highlightedPersonId]);

  if (!hasRows) {
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
          <tr className="absence-month-row">
            <th className="absence-person-col absence-month-fixed" aria-hidden="true" />
            {monthGroups.map((group) => (
              <th
                className="absence-month-cell"
                colSpan={group.dayCount}
                key={`${group.year}-${group.month}`}
                scope="colgroup"
              >
                {group.label}
              </th>
            ))}
          </tr>
          <tr className="absence-week-row">
            <th className="absence-person-col absence-week-fixed" aria-hidden="true" />
            {weekGroups.map((group) => (
              <th
                className="absence-week-cell"
                colSpan={group.dayCount}
                key={`${group.isoYear}-${group.week}`}
                scope="colgroup"
              >
                KW {group.week}
              </th>
            ))}
          </tr>
          <tr className="absence-day-row">
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
          {personGroups.map((group) => (
            <Fragment key={group.key}>
              <tr className="absence-person-group-row">
                <th className="absence-person-col absence-person-group-heading" scope="rowgroup">
                  <span>{group.label}</span>
                  <small>{group.rows.length}</small>
                </th>
                <td className="absence-person-group-fill" colSpan={days.length} />
              </tr>
              {group.rows.map((row) => {
                const isPersonHighlighted = highlightedPersonId === row.person.id;
                return (
                  <tr
                    aria-selected={isPersonHighlighted}
                    className={`absence-person-row${isPersonHighlighted ? " is-highlighted" : ""}`}
                    key={row.person.id}
                  >
                    <th className="absence-person-col" scope="row">
                      <button
                        aria-label={`${row.person.display_name}: ${isPersonHighlighted ? "Zeilenmarkierung aufheben" : "Zeile hervorheben"}`}
                        aria-pressed={isPersonHighlighted}
                        className="absence-person-highlight-trigger"
                        type="button"
                        onClick={() => setHighlightedPersonId((current) => current === row.person.id ? null : row.person.id)}
                      >
                        <span>{row.person.display_name}</span>
                      </button>
                    </th>
                    {row.cells.map((cell) => (
                      <td
                        className={absenceCellClassName(
                          cell.date,
                          today,
                          Boolean(
                            activeSelection
                            && activeSelection.personId === row.person.id
                            && isDateWithinAbsenceSelection(cell.date, activeSelection),
                          ),
                        )}
                        key={`${row.person.id}-${cell.date}`}
                        onMouseDown={(event) => {
                          if (canEdit && !cell.absences.length) {
                            onStartSelection(row.person.id, cell.date, event);
                          }
                        }}
                        onMouseEnter={() => {
                          if (canEdit) {
                            onExtendSelection(row.person.id, cell.date);
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
                              onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (canEdit) {
                                  onDeleteAbsenceDay(absence, cell.date);
                                }
                              }}
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
                );
              })}
            </Fragment>
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
const absencePersonGroupOrder: { key: AbsencePersonGroupKey; label: string }[] = [
  { key: "project-managers", label: "Projektleiter" },
  { key: "office", label: "Büro" },
  { key: "workers", label: "Monteure" },
  { key: "external", label: "Externe / Gastnutzer" },
  { key: "other", label: "Sonstige / Unklare Zuordnung" },
];

function buildGroupedAbsenceRows(people: Person[], absences: Absence[], days: string[]): PersonAbsenceGroup[] {
  const groupedPeople = new Map<AbsencePersonGroupKey, Person[]>(
    absencePersonGroupOrder.map((group) => [group.key, []]),
  );
  people.forEach((person) => {
    groupedPeople.get(getAbsencePersonGroupKey(person))?.push(person);
  });

  return absencePersonGroupOrder
    .map((group) => ({
      ...group,
      rows: buildAbsenceRows((groupedPeople.get(group.key) ?? []).sort(comparePeople), absences, days),
    }))
    .filter((group) => group.rows.length > 0);
}

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

function getAbsencePersonGroupKey(person: Person): AbsencePersonGroupKey {
  switch (person.person_type) {
    case "external":
    case "external_temp":
      return "external";
    case "internal":
      if (isAbsenceProjectManagerPerson(person)) {
        return "project-managers";
      }
      if (isAbsenceOfficePerson(person)) {
        return "office";
      }
      return "workers";
    default:
      return "other";
  }
}

function isAbsenceProjectManagerPerson(person: Person): boolean {
  return person.user_roles?.includes("project_manager") ?? false;
}

function isAbsenceOfficePerson(person: Person): boolean {
  if (isAbsenceProjectManagerPerson(person)) {
    return false;
  }
  const roles = person.user_roles ?? [];
  return roles.includes("office") || roles.includes("admin");
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

function addDays(value: string, offset: number): string {
  const date = parseLocalDate(value);
  date.setDate(date.getDate() + offset);
  return toDateInputValue(date);
}

function normalizedDateRange(firstDate: string, secondDate: string): { startDate: string; endDate: string } {
  return firstDate <= secondDate
    ? { startDate: firstDate, endDate: secondDate }
    : { startDate: secondDate, endDate: firstDate };
}

function isDateWithinAbsenceSelection(date: string, selection: AbsenceSelectionRange): boolean {
  const { startDate, endDate } = normalizedDateRange(selection.startDate, selection.endDate);
  return date >= startDate && date <= endDate;
}

function hasAbsenceForPersonDate(absences: Absence[], personId: number, date: string): boolean {
  return absences.some((absence) =>
    absence.person_id === personId
    && absence.start_date <= date
    && absence.end_date >= date,
  );
}

function buildAbsenceCellKey(personId: number, date: string): string {
  return `${personId}|${date}`;
}

function toAbsencePopupAnchorRect(rect: DOMRect): AbsencePopupAnchorRect {
  return {
    bottom: rect.bottom,
    left: rect.left,
    top: rect.top,
  };
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
    calendarPersonCode(person),
    person.person_type,
    ...(person.user_roles ?? []),
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
    free: "Ü",
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

function buildAbsenceWeekGroups(days: string[]): AbsenceWeekGroup[] {
  return days.reduce<AbsenceWeekGroup[]>((groups, day) => {
    const isoWeek = getIsoWeekInfo(day);
    const currentGroup = groups[groups.length - 1];
    if (currentGroup && currentGroup.isoYear === isoWeek.isoYear && currentGroup.week === isoWeek.week) {
      currentGroup.dayCount += 1;
      return groups;
    }
    groups.push({ isoYear: isoWeek.isoYear, week: isoWeek.week, dayCount: 1 });
    return groups;
  }, []);
}

function buildAbsenceMonthGroups(days: string[]): AbsenceMonthGroup[] {
  return days.reduce<AbsenceMonthGroup[]>((groups, day) => {
    const date = parseLocalDate(day);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const currentGroup = groups[groups.length - 1];
    if (currentGroup && currentGroup.year === year && currentGroup.month === month) {
      currentGroup.dayCount += 1;
      return groups;
    }
    groups.push({ year, month, label: formatAbsenceMonthLabel(date), dayCount: 1 });
    return groups;
  }, []);
}

function formatAbsenceMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat("de-DE", { month: "long" }).format(date);
}

function absenceDayClassName(date: string, today: string): string {
  return ["absence-day-col", isWeekendDate(date) ? "weekend" : "", date === today ? "today" : ""].filter(Boolean).join(" ");
}

function absenceCellClassName(date: string, today: string, isSelected = false): string {
  return [
    "absence-day-cell",
    isWeekendDate(date) ? "weekend" : "",
    date === today ? "today" : "",
    isSelected ? "is-selected" : "",
  ].filter(Boolean).join(" ");
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

function formatAbsenceSelectionLabel(selection: AbsenceSelectionRange): string {
  const { startDate, endDate } = normalizedDateRange(selection.startDate, selection.endDate);
  if (startDate === endDate) {
    return formatDate(startDate);
  }
  return `${formatDate(startDate)} - ${formatDate(endDate)}`;
}

function boundedAbsencePopupPosition(rect: AbsencePopupAnchorRect): { x: number; y: number } {
  const popoverWidth = 240;
  const popoverHeight = 238;
  const spacing = 12;
  const gap = 6;
  if (typeof window === "undefined") {
    return { x: rect.left, y: rect.bottom + gap };
  }
  const maxLeft = Math.max(spacing, window.innerWidth - popoverWidth - spacing);
  const maxTop = Math.max(spacing, window.innerHeight - popoverHeight - spacing);
  const preferredTop = rect.bottom + gap;
  const fallbackTop = rect.top - popoverHeight - gap;
  const top = preferredTop + popoverHeight > window.innerHeight - spacing ? fallbackTop : preferredTop;
  return {
    x: Math.min(Math.max(rect.left, spacing), maxLeft),
    y: Math.min(Math.max(top, spacing), maxTop),
  };
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
