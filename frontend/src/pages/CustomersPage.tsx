import {
  Building2,
  ChevronRight,
  Mail,
  Pencil,
  Phone,
  Plus,
  Save,
  Search,
  StickyNote,
  Trash2,
  UserRound,
  UserPlus,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { canEditMainPage } from "../auth/permissions";
import { AddressDisplayItem, AddressSearch } from "../components/AddressSearch";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { ApiError, api } from "../lib/api";
import { getSiteColorDisplayValue, getSiteColorLabel } from "../lib/siteColors";
import { compareSiteNumbers } from "../lib/siteSorting";
import type { Customer, CustomerContactInput, CustomerCreate } from "../types/customer";
import type { SiteSummary } from "../types/site";

type EditableCustomer = CustomerCreate & { id: number };
type DrawerState = { mode: "new" } | null;
type CustomerContactRow = CustomerContactInput & { key: string };

const customerContactTypeLabels: Record<string, string> = {
  monteur: "Ansprechpartner",
  bauleiter: "Bauleiter Kunde",
  einkauf: "Einkauf",
  rechnung: "Rechnung",
};

const emptyCustomer: CustomerCreate = {
  company_name: "",
  address_street: null,
  address_house_number: null,
  address_postal_code: null,
  address_city: null,
  address_country: "Deutschland",
  address_extra: null,
  address_formatted: null,
  address_latitude: null,
  address_longitude: null,
  address_location_status: "unchecked",
  company_phone: null,
  project_lead_name: null,
  project_lead_phone: null,
  project_lead_email: null,
  notes: null,
  is_active: true,
  contacts: [],
};

export function CustomersPage() {
  const { user } = useAuth();
  const canEdit = canEditMainPage(user, "customers");
  const canRemove = canEdit;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [siteSummaries, setSiteSummaries] = useState<SiteSummary[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditableCustomer>>({});
  const [createForm, setCreateForm] = useState<CustomerCreate>(emptyCustomer);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [isEditingCustomer, setIsEditingCustomer] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [letterFilter, setLetterFilter] = useState("all");
  const [sortDescending, setSortDescending] = useState(false);
  const [previewCustomerId, setPreviewCustomerId] = useState<number | null>(null);
  const [previewTab, setPreviewTab] = useState<"master" | "contacts" | "projects">("master");
  const [isLoading, setIsLoading] = useState(true);
  const [savingCustomerId, setSavingCustomerId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void loadCustomers();
  }, []);

  async function loadCustomers() {
    setIsLoading(true);
    setError(null);
    try {
      const [customerData, siteData] = await Promise.all([
        api.customers(),
        api.siteSummaries({ includeClosed: true }),
      ]);
      setCustomers(customerData);
      setSiteSummaries(siteData);
      setDrafts((current) => Object.fromEntries(customerData.map((customer) => [
        customer.id, current[customer.id] ?? toEditableCustomer(customer),
      ])));
    } catch (requestError) {
      setError(readApiError(requestError, "Kunden konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }

  const filteredCustomers = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    return customers.filter((customer) =>
      (!needle || customerSearchText(customer).includes(needle))
      && (letterFilter === "all" || customerInitial(customer.company_name) === letterFilter),
    ).sort((left, right) => compareCustomers(left, right) * (sortDescending ? -1 : 1));
  }, [customers, searchTerm, letterFilter, sortDescending]);
  const customerGroups = useMemo(() => {
    const groups = groupCustomersAlphabetically(filteredCustomers);
    return sortDescending ? groups.reverse() : groups;
  }, [filteredCustomers, sortDescending]);
  const previewCustomer = filteredCustomers.find((customer) => customer.id === previewCustomerId)
    ?? filteredCustomers[0] ?? null;

  useEffect(() => {
    setIsEditingCustomer(false);
  }, [previewCustomer?.id]);

  const selectedCustomer = previewCustomer;
  const selectedDraft = selectedCustomer
    ? drafts[selectedCustomer.id] ?? toEditableCustomer(selectedCustomer)
    : null;
  const hasPendingCustomerDraft = selectedCustomer && selectedDraft
    && JSON.stringify(normalizeCustomerPayload(selectedDraft)) !== JSON.stringify(normalizeCustomerPayload(toEditableCustomer(selectedCustomer)));
  const selectedCustomerProjects = useMemo(
    () => selectedCustomer ? customerProjects(siteSummaries, selectedCustomer.id) : [],
    [selectedCustomer, siteSummaries],
  );

  async function createCustomer() {
    const validationError = validateCustomerPayload(createForm);
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }
    setSavingCustomerId(0);
    setError(null);
    setMessage(null);
    try {
      const created = await api.createCustomer(normalizeCustomerPayload(createForm));
      setCustomers((current) => [...current, created].sort(compareCustomers));
      setDrafts((current) => ({ ...current, [created.id]: toEditableCustomer(created) }));
      setCreateForm(emptyCustomer);
      setSearchTerm("");
      setLetterFilter("all");
      setPreviewCustomerId(created.id);
      setDrawer(null);
      setMessage("Kunde angelegt.");
    } catch (requestError) {
      setError(readApiError(requestError, "Kunde konnte nicht angelegt werden."));
    } finally {
      setSavingCustomerId(null);
    }
  }

  async function saveCustomer(customerId: number): Promise<boolean> {
    const draft = drafts[customerId];
    if (!draft) {
      return false;
    }
    const validationError = validateCustomerPayload(draft);
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return false;
    }
    setSavingCustomerId(customerId);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.updateCustomer(customerId, normalizeCustomerPayload(draft));
      setCustomers((current) =>
        current.map((customer) => customer.id === updated.id ? updated : customer).sort(compareCustomers),
      );
      setDrafts((current) => ({ ...current, [updated.id]: toEditableCustomer(updated) }));
      setMessage("Kunde gespeichert.");
      return true;
    } catch (requestError) {
      setError(readApiError(requestError, "Kunde konnte nicht gespeichert werden."));
      return false;
    } finally {
      setSavingCustomerId(null);
    }
  }

  async function saveCustomerContacts(customerId: number, contacts: CustomerContactInput[]): Promise<boolean> {
    setSavingCustomerId(customerId);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.updateCustomer(customerId, { contacts });
      setCustomers((current) =>
        current.map((customer) => customer.id === updated.id ? updated : customer).sort(compareCustomers),
      );
      setDrafts((current) => ({ ...current, [updated.id]: {
        ...(current[updated.id] ?? toEditableCustomer(updated)), contacts: toEditableCustomer(updated).contacts,
      } }));
      return true;
    } catch (requestError) {
      setError(readApiError(requestError, "Kundenkontakt konnte nicht gespeichert werden."));
      return false;
    } finally {
      setSavingCustomerId(null);
    }
  }

  async function saveCustomerNotes(customerId: number, notes: string | null): Promise<boolean> {
    setSavingCustomerId(customerId);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.updateCustomer(customerId, { notes });
      setCustomers((current) =>
        current.map((customer) => customer.id === updated.id ? updated : customer).sort(compareCustomers),
      );
      setDrafts((current) => ({ ...current, [updated.id]: {
        ...(current[updated.id] ?? toEditableCustomer(updated)), notes: updated.notes,
      } }));
      return true;
    } catch (requestError) {
      setError(readApiError(requestError, "Hinweise konnten nicht gespeichert werden."));
      return false;
    } finally {
      setSavingCustomerId(null);
    }
  }

  async function removeCustomer(customerId: number) {
    const confirmed = window.confirm(
      "Kunde wirklich löschen? Der Kunde wird für alle Nutzer dauerhaft ausgeblendet und kann anschließend neu angelegt werden.",
    );
    if (!confirmed) {
      return;
    }

    setSavingCustomerId(customerId);
    setError(null);
    setMessage(null);
    try {
      await api.removeCustomer(customerId);
      await loadCustomers();
      setMessage("Kunde gelöscht.");
      setDrawer(null);
      setIsEditingCustomer(false);
    } catch (requestError) {
      setError(readApiError(requestError, "Kunde konnte nicht gelöscht werden."));
    } finally {
      setSavingCustomerId(null);
    }
  }

  function updateDraft(customerId: number, values: Partial<EditableCustomer>) {
    setDrafts((current) => ({
      ...current,
      [customerId]: { ...current[customerId], ...values },
    }));
  }

  function openNewCustomerDrawer() {
    setCreateForm(emptyCustomer);
    setIsEditingCustomer(false);
    setDrawer({ mode: "new" });
  }

  function startCustomerEdit() {
    if (!selectedCustomer) return;
    setDrafts((current) => ({ ...current, [selectedCustomer.id]: current[selectedCustomer.id] ?? toEditableCustomer(selectedCustomer) }));
    setIsEditingCustomer(true);
  }

  function cancelCustomerEdit() {
    if (selectedCustomer) {
      setDrafts((current) => ({ ...current, [selectedCustomer.id]: toEditableCustomer(selectedCustomer) }));
    }
    setIsEditingCustomer(false);
    setError(null);
  }

  function closeDrawer() {
    if (drawer?.mode === "new") {
      setCreateForm(emptyCustomer);
    }
    setIsEditingCustomer(false);
    setDrawer(null);
  }

  return (
    <section className="persons-page customers-page overview-page">
      <div className="page-header entity-page-header overview-header">
        <div>
          <p className="eyebrow">Stammdaten</p>
          <h1>Kunden</h1>
        </div>
        {canEdit && (
          <button className="icon-button overview-create" type="button" disabled={savingCustomerId !== null} onClick={openNewCustomerDrawer}>
            <UserPlus aria-hidden="true" size={17} />
            <span>Neuer Kunde</span>
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      {isLoading && <div className="matrix-state">Kunden werden geladen...</div>}

      {!isLoading && (
        <div className="customer-directory">
          <div className="customer-directory-list">
            <div className="customer-directory-tools">
              <label className="overview-search">
                <Search aria-hidden="true" size={16} />
                <input aria-label="Kunden suchen" placeholder="Kunden suchen …" value={searchTerm}
                  disabled={savingCustomerId !== null}
                  onChange={(event) => setSearchTerm(event.target.value)} />
              </label>
              <div className="customer-directory-filters">
                <div className="customer-alphabet" role="group" aria-label="Anfangsbuchstabe">
                  {["all", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"].map((letter) => (
                    <button key={letter} type="button" aria-pressed={letterFilter === letter}
                      disabled={savingCustomerId !== null}
                      onClick={() => setLetterFilter(letter)}>{letter === "all" ? "Alle" : letter}</button>
                  ))}
                </div>
                <select aria-label="Kunden sortieren" value={sortDescending ? "desc" : "asc"}
                  disabled={savingCustomerId !== null}
                  onChange={(event) => setSortDescending(event.target.value === "desc")}>
                  <option value="asc">Name A–Z</option><option value="desc">Name Z–A</option>
                </select>
              </div>
            </div>
            <div className="customer-directory-results" aria-label="Kundenliste">
              {customerGroups.length ? <>
              {customerGroups.map((group) => (
                <section className="customer-letter-group" key={group.key} aria-label={group.label}>
                  <h2>{group.label}</h2>
                    {group.customers.map((customer) => (
                      <button key={customer.id} type="button"
                        disabled={savingCustomerId !== null}
                        className={`customer-directory-row${!customer.is_active ? " is-inactive" : ""}`}
                        aria-pressed={previewCustomer?.id === customer.id}
                        onClick={() => setPreviewCustomerId(customer.id)}>
                        <Building2 aria-hidden="true" size={19} />
                        <span className="customer-directory-row-copy">
                          <strong title={customer.company_name}>{customer.company_name}</strong>
                          <span title={formatCustomerAddress(customer)}>{formatCustomerAddress(customer) || "Keine Adresse hinterlegt"}</span>
                        </span>
                        {!customer.is_active && <small>Inaktiv</small>}
                        <ChevronRight aria-hidden="true" size={16} />
                      </button>
                    ))}
                </section>
              ))}
              </> : <p className="customer-directory-empty">{customers.length ? "Keine Treffer gefunden." : "Noch keine Kunden vorhanden."}</p>}
            </div>
          </div>
          <section className="customer-preview" aria-label="Kundendetails">
            {previewCustomer ? <>
              <div className="customer-preview-actions">
                {hasPendingCustomerDraft && !isEditingCustomer && <span className="customer-preview-draft-hint">Ungespeicherter Entwurf · über Bearbeiten fortsetzen</span>}
                {canEdit && !isEditingCustomer && <button className="icon-button secondary" type="button"
                  disabled={savingCustomerId !== null} onClick={startCustomerEdit}>
                  <Pencil aria-hidden="true" size={15} /><span>Bearbeiten</span>
                </button>}
              </div>
              <header className="customer-preview-heading">
                <Building2 aria-hidden="true" size={34} />
                <div><p className="eyebrow">Kunde{!previewCustomer.is_active ? " · Inaktiv" : ""}</p><h2>{previewCustomer.company_name}</h2></div>
              </header>
              {isEditingCustomer && canEdit && selectedDraft ? <>
                <div className="customer-record-edit">
                  <CustomerFields draft={selectedDraft} onChange={(values) => updateDraft(previewCustomer.id, values)} />
                </div>
                <div className="customer-record-edit-actions">
                  {canRemove && <button className="icon-button danger danger-action" type="button"
                    disabled={savingCustomerId !== null} onClick={() => void removeCustomer(previewCustomer.id)}>
                    <Trash2 aria-hidden="true" size={16} /><span>Kunden löschen</span>
                  </button>}
                  <button className="icon-button secondary" type="button" disabled={savingCustomerId !== null}
                    onClick={cancelCustomerEdit}>Abbrechen</button>
                  <button className="icon-button secondary" type="button" disabled={savingCustomerId !== null}
                    onClick={() => void saveCustomer(previewCustomer.id).then((saved) => {
                      if (saved) setIsEditingCustomer(false);
                    })}><Save aria-hidden="true" size={16} /><span>Speichern</span></button>
                </div>
              </> : <>
              <div className="customer-preview-tabs" role="tablist" aria-label="Kundendetails">
                <button id="customer-master-tab" type="button" role="tab" aria-selected={previewTab === "master"}
                  aria-controls="customer-preview-panel" onClick={() => setPreviewTab("master")}>Stammdaten</button>
                <button id="customer-contacts-tab" type="button" role="tab" aria-selected={previewTab === "contacts"}
                  aria-controls="customer-preview-panel" onClick={() => setPreviewTab("contacts")}>Ansprechpartner</button>
                <button id="customer-projects-tab" type="button" role="tab" aria-selected={previewTab === "projects"}
                  aria-controls="customer-preview-panel" onClick={() => setPreviewTab("projects")}>Projekte</button>
              </div>
              <div className="customer-preview-body" id="customer-preview-panel" role="tabpanel"
                aria-labelledby={`customer-${previewTab}-tab`}>
                {previewTab === "master" ? <>
                  <section><h3>Anschrift</h3>
                    {customerAddressLines(previewCustomer).length
                      ? customerAddressLines(previewCustomer).map((line) => <p key={line}>{line}</p>)
                      : <p className="detail-empty">Keine Adresse hinterlegt.</p>}
                  </section>
                  <section><h3>Kontakt</h3><span className="customer-preview-phone-label">Telefon</span>
                    <CustomerPhoneLink phone={previewCustomer.company_phone} />
                  </section>
                  <CustomerNotesSection key={previewCustomer.id} canEdit={canEdit}
                    isSaving={savingCustomerId === previewCustomer.id} notes={previewCustomer.notes}
                    onSaveNotes={(notes) => saveCustomerNotes(previewCustomer.id, notes)} />
                </> : previewTab === "projects" ? <CustomerProjectsList projects={selectedCustomerProjects} /> : <CustomerContactEditor key={previewCustomer.id} canEdit={canEdit}
                  contactRows={customerContactRows(previewCustomer)} isSaving={savingCustomerId === previewCustomer.id}
                  onSaveContacts={(contacts) => saveCustomerContacts(previewCustomer.id, contacts)} />}
              </div>
              </>}
            </> : <p className="customer-directory-empty">Wählen Sie einen Kunden aus der Liste.</p>}
          </section>
        </div>
      )}

      <EntityDetailDrawer
        isOpen={drawer?.mode === "new"}
        title="Neuer Kunde"
        subtitle="Kundenstammdaten anlegen"
        onClose={closeDrawer}
        footer={(
          <button className="icon-button" disabled={savingCustomerId === 0} type="button" onClick={() => void createCustomer()}>
            <UserPlus aria-hidden="true" size={17} />
            <span>Kunde anlegen</span>
          </button>
        )}
      >
        <CustomerFields
          draft={createForm}
          onChange={(values) => setCreateForm((current) => ({ ...current, ...values }))}
        />
      </EntityDetailDrawer>

    </section>
  );
}


function CustomerNotesSection({
  canEdit,
  isSaving,
  notes,
  onSaveNotes,
}: {
  canEdit: boolean;
  isSaving: boolean;
  notes: string | null;
  onSaveNotes: (notes: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(notes ?? "");

  useEffect(() => {
    setDraft(notes ?? "");
  }, [notes]);

  async function persistNotes() {
    const normalizedDraft = draft.trim() || null;
    const normalizedSource = notes?.trim() || null;
    if (normalizedDraft === normalizedSource) {
      return;
    }
    const saved = await onSaveNotes(normalizedDraft);
    if (!saved) {
      setDraft(notes ?? "");
    }
  }

  return (
    <section className="detail-read-section customer-notes-section">
      <div className="customer-detail-section-heading">
        <StickyNote aria-hidden="true" size={17} />
        <h3>Hinweise</h3>
      </div>
      <textarea
        className="customer-notes-textarea"
        aria-label="Interne Hinweise zum Kunden"
        disabled={!canEdit || isSaving}
        placeholder="Interne Hinweise zum Kunden..."
        rows={3}
        value={draft}
        onBlur={() => void persistNotes()}
        onChange={(event) => setDraft(event.target.value)}
      />
    </section>
  );
}

function CustomerProjectsList({ projects }: { projects: SiteSummary[] }) {
  if (!projects.length) {
    return <p className="detail-empty">Keine Projekte zugeordnet.</p>;
  }

  return (
    <div className="customer-project-table-wrap">
      <table className="customer-project-table">
        <thead>
          <tr>
            <th scope="col">Nummer</th>
            <th scope="col">Baustelle</th>
            <th scope="col">Größe</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((site) => {
            const sizeLabel = getSiteColorLabel(site.color);
            return (
              <tr key={site.id}>
                <td>
                  <Link className="customer-project-number-link" to={`/sites/${site.id}`}>
                    {site.site_number ?? "-"}
                  </Link>
                </td>
                <td>
                  <Link className="customer-project-name-link" to={`/sites/${site.id}`} title={site.name}>
                    {site.name}
                  </Link>
                </td>
                <td>
                  {sizeLabel ? (
                    <span className="customer-project-size">
                      <span className="site-color-swatch" style={{ backgroundColor: getSiteColorDisplayValue(site.color) }} />
                      <span>{sizeLabel}</span>
                    </span>
                  ) : (
                    <span className="customer-project-empty-value">-</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}


function CustomerContactEditor({
  canEdit,
  contactRows,
  isSaving,
  onSaveContacts,
}: {
  canEdit: boolean;
  contactRows: CustomerContactRow[];
  isSaving: boolean;
  onSaveContacts: (contacts: CustomerContactInput[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<CustomerContactRow | null>(null);
  const [contactSearch, setContactSearch] = useState("");
  const isNew = draft?.key === "new";
  const rows = isNew ? [...contactRows, draft] : contactRows;
  const visibleRows = rows.filter((item) => item.key === draft?.key || matchesCustomerContactSearch(item, contactSearch));

  function updateContact(values: Partial<CustomerContactInput>) {
    setDraft((current) => current ? { ...current, ...values } : current);
  }

  async function saveContact() {
    if (!canEdit || isSaving || !draft) return;
    const nextRows = isNew ? [...contactRows, draft] : contactRows.map((row) => row.key === draft.key ? draft : row);
    const payload = normalizeCustomerContactsPayload(nextRows);
    if (customerContactsKey(payload) === customerContactsKey(contactRows) || await onSaveContacts(payload)) {
      setDraft(null);
    }
  }

  return (
    <div className="customer-contact-editor">
      <label className="overview-search customer-contact-search">
        <Search aria-hidden="true" size={17} />
        <input type="search" aria-label="Ansprechpartner suchen" placeholder="Name, Rolle, E-Mail oder Telefon suchen …"
          value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} />
      </label>
      {visibleRows.length ? (
        <div className="customer-contact-cards">
          {visibleRows.map((item) => (
            <article className="customer-contact-card" aria-label={item.name?.trim() || "Ansprechpartner ohne Namen"} key={item.key}>
              <header className="customer-contact-card-heading">
                <span className="customer-contact-avatar" aria-hidden="true"><UserRound size={22} /></span>
                <div className="customer-contact-identity">
                  <h3>{item.name?.trim() || (item.key === "new" ? "Neuer Ansprechpartner" : "-")}</h3>
                  <p>{displayCustomerContactRole(item.contact_type) || "Ansprechpartner"}</p>
                </div>
                {canEdit && draft?.key !== item.key && <button className="icon-button secondary customer-contact-edit-button"
                  type="button" aria-label={`Kontakt bearbeiten: ${item.name?.trim() || item.email || "Ansprechpartner"}`}
                  disabled={isSaving || draft !== null} onClick={() => setDraft({ ...item })}>
                  <Pencil aria-hidden="true" size={15} />
                </button>}
              </header>
              {canEdit && draft?.key === item.key ? (
                <form className="customer-contact-card-form" onSubmit={(event) => { event.preventDefault(); void saveContact(); }}
                  onKeyDown={(event) => { if (event.key === "Escape" && !isSaving) { event.preventDefault(); setDraft(null); } }}>
                  <div className="customer-contact-card-fields">
                    <label>Name<input autoFocus disabled={isSaving} placeholder="Vor- und Nachname" value={draft.name ?? ""}
                      onChange={(event) => updateContact({ name: event.target.value })} /></label>
                    <label>Rolle<input disabled={isSaving} placeholder="z. B. Projektleiter" value={displayCustomerContactRole(draft.contact_type)}
                      onChange={(event) => updateContact({ contact_type: event.target.value })} /></label>
                    <label>E-Mail<input disabled={isSaving} type="email" placeholder="name@firma.de" value={draft.email ?? ""}
                      onChange={(event) => updateContact({ email: event.target.value })} /></label>
                    <label>Telefon<input disabled={isSaving} type="tel" placeholder="Telefonnummer" value={draft.phone ?? ""}
                      onChange={(event) => updateContact({ phone: event.target.value })} /></label>
                  </div>
                  <div className="customer-contact-card-actions">
                    {!isNew && <button aria-label="Kontakt entfernen" className="icon-button danger customer-contact-delete-button" type="button"
                      disabled={isSaving} onClick={() => { void onSaveContacts(normalizeCustomerContactsPayload(contactRows.filter((row) => row.key !== item.key)))
                        .then((saved) => { if (saved) setDraft(null); }); }}><Trash2 aria-hidden="true" size={15} /></button>}
                    <button className="icon-button secondary" type="button" disabled={isSaving} onClick={() => setDraft(null)}>Abbrechen</button>
                    <button className="icon-button secondary" type="submit" disabled={isSaving || ![draft.name, draft.email, draft.phone].some((value) => value?.trim())}>
                      <Save aria-hidden="true" size={15} /><span>Speichern</span>
                    </button>
                  </div>
                </form>
              ) : <div className="customer-contact-channels">
                {item.email?.trim() ? <a href={`mailto:${item.email.trim()}`}><Mail aria-hidden="true" size={16} /><span>{item.email}</span></a>
                  : <span className="customer-contact-missing"><Mail aria-hidden="true" size={16} />Keine E-Mail hinterlegt</span>}
                {item.phone?.trim() ? <CustomerPhoneLink phone={item.phone} />
                  : <span className="customer-contact-missing"><Phone aria-hidden="true" size={16} />Keine Telefonnummer hinterlegt</span>}
              </div>}
            </article>
          ))}
        </div>
      ) : (
        <p className="detail-empty">{contactRows.length ? "Keine passenden Ansprechpartner gefunden." : "Keine Kontakte hinterlegt."}</p>
      )}
      {canEdit && (
        <button className="icon-button secondary customer-contact-add-button" disabled={isSaving || draft !== null} type="button"
          onClick={() => { setContactSearch(""); setDraft({ key: "new", contact_type: null, name: null, phone: null, email: null }); }}>
          <Plus aria-hidden="true" size={15} />
          <span>Kontakt hinzufügen</span>
        </button>
      )}
    </div>
  );
}

function matchesCustomerContactSearch(contact: CustomerContactInput, search: string): boolean {
  const needle = search.trim().toLocaleLowerCase("de");
  return !needle || [contact.name, displayCustomerContactRole(contact.contact_type), contact.email, contact.phone]
    .some((value) => value?.toLocaleLowerCase("de").includes(needle));
}

function CustomerPhoneLink({ phone }: { phone: string | null | undefined }) {
  if (!phone) {
    return <strong>-</strong>;
  }

  return (
    <a className="customer-detail-phone-link" href={`tel:${phone.replace(/\s+/g, "")}`}>
      <Phone aria-hidden="true" size={16} />
      <span>{phone}</span>
    </a>
  );
}

export function CustomerFields({
  draft,
  onChange,
}: {
  draft: CustomerCreate;
  onChange: (values: Partial<CustomerCreate>) => void;
}) {
  return (
    <div className="person-form-grid customer-form-grid">
      <label className="customer-company-field">
        <span>Firmenname</span>
        <input
          value={draft.company_name}
          onChange={(event) => onChange({ company_name: event.target.value })}
        />
      </label>
      <label>
        <span>Firmentelefon</span>
        <input
          value={draft.company_phone ?? ""}
          onChange={(event) => onChange({ company_phone: event.target.value || null })}
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
          <h3>Firmenadresse</h3>
        </div>
        <AddressSearch
          inputName="customer-address-query"
          onSelect={(result) => {
            onChange({
              address_formatted: result.label,
              address_postal_code: result.postal_code,
              address_city: result.city,
              address_street: result.street,
              address_house_number: result.house_number,
              address_country: draft.address_country || "Deutschland",
              address_extra: draft.address_extra ?? null,
              address_latitude: result.latitude,
              address_longitude: result.longitude,
              address_location_status: "geocoded",
            });
          }}
        />
        <div className="site-address-display-grid">
          <AddressDisplayItem label="PLZ" value={draft.address_postal_code} />
          <AddressDisplayItem label="Stadt" value={draft.address_city} />
          <AddressDisplayItem label="Strasse" value={draft.address_street} />
          <AddressDisplayItem label="Hausnummer" value={draft.address_house_number} />
          <AddressDisplayItem label="Land" value={draft.address_country} />
          <AddressDisplayItem label="Adresszusatz / Bereich" value={draft.address_extra} wide />
        </div>
      </section>
    </div>
  );
}

function toEditableCustomer(customer: Customer): EditableCustomer {
  return {
    id: customer.id,
    company_name: customer.company_name,
    address_street: customer.address_street,
    address_house_number: customer.address_house_number,
    address_postal_code: customer.address_postal_code,
    address_city: customer.address_city,
    address_country: customer.address_country ?? "Deutschland",
    address_extra: customer.address_extra,
    address_formatted: customer.address_formatted,
    address_latitude: customer.address_latitude,
    address_longitude: customer.address_longitude,
    address_location_status: customer.address_location_status ?? "unchecked",
    company_phone: customer.company_phone,
    project_lead_name: customer.project_lead_name,
    project_lead_phone: customer.project_lead_phone,
    project_lead_email: customer.project_lead_email,
    notes: customer.notes,
    is_active: customer.is_active,
    contacts: customer.contacts.map((contact) => ({
      contact_type: contact.contact_type,
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
    })),
  };
}

export function validateCustomerPayload(customer: CustomerCreate): string | null {
  if (!customer.company_name.trim()) {
    return "Firmenname ist Pflicht.";
  }
  if (!isValidOptionalEmail(customer.project_lead_email)) {
    return "Projektleiter-Mail ist nicht gueltig.";
  }
  for (const contact of customer.contacts) {
    const hasContactData = Boolean(
      contact.name?.trim()
      || contact.phone?.trim()
      || contact.email?.trim(),
    );
    if (!hasContactData) {
      continue;
    }
    if (!isValidOptionalEmail(contact.email)) {
      return "Ansprechpartner-Mail ist nicht gueltig.";
    }
  }
  return null;
}

export function normalizeCustomerPayload(customer: CustomerCreate): CustomerCreate {
  return {
    company_name: customer.company_name.trim(),
    address_street: customer.address_street?.trim() || null,
    address_house_number: customer.address_house_number?.trim() || null,
    address_postal_code: customer.address_postal_code?.trim() || null,
    address_city: customer.address_city?.trim() || null,
    address_country: customer.address_country?.trim() || "Deutschland",
    address_extra: customer.address_extra?.trim() || null,
    address_formatted: customer.address_formatted?.trim() || null,
    address_latitude: customer.address_latitude,
    address_longitude: customer.address_longitude,
    address_location_status: customer.address_location_status,
    company_phone: customer.company_phone?.trim() || null,
    project_lead_name: customer.project_lead_name?.trim() || null,
    project_lead_phone: customer.project_lead_phone?.trim() || null,
    project_lead_email: customer.project_lead_email?.trim() || null,
    notes: customer.notes?.trim() || null,
    is_active: customer.is_active,
    contacts: customer.contacts
      .map((contact) => ({
        contact_type: contact.contact_type?.trim() || null,
        name: contact.name?.trim() || null,
        phone: contact.phone?.trim() || null,
        email: contact.email?.trim() || null,
      }))
      .filter((contact) => Boolean(contact.name || contact.phone || contact.email)),
  };
}

function isValidOptionalEmail(value: string | null): boolean {
  return !value || value.includes("@");
}

function compareCustomers(left: Customer, right: Customer): number {
  return left.company_name.localeCompare(right.company_name, "de");
}

function customerInitial(name: string): string {
  const firstLetter = name.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0).toUpperCase();
  return /^[A-Z]$/.test(firstLetter) ? firstLetter : "#";
}

function groupCustomersAlphabetically(customers: Customer[]): Array<{ key: string; label: string; customers: Customer[] }> {
  const groups = new Map<string, Customer[]>();
  customers.forEach((customer) => {
    const key = customerInitial(customer.company_name);
    groups.set(key, [...(groups.get(key) ?? []), customer]);
  });
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right, "de"))
    .map(([key, groupCustomers]) => ({
      key,
      label: key === "#" ? "Sonstige" : key,
      customers: groupCustomers,
    }));
}

function customerProjects(sites: SiteSummary[], customerId: number): SiteSummary[] {
  return sites
    .filter((site) => site.customer_id === customerId && site.status !== "deleted")
    .sort(compareCustomerProjects);
}

function compareCustomerProjects(left: SiteSummary, right: SiteSummary): number {
  return compareSiteNumbers(left.site_number, right.site_number)
    || left.name.localeCompare(right.name, "de")
    || left.id - right.id;
}

function formatCustomerAddress(customer: Pick<Customer, "address_street" | "address_house_number" | "address_postal_code" | "address_city" | "address_country" | "address_formatted">): string {
  if (customer.address_formatted?.trim()) {
    return customer.address_formatted.trim();
  }
  const streetLine = [customer.address_street, customer.address_house_number].filter(Boolean).join(" ");
  const cityLine = [customer.address_postal_code, customer.address_city].filter(Boolean).join(" ");
  return [streetLine, cityLine, customer.address_country].filter(Boolean).join(", ");
}

function customerAddressLines(customer: Pick<Customer, "address_street" | "address_house_number" | "address_postal_code" | "address_city" | "address_country" | "address_formatted">): string[] {
  const streetLine = [customer.address_street, customer.address_house_number].filter(Boolean).join(" ").trim();
  const cityLine = [customer.address_postal_code, customer.address_city].filter(Boolean).join(" ").trim();
  const country = customer.address_country?.trim();
  const formatted = customer.address_formatted?.trim();

  if (!streetLine && !cityLine) {
    return formatted ? [formatted] : [];
  }

  const structuredLines = [
    streetLine,
    [cityLine, country].filter(Boolean).join(", "),
  ].filter(Boolean);

  return structuredLines;
}

function customerContactRows(customer: Customer): CustomerContactRow[] {
  const rows: CustomerContactRow[] = [];
  const rowIndexByEmail = new Map<string, number>();

  const addRow = (row: CustomerContactRow) => {
    const emailKey = normalizeCustomerContactEmailKey(row.email);
    if (emailKey) {
      const existingIndex = rowIndexByEmail.get(emailKey);
      if (existingIndex !== undefined) {
        rows[existingIndex] = mergeCustomerContactRows(rows[existingIndex], row);
        return;
      }
      rowIndexByEmail.set(emailKey, rows.length);
    }
    rows.push(row);
  };

  for (const contact of customer.contacts) {
    addRow({
      key: `contact:${contact.id}`,
      contact_type: contact.contact_type,
      name: customerContactNameFromEmailLabel(contact.name),
      phone: contact.phone,
      email: contact.email,
    });
  }

  for (const emailAddress of customer.email_addresses) {
    const email = emailAddress.email?.trim();
    if (!email) {
      continue;
    }
    const label = customerContactNameFromEmailLabel(emailAddress.label);
    addRow({
      key: `email:${email.toLowerCase()}`,
      contact_type: null,
      name: label,
      phone: null,
      email,
    });
  }

  return rows;
}

function mergeCustomerContactRows(existing: CustomerContactRow, incoming: CustomerContactRow): CustomerContactRow {
  return {
    ...existing,
    name: existing.name?.trim() ? existing.name : incoming.name,
    phone: existing.phone?.trim() ? existing.phone : incoming.phone,
    contact_type: existing.contact_type?.trim() ? existing.contact_type : incoming.contact_type,
    email: existing.email?.trim() ? existing.email : incoming.email,
  };
}

function customerContactNameFromEmailLabel(value: string | null | undefined): string | null {
  const label = value?.trim();
  if (!label) {
    return null;
  }
  const normalizedLabel = label.toLowerCase();
  if (normalizedLabel === "mobile e-mail" || normalizedLabel === "projektleiter kunde") {
    return null;
  }
  return label;
}

function normalizeCustomerContactsPayload(rows: Array<CustomerContactInput | CustomerContactRow>): CustomerContactInput[] {
  const contacts: CustomerContactInput[] = [];
  const contactIndexByEmail = new Map<string, number>();

  for (const row of rows) {
    const contact: CustomerContactInput = {
      contact_type: row.contact_type?.trim() || null,
      name: row.name?.trim() || null,
      phone: row.phone?.trim() || null,
      email: row.email?.trim() || null,
    };
    if (!contact.name && !contact.phone && !contact.email) {
      continue;
    }
    const emailKey = normalizeCustomerContactEmailKey(contact.email);
    if (emailKey) {
      const existingIndex = contactIndexByEmail.get(emailKey);
      if (existingIndex !== undefined) {
        contacts[existingIndex] = mergeCustomerContactRows(
          { ...contacts[existingIndex], key: "existing" },
          { ...contact, key: "incoming" },
        );
        continue;
      }
      contactIndexByEmail.set(emailKey, contacts.length);
    }
    contacts.push(contact);
  }

  return contacts;
}

function customerContactsKey(rows: Array<CustomerContactInput | CustomerContactRow>): string {
  return normalizeCustomerContactsPayload(rows)
    .map((row) => [
      row.email?.trim().toLowerCase() ?? "",
      row.name?.trim() ?? "",
      row.phone?.trim() ?? "",
      row.contact_type?.trim() ?? "",
    ].join("\u0000"))
    .join("\u0001");
}

function normalizeCustomerContactEmailKey(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function displayCustomerContactRole(value: string | null | undefined): string {
  const role = value?.trim();
  if (!role) {
    return "";
  }
  if (role === "mobile_email") {
    return "";
  }
  return customerContactTypeLabels[role] ?? role;
}

function customerSearchText(customer: Customer): string {
  return [
    customer.company_name,
    customer.company_phone,
    customer.address_street,
    customer.address_house_number,
    customer.address_postal_code,
    customer.address_city,
    customer.address_country,
    customer.address_extra,
    customer.address_formatted,
    customer.project_lead_name,
    customer.project_lead_phone,
    customer.project_lead_email,
    customer.is_active ? "Aktiv" : "Inaktiv",
    ...customer.contacts.flatMap((contact) => [
      contact.name,
      contact.phone,
      contact.email,
      displayCustomerContactRole(contact.contact_type),
    ]),
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
