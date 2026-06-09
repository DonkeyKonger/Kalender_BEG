import { Save, Trash2, UserPlus, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EntityCard } from "../components/EntityCard";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { StatusBadge } from "../components/StatusBadge";
import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import type { Person, PersonCreate, PersonGeocodeSearchResult, PersonLocationStatus, PersonType } from "../types/person";
import { calendarPersonCode } from "../types/person";

const personTypeLabels: Record<PersonType, string> = {
  internal: "Intern",
  external: "Extern",
  external_temp: "Extern schnell",
};

type EditablePerson = PersonCreate & { id: number };
type DrawerState = { mode: "new" } | { mode: "edit"; personId: number } | null;
type PersonScope = "internal" | "external";

const emptyPerson: PersonCreate = {
  first_name: "",
  last_name: "",
  display_name: "",
  short_code: "",
  person_type: "internal",
  is_active: true,
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
  const canRemove = user?.role === "admin";
  const [people, setPeople] = useState<Person[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditablePerson>>({});
  const [createForm, setCreateForm] = useState<PersonCreate>(emptyPerson);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [isEditingPerson, setIsEditingPerson] = useState(false);
  const [personScope, setPersonScope] = useState<PersonScope>("internal");
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
    return people
      .filter((person) => personInScope(person, personScope))
      .filter((person) => !needle || personSearchText(person).includes(needle));
  }, [people, personScope, searchTerm]);
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

  async function savePerson(personId: number): Promise<boolean> {
    const draft = drafts[personId];
    if (!draft) {
      return false;
    }
    const validationError = validatePersonPayload(draft);
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return false;
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
      return true;
    } catch (requestError) {
      setError(readApiError(requestError, "Person konnte nicht gespeichert werden."));
      return false;
    } finally {
      setSavingPersonId(null);
    }
  }

  async function deletePerson(personId: number) {
    const confirmed = window.confirm(
      "Diese Person wird gelöscht. Bestehende Einsätze, Zeiten und Abwesenheiten bleiben historisch erhalten und werden künftig als \"gelöscht\" angezeigt. Wirklich löschen?",
    );
    if (!confirmed) {
      return;
    }

    setSavingPersonId(personId);
    setError(null);
    setMessage(null);
    try {
      await api.removePerson(personId);
      setPeople((current) => current.filter((person) => person.id !== personId));
      setDrafts((current) => {
        const next = { ...current };
        delete next[personId];
        return next;
      });
      setDrawer(null);
      setIsEditingPerson(false);
      setMessage("Person gelöscht. Historische Daten bleiben erhalten.");
    } catch (requestError) {
      setError(readApiError(requestError, "Person konnte nicht geloescht werden."));
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
    setMessage(null);
    updateDraft(personId, values as Partial<EditablePerson>);
    try {
      const updated = await api.updatePerson(personId, normalizePersonPayload(nextDraft));
      setPeople((current) =>
        current.map((person) => person.id === updated.id ? updated : person).sort(comparePeople),
      );
      setDrafts((current) => ({ ...current, [updated.id]: toEditablePerson(updated) }));
      setMessage("Startort aus Vorschlag uebernommen und gespeichert.");
    } catch (requestError) {
      setError(readApiError(requestError, "Startort konnte nicht gespeichert werden."));
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
      person_type: personScope === "external" ? "external_temp" : "internal",
    });
    setIsEditingPerson(false);
    setDrawer({ mode: "new" });
  }

  function openPersonDrawer(personId: number) {
    setIsEditingPerson(false);
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
    setDrawer(null);
  }

  return (
    <section className="persons-page">
      <div className="page-header entity-page-header">
        <div>
          <p className="eyebrow">Stammdaten</p>
          <h1>Personen</h1>
        </div>
        {canEdit && (
          <button className="icon-button" type="button" onClick={openNewPersonDrawer}>
            <UserPlus aria-hidden="true" size={17} />
            <span>Neue Person</span>
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      <div className="person-scope-tabs" role="tablist" aria-label="Personenbereich">
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
              onClick={() => openPersonDrawer(person.id)}
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
        title={selectedPerson ? isEditingPerson ? "Person bearbeiten" : "Person" : "Person"}
        subtitle={selectedPerson ? `${personTypeLabels[selectedPerson.person_type]} · ${calendarPersonCode(selectedPerson)}` : undefined}
        onClose={closeDrawer}
        actions={selectedPerson && canEdit && !isEditingPerson ? (
          <button className="icon-button secondary" type="button" onClick={() => setIsEditingPerson(true)}>
            <span>Bearbeiten</span>
          </button>
        ) : undefined}
        footer={selectedPerson ? (
          isEditingPerson && canEdit ? (
            <>
              {canRemove && (
                <button
                  className="icon-button danger danger-action"
                  disabled={savingPersonId === selectedPerson.id}
                  type="button"
                  onClick={() => void deletePerson(selectedPerson.id)}
                >
                  <Trash2 aria-hidden="true" size={16} />
                  <span>{savingPersonId === selectedPerson.id ? "Loescht..." : "Loeschen"}</span>
                </button>
              )}
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
            </>
          ) : (
            <>
              {canRemove && (
                <button
                  className="icon-button danger danger-action"
                  disabled={savingPersonId === selectedPerson.id}
                  type="button"
                  onClick={() => void deletePerson(selectedPerson.id)}
                >
                  <Trash2 aria-hidden="true" size={16} />
                  <span>{savingPersonId === selectedPerson.id ? "Loescht..." : "Loeschen"}</span>
                </button>
              )}
              <button className="icon-button secondary" type="button" onClick={closeDrawer}>
                <span>Schliessen</span>
              </button>
            </>
          )
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
            <PersonReadView person={selectedPerson} />
          )
        )}
      </EntityDetailDrawer>
    </section>
  );
}

function PersonReadView({ person }: { person: Person }) {
  const addressText = formatPersonAddress(person);
  return (
    <div className="detail-read-view">
      <section className="detail-read-section">
        <h3>Stammdaten</h3>
        <div className="detail-read-grid">
          <ReadItem label="Name" value={person.display_name || `${person.first_name} ${person.last_name}`.trim()} />
          <ReadItem label="Typ" value={personTypeLabels[person.person_type]} />
          <ReadItem label="Kuerzel" value={calendarPersonCode(person)} />
          <ReadItem label="E-Mail" value={person.email || "-"} />
          <ReadItem label="Telefon" value={person.phone || "-"} />
          <div className="detail-read-item">
            <span>Status</span>
            <strong><StatusBadge tone={person.is_active ? "active" : "inactive"}>{person.is_active ? "Aktiv" : "Inaktiv"}</StatusBadge></strong>
          </div>
        </div>
      </section>

      <section className="detail-read-section">
        <h3>Adresse / Startort</h3>
        <div className={`detail-address-card ${addressText ? "has-address" : "is-empty"}`}>
          <span>{addressText ? "Adresse hinterlegt" : "Keine Adresse hinterlegt"}</span>
          {addressText ? <strong>{addressText}</strong> : null}
        </div>
      </section>

      <section className="detail-read-section">
        <h3>Info / Notizen</h3>
        <p className={person.notes ? "detail-note" : "detail-empty"}>{person.notes || "Keine Notizen hinterlegt."}</p>
      </section>
    </div>
  );
}

function ReadItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-read-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PersonFields({
  draft,
  onChange,
  onGeocodeSelected,
}: {
  draft: PersonCreate;
  onChange: (values: Partial<PersonCreate>) => void;
  onGeocodeSelected?: (values: Partial<PersonCreate>) => void;
}) {
  const [addressSearch, setAddressSearch] = useState("");
  const [addressResults, setAddressResults] = useState<PersonGeocodeSearchResult[]>([]);
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);
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

  function markAddressUnchecked(values: Partial<PersonCreate>): Partial<PersonCreate> {
    return {
      ...values,
      address_formatted: null,
      address_latitude: null,
      address_longitude: null,
      address_location_status: "unchecked",
    };
  }

  function updateManualAddress(values: Partial<PersonCreate>) {
    setSelectedGeocodeResult(null);
    onChange(markAddressUnchecked(values));
  }

  function applyGeocodeResult(result: PersonGeocodeSearchResult) {
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
    setSelectedGeocodeResult(result);
    onChange(selectedValues);
    onGeocodeSelected?.(selectedValues);
    setAddressSearch("");
    setAddressResults([]);
    setIsSearchingAddress(false);
    setAddressSearchMessage("Startort aus Vorschlag uebernommen und geprueft.");
    (document.activeElement as HTMLElement | null)?.blur();
  }

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

      <section className="person-location-section site-location-section">
        <div>
          <h3>Adresse / Startort</h3>
          <p>Adresse suchen, passenden Treffer auswaehlen. Koordinaten werden technisch gespeichert.</p>
        </div>
        <label className="address-field site-address-search">
          <span>Adresse suchen</span>
          <input
            placeholder="z. B. Moorburger Str. 16, 21079 Hamburg"
            value={addressSearch}
            onChange={(event) => {
              setSelectedGeocodeResult(null);
              setAddressSearch(event.target.value);
            }}
          />
          {isSearchingAddress && <small>Adresse wird gesucht...</small>}
          {addressSearchMessage && <small>{addressSearchMessage}</small>}
          {addressResults.length > 0 && (
            <div className="site-address-results" role="listbox">
              {addressResults.map((result) => (
                <button
                  key={`${result.latitude}-${result.longitude}-${result.label}`}
                  type="button"
                  onClick={() => applyGeocodeResult(result)}
                >
                  <strong>{result.label}</strong>
                  <span>{formatGeocodeMeta(result)}</span>
                </button>
              ))}
            </div>
          )}
        </label>
        <label className="address-postal-field">
          <span>PLZ</span>
          <input
            value={draft.address_postal_code ?? ""}
            onChange={(event) => updateManualAddress({ address_postal_code: event.target.value || null })}
          />
        </label>
        <label className="address-city-field">
          <span>Stadt</span>
          <input
            value={draft.address_city ?? ""}
            onChange={(event) => updateManualAddress({ address_city: event.target.value || null })}
          />
        </label>
        <label className="address-street-field">
          <span>Strasse</span>
          <input
            value={draft.address_street ?? ""}
            onChange={(event) => updateManualAddress({ address_street: event.target.value || null })}
          />
        </label>
        <label className="address-house-number-field">
          <span>Hausnummer</span>
          <input
            value={draft.address_house_number ?? ""}
            onChange={(event) => updateManualAddress({ address_house_number: event.target.value || null })}
          />
        </label>
        <label className="address-extra-field address-field">
          <span>Adresszusatz / Bereich</span>
          <input
            value={draft.address_extra ?? ""}
            onChange={(event) => updateManualAddress({ address_extra: event.target.value || null })}
          />
        </label>
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

function personInScope(person: Person, scope: PersonScope): boolean {
  if (scope === "internal") {
    return person.person_type === "internal";
  }
  return person.person_type !== "internal";
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
