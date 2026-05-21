import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CircleMarker, MapContainer, Popup, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";

import { siteStatusLabels } from "../components/StatusBadge";
import { api, ApiError } from "../lib/api";
import type { SiteMapItem, SiteMapResponse } from "../types/site";

const GERMANY_CENTER: [number, number] = [51.1657, 10.4515];
const DEFAULT_ZOOM = 6;

export function SiteMapPage() {
  const [data, setData] = useState<SiteMapResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const sites = data?.sites ?? [];
  const projectManagerCount = useMemo(
    () => new Set(sites.map((site) => site.project_manager?.id).filter(Boolean)).size,
    [sites],
  );

  return (
    <div className="page-stack site-map-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Baustellen</p>
          <h1>Baustellenkarte</h1>
          <p className="page-subtitle">Aktive und pausierte Baustellen mit geprueftem Standort.</p>
        </div>
      </header>

      <section className="site-map-summary" aria-label="Kartenuebersicht">
        <InfoTile label="Marker" value={String(sites.length)} />
        <InfoTile label="Projektleiter" value={String(projectManagerCount)} />
        <InfoTile label="Ohne geprueften Standort" value={String(data?.missing_location ?? 0)} tone="warning" />
      </section>

      {error ? <p className="form-error">{error}</p> : null}

      <section className="site-map-card">
        {isLoading ? (
          <div className="empty-state">Baustellenkarte wird geladen...</div>
        ) : sites.length === 0 ? (
          <div className="empty-state">Noch keine Baustellen mit geprueftem Standort vorhanden.</div>
        ) : (
          <MapContainer center={GERMANY_CENTER} zoom={DEFAULT_ZOOM} scrollWheelZoom className="site-map-canvas">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {sites.map((site) => (
              <CircleMarker
                key={site.id}
                center={[site.latitude, site.longitude]}
                radius={9}
                pathOptions={{
                  color: "#172033",
                  fillColor: markerColor(site),
                  fillOpacity: 0.9,
                  weight: 1.5,
                }}
              >
                <Popup>
                  <SiteMapPopup site={site} />
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

function formatAddress(site: SiteMapItem): string {
  const streetLine = [site.street, site.house_number].filter(Boolean).join(" ");
  const cityLine = [site.postal_code, site.city].filter(Boolean).join(" ");
  return [streetLine, cityLine].filter(Boolean).join(", ") || "Adresse nicht hinterlegt";
}

function markerColor(site: SiteMapItem): string {
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
