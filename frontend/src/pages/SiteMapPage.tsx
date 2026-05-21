import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";

import { useAuth } from "../auth/AuthContext";
import { siteStatusLabels } from "../components/StatusBadge";
import { api, ApiError } from "../lib/api";
import type { PersonMapItem, PersonMapResponse, PersonType } from "../types/person";
import type { SiteMapItem, SiteMapResponse } from "../types/site";

const GERMANY_CENTER: [number, number] = [51.1657, 10.4515];
const DEFAULT_ZOOM = 6;
const ALL_FILTER = "all";
const LABEL_OFFSET_PATTERN: Array<[number, number]> = [[0, -14], [18, -18], [-18, -18], [18, 6], [-18, 6]];

type SiteLabelMode = "full" | "number" | "points";

type MapProjectManagerOption = {
  id: number;
  display_name: string;
  short_code: string;
};

const personTypeLabels: Record<PersonType, string> = {
  internal: "Intern",
  external: "Extern",
  external_temp: "Extern schnell",
};

export function SiteMapPage() {
  const { user } = useAuth();
  const [data, setData] = useState<SiteMapResponse | null>(null);
  const [personData, setPersonData] = useState<PersonMapResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingPeople, setIsLoadingPeople] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [personError, setPersonError] = useState<string | null>(null);
  const [showPersons, setShowPersons] = useState(false);
  const [projectFilter, setProjectFilter] = useState(ALL_FILTER);
  const [personFilter, setPersonFilter] = useState(ALL_FILTER);
  const [visibleSiteCount, setVisibleSiteCount] = useState(0);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);

  useEffect(() => {
    if (!user) {
      return;
    }
    setShowPersons(readMapBooleanPreference(user.id, "map_show_persons", false));
    setProjectFilter(readMapPreference(user.id, "map_project_filter", ALL_FILTER));
    setPersonFilter(readMapPreference(user.id, "map_person_filter", ALL_FILTER));
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    api
      .siteMap()
      .then((response) => {
        if (!cancelled) {
          setData(response);
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        if (caught instanceof ApiError) {
          setError(caught.message);
          return;
        }
        setError("Baustellenkarte konnte nicht geladen werden.");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!showPersons || personData) {
      return;
    }
    let cancelled = false;
    setIsLoadingPeople(true);
    setPersonError(null);
    api
      .personMap()
      .then((response) => {
        if (!cancelled) {
          setPersonData(response);
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        if (caught instanceof ApiError) {
          setPersonError(caught.message);
          return;
        }
        setPersonError("Personenmarker konnten nicht geladen werden.");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingPeople(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [personData, showPersons]);

  useEffect(() => {
    if (!user) {
      return;
    }
    writeMapPreference(user.id, "map_show_persons", showPersons ? "true" : "false");
  }, [showPersons, user]);

  useEffect(() => {
    if (!user) {
      return;
    }
    writeMapPreference(user.id, "map_project_filter", projectFilter);
  }, [projectFilter, user]);

  useEffect(() => {
    if (!user) {
      return;
    }
    writeMapPreference(user.id, "map_person_filter", personFilter);
  }, [personFilter, user]);

  const sites = data?.sites ?? [];
  const people = personData?.people ?? [];
  const projectManagers = useMemo(() => mapProjectManagerOptions(sites), [sites]);
  const personProjectManagers = useMemo(() => personProjectManagerOptions(people, projectManagers), [people, projectManagers]);
  const filteredSites = useMemo(
    () => sites.filter((site) => projectFilter === ALL_FILTER || String(site.project_manager?.id) === projectFilter),
    [projectFilter, sites],
  );
  const filteredPeople = useMemo(
    () => people.filter((person) => personFilter === ALL_FILTER || String(person.project_manager_assignment?.id) === personFilter),
    [people, personFilter],
  );
  const siteLabelMode = labelModeForVisibleCount(visibleSiteCount);
  const siteLabelOffsets = useMemo(() => buildSiteLabelOffsets(filteredSites), [filteredSites]);
  const updateVisibleSiteCount = useCallback((count: number) => {
    setVisibleSiteCount(count);
  }, []);

  return (
    <div className="page-stack site-map-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Baustellen</p>
          <h1>Baustellenkarte</h1>
          <p className="page-subtitle">Aktive und pausierte Baustellen sowie optionale Startorte von Personen.</p>
        </div>
      </header>

      <section className="site-map-summary" aria-label="Kartenuebersicht">
        <InfoTile label="Baustellenmarker" value={String(filteredSites.length)} />
        <InfoTile label="Personenmarker" value={showPersons ? String(filteredPeople.length) : "Aus"} />
        <InfoTile label="Baustellen ohne Standort" value={String(data?.missing_location ?? 0)} tone="warning" />
        <InfoTile label="Personen ohne Startort" value={showPersons ? String(personData?.missing_location ?? 0) : "-"} tone="warning" />
      </section>

      <section className="site-map-controls" aria-label="Kartenfilter">
        <label>
          <span>Projekte anzeigen</span>
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value={ALL_FILTER}>Alle</option>
            {projectManagers.map((manager) => (
              <option key={manager.id} value={manager.id}>
                {manager.short_code || manager.display_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Personen anzeigen</span>
          <select value={personFilter} onChange={(event) => setPersonFilter(event.target.value)} disabled={!showPersons}>
            <option value={ALL_FILTER}>Alle</option>
            {personProjectManagers.map((manager) => (
              <option key={manager.id} value={manager.id}>
                {manager.short_code || manager.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-field site-map-toggle">
          <input checked={showPersons} type="checkbox" onChange={(event) => setShowPersons(event.target.checked)} />
          <span>Personen auf Karte anzeigen</span>
        </label>
        {isLoadingPeople && <span className="site-map-loading-note">Personen werden geladen...</span>}
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {personError ? <p className="form-error">{personError}</p> : null}

      <section className="site-map-card">
        {isLoading ? (
          <div className="empty-state">Baustellenkarte wird geladen...</div>
        ) : filteredSites.length === 0 && (!showPersons || filteredPeople.length === 0) ? (
          <div className="empty-state">Keine Marker fuer die aktuellen Filter vorhanden.</div>
        ) : (
          <MapContainer center={GERMANY_CENTER} zoom={DEFAULT_ZOOM} scrollWheelZoom className="site-map-canvas">
            <VisibleSiteTracker sites={filteredSites} onVisibleCountChange={updateVisibleSiteCount} />
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {filteredSites.map((site) => {
              const isSelected = selectedSiteId === site.id;
              return (
                <CircleMarker
                  key={`site-${site.id}`}
                  center={[site.latitude, site.longitude]}
                  radius={isSelected ? 7 : 5}
                  pathOptions={{
                    color: isSelected ? "#f8fafc" : siteMarkerFill(site, siteLabelMode),
                    fillColor: siteMarkerFill(site, siteLabelMode),
                    fillOpacity: siteLabelMode === "points" ? 0.72 : 0.82,
                    opacity: isSelected ? 1 : 0.9,
                    weight: isSelected ? 2 : 0.5,
                  }}
                  eventHandlers={{
                    click: () => setSelectedSiteId(site.id),
                  }}
                >
                  <Tooltip
                    permanent={siteLabelMode !== "points"}
                    direction="top"
                    offset={siteLabelMode === "points" ? [0, -8] : siteLabelOffsets[site.id] ?? LABEL_OFFSET_PATTERN[0]}
                    opacity={1}
                    className={siteLabelMode === "points" ? "site-map-marker-label site-map-marker-label-hover" : "site-map-marker-label"}
                  >
                    {siteMarkerLabel(site, siteLabelMode)}
                  </Tooltip>
                  <Popup>
                    <SiteMapPopup site={site} />
                  </Popup>
                </CircleMarker>
              );
            })}
            {showPersons && filteredPeople.map((person) => (
              <CircleMarker
                key={`person-${person.id}`}
                center={[person.address_latitude, person.address_longitude]}
                radius={7}
                pathOptions={{
                  color: "#7c2d12",
                  fillColor: "#f97316",
                  fillOpacity: 0.86,
                  weight: 2,
                  dashArray: "3 2",
                }}
              >
                <Tooltip permanent direction="right" offset={[8, 0]} opacity={1} className="site-map-marker-label site-map-person-label">
                  {personMarkerLabel(person)}
                </Tooltip>
                <Popup>
                  <PersonMapPopup person={person} />
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>
        )}
      </section>
    </div>
  );
}

type InfoTileProps = {
  label: string;
  value: string;
  tone?: "default" | "warning";
};

function VisibleSiteTracker({
  sites,
  onVisibleCountChange,
}: {
  sites: SiteMapItem[];
  onVisibleCountChange: (count: number) => void;
}) {
  const map = useMapEvents({
    moveend: updateVisibleSites,
    zoomend: updateVisibleSites,
  });

  function updateVisibleSites() {
    const bounds = map.getBounds();
    onVisibleCountChange(sites.filter((site) => bounds.contains([site.latitude, site.longitude])).length);
  }

  useEffect(() => {
    updateVisibleSites();
  }, [map, onVisibleCountChange, sites]);

  return null;
}

function InfoTile({ label, value, tone = "default" }: InfoTileProps) {
  return (
    <article className={`site-map-info-tile site-map-info-tile-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SiteMapPopup({ site }: { site: SiteMapItem }) {
  const projectManager = site.project_manager?.short_code || site.project_manager?.display_name || "Nicht zugeordnet";
  return (
    <div className="site-map-popup">
      <strong>{site.name}</strong>
      {site.number ? <span>{site.number}</span> : null}
      <span>{formatAddress(site)}</span>
      <span>PL: {projectManager}</span>
      <span>Status: {siteStatusLabels[site.status]}</span>
      <span>Radius: {site.geofence_radius_m.toLocaleString("de-DE")} m</span>
      <Link to={`/sites/${site.id}`}>Baustelle oeffnen</Link>
    </div>
  );
}

function PersonMapPopup({ person }: { person: PersonMapItem }) {
  const projectManager = person.project_manager_assignment?.short_code || person.project_manager_assignment?.display_name || "Nicht zugeordnet";
  return (
    <div className="site-map-popup">
      <strong>{person.display_name}</strong>
      <span>{personTypeLabels[person.role]}</span>
      <span>Startort: {[person.address_postal_code, person.address_city].filter(Boolean).join(" ") || "Nicht hinterlegt"}</span>
      <span>PL-Zuordnung: {projectManager}</span>
    </div>
  );
}

function formatAddress(site: SiteMapItem): string {
  const streetLine = [site.street, site.house_number].filter(Boolean).join(" ");
  const cityLine = [site.postal_code, site.city].filter(Boolean).join(" ");
  return [streetLine, cityLine].filter(Boolean).join(", ") || "Adresse nicht hinterlegt";
}

function siteMarkerLabel(site: SiteMapItem, mode: SiteLabelMode): string {
  if (mode === "number") {
    return site.number || truncateLabel(site.name || site.city || "Baustelle", 12);
  }
  const prefix = site.number ? `${site.number} · ` : "";
  return `${prefix}${truncateLabel(site.name || site.city || "Baustelle")}`;
}

function personMarkerLabel(person: PersonMapItem): string {
  return `${person.short_name} · ${truncateLabel(person.address_city || person.display_name, 18)}`;
}

function truncateLabel(value: string, max = 24): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 3)}...`;
}

function siteMarkerFill(site: SiteMapItem, mode: SiteLabelMode): string {
  if (mode === "points") {
    return "#64748b";
  }
  if (site.color && /^#[0-9a-f]{6}$/i.test(site.color)) {
    return site.color;
  }
  if (site.status === "active") {
    return "#17803d";
  }
  if (site.status === "paused") {
    return "#d18b00";
  }
  return "#64748b";
}

function labelModeForVisibleCount(count: number): SiteLabelMode {
  if (count < 5) {
    return "full";
  }
  if (count < 15) {
    return "number";
  }
  return "points";
}

function buildSiteLabelOffsets(sites: SiteMapItem[]): Record<number, [number, number]> {
  const groups = new Map<string, SiteMapItem[]>();
  sites.forEach((site) => {
    const key = `${Math.round(site.latitude / 0.025)}:${Math.round(site.longitude / 0.025)}`;
    const group = groups.get(key) ?? [];
    group.push(site);
    groups.set(key, group);
  });

  const offsets: Record<number, [number, number]> = {};
  groups.forEach((group) => {
    group
      .slice()
      .sort((left, right) => left.id - right.id)
      .forEach((site, index) => {
        offsets[site.id] = LABEL_OFFSET_PATTERN[index % LABEL_OFFSET_PATTERN.length];
      });
  });
  return offsets;
}

function mapProjectManagerOptions(sites: SiteMapItem[]): MapProjectManagerOption[] {
  const byId = new Map<number, MapProjectManagerOption>();
  for (const site of sites) {
    if (site.project_manager) {
      byId.set(site.project_manager.id, site.project_manager);
    }
  }
  return Array.from(byId.values()).sort((left, right) => left.display_name.localeCompare(right.display_name));
}

function personProjectManagerOptions(people: PersonMapItem[], fallback: MapProjectManagerOption[]): MapProjectManagerOption[] {
  const byId = new Map<number, MapProjectManagerOption>();
  for (const manager of fallback) {
    byId.set(manager.id, manager);
  }
  for (const person of people) {
    if (person.project_manager_assignment) {
      byId.set(person.project_manager_assignment.id, person.project_manager_assignment);
    }
  }
  return Array.from(byId.values()).sort((left, right) => left.display_name.localeCompare(right.display_name));
}

function mapPreferenceKey(userId: number, key: string): string {
  return `kb_user_${userId}_${key}`;
}

function readMapPreference(userId: number, key: string, fallback: string): string {
  return localStorage.getItem(mapPreferenceKey(userId, key)) ?? fallback;
}

function readMapBooleanPreference(userId: number, key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(mapPreferenceKey(userId, key));
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

function writeMapPreference(userId: number, key: string, value: string) {
  localStorage.setItem(mapPreferenceKey(userId, key), value);
}
