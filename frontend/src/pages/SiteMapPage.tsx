import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CircleMarker, MapContainer, Marker, Popup, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import { divIcon } from "leaflet";
import "leaflet/dist/leaflet.css";

import { useAuth } from "../auth/AuthContext";
import { siteStatusLabels } from "../components/StatusBadge";
import { api, ApiError, type VehicleLatestPositionItem } from "../lib/api";
import { formatGermanDateTimeShort } from "../lib/formatters";
import { getSiteColorDisplayValue } from "../lib/siteColors";
import { calendarPersonCode, type PersonMapItem, type PersonMapResponse, type PersonType } from "../types/person";
import type { SiteMapItem, SiteMapResponse } from "../types/site";

const GERMANY_CENTER: [number, number] = [51.1657, 10.4515];
const DEFAULT_ZOOM = 6;
const ALL_FILTER = "all";
const LABEL_OFFSET_PATTERN: Array<[number, number]> = [[0, -14], [18, -18], [-18, -18], [18, 6], [-18, 6]];
const EMPTY_SITES: SiteMapItem[] = [];
const EMPTY_PEOPLE: PersonMapItem[] = [];
const EMPTY_VEHICLES: VehicleLatestPositionItem[] = [];
const VEHICLE_ICON_HTML = `
  <span class="site-map-vehicle-icon-symbol" aria-hidden="true">🚗</span>
`;
const VEHICLE_MARKER_ICON = divIcon({
  className: "site-map-vehicle-icon",
  html: VEHICLE_ICON_HTML,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -18],
  tooltipAnchor: [0, -20],
});
const SELECTED_VEHICLE_MARKER_ICON = divIcon({
  className: "site-map-vehicle-icon is-selected",
  html: VEHICLE_ICON_HTML,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -18],
  tooltipAnchor: [0, -20],
});

type SiteLabelMode = "full" | "number" | "points";
type PersonLabelMode = "full" | "short" | "points";
type VehicleLabelMode = "full" | "points";
type VisibleMarkerState = {
  sites: number;
  persons: number;
  vehicles: number;
  zoom: number;
  hasDenseSites: boolean;
  hasDensePersons: boolean;
  hasDenseVehicles: boolean;
};

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
  const [vehicleData, setVehicleData] = useState<VehicleLatestPositionItem[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingPeople, setIsLoadingPeople] = useState(false);
  const [isLoadingVehicles, setIsLoadingVehicles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [personError, setPersonError] = useState<string | null>(null);
  const [vehicleError, setVehicleError] = useState<string | null>(null);
  const [showPersons, setShowPersons] = useState(false);
  const [showVehicles, setShowVehicles] = useState(false);
  const [projectFilter, setProjectFilter] = useState(ALL_FILTER);
  const [personFilter, setPersonFilter] = useState(ALL_FILTER);
  const [visibleMarkers, setVisibleMarkers] = useState<VisibleMarkerState>({
    sites: 15,
    persons: 15,
    vehicles: 15,
    zoom: DEFAULT_ZOOM,
    hasDenseSites: false,
    hasDensePersons: false,
    hasDenseVehicles: false,
  });
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState<number | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<number | null>(null);

  useEffect(() => {
    if (!user) {
      return;
    }
    setShowPersons(readMapBooleanPreference(user.id, "map_show_persons", false));
    setShowVehicles(readMapBooleanPreference(user.id, "map_show_vehicles", false));
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
    if (!showVehicles || vehicleData) {
      if (!showVehicles) {
        setVehicleError(null);
      }
      return;
    }
    let cancelled = false;
    setIsLoadingVehicles(true);
    setVehicleError(null);
    api
      .vehicleLatestPositions()
      .then((response) => {
        if (!cancelled) {
          setVehicleData(response);
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        if (caught instanceof ApiError) {
          setVehicleError(caught.message);
          return;
        }
        setVehicleError("Fahrzeugpositionen konnten nicht geladen werden.");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingVehicles(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showVehicles, vehicleData]);

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
    writeMapPreference(user.id, "map_show_vehicles", showVehicles ? "true" : "false");
  }, [showVehicles, user]);

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

  const sites = data?.sites ?? EMPTY_SITES;
  const people = personData?.people ?? EMPTY_PEOPLE;
  const vehicles = vehicleData ?? EMPTY_VEHICLES;
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
  const visiblePeopleForMap = useMemo(() => showPersons ? filteredPeople : [], [filteredPeople, showPersons]);
  const visibleVehiclesForMap = useMemo(
    () => showVehicles ? vehicles.filter(hasValidVehicleCoordinates) : [],
    [showVehicles, vehicles],
  );
  const siteLabelMode = siteLabelModeForVisibleMarkers(visibleMarkers);
  const personLabelMode = personLabelModeForVisibleMarkers(visibleMarkers);
  const vehicleLabelMode = vehicleLabelModeForVisibleMarkers(visibleMarkers);
  const siteLabelOffsets = useMemo(() => buildLabelOffsets(filteredSites), [filteredSites]);
  const personLabelOffsets = useMemo(() => buildLabelOffsets(filteredPeople), [filteredPeople]);
  const vehicleLabelOffsets = useMemo(() => buildVehicleLabelOffsets(visibleVehiclesForMap), [visibleVehiclesForMap]);
  const updateVisibleMarkerState = useCallback((nextMarkers: VisibleMarkerState) => {
    setVisibleMarkers((current) => areVisibleMarkerStatesEqual(current, nextMarkers) ? current : nextMarkers);
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

      <section className="site-map-controls" aria-label="Kartenfilter">
        <label>
          <span>Projekte anzeigen</span>
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value={ALL_FILTER}>Alle</option>
            {projectManagers.map((manager) => (
              <option key={manager.id} value={manager.id}>
                {calendarPersonCode(manager)}
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
                {calendarPersonCode(manager)}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-field site-map-toggle">
          <input checked={showPersons} type="checkbox" onChange={(event) => setShowPersons(event.target.checked)} />
          <span>Personen auf Karte anzeigen</span>
        </label>
        <label className="checkbox-field site-map-toggle">
          <input checked={showVehicles} type="checkbox" onChange={(event) => setShowVehicles(event.target.checked)} />
          <span>Fahrzeuge auf Karte anzeigen</span>
        </label>
        {isLoadingPeople && <span className="site-map-loading-note">Personen werden geladen...</span>}
        {isLoadingVehicles && <span className="site-map-loading-note">Fahrzeuge werden geladen...</span>}
        {showVehicles && !isLoadingVehicles && vehicleData && vehicles.length === 0 ? (
          <span className="site-map-loading-note">Keine Fahrzeugpositionen gespeichert.</span>
        ) : null}
        {showVehicles && !isLoadingVehicles && vehicles.length > 0 && visibleVehiclesForMap.length === 0 ? (
          <span className="site-map-loading-note">Fahrzeugpositionen ohne gueltige Koordinaten.</span>
        ) : null}
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {personError ? <p className="form-error">{personError}</p> : null}
      {vehicleError ? <p className="form-error">{vehicleError}</p> : null}

      <section className="site-map-card">
        {isLoading ? (
          <div className="empty-state">Baustellenkarte wird geladen...</div>
        ) : filteredSites.length === 0 && visiblePeopleForMap.length === 0 && visibleVehiclesForMap.length === 0 ? (
          <div className="empty-state">Keine Marker fuer die aktuellen Filter vorhanden.</div>
        ) : (
          <MapContainer center={GERMANY_CENTER} zoom={DEFAULT_ZOOM} scrollWheelZoom className="site-map-canvas">
            <VisibleMarkerTracker
              sites={filteredSites}
              people={visiblePeopleForMap}
              vehicles={visibleVehiclesForMap}
              onVisibleMarkersChange={updateVisibleMarkerState}
            />
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              referrerPolicy="strict-origin-when-cross-origin"
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {filteredSites.map((site) => {
              const isSelected = selectedSiteId === site.id;
              return (
                <CircleMarker
                  key={`site-${site.id}`}
                  center={[site.latitude, site.longitude]}
                  radius={isSelected ? 5.5 : 3.8}
                  pathOptions={{
                    color: isSelected ? "#ffffff" : siteMarkerFill(site, siteLabelMode),
                    fillColor: siteMarkerFill(site, siteLabelMode),
                    fillOpacity: siteLabelMode === "points" ? 0.68 : 0.82,
                    opacity: isSelected ? 1 : 0.9,
                    weight: isSelected ? 2 : 0,
                  }}
                  eventHandlers={{
                    click: () => {
                      setSelectedSiteId(site.id);
                      setSelectedPersonId(null);
                      setSelectedVehicleId(null);
                    },
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
            {showPersons && filteredPeople.map((person) => {
              const isSelected = selectedPersonId === person.id;
              return (
                <CircleMarker
                  key={`person-${person.id}`}
                  center={[person.address_latitude, person.address_longitude]}
                  radius={isSelected ? 5.5 : 3.8}
                  pathOptions={{
                    color: isSelected ? "#ffffff" : personMarkerFill(personLabelMode),
                    fillColor: personMarkerFill(personLabelMode),
                    fillOpacity: personLabelMode === "points" ? 0.68 : 0.82,
                    opacity: isSelected ? 1 : 0.9,
                    weight: isSelected ? 2 : 0,
                  }}
                  eventHandlers={{
                    click: () => {
                      setSelectedPersonId(person.id);
                      setSelectedSiteId(null);
                      setSelectedVehicleId(null);
                    },
                  }}
                >
                  <Tooltip
                    permanent={personLabelMode !== "points"}
                    direction="top"
                    offset={personLabelMode === "points" ? [0, -8] : personLabelOffsets[person.id] ?? LABEL_OFFSET_PATTERN[0]}
                    opacity={1}
                    className={personLabelMode === "points" ? "site-map-marker-label site-map-person-label site-map-marker-label-hover" : "site-map-marker-label site-map-person-label"}
                  >
                    {personMarkerLabel(person, personLabelMode)}
                  </Tooltip>
                  <Popup>
                    <PersonMapPopup person={person} />
                  </Popup>
                </CircleMarker>
              );
            })}
            {visibleVehiclesForMap.map((item) => {
              const isSelected = selectedVehicleId === item.vehicle.id;
              const center = vehicleMarkerCenter(item);
              return (
                <Marker
                  key={`vehicle-${item.vehicle.id}`}
                  position={center}
                  icon={vehicleMarkerIcon(isSelected)}
                  eventHandlers={{
                    click: () => {
                      setSelectedVehicleId(item.vehicle.id);
                      setSelectedSiteId(null);
                      setSelectedPersonId(null);
                    },
                  }}
                >
                  <Tooltip
                    permanent={vehicleLabelMode !== "points"}
                    direction="top"
                    offset={vehicleLabelMode === "points" ? [0, -9] : vehicleLabelOffsets[item.vehicle.id] ?? LABEL_OFFSET_PATTERN[0]}
                    opacity={1}
                    className={vehicleLabelMode === "points" ? "site-map-marker-label site-map-marker-label-hover site-map-vehicle-label" : "site-map-marker-label site-map-vehicle-label"}
                  >
                    {vehicleMarkerLabel(item)}
                  </Tooltip>
                  <Popup>
                    <VehicleMapPopup item={item} />
                  </Popup>
                </Marker>
              );
            })}
          </MapContainer>
        )}
      </section>
    </div>
  );
}

function VisibleMarkerTracker({
  sites,
  people,
  vehicles,
  onVisibleMarkersChange,
}: {
  sites: SiteMapItem[];
  people: PersonMapItem[];
  vehicles: VehicleLatestPositionItem[];
  onVisibleMarkersChange: (markers: VisibleMarkerState) => void;
}) {
  const map = useMapEvents({
    moveend: updateVisibleMarkers,
    zoomend: updateVisibleMarkers,
  });

  function updateVisibleMarkers() {
    if (!map || typeof map.getBounds !== "function") {
      return;
    }
    const bounds = map.getBounds();
    const visibleSites = sites.filter((site) => bounds.contains([site.latitude, site.longitude]));
    const visiblePeople = people.filter((person) => bounds.contains([person.address_latitude, person.address_longitude]));
    const visibleVehicles = vehicles.filter((vehicle) => bounds.contains(vehicleMarkerCenter(vehicle)));
    const zoom = map.getZoom?.() ?? DEFAULT_ZOOM;
    onVisibleMarkersChange({
      sites: visibleSites.length,
      persons: visiblePeople.length,
      vehicles: visibleVehicles.length,
      zoom,
      hasDenseSites: hasDenseSiteGroup(visibleSites, zoom),
      hasDensePersons: hasDensePersonGroup(visiblePeople, zoom),
      hasDenseVehicles: hasDenseVehicleGroup(visibleVehicles, zoom),
    });
  }

  useEffect(() => {
    updateVisibleMarkers();
  }, [map, onVisibleMarkersChange, people, sites, vehicles]);

  return null;
}

function SiteMapPopup({ site }: { site: SiteMapItem }) {
  const projectManager = site.project_manager ? calendarPersonCode(site.project_manager) : "Nicht zugeordnet";
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
  const projectManager = person.project_manager_assignment ? calendarPersonCode(person.project_manager_assignment) : "Nicht zugeordnet";
  return (
    <div className="site-map-popup">
      <strong>{person.display_name}</strong>
      <span>{personTypeLabels[person.role]}</span>
      <span>Startort: {[person.address_postal_code, person.address_city].filter(Boolean).join(" ") || "Nicht hinterlegt"}</span>
      <span>PL-Zuordnung: {projectManager}</span>
    </div>
  );
}

function VehicleMapPopup({ item }: { item: VehicleLatestPositionItem }) {
  const vehicle = item.vehicle;
  const position = item.position;
  const title = vehicleMarkerLabel(item);
  return (
    <div className="site-map-popup">
      <strong>{title}</strong>
      {vehicle.vehicle_registration ? <span>Kennzeichen: {vehicle.vehicle_registration}</span> : null}
      {vehicle.fleet_number ? <span>Flottennr.: {vehicle.fleet_number}</span> : null}
      <span>Letztes Signal: {formatVehicleEventTime(position.event_time_utc)}</span>
      <span>Geschwindigkeit: {formatVehicleSpeed(position.speed)}</span>
      <span>Zündung: {formatVehicleIgnition(position.ignition)}</span>
      {position.location_text ? <span>Ort: {position.location_text}</span> : null}
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

function personMarkerLabel(person: PersonMapItem, mode: PersonLabelMode): string {
  const name = person.short_name || truncateLabel(person.display_name, 16);
  if (mode === "short") {
    return name;
  }
  const place = person.address_city ? truncateLabel(person.address_city, 18) : "Startort";
  return `${name} · ${place}`;
}

function vehicleMarkerLabel(item: VehicleLatestPositionItem): string {
  return item.vehicle.label
    || item.vehicle.vehicle_registration
    || item.vehicle.fleet_number
    || `Fahrzeug ${item.vehicle.ctrack_node_id ?? item.vehicle.external_id}`;
}

function hasValidVehicleCoordinates(item: VehicleLatestPositionItem): boolean {
  const latitude = Number(item.position.latitude);
  const longitude = Number(item.position.longitude);
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

function vehicleMarkerCenter(item: VehicleLatestPositionItem): [number, number] {
  return [Number(item.position.latitude), Number(item.position.longitude)];
}

function vehicleMarkerIcon(isSelected: boolean) {
  return isSelected ? SELECTED_VEHICLE_MARKER_ICON : VEHICLE_MARKER_ICON;
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
    return getSiteColorDisplayValue(site.color);
  }
  if (site.status === "active") {
    return "#17803d";
  }
  if (site.status === "paused") {
    return "#d18b00";
  }
  if (site.status === "planned") {
    return "#2563eb";
  }
  if (site.status === "deleted") {
    return "#b91c1c";
  }
  return "#64748b";
}

function personMarkerFill(mode: PersonLabelMode): string {
  return mode === "points" ? "#b45309" : "#f97316";
}

function formatVehicleEventTime(value: string | null): string {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return formatGermanDateTimeShort(value);
}

function formatVehicleSpeed(value: number | null): string {
  if (value === null) {
    return "-";
  }
  return `${value.toLocaleString("de-DE", { maximumFractionDigits: 1 })} km/h`;
}

function formatVehicleIgnition(value: boolean | null): string {
  if (value === null) {
    return "-";
  }
  return value ? "an" : "aus";
}

function siteLabelModeForVisibleMarkers(markers: VisibleMarkerState): SiteLabelMode {
  if (markers.sites <= 0) {
    return "points";
  }
  if (markers.sites < 5) {
    if (markers.zoom <= 6) {
      return "points";
    }
    return markers.hasDenseSites || markers.zoom < 8 ? "number" : "full";
  }
  if (markers.sites < 15) {
    return markers.zoom >= 13 && !markers.hasDenseSites ? "full" : "number";
  }
  return "points";
}

function personLabelModeForVisibleMarkers(markers: VisibleMarkerState): PersonLabelMode {
  if (markers.persons <= 0) {
    return "points";
  }
  if (markers.persons < 5) {
    if (markers.zoom <= 6) {
      return "points";
    }
    return markers.hasDensePersons || markers.zoom < 8 ? "short" : "full";
  }
  if (markers.persons < 15) {
    return markers.zoom >= 13 && !markers.hasDensePersons ? "short" : "points";
  }
  return "points";
}

function vehicleLabelModeForVisibleMarkers(markers: VisibleMarkerState): VehicleLabelMode {
  if (markers.vehicles <= 0) {
    return "points";
  }
  if (markers.vehicles < 5) {
    return markers.zoom >= 8 && !markers.hasDenseVehicles ? "full" : "points";
  }
  if (markers.vehicles < 15) {
    return markers.zoom >= 13 && !markers.hasDenseVehicles ? "full" : "points";
  }
  return "points";
}

function areVisibleMarkerStatesEqual(left: VisibleMarkerState, right: VisibleMarkerState): boolean {
  return left.sites === right.sites
    && left.persons === right.persons
    && left.vehicles === right.vehicles
    && left.zoom === right.zoom
    && left.hasDenseSites === right.hasDenseSites
    && left.hasDensePersons === right.hasDensePersons
    && left.hasDenseVehicles === right.hasDenseVehicles;
}

function hasDenseSiteGroup(sites: SiteMapItem[], zoom: number): boolean {
  return hasDenseMarkerGroup(
    sites.map((site) => ({ latitude: site.latitude, longitude: site.longitude })),
    zoom,
  );
}

function hasDensePersonGroup(people: PersonMapItem[], zoom: number): boolean {
  return hasDenseMarkerGroup(
    people.map((person) => ({ latitude: person.address_latitude, longitude: person.address_longitude })),
    zoom,
  );
}

function hasDenseVehicleGroup(vehicles: VehicleLatestPositionItem[], zoom: number): boolean {
  return hasDenseMarkerGroup(
    vehicles.map((item) => ({ latitude: Number(item.position.latitude), longitude: Number(item.position.longitude) })),
    zoom,
  );
}

function hasDenseMarkerGroup(items: Array<{ latitude: number; longitude: number }>, zoom: number): boolean {
  if (items.length < 2) {
    return false;
  }
  const bucketSize = denseBucketSizeForZoom(zoom);
  const buckets = new Map<string, number>();
  for (const item of items) {
    const key = `${Math.round(item.latitude / bucketSize)}:${Math.round(item.longitude / bucketSize)}`;
    const count = (buckets.get(key) ?? 0) + 1;
    if (count >= 2) {
      return true;
    }
    buckets.set(key, count);
  }
  return false;
}

function denseBucketSizeForZoom(zoom: number): number {
  if (zoom >= 13) {
    return 0.004;
  }
  if (zoom >= 10) {
    return 0.012;
  }
  return 0.03;
}

function buildLabelOffsets<T extends { id: number; latitude?: number; longitude?: number; address_latitude?: number; address_longitude?: number }>(
  items: T[],
): Record<number, [number, number]> {
  const groups = new Map<string, T[]>();
  items.forEach((item) => {
    const latitude = item.latitude ?? item.address_latitude;
    const longitude = item.longitude ?? item.address_longitude;
    if (latitude === undefined || longitude === undefined) {
      return;
    }
    const key = `${Math.round(latitude / 0.025)}:${Math.round(longitude / 0.025)}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  });

  const offsets: Record<number, [number, number]> = {};
  groups.forEach((group) => {
    group
      .slice()
      .sort((left, right) => left.id - right.id)
      .forEach((item, index) => {
        offsets[item.id] = LABEL_OFFSET_PATTERN[index % LABEL_OFFSET_PATTERN.length];
      });
  });
  return offsets;
}

function buildVehicleLabelOffsets(items: VehicleLatestPositionItem[]): Record<number, [number, number]> {
  return buildLabelOffsets(
    items.map((item) => ({
      id: item.vehicle.id,
      latitude: Number(item.position.latitude),
      longitude: Number(item.position.longitude),
    })),
  );
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
