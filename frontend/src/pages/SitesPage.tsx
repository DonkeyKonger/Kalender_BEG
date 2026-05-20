import { ChevronRight, MapPin } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError, api } from "../lib/api";
import type { Site } from "../types/site";

const statusLabels: Record<Site["status"], string> = {
  active: "Aktiv",
  paused: "Pause",
  closed: "Zu",
  archived: "Archiv",
};

export function SitesPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadSites() {
      setIsLoading(true);
      setError(null);
      try {
        setSites(await api.sites());
      } catch (requestError) {
        setError(readApiError(requestError, "Baustellen konnten nicht geladen werden."));
      } finally {
        setIsLoading(false);
      }
    }

    void loadSites();
  }, []);

  const groupedSites = useMemo(() => sites, [sites]);

  return (
    <section className="site-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Projektakte</p>
          <h1>Baustellen</h1>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}
      {isLoading && <div className="matrix-state">Baustellen werden geladen...</div>}

      {!isLoading && !error && (
        <div className="site-list" role="list">
          {groupedSites.map((site) => (
            <Link className="site-list-row" key={site.id} role="listitem" to={`/sites/${site.id}`}>
              <span className="site-color" style={{ backgroundColor: site.color ?? "#94a3b8" }} />
              <span className="site-row-main">
                <strong>{site.name}</strong>
                <small>{[site.site_number, site.customer].filter(Boolean).join(" - ")}</small>
              </span>
              <span className="site-row-location">
                <MapPin aria-hidden="true" size={15} />
                <span>{site.location ?? ""}</span>
              </span>
              <span className={`status-badge status-${site.status}`}>{statusLabels[site.status]}</span>
              <ChevronRight aria-hidden="true" size={18} />
            </Link>
          ))}
          {!groupedSites.length && <p className="empty-inline">Keine aktiven Baustellen vorhanden.</p>}
        </div>
      )}
    </section>
  );
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
