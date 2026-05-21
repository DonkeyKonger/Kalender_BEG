import { Save, UserPlus, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EntityCard } from "../components/EntityCard";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { StatusBadge } from "../components/StatusBadge";
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
            onGeocodeSelected={(values) => void applyGeocodedPerson(selectedPerson.id, values)}
          />
        )}
      </EntityDetailDrawer>
    </section>
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
  const [addressSearch, setAddressSearch] = useState(draft.address_formatted ?? "");
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
    setAddressSearch(result.label);
    setAddressResults([]);
    setAddressSearchMessage("Startort aus Vorschlag uebernommen und geprueft.");
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
        <label>
          <span>PLZ</span>
          <input
            value={draft.address_postal_code ?? ""}
            onChange={(event) => updateManualAddress({ address_postal_code: event.target.value || null })}
          />
        </label>
        <label>
          <span>Stadt</span>
          <input
            value={draft.address_city ?? ""}
            onChange={(event) => updateManualAddress({ address_city: event.target.value || null })}
          />
        </label>
        <label>
          <span>Strasse</span>
          <input
            value={draft.address_street ?? ""}
            onChange={(event) => updateManualAddress({ address_street: event.target.value || null })}
          />
        </label>
        <label>
          <span>Hausnummer</span>
          <input
            value={draft.address_house_number ?? ""}
            onChange={(event) => updateManualAddress({ address_house_number: event.target.value || null })}
          />
        </label>
        <label className="address-field">
          <span>Adresszusatz / Bereich</span>
          <input
            value={draft.address_extra ?? ""}
            onChange={(event) => updateManualAddress({ address_extra: event.target.value || null })}
          />
        </label>
        <div className="site-location-readonly">
          <span>Standortstatus</span>
          <strong>{personLocationStatusLabels[draft.address_location_status]}</strong>
        </div>
        <div className="site-location-readonly">
          <span>Koordinaten</span>
          <strong>{formatCoordinates(draft.address_latitude, draft.address_longitude)}</strong>
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

function formatCoordinates(latitude: number | null, longitude: number | null): string {
  if (latitude === null || longitude === null) {
    return "Noch nicht geprueft";
  }
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

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
