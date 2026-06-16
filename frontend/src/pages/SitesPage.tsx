import { BriefcaseBusiness, ChevronDown, PlusCircle, Search, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { SiteStatusBadge, siteStatusLabels } from "../components/StatusBadge";
import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import { CustomerFields } from "./CustomersPage";
import type { Customer, CustomerCreate } from "../types/customer";
import type { SiteStatus } from "../types/matrix";
import type { Person } from "../types/person";
import type { Site, SiteCreate, SiteGeocodeSearchResult, SiteSummary, SiteSummaryPerson } from "../types/site";

const emptySite: SiteCreate = {
  site_number: null,
  name: "",
  location: null,
  address: null,
  postal_code: null,
  city: null,
  street: null,
  house_number: null,
  address_extra: null,
  latitude: null,
  longitude: null,
  geofence_radius_m: 5000,
  location_status: "unchecked",
  customer: null,
  project_manager_person_id: null,
  status: "active",
  info: null,
  color: "#1d5c99",
};

const emptyCustomerForSite: CustomerCreate = {
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

export type EditableSite = SiteCreate & { id: number };
type ProjectManagerOption = { id: number; name: string; shortCode: string };
type CurrentProjectManagerOption = Pick<SiteSummaryPerson, "id" | "display_name" | "short_code"> | null;
type SiteGroup = { key: string; label: string; sites: SiteSummary[]; showHeading: boolean };
type SiteColorOption = { name: string; value: string };
type SiteStatusFilter = SiteStatus | "standard";

const STANDARD_SITE_STATUSES: SiteStatus[] = ["active", "paused", "planned"];
const INACTIVE_SITE_STATUSES: SiteStatus[] = ["completed", "deleted"];

const SITE_COLOR_OPTIONS: SiteColorOption[] = [
  { name: "Blau", value: "#2563EB" },
  { name: "Dunkelblau", value: "#1E40AF" },
  { name: "Gruen", value: "#16A34A" },
  { name: "Rot", value: "#DC2626" },
  { name: "Orange", value: "#F97316" },
  { name: "Ocker", value: "#D97706" },
  { name: "Tuerkis", value: "#0891B2" },
  { name: "Violett", value: "#7C3AED" },
  { name: "Magenta", value: "#DB2777" },
  { name: "Grau", value: "#64748B" },
];

export function SitesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "project_manager";
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [isCreateDrawerOpen, setIsCreateDrawerOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [projectManagerFilter, setProjectManagerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<SiteStatusFilter>("standard");
  const [hasInitializedProjectManagerFilter, setHasInitializedProjectManagerFilter] = useState(false);
  const [hasInitializedSiteGroupCollapse, setHasInitializedSiteGroupCollapse] = useState(false);
  const [collapsedSiteGroupKeys, setCollapsedSiteGroupKeys] = useState<Set<string>>(() => new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [savingSiteId, setSavingSiteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const includeInactiveSites = INACTIVE_SITE_STATUSES.includes(statusFilter as SiteStatus);

  useEffect(() => {
    void loadData();
  }, [includeInactiveSites]);

  useEffect(() => {
    const state = location.state as { message?: string } | null;
    if (!state?.message) {
      return;
    }
    setMessage(state.message);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  async function loadData() {
    setIsLoading(true);
    setError(null);
    try {
      setSites(await api.siteSummaries({ includeClosed: includeInactiveSites }));
    } catch (requestError) {
      setError(readApiError(requestError, "Baustellen konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (hasInitializedProjectManagerFilter || isLoading) {
      return;
    }
    if (user?.role === "project_manager" && user.person_id && sites.some((site) => site.project_manager_person_id === user.person_id)) {
      setProjectManagerFilter(String(user.person_id));
    } else {
      setProjectManagerFilter("all");
    }
    setHasInitializedProjectManagerFilter(true);
  }, [hasInitializedProjectManagerFilter, isLoading, sites, user?.person_id, user?.role]);

  const projectManagerOptions = useMemo(() => projectManagerOptionsFromSites(sites), [sites]);
  const statusFilterOptions = useMemo(() => siteStatusFilterOptions(), []);

  const filteredSites = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    const searchFilteredSites = needle
      ? sites.filter((site) => siteSearchText(site).includes(needle))
      : sites;
    if (statusFilter === "standard") {
      return searchFilteredSites.filter((site) => STANDARD_SITE_STATUSES.includes(site.status));
    }
    return searchFilteredSites.filter((site) => site.status === statusFilter);
  }, [searchTerm, sites, statusFilter]);

  const siteGroups = useMemo(() => groupSites(filteredSites, projectManagerFilter), [filteredSites, projectManagerFilter]);
  const allSiteGroups = useMemo(() => groupSites(filteredSites, "all"), [filteredSites]);
  const visibleSiteCount = siteGroups.reduce((count, group) => count + group.sites.length, 0);

  useEffect(() => {
    if (hasInitializedSiteGroupCollapse || isLoading) {
      return;
    }

    const ownProjectManagerGroupKey = user?.role === "project_manager" && user.person_id ? String(user.person_id) : null;
    const hasOwnProjectManagerGroup = Boolean(
      ownProjectManagerGroupKey && allSiteGroups.some((group) => group.key === ownProjectManagerGroupKey),
    );

    setCollapsedSiteGroupKeys(
      hasOwnProjectManagerGroup
        ? new Set(allSiteGroups.filter((group) => group.key !== ownProjectManagerGroupKey).map((group) => group.key))
        : new Set(),
    );
    setHasInitializedSiteGroupCollapse(true);
  }, [allSiteGroups, hasInitializedSiteGroupCollapse, isLoading, user?.person_id, user?.role]);

  async function updateSiteStatus(site: SiteSummary, nextStatus: SiteStatus) {
    if (!canEdit || site.status === nextStatus) {
      return;
    }
    setSavingSiteId(site.id);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.updateSite(site.id, { status: nextStatus });
      replaceSiteSummary(toSiteSummary(updated));
      setMessage(`Status aktualisiert: ${siteStatusLabels[updated.status]}.`);
    } catch (requestError) {
      setError(readApiError(requestError, "Status konnte nicht gespeichert werden."));
    } finally {
      setSavingSiteId(null);
    }
  }

  function replaceSiteSummary(updated: SiteSummary) {
    setSites((current) => {
      const shouldHide = !includeInactiveSites && INACTIVE_SITE_STATUSES.includes(updated.status);
      if (shouldHide) {
        return current.filter((site) => site.id !== updated.id);
      }
      const exists = current.some((site) => site.id === updated.id);
      const next = exists
        ? current.map((site) => site.id === updated.id ? updated : site)
        : [...current, updated];
      return next.sort(compareSites);
    });
  }


  function openNewSiteDrawer() {
    setError(null);
    setMessage(null);
    setIsCreateDrawerOpen(true);
  }

  function closeDrawer() {
    setIsCreateDrawerOpen(false);
  }

  function toggleSiteGroup(groupKey: string) {
    setCollapsedSiteGroupKeys((current) => {
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
    <section className="site-page site-overview-page">
      <div className="page-header entity-page-header site-overview-header">
        <div className="site-overview-title">
          <p className="eyebrow">Projektakte</p>
          <h1>Baustellen</h1>
        </div>
        {canEdit && (
          <button className="icon-button site-overview-create" type="button" onClick={openNewSiteDrawer}>
            <PlusCircle aria-hidden="true" size={17} />
            <span>Neue Baustelle</span>
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      <div className="site-list-toolbar site-overview-toolbar">
        <div className="site-list-toolbar-left">
          <label className="site-overview-search">
            <Search aria-hidden="true" size={17} />
            <input
              placeholder="Baustelle suchen"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>
        </div>
        <div className="site-list-toolbar-right">
          {projectManagerOptions.length > 0 && (
            <div className="matrix-pm-filter site-pm-filter" aria-label="Projektleiter filtern">
              <button
                className={projectManagerFilter === "all" ? "is-active" : ""}
                type="button"
                onClick={() => setProjectManagerFilter("all")}
              >
                Alle
              </button>
              {projectManagerOptions.map((manager) => (
                <button
                  className={projectManagerFilter === String(manager.id) ? "is-active" : ""}
                  key={manager.id}
                  type="button"
                  onClick={() => setProjectManagerFilter(String(manager.id))}
                >
                  {compactProjectManagerFilterLabel(manager)}
                </button>
              ))}
            </div>
          )}
          <label className="site-status-select">
            <span>Status:</span>
            <select
              aria-label="Status filtern"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as SiteStatusFilter)}
            >
              {statusFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {isLoading && <div className="matrix-state">Baustellen werden geladen...</div>}

      {!isLoading && !error && (
        <>
          {projectManagerFilter === "all" ? (
            <div className="site-group-list" role="list">
              {siteGroups.map((group) => {
                const isCollapsed = group.showHeading && collapsedSiteGroupKeys.has(group.key);
                const cardsId = siteGroupCardsId(group.key);

                return (
                  <section className={`site-group-section${isCollapsed ? " is-collapsed" : ""}`} key={group.key}>
                    {group.showHeading && (
                      <div className="site-group-header">
                        <button
                          aria-controls={cardsId}
                          aria-expanded={!isCollapsed}
                          className="site-group-toggle"
                          type="button"
                          onClick={() => toggleSiteGroup(group.key)}
                        >
                          <span className="site-group-title">
                            <ChevronDown className="site-group-chevron" aria-hidden="true" size={16} />
                            <span>{compactSiteGroupLabel(group.label)}</span>
                          </span>
                          <span className="site-group-count">{group.sites.length}</span>
                        </button>
                      </div>
                    )}
                    {!isCollapsed && (
                      <div className="entity-card-list site-card-grid" id={cardsId}>
                        {group.sites.map((site) => renderSiteCard(site, (siteId) => navigate(`/sites/${siteId}`), canEdit, savingSiteId === site.id, updateSiteStatus))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="entity-card-list site-card-grid" role="list">
              {siteGroups.flatMap((group) => group.sites).map((site) => renderSiteCard(site, (siteId) => navigate(`/sites/${siteId}`), canEdit, savingSiteId === site.id, updateSiteStatus))}
            </div>
          )}
          {!visibleSiteCount && (
            <div className="empty-panel">
              <p>{sites.length ? "Keine Treffer gefunden." : "Noch keine Baustellen vorhanden."}</p>
            </div>
          )}
        </>
      )}

      <SiteCreateDrawer
        canEdit={canEdit}
        isOpen={isCreateDrawerOpen}
        onClose={closeDrawer}
        onCreated={(created) => {
          setSites((current) => [...current, toSiteSummary(created)].sort(compareSites));
          setError(null);
          setMessage("Baustelle angelegt.");
        }}
      />
    </section>
  );
}

type SiteCreateDrawerProps = {
  canEdit: boolean;
  initialProjectManagerPersonId?: number | null;
  isOpen: boolean;
  onClose: () => void;
  onCreated: (site: Site) => void;
};

export function SiteCreateDrawer({
  canEdit,
  initialProjectManagerPersonId = null,
  isOpen,
  onClose,
  onCreated,
}: SiteCreateDrawerProps) {
  const initialCreateForm = useMemo<SiteCreate>(() => ({
    ...emptySite,
    project_manager_person_id: initialProjectManagerPersonId,
  }), [initialProjectManagerPersonId]);
  const [projectManagerPeople, setProjectManagerPeople] = useState<Person[]>([]);
  const [projectManagersLoaded, setProjectManagersLoaded] = useState(false);
  const [projectManagersLoading, setProjectManagersLoading] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoaded, setCustomersLoaded] = useState(false);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [createForm, setCreateForm] = useState<SiteCreate>(initialCreateForm);
  const [isCustomerCreateDrawerOpen, setIsCustomerCreateDrawerOpen] = useState(false);
  const [customerCreateForm, setCustomerCreateForm] = useState<CustomerCreate>(emptyCustomerForSite);
  const [customerCreateError, setCustomerCreateError] = useState<string | null>(null);
  const [savingSite, setSavingSite] = useState(false);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setCreateForm(initialCreateForm);
      setCreateError(null);
    }
  }, [initialCreateForm, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (!projectManagersLoaded && !projectManagersLoading) {
      void loadProjectManagersForSiteForm();
    }
    if (!customersLoaded && !customersLoading) {
      void loadCustomersForSiteForm();
    }
  }, [customersLoaded, customersLoading, isOpen, projectManagersLoaded, projectManagersLoading]);

  async function createSite() {
    const validationError = validateSitePayload(createForm);
    if (validationError) {
      setCreateError(validationError);
      return;
    }
    setSavingSite(true);
    setCreateError(null);
    try {
      const created = await api.createSite(normalizeSitePayload(createForm));
      onCreated(created);
      setCreateForm(initialCreateForm);
      onClose();
    } catch (requestError) {
      setCreateError(readApiError(requestError, "Baustelle konnte nicht angelegt werden."));
    } finally {
      setSavingSite(false);
    }
  }

  async function loadProjectManagersForSiteForm() {
    setProjectManagersLoading(true);
    setCreateError(null);
    try {
      setProjectManagerPeople(await api.siteProjectManagers());
      setProjectManagersLoaded(true);
    } catch (requestError) {
      setCreateError(readApiError(requestError, "Projektleiter konnten nicht geladen werden."));
    } finally {
      setProjectManagersLoading(false);
    }
  }

  async function loadCustomersForSiteForm() {
    if (customersLoading) {
      return;
    }
    setCustomersLoading(true);
    setCreateError(null);
    try {
      setCustomers(await api.customers({ isActive: true }));
      setCustomersLoaded(true);
    } catch (requestError) {
      setCreateError(readApiError(requestError, "Kunden konnten nicht geladen werden."));
    } finally {
      setCustomersLoading(false);
    }
  }

  function selectCustomerForSite(customer: Customer) {
    setCreateForm((current) => ({ ...current, customer: customer.company_name }));
  }

  function openCustomerCreateDrawer(initialName: string) {
    setCustomerCreateForm({ ...emptyCustomerForSite, company_name: initialName.trim() });
    setCustomerCreateError(null);
    setIsCustomerCreateDrawerOpen(true);
  }

  function closeCustomerCreateDrawer() {
    if (savingCustomer) {
      return;
    }
    setCustomerCreateForm(emptyCustomerForSite);
    setCustomerCreateError(null);
    setIsCustomerCreateDrawerOpen(false);
  }

  async function createCustomerFromSite() {
    const validationError = validateCustomerPayloadForSite(customerCreateForm);
    if (validationError) {
      setCustomerCreateError(validationError);
      return;
    }
    setSavingCustomer(true);
    setCustomerCreateError(null);
    try {
      const created = await api.createCustomer(normalizeCustomerPayloadForSite(customerCreateForm));
      setCustomers((current) => [...current.filter((customer) => customer.id !== created.id), created].sort(compareCustomersByName));
      setCustomersLoaded(true);
      setCreateForm((current) => ({ ...current, customer: created.company_name }));
      setCustomerCreateForm(emptyCustomerForSite);
      setIsCustomerCreateDrawerOpen(false);
    } catch (requestError) {
      setCustomerCreateError(readApiError(requestError, "Kunde konnte nicht angelegt werden."));
    } finally {
      setSavingCustomer(false);
    }
  }

  function closeSiteDrawer() {
    if (savingSite) {
      return;
    }
    setCreateForm(initialCreateForm);
    setCustomerCreateForm(emptyCustomerForSite);
    setCustomerCreateError(null);
    setIsCustomerCreateDrawerOpen(false);
    setCreateError(null);
    onClose();
  }

  return (
    <>
      <EntityDetailDrawer
        isOpen={isOpen}
        title="Neue Baustelle"
        subtitle="Stammdaten anlegen"
        onClose={closeSiteDrawer}
        footer={canEdit ? (
          <button
            className="icon-button site-create-submit-button"
            disabled={savingSite}
            type="button"
            onClick={() => void createSite()}
          >
            <PlusCircle aria-hidden="true" size={17} />
            <span>{savingSite ? "Baustelle wird angelegt..." : "Baustelle anlegen"}</span>
          </button>
        ) : undefined}
      >
        {createError && <p className="form-error">{createError}</p>}
        <SiteFields
          draft={createForm}
          people={projectManagerPeople}
          customers={customers}
          customersLoading={customersLoading}
          disabled={!canEdit}
          hideTopLocationField
          onChange={(values) => setCreateForm((current) => ({ ...current, ...values }))}
          onCustomerFocus={() => {
            if (customersLoaded === false && customersLoading === false) {
              void loadCustomersForSiteForm();
            }
          }}
          onCustomerSelected={selectCustomerForSite}
          onCreateCustomer={openCustomerCreateDrawer}
        />
      </EntityDetailDrawer>

      <EntityDetailDrawer
        isOpen={isCustomerCreateDrawerOpen}
        title="Neuer Kunde"
        subtitle="Aus der Baustelle anlegen"
        onClose={closeCustomerCreateDrawer}
        footer={canEdit ? (
          <button className="icon-button" disabled={savingCustomer} type="button" onClick={() => void createCustomerFromSite()}>
            <UserPlus aria-hidden="true" size={17} />
            <span>{savingCustomer ? "Kunde wird gespeichert..." : "Kunde speichern"}</span>
          </button>
        ) : undefined}
      >
        {customerCreateError && <p className="form-error">{customerCreateError}</p>}
        <CustomerFields
          draft={customerCreateForm}
          onChange={(values) => setCustomerCreateForm((current) => ({ ...current, ...values }))}
        />
      </EntityDetailDrawer>
    </>
  );
}



function toSiteSummary(site: Site): SiteSummary {
  return {
    id: site.id,
    site_number: site.site_number,
    name: site.name,
    location: site.location,
    city: site.city,
    customer: site.customer,
    project_manager_person_id: site.project_manager_person_id,
    project_manager: site.project_manager
      ? {
        id: site.project_manager.id,
        display_name: site.project_manager.display_name,
        short_code: site.project_manager.short_code,
      }
      : null,
    status: site.status,
    color: site.color,
    requires_extra_work_approval: site.requires_extra_work_approval,
  };
}

export function SiteFields({
  draft,
  people,
  currentProjectManager = null,
  customers = [],
  customersLoading = false,
  disabled = false,
  hideTopLocationField = false,
  onChange,
  onCustomerFocus,
  onCustomerSelected,
  onCreateCustomer,
  onGeocodeSelected,
}: {
  draft: SiteCreate;
  people: Person[];
  currentProjectManager?: CurrentProjectManagerOption;
  customers?: Customer[];
  customersLoading?: boolean;
  disabled?: boolean;
  hideTopLocationField?: boolean;
  isCheckingLocation?: boolean;
  onChange: (values: Partial<SiteCreate>) => void;
  onCustomerFocus?: () => void;
  onCustomerSelected?: (customer: Customer) => void;
  onCreateCustomer?: (initialName: string) => void;
  onCheckLocation?: () => void;
  onGeocodeSelected?: (values: Partial<SiteCreate>) => void;
}) {
  const [isCustomerSuggestionsOpen, setIsCustomerSuggestionsOpen] = useState(false);
  const [activeCustomerSuggestionIndex, setActiveCustomerSuggestionIndex] = useState(0);
  const projectManagerOptions = useMemo(
    () => withCurrentProjectManagerOption(people, draft.project_manager_person_id, currentProjectManager),
    [currentProjectManager, draft.project_manager_person_id, people],
  );

  const customerQuery = draft.customer ?? "";
  const customerSuggestions = useMemo(() => {
    const needle = customerQuery.trim().toLowerCase();
    const activeCustomers = customers.filter((customer) => customer.is_active);
    const matches = needle
      ? activeCustomers.filter((customer) => customerSearchTextForSite(customer).includes(needle))
      : activeCustomers;
    return matches.slice(0, 6);
  }, [customerQuery, customers]);
  const canUseCustomerAutocomplete = Boolean(onCustomerSelected || onCreateCustomer);
  const showCustomerSuggestions = canUseCustomerAutocomplete && isCustomerSuggestionsOpen && !disabled;

  function selectCustomer(customer: Customer) {
    onChange({ customer: customer.company_name });
    onCustomerSelected?.(customer);
    setIsCustomerSuggestionsOpen(false);
    setActiveCustomerSuggestionIndex(0);
  }

  function createCustomerFromAutocomplete() {
    onCreateCustomer?.(customerQuery.trim());
    setIsCustomerSuggestionsOpen(false);
    setActiveCustomerSuggestionIndex(0);
  }

  function handleCustomerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!canUseCustomerAutocomplete) {
      return;
    }
    const optionCount = customerSuggestions.length + (onCreateCustomer ? 1 : 0);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIsCustomerSuggestionsOpen(true);
      setActiveCustomerSuggestionIndex((current) => optionCount ? (current + 1) % optionCount : 0);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIsCustomerSuggestionsOpen(true);
      setActiveCustomerSuggestionIndex((current) => optionCount ? (current - 1 + optionCount) % optionCount : 0);
      return;
    }
    if (event.key === "Enter" && showCustomerSuggestions && optionCount) {
      event.preventDefault();
      if (activeCustomerSuggestionIndex < customerSuggestions.length) {
        selectCustomer(customerSuggestions[activeCustomerSuggestionIndex]);
      } else {
        createCustomerFromAutocomplete();
      }
      return;
    }
    if (event.key === "Escape") {
      setIsCustomerSuggestionsOpen(false);
      setActiveCustomerSuggestionIndex(0);
    }
  }

  return (
    <div className="site-form-grid">
      <label className="site-field-name">
        <span>Baustellenname</span>
        <input disabled={disabled} value={draft.name} onChange={(event) => onChange({ name: event.target.value })} />
      </label>
      <label className="site-field-number">
        <span>Kommissions Nr.</span>
        <input
          disabled={disabled}
          value={draft.site_number ?? ""}
          onChange={(event) => onChange({ site_number: event.target.value || null })}
        />
      </label>
      {!hideTopLocationField ? (
        <label className="site-field-location">
          <span>Ort</span>
          <input
            disabled={disabled}
            value={draft.location ?? ""}
            onChange={(event) => onChange({ location: event.target.value || null })}
          />
        </label>
      ) : null}
      <div className="site-field-customer site-customer-autocomplete">
        <label>
          <span>Kunde</span>
          <input
            aria-autocomplete={canUseCustomerAutocomplete ? "list" : undefined}
            aria-expanded={showCustomerSuggestions}
            disabled={disabled}
            value={draft.customer ?? ""}
            onBlur={() => {
              window.setTimeout(() => setIsCustomerSuggestionsOpen(false), 120);
            }}
            onChange={(event) => {
              onChange({ customer: event.target.value || null });
              setActiveCustomerSuggestionIndex(0);
              setIsCustomerSuggestionsOpen(true);
            }}
            onFocus={() => {
              onCustomerFocus?.();
              setIsCustomerSuggestionsOpen(true);
            }}
            onKeyDown={handleCustomerKeyDown}
          />
        </label>
        {showCustomerSuggestions && (
          <div className="site-customer-suggestions" role="listbox">
            {customersLoading && <span className="site-customer-suggestion-empty">Kunden werden geladen...</span>}
            {!customersLoading && customerSuggestions.map((customer, index) => (
              <button
                aria-selected={activeCustomerSuggestionIndex === index}
                key={customer.id}
                role="option"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectCustomer(customer)}
              >
                <strong>{customer.company_name}</strong>
                <span>{customerSuggestionMeta(customer)}</span>
              </button>
            ))}
            {!customersLoading && customerSuggestions.length === 0 && customerQuery.trim() && (
              <span className="site-customer-suggestion-empty">Kein passender Kunde gefunden.</span>
            )}
            {onCreateCustomer && (
              <button
                aria-selected={activeCustomerSuggestionIndex === customerSuggestions.length}
                className="site-customer-create-option"
                role="option"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={createCustomerFromAutocomplete}
              >
                <UserPlus aria-hidden="true" size={15} />
                <span>Neuen Kunden anlegen</span>
              </button>
            )}
          </div>
        )}
      </div>
      <label className="site-field-manager">
        <span>Projektleiter</span>
        <select
          disabled={disabled}
          value={draft.project_manager_person_id ?? ""}
          onChange={(event) => onChange({ project_manager_person_id: parsePersonId(event.target.value) })}
        >
          <option value="">Nicht zugeordnet</option>
          {projectManagerOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="site-field-status">
        <span>Status</span>
        <select
          disabled={disabled}
          value={draft.status}
          onChange={(event) => onChange({ status: event.target.value as SiteStatus })}
        >
          {Object.entries(siteStatusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <SiteColorSelect
        disabled={disabled}
        value={draft.color ?? "#64748B"}
        onChange={(color) => onChange({ color })}
      />
      <section className="site-location-section">
        <SiteAddressSearch
          draft={draft}
          disabled={disabled}
          onChange={onChange}
          onGeocodeSelected={onGeocodeSelected}
        />
        <div className="site-address-display-grid">
          <AddressDisplayItem label="PLZ" value={draft.postal_code} />
          <AddressDisplayItem label="Stadt" value={draft.city} />
          <AddressDisplayItem label="Strasse" value={draft.street} />
          <AddressDisplayItem label="Hausnummer" value={draft.house_number} />
          <AddressDisplayItem label="Adresszusatz / Bereich" value={draft.address_extra} wide />
        </div>
      </section>

      <label className="site-info-field">
        <span>Info</span>
        <textarea
          disabled={disabled}
          value={draft.info ?? ""}
          onChange={(event) => onChange({ info: event.target.value || null })}
        />
      </label>
    </div>
  );
}

export function SiteAddressSearch({
  className = "",
  draft,
  disabled = false,
  onChange,
  onGeocodeSelected,
}: {
  className?: string;
  draft: SiteCreate;
  disabled?: boolean;
  onChange: (values: Partial<SiteCreate>) => void;
  onGeocodeSelected?: (values: Partial<SiteCreate>) => void;
}) {
  const [addressSearch, setAddressSearch] = useState("");
  const [addressResults, setAddressResults] = useState<SiteGeocodeSearchResult[]>([]);
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);
  const [addressSearchMessage, setAddressSearchMessage] = useState<string | null>(null);
  const [selectedGeocodeResult, setSelectedGeocodeResult] = useState<SiteGeocodeSearchResult | null>(null);

  useEffect(() => {
    const query = addressSearch.trim();
    if (selectedGeocodeResult && query === selectedGeocodeResult.label) {
      setAddressResults([]);
      setIsSearchingAddress(false);
      return;
    }
    if (query.length < 3 || disabled) {
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
        .searchSiteAddress(query)
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
  }, [addressSearch, disabled, selectedGeocodeResult]);

  function applyGeocodeResult(result: SiteGeocodeSearchResult) {
    const selectedValues: Partial<SiteCreate> = {
      address: result.label,
      postal_code: result.postal_code,
      city: result.city,
      location: result.city ?? draft.location,
      street: result.street,
      house_number: result.house_number,
      latitude: result.latitude,
      longitude: result.longitude,
      location_status: "geocoded",
    };
    setSelectedGeocodeResult(result);
    onChange(selectedValues);
    onGeocodeSelected?.(selectedValues);
    setAddressSearch("");
    setAddressResults([]);
    setIsSearchingAddress(false);
    setAddressSearchMessage("Standort aus Vorschlag uebernommen und geprueft.");
    (document.activeElement as HTMLElement | null)?.blur();
  }

  return (
    <label className={`address-field site-address-search${className ? ` ${className}` : ""}`}>
      <span>Adresse suchen</span>
      <input
        aria-label="Adresse suchen"
        autoCapitalize="none"
        autoComplete="new-password"
        autoCorrect="off"
        disabled={disabled}
        id="site-query-token"
        inputMode="search"
        name="site-query-token"
        placeholder="z. B. Moorburger Str. 16, 21079 Hamburg"
        spellCheck={false}
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
  );
}

function AddressDisplayItem({ label, value, wide = false }: { label: string; value: string | null | undefined; wide?: boolean }) {
  return (
    <div className={`site-address-display-item${wide ? " is-wide" : ""}`}>
      <span>{label}</span>
      <strong>{value || "—"}</strong>
    </div>
  );
}


export function toEditableSite(site: Site): EditableSite {
  return {
    id: site.id,
    site_number: site.site_number,
    name: site.name,
    location: site.location,
    address: site.address,
    postal_code: site.postal_code,
    city: site.city,
    street: site.street,
    house_number: site.house_number,
    address_extra: site.address_extra,
    latitude: site.latitude,
    longitude: site.longitude,
    geofence_radius_m: site.geofence_radius_m,
    location_status: site.location_status,
    customer: site.customer,
    project_manager_person_id: site.project_manager_person_id,
    status: site.status,
    info: site.info,
    color: site.color,
  };
}

function withCurrentProjectManagerOption(
  people: Person[],
  selectedPersonId: number | null,
  currentProjectManager: CurrentProjectManagerOption,
): Array<{ id: number; label: string }> {
  const options = people.map((person) => ({ id: person.id, label: person.display_name }));
  if (
    selectedPersonId !== null
    && currentProjectManager
    && currentProjectManager.id === selectedPersonId
    && !options.some((option) => option.id === selectedPersonId)
  ) {
    return [
      { id: currentProjectManager.id, label: `${currentProjectManager.display_name} (aktuell zugeordnet)` },
      ...options,
    ];
  }
  return options;
}

export function validateSitePayload(site: SiteCreate): string | null {
  if (!site.name.trim()) {
    return "Baustellenname fehlt.";
  }
  if (!site.site_number?.trim()) {
    return "Kommissionsnummer fehlt.";
  }
  if (site.project_manager_person_id === null) {
    return "Projektleiter fehlt.";
  }
  if (!site.status) {
    return "Status fehlt.";
  }
  if (!site.color?.trim()) {
    return "Farbe fehlt.";
  }
  return null;
}

export function normalizeSitePayload(site: SiteCreate): SiteCreate {
  return {
    ...site,
    site_number: cleanOptionalText(site.site_number),
    name: site.name.trim(),
    location: cleanOptionalText(site.location),
    address: cleanOptionalText(site.address),
    postal_code: cleanOptionalText(site.postal_code),
    city: cleanOptionalText(site.city),
    street: cleanOptionalText(site.street),
    house_number: cleanOptionalText(site.house_number),
    address_extra: cleanOptionalText(site.address_extra),
    latitude: site.latitude,
    longitude: site.longitude,
    geofence_radius_m: site.geofence_radius_m || 5000,
    location_status: site.location_status,
    customer: cleanOptionalText(site.customer),
    info: cleanOptionalText(site.info),
    color: cleanOptionalText(site.color),
  };
}

function cleanOptionalText(value: string | null): string | null {
  return value?.trim() || null;
}

function parsePersonId(value: string): number | null {
  return value ? Number(value) : null;
}

function customerSuggestionMeta(customer: Customer): string {
  return [
    formatCustomerAddressForSite(customer),
    customer.project_lead_name ? `Projektleiter: ${customer.project_lead_name}` : "",
    customer.company_phone,
  ].filter(Boolean).join(" · ") || "Kundenstamm";
}

function validateCustomerPayloadForSite(customer: CustomerCreate): string | null {
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

function normalizeCustomerPayloadForSite(customer: CustomerCreate): CustomerCreate {
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

function compareCustomersByName(left: Customer, right: Customer): number {
  return left.company_name.localeCompare(right.company_name, "de");
}

function formatCustomerAddressForSite(customer: Pick<Customer, "address_street" | "address_house_number" | "address_postal_code" | "address_city" | "address_country">): string {
  const streetLine = [customer.address_street, customer.address_house_number].filter(Boolean).join(" ");
  const cityLine = [customer.address_postal_code, customer.address_city].filter(Boolean).join(" ");
  return [streetLine, cityLine, customer.address_country].filter(Boolean).join(", ");
}

function customerSearchTextForSite(customer: Customer): string {
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
    customer.contacts.map((contact) => [contact.name, contact.phone, contact.email].filter(Boolean).join(" ")).join(" "),
  ].filter(Boolean).join(" ").toLowerCase();
}

function compareSites(left: SiteSummary, right: SiteSummary): number {
  return compareSiteNumbers(left.site_number, right.site_number)
    || left.name.localeCompare(right.name, "de")
    || left.id - right.id;
}

function compareSiteNumbers(left: string | null, right: string | null): number {
  const leftNumber = parseSiteNumber(left);
  const rightNumber = parseSiteNumber(right);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber;
  }
  if (leftNumber !== null) {
    return -1;
  }
  if (rightNumber !== null) {
    return 1;
  }
  return (left ?? "").localeCompare(right ?? "", "de");
}

function parseSiteNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const matches = value.match(/\d+/g);
  return matches?.length ? Number(matches[matches.length - 1]) : null;
}

function SiteColorSelect({
  disabled,
  value,
  onChange,
}: {
  disabled?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selectedOption = SITE_COLOR_OPTIONS.find((option) => option.value.toLowerCase() === value.toLowerCase());
  const label = selectedOption?.name ?? "Farbe";

  return (
    <div className="site-color-select-field site-field-color">
      <span>Farbe</span>
      <div className="site-color-select">
        <button
          aria-expanded={isOpen}
          className="site-color-select-trigger"
          disabled={disabled}
          type="button"
          onBlur={(event) => {
            if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) {
              setIsOpen(false);
            }
          }}
          onClick={() => setIsOpen((current) => !current)}
        >
          <span className="site-color-swatch" style={{ backgroundColor: value }} />
          <span>{label}</span>
        </button>
        {isOpen && !disabled && (
          <div className="site-color-menu" role="listbox">
            {SITE_COLOR_OPTIONS.map((option) => (
              <button
                aria-selected={option.value.toLowerCase() === value.toLowerCase()}
                key={option.value}
                role="option"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
              >
                <span className="site-color-swatch" style={{ backgroundColor: option.value }} />
                <span>{option.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function renderSiteCard(
  site: SiteSummary,
  openSiteDetail: (siteId: number) => void,
  canEdit: boolean,
  isSaving: boolean,
  onStatusChange: (site: SiteSummary, status: SiteStatus) => void,
) {
  const classes = ["entity-card", "site-card", INACTIVE_SITE_STATUSES.includes(site.status) ? "is-inactive" : ""].filter(Boolean).join(" ");
  return (
    <article className={classes} key={site.id}>
      <button className="site-card-main" type="button" onClick={() => openSiteDetail(site.id)}>
        <span className="entity-card-color site-card-color" style={{ backgroundColor: site.color ?? "#94a3b8" }} aria-hidden="true" />
        <span className="entity-card-icon site-card-icon"><BriefcaseBusiness aria-hidden="true" size={17} /></span>
        <span className="entity-card-body">
          <span className="entity-card-title">{site.name}</span>
          <span className="entity-card-subtitle">{[site.site_number, site.location].filter(Boolean).join(" · ") || "Ohne Ort"}</span>
          <span className="site-card-meta-grid">
            <span><strong>PL:</strong><span>{siteProjectManagerLabel(site)}</span></span>
            <span><strong>Kunde:</strong><span>{site.customer || "—"}</span></span>
          </span>
        </span>
      </button>
      <span className="entity-card-status site-card-status-control" onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
        {canEdit ? (
          <select
            aria-label={`Status fuer ${site.name} aendern`}
            className={`site-card-status-select status-badge-${site.status}`}
            disabled={isSaving}
            value={site.status}
            onChange={(event) => onStatusChange(site, event.target.value as SiteStatus)}
          >
            {siteStatusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <SiteStatusBadge status={site.status} />
        )}
      </span>
    </article>
  );
}

export const siteStatusOptions: Array<{ value: SiteStatus; label: string }> = [
  { value: "active", label: siteStatusLabels.active },
  { value: "paused", label: siteStatusLabels.paused },
  { value: "planned", label: siteStatusLabels.planned },
  { value: "completed", label: siteStatusLabels.completed },
  { value: "deleted", label: siteStatusLabels.deleted },
];

function siteStatusFilterOptions(): Array<{ value: SiteStatusFilter; label: string }> {
  return [
    { value: "standard", label: "Offen" },
    ...siteStatusOptions,
  ];
}

function compactProjectManagerFilterLabel(manager: ProjectManagerOption): string {
  return compactCodeFromText(manager.shortCode || manager.name);
}

function compactCodeFromText(value: string): string {
  const parts = value.split(/[.\s-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0].slice(0, 1)}${parts[1].slice(0, 1)}`.toUpperCase();
  }
  const letters = value.replace(/[^A-Za-zÄÖÜäöüß]/g, "");
  return letters.slice(0, 2).toUpperCase();
}

function projectManagerOptionsFromSites(sites: SiteSummary[]): ProjectManagerOption[] {
  const options = new Map<number, ProjectManagerOption>();
  sites.forEach((site) => {
    const manager = site.project_manager;
    if (!manager) {
      return;
    }
    options.set(manager.id, {
      id: manager.id,
      name: manager.display_name,
      shortCode: manager.short_code,
    });
  });
  return [...options.values()].sort((left, right) => left.name.localeCompare(right.name, "de"));
}

function groupSites(sites: SiteSummary[], projectManagerFilter: string): SiteGroup[] {
  const filteredSites = projectManagerFilter === "all"
    ? sites
    : sites.filter((site) => String(site.project_manager_person_id ?? "") === projectManagerFilter);
  const sortedSites = filteredSites.slice().sort(compareSites);
  if (projectManagerFilter !== "all") {
    return [{ key: projectManagerFilter, label: "", sites: sortedSites, showHeading: false }];
  }

  const groups = new Map<string, SiteGroup>();
  sortedSites.forEach((site) => {
    const key = site.project_manager_person_id ? String(site.project_manager_person_id) : "unassigned";
    const label = site.project_manager?.display_name ?? "Ohne Projektleiter";
    const existing = groups.get(key);
    if (existing) {
      existing.sites.push(site);
      return;
    }
    groups.set(key, { key, label, sites: [site], showHeading: true });
  });

  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label, "de"));
}

function siteProjectManagerLabel(site: SiteSummary): string {
  return site.project_manager?.short_code || site.project_manager?.display_name || "offen";
}

function compactSiteGroupLabel(label: string): string {
  if (label === "Ohne Projektleiter") {
    return label;
  }
  return compactCodeFromText(label);
}

function siteGroupCardsId(groupKey: string): string {
  return `site-group-cards-${groupKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function siteSearchText(site: SiteSummary): string {
  return [
    site.name,
    site.site_number,
    site.location,
    site.city,
    site.customer,
    site.project_manager?.display_name,
    site.project_manager?.short_code,
    siteStatusLabels[site.status],
  ].filter(Boolean).join(" ").toLowerCase();
}


function formatGeocodeMeta(result: SiteGeocodeSearchResult): string {
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
