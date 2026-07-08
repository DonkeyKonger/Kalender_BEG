import {
  ArrowLeft,
  CalendarDays,
  Car,
  ChartColumn,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Pencil,
  Save,
  Search,
  StickyNote,
  Trash2,
  UserPlus,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { EntityCard } from "../components/EntityCard";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { StatusBadge, absenceTypeLabels } from "../components/StatusBadge";
import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import type { Absence } from "../types/absence";
import type { AbsenceType } from "../types/matrix";
import type { Person, PersonCreate, PersonEmploymentStatus, PersonGeocodeSearchResult, PersonHoursAccount, PersonHoursAccountEntry, PersonLocationStatus, PersonType } from "../types/person";
import { calendarPersonCode, getEmployeeShortName } from "../types/person";

const personTypeLabels: Record<PersonType, string> = {
  internal: "Intern",
  external: "Extern",
  external_temp: "Extern schnell",
};

const personEmploymentStatusLabels: Record<PersonEmploymentStatus, string> = {
  active: "Aktiv",
  paused: "Pausiert",
  departed: "Ausgeschieden",
};

type EditablePerson = PersonCreate & { id: number };
type DrawerState = { mode: "new" } | { mode: "edit"; personId: number } | null;
type PersonScope = "internal" | "external";
type PeopleOverviewGroup = { key: string; label: string; people: Person[]; collapsible?: boolean };
type PersonDetailActionKey = "absence" | "timeAccount" | "equipment" | "vehicle" | "performance";

const personDetailActions: Array<{
  key: PersonDetailActionKey;
  label: string;
  title: string;
  description: string;
  preview: string;
  icon: LucideIcon;
}> = [
  {
    key: "absence",
    label: "Urlaub / Krankheit",
    title: "Urlaub / Krankheit",
    description: "Gesamturlaubstage und Krankheitstage pro Person werden hier vorbereitet.",
    preview: "Urlaubs- und Krankheitstage werden vorbereitet.",
    icon: CalendarDays,
  },
  {
    key: "timeAccount",
    label: "Stundenkonto",
    title: "Stundenkonto",
    description: "Stundenkonto und Überstunden werden nachvollziehbar geführt.",
    preview: "Stundenkonto und Überstunden.",
    icon: Clock,
  },
  {
    key: "equipment",
    label: "Werkzeug / Material",
    title: "Werkzeug / Material",
    description: "Ausgegebenes Werkzeug und Material je Person werden hier vorbereitet.",
    preview: "Ausgegebenes Werkzeug und Material.",
    icon: Wrench,
  },
  {
    key: "vehicle",
    label: "Fahrzeug",
    title: "Fahrzeug",
    description: "Zugewiesene Fahrzeuge je Person werden hier vorbereitet.",
    preview: "Fahrzeugzuordnung wird vorbereitet.",
    icon: Car,
  },
  {
    key: "performance",
    label: "Performance",
    title: "Monteurperformance",
    description: "Leistungs- und Auswertungsdaten je Monteur werden hier vorbereitet.",
    preview: "Auswertung wird vorbereitet.",
    icon: ChartColumn,
  },
];

const emptyPerson: PersonCreate = {
  first_name: "",
  last_name: "",
  display_name: "",
  short_code: "",
  person_type: "internal",
  is_active: true,
  employment_status: "active",
  can_sign_measurements_immediately: false,
  annual_vacation_days: null,
  weekly_hours: null,
  email: null,
  phone: null,
  address_postal_code: null,
  address_city: null,
  address_street: null,
  address_house_number: null,
  address_extra: null,
  address_formatted: null,
  address_latitude: null,
  address_longitude: null,
  address_location_status: "unchecked",
  notes: null,
};

export function PersonsPage() {
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "project_manager";
  const canManageHoursAccount = user?.role === "admin" || user?.role === "project_manager" || user?.role === "office";
  const canManageVacationCarryover = user?.role === "admin" || user?.role === "project_manager" || user?.role === "office";
  const canRemove = canEdit;
  const [people, setPeople] = useState<Person[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditablePerson>>({});
  const [createForm, setCreateForm] = useState<PersonCreate>(emptyPerson);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [isEditingPerson, setIsEditingPerson] = useState(false);
  const [activePersonAction, setActivePersonAction] = useState<PersonDetailActionKey | null>(null);
  const [personScope, setPersonScope] = useState<PersonScope>("internal");
  const [collapsedPersonGroupKeys, setCollapsedPersonGroupKeys] = useState<Set<string>>(() => new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [savingPersonId, setSavingPersonId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadPeople();
  }, []);

  async function loadPeople() {
    setIsLoading(true);
    setError(null);
    try {
      const personData = await api.persons({ isActive: null });
      setPeople(personData);
      setDrafts(toEditablePeople(personData));
    } catch (requestError) {
      setError(readApiError(requestError, "Mitarbeiter konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }

  const filteredPeople = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    return people
      .filter((person) => personInScope(person, personScope))
      .filter((person) => !needle || personSearchText(person).includes(needle));
  }, [people, personScope, searchTerm]);
  const personGroups = useMemo(() => groupPeopleForOverview(filteredPeople, personScope), [filteredPeople, personScope]);
  const internalPeopleCount = useMemo(
    () => people.filter((person) => personInScope(person, "internal")).length,
    [people],
  );
  const externalPeopleCount = useMemo(
    () => people.filter((person) => personInScope(person, "external")).length,
    [people],
  );

  const selectedPerson = drawer?.mode === "edit"
    ? people.find((person) => person.id === drawer.personId) ?? null
    : null;
  const selectedDraft = drawer?.mode === "edit" && selectedPerson
    ? drafts[selectedPerson.id] ?? toEditablePerson(selectedPerson)
    : null;
  const isExternalScope = personScope === "external";
  const createButtonLabel = isExternalScope ? "Externe Person anlegen" : "Neuer Mitarbeiter";
  const createDrawerTitle = createForm.person_type === "internal" ? "Neuer Mitarbeiter" : "Externe Person anlegen";
  const createDrawerSubtitle = createForm.person_type === "internal" ? "Stammdaten anlegen" : "Leiharbeiter / externe Person anlegen";

  async function createPerson() {
    const validationError = validatePersonPayload(createForm);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSavingPersonId(0);
    setError(null);
    try {
      const payload = normalizePersonPayload(createForm);
      const created = await api.createPerson(payload);
      setPeople((current) => [...current, created].sort(comparePeople));
      setDrafts((current) => ({ ...current, [created.id]: toEditablePerson(created) }));
      setCreateForm(emptyPerson);
      setDrawer(null);
    } catch (requestError) {
      setError(readApiError(requestError, "Person konnte nicht angelegt werden."));
    } finally {
      setSavingPersonId(null);
    }
  }

  async function savePerson(personId: number): Promise<boolean> {
    const draft = drafts[personId];
    if (!draft) {
      return false;
    }
    const validationError = validatePersonPayload(draft);
    if (validationError) {
      setError(validationError);
      return false;
    }
    setSavingPersonId(personId);
    setError(null);
    try {
      const updated = await api.updatePerson(personId, normalizePersonPayload(draft));
      setPeople((current) =>
        current.map((person) => person.id === updated.id ? updated : person).sort(comparePeople),
      );
      setDrafts((current) => ({ ...current, [updated.id]: toEditablePerson(updated) }));
      return true;
    } catch (requestError) {
      setError(readApiError(requestError, "Person konnte nicht gespeichert werden."));
      return false;
    } finally {
      setSavingPersonId(null);
    }
  }

  async function deletePerson(person: Person) {
    const confirmed = window.confirm(
      "Mitarbeiter wirklich ausblenden? Historische Daten bleiben erhalten.",
    );
    if (!confirmed) {
      return;
    }

    const personId = person.id;
    setSavingPersonId(personId);
    setError(null);
    try {
      await api.deletePerson(personId);
      setPeople((current) => current.filter((person) => person.id !== personId));
      setDrafts((current) => {
        const next = { ...current };
        delete next[personId];
        return next;
      });
      setDrawer(null);
      setIsEditingPerson(false);
    } catch (requestError) {
      setError(readApiError(requestError, "Mitarbeiter konnte nicht ausgeblendet werden."));
    } finally {
      setSavingPersonId(null);
    }
  }

  async function applyGeocodedPerson(personId: number, values: Partial<PersonCreate>) {
    const draft = drafts[personId];
    if (!draft) {
      return;
    }
    const nextDraft = { ...draft, ...values };
    setSavingPersonId(personId);
    setError(null);
    updateDraft(personId, values as Partial<EditablePerson>);
    try {
      const updated = await api.updatePerson(personId, normalizePersonPayload(nextDraft));
      setPeople((current) =>
        current.map((person) => person.id === updated.id ? updated : person).sort(comparePeople),
      );
      setDrafts((current) => ({ ...current, [updated.id]: toEditablePerson(updated) }));
    } catch (requestError) {
      setError(readApiError(requestError, "Startort konnte nicht gespeichert werden."));
    } finally {
      setSavingPersonId(null);
    }
  }

  async function updatePersonSignaturePermission(person: Person, canSignImmediately: boolean): Promise<boolean> {
    if (person.can_sign_measurements_immediately === canSignImmediately) {
      return true;
    }
    const nextDraft = {
      ...toEditablePerson(person),
      can_sign_measurements_immediately: canSignImmediately,
    };
    setSavingPersonId(person.id);
    setError(null);
    try {
      const updated = await api.updatePerson(person.id, normalizePersonPayload(nextDraft));
      setPeople((current) =>
        current.map((currentPerson) => currentPerson.id === updated.id ? updated : currentPerson).sort(comparePeople),
      );
      setDrafts((current) => ({ ...current, [updated.id]: toEditablePerson(updated) }));
      return true;
    } catch (requestError) {
      setError(readApiError(requestError, "Kundenunterschrift konnte nicht gespeichert werden."));
      return false;
    } finally {
      setSavingPersonId(null);
    }
  }

  async function updatePersonEmploymentStatus(person: Person, employmentStatus: PersonEmploymentStatus): Promise<boolean> {
    if (personEmploymentStatus(person) === employmentStatus) {
      return true;
    }
    const nextDraft = {
      ...toEditablePerson(person),
      employment_status: employmentStatus,
      is_active: employmentStatus === "active",
    };
    setSavingPersonId(person.id);
    setError(null);
    try {
      const updated = await api.updatePerson(person.id, normalizePersonPayload(nextDraft));
      setPeople((current) =>
        current.map((currentPerson) => currentPerson.id === updated.id ? updated : currentPerson).sort(comparePeople),
      );
      setDrafts((current) => ({ ...current, [updated.id]: toEditablePerson(updated) }));
      return true;
    } catch (requestError) {
      setError(readApiError(requestError, "Status konnte nicht gespeichert werden."));
      return false;
    } finally {
      setSavingPersonId(null);
    }
  }

  async function updatePersonInformation(person: Person, values: Partial<PersonCreate>): Promise<boolean> {
    const nextDraft = {
      ...toEditablePerson(person),
      ...values,
    };
    const validationError = validatePersonPayload(nextDraft);
    if (validationError) {
      setError(validationError);
      return false;
    }
    setSavingPersonId(person.id);
    setError(null);
    try {
      const updated = await api.updatePerson(person.id, normalizePersonPayload(nextDraft));
      setPeople((current) =>
        current.map((currentPerson) => currentPerson.id === updated.id ? updated : currentPerson).sort(comparePeople),
      );
      setDrafts((current) => ({ ...current, [updated.id]: toEditablePerson(updated) }));
      return true;
    } catch (requestError) {
      setError(readApiError(requestError, "Mitarbeiterdaten konnten nicht gespeichert werden."));
      return false;
    } finally {
      setSavingPersonId(null);
    }
  }

  async function updatePersonNotes(person: Person, notes: string | null): Promise<boolean> {
    const currentNotes = person.notes?.trim() || null;
    const nextNotes = notes?.trim() || null;
    if (currentNotes === nextNotes) {
      return true;
    }
    const nextDraft = {
      ...toEditablePerson(person),
      notes: nextNotes,
    };
    setSavingPersonId(person.id);
    setError(null);
    try {
      const updated = await api.updatePerson(person.id, normalizePersonPayload(nextDraft));
      setPeople((current) =>
        current.map((currentPerson) => currentPerson.id === updated.id ? updated : currentPerson).sort(comparePeople),
      );
      setDrafts((current) => ({ ...current, [updated.id]: toEditablePerson(updated) }));
      return true;
    } catch (requestError) {
      setError(readApiError(requestError, "Info konnte nicht gespeichert werden."));
      return false;
    } finally {
      setSavingPersonId(null);
    }
  }

  function updateDraft(personId: number, values: Partial<EditablePerson>) {
    setDrafts((current) => ({
      ...current,
      [personId]: { ...current[personId], ...values },
    }));
  }

  function openNewPersonDrawer() {
    setCreateForm({
      ...emptyPerson,
      person_type: personScopeToCreateType(personScope),
    });
    setIsEditingPerson(false);
    setActivePersonAction(null);
    setDrawer({ mode: "new" });
  }

  function openPersonDrawer(personId: number) {
    setIsEditingPerson(false);
    setActivePersonAction(null);
    setDrawer({ mode: "edit", personId });
  }

  function cancelPersonEdit() {
    if (selectedPerson) {
      setDrafts((current) => ({ ...current, [selectedPerson.id]: toEditablePerson(selectedPerson) }));
    }
    setIsEditingPerson(false);
    setError(null);
  }

  function closeDrawer() {
    if (drawer?.mode === "edit" && selectedPerson) {
      setDrafts((current) => ({ ...current, [selectedPerson.id]: toEditablePerson(selectedPerson) }));
    }
    if (drawer?.mode === "new") {
      setCreateForm(emptyPerson);
    }
    setIsEditingPerson(false);
    setActivePersonAction(null);
    setDrawer(null);
  }

  function togglePersonGroup(groupKey: string) {
    setCollapsedPersonGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }

  return (
    <section className="persons-page overview-page">
      <div className="page-header entity-page-header overview-header">
        <div>
          <p className="eyebrow">Stammdaten</p>
          <h1>Mitarbeiter</h1>
        </div>
        {canEdit && (
          <button
            className={`icon-button overview-create ${isExternalScope ? "is-external-create" : ""}`}
            type="button"
            onClick={openNewPersonDrawer}
          >
            <UserPlus aria-hidden="true" size={17} />
            <span>{createButtonLabel}</span>
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="overview-toolbar">
        <div className="overview-toolbar-left">
          <label className="overview-search">
            <Search aria-hidden="true" size={17} />
            <input
              placeholder="Mitarbeiter suchen"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>
        </div>
        <div className="overview-toolbar-right">
          <div className="person-scope-tabs overview-filter-tabs" role="tablist" aria-label="Mitarbeiterbereich">
            <button
              className={personScope === "internal" ? "is-active" : ""}
              role="tab"
              type="button"
              aria-selected={personScope === "internal"}
              onClick={() => setPersonScope("internal")}
            >
              Eigenes Personal
              <span>{internalPeopleCount}</span>
            </button>
            <button
              className={personScope === "external" ? "is-active" : ""}
              role="tab"
              type="button"
              aria-selected={personScope === "external"}
              onClick={() => setPersonScope("external")}
            >
              Externe / Leiharbeiter
              <span>{externalPeopleCount}</span>
            </button>
          </div>
        </div>
      </div>

      {isLoading && <div className="matrix-state">Mitarbeiter werden geladen...</div>}

      {!isLoading && (
        <>
          {personGroups.length ? (
            <div className="overview-group-list">
              {personGroups.map((group) => {
                const groupId = `person-overview-group-${group.key}`;
                const isCollapsed = Boolean(group.collapsible && collapsedPersonGroupKeys.has(group.key));
                return (
                  <section className={`overview-group-section ${isCollapsed ? "is-collapsed" : ""}`} key={group.key}>
                    {group.collapsible ? (
                      <button
                        className="overview-group-header overview-group-toggle"
                        type="button"
                        aria-expanded={!isCollapsed}
                        aria-controls={groupId}
                        onClick={() => togglePersonGroup(group.key)}
                      >
                        <h2>
                          <ChevronDown aria-hidden="true" size={16} />
                          <span>{group.label}</span>
                        </h2>
                        <span className="overview-group-count">{group.people.length}</span>
                      </button>
                    ) : (
                      <div className="overview-group-header">
                        <h2>
                          <ChevronDown aria-hidden="true" size={16} />
                          <span>{group.label}</span>
                        </h2>
                        <span className="overview-group-count">{group.people.length}</span>
                      </div>
                    )}
                    {!isCollapsed && (
                      <div className="entity-card-list overview-card-grid" id={groupId}>
                        {group.people.map((person) => (
                          <EntityCard
                            key={person.id}
                            className={`overview-card person-overview-card ${person.person_type !== "internal" ? "is-external-person" : ""}`}
                            color={personCardColor(person)}
                            title={person.display_name || `${person.first_name} ${person.last_name}`.trim()}
                            subtitle={personTypeLabels[person.person_type]}
                            meta={personCardMeta(person)}
                            icon={<Users aria-hidden="true" size={17} />}
                            status={<StatusBadge tone={personStatusBadgeTone(personEmploymentStatus(person))}>{personEmploymentStatusLabels[personEmploymentStatus(person)]}</StatusBadge>}
                            isInactive={!person.is_active}
                            onClick={() => openPersonDrawer(person.id)}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="empty-panel">
              <p>{people.length ? "Keine Treffer gefunden." : "Noch keine Mitarbeiter vorhanden."}</p>
            </div>
          )}
        </>
      )}

      <EntityDetailDrawer
        isOpen={drawer?.mode === "new"}
        title={createDrawerTitle}
        subtitle={createDrawerSubtitle}
        onClose={closeDrawer}
        footer={(
          <button
            className={`icon-button person-create-submit-button ${createForm.person_type !== "internal" ? "is-external-create" : ""}`}
            disabled={savingPersonId === 0}
            type="button"
            onClick={() => void createPerson()}
          >
            <UserPlus aria-hidden="true" size={17} />
            <span>{createForm.person_type === "internal" ? "Mitarbeiter anlegen" : "Externe Person anlegen"}</span>
          </button>
        )}
      >
        <PersonFields
          draft={createForm}
          isCreateForm
          onChange={(values) => setCreateForm((current) => ({ ...current, ...values }))}
        />
      </EntityDetailDrawer>

      <EntityDetailDrawer
        isOpen={drawer?.mode === "edit" && Boolean(selectedPerson && selectedDraft)}
        title={selectedPerson ? isEditingPerson ? "Mitarbeiter bearbeiten" : "Mitarbeiter" : "Mitarbeiter"}
        onClose={closeDrawer}
        footer={selectedPerson && isEditingPerson && canEdit ? (
          <div className="person-drawer-footer-actions">
            <div className="person-drawer-footer-left">
              {canRemove && (
                <button
                  className="icon-button danger"
                  disabled={savingPersonId === selectedPerson.id}
                  type="button"
                  onClick={() => void deletePerson(selectedPerson)}
                >
                  <Trash2 aria-hidden="true" size={16} />
                  <span>{savingPersonId === selectedPerson.id ? "Löscht..." : "Löschen"}</span>
                </button>
              )}
            </div>
            <div className="person-drawer-footer-right">
              <button className="icon-button secondary" disabled={savingPersonId === selectedPerson.id} type="button" onClick={cancelPersonEdit}>
                <span>Abbrechen</span>
              </button>
              <button
                className="icon-button secondary"
                disabled={savingPersonId === selectedPerson.id}
                type="button"
                onClick={() => {
                  void savePerson(selectedPerson.id).then((saved) => {
                    if (saved) {
                      setIsEditingPerson(false);
                    }
                  });
                }}
              >
                <Save aria-hidden="true" size={16} />
                <span>Speichern</span>
              </button>
            </div>
          </div>
        ) : undefined}
      >
        {selectedPerson && selectedDraft && (
          isEditingPerson ? (
            <PersonFields
              draft={selectedDraft}
              onChange={(values) => updateDraft(selectedPerson.id, values)}
              onGeocodeSelected={(values) => void applyGeocodedPerson(selectedPerson.id, values)}
            />
          ) : (
            <PersonReadView
              person={selectedPerson}
              activeAction={activePersonAction}
              canEdit={canEdit}
              canManageHoursAccount={canManageHoursAccount}
              canManageVacationCarryover={canManageVacationCarryover}
              isSaving={savingPersonId === selectedPerson.id}
              onActionChange={setActivePersonAction}
              onInformationSave={(values) => updatePersonInformation(selectedPerson, values)}
              onNotesSave={(notes) => updatePersonNotes(selectedPerson, notes)}
              onStatusChange={(status) => updatePersonEmploymentStatus(selectedPerson, status)}
              onSignaturePermissionChange={(value) => updatePersonSignaturePermission(selectedPerson, value)}
            />
          )
        )}
      </EntityDetailDrawer>
    </section>
  );
}

function PersonReadView({
  person,
  activeAction,
  canEdit,
  canManageHoursAccount,
  canManageVacationCarryover,
  isSaving,
  onActionChange,
  onInformationSave,
  onNotesSave,
  onStatusChange,
  onSignaturePermissionChange,
}: {
  person: Person;
  activeAction: PersonDetailActionKey | null;
  canEdit: boolean;
  canManageHoursAccount: boolean;
  canManageVacationCarryover: boolean;
  isSaving: boolean;
  onActionChange: (action: PersonDetailActionKey | null) => void;
  onInformationSave: (values: Partial<PersonCreate>) => Promise<boolean>;
  onNotesSave: (notes: string | null) => Promise<boolean>;
  onStatusChange: (employmentStatus: PersonEmploymentStatus) => Promise<boolean>;
  onSignaturePermissionChange: (canSignImmediately: boolean) => Promise<boolean>;
}) {
  const addressText = formatPersonAddress(person);
  const action = activeAction ? personDetailActions.find((entry) => entry.key === activeAction) ?? null : null;
  const [isEditingAddress, setIsEditingAddress] = useState(false);

  useEffect(() => {
    setIsEditingAddress(false);
  }, [person.id]);

  return (
    <div className="detail-read-view person-detail-view">
      <div className="person-detail-main" aria-hidden={action ? true : undefined}>
        <section className="detail-read-section person-detail-info-section">
          <div className="person-detail-info-grid">
            <PersonDetailField label="Name">
              <PersonInlineEditableField
                ariaLabel="Name bearbeiten"
                canEdit={canEdit}
                displayValue={person.display_name || `${person.first_name} ${person.last_name}`.trim() || "-"}
                isSaving={isSaving}
                required
                value={person.display_name || `${person.first_name} ${person.last_name}`.trim()}
                onSave={(value) => onInformationSave(personNameUpdateValues(person, value))}
              />
            </PersonDetailField>
            <PersonDetailField label="Telefon">
              <PersonInlineEditableField
                ariaLabel="Telefon bearbeiten"
                canEdit={canEdit}
                displayValue={person.phone || "-"}
                isSaving={isSaving}
                value={person.phone ?? ""}
                onSave={(value) => onInformationSave({ phone: value.trim() || null })}
              />
            </PersonDetailField>
            <PersonDetailField label="E-Mail">
              <PersonInlineEditableField
                ariaLabel="E-Mail bearbeiten"
                canEdit={canEdit}
                displayValue={person.email || "-"}
                inputMode="email"
                isSaving={isSaving}
                value={person.email ?? ""}
                onSave={(value) => onInformationSave({ email: value.trim() || null })}
              />
            </PersonDetailField>
            <PersonDetailField label="Status">
              <PersonEmploymentStatusSelect
                canEdit={canEdit}
                disabled={isSaving}
                value={personEmploymentStatus(person)}
                onChange={onStatusChange}
              />
            </PersonDetailField>
            <PersonDetailField label="Jahresurlaub">
              <PersonInlineEditableField
                ariaLabel="Jahresurlaub bearbeiten"
                canEdit={canEdit}
                displayValue={formatAnnualVacationDays(person.annual_vacation_days)}
                inputMode="numeric"
                isSaving={isSaving}
                max={365}
                min={0}
                step={1}
                type="number"
                value={person.annual_vacation_days?.toString() ?? ""}
                onSave={(value) => onInformationSave({ annual_vacation_days: parseOptionalInteger(value) })}
              />
            </PersonDetailField>
            <PersonDetailField label="Wochenstunden">
              <PersonInlineEditableField
                ariaLabel="Wochenstunden bearbeiten"
                canEdit={canEdit}
                displayValue={formatWeeklyHours(person.weekly_hours)}
                inputMode="decimal"
                isSaving={isSaving}
                max={80}
                min={0}
                step="0.25"
                value={person.weekly_hours?.toString() ?? ""}
                onSave={(value) => onInformationSave({ weekly_hours: parseOptionalDecimal(value) })}
              />
            </PersonDetailField>
            <PersonDetailField className="is-wide person-detail-signature-field" label="Kundenunterschrift">
              <PersonSignaturePermissionSelect
                canEdit={canEdit}
                disabled={isSaving}
                value={person.can_sign_measurements_immediately}
                onChange={onSignaturePermissionChange}
              />
            </PersonDetailField>
          </div>
        </section>

        <section className="detail-read-section customer-detail-address-section person-detail-address-section">
          <div className="customer-detail-section-heading person-detail-address-heading">
            <h3>Adresse</h3>
            {canEdit && !isEditingAddress ? (
              <button
                aria-label="Adresse bearbeiten"
                className="person-inline-edit-button person-detail-address-edit-button"
                disabled={isSaving}
                type="button"
                onClick={() => setIsEditingAddress(true)}
              >
                <Pencil aria-hidden="true" size={12} />
              </button>
            ) : null}
          </div>
          {isEditingAddress ? (
            <div className="person-detail-address-editor">
              {addressText ? (
                <div className="person-detail-address-current">
                  <span>Aktuelle Adresse</span>
                  <strong>{addressText}</strong>
                </div>
              ) : null}
              <PersonAddressSearchField
                disabled={isSaving}
                onSelect={async (values) => {
                  const saved = await onInformationSave(values);
                  if (saved) {
                    setIsEditingAddress(false);
                  }
                  return saved;
                }}
              />
              <div className="person-detail-address-editor-actions">
                <button disabled={isSaving} type="button" onClick={() => setIsEditingAddress(false)}>
                  Abbrechen
                </button>
              </div>
            </div>
          ) : (
            <div className={`customer-address-panel ${addressText ? "has-address" : "is-empty"}`}>
              <div className="customer-address-status">
                <CheckCircle2 aria-hidden="true" size={16} />
                <span>{addressText ? "Adresse hinterlegt" : "Keine Adresse hinterlegt"}</span>
              </div>
              {addressText ? (
                <div className="customer-address-lines">
                  <MapPin aria-hidden="true" size={18} />
                  <div>
                    <strong>{addressText}</strong>
                  </div>
                </div>
              ) : (
                <p className="detail-empty">Noch keine Adresse hinterlegt.</p>
              )}
            </div>
          )}
        </section>

        <section className="detail-read-section person-detail-notes-section">
          <div className="customer-detail-section-heading">
            <StickyNote aria-hidden="true" size={17} />
            <h3>Info</h3>
          </div>
          <PersonNotesEditor
            canEdit={canEdit}
            disabled={isSaving}
            personId={person.id}
            value={person.notes}
            onSave={onNotesSave}
          />
        </section>

        <section className="detail-read-section customer-detail-nav-section person-detail-nav-section">
          {personDetailActions.map((detailAction) => (
            <PersonDetailNavItem
              action={detailAction}
              key={detailAction.key}
              onOpen={() => onActionChange(detailAction.key)}
            />
          ))}
        </section>
      </div>

      {action ? (
        <PersonDetailSubpage title={action.title} onBack={() => onActionChange(null)}>
          {action.key === "absence" ? (
            <PersonAbsenceOverviewPanel canManageCarryover={canManageVacationCarryover} person={person} />
          ) : action.key === "timeAccount" ? (
            <PersonHoursAccountPanel canManage={canManageHoursAccount} person={person} />
          ) : (
            <PersonDetailPlaceholderPanel action={action} person={person} />
          )}
        </PersonDetailSubpage>
      ) : null}
    </div>
  );
}

function PersonNotesEditor({
  canEdit,
  disabled,
  personId,
  value,
  onSave,
}: {
  canEdit: boolean;
  disabled: boolean;
  personId: number;
  value: string | null | undefined;
  onSave: (notes: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setDraft(value ?? "");
    setSaveState("idle");
  }, [personId, value]);

  async function saveIfChanged() {
    if (!canEdit || disabled || saveState === "saving") {
      return;
    }
    const currentNotes = value?.trim() || null;
    const nextNotes = draft.trim() || null;
    if (currentNotes === nextNotes) {
      setSaveState("idle");
      return;
    }
    setSaveState("saving");
    const saved = await onSave(nextNotes);
    setSaveState(saved ? "saved" : "error");
  }

  const statusText = saveState === "dirty"
    ? "Wird beim Verlassen gespeichert"
    : saveState === "saving"
      ? "Speichert..."
      : saveState === "saved"
        ? "Gespeichert"
        : saveState === "error"
          ? "Speichern fehlgeschlagen"
          : "";

  return (
    <div className="person-detail-info-editor">
      <textarea
        aria-label="Info"
        className="person-detail-info-textarea"
        disabled={!canEdit || disabled}
        placeholder="Interne Hinweise zum Mitarbeiter..."
        value={draft}
        onBlur={() => void saveIfChanged()}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaveState("dirty");
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
      {statusText ? <span className={`person-detail-info-save-state is-${saveState}`} aria-live="polite">{statusText}</span> : null}
    </div>
  );
}

function PersonDetailNavItem({
  action,
  onOpen,
}: {
  action: (typeof personDetailActions)[number];
  onOpen: () => void;
}) {
  const Icon = action.icon;
  return (
    <button className="customer-detail-nav-button person-detail-nav-button" type="button" onClick={onOpen}>
      <span className="customer-detail-nav-icon">
        <Icon aria-hidden="true" size={18} />
      </span>
      <span className="customer-detail-nav-copy">
        <span className="customer-detail-nav-title">{action.label}</span>
        <span className="customer-detail-nav-preview">{action.preview}</span>
      </span>
      <ChevronRight aria-hidden="true" size={17} />
    </button>
  );
}

function PersonEmploymentStatusSelect({
  canEdit,
  disabled,
  value,
  onChange,
}: {
  canEdit: boolean;
  disabled: boolean;
  value: PersonEmploymentStatus;
  onChange: (employmentStatus: PersonEmploymentStatus) => Promise<boolean>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  async function selectStatus(nextStatus: PersonEmploymentStatus) {
    if (nextStatus === value) {
      setIsOpen(false);
      return;
    }
    setIsSaving(true);
    const saved = await onChange(nextStatus);
    setIsSaving(false);
    if (saved) {
      setIsOpen(false);
    }
  }

  return (
    <div className="person-status-select" ref={containerRef}>
      <button
        aria-expanded={isOpen}
        className={`person-status-trigger is-${value}`}
        disabled={!canEdit || disabled || isSaving}
        type="button"
        onClick={() => setIsOpen((current) => !current)}
      >
        {isSaving ? "Speichert..." : personEmploymentStatusLabels[value]}
      </button>
      {isOpen ? (
        <div className="person-status-menu" role="menu">
          {(["active", "paused", "departed"] as PersonEmploymentStatus[]).map((status) => (
            <button
              className={`person-status-option is-${status}${status === value ? " is-selected" : ""}`}
              key={status}
              role="menuitemradio"
              aria-checked={status === value}
              type="button"
              onClick={() => void selectStatus(status)}
            >
              <span className={`person-status-dot is-${status}`} aria-hidden="true" />
              <span>{personEmploymentStatusLabels[status]}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PersonSignaturePermissionSelect({
  canEdit,
  disabled,
  value,
  onChange,
}: {
  canEdit: boolean;
  disabled: boolean;
  value: boolean;
  onChange: (canSignImmediately: boolean) => Promise<boolean>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const label = value ? "Sofort erlaubt" : "Erst nach Prüfung";
  const options = [
    { value: true, label: "Sofort erlaubt" },
    { value: false, label: "Erst nach Prüfung" },
  ];

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  async function selectSignaturePermission(nextValue: boolean) {
    if (nextValue === value) {
      setIsOpen(false);
      return;
    }
    setIsSaving(true);
    const saved = await onChange(nextValue);
    setIsSaving(false);
    if (saved) {
      setIsOpen(false);
    }
  }

  return (
    <div className="person-signature-select" ref={containerRef}>
      <button
        aria-expanded={isOpen}
        className="person-signature-trigger"
        disabled={!canEdit || disabled || isSaving}
        type="button"
        onClick={() => setIsOpen((current) => !current)}
      >
        <span>{isSaving ? "Speichert..." : label}</span>
        <ChevronDown aria-hidden="true" size={13} />
      </button>
      {isOpen ? (
        <div className="person-signature-menu" role="menu">
          {options.map((option) => (
            <button
              aria-checked={option.value === value}
              className={`person-signature-option${option.value === value ? " is-selected" : ""}`}
              key={option.label}
              role="menuitemradio"
              type="button"
              onClick={() => void selectSignaturePermission(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PersonDetailSubpage({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <section className="customer-detail-subpage person-detail-subpage" aria-label={title}>
      <header className="customer-detail-subpage-header">
        <button className="icon-button secondary customer-detail-back-button" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={16} />
          <span>Zurück</span>
        </button>
        <h3>{title}</h3>
      </header>
      <div className="customer-detail-subpage-body">
        {children}
      </div>
    </section>
  );
}

const PERSON_ABSENCE_TYPES: AbsenceType[] = ["vacation", "sick", "school", "free", "other"];

type PersonAbsenceListEntry = {
  absence_type: AbsenceType;
  start_date: string;
  end_date: string;
  note: string | null;
  dayCount: number;
  sourceIds: number[];
};

function PersonAbsenceOverviewPanel({ person, canManageCarryover }: { person: Person; canManageCarryover: boolean }) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [vacationCarryoverDays, setVacationCarryoverDays] = useState(0);
  const [carryoverDraft, setCarryoverDraft] = useState("0");
  const [isSavingCarryover, setIsSavingCarryover] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadPersonAbsences() {
      setIsLoading(true);
      setError(null);
      try {
        const [loadedAbsences, loadedCarryover] = await Promise.all([
          api.absences({
            personId: person.id,
            start: `${year}-01-01`,
            end: `${year}-12-31`,
          }),
          api.vacationCarryover({ personId: person.id, year }),
        ]);
        if (!cancelled) {
          setAbsences(loadedAbsences);
          setVacationCarryoverDays(loadedCarryover.carryover_days);
          setCarryoverDraft(String(loadedCarryover.carryover_days));
        }
      } catch (requestError) {
        if (!cancelled) {
          setAbsences([]);
          setVacationCarryoverDays(0);
          setCarryoverDraft("0");
          setError(readApiError(requestError, "Abwesenheiten konnten nicht geladen werden."));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }
    void loadPersonAbsences();
    return () => {
      cancelled = true;
    };
  }, [person.id, year]);

  async function saveVacationCarryover() {
    if (!canManageCarryover || isSavingCarryover) {
      return;
    }
    const parsedCarryover = parseVacationCarryoverDays(carryoverDraft);
    if (!parsedCarryover.ok) {
      setError(parsedCarryover.error);
      return;
    }
    if (parsedCarryover.value === vacationCarryoverDays) {
      setCarryoverDraft(String(vacationCarryoverDays));
      return;
    }
    setIsSavingCarryover(true);
    setError(null);
    try {
      const updatedCarryover = await api.updateVacationCarryover({
        person_id: person.id,
        year,
        carryover_days: parsedCarryover.value,
      });
      setVacationCarryoverDays(updatedCarryover.carryover_days);
      setCarryoverDraft(String(updatedCarryover.carryover_days));
    } catch (requestError) {
      setError(readApiError(requestError, "Resturlaub konnte nicht gespeichert werden."));
      setCarryoverDraft(String(vacationCarryoverDays));
    } finally {
      setIsSavingCarryover(false);
    }
  }

  const activeAbsences = useMemo(
    () => absences
      .filter((absence) => absence.status === "active" && absence.person_id === person.id && absenceOverlapsYear(absence, year))
      .sort(comparePersonAbsences),
    [absences, person.id, year],
  );
  const summary = useMemo(() => summarizeAbsencesByType(activeAbsences, year), [activeAbsences, year]);
  const listEntries = useMemo(() => buildPersonAbsenceListEntries(activeAbsences, year), [activeAbsences, year]);
  const vacationDays = summary.vacation;
  const remainingVacationDays = person.annual_vacation_days === null || person.annual_vacation_days === undefined
    ? null
    : person.annual_vacation_days + vacationCarryoverDays - vacationDays;

  return (
    <div className="person-absence-overview">
      <div className="person-absence-year-control" aria-label="Jahr auswählen">
        <button type="button" onClick={() => setYear((current) => current - 1)}>
          <ChevronLeft aria-hidden="true" size={14} />
          <span>Vorjahr</span>
        </button>
        <strong>{year}</strong>
        <button type="button" onClick={() => setYear((current) => current + 1)}>
          <span>Nächstes Jahr</span>
          <ChevronRight aria-hidden="true" size={14} />
        </button>
      </div>

      <section className="person-absence-summary-card">
        <div className="person-absence-summary-top">
          <div className="person-absence-remaining">
            <span>Verbleibende Urlaubstage {year}</span>
            {remainingVacationDays === null ? (
              <strong>Jahresurlaub nicht hinterlegt</strong>
            ) : (
              <strong className={remainingVacationDays < 0 ? "is-negative" : ""}>{formatAbsenceDays(remainingVacationDays)}</strong>
            )}
          </div>
          <label className="person-vacation-carryover-field">
            <span>Resturlaub</span>
            <div>
              <input
                disabled={!canManageCarryover || isLoading || isSavingCarryover}
                inputMode="numeric"
                type="text"
                value={carryoverDraft}
                onBlur={() => void saveVacationCarryover()}
                onChange={(event) => {
                  setCarryoverDraft(event.target.value);
                  if (error?.startsWith("Resturlaub")) {
                    setError(null);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setCarryoverDraft(String(vacationCarryoverDays));
                    event.currentTarget.blur();
                  }
                }}
              />
              <small>Tage</small>
            </div>
          </label>
        </div>
        <div className="person-absence-type-summary" aria-label={`Fehlzeiten ${year}`}>
          {PERSON_ABSENCE_TYPES.map((type) => (
            <div className="person-absence-type-summary-item" key={type}>
              <StatusBadge tone={type}>{absenceTypeLabels[type]}</StatusBadge>
              <strong>{summary[type]}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="person-absence-list-section">
        <div className="person-absence-list-heading">
          <h4>Fehlzeiten {year}</h4>
          <span>{listEntries.length} {listEntries.length === 1 ? "Eintrag" : "Einträge"}</span>
        </div>
        {isLoading ? (
          <div className="person-absence-state">Abwesenheiten werden geladen...</div>
        ) : error ? (
          <div className="person-absence-state is-error">{error}</div>
        ) : listEntries.length ? (
          <div className="person-absence-list">
            {listEntries.map((entry) => (
              <article className={`person-absence-row is-${entry.absence_type}`} key={personAbsenceListEntryKey(entry)}>
                <div>
                  <StatusBadge tone={entry.absence_type}>{absenceTypeLabels[entry.absence_type]}</StatusBadge>
                  <strong>{formatPersonAbsenceDateRange(entry)}</strong>
                  {entry.note ? <p>{entry.note}</p> : null}
                </div>
                <span>{formatAbsenceDays(entry.dayCount)}</span>
              </article>
            ))}
          </div>
        ) : (
          <div className="person-absence-state">Keine Abwesenheiten im Jahr {year} hinterlegt.</div>
        )}
      </section>
    </div>
  );
}

function PersonHoursAccountPanel({ person, canManage }: { person: Person; canManage: boolean }) {
  const [account, setAccount] = useState<PersonHoursAccount | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeForm, setActiveForm] = useState<"manual" | "payout" | null>(null);
  const [hoursInput, setHoursInput] = useState("");
  const [noteInput, setNoteInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadHoursAccount() {
      setIsLoading(true);
      setError(null);
      setMessage(null);
      try {
        const loadedAccount = await api.personHoursAccount(person.id);
        if (!cancelled) {
          setAccount(loadedAccount);
        }
      } catch (requestError) {
        if (!cancelled) {
          setAccount(null);
          setError(readApiError(requestError, "Stundenkonto konnte nicht geladen werden."));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }
    void loadHoursAccount();
    return () => {
      cancelled = true;
    };
  }, [person.id]);

  function openForm(mode: "manual" | "payout") {
    setActiveForm(mode);
    setHoursInput("");
    setNoteInput(mode === "payout" ? defaultPayoutNote() : "");
    setError(null);
    setMessage(null);
  }

  function closeForm() {
    setActiveForm(null);
    setHoursInput("");
    setNoteInput("");
  }

  async function submitHoursAccountForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeForm || isSaving) {
      return;
    }
    const parsedHours = parseHoursAccountInput(hoursInput);
    if (!parsedHours.ok) {
      setError(parsedHours.error);
      return;
    }
    const note = noteInput.trim();
    if (activeForm === "manual" && !note) {
      setError("Grund / Notiz ist Pflicht.");
      return;
    }
    if (activeForm === "manual" && parsedHours.value === 0) {
      setError("Die Korrektur muss größer oder kleiner als 0 sein.");
      return;
    }
    if (activeForm === "payout" && parsedHours.value <= 0) {
      setError("Auszahlung muss größer als 0 Stunden sein.");
      return;
    }
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const updatedAccount = activeForm === "manual"
        ? await api.createPersonHoursManualAdjustment(person.id, { hours_delta: parsedHours.value, note })
        : await api.createPersonHoursPayout(person.id, { hours: parsedHours.value, note: note || null });
      setAccount(updatedAccount);
      setMessage(activeForm === "manual" ? "Manuelle Korrektur gebucht." : "Auszahlung gebucht.");
      closeForm();
    } catch (requestError) {
      setError(readApiError(requestError, "Buchung konnte nicht gespeichert werden."));
    } finally {
      setIsSaving(false);
    }
  }

  const balanceMinutes = account?.current_balance_minutes ?? 0;
  const balanceTone = balanceMinutes < 0 ? "is-negative" : balanceMinutes > 0 ? "is-positive" : "is-neutral";
  const overtimeAbsenceMinutesByWeek = useMemo(
    () => summarizeHoursAccountOvertimeAbsenceMinutes(account?.entries ?? []),
    [account?.entries],
  );
  const logEntries = useMemo(
    () => sortHoursAccountEntries(account?.entries ?? []),
    [account?.entries],
  );

  return (
    <div className="person-hours-account">
      <section className={`person-hours-balance-card ${balanceTone}`}>
        <div>
          <span>Aktueller Stand</span>
          <strong>{formatHoursAccountMinutes(balanceMinutes)}</strong>
        </div>
        {canManage ? (
          <div className="person-hours-account-actions">
            <button
              disabled={isLoading || isSaving}
              type="button"
              onClick={() => openForm("manual")}
            >
              Manuelle Korrektur
            </button>
            <button disabled={isLoading || isSaving} type="button" onClick={() => openForm("payout")}>
              Stunden auszahlen
            </button>
          </div>
        ) : null}
      </section>

      {activeForm ? (
        <form className="person-hours-account-form" onSubmit={(event) => void submitHoursAccountForm(event)}>
          <div className="person-hours-account-form-heading">
            <strong>{activeForm === "manual" ? "Manuelle Korrektur" : "Auszahlung buchen"}</strong>
            <span>{activeForm === "manual" ? "Manuelle Korrektur nur für Büro-Notfälle verwenden." : "Auszahlungen werden als eigene Buchung im Log gespeichert."}</span>
          </div>
          <label>
            <span>{activeForm === "manual" ? "Stundenänderung" : "Stunden"}</span>
            <input
              autoFocus
              disabled={isSaving}
              inputMode="decimal"
              placeholder={activeForm === "manual" ? "+5 oder -2,5" : "20"}
              value={hoursInput}
              onChange={(event) => setHoursInput(event.target.value)}
            />
          </label>
          <label>
            <span>{activeForm === "manual" ? "Grund / Notiz" : "Zeitraum / Notiz"}</span>
            <textarea
              disabled={isSaving}
              placeholder={activeForm === "manual" ? "z. B. Startwert Altbestand übernommen" : "z. B. Auszahlung Juli 2026"}
              value={noteInput}
              onChange={(event) => setNoteInput(event.target.value)}
            />
          </label>
          <div className="person-hours-account-form-actions">
            <button disabled={isSaving} type="button" onClick={closeForm}>Abbrechen</button>
            <button disabled={isSaving} type="submit">{isSaving ? "Speichert..." : "Buchen"}</button>
          </div>
        </form>
      ) : null}

      {message ? <div className="person-hours-account-state is-success">{message}</div> : null}
      {error ? <div className="person-hours-account-state is-error">{error}</div> : null}
      {isLoading ? <div className="person-hours-account-state">Stundenkonto wird geladen...</div> : null}

      <section className="person-hours-log-section">
        <div className="person-hours-log-heading">
          <h4>Ereignislog</h4>
          <span>{logEntries.length} {logEntries.length === 1 ? "Buchung" : "Buchungen"}</span>
        </div>
        {account && logEntries.length > 0 ? (
          <div className="person-hours-log-list">
            {logEntries.map((entry) => {
              const descriptionLines = hoursAccountEntryDescriptionLines(entry, overtimeAbsenceMinutesByWeek);
              return (
                <article className="person-hours-log-entry" key={entry.id}>
                  <div className="person-hours-log-entry-main">
                    <span>{formatHoursAccountDate(entry.created_at)}</span>
                    <strong>{hoursAccountEntryTitle(entry)}</strong>
                    {descriptionLines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}
                    {entry.created_by_name ? <small>Gebucht von {entry.created_by_name}</small> : null}
                  </div>
                  <div className="person-hours-log-entry-values">
                    <strong className={entry.minutes_delta < 0 ? "is-negative" : entry.minutes_delta > 0 ? "is-positive" : ""}>
                      {formatHoursAccountMinutes(entry.minutes_delta)}
                    </strong>
                    <span>Saldo {formatHoursAccountMinutes(entry.balance_after_minutes)}</span>
                  </div>
                </article>
              );
            })}
          </div>
        ) : !isLoading && !error ? (
          <div className="person-hours-account-state">Noch keine Buchungen vorhanden.</div>
        ) : null}
      </section>
    </div>
  );
}

function PersonDetailPlaceholderPanel({
  action,
  person,
}: {
  action: (typeof personDetailActions)[number];
  person: Person;
}) {
  return (
    <section className="person-detail-placeholder-panel" aria-live="polite">
      <div>
        <span>Funktion wird vorbereitet</span>
        <h3>{action.title}</h3>
      </div>
      <p>{action.description}</p>
      <small>{person.display_name}</small>
    </section>
  );
}

function PersonDetailField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={["person-detail-info-field", className].filter(Boolean).join(" ")}>
      <span>{label}</span>
      {children}
    </div>
  );
}

function PersonInlineEditableField({
  ariaLabel,
  canEdit,
  displayValue,
  inputMode,
  isSaving,
  max,
  min,
  required = false,
  step,
  type = "text",
  value,
  onSave,
}: {
  ariaLabel: string;
  canEdit: boolean;
  displayValue: string;
  inputMode?: "decimal" | "email" | "numeric" | "search" | "tel" | "text" | "url";
  isSaving: boolean;
  max?: number;
  min?: number;
  required?: boolean;
  step?: number | string;
  type?: "email" | "number" | "tel" | "text";
  value: string;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditing) {
      setDraft(value);
      setFieldError(null);
    }
  }, [isEditing, value]);

  function cancelEdit() {
    setDraft(value);
    setFieldError(null);
    setIsEditing(false);
  }

  async function saveEdit() {
    const nextValue = draft.trim();
    if (required && !nextValue) {
      setFieldError("Pflichtfeld");
      return;
    }
    if (nextValue === value.trim()) {
      cancelEdit();
      return;
    }
    const saved = await onSave(nextValue);
    if (saved) {
      setIsEditing(false);
      setFieldError(null);
    }
  }

  if (isEditing) {
    return (
      <div className="person-inline-field is-editing">
        <input
          aria-label={ariaLabel}
          disabled={isSaving}
          inputMode={inputMode}
          max={type === "number" ? max : undefined}
          min={type === "number" ? min : undefined}
          step={type === "number" ? step : undefined}
          type={type}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setFieldError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveEdit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
        />
        <div className="person-inline-field-actions">
          <button aria-label="Speichern" disabled={isSaving} type="button" onClick={() => void saveEdit()}>
            <Save aria-hidden="true" size={13} />
          </button>
          <button aria-label="Abbrechen" disabled={isSaving} type="button" onClick={cancelEdit}>
            ×
          </button>
        </div>
        {fieldError ? <small>{fieldError}</small> : null}
      </div>
    );
  }

  return (
    <div className="person-inline-field">
      <strong>{displayValue}</strong>
      {canEdit ? (
        <button
          aria-label={ariaLabel}
          className="person-inline-edit-button"
          disabled={isSaving}
          type="button"
          onClick={() => setIsEditing(true)}
        >
          <Pencil aria-hidden="true" size={12} />
        </button>
      ) : null}
    </div>
  );
}

function PersonAddressSearchField({
  disabled = false,
  name,
  onSelect,
}: {
  disabled?: boolean;
  name?: string;
  onSelect: (values: Partial<PersonCreate>, result: PersonGeocodeSearchResult) => boolean | Promise<boolean>;
}) {
  const [addressSearch, setAddressSearch] = useState("");
  const [addressResults, setAddressResults] = useState<PersonGeocodeSearchResult[]>([]);
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);
  const [isApplyingAddress, setIsApplyingAddress] = useState(false);
  const [addressSearchMessage, setAddressSearchMessage] = useState<string | null>(null);
  const [selectedGeocodeResult, setSelectedGeocodeResult] = useState<PersonGeocodeSearchResult | null>(null);

  useEffect(() => {
    const query = addressSearch.trim();
    if (selectedGeocodeResult && query === selectedGeocodeResult.label) {
      setAddressResults([]);
      setIsSearchingAddress(false);
      return;
    }
    if (query.length < 3) {
      setAddressResults([]);
      setIsSearchingAddress(false);
      setAddressSearchMessage(null);
      return;
    }

    let cancelled = false;
    setIsSearchingAddress(true);
    setAddressSearchMessage(null);
    const timer = window.setTimeout(() => {
      api
        .searchPersonAddress(query)
        .then((results) => {
          if (cancelled) {
            return;
          }
          setAddressResults(results);
          setAddressSearchMessage(results.length ? null : "Keine passende Adresse gefunden. Bitte Eingabe pruefen oder genauer formulieren.");
        })
        .catch(() => {
          if (!cancelled) {
            setAddressResults([]);
            setAddressSearchMessage("Adresssuche aktuell nicht verfuegbar.");
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsSearchingAddress(false);
          }
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [addressSearch, selectedGeocodeResult]);

  async function applyGeocodeResult(result: PersonGeocodeSearchResult) {
    const selectedValues: Partial<PersonCreate> = {
      address_postal_code: result.postal_code,
      address_city: result.city,
      address_street: result.street,
      address_house_number: result.house_number,
      address_formatted: result.label,
      address_latitude: result.latitude,
      address_longitude: result.longitude,
      address_location_status: "geocoded",
    };
    setIsApplyingAddress(true);
    const saved = await onSelect(selectedValues, result);
    setIsApplyingAddress(false);
    if (saved === false) {
      setAddressSearchMessage("Adresse konnte nicht gespeichert werden.");
      return;
    }
    setSelectedGeocodeResult(result);
    setAddressSearch("");
    setAddressResults([]);
    setIsSearchingAddress(false);
    setAddressSearchMessage("Startort aus Vorschlag uebernommen und geprueft.");
    (document.activeElement as HTMLElement | null)?.blur();
  }

  return (
    <label className="address-field site-address-search">
      <span>Adresse suchen</span>
      <input
        aria-label="Adresse suchen"
        autoCapitalize="none"
        autoComplete="new-password"
        autoCorrect="off"
        disabled={disabled || isApplyingAddress}
        inputMode="search"
        name={name}
        placeholder="z. B. Moorburger Str. 16, 21079 Hamburg"
        spellCheck={false}
        value={addressSearch}
        onChange={(event) => {
          setSelectedGeocodeResult(null);
          setAddressSearch(event.target.value);
        }}
      />
      {isSearchingAddress && <small>Adresse wird gesucht...</small>}
      {isApplyingAddress && <small>Adresse wird gespeichert...</small>}
      {addressSearchMessage && <small>{addressSearchMessage}</small>}
      {addressResults.length > 0 && (
        <div className="site-address-results" role="listbox">
          {addressResults.map((result) => (
            <button
              disabled={disabled || isApplyingAddress}
              key={`${result.latitude}-${result.longitude}-${result.label}`}
              type="button"
              onClick={() => void applyGeocodeResult(result)}
            >
              <strong>{result.label}</strong>
              <span>{formatGeocodeMeta(result)}</span>
            </button>
          ))}
        </div>
      )}
    </label>
  );
}

function PersonFields({
  draft,
  isCreateForm = false,
  onChange,
  onGeocodeSelected,
}: {
  draft: PersonCreate;
  isCreateForm?: boolean;
  onChange: (values: Partial<PersonCreate>) => void;
  onGeocodeSelected?: (values: Partial<PersonCreate>) => void;
}) {
  return (
    <div className="person-form-grid">
      <label>
        <span>Vorname</span>
        <input
          value={draft.first_name}
          onChange={(event) => onChange({ first_name: event.target.value })}
        />
      </label>
      <label>
        <span>Nachname</span>
        <input
          value={draft.last_name}
          onChange={(event) => onChange({ last_name: event.target.value })}
        />
      </label>
      <label>
        <span>Anzeigename</span>
        <input
          value={draft.display_name}
          onChange={(event) => onChange({ display_name: event.target.value })}
        />
      </label>
      {!isCreateForm && (
        <label>
          <span>Typ</span>
          <select
            value={draft.person_type}
            onChange={(event) => onChange({ person_type: event.target.value as PersonType })}
          >
            {Object.entries(personTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>E-Mail</span>
        <input
          value={draft.email ?? ""}
          onChange={(event) => onChange({ email: event.target.value || null })}
        />
      </label>
      <label>
        <span>Telefon</span>
        <input
          value={draft.phone ?? ""}
          onChange={(event) => onChange({ phone: event.target.value || null })}
        />
      </label>
      <label>
        <span>Jahresurlaub</span>
        <input
          max={365}
          min={0}
          step={1}
          type="number"
          value={draft.annual_vacation_days ?? ""}
          onChange={(event) => onChange({ annual_vacation_days: parseOptionalInteger(event.target.value) })}
        />
      </label>
      <label>
        <span>Wochenstunden</span>
        <input
          inputMode="decimal"
          max={80}
          min={0}
          step={0.25}
          type="text"
          value={Number.isFinite(draft.weekly_hours) ? draft.weekly_hours ?? "" : ""}
          onChange={(event) => onChange({ weekly_hours: parseOptionalDecimal(event.target.value) })}
        />
      </label>
      <label className="checkbox-field">
        <input
          checked={draft.is_active}
          type="checkbox"
          onChange={(event) => {
            const isActive = event.target.checked;
            onChange({
              is_active: isActive,
              employment_status: isActive ? "active" : "departed",
            });
          }}
        />
        <span>Aktiv</span>
      </label>
      <label className="checkbox-field">
        <input
          checked={draft.can_sign_measurements_immediately}
          type="checkbox"
          onChange={(event) => onChange({ can_sign_measurements_immediately: event.target.checked })}
        />
        <span>Darf Aufmaße sofort unterschreiben lassen</span>
      </label>

      <section className="person-location-section site-location-section">
        {!isCreateForm && (
          <div>
            <h3>Adresse / Startort</h3>
          </div>
        )}
        <PersonAddressSearchField
          name={isCreateForm ? "person-location-query" : undefined}
          onSelect={(selectedValues) => {
            onChange(selectedValues);
            onGeocodeSelected?.(selectedValues);
            return true;
          }}
        />
        <div className="site-address-display-grid person-address-display-grid">
          <PersonAddressDisplayItem label="PLZ" value={draft.address_postal_code} />
          <PersonAddressDisplayItem label="Stadt" value={draft.address_city} />
          <PersonAddressDisplayItem label="Strasse" value={draft.address_street} />
          <PersonAddressDisplayItem label="Hausnummer" value={draft.address_house_number} />
          <PersonAddressDisplayItem label="Adresszusatz / Bereich" value={draft.address_extra} wide />
        </div>
      </section>

      <label className="notes-field">
        <span>Notizen</span>
        <textarea
          value={draft.notes ?? ""}
          onChange={(event) => onChange({ notes: event.target.value || null })}
        />
      </label>
    </div>
  );
}

function PersonAddressDisplayItem({ label, value, wide = false }: { label: string; value: string | null | undefined; wide?: boolean }) {
  return (
    <div className={`site-address-display-item${wide ? " is-wide" : ""}`}>
      <span>{label}</span>
      <strong>{value || "—"}</strong>
    </div>
  );
}

function toEditablePeople(people: Person[]): Record<string, EditablePerson> {
  return Object.fromEntries(
    people.map((person) => [String(person.id), toEditablePerson(person)]),
  );
}

function toEditablePerson(person: Person): EditablePerson {
  return {
    id: person.id,
    first_name: person.first_name,
    last_name: person.last_name,
    display_name: person.display_name,
    short_code: person.short_code,
    person_type: person.person_type,
    is_active: person.is_active,
    employment_status: personEmploymentStatus(person),
    can_sign_measurements_immediately: person.can_sign_measurements_immediately,
    annual_vacation_days: person.annual_vacation_days,
    weekly_hours: person.weekly_hours,
    email: person.email,
    phone: person.phone,
    address_postal_code: person.address_postal_code,
    address_city: person.address_city,
    address_street: person.address_street,
    address_house_number: person.address_house_number,
    address_extra: person.address_extra,
    address_formatted: person.address_formatted,
    address_latitude: person.address_latitude,
    address_longitude: person.address_longitude,
    address_location_status: person.address_location_status,
    notes: person.notes,
  };
}

function personNameUpdateValues(person: Person, value: string): Partial<PersonCreate> {
  const displayName = value.trim();
  const parts = displayName.split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? person.first_name;
  const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? person.last_name;
  return {
    first_name: firstName,
    last_name: lastName,
    display_name: displayName,
    short_code: getEmployeeShortName({
      first_name: firstName,
      last_name: lastName,
      display_name: displayName,
      short_code: person.short_code,
    }),
  };
}

function validatePersonPayload(person: PersonCreate): string | null {
  if (!person.first_name.trim() || !person.last_name.trim()) {
    return "Vorname und Nachname sind Pflicht.";
  }
  if (
    person.annual_vacation_days !== null
    && (!Number.isInteger(person.annual_vacation_days) || person.annual_vacation_days < 0 || person.annual_vacation_days > 365)
  ) {
    return "Jahresurlaub muss eine ganze Zahl zwischen 0 und 365 sein.";
  }
  if (
    person.weekly_hours !== null
    && (!Number.isFinite(person.weekly_hours) || person.weekly_hours < 0 || person.weekly_hours > 80)
  ) {
    return "Wochenstunden müssen eine Zahl zwischen 0 und 80 sein.";
  }
  return null;
}

function parseOptionalInteger(value: string): number | null {
  if (!value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalDecimal(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) {
    return null;
  }
  return Number(normalized);
}

function parseVacationCarryoverDays(value: string): { ok: true; value: number } | { ok: false; error: string } {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) {
    return { ok: true, value: 0 };
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { ok: false, error: "Resturlaub muss eine ganze Zahl sein." };
  }
  if (parsed < 0) {
    return { ok: false, error: "Resturlaub darf nicht negativ sein." };
  }
  if (parsed > 365) {
    return { ok: false, error: "Resturlaub darf maximal 365 Tage betragen." };
  }
  return { ok: true, value: parsed };
}

function normalizeAnnualVacationDays(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Math.trunc(value);
}

function normalizeWeeklyHours(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function formatAnnualVacationDays(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }
  return `${value} ${value === 1 ? "Tag" : "Tage"}`;
}

function formatWeeklyHours(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value)} Std.`;
}

function parseHoursAccountInput(value: string): { ok: true; value: number } | { ok: false; error: string } {
  const normalized = value.trim().replace(",", ".").replace(/^\+/, "");
  if (!normalized) {
    return { ok: false, error: "Bitte Stunden eintragen." };
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: "Bitte eine gültige Stundenanzahl eintragen." };
  }
  return { ok: true, value: parsed };
}

function formatHoursAccountMinutes(minutes: number): string {
  const sign = minutes > 0 ? "+" : minutes < 0 ? "-" : "";
  const hours = Math.abs(minutes) / 60;
  return `${sign}${new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  }).format(hours)} h`;
}

function formatHoursAccountDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function hoursAccountEntryTitle(entry: PersonHoursAccountEntry): string {
  if (entry.entry_type === "weekly_balance") {
    return entry.iso_year && entry.iso_week
      ? `Wochenabschluss KW ${entry.iso_week} / ${entry.iso_year}`
      : "Wochenabschluss";
  }
  if (entry.entry_type === "manual_adjustment") {
    return "Manuelle Korrektur";
  }
  if (entry.entry_type === "payout") {
    return "Auszahlung";
  }
  if (entry.entry_type === "overtime_absence") {
    return "Überstunden abgebaut";
  }
  return "Buchung";
}

function hoursAccountEntryDescriptionLines(
  entry: PersonHoursAccountEntry,
  overtimeAbsenceMinutesByWeek: ReadonlyMap<string, number>,
): string[] {
  if (
    entry.entry_type === "weekly_balance"
    && entry.weekly_actual_minutes !== null
    && entry.weekly_required_minutes !== null
  ) {
    const overtimeAbsenceImpactMinutes = weeklyOvertimeAbsenceImpactMinutes(entry, overtimeAbsenceMinutesByWeek);
    const detailParts = weeklyBalanceDetailParts(entry, overtimeAbsenceImpactMinutes);
    if (entry.weekly_actual_minutes === entry.weekly_required_minutes && overtimeAbsenceImpactMinutes === 0 && detailParts.length === 0) {
      return ["Sollzeit erreicht - keine Stundenkonto-Abweichung"];
    }
    const weeklyDeltaMinutes = entry.weekly_actual_minutes - entry.weekly_required_minutes;
    const weeklyDescription = `Ist ${formatHoursAccountMinutesUnsigned(entry.weekly_actual_minutes)} / Soll ${formatHoursAccountMinutesUnsigned(entry.weekly_required_minutes)} -> ${formatHoursAccountMinutes(weeklyDeltaMinutes)}`;
    return detailParts.length > 0 ? [detailParts.join(" / "), weeklyDescription] : [weeklyDescription];
  }
  if (entry.entry_type === "overtime_absence") {
    return [`Überstundenabbau: ${formatHoursAccountMinutes(entry.minutes_delta)}`];
  }
  if (entry.entry_type === "payout") {
    return [`${entry.note}: ${formatHoursAccountMinutes(entry.minutes_delta)}`];
  }
  return [entry.note];
}

function weeklyBalanceDetailParts(entry: PersonHoursAccountEntry, overtimeAbsenceImpactMinutes: number): string[] {
  const absenceBreakdown = entry.weekly_absence_breakdown ?? [];
  const visibleAbsenceBreakdown = absenceBreakdown.filter((item) => item.absence_type !== "free");
  const hasSpecialDetails = visibleAbsenceBreakdown.some((item) => item.minutes > 0) || overtimeAbsenceImpactMinutes !== 0;
  if (!hasSpecialDetails) {
    return [];
  }
  const detailParts: string[] = [];
  if (entry.weekly_work_minutes !== null) {
    detailParts.push(`Arbeitsstunden ${formatHoursAccountMinutesUnsigned(entry.weekly_work_minutes)}`);
  }
  visibleAbsenceBreakdown.forEach((item) => {
    if (item.minutes <= 0) {
      return;
    }
    detailParts.push(`${hoursAccountAbsenceTypeLabel(item.absence_type)} ${formatHoursAccountMinutesUnsigned(item.minutes)}`);
  });
  if (overtimeAbsenceImpactMinutes !== 0) {
    detailParts.push(`Überstundenabbau ${formatHoursAccountMinutes(overtimeAbsenceImpactMinutes)}`);
  }
  return detailParts;
}

function weeklyOvertimeAbsenceImpactMinutes(
  entry: PersonHoursAccountEntry,
  overtimeAbsenceMinutesByWeek: ReadonlyMap<string, number>,
): number {
  if (entry.weekly_overtime_absence_minutes !== null) {
    return entry.weekly_overtime_absence_minutes === 0 ? 0 : -entry.weekly_overtime_absence_minutes;
  }
  const weekKey = hoursAccountWeekKey(entry);
  const legacyOvertimeAbsenceMinutes = weekKey ? overtimeAbsenceMinutesByWeek.get(weekKey) ?? 0 : 0;
  if (legacyOvertimeAbsenceMinutes !== 0) {
    return legacyOvertimeAbsenceMinutes;
  }
  const legacyBreakdownOvertimeMinutes = (entry.weekly_absence_breakdown ?? [])
    .filter((item) => item.absence_type === "free")
    .reduce((sum, item) => sum + Math.max(0, item.minutes), 0);
  return legacyBreakdownOvertimeMinutes > 0 ? -legacyBreakdownOvertimeMinutes : 0;
}

function hoursAccountAbsenceTypeLabel(absenceType: string): string {
  if (absenceType in absenceTypeLabels) {
    return absenceTypeLabels[absenceType as AbsenceType];
  }
  return absenceType;
}

function formatHoursAccountMinutesUnsigned(minutes: number): string {
  return formatHoursAccountMinutes(Math.abs(minutes)).replace(/^\+/, "");
}

function summarizeHoursAccountOvertimeAbsenceMinutes(entries: PersonHoursAccountEntry[]): Map<string, number> {
  const minutesByWeek = new Map<string, number>();
  entries.forEach((entry) => {
    if (entry.entry_type !== "overtime_absence") {
      return;
    }
    const weekKey = hoursAccountWeekKey(entry);
    if (!weekKey) {
      return;
    }
    minutesByWeek.set(weekKey, (minutesByWeek.get(weekKey) ?? 0) + entry.minutes_delta);
  });
  return minutesByWeek;
}

function hoursAccountWeekKey(entry: Pick<PersonHoursAccountEntry, "person_id" | "iso_year" | "iso_week">): string | null {
  if (entry.iso_year === null || entry.iso_week === null) {
    return null;
  }
  return `${entry.person_id}-${entry.iso_year}-${entry.iso_week}`;
}

function sortHoursAccountEntries(entries: PersonHoursAccountEntry[]): PersonHoursAccountEntry[] {
  return [...entries].sort(compareHoursAccountEntries);
}

function compareHoursAccountEntries(first: PersonHoursAccountEntry, second: PersonHoursAccountEntry): number {
  if (isWeeklyBalanceWithWeek(first) && isWeeklyBalanceWithWeek(second)) {
    if (first.iso_year !== second.iso_year) {
      return second.iso_year - first.iso_year;
    }
    if (first.iso_week !== second.iso_week) {
      return second.iso_week - first.iso_week;
    }
  }
  const createdComparison = timestampValue(second.created_at) - timestampValue(first.created_at);
  if (createdComparison !== 0) {
    return createdComparison;
  }
  return second.id - first.id;
}

function isWeeklyBalanceWithWeek(
  entry: PersonHoursAccountEntry,
): entry is PersonHoursAccountEntry & { iso_year: number; iso_week: number } {
  return entry.entry_type === "weekly_balance" && entry.iso_year !== null && entry.iso_week !== null;
}

function timestampValue(value: string): number {
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function defaultPayoutNote(): string {
  const now = new Date();
  const month = new Intl.DateTimeFormat("de-DE", { month: "long" }).format(now);
  return `Auszahlung ${month} ${now.getFullYear()}`;
}

function summarizeAbsencesByType(absences: Absence[], year: number): Record<AbsenceType, number> {
  const summary: Record<AbsenceType, number> = {
    vacation: 0,
    sick: 0,
    school: 0,
    free: 0,
    other: 0,
  };
  absences.forEach((absence) => {
    summary[absence.absence_type] += countAbsenceDaysInYear(absence, year);
  });
  return summary;
}

function buildPersonAbsenceListEntries(absences: Absence[], year: number): PersonAbsenceListEntry[] {
  const clippedAbsences = absences
    .map((absence) => {
      const startDate = maxIsoDate(absence.start_date, `${year}-01-01`);
      const endDate = minIsoDate(absence.end_date, `${year}-12-31`);
      if (endDate < startDate) {
        return null;
      }
      return {
        absence,
        startDate,
        endDate,
        noteKey: normalizeAbsenceNote(absence.note),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) =>
      left.startDate.localeCompare(right.startDate)
      || left.endDate.localeCompare(right.endDate)
      || left.absence.id - right.absence.id,
    );

  return clippedAbsences.reduce<PersonAbsenceListEntry[]>((entries, entry) => {
    const previous = entries[entries.length - 1];
    if (
      previous
      && previous.absence_type === entry.absence.absence_type
      && normalizeAbsenceNote(previous.note) === entry.noteKey
      && entry.startDate <= addIsoDays(previous.end_date, 1)
    ) {
      previous.end_date = maxIsoDate(previous.end_date, entry.endDate);
      previous.dayCount = countWeekdaysInclusive(previous.start_date, previous.end_date);
      previous.sourceIds.push(entry.absence.id);
      return entries;
    }

    entries.push({
      absence_type: entry.absence.absence_type,
      start_date: entry.startDate,
      end_date: entry.endDate,
      note: entry.absence.note?.trim() || null,
      dayCount: countWeekdaysInclusive(entry.startDate, entry.endDate),
      sourceIds: [entry.absence.id],
    });
    return entries;
  }, []);
}

function personAbsenceListEntryKey(entry: PersonAbsenceListEntry): string {
  return `${entry.absence_type}-${entry.start_date}-${entry.end_date}-${entry.sourceIds.join("-")}`;
}

function normalizeAbsenceNote(note: string | null | undefined): string {
  return note?.trim().toLowerCase() || "";
}

function absenceOverlapsYear(absence: Pick<Absence, "start_date" | "end_date">, year: number): boolean {
  return absence.start_date <= `${year}-12-31` && absence.end_date >= `${year}-01-01`;
}

function countAbsenceDaysInYear(absence: Pick<Absence, "start_date" | "end_date">, year: number): number {
  const start = maxIsoDate(absence.start_date, `${year}-01-01`);
  const end = minIsoDate(absence.end_date, `${year}-12-31`);
  if (end < start) {
    return 0;
  }
  return countWeekdaysInclusive(start, end);
}

function countWeekdaysInclusive(startDate: string, endDate: string): number {
  const start = parseIsoDateStrict(startDate);
  const end = parseIsoDateStrict(endDate);
  if (!start || !end || end.getTime() < start.getTime()) {
    return 0;
  }

  let count = 0;
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      count += 1;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function parseIsoDateStrict(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function minIsoDate(left: string, right: string): string {
  return left <= right ? left : right;
}

function maxIsoDate(left: string, right: string): string {
  return left >= right ? left : right;
}

function addIsoDays(value: string, offset: number): string {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function comparePersonAbsences(left: Absence, right: Absence): number {
  return left.start_date.localeCompare(right.start_date) || left.end_date.localeCompare(right.end_date) || left.id - right.id;
}

function formatPersonAbsenceDateRange(absence: Pick<Absence, "start_date" | "end_date">): string {
  if (absence.start_date === absence.end_date) {
    return formatIsoDate(absence.start_date);
  }
  return `${formatIsoDate(absence.start_date)} - ${formatIsoDate(absence.end_date)}`;
}

function formatIsoDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short" }).format(new Date(`${value}T00:00:00`));
}

function formatAbsenceDays(value: number): string {
  return `${value} ${Math.abs(value) === 1 ? "Tag" : "Tage"}`;
}

function normalizePersonPayload(person: PersonCreate): PersonCreate {
  const firstName = person.first_name.trim();
  const lastName = person.last_name.trim();
  const employmentStatus = person.employment_status ?? (person.is_active ? "active" : "departed");
  return {
    ...person,
    first_name: firstName,
    last_name: lastName,
    display_name: person.display_name.trim() || `${firstName} ${lastName}`.trim(),
    short_code: getEmployeeShortName({ ...person, first_name: firstName, last_name: lastName }),
    is_active: employmentStatus === "active",
    employment_status: employmentStatus,
    can_sign_measurements_immediately: person.can_sign_measurements_immediately,
    annual_vacation_days: normalizeAnnualVacationDays(person.annual_vacation_days),
    weekly_hours: normalizeWeeklyHours(person.weekly_hours),
    email: person.email?.trim() || null,
    phone: person.phone?.trim() || null,
    address_postal_code: person.address_postal_code?.trim() || null,
    address_city: person.address_city?.trim() || null,
    address_street: person.address_street?.trim() || null,
    address_house_number: person.address_house_number?.trim() || null,
    address_extra: person.address_extra?.trim() || null,
    address_formatted: person.address_formatted?.trim() || null,
    address_latitude: person.address_latitude,
    address_longitude: person.address_longitude,
    address_location_status: person.address_location_status,
    notes: person.notes?.trim() || null,
  };
}

function comparePeople(left: Person, right: Person): number {
  return left.display_name.localeCompare(right.display_name);
}

function comparePeopleForOverview(left: Person, right: Person): number {
  const statusDiff = personEmploymentStatusRank(left) - personEmploymentStatusRank(right);
  return statusDiff || comparePeople(left, right);
}

function personInScope(person: Person, scope: PersonScope): boolean {
  if (scope === "internal") {
    return person.person_type === "internal";
  }
  return person.person_type !== "internal";
}

function personScopeToCreateType(scope: PersonScope): PersonType {
  return scope === "external" ? "external" : "internal";
}

function groupPeopleForOverview(people: Person[], scope: PersonScope): PeopleOverviewGroup[] {
  if (scope === "external") {
    return [
      {
        key: "external",
        label: "Externe / Leiharbeiter",
        people: sortPeopleForOverview(people.filter((person) => person.is_active && person.person_type === "external")),
      },
      {
        key: "external-temp",
        label: "Schnell angelegt",
        people: sortPeopleForOverview(people.filter((person) => person.is_active && person.person_type === "external_temp")),
      },
      {
        key: "inactive-external",
        label: "Inaktive Externe",
        people: sortPeopleForOverview(people.filter((person) => !person.is_active)),
      },
    ].filter((group) => group.people.length > 0);
  }
  const internalPeople = people.filter((person) => person.person_type === "internal");
  return [
    {
      key: "internal-project-managers",
      label: "Projektleiter",
      people: sortPeopleForOverview(internalPeople.filter(isProjectManagerPerson)),
      collapsible: true,
    },
    {
      key: "internal-office",
      label: "Büro",
      people: sortPeopleForOverview(internalPeople.filter(isOfficePerson)),
      collapsible: true,
    },
    {
      key: "internal-workers",
      label: "Monteure",
      people: sortPeopleForOverview(internalPeople.filter(isWorkerPerson)),
      collapsible: true,
    },
  ].filter((group) => group.people.length > 0);
}

function sortPeopleForOverview(people: Person[]): Person[] {
  return [...people].sort(comparePeopleForOverview);
}

function isProjectManagerPerson(person: Person): boolean {
  return person.user_roles?.includes("project_manager") ?? false;
}

function isOfficePerson(person: Person): boolean {
  if (isProjectManagerPerson(person)) {
    return false;
  }
  const roles = person.user_roles ?? [];
  return roles.includes("office") || roles.includes("admin");
}

function isWorkerPerson(person: Person): boolean {
  return !isProjectManagerPerson(person) && !isOfficePerson(person);
}

function personEmploymentStatus(person: Pick<Person, "employment_status" | "is_active">): PersonEmploymentStatus {
  return person.employment_status ?? (person.is_active ? "active" : "departed");
}

function personEmploymentStatusRank(person: Pick<Person, "employment_status" | "is_active">): number {
  const status = personEmploymentStatus(person);
  if (status === "active") {
    return 0;
  }
  if (status === "paused") {
    return 1;
  }
  return 2;
}

function personCardColor(person: Person): string {
  if (!person.is_active) {
    return "#94a3b8";
  }
  if (person.person_type !== "internal") {
    return "#f2b84b";
  }
  return "#1d5c99";
}

function personStatusBadgeTone(status: PersonEmploymentStatus): "active" | "warning" | "inactive" {
  if (status === "active") {
    return "active";
  }
  if (status === "paused") {
    return "warning";
  }
  return "inactive";
}

function formatPersonAddress(person: Pick<Person, "address_formatted" | "address_postal_code" | "address_city" | "address_street" | "address_house_number" | "address_extra">): string {
  if (person.address_formatted) {
    return person.address_formatted;
  }
  const streetLine = [person.address_street, person.address_house_number].filter(Boolean).join(" ");
  const cityLine = [person.address_postal_code, person.address_city].filter(Boolean).join(" ");
  return [streetLine, person.address_extra, cityLine].filter(Boolean).join(", ");
}

function personCardMeta(person: Person): string[] {
  return [
    person.email,
    person.phone,
    person.address_city ? `Startort: ${person.address_city}` : "",
  ].filter((item): item is string => Boolean(item));
}

function personSearchText(person: Person): string {
  return [
    person.first_name,
    person.last_name,
    person.display_name,
    person.short_code,
    calendarPersonCode(person),
    personTypeLabels[person.person_type],
    person.email,
    person.phone,
    person.address_postal_code,
    person.address_city,
    person.address_street,
    person.address_house_number,
    person.address_formatted,
    personLocationStatusLabels[person.address_location_status],
    person.is_active ? "Aktiv" : "Inaktiv",
  ].filter(Boolean).join(" ").toLowerCase();
}

const personLocationStatusLabels: Record<PersonLocationStatus, string> = {
  unchecked: "Ungeprueft",
  geocoded: "Geprueft",
  ambiguous: "Nicht eindeutig",
  failed: "Fehler",
};

function formatGeocodeMeta(result: PersonGeocodeSearchResult): string {
  const place = [result.postal_code, result.city].filter(Boolean).join(" ");
  const precision = result.street || result.house_number ? "Adresse" : "Ort";
  return [place, precision].filter(Boolean).join(" · ");
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
