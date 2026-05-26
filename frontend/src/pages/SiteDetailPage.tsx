import { ArrowLeft, Building2, CalendarClock, ExternalLink, File as FileIcon, FileImage, FileSpreadsheet, FileText, Folder, FolderOpen, Mail, MapPin, Phone, Ruler, Search, UploadCloud, UserRound, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { SiteStatusBadge, siteStatusLabels } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { ProjectFolder, ProjectFolderDocumentItem, ProjectFolderDocumentList, Site } from "../types/site";

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
  const [folderDocuments, setFolderDocuments] = useState<ProjectFolderDocumentList | null>(null);
  const [folderDocumentsLoading, setFolderDocumentsLoading] = useState(false);
  const [folderDocumentsError, setFolderDocumentsError] = useState<string | null>(null);
  const [folderDocumentsReloadKey, setFolderDocumentsReloadKey] = useState(0);
  const [uploadingFolderKey, setUploadingFolderKey] = useState<string | null>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOverFolderKey, setDragOverFolderKey] = useState<string | null>(null);

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
    setFolderDocuments(null);
    setFolderDocumentsLoading(false);
    setFolderDocumentsError(null);
    setFolderDocumentsReloadKey(0);
    setUploadingFolderKey(null);
    setUploadMessage(null);
    setUploadError(null);
    setDragOverFolderKey(null);
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

  useEffect(() => {
    setFolderDocuments(null);
    setFolderDocumentsError(null);
    setFolderDocumentsLoading(false);

    if (!site || activeTab !== "folders" || !selectedFolder || !site.project_folder_web_url) {
      return;
    }

    let isCurrent = true;
    async function loadFolderDocuments() {
      if (!site || !selectedFolder) {
        return;
      }
      setFolderDocumentsLoading(true);
      try {
        const documents = await api.projectFolderDocuments(site.id, selectedFolder.folder_key);
        if (isCurrent) {
          setFolderDocuments(documents);
        }
      } catch (requestError) {
        if (isCurrent) {
          setFolderDocumentsError(readApiError(requestError, "Dateien konnten nicht geladen werden."));
        }
      } finally {
        if (isCurrent) {
          setFolderDocumentsLoading(false);
        }
      }
    }

    void loadFolderDocuments();
    return () => {
      isCurrent = false;
    };
  }, [activeTab, folderDocumentsReloadKey, selectedFolder, site]);

  async function uploadFilesToFolder(folder: ProjectFolder, files: FileList | File[]): Promise<void> {
    if (!site) {
      return;
    }
    const fileList = Array.from(files);
    setUploadMessage(null);
    setUploadError(null);
    if (!site.project_folder_web_url) {
      setUploadError("Für diese Baustelle ist noch kein SharePoint-Projektordner vorhanden.");
      return;
    }
    if (fileList.length !== 1) {
      setUploadError("Bitte genau eine Datei hochladen.");
      return;
    }

    setUploadingFolderKey(folder.folder_key);
    try {
      await api.uploadProjectFolderDocument(site.id, folder.folder_key, fileList[0]);
      setSelectedFolder(folder);
      setUploadMessage(`${fileList[0].name} wurde hochgeladen.`);
      setFolderDocumentsReloadKey((value) => value + 1);
    } catch (requestError) {
      setUploadError(readApiError(requestError, "Datei konnte nicht hochgeladen werden."));
    } finally {
      setUploadingFolderKey(null);
      setDragOverFolderKey(null);
    }
  }

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
          documents={folderDocuments}
          documentsLoading={folderDocumentsLoading}
          documentsError={folderDocumentsError}
          uploadingFolderKey={uploadingFolderKey}
          uploadMessage={uploadMessage}
          uploadError={uploadError}
          dragOverFolderKey={dragOverFolderKey}
          onSelectFolder={setSelectedFolder}
          onUploadFiles={(folder, files) => void uploadFilesToFolder(folder, files)}
          onDragOverFolder={setDragOverFolderKey}
          onRetry={() => {
            setFoldersLoaded(false);
            setFoldersError(null);
          }}
          onRetryDocuments={() => setFolderDocumentsReloadKey((value) => value + 1)}
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
  documents,
  documentsLoading,
  documentsError,
  uploadingFolderKey,
  uploadMessage,
  uploadError,
  dragOverFolderKey,
  onSelectFolder,
  onUploadFiles,
  onDragOverFolder,
  onRetry,
  onRetryDocuments,
}: {
  site: Site;
  folders: ProjectFolder[];
  isLoading: boolean;
  error: string | null;
  selectedFolder: ProjectFolder | null;
  documents: ProjectFolderDocumentList | null;
  documentsLoading: boolean;
  documentsError: string | null;
  uploadingFolderKey: string | null;
  uploadMessage: string | null;
  uploadError: string | null;
  dragOverFolderKey: string | null;
  onSelectFolder: (folder: ProjectFolder | null) => void;
  onUploadFiles: (folder: ProjectFolder, files: FileList | File[]) => void;
  onDragOverFolder: (folderKey: string | null) => void;
  onRetry: () => void;
  onRetryDocuments: () => void;
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
          {folders.map((folder) => {
            const isSelected = selectedFolder?.id === folder.id;
            return (
              <button
                key={folder.id}
                type="button"
                className={`project-folder-card${isSelected ? " is-selected" : ""}${dragOverFolderKey === folder.folder_key ? " is-drag-over" : ""}`}
                onClick={() => onSelectFolder(folder)}
                onDragOver={(event) => {
                  event.preventDefault();
                  onDragOverFolder(folder.folder_key);
                }}
                onDragLeave={() => onDragOverFolder(null)}
                onDrop={(event) => {
                  event.preventDefault();
                  onDragOverFolder(null);
                  onUploadFiles(folder, event.dataTransfer.files);
                }}
                title={`${folder.sort_order}. ${folder.name} Dateien anzeigen`}
              >
                <Folder aria-hidden="true" size={18} />
                <span>{folder.sort_order}.</span>
                <strong>{dragOverFolderKey === folder.folder_key ? "Hier ablegen zum Hochladen" : folder.name}</strong>
              </button>
            );
          })}
        </div>
      )}

      {selectedFolder ? (
        <ProjectFolderDocumentBrowser
          folder={selectedFolder}
          hasSharePointFolder={Boolean(site.project_folder_web_url)}
          documents={documents}
          isLoading={documentsLoading}
          error={documentsError}
          isUploading={uploadingFolderKey === selectedFolder.folder_key}
          uploadMessage={uploadMessage}
          uploadError={uploadError}
          onUpload={(files) => onUploadFiles(selectedFolder, files)}
          onClose={() => onSelectFolder(null)}
          onRetry={onRetryDocuments}
        />
      ) : null}
    </div>
  );
}

function ProjectFolderDocumentBrowser({
  folder,
  hasSharePointFolder,
  documents,
  isLoading,
  error,
  isUploading,
  uploadMessage,
  uploadError,
  onUpload,
  onClose,
  onRetry,
}: {
  folder: ProjectFolder;
  hasSharePointFolder: boolean;
  documents: ProjectFolderDocumentList | null;
  isLoading: boolean;
  error: string | null;
  isUploading: boolean;
  uploadMessage: string | null;
  uploadError: string | null;
  onUpload: (files: FileList | File[]) => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    setQuery("");
  }, [folder.id]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = documents?.items.filter((item) => {
    if (!normalizedQuery) {
      return true;
    }
    return [item.name, item.file_extension, item.mime_type]
      .filter(Boolean)
      .some((value) => value?.toLowerCase().includes(normalizedQuery));
  }) ?? [];
  const hasLoadedItems = Boolean(documents && documents.items.length > 0);

  return (
    <aside className="project-document-browser" aria-live="polite">
      <div className="project-document-browser-header">
        <div>
          <FolderOpen aria-hidden="true" size={20} />
          <div>
            <h3>Dateien in: {folder.sort_order}. {folder.name}</h3>
            <p>{hasSharePointFolder ? "Dateien aus dem SharePoint-Unterordner." : "Dateiablage läuft über SharePoint, sobald ein Projektordner vorhanden ist."}</p>
          </div>
        </div>
        <div className="project-document-browser-actions">
          {hasSharePointFolder ? (
            <label className={`secondary-action project-upload-action${isUploading ? " is-disabled" : ""}`}>
              <UploadCloud aria-hidden="true" size={15} />
              <span>{isUploading ? "Wird hochgeladen..." : "Datei hochladen"}</span>
              <input
                className="project-upload-input"
                type="file"
                disabled={isUploading}
                onChange={(event) => {
                  if (event.target.files) {
                    onUpload(event.target.files);
                    event.target.value = "";
                  }
                }}
              />
            </label>
          ) : null}
          {folder.external_web_url ? (
            <a className="secondary-action project-document-open-action" href={folder.external_web_url} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" size={15} />
              <span>Ordner öffnen</span>
            </a>
          ) : null}
          <button type="button" className="secondary-action" onClick={onClose}>Schließen</button>
        </div>
      </div>

      {uploadMessage ? <div className="project-record-empty-state is-success">{uploadMessage}</div> : null}
      {uploadError ? <div className="project-record-empty-state is-error"><strong>{uploadError}</strong></div> : null}

      {!hasSharePointFolder ? (
        <div className="project-record-empty-state">Noch kein SharePoint-Projektordner für diese Baustelle vorhanden.</div>
      ) : null}
      {hasSharePointFolder ? (
        <div className="project-document-filter-row">
          <label className="project-document-search">
            <Search aria-hidden="true" size={16} />
            <input
              type="search"
              value={query}
              placeholder="Dateien suchen..."
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
      ) : null}
      {hasSharePointFolder && isLoading ? (
        <div className="project-record-empty-state">Dateien werden geladen...</div>
      ) : null}
      {hasSharePointFolder && error ? (
        <div className="project-record-empty-state is-error">
          <strong>{error}</strong>
          <button type="button" className="secondary-action" onClick={onRetry}>Erneut laden</button>
        </div>
      ) : null}
      {hasSharePointFolder && !isLoading && !error && documents?.items.length === 0 ? (
        <div className="project-record-empty-state">Noch keine Dateien in diesem Ordner. Datei hochladen oder per Drag & Drop auf den Ordner ziehen.</div>
      ) : null}
      {hasSharePointFolder && !isLoading && !error && hasLoadedItems && visibleItems.length === 0 ? (
        <div className="project-record-empty-state">Keine Dateien gefunden.</div>
      ) : null}
      {hasSharePointFolder && !isLoading && !error && visibleItems.length > 0 ? (
        <ul className="project-document-list">
          {visibleItems.map((item) => (
            <li key={item.id || item.name} className="project-document-item">
              <div>
                <DocumentTypeIcon item={item} />
                <div>
                  <strong>{item.name}</strong>
                  <span>{formatDocumentMeta(item)}</span>
                </div>
              </div>
              {item.web_url ? (
                <a className="secondary-action project-document-open-action" href={item.web_url} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden="true" size={15} />
                  <span>Öffnen</span>
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}

function DocumentTypeIcon({ item }: { item: ProjectFolderDocumentItem }) {
  const extension = item.file_extension?.toLowerCase();
  const mimeType = item.mime_type?.toLowerCase() ?? "";
  if (extension === "pdf" || mimeType.includes("pdf")) {
    return <FileText aria-hidden="true" className="is-pdf" size={20} />;
  }
  if (["doc", "docx"].includes(extension ?? "") || mimeType.includes("word")) {
    return <FileText aria-hidden="true" className="is-word" size={20} />;
  }
  if (["xls", "xlsx", "xlsm", "csv"].includes(extension ?? "") || mimeType.includes("spreadsheet") || mimeType.includes("excel")) {
    return <FileSpreadsheet aria-hidden="true" className="is-excel" size={20} />;
  }
  if (["jpg", "jpeg", "png", "webp"].includes(extension ?? "") || mimeType.startsWith("image/")) {
    return <FileImage aria-hidden="true" className="is-image" size={20} />;
  }
  if (["msg", "eml"].includes(extension ?? "") || mimeType.includes("message")) {
    return <Mail aria-hidden="true" className="is-mail" size={20} />;
  }
  return <FileIcon aria-hidden="true" size={20} />;
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

function formatDocumentMeta(item: ProjectFolderDocumentItem): string {
  const type = item.is_folder ? "Ordner" : item.file_extension?.toUpperCase() ?? item.mime_type ?? "Datei";
  const changed = item.last_modified_date_time ? `Geändert ${formatDateTime(item.last_modified_date_time)}` : null;
  const size = item.is_folder ? null : formatFileSize(item.size);
  return [type, changed, size].filter(Boolean).join(" · ");
}

function formatFileSize(size: number | null): string | null {
  if (typeof size !== "number") {
    return null;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
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
