import { ArrowLeft, Building2, CalendarClock, Download, ExternalLink, File as FileIcon, FileImage, FileSpreadsheet, FileText, Flag, Folder, Mail, MapPin, Pencil, Phone, Plus, Ruler, Search, UploadCloud, UserPlus, UserRound, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { canEditMainPage } from "../auth/permissions";
import { AddressSearch } from "../components/AddressSearch";
import { DashboardNotePicker } from "../components/DashboardNotePickers";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { SiteColorSelect } from "../components/SiteColorSelect";
import { SiteStatusBadge, StatusBadge, type StatusBadgeTone, siteStatusLabels } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import { containsDraggedFiles } from "../lib/fileDrag";
import {
  formatGermanDateKey as formatDateOnly,
  formatGermanDateTimeShort as formatDateTime,
} from "../lib/formatters";
import {
  DEFAULT_PROJECT_DOCUMENT_SORT,
  getProjectDocumentTypeLabel,
  getNextProjectDocumentSort,
  sortProjectDocumentItems,
  type ProjectDocumentSort,
  type ProjectDocumentSortKey,
} from "../lib/projectDocumentSort";
import { getProjectDocumentKind } from "../lib/projectFiles";
import { buildMeasurementPositionCatalog, getMeasurementPositionCatalogKey } from "../lib/measurementPositionCatalog";
import { buildDesktopMeasurementPositionGroups } from "../lib/measurementPositionGroups";
import {
  extraWorkStatusPromotionOptions,
  measurementStatusPromotionOptions,
  type ExtraWorkManualStatus,
  type MeasurementManualStatus,
  type ProjectRecordStatusOption,
} from "../lib/projectRecordStatuses";
import { DEFAULT_SITE_COLOR, getSiteColorDisplayValue } from "../lib/siteColors";
import type { AssignmentRead } from "../types/matrix";
import type { Customer, CustomerCreate } from "../types/customer";
import { calendarPersonCode, type Person } from "../types/person";
import type { MeasurementBase, MeasurementBaseUpdate, MeasurementEntry, MeasurementImportOptions, MeasurementItem, MeasurementItemUpdatePayload, MeasurementTimeAnalysis, MeasurementTimeAnalysisRow, MeasurementTimesheet, MeasurementWorkerOption, MobileExtraWorkTicket, MobileMeasurementBatch, MobileMeasurementFreeItemPayload, MobileMeasurementItem, OfficeMeasurementBatchPayload, ProjectFolder, ProjectFolderDocumentItem, ProjectFolderDocumentList, Site, SiteCreate, SiteUpdate } from "../types/site";
import type { TimeEntry, TimeEntryStatus } from "../types/timeEntry";
import { CustomerFields, normalizeCustomerPayload, validateCustomerPayload } from "./CustomersPage";
import { SiteFields, normalizeSitePayload, siteStatusOptions, toEditableSite, validateSitePayload } from "./SitesPage";
import type { EditableSite } from "./SitesPage";

type ProjectRecordTab = "overview" | "folders" | "assembly-times" | "measurement" | "extra-work" | "tools-material";
type MeasurementSubtab = "timesheet" | "review" | "time-analysis" | "bases";
type MeasurementPdfMode = "checked" | "original";
type SiteHoursComparisonStatus = "on_course" | "watch" | "critical" | "missing";
type SiteHoursComparison = {
  offerMinutes: number | null;
  valuedMeasurementMinutes: number | null;
  workerMinutes: number;
  offerDifferenceMinutes: number | null;
  valuedDifferenceMinutes: number | null;
  status: SiteHoursComparisonStatus;
};
type ProjectFolderNavigationLevel = {
  itemId: string;
  name: string;
  documents: ProjectFolderDocumentList;
};

const MEASUREMENT_TABLE_AXIS_WIDTH = 216;
const MEASUREMENT_TABLE_POSITION_WIDTH = 134;
const MEASUREMENT_TABLE_MIN_COLUMNS = 12;
const MEASUREMENT_FREE_INPUT_MIN_COLUMNS = 10;
const MEASUREMENT_BATCH_BEFORE_SUBMITTED_STATUSES = new Set(["draft"]);
const MEASUREMENT_BATCH_REVIEWED_STATUSES = new Set(["reviewed", "checked"]);
const MEASUREMENT_BATCH_BILLED_STATUSES = new Set(["billed", "approved", "closed", "completed", "finalized"]);
const MEASUREMENT_TABLE_MIN_AREA_ROWS = 12;
const MEASUREMENT_TIMESHEET_ROW_HEIGHT = 38;
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
  { key: "assembly-times", label: "Ausführungsstand" },
  { key: "measurement", label: "Aufmaß" },
  { key: "extra-work", label: "Zusatzaufträge" },
  { key: "tools-material", label: "Werkzeuge & Material" },
];

const timeEntryStatusLabels: Record<TimeEntryStatus, string> = {
  draft: "Entwurf",
  submitted: "Gemeldet",
  reviewed: "Geprüft",
};

const emptyCustomerForProjectRecord: CustomerCreate = {
  company_name: "",
  address_street: null,
  address_house_number: null,
  address_postal_code: null,
  address_city: null,
  address_country: "Deutschland",
  address_extra: null,
  address_formatted: null,
  address_latitude: null,
  address_longitude: null,
  address_location_status: "unchecked",
  company_phone: null,
  project_lead_name: null,
  project_lead_phone: null,
  project_lead_email: null,
  notes: null,
  is_active: true,
  contacts: [],
};

export function SiteDetailPage() {
  const { user } = useAuth();
  const canEditSite = canEditMainPage(user, "sites");
  const canOpenSharePointDirectly = user?.role === "admin" || user?.role === "project_manager" || user?.role === "office";
  const { siteId } = useParams();
  const location = useLocation();
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
  const [isSavingSiteStatus, setIsSavingSiteStatus] = useState(false);
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
  const [measurementCatalogItems, setMeasurementCatalogItems] = useState<MeasurementItem[]>([]);
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
  const [measurementHideError, setMeasurementHideError] = useState<string | null>(null);
  const [measurementHidingItemId, setMeasurementHidingItemId] = useState<number | null>(null);
  const [measurementSubtab, setMeasurementSubtab] = useState<MeasurementSubtab>("timesheet");
  const [measurementBatches, setMeasurementBatches] = useState<MobileMeasurementBatch[]>([]);
  const [measurementBatchesLoading, setMeasurementBatchesLoading] = useState(false);
  const [measurementBatchesLoaded, setMeasurementBatchesLoaded] = useState(false);
  const [measurementBatchesError, setMeasurementBatchesError] = useState<string | null>(null);
  const [measurementArchiveMode, setMeasurementArchiveMode] = useState(false);
  const [selectedMeasurementBatch, setSelectedMeasurementBatch] = useState<MobileMeasurementBatch | null>(null);
  const [measurementBatchItems, setMeasurementBatchItems] = useState<MobileMeasurementItem[]>([]);
  const [measurementWorkerHeadCount, setMeasurementWorkerHeadCount] = useState(0);
  const [measurementBatchItemsLoading, setMeasurementBatchItemsLoading] = useState(false);
  const [measurementReviewMessage, setMeasurementReviewMessage] = useState<string | null>(null);
  const [measurementReviewError, setMeasurementReviewError] = useState<string | null>(null);
  const [measurementReviewActionLoading, setMeasurementReviewActionLoading] = useState(false);
  const [measurementStatusActionId, setMeasurementStatusActionId] = useState<number | null>(null);
  const [measurementWorkers, setMeasurementWorkers] = useState<MeasurementWorkerOption[]>([]);
  const [measurementWorkersLoading, setMeasurementWorkersLoading] = useState(false);
  const [measurementWorkersLoaded, setMeasurementWorkersLoaded] = useState(false);
  const [measurementWorkersError, setMeasurementWorkersError] = useState<string | null>(null);
  const [extraWorkTickets, setExtraWorkTickets] = useState<MobileExtraWorkTicket[]>([]);
  const [extraWorkLoading, setExtraWorkLoading] = useState(false);
  const [extraWorkLoaded, setExtraWorkLoaded] = useState(false);
  const [extraWorkError, setExtraWorkError] = useState<string | null>(null);
  const [extraWorkPdfAction, setExtraWorkPdfAction] = useState<string | null>(null);
  const [deletingExtraWorkTicketId, setDeletingExtraWorkTicketId] = useState<number | null>(null);
  const [extraWorkStatusActionId, setExtraWorkStatusActionId] = useState<number | null>(null);

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
    setActiveTab(
      projectRecordTabs.some((tab) => tab.key === requestedProjectTab)
        ? requestedProjectTab as ProjectRecordTab
        : "overview",
    );
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
    setMeasurementCatalogItems([]);
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
    setMeasurementWorkers([]);
    setMeasurementWorkersLoading(false);
    setMeasurementWorkersLoaded(false);
    setMeasurementWorkersError(null);
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
      || (measurementSubtab !== "timesheet" && measurementSubtab !== "review")
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
        const [bases, catalogItems, timesheet] = await Promise.all([
          api.measurementBases(site.id),
          api.measurementItems(site.id, { activeOnly: true }),
          api.measurementTimesheet(site.id),
        ]);
        logMeasurementTimesheetPerformance("API Zeitenliste aggregiert", initialRequestsStartedAt, {
          bases: bases.length,
          catalogItems: catalogItems.length,
          activeBatches: timesheet.active_batch_ids.length,
          rows: timesheet.rows.length,
        });
        setMeasurementBases(bases);
        setMeasurementCatalogItems(catalogItems);
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
  }, [activeTab, measurementArchiveMode, measurementBatchesLoaded, measurementBatchesLoading, measurementSubtab, site]);

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

  async function loadMeasurementBatches(archivedOnly = measurementArchiveMode): Promise<void> {
    if (!site) {
      return;
    }
    setMeasurementBatchesLoading(true);
    setMeasurementBatchesError(null);
    try {
      setMeasurementBatches(await api.siteMeasurementBatches(site.id, { archivedOnly }));
      setMeasurementBatchesLoaded(true);
    } catch (requestError) {
      setMeasurementBatchesError(readApiError(requestError, "Aufmaßpakete konnten nicht geladen werden."));
    } finally {
      setMeasurementBatchesLoading(false);
    }
  }

  async function loadMeasurementWorkers(): Promise<void> {
    if (!site || measurementWorkersLoading || measurementWorkersLoaded) {
      return;
    }
    setMeasurementWorkersLoading(true);
    setMeasurementWorkersError(null);
    try {
      setMeasurementWorkers(await api.siteMeasurementWorkers(site.id));
      setMeasurementWorkersLoaded(true);
    } catch (requestError) {
      setMeasurementWorkersError(readApiError(requestError, "Monteure konnten nicht geladen werden."));
    } finally {
      setMeasurementWorkersLoading(false);
    }
  }

  async function createOfficeMeasurementBatch(
    payload: OfficeMeasurementBatchPayload,
  ): Promise<MobileMeasurementBatch> {
    if (!site) {
      throw new Error("Baustelle ist nicht geladen.");
    }
    const created = await api.createOfficeMeasurementBatch(site.id, payload);
    setMeasurementBatches((current) => {
      const withoutCreated = current.filter((batch) => batch.id !== created.id);
      return [...withoutCreated, created];
    });
    await selectMeasurementBatch(created);
    return created;
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
      setMeasurementBatchItems(orderMeasurementItemsByColumnPosition(
        await api.siteMeasurementBatchItems(site.id, batch.id),
      ));
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
      setMeasurementTimesheet(null);
      setMeasurementLoaded(false);
      setMeasurementBatchItems(orderMeasurementItemsByColumnPosition(
        await api.siteMeasurementBatchItems(site.id, batch.id),
      ));
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
      setMeasurementBatchItems(orderMeasurementItemsByColumnPosition(
        await api.siteMeasurementBatchItems(site.id, batch.id),
      ));
      setMeasurementReviewMessage(`${batch.title} wurde als geprüft markiert.`);
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Prüfstatus konnte nicht gespeichert werden."));
    } finally {
      setMeasurementReviewActionLoading(false);
    }
  }

  async function promoteMeasurementBatchStatus(
    batch: MobileMeasurementBatch,
    targetStatus: MeasurementManualStatus,
  ): Promise<void> {
    if (!site || !canEditSite || measurementStatusActionId !== null) {
      return;
    }
    setMeasurementStatusActionId(batch.id);
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      const updated = await api.promoteSiteMeasurementBatchStatus(site.id, batch.id, targetStatus);
      setMeasurementBatches((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setSelectedMeasurementBatch((current) => (current?.id === updated.id ? updated : current));
      setMeasurementTimesheet(null);
      setMeasurementLoaded(false);
      setMeasurementTimeAnalysis(null);
      setMeasurementTimeAnalysisLoaded(false);
      setMeasurementReviewMessage(`${batch.title}: Status wurde auf ${getMeasurementBatchStatusBadge(updated).label} gesetzt.`);
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Status konnte nicht aufgewertet werden."));
    } finally {
      setMeasurementStatusActionId(null);
    }
  }

  async function deleteMeasurementBatch(batch: MobileMeasurementBatch): Promise<void> {
    if (!site || measurementReviewActionLoading) {
      return;
    }
    const displayTitle = formatMeasurementPackageNumber(site.site_number, batch.number, batch.title);
    if (!window.confirm(`${displayTitle} wirklich löschen? Das Aufmaß wird ins Archiv verschoben und kann wiederhergestellt werden.`)) {
      return;
    }

    const wasSelectedBatch = selectedMeasurementBatch?.id === batch.id;
    setMeasurementReviewActionLoading(true);
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      await api.deleteSiteMeasurementBatch(site.id, batch.id);
      setMeasurementBatches((current) => current.filter((entry) => entry.id !== batch.id));
      setSelectedMeasurementBatch((current) => (current?.id === batch.id ? null : current));
      setMeasurementBatchItems((current) => (wasSelectedBatch ? [] : current));
      setMeasurementTimesheet(null);
      setMeasurementLoaded(false);
      setMeasurementTimeAnalysis(null);
      setMeasurementTimeAnalysisLoaded(false);
      setMeasurementTimeAnalysisError(null);
      setMeasurementReviewMessage(`${displayTitle} wurde gelöscht.`);
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Aufmaß konnte nicht gelöscht werden."));
      throw requestError;
    } finally {
      setMeasurementReviewActionLoading(false);
    }
  }

  async function restoreMeasurementBatch(batch: MobileMeasurementBatch): Promise<void> {
    if (!site || measurementReviewActionLoading) {
      return;
    }
    const displayTitle = formatMeasurementPackageNumber(site.site_number, batch.number, batch.title);
    setMeasurementReviewActionLoading(true);
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      await api.restoreSiteMeasurementBatch(site.id, batch.id);
      setMeasurementBatches((current) => current.filter((entry) => entry.id !== batch.id));
      setMeasurementTimesheet(null);
      setMeasurementLoaded(false);
      setMeasurementTimeAnalysis(null);
      setMeasurementTimeAnalysisLoaded(false);
      setMeasurementTimeAnalysisError(null);
      setMeasurementReviewMessage(`${displayTitle} wurde wiederhergestellt.`);
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Aufmaß konnte nicht wiederhergestellt werden."));
      throw requestError;
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

  async function createMeasurementFreeItem(
    batch: MobileMeasurementBatch,
    payload: MobileMeasurementFreeItemPayload,
  ): Promise<MobileMeasurementItem> {
    if (!site) {
      throw new Error("Baustelle ist nicht geladen.");
    }
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      const createdItem = await api.createSiteMeasurementFreeItem(site.id, batch.id, payload);
      setMeasurementBatchItems((current) => orderMeasurementItemsByColumnPosition([...current, createdItem]));
      return createdItem;
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Büro-Zusatzposition konnte nicht angelegt werden."));
      throw requestError;
    }
  }

  async function updateMeasurementFreeItem(
    batch: MobileMeasurementBatch,
    measurementItemId: number,
    payload: MeasurementItemUpdatePayload,
  ): Promise<MobileMeasurementItem> {
    if (!site) {
      throw new Error("Baustelle ist nicht geladen.");
    }
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      const updatedItem = await api.updateSiteMeasurementFreeItem(site.id, batch.id, measurementItemId, payload);
      setMeasurementBatchItems((current) => replaceMeasurementItem(current, updatedItem));
      setMeasurementTimesheet(null);
      setMeasurementLoaded(false);
      setMeasurementTimeAnalysis(null);
      setMeasurementTimeAnalysisLoaded(false);
      return updatedItem;
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Manuelle Positionsnummer konnte nicht gespeichert werden."));
      throw requestError;
    }
  }

  async function deleteMeasurementFreeItem(
    batch: MobileMeasurementBatch,
    measurementItemId: number,
  ): Promise<void> {
    if (!site) {
      return;
    }
    setMeasurementReviewMessage(null);
    setMeasurementReviewError(null);
    try {
      await api.deleteSiteMeasurementFreeItem(site.id, batch.id, measurementItemId);
      setMeasurementBatchItems((current) => current.filter((item) => item.id !== measurementItemId));
    } catch (requestError) {
      setMeasurementReviewError(readApiError(requestError, "Freie Position konnte nicht gelöscht werden."));
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
      setMeasurementBatchItems(orderMeasurementItemsByColumnPosition(
        await api.resetSiteMeasurementBatchToSubmitted(site.id, batch.id),
      ));
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

  async function deleteExtraWorkTicket(ticket: MobileExtraWorkTicket): Promise<void> {
    if (!site || deletingExtraWorkTicketId !== null || extraWorkPdfAction) {
      return;
    }
    const displayTitle = formatExtraWorkTicketTitle(ticket);
    if (!window.confirm(`${displayTitle} wirklich löschen?`)) {
      return;
    }
    if (!window.confirm("Endgültig löschen? Dieser Vorgang kann nicht rückgängig gemacht werden.")) {
      return;
    }

    setDeletingExtraWorkTicketId(ticket.id);
    setExtraWorkError(null);
    try {
      await api.deleteSiteExtraWorkTicket(site.id, ticket.id);
      setExtraWorkTickets((current) => current.filter((entry) => entry.id !== ticket.id));
    } catch (requestError) {
      setExtraWorkError(readApiError(requestError, "Zusatzauftrag konnte nicht gelöscht werden."));
    } finally {
      setDeletingExtraWorkTicketId(null);
    }
  }

  async function promoteExtraWorkTicketStatus(
    ticket: MobileExtraWorkTicket,
    targetStatus: ExtraWorkManualStatus,
  ): Promise<void> {
    if (!site || !canEditSite || extraWorkStatusActionId !== null) {
      return;
    }
    setExtraWorkStatusActionId(ticket.id);
    setExtraWorkError(null);
    try {
      const updated = await api.promoteSiteExtraWorkTicketStatus(site.id, ticket.id, targetStatus);
      setExtraWorkTickets((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (requestError) {
      setExtraWorkError(readApiError(requestError, "Status konnte nicht aufgewertet werden."));
    } finally {
      setExtraWorkStatusActionId(null);
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
      setMeasurementCatalogItems(await api.measurementItems(site.id, { activeOnly: true }));
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
      const [catalogItems, timesheet] = await Promise.all([
        api.measurementItems(site.id, { activeOnly: true }),
        api.measurementTimesheet(site.id),
      ]);
      setMeasurementBases(bases);
      setMeasurementCatalogItems(catalogItems);
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
      const [catalogItems, timesheet] = await Promise.all([
        api.measurementItems(site.id, { activeOnly: true }),
        api.measurementTimesheet(site.id),
      ]);
      setMeasurementBases(bases);
      setMeasurementCatalogItems(catalogItems);
      setMeasurementTimesheet(timesheet);
      setMeasurementBatches([]);
      setMeasurementBatchesLoaded(false);
      setMeasurementImportMessage("Angebot wurde gelöscht.");
    } catch (requestError) {
      setMeasurementImportError(readApiError(requestError, "Angebot konnte nicht gelöscht werden."));
    }
  }

  async function hideMeasurementItem(measurementItemId: number): Promise<void> {
    if (!site || !canEditSite || measurementHidingItemId !== null) {
      return;
    }
    setMeasurementHidingItemId(measurementItemId);
    setMeasurementHideError(null);
    setMeasurementImportMessage(null);
    try {
      await api.hideMeasurementItem(site.id, measurementItemId);
      const [bases, catalogItems, timesheet] = await Promise.all([
        api.measurementBases(site.id),
        api.measurementItems(site.id, { activeOnly: true }),
        api.measurementTimesheet(site.id),
      ]);
      setMeasurementBases(bases);
      setMeasurementCatalogItems(catalogItems);
      setMeasurementTimesheet(timesheet);
      setMeasurementBatches([]);
      setMeasurementBatchesLoaded(false);
    } catch (requestError) {
      setMeasurementHideError(readApiError(requestError, "Aufmaßposition konnte nicht ausgeblendet werden."));
    } finally {
      setMeasurementHidingItemId(null);
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
      const selectedBatchId = selectedMeasurementBatch?.id ?? null;
      const [bases, catalogItems, timesheet, selectedBatchItems] = await Promise.all([
        api.measurementBases(site.id),
        api.measurementItems(site.id, { activeOnly: true }),
        api.measurementTimesheet(site.id),
        selectedBatchId === null
          ? Promise.resolve(null)
          : api.siteMeasurementBatchItems(site.id, selectedBatchId),
      ]);
      setMeasurementBases(bases);
      setMeasurementCatalogItems(catalogItems);
      setMeasurementTimesheet(timesheet);
      if (selectedBatchItems !== null) {
        setMeasurementBatchItems(orderMeasurementItemsByColumnPosition(selectedBatchItems));
      }
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

  async function updateSiteHeaderStatus(nextStatus: Site["status"]): Promise<void> {
    if (!site || !canEditSite || site.status === nextStatus || isSavingSiteStatus) {
      return;
    }
    setIsSavingSiteStatus(true);
    setSiteSaveError(null);
    setSiteSaveMessage(null);
    try {
      const updated = await api.updateSite(site.id, { status: nextStatus });
      setSite(updated);
      setSiteDraft(toEditableSite(updated));
      setSiteSaveMessage(`Status aktualisiert: ${siteStatusLabels[updated.status]}.`);
    } catch (requestError) {
      setSiteSaveError(readApiError(requestError, "Status konnte nicht gespeichert werden."));
    } finally {
      setIsSavingSiteStatus(false);
    }
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
  const isMeasurementTimesheetWorkspace = activeTab === "measurement" && measurementSubtab === "timesheet";

  return (
    <section
      className={`site-detail-page is-project-file-workspace${isMeasurementReviewWorkspace ? " is-measurement-review-workspace" : ""}${isMeasurementTimesheetWorkspace ? " is-measurement-timesheet-workspace" : ""}`}
    >
      <Link className="back-link" to={siteDetailBackPath}>
        <ArrowLeft aria-hidden="true" size={16} />
        <span>Baustellen</span>
      </Link>

      <div className="site-detail-header">
        <span className="site-color large" style={{ backgroundColor: getSiteColorDisplayValue(site.color) }} />
        <div>
          <p className="eyebrow">Projektakte</p>
          <EditableSiteHeaderName
            name={site.name}
            canEdit={canEditSite}
            disabled={isSavingSite}
            onSave={(name) => saveSiteInline({ name })}
          />
          <p>{[site.site_number, site.customer].filter(Boolean).join(" - ")}</p>
        </div>
        <div className="site-detail-header-actions">
          {canEditSite ? (
            <select
              aria-label={`Status fuer ${site.name} aendern`}
              className={`site-detail-status-select site-card-status-select status-badge-${site.status}`}
              disabled={isSavingSiteStatus}
              value={site.status}
              onChange={(event) => void updateSiteHeaderStatus(event.target.value as Site["status"])}
            >
              {siteStatusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <SiteStatusBadge status={site.status} />
          )}
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
          onUploadFiles={uploadFilesToFolder}
          onDragOverFolder={setDragOverFolderKey}
          onRetry={() => {
            setFoldersLoaded(false);
            setFoldersError(null);
          }}
          onRetryDocuments={() => setFolderDocumentsReloadKey((value) => value + 1)}
        />
      ) : null}
      {activeTab === "assembly-times" ? (
        <SiteWorkTimesPanel site={site} />
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
            if (subtab !== "review") {
              setMeasurementArchiveMode(false);
            }
          }}
          bases={measurementBases}
          catalogItems={measurementCatalogItems}
          canCreateBatch={canEditSite}
          canPromoteStatus={canEditSite}
          timesheet={measurementTimesheet}
          timeAnalysis={measurementTimeAnalysis}
          timeAnalysisLoading={measurementTimeAnalysisLoading}
          timeAnalysisError={measurementTimeAnalysisError}
          canHideItems={canEditSite}
          isLoading={measurementLoading}
          error={measurementError}
          isImporting={measurementImporting}
          importMessage={measurementImportMessage}
          importError={measurementImportError}
          hideError={measurementHideError}
          hidingItemId={measurementHidingItemId}
          onImport={importMeasurementTimesheet}
          onUpdateBase={(base, payload) => void updateMeasurementBase(base, payload)}
          onActivateBase={(base) => void activateMeasurementBase(base)}
          onDeleteBase={(base) => void deleteMeasurementBase(base)}
          onHideItem={(measurementItemId) => void hideMeasurementItem(measurementItemId)}
          onRetry={() => {
            setMeasurementLoaded(false);
            setMeasurementCatalogItems([]);
            setMeasurementTimesheet(null);
            setMeasurementError(null);
            setMeasurementHideError(null);
          }}
          onRetryTimeAnalysis={() => {
            setMeasurementTimeAnalysisLoaded(false);
            setMeasurementTimeAnalysis(null);
            setMeasurementTimeAnalysisError(null);
          }}
          batches={measurementBatches}
          measurementWorkers={measurementWorkers}
          measurementWorkersLoading={measurementWorkersLoading}
          measurementWorkersError={measurementWorkersError}
          workerHeadCount={measurementWorkerHeadCount}
          batchesLoading={measurementBatchesLoading}
          batchesError={measurementBatchesError}
          selectedBatch={selectedMeasurementBatch}
          batchItems={measurementBatchItems}
          batchItemsLoading={measurementBatchItemsLoading}
          reviewMessage={measurementReviewMessage}
          reviewError={measurementReviewError}
          reviewActionLoading={measurementReviewActionLoading}
          statusActionId={measurementStatusActionId}
          archiveMode={measurementArchiveMode}
          onRetryBatches={() => {
            setMeasurementBatchesLoaded(false);
            setMeasurementBatchesError(null);
          }}
          onLoadMeasurementWorkers={() => void loadMeasurementWorkers()}
          onCreateBatch={createOfficeMeasurementBatch}
          onToggleArchive={() => {
            const nextArchiveMode = !measurementArchiveMode;
            setMeasurementArchiveMode(nextArchiveMode);
            setMeasurementBatches([]);
            setMeasurementBatchesLoaded(false);
            setMeasurementBatchesError(null);
            setSelectedMeasurementBatch(null);
            setMeasurementBatchItems([]);
            setMeasurementReviewMessage(null);
            setMeasurementReviewError(null);
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
          onPromoteStatus={(batch, status) => void promoteMeasurementBatchStatus(batch, status)}
          onDeleteBatch={deleteMeasurementBatch}
          onRestoreBatch={restoreMeasurementBatch}
          onUpdateEntry={updateMeasurementEntry}
          onCreateEntry={createMeasurementEntry}
          onCreateFreeItem={createMeasurementFreeItem}
          onUpdateFreeItem={updateMeasurementFreeItem}
          onDeleteFreeItem={deleteMeasurementFreeItem}
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
          deletingTicketId={deletingExtraWorkTicketId}
          statusActionId={extraWorkStatusActionId}
          canPromoteStatus={canEditSite}
          onRetry={() => {
            setExtraWorkLoaded(false);
            setExtraWorkError(null);
          }}
          onOpenPdf={(ticket) => void handleExtraWorkTicketPdf(ticket, "open")}
          onDownloadPdf={(ticket) => void handleExtraWorkTicketPdf(ticket, "download")}
          onDeleteTicket={(ticket) => void deleteExtraWorkTicket(ticket)}
          onPromoteStatus={(ticket, status) => void promoteExtraWorkTicketStatus(ticket, status)}
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
              <CustomerAssignmentDetailItem
                label="Kunde"
                site={site}
                canEdit={canEdit}
                onSaveCustomer={(customer) => onSaveField({ customer_id: customer.id, customer: customer.company_name })}
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
              {canEdit && draft ? (
                <AddressSearch
                  className="site-detail-address-search"
                  disabled={isSaving}
                  onSelect={(result) => {
                    const selectedValues: Partial<SiteCreate> = {
                      address: result.label,
                      postal_code: result.postal_code,
                      city: result.city,
                      location: result.city ?? draft.location,
                      street: result.street,
                      house_number: result.house_number,
                      latitude: result.latitude,
                      longitude: result.longitude,
                      location_status: "geocoded",
                    };
                    onDraftChange(selectedValues);
                    onGeocodeSelected?.(selectedValues);
                  }}
                />
              ) : null}
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
              <DetailItem label="Kuerzel" value={site.project_manager ? calendarPersonCode(site.project_manager) : null} />
              <DetailItem label="Telefon" value={site.project_manager?.phone} icon={Phone} />
            </DetailSection>

            <DetailSection title="Planstatus" icon={CalendarClock}>
              <DetailItem label="Angelegt" value={formatDateTime(site.created_at)} />
              <DetailItem label="Geschlossen" value={site.closed_at ? formatDateTime(site.closed_at) : null} />
              <SiteColorDetailItem
                label="Farbe"
                value={site.color ?? DEFAULT_SITE_COLOR}
                canEdit={canEdit}
                disabled={isSaving}
                onSave={(color) => onSaveField({ color })}
              />
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
  onUploadFiles: (folder: ProjectFolder, files: FileList | File[]) => Promise<void>;
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
                      void onUploadFiles(folder, event.dataTransfer.files);
                    }}
                    title={`${folder.sort_order}. ${folder.name} Dateien anzeigen`}
                  >
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
  onUpload: (files: FileList | File[]) => Promise<void>;
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
  const [documentSort, setDocumentSort] = useState<ProjectDocumentSort>(() => ({
    ...DEFAULT_PROJECT_DOCUMENT_SORT,
  }));
  const [isFileDropActive, setIsFileDropActive] = useState(false);
  const fileDragDepthRef = useRef(0);
  const fileDropUploadPendingRef = useRef(false);

  function resetFileDropState(): void {
    fileDragDepthRef.current = 0;
    setIsFileDropActive(false);
  }

  useEffect(() => {
    setDocumentSort({ ...DEFAULT_PROJECT_DOCUMENT_SORT });
  }, [siteId]);

  useEffect(() => {
    setQuery("");
    setFolderStack([]);
    setFolderNavigationError(null);
    setOpenError(null);
    setDownloadError(null);
    resetFileDropState();
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
      resetFileDropState();
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
    resetFileDropState();
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
    const filteredItems = normalizedQuery
      ? currentDocuments.items.filter((item) => (
          [item.name, item.file_extension, item.mime_type]
            .filter(Boolean)
            .some((value) => value?.toLowerCase().includes(normalizedQuery))
        ))
      : currentDocuments.items;
    return sortProjectDocumentItems(filteredItems, documentSort);
  }, [currentDocuments, documentSort, normalizedQuery]);
  const hasLoadedItems = Boolean(currentDocuments && currentDocuments.items.length > 0);
  const isCurrentLoading = isInSubfolder ? folderNavigationLoading : isLoading;
  const canUploadToCurrentFolder = hasSharePointFolder && !isInSubfolder;

  function handleDocumentSort(key: ProjectDocumentSortKey): void {
    setDocumentSort((currentSort) => getNextProjectDocumentSort(currentSort, key));
  }

  function handleFileDragEnter(event: ReactDragEvent<HTMLElement>): void {
    if (!containsDraggedFiles(event.dataTransfer.types)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!canUploadToCurrentFolder || isUploading || fileDropUploadPendingRef.current) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    fileDragDepthRef.current += 1;
    setIsFileDropActive(true);
  }

  function handleFileDragOver(event: ReactDragEvent<HTMLElement>): void {
    if (!containsDraggedFiles(event.dataTransfer.types)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = canUploadToCurrentFolder && !isUploading && !fileDropUploadPendingRef.current
      ? "copy"
      : "none";
  }

  function handleFileDragLeave(event: ReactDragEvent<HTMLElement>): void {
    if (fileDragDepthRef.current === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) {
      setIsFileDropActive(false);
    }
  }

  function handleFileDrop(event: ReactDragEvent<HTMLElement>): void {
    if (!containsDraggedFiles(event.dataTransfer.types)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    resetFileDropState();
    if (!canUploadToCurrentFolder || isUploading || fileDropUploadPendingRef.current || event.dataTransfer.files.length === 0) {
      return;
    }
    fileDropUploadPendingRef.current = true;
    void onUpload(event.dataTransfer.files).finally(() => {
      fileDropUploadPendingRef.current = false;
    });
  }

  return (
    <aside
      className={`project-document-browser${isFileDropActive ? " is-file-drag-over" : ""}`}
      aria-live="polite"
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDragEnd={resetFileDropState}
      onDrop={handleFileDrop}
    >
      {isFileDropActive ? (
        <div className="project-document-drop-overlay" role="status">
          <UploadCloud aria-hidden="true" size={30} />
          <strong>Dateien hier ablegen</strong>
        </div>
      ) : null}
      <div className="project-document-browser-header">
        <div className="project-document-browser-title">
          <span>Ordner {folder.sort_order}</span>
          <h3>{currentFolderTitle}</h3>
        </div>
        <div className="project-document-browser-actions">
          {hasSharePointFolder ? (
            <label className="project-document-search">
              <Search aria-hidden="true" size={15} />
              <input
                type="search"
                value={query}
                placeholder="Suchen ..."
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          ) : null}
          {isInSubfolder ? (
            <button type="button" className="secondary-action" onClick={handleBackToParentFolder}>
              <ArrowLeft aria-hidden="true" size={15} />
              <span>Zurück</span>
            </button>
          ) : null}
          {hasSharePointFolder && !isInSubfolder ? (
            <label className={`secondary-action project-upload-action${isUploading ? " is-disabled" : ""}`}>
              <UploadCloud aria-hidden="true" size={15} />
              <span>{isUploading ? "Lädt..." : "Hochladen"}</span>
              <input
                className="project-upload-input"
                type="file"
                disabled={isUploading}
                onChange={(event) => {
                  if (event.target.files) {
                    void onUpload(event.target.files);
                    event.target.value = "";
                  }
                }}
              />
            </label>
          ) : null}
          {canOpenSharePointDirectly && !isInSubfolder && folder.external_web_url ? (
            <a className="secondary-action project-document-open-action" href={folder.external_web_url} target="_blank" rel="noreferrer">
              <Folder aria-hidden="true" size={15} />
              <span>Ordner</span>
            </a>
          ) : null}
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
        <div className="project-document-table-wrap">
          <table className="project-document-table">
            <thead>
              <tr>
                <ProjectDocumentSortHeader
                  label="Dateiname"
                  sortKey="name"
                  activeSort={documentSort}
                  onSort={handleDocumentSort}
                />
                <ProjectDocumentSortHeader
                  label="Typ"
                  sortKey="type"
                  activeSort={documentSort}
                  onSort={handleDocumentSort}
                />
                <ProjectDocumentSortHeader
                  label="Hochgeladen"
                  sortKey="uploaded"
                  activeSort={documentSort}
                  onSort={handleDocumentSort}
                />
                <th aria-label="Aktionen"></th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((item) => (
                <tr key={item.id || item.name} className="project-document-row">
                  <td>
                    <div className="project-document-name-cell">
                      <DocumentTypeIcon item={item} />
                      <strong>{item.name}</strong>
                    </div>
                  </td>
                  <td>{formatProjectDocumentType(item)}</td>
                  <td>{formatProjectDocumentUploaded(item)}</td>
                  <td>
                    <div className="project-document-item-actions">
                      {item.is_folder ? (
                        <button
                          type="button"
                          className="secondary-action project-document-open-action"
                          disabled={folderNavigationLoading}
                          onClick={() => void handleOpenFolder(item)}
                        >
                          <Folder aria-hidden="true" size={14} />
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
                          <ExternalLink aria-hidden="true" size={14} />
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
                          <Download aria-hidden="true" size={14} />
                          <span>{downloadingItemId === item.id ? "Lädt..." : "Download"}</span>
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </aside>
  );
}

function ProjectDocumentSortHeader({
  label,
  sortKey,
  activeSort,
  onSort,
}: {
  label: string;
  sortKey: ProjectDocumentSortKey;
  activeSort: ProjectDocumentSort;
  onSort: (key: ProjectDocumentSortKey) => void;
}) {
  const isActive = activeSort.key === sortKey;
  const ariaSort = isActive
    ? activeSort.direction === "asc" ? "ascending" : "descending"
    : "none";
  const nextDirection = isActive
    ? activeSort.direction === "asc" ? "absteigend" : "aufsteigend"
    : sortKey === "uploaded" ? "absteigend" : "aufsteigend";

  return (
    <th scope="col" aria-sort={ariaSort}>
      <button
        type="button"
        className={`project-document-sort-trigger${isActive ? " is-active" : ""}`}
        aria-label={`${label} ${nextDirection} sortieren`}
        onClick={() => onSort(sortKey)}
      >
        <span>{label}</span>
        {isActive ? (
          <span className="project-document-sort-indicator" aria-hidden="true">
            {activeSort.direction === "asc" ? "↑" : "↓"}
          </span>
        ) : null}
      </button>
    </th>
  );
}

function formatProjectDocumentType(item: ProjectFolderDocumentItem): string {
  return getProjectDocumentTypeLabel(item) ?? "Datei";
}

function formatProjectDocumentUploaded(item: ProjectFolderDocumentItem): string {
  return item.created_date_time ? formatDateTime(item.created_date_time) : "-";
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

function ProjectRecordStatusControl<T extends string>({
  active,
  ariaLabel,
  busy,
  label,
  options,
  onClose,
  onSelect,
  onToggle,
}: {
  active: boolean;
  ariaLabel: string;
  busy: boolean;
  label: string;
  options: ProjectRecordStatusOption<T>[];
  onClose: () => void;
  onSelect: (status: T) => void;
  onToggle: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!active) {
      return undefined;
    }
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = 190;
      const estimatedHeight = 34 + options.length * 32;
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
      const opensAbove = window.innerHeight - rect.bottom < estimatedHeight + 8 && rect.top > estimatedHeight;
      const top = opensAbove
        ? rect.top - estimatedHeight - 4
        : Math.min(window.innerHeight - estimatedHeight - 8, rect.bottom + 4);
      setPosition({ left, top: Math.max(8, top) });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [active, options.length]);

  useEffect(() => {
    if (!active) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) onClose();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [active, onClose]);

  if (options.length === 0) {
    return <span className="measurement-review-status-label">{label}</span>;
  }

  return (
    <>
      <button
        ref={triggerRef}
        aria-expanded={active}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        className="measurement-review-status-label measurement-review-status-trigger"
        disabled={busy}
        type="button"
        onClick={onToggle}
      >
        <span>{busy ? "Speichert..." : label}</span>
        <span aria-hidden="true" className="measurement-review-status-caret">⌄</span>
      </button>
      {active ? createPortal(
        <div
          ref={popoverRef}
          aria-label="Status aufwerten"
          className="project-record-status-popover"
          role="menu"
          style={{ left: position.left, top: position.top }}
        >
          <strong>Status setzen auf</strong>
          {options.map((option) => (
            <button key={option.value} role="menuitem" type="button" onClick={() => onSelect(option.value)}>
              {option.label}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function ExtraWorkTab({
  site,
  tickets,
  isLoading,
  error,
  pdfAction,
  deletingTicketId,
  statusActionId,
  canPromoteStatus,
  onRetry,
  onOpenPdf,
  onDownloadPdf,
  onDeleteTicket,
  onPromoteStatus,
}: {
  site: Site;
  tickets: MobileExtraWorkTicket[];
  isLoading: boolean;
  error: string | null;
  pdfAction: string | null;
  deletingTicketId: number | null;
  statusActionId: number | null;
  canPromoteStatus: boolean;
  onRetry: () => void;
  onOpenPdf: (ticket: MobileExtraWorkTicket) => void;
  onDownloadPdf: (ticket: MobileExtraWorkTicket) => void;
  onDeleteTicket: (ticket: MobileExtraWorkTicket) => void;
  onPromoteStatus: (ticket: MobileExtraWorkTicket, status: ExtraWorkManualStatus) => void;
}) {
  const [openStatusTicketId, setOpenStatusTicketId] = useState<number | null>(null);
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
            const isDeleting = deletingTicketId === ticket.id;
            const statusOptions = canPromoteStatus
              ? extraWorkStatusPromotionOptions(ticket.status, ticket.customer_signed_at)
              : [];
            return (
              <div
                key={ticket.id}
                className={`measurement-review-card project-extra-work-card has-delete-action${ticket.status === "submitted" ? " is-submitted" : ""}`}
              >
                <div className="measurement-review-card-controls">
                  <span className={`${statusBadge.className} has-delete-control`}>
                    <button
                      type="button"
                      className="measurement-review-delete-action"
                      disabled={deletingTicketId !== null || isPdfBusy}
                      title="Zusatzauftrag löschen"
                      aria-label={`${formatExtraWorkTicketTitle(ticket)} löschen`}
                      onClick={() => onDeleteTicket(ticket)}
                    >
                      {isDeleting ? "..." : "×"}
                    </button>
                    <ProjectRecordStatusControl
                      active={openStatusTicketId === ticket.id}
                      ariaLabel={`${formatExtraWorkTicketTitle(ticket)}: Status ${statusBadge.label}`}
                      busy={statusActionId === ticket.id}
                      label={statusBadge.label}
                      options={statusOptions}
                      onClose={() => setOpenStatusTicketId(null)}
                      onSelect={(status) => {
                        setOpenStatusTicketId(null);
                        onPromoteStatus(ticket, status);
                      }}
                      onToggle={() => setOpenStatusTicketId((current) => (current === ticket.id ? null : ticket.id))}
                    />
                  </span>
                </div>
                <button
                  type="button"
                  className="measurement-review-card-open"
                  onClick={() => onOpenPdf(ticket)}
                >
                  <div className="measurement-review-card-main">
                    <div className="measurement-review-card-title-row">
                      <strong>{formatExtraWorkTicketTitle(ticket)}</strong>
                    </div>
                    <CustomerEmailStatusLine item={ticket} />
                    <small className="measurement-review-submitter-status">{formatExtraWorkTicketSubmitter(ticket)}</small>
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
  catalogItems,
  canCreateBatch,
  canPromoteStatus,
  timesheet,
  timeAnalysis,
  timeAnalysisLoading,
  timeAnalysisError,
  canHideItems,
  isLoading,
  error,
  isImporting,
  importMessage,
  importError,
  hideError,
  hidingItemId,
  onImport,
  onUpdateBase,
  onActivateBase,
  onDeleteBase,
  onHideItem,
  onRetry,
  onRetryTimeAnalysis,
  batches,
  measurementWorkers,
  measurementWorkersLoading,
  measurementWorkersError,
  workerHeadCount,
  batchesLoading,
  batchesError,
  selectedBatch,
  batchItems,
  batchItemsLoading,
  reviewMessage,
  reviewError,
  reviewActionLoading,
  statusActionId,
  archiveMode,
  onRetryBatches,
  onLoadMeasurementWorkers,
  onCreateBatch,
  onToggleArchive,
  onSelectBatch,
  onBackToBatchList,
  onMarkBilled,
  onMarkOpen,
  onMarkReviewed,
  onPromoteStatus,
  onDeleteBatch,
  onRestoreBatch,
  onUpdateEntry,
  onCreateEntry,
  onCreateFreeItem,
  onUpdateFreeItem,
  onDeleteFreeItem,
  onResetToSubmitted,
  onExportPdf,
}: {
  siteNumber: string | null;
  activeSubtab: MeasurementSubtab;
  onSubtabChange: (subtab: MeasurementSubtab) => void;
  bases: MeasurementBase[];
  catalogItems: MeasurementItem[];
  canCreateBatch: boolean;
  canPromoteStatus: boolean;
  timesheet: MeasurementTimesheet | null;
  timeAnalysis: MeasurementTimeAnalysis | null;
  timeAnalysisLoading: boolean;
  timeAnalysisError: string | null;
  canHideItems: boolean;
  isLoading: boolean;
  error: string | null;
  isImporting: boolean;
  importMessage: string | null;
  importError: string | null;
  hideError: string | null;
  hidingItemId: number | null;
  onImport: (file: File, options: MeasurementImportOptions) => Promise<void>;
  onUpdateBase: (base: MeasurementBase, payload: MeasurementBaseUpdate) => void;
  onActivateBase: (base: MeasurementBase) => void;
  onDeleteBase: (base: MeasurementBase) => void;
  onHideItem: (measurementItemId: number) => void;
  onRetry: () => void;
  onRetryTimeAnalysis: () => void;
  batches: MobileMeasurementBatch[];
  measurementWorkers: MeasurementWorkerOption[];
  measurementWorkersLoading: boolean;
  measurementWorkersError: string | null;
  workerHeadCount: number;
  batchesLoading: boolean;
  batchesError: string | null;
  selectedBatch: MobileMeasurementBatch | null;
  batchItems: MobileMeasurementItem[];
  batchItemsLoading: boolean;
  reviewMessage: string | null;
  reviewError: string | null;
  reviewActionLoading: boolean;
  statusActionId: number | null;
  archiveMode: boolean;
  onRetryBatches: () => void;
  onLoadMeasurementWorkers: () => void;
  onCreateBatch: (payload: OfficeMeasurementBatchPayload) => Promise<MobileMeasurementBatch>;
  onToggleArchive: () => void;
  onSelectBatch: (batch: MobileMeasurementBatch) => void;
  onBackToBatchList: () => void;
  onMarkBilled: (batch: MobileMeasurementBatch) => void;
  onMarkOpen: (batch: MobileMeasurementBatch) => void;
  onMarkReviewed: (batch: MobileMeasurementBatch) => void;
  onPromoteStatus: (batch: MobileMeasurementBatch, status: MeasurementManualStatus) => void;
  onDeleteBatch: (batch: MobileMeasurementBatch) => Promise<void>;
  onRestoreBatch: (batch: MobileMeasurementBatch) => Promise<void>;
  onUpdateEntry: (batch: MobileMeasurementBatch, entryId: number, payload: { area_or_comment: string; quantity: number }) => Promise<void>;
  onCreateEntry: (batch: MobileMeasurementBatch, measurementItemId: number, payload: { area_or_comment: string; quantity: number }) => Promise<void>;
  onCreateFreeItem: (batch: MobileMeasurementBatch, payload: MobileMeasurementFreeItemPayload) => Promise<MobileMeasurementItem>;
  onUpdateFreeItem: (batch: MobileMeasurementBatch, measurementItemId: number, payload: MeasurementItemUpdatePayload) => Promise<MobileMeasurementItem>;
  onDeleteFreeItem: (batch: MobileMeasurementBatch, measurementItemId: number) => Promise<void>;
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
  const projectPositionSuggestions = useMemo<MeasurementPositionSuggestion[]>(
    () => buildMeasurementPositionCatalog(catalogItems).map((item) => ({
      ...item,
      linkedItem: {
        id: item.id,
        position: item.position,
      },
    })),
    [catalogItems],
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
          <span>{isDropTargetActive ? "PDF hier ablegen" : "Zeitenliste importieren"}</span>
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
          catalogItems={catalogItems}
          workerHeadCount={workerHeadCount}
          isLoading={isLoading}
          error={error}
          fileSelectionError={fileSelectionError}
          isImportDialogOpen={isImportDialogOpen}
          importMessage={importMessage}
          importError={importError}
          canHideItems={canHideItems}
          hideError={hideError}
          hidingItemId={hidingItemId}
          onRetry={onRetry}
          onHideItem={onHideItem}
        />
      ) : null}

      {activeSubtab === "review" ? (
        <MeasurementReviewPanel
          siteNumber={siteNumber}
          projectPositionSuggestions={projectPositionSuggestions}
          canCreateBatch={canCreateBatch}
          canPromoteStatus={canPromoteStatus}
          batches={batches}
          measurementWorkers={measurementWorkers}
          measurementWorkersLoading={measurementWorkersLoading}
          measurementWorkersError={measurementWorkersError}
          batchesLoading={batchesLoading}
          batchesError={batchesError}
          selectedBatch={selectedBatch}
          batchItems={batchItems}
          batchItemsLoading={batchItemsLoading}
          reviewMessage={reviewMessage}
          reviewError={reviewError}
          reviewActionLoading={reviewActionLoading}
          statusActionId={statusActionId}
          archiveMode={archiveMode}
          onRetryBatches={onRetryBatches}
          onLoadMeasurementWorkers={onLoadMeasurementWorkers}
          onCreateBatch={onCreateBatch}
          onToggleArchive={onToggleArchive}
          onSelectBatch={onSelectBatch}
          onBackToBatchList={onBackToBatchList}
          onMarkBilled={onMarkBilled}
          onMarkOpen={onMarkOpen}
          onMarkReviewed={onMarkReviewed}
          onPromoteStatus={onPromoteStatus}
          onDeleteBatch={onDeleteBatch}
          onRestoreBatch={onRestoreBatch}
          onUpdateEntry={onUpdateEntry}
          onCreateEntry={onCreateEntry}
          onCreateFreeItem={onCreateFreeItem}
          onUpdateFreeItem={onUpdateFreeItem}
          onDeleteFreeItem={onDeleteFreeItem}
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
  catalogItems,
  workerHeadCount,
  isLoading,
  error,
  fileSelectionError,
  isImportDialogOpen,
  importMessage,
  importError,
  canHideItems,
  onRetry,
  hideError,
  hidingItemId,
  onHideItem,
}: {
  timesheet: MeasurementTimesheet | null;
  catalogItems: MeasurementItem[];
  workerHeadCount: number;
  isLoading: boolean;
  error: string | null;
  fileSelectionError: string | null;
  isImportDialogOpen: boolean;
  importMessage: string | null;
  importError: string | null;
  canHideItems: boolean;
  onRetry: () => void;
  hideError: string | null;
  hidingItemId: number | null;
  onHideItem: (measurementItemId: number) => void;
}) {
  const [activePositionGroupKey, setActivePositionGroupKey] = useState("all");
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
  const tableResetKeyRef = useRef<string | null>(null);

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

      return {
        positionId: row.position_id,
        positionNumber: row.position_number,
        description: row.description,
        searchText: row.search_text || `${row.position_number} ${row.description ?? ""}`.toLocaleLowerCase("de-DE"),
        unit: row.unit,
        plannedQuantity,
        hasPlannedQuantity: plannedQuantity > 0,
        measuredQuantity,
        minutesPerUnit: getMeasurementNumericValue(row.minutes_per_unit),
        plannedMinutes: getMeasurementNumericValue(row.planned_minutes),
        measuredMinutes: getMeasurementNumericValue(row.measured_minutes),
        progressPercent: row.progress_percent,
        isCaptured: row.is_captured,
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
        plannedMinutes: 0,
        measuredMinutes: 0,
        progressPercent: null,
        openMinutes: null,
        hasPlannedBasis: false,
      };
    }

    return {
      plannedMinutes: getMeasurementNumericValue(kpi.planned_minutes),
      measuredMinutes: getMeasurementNumericValue(kpi.measured_minutes),
      progressPercent: kpi.progress_percent,
      openMinutes: kpi.open_minutes === null ? null : getMeasurementNumericValue(kpi.open_minutes),
      hasPlannedBasis: kpi.has_planned_basis,
    };
  }, [timesheet?.kpi]);

  const projectPositionCaptureStats = useMemo(() => {
    const capturedPositions = projectPositionRows.filter((row) => row.isCaptured).length;
    return {
      capturedPositions,
      openPositions: projectPositionRows.length - capturedPositions,
      totalPositions: projectPositionRows.length,
    };
  }, [projectPositionRows]);

  const positionGroups = useMemo(() => {
    const catalogById = new Map(catalogItems.map((item) => [item.id, item]));
    const groupItems = projectPositionRows.map((row) => catalogById.get(row.positionId) ?? {
      id: row.positionId,
      position: row.positionNumber,
      source_file_name: null,
      source_invoice_number: null,
      is_free_position: false,
      is_hidden: false,
    });
    return buildDesktopMeasurementPositionGroups(groupItems);
  }, [catalogItems, projectPositionRows]);

  const activePositionGroup = useMemo(
    () => positionGroups.find((group) => group.key === activePositionGroupKey) ?? positionGroups[0] ?? null,
    [activePositionGroupKey, positionGroups],
  );

  useEffect(() => {
    if (!positionGroups.some((group) => group.key === activePositionGroupKey)) {
      setActivePositionGroupKey("all");
    }
  }, [activePositionGroupKey, positionGroups]);

  const filteredProjectPositionRows = useMemo(() => {
    const startedAt = startMeasurementTimesheetPerformanceTiming();
    const normalizedSearch = deferredSearchTerm.trim().toLocaleLowerCase("de-DE");

    const rows = projectPositionRows.filter((row) => {
      const matchesFilter = activePositionGroup?.key === "all"
        || activePositionGroup?.itemIds.has(row.positionId);

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
      group: activePositionGroup?.key ?? "all",
      hasSearch: normalizedSearch.length > 0,
    });
    return rows;
  }, [activePositionGroup, deferredSearchTerm, projectPositionRows]);

  const tableResetKey = useMemo(
    () => `${activePositionGroup?.key ?? "all"}\u0000${deferredSearchTerm.trim().toLocaleLowerCase("de-DE")}`,
    [activePositionGroup?.key, deferredSearchTerm],
  );

  useEffect(() => {
    const rowCount = filteredProjectPositionRows.length;
    const shouldResetScroll = tableResetKeyRef.current !== tableResetKey;
    tableResetKeyRef.current = tableResetKey;
    tableRenderStartedAtRef.current = startMeasurementTimesheetPerformanceTiming();

    if (shouldResetScroll) {
      setIsTableRenderReady(false);
      if (tableWrapRef.current) {
        tableWrapRef.current.scrollTop = 0;
      }
      setTableViewport((currentViewport) => ({
        firstVisibleRow: 0,
        height: currentViewport.height || MEASUREMENT_TIMESHEET_DEFAULT_VIEWPORT_HEIGHT,
      }));
    }

    if (rowCount === 0) {
      setIsTableRenderReady(true);
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (!shouldResetScroll) {
        const element = tableWrapRef.current;
        if (element) {
          const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
          element.scrollTop = Math.min(element.scrollTop, maxScrollTop);
        }
        updateTableViewport();
      }
      setIsTableRenderReady(true);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [filteredProjectPositionRows, tableResetKey, updateTableViewport]);

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
        {hideError ? <div className="project-record-empty-state is-error"><strong>{hideError}</strong></div> : null}

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
                  {projectPositionStats.progressPercent !== null ? (
                    <strong className={projectPositionStats.progressPercent < 0 ? "measurement-negative-quantity" : undefined}>
                      {formatMeasurementPercent(projectPositionStats.progressPercent)}
                    </strong>
                  ) : null}
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
                  <strong className={projectPositionStats.measuredMinutes < 0 ? "measurement-negative-quantity" : undefined}>
                    {formatMeasurementDuration(projectPositionStats.measuredMinutes)}
                  </strong>
                </div>
                <div>
                  <span>Offene Stunden</span>
                  <strong className={projectPositionStats.openMinutes !== null && projectPositionStats.openMinutes < 0 ? "measurement-negative-quantity" : undefined}>
                    {projectPositionStats.openMinutes !== null ? formatMeasurementDuration(projectPositionStats.openMinutes) : "Keine Sollbasis"}
                  </strong>
                </div>
              </aside>
            </div>

            <section className="measurement-timesheet-table-panel" aria-label="Projektpositionen Tabelle">
              <div className="measurement-timesheet-filterbar">
                <div className="measurement-timesheet-filter-group" aria-label="Positionsgruppen filtern">
                  {positionGroups.map((group) => (
                    <button
                      key={group.key}
                      type="button"
                      className={activePositionGroup?.key === group.key ? "is-active" : ""}
                      aria-label={`${group.label}, ${group.count} ${group.count === 1 ? "Position" : "Positionen"}`}
                      onClick={() => setActivePositionGroupKey(group.key)}
                    >
                      {group.label}
                      <span aria-hidden="true">{group.count}</span>
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
                          <th className="measurement-timesheet-remove-col" aria-label="Ausblenden" />
                          <th>Pos.-Nr.</th>
                          <th>Bezeichnung</th>
                          <th>Einheit</th>
                          <th className="measurement-timesheet-number">Soll</th>
                          <th className="measurement-timesheet-number">Ist</th>
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
                            className={row.isCaptured ? "has-quantity" : undefined}
                          >
                            <td className="measurement-timesheet-remove-cell">
                              {canHideItems ? (
                                <button
                                  type="button"
                                  className="measurement-timesheet-hide-button"
                                  disabled={hidingItemId === row.positionId}
                                  aria-label={`Position ${row.positionNumber} ausblenden`}
                                  title="Position ausblenden"
                                  onClick={() => onHideItem(row.positionId)}
                                >
                                  ×
                                </button>
                              ) : null}
                            </td>
                            <td><strong>{row.positionNumber}</strong></td>
                            <td className="measurement-timesheet-description" title={row.description}>{row.description}</td>
                            <td>{row.unit ?? "-"}</td>
                            <td className="measurement-timesheet-number">{row.hasPlannedQuantity ? formatMeasurementNumber(row.plannedQuantity) : "-"}</td>
                            <td className={`measurement-timesheet-number${row.measuredQuantity < 0 ? " measurement-negative-quantity" : ""}`}>
                              {row.isCaptured ? formatMeasurementNumber(row.measuredQuantity) : "-"}
                            </td>
                            <td className="measurement-timesheet-number">{row.minutesPerUnit > 0 ? formatMeasurementNumber(row.minutesPerUnit) : "-"}</td>
                            <td className={`measurement-timesheet-number${row.measuredMinutes < 0 ? " measurement-negative-quantity" : ""}`}>
                              {row.isCaptured ? formatMeasurementDuration(row.measuredMinutes) : "-"}
                            </td>
                            <td className={`measurement-timesheet-number measurement-timesheet-progress-cell${row.progressPercent !== null && row.progressPercent < 0 ? " measurement-negative-quantity" : ""}`}>
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
                  <div className="measurement-timesheet-statusbar" aria-label="Positionsstatus">
                    <span>{projectPositionCaptureStats.totalPositions} Positionen</span>
                    <span>{projectPositionCaptureStats.capturedPositions} erfasst</span>
                    <span>{projectPositionCaptureStats.openPositions} offen</span>
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

const MEASUREMENT_OFFICE_EXTRA_COLUMN_KEY = "office-extra-column";

type MeasurementPositionSuggestion = {
  id: number;
  position: string;
  description: string;
  unit: string | null;
  linkedItem: {
    id: number;
    position: string;
  } | null;
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

function isTechnicalFreeMeasurementPosition(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return /^FREI-\d+$/.test(normalized);
}

function getVisibleMeasurementPosition(item: MobileMeasurementItem): string {
  return item.is_free_position && isTechnicalFreeMeasurementPosition(item.position) ? "" : item.position;
}

function hasMeaningfulFreeMeasurementData(item: MobileMeasurementItem): boolean {
  return item.entries.length > 0
    || item.description.trim().length > 0
    || (item.unit ?? "").trim().length > 0
    || getVisibleMeasurementPosition(item).trim().length > 0;
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
    mobile_status: entries.length > 0 ? "edited" : "open",
  };
}

function replaceMeasurementItem(items: MobileMeasurementItem[], updatedItem: MobileMeasurementItem): MobileMeasurementItem[] {
  return items.map((item) => (item.id === updatedItem.id ? updatedItem : item));
}

function orderMeasurementItemsByColumnPosition(items: MobileMeasurementItem[]): MobileMeasurementItem[] {
  return [...items].sort((left, right) => left.sort_order - right.sort_order || left.id - right.id);
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
  projectPositionSuggestions,
  canCreateBatch,
  canPromoteStatus,
  batches,
  measurementWorkers,
  measurementWorkersLoading,
  measurementWorkersError,
  batchesLoading,
  batchesError,
  selectedBatch,
  batchItems,
  batchItemsLoading,
  reviewMessage,
  reviewError,
  reviewActionLoading,
  statusActionId,
  archiveMode,
  onRetryBatches,
  onLoadMeasurementWorkers,
  onCreateBatch,
  onToggleArchive,
  onSelectBatch,
  onBackToBatchList,
  onMarkBilled,
  onMarkOpen,
  onMarkReviewed,
  onPromoteStatus,
  onDeleteBatch,
  onRestoreBatch,
  onUpdateEntry,
  onCreateEntry,
  onCreateFreeItem,
  onUpdateFreeItem,
  onDeleteFreeItem,
  onResetToSubmitted,
  onExportPdf,
}: {
  siteNumber: string | null;
  projectPositionSuggestions: MeasurementPositionSuggestion[];
  canCreateBatch: boolean;
  canPromoteStatus: boolean;
  batches: MobileMeasurementBatch[];
  measurementWorkers: MeasurementWorkerOption[];
  measurementWorkersLoading: boolean;
  measurementWorkersError: string | null;
  batchesLoading: boolean;
  batchesError: string | null;
  selectedBatch: MobileMeasurementBatch | null;
  batchItems: MobileMeasurementItem[];
  batchItemsLoading: boolean;
  reviewMessage: string | null;
  reviewError: string | null;
  reviewActionLoading: boolean;
  statusActionId: number | null;
  archiveMode: boolean;
  onRetryBatches: () => void;
  onLoadMeasurementWorkers: () => void;
  onCreateBatch: (payload: OfficeMeasurementBatchPayload) => Promise<MobileMeasurementBatch>;
  onToggleArchive: () => void;
  onSelectBatch: (batch: MobileMeasurementBatch) => void;
  onBackToBatchList: () => void;
  onMarkBilled: (batch: MobileMeasurementBatch) => void;
  onMarkOpen: (batch: MobileMeasurementBatch) => void;
  onMarkReviewed: (batch: MobileMeasurementBatch) => void;
  onPromoteStatus: (batch: MobileMeasurementBatch, status: MeasurementManualStatus) => void;
  onDeleteBatch: (batch: MobileMeasurementBatch) => Promise<void>;
  onRestoreBatch: (batch: MobileMeasurementBatch) => Promise<void>;
  onUpdateEntry: (batch: MobileMeasurementBatch, entryId: number, payload: { area_or_comment: string; quantity: number }) => Promise<void>;
  onCreateEntry: (batch: MobileMeasurementBatch, measurementItemId: number, payload: { area_or_comment: string; quantity: number }) => Promise<void>;
  onCreateFreeItem: (batch: MobileMeasurementBatch, payload: MobileMeasurementFreeItemPayload) => Promise<MobileMeasurementItem>;
  onUpdateFreeItem: (batch: MobileMeasurementBatch, measurementItemId: number, payload: MeasurementItemUpdatePayload) => Promise<MobileMeasurementItem>;
  onDeleteFreeItem: (batch: MobileMeasurementBatch, measurementItemId: number) => Promise<void>;
  onResetToSubmitted: (batch: MobileMeasurementBatch) => Promise<void>;
  onExportPdf: (batch: MobileMeasurementBatch, mode: MeasurementPdfMode) => Promise<void>;
}) {
  const [, setEntryDrafts] = useState<Record<number, MeasurementEntryDraft>>({});
  const [undoStack, setUndoStack] = useState<MeasurementEntryUndoState[]>([]);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [savingEntryId, setSavingEntryId] = useState<number | null>(null);
  const [pdfExportingAction, setPdfExportingAction] = useState<string | null>(null);
  const [deletingBatchId, setDeletingBatchId] = useState<number | null>(null);
  const [restoringBatchId, setRestoringBatchId] = useState<number | null>(null);
  const [openStatusBatchId, setOpenStatusBatchId] = useState<number | null>(null);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createAreaLocation, setCreateAreaLocation] = useState("");
  const [createMeasurementDate, setCreateMeasurementDate] = useState("");
  const [createEmployeeId, setCreateEmployeeId] = useState("");
  const [createRequestId, setCreateRequestId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreatingBatch, setIsCreatingBatch] = useState(false);
  const [forceDuplicateConfirmation, setForceDuplicateConfirmation] = useState(false);
  const createAreaLabelId = useId();
  const createDateLabelId = useId();
  const createEmployeeLabelId = useId();
  const workerPickerOptions = useMemo(
    () => measurementWorkers.map((worker) => ({
      value: String(worker.id),
      label: worker.display_name,
      searchText: `${worker.first_name} ${worker.last_name} ${worker.display_name} ${worker.last_name} ${worker.first_name}`,
    })),
    [measurementWorkers],
  );
  const matchingDraft = useMemo(() => {
    const areaKey = normalizeMeasurementArea(createAreaLocation);
    if (!areaKey || !createMeasurementDate) {
      return null;
    }
    return batches.find((batch) => (
      batch.status === "draft"
      && batch.measurement_date === createMeasurementDate
      && normalizeMeasurementArea(batch.area_location ?? "") === areaKey
    )) ?? null;
  }, [batches, createAreaLocation, createMeasurementDate]);
  const reviewPositionSuggestions = useMemo<MeasurementPositionSuggestion[]>(() => {
    const suggestionsByPosition = new Map<string, MeasurementPositionSuggestion>();
    const historicalSuggestions = buildMeasurementPositionCatalog(batchItems).map((item) => ({
      ...item,
      linkedItem: {
        id: item.id,
        position: item.position,
      },
    }));

    for (const suggestion of [...historicalSuggestions, ...projectPositionSuggestions]) {
      const positionKey = getMeasurementPositionCatalogKey(suggestion.position);
      if (positionKey && !suggestionsByPosition.has(positionKey)) {
        suggestionsByPosition.set(positionKey, suggestion);
      }
    }
    return [...suggestionsByPosition.values()];
  }, [batchItems, projectPositionSuggestions]);

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

  useEffect(() => {
    if (!isCreateDialogOpen) {
      return undefined;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !isCreatingBatch) {
        setIsCreateDialogOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isCreateDialogOpen, isCreatingBatch]);

  function openCreateDialog(): void {
    setCreateAreaLocation("");
    setCreateMeasurementDate(toLocalDateKey(new Date()));
    setCreateEmployeeId("");
    setCreateRequestId(createClientRequestId());
    setCreateError(null);
    setForceDuplicateConfirmation(false);
    setIsCreateDialogOpen(true);
    onLoadMeasurementWorkers();
  }

  async function submitCreateBatch(): Promise<void> {
    const areaLocation = createAreaLocation.trim().split(/\s+/).join(" ");
    if (!areaLocation) {
      setCreateError("Bitte einen Bereich oder Ort angeben.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(createMeasurementDate)) {
      setCreateError("Bitte ein gültiges Aufmaßdatum angeben.");
      return;
    }
    setIsCreatingBatch(true);
    setCreateError(null);
    try {
      await onCreateBatch({
        area_location: areaLocation,
        measurement_date: createMeasurementDate,
        assigned_employee_id: createEmployeeId ? Number(createEmployeeId) : null,
        request_id: createRequestId,
        allow_duplicate: Boolean(matchingDraft) || forceDuplicateConfirmation,
      });
      setIsCreateDialogOpen(false);
    } catch (error) {
      const message = readApiError(error, "Aufmaß konnte nicht angelegt werden.");
      if (message.includes("bereits ein offener Entwurf")) {
        setForceDuplicateConfirmation(true);
      }
      setCreateError(message);
    } finally {
      setIsCreatingBatch(false);
    }
  }

  const sortedBatches = useMemo(() => [...batches].sort((left, right) => {
    const rightTime = getMeasurementBatchSortTime(right);
    const leftTime = getMeasurementBatchSortTime(left);
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return right.number - left.number;
  }), [batches]);

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
    if (quantity === null) {
      setInlineError("Bitte eine gültige Menge eingeben.");
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

  async function deleteBatch(event: MouseEvent<HTMLButtonElement>, batch: MobileMeasurementBatch): Promise<void> {
    event.stopPropagation();
    if (deletingBatchId !== null || reviewActionLoading) {
      return;
    }
    setDeletingBatchId(batch.id);
    try {
      await onDeleteBatch(batch);
    } catch {
      // The parent handler already surfaces the API error.
    } finally {
      setDeletingBatchId(null);
    }
  }

  async function restoreBatch(batch: MobileMeasurementBatch): Promise<void> {
    if (restoringBatchId !== null || reviewActionLoading) {
      return;
    }
    setRestoringBatchId(batch.id);
    try {
      await onRestoreBatch(batch);
    } catch {
      // The parent handler already surfaces the API error.
    } finally {
      setRestoringBatchId(null);
    }
  }

  if (selectedBatch && !archiveMode) {
    const itemsWithEntries = batchItems.filter((item) => item.entries.length > 0);
    const isFreePositionOnlyBatch = selectedBatch.position_mode === "BLANK";
    const isOfficeCreatedBatch = selectedBatch.origin === "OFFICE";
    const tableItems = isFreePositionOnlyBatch
      ? batchItems.filter(hasMeaningfulFreeMeasurementData)
      : itemsWithEntries;
    const isBilled = isMeasurementBatchBilled(selectedBatch.status);
    const isDraft = selectedBatch.status === "draft";
    const isReviewed = isMeasurementBatchReviewed(selectedBatch.status);
    const isCustomerSigned = isCustomerSignedMeasurementBatch(selectedBatch);
    const showUnsubmittedWarning = isMeasurementBatchBeforeSubmitted(selectedBatch.status);
    const canEditRows = (!isDraft || selectedBatch.origin === "OFFICE")
      && !isBilled
      && !isCustomerSigned
      && selectedBatch.deleted_at === null;
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
            {!isOfficeCreatedBatch ? (
              <>
                <span className="measurement-review-action-divider" aria-hidden="true" />
                <div className="measurement-review-filter-group" aria-label="Aktueller Prüfstatus">
                  <span className={isMeasurementBatchReviewRequired(selectedBatch) ? "is-active" : ""}>Eingereicht</span>
                  <span className={isReviewed ? "is-active" : ""}>Geprüft</span>
                  <span className={isCustomerSigned && !isBilled ? "is-active" : ""}>Unterschrieben</span>
                  <span className={isBilled ? "is-active" : ""}>Abgeschlossen</span>
                </div>
              </>
            ) : null}
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
            {selectedBatch.has_original_worker_submission ? (
              <button
                type="button"
                className="secondary-action"
                disabled={!canEditRows || reviewActionLoading || savingEntryId !== null}
                onClick={() => void resetToSubmitted(selectedBatch)}
              >
                Auf Monteurstand zurücksetzen
              </button>
            ) : null}
            <span className="measurement-review-action-divider" aria-hidden="true" />
            {isBilled ? (
              <button type="button" className="secondary-action" disabled={reviewActionLoading} onClick={() => onMarkOpen(selectedBatch)}>
                Wieder auf Eingereicht setzen
              </button>
            ) : (
              <>
                {!isOfficeCreatedBatch && !isReviewed && !isCustomerSigned ? (
                  <button type="button" className="primary-action" disabled={reviewActionLoading} onClick={() => onMarkReviewed(selectedBatch)}>
                    Prüfung abschließen
                  </button>
                ) : null}
                <button type="button" className="primary-action" disabled={reviewActionLoading} onClick={() => onMarkBilled(selectedBatch)}>
                  Aufmaß abschließen
                </button>
              </>
            )}
          </div>
        </div>

        {!isOfficeCreatedBatch && showUnsubmittedWarning ? (
          <div className="measurement-review-unsubmitted-warning" role="note">
            Dieses Aufmaß wurde noch nicht zur Prüfung eingereicht. Eine Prüfung oder ein Abschluss ist trotzdem möglich. Bitte vor dem Fortfahren fachlich kontrollieren.
          </div>
        ) : null}
        {reviewMessage ? <div className="project-record-empty-state is-success">{reviewMessage}</div> : null}
        {reviewError ? <div className="project-record-empty-state is-error"><strong>{reviewError}</strong></div> : null}
        {inlineError ? <div className="project-record-empty-state is-error"><strong>{inlineError}</strong></div> : null}
        {batchItemsLoading ? <div className="matrix-state">Aufmaßzeilen werden geladen...</div> : null}
        {!batchItemsLoading && !isFreePositionOnlyBatch && itemsWithEntries.length === 0 ? (
          <div className="project-record-empty-state">Keine Aufmaßzeilen in diesem Paket.</div>
        ) : null}
        {!batchItemsLoading ? (
          <MeasurementReviewTable
            items={tableItems}
            positionSuggestions={reviewPositionSuggestions}
            freePositionOnly={isFreePositionOnlyBatch}
            canEditRows={canEditRows}
            reviewActionLoading={reviewActionLoading}
            savingEntryId={savingEntryId}
            onDraftSave={(entry, draft) => void saveEntryDraft(selectedBatch, entry, draft)}
            onDraftReset={resetEntryDraft}
            onCellCreate={(item, areaLabel, quantity) => onCreateEntry(selectedBatch, item.id, { area_or_comment: areaLabel, quantity })}
            onFreeItemCreate={(payload) => onCreateFreeItem(selectedBatch, payload)}
            onFreeItemUpdate={(item, payload) => onUpdateFreeItem(selectedBatch, item.id, payload)}
            onFreeItemDelete={(item) => onDeleteFreeItem(selectedBatch, item.id)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <>
      <header className="project-record-toolbar measurement-review-toolbar">
        <div className="measurement-review-header-copy">
          <h2><Ruler aria-hidden="true" size={18} />{archiveMode ? "Archivierte Aufmaße" : "Prüfung"}</h2>
          <p>
            {archiveMode
              ? "Gelöschte Aufmaße können hier wiederhergestellt werden."
              : "Eingereichte Aufmaßpakete prüfen, unterschreiben lassen und abschließen."}
          </p>
        </div>
        <div className="measurement-review-header-actions">
          {!archiveMode && canCreateBatch ? (
            <button type="button" className="secondary-action" disabled={batchesLoading} onClick={openCreateDialog}>
              <Plus aria-hidden="true" size={15} />
              Aufmaß anlegen
            </button>
          ) : null}
          <button type="button" className="secondary-action" disabled={batchesLoading} onClick={onToggleArchive}>
            {archiveMode ? "Aktive Aufmaße anzeigen" : "Archiv anzeigen"}
          </button>
        </div>
      </header>
      {isCreateDialogOpen ? (
        <div
          className="measurement-create-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isCreatingBatch) {
              setIsCreateDialogOpen(false);
            }
          }}
        >
          <section
            aria-labelledby="measurement-create-modal-title"
            aria-modal="true"
            className="measurement-create-modal"
            role="dialog"
          >
            <header className="measurement-create-modal-header">
              <div>
                <h3 id="measurement-create-modal-title">Aufmaß anlegen</h3>
                <p>Neues Aufmaßpaket direkt in der Projektakte erstellen.</p>
              </div>
              <button
                aria-label="Dialog schließen"
                className="measurement-create-modal-close"
                disabled={isCreatingBatch}
                type="button"
                onClick={() => setIsCreateDialogOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="measurement-create-modal-form">
              <label className="measurement-create-field" htmlFor={`${createAreaLabelId}-input`}>
                <span id={createAreaLabelId}>Bereich/Ort *</span>
                <input
                  autoFocus
                  id={`${createAreaLabelId}-input`}
                  maxLength={260}
                  placeholder="z. B. 1. Obergeschoss"
                  type="text"
                  value={createAreaLocation}
                  onChange={(event) => {
                    setCreateAreaLocation(event.target.value);
                    setCreateError(null);
                    setForceDuplicateConfirmation(false);
                  }}
                />
              </label>
              <label className="measurement-create-field" htmlFor={`${createDateLabelId}-input`}>
                <span id={createDateLabelId}>Aufmaßdatum *</span>
                <input
                  id={`${createDateLabelId}-input`}
                  type="date"
                  value={createMeasurementDate}
                  onChange={(event) => {
                    setCreateMeasurementDate(event.target.value);
                    setCreateError(null);
                    setForceDuplicateConfirmation(false);
                  }}
                />
              </label>
              <div className="measurement-create-field">
                <span id={createEmployeeLabelId}>Verantwortlicher Monteur</span>
                <DashboardNotePicker
                  emptyText="Kein aktiver interner Monteur gefunden"
                  error={measurementWorkersError}
                  errorText="Monteure konnten nicht geladen werden."
                  labelId={createEmployeeLabelId}
                  listLabel="Verantwortlichen Monteur auswählen"
                  loading={measurementWorkersLoading}
                  loadingText="Monteure werden geladen..."
                  options={workerPickerOptions}
                  searchLabel="Monteur suchen"
                  searchPlaceholder="Monteur suchen…"
                  value={createEmployeeId}
                  onChange={(value) => {
                    setCreateEmployeeId(value);
                    setCreateError(null);
                  }}
                />
              </div>
              {matchingDraft || forceDuplicateConfirmation ? (
                <div className="measurement-create-duplicate-note" role="note">
                  Für diesen Bereich und dieses Datum besteht bereits ein offener Entwurf. Ein weiteres Aufmaß kann bewusst trotzdem angelegt werden.
                </div>
              ) : null}
              {createError ? <div className="project-record-empty-state is-error"><strong>{createError}</strong></div> : null}
            </div>
            <footer className="measurement-create-modal-actions">
              <button
                className="secondary-action"
                disabled={isCreatingBatch}
                type="button"
                onClick={() => setIsCreateDialogOpen(false)}
              >
                Abbrechen
              </button>
              <button
                className="primary-action"
                disabled={
                  isCreatingBatch
                  || !createAreaLocation.trim()
                  || !createMeasurementDate
                }
                type="button"
                onClick={() => void submitCreateBatch()}
              >
                {isCreatingBatch
                  ? "Wird angelegt..."
                  : matchingDraft || forceDuplicateConfirmation
                    ? "Trotzdem anlegen"
                    : "Aufmaß anlegen"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {batchesLoading ? <div className="matrix-state">Aufmaßpakete werden geladen...</div> : null}
      {batchesError ? (
        <div className="project-record-empty-state is-error">
          <strong>{batchesError}</strong>
          <button type="button" className="secondary-action" onClick={onRetryBatches}>Erneut laden</button>
        </div>
      ) : null}
      {!batchesLoading && !batchesError && sortedBatches.length === 0 ? (
        <div className="project-record-empty-state">
          {archiveMode
            ? "Keine archivierten Aufmaße vorhanden."
            : "Noch keine Aufmaßpakete vorhanden. Du kannst ein Aufmaß im Büro anlegen, wenn kein Monteur-Aufmaß vorliegt."}
        </div>
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
            const statusOptions = canPromoteStatus
              ? measurementStatusPromotionOptions(batch.status, batch.customer_signed_at)
              : [];
            if (archiveMode) {
              return (
                <div
                  key={batch.id}
                  className="measurement-review-card has-delete-action is-archive"
                >
                  <div className="measurement-review-card-controls">
                    <span className={`${statusBadge.className} has-delete-control`}>
                      <span className="measurement-review-status-spacer" aria-hidden="true" />
                      <span className="measurement-review-status-label">{statusBadge.label}</span>
                    </span>
                  </div>
                  <div className="measurement-review-card-open">
                    <div className="measurement-review-card-main">
                      <div className="measurement-review-card-title-row">
                        <strong>{formatMeasurementPackageNumber(siteNumber, batch.number, batch.title)}</strong>
                        {batch.offer_name ? <span className="measurement-status is-old-offer">{batch.offer_name}</span> : null}
                      </div>
                      <small className="measurement-review-submitter-status">
                        {batch.origin === "OFFICE"
                          ? `Im Büro angelegt${batch.created_by_name ? ` · von ${batch.created_by_name}` : ""}`
                          : batch.submitted_by_name ? `Von ${batch.submitted_by_name}` : "Ohne Einreicher"}
                        {batch.origin !== "OFFICE" && batch.submitted_at ? ` · Eingereicht ${formatDateTime(batch.submitted_at)}` : ""}
                      </small>
                      <small className="measurement-review-submitter-status">
                        Gelöscht {batch.deleted_at ? formatDateTime(batch.deleted_at) : "ohne Datum"}
                        {batch.deleted_by_name ? ` · von ${batch.deleted_by_name}` : " · ohne Benutzer"}
                      </small>
                    </div>
                    <b>{batch.entry_count} Zeilen · {batch.position_count} Positionen</b>
                  </div>
                  <div className="measurement-review-pdf-actions">
                    <button
                      type="button"
                      className="measurement-review-pdf-action"
                      disabled={reviewActionLoading || restoringBatchId !== null}
                      onClick={() => void restoreBatch(batch)}
                    >
                      {restoringBatchId === batch.id ? "Stellt wieder her..." : "Wiederherstellen"}
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <div
                key={batch.id}
                className={`measurement-review-card has-delete-action${batch.status === "submitted" ? " is-submitted" : ""}${isOldOffer ? " is-old-offer" : ""}`}
              >
                <div className="measurement-review-card-controls">
                  <span className={`${statusBadge.className} has-delete-control`}>
                    <button
                      type="button"
                      className="measurement-review-delete-action"
                      disabled={reviewActionLoading || deletingBatchId !== null}
                      title="Aufmaß löschen"
                      aria-label={`${formatMeasurementPackageNumber(siteNumber, batch.number, batch.title)} löschen`}
                      onClick={(event) => void deleteBatch(event, batch)}
                    >
                      {deletingBatchId === batch.id ? "..." : "×"}
                    </button>
                    <ProjectRecordStatusControl
                      active={openStatusBatchId === batch.id}
                      ariaLabel={`${formatMeasurementPackageNumber(siteNumber, batch.number, batch.title)}: Status ${statusBadge.label}`}
                      busy={statusActionId === batch.id}
                      label={statusBadge.label}
                      options={statusOptions}
                      onClose={() => setOpenStatusBatchId(null)}
                      onSelect={(status) => {
                        setOpenStatusBatchId(null);
                        onPromoteStatus(batch, status);
                      }}
                      onToggle={() => setOpenStatusBatchId((current) => (current === batch.id ? null : batch.id))}
                    />
                  </span>
                </div>
                <button
                  type="button"
                  className="measurement-review-card-open"
                  onClick={() => onSelectBatch(batch)}
                >
                  <div className="measurement-review-card-main">
                    <div className="measurement-review-card-title-row">
                      <strong>{formatMeasurementPackageNumber(siteNumber, batch.number, batch.title)}</strong>
                      {isOldOffer ? <span className="measurement-status is-old-offer">Altes Angebot</span> : null}
                    </div>
                    <CustomerEmailStatusLine item={batch} />
                    <small className="measurement-review-submitter-status">
                      {batch.origin === "OFFICE"
                        ? `Im Büro angelegt${batch.created_by_name ? ` · von ${batch.created_by_name}` : ""}`
                        : batch.submitted_by_name ? `Von ${batch.submitted_by_name}` : "Ohne Einreicher"}
                      {batch.origin !== "OFFICE" && batch.submitted_at ? ` · ${formatDateTime(batch.submitted_at)}` : ""}
                      {isOldOffer && batch.offer_name ? ` · ${batch.offer_name}` : ""}
                    </small>
                    {batch.area_location || batch.measurement_date || batch.assigned_employee_name ? (
                      <small className="measurement-review-submitter-status">
                        {[batch.area_location, batch.measurement_date ? formatDateOnly(batch.measurement_date, "numeric") : null, batch.assigned_employee_name].filter(Boolean).join(" · ")}
                      </small>
                    ) : null}
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
                  {batch.has_original_worker_submission ? (
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
                  ) : null}
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
  freePositionOnly,
  canEditRows,
  reviewActionLoading,
  savingEntryId,
  onDraftSave,
  onDraftReset,
  onCellCreate,
  onFreeItemCreate,
  onFreeItemUpdate,
  onFreeItemDelete,
}: {
  items: MobileMeasurementItem[];
  positionSuggestions: MeasurementPositionSuggestion[];
  freePositionOnly: boolean;
  canEditRows: boolean;
  reviewActionLoading: boolean;
  savingEntryId: number | null;
  onDraftSave: (entry: MobileMeasurementItem["entries"][number], draft: MeasurementEntryDraft | undefined) => void;
  onDraftReset: (entry: MobileMeasurementItem["entries"][number]) => void;
  onCellCreate: (item: { id: number; position: string }, areaLabel: string, quantity: number) => Promise<void>;
  onFreeItemCreate: (payload: MobileMeasurementFreeItemPayload) => Promise<MobileMeasurementItem>;
  onFreeItemUpdate: (item: MobileMeasurementItem, payload: MeasurementItemUpdatePayload) => Promise<MobileMeasurementItem>;
  onFreeItemDelete: (item: MobileMeasurementItem) => Promise<void>;
}) {
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const areaLabelDraftsRef = useRef<Record<string, string>>({});
  const savingCellKeysRef = useRef<Set<string>>(new Set());
  const [viewportColumnCount, setViewportColumnCount] = useState(MEASUREMENT_TABLE_MIN_COLUMNS);
  const [manualColumnDrafts, setManualColumnDrafts] = useState<Record<string, MeasurementManualColumnDraft>>({});
  const [manualColumnTotals, setManualColumnTotals] = useState<Record<string, number>>({});
  const [suggestionState, setSuggestionState] = useState<MeasurementSuggestionState>(null);
  const [areaDraftVersion, setAreaDraftVersion] = useState(0);
  const [savingPositionItemId, setSavingPositionItemId] = useState<number | null>(null);
  const areaRows = useMemo(() => buildMeasurementMatrixAreaRows(items), [items]);
  const actualItemIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const activeManualColumnIndexes = useMemo(() => Object.entries(manualColumnDrafts)
    .filter(([columnKey, draft]) => (
      columnKey.startsWith(`${MEASUREMENT_OFFICE_EXTRA_COLUMN_KEY}-`)
      && Boolean(draft.position.trim() || draft.description.trim() || draft.unit.trim())
    ))
    .map(([columnKey]) => Number(columnKey.slice(MEASUREMENT_OFFICE_EXTRA_COLUMN_KEY.length + 1)))
    .filter(Number.isFinite), [manualColumnDrafts]);
  const activeQuantityColumnIndexes = useMemo(() => Object.entries(manualColumnTotals)
    .filter(([columnKey, total]) => columnKey.startsWith(`${MEASUREMENT_OFFICE_EXTRA_COLUMN_KEY}-`) && total > 0)
    .map(([columnKey]) => Number(columnKey.slice(MEASUREMENT_OFFICE_EXTRA_COLUMN_KEY.length + 1)))
    .filter(Number.isFinite), [manualColumnTotals]);
  const highestActiveFreeColumnIndex = Math.max(0, ...activeManualColumnIndexes, ...activeQuantityColumnIndexes);
  const freeInputColumnCount = freePositionOnly
    ? Math.max(MEASUREMENT_FREE_INPUT_MIN_COLUMNS - items.length, highestActiveFreeColumnIndex + 1, 1)
    : 1;
  const displayColumnCount = freePositionOnly
    ? items.length + freeInputColumnCount
    : Math.max(MEASUREMENT_TABLE_MIN_COLUMNS, items.length + 1, viewportColumnCount);
  const fillerColumnCount = freePositionOnly
    ? 0
    : Math.max(0, displayColumnCount - items.length - 1);
  const displayColumns: Array<
    | { key: string; kind: "item"; item: MobileMeasurementItem }
    | { key: string; kind: "placeholder"; index: number }
    | { key: string; kind: "office-extra"; index: number }
  > = useMemo(() => {
    const itemColumns = items.map((item) => ({ key: `item-${item.id}`, kind: "item" as const, item }));
    if (freePositionOnly) {
      return [
        ...itemColumns,
        ...Array.from({ length: freeInputColumnCount }, (_, index) => ({
          key: `${MEASUREMENT_OFFICE_EXTRA_COLUMN_KEY}-${index + 1}`,
          kind: "office-extra" as const,
          index: index + 1,
        })),
      ];
    }
    return [
      ...itemColumns,
      ...Array.from({ length: fillerColumnCount }, (_, index) => ({
        key: `placeholder-column-${index + 1}`,
        kind: "placeholder" as const,
        index: index + 1,
      })),
      {
        key: MEASUREMENT_OFFICE_EXTRA_COLUMN_KEY,
        kind: "office-extra" as const,
        index: fillerColumnCount + 1,
      },
    ];
  }, [items, fillerColumnCount, freeInputColumnCount, freePositionOnly]);
  const displayAreaRows: Array<MeasurementMatrixAreaRow & { isPlaceholder?: boolean }> = useMemo(() => {
    const placeholderCount = Math.max(0, MEASUREMENT_TABLE_MIN_AREA_ROWS - areaRows.length);
    const placeholderAreaRows = Array.from({ length: placeholderCount }, (_, index) => ({
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
      .filter((item) => (
        item.position.toLocaleLowerCase("de-DE").includes(query)
        || item.description.toLocaleLowerCase("de-DE").includes(query)
      ))
      .sort((left, right) => left.position.localeCompare(right.position, "de-DE", { numeric: true, sensitivity: "base" }))
      .slice(0, 8);
  }, [positionSuggestions, suggestionState]);
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

  useEffect(() => {
    if (!suggestionState) {
      return undefined;
    }
    const closeSuggestionOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      const anchor = target instanceof Element
        ? target.closest<HTMLElement>("[data-position-suggestion-column]")
        : null;
      if (anchor?.dataset.positionSuggestionColumn !== suggestionState.columnKey) {
        setSuggestionState(null);
      }
    };
    document.addEventListener("pointerdown", closeSuggestionOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeSuggestionOnOutsidePointer);
  }, [suggestionState]);

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

  function saveAreaLabelDraft(area: MeasurementMatrixAreaRow & { isPlaceholder?: boolean }): void {
    if (area.isPlaceholder) {
      return;
    }
    const nextLabel = getAreaLabel(area).trim().replace(/\s+/g, " ");
    if (!nextLabel || nextLabel === area.label) {
      return;
    }
    for (const item of items) {
      for (const entry of item.entries) {
        if (getMeasurementAreaKey(entry.area_or_comment) === area.key) {
          onDraftSave(entry, {
            area_or_comment: nextLabel,
            quantity: formatMeasurementDraftQuantity(entry.quantity),
          });
        }
      }
    }
  }

  function getManualColumnDraft(columnKey: string): MeasurementManualColumnDraft {
    return manualColumnDrafts[columnKey] ?? { position: "", description: "", unit: "", linkedItemId: null };
  }

  function getManualColumnItem(columnKey: string): { id: number; position: string } | null {
    const linkedItemId = manualColumnDrafts[columnKey]?.linkedItemId;
    if (!linkedItemId || actualItemIds.has(linkedItemId)) {
      return null;
    }
    return positionSuggestions.find((item) => item.linkedItem?.id === linkedItemId)?.linkedItem ?? null;
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

  async function selectPositionSuggestion(
    columnKey: string,
    suggestion: MeasurementPositionSuggestion,
    existingItem?: MobileMeasurementItem,
  ): Promise<void> {
    setSuggestionState(null);
    if (existingItem) {
      setSavingPositionItemId(existingItem.id);
      try {
        await onFreeItemUpdate(existingItem, {
          position: suggestion.position,
          linked_measurement_item_id: suggestion.id,
        });
      } finally {
        setSavingPositionItemId(null);
      }
      clearManualColumnDraft(columnKey);
      return;
    }
    if (freePositionOnly) {
      await onFreeItemCreate({
        position: suggestion.position,
        description: suggestion.description,
        unit: normalizeMeasurementUnitDisplay(suggestion.unit),
        linked_measurement_item_id: suggestion.id,
        quantity: 0,
      });
      clearManualColumnDraft(columnKey);
      return;
    }
    updateManualColumnDraft(columnKey, {
      position: suggestion.position,
      description: suggestion.description,
      unit: normalizeMeasurementUnitDisplay(suggestion.unit),
      linkedItemId: suggestion.linkedItem?.id ?? null,
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

  function clearManualColumnDraft(columnKey: string): void {
    setManualColumnDrafts((current) => {
      const next = { ...current };
      delete next[columnKey];
      return next;
    });
    setManualColumnTotals((current) => {
      const next = { ...current };
      delete next[columnKey];
      return next;
    });
  }

  async function createFreeItemFromHeaderDraft(
    columnKey: string,
    patch: Partial<MeasurementManualColumnDraft> = {},
  ): Promise<void> {
    if (!freePositionOnly) {
      return;
    }
    const draft = { ...getManualColumnDraft(columnKey), ...patch };
    const position = draft.position.trim();
    const description = draft.description.trim();
    const unit = normalizeMeasurementUnitDisplay(draft.unit);
    if (!position && !description && !unit) {
      return;
    }
    const cellKey = `header-${columnKey}`;
    if (savingCellKeysRef.current.has(cellKey)) {
      return;
    }
    savingCellKeysRef.current.add(cellKey);
    try {
      await onFreeItemCreate({
        position: position || null,
        description,
        unit,
        linked_measurement_item_id: draft.linkedItemId ?? null,
        quantity: 0,
      });
      clearManualColumnDraft(columnKey);
      setSuggestionState(null);
    } finally {
      savingCellKeysRef.current.delete(cellKey);
    }
  }

  function getCellEntries(item: MobileMeasurementItem, areaKey: string): MobileMeasurementItem["entries"] {
    return entryGroups.get(`${item.id}:${areaKey}`) ?? [];
  }

  async function saveNewCellDraft(
    item: { id: number; position: string },
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
    if (!areaLabel || quantity === null) {
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

  async function saveOfficeExtraCellDraft(
    columnKey: string,
    area: MeasurementMatrixAreaRow,
    input: HTMLInputElement,
  ): Promise<void> {
    const value = input.value;
    const quantity = parseMeasurementQuantityInput(value);
    const areaLabel = getAreaLabel(area).trim();
    if (value.trim() === "") {
      return;
    }
    if (!areaLabel || quantity === null) {
      input.value = "";
      updateManualColumnTotal(columnKey);
      return;
    }

    const draft = getManualColumnDraft(columnKey);
    const position = draft.position.trim();
    const description = draft.description.trim();
    const unit = normalizeMeasurementUnitDisplay(draft.unit);
    if (!freePositionOnly && (!description || !unit)) {
      return;
    }

    const cellKey = `${area.key}-${columnKey}`;
    if (savingCellKeysRef.current.has(cellKey)) {
      return;
    }
    savingCellKeysRef.current.add(cellKey);
    try {
      await onFreeItemCreate({
        position: position || null,
        description,
        unit,
        linked_measurement_item_id: draft.linkedItemId ?? null,
        quantity,
        area_or_comment: areaLabel,
      });
      input.value = "";
      if (area.key.startsWith("placeholder-area-")) {
        clearAreaLabelDraft(area.key);
      }
      clearManualColumnDraft(columnKey);
      setSuggestionState(null);
    } finally {
      savingCellKeysRef.current.delete(cellKey);
    }
  }

  async function saveFreeItemPositionDraft(item: MobileMeasurementItem, input: HTMLInputElement): Promise<void> {
    const currentVisiblePosition = getVisibleMeasurementPosition(item);
    const nextPosition = input.value.trim();
    if (nextPosition === currentVisiblePosition || savingPositionItemId === item.id) {
      input.value = currentVisiblePosition;
      return;
    }

    setSavingPositionItemId(item.id);
    try {
      const updatedItem = await onFreeItemUpdate(item, { position: nextPosition || null });
      input.value = getVisibleMeasurementPosition(updatedItem);
    } catch {
      input.value = currentVisiblePosition;
    } finally {
      setSavingPositionItemId(null);
    }
  }

  async function saveFreeItemTextDraft(
    item: MobileMeasurementItem,
    field: "description" | "unit",
    input: HTMLInputElement | HTMLTextAreaElement,
  ): Promise<void> {
    const currentValue = field === "description" ? item.description : (item.unit ?? "");
    const nextValue = field === "description"
      ? input.value.trim().replace(/\s+/g, " ")
      : normalizeMeasurementUnitDisplay(input.value);
    if (nextValue === currentValue || savingPositionItemId === item.id) {
      input.value = currentValue;
      return;
    }
    if (!nextValue && !freePositionOnly) {
      input.value = currentValue;
      return;
    }

    setSavingPositionItemId(item.id);
    try {
      const updatedItem = await onFreeItemUpdate(item, { [field]: nextValue });
      input.value = field === "description" ? updatedItem.description : (updatedItem.unit ?? "");
    } catch {
      input.value = currentValue;
    } finally {
      setSavingPositionItemId(null);
    }
  }

  async function deleteFreeItem(item: MobileMeasurementItem): Promise<void> {
    if (savingPositionItemId === item.id) {
      return;
    }
    if (!window.confirm(`Freie Position ${getVisibleMeasurementPosition(item) || item.description} wirklich löschen?`)) {
      return;
    }
    setSavingPositionItemId(item.id);
    try {
      await onFreeItemDelete(item);
    } finally {
      setSavingPositionItemId(null);
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
                const visiblePosition = getVisibleMeasurementPosition(column.item);
                if (column.item.is_free_position) {
                  const isSavingPosition = savingPositionItemId === column.item.id;
                  const suggestionColumnKey = `item-${column.item.id}`;
                  const isSuggestionOpen = suggestionState?.columnKey === suggestionColumnKey
                    && suggestionMatches.length > 0;
                  const positionInput = (
                    <input
                      key={`${column.item.id}-${column.item.updated_at}-${visiblePosition}`}
                      className="measurement-placeholder-header-input is-free-position"
                      defaultValue={visiblePosition}
                      disabled={!canEditRows || reviewActionLoading || isSavingPosition}
                      aria-label={`Positionsnummer für manuelle Position ${column.item.description}`}
                      placeholder="Pos."
                      autoComplete="off"
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setSuggestionState({ columnKey: suggestionColumnKey, query: value, activeIndex: 0 });
                      }}
                      onFocus={(event) => {
                        if (event.currentTarget.value.trim()) {
                          setSuggestionState({ columnKey: suggestionColumnKey, query: event.currentTarget.value, activeIndex: 0 });
                        }
                      }}
                      onBlur={(event) => void saveFreeItemPositionDraft(column.item, event.currentTarget)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown" && suggestionMatches.length > 0) {
                          event.preventDefault();
                          setSuggestionState((current) => current?.columnKey === suggestionColumnKey
                            ? { ...current, activeIndex: Math.min(current.activeIndex + 1, suggestionMatches.length - 1) }
                            : current);
                        }
                        if (event.key === "ArrowUp" && suggestionMatches.length > 0) {
                          event.preventDefault();
                          setSuggestionState((current) => current?.columnKey === suggestionColumnKey
                            ? { ...current, activeIndex: Math.max(current.activeIndex - 1, 0) }
                            : current);
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          if (suggestionState?.columnKey === suggestionColumnKey && suggestionMatches.length > 0) {
                            void selectPositionSuggestion(
                              suggestionColumnKey,
                              suggestionMatches[suggestionState.activeIndex] ?? suggestionMatches[0],
                              column.item,
                            );
                          } else {
                            void saveFreeItemPositionDraft(column.item, event.currentTarget);
                          }
                        }
                        if (event.key === "Escape") {
                          event.currentTarget.value = visiblePosition;
                          setSuggestionState(null);
                        }
                      }}
                    />
                  );
                  return (
              <th
                className="measurement-matrix-position-heading"
                data-position-suggestion-column={suggestionColumnKey}
                key={column.key}
                scope="col"
              >
                {freePositionOnly ? (
                  <div className="measurement-free-position-head">
                    {positionInput}
                    <button
                      aria-label={`Freie Position ${visiblePosition || column.item.description} löschen`}
                      className="measurement-free-position-delete"
                      disabled={!canEditRows || reviewActionLoading || isSavingPosition}
                      title="Freie Position löschen"
                      type="button"
                      onClick={() => void deleteFreeItem(column.item)}
                    >×</button>
                  </div>
                ) : positionInput}
                {isSuggestionOpen ? (
                  <div className="measurement-position-suggestions" role="listbox">
                    {suggestionMatches.map((suggestion, index) => (
                      <button
                        className={index === suggestionState.activeIndex ? "is-active" : ""}
                        key={suggestion.id}
                        type="button"
                        role="option"
                        aria-selected={index === suggestionState.activeIndex}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          void selectPositionSuggestion(suggestionColumnKey, suggestion, column.item);
                        }}
                      >
                        <strong>{suggestion.position}</strong>
                        <span>{suggestion.description}</span>
                        <small>{normalizeMeasurementUnitDisplay(suggestion.unit)}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </th>
                  );
                }
                return (
              <th className="measurement-matrix-position-heading" key={column.key} scope="col">
                <strong>{visiblePosition}</strong>
              </th>
                );
              }
              if (column.kind === "placeholder") {
                return (
                  <th className="measurement-matrix-position-heading measurement-matrix-placeholder-heading" key={column.key} scope="col" />
                );
              }
              const draft = getManualColumnDraft(column.key);
              const isSuggestionOpen = suggestionState?.columnKey === column.key && suggestionMatches.length > 0;
              return (
              <th
                className="measurement-matrix-position-heading measurement-matrix-placeholder-heading measurement-matrix-office-extra-heading"
                data-position-suggestion-column={column.key}
                key={column.key}
                scope="col"
              >
                <input
                  className="measurement-placeholder-header-input"
                  value={draft.position}
                  disabled={!canEditRows || reviewActionLoading}
                  aria-label="Büro-Zusatzposition Pos.-Nr."
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
                  onBlur={(event) => void createFreeItemFromHeaderDraft(column.key, { position: event.currentTarget.value })}
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
                      void selectPositionSuggestion(column.key, suggestionMatches[suggestionState.activeIndex] ?? suggestionMatches[0]);
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
                          void selectPositionSuggestion(column.key, item);
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
            {displayColumns.map((column) => {
              if (column.kind === "item") {
                if (freePositionOnly && column.item.is_free_position) {
                  return (
                    <th className="measurement-matrix-description-heading" key={column.key} scope="col">
                      <textarea
                        className="measurement-placeholder-header-input is-description"
                        defaultValue={column.item.description}
                        disabled={!canEditRows || reviewActionLoading || savingPositionItemId === column.item.id}
                        aria-label={`Beschreibung für freie Position ${getVisibleMeasurementPosition(column.item) || column.item.id}`}
                        placeholder="Beschreibung"
                        rows={2}
                        onBlur={(event) => void saveFreeItemTextDraft(column.item, "description", event.currentTarget)}
                      />
                    </th>
                  );
                }
                return (
              <th className="measurement-matrix-description-heading" key={column.key} scope="col" title={column.item.description}><span>{column.item.description}</span></th>
                );
              }
              if (column.kind === "placeholder") {
                return (
                  <th className="measurement-matrix-description-heading measurement-matrix-placeholder-heading" key={column.key} scope="col" />
                );
              }
              return (
              <th className="measurement-matrix-description-heading measurement-matrix-placeholder-heading measurement-matrix-office-extra-heading" key={column.key} scope="col">
                <textarea
                  className="measurement-placeholder-header-input is-description"
                  value={getManualColumnDraft(column.key).description}
                  disabled={!canEditRows || reviewActionLoading}
                  aria-label="Büro-Zusatzposition Beschreibung"
                  placeholder="Beschreibung"
                  rows={2}
                  onChange={(event) => updateManualColumnDraft(column.key, { description: event.currentTarget.value })}
                  onBlur={(event) => void createFreeItemFromHeaderDraft(column.key, { description: event.currentTarget.value })}
                />
              </th>
              );
            })}
          </tr>
          <tr className="measurement-matrix-meta-row measurement-matrix-unit-row">
            <th className="measurement-matrix-axis" scope="row">Einheit</th>
            {displayColumns.map((column) => {
              if (column.kind === "item") {
                if (freePositionOnly && column.item.is_free_position) {
                  return (
                    <th className="measurement-matrix-unit-heading" key={column.key} scope="col">
                      <input
                        className="measurement-placeholder-header-input"
                        defaultValue={normalizeMeasurementUnitDisplay(column.item.unit)}
                        disabled={!canEditRows || reviewActionLoading || savingPositionItemId === column.item.id}
                        aria-label={`Einheit für freie Position ${getVisibleMeasurementPosition(column.item) || column.item.id}`}
                        placeholder="Einheit"
                        onBlur={(event) => void saveFreeItemTextDraft(column.item, "unit", event.currentTarget)}
                      />
                    </th>
                  );
                }
                return (
              <th className="measurement-matrix-unit-heading" key={column.key} scope="col">{normalizeMeasurementUnitDisplay(column.item.unit) || "-"}</th>
                );
              }
              if (column.kind === "placeholder") {
                return (
                  <th className="measurement-matrix-unit-heading measurement-matrix-placeholder-heading" key={column.key} scope="col" />
                );
              }
              return (
              <th className="measurement-matrix-unit-heading measurement-matrix-placeholder-heading measurement-matrix-office-extra-heading" key={column.key} scope="col">
                <input
                  className="measurement-placeholder-header-input"
                  value={getManualColumnDraft(column.key).unit}
                  disabled={!canEditRows || reviewActionLoading}
                  aria-label="Büro-Zusatzposition Einheit"
                  placeholder="Einheit"
                  onChange={(event) => updateManualColumnDraft(column.key, { unit: event.currentTarget.value })}
                  onBlur={(event) => {
                    updateManualColumnDraft(column.key, { unit: normalizeMeasurementUnitDisplay(event.currentTarget.value) });
                    void createFreeItemFromHeaderDraft(column.key, { unit: event.currentTarget.value });
                  }}
                />
              </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          <tr className="measurement-matrix-section-row">
            <th className="measurement-matrix-axis" scope="row">Bauteil / Ort</th>
            {displayColumns.map((column) => (
              <td
                className={column.kind === "item" ? undefined : `measurement-matrix-placeholder-cell${column.kind === "office-extra" ? " is-office-extra-column" : ""}`}
                key={column.key}
              />
            ))}
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
                  onBlur={() => saveAreaLabelDraft(area)}
                />
              </th>
              {displayColumns.map((column) => {
                if (column.kind === "placeholder") {
                  return (
                    <td className="measurement-matrix-empty-cell measurement-matrix-placeholder-cell" key={column.key} />
                  );
                }
                if (column.kind === "office-extra") {
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
                      <td className="measurement-matrix-empty-cell is-manual-column is-office-extra-column" key={column.key}>
                        <input
                          className="measurement-table-input is-quantity"
                          data-manual-column={column.key}
                          disabled={!canEditRows || reviewActionLoading}
                          inputMode="decimal"
                          aria-label={`Neue Menge ${areaLabel || "ohne Bereich"} für ${manualItem.position}`}
                          onInput={(event) => {
                            syncMeasurementNegativeInputClass(event.currentTarget);
                            updateManualColumnTotal(column.key);
                          }}
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
                    <td className={`measurement-matrix-empty-cell is-office-extra-column${isManualColumnActive ? " is-manual-column" : " measurement-matrix-placeholder-cell"}`} key={column.key}>
                      <input
                        className="measurement-table-input is-quantity"
                        data-manual-column={column.key}
                        disabled={!canEditRows || reviewActionLoading}
                        inputMode="decimal"
                        aria-label={`Neue Menge ${areaLabel || "ohne Bereich"} in Büro-Zusatzspalte`}
                        title="Büro-Zusatzposition: Pos.-Nr., Beschreibung und Einheit oben eintragen, danach Menge speichern."
                        onInput={(event) => {
                          syncMeasurementNegativeInputClass(event.currentTarget);
                          updateManualColumnTotal(column.key);
                        }}
                        onBlur={(event) => {
                          updateManualColumnTotal(column.key);
                          void saveOfficeExtraCellDraft(column.key, area, event.currentTarget);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            updateManualColumnTotal(column.key);
                            void saveOfficeExtraCellDraft(column.key, area, event.currentTarget);
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
                        onInput={(event) => syncMeasurementNegativeInputClass(event.currentTarget)}
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
                    <td className={`measurement-matrix-quantity-cell is-combined${getMeasurementCellQuantity(entries) < 0 ? " measurement-negative-quantity" : ""}`} key={item.id}>
                      <strong>{formatMeasurementNumber(getMeasurementCellQuantity(entries))}</strong>
                    </td>
                  );
                }
                const entry = entries[0];
                const displayedQuantity = formatMeasurementDraftQuantity(entry.quantity);
                const isSaving = savingEntryId === entry.id;
                return (
                  <td className={`measurement-matrix-quantity-cell${Number(entry.quantity) < 0 ? " measurement-negative-quantity" : ""}`} key={column.key}>
                    <input
                      key={`${entry.id}-${entry.updated_at}-${entry.quantity}`}
                      className={`measurement-table-input is-quantity${Number(entry.quantity) < 0 ? " measurement-negative-quantity" : ""}`}
                      defaultValue={displayedQuantity}
                      disabled={!canEditRows || reviewActionLoading || isSaving}
                      inputMode="decimal"
                      aria-label={`Menge ${areaLabel || "ohne Bereich"} für ${item.position}`}
                      onInput={(event) => syncMeasurementNegativeInputClass(event.currentTarget)}
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
              <td className={`measurement-matrix-quantity-cell${(totalsByItemId.get(column.item.id) ?? 0) < 0 ? " measurement-negative-quantity" : ""}`} key={column.key}>
                <strong>{formatMeasurementNumber(totalsByItemId.get(column.item.id) ?? 0)}</strong>
              </td>
            ) : column.kind === "placeholder" ? (
              <td className="measurement-matrix-quantity-cell measurement-matrix-placeholder-cell" key={column.key} />
            ) : (
              <td className="measurement-matrix-quantity-cell measurement-matrix-placeholder-cell is-office-extra-column" key={column.key}>
                <strong className={(manualColumnTotals[column.key] ?? 0) < 0 ? "measurement-negative-quantity" : undefined}>
                  {manualColumnTotals[column.key] !== undefined ? formatMeasurementNumber(manualColumnTotals[column.key]) : ""}
                </strong>
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
  const displayRows = analysis ? getMeasurementTimeAnalysisRowsNewestFirst(analysis.rows) : [];

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
            <div>
              <span>Soll gesamt</span>
              <strong className={getMeasurementNumericValue(analysis.totals.planned_minutes) < 0 ? "measurement-negative-quantity" : undefined}>
                {formatMeasurementDuration(getMeasurementNumericValue(analysis.totals.planned_minutes))}
              </strong>
            </div>
            <div><span>Ist gesamt</span><strong>{formatMeasurementDuration(getMeasurementNumericValue(analysis.totals.actual_minutes))}</strong></div>
            <div>
              <span>Abweichung</span>
              <strong className={signedMeasurementDurationClassName(getMeasurementNumericValue(analysis.totals.deviation_minutes))}>
                {formatSignedMeasurementDuration(getMeasurementNumericValue(analysis.totals.deviation_minutes))}
              </strong>
            </div>
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
                  <th>Ist/Soll-Quote</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row) => (
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
                    <td className={`measurement-timesheet-number${getMeasurementNumericValue(row.measurement_minutes) < 0 ? " measurement-negative-quantity" : ""}`}>
                      {formatMeasurementDuration(getMeasurementNumericValue(row.measurement_minutes))}
                    </td>
                    <td className="measurement-timesheet-number">{formatMeasurementDuration(getMeasurementNumericValue(row.extra_work_minutes))}</td>
                    <td className={`measurement-timesheet-number${getMeasurementNumericValue(row.planned_minutes) < 0 ? " measurement-negative-quantity" : ""}`}>
                      {formatMeasurementDuration(getMeasurementNumericValue(row.planned_minutes))}
                    </td>
                    <td className="measurement-timesheet-number">{formatMeasurementDuration(getMeasurementNumericValue(row.actual_minutes))}</td>
                    <td className="measurement-timesheet-number">
                      <span className={signedMeasurementDurationClassName(getMeasurementNumericValue(row.deviation_minutes))}>
                        {formatSignedMeasurementDuration(getMeasurementNumericValue(row.deviation_minutes))}
                      </span>
                    </td>
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
}: {
  site: Site;
}) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [projectTimesheet, setProjectTimesheet] = useState<MeasurementTimesheet | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isComparisonLoading, setIsComparisonLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const summary = useMemo(() => ({
    count: entries.length,
    workerCount: countSiteWorkTimeParticipants(entries),
    internalWorkMinutes: sumSiteWorkTimeMinutes(entries, "internal-work"),
    externalWorkMinutes: sumSiteWorkTimeMinutes(entries, "external-work"),
    workMinutes: sumSiteWorkTimeMinutes(entries, "work"),
    breakMinutes: sumSiteWorkTimeMinutes(entries, "break"),
    travelMinutes: sumSiteWorkTimeMinutes(entries, "travel"),
  }), [entries]);
  const hoursComparison = useMemo(
    () => buildSiteHoursComparison(projectTimesheet, summary.workMinutes),
    [projectTimesheet, summary.workMinutes],
  );
  const hourCreditMinutes = hoursComparison.valuedDifferenceMinutes !== null
    ? -hoursComparison.valuedDifferenceMinutes
    : null;
  const internalWorkTimeRows = useMemo(() => buildSiteWorkTimeDisplayRows(entries, "internal"), [entries]);
  const externalWorkTimeRows = useMemo(() => buildSiteWorkTimeDisplayRows(entries, "external"), [entries]);

  useEffect(() => {
    let ignore = false;
    setIsLoading(true);
    setError(null);

    api.timeEntries({
      siteId: site.id,
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
  }, [site.id]);

  useEffect(() => {
    let ignore = false;
    setIsComparisonLoading(true);
    setComparisonError(null);

    api.measurementTimesheet(site.id)
      .then((timesheetData) => {
        if (!ignore) {
          setProjectTimesheet(timesheetData);
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setProjectTimesheet(null);
          setComparisonError(readApiError(requestError, "Stundenvergleich konnte nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsComparisonLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [site.id]);

  return (
    <div className="project-record-tab-panel site-times-shell">
      <div className="site-times-insights">
        <section className="site-times-panel site-times-overview-panel" aria-label="Gesamtstunden">
          <div className="site-times-panel-heading">
            <h3>Gesamtstunden</h3>
            <p>Zusammenfassung aller erfassten Zeiten dieser Baustelle</p>
          </div>
          <div className="site-times-summary-list">
            <div className="site-times-summary-row">
              <span><i className="is-work" aria-hidden="true" />Arbeitszeit Monteure</span>
              <strong>{formatMeasurementDuration(summary.internalWorkMinutes)}</strong>
            </div>
            <div className="site-times-summary-row">
              <span><i className="is-external-work" aria-hidden="true" />Arbeitszeit externe</span>
              <strong>{formatMeasurementDuration(summary.externalWorkMinutes)}</strong>
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

        <section className="site-times-panel site-times-balance-panel" aria-label="Stundenvergleich">
          <div className="site-times-panel-heading site-times-balance-heading">
            <div>
              <h3>Stundenvergleich</h3>
              <p>Vergleich aus gewerteten Aufmaßen und geleisteten Monteurstunden</p>
            </div>
            <StatusBadge tone={siteHoursComparisonTone(hoursComparison.status)}>
              {siteHoursComparisonLabel(hoursComparison.status)}
            </StatusBadge>
          </div>
          {comparisonError ? <div className="project-record-empty-state is-error">{comparisonError}</div> : null}
          {isComparisonLoading ? (
            <div className="project-record-empty-state">Stundenvergleich wird geladen...</div>
          ) : null}
          {!isComparisonLoading && !comparisonError ? (
            <div className="site-times-summary-list site-times-comparison-list">
              <div className="site-times-summary-row">
                <span>Stunden abgerechnet</span>
                <strong className={hoursComparison.valuedMeasurementMinutes !== null && hoursComparison.valuedMeasurementMinutes < 0 ? "measurement-negative-quantity" : undefined}>
                  {hoursComparison.valuedMeasurementMinutes !== null
                    ? formatMeasurementDuration(hoursComparison.valuedMeasurementMinutes)
                    : "Keine gewerteten Aufmaße"}
                </strong>
              </div>
              <div className="site-times-summary-row">
                <span>Geleistete Monteurstunden</span>
                <strong>
                  {hoursComparison.workerMinutes > 0
                    ? formatMeasurementDuration(hoursComparison.workerMinutes)
                    : "Keine Stunden erfasst"}
                </strong>
              </div>
              <div className="site-times-summary-row site-times-credit-row">
                <span>Stundenguthaben</span>
                <strong className={signedMeasurementDurationClassName(hourCreditMinutes)}>
                  {hourCreditMinutes !== null
                    ? formatSignedMeasurementDuration(hourCreditMinutes)
                    : "-"}
                </strong>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <section className="site-times-table-card" aria-label="Geleistete Monteurstunden">
        <div className="site-times-table-toolbar">
          <div>
            <h3>Geleistete Monteurstunden</h3>
            <p>Finale, abrechnungsfähige Ist-Zeiten dieser Baustelle</p>
          </div>
        </div>
        {error ? <div className="project-record-empty-state is-error">{error}</div> : null}
        {isLoading ? <div className="project-record-empty-state">Arbeitszeiten werden geladen...</div> : null}
        {!isLoading && !error && entries.length === 0 ? (
          <div className="project-record-empty-state">Für diese Baustelle wurden noch keine geleisteten Monteurstunden erfasst.</div>
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
                {internalWorkTimeRows.length > 0 ? (
                  <>
                    <tr className="site-worktime-section-row">
                      <td colSpan={7}>Interne Monteurstunden</td>
                    </tr>
                    {internalWorkTimeRows.map((row) => (
                      <SiteWorkTimeTableRow key={row.key} row={row} />
                    ))}
                  </>
                ) : null}
                {externalWorkTimeRows.length > 0 ? (
                  <>
                    <tr className="site-worktime-section-row is-external">
                      <td colSpan={7}>Externe Monteurstunden</td>
                    </tr>
                    {externalWorkTimeRows.map((row) => (
                      <SiteWorkTimeTableRow key={row.key} row={row} />
                    ))}
                  </>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

type SiteWorkTimeDisplayScope = "internal" | "external";

type SiteWorkTimeDisplayRow = {
  key: string;
  entry: TimeEntry;
  scope: SiteWorkTimeDisplayScope;
  personName: string;
  workMinutes: number;
  breakMinutes: number;
  travelMinutes: number;
};

function SiteWorkTimeTableRow({ row }: { row: SiteWorkTimeDisplayRow }) {
  return (
    <tr className={row.scope === "external" ? "is-external-worktime" : undefined}>
      <td>{formatDateOnly(row.entry.work_date)}</td>
      <td>{row.personName}</td>
      <td className="site-worktime-number">{formatMeasurementDuration(row.workMinutes)}</td>
      <td className="site-worktime-number">{formatMeasurementDuration(row.breakMinutes)}</td>
      <td className="site-worktime-number">{formatMeasurementDuration(row.travelMinutes)}</td>
      <td>
        <StatusBadge tone={timeEntryStatusTone(row.entry.status)}>
          {timeEntryStatusLabels[row.entry.status] ?? row.entry.status}
        </StatusBadge>
      </td>
      <td>{row.entry.note || "-"}</td>
    </tr>
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

function EditableSiteHeaderName({
  name,
  canEdit,
  disabled,
  onSave,
}: {
  name: string;
  canEdit: boolean;
  disabled?: boolean;
  onSave: (name: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [status, setStatus] = useState<InlineEditStatus>("idle");

  useEffect(() => {
    if (!isEditing) {
      setDraftName(name);
    }
  }, [isEditing, name]);

  async function commit(): Promise<void> {
    const nextName = draftName.trim();
    if (!nextName) {
      setStatus("error");
      return;
    }
    if (nextName === name.trim()) {
      setDraftName(name);
      setIsEditing(false);
      setStatus("idle");
      return;
    }
    setStatus("saving");
    try {
      await onSave(nextName);
      setIsEditing(false);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  function cancel(): void {
    setDraftName(name);
    setIsEditing(false);
    setStatus("idle");
  }

  if (isEditing) {
    return (
      <div className="site-header-name-edit">
        <input
          className="site-header-name-input"
          autoFocus
          value={draftName}
          aria-invalid={!draftName.trim()}
          disabled={disabled || status === "saving"}
          onBlur={() => void commit()}
          onChange={(event) => {
            setDraftName(event.target.value);
            setStatus("idle");
          }}
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
        {status !== "idle" ? (
          <small className={`site-inline-edit-status is-${status}`}>
            {status === "error" && !draftName.trim() ? "Baustellenname darf nicht leer sein." : formatInlineEditStatus(status)}
          </small>
        ) : null}
      </div>
    );
  }

  return (
    <div className="site-header-name-row">
      <h1>{name}</h1>
      {canEdit ? (
        <button
          type="button"
          className="site-inline-edit-button site-header-name-edit-button"
          aria-label="Baustellenname bearbeiten"
          disabled={disabled}
          onClick={() => {
            setDraftName(name);
            setIsEditing(true);
            setStatus("idle");
          }}
        >
          <Pencil aria-hidden="true" size={13} />
        </button>
      ) : null}
      {status === "saved" || status === "error" ? <small className={`site-inline-edit-status is-${status}`}>{formatInlineEditStatus(status)}</small> : null}
    </div>
  );
}

function SiteColorDetailItem({
  label,
  value,
  canEdit,
  disabled,
  onSave,
}: {
  label: string;
  value: string;
  canEdit: boolean;
  disabled?: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<InlineEditStatus>("idle");

  useEffect(() => {
    setStatus("idle");
  }, [value]);

  async function commit(nextColor: string): Promise<void> {
    if (!canEdit || disabled || nextColor.toLowerCase() === value.toLowerCase()) {
      return;
    }
    setStatus("saving");
    try {
      await onSave(nextColor);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="detail-item site-planstatus-color-item">
      <span>{label}</span>
      <div className="site-planstatus-color-control">
        <SiteColorSelect
          className="site-planstatus-color-select"
          disabled={!canEdit || disabled || status === "saving"}
          hideLabel
          value={value}
          onChange={(color) => void commit(color)}
        />
        {status !== "idle" ? <small className={`site-inline-edit-status is-${status}`}>{formatInlineEditStatus(status)}</small> : null}
      </div>
    </div>
  );
}

type InlineEditStatus = "idle" | "saving" | "saved" | "error";

function CustomerAssignmentDetailItem({
  label,
  site,
  canEdit,
  onSaveCustomer,
}: {
  label: string;
  site: Site;
  canEdit: boolean;
  onSaveCustomer: (customer: Customer) => Promise<void>;
}) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [status, setStatus] = useState<InlineEditStatus>("idle");

  async function assignCustomer(customer: Customer): Promise<void> {
    setStatus("saving");
    try {
      await onSaveCustomer(customer);
      setStatus("saved");
    } catch (error) {
      setStatus("error");
      throw error;
    }
  }

  return (
    <div className="detail-item site-inline-edit-item project-customer-detail-item">
      <span>{label}</span>
      <strong className="site-inline-edit-display">
        <span>{site.customer || "-"}</span>
        {canEdit ? (
          <button
            type="button"
            className="site-inline-edit-button"
            aria-label={`${label} bearbeiten`}
            onClick={() => {
              setStatus("idle");
              setIsDialogOpen(true);
            }}
          >
            <Pencil aria-hidden="true" size={13} />
          </button>
        ) : null}
      </strong>
      {status === "saved" || status === "error" ? (
        <small className={`site-inline-edit-status is-${status}`}>{formatInlineEditStatus(status)}</small>
      ) : null}
      {isDialogOpen ? (
        <CustomerAssignmentDialog
          currentCustomerText={site.customer}
          currentCustomerId={site.customer_id}
          onAssignCustomer={assignCustomer}
          onClose={() => setIsDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

function CustomerAssignmentDialog({
  currentCustomerText,
  currentCustomerId,
  onAssignCustomer,
  onClose,
}: {
  currentCustomerText: string | null;
  currentCustomerId: number | null;
  onAssignCustomer: (customer: Customer) => Promise<void>;
  onClose: () => void;
}) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState(currentCustomerText ?? "");
  const [isLoading, setIsLoading] = useState(true);
  const [actionCustomerId, setActionCustomerId] = useState<number | "new" | null>(null);
  const [isCreateDrawerOpen, setIsCreateDrawerOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CustomerCreate>(emptyCustomerForProjectRecord);
  const [createError, setCreateError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    api
      .customers({ isActive: true })
      .then((customerData) => {
        if (!cancelled) {
          setCustomers(customerData);
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(readApiError(requestError, "Kunden konnten nicht geladen werden."));
        }
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
    function handleEscape(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape" && actionCustomerId === null && !isCreateDrawerOpen) {
        onClose();
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [actionCustomerId, isCreateDrawerOpen, onClose]);

  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();
  const matchingCustomers = useMemo(() => {
    const activeCustomers = customers.filter((customer) => customer.is_active);
    const matches = normalizedQuery
      ? activeCustomers.filter((customer) => customer.company_name.toLowerCase().includes(normalizedQuery))
      : activeCustomers;
    return matches.slice(0, 8);
  }, [customers, normalizedQuery]);
  const canOpenCreateDrawer = actionCustomerId === null && !isLoading;

  function openCreateDrawer(): void {
    setCreateForm({
      ...emptyCustomerForProjectRecord,
      company_name: trimmedQuery,
    });
    setCreateError(null);
    setError(null);
    setIsCreateDrawerOpen(true);
  }

  function closeCreateDrawer(): void {
    if (actionCustomerId !== null) {
      return;
    }
    setIsCreateDrawerOpen(false);
    setCreateForm(emptyCustomerForProjectRecord);
    setCreateError(null);
  }

  async function assignExistingCustomer(customer: Customer): Promise<void> {
    if (actionCustomerId !== null) {
      return;
    }
    setActionCustomerId(customer.id);
    setError(null);
    let shouldClose = false;
    try {
      await onAssignCustomer(customer);
      shouldClose = true;
    } catch (requestError) {
      setError(readApiError(requestError, "Kunde konnte nicht zugeordnet werden."));
    } finally {
      setActionCustomerId(null);
    }
    if (shouldClose) {
      onClose();
    }
  }

  async function createAndAssignCustomer(): Promise<void> {
    if (actionCustomerId !== null) {
      return;
    }
    const validationError = validateCustomerPayload(createForm);
    if (validationError) {
      setCreateError(validationError);
      return;
    }
    setActionCustomerId("new");
    setCreateError(null);
    setError(null);
    let shouldClose = false;
    try {
      const created = await api.createCustomer(normalizeCustomerPayload(createForm));
      setCustomers((current) => [...current.filter((customer) => customer.id !== created.id), created].sort(compareCustomersByName));
      setQuery(created.company_name);
      await onAssignCustomer(created);
      setIsCreateDrawerOpen(false);
      setCreateForm(emptyCustomerForProjectRecord);
      shouldClose = true;
    } catch (requestError) {
      setCreateError(readApiError(requestError, "Kunde konnte nicht angelegt oder zugeordnet werden."));
    } finally {
      setActionCustomerId(null);
    }
    if (shouldClose) {
      onClose();
    }
  }

  return (
    <div
      className="project-customer-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && actionCustomerId === null) {
          onClose();
        }
      }}
    >
      <section className="project-customer-dialog" role="dialog" aria-modal="true" aria-labelledby="project-customer-dialog-title">
        <header className="project-customer-dialog-header">
          <div>
            <h3 id="project-customer-dialog-title">Kunde zuordnen</h3>
            <p>{currentCustomerId ? "Aktuell mit Kundenstamm verknuepft." : currentCustomerText ? `Bisheriger Kundentext: ${currentCustomerText}` : "Noch kein Kunde zugeordnet."}</p>
          </div>
          <button type="button" className="secondary-action" disabled={actionCustomerId !== null} onClick={onClose}>
            Schliessen
          </button>
        </header>

        <label className="project-customer-search-field">
          <span>Kunde suchen</span>
          <input
            autoFocus
            autoComplete="off"
            disabled={actionCustomerId !== null}
            placeholder="Kundenname"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setError(null);
            }}
          />
        </label>

        <div className="project-customer-result-list" role="listbox" aria-busy={isLoading}>
          {isLoading ? <span className="project-customer-empty">Kunden werden geladen...</span> : null}
          {!isLoading && matchingCustomers.map((customer) => (
            <button
              key={customer.id}
              type="button"
              role="option"
              aria-selected={currentCustomerId === customer.id}
              disabled={actionCustomerId !== null}
              onClick={() => void assignExistingCustomer(customer)}
            >
              <strong>{customer.company_name}</strong>
              <span>{formatCustomerMetaForProjectRecord(customer)}</span>
            </button>
          ))}
          {!isLoading && matchingCustomers.length === 0 ? (
            <span className="project-customer-empty">Kein passender Kunde gefunden.</span>
          ) : null}
        </div>

        <div className="project-customer-create-row">
          <span>Nicht in der Liste?</span>
          <button type="button" className="secondary-action" disabled={!canOpenCreateDrawer} onClick={openCreateDrawer}>
            <UserPlus aria-hidden="true" size={15} />
            Neuen Kunden anlegen
          </button>
        </div>

        {error ? <p className="form-error">{error}</p> : null}
      </section>

      <EntityDetailDrawer
        isOpen={isCreateDrawerOpen}
        title="Neuer Kunde"
        subtitle="Kundenstammdaten anlegen"
        onClose={closeCreateDrawer}
        footer={(
          <button className="icon-button" disabled={actionCustomerId !== null} type="button" onClick={() => void createAndAssignCustomer()}>
            <UserPlus aria-hidden="true" size={17} />
            <span>{actionCustomerId === "new" ? "Kunde wird angelegt..." : "Kunde anlegen"}</span>
          </button>
        )}
      >
        {createError ? <p className="form-error">{createError}</p> : null}
        <CustomerFields
          draft={createForm}
          onChange={(values) => setCreateForm((current) => ({ ...current, ...values }))}
        />
      </EntityDetailDrawer>
    </div>
  );
}

function compareCustomersByName(left: Customer, right: Customer): number {
  return left.company_name.localeCompare(right.company_name, "de");
}

function formatCustomerMetaForProjectRecord(customer: Customer): string {
  return [
    formatCustomerAddressForProjectRecord(customer),
    customer.project_lead_name ? `Projektleiter: ${customer.project_lead_name}` : "",
    customer.company_phone,
  ].filter(Boolean).join(" · ") || "Kundenstamm";
}

function formatCustomerAddressForProjectRecord(
  customer: Pick<Customer, "address_street" | "address_house_number" | "address_postal_code" | "address_city" | "address_country">,
): string {
  const streetLine = [customer.address_street, customer.address_house_number].filter(Boolean).join(" ");
  const cityLine = [customer.address_postal_code, customer.address_city].filter(Boolean).join(" ");
  return [streetLine, cityLine, customer.address_country].filter(Boolean).join(", ");
}

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
  if (["approved", "billed", "closed", "completed", "finalized", "abgeschlossen"].includes(status)) {
    return { label: "Abgeschlossen", className: "measurement-status measurement-review-status-badge is-billed" };
  }
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

type CustomerEmailStatusItem = {
  customer_email_sent_at: string | null;
  customer_email_signature_present: boolean | null;
  customer_signed_at: string | null;
  customer_signature_name?: string | null;
  is_locked_for_worker?: boolean;
};

function CustomerEmailStatusLine({ item }: { item: CustomerEmailStatusItem }) {
  const status = getCustomerEmailStatus(item);
  return <small className={`measurement-review-email-status ${status.className}`}>{status.label}</small>;
}

function getCustomerEmailStatus(item: CustomerEmailStatusItem): { label: string; className: string } {
  if (!item.customer_email_sent_at) {
    return {
      label: "Nicht an Kunden gesendet",
      className: "is-not-sent",
    };
  }
  const signaturePresent = Boolean(item.customer_signed_at || item.customer_signature_name || item.is_locked_for_worker)
    || item.customer_email_signature_present === true;
  const sentAt = formatCustomerEmailSentDate(item.customer_email_sent_at);
  if (signaturePresent) {
    return {
      label: `An Kunden gesendet - Unterschrift erhalten · ${sentAt}`,
      className: "is-complete",
    };
  }
  return {
    label: `An Kunden gesendet · Unterschrift fehlt · ${sentAt}`,
    className: "is-signature-open",
  };
}

function formatCustomerEmailSentDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).format(parsed);
}

function formatExtraWorkTicketTitle(ticket: MobileExtraWorkTicket): string {
  const suffix = ticket.title?.trim() || "Hauptauftrag";
  return `Zusatzauftrag ${ticket.display_number}${suffix ? ` - ${suffix}` : ""}`;
}

function formatExtraWorkTicketSubmitter(ticket: MobileExtraWorkTicket): string {
  const submitter = ticket.created_by_name ? `Von ${ticket.created_by_name}` : "Ohne Einreicher";
  const submittedAt = ticket.submitted_at ?? ticket.created_at;
  return submittedAt ? `${submitter} · ${formatDateTime(submittedAt)}` : submitter;
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
  return MEASUREMENT_BATCH_BILLED_STATUSES.has(status.toLowerCase());
}

function isMeasurementBatchPdfExportable(status: string): boolean {
  return isMeasurementBatchBilled(status) || isMeasurementBatchReviewed(status) || status === "customer_signed";
}

function isMeasurementBatchReviewed(status: string): boolean {
  return MEASUREMENT_BATCH_REVIEWED_STATUSES.has(status.toLowerCase());
}

function isMeasurementBatchBeforeSubmitted(status: string): boolean {
  return MEASUREMENT_BATCH_BEFORE_SUBMITTED_STATUSES.has(status.toLowerCase());
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

function siteTimeCreditClassName(minutes: number | null): string {
  if (minutes === null || minutes === 0) {
    return "is-neutral";
  }
  return minutes > 0 ? "is-positive" : "is-negative";
}

function signedMeasurementDurationClassName(minutes: number | null): string {
  return `measurement-signed-duration ${siteTimeCreditClassName(minutes)}`;
}

function getMeasurementTimeAnalysisRowsNewestFirst(rows: MeasurementTimeAnalysisRow[]): MeasurementTimeAnalysisRow[] {
  return [...rows].sort(compareMeasurementTimeAnalysisRowsNewestFirst);
}

function compareMeasurementTimeAnalysisRowsNewestFirst(
  left: MeasurementTimeAnalysisRow,
  right: MeasurementTimeAnalysisRow,
): number {
  const rightTime = getMeasurementTimeAnalysisRowSortTime(right);
  const leftTime = getMeasurementTimeAnalysisRowSortTime(left);
  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }
  if (right.measurement_number !== left.measurement_number) {
    return right.measurement_number - left.measurement_number;
  }
  return right.measurement_batch_id - left.measurement_batch_id;
}

function getMeasurementTimeAnalysisRowSortTime(row: MeasurementTimeAnalysisRow): number {
  const value = row.analysis_at ?? row.period_end ?? row.period_start;
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
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
  const trimmed = value.trim();
  const normalized = trimmed.includes(",")
    ? trimmed.replace(/\./g, "").replace(",", ".")
    : trimmed;
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function syncMeasurementNegativeInputClass(input: HTMLInputElement): void {
  const quantity = parseMeasurementQuantityInput(input.value);
  input.classList.toggle("measurement-negative-quantity", quantity !== null && quantity < 0);
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

function sumSiteWorkTimeMinutes(entries: TimeEntry[], field: "work" | "internal-work" | "external-work" | "break" | "travel"): number {
  return entries.reduce((sum, entry) => sum + getSiteWorkTimeMinutes(entry, field), 0);
}

function buildSiteWorkTimeDisplayRows(entries: TimeEntry[], scope: SiteWorkTimeDisplayScope): SiteWorkTimeDisplayRow[] {
  return entries.flatMap((entry): SiteWorkTimeDisplayRow[] => {
    if (scope === "internal") {
      if (isExternalTimeEntryPerson(entry)) {
        return [];
      }
      return [{
        key: `internal-${entry.id}`,
        entry,
        scope,
        personName: entry.person_name || `Person ${entry.person_id}`,
        workMinutes: getSiteWorkTimeBaseMinutes(entry),
        breakMinutes: getSiteWorkTimeBaseBreakMinutes(entry),
        travelMinutes: getSiteWorkTimeBaseTravelMinutes(entry),
      }];
    }

    const externalFactor = getSiteWorkTimeExternalFactor(entry);
    if (externalFactor <= 0) {
      return [];
    }

    return [{
      key: `external-${entry.id}`,
      entry,
      scope,
      personName: formatSiteWorkTimeExternalNames(entry, externalFactor),
      workMinutes: getSiteWorkTimeBaseMinutes(entry) * externalFactor,
      breakMinutes: getSiteWorkTimeBaseBreakMinutes(entry) * externalFactor,
      travelMinutes: getSiteWorkTimeBaseTravelMinutes(entry) * externalFactor,
    }];
  });
}

function getSiteWorkTimeMinutes(entry: TimeEntry, field: "work" | "internal-work" | "external-work" | "break" | "travel"): number {
  if (field === "work") {
    return entry.project_mounting_work_minutes ?? entry.work_minutes;
  }
  if (field === "internal-work") {
    return isExternalTimeEntryPerson(entry) ? 0 : getSiteWorkTimeBaseMinutes(entry);
  }
  if (field === "external-work") {
    const baseMinutes = getSiteWorkTimeBaseMinutes(entry);
    const externalFactor = entry.project_mounting_external_person_count + (isExternalTimeEntryPerson(entry) ? 1 : 0);
    return baseMinutes * externalFactor;
  }
  if (field === "break") {
    return entry.project_mounting_break_minutes ?? entry.break_minutes;
  }
  return entry.project_mounting_travel_minutes ?? entry.travel_minutes;
}

function getSiteWorkTimeBaseMinutes(entry: TimeEntry): number {
  return entry.project_mounting_base_work_minutes ?? entry.work_minutes;
}

function getSiteWorkTimeBaseBreakMinutes(entry: TimeEntry): number {
  return getSiteWorkTimeBaseShare(entry.project_mounting_break_minutes, entry.break_minutes, entry.project_mounting_multiplier);
}

function getSiteWorkTimeBaseTravelMinutes(entry: TimeEntry): number {
  return getSiteWorkTimeBaseShare(entry.project_mounting_travel_minutes, entry.travel_minutes, entry.project_mounting_multiplier);
}

function getSiteWorkTimeBaseShare(totalMinutes: number | null, fallbackMinutes: number, multiplier: number): number {
  if (totalMinutes === null || multiplier <= 1) {
    return fallbackMinutes;
  }
  return Math.round(totalMinutes / multiplier);
}

function isExternalTimeEntryPerson(entry: TimeEntry): boolean {
  return entry.person_type === "external" || entry.person_type === "external_temp";
}

function getSiteWorkTimeExternalFactor(entry: TimeEntry): number {
  return entry.project_mounting_external_person_count + (isExternalTimeEntryPerson(entry) ? 1 : 0);
}

function formatSiteWorkTimeExternalNames(entry: TimeEntry, externalFactor: number): string {
  const participantNames = entry.project_mounting_participant_names.filter((name) => name.trim().length > 0);
  const externalNames = isExternalTimeEntryPerson(entry)
    ? [entry.person_name || `Person ${entry.person_id}`, ...participantNames.filter((name) => name !== entry.person_name)]
    : participantNames.slice(1);
  const uniqueNames = Array.from(new Set(externalNames)).filter((name) => name.trim().length > 0);

  if (uniqueNames.length === 1) {
    return uniqueNames[0];
  }
  if (uniqueNames.length > 1) {
    return `${uniqueNames.length} externe Monteure (${uniqueNames.join(", ")})`;
  }
  return externalFactor === 1 ? "Externer Monteur" : `${externalFactor} externe Monteure`;
}

function countSiteWorkTimeParticipants(entries: TimeEntry[]): number {
  const participantIds = new Set<number>();
  entries.forEach((entry) => {
    if (entry.project_mounting_participant_ids.length > 0) {
      entry.project_mounting_participant_ids.forEach((participantId) => participantIds.add(participantId));
    } else {
      participantIds.add(entry.person_id);
    }
  });
  return participantIds.size;
}

function buildSiteHoursComparison(
  timesheet: MeasurementTimesheet | null,
  workerMinutes: number,
): SiteHoursComparison {
  const offerMinutes = timesheet?.kpi.has_planned_basis
    ? getMeasurementNumericValue(timesheet.kpi.planned_minutes)
    : null;
  const valuedMeasurementMinutes = timesheet?.kpi.billed_minutes === null
    || timesheet?.kpi.billed_minutes === undefined
    ? null
    : getMeasurementNumericValue(timesheet.kpi.billed_minutes);
  const hasMissingMeasurementBasis = (timesheet?.kpi.billed_missing_position_count ?? 0) > 0;

  return {
    offerMinutes,
    valuedMeasurementMinutes,
    workerMinutes,
    offerDifferenceMinutes: offerMinutes !== null ? workerMinutes - offerMinutes : null,
    valuedDifferenceMinutes: valuedMeasurementMinutes !== null ? workerMinutes - valuedMeasurementMinutes : null,
    status: getSiteHoursComparisonStatus(
      offerMinutes,
      valuedMeasurementMinutes,
      workerMinutes,
      hasMissingMeasurementBasis,
    ),
  };
}

function getSiteHoursComparisonStatus(
  offerMinutes: number | null,
  valuedMeasurementMinutes: number | null,
  workerMinutes: number,
  hasMissingMeasurementBasis = false,
): SiteHoursComparisonStatus {
  if (
    hasMissingMeasurementBasis
    || offerMinutes === null
    || offerMinutes <= 0
    || valuedMeasurementMinutes === null
    || valuedMeasurementMinutes <= 0
    || workerMinutes <= 0
  ) {
    return "missing";
  }
  const offerUsage = workerMinutes / offerMinutes;
  const valuedUsage = workerMinutes / valuedMeasurementMinutes;
  if (offerUsage > 1 || valuedUsage > 1.15) {
    return "critical";
  }
  if (offerUsage >= 0.85 || valuedUsage > 1.05) {
    return "watch";
  }
  return "on_course";
}

function siteHoursComparisonLabel(status: SiteHoursComparisonStatus): string {
  if (status === "on_course") {
    return "Auf Kurs";
  }
  if (status === "watch") {
    return "Beobachten";
  }
  if (status === "critical") {
    return "Kritisch";
  }
  return "Daten fehlen";
}

function siteHoursComparisonTone(status: SiteHoursComparisonStatus): StatusBadgeTone {
  if (status === "on_course") {
    return "active";
  }
  if (status === "watch") {
    return "warning";
  }
  if (status === "critical") {
    return "danger";
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

function normalizeMeasurementArea(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
}

function createClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `measurement-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
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
