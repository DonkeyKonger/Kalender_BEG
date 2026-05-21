import { ArrowLeft, Building2, CalendarClock, MapPin, Phone, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { SiteStatusBadge, siteStatusLabels } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { Site } from "../types/site";

export function SiteDetailPage() {
  const { siteId } = useParams();
  const [site, setSite] = useState<Site | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadSite() {
      const id = Number(siteId);
      if (!Number.isInteger(id)) {
        setError("Baustelle nicht gefunden.");
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        setSite(await api.site(id));
      } catch (requestError) {
        setError(readApiError(requestError, "Baustelle konnte nicht geladen werden."));
      } finally {
        setIsLoading(false);
      }
    }

    void loadSite();
  }, [siteId]);

  if (isLoading) {
    return <div className="matrix-state">Projektakte wird geladen...</div>;
  }

  if (error || !site) {
    return <p className="form-error">{error ?? "Baustelle nicht gefunden."}</p>;
  }

  return (
    <section className="site-detail-page">
      <Link className="back-link" to="/sites">
        <ArrowLeft aria-hidden="true" size={16} />
        <span>Baustellen</span>
      </Link>

      <div className="site-detail-header">
        <span className="site-color large" style={{ backgroundColor: site.color ?? "#94a3b8" }} />
        <div>
          <p className="eyebrow">Projektakte</p>
          <h1>{site.name}</h1>
          <p>{[site.site_number, site.customer].filter(Boolean).join(" - ")}</p>
        </div>
        <SiteStatusBadge status={site.status} />
      </div>

      <div className="site-detail-grid">
        <DetailSection title="Stammdaten" icon={Building2}>
          <DetailItem label="Baustellennummer" value={site.site_number} />
          <DetailItem label="Kunde" value={site.customer} />
          <DetailItem label="Status" value={siteStatusLabels[site.status]} />
          <DetailItem label="Aktualisiert" value={formatDateTime(site.updated_at)} />
        </DetailSection>

        <DetailSection title="Adresse / Standort" icon={MapPin}>
          <DetailItem label="Ort" value={site.location} />
          <DetailItem label="Adresse" value={site.address} />
          <DetailItem label="PLZ / Stadt" value={[site.postal_code, site.city].filter(Boolean).join(" ")} />
          <DetailItem label="Koordinaten" value={formatCoordinates(site.latitude, site.longitude)} />
          <DetailItem label="Radius" value={`${site.geofence_radius_m} m`} />
          <DetailItem label="Standortstatus" value={formatLocationStatus(site.location_status)} />
        </DetailSection>

        <DetailSection title="Projektleiter" icon={UserRound}>
          <DetailItem label="Name" value={site.project_manager?.display_name} />
          <DetailItem label="Kuerzel" value={site.project_manager?.short_code} />
          <DetailItem label="Telefon" value={site.project_manager?.phone} icon={Phone} />
        </DetailSection>

        <DetailSection title="Planstatus" icon={CalendarClock}>
          <DetailItem label="Angelegt" value={formatDateTime(site.created_at)} />
          <DetailItem label="Geschlossen" value={site.closed_at ? formatDateTime(site.closed_at) : null} />
        </DetailSection>
      </div>

      <section className="site-notes-section">
        <h2>Notizen</h2>
        <p>{site.info || "Keine Notizen hinterlegt."}</p>
      </section>
    </section>
  );
}

function DetailSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className="site-detail-section">
      <h2><Icon aria-hidden="true" size={17} />{title}</h2>
      <div>{children}</div>
    </section>
  );
}

function DetailItem({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | null | undefined;
  icon?: LucideIcon;
}) {
  return (
    <p className="detail-item">
      <span>{label}</span>
      <strong>{Icon && value ? <Icon aria-hidden="true" size={14} /> : null}{value || "-"}</strong>
    </p>
  );
}

function formatCoordinates(latitude: number | null, longitude: number | null): string | null {
  if (latitude === null || longitude === null) {
    return null;
  }
  return `${latitude}, ${longitude}`;
}

function formatLocationStatus(status: Site["location_status"]): string {
  const labels: Record<Site["location_status"], string> = {
    unknown: "Ungeprueft",
    geocoded: "Geocodiert",
    manually_set: "Manuell gesetzt",
    verified: "Geprueft",
  };
  return labels[status];
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
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
