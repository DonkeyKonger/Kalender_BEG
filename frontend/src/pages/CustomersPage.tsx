import { ArrowLeft, Building2, ChevronDown, ChevronRight, Plus, Save, Search, Trash2, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "../auth/AuthContext";
import { EntityCard } from "../components/EntityCard";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { ApiError, api } from "../lib/api";
import type { Customer, CustomerContactInput, CustomerCreate } from "../types/customer";

type EditableCustomer = CustomerCreate & { id: number };
type DrawerState = { mode: "new" } | { mode: "edit"; customerId: number } | null;
type CustomerDetailSubview = "emails" | "contacts" | "projects";

const customerContactTypeLabels: Record<string, string> = {
  monteur: "Ansprechpartner vor Ort",
  bauleiter: "Bauleiter Kunde",
  einkauf: "Einkauf",
  rechnung: "Rechnung",
  mobile_email: "Mobile E-Mail",
};

const emptyCustomer: CustomerCreate = {
  company_name: "",
  address_street: null,
  address_house_number: null,
  address_postal_code: null,
  address_city: null,
  address_country: "Deutschland",
  company_phone: null,
  project_lead_name: null,
  project_lead_phone: null,
  project_lead_email: null,
  is_active: true,
  contacts: [],
};

function emptyCustomerContact(): CustomerContactInput {
  return {
    contact_type: "monteur",
    name: "",
    phone: null,
    email: null,
  };
}

export function CustomersPage() {
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "project_manager";
  const canRemove = user?.role === "admin";
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditableCustomer>>({});
  const [createForm, setCreateForm] = useState<CustomerCreate>(emptyCustomer);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [isEditingCustomer, setIsEditingCustomer] = useState(false);
  const [customerDetailSubview, setCustomerDetailSubview] = useState<CustomerDetailSubview | null>(null);
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
      const customerData = await api.customers();
      setCustomers(customerData);
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
    setCustomerDetailSubview(null);
    setDrawer({ mode: "new" });
  }

  function openCustomerDrawer(customerId: number) {
    setIsEditingCustomer(false);
    setCustomerDetailSubview(null);
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
    setCustomerDetailSubview(null);
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
        title={selectedCustomer ? isEditingCustomer ? "Kunde bearbeiten" : "Kunde" : "Kunde"}
        subtitle={selectedCustomer ? selectedCustomer.company_name : undefined}
        onClose={closeDrawer}
        actions={selectedCustomer && canEdit && !isEditingCustomer && !customerDetailSubview ? (
          <button
            className="icon-button secondary"
            type="button"
            onClick={() => {
              setCustomerDetailSubview(null);
              setIsEditingCustomer(true);
            }}
          >
            <span>Bearbeiten</span>
          </button>
        ) : undefined}
        footer={selectedCustomer ? (
          isEditingCustomer && canEdit ? (
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
          ) : (
            <button className="icon-button secondary" type="button" onClick={closeDrawer}>
              <span>Schliessen</span>
            </button>
          )
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
                showContactSections={false}
                onChange={(values) => updateDraft(selectedCustomer.id, values)}
              />
            </div>
          ) : (
            customerDetailSubview ? (
              <CustomerDetailSubviewView
                customer={selectedCustomer}
                view={customerDetailSubview}
                onBack={() => setCustomerDetailSubview(null)}
              />
            ) : (
              <CustomerReadView customer={selectedCustomer} onOpenSubview={setCustomerDetailSubview} />
            )
          )
        )}
      </EntityDetailDrawer>
    </section>
  );
}

function CustomerReadView({
  customer,
  onOpenSubview,
}: {
  customer: Customer;
  onOpenSubview: (view: CustomerDetailSubview) => void;
}) {
  const emailItems = customerEmailItems(customer);

  return (
    <div className="detail-read-view">
      <section className="detail-read-section">
        <h3>Firma</h3>
        <div className="detail-read-grid">
          <ReadItem label="Firmenname" value={customer.company_name} />
          <ReadItem label="Firmentelefon" value={customer.company_phone || "-"} />
        </div>
      </section>

      <section className="detail-read-section">
        <h3>Firmenadresse</h3>
        <div className={`detail-address-card ${formatCustomerAddress(customer) ? "has-address" : "is-empty"}`}>
          <span>{formatCustomerAddress(customer) ? "Adresse hinterlegt" : "Keine Adresse hinterlegt"}</span>
          {formatCustomerAddress(customer) ? <strong>{formatCustomerAddress(customer)}</strong> : null}
        </div>
      </section>

      <CustomerDetailNavSection
        title="E-Mail-Adressen"
        preview={emailItems.length
          ? `${emailItems.length} E-Mail-Adresse${emailItems.length === 1 ? "" : "n"} hinterlegt`
          : "Keine E-Mail-Adressen hinterlegt."}
        onClick={() => onOpenSubview("emails")}
      />

      <CustomerDetailNavSection
        title="Ansprechpartner"
        preview={customer.contacts.length
          ? `${customer.contacts.length} Ansprechpartner hinterlegt`
          : "Keine Ansprechpartner hinterlegt."}
        onClick={() => onOpenSubview("contacts")}
      />

      <CustomerDetailNavSection
        title="Projekte"
        preview="Projektübersicht wird vorbereitet."
        onClick={() => onOpenSubview("projects")}
      />
    </div>
  );
}

function CustomerDetailNavSection({
  title,
  preview,
  onClick,
}: {
  title: string;
  preview: string;
  onClick: () => void;
}) {
  return (
    <section className="detail-read-section customer-detail-nav-section">
      <button className="customer-detail-nav-button" type="button" onClick={onClick}>
        <span className="customer-detail-nav-copy">
          <span className="customer-detail-nav-title">{title}</span>
          <span className="customer-detail-nav-preview">{preview}</span>
        </span>
        <ChevronRight aria-hidden="true" size={17} />
      </button>
    </section>
  );
}

function CustomerDetailSubviewView({
  customer,
  view,
  onBack,
}: {
  customer: Customer;
  view: CustomerDetailSubview;
  onBack: () => void;
}) {
  const emailItems = customerEmailItems(customer);
  const title = view === "emails" ? "E-Mail-Adressen" : view === "contacts" ? "Ansprechpartner" : "Projekte";

  return (
    <div className="detail-read-view customer-detail-subview">
      <button className="icon-button secondary customer-detail-back-button" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={16} />
        <span>Zurück</span>
      </button>

      <section className="detail-read-section">
        <h3>{title}</h3>
        {view === "emails" && (
          emailItems.length ? (
            <div className="customer-email-list">
              {emailItems.map((item) => (
                <div className="customer-email-row" key={item.email}>
                  <span>{item.label}</span>
                  <strong>{item.email}</strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="detail-empty">Keine E-Mail-Adressen hinterlegt.</p>
          )
        )}
        {view === "contacts" && (
          customer.contacts.length ? (
            <CustomerContactCardList contacts={customer.contacts} />
          ) : (
            <p className="detail-empty">Keine Ansprechpartner hinterlegt.</p>
          )
        )}
        {view === "projects" && (
          <p className="detail-empty">Projektübersicht wird vorbereitet.</p>
        )}
      </section>
    </div>
  );
}

function CustomerContactCardList({ contacts }: { contacts: Customer["contacts"] }) {
  return (
    <div className="customer-contact-card-list">
      {contacts.map((contact) => (
        <div className="customer-contact-card" key={contact.id}>
          <strong>{contact.name}</strong>
          <span>{customerContactTypeLabels[contact.contact_type] ?? contact.contact_type}</span>
          <small>{[contact.phone, contact.email].filter(Boolean).join(" · ") || "Keine Kontaktdaten"}</small>
        </div>
      ))}
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

export function CustomerFields({
  draft,
  showContactSections = true,
  onChange,
}: {
  draft: CustomerCreate;
  showContactSections?: boolean;
  onChange: (values: Partial<CustomerCreate>) => void;
}) {
  function updateContact(index: number, values: Partial<CustomerContactInput>) {
    const nextContacts = draft.contacts.map((contact, currentIndex) => (
      currentIndex === index ? { ...contact, ...values } : contact
    ));
    onChange({ contacts: nextContacts });
  }

  function addContact() {
    onChange({ contacts: [...draft.contacts, emptyCustomerContact()] });
  }

  function removeContact(index: number) {
    onChange({ contacts: draft.contacts.filter((_, currentIndex) => currentIndex !== index) });
  }

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
          <p>Strukturierte Adresse fuer spaetere Baustellen-, Dokument- und Versandfunktionen.</p>
        </div>
        <label className="address-street-field">
          <span>Strasse</span>
          <input
            value={draft.address_street ?? ""}
            onChange={(event) => onChange({ address_street: event.target.value || null })}
          />
        </label>
        <label className="address-house-number-field">
          <span>Hausnummer</span>
          <input
            value={draft.address_house_number ?? ""}
            onChange={(event) => onChange({ address_house_number: event.target.value || null })}
          />
        </label>
        <label className="address-postal-field">
          <span>PLZ</span>
          <input
            value={draft.address_postal_code ?? ""}
            onChange={(event) => onChange({ address_postal_code: event.target.value || null })}
          />
        </label>
        <label className="address-city-field">
          <span>Ort</span>
          <input
            value={draft.address_city ?? ""}
            onChange={(event) => onChange({ address_city: event.target.value || null })}
          />
        </label>
        <label className="address-extra-field address-field">
          <span>Land</span>
          <input
            value={draft.address_country ?? ""}
            onChange={(event) => onChange({ address_country: event.target.value || null })}
          />
        </label>
      </section>

      {showContactSections && (
        <>
          <section className="customer-form-section">
            <div>
              <h3>Projektleiter Kunde</h3>
              <p>Kontaktdaten der kundenseitigen Projektleitung.</p>
            </div>
            <label>
              <span>Name</span>
              <input
                value={draft.project_lead_name ?? ""}
                onChange={(event) => onChange({ project_lead_name: event.target.value || null })}
              />
            </label>
            <label>
              <span>Telefon</span>
              <input
                value={draft.project_lead_phone ?? ""}
                onChange={(event) => onChange({ project_lead_phone: event.target.value || null })}
              />
            </label>
            <label>
              <span>Mail</span>
              <input
                value={draft.project_lead_email ?? ""}
                onChange={(event) => onChange({ project_lead_email: event.target.value || null })}
              />
            </label>
          </section>

          <section className="customer-form-section customer-contacts-section">
            <div className="customer-contacts-header">
              <div>
                <h3>Ansprechpartner vor Ort</h3>
                <p>Kunden-Ansprechpartner, nicht interne BEG-Monteure.</p>
              </div>
              <button className="icon-button secondary" type="button" onClick={addContact}>
                <Plus aria-hidden="true" size={15} />
                <span>Kontakt</span>
              </button>
            </div>
            {draft.contacts.length === 0 ? (
              <p className="detail-empty">Noch kein Ansprechpartner hinterlegt.</p>
            ) : (
              <div className="customer-contact-form-list">
                {draft.contacts.map((contact, index) => (
                  <div className="customer-contact-form-row" key={index}>
                    <label>
                      <span>Typ</span>
                      <select
                        value={contact.contact_type}
                        onChange={(event) => updateContact(index, { contact_type: event.target.value })}
                      >
                        {Object.entries(customerContactTypeLabels).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Name</span>
                      <input
                        value={contact.name}
                        onChange={(event) => updateContact(index, { name: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Telefon</span>
                      <input
                        value={contact.phone ?? ""}
                        onChange={(event) => updateContact(index, { phone: event.target.value || null })}
                      />
                    </label>
                    <label>
                      <span>Mail</span>
                      <input
                        value={contact.email ?? ""}
                        onChange={(event) => updateContact(index, { email: event.target.value || null })}
                      />
                    </label>
                    <button className="icon-button secondary" type="button" onClick={() => removeContact(index)}>
                      <Trash2 aria-hidden="true" size={15} />
                      <span>Entfernen</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
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
    company_phone: customer.company_phone,
    project_lead_name: customer.project_lead_name,
    project_lead_phone: customer.project_lead_phone,
    project_lead_email: customer.project_lead_email,
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
    const hasContactData = Boolean(contact.name.trim() || contact.phone?.trim() || contact.email?.trim());
    if (!hasContactData) {
      continue;
    }
    if (!contact.name.trim()) {
      return "Ansprechpartner brauchen einen Namen.";
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
    company_phone: customer.company_phone?.trim() || null,
    project_lead_name: customer.project_lead_name?.trim() || null,
    project_lead_phone: customer.project_lead_phone?.trim() || null,
    project_lead_email: customer.project_lead_email?.trim() || null,
    is_active: customer.is_active,
    contacts: customer.contacts
      .map((contact) => ({
        contact_type: contact.contact_type.trim() || "monteur",
        name: contact.name.trim(),
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

function formatCustomerAddress(customer: Pick<Customer, "address_street" | "address_house_number" | "address_postal_code" | "address_city" | "address_country">): string {
  const streetLine = [customer.address_street, customer.address_house_number].filter(Boolean).join(" ");
  const cityLine = [customer.address_postal_code, customer.address_city].filter(Boolean).join(" ");
  return [streetLine, cityLine, customer.address_country].filter(Boolean).join(", ");
}

function customerEmailItems(customer: Customer): Array<{ email: string; label: string }> {
  const items = new Map<string, { email: string; label: string }>();
  const addEmail = (email: string | null, label: string) => {
    const cleanedEmail = email?.trim();
    if (!cleanedEmail) {
      return;
    }
    const key = cleanedEmail.toLowerCase();
    if (!items.has(key)) {
      items.set(key, { email: cleanedEmail, label });
    }
  };

  addEmail(customer.project_lead_email, customerEmailOwnerLabel(customer.project_lead_name) || "Nicht zugeordnet");
  for (const contact of customer.contacts) {
    addEmail(contact.email, customerEmailOwnerLabel(contact.name) || "Nicht zugeordnet");
  }
  for (const emailAddress of customer.email_addresses) {
    addEmail(emailAddress.email, customerEmailOwnerLabel(emailAddress.label) || "Nicht zugeordnet");
  }
  return [...items.values()];
}

function customerEmailOwnerLabel(value: string | null | undefined): string | null {
  const label = value?.trim();
  if (!label) {
    return null;
  }
  return label.toLowerCase() === "mobile e-mail" ? null : label;
}

function customerCardMeta(customer: Customer): string[] {
  return [
    customer.project_lead_name ? `Projektleiter: ${customer.project_lead_name}` : "",
    customer.company_phone,
    customer.contacts.length ? `${customer.contacts.length} Ansprechpartner` : "",
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
    customer.project_lead_name,
    customer.project_lead_phone,
    customer.project_lead_email,
    customer.is_active ? "Aktiv" : "Inaktiv",
    ...customer.contacts.flatMap((contact) => [
      contact.name,
      contact.phone,
      contact.email,
      customerContactTypeLabels[contact.contact_type] ?? contact.contact_type,
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
