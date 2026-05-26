import { ArrowLeft, Building2, CalendarClock, Folder, FolderOpen, MapPin, Phone, Ruler, UserRound, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { SiteStatusBadge, siteStatusLabels } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { ProjectFolder, Site } from "../types/site";

type ProjectRecordTab = "overview" | "folders" | "assembly-times" | "measurement" | "tools-material";

const projectRecordTabs: { key: ProjectRecordTab; label: string }[] = [
  { key: "overview", label: "Übersicht" },
  { key: "folders", label: "Ordnerstruktur" },
  { key: "assembly-times", label: "Montagezeiten" },
  { key: "measurement", label: "Aufmaß" },
  { key: "tools-material", label: "Werkzeuge & Material" },
];

export function SiteDetailPage() {
  const { siteId } = useParams();
  const [site, setSite] = useState<Site | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ProjectRecordTab>("overview");
  const [editMode, setEditMode] = useState(false);
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<ProjectFolder | null>(null);

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

  useEffect(() => {
    setActiveTab("overview");
    setEditMode(false);
    setFolders([]);
    setFoldersLoaded(false);
    setFoldersError(null);
    setSelectedFolder(null);
  }, [site?.id]);

  useEffect(() => {
    if (!site || activeTab !== "folders" || foldersLoaded || foldersLoading) {
      return;
    }

    async function loadFolders() {
      if (!site) {
        return;
      }
      setFoldersLoading(true);
      setFoldersError(null);
      try {
        setFolders(await api.projectFolders(site.id));
        setFoldersLoaded(true);
      } catch (requestError) {
        setFoldersError(readApiError(requestError, "Ordnerstruktur konnte nicht geladen werden."));
      } finally {
        setFoldersLoading(false);
      }
    }

    void loadFolders();
  }, [activeTab, foldersLoaded, foldersLoading, site]);

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

      <ProjectRecordTabs activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === "overview" ? (
        <OverviewTab site={site} editMode={editMode} onToggleEdit={() => setEditMode((value) => !value)} />
      ) : null}
      {activeTab === "folders" ? (
        <ProjectFoldersPanel
          site={site}
          folders={folders}
          isLoading={foldersLoading}
          error={foldersError}
          selectedFolder={selectedFolder}
          onSelectFolder={setSelectedFolder}
          onRetry={() => {
            setFoldersLoaded(false);
            setFoldersError(null);
          }}
        />
      ) : null}
      {activeTab === "assembly-times" ? (
        <PlaceholderTab
          icon={CalendarClock}
          title="Montagezeiten"
          description="Montagezeiten werden später aus mobiler Rückmeldung, Standortdaten und Fahrzeugdaten abgeleitet und hier nachvollziehbar dargestellt."
          emptyText="Noch keine Montagezeiten vorhanden."
          sections={["Zeitraum", "Monteur", "Fahrzeug", "erkannte Anwesenheit", "Quelle", "Prüfstatus"]}
        />
      ) : null}
      {activeTab === "measurement" ? (
        <PlaceholderTab
          icon={Ruler}
          title="Aufmaß"
          description="Aufmaße werden später aus LV-Positionen, Montagezeiten und mobilen Rückmeldungen erzeugt."
          emptyText="Noch kein Aufmaß vorhanden."
          sections={["PDF/LV-Import", "Aufmaßpositionen", "mobile Bearbeitung", "PDF-Ausgabe", "Rechnungsanhang"]}
          disabledActions={["PDF importieren", "Aufmaß erstellen", "PDF ausgeben"]}
        />
      ) : null}
      {activeTab === "tools-material" ? (
        <PlaceholderTab
          icon={Wrench}
          title="Werkzeuge & Material"
          description="Werkzeuge und Material werden später baustellenbezogen geplant, dokumentiert und geprüft."
          emptyText="Noch keine Werkzeuge oder Materialeinträge vorhanden."
          sections={["Werkzeuge", "Geräte", "Material", "Bestellungen", "Rückgaben / Klärungen"]}
        />
      ) : null}
    </section>
  );
}

function ProjectRecordTabs({
  activeTab,
  onChange,
}: {
  activeTab: ProjectRecordTab;
  onChange: (tab: ProjectRecordTab) => void;
}) {
  return (
    <div className="project-record-tabs" role="tablist" aria-label="Projektakte Bereiche">
      {projectRecordTabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.key}
          className={activeTab === tab.key ? "is-active" : ""}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function OverviewTab({ site, editMode, onToggleEdit }: { site: Site; editMode: boolean; onToggleEdit: () => void }) {
  return (
    <div className="project-record-tab-panel">
      <div className="project-record-toolbar">
        <div>
          <h2>Übersicht</h2>
          <p>Stammdaten und Standortinformationen zur Baustelle.</p>
        </div>
        <button type="button" className="secondary-action" onClick={onToggleEdit}>
          {editMode ? "Bearbeitung schließen" : "Bearbeiten"}
        </button>
      </div>
      {editMode ? (
        <p className="project-record-edit-note">Die Detailbearbeitung bleibt vorerst über den bestehenden Baustellen-Drawer in der Übersicht erreichbar.</p>
      ) : null}

      <div className="site-detail-grid">
        <DetailSection title="Stammdaten" icon={Building2}>
          <DetailItem label="Baustellennummer" value={site.site_number} />
          <DetailItem label="Kunde" value={site.customer} />
          <DetailItem label="Status" value={siteStatusLabels[site.status]} />
          <DetailItem label="Aktualisiert" value={formatDateTime(site.updated_at)} />
        </DetailSection>

        <DetailSection title="Adresse / Standort" icon={MapPin}>
          <DetailItem label="Ort" value={site.location} />
          <DetailItem label="PLZ / Stadt" value={[site.postal_code, site.city].filter(Boolean).join(" ")} />
          <DetailItem label="Strasse" value={[site.street, site.house_number].filter(Boolean).join(" ")} />
          <DetailItem label="Adresszusatz" value={site.address_extra || site.address} />
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
    </div>
  );
}

function ProjectFoldersPanel({
  site,
  folders,
  isLoading,
  error,
  selectedFolder,
  onSelectFolder,
  onRetry,
}: {
  site: Site;
  folders: ProjectFolder[];
  isLoading: boolean;
  error: string | null;
  selectedFolder: ProjectFolder | null;
  onSelectFolder: (folder: ProjectFolder | null) => void;
  onRetry: () => void;
}) {
  if (isLoading) {
    return <div className="matrix-state">Ordnerstruktur wird geladen...</div>;
  }

  if (error) {
    return (
      <div className="project-record-empty-state is-error">
        <strong>{error}</strong>
        <button type="button" className="secondary-action" onClick={onRetry}>Erneut laden</button>
      </div>
    );
  }

  return (
    <div className="project-record-tab-panel">
      <div className="project-record-toolbar">
        <div>
          <h2>Ordnerstruktur</h2>
          <p>Logische Projektordner für diese Baustelle. Dateiablage läuft über SharePoint, sobald ein Projektordner vorhanden ist.</p>
        </div>
        {site.project_folder_web_url ? (
          <a
            className="secondary-action"
            href={site.project_folder_web_url}
            target="_blank"
            rel="noreferrer"
          >
            Projektordner in SharePoint öffnen
          </a>
        ) : null}
      </div>

      {site.project_folder_status === "error" && site.project_folder_error ? (
        <div className="project-record-empty-state is-error">{site.project_folder_error}</div>
      ) : null}

      {folders.length === 0 ? (
        <div className="project-record-empty-state">Keine Ordner vorhanden.</div>
      ) : (
        <div className="project-folder-grid">
          {folders.map((folder) => (
            <button key={folder.id} type="button" className="project-folder-card" onClick={() => onSelectFolder(folder)}>
              <Folder aria-hidden="true" size={18} />
              <span>{folder.sort_order}.</span>
              <strong>{folder.name}</strong>
            </button>
          ))}
        </div>
      )}

      {selectedFolder ? (
        <aside className="project-folder-placeholder" aria-live="polite">
          <div>
            <FolderOpen aria-hidden="true" size={20} />
            <div>
              <h3>{selectedFolder.sort_order}. {selectedFolder.name}</h3>
              <p>Dateiablage für diesen Ordner wird später angebunden.</p>
            </div>
          </div>
          <button type="button" className="secondary-action" onClick={() => onSelectFolder(null)}>Schließen</button>
        </aside>
      ) : null}
    </div>
  );
}

function PlaceholderTab({
  icon: Icon,
  title,
  description,
  emptyText,
  sections,
  disabledActions = [],
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  emptyText: string;
  sections: string[];
  disabledActions?: string[];
}) {
  return (
    <div className="project-record-tab-panel">
      <div className="project-record-toolbar">
        <div>
          <h2><Icon aria-hidden="true" size={18} />{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className="project-record-empty-state">{emptyText}</div>
      <div className="project-placeholder-grid">
        {sections.map((section) => (
          <div key={section} className="project-placeholder-card">
            <span>{section}</span>
            <small>Wird in einer späteren Ausbaustufe aktiviert.</small>
          </div>
        ))}
      </div>
      {disabledActions.length > 0 ? (
        <div className="project-placeholder-actions">
          {disabledActions.map((action) => (
            <button key={action} type="button" disabled title="Wird in einer späteren Ausbaustufe aktiviert.">{action}</button>
          ))}
        </div>
      ) : null}
    </div>
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
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

function formatLocationStatus(status: Site["location_status"]): string {
  const labels: Record<Site["location_status"], string> = {
    unchecked: "Ungeprueft",
    geocoded: "Geprueft",
    ambiguous: "Nicht eindeutig",
    failed: "Fehler",
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
