import { Save, UserPlus, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EntityCard } from "../components/EntityCard";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { StatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { Person, PersonCreate, PersonType } from "../types/person";
import { calendarPersonCode } from "../types/person";

const personTypeLabels: Record<PersonType, string> = {
  internal: "Intern",
  external: "Extern",
  external_temp: "Extern schnell",
};

type EditablePerson = PersonCreate & { id: number };
type DrawerState = { mode: "new" } | { mode: "edit"; personId: number } | null;

const emptyPerson: PersonCreate = {
  first_name: "",
  last_name: "",
  display_name: "",
  short_code: "",
  person_type: "internal",
  is_active: true,
  email: null,
  phone: null,
  notes: null,
};

export function PersonsPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditablePerson>>({});
  const [createForm, setCreateForm] = useState<PersonCreate>(emptyPerson);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [savingPersonId, setSavingPersonId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
      setError(readApiError(requestError, "Personen konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }

  const filteredPeople = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) {
      return people;
    }
    return people.filter((person) => personSearchText(person).includes(needle));
  }, [people, searchTerm]);

  const selectedPerson = drawer?.mode === "edit"
    ? people.find((person) => person.id === drawer.personId) ?? null
    : null;
  const selectedDraft = drawer?.mode === "edit" && selectedPerson
    ? drafts[selectedPerson.id] ?? toEditablePerson(selectedPerson)
    : null;

  async function createPerson() {
    const validationError = validatePersonPayload(createForm);
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }
    setSavingPersonId(0);
    setError(null);
    setMessage(null);
    try {
      const payload = normalizePersonPayload(createForm);
      const created = await api.createPerson(payload);
      setPeople((current) => [...current, created].sort(comparePeople));
      setDrafts((current) => ({ ...current, [created.id]: toEditablePerson(created) }));
      setCreateForm(emptyPerson);
      setDrawer(null);
      setMessage("Person angelegt.");
    } catch (requestError) {
      setError(readApiError(requestError, "Person konnte nicht angelegt werden."));
    } finally {
      setSavingPersonId(null);
    }
  }

  async function savePerson(personId: number) {
    const draft = drafts[personId];
    if (!draft) {
      return;
    }
    const validationError = validatePersonPayload(draft);
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }
    setSavingPersonId(personId);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.updatePerson(personId, normalizePersonPayload(draft));
      setPeople((current) =>
        current.map((person) => person.id === updated.id ? updated : person).sort(comparePeople),
      );
      setDrafts((current) => ({ ...current, [updated.id]: toEditablePerson(updated) }));
      setMessage("Person gespeichert.");
    } catch (requestError) {
      setError(readApiError(requestError, "Person konnte nicht gespeichert werden."));
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

  function closeDrawer() {
    setDrawer(null);
  }

  return (
    <section className="persons-page">
      <div className="page-header entity-page-header">
        <div>
          <p className="eyebrow">Stammdaten</p>
          <h1>Personen</h1>
        </div>
        <button className="icon-button" type="button" onClick={() => setDrawer({ mode: "new" })}>
          <UserPlus aria-hidden="true" size={17} />
          <span>Neue Person</span>
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      <input
        className="entity-search"
        placeholder="Person suchen"
        value={searchTerm}
        onChange={(event) => setSearchTerm(event.target.value)}
      />

      {isLoading && <div className="matrix-state">Personen werden geladen...</div>}

      {!isLoading && (
        <div className="entity-card-list">
          {filteredPeople.map((person) => (
            <EntityCard
              key={person.id}
              title={person.display_name || `${person.first_name} ${person.last_name}`.trim()}
              subtitle={`${personTypeLabels[person.person_type]} · Kuerzel: ${calendarPersonCode(person)}`}
              meta={personCardMeta(person)}
              icon={<Users aria-hidden="true" size={17} />}
              status={<StatusBadge tone={person.is_active ? "active" : "inactive"}>{person.is_active ? "Aktiv" : "Inaktiv"}</StatusBadge>}
              isInactive={!person.is_active}
              onClick={() => setDrawer({ mode: "edit", personId: person.id })}
            />
          ))}
          {!filteredPeople.length && (
            <div className="empty-panel">
              <p>{people.length ? "Keine Treffer gefunden." : "Noch keine Personen vorhanden."}</p>
            </div>
          )}
        </div>
      )}

      <EntityDetailDrawer
        isOpen={drawer?.mode === "new"}
        title="Neue Person"
        subtitle="Stammdaten anlegen"
        onClose={closeDrawer}
        footer={(
          <button className="icon-button" disabled={savingPersonId === 0} type="button" onClick={() => void createPerson()}>
            <UserPlus aria-hidden="true" size={17} />
            <span>Person anlegen</span>
          </button>
        )}
      >
        <PersonFields
          draft={createForm}
          onChange={(values) => setCreateForm((current) => ({ ...current, ...values }))}
        />
      </EntityDetailDrawer>

      <EntityDetailDrawer
        isOpen={drawer?.mode === "edit" && Boolean(selectedPerson && selectedDraft)}
        title={selectedPerson ? "Person bearbeiten" : "Person"}
        subtitle={selectedPerson ? `${personTypeLabels[selectedPerson.person_type]} · ${calendarPersonCode(selectedPerson)}` : undefined}
        onClose={closeDrawer}
        footer={selectedPerson ? (
          <button
            className="icon-button secondary"
            disabled={savingPersonId === selectedPerson.id}
            type="button"
            onClick={() => void savePerson(selectedPerson.id)}
          >
            <Save aria-hidden="true" size={16} />
            <span>Speichern</span>
          </button>
        ) : undefined}
      >
        {selectedPerson && selectedDraft && (
          <PersonFields
            draft={selectedDraft}
            onChange={(values) => updateDraft(selectedPerson.id, values)}
          />
        )}
      </EntityDetailDrawer>
    </section>
  );
}

function PersonFields({
  draft,
  onChange,
}: {
  draft: PersonCreate;
  onChange: (values: Partial<PersonCreate>) => void;
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
      <label>
        <span>Kuerzel/Suche</span>
        <input
          value={draft.short_code}
          onChange={(event) => onChange({ short_code: event.target.value })}
        />
      </label>
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
      <label className="checkbox-field">
        <input
          checked={draft.is_active}
          type="checkbox"
          onChange={(event) => onChange({ is_active: event.target.checked })}
        />
        <span>Aktiv</span>
      </label>
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
    email: person.email,
    phone: person.phone,
    notes: person.notes,
  };
}

function validatePersonPayload(person: PersonCreate): string | null {
  if (!person.first_name.trim() || !person.last_name.trim()) {
    return "Vorname und Nachname sind Pflicht.";
  }
  return null;
}

function normalizePersonPayload(person: PersonCreate): PersonCreate {
  const firstName = person.first_name.trim();
  const lastName = person.last_name.trim();
  return {
    ...person,
    first_name: firstName,
    last_name: lastName,
    display_name: person.display_name.trim() || `${firstName} ${lastName}`.trim(),
    short_code: person.short_code.trim() || `${firstName.slice(0, 1)}.${lastName}`.trim(),
    email: person.email?.trim() || null,
    phone: person.phone?.trim() || null,
    notes: person.notes?.trim() || null,
  };
}

function comparePeople(left: Person, right: Person): number {
  return left.display_name.localeCompare(right.display_name);
}

function personCardMeta(person: Person): string[] {
  return [person.email, person.phone].filter((item): item is string => Boolean(item));
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
    person.is_active ? "Aktiv" : "Inaktiv",
  ].filter(Boolean).join(" ").toLowerCase();
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
