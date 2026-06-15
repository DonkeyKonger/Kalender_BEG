import { ArrowLeft, Building2, CalendarClock, Download, ExternalLink, File as FileIcon, FileImage, FileSpreadsheet, FileText, Flag, Folder, Mail, MapPin, Pencil, Phone, Ruler, Search, UploadCloud, UserRound, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { SiteStatusBadge, StatusBadge, type StatusBadgeTone, siteStatusLabels } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import {
  formatGermanDateKey as formatDateOnly,
  formatGermanDateKeyRange as formatDateRange,
  formatGermanDateTimeShort as formatDateTime,
} from "../lib/formatters";
import { formatProjectDocumentMeta, getProjectDocumentKind } from "../lib/projectFiles";
import type { AssignmentRead } from "../types/matrix";
import type { Person } from "../types/person";
import type { MeasurementBase, MeasurementBaseUpdate, MeasurementEntry, MeasurementImportOptions, MeasurementTimeAnalysis, MeasurementTimesheet, MobileExtraWorkTicket, MobileMeasurementBatch, MobileMeasurementItem, ProjectFolder, ProjectFolderDocumentItem, ProjectFolderDocumentList, Site, SiteCreate, SiteUpdate } from "../types/site";
import type { TimeEntry, TimeEntryStatus } from "../types/timeEntry";
import { SiteFields, normalizeSitePayload, toEditableSite, validateSitePayload } from "./SitesPage";
import type { EditableSite } from "./SitesPage";

type ProjectRecordTab = "overview" | "folders" | "assembly-times" | "measurement" | "extra-work" | "tools-material";
type MeasurementSubtab = "timesheet" | "review" | "time-analysis" | "bases";
type MeasurementPdfMode = "checked" | "original";
type MeasurementTimesheetFilter = "all" | "billed" | "unbilled";
type SiteWorkTimeRangeMode = "week" | "month";
type SiteWorkTimeBalanceStatus = "missing" | "within" | "near_limit" | "over";
type ProjectFolderNavigationLevel = {
  itemId: string;
  name: string;
  documents: ProjectFolderDocumentList;
};

const MEASUREMENT_TABLE_AXIS_WIDTH = 216;
const MEASUREMENT_TABLE_POSITION_WIDTH = 134;
const MEASUREMENT_TABLE_MIN_COLUMNS = 12;
const MEASUREMENT_TABLE_MIN_AREA_ROWS = 12;
const MEASUREMENT_TIMESHEET_ROW_HEIGHT = 56;
const MEASUREMENT_TIMESHEET_OVERSCAN_ROWS = 10;
const MEASUREMENT_TIMESHEET_DEFAULT_VIEWPORT_HEIGHT = 560;

const measurementSubtabs: { key: MeasurementSubtab; label: string }[] = [
  { key: "timesheet", label: "Ausführungsstand" },
  { key: "review", label: "Prüfung" },
  { key: "time-analysis", label: "Zeitauswertung" },
  { key: "bases", label: "Zeitenlisten" },
];

const projectRecordTabs: { key: ProjectRecordTab; label: string }[] = [
  { key: "overview", label: "Übersicht" },
  { key: "folders", label: "Projektdateien" },
  { key: "assembly-times", label: "Montagezeiten" },
  { key: "measurement", label: "Aufmaß" },
  { key: "extra-work", label: "Zusatzaufträge" },
  { key: "tools-material", label: "Werkzeuge & Material" },
];

const timeEntryStatusLabels: Record<TimeEntryStatus, string> = {
  draft: "Entwurf",
  submitted: "Gemeldet",
  reviewed: "Geprüft",
};

export function SiteDetailPage() {
  const { user } = useAuth();
  const canEditSite = user?.role === "admin" || user?.role === "project_manager";
  const canOpenSharePointDirectly = user?.role === "admin" || user?.role === "project_manager" || user?.role === "office";
  const { siteId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const siteDetailReturnTo = (location.state as { returnTo?: string } | null)?.returnTo;
  const siteDetailBackPath = siteDetailReturnTo === "matrix" ? "/matrix" : "/sites";
  const requestedProjectTab = searchParams.get("tab");
  const requestedMeasurementSubtab = searchParams.get("measurementSubtab");
  const [site, setSite] = useState<Site | null>(null);
  const [siteDraft, setSiteDraft] = useState<EditableSite | null>(null);
  const [projectManagerPeople, setProjectManagerPeople] = useState<Person[]>([]);
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
  const [measurementTimesheet, setMeasurementTimesheet] = useState<MeasurementTimesheet | null>(null);
  const [measurementTimeAnalysis, setMeasurementTimeAnalysis] = useState<MeasurementTimeAnalysis | null>(null);
  const [measurementTimeAnalysisLoading, setMeasurementTimeAnalysisLoading] = useState(false);
  const [measurementTimeAnalysisLoaded, setMeasurementTimeAnalysisLoaded] = useState(false);
  const [measurementTimeAnalysisError, setMeasurementTimeAnalysisError] = useState<string | null>(null);
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
  const [measurementWorkerHeadCount, setMeasurementWorkerHeadCount] = useState(0);
  const [measurementBatchItemsLoading, setMeasurementBatchItemsLoading] = useState(false);
  const [measurementReviewMessage, setMeasurementReviewMessage] = useState<string | null>(null);
  const [measurementReviewError, setMeasurementReviewError] = useState<string | null>(null);
  const [measurementReviewActionLoading, setMeasurementReviewActionLoading] = useState(false);
  const [extraWorkTickets, setExtraWorkTickets] = useState<MobileExtraWorkTicket[]>([]);
  const [extraWorkLoading, setExtraWorkLoading] = useState(false);
  const [extraWorkLoaded, setExtraWorkLoaded] = useState(false);
  const [extraWorkError, setExtraWorkError] = useState<string | null>(null);
  const [extraWorkPdfAction, setExtraWorkPdfAction] = useState<string | null>(null);

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
      .siteProjectManagers()
      .then((personData) => {
        if (isCurrent) {
          setProjectManagerPeople(personData);
        }
      })
      .catch(() => {
        if (isCurrent) {
          setProjectManagerPeople([]);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [canEditSite]);

  useEffect(() => {
    setActiveTab(requestedProjectTab === "measurement" ? "measurement" : "overview");
    setMeasurementSubtab(
      measurementSubtabs.some((tab) => tab.key === requestedMeasurementSubtab)
        ? requestedMeasurementSubtab as MeasurementSubtab
        : "timesheet",
    );
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
    setMeasurementTimesheet(null);
    setMeasurementTimeAnalysis(null);
    setMeasurementTimeAnalysisLoading(false);
    setMeasurementTimeAnalysisLoaded(false);
    setMeasurementTimeAnalysisError(null);
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
    setMeasurementWorkerHeadCount(0);
    setMeasurementBatchItemsLoading(false);
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    setMeasurementReviewActionLoading(false);
    setExtraWorkTickets([]);
    setExtraWorkLoading(false);
    setExtraWorkLoaded(false);
    setExtraWorkError(null);
    setExtraWorkPdfAction(null);
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
        const loadedFolders = await api.projectFolders(site.id);
        setFolders(loadedFolders);
        setSelectedFolder((currentFolder) => {
          if (currentFolder && loadedFolders.some((folder) => folder.id === currentFolder.id)) {
            return currentFolder;
          }
          return loadedFolders[0] ?? null;
        });
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
      const loadStartedAt = startMeasurementTimesheetPerformanceTiming();
      setMeasurementLoading(true);
      setMeasurementError(null);
      setMeasurementBatchesError(null);
      try {
        const initialRequestsStartedAt = startMeasurementTimesheetPerformanceTiming();
        const [bases, timesheet] = await Promise.all([
          api.measurementBases(site.id),
          api.measurementTimesheet(site.id),
        ]);
        logMeasurementTimesheetPerformance("API Zeitenliste aggregiert", initialRequestsStartedAt, {
          bases: bases.length,
          activeBatches: timesheet.active_batch_ids.length,
          rows: timesheet.rows.length,
        });
        setMeasurementBases(bases);
        setMeasurementTimesheet(timesheet);
        setMeasurementLoaded(true);
        logMeasurementTimesheetPerformance("Erstladen gesamt", loadStartedAt, {
          activeBatches: timesheet.active_batch_ids.length,
          rows: timesheet.rows.length,
        });
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

  useEffect(() => {
    if (
      !site
      || activeTab !== "measurement"
      || measurementSubtab !== "time-analysis"
      || measurementTimeAnalysisLoaded
      || measurementTimeAnalysisLoading
    ) {
      return;
    }

    async function loadMeasurementTimeAnalysis() {
      if (!site) {
        return;
      }
      setMeasurementTimeAnalysisLoading(true);
      setMeasurementTimeAnalysisError(null);
      try {
        setMeasurementTimeAnalysis(await api.measurementTimeAnalysis(site.id));
        setMeasurementTimeAnalysisLoaded(true);
      } catch (requestError) {
        setMeasurementTimeAnalysisError(readApiError(requestError, "Zeitauswertung konnte nicht geladen werden."));
      } finally {
        setMeasurementTimeAnalysisLoading(false);
      }
    }

    void loadMeasurementTimeAnalysis();
  }, [
    activeTab,
    measurementSubtab,
    measurementTimeAnalysisLoaded,
    measurementTimeAnalysisLoading,
    site,
  ]);

  useEffect(() => {
    if (!site || activeTab !== "extra-work" || extraWorkLoaded || extraWorkLoading) {
      return;
    }

    void loadExtraWorkTickets();
  }, [activeTab, extraWorkLoaded, extraWorkLoading, site]);

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

  async function loadExtraWorkTickets(): Promise<void> {
    if (!site) {
      return;
    }
    setExtraWorkLoading(true);
    setExtraWorkError(null);
    try {
      setExtraWorkTickets(await api.siteExtraWorkTickets(site.id));
      setExtraWorkLoaded(true);
    } catch (requestError) {
      setExtraWorkError(readApiError(requestError, "Zusatzaufträge konnten nicht geladen werden."));
    } finally {
      setExtraWorkLoading(false);
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
          ? `${batch.title} wurde abgeschlossen.`
          : `${batch.title} wurde wieder als eingereicht markiert.`,
      );
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Abschlussstatus konnte nicht gespeichert werden."));
    } finally {
      setMeasurementReviewActionLoading(false);
    }
  }

  async function markMeasurementBatchReviewed(batch: MobileMeasurementBatch): Promise<void> {
    if (!site || measurementReviewActionLoading) {
      return;
    }
    setMeasurementReviewActionLoading(true);
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      const updated = await api.markSiteMeasurementBatchReviewed(site.id, batch.id);
      setMeasurementBatches((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setSelectedMeasurementBatch(updated);
      setMeasurementBatchItems(await api.siteMeasurementBatchItems(site.id, batch.id));
      setMeasurementReviewMessage(`${batch.title} wurde als geprüft markiert.`);
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Prüfstatus konnte nicht gespeichert werden."));
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

  async function handleExtraWorkTicketPdf(ticket: MobileExtraWorkTicket, mode: "open" | "download"): Promise<void> {
    if (!site || extraWorkPdfAction) {
      return;
    }
    const actionKey = `${ticket.id}:${mode}`;
    const openedWindow = mode === "open" ? window.open("about:blank", "_blank", "noopener,noreferrer") : null;
    setExtraWorkPdfAction(actionKey);
    setExtraWorkError(null);
    try {
      const blob = await api.downloadSiteExtraWorkTicketPdf(site.id, ticket.id);
      if (mode === "open") {
        openBlobInNewTab(blob, openedWindow);
      } else {
        triggerBrowserDownload(blob, formatExtraWorkTicketPdfFilename(site, ticket));
      }
    } catch (requestError) {
      if (openedWindow) {
        openedWindow.close();
      }
      setExtraWorkError(readApiError(requestError, "Zusatzauftrag-PDF konnte nicht erstellt werden."));
    } finally {
      setExtraWorkPdfAction(null);
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
      const timesheet = await api.measurementTimesheet(site.id);
      setMeasurementBases(bases);
      setMeasurementTimesheet(timesheet);
      setMeasurementBatches([]);
      setMeasurementLoaded(true);
      setMeasurementBatchesLoaded(false);
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
      "Angebot wirklich löschen?\n\nImportierte Positionen dieses Angebots werden entfernt. Bereits erfasste oder abgeschlossene Aufmaße dürfen nicht gelöscht werden.",
    );
    if (!confirmed) {
      return;
    }
    setMeasurementImportMessage(null);
    setMeasurementImportError(null);
    try {
      const bases = await api.deleteMeasurementBase(site.id, base.id);
      const timesheet = await api.measurementTimesheet(site.id);
      setMeasurementBases(bases);
      setMeasurementTimesheet(timesheet);
      setMeasurementBatches([]);
      setMeasurementBatchesLoaded(false);
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
      const [bases, timesheet] = await Promise.all([
        api.measurementBases(site.id),
        api.measurementTimesheet(site.id),
      ]);
      setMeasurementBases(bases);
      setMeasurementTimesheet(timesheet);
      setMeasurementBatches([]);
      setMeasurementLoaded(true);
      setMeasurementBatchesLoaded(false);
      setFoldersLoaded(false);
      setFolderDocumentsReloadKey((currentKey) => currentKey + 1);
      if (result.timesheet_document_saved) {
        setMeasurementImportMessage(
          `Zeitenliste importiert und unter 9. Dokumentation gespeichert: ${result.imported_count} Positionen in ${formatMeasurementBaseName(result.measurement_base)} erkannt.`,
        );
      } else {
        setMeasurementImportMessage(
          "Zeitenliste importiert. Speicherung unter 9. Dokumentation fehlgeschlagen.",
        );
      }
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

  async function saveSiteInline(values: SiteUpdate): Promise<void> {
    if (!site || !canEditSite) {
      return;
    }
    const updated = await api.updateSite(site.id, values);
    setSite(updated);
    setSiteDraft(toEditableSite(updated));
  }

  async function saveSiteNotes(info: string | null): Promise<void> {
    await saveSiteInline({ info });
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
      <Link className="back-link" to={siteDetailBackPath}>
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
        <div className="site-detail-header-actions">
          <SiteStatusBadge status={site.status} />
        </div>
      </div>

      <ProjectRecordTabs activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === "overview" ? (
        <OverviewTab
          site={site}
          draft={siteDraft}
          people={projectManagerPeople}
          editMode={editMode}
          canEdit={canEditSite}
          isSaving={isSavingSite}
          isCheckingLocation={isCheckingSiteLocation}
          saveError={siteSaveError}
          saveMessage={siteSaveMessage}
          onCancelEdit={cancelSiteEdit}
          onDraftChange={updateSiteDraft}
          onSave={() => void saveSiteDetails()}
          onSaveField={saveSiteInline}
          onSaveNotes={saveSiteNotes}
          onCheckLocation={() => void checkSiteLocation()}
          onGeocodeSelected={(values) => void applyGeocodedSite(values)}
        />
      ) : null}
      {activeTab === "folders" ? (
        <ProjectFoldersPanel
          site={site}
          canOpenSharePointDirectly={canOpenSharePointDirectly}
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
        <SiteWorkTimesPanel site={site} canEdit={canEditSite} onSiteUpdated={setSite} />
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
          timesheet={measurementTimesheet}
          timeAnalysis={measurementTimeAnalysis}
          timeAnalysisLoading={measurementTimeAnalysisLoading}
          timeAnalysisError={measurementTimeAnalysisError}
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
            setMeasurementTimesheet(null);
            setMeasurementError(null);
          }}
          onRetryTimeAnalysis={() => {
            setMeasurementTimeAnalysisLoaded(false);
            setMeasurementTimeAnalysis(null);
            setMeasurementTimeAnalysisError(null);
          }}
          batches={measurementBatches}
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
          onMarkReviewed={(batch) => void markMeasurementBatchReviewed(batch)}
          onUpdateEntry={updateMeasurementEntry}
          onCreateEntry={createMeasurementEntry}
          onResetToSubmitted={resetMeasurementBatchToSubmitted}
          onExportPdf={downloadMeasurementBatchPdf}
        />
      ) : null}
      {activeTab === "extra-work" ? (
        <ExtraWorkTab
          site={site}
          tickets={extraWorkTickets}
          isLoading={extraWorkLoading}
          error={extraWorkError}
          pdfAction={extraWorkPdfAction}
          onRetry={() => {
            setExtraWorkLoaded(false);
            setExtraWorkError(null);
          }}
          onOpenPdf={(ticket) => void handleExtraWorkTicketPdf(ticket, "open")}
          onDownloadPdf={(ticket) => void handleExtraWorkTicketPdf(ticket, "download")}
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
  onCancelEdit,
  onDraftChange,
  onSave,
  onSaveField,
  onSaveNotes,
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
  onCancelEdit: () => void;
  onDraftChange: (values: Partial<SiteCreate>) => void;
  onSave: () => void;
  onSaveField: (values: SiteUpdate) => Promise<void>;
  onSaveNotes: (info: string | null) => Promise<void>;
  onCheckLocation: () => void;
  onGeocodeSelected: (values: Partial<SiteCreate>) => void;
}) {
  const [notesDraft, setNotesDraft] = useState(site.info ?? "");
  const [notesSaveStatus, setNotesSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const externalNotesRef = useRef(site.info ?? "");

  useEffect(() => {
    const nextInfo = site.info ?? "";
    setNotesDraft((currentDraft) => (
      currentDraft === externalNotesRef.current ? nextInfo : currentDraft
    ));
    externalNotesRef.current = nextInfo;
  }, [site.id, site.info]);

  useEffect(() => {
    setNotesSaveStatus("idle");
  }, [site.id]);

  const persistNotes = useCallback(async (value: string): Promise<void> => {
    if (!canEdit) {
      return;
    }
    const normalizedInfo = normalizeSiteNotesInput(value);
    const normalizedCurrent = normalizeSiteNotesInput(site.info ?? "");
    if (normalizedInfo === normalizedCurrent) {
      return;
    }
    setNotesSaveStatus("saving");
    try {
      await onSaveNotes(normalizedInfo);
      externalNotesRef.current = normalizedInfo ?? "";
      setNotesSaveStatus("saved");
    } catch {
      setNotesSaveStatus("error");
    }
  }, [canEdit, onSaveNotes, site.info]);

  useEffect(() => {
    if (!canEdit || editMode) {
      return;
    }
    if (normalizeSiteNotesInput(notesDraft) === normalizeSiteNotesInput(site.info ?? "")) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void persistNotes(notesDraft);
    }, 1000);
    return () => window.clearTimeout(timeoutId);
  }, [canEdit, editMode, notesDraft, persistNotes, site.info]);

  function handleNotesBlur(): void {
    if (!canEdit || editMode) {
      return;
    }
    void persistNotes(notesDraft);
  }

  const projectManagerOptions = getProjectManagerInlineOptions(people, site.project_manager);

  return (
    <div className="project-record-tab-panel">
      {saveError ? <p className="form-error">{saveError}</p> : null}
      {saveMessage ? <p className="form-info">{saveMessage}</p> : null}

      {editMode && draft ? (
        <div className="project-record-edit-panel">
          <SiteFields
            draft={draft}
            people={people}
            currentProjectManager={site.project_manager}
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
              <InlineEditableDetailItem
                label="Baustellennummer"
                value={site.site_number}
                canEdit={canEdit}
                required
                emptyMessage="Baustellennummer darf nicht leer sein."
                onSave={(value) => onSaveField({ site_number: value })}
              />
              <InlineEditableDetailItem
                label="Kunde"
                value={site.customer}
                canEdit={canEdit}
                onSave={(value) => onSaveField({ customer: value })}
              />
              <InlineEditableSelectItem
                label="Status"
                value={site.status}
                displayValue={siteStatusLabels[site.status]}
                canEdit={canEdit}
                options={Object.entries(siteStatusLabels).map(([value, label]) => ({ value, label }))}
                onSave={(value) => onSaveField({ status: value as Site["status"] })}
              />
              <DetailItem label="Aktualisiert" value={formatDateTime(site.updated_at)} />
            </DetailSection>

            <DetailSection title="Adresse / Standort" icon={MapPin}>
              <InlineEditableDetailItem
                label="Ort"
                value={site.location}
                canEdit={canEdit}
                onSave={(value) => onSaveField({ location: value })}
              />
              <InlineEditablePairItem
                label="PLZ / Stadt"
                firstValue={site.postal_code}
                secondValue={site.city}
                firstPlaceholder="PLZ"
                secondPlaceholder="Stadt"
                displayValue={[site.postal_code, site.city].filter(Boolean).join(" ")}
                canEdit={canEdit}
                onSave={(postalCode, city) => onSaveField({ postal_code: postalCode, city })}
              />
              <InlineEditablePairItem
                label="Strasse"
                firstValue={site.street}
                secondValue={site.house_number}
                firstPlaceholder="Strasse"
                secondPlaceholder="Hausnummer"
                displayValue={[site.street, site.house_number].filter(Boolean).join(" ")}
                canEdit={canEdit}
                onSave={(street, houseNumber) => onSaveField({ street, house_number: houseNumber })}
              />
              <InlineEditableDetailItem
                label="Adresszusatz"
                value={site.address_extra || site.address}
                canEdit={canEdit}
                onSave={(value) => onSaveField({ address_extra: value })}
              />
            </DetailSection>

            <DetailSection title="Projektleiter" icon={UserRound}>
              <InlineEditableSelectItem
                label="Name"
                value={site.project_manager_person_id !== null ? String(site.project_manager_person_id) : ""}
                displayValue={site.project_manager?.display_name}
                canEdit={canEdit}
                options={projectManagerOptions}
                onSave={(value) => onSaveField({ project_manager_person_id: value ? Number(value) : null })}
              />
              <DetailItem label="Kuerzel" value={site.project_manager?.short_code} />
              <DetailItem label="Telefon" value={site.project_manager?.phone} icon={Phone} />
            </DetailSection>

            <DetailSection title="Planstatus" icon={CalendarClock}>
              <DetailItem label="Angelegt" value={formatDateTime(site.created_at)} />
              <DetailItem label="Geschlossen" value={site.closed_at ? formatDateTime(site.closed_at) : null} />
            </DetailSection>
          </div>

          <section className="site-notes-section">
            <div className="site-notes-header">
              <h2>Notizen</h2>
              {canEdit && notesSaveStatus !== "idle" ? (
                <span className={`site-notes-save-status is-${notesSaveStatus}`}>{formatSiteNotesSaveStatus(notesSaveStatus)}</span>
              ) : null}
            </div>
            <textarea
              className="site-notes-textarea"
              disabled={!canEdit}
              placeholder={canEdit ? "Baustellennotizen eintragen..." : "Keine Notizen hinterlegt."}
              value={notesDraft}
              onChange={(event) => {
                setNotesDraft(event.target.value);
                setNotesSaveStatus("idle");
              }}
              onBlur={handleNotesBlur}
            />
          </section>
        </>
      )}
    </div>
  );
}

function ProjectFoldersPanel({
  site,
  canOpenSharePointDirectly,
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
  canOpenSharePointDirectly: boolean;
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
      {canOpenSharePointDirectly && site.project_folder_web_url ? (
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
        <div className="project-folder-workspace">
          <nav className="project-folder-sidebar" aria-label="Standardordner">
            <div className="project-folder-grid is-folder-list">
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
          </nav>

          <div className="project-folder-content">
            {selectedFolder ? (
              <ProjectFolderDocumentBrowser
                siteId={site.id}
                folder={selectedFolder}
                hasSharePointFolder={Boolean(site.project_folder_web_url)}
                canOpenSharePointDirectly={canOpenSharePointDirectly}
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
            ) : (
              <div className="project-record-empty-state">Ordner auswählen, um Dateien anzuzeigen.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectFolderDocumentBrowser({
  siteId,
  folder,
  hasSharePointFolder,
  canOpenSharePointDirectly,
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
  canOpenSharePointDirectly: boolean;
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
  const [folderStack, setFolderStack] = useState<ProjectFolderNavigationLevel[]>([]);
  const [folderNavigationLoading, setFolderNavigationLoading] = useState(false);
  const [folderNavigationError, setFolderNavigationError] = useState<string | null>(null);
  const [openingItemId, setOpeningItemId] = useState<string | null>(null);
  const [downloadingItemId, setDownloadingItemId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    setQuery("");
    setFolderStack([]);
    setFolderNavigationError(null);
    setOpenError(null);
    setDownloadError(null);
  }, [folder.id]);

  async function handleOpenFolder(item: ProjectFolderDocumentItem): Promise<void> {
    if (!item.is_folder) {
      return;
    }
    setFolderNavigationError(null);
    setFolderNavigationLoading(true);
    try {
      const childDocuments = await api.projectFolderItemChildren(siteId, folder.folder_key, item.id);
      setFolderStack((currentStack) => [
        ...currentStack,
        { itemId: item.id, name: item.name, documents: childDocuments },
      ]);
      setQuery("");
    } catch (requestError) {
      setFolderNavigationError(readApiError(requestError, "Unterordner konnte nicht geladen werden."));
    } finally {
      setFolderNavigationLoading(false);
    }
  }

  function handleBackToParentFolder(): void {
    setFolderStack((currentStack) => currentStack.slice(0, -1));
    setFolderNavigationError(null);
    setQuery("");
  }

  async function handleOpen(item: ProjectFolderDocumentItem): Promise<void> {
    setOpenError(null);
    setOpeningItemId(item.id);
    const openedWindow = window.open("about:blank", "_blank");
    if (openedWindow) {
      openedWindow.opener = null;
    }
    try {
      const blob = await api.projectFolderDocumentContent(siteId, folder.folder_key, item.id, "inline");
      openBlobInNewTab(blob, openedWindow);
    } catch (requestError) {
      openedWindow?.close();
      setOpenError(readApiError(requestError, "Datei konnte nicht geöffnet werden."));
    } finally {
      setOpeningItemId(null);
    }
  }

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

  const currentLevel = folderStack.length > 0 ? folderStack[folderStack.length - 1] : undefined;
  const currentDocuments = currentLevel?.documents ?? documents;
  const isInSubfolder = Boolean(currentLevel);
  const currentFolderTitle = currentLevel?.name ?? `${folder.sort_order}. ${folder.name}`;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = useMemo(() => {
    if (!currentDocuments) {
      return [];
    }
    if (!normalizedQuery) {
      return currentDocuments.items;
    }
    return currentDocuments.items.filter((item) => (
      [item.name, item.file_extension, item.mime_type]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalizedQuery))
    ));
  }, [currentDocuments, normalizedQuery]);
  const hasLoadedItems = Boolean(currentDocuments && currentDocuments.items.length > 0);
  const isCurrentLoading = isInSubfolder ? folderNavigationLoading : isLoading;

  return (
    <aside className="project-document-browser" aria-live="polite">
      <div className="project-document-browser-header">
        <div className="project-document-browser-title">
          <span>Ordner {folder.sort_order}</span>
          <h3>{currentFolderTitle}</h3>
        </div>
        <div className="project-document-browser-actions">
          {isInSubfolder ? (
            <button type="button" className="secondary-action" onClick={handleBackToParentFolder}>
              <ArrowLeft aria-hidden="true" size={15} />
              <span>Zurück</span>
            </button>
          ) : null}
          {hasSharePointFolder && !isInSubfolder ? (
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
          {canOpenSharePointDirectly && !isInSubfolder && folder.external_web_url ? (
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
      {folderNavigationError ? <div className="project-record-empty-state is-error"><strong>{folderNavigationError}</strong></div> : null}
      {openError ? <div className="project-record-empty-state is-error"><strong>{openError}</strong></div> : null}
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
      {hasSharePointFolder && isCurrentLoading ? (
        <div className="project-record-empty-state">Dateien werden geladen...</div>
      ) : null}
      {hasSharePointFolder && !isInSubfolder && error ? (
        <div className="project-record-empty-state is-error">
          <strong>{error}</strong>
          <button type="button" className="secondary-action" onClick={onRetry}>Erneut laden</button>
        </div>
      ) : null}
      {hasSharePointFolder && !isCurrentLoading && !error && currentDocuments?.items.length === 0 ? (
        <div className="project-record-empty-state">
          {isInSubfolder ? "Noch keine Dateien in diesem Unterordner." : "Noch keine Dateien in diesem Ordner. Datei hochladen oder per Drag & Drop auf den Ordner ziehen."}
        </div>
      ) : null}
      {hasSharePointFolder && !isCurrentLoading && !error && hasLoadedItems && visibleItems.length === 0 ? (
        <div className="project-record-empty-state">Keine Dateien gefunden.</div>
      ) : null}
      {hasSharePointFolder && !isCurrentLoading && !error && visibleItems.length > 0 ? (
        <ul className="project-document-list">
          {visibleItems.map((item) => (
            <li key={item.id || item.name} className="project-document-item">
              <div>
                <DocumentTypeIcon item={item} />
                <div>
                  <strong>{item.name}</strong>
                  <span>{formatProjectDocumentMeta(item)}</span>
                </div>
              </div>
              <div className="project-document-item-actions">
                {item.is_folder ? (
                  <button
                    type="button"
                    className="secondary-action project-document-open-action"
                    disabled={folderNavigationLoading}
                    onClick={() => void handleOpenFolder(item)}
                  >
                    <Folder aria-hidden="true" size={15} />
                    <span>Öffnen</span>
                  </button>
                ) : null}
                {!item.is_folder ? (
                  <button
                    type="button"
                    className="secondary-action project-document-open-action"
                    disabled={openingItemId === item.id}
                    onClick={() => void handleOpen(item)}
                  >
                    <ExternalLink aria-hidden="true" size={15} />
                    <span>{openingItemId === item.id ? "Öffnet..." : "Öffnen"}</span>
                  </button>
                ) : null}
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
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}

function DocumentTypeIcon({ item }: { item: ProjectFolderDocumentItem }) {
  if (item.is_folder) {
    return <Folder aria-hidden="true" size={20} />;
  }
  const kind = getProjectDocumentKind(item);
  if (kind === "pdf") {
    return <FileText aria-hidden="true" className="is-pdf" size={20} />;
  }
  if (kind === "word") {
    return <FileText aria-hidden="true" className="is-word" size={20} />;
  }
  if (kind === "excel") {
    return <FileSpreadsheet aria-hidden="true" className="is-excel" size={20} />;
  }
  if (kind === "image") {
    return <FileImage aria-hidden="true" className="is-image" size={20} />;
  }
  if (kind === "mail") {
    return <Mail aria-hidden="true" className="is-mail" size={20} />;
  }
  return <FileIcon aria-hidden="true" size={20} />;
}

function ExtraWorkTab({
  site,
  tickets,
  isLoading,
  error,
  pdfAction,
  onRetry,
  onOpenPdf,
  onDownloadPdf,
}: {
  site: Site;
  tickets: MobileExtraWorkTicket[];
  isLoading: boolean;
  error: string | null;
  pdfAction: string | null;
  onRetry: () => void;
  onOpenPdf: (ticket: MobileExtraWorkTicket) => void;
  onDownloadPdf: (ticket: MobileExtraWorkTicket) => void;
}) {
  const sortedTickets = useMemo(
    () => [...tickets].sort(compareExtraWorkTicketsNewestFirst),
    [tickets],
  );

  return (
    <>
      <div className="project-record-toolbar project-extra-work-toolbar">
        <div>
          <h2><FileText aria-hidden="true" size={18} />Zusatzaufträge</h2>
          <p>Mobile Stundenzettel und Zusatzaufträge zu {site.name} zur Einsicht und PDF-Ausgabe.</p>
        </div>
      </div>
      {isLoading ? <div className="matrix-state">Zusatzaufträge werden geladen...</div> : null}
      {error ? (
        <div className="project-record-empty-state is-error">
          <strong>{error}</strong>
          <button type="button" className="secondary-action" onClick={onRetry}>Erneut laden</button>
        </div>
      ) : null}
      {!isLoading && !error && sortedTickets.length === 0 ? (
        <div className="project-record-empty-state">Noch keine Zusatzaufträge vorhanden.</div>
      ) : null}
      {!isLoading && !error && sortedTickets.length > 0 ? (
        <div className="measurement-review-list project-extra-work-list">
          {sortedTickets.map((ticket) => {
            const statusBadge = getExtraWorkTicketStatusBadge(ticket);
            const openActionKey = `${ticket.id}:open`;
            const downloadActionKey = `${ticket.id}:download`;
            const isOpeningPdf = pdfAction === openActionKey;
            const isDownloadingPdf = pdfAction === downloadActionKey;
            const isPdfBusy = isOpeningPdf || isDownloadingPdf;
            return (
              <div
                key={ticket.id}
                className={`measurement-review-card project-extra-work-card${ticket.status === "submitted" ? " is-submitted" : ""}`}
              >
                <button
                  type="button"
                  className="measurement-review-card-open"
                  onClick={() => onOpenPdf(ticket)}
                >
                  <span className={statusBadge.className}>
                    {statusBadge.label}
                  </span>
                  <div className="measurement-review-card-main">
                    <div className="measurement-review-card-title-row">
                      <strong>{formatExtraWorkTicketTitle(ticket)}</strong>
                    </div>
                    <small>{formatExtraWorkTicketMeta(ticket)}</small>
                    <small>{formatExtraWorkTicketPeriod(ticket)}</small>
                  </div>
                  <b>{formatExtraWorkTicketHours(ticket)}</b>
                </button>
                <div className="measurement-review-pdf-actions">
                  <button
                    type="button"
                    className="measurement-review-pdf-action"
                    disabled={isPdfBusy}
                    onClick={() => onDownloadPdf(ticket)}
                  >
                    {isDownloadingPdf ? "Lädt..." : "PDF"}
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


function MeasurementTab({
  siteNumber,
  activeSubtab,
  onSubtabChange,
  bases,
  timesheet,
  timeAnalysis,
  timeAnalysisLoading,
  timeAnalysisError,
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
  onRetryTimeAnalysis,
  batches,
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
  onMarkReviewed,
  onUpdateEntry,
  onCreateEntry,
  onResetToSubmitted,
  onExportPdf,
}: {
  siteNumber: string | null;
  activeSubtab: MeasurementSubtab;
  onSubtabChange: (subtab: MeasurementSubtab) => void;
  bases: MeasurementBase[];
  timesheet: MeasurementTimesheet | null;
  timeAnalysis: MeasurementTimeAnalysis | null;
  timeAnalysisLoading: boolean;
  timeAnalysisError: string | null;
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
  onRetryTimeAnalysis: () => void;
  batches: MobileMeasurementBatch[];
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
  onMarkReviewed: (batch: MobileMeasurementBatch) => void;
  onUpdateEntry: (batch: MobileMeasurementBatch, entryId: number, payload: { area_or_comment: string; quantity: number }) => Promise<void>;
  onCreateEntry: (batch: MobileMeasurementBatch, measurementItemId: number, payload: { area_or_comment: string; quantity: number }) => Promise<void>;
  onResetToSubmitted: (batch: MobileMeasurementBatch) => Promise<void>;
  onExportPdf: (batch: MobileMeasurementBatch, mode: MeasurementPdfMode) => Promise<void>;
}) {
  const selectableBases = useMemo(
    () => bases.filter((base) => base.status !== "closed" && base.status !== "archived"),
    [bases],
  );
  const defaultBase = useMemo(
    () => selectableBases.find((base) => base.status === "active" && base.released_to_mobile) ?? selectableBases[0] ?? null,
    [selectableBases],
  );
  const suggestedBaseName = useMemo(() => getSuggestedMeasurementSheetName(siteNumber, bases.length + 1), [bases.length, siteNumber]);
  const [importMode, setImportMode] = useState<MeasurementImportOptions["importMode"]>(defaultBase ? "append_existing" : "create_new");
  const [selectedBaseId, setSelectedBaseId] = useState<number | null>(defaultBase?.id ?? null);
  const [newBaseName, setNewBaseName] = useState(suggestedBaseName);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [isDropTargetActive, setIsDropTargetActive] = useState(false);
  const [fileSelectionError, setFileSelectionError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

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
    <div className="project-record-tab-panel">
      <div className="project-record-subtab-bar">
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

      {activeSubtab === "timesheet" ? (
        <MeasurementTimesheetPanel
          timesheet={timesheet}
          workerHeadCount={workerHeadCount}
          isLoading={isLoading}
          error={error}
          fileSelectionError={fileSelectionError}
          isImportDialogOpen={isImportDialogOpen}
          importMessage={importMessage}
          importError={importError}
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
          onMarkReviewed={onMarkReviewed}
          onUpdateEntry={onUpdateEntry}
          onCreateEntry={onCreateEntry}
          onResetToSubmitted={onResetToSubmitted}
          onExportPdf={onExportPdf}
        />
      ) : null}

      {activeSubtab === "time-analysis" ? (
        <MeasurementTimeAnalysisPanel
          analysis={timeAnalysis}
          isLoading={timeAnalysisLoading}
          error={timeAnalysisError}
          onRetry={onRetryTimeAnalysis}
        />
      ) : null}

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
    </div>
  );
}

function MeasurementTimesheetPanel({
  timesheet,
  workerHeadCount,
  isLoading,
  error,
  fileSelectionError,
  isImportDialogOpen,
  importMessage,
  importError,
  onRetry,
}: {
  timesheet: MeasurementTimesheet | null;
  workerHeadCount: number;
  isLoading: boolean;
  error: string | null;
  fileSelectionError: string | null;
  isImportDialogOpen: boolean;
  importMessage: string | null;
  importError: string | null;
  onRetry: () => void;
}) {
  const [activeFilter, setActiveFilter] = useState<MeasurementTimesheetFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [isTableRenderReady, setIsTableRenderReady] = useState(false);
  const [tableViewport, setTableViewport] = useState({
    firstVisibleRow: 0,
    height: MEASUREMENT_TIMESHEET_DEFAULT_VIEWPORT_HEIGHT,
  });
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const tableScrollFrameRef = useRef<number | null>(null);
  const tableRenderStartedAtRef = useRef<number | null>(null);

  const updateTableViewport = useCallback(() => {
    const element = tableWrapRef.current;
    if (!element) {
      return;
    }

    const nextViewport = {
      firstVisibleRow: Math.max(0, Math.floor(element.scrollTop / MEASUREMENT_TIMESHEET_ROW_HEIGHT)),
      height: element.clientHeight || MEASUREMENT_TIMESHEET_DEFAULT_VIEWPORT_HEIGHT,
    };

    setTableViewport((currentViewport) => (
      currentViewport.firstVisibleRow === nextViewport.firstVisibleRow
        && Math.abs(currentViewport.height - nextViewport.height) < 1
        ? currentViewport
        : nextViewport
    ));
  }, []);

  const handleTableScroll = useCallback(() => {
    if (tableScrollFrameRef.current !== null) {
      return;
    }

    tableScrollFrameRef.current = window.requestAnimationFrame(() => {
      tableScrollFrameRef.current = null;
      updateTableViewport();
    });
  }, [updateTableViewport]);

  const projectPositionRows = useMemo(() => {
    const startedAt = startMeasurementTimesheetPerformanceTiming();
    const rows = (timesheet?.rows ?? []).map((row) => {
      const plannedQuantity = getMeasurementNumericValue(row.target_quantity);
      const measuredQuantity = getMeasurementNumericValue(row.measured_quantity);
      const remainingQuantity = row.remaining_quantity === null ? null : getMeasurementNumericValue(row.remaining_quantity);

      return {
        positionId: row.position_id,
        positionNumber: row.position_number,
        description: row.description,
        searchText: row.search_text || `${row.position_number} ${row.description ?? ""}`.toLocaleLowerCase("de-DE"),
        unit: row.unit,
        plannedQuantity,
        hasPlannedQuantity: plannedQuantity > 0,
        measuredQuantity,
        remainingQuantity,
        minutesPerUnit: getMeasurementNumericValue(row.minutes_per_unit),
        plannedMinutes: getMeasurementNumericValue(row.planned_minutes),
        measuredMinutes: getMeasurementNumericValue(row.measured_minutes),
        progressPercent: row.progress_percent,
      };
    });
    logMeasurementTimesheetPerformance("Derived Positionszeilen", startedAt, {
      rows: rows.length,
      source: "backend-timesheet",
    });
    return rows;
  }, [timesheet?.rows]);

  const projectPositionStats = useMemo(() => {
    const kpi = timesheet?.kpi;
    if (!kpi) {
      return {
        total: 0,
        plannedMinutes: 0,
        measuredMinutes: 0,
        progressPercent: null,
        openMinutes: null,
        hasPlannedBasis: false,
        withMeasurement: 0,
        withoutMeasurement: 0,
      };
    }

    return {
      total: kpi.position_count,
      plannedMinutes: getMeasurementNumericValue(kpi.planned_minutes),
      measuredMinutes: getMeasurementNumericValue(kpi.measured_minutes),
      progressPercent: kpi.progress_percent,
      openMinutes: kpi.open_minutes === null ? null : getMeasurementNumericValue(kpi.open_minutes),
      hasPlannedBasis: kpi.has_planned_basis,
      withMeasurement: kpi.captured_count,
      withoutMeasurement: kpi.not_captured_count,
    };
  }, [timesheet?.kpi]);

  const filterOptions = useMemo(() => ([
    { key: "all" as const, label: "Alle", count: projectPositionStats.total },
    { key: "billed" as const, label: "Erfasst", count: projectPositionStats.withMeasurement },
    { key: "unbilled" as const, label: "Noch nicht erfasst", count: projectPositionStats.withoutMeasurement },
  ]), [projectPositionStats]);

  const filteredProjectPositionRows = useMemo(() => {
    const startedAt = startMeasurementTimesheetPerformanceTiming();
    const normalizedSearch = deferredSearchTerm.trim().toLocaleLowerCase("de-DE");

    const rows = projectPositionRows.filter((row) => {
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

      return row.searchText.includes(normalizedSearch);
    });
    logMeasurementTimesheetPerformance("Derived Tabellenfilter", startedAt, {
      rows: projectPositionRows.length,
      filteredRows: rows.length,
      filter: activeFilter,
      hasSearch: normalizedSearch.length > 0,
    });
    return rows;
  }, [activeFilter, deferredSearchTerm, projectPositionRows]);

  useEffect(() => {
    const rowCount = filteredProjectPositionRows.length;
    tableRenderStartedAtRef.current = startMeasurementTimesheetPerformanceTiming();
    setIsTableRenderReady(false);
    if (tableWrapRef.current) {
      tableWrapRef.current.scrollTop = 0;
    }
    setTableViewport((currentViewport) => ({
      firstVisibleRow: 0,
      height: currentViewport.height || MEASUREMENT_TIMESHEET_DEFAULT_VIEWPORT_HEIGHT,
    }));

    if (rowCount === 0) {
      setIsTableRenderReady(true);
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      setIsTableRenderReady(true);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [filteredProjectPositionRows]);

  useEffect(() => {
    const element = tableWrapRef.current;
    if (!element || !isTableRenderReady) {
      return;
    }

    updateTableViewport();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => updateTableViewport());
    observer.observe(element);
    return () => observer.disconnect();
  }, [isTableRenderReady, updateTableViewport]);

  useEffect(() => () => {
    if (tableScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(tableScrollFrameRef.current);
    }
  }, []);

  const virtualProjectPositionRows = useMemo(() => {
    if (!isTableRenderReady) {
      return {
        bottomSpacerHeight: 0,
        endIndex: 0,
        rows: [],
        startIndex: 0,
        topSpacerHeight: 0,
      };
    }

    const totalRows = filteredProjectPositionRows.length;
    const startIndex = Math.max(0, tableViewport.firstVisibleRow - MEASUREMENT_TIMESHEET_OVERSCAN_ROWS);
    const visibleRowCount = Math.ceil(
      (tableViewport.height || MEASUREMENT_TIMESHEET_DEFAULT_VIEWPORT_HEIGHT) / MEASUREMENT_TIMESHEET_ROW_HEIGHT,
    ) + (MEASUREMENT_TIMESHEET_OVERSCAN_ROWS * 2);
    const endIndex = Math.min(totalRows, startIndex + visibleRowCount);

    return {
      bottomSpacerHeight: Math.max(0, totalRows - endIndex) * MEASUREMENT_TIMESHEET_ROW_HEIGHT,
      endIndex,
      rows: filteredProjectPositionRows.slice(startIndex, endIndex),
      startIndex,
      topSpacerHeight: startIndex * MEASUREMENT_TIMESHEET_ROW_HEIGHT,
    };
  }, [filteredProjectPositionRows, isTableRenderReady, tableViewport.firstVisibleRow, tableViewport.height]);

  useEffect(() => {
    const startedAt = tableRenderStartedAtRef.current;
    if (!isTableRenderReady || startedAt === null) {
      return;
    }
    logMeasurementTimesheetPerformance("Tabelle sichtbar", startedAt, {
      renderedRows: virtualProjectPositionRows.rows.length,
      totalRows: filteredProjectPositionRows.length,
      virtualStart: virtualProjectPositionRows.startIndex,
      virtualEnd: virtualProjectPositionRows.endIndex,
    });
    tableRenderStartedAtRef.current = null;
  }, [
    filteredProjectPositionRows.length,
    isTableRenderReady,
    virtualProjectPositionRows.endIndex,
    virtualProjectPositionRows.rows.length,
    virtualProjectPositionRows.startIndex,
  ]);

  return (
    <>
      <div className="measurement-timesheet-workspace">
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
        {!isLoading && !error && projectPositionRows.length === 0 ? (
          <div className="project-record-empty-state">Noch keine Aufmaßpositionen importiert.</div>
        ) : null}
        {!isLoading && !error && projectPositionRows.length > 0 ? (
          <>
            <div className="measurement-timesheet-progress-row">
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
                  </>
                ) : (
                  <p className="measurement-timesheet-progress-note">
                    Für einen belastbaren Fortschritt fehlt aktuell noch die Sollbasis aus Angebots-/Projektmengen.
                  </p>
                )}
              </section>
              <aside className="measurement-timesheet-hours-card" aria-label="Stundenübersicht">
                <div>
                  <span>Gesamtstunden Angebot</span>
                  <strong>{projectPositionStats.hasPlannedBasis ? formatMeasurementDuration(projectPositionStats.plannedMinutes) : "Keine Sollbasis"}</strong>
                </div>
                <div>
                  <span>Geleistete Stunden</span>
                  <strong>{formatMeasurementDuration(projectPositionStats.measuredMinutes)}</strong>
                </div>
                <div>
                  <span>Offene Stunden</span>
                  <strong>{projectPositionStats.openMinutes !== null ? formatMeasurementDuration(projectPositionStats.openMinutes) : "Keine Sollbasis"}</strong>
                </div>
              </aside>
            </div>

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
              ) : !isTableRenderReady ? (
                <div className="project-record-empty-state">Tabelle wird vorbereitet...</div>
              ) : (
                <>
                  <div
                    className="measurement-table-wrap measurement-timesheet-table-wrap"
                    ref={tableWrapRef}
                    onScroll={handleTableScroll}
                  >
                    <table className="measurement-table measurement-timesheet-table">
                      <thead>
                        <tr>
                          <th>Pos.-Nr.</th>
                          <th>Bezeichnung</th>
                          <th>Einheit</th>
                          <th className="measurement-timesheet-number">Soll</th>
                          <th className="measurement-timesheet-number">Ist</th>
                          <th className="measurement-timesheet-number">Restmenge</th>
                          <th className="measurement-timesheet-number">Minuten</th>
                          <th className="measurement-timesheet-number">Gesamt</th>
                          <th className="measurement-timesheet-number">Fortschritt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {virtualProjectPositionRows.topSpacerHeight > 0 ? (
                          <tr className="measurement-timesheet-virtual-spacer" aria-hidden="true">
                            <td colSpan={9} style={{ height: virtualProjectPositionRows.topSpacerHeight }} />
                          </tr>
                        ) : null}
                        {virtualProjectPositionRows.rows.map((row) => (
                          <tr
                            key={row.positionId}
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
                            <td className="measurement-timesheet-number measurement-timesheet-progress-cell">
                              {row.progressPercent !== null ? (
                                <span className="measurement-timesheet-cell-progress">
                                  <span className="measurement-timesheet-cell-progress-value">{formatMeasurementPercent(row.progressPercent)}</span>
                                  <span className="measurement-timesheet-cell-progress-track" aria-hidden="true">
                                    <span style={{ width: `${Math.min(Math.max(row.progressPercent, 0), 100)}%` }} />
                                  </span>
                                </span>
                              ) : (
                                <span className="measurement-timesheet-empty-value">-</span>
                              )}
                            </td>
                          </tr>
                        ))}
                        {virtualProjectPositionRows.bottomSpacerHeight > 0 ? (
                          <tr className="measurement-timesheet-virtual-spacer" aria-hidden="true">
                            <td colSpan={9} style={{ height: virtualProjectPositionRows.bottomSpacerHeight }} />
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          </>
        ) : null}
      </div>

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
  const sortedBases = useMemo(() => bases.slice().sort((left, right) => (
    new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
    || left.id - right.id
  )), [bases]);
  const offerNumberByBaseId = useMemo(
    () => new Map(sortedBases.map((base, index) => [base.id, index + 1])),
    [sortedBases],
  );

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
  onMarkReviewed,
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
  onMarkReviewed: (batch: MobileMeasurementBatch) => void;
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
    const isReviewed = isMeasurementBatchReviewed(selectedBatch.status);
    const isCustomerSigned = isCustomerSignedMeasurementBatch(selectedBatch);
    const canEditRows = !isDraft;
    const displayTitle = formatMeasurementPackageNumber(siteNumber, selectedBatch.number, selectedBatch.title);
    const updatedLabel = selectedBatch.updated_at ? formatDateTime(selectedBatch.updated_at) : null;

    return (
      <div className="measurement-review-detail is-table-view">
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
            <div className="measurement-review-filter-group" aria-label="Aktueller Prüfstatus">
              <span className={isMeasurementBatchReviewRequired(selectedBatch) ? "is-active" : ""}>Eingereicht</span>
              <span className={isReviewed ? "is-active" : ""}>Geprüft</span>
              <span className={isCustomerSigned && !isBilled ? "is-active" : ""}>Unterschrieben</span>
              <span className={isBilled ? "is-active" : ""}>Abgeschlossen</span>
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
                  Wieder auf Eingereicht setzen
                </button>
              ) : (
                <>
                  {isMeasurementBatchReviewRequired(selectedBatch) ? (
                    <button type="button" className="primary-action" disabled={reviewActionLoading} onClick={() => onMarkReviewed(selectedBatch)}>
                      Prüfung abschließen
                    </button>
                  ) : null}
                  {(isReviewed || isCustomerSigned) ? (
                    <button type="button" className="primary-action" disabled={reviewActionLoading} onClick={() => onMarkBilled(selectedBatch)}>
                      Aufmaß abschließen
                    </button>
                  ) : null}
                </>
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
        {!batchItemsLoading && itemsWithEntries.length > 0 ? (
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
          <p>Eingereichte Aufmaßpakete prüfen, unterschreiben lassen und abschließen.</p>
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
            const statusBadge = getMeasurementBatchStatusBadge(batch);
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
                  <span className={statusBadge.className}>
                    {statusBadge.label}
                  </span>
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
                    title={canExportPdf ? "Geprüftes PDF mit Projektleiterkorrekturen exportieren" : "PDF-Export erst nach Prüfung oder Abschluss verfügbar"}
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
                    title={canExportPdf ? "Originales Monteur-Aufmaß exportieren" : "PDF-Export erst nach Prüfung oder Abschluss verfügbar"}
                    onClick={() => {
                      setPdfExportingAction(originalPdfKey);
                      void onExportPdf(batch, "original").finally(() => setPdfExportingAction(null));
                    }}
                  >
                    {isExportingOriginalPdf ? "PDF..." : "Originales Monteur-Aufmaß"}
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

function MeasurementTimeAnalysisPanel({
  analysis,
  isLoading,
  error,
  onRetry,
}: {
  analysis: MeasurementTimeAnalysis | null;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="measurement-time-analysis-panel">
      <div className="project-record-toolbar">
        <div>
          <h2><Ruler aria-hidden="true" size={18} />Zeitauswertung</h2>
          <p>Aufmaßpakete werden mit den zugehörigen Montagezeiten und Zusatzaufträgen je Abrechnungszeitraum verglichen.</p>
        </div>
      </div>
      {error ? (
        <div className="project-record-empty-state">
          <p>{error}</p>
          <button type="button" className="secondary-action" onClick={onRetry}>Erneut laden</button>
        </div>
      ) : isLoading ? (
        <div className="project-record-empty-state">
          <p>Zeitauswertung wird geladen…</p>
        </div>
      ) : analysis && analysis.rows.length > 0 ? (
        <>
          <div className="measurement-evaluation-grid">
            <div><span>Soll gesamt</span><strong>{formatMeasurementDuration(getMeasurementNumericValue(analysis.totals.planned_minutes))}</strong></div>
            <div><span>Ist gesamt</span><strong>{formatMeasurementDuration(getMeasurementNumericValue(analysis.totals.actual_minutes))}</strong></div>
            <div><span>Abweichung</span><strong>{formatSignedMeasurementDuration(getMeasurementNumericValue(analysis.totals.deviation_minutes))}</strong></div>
          </div>
          <div className="measurement-table-wrap measurement-time-analysis-table-wrap">
            <table className="measurement-table measurement-time-analysis-table">
              <thead>
                <tr>
                  <th>Aufmaß</th>
                  <th>Zeitraum</th>
                  <th>Zusatzaufträge</th>
                  <th>Soll Aufmaß</th>
                  <th>Soll Zusatz</th>
                  <th>Soll Gesamt</th>
                  <th>Ist Monteure</th>
                  <th>Abweichung</th>
                  <th>Verbrauch</th>
                </tr>
              </thead>
              <tbody>
                {analysis.rows.map((row) => (
                  <tr key={row.measurement_batch_id}>
                    <td>
                      <strong>{`Aufmaß ${row.measurement_number}`}</strong>
                      <span>{row.measurement_title}</span>
                    </td>
                    <td>{formatMeasurementAnalysisPeriod(row.period_start, row.period_end)}</td>
                    <td className="measurement-time-analysis-extra-work-cell">
                      {row.extra_work_tickets.length > 0 ? (
                        <MeasurementTimeAnalysisExtraWorkDropdown tickets={row.extra_work_tickets} />
                      ) : "-"}
                    </td>
                    <td className="measurement-timesheet-number">{formatMeasurementDuration(getMeasurementNumericValue(row.measurement_minutes))}</td>
                    <td className="measurement-timesheet-number">{formatMeasurementDuration(getMeasurementNumericValue(row.extra_work_minutes))}</td>
                    <td className="measurement-timesheet-number">{formatMeasurementDuration(getMeasurementNumericValue(row.planned_minutes))}</td>
                    <td className="measurement-timesheet-number">{formatMeasurementDuration(getMeasurementNumericValue(row.actual_minutes))}</td>
                    <td className="measurement-timesheet-number">{formatSignedMeasurementDuration(getMeasurementNumericValue(row.deviation_minutes))}</td>
                    <td className="measurement-timesheet-number">{row.consumption_percent !== null ? formatMeasurementPercent(row.consumption_percent) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="project-record-empty-state">
          <p>Noch keine eingereichten Aufmaße für eine Zeitauswertung vorhanden.</p>
        </div>
      )}
    </div>
  );
}

function MeasurementTimeAnalysisExtraWorkDropdown({
  tickets,
}: {
  tickets: MeasurementTimeAnalysis["rows"][number]["extra_work_tickets"];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const totalMinutes = tickets.reduce(
    (sum, ticket) => sum + getMeasurementNumericValue(ticket.planned_minutes),
    0,
  );
  const ticketLabel = `${tickets.length} ${tickets.length === 1 ? "Zusatzauftrag" : "Zusatzaufträge"}`;

  return (
    <div className="measurement-time-analysis-extra-work-dropdown">
      <button
        type="button"
        className="measurement-time-analysis-extra-work-toggle"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setIsOpen(false);
          }
        }}
      >
        <span>
          <strong>{ticketLabel}</strong>
          <small>{formatMeasurementDuration(totalMinutes)} Zusatz</small>
        </span>
        <span aria-hidden="true">{isOpen ? "▴" : "▾"}</span>
      </button>
      {isOpen ? (
        <div className="measurement-time-analysis-extra-work-menu" role="menu">
          {tickets.map((ticket) => (
            <div className="measurement-time-analysis-extra-work-item" key={ticket.id} role="menuitem">
              <strong>{ticket.display_number}</strong>
              <span>{ticket.title || "Ohne Bezeichnung"}</span>
              <small>{formatMeasurementDuration(getMeasurementNumericValue(ticket.planned_minutes))}</small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SiteWorkTimesPanel({
  site,
  canEdit,
  onSiteUpdated,
}: {
  site: Site;
  canEdit: boolean;
  onSiteUpdated: (site: Site) => void;
}) {
  const [rangeMode, setRangeMode] = useState<SiteWorkTimeRangeMode>("month");
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditingPlanned, setIsEditingPlanned] = useState(false);
  const [plannedInput, setPlannedInput] = useState(() => formatPlannedWorkHours(site.planned_work_minutes));
  const [plannedSaveError, setPlannedSaveError] = useState<string | null>(null);
  const [plannedSaveMessage, setPlannedSaveMessage] = useState<string | null>(null);
  const [isSavingPlanned, setIsSavingPlanned] = useState(false);
  const activeRange = useMemo(
    () => (rangeMode === "week" ? getCurrentGermanWeekRange() : getCurrentMonthRange()),
    [rangeMode],
  );
  const summary = useMemo(() => ({
    count: entries.length,
    workerCount: new Set(entries.map((entry) => entry.person_id)).size,
    workMinutes: sumTimeEntryMinutes(entries, "work_minutes"),
    breakMinutes: sumTimeEntryMinutes(entries, "break_minutes"),
    travelMinutes: sumTimeEntryMinutes(entries, "travel_minutes"),
  }), [entries]);
  const plannedMinutes = site.planned_work_minutes;
  const hasPlannedMinutes = typeof plannedMinutes === "number" && plannedMinutes > 0;
  const differenceMinutes = hasPlannedMinutes ? summary.workMinutes - plannedMinutes : null;
  const usagePercent = hasPlannedMinutes ? (summary.workMinutes / plannedMinutes) * 100 : null;
  const balanceStatus = getSiteWorkTimeBalanceStatus(plannedMinutes, summary.workMinutes);

  useEffect(() => {
    if (!isEditingPlanned) {
      setPlannedInput(formatPlannedWorkHours(site.planned_work_minutes));
    }
  }, [isEditingPlanned, site.planned_work_minutes]);

  useEffect(() => {
    let ignore = false;
    setIsLoading(true);
    setError(null);

    api.timeEntries({
      siteId: site.id,
      dateFrom: activeRange.start,
      dateTo: activeRange.end,
      projectMountingOnly: true,
    })
      .then((entryData) => {
        if (!ignore) {
          setEntries(entryData);
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setEntries([]);
          setError(readApiError(requestError, "Arbeitszeiten konnten nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [activeRange.end, activeRange.start, site.id]);

  function startPlannedEdit(): void {
    setPlannedInput(formatPlannedWorkHours(site.planned_work_minutes));
    setPlannedSaveError(null);
    setPlannedSaveMessage(null);
    setIsEditingPlanned(true);
  }

  function cancelPlannedEdit(): void {
    if (isSavingPlanned) {
      return;
    }
    setPlannedInput(formatPlannedWorkHours(site.planned_work_minutes));
    setPlannedSaveError(null);
    setIsEditingPlanned(false);
  }

  async function savePlannedWorkMinutes(): Promise<void> {
    const parsed = parsePlannedWorkHours(plannedInput);
    if (!parsed.ok) {
      setPlannedSaveError(parsed.error);
      setPlannedSaveMessage(null);
      return;
    }
    setIsSavingPlanned(true);
    setPlannedSaveError(null);
    setPlannedSaveMessage(null);
    try {
      const updatedSite = await api.updateSite(site.id, { planned_work_minutes: parsed.value });
      onSiteUpdated(updatedSite);
      setIsEditingPlanned(false);
      setPlannedSaveMessage("Soll-Stunden gespeichert.");
    } catch (requestError) {
      setPlannedSaveError(readApiError(requestError, "Soll-Stunden konnten nicht gespeichert werden."));
    } finally {
      setIsSavingPlanned(false);
    }
  }

  return (
    <div className="project-record-tab-panel site-times-shell">
      <section className="site-times-hero" aria-label="Montagezeiten Zeitraum">
        <div className="site-times-hero-copy">
          <span className="site-times-hero-icon">
            <CalendarClock aria-hidden="true" size={22} />
          </span>
          <div>
            <h2>Montagezeiten</h2>
            <p>Erfasste Ist-Arbeitszeiten für diese Baustelle. Soll-/Ist-Auswertung folgt, sobald Sollstunden angebunden sind.</p>
          </div>
        </div>
        <div className="site-times-period">
          <div className="site-times-period-toggle" aria-label="Zeitraum">
            <button className={rangeMode === "week" ? "is-active" : ""} type="button" onClick={() => setRangeMode("week")}>
              Aktuelle Woche
            </button>
            <button className={rangeMode === "month" ? "is-active" : ""} type="button" onClick={() => setRangeMode("month")}>
              Aktueller Monat
            </button>
          </div>
          <small>{formatDateRange(activeRange.start, activeRange.end)}</small>
        </div>
      </section>

      <div className="site-times-kpi-strip" aria-label="Arbeitszeiten Kennzahlen">
        <div className="site-times-kpi-item"><span>Einträge</span><strong>{summary.count}</strong></div>
        <div className="site-times-kpi-item"><span>Monteure</span><strong>{summary.workerCount}</strong></div>
        <div className="site-times-kpi-item"><span>Arbeitszeit</span><strong>{formatMeasurementDuration(summary.workMinutes)}</strong></div>
        <div className="site-times-kpi-item"><span>Pause</span><strong>{formatMeasurementDuration(summary.breakMinutes)}</strong></div>
        <div className="site-times-kpi-item"><span>Fahrtzeit</span><strong>{formatMeasurementDuration(summary.travelMinutes)}</strong></div>
      </div>

      <div className="site-times-insights">
        <section className="site-times-panel site-times-overview-panel" aria-label="Ist-Zeiten Überblick">
          <div className="site-times-panel-heading">
            <h3>Ist-Zeiten Überblick</h3>
            <p>Zusammenfassung der erfassten Zeiten im gewählten Zeitraum</p>
          </div>
          <div className="site-times-summary-list">
            <div className="site-times-summary-row">
              <span><i className="is-work" aria-hidden="true" />Arbeitszeit</span>
              <strong>{formatMeasurementDuration(summary.workMinutes)}</strong>
            </div>
            <div className="site-times-summary-row">
              <span><i className="is-break" aria-hidden="true" />Pause</span>
              <strong>{formatMeasurementDuration(summary.breakMinutes)}</strong>
            </div>
            <div className="site-times-summary-row">
              <span><i className="is-travel" aria-hidden="true" />Fahrtzeit</span>
              <strong>{formatMeasurementDuration(summary.travelMinutes)}</strong>
            </div>
          </div>
        </section>

        <section className="site-times-panel site-times-balance-panel" aria-label="Soll-Ist-Auswertung">
          <div className="site-times-panel-heading site-times-panel-heading-with-action">
            <div>
              <h3>Soll / Ist Vergleich</h3>
              <p>Ist-Stunden aus geprüften Arbeitszeiten für {formatDateRange(activeRange.start, activeRange.end)}</p>
            </div>
            {canEdit && !isEditingPlanned ? (
              <button className="secondary-action" type="button" onClick={startPlannedEdit}>
                Soll-Stunden bearbeiten
              </button>
            ) : null}
          </div>

          {isEditingPlanned ? (
            <div className="site-worktime-planned-edit">
              <label>
                <span>Soll-Stunden für Auswertung</span>
                <input
                  inputMode="decimal"
                  placeholder="z. B. 120,5"
                  value={plannedInput}
                  onChange={(event) => setPlannedInput(event.target.value)}
                />
              </label>
              <div className="site-worktime-planned-actions">
                <button className="icon-button secondary" disabled={isSavingPlanned} type="button" onClick={cancelPlannedEdit}>
                  Abbrechen
                </button>
                <button className="icon-button" disabled={isSavingPlanned} type="button" onClick={() => void savePlannedWorkMinutes()}>
                  {isSavingPlanned ? "Speichert..." : "Speichern"}
                </button>
              </div>
            </div>
          ) : null}
          {plannedSaveError ? <div className="project-record-empty-state is-error">{plannedSaveError}</div> : null}
          {plannedSaveMessage ? <div className="project-record-empty-state is-success">{plannedSaveMessage}</div> : null}

          <div className="site-times-balance-grid">
            <div>
              <span>Soll-Stunden</span>
              <strong>{hasPlannedMinutes ? formatMeasurementDuration(plannedMinutes ?? 0) : "Nicht hinterlegt"}</strong>
            </div>
            <div>
              <span>Ist-Stunden im Zeitraum</span>
              <strong>{formatMeasurementDuration(summary.workMinutes)}</strong>
            </div>
            <div>
              <span>Differenz Ist - Soll</span>
              <strong>{differenceMinutes !== null ? formatMeasurementDuration(differenceMinutes) : "-"}</strong>
            </div>
            <div>
              <span>Verbrauch</span>
              <strong>{usagePercent !== null ? formatMeasurementPercent(usagePercent) : "-"}</strong>
            </div>
            <div>
              <span>Hinweisstatus</span>
              <strong>
                <StatusBadge tone={siteWorkTimeBalanceTone(balanceStatus)}>
                  {siteWorkTimeBalanceLabel(balanceStatus)}
                </StatusBadge>
              </strong>
            </div>
          </div>
        </section>
      </div>

      <section className="site-times-table-card" aria-label="Geprüfte Montagezeiten">
        <div className="site-times-table-toolbar">
          <div>
            <h3>Geprüfte Montagezeiten</h3>
            <p>Finale, abrechnungsfähige Ist-Zeiten im gewählten Zeitraum</p>
          </div>
        </div>
        {error ? <div className="project-record-empty-state is-error">{error}</div> : null}
        {isLoading ? <div className="project-record-empty-state">Arbeitszeiten werden geladen...</div> : null}
        {!isLoading && !error && entries.length === 0 ? (
          <div className="project-record-empty-state">Für diesen Zeitraum wurden noch keine geprüften Montagezeiten auf diese Baustelle erfasst.</div>
        ) : null}
        {!isLoading && !error && entries.length > 0 ? (
          <div className="site-worktime-table-wrap">
            <table className="site-worktime-table">
              <thead>
                <tr>
                  <th>Datum</th>
                  <th>Monteur</th>
                  <th>Arbeitszeit</th>
                  <th>Pause</th>
                  <th>Fahrtzeit</th>
                  <th>Status</th>
                  <th>Notiz</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDateOnly(entry.work_date)}</td>
                    <td>{entry.person_name || `Person ${entry.person_id}`}</td>
                    <td className="site-worktime-number">{formatMeasurementDuration(entry.work_minutes)}</td>
                    <td className="site-worktime-number">{formatMeasurementDuration(entry.break_minutes)}</td>
                    <td className="site-worktime-number">{formatMeasurementDuration(entry.travel_minutes)}</td>
                    <td>
                      <StatusBadge tone={timeEntryStatusTone(entry.status)}>
                        {timeEntryStatusLabels[entry.status] ?? entry.status}
                      </StatusBadge>
                    </td>
                    <td>{entry.note || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
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
      <div className="site-detail-section-content">{children}</div>
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

type InlineEditStatus = "idle" | "saving" | "saved" | "error";

function InlineEditableDetailItem({
  label,
  value,
  canEdit,
  required = false,
  emptyMessage = "Dieses Feld darf nicht leer sein.",
  onSave,
}: {
  label: string;
  value: string | null | undefined;
  canEdit: boolean;
  required?: boolean;
  emptyMessage?: string;
  onSave: (value: string | null) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(value ?? "");
  const [status, setStatus] = useState<InlineEditStatus>("idle");

  useEffect(() => {
    if (!isEditing) {
      setDraftValue(value ?? "");
    }
  }, [isEditing, value]);

  async function commit(): Promise<void> {
    const nextValue = normalizeInlineEditText(draftValue);
    if (required && nextValue === null) {
      setStatus("error");
      return;
    }
    if (nextValue === normalizeInlineEditText(value ?? "")) {
      setIsEditing(false);
      return;
    }
    setStatus("saving");
    try {
      await onSave(nextValue);
      setIsEditing(false);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  function cancel(): void {
    setDraftValue(value ?? "");
    setIsEditing(false);
    setStatus("idle");
  }

  return (
    <div className={`detail-item site-inline-edit-item${isEditing ? " is-editing" : ""}`}>
      <span>{label}</span>
      {isEditing ? (
        <div className="site-inline-edit-control">
          <input
            className="site-inline-edit-input"
            autoFocus
            value={draftValue}
            aria-invalid={required && normalizeInlineEditText(draftValue) === null}
            onChange={(event) => {
              setDraftValue(event.target.value);
              setStatus("idle");
            }}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
          />
          {status !== "idle" ? <small className={`site-inline-edit-status is-${status}`}>{status === "error" && required && normalizeInlineEditText(draftValue) === null ? emptyMessage : formatInlineEditStatus(status)}</small> : null}
        </div>
      ) : (
        <>
          <strong className="site-inline-edit-display">
            <span>{value || "-"}</span>
            {canEdit ? (
              <button
                type="button"
                className="site-inline-edit-button"
                aria-label={`${label} bearbeiten`}
                onClick={() => {
                  setDraftValue(value ?? "");
                  setIsEditing(true);
                  setStatus("idle");
                }}
              >
                <Pencil aria-hidden="true" size={13} />
              </button>
            ) : null}
          </strong>
          {status === "saved" || status === "error" ? <small className={`site-inline-edit-status is-${status}`}>{formatInlineEditStatus(status)}</small> : null}
        </>
      )}
    </div>
  );
}

function InlineEditablePairItem({
  label,
  firstValue,
  secondValue,
  firstPlaceholder,
  secondPlaceholder,
  displayValue,
  canEdit,
  onSave,
}: {
  label: string;
  firstValue: string | null | undefined;
  secondValue: string | null | undefined;
  firstPlaceholder: string;
  secondPlaceholder: string;
  displayValue: string;
  canEdit: boolean;
  onSave: (firstValue: string | null, secondValue: string | null) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [firstDraft, setFirstDraft] = useState(firstValue ?? "");
  const [secondDraft, setSecondDraft] = useState(secondValue ?? "");
  const [status, setStatus] = useState<InlineEditStatus>("idle");

  useEffect(() => {
    if (!isEditing) {
      setFirstDraft(firstValue ?? "");
      setSecondDraft(secondValue ?? "");
    }
  }, [firstValue, isEditing, secondValue]);

  async function commit(): Promise<void> {
    const nextFirst = normalizeInlineEditText(firstDraft);
    const nextSecond = normalizeInlineEditText(secondDraft);
    if (
      nextFirst === normalizeInlineEditText(firstValue ?? "")
      && nextSecond === normalizeInlineEditText(secondValue ?? "")
    ) {
      setIsEditing(false);
      return;
    }
    setStatus("saving");
    try {
      await onSave(nextFirst, nextSecond);
      setIsEditing(false);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  function cancel(): void {
    setFirstDraft(firstValue ?? "");
    setSecondDraft(secondValue ?? "");
    setIsEditing(false);
    setStatus("idle");
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  return (
    <div className={`detail-item site-inline-edit-item${isEditing ? " is-editing" : ""}`}>
      <span>{label}</span>
      {isEditing ? (
        <div
          className="site-inline-edit-control"
          onBlur={(event) => {
            const nextTarget = event.relatedTarget as Node | null;
            if (!event.currentTarget.contains(nextTarget)) {
              void commit();
            }
          }}
        >
          <div className="site-inline-edit-pair">
            <input
              className="site-inline-edit-input"
              autoFocus
              placeholder={firstPlaceholder}
              value={firstDraft}
              onChange={(event) => {
                setFirstDraft(event.target.value);
                setStatus("idle");
              }}
              onKeyDown={handleEditKeyDown}
            />
            <input
              className="site-inline-edit-input"
              placeholder={secondPlaceholder}
              value={secondDraft}
              onChange={(event) => {
                setSecondDraft(event.target.value);
                setStatus("idle");
              }}
              onKeyDown={handleEditKeyDown}
            />
          </div>
          {status !== "idle" ? <small className={`site-inline-edit-status is-${status}`}>{formatInlineEditStatus(status)}</small> : null}
        </div>
      ) : (
        <>
          <strong className="site-inline-edit-display">
            <span>{displayValue || "-"}</span>
            {canEdit ? (
              <button
                type="button"
                className="site-inline-edit-button"
                aria-label={`${label} bearbeiten`}
                onClick={() => {
                  setFirstDraft(firstValue ?? "");
                  setSecondDraft(secondValue ?? "");
                  setIsEditing(true);
                  setStatus("idle");
                }}
              >
                <Pencil aria-hidden="true" size={13} />
              </button>
            ) : null}
          </strong>
          {status === "saved" || status === "error" ? <small className={`site-inline-edit-status is-${status}`}>{formatInlineEditStatus(status)}</small> : null}
        </>
      )}
    </div>
  );
}

function InlineEditableSelectItem({
  label,
  value,
  displayValue,
  canEdit,
  options,
  onSave,
}: {
  label: string;
  value: string;
  displayValue: string | null | undefined;
  canEdit: boolean;
  options: Array<{ value: string; label: string }>;
  onSave: (value: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(value);
  const [status, setStatus] = useState<InlineEditStatus>("idle");

  useEffect(() => {
    if (!isEditing) {
      setDraftValue(value);
    }
  }, [isEditing, value]);

  async function commit(): Promise<void> {
    if (draftValue === value) {
      setIsEditing(false);
      return;
    }
    setStatus("saving");
    try {
      await onSave(draftValue);
      setIsEditing(false);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  function cancel(): void {
    setDraftValue(value);
    setIsEditing(false);
    setStatus("idle");
  }

  return (
    <div className={`detail-item site-inline-edit-item${isEditing ? " is-editing" : ""}`}>
      <span>{label}</span>
      {isEditing ? (
        <div className="site-inline-edit-control">
          <select
            className="site-inline-edit-input"
            autoFocus
            value={draftValue}
            onChange={(event) => {
              setDraftValue(event.target.value);
              setStatus("idle");
            }}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
          >
            {options.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
          {status !== "idle" ? <small className={`site-inline-edit-status is-${status}`}>{formatInlineEditStatus(status)}</small> : null}
        </div>
      ) : (
        <>
          <strong className="site-inline-edit-display">
            <span>{displayValue || "-"}</span>
            {canEdit ? (
              <button
                type="button"
                className="site-inline-edit-button"
                aria-label={`${label} bearbeiten`}
                onClick={() => {
                  setDraftValue(value);
                  setIsEditing(true);
                  setStatus("idle");
                }}
              >
                <Pencil aria-hidden="true" size={13} />
              </button>
            ) : null}
          </strong>
          {status === "saved" || status === "error" ? <small className={`site-inline-edit-status is-${status}`}>{formatInlineEditStatus(status)}</small> : null}
        </>
      )}
    </div>
  );
}

function startMeasurementTimesheetPerformanceTiming(): number | null {
  return isMeasurementTimesheetPerformanceLoggingEnabled() ? performance.now() : null;
}

function logMeasurementTimesheetPerformance(label: string, startedAt: number | null, details?: Record<string, unknown>): void {
  if (startedAt === null) {
    return;
  }
  const duration = performance.now() - startedAt;
  console.debug(`[Aufmaß Zeitenliste] ${label}: ${duration.toFixed(1)} ms`, details ?? {});
}

function isMeasurementTimesheetPerformanceLoggingEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem("beg_measurement_timesheet_perf") === "1";
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

function openBlobInNewTab(blob: Blob, openedWindow: Window | null): void {
  const url = window.URL.createObjectURL(blob);
  if (openedWindow) {
    openedWindow.location.href = url;
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
  window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
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

function normalizeSiteNotesInput(value: string): string | null {
  return value.trim() ? value : null;
}

function normalizeInlineEditText(value: string): string | null {
  return value.trim() ? value : null;
}

function formatSiteNotesSaveStatus(status: "idle" | "saving" | "saved" | "error"): string {
  if (status === "saving") {
    return "Speichert...";
  }
  if (status === "saved") {
    return "Gespeichert";
  }
  if (status === "error") {
    return "Fehler beim Speichern";
  }
  return "";
}

function formatInlineEditStatus(status: InlineEditStatus): string {
  if (status === "saving") {
    return "Speichert...";
  }
  if (status === "saved") {
    return "Gespeichert";
  }
  if (status === "error") {
    return "Fehler beim Speichern";
  }
  return "";
}

function getProjectManagerInlineOptions(
  people: Person[],
  currentProjectManager: Site["project_manager"],
): Array<{ value: string; label: string }> {
  const options = [
    { value: "", label: "Nicht zugeordnet" },
    ...people.map((person) => ({ value: String(person.id), label: person.display_name })),
  ];
  if (
    currentProjectManager
    && !options.some((option) => option.value === String(currentProjectManager.id))
  ) {
    options.splice(1, 0, {
      value: String(currentProjectManager.id),
      label: `${currentProjectManager.display_name} (aktuell zugeordnet)`,
    });
  }
  return options;
}

function compareExtraWorkTicketsNewestFirst(left: MobileExtraWorkTicket, right: MobileExtraWorkTicket): number {
  const rightTime = getExtraWorkTicketSortTime(right);
  const leftTime = getExtraWorkTicketSortTime(left);
  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }
  return right.sequence_number - left.sequence_number;
}

function getExtraWorkTicketSortTime(ticket: MobileExtraWorkTicket): number {
  const value = ticket.submitted_at ?? ticket.customer_signed_at ?? ticket.updated_at ?? ticket.created_at;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getExtraWorkTicketStatusBadge(ticket: MobileExtraWorkTicket): {
  label: string;
  className: string;
} {
  const status = ticket.status.toLowerCase();
  if (ticket.customer_signed_at || status === "signed") {
    return {
      label: "Unterschrieben",
      className: "measurement-status measurement-review-status-badge is-signed-review",
    };
  }
  if (status === "reviewed") {
    return { label: "Geprüft", className: "measurement-status measurement-review-status-badge is-reviewed" };
  }
  if (status === "submitted") {
    return { label: "Eingereicht", className: "measurement-status measurement-review-status-badge is-review-required" };
  }
  const labels: Record<string, string> = {
    draft: "Entwurf",
  };
  return {
    label: labels[status] ?? status,
    className: ["measurement-status", "measurement-review-status-badge", `is-${status}`].join(" "),
  };
}

function formatExtraWorkTicketTitle(ticket: MobileExtraWorkTicket): string {
  const suffix = ticket.title?.trim() || "Hauptauftrag";
  return `Zusatzauftrag ${ticket.display_number}${suffix ? ` - ${suffix}` : ""}`;
}

function formatExtraWorkTicketMeta(ticket: MobileExtraWorkTicket): string {
  const creator = ticket.created_by_name ? `Ersteller: ${ticket.created_by_name}` : "Ersteller: -";
  const created = ticket.created_at ? `Angelegt: ${formatDateTime(ticket.created_at)}` : null;
  const submitted = ticket.submitted_at ? `Eingereicht: ${formatDateTime(ticket.submitted_at)}` : null;
  return [creator, created, submitted].filter(Boolean).join(" · ");
}

function formatExtraWorkTicketPeriod(ticket: MobileExtraWorkTicket): string {
  const dateValue = ticket.submitted_at ?? ticket.created_at;
  return dateValue ? `Leistungsdatum: ${formatIsoDateOnly(dateValue)}` : "Leistungsdatum: -";
}

function formatExtraWorkTicketHours(ticket: MobileExtraWorkTicket): string {
  return `${formatMeasurementNumber(ticket.total_hours)} h`;
}

function formatExtraWorkTicketPdfFilename(site: Site, ticket: MobileExtraWorkTicket): string {
  const siteNumber = sanitizeDownloadPart(site.site_number || String(site.id));
  const ticketNumber = sanitizeDownloadPart(ticket.display_number || String(ticket.sequence_number));
  return `Zusatzauftrag_${siteNumber}_${ticketNumber}.pdf`;
}

function sanitizeDownloadPart(value: string): string {
  return value.trim().replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "ohne_nummer";
}

function formatIsoDateOnly(value: string): string {
  const dateKey = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? formatDateOnly(dateKey) : value;
}

function getMeasurementBatchStatusBadge(batch: MobileMeasurementBatch): {
  label: string;
  className: string;
} {
  const status = batch.status.toLowerCase();
  if (isMeasurementBatchBilled(status)) {
    return { label: "Abgeschlossen", className: "measurement-status measurement-review-status-badge is-billed" };
  }
  if (isCustomerSignedMeasurementBatch(batch)) {
    return {
      label: "Unterschrieben",
      className: "measurement-status measurement-review-status-badge is-signed-review",
    };
  }
  if (isMeasurementBatchOpen(status)) {
    return { label: "Eingereicht", className: "measurement-status measurement-review-status-badge is-review-required" };
  }
  const labels: Record<string, string> = {
    draft: "Entwurf",
    in_review: "Eingereicht",
    reviewed: "Geprüft",
    closed: "Abgeschlossen",
  };
  const normalizedStatus = status === "in_review" ? "review-required" : status;
  return {
    label: labels[status] ?? status,
    className: ["measurement-status", "measurement-review-status-badge", `is-${normalizedStatus}`].join(" "),
  };
}

function isMeasurementBatchBilled(status: string): boolean {
  return status === "billed" || status === "approved";
}

function isMeasurementBatchPdfExportable(status: string): boolean {
  return isMeasurementBatchBilled(status) || isMeasurementBatchReviewed(status) || status === "customer_signed";
}

function isMeasurementBatchReviewed(status: string): boolean {
  return status === "reviewed";
}

function isMeasurementBatchReviewRequired(batch: MobileMeasurementBatch): boolean {
  return isMeasurementBatchOpen(batch.status) && !isCustomerSignedMeasurementBatch(batch);
}

function isMeasurementBatchOpen(status: string): boolean {
  return status === "submitted" || status === "rejected" || status === "customer_signed";
}

function isCustomerSignedMeasurementBatch(batch: MobileMeasurementBatch): boolean {
  return Boolean(batch.customer_signed_at || batch.customer_signature_name || batch.is_locked_for_worker);
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

function formatSignedMeasurementDuration(minutes: number): string {
  if (minutes === 0) {
    return formatMeasurementDuration(0);
  }
  return `${minutes > 0 ? "+" : ""}${formatMeasurementDuration(minutes)}`;
}

function formatMeasurementAnalysisPeriod(start: string | null, end: string | null): string {
  if (!end) {
    return "-";
  }
  if (!start) {
    return `Bis ${formatDateTime(end)}`;
  }
  return `${formatDateTime(start)} bis ${formatDateTime(end)}`;
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

function getCurrentMonthRange(referenceDate = new Date()): { start: string; end: string } {
  return {
    start: toLocalDateKey(new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1)),
    end: toLocalDateKey(new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0)),
  };
}

function formatPlannedWorkHours(minutes: number | null): string {
  if (minutes === null || minutes === undefined) {
    return "";
  }
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : String(Number(hours.toFixed(2))).replace(".", ",");
}

function parsePlannedWorkHours(value: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  const parsed = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, error: "Soll-Stunden müssen eine Zahl ab 0 sein." };
  }
  return { ok: true, value: Math.round(parsed * 60) };
}

function sumTimeEntryMinutes(entries: TimeEntry[], field: "work_minutes" | "break_minutes" | "travel_minutes"): number {
  return entries.reduce((sum, entry) => sum + entry[field], 0);
}

function getSiteWorkTimeBalanceStatus(plannedMinutes: number | null, actualMinutes: number): SiteWorkTimeBalanceStatus {
  if (typeof plannedMinutes !== "number" || plannedMinutes <= 0) {
    return "missing";
  }
  const percent = (actualMinutes / plannedMinutes) * 100;
  if (percent > 100) {
    return "over";
  }
  if (percent >= 80) {
    return "near_limit";
  }
  return "within";
}

function siteWorkTimeBalanceLabel(status: SiteWorkTimeBalanceStatus): string {
  if (status === "within") {
    return "Im Rahmen";
  }
  if (status === "near_limit") {
    return "Soll fast erreicht";
  }
  if (status === "over") {
    return "Soll überschritten";
  }
  return "Sollwert fehlt";
}

function siteWorkTimeBalanceTone(status: SiteWorkTimeBalanceStatus): StatusBadgeTone {
  if (status === "within") {
    return "active";
  }
  if (status === "near_limit" || status === "over") {
    return "warning";
  }
  return "neutral";
}

function timeEntryStatusTone(status: TimeEntryStatus): StatusBadgeTone {
  if (status === "reviewed") {
    return "active";
  }
  if (status === "submitted") {
    return "planned";
  }
  return "neutral";
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

function readApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  if (typeof error.detail === "string") {
    return error.detail;
  }
  return error.message;
}
