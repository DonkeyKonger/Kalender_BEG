import { ArrowLeft, Building2, CalendarClock, Download, ExternalLink, File as FileIcon, FileImage, FileSpreadsheet, FileText, Folder, FolderOpen, Mail, MapPin, Phone, Ruler, Search, UploadCloud, UserRound, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { SiteStatusBadge, siteStatusLabels } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { MeasurementBase, MeasurementImportOptions, MeasurementItem, MobileMeasurementBatch, MobileMeasurementItem, ProjectFolder, ProjectFolderDocumentItem, ProjectFolderDocumentList, Site } from "../types/site";

type ProjectRecordTab = "overview" | "folders" | "assembly-times" | "measurement" | "tools-material";
type MeasurementSubtab = "timesheet" | "review" | "time-analysis" | "bases";
type MeasurementViewMode = "list" | "table";

const MEASUREMENT_VIEW_MODE_STORAGE_KEY = "beg_aufmass_view_mode";

const measurementSubtabs: { key: MeasurementSubtab; label: string }[] = [
  { key: "timesheet", label: "Zeitenliste" },
  { key: "review", label: "Prüfung" },
  { key: "time-analysis", label: "Zeitauswertung" },
  { key: "bases", label: "Aufmaße" },
];

const projectRecordTabs: { key: ProjectRecordTab; label: string }[] = [
  { key: "overview", label: "Übersicht" },
  { key: "folders", label: "Ordnerstruktur" },
  { key: "assembly-times", label: "Montagezeiten" },
  { key: "measurement", label: "Aufmaß" },
  { key: "tools-material", label: "Werkzeuge & Material" },
];

export function SiteDetailPage() {
  const { siteId } = useParams();
  const [searchParams] = useSearchParams();
  const requestedProjectTab = searchParams.get("tab");
  const requestedMeasurementSubtab = searchParams.get("measurementSubtab");
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
  const [measurementBases, setMeasurementBases] = useState<MeasurementBase[]>([]);
  const [measurementItems, setMeasurementItems] = useState<MeasurementItem[]>([]);
  const [measurementLoading, setMeasurementLoading] = useState(false);
  const [measurementLoaded, setMeasurementLoaded] = useState(false);
  const [measurementError, setMeasurementError] = useState<string | null>(null);
  const [measurementImporting, setMeasurementImporting] = useState(false);
  const [measurementImportMessage, setMeasurementImportMessage] = useState<string | null>(null);
  const [measurementImportError, setMeasurementImportError] = useState<string | null>(null);
  const [measurementSubtab, setMeasurementSubtab] = useState<MeasurementSubtab>("timesheet");
  const [measurementBatches, setMeasurementBatches] = useState<MobileMeasurementBatch[]>([]);
  const [measurementBatchesLoading, setMeasurementBatchesLoading] = useState(false);
  const [measurementBatchesLoaded, setMeasurementBatchesLoaded] = useState(false);
  const [measurementBatchesError, setMeasurementBatchesError] = useState<string | null>(null);
  const [selectedMeasurementBatch, setSelectedMeasurementBatch] = useState<MobileMeasurementBatch | null>(null);
  const [measurementBatchItems, setMeasurementBatchItems] = useState<MobileMeasurementItem[]>([]);
  const [measurementBatchItemsLoading, setMeasurementBatchItemsLoading] = useState(false);
  const [measurementReviewMessage, setMeasurementReviewMessage] = useState<string | null>(null);
  const [measurementReviewError, setMeasurementReviewError] = useState<string | null>(null);
  const [measurementReviewActionLoading, setMeasurementReviewActionLoading] = useState(false);

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
    setActiveTab(requestedProjectTab === "measurement" ? "measurement" : "overview");
    setMeasurementSubtab(requestedMeasurementSubtab === "review" ? "review" : "timesheet");
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
    setMeasurementItems([]);
    setMeasurementLoading(false);
    setMeasurementLoaded(false);
    setMeasurementError(null);
    setMeasurementImporting(false);
    setMeasurementImportMessage(null);
    setMeasurementImportError(null);
    setMeasurementBatches([]);
    setMeasurementBatchesLoading(false);
    setMeasurementBatchesLoaded(false);
    setMeasurementBatchesError(null);
    setSelectedMeasurementBatch(null);
    setMeasurementBatchItems([]);
    setMeasurementBatchItemsLoading(false);
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    setMeasurementReviewActionLoading(false);
  }, [requestedMeasurementSubtab, requestedProjectTab, site?.id]);

  useEffect(() => {
    if (!uploadMessage || uploadingFolderKey) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setUploadMessage(null);
    }, 3000);

    return () => window.clearTimeout(timeoutId);
  }, [uploadMessage, uploadingFolderKey]);

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

  useEffect(() => {
    if (
      !site
      || activeTab !== "measurement"
      || measurementSubtab !== "timesheet"
      || measurementLoaded
      || measurementLoading
    ) {
      return;
    }

    async function loadMeasurementItems() {
      if (!site) {
        return;
      }
      setMeasurementLoading(true);
      setMeasurementError(null);
      try {
        const [bases, items] = await Promise.all([api.measurementBases(site.id), api.measurementItems(site.id)]);
        setMeasurementBases(bases);
        setMeasurementItems(items);
        setMeasurementLoaded(true);
      } catch (requestError) {
        setMeasurementError(readApiError(requestError, "Aufmaßpositionen konnten nicht geladen werden."));
      } finally {
        setMeasurementLoading(false);
      }
    }

    void loadMeasurementItems();
  }, [activeTab, measurementLoaded, measurementLoading, measurementSubtab, site]);

  useEffect(() => {
    if (
      !site
      || activeTab !== "measurement"
      || measurementSubtab !== "review"
      || measurementBatchesLoaded
      || measurementBatchesLoading
    ) {
      return;
    }

    void loadMeasurementBatches();
  }, [activeTab, measurementBatchesLoaded, measurementBatchesLoading, measurementSubtab, site]);

  async function loadMeasurementBatches(): Promise<void> {
    if (!site) {
      return;
    }
    setMeasurementBatchesLoading(true);
    setMeasurementBatchesError(null);
    try {
      setMeasurementBatches(await api.siteMeasurementBatches(site.id));
      setMeasurementBatchesLoaded(true);
    } catch (requestError) {
      setMeasurementBatchesError(readApiError(requestError, "Aufmaßpakete konnten nicht geladen werden."));
    } finally {
      setMeasurementBatchesLoading(false);
    }
  }

  async function selectMeasurementBatch(batch: MobileMeasurementBatch): Promise<void> {
    if (!site) {
      return;
    }
    setSelectedMeasurementBatch(batch);
    setMeasurementBatchItems([]);
    setMeasurementBatchItemsLoading(true);
    setMeasurementReviewError(null);
    try {
      setMeasurementBatchItems(await api.siteMeasurementBatchItems(site.id, batch.id));
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Aufmaßzeilen konnten nicht geladen werden."));
    } finally {
      setMeasurementBatchItemsLoading(false);
    }
  }

  async function setMeasurementBatchBillingStatus(
    batch: MobileMeasurementBatch,
    billingStatus: "submitted" | "billed",
  ): Promise<void> {
    if (!site || measurementReviewActionLoading) {
      return;
    }
    setMeasurementReviewActionLoading(true);
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      const updated = billingStatus === "billed"
        ? await api.markSiteMeasurementBatchBilled(site.id, batch.id)
        : await api.markSiteMeasurementBatchOpen(site.id, batch.id);
      setMeasurementBatches((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setSelectedMeasurementBatch(updated);
      setMeasurementBatchItems(await api.siteMeasurementBatchItems(site.id, batch.id));
      setMeasurementReviewMessage(
        billingStatus === "billed"
          ? `${batch.title} wurde als abgerechnet markiert.`
          : `${batch.title} wurde wieder als noch offen markiert.`,
      );
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Abrechnungsstatus konnte nicht gespeichert werden."));
    } finally {
      setMeasurementReviewActionLoading(false);
    }
  }

  async function updateMeasurementEntry(
    batch: MobileMeasurementBatch,
    entryId: number,
    payload: { area_or_comment: string; quantity: number },
  ): Promise<void> {
    if (!site || measurementReviewActionLoading) {
      return;
    }
    setMeasurementReviewActionLoading(true);
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      await api.updateSiteMeasurementEntry(site.id, batch.id, entryId, payload);
      setMeasurementBatchItems(await api.siteMeasurementBatchItems(site.id, batch.id));
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Aufmaßzeile konnte nicht gespeichert werden."));
      throw requestError;
    } finally {
      setMeasurementReviewActionLoading(false);
    }
  }

  async function createMeasurementEntry(
    batch: MobileMeasurementBatch,
    measurementItemId: number,
    payload: { area_or_comment: string; quantity: number },
  ): Promise<void> {
    if (!site || measurementReviewActionLoading) {
      return;
    }
    setMeasurementReviewActionLoading(true);
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      await api.createSiteMeasurementEntry(site.id, batch.id, measurementItemId, payload);
      setMeasurementBatchItems(await api.siteMeasurementBatchItems(site.id, batch.id));
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Aufmaßzeile konnte nicht angelegt werden."));
      throw requestError;
    } finally {
      setMeasurementReviewActionLoading(false);
    }
  }

  async function resetMeasurementBatchToSubmitted(batch: MobileMeasurementBatch): Promise<void> {
    if (!site || measurementReviewActionLoading) {
      return;
    }
    setMeasurementReviewActionLoading(true);
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      setMeasurementBatchItems(await api.resetSiteMeasurementBatchToSubmitted(site.id, batch.id));
      setMeasurementReviewMessage(`${formatMeasurementPackageNumber(site.site_number, batch.number, batch.title)} wurde auf den Monteurstand zurückgesetzt.`);
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Monteurstand konnte nicht wiederhergestellt werden."));
      throw requestError;
    } finally {
      setMeasurementReviewActionLoading(false);
    }
  }


  async function updateMeasurementBase(base: MeasurementBase, payload: { status?: "draft" | "active" | "closed" | "archived"; released_to_mobile?: boolean }): Promise<void> {
    if (!site || measurementImporting) {
      return;
    }
    setMeasurementImportError(null);
    try {
      const updated = await api.updateMeasurementBase(site.id, base.id, payload);
      setMeasurementBases((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (requestError) {
      setMeasurementImportError(readApiError(requestError, "Aufmaßblatt konnte nicht aktualisiert werden."));
    }
  }

  async function activateMeasurementBase(base: MeasurementBase): Promise<void> {
    if (!site || measurementImporting) {
      return;
    }
    setMeasurementImportMessage(null);
    setMeasurementImportError(null);
    try {
      setMeasurementBases(await api.activateMeasurementBase(site.id, base.id));
      setMeasurementImportMessage(`${formatMeasurementBaseName(base)} ist jetzt aktiv.`);
    } catch (requestError) {
      setMeasurementImportError(readApiError(requestError, "Aufmaßblatt konnte nicht aktiviert werden."));
    }
  }

  async function deleteMeasurementBase(base: MeasurementBase): Promise<void> {
    if (!site || measurementImporting) {
      return;
    }
    const confirmed = window.confirm(
      "Aufmaßblatt wirklich löschen?\n\nImportierte Positionen dieses Aufmaßblatts werden entfernt. Bereits erfasste oder abgerechnete Aufmaße dürfen nicht gelöscht werden.",
    );
    if (!confirmed) {
      return;
    }
    setMeasurementImportMessage(null);
    setMeasurementImportError(null);
    try {
      const bases = await api.deleteMeasurementBase(site.id, base.id);
      const items = await api.measurementItems(site.id);
      setMeasurementBases(bases);
      setMeasurementItems(items);
      setMeasurementImportMessage(`${formatMeasurementBaseName(base)} wurde gelöscht.`);
    } catch (requestError) {
      setMeasurementImportError(readApiError(requestError, "Aufmaßblatt konnte nicht gelöscht werden."));
    }
  }

  async function importMeasurementTimesheet(file: File, options: MeasurementImportOptions): Promise<void> {
    if (!site || measurementImporting) {
      return;
    }
    setMeasurementImporting(true);
    setMeasurementImportMessage(null);
    setMeasurementImportError(null);
    try {
      const result = await api.importMeasurementTimesheet(site.id, file, options);
      const [bases, items] = await Promise.all([api.measurementBases(site.id), api.measurementItems(site.id)]);
      setMeasurementBases(bases);
      setMeasurementItems(items);
      setMeasurementLoaded(true);
      setMeasurementImportMessage(`Zeitenliste importiert: ${result.imported_count} Positionen in ${formatMeasurementBaseName(result.measurement_base)} erkannt.`);
    } catch (requestError) {
      setMeasurementImportError(readApiError(requestError, "Zeitenliste konnte nicht importiert werden."));
    } finally {
      setMeasurementImporting(false);
    }
  }

  async function uploadFilesToFolder(folder: ProjectFolder, files: FileList | File[]): Promise<void> {
    if (!site || uploadingFolderKey) {
      return;
    }
    const fileList = Array.from(files);
    setUploadMessage(null);
    setUploadError(null);
    if (!site.project_folder_web_url) {
      setUploadError("Für diese Baustelle ist noch kein SharePoint-Projektordner vorhanden.");
      return;
    }
    if (fileList.length === 0) {
      setUploadError("Keine Datei zum Hochladen gefunden.");
      return;
    }

    setUploadingFolderKey(folder.folder_key);
    setSelectedFolder(folder);
    setUploadMessage(
      fileList.length === 1 ? "Datei wird hochgeladen..." : `${fileList.length} Dateien werden hochgeladen...`,
    );

    let uploadedCount = 0;
    const failedFiles: string[] = [];
    for (const file of fileList) {
      try {
        await api.uploadProjectFolderDocument(site.id, folder.folder_key, file);
        uploadedCount += 1;
      } catch {
        failedFiles.push(file.name);
      }
    }

    if (uploadedCount > 0) {
      setFolderDocumentsReloadKey((value) => value + 1);
    }
    if (failedFiles.length === 0) {
      setUploadMessage(
        uploadedCount === 1 ? "1 Datei wurde hochgeladen." : `${uploadedCount} Dateien wurden hochgeladen.`,
      );
      setUploadError(null);
    } else if (uploadedCount > 0) {
      setUploadMessage(`${uploadedCount} von ${fileList.length} Dateien wurden hochgeladen.`);
      setUploadError(`Fehler bei: ${failedFiles.join(", ")}`);
    } else {
      setUploadMessage(null);
      setUploadError(`Keine Datei wurde hochgeladen. Fehler bei: ${failedFiles.join(", ")}`);
    }
    setUploadingFolderKey(null);
    setDragOverFolderKey(null);
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
        <MeasurementTab
          siteNumber={site.site_number}
          activeSubtab={measurementSubtab}
          onSubtabChange={(subtab) => {
            setMeasurementSubtab(subtab);
            setSelectedMeasurementBatch(null);
            setMeasurementReviewMessage(null);
            setMeasurementReviewError(null);
          }}
          bases={measurementBases}
          items={measurementItems}
          isLoading={measurementLoading}
          error={measurementError}
          isImporting={measurementImporting}
          importMessage={measurementImportMessage}
          importError={measurementImportError}
          onImport={(file, options) => void importMeasurementTimesheet(file, options)}
          onUpdateBase={(base, payload) => void updateMeasurementBase(base, payload)}
          onActivateBase={(base) => void activateMeasurementBase(base)}
          onDeleteBase={(base) => void deleteMeasurementBase(base)}
          onRetry={() => {
            setMeasurementLoaded(false);
            setMeasurementError(null);
          }}
          batches={measurementBatches}
          batchesLoading={measurementBatchesLoading}
          batchesError={measurementBatchesError}
          selectedBatch={selectedMeasurementBatch}
          batchItems={measurementBatchItems}
          batchItemsLoading={measurementBatchItemsLoading}
          reviewMessage={measurementReviewMessage}
          reviewError={measurementReviewError}
          reviewActionLoading={measurementReviewActionLoading}
          onRetryBatches={() => {
            setMeasurementBatchesLoaded(false);
            setMeasurementBatchesError(null);
          }}
          onSelectBatch={(batch) => void selectMeasurementBatch(batch)}
          onBackToBatchList={() => {
            setSelectedMeasurementBatch(null);
            setMeasurementBatchItems([]);
            setMeasurementReviewMessage(null);
            setMeasurementReviewError(null);
          }}
          onMarkBilled={(batch) => void setMeasurementBatchBillingStatus(batch, "billed")}
          onMarkOpen={(batch) => void setMeasurementBatchBillingStatus(batch, "submitted")}
          onUpdateEntry={updateMeasurementEntry}
          onCreateEntry={createMeasurementEntry}
          onResetToSubmitted={resetMeasurementBatchToSubmitted}
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
      {site.project_folder_web_url ? (
        <div className="project-folder-actions">
          <a
            className="secondary-action"
            href={site.project_folder_web_url}
            target="_blank"
            rel="noreferrer"
          >
            Projektordner in SharePoint öffnen
          </a>
        </div>
      ) : null}

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
                  event.stopPropagation();
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
          siteId={site.id}
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
  siteId,
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
  siteId: number;
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
  const [downloadingItemId, setDownloadingItemId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    setQuery("");
    setDownloadError(null);
  }, [folder.id]);

  async function handleDownload(item: ProjectFolderDocumentItem): Promise<void> {
    setDownloadError(null);
    setDownloadingItemId(item.id);
    try {
      const blob = await api.downloadProjectFolderDocument(siteId, folder.folder_key, item.id);
      triggerBrowserDownload(blob, item.name);
    } catch (requestError) {
      setDownloadError(readApiError(requestError, "Datei konnte nicht heruntergeladen werden."));
    } finally {
      setDownloadingItemId(null);
    }
  }

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
      {downloadError ? <div className="project-record-empty-state is-error"><strong>{downloadError}</strong></div> : null}

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
              <div className="project-document-item-actions">
                {!item.is_folder ? (
                  <button
                    type="button"
                    className="secondary-action project-document-open-action"
                    disabled={downloadingItemId === item.id}
                    onClick={() => void handleDownload(item)}
                  >
                    <Download aria-hidden="true" size={15} />
                    <span>{downloadingItemId === item.id ? "Lädt..." : "Download"}</span>
                  </button>
                ) : null}
                {item.web_url ? (
                  <a className="secondary-action project-document-open-action" href={item.web_url} target="_blank" rel="noreferrer">
                    <ExternalLink aria-hidden="true" size={15} />
                    <span>Öffnen</span>
                  </a>
                ) : null}
              </div>
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


function MeasurementTab({
  siteNumber,
  activeSubtab,
  onSubtabChange,
  bases,
  items,
  isLoading,
  error,
  isImporting,
  importMessage,
  importError,
  onImport,
  onUpdateBase,
  onActivateBase,
  onDeleteBase,
  onRetry,
  batches,
  batchesLoading,
  batchesError,
  selectedBatch,
  batchItems,
  batchItemsLoading,
  reviewMessage,
  reviewError,
  reviewActionLoading,
  onRetryBatches,
  onSelectBatch,
  onBackToBatchList,
  onMarkBilled,
  onMarkOpen,
  onUpdateEntry,
  onCreateEntry,
  onResetToSubmitted,
}: {
  siteNumber: string | null;
  activeSubtab: MeasurementSubtab;
  onSubtabChange: (subtab: MeasurementSubtab) => void;
  bases: MeasurementBase[];
  items: MeasurementItem[];
  isLoading: boolean;
  error: string | null;
  isImporting: boolean;
  importMessage: string | null;
  importError: string | null;
  onImport: (file: File, options: MeasurementImportOptions) => void;
  onUpdateBase: (base: MeasurementBase, payload: { status?: "draft" | "active" | "closed" | "archived"; released_to_mobile?: boolean }) => void;
  onActivateBase: (base: MeasurementBase) => void;
  onDeleteBase: (base: MeasurementBase) => void;
  onRetry: () => void;
  batches: MobileMeasurementBatch[];
  batchesLoading: boolean;
  batchesError: string | null;
  selectedBatch: MobileMeasurementBatch | null;
  batchItems: MobileMeasurementItem[];
  batchItemsLoading: boolean;
  reviewMessage: string | null;
  reviewError: string | null;
  reviewActionLoading: boolean;
  onRetryBatches: () => void;
  onSelectBatch: (batch: MobileMeasurementBatch) => void;
  onBackToBatchList: () => void;
  onMarkBilled: (batch: MobileMeasurementBatch) => void;
  onMarkOpen: (batch: MobileMeasurementBatch) => void;
  onUpdateEntry: (batch: MobileMeasurementBatch, entryId: number, payload: { area_or_comment: string; quantity: number }) => Promise<void>;
  onCreateEntry: (batch: MobileMeasurementBatch, measurementItemId: number, payload: { area_or_comment: string; quantity: number }) => Promise<void>;
  onResetToSubmitted: (batch: MobileMeasurementBatch) => Promise<void>;
}) {
  const latestImport = items[0];

  return (
    <div className="project-record-tab-panel">
      <div className="project-record-subtabs" role="tablist" aria-label="Aufmaß Bereiche">
        {measurementSubtabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeSubtab === tab.key}
            className={activeSubtab === tab.key ? "is-active" : ""}
            onClick={() => onSubtabChange(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeSubtab === "timesheet" ? (
        <MeasurementTimesheetPanel
          bases={bases}
          items={items}
          latestImport={latestImport}
          isLoading={isLoading}
          error={error}
          isImporting={isImporting}
          importMessage={importMessage}
          importError={importError}
          onImport={onImport}
          onRetry={onRetry}
        />
      ) : null}

      {activeSubtab === "review" ? (
        <MeasurementReviewPanel
          siteNumber={siteNumber}
          batches={batches}
          batchesLoading={batchesLoading}
          batchesError={batchesError}
          selectedBatch={selectedBatch}
          batchItems={batchItems}
          batchItemsLoading={batchItemsLoading}
          reviewMessage={reviewMessage}
          reviewError={reviewError}
          reviewActionLoading={reviewActionLoading}
          onRetryBatches={onRetryBatches}
          onSelectBatch={onSelectBatch}
          onBackToBatchList={onBackToBatchList}
          onMarkBilled={onMarkBilled}
          onMarkOpen={onMarkOpen}
          onUpdateEntry={onUpdateEntry}
          onCreateEntry={onCreateEntry}
          onResetToSubmitted={onResetToSubmitted}
        />
      ) : null}

      {activeSubtab === "time-analysis" ? <MeasurementTimeAnalysisPanel /> : null}

      {activeSubtab === "bases" ? (
        <MeasurementBasesPanel
          bases={bases}
          items={items}
          message={importMessage}
          error={importError}
          onActivateBase={onActivateBase}
          onDeleteBase={onDeleteBase}
        />
      ) : null}
    </div>
  );
}

function MeasurementTimesheetPanel({
  bases,
  items,
  latestImport,
  isLoading,
  error,
  isImporting,
  importMessage,
  importError,
  onImport,
  onRetry,
}: {
  bases: MeasurementBase[];
  items: MeasurementItem[];
  latestImport: MeasurementItem | undefined;
  isLoading: boolean;
  error: string | null;
  isImporting: boolean;
  importMessage: string | null;
  importError: string | null;
  onImport: (file: File, options: MeasurementImportOptions) => void;
  onRetry: () => void;
}) {
  const selectableBases = bases.filter((base) => base.status !== "closed" && base.status !== "archived");
  const defaultBaseId = selectableBases[0]?.id ?? null;
  const [importMode, setImportMode] = useState<MeasurementImportOptions["importMode"]>(defaultBaseId ? "append_existing" : "create_new");
  const [selectedBaseId, setSelectedBaseId] = useState<number | null>(defaultBaseId);
  const [newBaseName, setNewBaseName] = useState(`Aufmaßblatt ${new Date().toISOString().slice(0, 10)}`);

  useEffect(() => {
    if (selectedBaseId === null && defaultBaseId !== null) {
      setSelectedBaseId(defaultBaseId);
      setImportMode("append_existing");
    }
  }, [defaultBaseId, selectedBaseId]);

  const importOptions: MeasurementImportOptions = {
    importMode,
    measurementBaseId: importMode === "append_existing" ? selectedBaseId : null,
    measurementBaseName: importMode === "append_existing" ? null : newBaseName,
  };

  return (
    <>
      <div className="project-record-toolbar">
        <div>
          <h2><Ruler aria-hidden="true" size={18} />Zeitenliste</h2>
          <p>Zeitenliste als PDF importieren und die erkannten Aufmaß-Vorlagenpositionen prüfen.</p>
        </div>
        <label className={`secondary-action project-upload-action${isImporting ? " is-disabled" : ""}`}>
          <UploadCloud aria-hidden="true" size={15} />
          <span>{isImporting ? "Wird importiert..." : "Zeitenliste-PDF importieren"}</span>
          <input
            className="project-upload-input"
            type="file"
            accept="application/pdf,.pdf"
            disabled={isImporting || (importMode === "append_existing" && selectedBaseId === null)}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                onImport(file, importOptions);
                event.target.value = "";
              }
            }}
          />
        </label>
      </div>

      <div className="measurement-import-compact">
        <strong>Wie soll diese Zeitenliste importiert werden?</strong>
        <div className="measurement-import-inline-options">
          <label className={importMode === "append_existing" ? "is-selected" : ""}>
            <input
              type="radio"
              name="measurement-import-mode"
              checked={importMode === "append_existing"}
              disabled={selectableBases.length === 0}
              onChange={() => setImportMode("append_existing")}
            />
            <span>An bestehendes Aufmaßblatt anhängen</span>
          </label>
          <label className={importMode === "create_new" ? "is-selected" : ""}>
            <input
              type="radio"
              name="measurement-import-mode"
              checked={importMode === "create_new"}
              onChange={() => setImportMode("create_new")}
            />
            <span>Neues Aufmaßblatt erstellen</span>
          </label>
        </div>
        {importMode === "append_existing" ? (
          <select
            value={selectedBaseId ?? ""}
            disabled={selectableBases.length === 0}
            onChange={(event) => setSelectedBaseId(Number(event.target.value) || null)}
          >
            {selectableBases.map((base) => (
              <option key={base.id} value={base.id}>{formatMeasurementBaseName(base)}</option>
            ))}
          </select>
        ) : (
          <input
            className="measurement-base-name-input"
            value={newBaseName}
            onChange={(event) => setNewBaseName(event.target.value)}
            placeholder="Name des Aufmaßblatts"
          />
        )}
        {latestImport?.source_invoice_number ? (
          <small>Letzte importierte Rechnung: {latestImport.source_invoice_number}</small>
        ) : null}
      </div>

      {importMessage ? <div className="project-record-empty-state is-success">{importMessage}</div> : null}
      {importError ? <div className="project-record-empty-state is-error"><strong>{importError}</strong></div> : null}

      {isLoading ? <div className="matrix-state">Aufmaßpositionen werden geladen...</div> : null}
      {error ? (
        <div className="project-record-empty-state is-error">
          <strong>{error}</strong>
          <button type="button" className="secondary-action" onClick={onRetry}>Erneut laden</button>
        </div>
      ) : null}
      {!isLoading && !error && items.length === 0 ? (
        <div className="project-record-empty-state">Noch keine Aufmaßpositionen importiert.</div>
      ) : null}
      {!isLoading && !error && items.length > 0 ? (
        <div className="measurement-table-wrap">
          <table className="measurement-table">
            <thead>
              <tr>
                <th>Aufmaßblatt</th>
                <th>Position</th>
                <th>Bezeichnung</th>
                <th>Menge Liste</th>
                <th>Einheit</th>
                <th>Min/Einh.</th>
                <th>Minuten gesamt</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.measurement_base ? formatMeasurementBaseName(item.measurement_base) : "-"}</td>
                  <td><strong>{item.position}</strong></td>
                  <td>{item.description}</td>
                  <td>{formatMeasurementNumber(item.list_quantity)}</td>
                  <td>{item.unit ?? "-"}</td>
                  <td>{formatMeasurementNumber(item.minutes_per_unit)}</td>
                  <td>{item.is_nep ? "NEP" : formatMeasurementNumber(item.list_minutes_total)}</td>
                  <td><span className={`measurement-status${item.is_nep ? " is-nep" : ""}`}>{item.is_nep ? "NEP" : "Importiert"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function MeasurementBasesPanel({
  bases,
  items,
  message,
  error,
  onActivateBase,
  onDeleteBase,
}: {
  bases: MeasurementBase[];
  items: MeasurementItem[];
  message: string | null;
  error: string | null;
  onActivateBase: (base: MeasurementBase) => void;
  onDeleteBase: (base: MeasurementBase) => void;
}) {
  const itemCounts = items.reduce<Map<number, number>>((counts, item) => {
    counts.set(item.measurement_base_id, (counts.get(item.measurement_base_id) ?? 0) + 1);
    return counts;
  }, new Map());

  return (
    <section className="measurement-bases-panel">
      <div className="project-record-toolbar">
        <div>
          <h2><Ruler aria-hidden="true" size={18} />Aufmaße</h2>
          <p>Aufmaßblätter verwalten. Es ist immer genau ein Aufmaßblatt für Monteure aktiv.</p>
        </div>
      </div>
      {message ? <div className="project-record-empty-state is-success">{message}</div> : null}
      {error ? <div className="project-record-empty-state is-error"><strong>{error}</strong></div> : null}
      {bases.length === 0 ? (
        <div className="project-record-empty-state">Noch kein Aufmaßblatt vorhanden.</div>
      ) : (
        <div className="measurement-base-list">
          {bases.map((base) => {
            const isActive = base.status === "active" && base.released_to_mobile;
            const positionCount = base.item_count ?? itemCounts.get(base.id) ?? 0;
            const hasMeasurementData = (base.batch_count ?? 0) > 0;
            return (
              <article className={`measurement-base-card${isActive ? " is-active" : ""}`} key={base.id}>
                <div>
                  <strong>{formatMeasurementBaseName(base)}</strong>
                  <small>
                    {isActive ? "Aktiv" : "Inaktiv"} · {positionCount} Positionen · erstellt {formatDateTime(base.created_at)}
                  </small>
                </div>
                <div>
                  {!isActive ? (
                    <button type="button" className="secondary-action" onClick={() => onActivateBase(base)}>Aktivieren</button>
                  ) : (
                    <span className="measurement-status is-active">Aktiv</span>
                  )}
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={isActive || hasMeasurementData}
                    title={
                      isActive
                        ? "Aktive Aufmaßblätter können nicht gelöscht werden."
                        : hasMeasurementData
                          ? "Aufmaßblätter mit erfassten Aufmaßen können nicht gelöscht werden."
                          : undefined
                    }
                    onClick={() => onDeleteBase(base)}
                  >
                    Löschen
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}


type MeasurementEntryDraft = {
  area_or_comment: string;
  quantity: string;
};

type MeasurementEntryUndoState = {
  entryId: number;
  area_or_comment: string;
  quantity: string;
};


type MeasurementMatrixAreaRow = {
  key: string;
  label: string;
  firstIndex: number;
  sortRank: number;
};

function buildMeasurementMatrixAreaRows(items: MobileMeasurementItem[]): MeasurementMatrixAreaRow[] {
  const rows: MeasurementMatrixAreaRow[] = [];
  const seen = new Set<string>();
  let firstIndex = 0;

  for (const item of items) {
    for (const entry of item.entries) {
      const label = normalizeMeasurementAreaLabel(entry.area_or_comment);
      const key = getMeasurementAreaKey(label);
      if (!label || seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({ key, label, firstIndex, sortRank: getMeasurementAreaSortRank(label, firstIndex) });
      firstIndex += 1;
    }
  }

  return rows.sort((left, right) => left.sortRank - right.sortRank || left.firstIndex - right.firstIndex);
}

function normalizeMeasurementAreaLabel(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "";
  }
  const upper = trimmed.toUpperCase();
  if (["UG", "EG", "DG"].includes(upper)) {
    return upper;
  }
  if (upper === "DACH") {
    return "Dach";
  }
  const floorMatch = trimmed.match(/^(\d+)\s*\.?\s*og$/i);
  if (floorMatch) {
    return `${Number(floorMatch[1])}. OG`;
  }
  return trimmed;
}

function getMeasurementAreaKey(value: string): string {
  return normalizeMeasurementAreaLabel(value).toLocaleLowerCase("de-DE");
}

function getMeasurementAreaSortRank(label: string, fallbackIndex: number): number {
  const normalized = normalizeMeasurementAreaLabel(label);
  const upper = normalized.toUpperCase();
  if (upper === "UG") {
    return 0;
  }
  if (upper === "EG") {
    return 10;
  }
  const floorMatch = upper.match(/^(\d+)\. OG$/);
  if (floorMatch) {
    return 20 + Number(floorMatch[1]);
  }
  if (upper === "DG") {
    return 900;
  }
  if (upper === "DACH") {
    return 910;
  }
  if (upper.includes("AUSSEN") || upper.includes("AUßEN")) {
    return 920;
  }
  return 1000 + fallbackIndex;
}

function getMeasurementCellEntries(item: MobileMeasurementItem, areaKey: string): MobileMeasurementItem["entries"] {
  return item.entries.filter((entry) => getMeasurementAreaKey(entry.area_or_comment) === areaKey);
}

function getMeasurementCellQuantity(entries: MobileMeasurementItem["entries"]): number {
  return entries.reduce((sum, entry) => {
    const quantity = typeof entry.quantity === "number" ? entry.quantity : Number(entry.quantity);
    return Number.isFinite(quantity) ? sum + quantity : sum;
  }, 0);
}

function MeasurementReviewPanel({
  siteNumber,
  batches,
  batchesLoading,
  batchesError,
  selectedBatch,
  batchItems,
  batchItemsLoading,
  reviewMessage,
  reviewError,
  reviewActionLoading,
  onRetryBatches,
  onSelectBatch,
  onBackToBatchList,
  onMarkBilled,
  onMarkOpen,
  onUpdateEntry,
  onCreateEntry,
  onResetToSubmitted,
}: {
  siteNumber: string | null;
  batches: MobileMeasurementBatch[];
  batchesLoading: boolean;
  batchesError: string | null;
  selectedBatch: MobileMeasurementBatch | null;
  batchItems: MobileMeasurementItem[];
  batchItemsLoading: boolean;
  reviewMessage: string | null;
  reviewError: string | null;
  reviewActionLoading: boolean;
  onRetryBatches: () => void;
  onSelectBatch: (batch: MobileMeasurementBatch) => void;
  onBackToBatchList: () => void;
  onMarkBilled: (batch: MobileMeasurementBatch) => void;
  onMarkOpen: (batch: MobileMeasurementBatch) => void;
  onUpdateEntry: (batch: MobileMeasurementBatch, entryId: number, payload: { area_or_comment: string; quantity: number }) => Promise<void>;
  onCreateEntry: (batch: MobileMeasurementBatch, measurementItemId: number, payload: { area_or_comment: string; quantity: number }) => Promise<void>;
  onResetToSubmitted: (batch: MobileMeasurementBatch) => Promise<void>;
}) {
  const [entryDrafts, setEntryDrafts] = useState<Record<number, MeasurementEntryDraft>>({});
  const [undoStack, setUndoStack] = useState<MeasurementEntryUndoState[]>([]);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [savingEntryId, setSavingEntryId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<MeasurementViewMode>(() => readMeasurementViewMode());

  useEffect(() => {
    if (!selectedBatch) {
      setEntryDrafts({});
      setInlineError(null);
      return;
    }

    const drafts: Record<number, MeasurementEntryDraft> = {};
    for (const item of batchItems) {
      for (const entry of item.entries) {
        drafts[entry.id] = {
          area_or_comment: entry.area_or_comment,
          quantity: formatMeasurementDraftQuantity(entry.quantity),
        };
      }
    }
    setEntryDrafts(drafts);
    setInlineError(null);
  }, [batchItems, selectedBatch?.id]);

  useEffect(() => {
    setUndoStack([]);
  }, [selectedBatch?.id]);

  function updateViewMode(mode: MeasurementViewMode): void {
    setViewMode(mode);
    persistMeasurementViewMode(mode);
  }

  const sortedBatches = [...batches].sort((left, right) => {
    const rightTime = getMeasurementBatchSortTime(right);
    const leftTime = getMeasurementBatchSortTime(left);
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return right.number - left.number;
  });

  function updateEntryDraft(entryId: number, field: keyof MeasurementEntryDraft, value: string): void {
    setEntryDrafts((current) => ({
      ...current,
      [entryId]: {
        area_or_comment: current[entryId]?.area_or_comment ?? "",
        quantity: current[entryId]?.quantity ?? "",
        [field]: value,
      },
    }));
  }

  function resetEntryDraft(entry: MobileMeasurementItem["entries"][number]): void {
    setEntryDrafts((current) => ({
      ...current,
      [entry.id]: {
        area_or_comment: entry.area_or_comment,
        quantity: formatMeasurementDraftQuantity(entry.quantity),
      },
    }));
    setInlineError(null);
  }

  async function saveEntryDraft(
    batch: MobileMeasurementBatch,
    entry: MobileMeasurementItem["entries"][number],
    draft: MeasurementEntryDraft | undefined,
  ): Promise<void> {
    if (!draft || savingEntryId === entry.id || reviewActionLoading) {
      return;
    }

    const comment = draft.area_or_comment.trim();
    const quantity = parseMeasurementQuantityInput(draft.quantity);
    if (!comment) {
      setInlineError("Bereich oder Kommentar darf nicht leer sein.");
      resetEntryDraft(entry);
      return;
    }
    if (quantity === null || quantity <= 0) {
      setInlineError("Bitte eine gültige Menge größer 0 eingeben.");
      resetEntryDraft(entry);
      return;
    }

    const currentQuantity = Number(entry.quantity);
    if (entry.area_or_comment === comment && Number.isFinite(currentQuantity) && currentQuantity === quantity) {
      setEntryDrafts((current) => ({
        ...current,
        [entry.id]: { area_or_comment: comment, quantity: formatMeasurementDraftQuantity(quantity) },
      }));
      setInlineError(null);
      return;
    }

    const previousState: MeasurementEntryUndoState = {
      entryId: entry.id,
      area_or_comment: entry.area_or_comment,
      quantity: formatMeasurementDraftQuantity(entry.quantity),
    };

    setSavingEntryId(entry.id);
    setInlineError(null);
    try {
      await onUpdateEntry(batch, entry.id, { area_or_comment: comment, quantity });
      setUndoStack((current) => [...current, previousState].slice(-20));
    } catch {
      setInlineError("Änderung konnte nicht gespeichert werden.");
      resetEntryDraft(entry);
    } finally {
      setSavingEntryId(null);
    }
  }

  async function undoLastEntryChange(batch: MobileMeasurementBatch): Promise<void> {
    const previousState = undoStack[undoStack.length - 1];
    if (!previousState || savingEntryId !== null || reviewActionLoading) {
      return;
    }

    const currentEntry = batchItems
      .flatMap((item) => item.entries)
      .find((entry) => entry.id === previousState.entryId);
    const previousQuantity = parseMeasurementQuantityInput(previousState.quantity);
    if (!currentEntry || previousQuantity === null) {
      setInlineError("Die letzte Änderung kann nicht wiederhergestellt werden.");
      return;
    }

    setSavingEntryId(previousState.entryId);
    setInlineError(null);
    try {
      await onUpdateEntry(batch, previousState.entryId, {
        area_or_comment: previousState.area_or_comment,
        quantity: previousQuantity,
      });
      setUndoStack((current) => current.slice(0, -1));
      setEntryDrafts((current) => ({
        ...current,
        [previousState.entryId]: {
          area_or_comment: previousState.area_or_comment,
          quantity: formatMeasurementDraftQuantity(previousQuantity),
        },
      }));
    } catch {
      setInlineError("Undo konnte nicht gespeichert werden.");
    } finally {
      setSavingEntryId(null);
    }
  }

  async function resetToSubmitted(batch: MobileMeasurementBatch): Promise<void> {
    if (!window.confirm("Dieses Aufmaß wirklich auf den ursprünglichen Monteurstand zurücksetzen?")) {
      return;
    }
    setInlineError(null);
    try {
      await onResetToSubmitted(batch);
      setUndoStack([]);
    } catch {
      // The parent handler already surfaces the API error; avoid duplicate red messages.
    }
  }

  if (selectedBatch) {
    const itemsWithEntries = batchItems.filter((item) => item.entries.length > 0);
    const isBilled = isMeasurementBatchBilled(selectedBatch.status);
    const isDraft = selectedBatch.status === "draft";
    const canEditRows = !isDraft;
    const displayTitle = formatMeasurementPackageNumber(siteNumber, selectedBatch.number, selectedBatch.title);

    return (
      <div className={`measurement-review-detail${viewMode === "table" ? " is-table-view" : ""}`}>
        <div className="measurement-review-header">
          <div>
            <button type="button" className="secondary-action" onClick={onBackToBatchList}>Zurück</button>
            <h2>{displayTitle}</h2>
          </div>
          <div className="measurement-review-actions">
            <MeasurementViewToggle viewMode={viewMode} onChange={updateViewMode} />
            <span className={getMeasurementBatchStatusClass(selectedBatch.status)}>{getMeasurementBatchStatusLabel(selectedBatch.status)}</span>
            <button
              type="button"
              className="secondary-action"
              disabled={!canEditRows || undoStack.length === 0 || reviewActionLoading || savingEntryId !== null}
              onClick={() => void undoLastEntryChange(selectedBatch)}
            >
              Undo
            </button>
            <button
              type="button"
              className="secondary-action"
              disabled={!canEditRows || reviewActionLoading || savingEntryId !== null}
              onClick={() => void resetToSubmitted(selectedBatch)}
            >
              Auf Monteurstand zurücksetzen
            </button>
            {!isDraft ? (
              isBilled ? (
                <button type="button" className="secondary-action" disabled={reviewActionLoading} onClick={() => onMarkOpen(selectedBatch)}>
                  Wieder auf noch offen setzen
                </button>
              ) : (
                <button type="button" className="primary-action" disabled={reviewActionLoading} onClick={() => onMarkBilled(selectedBatch)}>
                  Als abgerechnet markieren
                </button>
              )
            ) : null}
          </div>
        </div>

        {reviewMessage ? <div className="project-record-empty-state is-success">{reviewMessage}</div> : null}
        {reviewError ? <div className="project-record-empty-state is-error"><strong>{reviewError}</strong></div> : null}
        {inlineError ? <div className="project-record-empty-state is-error"><strong>{inlineError}</strong></div> : null}
        {batchItemsLoading ? <div className="matrix-state">Aufmaßzeilen werden geladen...</div> : null}
        {!batchItemsLoading && itemsWithEntries.length === 0 ? (
          <div className="project-record-empty-state">Keine Aufmaßzeilen in diesem Paket.</div>
        ) : null}
        {!batchItemsLoading && itemsWithEntries.length > 0 && viewMode === "list" ? (
          <div className="measurement-review-positions">
            {itemsWithEntries.map((item) => (
              <section className="measurement-review-position" key={item.id}>
                <div className="measurement-review-position-head">
                  <strong className="measurement-review-position-title">{item.position} {item.description}</strong>
                </div>
                <div className="measurement-review-entry-list">
                  {item.entries.map((entry) => {
                    const draft = entryDrafts[entry.id] ?? {
                      area_or_comment: entry.area_or_comment,
                      quantity: formatMeasurementDraftQuantity(entry.quantity),
                    };
                    const isSaving = savingEntryId === entry.id;
                    return (
                      <div className="measurement-review-entry" key={entry.id}>
                        <input
                          className="measurement-review-inline-input"
                          value={draft.area_or_comment}
                          disabled={!canEditRows || reviewActionLoading || isSaving}
                          aria-label={`Bereich für ${item.position}`}
                          onChange={(event) => updateEntryDraft(entry.id, "area_or_comment", event.target.value)}
                          onBlur={() => void saveEntryDraft(selectedBatch, entry, draft)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void saveEntryDraft(selectedBatch, entry, draft);
                            }
                            if (event.key === "Escape") {
                              resetEntryDraft(entry);
                            }
                          }}
                        />
                        <div className="measurement-review-quantity-group">
                          <input
                            className="measurement-review-inline-quantity"
                            value={draft.quantity}
                            disabled={!canEditRows || reviewActionLoading || isSaving}
                            inputMode="decimal"
                            aria-label={`Menge für ${item.position}`}
                            onChange={(event) => updateEntryDraft(entry.id, "quantity", event.target.value)}
                            onBlur={() => void saveEntryDraft(selectedBatch, entry, draft)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void saveEntryDraft(selectedBatch, entry, draft);
                              }
                              if (event.key === "Escape") {
                                resetEntryDraft(entry);
                              }
                            }}
                          />
                          <span>{item.unit ?? ""}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : null}
        {!batchItemsLoading && itemsWithEntries.length > 0 && viewMode === "table" ? (
          <MeasurementReviewTable
            items={itemsWithEntries}
            entryDrafts={entryDrafts}
            canEditRows={canEditRows}
            reviewActionLoading={reviewActionLoading}
            savingEntryId={savingEntryId}
            onDraftChange={updateEntryDraft}
            onDraftSave={(entry, draft) => void saveEntryDraft(selectedBatch, entry, draft)}
            onDraftReset={resetEntryDraft}
            onCellCreate={(item, areaLabel, quantity) => onCreateEntry(selectedBatch, item.id, { area_or_comment: areaLabel, quantity })}
          />
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div className="project-record-toolbar">
        <div>
          <h2><Ruler aria-hidden="true" size={18} />Prüfung</h2>
          <p>Eingereichte Aufmaßpakete prüfen und als noch offen oder abgerechnet führen.</p>
        </div>
      </div>
      {batchesLoading ? <div className="matrix-state">Aufmaßpakete werden geladen...</div> : null}
      {batchesError ? (
        <div className="project-record-empty-state is-error">
          <strong>{batchesError}</strong>
          <button type="button" className="secondary-action" onClick={onRetryBatches}>Erneut laden</button>
        </div>
      ) : null}
      {!batchesLoading && !batchesError && sortedBatches.length === 0 ? (
        <div className="project-record-empty-state">Noch keine Aufmaßpakete vorhanden.</div>
      ) : null}
      {!batchesLoading && !batchesError && sortedBatches.length > 0 ? (
        <div className="measurement-review-list">
          {sortedBatches.map((batch) => (
            <button
              key={batch.id}
              type="button"
              className={`measurement-review-card${batch.status === "submitted" ? " is-submitted" : ""}`}
              onClick={() => onSelectBatch(batch)}
            >
              <span className={getMeasurementBatchStatusClass(batch.status)}>{getMeasurementBatchStatusLabel(batch.status)}</span>
              <div className="measurement-review-card-main">
                <strong>{formatMeasurementPackageNumber(siteNumber, batch.number, batch.title)}</strong>
                <small>
                  {batch.submitted_by_name ? `Von ${batch.submitted_by_name}` : "Ohne Einreicher"}
                  {batch.submitted_at ? ` · ${formatDateTime(batch.submitted_at)}` : ""}
                </small>
              </div>
              <b>{batch.entry_count} Zeilen · {batch.position_count} Positionen</b>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function MeasurementViewToggle({
  viewMode,
  onChange,
}: {
  viewMode: MeasurementViewMode;
  onChange: (mode: MeasurementViewMode) => void;
}) {
  return (
    <div className="measurement-view-toggle" role="group" aria-label="Aufmaß Ansicht">
      <button className={viewMode === "list" ? "is-active" : ""} type="button" onClick={() => onChange("list")}>Liste</button>
      <button className={viewMode === "table" ? "is-active" : ""} type="button" onClick={() => onChange("table")}>Tabelle</button>
    </div>
  );
}

function MeasurementReviewTable({
  items,
  entryDrafts,
  canEditRows,
  reviewActionLoading,
  savingEntryId,
  onDraftChange,
  onDraftSave,
  onDraftReset,
  onCellCreate,
}: {
  items: MobileMeasurementItem[];
  entryDrafts: Record<number, MeasurementEntryDraft>;
  canEditRows: boolean;
  reviewActionLoading: boolean;
  savingEntryId: number | null;
  onDraftChange: (entryId: number, field: keyof MeasurementEntryDraft, value: string) => void;
  onDraftSave: (entry: MobileMeasurementItem["entries"][number], draft: MeasurementEntryDraft | undefined) => void;
  onDraftReset: (entry: MobileMeasurementItem["entries"][number]) => void;
  onCellCreate: (item: MobileMeasurementItem, areaLabel: string, quantity: number) => Promise<void>;
}) {
  const areaRows = buildMeasurementMatrixAreaRows(items);
  const [newCellDrafts, setNewCellDrafts] = useState<Record<string, string>>({});
  const [savingCellKey, setSavingCellKey] = useState<string | null>(null);

  function updateNewCellDraft(cellKey: string, value: string): void {
    setNewCellDrafts((current) => ({ ...current, [cellKey]: value }));
  }

  async function saveNewCellDraft(item: MobileMeasurementItem, area: MeasurementMatrixAreaRow, value: string): Promise<void> {
    const quantity = parseMeasurementQuantityInput(value);
    if (value.trim() === "") {
      return;
    }
    if (quantity === null || quantity <= 0 || savingCellKey) {
      setNewCellDrafts((current) => ({ ...current, [`${area.key}-${item.id}`]: "" }));
      return;
    }

    const cellKey = `${area.key}-${item.id}`;
    setSavingCellKey(cellKey);
    try {
      await onCellCreate(item, area.label, quantity);
      setNewCellDrafts((current) => ({ ...current, [cellKey]: "" }));
    } finally {
      setSavingCellKey(null);
    }
  }

  return (
    <div className="measurement-review-table-wrap" role="region" aria-label="Tabellarische Aufmaßaufstellung">
      <table className="measurement-table-view measurement-matrix-table measurement-review-table">
        <thead>
          <tr>
            <th className="measurement-matrix-axis">Pos.-Nr.</th>
            {items.map((item) => (
              <th className="measurement-matrix-position-heading" key={item.id}>
                <strong>{item.position}</strong>
              </th>
            ))}
          </tr>
          <tr>
            <th className="measurement-matrix-axis">Beschreibung</th>
            {items.map((item) => (
              <th className="measurement-matrix-description-heading" key={item.id} title={item.description}><span>{item.description}</span></th>
            ))}
          </tr>
          <tr>
            <th className="measurement-matrix-axis">Einheit</th>
            {items.map((item) => (
              <th key={item.id}>{item.unit ?? "-"}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="measurement-matrix-section-row">
            <th className="measurement-matrix-axis">Bauteil / Ort</th>
            {items.map((item) => <td key={item.id} />)}
          </tr>
          {areaRows.map((area) => (
            <tr key={area.key}>
              <th className="measurement-matrix-axis">{area.label}</th>
              {items.map((item) => {
                const entries = getMeasurementCellEntries(item, area.key);
                if (entries.length === 0) {
                  const cellKey = `${area.key}-${item.id}`;
                  const draftValue = newCellDrafts[cellKey] ?? "";
                  const isSaving = savingCellKey === cellKey;
                  return (
                    <td className="measurement-matrix-empty-cell" key={item.id}>
                      <input
                        className={`measurement-table-input is-quantity${draftValue.trim() ? " has-value" : ""}`}
                        value={draftValue}
                        disabled={!canEditRows || reviewActionLoading || isSaving || savingCellKey !== null}
                        inputMode="decimal"
                        aria-label={`Neue Menge ${area.label} für ${item.position}`}
                        onChange={(event) => updateNewCellDraft(cellKey, event.target.value)}
                        onBlur={() => void saveNewCellDraft(item, area, draftValue)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void saveNewCellDraft(item, area, draftValue);
                          }
                          if (event.key === "Escape") {
                            updateNewCellDraft(cellKey, "");
                          }
                        }}
                      />
                    </td>
                  );
                }
                if (entries.length > 1) {
                  return (
                    <td className="measurement-matrix-quantity-cell is-combined" key={item.id}>
                      <strong>{formatMeasurementNumber(getMeasurementCellQuantity(entries))}</strong>
                    </td>
                  );
                }
                const entry = entries[0];
                const draft = entryDrafts[entry.id] ?? {
                  area_or_comment: entry.area_or_comment,
                  quantity: formatMeasurementDraftQuantity(entry.quantity),
                };
                const isSaving = savingEntryId === entry.id;
                return (
                  <td className="measurement-matrix-quantity-cell" key={entry.id}>
                    <input
                      className="measurement-table-input is-quantity"
                      value={draft.quantity}
                      disabled={!canEditRows || reviewActionLoading || isSaving}
                      inputMode="decimal"
                      aria-label={`Menge ${area.label} für ${item.position}`}
                      onChange={(event) => onDraftChange(entry.id, "quantity", event.target.value)}
                      onBlur={() => onDraftSave(entry, draft)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          onDraftSave(entry, draft);
                        }
                        if (event.key === "Escape") {
                          onDraftReset(entry);
                        }
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="measurement-matrix-total-row">
            <th className="measurement-matrix-axis">Gesamt</th>
            {items.map((item) => (
              <td className="measurement-matrix-quantity-cell" key={item.id}>
                <strong>{formatMeasurementNumber(getMeasurementCellQuantity(item.entries))}</strong>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MeasurementTimeAnalysisPanel() {
  return (
    <>
      <div className="project-record-toolbar">
        <div>
          <h2><Ruler aria-hidden="true" size={18} />Zeitauswertung</h2>
          <p>Die Zeitauswertung wird später Aufmaß-Sollstunden mit tatsächlich erfassten Lohnstunden vergleichen.</p>
        </div>
      </div>
      <div className="measurement-evaluation-grid">
        <div><span>Sollstunden aus Aufmaß</span><strong>-</strong></div>
        <div><span>Iststunden aus Lohnerfassung</span><strong>-</strong></div>
        <div><span>Abweichung</span><strong>-</strong></div>
      </div>
    </>
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

function readMeasurementViewMode(): MeasurementViewMode {
  if (typeof window === "undefined") {
    return "list";
  }
  return window.localStorage.getItem(MEASUREMENT_VIEW_MODE_STORAGE_KEY) === "table" ? "table" : "list";
}

function persistMeasurementViewMode(mode: MeasurementViewMode): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(MEASUREMENT_VIEW_MODE_STORAGE_KEY, mode);
}

function formatCoordinates(latitude: number | null, longitude: number | null): string | null {
  if (latitude === null || longitude === null) {
    return null;
  }
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
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


function formatMeasurementPackageNumber(
  siteNumber: string | null,
  packageNumber: number,
  fallbackTitle: string,
): string {
  const cleanSiteNumber = siteNumber?.trim();
  if (!cleanSiteNumber) {
    return fallbackTitle;
  }
  return `Aufmaß ${cleanSiteNumber}.${String(packageNumber).padStart(2, "0")}`;
}

function formatMeasurementBaseName(base: MeasurementBase): string {
  return base.name.replace("Aufmaßbasis", "Aufmaßblatt");
}

function getMeasurementBatchStatusLabel(status: string): string {
  if (isMeasurementBatchBilled(status)) {
    return "Abgerechnet";
  }
  if (isMeasurementBatchOpen(status)) {
    return "Noch offen";
  }
  const labels: Record<string, string> = {
    draft: "Entwurf",
    in_review: "In Prüfung",
    closed: "Abgeschlossen",
  };
  return labels[status] ?? status;
}

function getMeasurementBatchStatusClass(status: string): string {
  const normalizedStatus = isMeasurementBatchBilled(status)
    ? "billed"
    : isMeasurementBatchOpen(status)
      ? "open"
      : status;
  return ["measurement-status", `is-${normalizedStatus}`].join(" ");
}

function isMeasurementBatchBilled(status: string): boolean {
  return status === "billed" || status === "approved";
}

function isMeasurementBatchOpen(status: string): boolean {
  return status === "submitted" || status === "rejected";
}

function formatMeasurementNumber(value: string | number | null): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return String(value);
  }
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numericValue);
}

function formatMeasurementDraftQuantity(value: string | number | null): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return String(value).replace(".", ",");
  }
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numericValue);
}

function parseMeasurementQuantityInput(value: string): number | null {
  const normalized = value.trim().replace(/\./g, "").replace(",", ".");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getMeasurementBatchSortTime(batch: MobileMeasurementBatch): number {
  const value = batch.submitted_at ?? batch.created_at;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
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
