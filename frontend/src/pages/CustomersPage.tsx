import {
  ArrowLeft,
  Briefcase,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Save,
  Search,
  StickyNote,
  Trash2,
  Users,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { AddressDisplayItem, AddressSearch } from "../components/AddressSearch";
import { EntityCard } from "../components/EntityCard";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { ApiError, api } from "../lib/api";
import { getSiteColorLabel } from "../lib/siteColors";
import { compareSiteNumbers } from "../lib/siteSorting";
import type { Customer, CustomerContactInput, CustomerCreate } from "../types/customer";
import type { SiteSummary } from "../types/site";

type EditableCustomer = CustomerCreate & { id: number };
type DrawerState = { mode: "new" } | { mode: "edit"; customerId: number } | null;
type CustomerDetailSubviewKey = "contacts" | "projects";
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
  const canEdit = user?.role === "admin" || user?.role === "project_manager";
  const canRemove = user?.role === "admin";
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [siteSummaries, setSiteSummaries] = useState<SiteSummary[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditableCustomer>>({});
  const [createForm, setCreateForm] = useState<CustomerCreate>(emptyCustomer);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [isEditingCustomer, setIsEditingCustomer] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
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
      setDrafts(toEditableCustomers(customerData));
    } catch (requestError) {
      setError(readApiError(requestError, "Kunden konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }

  const filteredCustomers = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) {
      return customers;
    }
    return customers.filter((customer) => customerSearchText(customer).includes(needle));
  }, [customers, searchTerm]);
  const customerGroups = useMemo(() => groupCustomersAlphabetically(filteredCustomers), [filteredCustomers]);

  const selectedCustomer = drawer?.mode === "edit"
    ? customers.find((customer) => customer.id === drawer.customerId) ?? null
    : null;
  const selectedDraft = drawer?.mode === "edit" && selectedCustomer
    ? drafts[selectedCustomer.id] ?? toEditableCustomer(selectedCustomer)
    : null;
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
      setDrafts((current) => ({ ...current, [updated.id]: toEditableCustomer(updated) }));
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
      setDrafts((current) => ({ ...current, [updated.id]: toEditableCustomer(updated) }));
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

  function openCustomerDrawer(customerId: number) {
    setIsEditingCustomer(false);
    setDrawer({ mode: "edit", customerId });
  }

  function cancelCustomerEdit() {
    if (selectedCustomer) {
      setDrafts((current) => ({ ...current, [selectedCustomer.id]: toEditableCustomer(selectedCustomer) }));
    }
    setIsEditingCustomer(false);
    setError(null);
  }

  function closeDrawer() {
    if (drawer?.mode === "edit" && selectedCustomer) {
      setDrafts((current) => ({ ...current, [selectedCustomer.id]: toEditableCustomer(selectedCustomer) }));
    }
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
          <button className="icon-button overview-create" type="button" onClick={openNewCustomerDrawer}>
            <UserPlus aria-hidden="true" size={17} />
            <span>Neuer Kunde</span>
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      <div className="overview-toolbar">
        <div className="overview-toolbar-left">
          <label className="overview-search">
            <Search aria-hidden="true" size={17} />
            <input
              placeholder="Kunde suchen"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>
        </div>
      </div>

      {isLoading && <div className="matrix-state">Kunden werden geladen...</div>}

      {!isLoading && (
        <>
          {customerGroups.length ? (
            <div className="overview-group-list">
              {customerGroups.map((group) => (
                <section className="overview-group-section" key={group.key}>
                  <div className="overview-group-header">
                    <h2>
                      <ChevronDown aria-hidden="true" size={16} />
                      <span>{group.label}</span>
                    </h2>
                    <span className="overview-group-count">{group.customers.length}</span>
                  </div>
                  <div className="entity-card-list overview-card-grid">
                    {group.customers.map((customer) => (
                      <EntityCard
                        key={customer.id}
                        className="overview-card customer-overview-card"
                        color={customer.is_active ? "#1d5c99" : "#94a3b8"}
                        title={customer.company_name}
                        subtitle={formatCustomerAddress(customer) || "Keine Adresse hinterlegt"}
                        meta={customerCardMeta(customer)}
                        icon={<Building2 aria-hidden="true" size={17} />}
                        isInactive={!customer.is_active}
                        onClick={() => openCustomerDrawer(customer.id)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="empty-panel">
              <p>{customers.length ? "Keine Treffer gefunden." : "Noch keine Kunden vorhanden."}</p>
            </div>
          )}
        </>
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

      <EntityDetailDrawer
        isOpen={drawer?.mode === "edit" && Boolean(selectedCustomer && selectedDraft)}
        ariaLabel={selectedCustomer && !isEditingCustomer ? `Kunde ${selectedCustomer.company_name}` : undefined}
        title={selectedCustomer ? isEditingCustomer ? "Kunde bearbeiten" : undefined : "Kunde"}
        subtitle={selectedCustomer && isEditingCustomer ? selectedCustomer.company_name : undefined}
        onClose={closeDrawer}
        actions={selectedCustomer && canEdit && !isEditingCustomer ? (
          <button
            className="icon-button secondary"
            type="button"
            onClick={() => {
              setIsEditingCustomer(true);
            }}
          >
            <Pencil aria-hidden="true" size={16} />
            <span>Bearbeiten</span>
          </button>
        ) : undefined}
        footer={selectedCustomer && isEditingCustomer && canEdit ? (
          <>
            {canRemove && (
              <button
                className="icon-button danger danger-action"
                disabled={savingCustomerId === selectedCustomer.id}
                type="button"
                onClick={() => void removeCustomer(selectedCustomer.id)}
              >
                <Trash2 aria-hidden="true" size={16} />
                <span>Kunden löschen</span>
              </button>
            )}
            <button className="icon-button secondary" disabled={savingCustomerId === selectedCustomer.id} type="button" onClick={cancelCustomerEdit}>
              <span>Abbrechen</span>
            </button>
            <button
              className="icon-button secondary"
              disabled={savingCustomerId === selectedCustomer.id}
              type="button"
              onClick={() => {
                void saveCustomer(selectedCustomer.id).then((saved) => {
                  if (saved) {
                    setIsEditingCustomer(false);
                  }
                });
              }}
            >
              <Save aria-hidden="true" size={16} />
              <span>Speichern</span>
            </button>
          </>
        ) : undefined}
      >
        {selectedCustomer && selectedDraft && (
          isEditingCustomer ? (
            <div className="detail-read-view customer-detail-subview">
              <button className="icon-button secondary customer-detail-back-button" type="button" onClick={cancelCustomerEdit}>
                <ArrowLeft aria-hidden="true" size={16} />
                <span>Zurück</span>
              </button>
              <CustomerFields
                draft={selectedDraft}
                onChange={(values) => updateDraft(selectedCustomer.id, values)}
              />
            </div>
          ) : (
            <CustomerReadView
              canEdit={canEdit}
              customer={selectedCustomer}
              isSaving={savingCustomerId === selectedCustomer.id}
              projects={selectedCustomerProjects}
              onSaveContacts={(contacts) => saveCustomerContacts(selectedCustomer.id, contacts)}
              onSaveNotes={(notes) => saveCustomerNotes(selectedCustomer.id, notes)}
            />
          )
        )}
      </EntityDetailDrawer>
    </section>
  );
}

function CustomerReadView({
  canEdit,
  customer,
  isSaving,
  projects,
  onSaveContacts,
  onSaveNotes,
}: {
  canEdit: boolean;
  customer: Customer;
  isSaving: boolean;
  projects: SiteSummary[];
  onSaveContacts: (contacts: CustomerContactInput[]) => Promise<boolean>;
  onSaveNotes: (notes: string | null) => Promise<boolean>;
}) {
  const contactRows = customerContactRows(customer);
  const addressLines = customerAddressLines(customer);
  const hasAddress = addressLines.length > 0;
  const [activeSubview, setActiveSubview] = useState<CustomerDetailSubviewKey | null>(null);

  useEffect(() => {
    setActiveSubview(null);
  }, [customer.id]);

  const subviewTitle = activeSubview === "contacts"
    ? "Ansprechpartner / Kontakte"
    : activeSubview === "projects"
      ? "Projekte"
      : "";

  return (
    <div className="detail-read-view customer-detail-view">
      <div className="customer-detail-main" aria-hidden={activeSubview ? true : undefined}>
        <section className="detail-read-section customer-detail-master-section">
          <div className="customer-detail-master-grid">
            <CustomerDetailField label="Firmenname">
              <strong>{customer.company_name}</strong>
            </CustomerDetailField>
            <CustomerDetailField label="Firmentelefon">
              <CustomerPhoneLink phone={customer.company_phone} />
            </CustomerDetailField>
          </div>
        </section>

        <section className="detail-read-section customer-detail-address-section">
          <div className="customer-detail-section-heading">
            <h3>Firmenadresse</h3>
          </div>
          <div className={`customer-address-panel ${hasAddress ? "has-address" : "is-empty"}`}>
            <div className="customer-address-status">
              <CheckCircle2 aria-hidden="true" size={16} />
              <span>{hasAddress ? "Adresse hinterlegt" : "Keine Adresse hinterlegt"}</span>
            </div>
            {hasAddress ? (
              <div className="customer-address-lines">
                <MapPin aria-hidden="true" size={18} />
                <div>
                  {addressLines.map((line) => <strong key={line}>{line}</strong>)}
                </div>
              </div>
            ) : (
              <p className="detail-empty">Noch keine Firmenadresse hinterlegt.</p>
            )}
          </div>
        </section>

        <CustomerNotesSection
          canEdit={canEdit}
          isSaving={isSaving}
          notes={customer.notes}
          onSaveNotes={onSaveNotes}
        />

        <section className="detail-read-section customer-detail-nav-section">
          <CustomerDetailNavItem
            icon={Users}
            onOpen={() => setActiveSubview("contacts")}
            title="Ansprechpartner / Kontakte"
            preview={contactRows.length
              ? `${contactRows.length} Kontakt${contactRows.length === 1 ? "" : "e"} hinterlegt`
              : "Keine Kontakte hinterlegt"}
          />
          <CustomerDetailNavItem
            icon={Briefcase}
            onOpen={() => setActiveSubview("projects")}
            title="Projekte"
            preview={projects.length
              ? `${projects.length} Projekt${projects.length === 1 ? "" : "e"} zugeordnet`
              : "Keine Projekte zugeordnet"}
          />
        </section>
      </div>

      {activeSubview && (
        <CustomerDetailSubpage title={subviewTitle} onBack={() => setActiveSubview(null)}>
          {activeSubview === "projects" ? (
            <CustomerProjectsList projects={projects} />
          ) : (
            <CustomerContactEditor
              canEdit={canEdit}
              contactRows={contactRows}
              isSaving={isSaving}
              onSaveContacts={onSaveContacts}
            />
          )}
        </CustomerDetailSubpage>
      )}
    </div>
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
                      <span className="site-color-swatch" style={{ backgroundColor: site.color ?? "#94a3b8" }} />
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

function CustomerDetailNavItem({
  icon: Icon,
  title,
  preview,
  onOpen,
}: {
  icon: LucideIcon;
  title: string;
  preview: string;
  onOpen: () => void;
}) {
  return (
    <button className="customer-detail-nav-button" type="button" onClick={onOpen}>
      <span className="customer-detail-nav-icon">
        <Icon aria-hidden="true" size={18} />
      </span>
      <span className="customer-detail-nav-copy">
        <span className="customer-detail-nav-title">{title}</span>
        <span className="customer-detail-nav-preview">{preview}</span>
      </span>
      <ChevronRight aria-hidden="true" size={17} />
    </button>
  );
}

function CustomerDetailSubpage({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <section className="customer-detail-subpage" aria-label={title}>
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
  const sourceKey = customerContactsKey(contactRows);
  const [rows, setRows] = useState<CustomerContactRow[]>(() => contactRows.map((item) => ({ ...item })));

  useEffect(() => {
    setRows(contactRows.map((item) => ({ ...item })));
  }, [sourceKey]);

  function updateContact(index: number, values: Partial<CustomerContactInput>) {
    setRows((current) => current.map((row, currentIndex) => (
      currentIndex === index ? { ...row, ...values } : row
    )));
  }

  function addContact() {
    setRows((current) => [
      ...current,
      { key: `new:${Date.now()}`, contact_type: null, name: null, phone: null, email: null },
    ]);
  }

  function removeContact(index: number) {
    const nextRows = rows.filter((_, currentIndex) => currentIndex !== index);
    setRows(nextRows);
    void persistRows(nextRows);
  }

  function resetRows() {
    setRows(contactRows.map((item) => ({ ...item })));
  }

  async function persistRows(nextRows: CustomerContactRow[] = rows) {
    if (!canEdit) {
      return;
    }
    const payload = normalizeCustomerContactsPayload(nextRows);
    if (customerContactsKey(payload) === customerContactsKey(contactRows)) {
      return;
    }
    await onSaveContacts(payload);
  }

  return (
    <div className="customer-contact-editor">
      {rows.length ? (
        <div className="customer-contact-editor-table">
          {rows.map((item, index) => (
            <div className="customer-contact-editor-row" key={item.key}>
              {canEdit ? (
                <>
                  <input
                    aria-label="Name"
                    disabled={isSaving}
                    placeholder="Name"
                    value={item.name ?? ""}
                    onBlur={() => void persistRows()}
                    onChange={(event) => updateContact(index, { name: event.target.value })}
                    onKeyDown={(event) => handleCustomerContactEditorKey(event, resetRows)}
                  />
                  <input
                    aria-label="E-Mail"
                    disabled={isSaving}
                    placeholder="E-Mail"
                    value={item.email ?? ""}
                    onBlur={() => void persistRows()}
                    onChange={(event) => updateContact(index, { email: event.target.value })}
                    onKeyDown={(event) => handleCustomerContactEditorKey(event, resetRows)}
                  />
                  <input
                    aria-label="Telefon"
                    disabled={isSaving}
                    placeholder="Telefon"
                    value={item.phone ?? ""}
                    onBlur={() => void persistRows()}
                    onChange={(event) => updateContact(index, { phone: event.target.value })}
                    onKeyDown={(event) => handleCustomerContactEditorKey(event, resetRows)}
                  />
                  <input
                    aria-label="Rolle"
                    disabled={isSaving}
                    placeholder="Rolle"
                    value={displayCustomerContactRole(item.contact_type)}
                    onBlur={() => void persistRows()}
                    onChange={(event) => updateContact(index, { contact_type: event.target.value })}
                    onKeyDown={(event) => handleCustomerContactEditorKey(event, resetRows)}
                  />
                  <button
                    aria-label="Kontakt entfernen"
                    className="customer-contact-remove-button"
                    disabled={isSaving}
                    type="button"
                    onClick={() => removeContact(index)}
                  >
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </>
              ) : (
                <>
                  <span>{item.name ?? ""}</span>
                  <strong>{item.email ?? ""}</strong>
                  <span>{item.phone ?? ""}</span>
                  <span>{displayCustomerContactRole(item.contact_type)}</span>
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="detail-empty">Keine Kontakte hinterlegt.</p>
      )}
      {canEdit && (
        <button className="icon-button secondary customer-contact-add-button" disabled={isSaving} type="button" onClick={addContact}>
          <Plus aria-hidden="true" size={15} />
          <span>Kontakt hinzufügen</span>
        </button>
      )}
    </div>
  );
}

function handleCustomerContactEditorKey(event: KeyboardEvent<HTMLInputElement>, onCancel: () => void) {
  if (event.key === "Enter") {
    event.preventDefault();
    event.currentTarget.blur();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    onCancel();
    event.currentTarget.blur();
  }
}

function CustomerDetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="customer-detail-field">
      <span>{label}</span>
      {children}
    </div>
  );
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

function toEditableCustomers(customers: Customer[]): Record<string, EditableCustomer> {
  return Object.fromEntries(
    customers.map((customer) => [String(customer.id), toEditableCustomer(customer)]),
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

function groupCustomersAlphabetically(customers: Customer[]): Array<{ key: string; label: string; customers: Customer[] }> {
  const groups = new Map<string, Customer[]>();
  customers.forEach((customer) => {
    const firstLetter = customer.company_name.trim().charAt(0).toUpperCase();
    const key = /^[A-ZÄÖÜ]$/.test(firstLetter) ? firstLetter : "#";
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

function customerCardMeta(customer: Customer): string[] {
  return [
    customer.company_phone,
  ].filter((item): item is string => Boolean(item));
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
