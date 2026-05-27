import { BriefcaseBusiness, PlusCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { SiteStatusBadge, siteStatusLabels } from "../components/StatusBadge";
import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import type { SiteStatus } from "../types/matrix";
import type { Person } from "../types/person";
import type { Site, SiteCreate, SiteGeocodeSearchResult, SiteSummary } from "../types/site";

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

export type EditableSite = SiteCreate & { id: number };
type ProjectManagerOption = { id: number; name: string; shortCode: string };
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
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "project_manager";
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [createForm, setCreateForm] = useState<SiteCreate>(emptySite);
  const [isCreateDrawerOpen, setIsCreateDrawerOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [projectManagerFilter, setProjectManagerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<SiteStatusFilter>("standard");
  const [hasInitializedProjectManagerFilter, setHasInitializedProjectManagerFilter] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [savingSiteId, setSavingSiteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const includeInactiveSites = INACTIVE_SITE_STATUSES.includes(statusFilter as SiteStatus);

  useEffect(() => {
    void loadData();
  }, [includeInactiveSites]);

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
  const visibleSiteCount = siteGroups.reduce((count, group) => count + group.sites.length, 0);

  async function createSite() {
    const validationError = validateSitePayload(createForm);
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }
    setSavingSiteId(0);
    setError(null);
    setMessage(null);
    try {
      const created = await api.createSite(normalizeSitePayload(createForm));
      setSites((current) => [...current, toSiteSummary(created)].sort(compareSites));
      setCreateForm(emptySite);
      setIsCreateDrawerOpen(false);
      setMessage("Baustelle angelegt.");
    } catch (requestError) {
      setError(readApiError(requestError, "Baustelle konnte nicht angelegt werden."));
    } finally {
      setSavingSiteId(null);
    }
  }

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
    setCreateForm(emptySite);
    setIsCreateDrawerOpen(true);
    if (peopleLoaded === false && peopleLoading === false) {
      void loadPeopleForSiteForm();
    }
  }

  async function loadPeopleForSiteForm() {
    setPeopleLoading(true);
    setError(null);
    try {
      setPeople(await api.persons({ isActive: null }));
      setPeopleLoaded(true);
    } catch (requestError) {
      setError(readApiError(requestError, "Projektleiter konnten nicht geladen werden."));
    } finally {
      setPeopleLoading(false);
    }
  }

  function closeDrawer() {
    setCreateForm(emptySite);
    setIsCreateDrawerOpen(false);
  }

  return (
    <section className="site-page">
      <div className="page-header entity-page-header">
        <div>
          <p className="eyebrow">Projektakte</p>
          <h1>Baustellen</h1>
        </div>
        {canEdit && (
          <button className="icon-button" type="button" onClick={openNewSiteDrawer}>
            <PlusCircle aria-hidden="true" size={17} />
            <span>Neue Baustelle</span>
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-info">{message}</p>}

      <div className="site-list-toolbar">
        <div className="site-list-toolbar-left">
          <input
            placeholder="Baustelle suchen"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
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
              {siteGroups.map((group) => (
                <section className="site-group-section" key={group.key}>
                  {group.showHeading && <h2>{group.label}</h2>}
                  <div className="entity-card-list">
                    {group.sites.map((site) => renderSiteCard(site, (siteId) => navigate(`/sites/${siteId}`), canEdit, savingSiteId === site.id, updateSiteStatus))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="entity-card-list" role="list">
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

      <EntityDetailDrawer
        isOpen={isCreateDrawerOpen}
        title="Neue Baustelle"
        subtitle="Stammdaten anlegen"
        onClose={closeDrawer}
        footer={canEdit ? (
          <button className="icon-button" disabled={savingSiteId === 0} type="button" onClick={() => void createSite()}>
            <PlusCircle aria-hidden="true" size={17} />
            <span>Baustelle anlegen</span>
          </button>
        ) : undefined}
      >
        <SiteFields
          draft={createForm}
          people={people}
          disabled={!canEdit}
          onChange={(values) => setCreateForm((current) => ({ ...current, ...values }))}
        />
      </EntityDetailDrawer>
    </section>
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
  };
}

export function SiteFields({
  draft,
  people,
  disabled = false,
  isCheckingLocation = false,
  onChange,
  onCheckLocation,
  onGeocodeSelected,
}: {
  draft: SiteCreate;
  people: Person[];
  disabled?: boolean;
  isCheckingLocation?: boolean;
  onChange: (values: Partial<SiteCreate>) => void;
  onCheckLocation?: () => void;
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

  function markLocationUnchecked(values: Partial<SiteCreate>): Partial<SiteCreate> {
    return {
      ...values,
      address: null,
      latitude: null,
      longitude: null,
      location_status: "unchecked",
    };
  }

  function updateManualAddress(values: Partial<SiteCreate>) {
    setSelectedGeocodeResult(null);
    onChange(markLocationUnchecked(values));
  }

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
    <div className="site-form-grid">
      <label className="site-field-name">
        <span>Baustelle</span>
        <input disabled={disabled} value={draft.name} onChange={(event) => onChange({ name: event.target.value })} />
      </label>
      <label className="site-field-number">
        <span>Nummer</span>
        <input
          disabled={disabled}
          value={draft.site_number ?? ""}
          onChange={(event) => onChange({ site_number: event.target.value || null })}
        />
      </label>
      <label className="site-field-location">
        <span>Ort</span>
        <input
          disabled={disabled}
          value={draft.location ?? ""}
          onChange={(event) => onChange({ location: event.target.value || null })}
        />
      </label>
      <label className="site-field-customer">
        <span>Kunde</span>
        <input
          disabled={disabled}
          value={draft.customer ?? ""}
          onChange={(event) => onChange({ customer: event.target.value || null })}
        />
      </label>
      <label className="site-field-manager">
        <span>Projektleiter</span>
        <select
          disabled={disabled}
          value={draft.project_manager_person_id ?? ""}
          onChange={(event) => onChange({ project_manager_person_id: parsePersonId(event.target.value) })}
        >
          <option value="">Nicht zugeordnet</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.display_name}{person.is_active ? "" : " (inaktiv)"}
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
        <div>
          <h3>Standort / GPS</h3>
          <p>Adresse suchen, passenden Treffer auswaehlen. Koordinaten werden technisch gespeichert.</p>
        </div>
        <label className="address-field site-address-search">
          <span>Adresse suchen</span>
          <input
            disabled={disabled}
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
            disabled={disabled}
            value={draft.postal_code ?? ""}
            onChange={(event) => updateManualAddress({ postal_code: event.target.value || null })}
          />
        </label>
        <label className="address-city-field">
          <span>Stadt</span>
          <input
            disabled={disabled}
            value={draft.city ?? ""}
            onChange={(event) => updateManualAddress({ city: event.target.value || null })}
          />
        </label>
        <label className="address-street-field">
          <span>Strasse</span>
          <input
            disabled={disabled}
            value={draft.street ?? ""}
            onChange={(event) => updateManualAddress({ street: event.target.value || null })}
          />
        </label>
        <label className="address-house-number-field">
          <span>Hausnummer</span>
          <input
            disabled={disabled}
            value={draft.house_number ?? ""}
            onChange={(event) => updateManualAddress({ house_number: event.target.value || null })}
          />
        </label>
        <label className="address-extra-field address-field">
          <span>Adresszusatz / Bereich</span>
          <input
            disabled={disabled}
            value={draft.address_extra ?? ""}
            onChange={(event) => updateManualAddress({ address_extra: event.target.value || null })}
          />
        </label>
        {draft.location_status !== "geocoded" && (
          <button
            className="icon-button secondary"
            disabled={disabled || !onCheckLocation || isCheckingLocation}
            type="button"
            onClick={onCheckLocation}
          >
            {isCheckingLocation ? "Standort wird geprueft..." : "Standort pruefen"}
          </button>
        )}
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

export function validateSitePayload(site: SiteCreate): string | null {
  if (!site.name.trim()) {
    return "Baustellenname ist Pflicht.";
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
        <span className="entity-card-color" style={{ backgroundColor: site.color ?? "#94a3b8" }} aria-hidden="true" />
        <span className="entity-card-icon"><BriefcaseBusiness aria-hidden="true" size={17} /></span>
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

const siteStatusOptions: Array<{ value: SiteStatus; label: string }> = [
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
