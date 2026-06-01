import { ArrowLeft, Building2, CalendarClock, Download, ExternalLink, File as FileIcon, FileImage, FileSpreadsheet, FileText, Flag, Folder, Mail, MapPin, Phone, Ruler, Search, UploadCloud, UserRound, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { SiteStatusBadge, siteStatusLabels } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { AssignmentRead } from "../types/matrix";
import type { Person } from "../types/person";
import type { MeasurementBase, MeasurementBaseUpdate, MeasurementEntry, MeasurementImportOptions, MeasurementItem, MobileMeasurementBatch, MobileMeasurementItem, ProjectFolder, ProjectFolderDocumentItem, ProjectFolderDocumentList, Site, SiteCreate } from "../types/site";
import { SiteFields, normalizeSitePayload, toEditableSite, validateSitePayload } from "./SitesPage";
import type { EditableSite } from "./SitesPage";

type ProjectRecordTab = "overview" | "folders" | "assembly-times" | "measurement" | "tools-material";
type MeasurementSubtab = "timesheet" | "review" | "time-analysis" | "bases";
type MeasurementViewMode = "list" | "table";
type MeasurementPdfMode = "checked" | "original";
type MeasurementTimesheetFilter = "all" | "billed" | "unbilled";

const MEASUREMENT_VIEW_MODE_STORAGE_KEY = "beg_aufmass_view_mode";
const MEASUREMENT_TABLE_AXIS_WIDTH = 216;
const MEASUREMENT_TABLE_POSITION_WIDTH = 134;
const MEASUREMENT_TABLE_MIN_COLUMNS = 12;
const MEASUREMENT_TABLE_MIN_AREA_ROWS = 12;

const measurementSubtabs: { key: MeasurementSubtab; label: string }[] = [
  { key: "timesheet", label: "Zeitenliste" },
  { key: "review", label: "Prüfung" },
  { key: "time-analysis", label: "Zeitauswertung" },
  { key: "bases", label: "Angebot" },
];

const projectRecordTabs: { key: ProjectRecordTab; label: string }[] = [
  { key: "overview", label: "Übersicht" },
  { key: "folders", label: "Ordnerstruktur" },
  { key: "assembly-times", label: "Montagezeiten" },
  { key: "measurement", label: "Aufmaß" },
  { key: "tools-material", label: "Werkzeuge & Material" },
];

export function SiteDetailPage() {
  const { user } = useAuth();
  const canEditSite = user?.role === "admin" || user?.role === "project_manager";
  const { siteId } = useParams();
  const [searchParams] = useSearchParams();
  const requestedProjectTab = searchParams.get("tab");
  const requestedMeasurementSubtab = searchParams.get("measurementSubtab");
  const [site, setSite] = useState<Site | null>(null);
  const [siteDraft, setSiteDraft] = useState<EditableSite | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ProjectRecordTab>("overview");
  const [editMode, setEditMode] = useState(false);
  const [isSavingSite, setIsSavingSite] = useState(false);
  const [isCheckingSiteLocation, setIsCheckingSiteLocation] = useState(false);
  const [siteSaveError, setSiteSaveError] = useState<string | null>(null);
  const [siteSaveMessage, setSiteSaveMessage] = useState<string | null>(null);
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
  const [measurementProgressItems, setMeasurementProgressItems] = useState<MobileMeasurementItem[]>([]);
  const [measurementWorkerHeadCount, setMeasurementWorkerHeadCount] = useState(0);
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
    setSiteDraft(site ? toEditableSite(site) : null);
    setSiteSaveError(null);
    setSiteSaveMessage(null);
  }, [site?.id]);

  useEffect(() => {
    if (!canEditSite) {
      return;
    }

    let isCurrent = true;
    api
      .persons({ isActive: null })
      .then((personData) => {
        if (isCurrent) {
          setPeople(personData);
        }
      })
      .catch(() => {
        if (isCurrent) {
          setPeople([]);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [canEditSite]);

  useEffect(() => {
    setActiveTab(requestedProjectTab === "measurement" ? "measurement" : "overview");
    setMeasurementSubtab(requestedMeasurementSubtab === "review" ? "review" : "timesheet");
    setEditMode(false);
    setSiteSaveError(null);
    setSiteSaveMessage(null);
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
    setMeasurementProgressItems([]);
    setMeasurementWorkerHeadCount(0);
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
      setMeasurementBatchesError(null);
      try {
        const [bases, items, batches, activeBatches] = await Promise.all([
          api.measurementBases(site.id),
          api.measurementItems(site.id, { activeOnly: true }),
          api.siteMeasurementBatches(site.id),
          api.siteMeasurementBatches(site.id, { activeOnly: true }),
        ]);
        let progressItemLists: MobileMeasurementItem[][] = [];
        try {
          progressItemLists = activeBatches.length > 0
            ? await Promise.all(activeBatches.map((batch) => api.siteMeasurementBatchItems(site.id, batch.id)))
            : [];
        } catch (progressError) {
          setMeasurementBatchesError(readApiError(progressError, "Aufmaßmengen konnten für den Vergleich nicht geladen werden."));
        }
        setMeasurementBases(bases);
        setMeasurementItems(items);
        setMeasurementBatches(batches);
        setMeasurementBatchesLoaded(true);
        setMeasurementProgressItems(progressItemLists.flat());
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
    const currentSiteId = site?.id;
    if (!currentSiteId || activeTab !== "measurement" || measurementSubtab !== "timesheet") {
      return;
    }

    let isCurrent = true;
    const weekRange = getCurrentGermanWeekRange();
    setMeasurementWorkerHeadCount(0);
    api
      .assignments({
        siteId: currentSiteId,
        start: weekRange.start,
        end: weekRange.end,
      })
      .then((assignments) => {
        if (isCurrent) {
          setMeasurementWorkerHeadCount(getWeeklyWorkerHeadCount(assignments, weekRange.start, weekRange.end));
        }
      })
      .catch(() => {
        if (isCurrent) {
          setMeasurementWorkerHeadCount(0);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [activeTab, measurementSubtab, site?.id]);

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
    if (!site) {
      return;
    }
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      const updatedEntry = await api.updateSiteMeasurementEntry(site.id, batch.id, entryId, payload);
      setMeasurementBatchItems((current) => replaceMeasurementEntryInItems(current, updatedEntry));
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Aufmaßzeile konnte nicht gespeichert werden."));
      throw requestError;
    }
  }

  async function createMeasurementEntry(
    batch: MobileMeasurementBatch,
    measurementItemId: number,
    payload: { area_or_comment: string; quantity: number },
  ): Promise<void> {
    if (!site) {
      return;
    }
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      const createdEntry = await api.createSiteMeasurementEntry(site.id, batch.id, measurementItemId, payload);
      setMeasurementBatchItems((current) => addMeasurementEntryToItems(current, createdEntry));
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Aufmaßzeile konnte nicht angelegt werden."));
      throw requestError;
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

  async function downloadMeasurementBatchPdf(batch: MobileMeasurementBatch, mode: MeasurementPdfMode): Promise<void> {
    if (!site || measurementReviewActionLoading) {
      return;
    }
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      const blob = await api.downloadSiteMeasurementBatchPdf(site.id, batch.id, mode);
      const packageNumber = formatMeasurementPackageNumber(site.site_number, batch.number, batch.title)
        .replace(/^Aufmaß\s+/, "")
        .replace(/[^\w.-]+/g, "_");
      const prefix = mode === "checked" ? "Aufmass_geprueft" : "Aufmass";
      triggerBrowserDownload(blob, `${prefix}_${packageNumber}.pdf`);
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "PDF konnte nicht erstellt werden."));
    }
  }


  async function updateMeasurementBase(base: MeasurementBase, payload: MeasurementBaseUpdate): Promise<void> {
    if (!site || measurementImporting) {
      return;
    }
    setMeasurementImportError(null);
    try {
      const updated = await api.updateMeasurementBase(site.id, base.id, payload);
      setMeasurementBases((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (requestError) {
      setMeasurementImportError(readApiError(requestError, "Angebot konnte nicht aktualisiert werden."));
    }
  }

  async function activateMeasurementBase(base: MeasurementBase): Promise<void> {
    if (!site || measurementImporting) {
      return;
    }
    setMeasurementImportMessage(null);
    setMeasurementImportError(null);
    try {
      const bases = await api.activateMeasurementBase(site.id, base.id);
      const [items, batches, activeBatches] = await Promise.all([
        api.measurementItems(site.id, { activeOnly: true }),
        api.siteMeasurementBatches(site.id),
        api.siteMeasurementBatches(site.id, { activeOnly: true }),
      ]);
      const progressItemLists = activeBatches.length > 0
        ? await Promise.all(activeBatches.map((batch) => api.siteMeasurementBatchItems(site.id, batch.id)))
        : [];
      setMeasurementBases(bases);
      setMeasurementItems(items);
      setMeasurementBatches(batches);
      setMeasurementProgressItems(progressItemLists.flat());
      setMeasurementLoaded(true);
      setMeasurementBatchesLoaded(true);
      setMeasurementImportMessage("Angebot ist jetzt aktiv.");
    } catch (requestError) {
      setMeasurementImportError(readApiError(requestError, "Angebot konnte nicht aktiviert werden."));
    }
  }

  async function deleteMeasurementBase(base: MeasurementBase): Promise<void> {
    if (!site || measurementImporting) {
      return;
    }
    const confirmed = window.confirm(
      "Angebot wirklich löschen?\n\nImportierte Positionen dieses Angebots werden entfernt. Bereits erfasste oder abgerechnete Aufmaße dürfen nicht gelöscht werden.",
    );
    if (!confirmed) {
      return;
    }
    setMeasurementImportMessage(null);
    setMeasurementImportError(null);
    try {
      const bases = await api.deleteMeasurementBase(site.id, base.id);
      const items = await api.measurementItems(site.id, { activeOnly: true });
      setMeasurementBases(bases);
      setMeasurementItems(items);
      setMeasurementImportMessage("Angebot wurde gelöscht.");
    } catch (requestError) {
      setMeasurementImportError(readApiError(requestError, "Angebot konnte nicht gelöscht werden."));
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
      const [bases, items, batches, activeBatches] = await Promise.all([
        api.measurementBases(site.id),
        api.measurementItems(site.id, { activeOnly: true }),
        api.siteMeasurementBatches(site.id),
        api.siteMeasurementBatches(site.id, { activeOnly: true }),
      ]);
      const progressItemLists = activeBatches.length > 0
        ? await Promise.all(activeBatches.map((batch) => api.siteMeasurementBatchItems(site.id, batch.id)))
        : [];
      setMeasurementBases(bases);
      setMeasurementItems(items);
      setMeasurementBatches(batches);
      setMeasurementProgressItems(progressItemLists.flat());
      setMeasurementLoaded(true);
      setMeasurementBatchesLoaded(true);
      setMeasurementImportMessage(`Zeitenliste importiert: ${result.imported_count} Positionen in ${formatMeasurementBaseName(result.measurement_base)} erkannt.`);
    } catch (requestError) {
      setMeasurementImportError(readApiError(requestError, "Zeitenliste konnte nicht importiert werden."));
      throw requestError;
    } finally {
      setMeasurementImporting(false);
    }
  }

  function updateSiteDraft(values: Partial<SiteCreate>): void {
    setSiteDraft((current) => (current ? { ...current, ...values } : current));
    setSiteSaveError(null);
    setSiteSaveMessage(null);
  }

  function cancelSiteEdit(): void {
    setSiteDraft(site ? toEditableSite(site) : null);
    setEditMode(false);
    setSiteSaveError(null);
    setSiteSaveMessage(null);
  }

  async function saveSiteDetails(): Promise<void> {
    if (!site || !siteDraft || isSavingSite) {
      return;
    }
    const validationError = validateSitePayload(siteDraft);
    if (validationError) {
      setSiteSaveError(validationError);
      setSiteSaveMessage(null);
      return;
    }

    setIsSavingSite(true);
    setSiteSaveError(null);
    setSiteSaveMessage(null);
    try {
      const updated = await api.updateSite(site.id, normalizeSitePayload(siteDraft));
      setSite(updated);
      setSiteDraft(toEditableSite(updated));
      setEditMode(false);
      setSiteSaveMessage("Baustelle gespeichert.");
    } catch (requestError) {
      setSiteSaveError(readApiError(requestError, "Baustelle konnte nicht gespeichert werden."));
    } finally {
      setIsSavingSite(false);
    }
  }

  async function applyGeocodedSite(values: Partial<SiteCreate>): Promise<void> {
    if (!site || !siteDraft || isSavingSite) {
      return;
    }
    const nextDraft = { ...siteDraft, ...values };
    setSiteDraft(nextDraft);
    setIsSavingSite(true);
    setSiteSaveError(null);
    setSiteSaveMessage(null);
    try {
      const updated = await api.updateSite(site.id, normalizeSitePayload(nextDraft));
      setSite(updated);
      setSiteDraft(toEditableSite(updated));
      setSiteSaveMessage("Standort aus Vorschlag übernommen und gespeichert.");
    } catch (requestError) {
      setSiteSaveError(readApiError(requestError, "Standort konnte nicht gespeichert werden."));
    } finally {
      setIsSavingSite(false);
    }
  }

  async function checkSiteLocation(): Promise<void> {
    if (!site || !siteDraft || isCheckingSiteLocation) {
      return;
    }
    const validationError = validateSitePayload(siteDraft);
    if (validationError) {
      setSiteSaveError(validationError);
      setSiteSaveMessage(null);
      return;
    }

    setIsCheckingSiteLocation(true);
    setSiteSaveError(null);
    setSiteSaveMessage(null);
    try {
      await api.updateSite(site.id, normalizeSitePayload(siteDraft));
      const updated = await api.checkSiteLocation(site.id);
      setSite(updated);
      setSiteDraft(toEditableSite(updated));
      if (updated.location_status === "geocoded") {
        setSiteSaveMessage("Standort wurde geprüft und Koordinaten wurden gespeichert.");
      } else if (updated.location_status === "ambiguous") {
        setSiteSaveError("Standort ist nicht eindeutig. Bitte Adresse genauer erfassen.");
      } else {
        setSiteSaveError("Standort konnte nicht geprüft werden. Bitte Adresse prüfen.");
      }
    } catch (requestError) {
      setSiteSaveError(readApiError(requestError, "Standort konnte nicht geprüft werden."));
    } finally {
      setIsCheckingSiteLocation(false);
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

  const isMeasurementReviewWorkspace = activeTab === "measurement" && measurementSubtab === "review";

  return (
    <section className={`site-detail-page is-project-file-workspace${isMeasurementReviewWorkspace ? " is-measurement-review-workspace" : ""}`}>
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
        <OverviewTab
          site={site}
          draft={siteDraft}
          people={people}
          editMode={editMode}
          canEdit={canEditSite}
          isSaving={isSavingSite}
          isCheckingLocation={isCheckingSiteLocation}
          saveError={siteSaveError}
          saveMessage={siteSaveMessage}
          onToggleEdit={() => {
            setSiteDraft(toEditableSite(site));
            setSiteSaveError(null);
            setSiteSaveMessage(null);
            setEditMode((value) => !value);
          }}
          onCancelEdit={cancelSiteEdit}
          onDraftChange={updateSiteDraft}
          onSave={() => void saveSiteDetails()}
          onCheckLocation={() => void checkSiteLocation()}
          onGeocodeSelected={(values) => void applyGeocodedSite(values)}
        />
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
          onImport={importMeasurementTimesheet}
          onUpdateBase={(base, payload) => void updateMeasurementBase(base, payload)}
          onActivateBase={(base) => void activateMeasurementBase(base)}
          onDeleteBase={(base) => void deleteMeasurementBase(base)}
          onRetry={() => {
            setMeasurementLoaded(false);
            setMeasurementError(null);
          }}
          batches={measurementBatches}
          batchProgressItems={measurementProgressItems}
          workerHeadCount={measurementWorkerHeadCount}
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
          onExportPdf={downloadMeasurementBatchPdf}
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

function OverviewTab({
  site,
  draft,
  people,
  editMode,
  canEdit,
  isSaving,
  isCheckingLocation,
  saveError,
  saveMessage,
  onToggleEdit,
  onCancelEdit,
  onDraftChange,
  onSave,
  onCheckLocation,
  onGeocodeSelected,
}: {
  site: Site;
  draft: EditableSite | null;
  people: Person[];
  editMode: boolean;
  canEdit: boolean;
  isSaving: boolean;
  isCheckingLocation: boolean;
  saveError: string | null;
  saveMessage: string | null;
  onToggleEdit: () => void;
  onCancelEdit: () => void;
  onDraftChange: (values: Partial<SiteCreate>) => void;
  onSave: () => void;
  onCheckLocation: () => void;
  onGeocodeSelected: (values: Partial<SiteCreate>) => void;
}) {
  return (
    <div className="project-record-tab-panel">
      <div className="project-record-toolbar">
        <div>
          <h2>Übersicht</h2>
          <p>Stammdaten und Standortinformationen zur Baustelle.</p>
        </div>
        {canEdit ? (
          <button type="button" className="secondary-action" onClick={editMode ? onCancelEdit : onToggleEdit}>
            {editMode ? "Bearbeitung schließen" : "Bearbeiten"}
          </button>
        ) : null}
      </div>

      {saveError ? <p className="form-error">{saveError}</p> : null}
      {saveMessage ? <p className="form-info">{saveMessage}</p> : null}

      {editMode && draft ? (
        <div className="project-record-edit-panel">
          <SiteFields
            draft={draft}
            people={people}
            disabled={!canEdit || isSaving}
            isCheckingLocation={isCheckingLocation}
            onChange={onDraftChange}
            onCheckLocation={onCheckLocation}
            onGeocodeSelected={onGeocodeSelected}
          />
          <div className="project-record-edit-actions">
            <button type="button" className="secondary-action" disabled={isSaving} onClick={onCancelEdit}>
              Abbrechen
            </button>
            <button type="button" className="secondary-action primary-action" disabled={isSaving} onClick={onSave}>
              {isSaving ? "Speichert..." : "Speichern"}
            </button>
          </div>
        </div>
      ) : (
        <>
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
        </>
      )}
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
  batchProgressItems,
  workerHeadCount,
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
  onExportPdf,
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
  onImport: (file: File, options: MeasurementImportOptions) => Promise<void>;
  onUpdateBase: (base: MeasurementBase, payload: MeasurementBaseUpdate) => void;
  onActivateBase: (base: MeasurementBase) => void;
  onDeleteBase: (base: MeasurementBase) => void;
  onRetry: () => void;
  batches: MobileMeasurementBatch[];
  batchProgressItems: MobileMeasurementItem[];
  workerHeadCount: number;
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
  onExportPdf: (batch: MobileMeasurementBatch, mode: MeasurementPdfMode) => Promise<void>;
}) {
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
          siteNumber={siteNumber}
          bases={bases}
          items={items}
          progressItems={batchProgressItems}
          workerHeadCount={workerHeadCount}
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
          onExportPdf={onExportPdf}
        />
      ) : null}

      {activeSubtab === "time-analysis" ? <MeasurementTimeAnalysisPanel /> : null}

      {activeSubtab === "bases" ? (
        <MeasurementBasesPanel
          bases={bases}
          message={importMessage}
          error={importError}
          onUpdateBase={onUpdateBase}
          onActivateBase={onActivateBase}
          onDeleteBase={onDeleteBase}
        />
      ) : null}
    </div>
  );
}

function MeasurementTimesheetPanel({
  siteNumber,
  bases,
  items,
  progressItems,
  workerHeadCount,
  isLoading,
  error,
  isImporting,
  importMessage,
  importError,
  onImport,
  onRetry,
}: {
  siteNumber: string | null;
  bases: MeasurementBase[];
  items: MeasurementItem[];
  progressItems: MobileMeasurementItem[];
  workerHeadCount: number;
  isLoading: boolean;
  error: string | null;
  isImporting: boolean;
  importMessage: string | null;
  importError: string | null;
  onImport: (file: File, options: MeasurementImportOptions) => Promise<void>;
  onRetry: () => void;
}) {
  const selectableBases = bases.filter((base) => base.status !== "closed" && base.status !== "archived");
  const defaultBase = selectableBases.find((base) => base.status === "active" && base.released_to_mobile) ?? selectableBases[0] ?? null;
  const suggestedBaseName = getSuggestedMeasurementSheetName(siteNumber, bases.length + 1);
  const [importMode, setImportMode] = useState<MeasurementImportOptions["importMode"]>(defaultBase ? "append_existing" : "create_new");
  const [selectedBaseId, setSelectedBaseId] = useState<number | null>(defaultBase?.id ?? null);
  const [newBaseName, setNewBaseName] = useState(suggestedBaseName);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [isDropTargetActive, setIsDropTargetActive] = useState(false);
  const [fileSelectionError, setFileSelectionError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<MeasurementTimesheetFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");

  const measuredByItemId = useMemo(() => {
    const totals = new Map<number, { quantity: number; minutes: number }>();

    for (const progressItem of progressItems) {
      const quantity = getMeasurementNumericValue(progressItem.reported_quantity);
      const minutesPerUnit = getMeasurementNumericValue(progressItem.minutes_per_unit);
      const reportedMinutes = getMeasurementNumericValue(progressItem.reported_minutes);
      const minutes = reportedMinutes > 0 ? reportedMinutes : quantity * minutesPerUnit;
      const current = totals.get(progressItem.id) ?? { quantity: 0, minutes: 0 };

      totals.set(progressItem.id, {
        quantity: current.quantity + quantity,
        minutes: current.minutes + minutes,
      });
    }

    return totals;
  }, [progressItems]);

  const projectPositionRows = useMemo(() => (
    items.map((item) => {
      const plannedQuantity = getMeasurementNumericValue(item.list_quantity);
      const minutesPerUnit = getMeasurementNumericValue(item.minutes_per_unit);
      const plannedMinutes = plannedQuantity > 0 && minutesPerUnit > 0 ? plannedQuantity * minutesPerUnit : 0;
      const measured = measuredByItemId.get(item.id) ?? { quantity: 0, minutes: 0 };
      const measuredMinutes = measured.minutes > 0 ? measured.minutes : measured.quantity * minutesPerUnit;
      const progressPercent = plannedMinutes > 0 ? (measuredMinutes / plannedMinutes) * 100 : null;
      const remainingQuantity = plannedQuantity > 0 ? plannedQuantity - measured.quantity : null;

      return {
        item,
        positionNumber: item.position,
        description: item.description,
        unit: item.unit,
        plannedQuantity,
        hasPlannedQuantity: plannedQuantity > 0,
        measuredQuantity: measured.quantity,
        remainingQuantity,
        minutesPerUnit,
        plannedMinutes,
        measuredMinutes,
        progressPercent,
      };
    })
  ), [items, measuredByItemId]);

  const projectPositionStats = useMemo(() => {
    const plannedMinutes = projectPositionRows.reduce((sum, row) => sum + row.plannedMinutes, 0);
    const measuredMinutes = projectPositionRows.reduce((sum, row) => sum + row.measuredMinutes, 0);
    const hasPlannedBasis = plannedMinutes > 0;
    const progressPercent = hasPlannedBasis ? (measuredMinutes / plannedMinutes) * 100 : null;
    const withMeasurement = projectPositionRows.filter((row) => row.measuredQuantity > 0).length;

    // Belastbarer Fortschritt ist erst möglich, wenn Angebots-/Sollmengen als Vergleichsbasis vorhanden sind.
    return {
      total: projectPositionRows.length,
      plannedMinutes,
      measuredMinutes,
      progressPercent,
      openMinutes: hasPlannedBasis ? plannedMinutes - measuredMinutes : null,
      hasPlannedBasis,
      withMeasurement,
      withoutMeasurement: projectPositionRows.length - withMeasurement,
    };
  }, [projectPositionRows]);

  const latestImportInfo = useMemo(() => {
    let latestItem: MeasurementItem | null = null;
    let latestTimestamp = -Infinity;

    for (const item of items) {
      const timestamp = Date.parse(item.updated_at || item.created_at);
      if (Number.isFinite(timestamp) && timestamp > latestTimestamp) {
        latestTimestamp = timestamp;
        latestItem = item;
      }
    }

    return latestItem
      ? {
          fileName: latestItem.source_file_name,
          updatedAt: latestItem.updated_at || latestItem.created_at,
        }
      : null;
  }, [items]);

  const filterOptions = useMemo(() => ([
    { key: "all" as const, label: "Alle", count: projectPositionStats.total },
    { key: "billed" as const, label: "Abgerechnet", count: projectPositionStats.withMeasurement },
    { key: "unbilled" as const, label: "Noch nicht abgerechnet", count: projectPositionStats.withoutMeasurement },
  ]), [projectPositionStats]);

  const filteredProjectPositionRows = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLocaleLowerCase("de-DE");

    return projectPositionRows.filter((row) => {
      const matchesFilter =
        activeFilter === "all"
        || (activeFilter === "billed" && row.measuredQuantity > 0)
        || (activeFilter === "unbilled" && row.measuredQuantity <= 0);

      if (!matchesFilter) {
        return false;
      }
      if (!normalizedSearch) {
        return true;
      }

      const haystack = `${row.positionNumber} ${row.description ?? ""}`.toLocaleLowerCase("de-DE");
      return haystack.includes(normalizedSearch);
    });
  }, [activeFilter, projectPositionRows, searchTerm]);

  useEffect(() => {
    if (defaultBase && selectedBaseId === null) {
      setSelectedBaseId(defaultBase.id);
      setImportMode("append_existing");
    }
    if (!defaultBase && importMode === "append_existing") {
      setImportMode("create_new");
      setSelectedBaseId(null);
    }
  }, [defaultBase, importMode, selectedBaseId]);

  function resetImportDialog() {
    setPendingFile(null);
    setIsImportDialogOpen(false);
    setDialogError(null);
    setFileSelectionError(null);
    setIsDropTargetActive(false);
  }

  function openImportDialog(file: File) {
    if (!isPdfFile(file)) {
      setFileSelectionError("Bitte eine PDF-Datei auswählen oder ablegen.");
      return;
    }
    setPendingFile(file);
    setImportMode(defaultBase ? "append_existing" : "create_new");
    setSelectedBaseId(defaultBase?.id ?? null);
    setNewBaseName(getSuggestedMeasurementSheetName(siteNumber, bases.length + 1));
    setDialogError(null);
    setFileSelectionError(null);
    setIsImportDialogOpen(true);
  }

  async function submitImport() {
    if (!pendingFile || isImporting) {
      return;
    }
    if (importMode === "append_existing" && selectedBaseId === null) {
      setDialogError("Bitte ein Aufmaßblatt auswählen.");
      return;
    }
    if (importMode === "create_new" && !newBaseName.trim()) {
      setDialogError("Bitte einen Namen für das neue Aufmaßblatt eintragen.");
      return;
    }

    try {
      await onImport(pendingFile, {
        importMode,
        measurementBaseId: importMode === "append_existing" ? selectedBaseId : null,
        measurementBaseName: importMode === "create_new" ? newBaseName : null,
      });
      resetImportDialog();
    } catch {
      setDialogError("Zeitenliste konnte nicht importiert werden. Bitte die Angaben prüfen.");
    }
  }

  return (
    <>
      <div className="measurement-timesheet-workspace">
        <div className="project-record-toolbar measurement-timesheet-header">
          <div>
            <h2><Ruler aria-hidden="true" size={18} />Projektpositionen / Angebot vs. Ausführung</h2>
            <p>Übersicht über Projektpositionen, Montagezeiten und bisher erfasste Aufmaßmengen.</p>
            <div className="measurement-timesheet-meta">
              {defaultBase ? <span><strong>Aktives Aufmaß:</strong> {formatMeasurementBaseName(defaultBase)}</span> : null}
              {latestImportInfo?.fileName ? <span><strong>Letzter Import:</strong> {latestImportInfo.fileName}</span> : null}
              {latestImportInfo?.updatedAt ? <span><strong>Importzeit:</strong> {formatDateTime(latestImportInfo.updatedAt)}</span> : null}
            </div>
          </div>
          <label
            className={`secondary-action project-upload-action measurement-import-drop-action${isImporting ? " is-disabled" : ""}${isDropTargetActive ? " is-drop-target" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!isImporting) {
                setIsDropTargetActive(true);
              }
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDropTargetActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDropTargetActive(false);
              const file = event.dataTransfer.files?.[0];
              if (file) {
                openImportDialog(file);
              }
            }}
          >
            <UploadCloud aria-hidden="true" size={15} />
            <span>{isDropTargetActive ? "PDF hier ablegen" : "Zeitenliste-PDF importieren"}</span>
            <input
              className="project-upload-input"
              type="file"
              accept="application/pdf,.pdf"
              disabled={isImporting}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  openImportDialog(file);
                  event.target.value = "";
                }
              }}
            />
          </label>
        </div>

        {fileSelectionError ? <div className="project-record-empty-state is-error"><strong>{fileSelectionError}</strong></div> : null}
        {importMessage ? <div className="project-record-empty-state is-success">{importMessage}</div> : null}
        {importError && !isImportDialogOpen ? <div className="project-record-empty-state is-error"><strong>{importError}</strong></div> : null}

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
          <>
            <div className="measurement-timesheet-kpis" aria-label="Projektpositionen Kennzahlen">
              <div className="measurement-timesheet-kpi-card">
                <span>Projektpositionen</span>
                <strong>{projectPositionStats.total}</strong>
              </div>
              <div className="measurement-timesheet-kpi-card">
                <span>Geplante Stunden</span>
                <strong>{projectPositionStats.hasPlannedBasis ? formatMeasurementDuration(projectPositionStats.plannedMinutes) : "Noch keine Sollbasis"}</strong>
              </div>
              <div className="measurement-timesheet-kpi-card">
                <span>Aufmaß-Stunden</span>
                <strong>{formatMeasurementDuration(projectPositionStats.measuredMinutes)}</strong>
              </div>
              <div className="measurement-timesheet-kpi-card">
                <span>Rechnerischer Ausführungsstand</span>
                <strong>{projectPositionStats.progressPercent !== null ? formatMeasurementPercent(projectPositionStats.progressPercent) : "Keine Sollbasis"}</strong>
              </div>
              <div className="measurement-timesheet-kpi-card">
                <span>Offene Stunden</span>
                <strong>{projectPositionStats.openMinutes !== null ? formatMeasurementDuration(projectPositionStats.openMinutes) : "Keine Sollbasis"}</strong>
              </div>
            </div>

            <section className="measurement-timesheet-progress-panel" aria-label="Rechnerischer Ausführungsstand">
              <div className="measurement-timesheet-progress-head">
                <div>
                  <h3>Rechnerischer Ausführungsstand</h3>
                  <p>Aufmaß-/Leistungsfortschritt auf Basis von Montagezeiten und erfassten Aufmaßmengen.</p>
                </div>
                {projectPositionStats.progressPercent !== null ? <strong>{formatMeasurementPercent(projectPositionStats.progressPercent)}</strong> : null}
              </div>
              {projectPositionStats.progressPercent !== null ? (
                <>
                  <ExecutionProgressTrack
                    percent={projectPositionStats.progressPercent}
                    workerHeadCount={workerHeadCount}
                  />
                  <p className="measurement-timesheet-progress-note">
                    {formatMeasurementDuration(projectPositionStats.measuredMinutes)} von {formatMeasurementDuration(projectPositionStats.plannedMinutes)} über Aufmaß erfasst.
                  </p>
                </>
              ) : (
                <p className="measurement-timesheet-progress-note">
                  Für einen belastbaren Fortschritt fehlt aktuell noch die Sollbasis aus Angebots-/Projektmengen.
                </p>
              )}
            </section>

            <section className="measurement-timesheet-table-panel" aria-label="Projektpositionen Tabelle">
              <div className="measurement-timesheet-filterbar">
                <div className="measurement-timesheet-filter-group" aria-label="Zeitenliste filtern">
                  {filterOptions.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className={activeFilter === option.key ? "is-active" : ""}
                      onClick={() => setActiveFilter(option.key)}
                    >
                      {option.label}
                      <span>{option.count}</span>
                    </button>
                  ))}
                </div>
                <label className="measurement-timesheet-search">
                  <Search aria-hidden="true" size={15} />
                  <input
                    type="search"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder="Position oder Beschreibung suchen..."
                  />
                </label>
              </div>

              {filteredProjectPositionRows.length === 0 ? (
                <div className="project-record-empty-state">Keine passenden Projektpositionen gefunden.</div>
              ) : (
                <div className="measurement-table-wrap measurement-timesheet-table-wrap">
                  <table className="measurement-table measurement-timesheet-table">
                    <thead>
                      <tr>
                        <th>Pos.-Nr.</th>
                        <th>Bezeichnung</th>
                        <th>Einheit</th>
                        <th className="measurement-timesheet-number">Sollmenge / Listenmenge</th>
                        <th className="measurement-timesheet-number">Aufmaßmenge</th>
                        <th className="measurement-timesheet-number">Restmenge</th>
                        <th className="measurement-timesheet-number">Min./Einheit</th>
                        <th className="measurement-timesheet-number">Aufmaß-Stunden</th>
                        <th className="measurement-timesheet-number">Fortschritt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredProjectPositionRows.map((row) => (
                        <tr
                          key={row.item.id}
                          className={row.measuredQuantity > 0 ? "has-quantity" : ""}
                        >
                          <td><strong>{row.positionNumber}</strong></td>
                          <td className="measurement-timesheet-description">{row.description}</td>
                          <td>{row.unit ?? "-"}</td>
                          <td className="measurement-timesheet-number">{row.hasPlannedQuantity ? formatMeasurementNumber(row.plannedQuantity) : "-"}</td>
                          <td className="measurement-timesheet-number">{row.measuredQuantity > 0 ? formatMeasurementNumber(row.measuredQuantity) : "-"}</td>
                          <td className="measurement-timesheet-number">{row.remainingQuantity !== null ? formatMeasurementNumber(row.remainingQuantity) : "-"}</td>
                          <td className="measurement-timesheet-number">{row.minutesPerUnit > 0 ? formatMeasurementNumber(row.minutesPerUnit) : "-"}</td>
                          <td className="measurement-timesheet-number">{row.measuredMinutes > 0 ? formatMeasurementDuration(row.measuredMinutes) : "-"}</td>
                          <td className="measurement-timesheet-number">{row.progressPercent !== null ? formatMeasurementPercent(row.progressPercent) : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>

      {isImportDialogOpen && pendingFile ? (
        <div className="measurement-import-modal-backdrop" role="presentation" onMouseDown={resetImportDialog}>
          <section
            className="measurement-import-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="measurement-import-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="measurement-import-modal-header">
              <div>
                <h3 id="measurement-import-dialog-title">Zeitenliste importieren</h3>
                <p>Wähle, ob die PDF ein bestehendes Aufmaßblatt erweitert oder ein neues Aufmaßblatt erstellt.</p>
              </div>
              <button type="button" className="secondary-action" onClick={resetImportDialog}>Abbrechen</button>
            </div>

            <div className="measurement-import-file-row">
              <FileText aria-hidden="true" size={18} />
              <span>{pendingFile.name}</span>
            </div>

            <div className="measurement-import-modal-options">
              <label className={importMode === "append_existing" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="measurement-import-modal-mode"
                  checked={importMode === "append_existing"}
                  disabled={selectableBases.length === 0}
                  onChange={() => setImportMode("append_existing")}
                />
                <span>
                  <strong>An bestehendes Aufmaßblatt anhängen</strong>
                  <small>Für Nachträge oder Ergänzungen eines laufenden Sammelaufmaßes.</small>
                </span>
              </label>
              {importMode === "append_existing" ? (
                selectableBases.length > 0 ? (
                  <select value={selectedBaseId ?? ""} onChange={(event) => setSelectedBaseId(Number(event.target.value) || null)}>
                    {selectableBases.map((base) => (
                      <option key={base.id} value={base.id}>{formatMeasurementBaseName(base)}</option>
                    ))}
                  </select>
                ) : (
                  <small>Es gibt noch kein Aufmaßblatt zum Anhängen.</small>
                )
              ) : null}
              <label className={importMode === "create_new" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="measurement-import-modal-mode"
                  checked={importMode === "create_new"}
                  onChange={() => setImportMode("create_new")}
                />
                <span>
                  <strong>Neues Aufmaßblatt erstellen</strong>
                  <small>Für ein neues Hauptangebot oder ein getrenntes Einzelaufmaß.</small>
                </span>
              </label>
              {importMode === "create_new" ? (
                <>
                  <input
                    className="measurement-base-name-input"
                    value={newBaseName}
                    onChange={(event) => setNewBaseName(event.target.value)}
                    placeholder="Name des Aufmaßblatts"
                  />
                  <small>Das neue Aufmaßblatt wird nach dem Import automatisch aktiviert.</small>
                </>
              ) : null}
            </div>

            {dialogError ? <div className="project-record-empty-state is-error"><strong>{dialogError}</strong></div> : null}
            {importError && isImportDialogOpen ? <div className="project-record-empty-state is-error"><strong>{importError}</strong></div> : null}

            <div className="measurement-import-modal-actions">
              <button type="button" className="secondary-action" onClick={resetImportDialog}>Abbrechen</button>
              <button
                type="button"
                className="primary-action"
                disabled={isImporting || (importMode === "append_existing" && selectedBaseId === null) || (importMode === "create_new" && !newBaseName.trim())}
                onClick={() => void submitImport()}
              >
                {isImporting ? "Importiert..." : "Importieren"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function ExecutionProgressTrack({
  percent,
  workerHeadCount,
}: {
  percent: number;
  workerHeadCount: number;
}) {
  const visualPercent = clampProgressPercent(percent);
  const displayPercent = Number.isFinite(percent) ? percent : 0;
  const markerPlacement = visualPercent <= 8
    ? " is-near-start"
    : visualPercent >= 92
      ? " is-near-end"
      : "";
  const headCount = Math.min(Math.max(Math.floor(workerHeadCount), 0), 5);

  return (
    <div
      className={`measurement-execution-track${displayPercent > 100 ? " is-over-target" : ""}`}
      role="meter"
      aria-label={`Rechnerischer Ausführungsstand ${formatMeasurementPercent(displayPercent)}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(visualPercent)}
    >
      <div className="measurement-execution-rail">
        <span className="measurement-execution-fill" style={{ width: `${visualPercent}%` }} />
        <span className="measurement-execution-flag" aria-hidden="true">
          <Flag size={14} />
        </span>
        <span
          className={`measurement-execution-marker${markerPlacement}`}
          style={{ left: `${visualPercent}%` }}
          aria-hidden="true"
        >
          {headCount > 0 ? (
            <span className="measurement-worker-heads">
              {Array.from({ length: headCount }).map((_, index) => (
                <span className="measurement-worker-head" key={index} />
              ))}
            </span>
          ) : null}
          <span className="measurement-execution-pin" />
        </span>
      </div>
      <div className="measurement-execution-scale" aria-hidden="true">
        {[0, 25, 50, 75, 100].map((tick) => (
          <span key={tick}>{tick} %</span>
        ))}
      </div>
    </div>
  );
}

function MeasurementBasesPanel({
  bases,
  message,
  error,
  onUpdateBase,
  onActivateBase,
  onDeleteBase,
}: {
  bases: MeasurementBase[];
  message: string | null;
  error: string | null;
  onUpdateBase: (base: MeasurementBase, payload: MeasurementBaseUpdate) => void;
  onActivateBase: (base: MeasurementBase) => void;
  onDeleteBase: (base: MeasurementBase) => void;
}) {
  const sortedBases = bases.slice().sort((left, right) => (
    new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
    || left.id - right.id
  ));
  const offerNumberByBaseId = new Map(sortedBases.map((base, index) => [base.id, index + 1]));

  return (
    <section className="measurement-bases-panel">
      <div className="project-record-toolbar">
        <div>
          <h2><Ruler aria-hidden="true" size={18} />Angebotsübersicht</h2>
          <p>Angebote verwalten. Der Monteur sieht immer genau ein Angebot für die Aufmaßerstellung.</p>
        </div>
      </div>
      {message ? <div className="project-record-empty-state is-success">{message}</div> : null}
      {error ? <div className="project-record-empty-state is-error"><strong>{error}</strong></div> : null}
      {bases.length === 0 ? (
        <div className="project-record-empty-state">Noch kein Angebot vorhanden.</div>
      ) : (
        <div className="measurement-base-list">
          {sortedBases.map((base) => {
            const isActive = base.status === "active" && base.released_to_mobile;
            const positionCount = base.item_count ?? 0;
            const hasMeasurementData = (base.batch_count ?? 0) > 0;
            const fallbackOfferLabel = `Angebot ${offerNumberByBaseId.get(base.id) ?? ""}`.trim();
            const offerLabel = formatMeasurementBaseName(base).trim() || fallbackOfferLabel;
            return (
              <article className={`measurement-base-card${isActive ? " is-active" : ""}`} key={base.id}>
                <div className="measurement-base-main">
                  <div className="measurement-base-copy">
                    <div className="measurement-base-title-row">
                      <strong>{offerLabel}</strong>
                      <input
                        className="measurement-offer-note-input"
                        key={`${base.id}-${base.source_note ?? ""}`}
                        defaultValue={base.source_note ?? ""}
                        aria-label={`Kurzkennung zu ${offerLabel}`}
                        placeholder="Kurzkennung"
                        onBlur={(event) => {
                          const nextValue = event.currentTarget.value.trim();
                          if (nextValue !== (base.source_note ?? "")) {
                            onUpdateBase(base, { source_note: nextValue || null });
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                          if (event.key === "Escape") {
                            event.currentTarget.value = base.source_note ?? "";
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </div>
                    <small>
                      {isActive ? "Aktiv" : "Inaktiv"} · {positionCount} Positionen · erstellt {formatDateTime(base.created_at)}
                    </small>
                  </div>
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
                        ? "Aktive Angebote können nicht gelöscht werden."
                        : hasMeasurementData
                          ? "Angebote mit erfassten Aufmaßen können nicht gelöscht werden."
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

type MeasurementManualColumnDraft = {
  position: string;
  description: string;
  unit: string;
  linkedItemId?: number | null;
};

type MeasurementSuggestionState = {
  columnKey: string;
  query: string;
  activeIndex: number;
} | null;


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

function normalizeMeasurementUnitDisplay(unit: string | null | undefined): string {
  const raw = (unit ?? "").trim();
  if (!raw) {
    return "";
  }
  const normalized = raw
    .toLocaleLowerCase("de-DE")
    .replace(/\./g, "")
    .replace(/\s+/g, " ");

  if (["st", "stk", "stck", "stück", "stueck", "stücke", "stuecke"].includes(normalized)) {
    return "st";
  }
  if (["m", "mtr", "meter", "lfm", "laufmeter"].includes(normalized)) {
    return "m";
  }
  if (["std", "stunde", "stunden", "h"].includes(normalized)) {
    return "std";
  }
  if (["pausch", "pauschal", "psch"].includes(normalized)) {
    return "psch";
  }
  return normalized;
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

function getMeasurementCellQuantity(entries: MobileMeasurementItem["entries"]): number {
  return entries.reduce((sum, entry) => {
    const quantity = typeof entry.quantity === "number" ? entry.quantity : Number(entry.quantity);
    return Number.isFinite(quantity) ? sum + quantity : sum;
  }, 0);
}

function recalculateMeasurementItemTotals(item: MobileMeasurementItem, entries: MeasurementEntry[]): MobileMeasurementItem {
  const reportedQuantity = getMeasurementCellQuantity(entries);
  const minutesPerUnit = typeof item.minutes_per_unit === "number" ? item.minutes_per_unit : Number(item.minutes_per_unit);
  const reportedMinutes = Number.isFinite(minutesPerUnit) ? reportedQuantity * minutesPerUnit : item.reported_minutes;
  const reportedHours = typeof reportedMinutes === "number" && Number.isFinite(reportedMinutes) ? reportedMinutes / 60 : item.reported_hours;
  return {
    ...item,
    entries,
    reported_quantity: reportedQuantity,
    reported_minutes: reportedMinutes,
    reported_hours: reportedHours,
    mobile_status: reportedQuantity > 0 ? "edited" : "open",
  };
}

function replaceMeasurementEntryInItems(items: MobileMeasurementItem[], updatedEntry: MeasurementEntry): MobileMeasurementItem[] {
  return items.map((item) => {
    if (item.id !== updatedEntry.measurement_item_id) {
      return item;
    }
    const entries = item.entries.map((entry) => (entry.id === updatedEntry.id ? updatedEntry : entry));
    return recalculateMeasurementItemTotals(item, entries);
  });
}

function addMeasurementEntryToItems(items: MobileMeasurementItem[], createdEntry: MeasurementEntry): MobileMeasurementItem[] {
  return items.map((item) => {
    if (item.id !== createdEntry.measurement_item_id) {
      return item;
    }
    const entries = item.entries.some((entry) => entry.id === createdEntry.id)
      ? item.entries
      : [...item.entries, createdEntry];
    return recalculateMeasurementItemTotals(item, entries);
  });
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
  onExportPdf,
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
  onExportPdf: (batch: MobileMeasurementBatch, mode: MeasurementPdfMode) => Promise<void>;
}) {
  const [entryDrafts, setEntryDrafts] = useState<Record<number, MeasurementEntryDraft>>({});
  const [undoStack, setUndoStack] = useState<MeasurementEntryUndoState[]>([]);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [savingEntryId, setSavingEntryId] = useState<number | null>(null);
  const [pdfExportingAction, setPdfExportingAction] = useState<string | null>(null);
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

  const sortedBatches = useMemo(() => [...batches].sort((left, right) => {
    const rightTime = getMeasurementBatchSortTime(right);
    const leftTime = getMeasurementBatchSortTime(left);
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return right.number - left.number;
  }), [batches]);

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
      setEntryDrafts((current) => ({
        ...current,
        [entry.id]: { area_or_comment: comment, quantity: formatMeasurementDraftQuantity(quantity) },
      }));
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
      setUndoStack((current) => {
        const undoIndex = current.lastIndexOf(previousState);
        if (undoIndex === -1) {
          return current;
        }
        return [
          ...current.slice(0, undoIndex),
          ...current.slice(undoIndex + 1),
        ];
      });
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
    const updatedLabel = selectedBatch.updated_at ? formatDateTime(selectedBatch.updated_at) : null;

    return (
      <div className={`measurement-review-detail${viewMode === "table" ? " is-table-view" : ""}`}>
        <div className="measurement-package-header measurement-review-package-row">
          <div className="measurement-review-package-title">
            <h2>{displayTitle}</h2>
          </div>
          {updatedLabel ? <span className="measurement-review-updated">Letzte Änderung: {updatedLabel}</span> : null}
        </div>

        <div className="measurement-table-toolbar measurement-review-toolbar-row">
          <div className="measurement-review-toolbar-left">
            <button type="button" className="secondary-action" onClick={onBackToBatchList}>Zurück</button>
            <span className="measurement-review-action-divider" aria-hidden="true" />
            <MeasurementViewToggle viewMode={viewMode} onChange={updateViewMode} />
            <span className="measurement-review-action-divider" aria-hidden="true" />
            <div className="measurement-review-filter-group" aria-label="Statusfilter">
              <span>Alle</span>
              <span className={!isBilled ? "is-active" : ""}>Noch offen</span>
              <span className={isBilled ? "is-active" : ""}>Abgerechnet</span>
            </div>
          </div>
          <div className="measurement-review-actions">
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
            <span className="measurement-review-action-divider" aria-hidden="true" />
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
            positionSuggestions={batchItems}
            canEditRows={canEditRows}
            reviewActionLoading={reviewActionLoading}
            savingEntryId={savingEntryId}
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
          {sortedBatches.map((batch) => {
            const canExportPdf = isMeasurementBatchPdfExportable(batch.status);
            const isOldOffer = batch.is_current_offer === false;
            const checkedPdfKey = `${batch.id}:checked`;
            const originalPdfKey = `${batch.id}:original`;
            const isExportingCheckedPdf = pdfExportingAction === checkedPdfKey;
            const isExportingOriginalPdf = pdfExportingAction === originalPdfKey;
            const isExportingPdf = isExportingCheckedPdf || isExportingOriginalPdf;
            return (
              <div
                key={batch.id}
                className={`measurement-review-card${batch.status === "submitted" ? " is-submitted" : ""}${isOldOffer ? " is-old-offer" : ""}`}
              >
                <button
                  type="button"
                  className="measurement-review-card-open"
                  onClick={() => onSelectBatch(batch)}
                >
                  <span className={getMeasurementBatchStatusClass(batch.status)}>{getMeasurementBatchStatusLabel(batch.status)}</span>
                  <div className="measurement-review-card-main">
                    <div className="measurement-review-card-title-row">
                      <strong>{formatMeasurementPackageNumber(siteNumber, batch.number, batch.title)}</strong>
                      {isOldOffer ? <span className="measurement-status is-old-offer">Altes Angebot</span> : null}
                    </div>
                    <small>
                      {batch.submitted_by_name ? `Von ${batch.submitted_by_name}` : "Ohne Einreicher"}
                      {batch.submitted_at ? ` · ${formatDateTime(batch.submitted_at)}` : ""}
                      {isOldOffer && batch.offer_name ? ` · ${batch.offer_name}` : ""}
                    </small>
                  </div>
                  <b>{batch.entry_count} Zeilen · {batch.position_count} Positionen</b>
                </button>
                <div className="measurement-review-pdf-actions">
                  <button
                    type="button"
                    className="measurement-review-pdf-action"
                    disabled={!canExportPdf || isExportingPdf}
                    title={canExportPdf ? "Geprüftes PDF mit Projektleiterkorrekturen exportieren" : "PDF-Export erst bei abgerechneten Aufmaßen verfügbar"}
                    onClick={() => {
                      setPdfExportingAction(checkedPdfKey);
                      void onExportPdf(batch, "checked").finally(() => setPdfExportingAction(null));
                    }}
                  >
                    {isExportingCheckedPdf ? "PDF..." : "Aufmaß geprüft"}
                  </button>
                  <button
                    type="button"
                    className="measurement-review-pdf-action"
                    disabled={!canExportPdf || isExportingPdf}
                    title={canExportPdf ? "Originales Monteur-Aufmaß exportieren" : "PDF-Export erst bei abgerechneten Aufmaßen verfügbar"}
                    onClick={() => {
                      setPdfExportingAction(originalPdfKey);
                      void onExportPdf(batch, "original").finally(() => setPdfExportingAction(null));
                    }}
                  >
                    {isExportingOriginalPdf ? "PDF..." : "Aufmaß"}
                  </button>
                </div>
              </div>
            );
          })}
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
  positionSuggestions,
  canEditRows,
  reviewActionLoading,
  savingEntryId,
  onDraftSave,
  onDraftReset,
  onCellCreate,
}: {
  items: MobileMeasurementItem[];
  positionSuggestions: MobileMeasurementItem[];
  canEditRows: boolean;
  reviewActionLoading: boolean;
  savingEntryId: number | null;
  onDraftSave: (entry: MobileMeasurementItem["entries"][number], draft: MeasurementEntryDraft | undefined) => void;
  onDraftReset: (entry: MobileMeasurementItem["entries"][number]) => void;
  onCellCreate: (item: MobileMeasurementItem, areaLabel: string, quantity: number) => Promise<void>;
}) {
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const areaLabelDraftsRef = useRef<Record<string, string>>({});
  const savingCellKeysRef = useRef<Set<string>>(new Set());
  const [viewportColumnCount, setViewportColumnCount] = useState(MEASUREMENT_TABLE_MIN_COLUMNS);
  const [manualColumnDrafts, setManualColumnDrafts] = useState<Record<string, MeasurementManualColumnDraft>>({});
  const [manualColumnTotals, setManualColumnTotals] = useState<Record<string, number>>({});
  const [suggestionState, setSuggestionState] = useState<MeasurementSuggestionState>(null);
  const [areaDraftVersion, setAreaDraftVersion] = useState(0);
  const areaRows = useMemo(() => buildMeasurementMatrixAreaRows(items), [items]);
  const actualItemIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const displayColumnCount = Math.max(MEASUREMENT_TABLE_MIN_COLUMNS, items.length, viewportColumnCount);
  const placeholderColumnCount = Math.max(0, displayColumnCount - items.length);
  const displayColumns: Array<
    | { key: string; kind: "item"; item: MobileMeasurementItem }
    | { key: string; kind: "placeholder"; index: number }
  > = useMemo(() => ([
    ...items.map((item) => ({ key: `item-${item.id}`, kind: "item" as const, item })),
    ...Array.from({ length: placeholderColumnCount }, (_, index) => ({
      key: `placeholder-column-${index + 1}`,
      kind: "placeholder" as const,
      index: index + 1,
    })),
  ]), [items, placeholderColumnCount]);
  const displayAreaRows: Array<MeasurementMatrixAreaRow & { isPlaceholder?: boolean }> = useMemo(() => {
    const placeholderAreaRows = Array.from({ length: Math.max(0, MEASUREMENT_TABLE_MIN_AREA_ROWS - areaRows.length) }, (_, index) => ({
      key: `placeholder-area-${index + 1}`,
      label: "",
      firstIndex: areaRows.length + index,
      sortRank: Number.MAX_SAFE_INTEGER - MEASUREMENT_TABLE_MIN_AREA_ROWS + index,
      isPlaceholder: true,
    }));
    return [
      ...areaRows.map((area) => ({ ...area, isPlaceholder: false })),
      ...placeholderAreaRows,
    ];
  }, [areaRows]);
  const entryGroups = useMemo(() => {
    const groups = new Map<string, MobileMeasurementItem["entries"]>();
    for (const item of items) {
      for (const entry of item.entries) {
        const key = `${item.id}:${getMeasurementAreaKey(entry.area_or_comment)}`;
        const entries = groups.get(key) ?? [];
        entries.push(entry);
        groups.set(key, entries);
      }
    }
    return groups;
  }, [items]);
  const totalsByItemId = useMemo(() => new Map(items.map((item) => [item.id, getMeasurementCellQuantity(item.entries)])), [items]);
  const suggestionMatches = useMemo(() => {
    if (!suggestionState?.query.trim()) {
      return [];
    }
    const query = suggestionState.query.trim().toLocaleLowerCase("de-DE");
    return positionSuggestions
      .filter((item) => !actualItemIds.has(item.id))
      .filter((item) => (
        item.position.toLocaleLowerCase("de-DE").includes(query)
        || item.description.toLocaleLowerCase("de-DE").includes(query)
      ))
      .slice(0, 8);
  }, [actualItemIds, positionSuggestions, suggestionState]);
  const tableStyle = useMemo(() => ({
    "--measurement-axis-width": `${MEASUREMENT_TABLE_AXIS_WIDTH}px`,
    "--measurement-position-width": `${MEASUREMENT_TABLE_POSITION_WIDTH}px`,
    "--measurement-table-width": `${MEASUREMENT_TABLE_AXIS_WIDTH + displayColumnCount * MEASUREMENT_TABLE_POSITION_WIDTH}px`,
  }) as CSSProperties, [displayColumnCount]);

  useEffect(() => {
    const node = tableWrapRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const updateViewportColumns = () => {
      const availableWidth = Math.max(0, node.clientWidth - MEASUREMENT_TABLE_AXIS_WIDTH);
      setViewportColumnCount(Math.max(MEASUREMENT_TABLE_MIN_COLUMNS, Math.ceil(availableWidth / MEASUREMENT_TABLE_POSITION_WIDTH)));
    };

    updateViewportColumns();
    const observer = new ResizeObserver(updateViewportColumns);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function getAreaLabel(area: MeasurementMatrixAreaRow): string {
    return areaLabelDraftsRef.current[area.key] ?? area.label;
  }

  function updateAreaLabelDraft(areaKey: string, value: string): void {
    areaLabelDraftsRef.current[areaKey] = value;
  }

  function clearAreaLabelDraft(areaKey: string): void {
    if (areaLabelDraftsRef.current[areaKey] === undefined) {
      return;
    }
    delete areaLabelDraftsRef.current[areaKey];
    setAreaDraftVersion((version) => version + 1);
  }

  function getManualColumnDraft(columnKey: string): MeasurementManualColumnDraft {
    return manualColumnDrafts[columnKey] ?? { position: "", description: "", unit: "", linkedItemId: null };
  }

  function getManualColumnItem(columnKey: string): MobileMeasurementItem | null {
    const linkedItemId = manualColumnDrafts[columnKey]?.linkedItemId;
    if (!linkedItemId || actualItemIds.has(linkedItemId)) {
      return null;
    }
    return positionSuggestions.find((item) => item.id === linkedItemId) ?? null;
  }

  function updateManualColumnDraft(columnKey: string, patch: Partial<MeasurementManualColumnDraft>): void {
    setManualColumnDrafts((current) => ({
      ...current,
      [columnKey]: {
        position: current[columnKey]?.position ?? "",
        description: current[columnKey]?.description ?? "",
        unit: current[columnKey]?.unit ?? "",
        linkedItemId: current[columnKey]?.linkedItemId ?? null,
        ...patch,
      },
    }));
  }

  function selectPositionSuggestion(columnKey: string, item: MobileMeasurementItem): void {
    updateManualColumnDraft(columnKey, {
      position: item.position,
      description: item.description,
      unit: normalizeMeasurementUnitDisplay(item.unit),
      linkedItemId: item.id,
    });
    setSuggestionState(null);
  }

  function updateManualColumnTotal(columnKey: string): void {
    const node = tableWrapRef.current;
    if (!node) {
      return;
    }
    const inputs = node.querySelectorAll<HTMLInputElement>(`input[data-manual-column="${columnKey}"]`);
    let total = 0;
    inputs.forEach((input) => {
      const quantity = parseMeasurementQuantityInput(input.value);
      if (quantity !== null) {
        total += quantity;
      }
    });
    setManualColumnTotals((current) => ({ ...current, [columnKey]: total }));
  }

  function getCellEntries(item: MobileMeasurementItem, areaKey: string): MobileMeasurementItem["entries"] {
    return entryGroups.get(`${item.id}:${areaKey}`) ?? [];
  }

  async function saveNewCellDraft(
    item: MobileMeasurementItem,
    area: MeasurementMatrixAreaRow,
    input: HTMLInputElement,
    sourceColumnKey?: string,
  ): Promise<void> {
    const value = input.value;
    const quantity = parseMeasurementQuantityInput(value);
    const areaLabel = getAreaLabel(area).trim();
    if (value.trim() === "") {
      return;
    }
    if (!areaLabel || quantity === null || quantity <= 0) {
      input.value = "";
      return;
    }

    const cellKey = `${area.key}-${item.id}`;
    if (savingCellKeysRef.current.has(cellKey)) {
      return;
    }
    savingCellKeysRef.current.add(cellKey);
    try {
      await onCellCreate(item, areaLabel, quantity);
      input.value = "";
      if (area.key.startsWith("placeholder-area-")) {
        clearAreaLabelDraft(area.key);
      }
      if (sourceColumnKey) {
        setManualColumnDrafts((current) => {
          const next = { ...current };
          delete next[sourceColumnKey];
          return next;
        });
        setManualColumnTotals((current) => {
          const next = { ...current };
          delete next[sourceColumnKey];
          return next;
        });
      }
    } finally {
      savingCellKeysRef.current.delete(cellKey);
    }
  }

  function saveExistingQuantityDraft(entry: MobileMeasurementItem["entries"][number], input: HTMLInputElement): void {
    onDraftSave(entry, {
      area_or_comment: entry.area_or_comment,
      quantity: input.value,
    });
  }

  return (
    <div className="measurement-table-surface measurement-review-table-wrap" ref={tableWrapRef} role="region" aria-label="Tabellarische Aufmaßaufstellung">
      <table className="measurement-table-view measurement-matrix-table measurement-review-table" style={tableStyle}>
        <colgroup>
          <col className="measurement-matrix-label-col" />
          {displayColumns.map((column) => (
            <col className="measurement-matrix-position-col" key={column.key} />
          ))}
        </colgroup>
        <thead>
          <tr className="measurement-matrix-meta-row measurement-matrix-position-row">
            <th className="measurement-matrix-axis" scope="row">Pos.-Nr.</th>
            {displayColumns.map((column) => {
              if (column.kind === "item") {
                return (
              <th className="measurement-matrix-position-heading" key={column.key} scope="col">
                <strong>{column.item.position}</strong>
              </th>
                );
              }
              const draft = getManualColumnDraft(column.key);
              const isSuggestionOpen = suggestionState?.columnKey === column.key && suggestionMatches.length > 0;
              return (
              <th className="measurement-matrix-position-heading measurement-matrix-placeholder-heading" key={column.key} scope="col">
                <input
                  className="measurement-placeholder-header-input"
                  value={draft.position}
                  aria-label={`Manuelle Pos.-Nr. Spalte ${column.index}`}
                  placeholder="Pos."
                  autoComplete="off"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    updateManualColumnDraft(column.key, { position: value, linkedItemId: null });
                    setSuggestionState({ columnKey: column.key, query: value, activeIndex: 0 });
                  }}
                  onFocus={(event) => {
                    if (event.currentTarget.value.trim()) {
                      setSuggestionState({ columnKey: column.key, query: event.currentTarget.value, activeIndex: 0 });
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && suggestionMatches.length > 0) {
                      event.preventDefault();
                      setSuggestionState((current) => current?.columnKey === column.key
                        ? { ...current, activeIndex: Math.min(current.activeIndex + 1, suggestionMatches.length - 1) }
                        : current);
                    }
                    if (event.key === "ArrowUp" && suggestionMatches.length > 0) {
                      event.preventDefault();
                      setSuggestionState((current) => current?.columnKey === column.key
                        ? { ...current, activeIndex: Math.max(current.activeIndex - 1, 0) }
                        : current);
                    }
                    if (event.key === "Enter" && suggestionState?.columnKey === column.key && suggestionMatches.length > 0) {
                      event.preventDefault();
                      selectPositionSuggestion(column.key, suggestionMatches[suggestionState.activeIndex] ?? suggestionMatches[0]);
                    }
                    if (event.key === "Escape") {
                      setSuggestionState(null);
                    }
                  }}
                />
                {isSuggestionOpen ? (
                  <div className="measurement-position-suggestions" role="listbox">
                    {suggestionMatches.map((item, index) => (
                      <button
                        className={index === suggestionState.activeIndex ? "is-active" : ""}
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={index === suggestionState.activeIndex}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          selectPositionSuggestion(column.key, item);
                        }}
                      >
                        <strong>{item.position}</strong>
                        <span>{item.description}</span>
                        <small>{normalizeMeasurementUnitDisplay(item.unit)}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </th>
              );
            })}
          </tr>
          <tr className="measurement-matrix-meta-row measurement-matrix-description-row">
            <th className="measurement-matrix-axis" scope="row">Beschreibung</th>
            {displayColumns.map((column) => column.kind === "item" ? (
              <th className="measurement-matrix-description-heading" key={column.key} scope="col" title={column.item.description}><span>{column.item.description}</span></th>
            ) : (
              <th className="measurement-matrix-description-heading measurement-matrix-placeholder-heading" key={column.key} scope="col">
                <textarea
                  className="measurement-placeholder-header-input is-description"
                  value={getManualColumnDraft(column.key).description}
                  aria-label={`Manuelle Beschreibung Spalte ${column.index}`}
                  placeholder="Beschreibung"
                  rows={2}
                  onChange={(event) => updateManualColumnDraft(column.key, { description: event.currentTarget.value })}
                />
              </th>
            ))}
          </tr>
          <tr className="measurement-matrix-meta-row measurement-matrix-unit-row">
            <th className="measurement-matrix-axis" scope="row">Einheit</th>
            {displayColumns.map((column) => column.kind === "item" ? (
              <th className="measurement-matrix-unit-heading" key={column.key} scope="col">{normalizeMeasurementUnitDisplay(column.item.unit) || "-"}</th>
            ) : (
              <th className="measurement-matrix-unit-heading measurement-matrix-placeholder-heading" key={column.key} scope="col">
                <input
                  className="measurement-placeholder-header-input"
                  value={getManualColumnDraft(column.key).unit}
                  aria-label={`Manuelle Einheit Spalte ${column.index}`}
                  placeholder="Einheit"
                  onChange={(event) => updateManualColumnDraft(column.key, { unit: event.currentTarget.value })}
                  onBlur={(event) => updateManualColumnDraft(column.key, { unit: normalizeMeasurementUnitDisplay(event.currentTarget.value) })}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="measurement-matrix-section-row">
            <th className="measurement-matrix-axis" scope="row">Bauteil / Ort</th>
            {displayColumns.map((column) => <td className={column.kind === "placeholder" ? "measurement-matrix-placeholder-cell" : undefined} key={column.key} />)}
          </tr>
          {displayAreaRows.map((area) => {
            const areaLabel = getAreaLabel(area);
            return (
            <tr key={area.key}>
              <th className={`measurement-matrix-axis measurement-matrix-area-axis${area.isPlaceholder ? " is-placeholder-row" : ""}`} scope="row">
                <input
                  key={`${area.key}-${areaDraftVersion}`}
                  className="measurement-area-input"
                  defaultValue={areaLabel}
                  disabled={!canEditRows || reviewActionLoading}
                  placeholder={area.isPlaceholder ? "Bereich / Ort" : undefined}
                  aria-label="Bauteil oder Ort"
                  onInput={(event) => updateAreaLabelDraft(area.key, event.currentTarget.value)}
                />
              </th>
              {displayColumns.map((column) => {
                if (column.kind === "placeholder") {
                  const manualItem = getManualColumnItem(column.key);
                  const manualDraft = getManualColumnDraft(column.key);
                  const isManualColumnActive = Boolean(
                    manualItem
                    || manualDraft.position.trim()
                    || manualDraft.description.trim()
                    || manualDraft.unit.trim(),
                  );
                  if (manualItem) {
                    return (
                      <td className="measurement-matrix-empty-cell is-manual-column" key={column.key}>
                        <input
                          className="measurement-table-input is-quantity"
                          data-manual-column={column.key}
                          disabled={!canEditRows || reviewActionLoading}
                          inputMode="decimal"
                          aria-label={`Neue Menge ${areaLabel || "ohne Bereich"} für ${manualItem.position}`}
                          onInput={() => updateManualColumnTotal(column.key)}
                          onBlur={(event) => {
                            updateManualColumnTotal(column.key);
                            void saveNewCellDraft(manualItem, area, event.currentTarget, column.key);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              updateManualColumnTotal(column.key);
                              void saveNewCellDraft(manualItem, area, event.currentTarget, column.key);
                            }
                            if (event.key === "Escape") {
                              event.currentTarget.value = "";
                              updateManualColumnTotal(column.key);
                            }
                          }}
                        />
                      </td>
                    );
                  }
                  return (
                    <td className={`measurement-matrix-empty-cell${isManualColumnActive ? " is-manual-column" : " measurement-matrix-placeholder-cell"}`} key={column.key}>
                      <input
                        className="measurement-table-input is-quantity"
                        data-manual-column={column.key}
                        disabled={!canEditRows || reviewActionLoading}
                        inputMode="decimal"
                        aria-label={`Vorbereitete Menge ${areaLabel || "ohne Bereich"} in manueller Positionsspalte`}
                        title="Diese manuelle Spalte ist lokal vorbereitet. Dauerhaft gespeichert wird sie erst nach Auswahl einer vorhandenen Position."
                        onInput={() => updateManualColumnTotal(column.key)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.currentTarget.value = "";
                            updateManualColumnTotal(column.key);
                          }
                        }}
                      />
                    </td>
                  );
                }
                const item = column.item;
                const entries = getCellEntries(item, area.key);
                if (entries.length === 0) {
                  return (
                    <td className="measurement-matrix-empty-cell" key={column.key}>
                      <input
                        className="measurement-table-input is-quantity"
                        disabled={!canEditRows || reviewActionLoading}
                        inputMode="decimal"
                        aria-label={`Neue Menge ${areaLabel || "ohne Bereich"} für ${item.position}`}
                        onBlur={(event) => void saveNewCellDraft(item, area, event.currentTarget)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void saveNewCellDraft(item, area, event.currentTarget);
                          }
                          if (event.key === "Escape") {
                            event.currentTarget.value = "";
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
                const displayedQuantity = formatMeasurementDraftQuantity(entry.quantity);
                const isSaving = savingEntryId === entry.id;
                return (
                  <td className="measurement-matrix-quantity-cell" key={column.key}>
                    <input
                      key={`${entry.id}-${entry.updated_at}-${entry.quantity}`}
                      className="measurement-table-input is-quantity"
                      defaultValue={displayedQuantity}
                      disabled={!canEditRows || reviewActionLoading || isSaving}
                      inputMode="decimal"
                      aria-label={`Menge ${areaLabel || "ohne Bereich"} für ${item.position}`}
                      onBlur={(event) => saveExistingQuantityDraft(entry, event.currentTarget)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          saveExistingQuantityDraft(entry, event.currentTarget);
                        }
                        if (event.key === "Escape") {
                          event.currentTarget.value = displayedQuantity;
                          onDraftReset(entry);
                        }
                      }}
                    />
                  </td>
                );
              })}
            </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="measurement-matrix-total-row">
            <th className="measurement-matrix-axis" scope="row">Gesamt</th>
            {displayColumns.map((column) => column.kind === "item" ? (
              <td className="measurement-matrix-quantity-cell" key={column.key}>
                <strong>{formatMeasurementNumber(totalsByItemId.get(column.item.id) ?? 0)}</strong>
              </td>
            ) : (
              <td className="measurement-matrix-quantity-cell measurement-matrix-placeholder-cell" key={column.key}>
                <strong>{(manualColumnTotals[column.key] ?? 0) > 0 ? formatMeasurementNumber(manualColumnTotals[column.key] ?? 0) : ""}</strong>
              </td>
            ))}
          </tr>
        </tfoot>
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

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function getSuggestedMeasurementSheetName(siteNumber: string | null, nextNumber: number): string {
  const cleanSiteNumber = siteNumber?.trim();
  if (cleanSiteNumber) {
    return `Aufmaß ${cleanSiteNumber}.${String(nextNumber).padStart(2, "0")}`;
  }
  return `Aufmaßblatt ${new Date().toISOString().slice(0, 10)}`;
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

function isMeasurementBatchPdfExportable(status: string): boolean {
  return isMeasurementBatchBilled(status);
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

function getMeasurementNumericValue(value: string | number | null): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const normalizedValue = typeof value === "number"
    ? value
    : Number(String(value).includes(",") ? String(value).replace(/\./g, "").replace(",", ".") : value);
  return Number.isFinite(normalizedValue) ? normalizedValue : 0;
}

function formatMeasurementDuration(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const absoluteMinutes = Math.abs(minutes);
  if (absoluteMinutes >= 60) {
    const roundedMinutes = Math.round(absoluteMinutes);
    const hours = Math.floor(roundedMinutes / 60);
    const restMinutes = roundedMinutes % 60;
    return `${sign}${hours} Std. ${restMinutes} Min.`;
  }
  return `${sign}${formatMeasurementNumber(absoluteMinutes)} min`;
}

function formatMeasurementPercent(value: number): string {
  return `${new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value)} %`;
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

function clampProgressPercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(value, 100);
}

function getCurrentGermanWeekRange(referenceDate = new Date()): { start: string; end: string } {
  const start = new Date(referenceDate);
  const day = start.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + diffToMonday);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  return {
    start: toLocalDateKey(start),
    end: toLocalDateKey(end),
  };
}

function getWeeklyWorkerHeadCount(assignments: AssignmentRead[], weekStart: string, weekEnd: string): number {
  const weekDays = getDateKeysBetween(weekStart, weekEnd);
  const peopleByDay = new Map(weekDays.map((day) => [day, new Set<number>()]));

  for (const assignment of assignments) {
    const assignmentDays = getDateKeysBetween(
      assignment.start_date > weekStart ? assignment.start_date : weekStart,
      assignment.end_date < weekEnd ? assignment.end_date : weekEnd,
    );
    for (const day of assignmentDays) {
      peopleByDay.get(day)?.add(assignment.person_id);
    }
  }

  return Math.min(
    Math.max(...Array.from(peopleByDay.values(), (people) => people.size), 0),
    5,
  );
}

function getDateKeysBetween(startKey: string, endKey: string): string[] {
  const start = parseLocalDateKey(startKey);
  const end = parseLocalDateKey(endKey);
  if (!start || !end || end < start) {
    return [];
  }

  const days: string[] = [];
  for (const current = new Date(start); current <= end; current.setDate(current.getDate() + 1)) {
    days.push(toLocalDateKey(current));
  }
  return days;
}

function parseLocalDateKey(value: string): Date | null {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(year, month - 1, day);
}

function toLocalDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
