import { ArchiveRestore, BriefcaseBusiness, ExternalLink, PlusCircle, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { EntityCard } from "../components/EntityCard";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { SiteStatusBadge, siteStatusLabels } from "../components/StatusBadge";
import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import type { SiteStatus } from "../types/matrix";
import type { Person } from "../types/person";
import type { Site, SiteCreate, SiteGeocodeSearchResult, SiteLocationStatus } from "../types/site";

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

type EditableSite = SiteCreate & { id: number };
type DrawerState = { mode: "new" } | { mode: "edit"; siteId: number } | null;
type ProjectManagerOption = { id: number; name: string; shortCode: string };
type SiteGroup = { key: string; label: string; sites: Site[]; showHeading: boolean };
type SiteColorOption = { name: string; value: string };

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
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "project_manager";
  const canRemove = user?.role === "admin";
  const [sites, setSites] = useState<Site[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditableSite>>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [createForm, setCreateForm] = useState<SiteCreate>(emptySite);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [isEditingSite, setIsEditingSite] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [projectManagerFilter, setProjectManagerFilter] = useState("all");
  const [hasInitializedProjectManagerFilter, setHasInitializedProjectManagerFilter] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [savingSiteId, setSavingSiteId] = useState<number | null>(null);
  const [checkingLocationSiteId, setCheckingLocationSiteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [removalPlans, setRemovalPlans] = useState<Record<number, "delete" | "archive">>({});

  useEffect(() => {
    void loadData();
  }, [includeClosed]);

  async function loadData() {
    setIsLoading(true);
    setError(null);
    try {
      const [siteData, personData] = await Promise.all([
        api.sites({ includeClosed }),
        api.persons({ isActive: null }),
      ]);
      setSites(siteData);
      setDrafts(toEditableSites(siteData));
      setPeople(personData);
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

  const filteredSites = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) {
      return sites;
    }
    return sites.filter((site) => siteSearchText(site).includes(needle));
  }, [searchTerm, sites]);

  const siteGroups = useMemo(() => groupSites(filteredSites, projectManagerFilter), [filteredSites, projectManagerFilter]);
  const visibleSiteCount = siteGroups.reduce((count, group) => count + group.sites.length, 0);

  const selectedSite = drawer?.mode === "edit"
    ? sites.find((site) => site.id === drawer.siteId) ?? null
    : null;
  const selectedDraft = drawer?.mode === "edit" && selectedSite
    ? drafts[selectedSite.id] ?? toEditableSite(selectedSite)
    : null;

  useEffect(() => {
    if (!selectedSite || !isEditingSite || !canRemove || removalPlans[selectedSite.id]) {
      return;
    }
    void loadSiteRemovalPlan(selectedSite.id);
  }, [canRemove, isEditingSite, removalPlans, selectedSite]);

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
      setSites((current) => [...current, created].sort(compareSites));
      setDrafts((current) => ({ ...current, [created.id]: toEditableSite(created) }));
      setCreateForm(emptySite);
      setDrawer(null);
      setMessage("Baustelle angelegt.");
    } catch (requestError) {
      setError(readApiError(requestError, "Baustelle konnte nicht angelegt werden."));
    } finally {
      setSavingSiteId(null);
    }
  }

  async function saveSite(siteId: number): Promise<boolean> {
    const draft = drafts[siteId];
    if (!draft) {
      return false;
    }
    const validationError = validateSitePayload(draft);
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return false;
    }
    setSavingSiteId(siteId);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.updateSite(siteId, normalizeSitePayload(draft));
      replaceSite(updated);
      setMessage("Baustelle gespeichert.");
      return true;
    } catch (requestError) {
      setError(readApiError(requestError, "Baustelle konnte nicht gespeichert werden."));
      return false;
    } finally {
      setSavingSiteId(null);
    }
  }

  async function loadSiteRemovalPlan(siteId: number) {
    try {
      const plan = await api.siteRemovalPlan(siteId);
      setRemovalPlans((current) => ({ ...current, [siteId]: plan.action }));
    } catch {
      setRemovalPlans((current) => ({ ...current, [siteId]: "archive" }));
    }
  }

  async function removeSite(siteId: number) {
    const plan = removalPlans[siteId] ?? "archive";
    const confirmed = window.confirm(
      plan === "delete"
        ? "Dieser Baustellendatensatz hat keine abhaengigen Daten und kann endgueltig geloescht werden. Diese Aktion kann nicht rueckgaengig gemacht werden. Fortfahren?"
        : "Diese Baustelle wird archiviert und aus der Standardansicht ausgeblendet. Historische Planungen bleiben erhalten. Fortfahren?",
    );
    if (!confirmed) {
      return;
    }

    setSavingSiteId(siteId);
    setError(null);
    setMessage(null);
    try {
      const result = await api.removeSite(siteId);
      if (result.action === "deleted") {
        setSites((current) => current.filter((site) => site.id !== siteId));
        setDrafts((current) => {
          const next = { ...current };
          delete next[siteId];
          return next;
        });
        setMessage("Baustelle geloescht.");
      } else if (result.site) {
        replaceSite(result.site);
        setMessage("Baustelle archiviert.");
      }
      setDrawer(null);
      setIsEditingSite(false);
    } catch (requestError) {
      setError(readApiError(requestError, "Baustelle konnte nicht entfernt werden."));
    } finally {
      setSavingSiteId(null);
    }
  }

  async function closeSite(siteId: number) {
    setSavingSiteId(siteId);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.closeSite(siteId);
      replaceSite(updated);
      if (!includeClosed) {
        setDrawer(null);
      }
      setMessage("Baustelle geschlossen.");
    } catch (requestError) {
      setError(readApiError(requestError, "Baustelle konnte nicht geschlossen werden."));
    } finally {
      setSavingSiteId(null);
    }
  }

  async function applyGeocodedSite(siteId: number, values: Partial<SiteCreate>) {
    const draft = drafts[siteId];
    if (!draft) {
      return;
    }
    const nextDraft = { ...draft, ...values };
    setSavingSiteId(siteId);
    setError(null);
    setMessage(null);
    updateDraft(siteId, values as Partial<EditableSite>);
    try {
      const updated = await api.updateSite(siteId, normalizeSitePayload(nextDraft));
      replaceSite(updated);
      setMessage("Standort aus Vorschlag uebernommen und gespeichert.");
    } catch (requestError) {
      setError(readApiError(requestError, "Standort konnte nicht gespeichert werden."));
    } finally {
      setSavingSiteId(null);
    }
  }

  async function checkSiteLocation(siteId: number) {
    const draft = drafts[siteId];
    if (!draft) {
      return;
    }
    const validationError = validateSitePayload(draft);
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }
    setCheckingLocationSiteId(siteId);
    setError(null);
    setMessage(null);
    try {
      await api.updateSite(siteId, normalizeSitePayload(draft));
      const updated = await api.checkSiteLocation(siteId);
      replaceSite(updated);
      if (updated.location_status === "geocoded") {
        setMessage("Standort wurde geprueft und Koordinaten wurden gespeichert.");
      } else if (updated.location_status === "ambiguous") {
        setError("Standort ist nicht eindeutig. Bitte Adresse genauer erfassen.");
      } else {
        setError("Standort konnte nicht geprueft werden. Bitte Adresse pruefen.");
      }
    } catch (requestError) {
      setError(readApiError(requestError, "Standort konnte nicht geprueft werden."));
    } finally {
      setCheckingLocationSiteId(null);
    }
  }

  async function reactivateSite(siteId: number) {
    setSavingSiteId(siteId);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.reactivateSite(siteId);
      replaceSite(updated);
      setMessage("Baustelle reaktiviert.");
    } catch (requestError) {
      setError(readApiError(requestError, "Baustelle konnte nicht reaktiviert werden."));
    } finally {
      setSavingSiteId(null);
    }
  }

  function replaceSite(updated: Site) {
    setSites((current) => {
      const shouldHide = !includeClosed && ["closed", "archived"].includes(updated.status);
      if (shouldHide) {
        return current.filter((site) => site.id !== updated.id);
      }
      const exists = current.some((site) => site.id === updated.id);
      const next = exists
        ? current.map((site) => site.id === updated.id ? updated : site)
        : [...current, updated];
      return next.sort(compareSites);
    });
    setDrafts((current) => ({ ...current, [updated.id]: toEditableSite(updated) }));
  }

  function updateDraft(siteId: number, values: Partial<EditableSite>) {
    setDrafts((current) => ({
      ...current,
      [siteId]: { ...current[siteId], ...values },
    }));
  }

  function openNewSiteDrawer() {
    setCreateForm(emptySite);
    setIsEditingSite(false);
    setDrawer({ mode: "new" });
  }

  function openSiteDrawer(siteId: number) {
    setIsEditingSite(false);
    setDrawer({ mode: "edit", siteId });
  }

  function cancelSiteEdit() {
    if (selectedSite) {
      setDrafts((current) => ({ ...current, [selectedSite.id]: toEditableSite(selectedSite) }));
    }
    setIsEditingSite(false);
    setError(null);
  }

  function closeDrawer() {
    if (drawer?.mode === "edit" && selectedSite) {
      setDrafts((current) => ({ ...current, [selectedSite.id]: toEditableSite(selectedSite) }));
    }
    if (drawer?.mode === "new") {
      setCreateForm(emptySite);
    }
    setIsEditingSite(false);
    setDrawer(null);
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
        <input
          placeholder="Baustelle suchen"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
        />
        <label className="checkbox-field inline">
          <input
            checked={includeClosed}
            type="checkbox"
            onChange={(event) => setIncludeClosed(event.target.checked)}
          />
          <span>Archiv zeigen</span>
        </label>
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
                {manager.shortCode || manager.name}
              </button>
            ))}
          </div>
        )}
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
                    {group.sites.map((site) => renderSiteCard(site, openSiteDrawer))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="entity-card-list" role="list">
              {siteGroups.flatMap((group) => group.sites).map((site) => renderSiteCard(site, openSiteDrawer))}
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
        isOpen={drawer?.mode === "new"}
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

      <EntityDetailDrawer
        isOpen={drawer?.mode === "edit" && Boolean(selectedSite && selectedDraft)}
        title={selectedSite ? isEditingSite ? "Baustelle bearbeiten" : "Baustelle" : "Baustelle"}
        subtitle={selectedSite ? [selectedSite.site_number, selectedSite.name].filter(Boolean).join(" · ") : undefined}
        onClose={closeDrawer}
        actions={selectedSite && canEdit && !isEditingSite ? (
          <button className="icon-button secondary" type="button" onClick={() => setIsEditingSite(true)}>
            <span>Bearbeiten</span>
          </button>
        ) : undefined}
        footer={selectedSite && selectedDraft ? (
          isEditingSite && canEdit ? (
            <>
              {canRemove && (
                <button
                  className="icon-button danger danger-action"
                  disabled={savingSiteId === selectedSite.id}
                  type="button"
                  onClick={() => void removeSite(selectedSite.id)}
                >
                  <Trash2 aria-hidden="true" size={16} />
                  <span>{removalPlans[selectedSite.id] === "delete" ? "Baustelle loeschen" : "Baustelle archivieren"}</span>
                </button>
              )}
              <button className="icon-button secondary" disabled={savingSiteId === selectedSite.id} type="button" onClick={cancelSiteEdit}>
                <span>Abbrechen</span>
              </button>
              <button
                className="icon-button secondary"
                disabled={savingSiteId === selectedSite.id}
                type="button"
                onClick={() => {
                  void saveSite(selectedSite.id).then((saved) => {
                    if (saved) {
                      setIsEditingSite(false);
                    }
                  });
                }}
              >
                <Save aria-hidden="true" size={16} />
                <span>Speichern</span>
              </button>
              {selectedSite.status === "closed" || selectedSite.status === "archived" ? (
                <button
                  className="icon-button secondary"
                  disabled={savingSiteId === selectedSite.id}
                  type="button"
                  onClick={() => void reactivateSite(selectedSite.id)}
                >
                  <ArchiveRestore aria-hidden="true" size={16} />
                  <span>Reaktivieren</span>
                </button>
              ) : (
                <button
                  className="icon-button secondary"
                  disabled={savingSiteId === selectedSite.id}
                  type="button"
                  onClick={() => void closeSite(selectedSite.id)}
                >
                  <span>Schliessen</span>
                </button>
              )}
            </>
          ) : (
            <>
              <Link className="icon-button secondary" to={`/sites/${selectedSite.id}`}>
                <ExternalLink aria-hidden="true" size={16} />
                <span>Projektakte</span>
              </Link>
              <button className="icon-button secondary" type="button" onClick={closeDrawer}>
                <span>Schliessen</span>
              </button>
            </>
          )
        ) : undefined}
      >
        {selectedSite && selectedDraft && (
          isEditingSite ? (
            <SiteFields
              draft={selectedDraft}
              people={people}
              disabled={!canEdit}
              isCheckingLocation={checkingLocationSiteId === selectedSite.id}
              onChange={(values) => updateDraft(selectedSite.id, values)}
              onCheckLocation={() => void checkSiteLocation(selectedSite.id)}
              onGeocodeSelected={(values) => void applyGeocodedSite(selectedSite.id, values)}
            />
          ) : (
            <SiteReadView site={selectedSite} />
          )
        )}
      </EntityDetailDrawer>
    </section>
  );
}

function SiteReadView({ site }: { site: Site }) {
  const projectManager = site.project_manager?.display_name || "Nicht zugeordnet";
  const addressText = formatSiteAddress(site);
  return (
    <div className="detail-read-view">
      <section className="detail-read-section">
        <h3>Stammdaten</h3>
        <div className="detail-read-grid">
          <ReadItem label="Baustelle" value={site.name} />
          <ReadItem label="Nummer" value={site.site_number || "-"} />
          <ReadItem label="Ort" value={site.location || site.city || "-"} />
          <ReadItem label="Kunde" value={site.customer || "-"} />
          <ReadItem label="Projektleiter" value={projectManager} />
          <div className="detail-read-item">
            <span>Status</span>
            <strong><SiteStatusBadge status={site.status} /></strong>
          </div>
        </div>
      </section>

      <section className="detail-read-section">
        <h3>Adresse / Standort</h3>
        <div className={`detail-address-card ${addressText ? "has-address" : "is-empty"}`}>
          <span>{addressText ? "Adresse hinterlegt" : "Keine Adresse hinterlegt"}</span>
          {addressText ? <strong>{addressText}</strong> : null}
        </div>
      </section>

      <section className="detail-read-section">
        <h3>Info / Notizen</h3>
        <p className={site.info ? "detail-note" : "detail-empty"}>{site.info || "Keine Info hinterlegt."}</p>
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

function SiteFields({
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

function toEditableSites(sites: Site[]): Record<string, EditableSite> {
  return Object.fromEntries(sites.map((site) => [String(site.id), toEditableSite(site)]));
}

function toEditableSite(site: Site): EditableSite {
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

function validateSitePayload(site: SiteCreate): string | null {
  if (!site.name.trim()) {
    return "Baustellenname ist Pflicht.";
  }
  return null;
}

function normalizeSitePayload(site: SiteCreate): SiteCreate {
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

function compareSites(left: Site, right: Site): number {
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
  const label = selectedOption?.name ?? "Aktuelle Farbe";

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

function renderSiteCard(site: Site, openSiteDrawer: (siteId: number) => void) {
  return (
    <EntityCard
      key={site.id}
      title={site.name}
      subtitle={[site.site_number, site.location].filter(Boolean).join(" · ") || "Ohne Ort"}
      meta={siteCardMeta(site)}
      color={site.color ?? "#94a3b8"}
      icon={<BriefcaseBusiness aria-hidden="true" size={17} />}
      status={<SiteStatusBadge status={site.status} />}
      isInactive={site.status === "closed" || site.status === "archived"}
      onClick={() => openSiteDrawer(site.id)}
    />
  );
}

function projectManagerOptionsFromSites(sites: Site[]): ProjectManagerOption[] {
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

function groupSites(sites: Site[], projectManagerFilter: string): SiteGroup[] {
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

function siteCardMeta(site: Site): string[] {
  return [
    site.project_manager ? `PL: ${site.project_manager.short_code || site.project_manager.display_name}` : "PL: offen",
    site.customer ? `Kunde: ${site.customer}` : "",
  ].filter(Boolean);
}

function siteSearchText(site: Site): string {
  return [
    site.name,
    site.site_number,
    site.location,
    site.address,
    site.postal_code,
    site.city,
    site.street,
    site.house_number,
    site.address_extra,
    site.customer,
    site.project_manager?.display_name,
    site.project_manager?.short_code,
    siteStatusLabels[site.status],
  ].filter(Boolean).join(" ").toLowerCase();
}

function formatSiteAddress(site: Pick<Site, "address" | "postal_code" | "city" | "street" | "house_number" | "address_extra">): string {
  if (site.address) {
    return site.address;
  }
  const streetLine = [site.street, site.house_number].filter(Boolean).join(" ");
  const cityLine = [site.postal_code, site.city].filter(Boolean).join(" ");
  return [streetLine, site.address_extra, cityLine].filter(Boolean).join(", ");
}

function formatGeocodeMeta(result: SiteGeocodeSearchResult): string {
  const place = [result.postal_code, result.city].filter(Boolean).join(" ");
  const precision = result.street || result.house_number ? "Adresse" : "Ort";
  return [place, precision].filter(Boolean).join(" · ");
}

const siteLocationStatusLabels: Record<SiteLocationStatus, string> = {
  unchecked: "Ungeprueft",
  geocoded: "Geprueft",
  ambiguous: "Nicht eindeutig",
  failed: "Fehler",
};

function parsePositiveInt(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
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
