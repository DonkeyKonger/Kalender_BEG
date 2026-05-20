import { ArchiveRestore, ChevronRight, MapPin, PlusCircle, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import type { SiteStatus } from "../types/matrix";
import type { Person } from "../types/person";
import type { Site, SiteCreate } from "../types/site";

const statusLabels: Record<SiteStatus, string> = {
  active: "Aktiv",
  paused: "Pause",
  closed: "Zu",
  archived: "Archiv",
};

const emptySite: SiteCreate = {
  site_number: null,
  name: "",
  location: null,
  address: null,
  customer: null,
  project_manager_person_id: null,
  status: "active",
  info: null,
  color: "#1d5c99",
};

type EditableSite = SiteCreate & { id: number };

export function SitesPage() {
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "project_manager";
  const [sites, setSites] = useState<Site[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditableSite>>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [createForm, setCreateForm] = useState<SiteCreate>(emptySite);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [savingSiteId, setSavingSiteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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

  const filteredSites = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) {
      return sites;
    }
    return sites.filter((site) => siteSearchText(site).includes(needle));
  }, [searchTerm, sites]);

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
      setMessage("Baustelle angelegt.");
    } catch (requestError) {
      setError(readApiError(requestError, "Baustelle konnte nicht angelegt werden."));
    } finally {
      setSavingSiteId(null);
    }
  }

  async function saveSite(siteId: number) {
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
    setSavingSiteId(siteId);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.updateSite(siteId, normalizeSitePayload(draft));
      replaceSite(updated);
      setMessage("Baustelle gespeichert.");
    } catch (requestError) {
      setError(readApiError(requestError, "Baustelle konnte nicht gespeichert werden."));
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
      setMessage("Baustelle geschlossen.");
    } catch (requestError) {
      setError(readApiError(requestError, "Baustelle konnte nicht geschlossen werden."));
    } finally {
      setSavingSiteId(null);
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

  return (
    <section className="site-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Projektakte</p>
          <h1>Baustellen</h1>
        </div>
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
      </div>

      {canEdit && (
        <section className="site-create-panel">
          <h2>
            <PlusCircle aria-hidden="true" size={18} />
            Neue Baustelle
          </h2>
          <SiteFields
            draft={createForm}
            people={people}
            onChange={(values) => setCreateForm((current) => ({ ...current, ...values }))}
          />
          <button
            className="icon-button"
            disabled={savingSiteId === 0}
            type="button"
            onClick={() => void createSite()}
          >
            <PlusCircle aria-hidden="true" size={17} />
            <span>Baustelle anlegen</span>
          </button>
        </section>
      )}

      {isLoading && <div className="matrix-state">Baustellen werden geladen...</div>}

      {!isLoading && !error && (
        <div className="site-list" role="list">
          {filteredSites.map((site) => {
            const draft = drafts[site.id] ?? toEditableSite(site);
            const isClosed = site.status === "closed" || site.status === "archived";
            return (
              <article className="site-admin-row" key={site.id} role="listitem">
                <div className="site-row-header">
                  <span className="site-color" style={{ backgroundColor: site.color ?? "#94a3b8" }} />
                  <Link className="site-list-link" to={`/sites/${site.id}`}>
                    <span className="site-row-main">
                      <strong>{site.name}</strong>
                      <small>{[site.site_number, site.customer].filter(Boolean).join(" - ")}</small>
                    </span>
                  </Link>
                  <span className="site-row-location">
                    <MapPin aria-hidden="true" size={15} />
                    <span>{site.location ?? ""}</span>
                  </span>
                  <span className={`status-badge status-${site.status}`}>
                    {statusLabels[site.status]}
                  </span>
                  <Link className="site-open-link" to={`/sites/${site.id}`} aria-label="Projektakte oeffnen">
                    <ChevronRight aria-hidden="true" size={18} />
                  </Link>
                </div>

                {canEdit && (
                  <>
                    <SiteFields
                      draft={draft}
                      compact
                      people={people}
                      onChange={(values) => updateDraft(site.id, values)}
                    />
                    <div className="site-actions">
                      <button
                        className="icon-button secondary"
                        disabled={savingSiteId === site.id}
                        type="button"
                        onClick={() => void saveSite(site.id)}
                      >
                        <Save aria-hidden="true" size={16} />
                        <span>Speichern</span>
                      </button>
                      {isClosed ? (
                        <button
                          className="icon-button secondary"
                          disabled={savingSiteId === site.id}
                          type="button"
                          onClick={() => void reactivateSite(site.id)}
                        >
                          <ArchiveRestore aria-hidden="true" size={16} />
                          <span>Reaktivieren</span>
                        </button>
                      ) : (
                        <button
                          className="icon-button secondary"
                          disabled={savingSiteId === site.id}
                          type="button"
                          onClick={() => void closeSite(site.id)}
                        >
                          <span>Schliessen</span>
                        </button>
                      )}
                    </div>
                  </>
                )}
              </article>
            );
          })}
          {!filteredSites.length && <p className="empty-inline">Keine Baustellen gefunden.</p>}
        </div>
      )}
    </section>
  );
}

function SiteFields({
  draft,
  people,
  compact = false,
  onChange,
}: {
  draft: SiteCreate;
  people: Person[];
  compact?: boolean;
  onChange: (values: Partial<SiteCreate>) => void;
}) {
  return (
    <div className={compact ? "site-form-grid compact" : "site-form-grid"}>
      <label>
        <span>Baustelle</span>
        <input value={draft.name} onChange={(event) => onChange({ name: event.target.value })} />
      </label>
      <label>
        <span>Nummer</span>
        <input
          value={draft.site_number ?? ""}
          onChange={(event) => onChange({ site_number: event.target.value || null })}
        />
      </label>
      <label>
        <span>Ort</span>
        <input
          value={draft.location ?? ""}
          onChange={(event) => onChange({ location: event.target.value || null })}
        />
      </label>
      <label>
        <span>Kunde</span>
        <input
          value={draft.customer ?? ""}
          onChange={(event) => onChange({ customer: event.target.value || null })}
        />
      </label>
      <label>
        <span>Projektleiter</span>
        <select
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
      <label>
        <span>Status</span>
        <select
          value={draft.status}
          onChange={(event) => onChange({ status: event.target.value as SiteStatus })}
        >
          {Object.entries(statusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Farbe</span>
        <input
          type="color"
          value={draft.color ?? "#94a3b8"}
          onChange={(event) => onChange({ color: event.target.value })}
        />
      </label>
      <label className="address-field">
        <span>Adresse</span>
        <input
          value={draft.address ?? ""}
          onChange={(event) => onChange({ address: event.target.value || null })}
        />
      </label>
      <label className="site-info-field">
        <span>Info</span>
        <textarea
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
  return left.name.localeCompare(right.name);
}

function siteSearchText(site: Site): string {
  return [
    site.name,
    site.site_number,
    site.location,
    site.customer,
    site.project_manager?.display_name,
    statusLabels[site.status],
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
