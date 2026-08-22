import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  Camera,
  CalendarDays,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  DoorOpen,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Grid2X2,
  Hammer,
  Images,
  Layers3,
  MapPin,
  Mail,
  MessageSquare,
  Package,
  Pencil,
  Plus,
  ReceiptText,
  Search,
  Send,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { FileOpener } from "@capacitor-community/file-opener";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent as ReactChangeEvent, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type TouchEvent as ReactTouchEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { MobileBackButton } from "../components/MobileBackButton";
import { MobilePhotoCaptionViewer } from "../components/MobilePhotoCaptionViewer";
import { SiteStatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import { formatExtraWorkHours, getExtraWorkDailyHoursTotalError, parseExtraWorkHoursInput } from "../lib/extraWorkHours";
import { formatExtraWorkMaterialQuantity, parseExtraWorkMaterialInput, parseExtraWorkMaterialQuantity } from "../lib/extraWorkMaterial";
import { formatGermanDateKey, formatGermanDateKeyRange } from "../lib/formatters";
import { buildMeasurementSourceDocumentGroups } from "../lib/measurementPositionGroups";
import { formatProjectDocumentMeta, getProjectDocumentKind, type ProjectDocumentKind } from "../lib/projectFiles";
import { drawSignatureCanvas, getNormalizedSignaturePoint } from "../lib/signatureCanvas";
import { useMobileModalStack } from "../lib/useMobileModalStack";
import type { MobileAssignment, MobileAssignmentsResponse } from "../types/mobile";
import type { CustomerSignatureStroke, ExtraWorkTicketEmailSendResponse, MeasurementAreaRow, MeasurementEntry, MobileExtraWorkMaterialItem, MobileExtraWorkTicket, MobileExtraWorkTicketEntry, MobileExtraWorkTicketPhoto, MobileExtraWorkWorkerHours, MobileMeasurementBatch, MobileMeasurementBatchPhoto, MobileMeasurementItem, ProjectFolder, ProjectFolderDocumentItem, ProjectFolderDocumentList, SiteEmailRecipient } from "../types/site";
import { getIsoWeekInfo, getIsoWeekRange, getIsoWeeksInYear } from "../utils/dateRange";

const CACHE_KEY = "kb_mobile_assignments_cache_v1";
let pdfJsLoader: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfJsLoader) {
    pdfJsLoader = import("pdfjs-dist").then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjsLib;
    });
  }
  return pdfJsLoader;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const mediaQuery = window.matchMedia(query);
    const handleChange = () => setMatches(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}

type MobileDetailTab = "overview" | "folders" | "measurement" | "extra-work" | "tools" | "photos";
type MobileDetailActionKey = MobileDetailTab | "timesheet";
type MeasurementViewMode = "list" | "table";
type InlineMeasurementEditMode = "cell" | "add-row";
type InlineMeasurementCell = {
  itemId: number;
  area: string;
  mode: InlineMeasurementEditMode;
};
type MeasurementPositionGroupKind = "prefix" | "all" | "captured" | "free";
type MeasurementPositionGroup = {
  key: string;
  label: string;
  count: number;
  kind: MeasurementPositionGroupKind;
  itemIds: Set<number>;
  sourceItemCount?: number;
};
const MEASUREMENT_TITLE_GROUP_MISC_THRESHOLD = 13;
const MEASUREMENT_TITLE_GROUP_MIN_OWN_BADGE_COUNT = 3;
type MeasurementFreePositionDraft = {
  position: string;
  description: string;
  unit: string;
  quantity: string;
  areaOrComment: string;
};
const MOBILE_MEASUREMENT_FREE_UNITS = ["st", "m", "psch", "std"] as const;
const MOBILE_MEASUREMENT_TABLE_MIN_COLUMNS = 13;
const MOBILE_MEASUREMENT_TABLE_DEFAULT_AREA_ROWS = 6;
const MOBILE_MEASUREMENT_TABLE_TRAILING_ADD_ROW_ANCHOR = "__trailing_area_add__";
const MOBILE_MEASUREMENT_TABLE_PLACEHOLDER_ITEM_ID_BASE = -1_000_000;
const PDF_MIN_ZOOM = 0.75;
const PDF_MAX_ZOOM = 2.5;
const PDF_RENDER_QUALITY_MULTIPLIER = 1.6;
const PDF_MAX_RENDER_PIXEL_RATIO = 3.5;
const PDF_MAX_CANVAS_PIXELS = 8_000_000;
const MOBILE_DOCUMENT_PHOTO_LIMIT = 5;
const MAX_PHOTO_DIMENSION = 1600;
const PHOTO_JPEG_QUALITY = 0.8;
const EMPTY_MEASUREMENT_FREE_POSITION_DRAFT: MeasurementFreePositionDraft = {
  position: "",
  description: "",
  unit: "st",
  quantity: "0,00",
  areaOrComment: "",
};

type PdfContentSize = {
  width: number;
  height: number;
};

type PdfFocalPoint = {
  clientX: number;
  clientY: number;
};

type PdfPinchState = {
  initialDistance: number;
  initialZoom: number;
  latestZoom: number;
  latestFocal: PdfFocalPoint | null;
};

const TABLET_INLINE_MEASUREMENT_QUERY = "(min-width: 700px) and (max-width: 1199px)";
const EXTRA_WORK_WEEK_DAYS = [
  { key: "monday_hours", surcharge25Key: "monday_surcharge_25_hours", surcharge50Key: "monday_surcharge_50_hours", label: "Mo" },
  { key: "tuesday_hours", surcharge25Key: "tuesday_surcharge_25_hours", surcharge50Key: "tuesday_surcharge_50_hours", label: "Di" },
  { key: "wednesday_hours", surcharge25Key: "wednesday_surcharge_25_hours", surcharge50Key: "wednesday_surcharge_50_hours", label: "Mi" },
  { key: "thursday_hours", surcharge25Key: "thursday_surcharge_25_hours", surcharge50Key: "thursday_surcharge_50_hours", label: "Do" },
  { key: "friday_hours", surcharge25Key: "friday_surcharge_25_hours", surcharge50Key: "friday_surcharge_50_hours", label: "Fr" },
  { key: "saturday_hours", surcharge25Key: "saturday_surcharge_25_hours", surcharge50Key: "saturday_surcharge_50_hours", label: "Sa" },
  { key: "sunday_hours", surcharge25Key: "sunday_surcharge_25_hours", surcharge50Key: "sunday_surcharge_50_hours", label: "So" },
] as const;
type ExtraWorkWeekdayKey = (typeof EXTRA_WORK_WEEK_DAYS)[number]["key"];
const EXTRA_WORK_HIDDEN_SURCHARGE_KEYS = [
  "monday_surcharge_25_hours",
  "tuesday_surcharge_25_hours",
  "wednesday_surcharge_25_hours",
  "thursday_surcharge_25_hours",
  "friday_surcharge_25_hours",
  "saturday_surcharge_25_hours",
  "sunday_surcharge_25_hours",
  "monday_surcharge_50_hours",
  "tuesday_surcharge_50_hours",
  "wednesday_surcharge_50_hours",
  "thursday_surcharge_50_hours",
  "friday_surcharge_50_hours",
  "saturday_surcharge_50_hours",
  "sunday_surcharge_50_hours",
] as const;
type ExtraWorkHiddenSurchargeKey = (typeof EXTRA_WORK_HIDDEN_SURCHARGE_KEYS)[number];
const EXTRA_WORK_DEFAULT_TITLE_SUFFIX = "Hauptauftrag";

type LocationState = {
  assignment?: MobileAssignment;
};

type MobileFolderNavigationLevel = {
  itemId: string;
  name: string;
  documents: ProjectFolderDocumentList;
};

type MobileDocumentPreviewState = {
  item: ProjectFolderDocumentItem;
  kind: ProjectDocumentKind;
  status: "loading" | "ready" | "unsupported" | "error";
  url: string | null;
  error: string | null;
};

type MobileProjectPhotoPreviewState = {
  item: ProjectFolderDocumentItem;
  url: string;
};

const detailTabs: Array<{ key: MobileDetailActionKey; label: string; description: string; icon: typeof ClipboardList }> = [
  { key: "folders", label: "Ordner", description: "Projektordner und Dateien", icon: FolderOpen },
  { key: "measurement", label: "Aufmaß", description: "Pakete und Positionen erfassen", icon: ReceiptText },
  { key: "extra-work", label: "Stundenzettel", description: "Zusatzstunden erfassen", icon: FileText },
  { key: "timesheet", label: "Zeitenliste", description: "Aktuelle Zeitenliste anzeigen", icon: ClipboardList },
  { key: "tools", label: "Werkzeuge & Material", description: "Status später verfügbar", icon: Package },
];

export function MobileAssignmentDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { assignmentId } = useParams();
  const [activeTab, setActiveTab] = useState<MobileDetailTab | null>(null);
  const [isMeasurementEntryMode, setIsMeasurementEntryMode] = useState(false);
  const [isOpeningTimesheet, setIsOpeningTimesheet] = useState(false);
  const [timesheetMessage, setTimesheetMessage] = useState<string | null>(null);

  const assignment = useMemo(() => {
    const stateAssignment = (location.state as LocationState | null)?.assignment;
    if (stateAssignment) {
      return stateAssignment;
    }
    return findCachedAssignment(assignmentId);
  }, [assignmentId, location.state]);

  if (!assignment) {
    return (
      <section className="mobile-page mobile-detail-page">
        <MobileBackButton label="Zurück zu Meine Einsätze" onClick={() => navigate("/me/assignments")} />
        <div className="empty-panel">Dieser Einsatz konnte nicht aus dem lokalen Verlauf geladen werden.</div>
      </section>
    );
  }

  const currentAssignment = assignment;
  const isOverviewFlow = activeTab === "overview";
  const isFoldersFlow = activeTab === "folders";
  const isMeasurementFlow = activeTab === "measurement";
  const isExtraWorkFlow = activeTab === "extra-work";
  const isProjectPhotosFlow = activeTab === "photos";
  const isFocusedEntry = isMeasurementFlow && isMeasurementEntryMode;

  function openOverview(): void {
    setActiveTab("overview");
    setIsMeasurementEntryMode(false);
  }

  async function openTimesheetPdf(): Promise<void> {
    if (isOpeningTimesheet) {
      return;
    }
    setIsOpeningTimesheet(true);
    setTimesheetMessage(null);
    try {
      const blob = await api.mobileMeasurementTimesheetPdf(currentAssignment.id);
      const filename = "Zeitenliste.pdf";
      if (isNativeAndroidApp()) {
        await openAndroidPdfBlob(blob, filename);
      } else {
        const url = window.URL.createObjectURL(blob);
        const openedWindow = window.open(url, "_blank", "noopener,noreferrer");
        if (!openedWindow) {
          downloadBlobFile(blob, filename);
        }
        window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
      }
    } catch (requestError) {
      setTimesheetMessage(readApiError(requestError, "Zeitenliste konnte nicht geöffnet werden."));
    } finally {
      setIsOpeningTimesheet(false);
    }
  }

  function handleDetailAction(tab: (typeof detailTabs)[number]): void {
    if (tab.key === "timesheet") {
      void openTimesheetPdf();
      return;
    }
    setActiveTab(tab.key);
    if (tab.key !== "measurement") {
      setIsMeasurementEntryMode(false);
    }
  }

  return (
    <section className={`mobile-page mobile-detail-page${isFocusedEntry ? " is-entry-mode" : ""}`}>
      {isOverviewFlow ? (
        <>
          <button className="icon-button secondary mobile-back-button" type="button" onClick={() => setActiveTab(null)}>
            <ArrowLeft aria-hidden="true" size={17} />
            <span>Projektakte</span>
          </button>
        </>
      ) : isFoldersFlow ? (
        <MobileProjectFoldersHeader assignment={assignment} onBack={() => setActiveTab(null)} />
      ) : !isMeasurementFlow && !isExtraWorkFlow && !isProjectPhotosFlow ? (
        <>
          <MobileBackButton label="Zurück zu Meine Einsätze" onClick={() => navigate("/me/assignments")} />

          <header
            className="mobile-detail-hero mobile-detail-summary mobile-detail-summary-button"
            role="button"
            tabIndex={0}
            onClick={openOverview}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openOverview();
              }
            }}
          >
            <div className="assignment-card-main">
              <div>
                <h1>{assignment.site.name}</h1>
                <p className="muted-text">{[assignment.site.site_number, assignment.site.customer].filter(Boolean).join(" · ")}</p>
              </div>
              <SiteStatusBadge status={assignment.site.status} />
            </div>
            <p className="assignment-date">
              <span><CalendarClock aria-hidden="true" size={15} />{formatAssignmentRange(assignment)}</span>
              <ChevronRight aria-hidden="true" className="mobile-detail-summary-chevron" size={17} />
            </p>
          </header>

          <div className="mobile-detail-actions" aria-label="Baustellendetails">
            {detailTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  className={tab.key !== "timesheet" && activeTab === tab.key ? "is-active" : ""}
                  disabled={tab.key === "timesheet" && isOpeningTimesheet}
                  key={tab.key}
                  type="button"
                  onClick={() => handleDetailAction(tab)}
                >
                  <Icon aria-hidden="true" size={16} />
                  <span>
                    <strong>{tab.label}</strong>
                    <small>{tab.key === "timesheet" && isOpeningTimesheet ? "Zeitenliste wird geladen..." : tab.description}</small>
                  </span>
                </button>
              );
            })}
            {timesheetMessage ? (
              <p className="mobile-detail-action-message">
                {timesheetMessage}
                {timesheetMessage === "Keine aktive Zeitenliste ausgewählt." ? (
                  <span>Bitte im Büro/Projektleiterbereich unter Baustellen / Aufmaß / Angebot auswählen.</span>
                ) : null}
              </p>
            ) : null}
          </div>
          {activeTab === null ? <MobileProjectPhotoCapture assignment={assignment} onOpenPhotos={() => setActiveTab("photos")} /> : null}
        </>
      ) : null}

      {activeTab === "overview" && <OverviewPanel assignment={assignment} />}
      {activeTab === "folders" && <MobileProjectFoldersPanel assignment={assignment} />}
      {activeTab === "measurement" && (
        <MobileMeasurementTab
          assignment={assignment}
          onBackToProject={() => {
            setIsMeasurementEntryMode(false);
            setActiveTab(null);
          }}
          onEntryModeChange={setIsMeasurementEntryMode}
        />
      )}
      {activeTab === "extra-work" && (
        <MobileExtraWorkTab
          assignment={assignment}
          onBack={() => setActiveTab(null)}
        />
      )}
      {activeTab === "photos" && (
        <MobileProjectPhotosPanel
          assignment={assignment}
          onBack={() => setActiveTab(null)}
        />
      )}
      {activeTab === "tools" && <PlaceholderPanel icon={Hammer} text="Werkzeuge & Material wird später Wagen-, Werkzeug- und Materialinformationen anzeigen." />}
    </section>
  );
}

function MobileProjectFoldersHeader({
  assignment,
  onBack,
}: {
  assignment: MobileAssignment;
  onBack: () => void;
}) {
  return (
    <>
      <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={17} />
        <span>Projektakte</span>
      </button>

      <header className="mobile-detail-hero mobile-detail-summary mobile-folder-master-header">
        <div className="assignment-card-main">
          <div>
            <p className="eyebrow">Ordner</p>
            <h1>{assignment.site.name}</h1>
            <p className="muted-text">{[assignment.site.site_number, assignment.site.customer].filter(Boolean).join(" · ")}</p>
          </div>
          <FolderOpen aria-hidden="true" className="mobile-folder-master-icon" size={24} />
        </div>
        <p className="assignment-date">
          <span><FolderOpen aria-hidden="true" size={15} />Projektordner und Dateien</span>
        </p>
      </header>
    </>
  );
}

function MobileExtraWorkTab({
  assignment,
  onBack,
}: {
  assignment: MobileAssignment;
  onBack: () => void;
}) {
  const [orders, setOrders] = useState<MobileExtraWorkTicket[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<MobileExtraWorkTicket | null>(null);
  const [photoGalleryOrder, setPhotoGalleryOrder] = useState<MobileExtraWorkTicket | null>(null);
  const [photoUploadOrder, setPhotoUploadOrder] = useState<MobileExtraWorkTicket | null>(null);
  const [photoGalleryVersion, setPhotoGalleryVersion] = useState(0);
  const [isEditingEntry, setIsEditingEntry] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [photoMessageTone, setPhotoMessageTone] = useState<"info" | "error">("info");
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const requiresApproval = assignment.site.requires_extra_work_approval;
  const primaryKind: "billing" | "approval" = requiresApproval ? "approval" : "billing";

  useEffect(() => {
    void loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment.id]);

  async function loadOrders(selectOrderId?: number): Promise<void> {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.mobileExtraWorkTickets(assignment.id);
      const sortedOrders = sortMobileExtraWorkOrders(response);
      setOrders(sortedOrders);
      setSelectedOrder((currentOrder) => {
        const selectedId = selectOrderId ?? currentOrder?.id;
        return selectedId ? sortedOrders.find((order) => order.id === selectedId) ?? null : null;
      });
    } catch (requestError) {
      setError(readApiError(requestError, "Stundenzettel konnten nicht geladen werden."));
      setOrders([]);
    } finally {
      setIsLoading(false);
    }
  }

  function mergeUpdatedOrder(updatedOrder: MobileExtraWorkTicket): void {
    const nextOrders = orders.some((order) => order.id === updatedOrder.id)
      ? orders.map((order) => (order.id === updatedOrder.id ? updatedOrder : order))
      : [updatedOrder, ...orders];
    const sortedOrders = sortMobileExtraWorkOrders(nextOrders);
    setOrders(sortedOrders);
    setSelectedOrder(updatedOrder);
  }

  function updateOrderPhotoCount(orderId: number, nextCount: number): void {
    const normalizedCount = Math.max(0, nextCount);
    const applyCount = (order: MobileExtraWorkTicket) => (
      order.id === orderId ? { ...order, photo_count: normalizedCount } : order
    );
    setOrders((currentOrders) => currentOrders.map(applyCount));
    setSelectedOrder((currentOrder) => (currentOrder ? applyCount(currentOrder) : currentOrder));
    setPhotoGalleryOrder((currentOrder) => (currentOrder ? applyCount(currentOrder) : currentOrder));
  }

  async function createOrder(): Promise<void> {
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const createdOrder = await api.createMobileExtraWorkTicket(assignment.id, { kind: primaryKind });
      mergeUpdatedOrder(createdOrder);
    } catch (requestError) {
      setError(readApiError(requestError, `${formatMobileExtraWorkKindLabel(primaryKind)} konnte nicht erstellt werden.`));
    } finally {
      setIsSaving(false);
    }
  }

  function openPhotoCapture(order: MobileExtraWorkTicket): void {
    if ((order.photo_count ?? 0) >= MOBILE_DOCUMENT_PHOTO_LIMIT) {
      setMessage("Maximal 5 Fotos pro Stundenzettel erlaubt.");
      setPhotoMessageTone("error");
      return;
    }
    setPhotoUploadOrder(order);
    setMessage(null);
    setPhotoMessageTone("info");
    photoInputRef.current?.click();
  }

  async function handlePhotoInputChange(event: ReactChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    const order = photoUploadOrder ?? selectedOrder;
    if (!file || !order || isUploadingPhoto) {
      return;
    }
    if ((order.photo_count ?? 0) >= MOBILE_DOCUMENT_PHOTO_LIMIT) {
      setMessage("Maximal 5 Fotos pro Stundenzettel erlaubt.");
      setPhotoMessageTone("error");
      setPhotoUploadOrder(null);
      return;
    }
    setIsUploadingPhoto(true);
    setMessage("Foto wird optimiert...");
    setPhotoMessageTone("info");
    try {
      const uploadFile = await prepareMeasurementPhotoFile(file);
      setMessage("Foto wird gespeichert...");
      await api.uploadMobileExtraWorkTicketPhoto(assignment.id, order.id, uploadFile);
      updateOrderPhotoCount(order.id, (order.photo_count ?? 0) + 1);
      setPhotoGalleryVersion((version) => version + 1);
      setMessage("Foto gespeichert.");
      setPhotoMessageTone("info");
    } catch (requestError) {
      setMessage(readApiError(requestError, "Foto konnte nicht gespeichert werden."));
      setPhotoMessageTone("error");
    } finally {
      setIsUploadingPhoto(false);
      setPhotoUploadOrder(null);
    }
  }

  if (selectedOrder) {
    if (photoGalleryOrder) {
      return (
        <>
          <ExtraWorkPhotoGallery
            assignmentId={assignment.id}
            order={photoGalleryOrder}
            refreshKey={photoGalleryVersion}
            isUploadingPhoto={isUploadingPhoto}
            onBack={() => setPhotoGalleryOrder(null)}
            onTakePhoto={() => openPhotoCapture(photoGalleryOrder)}
            onPhotoCountChanged={(count) => updateOrderPhotoCount(photoGalleryOrder.id, count)}
            photoLimit={MOBILE_DOCUMENT_PHOTO_LIMIT}
          />
          <input
            ref={photoInputRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => void handlePhotoInputChange(event)}
          />
        </>
      );
    }
    if (isEditingEntry) {
      return (
        <ExtraWorkEntryPage
          assignmentId={assignment.id}
          assignmentPerson={assignment.person}
          assignmentStartDate={assignment.start_date}
          order={selectedOrder}
          onBack={() => setIsEditingEntry(false)}
          onOrderUpdated={mergeUpdatedOrder}
          onSaved={async () => {
            const updatedOrder = await api.mobileExtraWorkTicket(assignment.id, selectedOrder.id);
            mergeUpdatedOrder(updatedOrder);
            setIsEditingEntry(false);
            setPhotoMessageTone("info");
            setMessage("Eingaben gespeichert.");
          }}
        />
      );
    }
    return (
      <>
        <ExtraWorkOrderOverview
          assignmentId={assignment.id}
          assignmentStartDate={assignment.start_date}
          order={selectedOrder}
          message={message}
          error={error}
          isSaving={isSaving}
          isUploadingPhoto={isUploadingPhoto}
          photoLimit={MOBILE_DOCUMENT_PHOTO_LIMIT}
          messageTone={photoMessageTone}
          onBack={() => {
            setSelectedOrder(null);
            setPhotoGalleryOrder(null);
            setIsEditingEntry(false);
            setMessage(null);
          }}
          onOpenEntry={() => {
            setMessage(null);
            setIsEditingEntry(true);
          }}
          onTakePhoto={() => openPhotoCapture(selectedOrder)}
          onOpenPhotos={() => setPhotoGalleryOrder(selectedOrder)}
          onCustomerSigned={(updatedOrder) => {
            mergeUpdatedOrder(updatedOrder);
            setPhotoMessageTone("info");
            setMessage("Kundenunterschrift gespeichert.");
          }}
          onTitleUpdated={(updatedOrder) => {
            mergeUpdatedOrder(updatedOrder);
            setPhotoMessageTone("info");
            setMessage("Bezeichnung gespeichert.");
          }}
          onDetailsUpdated={(updatedOrder) => {
            mergeUpdatedOrder(updatedOrder);
            setPhotoMessageTone("info");
            setMessage("Stundenzettel-Details gespeichert.");
          }}
          onEmailRecipientsSaved={(count) => {
            setPhotoMessageTone("info");
            setMessage(count === 1 ? "Ein Kundenempfänger gespeichert." : `${count} Kundenempfänger gespeichert.`);
          }}
          onEmailSent={(result) => {
            setPhotoMessageTone("info");
            setMessage(`E-Mail gesendet an ${result.recipients.join(", ")}.`);
          }}
          onWorkerSigned={(updatedOrder) => {
            mergeUpdatedOrder(updatedOrder);
            setPhotoMessageTone("info");
            setMessage("Monteursunterschrift gespeichert.");
          }}
          onSubmit={async () => {
            if (selectedOrder.status !== "draft" || isSaving) {
              return;
            }
            setIsSaving(true);
            setError(null);
            setMessage(null);
            try {
              const submittedOrder = await api.updateMobileExtraWorkTicketStatus(assignment.id, selectedOrder.id, "submitted");
              mergeUpdatedOrder(submittedOrder);
              setPhotoMessageTone("info");
              setMessage(`${formatMobileExtraWorkKindLabel(selectedOrder.kind)} wurde eingereicht.`);
            } catch (requestError) {
              setError(readApiError(requestError, `${formatMobileExtraWorkKindLabel(selectedOrder.kind)} konnte nicht gesendet werden.`));
            } finally {
              setIsSaving(false);
            }
          }}
        />
        <input
          ref={photoInputRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => void handlePhotoInputChange(event)}
        />
      </>
    );
  }

  return (
    <div className="mobile-measurement-page mobile-measurement-panel">
      <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={17} />
        <span>Projektakte</span>
      </button>

      <div className="mobile-panel-title-row">
        <div className="mobile-measurement-page-title">
          <h1>Stundenzettel</h1>
          <p>{[assignment.site.site_number, assignment.site.name].filter(Boolean).join(" · ")}</p>
        </div>
        <button
          className="primary-action mobile-measurement-new-action"
          type="button"
          onClick={() => void createOrder()}
          disabled={isSaving}
        >
          <Plus aria-hidden="true" size={15} />
          <span>{isSaving ? "Erstelle..." : requiresApproval ? "Neue Stundenfreigabe" : "Neuer Stundenzettel"}</span>
        </button>
      </div>

      {requiresApproval ? (
        <p className="form-info">
          Für diese Baustelle ist vor Zusatzarbeiten eine Stundenfreigabe vorgesehen.
        </p>
      ) : null}
      {isLoading ? <div className="empty-panel">Stundenzettel werden geladen...</div> : null}
      {error ? <div className="form-error">{error}</div> : null}
      {!isLoading && !error && orders.length === 0 ? (
        <div className="empty-panel">{requiresApproval ? "Noch keine Stundenfreigabe vorhanden." : "Noch kein Stundenzettel vorhanden."}</div>
      ) : null}
      {!isLoading && orders.length > 0 ? (
        <div className="mobile-measurement-list">
          {orders.map((order) => {
            const statusBadge = getMobileExtraWorkOrderStatusBadge(order);
            return (
              <button
                className="mobile-measurement-card is-document-card"
                key={order.id}
                type="button"
                onClick={() => {
                  setSelectedOrder(order);
                  setIsEditingEntry(false);
                  setMessage(null);
                }}
              >
                <span className={`mobile-measurement-card-side-status measurement-status ${statusBadge.className}`}>{statusBadge.label}</span>
                <span className="mobile-measurement-card-head">
                  <strong className="mobile-measurement-card-title">{formatMobileExtraWorkOrderTitle(order)}</strong>
                  <span className="mobile-measurement-card-date">{formatMobileExtraWorkOrderDate(order)}</span>
                </span>
                <MobileCustomerEmailStatus item={order} />
                <span className="mobile-measurement-card-footer">
                  <span className="mobile-measurement-card-date">{order.created_by_name ? `Ersteller: ${order.created_by_name}` : "Ohne Ersteller"}</span>
                  <span className="mobile-measurement-card-hours">Stunden: {formatExtraWorkHours(order.total_hours)}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ExtraWorkOrderOverview({
  assignmentId,
  assignmentStartDate,
  order,
  message,
  error,
  isSaving,
  isUploadingPhoto,
  photoLimit,
  messageTone,
  onBack,
  onOpenEntry,
  onTakePhoto,
  onOpenPhotos,
  onCustomerSigned,
  onTitleUpdated,
  onDetailsUpdated,
  onEmailRecipientsSaved,
  onEmailSent,
  onWorkerSigned,
  onSubmit,
}: {
  assignmentId: number;
  assignmentStartDate: string;
  order: MobileExtraWorkTicket;
  message: string | null;
  error: string | null;
  isSaving: boolean;
  isUploadingPhoto: boolean;
  photoLimit: number;
  messageTone: "info" | "error";
  onBack: () => void;
  onOpenEntry: () => void;
  onTakePhoto: () => void;
  onOpenPhotos: () => void;
  onCustomerSigned: (order: MobileExtraWorkTicket) => void;
  onTitleUpdated: (order: MobileExtraWorkTicket) => void;
  onDetailsUpdated: (order: MobileExtraWorkTicket) => void;
  onEmailRecipientsSaved: (count: number) => void;
  onEmailSent: (result: ExtraWorkTicketEmailSendResponse) => void;
  onWorkerSigned: (order: MobileExtraWorkTicket) => void;
  onSubmit: () => Promise<void>;
}) {
  const { user } = useAuth();
  const isDraft = order.status === "draft";
  const statusBadge = getMobileExtraWorkOrderStatusBadge(order);
  const kindLabel = formatMobileExtraWorkKindLabel(order.kind);
  const isApproval = order.kind === "approval";
  const [isOpeningPdf, setIsOpeningPdf] = useState(false);
  const [isSigningCustomer, setIsSigningCustomer] = useState(false);
  const [isSigningWorker, setIsSigningWorker] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [isEditingEmailRecipients, setIsEditingEmailRecipients] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState<SiteEmailRecipient[]>([]);
  const [isLoadingEmailRecipients, setIsLoadingEmailRecipients] = useState(true);
  const [isConfirmingEmailSend, setIsConfirmingEmailSend] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailSendError, setEmailSendError] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const hasCustomerSignature = Boolean(order.customer_signed_at);
  const hasWorkerSignature = Boolean(order.worker_signed_at);
  const isPhotoLimitReached = (order.photo_count ?? 0) >= photoLimit;
  const canRename = order.status === "draft" && !hasCustomerSignature;
  const workerName = order.worker_signature_name ?? user?.display_name ?? user?.username ?? "";
  const emailPdfFilename = `${formatMobileExtraWorkOrderTitle(order)}.pdf`;
  const emailSendPrerequisitesMet = emailRecipients.length > 0;
  const shouldWarnMissingCustomerSignatureForEmail = emailRecipients.length > 0 && !hasCustomerSignature;
  const emailSendHint = getDocumentEmailSendHint({
    hasRecipients: emailRecipients.length > 0,
    hasCustomerSignature,
    hasWorkerSignature,
    isLoadingRecipients: isLoadingEmailRecipients,
    allowMissingCustomerSignature: true,
  });
  const emailSendStatusTitle = emailSendError ?? emailSendHint ?? undefined;
  const hasEmailSendInlineStatus = shouldWarnMissingCustomerSignatureForEmail || Boolean(emailSendError);

  useEffect(() => {
    let isActive = true;

    async function loadEmailRecipients(): Promise<void> {
      setIsLoadingEmailRecipients(true);
      setEmailSendError(null);
      try {
        const response = await api.assignmentEmailRecipients(assignmentId);
        if (isActive) {
          setEmailRecipients(response.recipients);
        }
      } catch (requestError) {
        if (isActive) {
          setEmailSendError(readApiError(requestError, "E-Mail-Empfänger konnten nicht geladen werden."));
          setEmailRecipients([]);
        }
      } finally {
        if (isActive) {
          setIsLoadingEmailRecipients(false);
        }
      }
    }

    void loadEmailRecipients();
    return () => {
      isActive = false;
    };
  }, [assignmentId, order.id]);

  async function openExtraWorkPdf(): Promise<void> {
    if (isOpeningPdf) {
      return;
    }
    setIsOpeningPdf(true);
    setPdfError(null);
    try {
      const blob = await api.mobileExtraWorkTicketPdf(assignmentId, order.id);
      const filename = getMobileExtraWorkPdfFilename(order);
      if (isNativeAndroidApp()) {
        await openAndroidPdfBlob(blob, filename);
      } else {
        const url = window.URL.createObjectURL(blob);
        const openedWindow = window.open(url, "_blank", "noopener,noreferrer");
        if (!openedWindow) {
          downloadBlobFile(blob, filename);
        }
        window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
      }
    } catch (requestError) {
      setPdfError(readApiError(requestError, `${kindLabel}-PDF konnte nicht geöffnet werden.`));
    } finally {
      setIsOpeningPdf(false);
    }
  }

  async function sendExtraWorkEmail(): Promise<void> {
    if (!emailSendPrerequisitesMet || isSendingEmail) {
      return;
    }
    setIsSendingEmail(true);
    setEmailSendError(null);
    try {
      const result = await api.sendMobileExtraWorkTicketEmail(assignmentId, order.id);
      setIsConfirmingEmailSend(false);
      onEmailSent(result);
    } catch (requestError) {
      setEmailSendError(readApiError(requestError, "E-Mail konnte nicht gesendet werden."));
    } finally {
      setIsSendingEmail(false);
    }
  }

  return (
    <div className="mobile-detail-panel mobile-measurement-panel mobile-measurement-overview-panel">
      <div className="mobile-measurement-detail-topbar">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Stundenzettel</span>
        </button>
        <button
          className="primary-action mobile-measurement-submit-action"
          type="button"
          onClick={onSubmit}
          disabled={!isDraft || isSaving}
        >
          <Send aria-hidden="true" size={15} />
          <span>{isSaving ? "Sende..." : "Zur Prüfung senden"}</span>
        </button>
      </div>

      <section
        className="mobile-measurement-summary-card mobile-extra-work-title-card is-editable"
      >
        <button
          className="mobile-extra-work-details-hit-area"
          type="button"
          onClick={() => setIsEditingDetails(true)}
          aria-label="Stundenzettel-Details öffnen"
        />
        <span className="mobile-measurement-summary-status-row">
          <span className={`measurement-status ${statusBadge.className}`}>{statusBadge.label}</span>
          <MobileCustomerEmailStatus item={order} />
        </span>
        <span className="mobile-measurement-card-date">{kindLabel}</span>
        <span className="mobile-extra-work-title-line">
          <h2>{formatMobileExtraWorkOrderTitle(order)}</h2>
          {canRename ? (
            <button
              className="mobile-extra-work-rename-button"
              type="button"
              aria-label="Stundenzettel benennen"
              onClick={(event) => {
                event.stopPropagation();
                setIsRenaming(true);
              }}
            >
              <Pencil aria-hidden="true" size={15} />
            </button>
          ) : null}
        </span>
        <span className="mobile-measurement-card-date">Datum: {formatMobileExtraWorkOrderDate(order)}</span>
        <span className="mobile-measurement-card-meta">
          <span>Stunden: {formatExtraWorkHours(order.total_hours)}</span>
          {isApproval && order.estimated_hours !== null && order.estimated_hours !== undefined ? (
            <span>Vorgabe: {formatExtraWorkHours(order.estimated_hours)}</span>
          ) : null}
        </span>
      </section>
      {error || pdfError ? <div className="form-error">{error ?? pdfError}</div> : null}

      <div className="mobile-measurement-overview-actions">
        <button className="mobile-measurement-overview-action is-primary" type="button" onClick={onOpenEntry}>
          <ClipboardList aria-hidden="true" size={18} />
          <span>{isApproval ? "Freigabe erfassen" : "Leistungen erfassen"}</span>
        </button>
        <button className="mobile-measurement-overview-action" type="button" onClick={() => void openExtraWorkPdf()} disabled={isOpeningPdf}>
          <FileText aria-hidden="true" size={18} />
          <span>{isOpeningPdf ? "PDF wird geöffnet..." : `${kindLabel} anzeigen (PDF)`}</span>
        </button>
        <button
          className={`mobile-measurement-overview-action${hasCustomerSignature ? " is-complete" : ""}`}
          type="button"
          onClick={() => {
            setPdfError(null);
            setIsSigningCustomer(true);
          }}
          disabled={hasCustomerSignature}
        >
          <UserRound aria-hidden="true" size={18} />
          <span>{hasCustomerSignature ? "Kundenunterschrift vorhanden" : "Kundenunterschrift einfügen"}</span>
          {hasCustomerSignature ? <CheckCircle2 className="mobile-action-status-icon" aria-hidden="true" size={19} /> : null}
        </button>
        <button
          className={`mobile-measurement-overview-action${hasWorkerSignature ? " is-complete" : ""}`}
          type="button"
          onClick={() => {
            setPdfError(null);
            setIsSigningWorker(true);
          }}
          disabled={hasWorkerSignature}
        >
          <UserRound aria-hidden="true" size={18} />
          <span>{hasWorkerSignature ? "Monteursunterschrift vorhanden" : "Monteursunterschrift einfügen"}</span>
          {hasWorkerSignature ? <CheckCircle2 className="mobile-action-status-icon" aria-hidden="true" size={19} /> : null}
        </button>
        <button
          className="mobile-measurement-overview-action"
          type="button"
          onClick={() => {
            setPdfError(null);
            setIsEditingEmailRecipients(true);
          }}
        >
          <Mail aria-hidden="true" size={18} />
          <span>Kunden-E-Mail</span>
        </button>
        <button
          className={`mobile-measurement-overview-action${hasEmailSendInlineStatus ? " has-inline-status" : ""}${shouldWarnMissingCustomerSignatureForEmail ? " is-email-warning" : ""}`}
          type="button"
          title={emailSendStatusTitle}
          onClick={() => {
            setEmailSendError(null);
            setIsConfirmingEmailSend(true);
          }}
          disabled={!emailSendPrerequisitesMet || isSendingEmail || isLoadingEmailRecipients}
        >
          <Mail aria-hidden="true" size={18} />
          <span>{isSendingEmail ? "Wird gesendet..." : "Per E-Mail senden"}</span>
          {shouldWarnMissingCustomerSignatureForEmail || emailSendError ? (
            <AlertTriangle className="mobile-action-warning-icon" aria-hidden="true" size={18} />
          ) : null}
        </button>
        <MobileOverviewPhotoAction
          count={order.photo_count}
          disabled={isUploadingPhoto || isPhotoLimitReached}
          onOpenPhotos={onOpenPhotos}
          onTakePhoto={onTakePhoto}
        />
      </div>
      {isPhotoLimitReached ? (
        <p className="mobile-measurement-action-hint">Maximal 5 Fotos pro Stundenzettel erlaubt.</p>
      ) : null}
      {message ? <p className={messageTone === "error" ? "form-error" : "form-info"}>{message}</p> : null}
      {isSigningCustomer ? (
        <ExtraWorkCustomerSignatureOverlay
          assignmentId={assignmentId}
          order={order}
          onClose={() => setIsSigningCustomer(false)}
          onSigned={(updatedOrder) => {
            onCustomerSigned(updatedOrder);
          }}
        />
      ) : null}
      {isRenaming ? (
        <ExtraWorkTitleDialog
          assignmentId={assignmentId}
          order={order}
          onClose={() => setIsRenaming(false)}
          onSaved={(updatedOrder) => {
            setIsRenaming(false);
            onTitleUpdated(updatedOrder);
          }}
        />
      ) : null}
      {isEditingDetails ? (
        <ExtraWorkDetailsDialog
          assignmentId={assignmentId}
          assignmentStartDate={assignmentStartDate}
          order={order}
          onClose={() => setIsEditingDetails(false)}
          onSaved={(updatedOrder) => {
            setIsEditingDetails(false);
            onDetailsUpdated(updatedOrder);
          }}
        />
      ) : null}
      {isEditingEmailRecipients ? (
        <ProjectEmailRecipientsModal
          assignmentId={assignmentId}
          onClose={() => setIsEditingEmailRecipients(false)}
          onSaved={(count) => {
            setIsEditingEmailRecipients(false);
            void api.assignmentEmailRecipients(assignmentId).then((response) => {
              setEmailRecipients(response.recipients);
            }).catch(() => undefined);
            onEmailRecipientsSaved(count);
          }}
        />
      ) : null}
      {isConfirmingEmailSend ? (
        <DocumentEmailSendDialog
          description={`Der aktuelle ${formatMobileExtraWorkKindLabel(order.kind)} wird als vollständige PDF an die ausgewählten Kundenempfänger gesendet.`}
          filename={emailPdfFilename}
          isSending={isSendingEmail}
          recipients={emailRecipients}
          error={emailSendError}
          warning={shouldWarnMissingCustomerSignatureForEmail ? "Für diesen Zusatzauftrag liegt noch keine Kundenunterschrift vor. Das PDF wird ohne Kundenunterschrift versendet. Die Unterschrift muss anschließend vom Kunden eingeholt werden." : null}
          title="Stundenzettel senden?"
          onClose={() => setIsConfirmingEmailSend(false)}
          onConfirm={() => void sendExtraWorkEmail()}
        />
      ) : null}
      {isSigningWorker ? (
        <ExtraWorkWorkerSignatureOverlay
          assignmentId={assignmentId}
          order={order}
          workerName={workerName}
          onClose={() => setIsSigningWorker(false)}
          onSigned={(updatedOrder) => {
            setIsSigningWorker(false);
            onWorkerSigned(updatedOrder);
          }}
        />
      ) : null}
    </div>
  );
}

function ExtraWorkTitleDialog({
  assignmentId,
  order,
  onClose,
  onSaved,
}: {
  assignmentId: number;
  order: MobileExtraWorkTicket;
  onClose: () => void;
  onSaved: (order: MobileExtraWorkTicket) => void;
}) {
  const [title, setTitle] = useState(getMobileExtraWorkOrderEditableTitle(order));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const canRename = order.status === "draft" && !order.customer_signed_at;
  const isTopModal = useMobileModalStack(true);

  async function saveTitle(): Promise<void> {
    if (!canRename || isSaving) {
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const cleanedTitle = title.trim().replace(/\s+/g, " ");
      const updatedOrder = await api.updateMobileExtraWorkTicketTitle(assignmentId, order.id, cleanedTitle || null);
      onSaved(updatedOrder);
    } catch (requestError) {
      setError(readApiError(requestError, "Bezeichnung konnte nicht gespeichert werden."));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      aria-hidden={!isTopModal}
      className="mobile-dialog-backdrop mobile-modal-layer"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={onClose}
    >
      <div
        className="mobile-extra-work-title-dialog mobile-modal-scroll-region"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-extra-work-title-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mobile-extra-work-title-dialog-head">
          <p>{getMobileExtraWorkOrderFixedTitle(order)}</p>
          <h2 id="mobile-extra-work-title-dialog-title">Stundenzettel benennen</h2>
        </div>
        {canRename ? (
          <label>
            <span>Bezeichnung</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={EXTRA_WORK_DEFAULT_TITLE_SUFFIX}
              autoFocus
            />
          </label>
        ) : (
          <p className="form-info">Der Name kann nach Kundenunterschrift nicht mehr geändert werden.</p>
        )}
        {error ? <p className="form-error">{error}</p> : null}
        <div className="mobile-extra-work-title-dialog-actions">
          <button className="secondary-action" type="button" onClick={onClose} disabled={isSaving}>
            Abbrechen
          </button>
          <button className="primary-action" type="button" onClick={() => void saveTitle()} disabled={!canRename || isSaving}>
            {isSaving ? "Speichert..." : "Speichern"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExtraWorkDetailsDialog({
  assignmentId,
  assignmentStartDate,
  order,
  onClose,
  onSaved,
}: {
  assignmentId: number;
  assignmentStartDate: string;
  order: MobileExtraWorkTicket;
  onClose: () => void;
  onSaved: (order: MobileExtraWorkTicket) => void;
}) {
  const automaticOrderDate = getExtraWorkAutomaticOrderDate(order.created_at);
  const automaticWeek = getIsoWeekInfo(assignmentStartDate || automaticOrderDate);
  const initialWeekYear = order.manual_execution_week_year ?? automaticWeek.isoYear;
  const initialWeek = order.manual_execution_week ?? automaticWeek.week;
  const [orderDate, setOrderDate] = useState(order.manual_order_date ?? automaticOrderDate);
  const [executionWeek, setExecutionWeek] = useState(`${initialWeekYear}-${initialWeek}`);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const canEdit = !order.customer_signed_at;
  const weekOptions = useMemo(
    () => buildExtraWorkIsoWeekOptions(automaticWeek.isoYear, initialWeekYear),
    [automaticWeek.isoYear, initialWeekYear],
  );
  const selectedWeek = parseExtraWorkIsoWeekValue(executionWeek);
  const selectedWeekRange = selectedWeek
    ? getIsoWeekRange(selectedWeek.isoYear, selectedWeek.week)
    : null;
  const isTopModal = useMobileModalStack(true);

  async function saveDetails(): Promise<void> {
    if (!canEdit || isSaving || !orderDate || !selectedWeek) {
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const usesAutomaticWeek = selectedWeek.isoYear === automaticWeek.isoYear
        && selectedWeek.week === automaticWeek.week;
      const updatedOrder = await api.updateMobileExtraWorkTicketDetails(assignmentId, order.id, {
        manual_order_date: orderDate === automaticOrderDate ? null : orderDate,
        manual_execution_week: usesAutomaticWeek ? null : selectedWeek.week,
        manual_execution_week_year: usesAutomaticWeek ? null : selectedWeek.isoYear,
      });
      onSaved(updatedOrder);
    } catch (requestError) {
      setError(readApiError(requestError, "Stundenzettel-Details konnten nicht gespeichert werden."));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      aria-hidden={!isTopModal}
      className="mobile-dialog-backdrop mobile-modal-layer"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={isSaving ? undefined : onClose}
    >
      <div
        className="mobile-extra-work-details-dialog mobile-modal-scroll-region"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-extra-work-details-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mobile-extra-work-details-dialog-head">
          <div>
            <p>{formatMobileExtraWorkOrderTitle(order)}</p>
            <h2 id="mobile-extra-work-details-dialog-title">Stundenzettel-Details</h2>
          </div>
          <button className="icon-button secondary" type="button" onClick={onClose} disabled={isSaving} aria-label="Schließen">
            <X aria-hidden="true" size={18} />
          </button>
        </div>

        <label className="mobile-extra-work-details-field">
          <span>Datum der Auftragserteilung</span>
          <input
            type="date"
            value={orderDate}
            onChange={(event) => setOrderDate(event.target.value)}
            disabled={!canEdit || isSaving}
            required
          />
          <small>Automatisch: {formatGermanDateKey(automaticOrderDate)}</small>
        </label>

        <label className="mobile-extra-work-details-field">
          <span>Kalenderwoche der Ausführung</span>
          <select
            value={executionWeek}
            onChange={(event) => setExecutionWeek(event.target.value)}
            disabled={!canEdit || isSaving}
          >
            {weekOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <small>
            {selectedWeekRange
              ? `${formatGermanDateKey(selectedWeekRange.start)} – ${formatGermanDateKey(selectedWeekRange.end)}`
              : "Ungültige Kalenderwoche"}
            {` · Automatisch: KW ${String(automaticWeek.week).padStart(2, "0")} / ${automaticWeek.isoYear}`}
          </small>
        </label>

        {!canEdit ? (
          <p className="mobile-extra-work-details-locked-note">
            Nach der Kundenunterschrift können diese Angaben nicht mehr geändert werden.
          </p>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        <div className={`mobile-extra-work-title-dialog-actions${canEdit ? "" : " is-single"}`}>
          <button className="secondary-action" type="button" onClick={onClose} disabled={isSaving}>
            {canEdit ? "Abbrechen" : "Schließen"}
          </button>
          {canEdit ? (
            <button
              className="primary-action"
              type="button"
              onClick={() => void saveDetails()}
              disabled={isSaving || !orderDate || !selectedWeek}
            >
              {isSaving ? "Speichert..." : "Speichern"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DocumentEmailSendDialog({
  title,
  description,
  recipients,
  filename,
  isSending,
  error,
  warning,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  recipients: SiteEmailRecipient[];
  filename: string;
  isSending: boolean;
  error: string | null;
  warning?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isTopModal = useMobileModalStack(true);

  return (
    <div
      aria-hidden={!isTopModal}
      className="mobile-dialog-backdrop mobile-modal-layer"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={isSending ? undefined : onClose}
    >
      <div
        className="mobile-project-email-dialog mobile-modal-scroll-region"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-extra-work-email-send-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mobile-project-email-dialog-head">
          <h2 id="mobile-extra-work-email-send-title">{title}</h2>
          <p>{description}</p>
        </div>

        {warning ? <p className="mobile-project-email-warning">{warning}</p> : null}

        <div className="mobile-project-email-list">
          <div className="mobile-project-email-option is-static">
            <FileText aria-hidden="true" size={18} />
            <span>
              <strong>{filename}</strong>
              <small>PDF-Dokument</small>
            </span>
          </div>
          {recipients.map((recipient) => (
            <div className="mobile-project-email-option is-static" key={recipient.email}>
              <Mail aria-hidden="true" size={18} />
              <span>
                <strong>{recipient.label || recipient.email}</strong>
                {recipient.label ? <small>{recipient.email}</small> : null}
              </span>
            </div>
          ))}
        </div>

        {error ? <p className="form-error">{error}</p> : null}
        <div className="mobile-project-email-actions">
          <button className="secondary-action" type="button" onClick={onClose} disabled={isSending}>
            Abbrechen
          </button>
          <button className="primary-action" type="button" onClick={onConfirm} disabled={isSending}>
            {isSending ? "Sendet..." : "Jetzt senden"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectEmailRecipientsModal({
  assignmentId,
  onClose,
  onSaved,
}: {
  assignmentId: number;
  onClose: () => void;
  onSaved: (count: number) => void;
}) {
  const [suggestions, setSuggestions] = useState<SiteEmailRecipient[]>([]);
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const isTopModal = useMobileModalStack(true);

  useEffect(() => {
    let isActive = true;

    async function loadRecipients(): Promise<void> {
      setIsLoading(true);
      setError(null);
      try {
        const response = await api.assignmentEmailRecipients(assignmentId);
        if (!isActive) {
          return;
        }
        setSuggestions(response.suggestions);
        setSelectedEmails(response.recipients.map((recipient) => recipient.email));
      } catch (requestError) {
        if (isActive) {
          setError(readApiError(requestError, "E-Mail-Empfänger konnten nicht geladen werden."));
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    void loadRecipients();
    return () => {
      isActive = false;
    };
  }, [assignmentId]);

  const suggestionByEmail = useMemo(() => {
    const entries = new Map<string, SiteEmailRecipient>();
    for (const suggestion of suggestions) {
      entries.set(suggestion.email, suggestion);
    }
    return entries;
  }, [suggestions]);

  function toggleEmail(email: string): void {
    setSelectedEmails((currentEmails) => (
      currentEmails.includes(email)
        ? currentEmails.filter((currentEmail) => currentEmail !== email)
        : [...currentEmails, email]
    ));
  }

  async function saveRecipients(): Promise<void> {
    setIsSaving(true);
    setError(null);
    try {
      const normalizedEmail = normalizeProjectRecipientEmail(newEmail);
      if (normalizedEmail && !isValidProjectRecipientEmail(normalizedEmail)) {
        setError("E-Mail-Adresse ist nicht gültig.");
        return;
      }

      const emailsToSave = normalizedEmail && !selectedEmails.includes(normalizedEmail)
        ? [...selectedEmails, normalizedEmail]
        : selectedEmails;
      const recipients = emailsToSave.map((email) => {
        const suggestion = suggestionByEmail.get(email);
        return {
          email,
          label: suggestion?.label ?? null,
        };
      });
      const response = await api.updateAssignmentEmailRecipients(assignmentId, { recipients });
      onSaved(response.recipients.length);
    } catch (requestError) {
      setError(readApiError(requestError, "E-Mail-Empfänger konnten nicht gespeichert werden."));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      aria-hidden={!isTopModal}
      className="mobile-dialog-backdrop mobile-modal-layer"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={onClose}
    >
      <div
        className="mobile-project-email-dialog mobile-modal-scroll-region"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-project-email-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mobile-project-email-dialog-head">
          <h2 id="mobile-project-email-dialog-title">E-Mail-Empfänger</h2>
          <p>Projektbezogene Kundenempfänger für spätere Dokumente und Mails.</p>
        </div>

        {isLoading ? <div className="empty-panel">Empfänger werden geladen...</div> : null}
        {!isLoading ? (
          <>
            <div className="mobile-project-email-list">
              {suggestions.length === 0 ? (
                <p className="mobile-project-email-empty">Noch keine Kunden-E-Mail bekannt. Du kannst unten eine Adresse hinzufügen.</p>
              ) : null}
              {suggestions.map((recipient) => (
                <label className="mobile-project-email-option" key={recipient.email}>
                  <input
                    type="checkbox"
                    checked={selectedEmails.includes(recipient.email)}
                    onChange={() => toggleEmail(recipient.email)}
                  />
                  <span>
                    <strong>{recipient.label || recipient.email}</strong>
                    {recipient.label ? <small>{recipient.email}</small> : null}
                  </span>
                </label>
              ))}
            </div>

            <div className="mobile-project-email-add">
              <label>
                <span>Neue E-Mail-Adresse</span>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                  placeholder="kunde@example.de"
                />
              </label>
            </div>
          </>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        <div className="mobile-project-email-actions">
          <button className="secondary-action" type="button" onClick={onClose} disabled={isSaving}>
            Abbrechen
          </button>
          <button className="primary-action" type="button" onClick={() => void saveRecipients()} disabled={isLoading || isSaving}>
            {isSaving ? "Speichert..." : "Speichern"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExtraWorkCustomerSignatureOverlay({
  assignmentId,
  order,
  onClose,
  onSigned,
}: {
  assignmentId: number;
  order: MobileExtraWorkTicket;
  onClose: () => void;
  onSigned: (order: MobileExtraWorkTicket) => void;
}) {
  const [activeOrder, setActiveOrder] = useState(order);
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [pdfReloadKey, setPdfReloadKey] = useState(0);
  const [isPdfLoading, setIsPdfLoading] = useState(true);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  const signatureLabel = activeOrder.kind === "approval"
    ? "Ausführungsgenehmigung unterschreiben"
    : "Stundenabrechnung unterschreiben";
  const kindLabel = formatMobileExtraWorkKindLabel(activeOrder.kind);
  const [customerName, setCustomerName] = useState(activeOrder.customer_signature_name ?? "");
  const [strokes, setStrokes] = useState<CustomerSignatureStroke[]>([]);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [isSavingSignature, setIsSavingSignature] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const isSigned = Boolean(activeOrder.customer_signed_at);
  const hasSignature = strokes.some((stroke) => stroke.length >= 2);
  const isTopModal = useMobileModalStack(true);

  useEffect(() => {
    setActiveOrder(order);
    setCustomerName(order.customer_signature_name ?? "");
  }, [order]);

  useEffect(() => {
    let isActive = true;

    async function loadPdf(): Promise<void> {
      setIsPdfLoading(true);
      setPdfError(null);
      setPdfData(null);
      try {
        const blob = await api.mobileExtraWorkTicketPdf(assignmentId, activeOrder.id);
        const arrayBuffer = await blob.arrayBuffer();
        if (isActive) {
          setPdfData(arrayBuffer);
        }
      } catch (requestError) {
        if (isActive) {
          setPdfError(readApiError(requestError, `${kindLabel}-PDF konnte nicht geladen werden.`));
        }
      } finally {
        if (isActive) {
          setIsPdfLoading(false);
        }
      }
    }

    void loadPdf();
    return () => {
      isActive = false;
    };
  }, [activeOrder.id, assignmentId, kindLabel, pdfReloadKey]);

  useEffect(() => {
    if (!isSigning) {
      return;
    }
    drawSignatureCanvas(canvasRef.current, strokes);
  }, [isSigning, strokes]);

  function appendSignaturePoint(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const point = getSignatureCanvasPoint(event);
    if (!point) {
      return;
    }
    setStrokes((currentStrokes) => {
      if (currentStrokes.length === 0) {
        return [[point]];
      }
      const nextStrokes = currentStrokes.slice();
      const lastStroke = nextStrokes[nextStrokes.length - 1] ?? [];
      nextStrokes[nextStrokes.length - 1] = [...lastStroke, point];
      return nextStrokes;
    });
  }

  async function handleSaveSignature(): Promise<void> {
    const normalizedName = customerName.trim();
    if (!normalizedName) {
      setSignatureError("Bitte Kundennamen eintragen.");
      return;
    }
    const validStrokes = strokes.filter((stroke) => stroke.length >= 2);
    if (validStrokes.length === 0) {
      setSignatureError("Bitte Unterschrift erfassen.");
      return;
    }
    setIsSavingSignature(true);
    setSignatureError(null);
    try {
      const updatedOrder = await api.signMobileExtraWorkTicketCustomer(assignmentId, activeOrder.id, {
        customer_name: normalizedName,
        signature_strokes: validStrokes,
      });
      setActiveOrder(updatedOrder);
      setIsSigning(false);
      setStrokes([]);
      onSigned(updatedOrder);
      setPdfReloadKey((currentKey) => currentKey + 1);
    } catch (requestError) {
      setSignatureError(readApiError(requestError, "Kundenunterschrift konnte nicht gespeichert werden."));
    } finally {
      setIsSavingSignature(false);
    }
  }

  return (
    <div
      aria-hidden={!isTopModal}
      aria-label="Kundenunterschrift"
      aria-modal="true"
      className="mobile-customer-signature-overlay mobile-modal-layer mobile-modal-scroll-region"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="dialog"
    >
      <header className="mobile-customer-signature-header">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onClose}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Zurück</span>
        </button>
        <div className="mobile-customer-signature-title">
          <strong>{formatMobileExtraWorkOrderTitle(activeOrder)}</strong>
          <span>{isSigned ? "Kundenunterschrift gespeichert" : "PDF prüfen und unterschreiben"}</span>
        </div>
        <button
          className="primary-action mobile-customer-signature-sign-action"
          type="button"
          onClick={() => {
            setSignatureError(null);
            setIsSigning(true);
          }}
          disabled={isSigned}
        >
          Unterschrift einfügen
        </button>
      </header>

      <main className="mobile-customer-signature-pdf">
        {isPdfLoading ? <div className="empty-panel">PDF wird geladen...</div> : null}
        {pdfError ? <div className="form-error">{pdfError}</div> : null}
        {!isPdfLoading && !pdfError && pdfData ? <PdfCanvasPreview data={pdfData} /> : null}
      </main>

      {isSigning && !isSigned ? (
        <section className="mobile-customer-signature-sheet" aria-label="Kundenunterschrift erfassen">
          <p className="mobile-measurement-action-hint">{signatureLabel}</p>
          <label>
            <span>Name des Kunden</span>
            <input
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              placeholder="Name des Unterzeichners"
            />
          </label>
          <div className="mobile-signature-canvas-wrap">
            <span>Unterschrift</span>
            <canvas
              ref={canvasRef}
              className="mobile-signature-canvas"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                isDrawingRef.current = true;
                const point = getSignatureCanvasPoint(event);
                if (point) {
                  setStrokes((currentStrokes) => [...currentStrokes, [point]]);
                }
              }}
              onPointerMove={(event) => {
                if (!isDrawingRef.current) {
                  return;
                }
                event.preventDefault();
                appendSignaturePoint(event);
              }}
              onPointerUp={(event) => {
                isDrawingRef.current = false;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={() => {
                isDrawingRef.current = false;
              }}
            />
          </div>
          {signatureError ? <p className="form-error">{signatureError}</p> : null}
          <div className="mobile-customer-signature-actions">
            <button
              className="secondary-action"
              type="button"
              onClick={() => {
                setStrokes([]);
                setSignatureError(null);
              }}
              disabled={isSavingSignature}
            >
              Leeren
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={() => void handleSaveSignature()}
              disabled={isSavingSignature || !customerName.trim() || !hasSignature}
            >
              {isSavingSignature ? "Speichert..." : "Speichern"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ExtraWorkWorkerSignatureOverlay({
  assignmentId,
  order,
  workerName,
  onClose,
  onSigned,
}: {
  assignmentId: number;
  order: MobileExtraWorkTicket;
  workerName: string;
  onClose: () => void;
  onSigned: (order: MobileExtraWorkTicket) => void;
}) {
  const [signerName, setSignerName] = useState(order.worker_signature_name ?? workerName);
  const [strokes, setStrokes] = useState<CustomerSignatureStroke[]>([]);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [isSavingSignature, setIsSavingSignature] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const hasSignature = strokes.some((stroke) => stroke.length >= 2);
  const isTopModal = useMobileModalStack(true);

  useEffect(() => {
    drawSignatureCanvas(canvasRef.current, strokes);
  }, [strokes]);

  function appendSignaturePoint(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const point = getSignatureCanvasPoint(event);
    if (!point) {
      return;
    }
    setStrokes((currentStrokes) => {
      if (currentStrokes.length === 0) {
        return [[point]];
      }
      const nextStrokes = currentStrokes.slice();
      const lastStroke = nextStrokes[nextStrokes.length - 1] ?? [];
      nextStrokes[nextStrokes.length - 1] = [...lastStroke, point];
      return nextStrokes;
    });
  }

  async function handleSaveSignature(): Promise<void> {
    const normalizedName = signerName.trim();
    if (!normalizedName) {
      setSignatureError("Bitte Monteurnamen eintragen.");
      return;
    }
    const validStrokes = strokes.filter((stroke) => stroke.length >= 2);
    if (validStrokes.length === 0) {
      setSignatureError("Bitte Unterschrift erfassen.");
      return;
    }
    setIsSavingSignature(true);
    setSignatureError(null);
    try {
      const updatedOrder = await api.signMobileExtraWorkTicketWorker(assignmentId, order.id, {
        worker_name: normalizedName,
        signature_strokes: validStrokes,
      });
      onSigned(updatedOrder);
    } catch (requestError) {
      setSignatureError(readApiError(requestError, "Monteursunterschrift konnte nicht gespeichert werden."));
    } finally {
      setIsSavingSignature(false);
    }
  }

  return (
    <div
      aria-hidden={!isTopModal}
      className="mobile-dialog-backdrop mobile-modal-layer"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={isSavingSignature ? undefined : onClose}
    >
      <div
        className="mobile-project-email-dialog mobile-worker-signature-dialog mobile-modal-scroll-region"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-worker-signature-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mobile-project-email-dialog-head">
          <h2 id="mobile-worker-signature-dialog-title">Monteursunterschrift</h2>
          <p>{formatMobileExtraWorkOrderTitle(order)}</p>
        </div>
        <section className="mobile-worker-signature-card" aria-label="Monteursunterschrift erfassen">
          <label>
            <span>Monteur</span>
            <input
              value={signerName}
              onChange={(event) => setSignerName(event.target.value)}
              placeholder="Name des Monteurs"
            />
          </label>
          <div className="mobile-signature-canvas-wrap">
            <span>Unterschrift</span>
            <canvas
              ref={canvasRef}
              className="mobile-signature-canvas"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                isDrawingRef.current = true;
                const point = getSignatureCanvasPoint(event);
                if (point) {
                  setStrokes((currentStrokes) => [...currentStrokes, [point]]);
                }
              }}
              onPointerMove={(event) => {
                if (!isDrawingRef.current) {
                  return;
                }
                event.preventDefault();
                appendSignaturePoint(event);
              }}
              onPointerUp={(event) => {
                isDrawingRef.current = false;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={() => {
                isDrawingRef.current = false;
              }}
            />
          </div>
          {signatureError ? <p className="form-error">{signatureError}</p> : null}
          <div className="mobile-worker-signature-actions">
            <button className="secondary-action" type="button" onClick={onClose} disabled={isSavingSignature}>
              Abbrechen
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => {
                setStrokes([]);
                setSignatureError(null);
              }}
              disabled={isSavingSignature}
            >
              Leeren
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={() => void handleSaveSignature()}
              disabled={isSavingSignature || !signerName.trim() || !hasSignature}
            >
              {isSavingSignature ? "Speichert..." : "Speichern"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

type ExtraWorkWorkerHoursFormRow = {
  id: string;
  worker_name: string;
} & Record<ExtraWorkWeekdayKey, string>
  & Pick<MobileExtraWorkWorkerHours, "person_id" | ExtraWorkHiddenSurchargeKey>;

type ExtraWorkMaterialFormItem = MobileExtraWorkMaterialItem & {
  id: string;
};

type ExtraWorkMaterialEditDraft = {
  id: string;
  quantity: string;
  unit: string;
  description: string;
};

type ExtraWorkEntryFormState = {
  component: string;
  floor: string;
  room_number: string;
  axis: string;
  remarks: string;
  material_text: string;
  material_items: ExtraWorkMaterialFormItem[];
  estimated_hours: string;
  worker_rows: ExtraWorkWorkerHoursFormRow[];
};

function ExtraWorkEntryPage({
  assignmentId,
  assignmentPerson,
  assignmentStartDate,
  order,
  onBack,
  onOrderUpdated,
  onSaved,
}: {
  assignmentId: number;
  assignmentPerson: MobileAssignment["person"];
  assignmentStartDate: string;
  order: MobileExtraWorkTicket;
  onBack: () => void;
  onOrderUpdated: (order: MobileExtraWorkTicket) => void;
  onSaved: () => Promise<void>;
}) {
  const { user } = useAuth();
  const isApproval = order.kind === "approval";
  const automaticOrderDate = getExtraWorkAutomaticOrderDate(order.created_at);
  const automaticWeek = useMemo(
    () => getIsoWeekInfo(assignmentStartDate || automaticOrderDate),
    [assignmentStartDate, automaticOrderDate],
  );
  const selectedWeek = useMemo(() => ({
    isoYear: order.manual_execution_week_year ?? automaticWeek.isoYear,
    week: order.manual_execution_week ?? automaticWeek.week,
  }), [automaticWeek.isoYear, automaticWeek.week, order.manual_execution_week, order.manual_execution_week_year]);
  const selectedWeekRange = useMemo(
    () => getIsoWeekRange(selectedWeek.isoYear, selectedWeek.week),
    [selectedWeek.isoYear, selectedWeek.week],
  );
  const statusBadge = getMobileExtraWorkOrderStatusBadge(order);
  const canEdit = canEditMobileExtraWorkContent(order);
  const defaultWorkerName = useMemo(
    () => getExtraWorkDefaultWorkerName(assignmentPerson, user?.display_name || user?.username || ""),
    [assignmentPerson, user?.display_name, user?.username],
  );
  const legacyWorkerNames = useMemo(
    () => getExtraWorkLegacyWorkerNames(defaultWorkerName, user?.display_name || "", user?.username || ""),
    [defaultWorkerName, user?.display_name, user?.username],
  );
  const [form, setForm] = useState<ExtraWorkEntryFormState>(() => createEmptyExtraWorkEntryForm(defaultWorkerName));
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHoursFingerprint, setSavedHoursFingerprint] = useState("");
  const [isWeekDialogOpen, setIsWeekDialogOpen] = useState(false);
  const [visibleWeekYear, setVisibleWeekYear] = useState(selectedWeek.isoYear);
  const [pendingWeek, setPendingWeek] = useState<{ isoYear: number; week: number } | null>(null);
  const [isSavingWeek, setIsSavingWeek] = useState(false);
  const [weekError, setWeekError] = useState<string | null>(null);
  const [materialQuickInput, setMaterialQuickInput] = useState("");
  const [materialEditDraft, setMaterialEditDraft] = useState<ExtraWorkMaterialEditDraft | null>(null);
  const [materialError, setMaterialError] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const saveDockRef = useRef<HTMLDivElement>(null);
  const materialQuickInputRef = useRef<HTMLInputElement>(null);
  const focusScrollTimeoutRef = useRef<number | null>(null);
  const focusScrollFrameRef = useRef<number | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function loadEntry(): Promise<void> {
      setIsLoading(true);
      setError(null);
      try {
        const entry = await api.mobileExtraWorkTicketEntry(assignmentId, order.id);
        if (isMounted) {
          const nextForm = entry
            ? mapExtraWorkEntryToForm(entry, defaultWorkerName, legacyWorkerNames)
            : createEmptyExtraWorkEntryForm(defaultWorkerName);
          setForm(nextForm);
          setSavedHoursFingerprint(getExtraWorkHoursFingerprint(nextForm.worker_rows));
        }
      } catch (requestError) {
        if (isMounted) {
          setError(readApiError(requestError, "Eingaben konnten nicht geladen werden."));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }
    void loadEntry();
    return () => {
      isMounted = false;
    };
  }, [assignmentId, defaultWorkerName, legacyWorkerNames, order.id]);

  useEffect(() => {
    setVisibleWeekYear(selectedWeek.isoYear);
  }, [selectedWeek.isoYear]);

  const ensureActiveInputVisible = useCallback((target: HTMLElement) => {
    if (focusScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(focusScrollFrameRef.current);
    }
    focusScrollFrameRef.current = window.requestAnimationFrame(() => {
      const visualViewport = window.visualViewport;
      const visibleTop = visualViewport?.offsetTop ?? 0;
      const visibleBottom = visibleTop + (visualViewport?.height ?? window.innerHeight);
      const dockTop = saveDockRef.current?.getBoundingClientRect().top ?? visibleBottom;
      const targetRect = target.getBoundingClientRect();
      const safeTop = visibleTop + 58;
      const safeBottom = Math.min(visibleBottom, dockTop) - 12;
      if (targetRect.bottom > safeBottom) {
        window.scrollBy({ top: targetRect.bottom - safeBottom, behavior: "auto" });
      } else if (targetRect.top < safeTop) {
        window.scrollBy({ top: targetRect.top - safeTop, behavior: "auto" });
      }
      focusScrollFrameRef.current = null;
    });
  }, []);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    let viewportFrame = 0;
    const syncViewport = () => {
      window.cancelAnimationFrame(viewportFrame);
      viewportFrame = window.requestAnimationFrame(() => {
        const nextOffset = visualViewport
          ? Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop)
          : 0;
        pageRef.current?.style.setProperty(
          "--mobile-extra-work-keyboard-offset",
          `${Math.round(nextOffset)}px`,
        );
        const activeElement = document.activeElement;
        if (nextOffset > 0 && activeElement instanceof HTMLElement && pageRef.current?.contains(activeElement)) {
          ensureActiveInputVisible(activeElement);
        }
      });
    };
    syncViewport();
    visualViewport?.addEventListener("resize", syncViewport);
    visualViewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      window.cancelAnimationFrame(viewportFrame);
      visualViewport?.removeEventListener("resize", syncViewport);
      visualViewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
    };
  }, [ensureActiveInputVisible]);

  useEffect(() => () => {
    if (focusScrollTimeoutRef.current !== null) {
      window.clearTimeout(focusScrollTimeoutRef.current);
    }
    if (focusScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(focusScrollFrameRef.current);
    }
  }, []);

  const hasUnsavedHours = useMemo(
    () => getExtraWorkHoursFingerprint(form.worker_rows) !== savedHoursFingerprint,
    [form.worker_rows, savedHoursFingerprint],
  );
  const hasInvalidDailyHours = useMemo(
    () => form.worker_rows.some((row) => (
      EXTRA_WORK_WEEK_DAYS.some((day) => getExtraWorkRowDailyHoursError(row, day) !== null)
    )),
    [form.worker_rows],
  );

  function updateField(
    key: Exclude<keyof ExtraWorkEntryFormState, "worker_rows" | "material_items">,
    value: string,
  ): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function addMaterialFromQuickInput(): void {
    const parsed = parseExtraWorkMaterialInput(materialQuickInput);
    if (!parsed) {
      materialQuickInputRef.current?.focus();
      return;
    }
    if (form.material_items.length >= 100) {
      setMaterialError("Maximal 100 Materialpositionen möglich.");
      return;
    }
    setForm((current) => ({
      ...current,
      material_items: [...current.material_items, { id: createClientRowId(), ...parsed }],
    }));
    setMaterialQuickInput("");
    setMaterialError(null);
    window.requestAnimationFrame(() => materialQuickInputRef.current?.focus());
  }

  function startEditingMaterial(item: ExtraWorkMaterialFormItem): void {
    setMaterialEditDraft({
      id: item.id,
      quantity: item.quantity === null ? "" : String(item.quantity).replace(".", ","),
      unit: item.unit ?? "",
      description: item.description,
    });
    setMaterialError(null);
  }

  function saveEditedMaterial(): void {
    if (!materialEditDraft) {
      return;
    }
    const quantity = parseExtraWorkMaterialQuantity(materialEditDraft.quantity);
    const description = materialEditDraft.description.trim();
    if (Number.isNaN(quantity)) {
      setMaterialError("Bitte eine gültige, nicht negative Menge eingeben.");
      return;
    }
    if (!description) {
      setMaterialError("Bitte eine Materialbeschreibung eingeben.");
      return;
    }
    setForm((current) => ({
      ...current,
      material_items: current.material_items.map((item) => (
        item.id === materialEditDraft.id
          ? {
              ...item,
              quantity,
              unit: materialEditDraft.unit.trim() || null,
              description,
            }
          : item
      )),
    }));
    setMaterialEditDraft(null);
    setMaterialError(null);
  }

  function removeMaterialItem(itemId: string): void {
    setForm((current) => ({
      ...current,
      material_items: current.material_items.filter((item) => item.id !== itemId),
    }));
    setMaterialEditDraft((current) => current?.id === itemId ? null : current);
    setMaterialError(null);
  }

  function focusMaterialQuickInput(): void {
    materialQuickInputRef.current?.focus({ preventScroll: true });
    if (materialQuickInputRef.current) {
      ensureActiveInputVisible(materialQuickInputRef.current);
    }
  }

  function handleFormFocus(event: ReactFocusEvent<HTMLFormElement>): void {
    if (!(event.target instanceof HTMLElement)) {
      return;
    }
    if (focusScrollTimeoutRef.current !== null) {
      window.clearTimeout(focusScrollTimeoutRef.current);
    }
    const target = event.target;
    focusScrollTimeoutRef.current = window.setTimeout(() => {
      ensureActiveInputVisible(target);
      focusScrollTimeoutRef.current = null;
    }, 180);
  }

  function getMaterialItemsForSave(): ExtraWorkMaterialFormItem[] | null {
    let items = form.material_items;
    if (materialEditDraft) {
      const quantity = parseExtraWorkMaterialQuantity(materialEditDraft.quantity);
      const description = materialEditDraft.description.trim();
      if (Number.isNaN(quantity)) {
        setMaterialError("Bitte eine gültige, nicht negative Menge eingeben.");
        return null;
      }
      if (!description) {
        setMaterialError("Bitte eine Materialbeschreibung eingeben.");
        return null;
      }
      items = items.map((item) => (
        item.id === materialEditDraft.id
          ? {
              ...item,
              quantity,
              unit: materialEditDraft.unit.trim() || null,
              description,
            }
          : item
      ));
    }
    const pendingItem = parseExtraWorkMaterialInput(materialQuickInput);
    if (pendingItem) {
      if (items.length >= 100) {
        setMaterialError("Maximal 100 Materialpositionen möglich.");
        return null;
      }
      items = [...items, { id: createClientRowId(), ...pendingItem }];
    }
    setMaterialError(null);
    return items;
  }

  function updateWorkerRow(rowId: string, key: "worker_name" | ExtraWorkWeekdayKey, value: string): void {
    setForm((current) => ({
      ...current,
      worker_rows: current.worker_rows.map((row) => (
        row.id === rowId ? { ...row, [key]: value } : row
      )),
    }));
  }

  function addWorkerRow(): void {
    setForm((current) => ({
      ...current,
      worker_rows: [...current.worker_rows, createEmptyExtraWorkWorkerRow()],
    }));
  }

  function removeWorkerRow(rowId: string): void {
    setForm((current) => ({
      ...current,
      worker_rows: current.worker_rows.length > 1
        ? current.worker_rows.filter((row) => row.id !== rowId)
        : current.worker_rows,
    }));
  }

  async function persistExecutionWeek(nextWeek: { isoYear: number; week: number }): Promise<void> {
    if (!canEdit || isSavingWeek) {
      return;
    }
    setIsSavingWeek(true);
    setWeekError(null);
    try {
      const usesAutomaticWeek = nextWeek.isoYear === automaticWeek.isoYear
        && nextWeek.week === automaticWeek.week;
      const updatedOrder = await api.updateMobileExtraWorkTicketDetails(assignmentId, order.id, {
        manual_order_date: order.manual_order_date,
        manual_execution_week: usesAutomaticWeek ? null : nextWeek.week,
        manual_execution_week_year: usesAutomaticWeek ? null : nextWeek.isoYear,
      });
      onOrderUpdated(updatedOrder);
      setPendingWeek(null);
      setIsWeekDialogOpen(false);
    } catch (requestError) {
      setPendingWeek(null);
      setIsWeekDialogOpen(true);
      setWeekError(readApiError(requestError, "Kalenderwoche konnte nicht gespeichert werden."));
    } finally {
      setIsSavingWeek(false);
    }
  }

  function requestExecutionWeekChange(nextWeek: { isoYear: number; week: number }): void {
    if (nextWeek.isoYear === selectedWeek.isoYear && nextWeek.week === selectedWeek.week) {
      setIsWeekDialogOpen(false);
      return;
    }
    if (hasUnsavedHours) {
      setIsWeekDialogOpen(false);
      setPendingWeek(nextWeek);
      return;
    }
    void persistExecutionWeek(nextWeek);
  }

  async function saveEntry(): Promise<void> {
    if (!canEdit) {
      setError("Dieser Zusatzauftrag kann nicht mehr bearbeitet werden.");
      return;
    }
    setError(null);
    if (hasInvalidDailyHours) {
      setError("Bitte ungültige Tagesstunden korrigieren.");
      return;
    }
    const materialItems = getMaterialItemsForSave();
    if (!materialItems) {
      return;
    }
    const component = form.component.trim();
    const floor = form.floor.trim();
    const workerRows = form.worker_rows
      .map((row) => ({
        person_id: row.person_id ?? null,
        worker_name: row.worker_name.trim(),
        monday_hours: parseExtraWorkHoursInput(row.monday_hours),
        tuesday_hours: parseExtraWorkHoursInput(row.tuesday_hours),
        wednesday_hours: parseExtraWorkHoursInput(row.wednesday_hours),
        thursday_hours: parseExtraWorkHoursInput(row.thursday_hours),
        friday_hours: parseExtraWorkHoursInput(row.friday_hours),
        saturday_hours: parseExtraWorkHoursInput(row.saturday_hours),
        sunday_hours: parseExtraWorkHoursInput(row.sunday_hours),
        monday_surcharge_25_hours: row.monday_surcharge_25_hours ?? null,
        tuesday_surcharge_25_hours: row.tuesday_surcharge_25_hours ?? null,
        wednesday_surcharge_25_hours: row.wednesday_surcharge_25_hours ?? null,
        thursday_surcharge_25_hours: row.thursday_surcharge_25_hours ?? null,
        friday_surcharge_25_hours: row.friday_surcharge_25_hours ?? null,
        saturday_surcharge_25_hours: row.saturday_surcharge_25_hours ?? null,
        sunday_surcharge_25_hours: row.sunday_surcharge_25_hours ?? null,
        monday_surcharge_50_hours: row.monday_surcharge_50_hours ?? null,
        tuesday_surcharge_50_hours: row.tuesday_surcharge_50_hours ?? null,
        wednesday_surcharge_50_hours: row.wednesday_surcharge_50_hours ?? null,
        thursday_surcharge_50_hours: row.thursday_surcharge_50_hours ?? null,
        friday_surcharge_50_hours: row.friday_surcharge_50_hours ?? null,
        saturday_surcharge_50_hours: row.saturday_surcharge_50_hours ?? null,
        sunday_surcharge_50_hours: row.sunday_surcharge_50_hours ?? null,
      }))
      .filter((row) => row.worker_name || row.person_id !== null || calculateExtraWorkPayloadWorkerTotal(row) > 0 || hasExtraWorkSurchargeHours(row));
    if (!component || !floor) {
      setError("Bitte Bauteil und Etage ausfüllen.");
      return;
    }
    if (workerRows.length === 0 || workerRows.some((row) => !row.worker_name)) {
      setError("Bitte mindestens einen Monteur mit Namen erfassen.");
      return;
    }
    setIsSaving(true);
    try {
      await api.saveMobileExtraWorkTicketEntry(assignmentId, order.id, {
        component,
        floor,
        room_number: cleanOptionalFormText(form.room_number),
        axis: cleanOptionalFormText(form.axis),
        remarks: cleanOptionalFormText(form.remarks),
        material_text: cleanOptionalFormText(form.material_text),
        material_items: materialItems.map((item) => ({
          quantity: item.quantity,
          unit: item.unit,
          description: item.description,
        })),
        // Billing tickets do not expose this field in the compact mobile form,
        // but a desktop-entered value still has to survive a mobile edit.
        estimated_hours: parseNullableExtraWorkHoursInput(form.estimated_hours),
        worker_rows: workerRows,
      });
      await onSaved();
    } catch (requestError) {
      setError(readApiError(requestError, "Eingaben konnten nicht gespeichert werden."));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      ref={pageRef}
      className="mobile-measurement-entry-page mobile-extra-work-entry-page"
    >
      <nav className="mobile-extra-work-sticky-nav" aria-label="Zurück zum Stundenzettel">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={20} />
          <span>Stundenzettel</span>
        </button>
      </nav>

      <header className="mobile-extra-work-entry-header-card">
        <div>
          <h1>{isApproval ? "Stundenfreigabe erfassen" : "Leistungen erfassen"}</h1>
          <p>{formatMobileExtraWorkEntrySubtitle(order)}</p>
        </div>
        <div className="mobile-extra-work-entry-header-meta">
          <span className={`measurement-status ${statusBadge.className}`}>{statusBadge.label}</span>
          <span className="mobile-extra-work-entry-date">
            <CalendarDays aria-hidden="true" size={18} />
            {formatGermanDateKey(order.manual_order_date ?? automaticOrderDate)}
          </span>
        </div>
      </header>

      {isLoading ? <div className="empty-panel">Eingaben werden geladen...</div> : null}
      {error ? <div className="form-error">{error}</div> : null}

      {!isLoading ? (
        <form
          id="mobile-extra-work-entry-form"
          className="mobile-measurement-form mobile-measurement-entry-form mobile-extra-work-form"
          onFocusCapture={handleFormFocus}
          onSubmit={(event) => {
            event.preventDefault();
            void saveEntry();
          }}
        >
          <section className="mobile-extra-work-card mobile-extra-work-location-card">
            <div className="mobile-extra-work-card-heading">
              <MapPin aria-hidden="true" size={21} />
              <h2>Ort / Position</h2>
            </div>
            <div className="mobile-extra-work-location-grid">
              <label className="mobile-extra-work-location-control">
                <span className="mobile-extra-work-location-label">Bauteil</span>
                <span className="mobile-extra-work-location-input">
                  <span className="mobile-extra-work-location-icon"><Building2 aria-hidden="true" size={18} /></span>
                  <input
                    value={form.component}
                    onChange={(event) => updateField("component", event.target.value)}
                    placeholder="z. B. Halle A"
                    disabled={!canEdit}
                    required
                  />
                </span>
              </label>
              <label className="mobile-extra-work-location-control">
                <span className="mobile-extra-work-location-label">Etage</span>
                <span className="mobile-extra-work-location-input">
                  <span className="mobile-extra-work-location-icon"><Layers3 aria-hidden="true" size={18} /></span>
                  <input
                    value={form.floor}
                    onChange={(event) => updateField("floor", event.target.value)}
                    placeholder="z. B. EG"
                    disabled={!canEdit}
                    required
                  />
                </span>
              </label>
              <label className="mobile-extra-work-location-control">
                <span className="mobile-extra-work-location-label">Raum Nr.</span>
                <span className="mobile-extra-work-location-input">
                  <span className="mobile-extra-work-location-icon"><DoorOpen aria-hidden="true" size={18} /></span>
                  <input
                    value={form.room_number}
                    onChange={(event) => updateField("room_number", event.target.value)}
                    placeholder="z. B. A-B-5-5.1"
                    disabled={!canEdit}
                  />
                </span>
              </label>
              <label className="mobile-extra-work-location-control">
                <span className="mobile-extra-work-location-label">Achse</span>
                <span className="mobile-extra-work-location-input">
                  <span className="mobile-extra-work-location-icon"><Grid2X2 aria-hidden="true" size={18} /></span>
                  <input
                    value={form.axis}
                    onChange={(event) => updateField("axis", event.target.value)}
                    placeholder="z. B. 1-2 / A-B"
                    disabled={!canEdit}
                  />
                </span>
              </label>
              {isApproval ? (
                <label className="mobile-extra-work-location-control is-wide">
                  <span className="mobile-extra-work-location-label">Stundenvorgabe / geschätzt</span>
                  <span className="mobile-extra-work-location-input">
                    <span className="mobile-extra-work-location-icon"><ClipboardList aria-hidden="true" size={18} /></span>
                    <input
                      inputMode="decimal"
                      value={form.estimated_hours}
                      onChange={(event) => updateField("estimated_hours", event.target.value)}
                      placeholder="z. B. 12,5"
                      disabled={!canEdit}
                    />
                  </span>
                </label>
              ) : null}
            </div>
          </section>

          <section className="mobile-extra-work-card mobile-extra-work-section">
            <div className="mobile-extra-work-section-head">
              <div className="mobile-extra-work-card-heading">
                <UserRound aria-hidden="true" size={21} />
                <h2>Monteure und Stunden</h2>
              </div>
              <button
                className="mobile-extra-work-week-button"
                type="button"
                onClick={() => {
                  setWeekError(null);
                  setVisibleWeekYear(selectedWeek.isoYear);
                  setIsWeekDialogOpen(true);
                }}
                disabled={!canEdit || isSavingWeek}
                aria-label={`Kalenderwoche ändern, aktuell KW ${selectedWeek.week}`}
              >
                <span>KW {selectedWeek.week}</span>
                <CalendarDays aria-hidden="true" size={20} />
              </button>
            </div>
            <div className="mobile-extra-work-worker-list">
              {form.worker_rows.map((row, index) => (
                <article className="mobile-extra-work-worker-card" key={row.id}>
                  <div className="mobile-extra-work-worker-head">
                    <label className="mobile-extra-work-worker-name">
                      <UserRound aria-hidden="true" size={20} />
                      <span className="visually-hidden">Name des Monteurs</span>
                      <input
                        value={row.worker_name}
                        onChange={(event) => updateWorkerRow(row.id, "worker_name", event.target.value)}
                        placeholder="Name des Monteurs"
                        disabled={!canEdit}
                        required
                      />
                    </label>
                  </div>
                  <div className="mobile-extra-work-week-grid">
                    {EXTRA_WORK_WEEK_DAYS.map((day) => {
                      const validationError = getExtraWorkRowDailyHoursError(row, day);
                      const errorId = `extra-work-hours-error-${row.id}-${day.key}`;
                      return (
                        <label className={validationError ? "is-invalid" : ""} key={day.key}>
                          <span>{day.label}</span>
                          <span className="mobile-extra-work-hours-input">
                            <input
                              inputMode="decimal"
                              value={row[day.key]}
                              onChange={(event) => updateWorkerRow(row.id, day.key, event.target.value)}
                              placeholder="0,00"
                              disabled={!canEdit}
                              aria-invalid={Boolean(validationError)}
                              aria-describedby={validationError ? errorId : undefined}
                            />
                            <span aria-hidden="true">h</span>
                          </span>
                          {validationError ? (
                            <small className="mobile-extra-work-hours-error" id={errorId}>{validationError}</small>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                  <div className="mobile-extra-work-worker-footer">
                    <p className="mobile-extra-work-worker-total">Summe: <strong>{formatExtraWorkHours(calculateExtraWorkWorkerTotal(row))} h</strong></p>
                    <button
                      className="mobile-extra-work-remove-worker"
                      type="button"
                      onClick={() => removeWorkerRow(row.id)}
                      disabled={!canEdit || form.worker_rows.length <= 1}
                      aria-label={`Monteur ${index + 1} entfernen`}
                    >
                      <Trash2 aria-hidden="true" size={20} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <button className="secondary-action mobile-extra-work-add-worker" type="button" onClick={addWorkerRow} disabled={!canEdit}>
              <Plus aria-hidden="true" size={15} />
              <span>Monteur hinzufügen</span>
            </button>
          </section>

          <section className="mobile-extra-work-card mobile-extra-work-text-card">
            <label>
              <span className="mobile-extra-work-card-heading">
                <MessageSquare aria-hidden="true" size={21} />
                <span>Bemerkungen / ausgeführte Arbeiten</span>
              </span>
              <textarea
                value={form.remarks}
                onChange={(event) => updateField("remarks", event.target.value)}
                placeholder="z. B. Beschreibung der Arbeiten, Besonderheiten ..."
                disabled={!canEdit}
                rows={3}
              />
            </label>
          </section>
          <section className="mobile-extra-work-card mobile-extra-work-material-card">
            <div className="mobile-extra-work-card-heading">
              <Package aria-hidden="true" size={21} />
              <h2>Material</h2>
            </div>
            <div className="mobile-extra-work-material-quick-input">
              <input
                ref={materialQuickInputRef}
                value={materialQuickInput}
                onChange={(event) => setMaterialQuickInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    addMaterialFromQuickInput();
                  }
                }}
                placeholder="z. B. 2x Stiel US 5 bis 500"
                enterKeyHint="done"
                disabled={!canEdit}
                maxLength={500}
              />
              <button
                type="button"
                onClick={addMaterialFromQuickInput}
                disabled={!canEdit || !materialQuickInput.trim()}
                aria-label="Materialposition hinzufügen"
              >
                <Plus aria-hidden="true" size={20} />
              </button>
            </div>

            {form.material_items.length > 0 ? (
              <div className="mobile-extra-work-material-list">
                {form.material_items.map((item) => {
                  const quantityLabel = formatExtraWorkMaterialQuantity(item.quantity, item.unit);
                  const isEditing = materialEditDraft?.id === item.id;
                  return (
                    <div className={`mobile-extra-work-material-item${quantityLabel ? "" : " has-no-quantity"}`} key={item.id}>
                      {isEditing && materialEditDraft ? (
                        <div className="mobile-extra-work-material-edit">
                          <label>
                            <span>Menge</span>
                            <input
                              inputMode="decimal"
                              value={materialEditDraft.quantity}
                              onChange={(event) => setMaterialEditDraft((current) => current ? { ...current, quantity: event.target.value } : current)}
                              placeholder="2"
                            />
                          </label>
                          <label>
                            <span>Einheit</span>
                            <input
                              value={materialEditDraft.unit}
                              onChange={(event) => setMaterialEditDraft((current) => current ? { ...current, unit: event.target.value } : current)}
                              placeholder="x"
                              maxLength={16}
                            />
                          </label>
                          <label className="is-description">
                            <span>Material</span>
                            <input
                              value={materialEditDraft.description}
                              onChange={(event) => setMaterialEditDraft((current) => current ? { ...current, description: event.target.value } : current)}
                              placeholder="Materialbeschreibung"
                              maxLength={500}
                            />
                          </label>
                          <div className="mobile-extra-work-material-edit-actions">
                            <button type="button" onClick={() => setMaterialEditDraft(null)} aria-label="Bearbeitung abbrechen">
                              <X aria-hidden="true" size={18} />
                            </button>
                            <button type="button" onClick={saveEditedMaterial} aria-label="Materialposition übernehmen">
                              <CheckCircle2 aria-hidden="true" size={18} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {quantityLabel ? <span className="mobile-extra-work-material-quantity">{quantityLabel}</span> : null}
                          <span className="mobile-extra-work-material-description">{item.description}</span>
                          <div className="mobile-extra-work-material-actions">
                            <button type="button" onClick={() => startEditingMaterial(item)} disabled={!canEdit} aria-label={`${item.description} bearbeiten`}>
                              <Pencil aria-hidden="true" size={17} />
                            </button>
                            <button type="button" onClick={() => removeMaterialItem(item.id)} disabled={!canEdit} aria-label={`${item.description} löschen`}>
                              <Trash2 aria-hidden="true" size={17} />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {materialError ? <p className="mobile-extra-work-material-error">{materialError}</p> : null}

            {form.material_text.trim() ? (
              <label className="mobile-extra-work-legacy-material">
                <span>Bisherige Materialangaben</span>
                <textarea
                  value={form.material_text}
                  onChange={(event) => updateField("material_text", event.target.value)}
                  disabled={!canEdit}
                  rows={2}
                />
              </label>
            ) : null}

            {form.material_items.length > 0 ? (
              <button className="secondary-action mobile-extra-work-add-material" type="button" onClick={focusMaterialQuickInput} disabled={!canEdit}>
                <Plus aria-hidden="true" size={15} />
                <span>Material hinzufügen</span>
              </button>
            ) : null}
          </section>

          {!canEdit ? (
            <p className="mobile-extra-work-entry-locked-note">Dieser Zusatzauftrag ist abgeschlossen und kann nicht mehr bearbeitet werden.</p>
          ) : null}

        </form>
      ) : null}

      <div ref={saveDockRef} className="mobile-extra-work-save-dock">
        <button
          className="primary-action"
          type="submit"
          form="mobile-extra-work-entry-form"
          disabled={isLoading || isSaving || !canEdit || hasInvalidDailyHours}
        >
          {isSaving ? "Speichert..." : "Speichern"}
        </button>
      </div>

      {isWeekDialogOpen ? (
        <ExtraWorkWeekPickerDialog
          selectedWeek={selectedWeek}
          selectedWeekRange={selectedWeekRange}
          visibleYear={visibleWeekYear}
          isSaving={isSavingWeek}
          error={weekError}
          onVisibleYearChange={setVisibleWeekYear}
          onSelect={requestExecutionWeekChange}
          onClose={() => setIsWeekDialogOpen(false)}
        />
      ) : null}
      {pendingWeek ? (
        <ExtraWorkWeekChangeConfirmDialog
          isSaving={isSavingWeek}
          onCancel={() => setPendingWeek(null)}
          onConfirm={() => void persistExecutionWeek(pendingWeek)}
        />
      ) : null}
    </div>
  );
}

function ExtraWorkWeekPickerDialog({
  selectedWeek,
  selectedWeekRange,
  visibleYear,
  isSaving,
  error,
  onVisibleYearChange,
  onSelect,
  onClose,
}: {
  selectedWeek: { isoYear: number; week: number };
  selectedWeekRange: { start: string; end: string };
  visibleYear: number;
  isSaving: boolean;
  error: string | null;
  onVisibleYearChange: (year: number) => void;
  onSelect: (week: { isoYear: number; week: number }) => void;
  onClose: () => void;
}) {
  const isTopModal = useMobileModalStack(true);
  const weeks = Array.from({ length: getIsoWeeksInYear(visibleYear) }, (_, index) => index + 1);

  return (
    <div
      aria-hidden={!isTopModal}
      className="mobile-dialog-backdrop mobile-modal-layer"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={isSaving ? undefined : onClose}
    >
      <div
        className="mobile-extra-work-week-dialog mobile-modal-scroll-region"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-extra-work-week-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mobile-extra-work-week-dialog-head">
          <div>
            <h2 id="mobile-extra-work-week-dialog-title">Kalenderwoche</h2>
            <p>
              KW {selectedWeek.week} · {formatGermanDateKey(selectedWeekRange.start)} – {formatGermanDateKey(selectedWeekRange.end)}
            </p>
          </div>
          <button className="icon-button secondary" type="button" onClick={onClose} disabled={isSaving} aria-label="Schließen">
            <X aria-hidden="true" size={18} />
          </button>
        </div>
        <div className="mobile-extra-work-week-year-nav">
          <button type="button" onClick={() => onVisibleYearChange(visibleYear - 1)} disabled={isSaving || visibleYear <= 1} aria-label="Vorheriges Jahr">
            <ChevronLeft aria-hidden="true" size={20} />
          </button>
          <strong>{visibleYear}</strong>
          <button type="button" onClick={() => onVisibleYearChange(visibleYear + 1)} disabled={isSaving || visibleYear >= 9999} aria-label="Nächstes Jahr">
            <ChevronRight aria-hidden="true" size={20} />
          </button>
        </div>
        <div className="mobile-extra-work-week-options" aria-label={`Kalenderwochen ${visibleYear}`}>
          {weeks.map((week) => {
            const isSelected = selectedWeek.isoYear === visibleYear && selectedWeek.week === week;
            const range = getIsoWeekRange(visibleYear, week);
            return (
              <button
                className={isSelected ? "is-selected" : ""}
                type="button"
                key={`${visibleYear}-${week}`}
                onClick={() => onSelect({ isoYear: visibleYear, week })}
                disabled={isSaving}
                aria-pressed={isSelected}
                title={`${formatGermanDateKey(range.start)} – ${formatGermanDateKey(range.end)}`}
              >
                KW {week}
              </button>
            );
          })}
        </div>
        {error ? <p className="form-error">{error}</p> : null}
      </div>
    </div>
  );
}

function ExtraWorkWeekChangeConfirmDialog({
  isSaving,
  onCancel,
  onConfirm,
}: {
  isSaving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isTopModal = useMobileModalStack(true);
  return (
    <div
      aria-hidden={!isTopModal}
      className="mobile-dialog-backdrop mobile-modal-layer"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={isSaving ? undefined : onCancel}
    >
      <div
        className="mobile-extra-work-week-confirm mobile-modal-scroll-region"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mobile-extra-work-week-confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="mobile-extra-work-week-confirm-title">Kalenderwoche ändern?</h2>
        <p>Bereits eingegebene, noch nicht gespeicherte Stunden beziehen sich auf die aktuelle KW.</p>
        <div className="mobile-extra-work-week-confirm-actions">
          <button className="secondary-action" type="button" onClick={onCancel} disabled={isSaving}>Abbrechen</button>
          <button className="primary-action" type="button" onClick={onConfirm} disabled={isSaving}>
            {isSaving ? "Speichert..." : "KW ändern"}
          </button>
        </div>
      </div>
    </div>
  );
}

function OverviewPanel({ assignment }: { assignment: MobileAssignment }) {
  const addressLabel = formatMobileSiteAddressLabel(assignment.site);
  const directionsUrl = buildGoogleMapsDirectionsUrl(assignment.site);

  return (
    <div className="mobile-detail-panel">
      <h2>Übersicht</h2>
      <div className="assignment-detail-list">
        {addressLabel && (
          directionsUrl ? (
            <a
              className="assignment-address-link"
              href={directionsUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Route zu ${addressLabel} in Google Maps öffnen`}
            >
              <MapPin aria-hidden="true" size={16} />
              <span>{addressLabel}</span>
            </a>
          ) : (
            <p><MapPin aria-hidden="true" size={16} /><span>{addressLabel}</span></p>
          )
        )}
        {assignment.site.project_manager && (
          <p><UserRound aria-hidden="true" size={16} /><span>{assignment.site.project_manager.display_name}</span></p>
        )}
        {assignment.site.customer && (
          <p><ClipboardList aria-hidden="true" size={16} /><span>Kunde: {assignment.site.customer}</span></p>
        )}
      </div>
      {assignment.site.info && <p className="assignment-note">{assignment.site.info}</p>}
      {assignment.note && <p className="assignment-note">{assignment.note}</p>}
    </div>
  );
}

function MobileProjectPhotoCapture({ assignment, onOpenPhotos }: { assignment: MobileAssignment; onOpenPhotos: () => void }) {
  const [isUploadingProjectPhoto, setIsUploadingProjectPhoto] = useState(false);
  const [projectPhotoMessage, setProjectPhotoMessage] = useState<string | null>(null);
  const [projectPhotoMessageTone, setProjectPhotoMessageTone] = useState<"info" | "error">("info");
  const projectPhotoInputRef = useRef<HTMLInputElement | null>(null);

  function openProjectPhotoCapture(): void {
    setProjectPhotoMessage(null);
    setProjectPhotoMessageTone("info");
    projectPhotoInputRef.current?.click();
  }

  async function handleProjectPhotoChange(event: ReactChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file || isUploadingProjectPhoto) {
      return;
    }
    setIsUploadingProjectPhoto(true);
    setProjectPhotoMessage("Foto wird gespeichert...");
    setProjectPhotoMessageTone("info");
    try {
      const folders = await api.projectFolders(assignment.site.id);
      const hasConnectedProjectFolder = folders.some((folder) => folder.external_drive_id && folder.external_item_id);
      if (!hasConnectedProjectFolder) {
        throw new Error("Für diese Baustelle ist noch kein Projektordner vorhanden.");
      }
      const photoFolder = folders.find((folder) => folder.folder_key === "fotos");
      if (!photoFolder) {
        throw new Error("Projektordner Fotos wurde nicht gefunden.");
      }
      if (!photoFolder.external_drive_id || !photoFolder.external_item_id) {
        throw new Error("Für diese Baustelle ist noch kein Projektordner vorhanden.");
      }
      const uploadFile = await prepareMeasurementPhotoFile(file);
      await api.uploadProjectFolderDocument(assignment.site.id, "fotos", uploadFile);
      setProjectPhotoMessage("Foto gespeichert.");
      setProjectPhotoMessageTone("info");
    } catch (requestError) {
      setProjectPhotoMessage(
        requestError instanceof Error && !(requestError instanceof ApiError)
          ? requestError.message
          : readApiError(requestError, "Foto konnte nicht gespeichert werden."),
      );
      setProjectPhotoMessageTone("error");
    } finally {
      setIsUploadingProjectPhoto(false);
    }
  }

  return (
    <div className="mobile-project-photo-action">
      {projectPhotoMessage ? (
        <p className={projectPhotoMessageTone === "error" ? "form-error mobile-project-photo-message" : "form-info mobile-project-photo-message"}>
          {projectPhotoMessage}
        </p>
      ) : null}
      <MobileOverviewPhotoAction
        disabled={isUploadingProjectPhoto}
        description="Projektfotos anzeigen"
        onOpenPhotos={onOpenPhotos}
        onTakePhoto={openProjectPhotoCapture}
      />
      <input
        ref={projectPhotoInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => void handleProjectPhotoChange(event)}
      />
    </div>
  );
}

function MobileProjectPhotosPanel({ assignment, onBack }: { assignment: MobileAssignment; onBack: () => void }) {
  const [isUploadingProjectPhoto, setIsUploadingProjectPhoto] = useState(false);
  const [projectPhotoGalleryVersion, setProjectPhotoGalleryVersion] = useState(0);
  const [projectPhotoMessage, setProjectPhotoMessage] = useState<string | null>(null);
  const [projectPhotoMessageTone, setProjectPhotoMessageTone] = useState<"info" | "error">("info");
  const projectPhotoInputRef = useRef<HTMLInputElement | null>(null);

  function openProjectPhotoCapture(): void {
    setProjectPhotoMessage(null);
    setProjectPhotoMessageTone("info");
    projectPhotoInputRef.current?.click();
  }

  async function handleProjectPhotoChange(event: ReactChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file || isUploadingProjectPhoto) {
      return;
    }
    setIsUploadingProjectPhoto(true);
    setProjectPhotoMessage("Foto wird gespeichert...");
    setProjectPhotoMessageTone("info");
    try {
      const folders = await api.projectFolders(assignment.site.id);
      const hasConnectedProjectFolder = folders.some((folder) => folder.external_drive_id && folder.external_item_id);
      if (!hasConnectedProjectFolder) {
        throw new Error("Für diese Baustelle ist noch kein Projektordner vorhanden.");
      }
      const photoFolder = folders.find((folder) => folder.folder_key === "fotos");
      if (!photoFolder) {
        throw new Error("Projektordner Fotos wurde nicht gefunden.");
      }
      if (!photoFolder.external_drive_id || !photoFolder.external_item_id) {
        throw new Error("Für diese Baustelle ist noch kein Projektordner vorhanden.");
      }
      const uploadFile = await prepareMeasurementPhotoFile(file);
      await api.uploadProjectFolderDocument(assignment.site.id, "fotos", uploadFile);
      setProjectPhotoMessage("Foto gespeichert.");
      setProjectPhotoMessageTone("info");
      setProjectPhotoGalleryVersion((version) => version + 1);
    } catch (requestError) {
      setProjectPhotoMessage(
        requestError instanceof Error && !(requestError instanceof ApiError)
          ? requestError.message
          : readApiError(requestError, "Foto konnte nicht gespeichert werden."),
      );
      setProjectPhotoMessageTone("error");
    } finally {
      setIsUploadingProjectPhoto(false);
    }
  }

  return (
    <>
      <MobileProjectPhotoGallery
        assignment={assignment}
        refreshKey={projectPhotoGalleryVersion}
        isUploadingPhoto={isUploadingProjectPhoto}
        message={projectPhotoMessage}
        messageTone={projectPhotoMessageTone}
        onBack={onBack}
        onTakePhoto={openProjectPhotoCapture}
      />
      <input
        ref={projectPhotoInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => void handleProjectPhotoChange(event)}
      />
    </>
  );
}

function MobileProjectPhotoGallery({
  assignment,
  refreshKey,
  isUploadingPhoto,
  message,
  messageTone,
  onBack,
  onTakePhoto,
}: {
  assignment: MobileAssignment;
  refreshKey: number;
  isUploadingPhoto: boolean;
  message: string | null;
  messageTone: "info" | "error";
  onBack: () => void;
  onTakePhoto: () => void;
}) {
  const [photos, setPhotos] = useState<ProjectFolderDocumentItem[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState<MobileProjectPhotoPreviewState | null>(null);
  const [isLoadingPhotos, setIsLoadingPhotos] = useState(true);
  const [isOpeningPhotoAppendix, setIsOpeningPhotoAppendix] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  useEffect(() => {
    let isCurrent = true;

    async function loadProjectPhotos(): Promise<void> {
      setIsLoadingPhotos(true);
      setPhotoError(null);
      try {
        const response = await api.projectFolderDocuments(assignment.site.id, "fotos");
        const imageItems = response.items.filter((item) => !item.is_folder && getProjectDocumentKind(item) === "image");
        if (isCurrent) {
          setPhotos(imageItems);
        }
      } catch (requestError) {
        if (isCurrent) {
          setPhotos([]);
          setPhotoError(readApiError(requestError, "Projektfotos konnten nicht geladen werden."));
        }
      } finally {
        if (isCurrent) {
          setIsLoadingPhotos(false);
        }
      }
    }

    void loadProjectPhotos();
    return () => {
      isCurrent = false;
    };
  }, [assignment.site.id, refreshKey]);

  async function saveProjectPhotoCaption(caption: string | null): Promise<void> {
    if (!selectedPhoto) {
      return;
    }
    try {
      const updated = await api.updateProjectFolderDocumentCaption(
        assignment.site.id,
        "fotos",
        selectedPhoto.item.id,
        caption,
      );
      setPhotos((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSelectedPhoto((current) => current ? { ...current, item: updated } : null);
    } catch (requestError) {
      throw new Error(readApiError(requestError, "Beschriftung konnte nicht gespeichert werden."));
    }
  }

  async function openProjectPhotoAppendix(): Promise<void> {
    if (isOpeningPhotoAppendix) {
      return;
    }
    setIsOpeningPhotoAppendix(true);
    setPhotoError(null);
    try {
      const blob = await api.projectPhotoAppendixPdf(assignment.site.id);
      const filename = `Fotoanlage_Projektfotos_${assignment.site.site_number || assignment.site.id}.pdf`;
      if (isNativeAndroidApp()) {
        await openAndroidPdfBlob(blob, filename);
      } else {
        const url = window.URL.createObjectURL(blob);
        const openedWindow = window.open(url, "_blank", "noopener,noreferrer");
        if (!openedWindow) {
          downloadBlobFile(blob, filename);
        }
        window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
      }
    } catch (requestError) {
      setPhotoError(readApiError(requestError, "Fotoanlage konnte nicht geöffnet werden."));
    } finally {
      setIsOpeningPhotoAppendix(false);
    }
  }

  return (
    <div className="mobile-detail-panel mobile-measurement-photo-gallery mobile-project-photo-gallery">
      <div className="mobile-measurement-detail-topbar">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Projekt</span>
        </button>
        <button className="primary-action mobile-measurement-photo-capture-action" type="button" onClick={onTakePhoto} disabled={isUploadingPhoto}>
          <Camera aria-hidden="true" size={16} />
          <span>{isUploadingPhoto ? "Speichert..." : "Foto aufnehmen"}</span>
        </button>
      </div>

      <header className="mobile-measurement-photo-gallery-head">
        <h2>Projektfotos</h2>
        <p>{assignment.site.name}</p>
      </header>

      <button
        className="secondary-action mobile-project-photo-pdf-action"
        type="button"
        onClick={() => void openProjectPhotoAppendix()}
        disabled={isLoadingPhotos || !photos.length || isOpeningPhotoAppendix}
      >
        <FileText aria-hidden="true" size={17} />
        <span>{isOpeningPhotoAppendix ? "PDF wird erstellt..." : "Fotoanlage PDF öffnen"}</span>
      </button>

      {message ? (
        <p className={messageTone === "error" ? "form-error mobile-project-photo-message" : "form-info mobile-project-photo-message"}>
          {message}
        </p>
      ) : null}
      {photoError ? <div className="form-error">{photoError}</div> : null}
      {isLoadingPhotos ? <div className="empty-panel">Fotos werden geladen...</div> : null}
      {!isLoadingPhotos && !photos.length ? (
        <div className="empty-panel mobile-measurement-photo-empty">
          <span>Noch keine Fotos hinterlegt.</span>
          <button className="secondary-action" type="button" onClick={onTakePhoto} disabled={isUploadingPhoto}>
            Foto aufnehmen
          </button>
        </div>
      ) : null}
      {!isLoadingPhotos && photos.length ? (
        <div className="mobile-measurement-photo-grid">
          {photos.map((photo) => (
            <MobileProjectPhotoTile
              item={photo}
              key={photo.id || photo.name}
              siteId={assignment.site.id}
              onOpen={setSelectedPhoto}
            />
          ))}
        </div>
      ) : null}
      {selectedPhoto ? (
        <MobilePhotoCaptionViewer
          alt={selectedPhoto.item.name}
          canEdit
          caption={selectedPhoto.item.caption}
          dateLabel={formatDateTimeLabel(selectedPhoto.item.created_date_time ?? selectedPhoto.item.last_modified_date_time)}
          filename={selectedPhoto.item.name}
          imageUrl={selectedPhoto.url}
          onClose={() => setSelectedPhoto(null)}
          onSave={saveProjectPhotoCaption}
        />
      ) : null}
    </div>
  );
}

function MobileProjectPhotoTile({
  item,
  siteId,
  onOpen,
}: {
  item: ProjectFolderDocumentItem;
  siteId: number;
  onOpen: (preview: MobileProjectPhotoPreviewState) => void;
}) {
  const tileRef = useRef<HTMLButtonElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingImage, setIsLoadingImage] = useState(false);

  useEffect(() => {
    const element = tileRef.current;
    if (!element || isVisible) {
      return undefined;
    }
    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setIsVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible || url || error) {
      return undefined;
    }
    let isCurrent = true;
    let objectUrl: string | null = null;

    async function loadPhoto(): Promise<void> {
      setIsLoadingImage(true);
      try {
        const blob = await api.projectFolderDocumentContent(siteId, "fotos", item.id, "inline");
        objectUrl = window.URL.createObjectURL(blob);
        if (isCurrent) {
          setUrl(objectUrl);
        } else {
          window.URL.revokeObjectURL(objectUrl);
        }
      } catch (requestError) {
        if (isCurrent) {
          setError(readApiError(requestError, "Foto konnte nicht geladen werden."));
        }
      } finally {
        if (isCurrent) {
          setIsLoadingImage(false);
        }
      }
    }

    void loadPhoto();
    return () => {
      isCurrent = false;
      if (objectUrl) {
        window.URL.revokeObjectURL(objectUrl);
      }
    };
  }, [error, isVisible, item.id, siteId, url]);

  return (
    <button
      ref={tileRef}
      className="mobile-measurement-photo-tile mobile-project-photo-tile"
      type="button"
      onClick={() => {
        if (url) {
          onOpen({ item, url });
        }
      }}
      disabled={!url}
    >
      {url ? <img alt={item.name} src={url} loading="lazy" /> : <span>{error ?? (isLoadingImage ? "Foto wird geladen..." : "Foto")}</span>}
      <small>{formatProjectDocumentMeta(item, { includeFallbackType: false })}</small>
    </button>
  );
}

function MobileCameraButton({
  className = "",
  disabled,
  label,
  onClick,
}: {
  className?: string;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={`mobile-camera-button ${className}`.trim()}
      type="button"
      onClick={onClick}
      disabled={disabled}
    >
      <Camera aria-hidden="true" size={24} />
    </button>
  );
}

function MobileOverviewPhotoAction({
  count,
  description,
  disabled,
  onOpenPhotos,
  onTakePhoto,
}: {
  count?: number | null;
  description?: string;
  disabled?: boolean;
  onOpenPhotos: () => void;
  onTakePhoto: () => void;
}) {
  return (
    <div className="mobile-measurement-photo-action-row">
      <button className="mobile-measurement-overview-action mobile-measurement-photo-main-action" type="button" onClick={onOpenPhotos}>
        <Images aria-hidden="true" size={18} />
        <span>
          <strong>Hinterlegte Fotos{count ? ` (${count})` : ""}</strong>
          {description ? <small>{description}</small> : null}
        </span>
      </button>
      <MobileCameraButton
        className="mobile-measurement-inline-camera-button"
        disabled={disabled}
        label="Foto aufnehmen"
        onClick={onTakePhoto}
      />
    </div>
  );
}

function MobileProjectFoldersPanel({ assignment }: { assignment: MobileAssignment }) {
  const { user } = useAuth();
  const canOpenSharePointDirectly = user?.role === "admin" || user?.role === "project_manager" || user?.role === "office";
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<ProjectFolder | null>(null);
  const [documents, setDocuments] = useState<ProjectFolderDocumentList | null>(null);
  const [folderStack, setFolderStack] = useState<MobileFolderNavigationLevel[]>([]);
  const [isLoadingFolders, setIsLoadingFolders] = useState(true);
  const [isLoadingDocuments, setIsLoadingDocuments] = useState(false);
  const [isLoadingNestedFolder, setIsLoadingNestedFolder] = useState(false);
  const [openingItemId, setOpeningItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [folderNavigationError, setFolderNavigationError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [documentPreview, setDocumentPreview] = useState<MobileDocumentPreviewState | null>(null);
  const [downloadingItemId, setDownloadingItemId] = useState<string | null>(null);
  const documentPreviewUrlRef = useRef<string | null>(null);

  const revokeDocumentPreviewUrl = useCallback((): void => {
    if (documentPreviewUrlRef.current) {
      window.URL.revokeObjectURL(documentPreviewUrlRef.current);
      documentPreviewUrlRef.current = null;
    }
  }, []);

  const clearDocumentPreview = useCallback((): void => {
    revokeDocumentPreviewUrl();
    setDocumentPreview(null);
  }, [revokeDocumentPreviewUrl]);

  useEffect(() => () => {
    revokeDocumentPreviewUrl();
  }, [revokeDocumentPreviewUrl]);

  useEffect(() => {
    let isCurrent = true;

    async function loadFolders(): Promise<void> {
      setIsLoadingFolders(true);
      setError(null);
      try {
        const response = await api.projectFolders(assignment.site.id);
        if (isCurrent) {
          setFolders(response);
        }
      } catch (requestError) {
        if (isCurrent) {
          setError(readApiError(requestError, "Ordnerstruktur konnte nicht geladen werden."));
        }
      } finally {
        if (isCurrent) {
          setIsLoadingFolders(false);
        }
      }
    }

    void loadFolders();
    return () => {
      isCurrent = false;
    };
  }, [assignment.site.id]);

  useEffect(() => {
    setDocuments(null);
    setDocumentsError(null);
    setFolderStack([]);
    setFolderNavigationError(null);
    setOpenError(null);
    clearDocumentPreview();
    if (!selectedFolder) {
      return;
    }

    const folder = selectedFolder;
    let isCurrent = true;

    async function loadDocuments(): Promise<void> {
      setIsLoadingDocuments(true);
      try {
        const response = await api.projectFolderDocuments(assignment.site.id, folder.folder_key);
        if (isCurrent) {
          setDocuments(response);
        }
      } catch (requestError) {
        if (isCurrent) {
          setDocumentsError(readApiError(requestError, "Dateien konnten nicht geladen werden."));
        }
      } finally {
        if (isCurrent) {
          setIsLoadingDocuments(false);
        }
      }
    }

    void loadDocuments();
    return () => {
      isCurrent = false;
    };
  }, [assignment.site.id, clearDocumentPreview, selectedFolder]);

  async function handleOpenFolderItem(item: ProjectFolderDocumentItem): Promise<void> {
    if (!selectedFolder || !item.is_folder) {
      return;
    }
    setFolderNavigationError(null);
    setOpenError(null);
    clearDocumentPreview();
    setIsLoadingNestedFolder(true);
    try {
      const childDocuments = await api.projectFolderItemChildren(
        assignment.site.id,
        selectedFolder.folder_key,
        item.id,
      );
      setFolderStack((currentStack) => [
        ...currentStack,
        { itemId: item.id, name: item.name, documents: childDocuments },
      ]);
    } catch (requestError) {
      setFolderNavigationError(readApiError(requestError, "Unterordner konnte nicht geladen werden."));
    } finally {
      setIsLoadingNestedFolder(false);
    }
  }

  async function handleOpenDocument(item: ProjectFolderDocumentItem): Promise<void> {
    if (!selectedFolder) {
      return;
    }
    const kind = getProjectDocumentKind(item);
    setOpenError(null);
    setOpeningItemId(item.id);
    revokeDocumentPreviewUrl();

    if (!isMobileInlineDocumentKind(kind)) {
      setDocumentPreview({
        item,
        kind,
        status: "unsupported",
        url: null,
        error: null,
      });
      setOpeningItemId(null);
      return;
    }

    if (kind === "pdf" && isNativeAndroidApp()) {
      setDocumentPreview({
        item,
        kind,
        status: "loading",
        url: null,
        error: null,
      });
      try {
        await openAndroidPdfFromProjectFolder(
          assignment.site.id,
          selectedFolder.folder_key,
          item,
        );
        clearDocumentPreview();
      } catch (requestError) {
        setDocumentPreview({
          item,
          kind,
          status: "error",
          url: null,
          error: readAndroidPdfOpenError(requestError),
        });
      } finally {
        setOpeningItemId(null);
      }
      return;
    }

    setDocumentPreview({
      item,
      kind,
      status: "loading",
      url: null,
      error: null,
    });
    try {
      const blob = await api.projectFolderDocumentContent(
        assignment.site.id,
        selectedFolder.folder_key,
        item.id,
        "inline",
      );
      const url = window.URL.createObjectURL(blob);
      documentPreviewUrlRef.current = url;
      setDocumentPreview({
        item,
        kind,
        status: "ready",
        url,
        error: null,
      });
    } catch (requestError) {
      setDocumentPreview({
        item,
        kind,
        status: "error",
        url: null,
        error: readApiError(requestError, "Dokument konnte nicht geladen werden."),
      });
    } finally {
      setOpeningItemId(null);
    }
  }

  async function handleDownloadDocument(item: ProjectFolderDocumentItem): Promise<void> {
    if (!selectedFolder) {
      return;
    }
    const kind = getProjectDocumentKind(item);
    setOpenError(null);
    setDownloadingItemId(item.id);
    try {
      if (kind === "pdf" && isNativeAndroidApp()) {
        await openAndroidPdfFromProjectFolder(
          assignment.site.id,
          selectedFolder.folder_key,
          item,
        );
        return;
      }
      const blob = await api.downloadProjectFolderDocument(
        assignment.site.id,
        selectedFolder.folder_key,
        item.id,
      );
      downloadBlobFile(blob, item.name || "download");
    } catch (requestError) {
      setOpenError(kind === "pdf" && isNativeAndroidApp()
        ? readAndroidPdfOpenError(requestError)
        : readApiError(requestError, "Datei konnte nicht heruntergeladen werden."));
    } finally {
      setDownloadingItemId(null);
    }
  }

  function handleBackFromFolderDetail(): void {
    if (folderStack.length > 0) {
      setFolderStack((currentStack) => currentStack.slice(0, -1));
      setFolderNavigationError(null);
      setOpenError(null);
      clearDocumentPreview();
      return;
    }
    clearDocumentPreview();
    setSelectedFolder(null);
  }

  const currentLevel = folderStack.length > 0 ? folderStack[folderStack.length - 1] : undefined;
  const currentDocuments = currentLevel?.documents ?? documents;
  const isInSubfolder = Boolean(currentLevel);
  const currentFolderTitle = currentLevel?.name ?? (
    selectedFolder ? `${selectedFolder.sort_order}. ${selectedFolder.name}` : ""
  );
  const currentLoading = isInSubfolder ? isLoadingNestedFolder : isLoadingDocuments;

  if (selectedFolder) {
    return (
      <div className="mobile-detail-panel mobile-folder-panel">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={handleBackFromFolderDetail}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>{isInSubfolder ? "Zurück" : "Ordner"}</span>
        </button>

        <div className="mobile-folder-detail-head">
          <div>
            <span>Ordner {selectedFolder.sort_order}</span>
            <h2>{currentFolderTitle}</h2>
          </div>
          {canOpenSharePointDirectly && !isInSubfolder && selectedFolder.external_web_url ? (
            <a className="mobile-folder-open-link" href={selectedFolder.external_web_url} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" size={15} />
              <span>In SharePoint öffnen</span>
            </a>
          ) : null}
        </div>

        {currentLoading ? <div className="empty-panel">Dateien werden geladen...</div> : null}
        {documentsError ? <div className="form-error">{documentsError}</div> : null}
        {folderNavigationError ? <div className="form-error">{folderNavigationError}</div> : null}
        {openError ? <div className="form-error">{openError}</div> : null}
        {documentPreview ? (
          <MobileDocumentPreview
            preview={documentPreview}
            isDownloading={downloadingItemId === documentPreview.item.id}
            downloadError={openError}
            onClose={clearDocumentPreview}
            onDownload={() => void handleDownloadDocument(documentPreview.item)}
          />
        ) : null}
        {!currentLoading && !documentsError && currentDocuments?.items.length === 0 ? (
          <div className="empty-panel">Noch keine Dateien in diesem Ordner.</div>
        ) : null}
        {!currentLoading && !documentsError && currentDocuments && currentDocuments.items.length > 0 ? (
          <div className="mobile-folder-file-list">
            {currentDocuments.items.map((item) => (
              <MobileFolderFileItem
                folderKey={selectedFolder.folder_key}
                item={item}
                key={item.id || item.name}
                isOpening={openingItemId === item.id || (isLoadingNestedFolder && item.is_folder)}
                siteId={assignment.site.id}
                onOpen={() => {
                  if (item.is_folder) {
                    void handleOpenFolderItem(item);
                    return;
                  }
                  void handleOpenDocument(item);
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mobile-detail-panel mobile-folder-panel">
      <h2>Ordner</h2>
      {isLoadingFolders ? <div className="empty-panel">Ordnerstruktur wird geladen...</div> : null}
      {error ? <div className="form-error">{error}</div> : null}
      {!isLoadingFolders && !error && folders.length === 0 ? (
        <div className="empty-panel">Keine Ordner vorhanden.</div>
      ) : null}
      {!isLoadingFolders && !error && folders.length > 0 ? (
        <div className="mobile-folder-list" aria-label="Projektordner">
          {folders.map((folder) => (
            <button className="mobile-folder-card" key={folder.id} type="button" onClick={() => setSelectedFolder(folder)}>
              <FolderOpen aria-hidden="true" size={19} />
              <span>{folder.sort_order}.</span>
              <strong>{folder.name}</strong>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MobileDocumentPreview({
  preview,
  isDownloading,
  downloadError,
  onClose,
  onDownload,
}: {
  preview: MobileDocumentPreviewState;
  isDownloading: boolean;
  downloadError: string | null;
  onClose: () => void;
  onDownload: () => void;
}) {
  const canRenderInline = preview.status === "ready" && preview.url && isMobileInlineDocumentKind(preview.kind);
  const downloadLabel = preview.kind === "pdf" ? "PDF" : "Download";
  const isTopModal = useMobileModalStack(true);
  return (
    <section
      aria-hidden={!isTopModal}
      aria-label="Dokumentenvorschau"
      aria-modal="true"
      className="mobile-document-preview mobile-modal-layer mobile-modal-scroll-region"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="dialog"
    >
      <div className="mobile-document-preview-head">
        <button className="icon-button secondary mobile-document-preview-back" type="button" onClick={onClose}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Dokumente</span>
        </button>
        <div>
          <span>{documentKindLabel(preview.kind)}</span>
          <h3>{preview.item.name}</h3>
          <p>{formatProjectDocumentMeta(preview.item, { includeFallbackType: false })}</p>
        </div>
      </div>

      <div className="mobile-document-preview-body">
        {preview.status === "loading" ? (
          <div className="empty-panel">Dokument wird geladen...</div>
        ) : null}

        {preview.status === "error" ? (
          <div className="form-error">{preview.error || "Dokument konnte nicht geladen werden."}</div>
        ) : null}

        {preview.status === "unsupported" ? (
          <div className="mobile-document-preview-note">
            {preview.error || "Diese Datei kann mobil nicht direkt angezeigt werden. Bitte lade sie über den Baustellenplaner herunter."}
          </div>
        ) : null}

        {canRenderInline && preview.kind === "image" ? (
          <div className="mobile-document-preview-frame is-image">
            <img src={preview.url ?? ""} alt={preview.item.name} />
          </div>
        ) : null}

        {canRenderInline && preview.kind === "pdf" ? (
          <div className="mobile-document-preview-frame">
            <iframe title={preview.item.name} src={preview.url ?? ""} />
          </div>
        ) : null}
      </div>

      <button className="mobile-document-download-action" type="button" disabled={isDownloading} onClick={onDownload}>
        <Download aria-hidden="true" size={16} />
        <span>{isDownloading ? "Lädt..." : downloadLabel}</span>
      </button>
      {downloadError ? <div className="mobile-document-viewer-error">{downloadError}</div> : null}
    </section>
  );
}

function isMobileInlineDocumentKind(kind: ProjectDocumentKind): boolean {
  return kind === "pdf" || kind === "image";
}

function isNativeAndroidApp(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

async function openAndroidPdfFromProjectFolder(
  siteId: number,
  folderKey: string,
  item: ProjectFolderDocumentItem,
): Promise<void> {
  const blob = await api.projectFolderDocumentContent(siteId, folderKey, item.id, "inline");
  await openAndroidPdfBlob(blob, item.name || "dokument.pdf");
}

async function openAndroidPdfBlob(blob: Blob, filename: string): Promise<void> {
  const data = await blobToBase64(blob);
  const safeFilename = toSafePdfFilename(filename);
  const writtenFile = await Filesystem.writeFile({
    path: `pdf-cache/${Date.now()}-${safeFilename}`,
    data,
    directory: Directory.Cache,
    recursive: true,
  });
  await FileOpener.open({
    filePath: writtenFile.uri,
    contentType: "application/pdf",
    openWithDefault: true,
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Datei konnte nicht gelesen werden."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64Data] = result.split(",", 2);
      if (!base64Data) {
        reject(new Error("Datei konnte nicht für Android vorbereitet werden."));
        return;
      }
      resolve(base64Data);
    };
    reader.readAsDataURL(blob);
  });
}

function toSafePdfFilename(filename: string): string {
  const withoutPath = filename.split(/[\\/]/).pop() ?? "dokument.pdf";
  const sanitized = withoutPath
    .trim()
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/g, " ")
    .slice(0, 90);
  const fallback = sanitized || "dokument.pdf";
  return fallback.toLocaleLowerCase("de-DE").endsWith(".pdf") ? fallback : `${fallback}.pdf`;
}

function readAndroidPdfOpenError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/activity not found|no application|no app|viewer|pdf-viewer/i.test(message)) {
    return "Kein PDF-Viewer installiert.";
  }
  return readApiError(error, "PDF konnte nicht mit Android geöffnet werden.");
}

function documentKindLabel(kind: ProjectDocumentKind): string {
  if (kind === "pdf") {
    return "PDF";
  }
  if (kind === "image") {
    return "Bild";
  }
  if (kind === "word") {
    return "Word-Dokument";
  }
  if (kind === "excel") {
    return "Excel-Datei";
  }
  if (kind === "mail") {
    return "E-Mail";
  }
  return "Datei";
}

function MobileFolderFileItem({
  folderKey,
  item,
  isOpening,
  siteId,
  onOpen,
}: {
  folderKey: string;
  item: ProjectFolderDocumentItem;
  isOpening: boolean;
  siteId: number;
  onOpen: () => void;
}) {
  const kind = getProjectDocumentKind(item);
  const isPdf = kind === "pdf";

  return (
    <button
      type="button"
      className={`mobile-folder-card mobile-folder-file-card${isPdf ? " is-pdf-preview" : ""}`}
      disabled={isOpening}
      onClick={onOpen}
    >
      {isPdf ? (
        <>
          <MobilePdfThumbnail folderKey={folderKey} item={item} siteId={siteId} />
          <span className="mobile-folder-file-copy">
            <strong>{item.name}</strong>
            <small>{formatProjectDocumentMeta(item, { includeFallbackType: false })}</small>
          </span>
          <ExternalLink aria-hidden="true" className="mobile-folder-file-open-icon" size={15} />
        </>
      ) : (
        <>
          {item.is_folder ? <FolderOpen aria-hidden="true" size={18} /> : <FileText aria-hidden="true" size={18} />}
          <span>
            <strong>{item.name}</strong>
            <small>{formatProjectDocumentMeta(item, { includeFallbackType: false })}</small>
          </span>
          {!item.is_folder ? <ExternalLink aria-hidden="true" size={15} /> : null}
        </>
      )}
    </button>
  );
}

function MobilePdfThumbnail({
  folderKey,
  item,
  siteId,
}: {
  folderKey: string;
  item: ProjectFolderDocumentItem;
  siteId: number;
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    let objectUrl: string | null = null;

    async function loadThumbnail(): Promise<void> {
      setHasError(false);
      setThumbnailUrl(null);
      try {
        const blob = await api.projectFolderDocumentThumbnail(siteId, folderKey, item.id);
        objectUrl = window.URL.createObjectURL(blob);
        if (isCurrent) {
          setThumbnailUrl(objectUrl);
        } else {
          window.URL.revokeObjectURL(objectUrl);
        }
      } catch {
        if (isCurrent) {
          setHasError(true);
        }
      }
    }

    void loadThumbnail();
    return () => {
      isCurrent = false;
      if (objectUrl) {
        window.URL.revokeObjectURL(objectUrl);
      }
    };
  }, [folderKey, item.id, siteId]);

  return (
    <span className={thumbnailUrl && !hasError ? "mobile-pdf-thumbnail is-ready" : "mobile-pdf-thumbnail"}>
      {thumbnailUrl && !hasError ? (
        <img
          alt=""
          loading="lazy"
          src={thumbnailUrl}
          onError={() => setHasError(true)}
        />
      ) : (
        <span className="mobile-pdf-thumbnail-placeholder" aria-hidden="true">
          <FileText size={28} />
          <small>PDF</small>
        </span>
      )}
    </span>
  );
}

function MobileMeasurementTab({
  assignment,
  onBackToProject,
  onEntryModeChange,
}: {
  assignment: MobileAssignment;
  onBackToProject: () => void;
  onEntryModeChange?: (isActive: boolean) => void;
}) {
  const [batches, setBatches] = useState<MobileMeasurementBatch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<MobileMeasurementBatch | null>(null);
  const [isBatchPositionOverviewOpen, setIsBatchPositionOverviewOpen] = useState(false);
  const [isFreePositionFormOpen, setIsFreePositionFormOpen] = useState(false);
  const [items, setItems] = useState<MobileMeasurementItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<MobileMeasurementItem | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isItemsLoading, setIsItemsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formComment, setFormComment] = useState("");
  const [formQuantity, setFormQuantity] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [freePositionDraft, setFreePositionDraft] = useState<MeasurementFreePositionDraft>(EMPTY_MEASUREMENT_FREE_POSITION_DRAFT);
  const [freePositionError, setFreePositionError] = useState<string | null>(null);
  const [signatureBatch, setSignatureBatch] = useState<MobileMeasurementBatch | null>(null);
  const [workerSignatureBatch, setWorkerSignatureBatch] = useState<MobileMeasurementBatch | null>(null);
  const [photoGalleryBatch, setPhotoGalleryBatch] = useState<MobileMeasurementBatch | null>(null);
  const [photoUploadBatch, setPhotoUploadBatch] = useState<MobileMeasurementBatch | null>(null);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  const [photoMessageTone, setPhotoMessageTone] = useState<"info" | "error">("info");
  const [photoGalleryVersion, setPhotoGalleryVersion] = useState(0);
  const [isOpeningPdf, setIsOpeningPdf] = useState(false);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [inlineCell, setInlineCell] = useState<InlineMeasurementCell | null>(null);
  const [inlineQuantity, setInlineQuantity] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const inlineFreePositionDraftIdRef = useRef(-1);
  const canUseInlineMeasurementTable = useMediaQuery(TABLET_INLINE_MEASUREMENT_QUERY);
  const viewMode: MeasurementViewMode = canUseInlineMeasurementTable ? "table" : "list";
  const isFreePositionDialogTopModal = useMobileModalStack(Boolean(
    selectedBatch && isBatchPositionOverviewOpen && isFreePositionFormOpen && canUseInlineMeasurementTable
  ));

  function mergeUpdatedBatch(updatedBatch: MobileMeasurementBatch): void {
    setBatches((currentBatches) => sortMobileMeasurementBatches(
      currentBatches.map((batch) => (batch.id === updatedBatch.id ? updatedBatch : batch)),
    ));
    setSelectedBatch((currentBatch) => (
      currentBatch?.id === updatedBatch.id ? updatedBatch : currentBatch
    ));
    setSignatureBatch((currentBatch) => (
      currentBatch?.id === updatedBatch.id ? updatedBatch : currentBatch
    ));
    setWorkerSignatureBatch((currentBatch) => (
      currentBatch?.id === updatedBatch.id ? updatedBatch : currentBatch
    ));
    setPhotoGalleryBatch((currentBatch) => (
      currentBatch?.id === updatedBatch.id ? updatedBatch : currentBatch
    ));
  }

  function updateBatchPhotoCount(batchId: number, nextCount: number): void {
    const applyCount = (batch: MobileMeasurementBatch) => (
      batch.id === batchId ? { ...batch, photo_count: nextCount } : batch
    );
    setBatches((currentBatches) => currentBatches.map(applyCount));
    setSelectedBatch((currentBatch) => (currentBatch ? applyCount(currentBatch) : currentBatch));
    setPhotoGalleryBatch((currentBatch) => (currentBatch ? applyCount(currentBatch) : currentBatch));
  }

  function updateBatchPositionCount(batchId: number, delta: number): void {
    const applyPositionCount = (batch: MobileMeasurementBatch) => (
      batch.id === batchId
        ? { ...batch, position_count: Math.max(0, batch.position_count + delta) }
        : batch
    );
    setBatches((currentBatches) => currentBatches.map(applyPositionCount));
    setSelectedBatch((currentBatch) => (currentBatch ? applyPositionCount(currentBatch) : currentBatch));
    setSignatureBatch((currentBatch) => (currentBatch ? applyPositionCount(currentBatch) : currentBatch));
    setWorkerSignatureBatch((currentBatch) => (currentBatch ? applyPositionCount(currentBatch) : currentBatch));
    setPhotoGalleryBatch((currentBatch) => (currentBatch ? applyPositionCount(currentBatch) : currentBatch));
  }

  function updateBatchAreaRows(batchId: number, areaRow: MeasurementAreaRow): void {
    const applyAreaRow = (batch: MobileMeasurementBatch) => (
      batch.id === batchId ? mergeMobileMeasurementBatchAreaRow(batch, areaRow) : batch
    );
    setBatches((currentBatches) => currentBatches.map(applyAreaRow));
    setSelectedBatch((currentBatch) => (currentBatch ? applyAreaRow(currentBatch) : currentBatch));
    setSignatureBatch((currentBatch) => (currentBatch ? applyAreaRow(currentBatch) : currentBatch));
    setWorkerSignatureBatch((currentBatch) => (currentBatch ? applyAreaRow(currentBatch) : currentBatch));
    setPhotoGalleryBatch((currentBatch) => (currentBatch ? applyAreaRow(currentBatch) : currentBatch));
  }

  async function createMeasurementAreaRow(areaOrComment: string): Promise<void> {
    if (!selectedBatch) {
      return;
    }
    try {
      const areaRow = await api.createMobileMeasurementAreaRow(assignment.id, selectedBatch.id, {
        area_or_comment: areaOrComment,
      });
      updateBatchAreaRows(selectedBatch.id, areaRow);
    } catch (requestError) {
      setError(readApiError(requestError, "Bereich / Ort konnte nicht gespeichert werden."));
    }
  }

  async function loadBatches(selectBatchId?: number): Promise<void> {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.mobileMeasurementBatches(assignment.id);
      const sortedBatches = sortMobileMeasurementBatches(response);
      setBatches(sortedBatches);
      if (selectBatchId) {
        const batch = sortedBatches.find((item) => item.id === selectBatchId) ?? null;
        setSelectedBatch(batch);
      }
    } catch (requestError) {
      setError(readApiError(requestError, "Aufmaße konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadBatchItems(batch: MobileMeasurementBatch, selectItemId?: number): Promise<void> {
    setIsItemsLoading(true);
    setError(null);
    setSearchTerm("");
    try {
      const response = await api.mobileMeasurementBatchItems(assignment.id, batch.id);
      setItems(response);
      setSelectedItem(selectItemId ? response.find((item) => item.id === selectItemId) ?? null : null);
    } catch (requestError) {
      setError(readApiError(requestError, "Aufmaßpositionen konnten nicht geladen werden."));
    } finally {
      setIsItemsLoading(false);
    }
  }

  useEffect(() => {
    void loadBatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment.id]);

  useEffect(() => {
    if (!canUseInlineMeasurementTable) {
      setInlineCell(null);
      setInlineQuantity("");
      setInlineError(null);
    }
  }, [canUseInlineMeasurementTable]);

  function closeBatchOverview(): void {
    setSelectedBatch(null);
    setSelectedItem(null);
    cancelInlineMeasurementEdit();
    setIsBatchPositionOverviewOpen(false);
    setIsFreePositionFormOpen(false);
    setItems([]);
    setError(null);
    setFreePositionError(null);
    setFreePositionDraft(EMPTY_MEASUREMENT_FREE_POSITION_DRAFT);
  }

  async function openMeasurementBatchPdf(batch: MobileMeasurementBatch): Promise<void> {
    if (isOpeningPdf) {
      return;
    }
    setIsOpeningPdf(true);
    setError(null);
    try {
      const blob = await api.mobileMeasurementBatchPdf(assignment.id, batch.id);
      const filename = getMobileMeasurementPdfFilename(batch);
      if (isNativeAndroidApp()) {
        await openAndroidPdfBlob(blob, filename);
      } else {
        const url = window.URL.createObjectURL(blob);
        const openedWindow = window.open(url, "_blank", "noopener,noreferrer");
        if (!openedWindow) {
          downloadBlobFile(blob, filename);
        }
        window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
      }
    } catch (requestError) {
      setError(readApiError(requestError, "Aufmaß-PDF konnte nicht geöffnet werden."));
    } finally {
      setIsOpeningPdf(false);
    }
  }

  function openPhotoCapture(batch: MobileMeasurementBatch): void {
    if ((batch.photo_count ?? 0) >= MOBILE_DOCUMENT_PHOTO_LIMIT) {
      setPhotoMessage("Maximal 5 Fotos pro Aufmaß erlaubt.");
      setPhotoMessageTone("error");
      return;
    }
    setPhotoUploadBatch(batch);
    setPhotoMessage(null);
    setPhotoMessageTone("info");
    photoInputRef.current?.click();
  }

  async function handlePhotoInputChange(event: ReactChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    const batch = photoUploadBatch ?? selectedBatch;
    if (!file || !batch || isUploadingPhoto) {
      return;
    }
    if ((batch.photo_count ?? 0) >= MOBILE_DOCUMENT_PHOTO_LIMIT) {
      setPhotoMessage("Maximal 5 Fotos pro Aufmaß erlaubt.");
      setPhotoMessageTone("error");
      setPhotoUploadBatch(null);
      return;
    }
    setIsUploadingPhoto(true);
    setPhotoMessage("Foto wird optimiert...");
    setPhotoMessageTone("info");
    try {
      const uploadFile = await prepareMeasurementPhotoFile(file);
      setPhotoMessage("Foto wird gespeichert...");
      await api.uploadMobileMeasurementBatchPhoto(assignment.id, batch.id, uploadFile);
      updateBatchPhotoCount(batch.id, (batch.photo_count ?? 0) + 1);
      setPhotoGalleryVersion((version) => version + 1);
      setPhotoMessage("Foto gespeichert.");
      setPhotoMessageTone("info");
    } catch (requestError) {
      setPhotoMessage(readApiError(requestError, "Foto konnte nicht gespeichert werden."));
      setPhotoMessageTone("error");
    } finally {
      setIsUploadingPhoto(false);
      setPhotoUploadBatch(null);
    }
  }

  async function handleCreateFreePosition(batch: MobileMeasurementBatch): Promise<void> {
    const description = freePositionDraft.description.trim();
    const unit = freePositionDraft.unit.trim();
    const quantity = parseOptionalMeasurementQuantity(freePositionDraft.quantity);
    const areaOrComment = normalizeMeasurementAreaInput(normalizeMeasurementArea(freePositionDraft.areaOrComment));

    if (!description) {
      setFreePositionError("Bitte Kurztext oder Leistungsbeschreibung eintragen.");
      return;
    }
    if (!unit) {
      setFreePositionError("Bitte Einheit eintragen.");
      return;
    }
    if (!areaOrComment) {
      setFreePositionError("Bitte Bereich / Ort angeben.");
      return;
    }
    if (quantity === null) {
      setFreePositionError("Bitte eine gültige Menge eintragen.");
      return;
    }

    setIsSaving(true);
    setFreePositionError(null);
    try {
      const createdItem = await api.createMobileMeasurementFreeItem(assignment.id, batch.id, {
        position: freePositionDraft.position.trim() || null,
        description,
        unit,
        quantity,
        area_or_comment: areaOrComment,
      });
      await loadBatches(batch.id);
      await loadBatchItems(batch, createdItem.id);
      setFormComment("");
      setFormQuantity("");
      setFreePositionDraft(EMPTY_MEASUREMENT_FREE_POSITION_DRAFT);
      setIsFreePositionFormOpen(false);
      setSearchTerm("");
    } catch (requestError) {
      setFreePositionError(readApiError(requestError, "Position konnte nicht erstellt werden."));
    } finally {
      setIsSaving(false);
    }
  }

  function startInlineMeasurementEdit(item: MobileMeasurementItem, area: string, mode: InlineMeasurementEditMode = "cell"): void {
    if (isInlineFreePositionDraftItem(item)) {
      setItems((currentItems) => (
        currentItems.some((currentItem) => currentItem.id === item.id) ? currentItems : [...currentItems, item]
      ));
    }
    const quantity = getMobileMeasurementAreaQuantity(item, area);
    setInlineCell({ itemId: item.id, area, mode });
    const hasExistingEntry = item.entries.some((entry) => getMeasurementAreaKey(entry.area_or_comment) === getMeasurementAreaKey(area));
    setInlineQuantity(mode === "add-row" ? "" : hasExistingEntry ? formatMeasurementNumber(quantity) : "");
    setInlineError(null);
  }

  function addInlineFreePositionColumn(): void {
    if (!selectedBatch) {
      return;
    }
    cancelInlineMeasurementEdit();
    setSearchTerm("");
    setItems((currentItems) => {
      if (currentItems.some(isEmptyInlineFreePositionDraftItem)) {
        return currentItems;
      }
      const draftId = inlineFreePositionDraftIdRef.current;
      inlineFreePositionDraftIdRef.current -= 1;
      return [
        ...currentItems,
        createInlineFreePositionDraftItem(selectedBatch, draftId, getNextInlineFreePositionDraftLabel(currentItems)),
      ];
    });
  }

  function updateInlineFreePositionDraft(itemId: number, patch: Partial<Pick<MobileMeasurementItem, "position" | "description" | "unit">>): void {
    setItems((currentItems) => currentItems.map((item) => {
      if (item.id !== itemId || !isInlineFreePositionDraftItem(item)) {
        return item;
      }
      return {
        ...item,
        ...patch,
        updated_at: new Date().toISOString(),
      };
    }).concat(
      selectedBatch && itemId < 0 && !currentItems.some((item) => item.id === itemId)
        ? [{
          ...createInlineFreePositionDraftItem(selectedBatch, itemId, getNextInlineFreePositionDraftLabel(currentItems)),
          ...patch,
          updated_at: new Date().toISOString(),
        }]
        : [],
    ));
  }

  function cancelInlineMeasurementEdit(): void {
    setInlineCell(null);
    setInlineQuantity("");
    setInlineError(null);
  }

  async function saveInlineMeasurementEdit(): Promise<boolean> {
    if (!selectedBatch || !inlineCell || isSaving) {
      return false;
    }
    const item = items.find((currentItem) => currentItem.id === inlineCell.itemId);
    if (!item) {
      setInlineError("Position wurde nicht gefunden.");
      return false;
    }

    const areaKey = getMeasurementAreaKey(inlineCell.area);
    const isAddRow = inlineCell.mode === "add-row";
    const existingEntries = isAddRow ? [] : item.entries.filter((entry) => getMeasurementAreaKey(entry.area_or_comment) === areaKey);
    const existingQuantity = isAddRow ? 0 : getMobileMeasurementAreaQuantity(item, inlineCell.area);
    const hasInlineQuantityInput = inlineQuantity.trim().length > 0;
    const quantity = parseOptionalMeasurementQuantity(inlineQuantity);
    const normalizedArea = normalizeMeasurementAreaInput(normalizeMeasurementArea(inlineCell.area));
    const isDraftFreePosition = isInlineFreePositionDraftItem(item);
    if (quantity === null) {
      setInlineError("Bitte eine gültige Menge eingeben.");
      return false;
    }
    if (isAddRow && !hasInlineQuantityInput) {
      cancelInlineMeasurementEdit();
      return true;
    }
    if (!normalizedArea) {
      setInlineError("Bitte Bereich oder Kommentar angeben.");
      return false;
    }
    if (!isAddRow && Math.abs(quantity - existingQuantity) < 0.0001) {
      cancelInlineMeasurementEdit();
      return true;
    }
    if (isDraftFreePosition && !item.description.trim()) {
      setInlineError("Bitte Leistung beschreiben.");
      return false;
    }
    if (isDraftFreePosition && !(item.unit ?? "").trim()) {
      setInlineError("Bitte Einheit angeben.");
      return false;
    }

    setIsSaving(true);
    setInlineError(null);
    try {
      if (isDraftFreePosition) {
        const createdItem = await api.createMobileMeasurementFreeItem(assignment.id, selectedBatch.id, {
          position: getMeasurementPositionSaveValue(item),
          description: item.description.trim(),
          unit: item.unit?.trim() || "st",
          quantity,
          area_or_comment: normalizedArea,
        });
        setInlineCell(null);
        setInlineQuantity("");
        setItems((currentItems) => currentItems.map((currentItem) => (currentItem.id === item.id ? createdItem : currentItem)));
        setSelectedItem((currentItem) => (currentItem?.id === item.id ? createdItem : currentItem));
        updateBatchPositionCount(selectedBatch.id, 1);
        return true;
      }
      if (existingEntries.length > 0) {
        await Promise.all(existingEntries.map((entry) => api.deleteMobileMeasurementEntry(assignment.id, selectedBatch.id, entry.id)));
      }
      let createdEntry: MeasurementEntry | null = null;
      if (hasInlineQuantityInput) {
        createdEntry = await api.createMobileMeasurementEntry(assignment.id, selectedBatch.id, item.id, {
          area_or_comment: normalizedArea,
          quantity,
        });
      }
      setInlineCell(null);
      setInlineQuantity("");
      const deletedEntryIds = new Set(existingEntries.map((entry) => entry.id));
      const updateItems = (currentItems: MobileMeasurementItem[]) => updateMobileMeasurementItemsAfterInlineSave(currentItems, item.id, deletedEntryIds, createdEntry);
      setItems(updateItems);
      setSelectedItem((currentItem) => (currentItem ? updateItems([currentItem])[0] ?? currentItem : currentItem));
      return true;
    } catch (requestError) {
      const message = readApiError(requestError, "Aufmaßzeile konnte nicht gespeichert werden.");
      try {
        await loadBatches(selectedBatch.id);
        await loadBatchItems(selectedBatch);
      } catch {
        // Keep the original save error visible; the next manual reload will reconcile the table.
      }
      setInlineError(message);
      setError(message);
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  const filteredItems = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    return items.filter((item) => {
      const matchesSearch = !needle
        || item.position.toLowerCase().includes(needle)
        || item.description.toLowerCase().includes(needle)
        || (item.unit ?? "").toLowerCase().includes(needle);
      return matchesSearch;
    });
  }, [items, searchTerm]);
  const freePositionAreaSuggestions = useMemo(() => collectMeasurementAreaTags(items), [items]);

  useEffect(() => {
    onEntryModeChange?.(Boolean(selectedBatch && selectedItem));
    return () => onEntryModeChange?.(false);
  }, [onEntryModeChange, selectedBatch, selectedItem]);

  if (selectedBatch && isFreePositionFormOpen && (!canUseInlineMeasurementTable || !isBatchPositionOverviewOpen)) {
    return (
      <MeasurementFreePositionForm
        draft={freePositionDraft}
        error={freePositionError}
        isSaving={isSaving}
        areaSuggestions={freePositionAreaSuggestions}
        onBack={() => {
          setIsFreePositionFormOpen(false);
          setFreePositionError(null);
          setFreePositionDraft(EMPTY_MEASUREMENT_FREE_POSITION_DRAFT);
        }}
        onCancel={() => {
          setIsFreePositionFormOpen(false);
          setFreePositionError(null);
          setFreePositionDraft(EMPTY_MEASUREMENT_FREE_POSITION_DRAFT);
        }}
        onChange={(patch) => {
          setFreePositionDraft((currentDraft) => ({ ...currentDraft, ...patch }));
          setFreePositionError(null);
        }}
        onSave={() => void handleCreateFreePosition(selectedBatch)}
      />
    );
  }

  if (selectedBatch && selectedItem) {
    return (
      <MeasurementDetail
        batch={selectedBatch}
        siteNumber={assignment.site.site_number}
        item={selectedItem}
        allItems={items}
        isSaving={isSaving}
        isLockedForWorker={selectedBatch.is_locked_for_worker}
        formComment={formComment}
        formQuantity={formQuantity}
        formError={formError}
        onBack={() => {
          setSelectedItem(null);
          setFormError(null);
        }}
        onCommentChange={setFormComment}
        onQuantityChange={setFormQuantity}
        onDeleteEntries={async (entries) => {
          if (!window.confirm("Aufmaß für diesen Ort löschen?")) {
            return;
          }
          setIsSaving(true);
          setFormError(null);
          try {
            await Promise.all(entries.map((entry) => api.deleteMobileMeasurementEntry(assignment.id, selectedBatch.id, entry.id)));
            await loadBatches(selectedBatch.id);
            await loadBatchItems(selectedBatch, selectedItem.id);
          } catch (requestError) {
            setFormError(readApiError(requestError, "Aufmaß konnte nicht gelöscht werden."));
          } finally {
            setIsSaving(false);
          }
        }}
        onSave={async () => {
          const quantity = parseOptionalMeasurementQuantity(formQuantity);
          const normalizedArea = normalizeMeasurementAreaInput(normalizeMeasurementArea(formComment));
          if (quantity === null || !formQuantity.trim()) {
            setFormError("Bitte eine gültige Menge eingeben.");
            return;
          }
          if (!normalizedArea) {
            setFormError("Bitte Bereich oder Kommentar angeben.");
            return;
          }
          setIsSaving(true);
          setFormError(null);
          try {
            await api.createMobileMeasurementEntry(assignment.id, selectedBatch.id, selectedItem.id, {
              area_or_comment: normalizedArea,
              quantity,
            });
            setFormComment("");
            setFormQuantity("");
            await loadBatches(selectedBatch.id);
            await loadBatchItems(selectedBatch, selectedItem.id);
          } catch (requestError) {
            setFormError(readApiError(requestError, "Aufmaßzeile konnte nicht gespeichert werden."));
          } finally {
            setIsSaving(false);
          }
        }}
      />
    );
  }

  if (selectedBatch && !isBatchPositionOverviewOpen) {
    const customerSignatureAction = getCustomerSignatureActionState(selectedBatch);
    const customerSignatureHint = getCompactCustomerSignatureHint(customerSignatureAction.hint);
    if (photoGalleryBatch) {
      return (
        <>
          <MeasurementPhotoGallery
            assignmentId={assignment.id}
            batch={photoGalleryBatch}
            siteNumber={assignment.site.site_number}
            isUploadingPhoto={isUploadingPhoto}
            refreshKey={photoGalleryVersion}
            onBack={() => setPhotoGalleryBatch(null)}
            onPhotoCountChange={(nextCount) => updateBatchPhotoCount(photoGalleryBatch.id, nextCount)}
            onTakePhoto={() => openPhotoCapture(photoGalleryBatch)}
            photoLimit={MOBILE_DOCUMENT_PHOTO_LIMIT}
          />
          <input
            ref={photoInputRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => void handlePhotoInputChange(event)}
          />
        </>
      );
    }
    return (
      <>
        <MeasurementBatchOverview
          assignmentId={assignment.id}
          batch={selectedBatch}
          siteNumber={assignment.site.site_number}
          error={error}
          isSaving={isSaving}
          isOpeningPdf={isOpeningPdf}
          isItemsLoading={isItemsLoading}
          isUploadingPhoto={isUploadingPhoto}
          photoLimit={MOBILE_DOCUMENT_PHOTO_LIMIT}
          photoMessage={photoMessage}
          photoMessageTone={photoMessageTone}
          customerSignatureDisabled={customerSignatureAction.disabled}
          customerSignatureHint={customerSignatureHint}
          onBack={closeBatchOverview}
          onOpenPdf={() => void openMeasurementBatchPdf(selectedBatch)}
          onTakePhoto={() => openPhotoCapture(selectedBatch)}
          onOpenPhotos={() => setPhotoGalleryBatch(selectedBatch)}
          onCustomerSignature={() => {
            if (customerSignatureAction.disabled) {
              setError(customerSignatureAction.hint);
              return;
            }
            setSignatureBatch(selectedBatch);
          }}
          onWorkerSignature={() => setWorkerSignatureBatch(selectedBatch)}
          onOpenPositions={() => setIsBatchPositionOverviewOpen(true)}
          onSubmit={async () => {
            setIsSaving(true);
            setError(null);
            try {
              const submitted = await api.submitMobileMeasurementBatch(assignment.id, selectedBatch.id);
              await loadBatches(submitted.id);
              setSelectedBatch(submitted);
            } catch (requestError) {
              setError(readApiError(requestError, "Aufmaß konnte nicht gesendet werden."));
            } finally {
              setIsSaving(false);
            }
          }}
        />
        {signatureBatch ? (
          <CustomerSignatureOverlay
            assignmentId={assignment.id}
            batch={signatureBatch}
            siteNumber={assignment.site.site_number}
            signaturePlace={formatMobileSignatureLocation(assignment.site)}
            onClose={() => setSignatureBatch(null)}
            onSigned={mergeUpdatedBatch}
          />
        ) : null}
        {workerSignatureBatch ? (
          <WorkerSignatureOverlay
            assignmentId={assignment.id}
            batch={workerSignatureBatch}
            siteNumber={assignment.site.site_number}
            workerName={assignment.person.display_name}
            onClose={() => setWorkerSignatureBatch(null)}
            onSigned={(updatedBatch) => {
              mergeUpdatedBatch(updatedBatch);
              setWorkerSignatureBatch(null);
            }}
          />
        ) : null}
        <input
          ref={photoInputRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => void handlePhotoInputChange(event)}
        />
      </>
    );
  }

  if (selectedBatch && isBatchPositionOverviewOpen) {
    return (
      <>
        <MeasurementBatchDetail
          batch={selectedBatch}
          items={filteredItems}
          allItems={items}
          isItemsLoading={isItemsLoading}
          error={error}
          searchTerm={searchTerm}
          onBack={() => {
            cancelInlineMeasurementEdit();
            setIsBatchPositionOverviewOpen(false);
            setIsFreePositionFormOpen(false);
            setSelectedItem(null);
            setError(null);
          }}
          onCreatePosition={() => {
            cancelInlineMeasurementEdit();
            setFreePositionDraft(EMPTY_MEASUREMENT_FREE_POSITION_DRAFT);
            setFreePositionError(null);
            setIsFreePositionFormOpen(true);
          }}
          viewMode={viewMode}
          onSearchChange={(value) => {
            cancelInlineMeasurementEdit();
            setSearchTerm(value);
          }}
          onSelectItem={(item) => {
            if (isInlineFreePositionDraftItem(item)) {
              return;
            }
            setSelectedItem(item);
            setFormComment("");
            setFormQuantity("");
            setFormError(null);
            cancelInlineMeasurementEdit();
          }}
          inlineCell={inlineCell}
          inlineQuantity={inlineQuantity}
          inlineError={inlineError}
          isInlineSaving={isSaving}
          isInlineEditingEnabled={canUseInlineMeasurementTable}
          onInlineEditStart={startInlineMeasurementEdit}
          onInlineQuantityChange={(value) => {
            setInlineQuantity(value);
            setInlineError(null);
          }}
          onInlineSave={saveInlineMeasurementEdit}
          onInlineCancel={cancelInlineMeasurementEdit}
          onInlineCreatePosition={addInlineFreePositionColumn}
          onInlineFreePositionDraftChange={updateInlineFreePositionDraft}
          onAreaRowCreate={createMeasurementAreaRow}
        />
        {isFreePositionFormOpen ? (
          <div
            aria-hidden={!isFreePositionDialogTopModal}
            className="mobile-measurement-dialog-backdrop mobile-modal-layer"
            data-mobile-modal-active={isFreePositionDialogTopModal}
            inert={!isFreePositionDialogTopModal}
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setIsFreePositionFormOpen(false);
                setFreePositionError(null);
                setFreePositionDraft(EMPTY_MEASUREMENT_FREE_POSITION_DRAFT);
              }
            }}
          >
            <div className="mobile-measurement-dialog mobile-modal-scroll-region" role="dialog" aria-modal="true" aria-labelledby="mobile-measurement-position-dialog-title">
              <MeasurementFreePositionForm
                draft={freePositionDraft}
                error={freePositionError}
                isSaving={isSaving}
                areaSuggestions={freePositionAreaSuggestions}
                variant="dialog"
                onBack={() => {
                  setIsFreePositionFormOpen(false);
                  setFreePositionError(null);
                  setFreePositionDraft(EMPTY_MEASUREMENT_FREE_POSITION_DRAFT);
                }}
                onCancel={() => {
                  setIsFreePositionFormOpen(false);
                  setFreePositionError(null);
                  setFreePositionDraft(EMPTY_MEASUREMENT_FREE_POSITION_DRAFT);
                }}
                onChange={(patch) => {
                  setFreePositionDraft((currentDraft) => ({ ...currentDraft, ...patch }));
                  setFreePositionError(null);
                }}
                onSave={() => void handleCreateFreePosition(selectedBatch)}
              />
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="mobile-measurement-page mobile-measurement-panel">
      <button className="icon-button secondary mobile-back-button" type="button" onClick={onBackToProject}>
        <ArrowLeft aria-hidden="true" size={17} />
        <span>Projektakte</span>
      </button>

      <div className="mobile-panel-title-row">
        <div className="mobile-measurement-page-title">
          <h1>Aufmaße</h1>
          <p>{[assignment.site.site_number, assignment.site.name].filter(Boolean).join(" · ")}</p>
        </div>
        <button
          className="primary-action mobile-measurement-new-action"
          type="button"
          onClick={async () => {
            setIsSaving(true);
            setError(null);
            try {
              const batch = await api.createMobileMeasurementBatch(assignment.id);
              await loadBatches(batch.id);
              setSelectedBatch(batch);
              setIsBatchPositionOverviewOpen(false);
              await loadBatchItems(batch);
            } catch (requestError) {
              setError(readApiError(requestError, "Aufmaß konnte nicht erstellt werden."));
            } finally {
              setIsSaving(false);
            }
          }}
          disabled={isSaving}
        >
          <Plus aria-hidden="true" size={15} />
          <span>{isSaving ? "Erstelle..." : "Neues Aufmaß"}</span>
        </button>
      </div>

      {isLoading ? <div className="empty-panel">Aufmaße werden geladen...</div> : null}
      {error ? <div className="form-error">{error}</div> : null}
      {!isLoading && !error && batches.length === 0 ? (
        <div className="empty-panel">Noch kein Aufmaß vorhanden.</div>
      ) : null}
      {!isLoading && batches.length > 0 ? (
        <div className="mobile-measurement-list">
          {batches.map((batch) => {
            const statusBadge = getMobileMeasurementBatchStatusBadge(batch);
            const displayDate = formatMobileMeasurementBatchDate(batch);
            return (
              <button
                className={batch.is_current_offer ? "mobile-measurement-card is-document-card is-measurement-batch-card" : "mobile-measurement-card is-document-card is-measurement-batch-card is-old-offer"}
                key={batch.id}
                type="button"
                onClick={() => {
                  setSelectedBatch(batch);
                  setIsBatchPositionOverviewOpen(false);
                  void loadBatchItems(batch);
                }}
              >
                <span className={`mobile-measurement-card-side-status measurement-status ${statusBadge.className}`}>{statusBadge.label}</span>
                <span className="mobile-measurement-card-head">
                  <strong className="mobile-measurement-card-title">{formatMobileMeasurementBatchTitle(batch, assignment.site.site_number)}</strong>
                  <span className="mobile-measurement-card-date">{displayDate}</span>
                </span>
                <MobileCustomerEmailStatus item={batch} />
                <span className="mobile-measurement-card-footer">
                  <span className="mobile-measurement-card-date">{batch.created_by_name ? `Ersteller: ${batch.created_by_name}` : "Ohne Ersteller"}</span>
                  <span className={`mobile-measurement-card-hours${Number(batch.reported_hours) < 0 ? " measurement-negative-quantity" : ""}`}>
                    Stunden: {formatMeasurementNumber(batch.reported_hours)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function MeasurementBatchOverview({
  assignmentId,
  batch,
  siteNumber,
  error,
  isSaving,
  isOpeningPdf,
  isItemsLoading,
  isUploadingPhoto,
  photoLimit,
  photoMessage,
  photoMessageTone,
  customerSignatureDisabled,
  customerSignatureHint,
  onBack,
  onOpenPdf,
  onTakePhoto,
  onOpenPhotos,
  onCustomerSignature,
  onWorkerSignature,
  onOpenPositions,
  onSubmit,
}: {
  assignmentId: number;
  batch: MobileMeasurementBatch;
  siteNumber: string | null;
  error: string | null;
  isSaving: boolean;
  isOpeningPdf: boolean;
  isItemsLoading: boolean;
  isUploadingPhoto: boolean;
  photoLimit: number;
  photoMessage: string | null;
  photoMessageTone: "info" | "error";
  customerSignatureDisabled: boolean;
  customerSignatureHint: string | null;
  onBack: () => void;
  onOpenPdf: () => void;
  onTakePhoto: () => void;
  onOpenPhotos: () => void;
  onCustomerSignature: () => void;
  onWorkerSignature: () => void;
  onOpenPositions: () => void;
  onSubmit: () => void;
}) {
  const isDraft = batch.status === "draft";
  const statusBadge = getMobileMeasurementBatchStatusBadge(batch);
  const displayDate = formatMobileMeasurementBatchDate(batch);
  const canSubmit = isDraft && !isSaving && batch.entry_count > 0 && !batch.is_locked_for_worker;
  const isPhotoLimitReached = (batch.photo_count ?? 0) >= photoLimit;
  const [isEditingEmailRecipients, setIsEditingEmailRecipients] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState<SiteEmailRecipient[]>([]);
  const [isLoadingEmailRecipients, setIsLoadingEmailRecipients] = useState(true);
  const [isConfirmingEmailSend, setIsConfirmingEmailSend] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailSendError, setEmailSendError] = useState<string | null>(null);
  const [emailSendMessage, setEmailSendMessage] = useState<string | null>(null);
  const hasCustomerSignature = Boolean(batch.customer_signed_at);
  const hasWorkerSignature = Boolean(batch.worker_signed_at);
  const emailPdfFilename = getMobileMeasurementPdfFilename(batch);
  const emailSendPrerequisitesMet = emailRecipients.length > 0;
  const shouldWarnMissingCustomerSignatureForEmail = emailRecipients.length > 0 && !hasCustomerSignature;
  const emailSendHint = getDocumentEmailSendHint({
    hasRecipients: emailRecipients.length > 0,
    hasCustomerSignature,
    hasWorkerSignature,
    isLoadingRecipients: isLoadingEmailRecipients,
    allowMissingCustomerSignature: true,
  });
  const emailSendStatusTitle = emailSendError ?? emailSendMessage ?? emailSendHint ?? undefined;
  const hasEmailSendInlineStatus = shouldWarnMissingCustomerSignatureForEmail || Boolean(emailSendError) || Boolean(emailSendMessage);

  useEffect(() => {
    let isActive = true;

    async function loadEmailRecipients(): Promise<void> {
      setIsLoadingEmailRecipients(true);
      setEmailSendError(null);
      try {
        const response = await api.assignmentEmailRecipients(assignmentId);
        if (isActive) {
          setEmailRecipients(response.recipients);
        }
      } catch (requestError) {
        if (isActive) {
          setEmailSendError(readApiError(requestError, "E-Mail-Empfänger konnten nicht geladen werden."));
          setEmailRecipients([]);
        }
      } finally {
        if (isActive) {
          setIsLoadingEmailRecipients(false);
        }
      }
    }

    void loadEmailRecipients();
    return () => {
      isActive = false;
    };
  }, [assignmentId, batch.id]);

  async function sendMeasurementEmail(): Promise<void> {
    if (!emailSendPrerequisitesMet || isSendingEmail) {
      return;
    }
    setIsSendingEmail(true);
    setEmailSendError(null);
    setEmailSendMessage(null);
    try {
      await api.sendMobileMeasurementBatchEmail(assignmentId, batch.id);
      setIsConfirmingEmailSend(false);
      setEmailSendMessage("E-Mail gesendet.");
    } catch (requestError) {
      setEmailSendError(readApiError(requestError, "E-Mail konnte nicht gesendet werden."));
    } finally {
      setIsSendingEmail(false);
    }
  }

  return (
    <div className="mobile-detail-panel mobile-measurement-panel mobile-measurement-overview-panel">
      <div className="mobile-measurement-detail-topbar">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Aufmaße</span>
        </button>
        <button
          className="primary-action mobile-measurement-submit-action"
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
        >
          <Send aria-hidden="true" size={15} />
          <span>{isSaving ? "Sende..." : "Zur Prüfung senden"}</span>
        </button>
      </div>

      <div className="mobile-measurement-summary-card">
        <span className="mobile-measurement-summary-status-row">
          <span className={`measurement-status ${statusBadge.className}`}>{statusBadge.label}</span>
          <MobileCustomerEmailStatus item={batch} />
        </span>
        <h2>{formatMobileMeasurementBatchTitle(batch, siteNumber)}</h2>
        <span className="mobile-measurement-card-date">Datum: {displayDate}</span>
        <span className="mobile-measurement-card-meta">
          <span>Positionen: {batch.position_count}</span>
          <span className={Number(batch.reported_hours) < 0 ? "measurement-negative-quantity" : undefined}>
            Stunden: {formatMeasurementNumber(batch.reported_hours)}
          </span>
        </span>
      </div>
      {batch.is_locked_for_worker ? (
        <p className="form-info">Dieses Aufmaß wurde vom Kunden unterschrieben und ist für Monteure gesperrt.</p>
      ) : null}
      {error ? <div className="form-error">{error}</div> : null}

      <div className="mobile-measurement-overview-actions">
          <button className="mobile-measurement-overview-action is-primary" type="button" onClick={onOpenPositions} disabled={isItemsLoading}>
            <ClipboardList aria-hidden="true" size={18} />
            <span>{isItemsLoading ? "Positionen laden..." : "Aufmaßpositionen erfassen"}</span>
          </button>
          <button className="mobile-measurement-overview-action" type="button" onClick={onOpenPdf} disabled={isOpeningPdf}>
            <FileText aria-hidden="true" size={18} />
            <span>{isOpeningPdf ? "PDF wird geöffnet..." : "Aufmaß anzeigen (PDF)"}</span>
          </button>

          <button
            className={`mobile-measurement-overview-action${hasCustomerSignature ? " is-complete" : ""}`}
            type="button"
            onClick={onCustomerSignature}
            disabled={hasCustomerSignature || customerSignatureDisabled}
          >
            <UserRound aria-hidden="true" size={18} />
            <span>{hasCustomerSignature ? "Kundenunterschrift vorhanden" : "Kundenunterschrift einfügen"}</span>
            {hasCustomerSignature ? <CheckCircle2 className="mobile-action-status-icon" aria-hidden="true" size={19} /> : null}
          </button>
          {!hasCustomerSignature && customerSignatureHint ? <p className="mobile-measurement-action-hint">{customerSignatureHint}</p> : null}
          <button
            className={`mobile-measurement-overview-action${hasWorkerSignature ? " is-complete" : ""}`}
            type="button"
            onClick={onWorkerSignature}
            disabled={hasWorkerSignature}
          >
            <UserRound aria-hidden="true" size={18} />
            <span>{hasWorkerSignature ? "Monteursunterschrift vorhanden" : "Monteursunterschrift einfügen"}</span>
            {hasWorkerSignature ? <CheckCircle2 className="mobile-action-status-icon" aria-hidden="true" size={19} /> : null}
          </button>

          <button
            className="mobile-measurement-overview-action"
            type="button"
            onClick={() => {
              setEmailSendError(null);
              setEmailSendMessage(null);
              setIsEditingEmailRecipients(true);
            }}
          >
            <Mail aria-hidden="true" size={18} />
            <span>Kunden-E-Mail</span>
          </button>
          <button
            className={`mobile-measurement-overview-action${hasEmailSendInlineStatus ? " has-inline-status" : ""}${shouldWarnMissingCustomerSignatureForEmail ? " is-email-warning" : ""}`}
            type="button"
            title={emailSendStatusTitle}
            onClick={() => {
              setEmailSendError(null);
              setEmailSendMessage(null);
              setIsConfirmingEmailSend(true);
            }}
            disabled={!emailSendPrerequisitesMet || isSendingEmail || isLoadingEmailRecipients}
          >
            <Mail aria-hidden="true" size={18} />
            <span>{isSendingEmail ? "Wird gesendet..." : "Per E-Mail senden"}</span>
            {shouldWarnMissingCustomerSignatureForEmail || emailSendError ? (
              <AlertTriangle className="mobile-action-warning-icon" aria-hidden="true" size={18} />
            ) : emailSendMessage ? (
              <CheckCircle2 className="mobile-action-status-icon" aria-hidden="true" size={18} />
            ) : null}
          </button>

          <MobileOverviewPhotoAction
            count={batch.photo_count}
            disabled={isUploadingPhoto || isPhotoLimitReached}
            onOpenPhotos={onOpenPhotos}
            onTakePhoto={onTakePhoto}
          />
      </div>
      {isPhotoLimitReached ? (
        <p className="mobile-measurement-action-hint">Maximal 5 Fotos pro Aufmaß erlaubt.</p>
      ) : null}
      {photoMessage ? <p className={photoMessageTone === "error" ? "form-error" : "form-info"}>{photoMessage}</p> : null}
      {isEditingEmailRecipients ? (
        <ProjectEmailRecipientsModal
          assignmentId={assignmentId}
          onClose={() => setIsEditingEmailRecipients(false)}
          onSaved={() => {
            setIsEditingEmailRecipients(false);
            void api.assignmentEmailRecipients(assignmentId).then((response) => {
              setEmailRecipients(response.recipients);
            }).catch(() => undefined);
          }}
        />
      ) : null}
      {isConfirmingEmailSend ? (
        <DocumentEmailSendDialog
          description="Das aktuelle Aufmaß wird als vollständige PDF an die ausgewählten Kundenempfänger gesendet."
          filename={emailPdfFilename}
          isSending={isSendingEmail}
          recipients={emailRecipients}
          error={emailSendError}
          warning={shouldWarnMissingCustomerSignatureForEmail ? "Für dieses Aufmaß liegt noch keine Kundenunterschrift vor. Das PDF wird mit leerem Unterschriftenfeld versendet. Die Unterschrift muss anschließend vom Kunden eingeholt werden." : null}
          title="Aufmaß senden?"
          onClose={() => setIsConfirmingEmailSend(false)}
          onConfirm={() => void sendMeasurementEmail()}
        />
      ) : null}
    </div>
  );
}

type MeasurementPhotoPreview = {
  photo: MobileMeasurementBatchPhoto;
  url: string | null;
  error: string | null;
};

function MeasurementPhotoGallery({
  assignmentId,
  batch,
  siteNumber,
  refreshKey,
  isUploadingPhoto,
  onBack,
  onPhotoCountChange,
  onTakePhoto,
  photoLimit,
}: {
  assignmentId: number;
  batch: MobileMeasurementBatch;
  siteNumber: string | null;
  refreshKey: number;
  isUploadingPhoto: boolean;
  onBack: () => void;
  onPhotoCountChange: (nextCount: number) => void;
  onTakePhoto: () => void;
  photoLimit: number;
}) {
  const [photos, setPhotos] = useState<MeasurementPhotoPreview[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState<MeasurementPhotoPreview | null>(null);
  const [isLoadingPhotos, setIsLoadingPhotos] = useState(true);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [deletingPhotoId, setDeletingPhotoId] = useState<number | null>(null);
  const isPhotoLimitReached = photos.length >= photoLimit;

  useEffect(() => {
    let isCurrent = true;
    const objectUrls: string[] = [];

    async function loadPhotos(): Promise<void> {
      setIsLoadingPhotos(true);
      setPhotoError(null);
      try {
        const response = await api.mobileMeasurementBatchPhotos(assignmentId, batch.id);
        const previews = await Promise.all(response.map(async (photo) => {
          try {
            const blob = await api.mobileMeasurementBatchPhotoContent(assignmentId, batch.id, photo.id);
            const url = window.URL.createObjectURL(blob);
            objectUrls.push(url);
            return { photo, url, error: null };
          } catch (requestError) {
            return {
              photo,
              url: null,
              error: readApiError(requestError, "Foto konnte nicht geladen werden."),
            };
          }
        }));
        if (isCurrent) {
          setPhotos(previews);
          onPhotoCountChange(previews.length);
        } else {
          objectUrls.forEach((url) => window.URL.revokeObjectURL(url));
        }
      } catch (requestError) {
        if (isCurrent) {
          setPhotoError(readApiError(requestError, "Fotos konnten nicht geladen werden."));
          setPhotos([]);
        }
      } finally {
        if (isCurrent) {
          setIsLoadingPhotos(false);
        }
      }
    }

    void loadPhotos();
    return () => {
      isCurrent = false;
      objectUrls.forEach((url) => window.URL.revokeObjectURL(url));
    };
  }, [assignmentId, batch.id, refreshKey]);

  async function handleDeletePhoto(preview: MeasurementPhotoPreview): Promise<void> {
    if (deletingPhotoId !== null || !window.confirm("Foto wirklich löschen?")) {
      return;
    }
    setDeletingPhotoId(preview.photo.id);
    setPhotoError(null);
    try {
      await api.deleteMobileMeasurementBatchPhoto(assignmentId, batch.id, preview.photo.id);
      if (preview.url) {
        window.URL.revokeObjectURL(preview.url);
      }
      const nextPhotos = photos.filter((item) => item.photo.id !== preview.photo.id);
      setPhotos(nextPhotos);
      onPhotoCountChange(nextPhotos.length);
      setSelectedPhoto((currentPhoto) => (
        currentPhoto?.photo.id === preview.photo.id ? null : currentPhoto
      ));
    } catch (requestError) {
      setPhotoError(readApiError(requestError, "Foto konnte nicht gelöscht werden."));
    } finally {
      setDeletingPhotoId(null);
    }
  }

  async function saveMeasurementPhotoCaption(caption: string | null): Promise<void> {
    if (!selectedPhoto) {
      return;
    }
    try {
      const updated = await api.updateMobileMeasurementBatchPhotoCaption(
        assignmentId,
        batch.id,
        selectedPhoto.photo.id,
        caption,
      );
      setPhotos((current) => current.map((preview) => (
        preview.photo.id === updated.id ? { ...preview, photo: updated } : preview
      )));
      setSelectedPhoto((current) => current ? { ...current, photo: updated } : null);
    } catch (requestError) {
      throw new Error(readApiError(requestError, "Beschriftung konnte nicht gespeichert werden."));
    }
  }

  return (
    <div className="mobile-detail-panel mobile-measurement-photo-gallery">
      <div className="mobile-measurement-detail-topbar">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Aufmaß</span>
        </button>
        <button className="primary-action mobile-measurement-photo-capture-action" type="button" onClick={onTakePhoto} disabled={isUploadingPhoto || isPhotoLimitReached}>
          <Camera aria-hidden="true" size={16} />
          <span>{isUploadingPhoto ? "Speichert..." : "Foto aufnehmen"}</span>
        </button>
      </div>

      <header className="mobile-measurement-photo-gallery-head">
        <h2>Hinterlegte Fotos</h2>
        <p>{formatMobileMeasurementBatchTitle(batch, siteNumber)}</p>
      </header>

      {photoError ? <div className="form-error">{photoError}</div> : null}
      {isPhotoLimitReached ? <p className="mobile-measurement-action-hint">Maximal 5 Fotos pro Aufmaß erlaubt.</p> : null}
      {isLoadingPhotos ? <div className="empty-panel">Fotos werden geladen...</div> : null}
      {!isLoadingPhotos && !photos.length ? (
        <div className="empty-panel mobile-measurement-photo-empty">
          <span>Noch keine Fotos hinterlegt.</span>
          <button className="secondary-action" type="button" onClick={onTakePhoto} disabled={isUploadingPhoto || isPhotoLimitReached}>
            Foto aufnehmen
          </button>
        </div>
      ) : null}
      {!isLoadingPhotos && photos.length ? (
        <div className="mobile-measurement-photo-grid">
          {photos.map((preview) => {
            const isDeleting = deletingPhotoId === preview.photo.id;
            return (
              <div className="mobile-measurement-photo-tile-wrap" key={preview.photo.id}>
                <button
                  className="mobile-measurement-photo-tile"
                  type="button"
                  onClick={() => preview.url ? setSelectedPhoto(preview) : undefined}
                  disabled={!preview.url || isDeleting}
                >
                  {preview.url ? <img alt={preview.photo.filename} src={preview.url} /> : <span>{preview.error ?? "Foto nicht verfügbar."}</span>}
                  <small>{isDeleting ? "Wird gelöscht..." : formatDateTimeLabel(preview.photo.created_at)}</small>
                </button>
                <button
                  aria-label="Foto löschen"
                  className="mobile-measurement-photo-delete"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDeletePhoto(preview);
                  }}
                  disabled={deletingPhotoId !== null}
                >
                  <X aria-hidden="true" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {selectedPhoto?.url ? (
        <MobilePhotoCaptionViewer
          alt={selectedPhoto.photo.filename}
          canEdit={!batch.is_locked_for_worker}
          caption={selectedPhoto.photo.caption}
          dateLabel={formatDateTimeLabel(selectedPhoto.photo.created_at)}
          filename={selectedPhoto.photo.filename}
          imageUrl={selectedPhoto.url}
          onClose={() => setSelectedPhoto(null)}
          onSave={saveMeasurementPhotoCaption}
        />
      ) : null}
    </div>
  );
}

type ExtraWorkPhotoPreview = {
  photo: MobileExtraWorkTicketPhoto;
  url: string | null;
  error: string | null;
};

function ExtraWorkPhotoGallery({
  assignmentId,
  order,
  refreshKey,
  isUploadingPhoto,
  onBack,
  onTakePhoto,
  onPhotoCountChanged,
  photoLimit,
}: {
  assignmentId: number;
  order: MobileExtraWorkTicket;
  refreshKey: number;
  isUploadingPhoto: boolean;
  onBack: () => void;
  onTakePhoto: () => void;
  onPhotoCountChanged: (count: number) => void;
  photoLimit: number;
}) {
  const [photos, setPhotos] = useState<ExtraWorkPhotoPreview[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState<ExtraWorkPhotoPreview | null>(null);
  const [isLoadingPhotos, setIsLoadingPhotos] = useState(true);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [deletingPhotoId, setDeletingPhotoId] = useState<number | null>(null);
  const isPhotoLimitReached = photos.length >= photoLimit;

  useEffect(() => {
    let isCurrent = true;
    const objectUrls: string[] = [];

    async function loadPhotos(): Promise<void> {
      setIsLoadingPhotos(true);
      setPhotoError(null);
      try {
        const response = await api.mobileExtraWorkTicketPhotos(assignmentId, order.id);
        const previews = await Promise.all(response.map(async (photo) => {
          try {
            const blob = await api.mobileExtraWorkTicketPhotoContent(assignmentId, order.id, photo.id);
            const url = window.URL.createObjectURL(blob);
            objectUrls.push(url);
            return { photo, url, error: null };
          } catch (requestError) {
            return {
              photo,
              url: null,
              error: readApiError(requestError, "Foto konnte nicht geladen werden."),
            };
          }
        }));
        if (isCurrent) {
          setPhotos(previews);
          onPhotoCountChanged(previews.length);
        } else {
          objectUrls.forEach((url) => window.URL.revokeObjectURL(url));
        }
      } catch (requestError) {
        if (isCurrent) {
          setPhotoError(readApiError(requestError, "Fotos konnten nicht geladen werden."));
          setPhotos([]);
        }
      } finally {
        if (isCurrent) {
          setIsLoadingPhotos(false);
        }
      }
    }

    void loadPhotos();
    return () => {
      isCurrent = false;
      objectUrls.forEach((url) => window.URL.revokeObjectURL(url));
    };
  }, [assignmentId, order.id, refreshKey]);

  async function handleDeletePhoto(preview: ExtraWorkPhotoPreview): Promise<void> {
    if (deletingPhotoId !== null || !window.confirm("Foto wirklich löschen?")) {
      return;
    }
    setDeletingPhotoId(preview.photo.id);
    setPhotoError(null);
    try {
      await api.deleteMobileExtraWorkTicketPhoto(assignmentId, order.id, preview.photo.id);
      if (preview.url) {
        window.URL.revokeObjectURL(preview.url);
      }
      const nextPhotos = photos.filter((item) => item.photo.id !== preview.photo.id);
      setPhotos(nextPhotos);
      onPhotoCountChanged(nextPhotos.length);
      setSelectedPhoto((currentPhoto) => (
        currentPhoto?.photo.id === preview.photo.id ? null : currentPhoto
      ));
    } catch (requestError) {
      setPhotoError(readApiError(requestError, "Foto konnte nicht gelöscht werden."));
    } finally {
      setDeletingPhotoId(null);
    }
  }

  async function saveExtraWorkPhotoCaption(caption: string | null): Promise<void> {
    if (!selectedPhoto) {
      return;
    }
    try {
      const updated = await api.updateMobileExtraWorkTicketPhotoCaption(
        assignmentId,
        order.id,
        selectedPhoto.photo.id,
        caption,
      );
      setPhotos((current) => current.map((preview) => (
        preview.photo.id === updated.id ? { ...preview, photo: updated } : preview
      )));
      setSelectedPhoto((current) => current ? { ...current, photo: updated } : null);
    } catch (requestError) {
      throw new Error(readApiError(requestError, "Beschriftung konnte nicht gespeichert werden."));
    }
  }

  return (
    <div className="mobile-detail-panel mobile-measurement-photo-gallery">
      <div className="mobile-measurement-detail-topbar">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Stundenzettel</span>
        </button>
        <button className="primary-action mobile-measurement-photo-capture-action" type="button" onClick={onTakePhoto} disabled={isUploadingPhoto || isPhotoLimitReached}>
          <Camera aria-hidden="true" size={16} />
          <span>{isUploadingPhoto ? "Speichert..." : "Foto aufnehmen"}</span>
        </button>
      </div>

      <header className="mobile-measurement-photo-gallery-head">
        <h2>Hinterlegte Fotos</h2>
        <p>{formatMobileExtraWorkOrderTitle(order)}</p>
      </header>

      {photoError ? <div className="form-error">{photoError}</div> : null}
      {isPhotoLimitReached ? <p className="mobile-measurement-action-hint">Maximal 5 Fotos pro Stundenzettel erlaubt.</p> : null}
      {isLoadingPhotos ? <div className="empty-panel">Fotos werden geladen...</div> : null}
      {!isLoadingPhotos && !photos.length ? (
        <div className="empty-panel mobile-measurement-photo-empty">
          <span>Noch keine Fotos hinterlegt.</span>
          <button className="secondary-action" type="button" onClick={onTakePhoto} disabled={isUploadingPhoto || isPhotoLimitReached}>
            Foto aufnehmen
          </button>
        </div>
      ) : null}
      {!isLoadingPhotos && photos.length ? (
        <div className="mobile-measurement-photo-grid">
          {photos.map((preview) => {
            const isDeleting = deletingPhotoId === preview.photo.id;
            return (
              <div className="mobile-measurement-photo-tile-wrap" key={preview.photo.id}>
                <button
                  className="mobile-measurement-photo-tile"
                  type="button"
                  onClick={() => preview.url ? setSelectedPhoto(preview) : undefined}
                  disabled={!preview.url || isDeleting}
                >
                  {preview.url ? <img alt={preview.photo.filename} src={preview.url} /> : <span>{preview.error ?? "Foto nicht verfügbar."}</span>}
                  <small>{isDeleting ? "Wird gelöscht..." : formatDateTimeLabel(preview.photo.created_at)}</small>
                </button>
                <button
                  aria-label="Foto löschen"
                  className="mobile-measurement-photo-delete"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDeletePhoto(preview);
                  }}
                  disabled={deletingPhotoId !== null}
                >
                  <X aria-hidden="true" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {selectedPhoto?.url ? (
        <MobilePhotoCaptionViewer
          alt={selectedPhoto.photo.filename}
          canEdit={canEditExtraWorkPhotoCaption(order)}
          caption={selectedPhoto.photo.caption}
          dateLabel={formatDateTimeLabel(selectedPhoto.photo.created_at)}
          filename={selectedPhoto.photo.filename}
          imageUrl={selectedPhoto.url}
          onClose={() => setSelectedPhoto(null)}
          onSave={saveExtraWorkPhotoCaption}
        />
      ) : null}
    </div>
  );
}

function MeasurementBatchDetail({
  batch,
  items,
  allItems,
  isItemsLoading,
  error,
  searchTerm,
  viewMode,
  onBack,
  onCreatePosition,
  onSearchChange,
  onSelectItem,
  inlineCell,
  inlineQuantity,
  inlineError,
  isInlineSaving,
  isInlineEditingEnabled,
  onInlineEditStart,
  onInlineQuantityChange,
  onInlineSave,
  onInlineCancel,
  onInlineCreatePosition,
  onInlineFreePositionDraftChange,
  onAreaRowCreate,
}: {
  batch: MobileMeasurementBatch;
  items: MobileMeasurementItem[];
  allItems: MobileMeasurementItem[];
  isItemsLoading: boolean;
  error: string | null;
  searchTerm: string;
  viewMode: MeasurementViewMode;
  onBack: () => void;
  onCreatePosition: () => void;
  onSearchChange: (value: string) => void;
  onSelectItem: (item: MobileMeasurementItem) => void;
  inlineCell: InlineMeasurementCell | null;
  inlineQuantity: string;
  inlineError: string | null;
  isInlineSaving: boolean;
  isInlineEditingEnabled: boolean;
  onInlineEditStart: (item: MobileMeasurementItem, area: string, mode?: InlineMeasurementEditMode) => void;
  onInlineQuantityChange: (value: string) => void;
  onInlineSave: () => Promise<boolean>;
  onInlineCancel: () => void;
  onInlineCreatePosition: () => void;
  onInlineFreePositionDraftChange: (itemId: number, patch: Partial<Pick<MobileMeasurementItem, "position" | "description" | "unit">>) => void;
  onAreaRowCreate: (areaOrComment: string) => Promise<void>;
}) {
  const positionGroups = useMemo(() => buildMeasurementPositionGroups(allItems), [allItems]);
  const [activePositionGroupKey, setActivePositionGroupKey] = useState<string | null>(null);
  const effectivePositionGroupKey = useMemo(
    () => getActiveMeasurementPositionGroupKey(positionGroups, activePositionGroupKey),
    [activePositionGroupKey, positionGroups],
  );
  const activePositionGroup = positionGroups.find((group) => group.key === effectivePositionGroupKey) ?? positionGroups[0] ?? null;
  const tableItems = useMemo(
    () => filterMeasurementItemsByPositionGroup(items, activePositionGroup),
    [activePositionGroup, items],
  );

  useEffect(() => {
    if (viewMode !== "table") {
      return;
    }
    const nextKey = getActiveMeasurementPositionGroupKey(positionGroups, activePositionGroupKey);
    if (nextKey !== activePositionGroupKey) {
      setActivePositionGroupKey(nextKey);
    }
  }, [activePositionGroupKey, positionGroups, viewMode]);

  const searchControl = (
    <div className="mobile-measurement-search">
      <Search aria-hidden="true" size={17} />
      <input
        type="text"
        placeholder="Position oder Leistung suchen..."
        value={searchTerm}
        onChange={(event) => onSearchChange(event.target.value)}
      />
    </div>
  );

  return (
    <div className={`mobile-detail-panel mobile-measurement-panel mobile-measurement-positions-page${viewMode === "table" ? " is-table-view" : ""}`}>
      <div className="mobile-measurement-detail-topbar">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Aufmaß</span>
        </button>
        {viewMode === "list" ? (
          <button className="mobile-measurement-create-position-button" type="button" onClick={onCreatePosition}>
            <Plus aria-hidden="true" size={15} />
            <span>Position erstellen</span>
          </button>
        ) : null}
        {viewMode === "table" ? searchControl : null}
      </div>
      {batch.is_locked_for_worker ? (
        <p className="form-info">Dieses Aufmaß wurde vom Kunden unterschrieben und ist für Monteure gesperrt.</p>
      ) : null}

      {viewMode === "list" ? (
        <div className="mobile-measurement-toolbar">
          {searchControl}
        </div>
      ) : null}

      {isItemsLoading ? <div className="empty-panel">Aufmaßpositionen werden geladen...</div> : null}
      {error ? <div className="form-error">{error}</div> : null}
      {!isItemsLoading && !error && allItems.length === 0 ? (
        <div className="empty-panel">Noch keine Aufmaßpositionen importiert.</div>
      ) : null}
      {!isItemsLoading && !error && allItems.length > 0 && items.length === 0 ? (
        <div className="empty-panel">Keine Aufmaßposition gefunden.</div>
      ) : null}
      {!isItemsLoading && !error && items.length > 0 && viewMode === "list" ? (
        <div className="mobile-measurement-list">
          {items.filter((item) => !isInlineFreePositionDraftItem(item)).map((item) => {
            const isCaptured = isMobileMeasurementItemCaptured(item);
            const positionLabel = getMeasurementPositionDisplayLabel(item);
            return (
              <button
                className={isCaptured ? "mobile-measurement-card is-captured-position" : "mobile-measurement-card is-empty-position"}
                key={item.id}
                type="button"
                onClick={() => onSelectItem(item)}
              >
                <div className="mobile-measurement-row-top">
                  <span className="mobile-measurement-row-position-wrap">
                    {positionLabel ? <strong className="mobile-measurement-row-position">{positionLabel}</strong> : null}
                    {item.is_free_position ? <span className="mobile-measurement-free-badge">Zusatzposition</span> : null}
                  </span>
                  <strong className={`mobile-measurement-row-quantity${Number(item.reported_quantity) < 0 ? " measurement-negative-quantity" : ""}`}>{formatMeasurementNumber(item.reported_quantity)} {item.unit ?? ""}</strong>
                </div>
                <span className="mobile-measurement-row-description">{item.description}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {!isItemsLoading && !error && items.length > 0 && viewMode === "table" ? (
        <>
          {positionGroups.length > 0 ? (
            <div className="mobile-measurement-position-groups" aria-label="Positionsbereich auswählen">
              {positionGroups.map((group) => (
                <div className="mobile-measurement-position-group" key={group.key}>
                  <button
                    className={[
                      group.key === effectivePositionGroupKey ? "is-active" : "",
                      `is-${group.kind}`,
                    ].filter(Boolean).join(" ")}
                    type="button"
                    onClick={() => setActivePositionGroupKey(group.key)}
                  >
                    <span className="mobile-measurement-position-group-label">{group.label}</span>
                    <span className="mobile-measurement-position-group-count">{group.count}</span>
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {tableItems.length > 0 ? (
            <MobileMeasurementTable
              batch={batch}
              items={tableItems}
              allItems={allItems}
              inlineCell={inlineCell}
              inlineQuantity={inlineQuantity}
              inlineError={inlineError}
              isInlineSaving={isInlineSaving}
              isInlineEditingEnabled={isInlineEditingEnabled && !batch.is_locked_for_worker}
              onInlineEditStart={onInlineEditStart}
              onInlineQuantityChange={onInlineQuantityChange}
              onInlineSave={onInlineSave}
              onInlineCancel={onInlineCancel}
              onInlineCreatePosition={onInlineCreatePosition}
              onInlineFreePositionDraftChange={onInlineFreePositionDraftChange}
              onAreaRowCreate={onAreaRowCreate}
              onSelectItem={onSelectItem}
            />
          ) : (
            <div className="empty-panel">Keine Position in diesem Bereich gefunden.</div>
          )}
        </>
      ) : null}
    </div>
  );
}

function MeasurementFreePositionForm({
  draft,
  error,
  isSaving,
  areaSuggestions,
  variant = "page",
  onBack,
  onCancel,
  onChange,
  onSave,
}: {
  draft: MeasurementFreePositionDraft;
  error: string | null;
  isSaving: boolean;
  areaSuggestions: string[];
  variant?: "page" | "dialog";
  onBack: () => void;
  onCancel: () => void;
  onChange: (patch: Partial<MeasurementFreePositionDraft>) => void;
  onSave: () => void;
}) {
  const quantityLabel = `Menge (${draft.unit || "Einheit"})`;

  return (
    <div className={`mobile-detail-panel mobile-measurement-panel mobile-measurement-free-position-page${variant === "dialog" ? " is-dialog" : ""}`}>
      <div className="mobile-measurement-detail-topbar">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Positionen</span>
        </button>
      </div>

      <header className="mobile-entry-head">
        <div>
          <span>Aufmaß</span>
          <h1 id={variant === "dialog" ? "mobile-measurement-position-dialog-title" : undefined}>Position erstellen</h1>
          <p>Freie Zusatzposition nur für dieses Aufmaß anlegen.</p>
        </div>
      </header>

      <div className="mobile-measurement-form mobile-measurement-free-position-form">
        <label>
          <span>Positionsnummer / Kennung</span>
          <input
            type="text"
            value={draft.position}
            onChange={(event) => onChange({ position: event.target.value })}
            placeholder="optional, z. B. N1.1"
          />
        </label>

        <label>
          <span>Kurztext / Leistungsbeschreibung</span>
          <textarea
            required
            value={draft.description}
            onChange={(event) => onChange({ description: event.target.value })}
            placeholder="Leistung beschreiben"
          />
        </label>

        <div className="mobile-measurement-form-grid">
          <label>
            <span>Einheit</span>
            <select value={draft.unit} onChange={(event) => onChange({ unit: event.target.value })}>
              {MOBILE_MEASUREMENT_FREE_UNITS.map((unit) => (
                <option key={unit} value={unit}>{unit}</option>
              ))}
            </select>
          </label>
        </div>

        <label>
          <span>Bereich / Ort</span>
          {areaSuggestions.length > 0 ? (
            <div className="mobile-area-tag-list" aria-label="Bereichsvorschläge">
              {areaSuggestions.map((area) => (
                <button
                  className={getMeasurementAreaKey(draft.areaOrComment) === getMeasurementAreaKey(area) ? "mobile-area-tag is-selected" : "mobile-area-tag"}
                  key={area}
                  type="button"
                  onClick={() => {
                    onChange({ areaOrComment: normalizeMeasurementAreaInput(area) });
                    blurActiveFormElement();
                  }}
                >
                  {area}
                </button>
              ))}
            </div>
          ) : null}
          <input
            type="text"
            required
            value={draft.areaOrComment}
            onChange={(event) => onChange({ areaOrComment: normalizeMeasurementAreaInput(event.target.value) })}
            placeholder="z. B. 2. OG"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

        <label>
          <span>{quantityLabel}</span>
          <input
            type="text"
            inputMode="none"
            readOnly
            value={draft.quantity || "0,00"}
            aria-label={quantityLabel}
            placeholder="0,00"
            className={Number(parseOptionalMeasurementQuantity(draft.quantity)) < 0 ? "measurement-negative-quantity" : undefined}
          />
          <MeasurementQuantityKeypad
            disabled={isSaving}
            onKeyPress={(key) => onChange({ quantity: applyMeasurementQuantityKey(draft.quantity, key) })}
          />
        </label>

        {error ? <p className="form-error">{error}</p> : null}

        <div className="mobile-form-actions mobile-measurement-free-position-actions">
          <button className="secondary-action" type="button" onClick={onCancel} disabled={isSaving}>Abbrechen</button>
          <button className="primary-action" type="button" onClick={onSave} disabled={isSaving}>
            {isSaving ? "Speichert..." : "Speichern"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MobileMeasurementTable({
  batch,
  items,
  allItems,
  inlineCell,
  inlineQuantity,
  inlineError,
  isInlineSaving,
  isInlineEditingEnabled,
  onInlineEditStart,
  onInlineQuantityChange,
  onInlineSave,
  onInlineCancel,
  onInlineCreatePosition,
  onInlineFreePositionDraftChange,
  onAreaRowCreate,
  onSelectItem,
}: {
  batch: MobileMeasurementBatch;
  items: MobileMeasurementItem[];
  allItems: MobileMeasurementItem[];
  inlineCell: InlineMeasurementCell | null;
  inlineQuantity: string;
  inlineError: string | null;
  isInlineSaving: boolean;
  isInlineEditingEnabled: boolean;
  onInlineEditStart: (item: MobileMeasurementItem, area: string, mode?: InlineMeasurementEditMode) => void;
  onInlineQuantityChange: (value: string) => void;
  onInlineSave: () => Promise<boolean>;
  onInlineCancel: () => void;
  onInlineCreatePosition: () => void;
  onInlineFreePositionDraftChange: (itemId: number, patch: Partial<Pick<MobileMeasurementItem, "position" | "description" | "unit">>) => void;
  onAreaRowCreate: (areaOrComment: string) => Promise<void>;
  onSelectItem: (item: MobileMeasurementItem) => void;
}) {
  const displayItems = useMemo(() => buildMeasurementTableDisplayItems(items, batch), [batch, items]);
  const measuredAreaRows = useMemo(() => (
    mergeMeasurementAreaRows(collectMeasurementBatchAreaRows(batch), collectMeasurementAreaTags(allItems, { sort: false }))
  ), [allItems, batch]);
  const [pendingAreaRows, setPendingAreaRows] = useState<string[]>([]);
  const areaRows = useMemo(() => mergeMeasurementAreaRows(measuredAreaRows, pendingAreaRows), [measuredAreaRows, pendingAreaRows]);
  const canAddFromTable = isInlineEditingEnabled && displayItems.length > 0;
  const emptyAreaRowAnchors = useMemo(() => {
    const missingRows = Math.max(0, MOBILE_MEASUREMENT_TABLE_DEFAULT_AREA_ROWS - areaRows.length);
    return Array.from({ length: missingRows }, (_, index) => `__empty_area_${index}__`);
  }, [areaRows.length]);
  const [draftAreaRow, setDraftAreaRow] = useState<{ anchor: string; value: string; area: string | null } | null>(null);
  const draftAreaInputRef = useRef<HTMLInputElement | null>(null);
  const editableCells = useMemo(() => {
    const cells: Array<{ item: MobileMeasurementItem; area: string; mode: InlineMeasurementEditMode }> = [];
    areaRows.forEach((area) => {
      displayItems.forEach((item) => cells.push({ item, area, mode: "cell" }));
    });
    if (canAddFromTable && draftAreaRow?.area) {
      displayItems.forEach((item) => cells.push({ item, area: draftAreaRow.area ?? "", mode: "add-row" }));
    }
    return cells;
  }, [areaRows, canAddFromTable, displayItems, draftAreaRow?.area]);

  useEffect(() => {
    if (!draftAreaRow || draftAreaRow.area) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      draftAreaInputRef.current?.focus();
      draftAreaInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draftAreaRow?.anchor, draftAreaRow?.area]);

  useEffect(() => {
    if (!draftAreaRow?.area) {
      return;
    }
    const draftAreaKey = getMeasurementAreaKey(draftAreaRow.area);
    if (areaRows.some((area) => getMeasurementAreaKey(area) === draftAreaKey)) {
      setDraftAreaRow(null);
    }
  }, [areaRows, draftAreaRow?.area]);

  function isInlineCellActive(item: MobileMeasurementItem, area: string, mode: InlineMeasurementEditMode): boolean {
    return Boolean(
      isInlineEditingEnabled
        && inlineCell?.itemId === item.id
        && inlineCell.mode === mode
        && getMeasurementAreaKey(inlineCell.area) === getMeasurementAreaKey(area),
    );
  }

  function findEditableCellIndex(item: MobileMeasurementItem, area: string, mode: InlineMeasurementEditMode): number {
    const areaKey = getMeasurementAreaKey(area);
    return editableCells.findIndex((cell) => (
      cell.item.id === item.id
        && cell.mode === mode
        && getMeasurementAreaKey(cell.area) === areaKey
    ));
  }

  async function activateInlineCell(item: MobileMeasurementItem, area: string, mode: InlineMeasurementEditMode = "cell"): Promise<void> {
    if (!isInlineEditingEnabled || isInlineSaving) {
      return;
    }
    if (isInlineCellActive(item, area, mode)) {
      return;
    }
    if (inlineCell) {
      const saved = await onInlineSave();
      if (!saved) {
        return;
      }
    }
    onInlineEditStart(item, area, mode);
  }

  async function moveInlineCell(item: MobileMeasurementItem, area: string, mode: InlineMeasurementEditMode, direction: 1 | -1): Promise<void> {
    const currentIndex = findEditableCellIndex(item, area, mode);
    if (currentIndex < 0 || editableCells.length === 0) {
      return;
    }
    const nextIndex = (currentIndex + direction + editableCells.length) % editableCells.length;
    const nextCell = editableCells[nextIndex];
    const saved = await onInlineSave();
    if (!saved) {
      return;
    }
    onInlineEditStart(nextCell.item, nextCell.area, nextCell.mode);
  }

  async function createPositionFromTable(): Promise<void> {
    if (inlineCell) {
      const saved = await onInlineSave();
      if (!saved) {
        return;
      }
    }
    onInlineCreatePosition();
  }

  async function startDraftAreaRow(anchor: string): Promise<void> {
    if (!canAddFromTable || isInlineSaving) {
      return;
    }
    if (inlineCell) {
      const saved = await onInlineSave();
      if (!saved) {
        return;
      }
    }
    setDraftAreaRow({ anchor, value: "", area: null });
  }

  function commitDraftAreaRow(): void {
    if (!draftAreaRow || !canAddFromTable) {
      return;
    }
    const normalizedArea = normalizeMeasurementAreaInput(normalizeMeasurementArea(draftAreaRow.value));
    if (!normalizedArea) {
      setDraftAreaRow(null);
      return;
    }
    setPendingAreaRows((currentRows) => (
      currentRows.some((area) => getMeasurementAreaKey(area) === getMeasurementAreaKey(normalizedArea))
        ? currentRows
        : [...currentRows, normalizedArea]
    ));
    setDraftAreaRow(null);
    if (!areaRows.some((area) => getMeasurementAreaKey(area) === getMeasurementAreaKey(normalizedArea))) {
      void onAreaRowCreate(normalizedArea);
    }
  }

  function handleQuantityKey(key: MeasurementQuantityKey): void {
    if (!inlineCell || isInlineSaving) {
      return;
    }
    onInlineQuantityChange(applyMeasurementQuantityKey(inlineQuantity, key));
  }

  function handleActiveCellKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    item: MobileMeasurementItem,
    area: string,
    mode: InlineMeasurementEditMode,
  ): void {
    if (event.key >= "0" && event.key <= "9") {
      event.preventDefault();
      handleQuantityKey(event.key as MeasurementQuantityKey);
      return;
    }
    if (event.key === "," || event.key === ".") {
      event.preventDefault();
      handleQuantityKey(event.key as MeasurementQuantityKey);
      return;
    }
    if (event.key === "-" || event.key === "Subtract") {
      event.preventDefault();
      handleQuantityKey("minus");
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      handleQuantityKey("backspace");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void onInlineSave();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      void moveInlineCell(item, area, mode, event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onInlineCancel();
    }
  }

  function renderActiveCell(item: MobileMeasurementItem, area: string, mode: InlineMeasurementEditMode): ReactElement {
    const displayValue = inlineQuantity || "0";
    return (
      <button
        autoFocus
        className={`measurement-matrix-active-cell${Number(parseOptionalMeasurementQuantity(displayValue)) < 0 ? " measurement-negative-quantity" : ""}`}
        type="button"
        aria-label={`Aktive Menge ${item.position} ${area}`}
        onKeyDown={(event) => handleActiveCellKeyDown(event, item, area, mode)}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof HTMLElement && (nextTarget.closest(".mobile-measurement-fixed-keypad") || nextTarget.closest(".mobile-measurement-table-wrap"))) {
            return;
          }
          void onInlineSave();
        }}
      >
        <span>{displayValue}</span>
        {inlineError ? <span className="mobile-measurement-inline-error">{inlineError}</span> : null}
      </button>
    );
  }

  function findActiveEditableCell(): { item: MobileMeasurementItem; area: string; mode: InlineMeasurementEditMode } | null {
    if (!inlineCell) {
      return null;
    }
    return editableCells.find((cell) => (
      cell.item.id === inlineCell.itemId
        && cell.mode === inlineCell.mode
        && getMeasurementAreaKey(cell.area) === getMeasurementAreaKey(inlineCell.area)
    )) ?? null;
  }

  function handleNumpadNext(): void {
    const activeCell = findActiveEditableCell();
    if (!activeCell) {
      return;
    }
    void moveInlineCell(activeCell.item, activeCell.area, activeCell.mode, 1);
  }

  function renderAddAreaButton(anchor: string, isEmptyTable = false): ReactElement {
    return (
      <button
        className="measurement-matrix-add-row-button"
        type="button"
        onClick={() => void startDraftAreaRow(anchor)}
        aria-label={isEmptyTable ? "Erste Eingabezeile anlegen" : "Neue Eingabezeile anlegen"}
        title={isEmptyTable ? "Erste Eingabezeile anlegen" : "Neue Eingabezeile anlegen"}
      >
        <Plus aria-hidden="true" size={15} />
      </button>
    );
  }

  function renderAreaDraftInput(): ReactElement {
    return (
      <input
        ref={draftAreaInputRef}
        className="measurement-matrix-area-draft-input"
        type="text"
        value={draftAreaRow?.value ?? ""}
        placeholder="Bauteil / Ort"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          const nextValue = normalizeMeasurementAreaInput(event.target.value);
          setDraftAreaRow((currentRow) => (currentRow ? { ...currentRow, value: nextValue } : currentRow));
        }}
        onBlur={commitDraftAreaRow}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitDraftAreaRow();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraftAreaRow(null);
          }
        }}
      />
    );
  }

  function renderDraftAreaAddRow(anchor: string): ReactElement | null {
    const isDraftActive = draftAreaRow?.anchor === anchor;
    const committedArea = isDraftActive ? draftAreaRow.area : null;

    return (
      <tr className={isDraftActive ? "measurement-matrix-add-row is-area-editing" : "measurement-matrix-add-row"}>
        <th className="measurement-matrix-axis measurement-matrix-add-row-axis">
          {!isDraftActive ? (
            renderAddAreaButton(anchor, areaRows.length === 0)
          ) : committedArea ? (
            <span className="measurement-matrix-area-draft-label">{committedArea}</span>
          ) : (
            renderAreaDraftInput()
          )}
        </th>
        {displayItems.map((item) => {
          const isActive = Boolean(committedArea && isInlineCellActive(item, committedArea, "add-row"));
          return (
            <td className={getMeasurementMatrixCellClassName(item, isActive ? "measurement-matrix-empty-cell is-tablet-editable is-inline-editing" : "measurement-matrix-empty-cell is-tablet-editable")} key={item.id}>
              {isActive && committedArea ? renderActiveCell(item, committedArea, "add-row") : null}
            </td>
          );
        })}
        {canAddFromTable ? <td className="measurement-matrix-add-column-cell" /> : null}
      </tr>
    );
  }

  function renderEmptyAreaSpacerRow(anchor: string): ReactElement {
    const isDraftActive = draftAreaRow?.anchor === anchor;
    return (
      <tr className={isDraftActive ? "measurement-matrix-empty-area-row is-area-editing" : "measurement-matrix-empty-area-row"}>
        <th className="measurement-matrix-axis">
          {isDraftActive ? renderAreaDraftInput() : canAddFromTable ? (
            <button
              className="measurement-matrix-empty-area-button"
              type="button"
              onClick={() => void startDraftAreaRow(anchor)}
              aria-label="Bauteil / Ort eintragen"
              title="Bauteil / Ort eintragen"
            />
          ) : null}
        </th>
        {displayItems.map((item) => (
          <td className={getMeasurementMatrixCellClassName(item, "measurement-matrix-empty-cell")} key={`${anchor}:${item.id}`} />
        ))}
        {canAddFromTable ? <td className="measurement-matrix-add-column-cell" /> : null}
      </tr>
    );
  }

  return (
    <>
      <div className="mobile-measurement-table-shell">
        <div className="mobile-measurement-table-wrap" role="region" aria-label="Tabellarische Aufmaßaufstellung">
          <table className={`measurement-table-view measurement-matrix-table mobile-measurement-table${isInlineEditingEnabled ? " is-inline-editing-enabled" : ""}`}>
          <thead>
            <tr>
              <th className="measurement-matrix-axis">Pos.-Nr.</th>
              {displayItems.map((item) => (
                <th className={getMeasurementMatrixCellClassName(item, "measurement-matrix-position-heading")} key={item.id}>
                  {isInlineFreePositionDraftItem(item) ? (
                    <input
                      className="measurement-matrix-draft-field"
                      type="text"
                      value={getMeasurementPositionDisplayLabel(item)}
                      aria-label="Positionsnummer der freien Position"
                      onChange={(event) => onInlineFreePositionDraftChange(item.id, { position: event.target.value })}
                    />
                  ) : (
                    <button className="measurement-matrix-header-button" type="button" onClick={() => onSelectItem(item)}>
                      <span className="measurement-matrix-position-text">{getMeasurementPositionDisplayLabel(item)}</span>
                      {item.is_free_position ? <span className="mobile-measurement-free-badge">frei</span> : null}
                    </button>
                  )}
                </th>
              ))}
              {canAddFromTable ? (
                <th className="measurement-matrix-add-column-heading">
                  <button className="measurement-matrix-add-column-button" type="button" onClick={() => void createPositionFromTable()} aria-label="Position erstellen" title="Position erstellen">
                    <Plus aria-hidden="true" size={16} />
                  </button>
                </th>
              ) : null}
            </tr>
            <tr>
              <th className="measurement-matrix-axis">Beschreibung</th>
              {displayItems.map((item) => (
                <th className={getMeasurementMatrixCellClassName(item, "measurement-matrix-description-heading")} key={item.id}>
                  {isInlineFreePositionDraftItem(item) ? (
                    <textarea
                      autoFocus={items.some((currentItem) => currentItem.id === item.id) && !item.description.trim()}
                      className="measurement-matrix-draft-field measurement-matrix-draft-field-description"
                      value={item.description}
                      placeholder="Leistung"
                      aria-label="Leistungsbeschreibung der freien Position"
                      onChange={(event) => onInlineFreePositionDraftChange(item.id, { description: event.target.value })}
                      rows={3}
                    />
                  ) : (
                    <span className="measurement-matrix-description-text">{item.description}</span>
                  )}
                </th>
              ))}
              {canAddFromTable ? <th className="measurement-matrix-add-column-heading is-spacer" aria-hidden="true" /> : null}
            </tr>
            <tr>
              <th className="measurement-matrix-axis">Einheit</th>
              {displayItems.map((item) => (
                <th className={getMeasurementMatrixCellClassName(item)} key={item.id}>
                  {isInlineFreePositionDraftItem(item) ? (
                    <select
                      className="measurement-matrix-draft-field"
                      value={item.unit ?? "st"}
                      aria-label="Einheit der freien Position"
                      onChange={(event) => onInlineFreePositionDraftChange(item.id, { unit: event.target.value })}
                    >
                      {MOBILE_MEASUREMENT_FREE_UNITS.map((unit) => (
                        <option key={unit} value={unit}>{unit}</option>
                      ))}
                    </select>
                  ) : item.unit ?? "-"}
                </th>
              ))}
              {canAddFromTable ? <th className="measurement-matrix-add-column-heading is-spacer" aria-hidden="true" /> : null}
            </tr>
          </thead>
          <tbody>
            <tr className="measurement-matrix-section-row">
              <th className="measurement-matrix-axis">Bauteil / Ort</th>
              {displayItems.map((item) => <td className={getMeasurementMatrixCellClassName(item)} key={item.id} />)}
              {canAddFromTable ? <td className="measurement-matrix-add-column-cell" /> : null}
            </tr>
            {areaRows.map((area) => (
              <Fragment key={area}>
                <tr>
                  <th className="measurement-matrix-axis">{area}</th>
                  {displayItems.map((item) => {
                    const quantity = getMobileMeasurementAreaQuantity(item, area);
                    const isActive = isInlineCellActive(item, area, "cell");
                    const hasEntries = item.entries.some((entry) => getMeasurementAreaKey(entry.area_or_comment) === getMeasurementAreaKey(area));
                    const cellClassName = [
                      hasEntries ? "measurement-matrix-quantity-cell" : "measurement-matrix-empty-cell",
                      quantity < 0 ? "measurement-negative-quantity" : "",
                      isInlineEditingEnabled ? "is-tablet-editable" : "",
                      isActive ? "is-inline-editing" : "",
                    ].filter(Boolean).join(" ");
                    return (
                      <td className={getMeasurementMatrixCellClassName(item, cellClassName)} key={item.id}>
                        {isActive ? renderActiveCell(item, area, "cell") : (
                          <button
                            className="measurement-matrix-cell-button"
                            type="button"
                            onClick={() => {
                              if (isInlineEditingEnabled) {
                                void activateInlineCell(item, area);
                                return;
                              }
                              onSelectItem(item);
                            }}
                          >
                            {hasEntries ? formatMeasurementNumber(quantity) : ""}
                          </button>
                        )}
                      </td>
                    );
                  })}
                  {canAddFromTable ? <td className="measurement-matrix-add-column-cell" /> : null}
                </tr>
              </Fragment>
            ))}
            {emptyAreaRowAnchors.map((anchor) => (
              <Fragment key={anchor}>{renderEmptyAreaSpacerRow(anchor)}</Fragment>
            ))}
            {canAddFromTable ? (
              <Fragment key={MOBILE_MEASUREMENT_TABLE_TRAILING_ADD_ROW_ANCHOR}>
                {renderDraftAreaAddRow(MOBILE_MEASUREMENT_TABLE_TRAILING_ADD_ROW_ANCHOR)}
              </Fragment>
            ) : null}
            <tr className="measurement-matrix-total-row">
              <th className="measurement-matrix-axis">Gesamt</th>
              {displayItems.map((item) => (
                <td className={getMeasurementMatrixCellClassName(item, `measurement-matrix-quantity-cell${Number(item.reported_quantity) < 0 ? " measurement-negative-quantity" : ""}`)} key={item.id}>
                  <button className="measurement-matrix-cell-button" type="button" onClick={() => onSelectItem(item)}>
                    <strong>{formatMeasurementNumber(item.reported_quantity)}</strong>
                  </button>
                </td>
              ))}
              {canAddFromTable ? <td className="measurement-matrix-add-column-cell" /> : null}
            </tr>
          </tbody>
          </table>
        </div>
      </div>
      {isInlineEditingEnabled && inlineCell ? (
        <MeasurementTableFixedKeypad
          disabled={isInlineSaving}
          onKeyPress={handleQuantityKey}
          onEnter={() => void onInlineSave()}
          onNext={handleNumpadNext}
        />
      ) : null}
    </>
  );
}

function MeasurementTableFixedKeypad({
  disabled,
  onKeyPress,
  onEnter,
  onNext,
}: {
  disabled: boolean;
  onKeyPress: (key: MeasurementQuantityKey) => void;
  onEnter: () => void;
  onNext: () => void;
}) {
  const keys: Array<{ key: MeasurementQuantityKey; label: string; className?: string; ariaLabel?: string }> = [
    { key: "7", label: "7" },
    { key: "8", label: "8" },
    { key: "9", label: "9" },
    { key: "4", label: "4" },
    { key: "5", label: "5" },
    { key: "6", label: "6" },
    { key: "1", label: "1" },
    { key: "2", label: "2" },
    { key: "3", label: "3" },
    { key: ",", label: "," },
    { key: "0", label: "0" },
    { key: ".", label: "." },
    { key: "minus", label: "−", ariaLabel: "Vorzeichen wechseln" },
    { key: "backspace", label: "Zurück", className: "is-muted", ariaLabel: "Letzte Ziffer entfernen" },
    { key: "clear", label: "Leeren", className: "is-muted", ariaLabel: "Menge leeren" },
  ];

  return (
    <div className="mobile-measurement-fixed-keypad" aria-label="Tabellenmenge eingeben">
      <div className="mobile-measurement-fixed-keypad-grid">
        {keys.map((keyConfig) => (
          <button
            aria-label={keyConfig.ariaLabel}
            className={keyConfig.className ? `mobile-measurement-fixed-key ${keyConfig.className}` : "mobile-measurement-fixed-key"}
            disabled={disabled}
            key={keyConfig.key}
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onKeyPress(keyConfig.key)}
          >
            {keyConfig.label}
          </button>
        ))}
        <button
          className="mobile-measurement-fixed-key is-commit"
          disabled={disabled}
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onEnter}
        >
          Enter
        </button>
        <button
          className="mobile-measurement-fixed-key is-commit"
          disabled={disabled}
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onNext}
        >
          Weiter
        </button>
      </div>
    </div>
  );
}

function MeasurementDetail({
  batch,
  siteNumber,
  item,
  allItems,
  isSaving,
  isLockedForWorker,
  formComment,
  formQuantity,
  formError,
  onBack,
  onCommentChange,
  onDeleteEntries,
  onQuantityChange,
  onSave,
}: {
  batch: MobileMeasurementBatch;
  siteNumber: string | null;
  item: MobileMeasurementItem;
  allItems: MobileMeasurementItem[];
  isSaving: boolean;
  isLockedForWorker: boolean;
  formComment: string;
  formQuantity: string;
  formError: string | null;
  onBack: () => void;
  onCommentChange: (value: string) => void;
  onDeleteEntries: (entries: MeasurementEntry[]) => Promise<void>;
  onQuantityChange: (value: string) => void;
  onSave: () => void;
}) {
  const isDraft = batch.status === "draft";
  const isEditable = isDraft && !isLockedForWorker;
  const areaInputRef = useRef<HTMLInputElement>(null);
  const areaSuggestions = useMemo(() => collectMeasurementAreaTags(allItems), [allItems]);
  const measuredAreas = useMemo(() => groupMeasurementEntriesByArea(item.entries), [item.entries]);
  const measuredQuantity = useMemo(() => sumMeasurementEntryQuantities(item.entries), [item.entries]);
  const positionLabel = getMeasurementPositionDisplayLabel(item);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [batch.id, item.id]);

  return (
    <div className="mobile-measurement-entry-page">
      <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={17} />
        <span>Positionen</span>
      </button>

      <header className="mobile-entry-head">
        <div>
          <span className={`measurement-status mobile-status-${item.mobile_status}`}>{mobileStatusLabel(item.mobile_status)}</span>
          <h1>{positionLabel ? `Pos. ${positionLabel}` : "Freie Position"}</h1>
          <p>{item.description}</p>
        </div>
      </header>

      {isLockedForWorker ? (
        <p className="form-info">Dieses Aufmaß wurde vom Kunden unterschrieben und ist für Monteure gesperrt.</p>
      ) : null}

      {isEditable ? (
        <div className="mobile-measurement-form mobile-measurement-entry-form">
          <div className="mobile-measurement-form-grid">
            <label>
              <span>Bereich / Ort</span>
              {areaSuggestions.length > 0 ? (
                <div className="mobile-area-tag-list" aria-label="Bereichsvorschläge">
                  {areaSuggestions.map((area) => (
                    <button
                      className={getMeasurementAreaKey(formComment) === getMeasurementAreaKey(area) ? "mobile-area-tag is-selected" : "mobile-area-tag"}
                      key={area}
                      type="button"
                      onClick={() => {
                        onCommentChange(normalizeMeasurementAreaInput(area));
                        blurActiveFormElement();
                      }}
                    >
                      {area}
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                ref={areaInputRef}
                value={formComment}
                onChange={(event) => onCommentChange(normalizeMeasurementAreaInput(event.target.value))}
                placeholder="z. B. 1. OG"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span>Menge ({item.unit ?? "Einheit"})</span>
              <input
                type="text"
                inputMode="none"
                readOnly
                value={formQuantity}
                aria-label={`Menge in ${item.unit ?? "Einheit"}`}
                className={Number(parseOptionalMeasurementQuantity(formQuantity)) < 0 ? "measurement-negative-quantity" : undefined}
              />
              <MeasurementQuantityKeypad
                disabled={isSaving}
                onKeyPress={(key) => onQuantityChange(applyMeasurementQuantityKey(formQuantity, key))}
              />
            </label>
          </div>

          {formError ? <p className="form-error">{formError}</p> : null}
          <div className="mobile-form-actions">
            <button className="primary-action" type="button" onClick={onSave} disabled={isSaving}>{isSaving ? "Speichern..." : "Speichern"}</button>
          </div>
        </div>
      ) : !isLockedForWorker ? (
        <p className="form-info">Dieses Aufmaß ist nicht mehr im Entwurf. Neue Aufmaßzeilen sind gesperrt.</p>
      ) : null}

      <div className="mobile-measurement-entries">
        <div className="mobile-panel-title-row">
          <h3>Bisher erfasst</h3>
        </div>

        {measuredAreas.length === 0 ? <p className="empty-inline">Noch keine Aufmaßzeilen erfasst.</p> : null}
        {measuredAreas.map((area) => (
          <article className="mobile-measurement-entry" key={area.key}>
            <strong>{area.label}</strong>
            <span className={area.quantity < 0 ? "measurement-negative-quantity" : undefined}>{formatMeasurementNumber(area.quantity)} {item.unit ?? ""}</span>
            {isEditable ? (
              <button
                aria-label={`Aufmaß für ${area.label} löschen`}
                className="mobile-measurement-entry-delete"
                disabled={isSaving}
                type="button"
                onClick={() => void onDeleteEntries(area.entries)}
              >
                ×
              </button>
            ) : null}
          </article>
        ))}
      </div>

      <details className="mobile-measurement-secondary-details">
        <summary>Details anzeigen</summary>
        <div className="mobile-measurement-detail-grid">
          <span>Aufmaßnummer <strong>{formatMobileMeasurementBatchTitle(batch, siteNumber)}</strong></span>
          <span>Min/Einh. <strong>{formatMeasurementNumber(item.minutes_per_unit)}</strong></span>
          <span>Menge laut Angebot <strong>{formatMeasurementNumber(item.list_quantity)}</strong></span>
          <span>
            Menge nach Aufmaß <strong className={measuredQuantity < 0 ? "measurement-negative-quantity" : undefined}>{formatMeasurementNumber(measuredQuantity)}</strong>
          </span>
        </div>
        <div className="mobile-measurement-detail-areas">
          <strong>Verbaute Orte:</strong>
          {measuredAreas.length > 0 ? measuredAreas.map((area) => (
            <span key={area.key}>
              <span>{area.label}:</span>
              <strong className={area.quantity < 0 ? "measurement-negative-quantity" : undefined}>{formatMeasurementNumber(area.quantity)} {item.unit ?? ""}</strong>
            </span>
          )) : <span>Noch keine Orte erfasst.</span>}
        </div>
      </details>
    </div>
  );
}

type MeasurementQuantityKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "," | "." | "minus" | "backspace" | "clear";

function MeasurementQuantityKeypad({
  disabled,
  onKeyPress,
}: {
  disabled: boolean;
  onKeyPress: (key: MeasurementQuantityKey) => void;
}) {
  const keys: Array<{ key: MeasurementQuantityKey; label: string; className?: string; ariaLabel?: string }> = [
    { key: "1", label: "1" },
    { key: "2", label: "2" },
    { key: "3", label: "3" },
    { key: "4", label: "4" },
    { key: "5", label: "5" },
    { key: "6", label: "6" },
    { key: "7", label: "7" },
    { key: "8", label: "8" },
    { key: "9", label: "9" },
    { key: "0", label: "0" },
    { key: ",", label: "," },
    { key: ".", label: "." },
    { key: "minus", label: "−", ariaLabel: "Vorzeichen wechseln" },
    { key: "backspace", label: "Zurück", className: "is-muted", ariaLabel: "Letzte Ziffer entfernen" },
    { key: "clear", label: "Leeren", className: "is-muted", ariaLabel: "Menge leeren" },
  ];

  return (
    <div className="mobile-quantity-keypad" aria-label="Menge eingeben">
      {keys.map((keyConfig) => (
        <button
          aria-label={keyConfig.ariaLabel}
          className={keyConfig.className ? `mobile-quantity-key ${keyConfig.className}` : "mobile-quantity-key"}
          disabled={disabled}
          key={keyConfig.key}
          type="button"
          onClick={() => onKeyPress(keyConfig.key)}
        >
          {keyConfig.label}
        </button>
      ))}
    </div>
  );
}

function PdfCanvasPreview({ data }: { data: ArrayBuffer }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const baseContentSizeRef = useRef<PdfContentSize>({ width: 0, height: 0 });
  const lastObservedWidthRef = useRef<number | null>(null);
  const pinchStateRef = useRef<PdfPinchState | null>(null);
  const zoomScaleRef = useRef(1);
  const activeScaleRef = useRef(1);
  const pendingScaleRef = useRef<{ scale: number; focal: PdfFocalPoint | null } | null>(null);
  const scaleFrameRef = useRef<number | null>(null);
  const [renderVersion, setRenderVersion] = useState(0);
  const [isRendering, setIsRendering] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const viewportElement = viewportRef.current;
    if (!viewportElement || typeof ResizeObserver === "undefined") {
      return;
    }

    let resizeTimer: number | null = null;
    lastObservedWidthRef.current = Math.round(viewportElement.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const nextWidth = Math.round(entries[0]?.contentRect.width ?? 0);
      const previousWidth = lastObservedWidthRef.current;
      if (nextWidth <= 0 || previousWidth === null || Math.abs(nextWidth - previousWidth) < 8) {
        return;
      }
      lastObservedWidthRef.current = nextWidth;
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(() => {
        setRenderVersion((currentVersion) => currentVersion + 1);
      }, 160);
    });

    observer.observe(viewportElement);
    return () => {
      observer.disconnect();
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (scaleFrameRef.current !== null) {
        window.cancelAnimationFrame(scaleFrameRef.current);
      }
    };
  }, []);

  function applyPdfScale(nextScale: number, focal: PdfFocalPoint | null = null): void {
    const viewportElement = viewportRef.current;
    const surfaceElement = surfaceRef.current;
    const pagesElement = pagesRef.current;
    const baseSize = baseContentSizeRef.current;
    if (!viewportElement || !surfaceElement || !pagesElement || baseSize.width <= 0 || baseSize.height <= 0) {
      return;
    }

    const clampedScale = clampNumber(nextScale, PDF_MIN_ZOOM, PDF_MAX_ZOOM);
    const previousScale = activeScaleRef.current || 1;
    const viewportRect = viewportElement.getBoundingClientRect();
    const focalX = focal ? clampNumber(focal.clientX - viewportRect.left, 0, viewportRect.width) : viewportRect.width / 2;
    const focalY = focal ? clampNumber(focal.clientY - viewportRect.top, 0, viewportRect.height) : viewportRect.height / 2;
    const focalContentX = (viewportElement.scrollLeft + focalX) / previousScale;
    const focalContentY = (viewportElement.scrollTop + focalY) / previousScale;
    const scaledWidth = Math.max(Math.ceil(baseSize.width * clampedScale), Math.ceil(viewportElement.clientWidth));
    const scaledHeight = Math.max(Math.ceil(baseSize.height * clampedScale), Math.ceil(viewportElement.clientHeight));

    activeScaleRef.current = clampedScale;
    pagesElement.style.transform = `scale(${clampedScale})`;
    surfaceElement.style.width = `${scaledWidth}px`;
    surfaceElement.style.height = `${scaledHeight}px`;

    const maxScrollLeft = Math.max(0, scaledWidth - viewportElement.clientWidth);
    const maxScrollTop = Math.max(0, scaledHeight - viewportElement.clientHeight);
    viewportElement.scrollLeft = clampNumber((focalContentX * clampedScale) - focalX, 0, maxScrollLeft);
    viewportElement.scrollTop = clampNumber((focalContentY * clampedScale) - focalY, 0, maxScrollTop);
  }

  function schedulePdfScale(nextScale: number, focal: PdfFocalPoint | null): void {
    pendingScaleRef.current = { scale: nextScale, focal };
    if (scaleFrameRef.current !== null) {
      return;
    }
    scaleFrameRef.current = window.requestAnimationFrame(() => {
      scaleFrameRef.current = null;
      const pendingScale = pendingScaleRef.current;
      pendingScaleRef.current = null;
      if (pendingScale) {
        applyPdfScale(pendingScale.scale, pendingScale.focal);
      }
    });
  }

  useEffect(() => {
    const viewportElement = viewportRef.current;
    const surfaceElement = surfaceRef.current;
    const pagesElement = pagesRef.current;
    if (!viewportElement || !surfaceElement || !pagesElement) {
      return;
    }
    const viewportNode = viewportElement;
    const surfaceNode = surfaceElement;
    const renderTarget = pagesElement;

    let isCancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let pdfDocument: PDFDocumentProxy | null = null;
    setIsRendering(renderTarget.childElementCount === 0);
    setRenderError(null);
    renderTarget.style.width = "";

    async function renderPdf(): Promise<void> {
      try {
        const pdfjsLib = await loadPdfJs();
        if (isCancelled) {
          return;
        }
        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) });
        pdfDocument = await loadingTask.promise;
        if (isCancelled || !pdfDocument) {
          return;
        }

        const nextPageElements: HTMLDivElement[] = [];
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
          const page = await pdfDocument.getPage(pageNumber);
          if (isCancelled) {
            return;
          }

          const baseViewport = page.getViewport({ scale: 1 });
          const availableWidth = Math.max(viewportNode.clientWidth - 16, 260);
          const scale = Math.min(Math.max(availableWidth / baseViewport.width, 0.35), 3.5);
          const viewport = page.getViewport({ scale });
          const renderPixelRatio = getPdfCanvasRenderScale(viewport.width, viewport.height);
          const renderViewport = page.getViewport({ scale: scale * renderPixelRatio });
          const canvas = document.createElement("canvas");
          const canvasContext = canvas.getContext("2d", { alpha: false });

          if (!canvasContext) {
            throw new Error("Canvas konnte nicht initialisiert werden.");
          }

          canvas.className = "mobile-customer-signature-canvas-page";
          canvas.width = Math.floor(renderViewport.width);
          canvas.height = Math.floor(renderViewport.height);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;

          const pageElement = document.createElement("div");
          pageElement.className = "mobile-customer-signature-pdf-page";
          pageElement.appendChild(canvas);
          nextPageElements.push(pageElement);

          const renderTask = page.render({ canvas, canvasContext, viewport: renderViewport });
          await renderTask.promise;
        }

        if (!isCancelled) {
          renderTarget.replaceChildren(...nextPageElements);
          const nextSize = {
            width: Math.ceil(renderTarget.scrollWidth),
            height: Math.ceil(renderTarget.scrollHeight),
          };
          baseContentSizeRef.current = nextSize;
          renderTarget.style.width = `${nextSize.width}px`;
          surfaceNode.style.width = `${Math.max(nextSize.width, viewportNode.clientWidth)}px`;
          surfaceNode.style.height = `${Math.max(nextSize.height, viewportNode.clientHeight)}px`;
          applyPdfScale(zoomScaleRef.current);
          setIsRendering(false);
        }
      } catch (error) {
        if (!isCancelled) {
          console.error("Measurement PDF render failed", error);
          setRenderError("Aufmaß-PDF konnte nicht angezeigt werden.");
          setIsRendering(false);
        }
      }
    }

    void renderPdf();
    return () => {
      isCancelled = true;
      void loadingTask?.destroy();
      void pdfDocument?.cleanup();
    };
  }, [data, renderVersion]);

  function handleTouchStart(event: ReactTouchEvent<HTMLDivElement>): void {
    if (event.touches.length !== 2) {
      return;
    }
    const distance = getTouchDistance(event.touches);
    if (distance <= 0) {
      return;
    }
    event.preventDefault();
    pinchStateRef.current = {
      initialDistance: distance,
      initialZoom: zoomScaleRef.current,
      latestZoom: zoomScaleRef.current,
      latestFocal: getTouchMidpoint(event.touches),
    };
  }

  function handleTouchMove(event: ReactTouchEvent<HTMLDivElement>): void {
    const pinchState = pinchStateRef.current;
    if (!pinchState || event.touches.length !== 2) {
      return;
    }
    event.preventDefault();
    const distance = getTouchDistance(event.touches);
    if (distance <= 0) {
      return;
    }
    const nextZoom = clampNumber(pinchState.initialZoom * (distance / pinchState.initialDistance), PDF_MIN_ZOOM, PDF_MAX_ZOOM);
    const focal = getTouchMidpoint(event.touches);
    pinchState.latestZoom = nextZoom;
    pinchState.latestFocal = focal;
    schedulePdfScale(nextZoom, focal);
  }

  function finishPinch(): void {
    const pinchState = pinchStateRef.current;
    if (!pinchState) {
      return;
    }
    pinchStateRef.current = null;
    zoomScaleRef.current = pinchState.latestZoom;
    applyPdfScale(pinchState.latestZoom, pinchState.latestFocal);
  }

  return (
    <div
      className="mobile-customer-signature-pdfjs"
      aria-label="Aufmaß-PDF"
    >
      {isRendering ? <div className="empty-panel">PDF wird vorbereitet...</div> : null}
      {renderError ? <div className="form-error">{renderError}</div> : null}
      <div
        className="mobile-customer-signature-pdf-viewport"
        ref={viewportRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={(event) => {
          if (event.touches.length < 2) {
            finishPinch();
          }
        }}
        onTouchCancel={finishPinch}
      >
        <div className="mobile-customer-signature-pdf-surface" ref={surfaceRef}>
          <div className="mobile-customer-signature-pdf-pages" ref={pagesRef} />
        </div>
      </div>
    </div>
  );
}

function CustomerSignatureOverlay({
  assignmentId,
  batch,
  siteNumber,
  signaturePlace,
  onClose,
  onSigned,
}: {
  assignmentId: number;
  batch: MobileMeasurementBatch;
  siteNumber: string | null;
  signaturePlace: string;
  onClose: () => void;
  onSigned: (batch: MobileMeasurementBatch) => void;
}) {
  const [activeBatch, setActiveBatch] = useState(batch);
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [pdfReloadKey, setPdfReloadKey] = useState(0);
  const [isPdfLoading, setIsPdfLoading] = useState(true);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  const [customerName, setCustomerName] = useState(batch.customer_signature_name ?? "");
  const [strokes, setStrokes] = useState<CustomerSignatureStroke[]>([]);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [isSavingSignature, setIsSavingSignature] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);

  const isSigned = Boolean(activeBatch.customer_signed_at);
  const hasSignature = strokes.some((stroke) => stroke.length >= 2);
  const isTopModal = useMobileModalStack(true);

  useEffect(() => {
    setActiveBatch(batch);
    setCustomerName(batch.customer_signature_name ?? "");
  }, [batch]);

  useEffect(() => {
    let isActive = true;

    async function loadPdf(): Promise<void> {
      setIsPdfLoading(true);
      setPdfError(null);
      setPdfData(null);
      try {
        const blob = await api.mobileMeasurementBatchPdf(assignmentId, batch.id);
        const arrayBuffer = await blob.arrayBuffer();
        if (isActive) {
          setPdfData(arrayBuffer);
        }
      } catch (requestError) {
        if (isActive) {
          setPdfError(readApiError(requestError, "Aufmaß-PDF konnte nicht geladen werden."));
        }
      } finally {
        if (isActive) {
          setIsPdfLoading(false);
        }
      }
    }

    void loadPdf();
    return () => {
      isActive = false;
    };
  }, [assignmentId, batch.id, pdfReloadKey]);

  useEffect(() => {
    if (!isSigning) {
      return;
    }
    drawSignatureCanvas(canvasRef.current, strokes);
  }, [isSigning, strokes]);

  function appendSignaturePoint(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const point = getSignatureCanvasPoint(event);
    if (!point) {
      return;
    }
    setStrokes((currentStrokes) => {
      if (currentStrokes.length === 0) {
        return [[point]];
      }
      const nextStrokes = currentStrokes.slice();
      const lastStroke = nextStrokes[nextStrokes.length - 1] ?? [];
      nextStrokes[nextStrokes.length - 1] = [...lastStroke, point];
      return nextStrokes;
    });
  }

  async function handleSaveSignature(): Promise<void> {
    const normalizedName = customerName.trim();
    if (!normalizedName) {
      setSignatureError("Bitte Kundennamen eintragen.");
      return;
    }
    const validStrokes = strokes.filter((stroke) => stroke.length >= 2);
    if (validStrokes.length === 0) {
      setSignatureError("Bitte Unterschrift erfassen.");
      return;
    }

    setIsSavingSignature(true);
    setSignatureError(null);
    try {
      const updatedBatch = await api.signMobileMeasurementBatch(assignmentId, activeBatch.id, {
        customer_name: normalizedName,
        signature_strokes: validStrokes,
      });
      setActiveBatch(updatedBatch);
      setIsSigning(false);
      setStrokes([]);
      onSigned(updatedBatch);
      setPdfReloadKey((currentKey) => currentKey + 1);
    } catch (requestError) {
      setSignatureError(readApiError(requestError, "Unterschrift konnte nicht gespeichert werden."));
    } finally {
      setIsSavingSignature(false);
    }
  }

  return (
    <div
      aria-hidden={!isTopModal}
      aria-label="Kundenunterschrift"
      aria-modal="true"
      className="mobile-customer-signature-overlay mobile-modal-layer mobile-modal-scroll-region"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="dialog"
    >
      <header className="mobile-customer-signature-header">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onClose}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Zurück</span>
        </button>
        <div className="mobile-customer-signature-title">
          <strong>{formatMobileMeasurementBatchTitle(activeBatch, siteNumber)}</strong>
          <span>{isSigned ? "Kundenunterschrift gespeichert" : "PDF prüfen und unterschreiben"}</span>
        </div>
        <button
          className="primary-action mobile-customer-signature-sign-action"
          type="button"
          onClick={() => {
            setSignatureError(null);
            setIsSigning(true);
          }}
          disabled={isSigned}
        >
          Unterschreiben
        </button>
      </header>

      <main className="mobile-customer-signature-pdf">
        {isPdfLoading ? <div className="empty-panel">PDF wird geladen...</div> : null}
        {pdfError ? <div className="form-error">{pdfError}</div> : null}
        {!isPdfLoading && !pdfError && pdfData ? <PdfCanvasPreview data={pdfData} /> : null}
      </main>

      {isSigning && !isSigned ? (
        <section className="mobile-customer-signature-sheet" aria-label="Unterschrift erfassen">
          <label>
            <span>Kundenname</span>
            <input
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              placeholder="Name des Kunden"
            />
          </label>
          <p className="mobile-measurement-action-hint">Ort: {activeBatch.customer_signature_place || signaturePlace}</p>
          <div className="mobile-signature-canvas-wrap">
            <span>Unterschrift</span>
            <canvas
              ref={canvasRef}
              className="mobile-signature-canvas"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                isDrawingRef.current = true;
                const point = getSignatureCanvasPoint(event);
                if (point) {
                  setStrokes((currentStrokes) => [...currentStrokes, [point]]);
                }
              }}
              onPointerMove={(event) => {
                if (!isDrawingRef.current) {
                  return;
                }
                event.preventDefault();
                appendSignaturePoint(event);
              }}
              onPointerUp={(event) => {
                isDrawingRef.current = false;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={() => {
                isDrawingRef.current = false;
              }}
            />
          </div>
          {signatureError ? <p className="form-error">{signatureError}</p> : null}
          <div className="mobile-customer-signature-actions">
            <button
              className="secondary-action"
              type="button"
              onClick={() => {
                setStrokes([]);
                setSignatureError(null);
              }}
              disabled={isSavingSignature}
            >
              Leeren
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={() => void handleSaveSignature()}
              disabled={isSavingSignature || !customerName.trim() || !hasSignature}
            >
              {isSavingSignature ? "Speichert..." : "Speichern"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function WorkerSignatureOverlay({
  assignmentId,
  batch,
  siteNumber,
  workerName,
  onClose,
  onSigned,
}: {
  assignmentId: number;
  batch: MobileMeasurementBatch;
  siteNumber: string | null;
  workerName: string;
  onClose: () => void;
  onSigned: (batch: MobileMeasurementBatch) => void;
}) {
  const [signerName, setSignerName] = useState(batch.worker_signature_name ?? workerName);
  const [strokes, setStrokes] = useState<CustomerSignatureStroke[]>([]);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [isSavingSignature, setIsSavingSignature] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const hasSignature = strokes.some((stroke) => stroke.length >= 2);
  const isTopModal = useMobileModalStack(true);

  useEffect(() => {
    drawSignatureCanvas(canvasRef.current, strokes);
  }, [strokes]);

  function appendSignaturePoint(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const point = getSignatureCanvasPoint(event);
    if (!point) {
      return;
    }
    setStrokes((currentStrokes) => {
      if (currentStrokes.length === 0) {
        return [[point]];
      }
      const nextStrokes = currentStrokes.slice();
      const lastStroke = nextStrokes[nextStrokes.length - 1] ?? [];
      nextStrokes[nextStrokes.length - 1] = [...lastStroke, point];
      return nextStrokes;
    });
  }

  async function handleSaveSignature(): Promise<void> {
    if (!signerName.trim()) {
      setSignatureError("Bitte Monteurnamen eintragen.");
      return;
    }
    if (!hasSignature) {
      setSignatureError("Bitte Unterschrift erfassen.");
      return;
    }
    setIsSavingSignature(true);
    setSignatureError(null);
    try {
      const updatedBatch = await api.signMobileMeasurementBatchWorker(assignmentId, batch.id, {
        worker_name: signerName.trim(),
        signature_strokes: strokes.filter((stroke) => stroke.length >= 2),
      });
      onSigned(updatedBatch);
    } catch (requestError) {
      setSignatureError(readApiError(requestError, "Monteursunterschrift konnte nicht gespeichert werden."));
    } finally {
      setIsSavingSignature(false);
    }
  }

  return (
    <div
      aria-hidden={!isTopModal}
      className="mobile-dialog-backdrop mobile-modal-layer"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={isSavingSignature ? undefined : onClose}
    >
      <div
        className="mobile-project-email-dialog mobile-worker-signature-dialog mobile-modal-scroll-region"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-measurement-worker-signature-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mobile-project-email-dialog-head">
          <h2 id="mobile-measurement-worker-signature-dialog-title">Monteursunterschrift</h2>
          <p>{formatMobileMeasurementBatchTitle(batch, siteNumber)}</p>
        </div>
        <section className="mobile-worker-signature-card" aria-label="Monteursunterschrift erfassen">
          <label>
            <span>Monteur</span>
            <input
              value={signerName}
              onChange={(event) => setSignerName(event.target.value)}
              placeholder="Name des Monteurs"
            />
          </label>
          <div className="mobile-signature-canvas-wrap">
            <span>Unterschrift</span>
            <canvas
              ref={canvasRef}
              className="mobile-signature-canvas"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                isDrawingRef.current = true;
                const point = getSignatureCanvasPoint(event);
                if (point) {
                  setStrokes((currentStrokes) => [...currentStrokes, [point]]);
                }
              }}
              onPointerMove={(event) => {
                if (!isDrawingRef.current) {
                  return;
                }
                event.preventDefault();
                appendSignaturePoint(event);
              }}
              onPointerUp={(event) => {
                isDrawingRef.current = false;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={() => {
                isDrawingRef.current = false;
              }}
            />
          </div>
          {signatureError ? <p className="form-error">{signatureError}</p> : null}
          <div className="mobile-worker-signature-actions">
            <button className="secondary-action" type="button" onClick={onClose} disabled={isSavingSignature}>
              Abbrechen
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => {
                setStrokes([]);
                setSignatureError(null);
              }}
              disabled={isSavingSignature}
            >
              Leeren
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={() => void handleSaveSignature()}
              disabled={isSavingSignature || !signerName.trim() || !hasSignature}
            >
              {isSavingSignature ? "Speichert..." : "Speichern"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function getSignatureCanvasPoint(event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } | null {
  return getNormalizedSignaturePoint(
    event.currentTarget,
    event.clientX,
    event.clientY,
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getPdfCanvasRenderScale(cssWidth: number, cssHeight: number): number {
  const deviceScale = window.devicePixelRatio || 1;
  const targetScale = Math.min(
    Math.max(deviceScale * PDF_RENDER_QUALITY_MULTIPLIER, 2.5),
    PDF_MAX_RENDER_PIXEL_RATIO,
  );
  const pixelCapScale = Math.sqrt(PDF_MAX_CANVAS_PIXELS / Math.max(cssWidth * cssHeight, 1));
  return Math.max(1, Math.min(targetScale, pixelCapScale));
}

function getTouchDistance(touches: ReactTouchEvent<HTMLDivElement>["touches"]): number {
  if (touches.length < 2) {
    return 0;
  }
  const firstTouch = touches[0];
  const secondTouch = touches[1];
  if (!firstTouch || !secondTouch) {
    return 0;
  }
  return Math.hypot(firstTouch.clientX - secondTouch.clientX, firstTouch.clientY - secondTouch.clientY);
}

function getTouchMidpoint(touches: ReactTouchEvent<HTMLDivElement>["touches"]): PdfFocalPoint | null {
  if (touches.length < 2) {
    return null;
  }
  const firstTouch = touches[0];
  const secondTouch = touches[1];
  if (!firstTouch || !secondTouch) {
    return null;
  }
  return {
    clientX: (firstTouch.clientX + secondTouch.clientX) / 2,
    clientY: (firstTouch.clientY + secondTouch.clientY) / 2,
  };
}

function PlaceholderPanel({ icon: Icon, text }: { icon: typeof ClipboardList; text: string }) {
  return (
    <div className="mobile-detail-panel mobile-placeholder-panel">
      <Icon aria-hidden="true" size={22} />
      <p>{text}</p>
    </div>
  );
}

function findCachedAssignment(assignmentId: string | undefined): MobileAssignment | null {
  if (!assignmentId) {
    return null;
  }
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return null;
    }
    const cache = JSON.parse(raw) as { data?: MobileAssignmentsResponse };
    return cache.data?.assignments.find((item) => String(item.id) === assignmentId) ?? null;
  } catch {
    return null;
  }
}

function readApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  if (typeof error.detail === "string") {
    return error.detail;
  }
  return error.message || fallback;
}

function downloadBlobFile(blob: Blob, filename: string): void {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 10_000);
}

function collectMeasurementAreaTags(
  items: MobileMeasurementItem[],
  options: { sort?: boolean } = {},
): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();

  items.forEach((item) => {
    item.entries.forEach((entry) => {
      const normalized = normalizeMeasurementArea(entry.area_or_comment);
      const key = getMeasurementAreaKey(normalized);
      if (!normalized || seen.has(key)) {
        return;
      }
      seen.add(key);
      tags.push(normalized);
    });
  });

  return options.sort === false ? tags : sortMeasurementAreaLabels(tags);
}

function collectMeasurementBatchAreaRows(batch: MobileMeasurementBatch): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  [...(batch.area_rows ?? [])]
    .sort((left, right) => left.sort_order - right.sort_order || left.id - right.id)
    .forEach((row) => {
      const normalized = normalizeMeasurementAreaInput(normalizeMeasurementArea(row.area_or_comment));
      const key = getMeasurementAreaKey(normalized);
      if (!normalized || seen.has(key)) {
        return;
      }
      seen.add(key);
      tags.push(normalized);
    });
  return tags;
}

function mergeMeasurementAreaRows(measuredRows: string[], pendingRows: string[]): string[] {
  const mergedRows = [...measuredRows];
  const seen = new Set(measuredRows.map(getMeasurementAreaKey));
  pendingRows.forEach((area) => {
    const normalized = normalizeMeasurementAreaInput(normalizeMeasurementArea(area));
    const key = getMeasurementAreaKey(normalized);
    if (!normalized || seen.has(key)) {
      return;
    }
    seen.add(key);
    mergedRows.push(normalized);
  });
  return mergedRows;
}

function sortMeasurementAreaLabels(labels: string[]): string[] {
  return labels
    .map((label, index) => ({ label, index, sortRank: getMeasurementAreaSortRank(label, index) }))
    .sort((left, right) => left.sortRank - right.sortRank || left.index - right.index)
    .map((item) => item.label);
}

function getMobileMeasurementAreaQuantity(item: MobileMeasurementItem, areaLabel: string): number {
  const areaKey = getMeasurementAreaKey(areaLabel);
  return item.entries.reduce((sum, entry) => {
    if (getMeasurementAreaKey(entry.area_or_comment) !== areaKey) {
      return sum;
    }
    return sum + getMeasurementEntryQuantity(entry);
  }, 0);
}

type MeasurementAreaSummary = {
  key: string;
  label: string;
  quantity: number;
  entries: MeasurementEntry[];
  sortIndex: number;
};

function groupMeasurementEntriesByArea(entries: MeasurementEntry[]): MeasurementAreaSummary[] {
  const grouped = new Map<string, MeasurementAreaSummary>();

  entries.forEach((entry, index) => {
    const label = normalizeMeasurementArea(entry.area_or_comment) || "Ohne Ort";
    const key = getMeasurementAreaKey(label);
    const current = grouped.get(key);
    if (current) {
      current.quantity += getMeasurementEntryQuantity(entry);
      current.entries.push(entry);
      return;
    }
    grouped.set(key, {
      key,
      label,
      quantity: getMeasurementEntryQuantity(entry),
      entries: [entry],
      sortIndex: index,
    });
  });

  return [...grouped.values()].sort((left, right) => (
    getMeasurementAreaSortRank(left.label, left.sortIndex) - getMeasurementAreaSortRank(right.label, right.sortIndex)
    || left.sortIndex - right.sortIndex
  ));
}

function sumMeasurementEntryQuantities(entries: MeasurementEntry[]): number {
  return entries.reduce((sum, entry) => sum + getMeasurementEntryQuantity(entry), 0);
}

function getMeasurementMatrixCellClassName(item: MobileMeasurementItem, baseClassName = ""): string {
  return [baseClassName, item.is_free_position ? "measurement-matrix-free-column" : ""]
    .filter(Boolean)
    .join(" ");
}

function buildMeasurementTableDisplayItems(items: MobileMeasurementItem[], batch: MobileMeasurementBatch): MobileMeasurementItem[] {
  if (items.length >= MOBILE_MEASUREMENT_TABLE_MIN_COLUMNS) {
    return items;
  }
  const existingIds = new Set(items.map((item) => item.id));
  const placeholderItems: MobileMeasurementItem[] = [];
  const freePositionCount = items.filter((item) => item.is_free_position).length;
  for (let index = 0; items.length + placeholderItems.length < MOBILE_MEASUREMENT_TABLE_MIN_COLUMNS; index += 1) {
    const placeholderId = MOBILE_MEASUREMENT_TABLE_PLACEHOLDER_ITEM_ID_BASE - index;
    if (existingIds.has(placeholderId)) {
      continue;
    }
    placeholderItems.push(createInlineFreePositionDraftItem(
      batch,
      placeholderId,
      `FREI-${freePositionCount + placeholderItems.length + 1}`,
    ));
  }
  return [...items, ...placeholderItems];
}

function buildMeasurementPositionGroups(items: MobileMeasurementItem[]): MeasurementPositionGroup[] {
  const allMeasurementItems = items.filter((item) => !isInlineFreePositionDraftItem(item));
  const offerItems = items.filter((item) => !item.is_free_position && !isInlineFreePositionDraftItem(item));
  const sourceDocumentGroups = buildMeasurementSourceDocumentGroups(offerItems);
  const hasMultipleSourceDocuments = sourceDocumentGroups.length > 1;
  if (offerItems.length < 30 && !hasMultipleSourceDocuments) {
    return [];
  }
  const capturedItems = items.filter(isMobileMeasurementItemCaptured);
  const freeItems = items.filter((item) => item.is_free_position);
  const sourceGroups = hasMultipleSourceDocuments
    ? sourceDocumentGroups.map((group) => createMeasurementPositionGroup(
      group.label,
      group.items,
      group.key,
    ))
    : [];
  const sourceSectionGroups = !hasMultipleSourceDocuments && offerItems.length >= 30
    ? buildMeasurementSourceSectionGroups(offerItems)
    : [];
  const root = createMeasurementPositionTreeNode([]);
  const miscellaneousItems: MobileMeasurementItem[] = [];

  offerItems.forEach((item) => {
    const segments = parseMeasurementPositionSegments(item.position);
    if (segments.length === 0) {
      miscellaneousItems.push(item);
      return;
    }
    appendMeasurementPositionTreeItem(root, segments, item);
  });

  const prefixGroups = hasMultipleSourceDocuments
    ? []
    : sourceSectionGroups.length > 0
      ? sourceSectionGroups
      : [...root.children.values()]
      .sort(compareMeasurementPositionTreeNodes)
      .flatMap((node) => chooseMeasurementPositionGroupNodes(node))
      .map((node) => {
        const prefix = node.prefixSegments.join(".");
        return createMeasurementPositionGroup(getMeasurementPositionGroupLabel(prefix, node.items), node.items, prefix);
      });

  if (!hasMultipleSourceDocuments && sourceSectionGroups.length === 0 && miscellaneousItems.length > 0) {
    prefixGroups.push(createMeasurementPositionGroup("Sonstige", miscellaneousItems, "misc"));
  }

  const allPositionsGroup = createMeasurementPositionGroup("Alle Positionen", allMeasurementItems, "all");
  const catalogGroups = [...sourceGroups, ...prefixGroups];
  const baseGroups = catalogGroups.length > 0 ? [allPositionsGroup, ...catalogGroups] : [allPositionsGroup];

  return [
    ...baseGroups,
    {
      key: "captured",
      label: "Erfasste Positionen",
      count: capturedItems.length,
      kind: "captured",
      itemIds: new Set(capturedItems.map((item) => item.id)),
    },
    ...(freeItems.length > 0 ? [{
      key: "free",
      label: "Freie Positionen",
      count: freeItems.length,
      kind: "free" as const,
      itemIds: new Set(freeItems.map((item) => item.id)),
    }] : []),
  ];
}

function buildMeasurementSourceSectionGroups(items: MobileMeasurementItem[]): MeasurementPositionGroup[] {
  const grouped = new Map<string, { sectionKey: string; sectionTitle: string; items: MobileMeasurementItem[]; sortIndex: number }>();
  const ungroupedItems: MobileMeasurementItem[] = [];
  items.forEach((item, index) => {
    const sectionKey = normalizeMeasurementSectionKey(item.source_section_key);
    const sectionTitle = item.source_section_title?.trim();
    if (!sectionKey || !sectionTitle) {
      ungroupedItems.push(item);
      return;
    }
    const signature = `${sectionKey}\u0000${sectionTitle.toLocaleUpperCase("de-DE")}`;
    const group = grouped.get(signature) ?? {
      sectionKey,
      sectionTitle,
      items: [],
      sortIndex: index,
    };
    group.items.push(item);
    grouped.set(signature, group);
  });

  const titleGroups = [...grouped.values()].sort((left, right) => left.sortIndex - right.sortIndex);
  const shouldCollectSmallTitleGroups = titleGroups.length >= MEASUREMENT_TITLE_GROUP_MISC_THRESHOLD;
  const groups: MeasurementPositionGroup[] = [];
  const miscellaneousItems: MobileMeasurementItem[] = [];

  titleGroups.forEach((group, index) => {
    if (shouldCollectSmallTitleGroups && group.items.length < MEASUREMENT_TITLE_GROUP_MIN_OWN_BADGE_COUNT) {
      miscellaneousItems.push(...group.items);
      return;
    }
    groups.push(createMeasurementPositionGroup(
      `${group.sectionKey} – ${group.sectionTitle}`,
      group.items,
      `section:${index}:${group.sectionKey}:${group.sectionTitle}`,
      group.items.length,
    ));
  });

  if (titleGroups.length > 0 && ungroupedItems.length > 0) {
    miscellaneousItems.push(...ungroupedItems);
  }
  if (titleGroups.length > 0 && miscellaneousItems.length > 0) {
    groups.push(createMeasurementPositionGroup("Sonstige", miscellaneousItems, "source-misc"));
  }
  return groups;
}

function filterMeasurementItemsByPositionGroup(items: MobileMeasurementItem[], group: MeasurementPositionGroup | null): MobileMeasurementItem[] {
  if (!group) {
    return items;
  }
  return items.filter((item) => {
    if (isInlineFreePositionDraftItem(item)) {
      return true;
    }
    if (group.kind === "all") {
      return true;
    }
    if (group.kind === "captured") {
      return isMobileMeasurementItemCaptured(item);
    }
    if (group.kind === "free") {
      return item.is_free_position;
    }
    return group.itemIds.has(item.id);
  });
}

function getActiveMeasurementPositionGroupKey(groups: MeasurementPositionGroup[], currentKey: string | null): string | null {
  if (currentKey && groups.some((group) => group.key === currentKey)) {
    return currentKey;
  }
  const capturedGroup = groups.find((group) => group.kind === "captured" && group.count > 0);
  if (capturedGroup) {
    return capturedGroup.key;
  }
  return groups.find((group) => group.kind !== "captured" && group.count > 0)?.key ?? groups[0]?.key ?? null;
}

type MeasurementPositionTreeNode = {
  prefixSegments: string[];
  items: MobileMeasurementItem[];
  children: Map<string, MeasurementPositionTreeNode>;
};

function createMeasurementPositionTreeNode(prefixSegments: string[]): MeasurementPositionTreeNode {
  return {
    prefixSegments,
    items: [],
    children: new Map(),
  };
}

function appendMeasurementPositionTreeItem(root: MeasurementPositionTreeNode, segments: string[], item: MobileMeasurementItem, startIndex = 0): void {
  let currentNode = root;
  currentNode.items.push(item);
  for (let index = startIndex; index < segments.length; index += 1) {
    const segment = segments[index];
    const childNode = currentNode.children.get(segment) ?? createMeasurementPositionTreeNode(segments.slice(0, index + 1));
    childNode.items.push(item);
    currentNode.children.set(segment, childNode);
    currentNode = childNode;
  }
}

function chooseMeasurementPositionGroupNodes(node: MeasurementPositionTreeNode): MeasurementPositionTreeNode[] {
  if (node.items.length <= 50 || node.children.size === 0) {
    return [node];
  }
  const children = [...node.children.values()].sort(compareMeasurementPositionTreeNodes);
  if (children.some((child) => child.items.length < 20)) {
    return [node];
  }
  return children.flatMap((child) => chooseMeasurementPositionGroupNodes(child));
}

function createMeasurementPositionGroup(label: string, items: MobileMeasurementItem[], keySuffix = label, sourceItemCount = items.length): MeasurementPositionGroup {
  return {
    key: `prefix:${keySuffix.toLocaleUpperCase("de-DE")}`,
    label,
    count: items.length,
    kind: label === "Alle Positionen" ? "all" : "prefix",
    itemIds: new Set(items.map((item) => item.id)),
    sourceItemCount,
  };
}

function getMeasurementPositionGroupLabel(prefix: string, items: MobileMeasurementItem[]): string {
  const normalizedPrefix = normalizeMeasurementSectionKey(prefix);
  const firstMatchingItem = items.find((item) => {
    return normalizeMeasurementSectionKey(item.source_section_key) === normalizedPrefix && Boolean(item.source_section_title?.trim());
  });
  if (
    firstMatchingItem?.source_section_title &&
    items.every((item) => normalizeMeasurementSectionKey(item.source_section_key) === normalizedPrefix)
  ) {
    return `${prefix} – ${firstMatchingItem.source_section_title.trim()}`;
  }
  return prefix;
}

function normalizeMeasurementSectionKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/\s*\.\s*/g, ".")
    .replace(/\.+$/g, "")
    .toLocaleUpperCase("de-DE");
}

function parseMeasurementPositionSegments(position: string): string[] {
  const normalized = position.trim();
  if (!/\d/.test(normalized)) {
    return [];
  }
  return normalized
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.toLocaleUpperCase("de-DE"));
}

function compareMeasurementPositionTreeNodes(left: MeasurementPositionTreeNode, right: MeasurementPositionTreeNode): number {
  return compareMeasurementPositionSegments(left.prefixSegments, right.prefixSegments);
}

function compareMeasurementPositionSegments(left: string[], right: string[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = left[index];
    const rightSegment = right[index];
    if (leftSegment === undefined) {
      return -1;
    }
    if (rightSegment === undefined) {
      return 1;
    }
    const comparison = leftSegment.localeCompare(rightSegment, "de-DE", {
      numeric: true,
      sensitivity: "base",
    });
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function isInlineFreePositionDraftItem(item: MobileMeasurementItem): boolean {
  return item.id < 0 && item.is_free_position;
}

function isEmptyInlineFreePositionDraftItem(item: MobileMeasurementItem): boolean {
  return isInlineFreePositionDraftItem(item) && item.entries.length === 0 && !item.description.trim();
}

function getMeasurementPositionDisplayLabel(item: MobileMeasurementItem): string {
  const position = item.position.trim();
  if (isTechnicalFreePositionLabel(position)) {
    return "";
  }
  return position;
}

function getMeasurementPositionSaveValue(item: MobileMeasurementItem): string | null {
  const position = item.position.trim();
  return position && !isTechnicalFreePositionLabel(position) ? position : null;
}

function isTechnicalFreePositionLabel(position: string): boolean {
  return /^FREI-\d+$/i.test(position.trim());
}

function getNextInlineFreePositionDraftLabel(items: MobileMeasurementItem[]): string {
  const nextNumber = items.filter((item) => item.is_free_position).length + 1;
  return `FREI-${nextNumber}`;
}

function createInlineFreePositionDraftItem(batch: MobileMeasurementBatch, id: number, position: string): MobileMeasurementItem {
  const timestamp = new Date().toISOString();
  return {
    id,
    site_id: batch.site_id,
    measurement_base_id: batch.measurement_base_id,
    linked_measurement_item_id: null,
    source_file_name: null,
    source_project_number: null,
    source_invoice_number: null,
    source_customer_name: null,
    source_section_key: null,
    source_section_title: null,
    position,
    description: "",
    list_quantity: null,
    unit: "st",
    minutes_per_unit: null,
    list_minutes_total: null,
    is_nep: false,
    is_free_position: true,
    is_hidden: false,
    sort_order: Number.MAX_SAFE_INTEGER - Math.abs(id),
    measurement_base: null,
    created_at: timestamp,
    updated_at: timestamp,
    entries: [],
    reported_quantity: 0,
    reported_minutes: 0,
    reported_hours: 0,
    mobile_status: "open",
  };
}

function recalculateMobileMeasurementItemTotals(item: MobileMeasurementItem, entries: MeasurementEntry[]): MobileMeasurementItem {
  const reportedQuantity = sumMeasurementEntryQuantities(entries);
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

function updateMobileMeasurementItemsAfterInlineSave(
  items: MobileMeasurementItem[],
  itemId: number,
  deletedEntryIds: Set<number>,
  createdEntry: MeasurementEntry | null,
): MobileMeasurementItem[] {
  return items.map((item) => {
    if (item.id !== itemId) {
      return item;
    }
    const entries = item.entries.filter((entry) => !deletedEntryIds.has(entry.id));
    if (createdEntry && !entries.some((entry) => entry.id === createdEntry.id)) {
      entries.push(createdEntry);
    }
    return recalculateMobileMeasurementItemTotals(item, entries);
  });
}

function getMeasurementEntryQuantity(entry: MeasurementEntry): number {
  const quantity = typeof entry.quantity === "number" ? entry.quantity : Number(entry.quantity);
  return Number.isFinite(quantity) ? quantity : 0;
}

function parseOptionalMeasurementQuantity(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) {
    return 0;
  }
  const quantity = Number(normalized);
  return Number.isFinite(quantity) ? quantity : null;
}

function applyMeasurementQuantityKey(value: string, key: MeasurementQuantityKey): string {
  const normalizedValue = value.replace(".", ",");

  if (key === "clear") {
    return "";
  }
  if (key === "backspace") {
    return normalizedValue.slice(0, -1);
  }
  if (key === "minus") {
    return normalizedValue.startsWith("-") ? normalizedValue.slice(1) : `-${normalizedValue}`;
  }
  if (key === "," || key === ".") {
    if (normalizedValue.includes(",")) {
      return normalizedValue;
    }
    return normalizedValue === "-" ? "-0," : normalizedValue ? `${normalizedValue},` : "0,";
  }

  if (normalizedValue === "-0") {
    return key === "0" ? normalizedValue : `-${key}`;
  }
  if (normalizedValue === "0") {
    return key === "0" ? normalizedValue : key;
  }
  return `${normalizedValue}${key}`;
}

function blurActiveFormElement(): void {
  if (typeof document === "undefined") {
    return;
  }
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
    activeElement.blur();
  }
}

function normalizeMeasurementArea(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "";
  }

  const upper = trimmed.toUpperCase();
  if (["EG", "UG", "DG"].includes(upper)) {
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

function normalizeMeasurementAreaInput(input: string): string {
  return input.toLocaleUpperCase("de-DE");
}

function getMeasurementAreaKey(value: string): string {
  return normalizeMeasurementArea(value).toLocaleLowerCase("de-DE");
}

function getMeasurementAreaSortRank(label: string, fallbackIndex: number): number {
  const normalized = normalizeMeasurementArea(label);
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

function formatAssignmentRange(assignment: MobileAssignment): string {
  return assignment.start_date === assignment.end_date
    ? formatGermanDateKey(assignment.start_date, "numeric")
    : formatGermanDateKeyRange(assignment.start_date, assignment.end_date, "numeric");
}

function formatMeasurementNumber(value: string | number | null): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }
  return new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric);
}

function sortMobileExtraWorkOrders(orders: MobileExtraWorkTicket[]): MobileExtraWorkTicket[] {
  return [...orders].sort((left, right) => {
    const leftCreatedAt = Date.parse(left.created_at);
    const rightCreatedAt = Date.parse(right.created_at);
    const leftRank = Number.isFinite(leftCreatedAt) ? leftCreatedAt : left.id;
    const rightRank = Number.isFinite(rightCreatedAt) ? rightCreatedAt : right.id;
    return rightRank - leftRank || right.id - left.id;
  });
}

function formatMobileExtraWorkOrderTitle(order: MobileExtraWorkTicket): string {
  return `${getMobileExtraWorkOrderFixedTitle(order)} - ${getMobileExtraWorkOrderTitleSuffix(order)}`;
}

function formatMobileExtraWorkEntrySubtitle(order: MobileExtraWorkTicket): string {
  const displayNumber = order.display_number?.trim() ?? "";
  const suffixMatch = displayNumber.match(/(?:^|[.\s_-])(SZ[\w.-]*)$/i);
  const sequenceLabel = suffixMatch?.[1]
    ?? `SZ${String(order.sequence_number).padStart(2, "0")}`;
  return `${order.kind === "approval" ? "Stundenfreigabe" : "Zusatzauftrag"} ${sequenceLabel.toUpperCase()}`;
}

function getMobileExtraWorkOrderFixedTitle(order: MobileExtraWorkTicket): string {
  return order.kind === "approval"
    ? `Stundenfreigabe ${order.sequence_number}`
    : `Stundenzettel ${order.sequence_number}`;
}

function getMobileExtraWorkOrderTitleSuffix(order: MobileExtraWorkTicket): string {
  return order.title?.trim() || EXTRA_WORK_DEFAULT_TITLE_SUFFIX;
}

function getMobileExtraWorkOrderEditableTitle(order: MobileExtraWorkTicket): string {
  return order.title?.trim() || "";
}

function formatMobileExtraWorkKindLabel(kind: string): string {
  return kind === "approval" ? "Stundenfreigabe" : "Stundenzettel";
}

function getMobileExtraWorkPdfFilename(order: MobileExtraWorkTicket): string {
  const number = order.display_number || String(order.id);
  return `Zusatzauftrag_${number.replace(/[\\/:*?"<>|\s]+/g, "_")}.pdf`;
}

type MobileCustomerEmailStatusItem = {
  customer_email_sent_at: string | null;
  customer_email_signature_present: boolean | null;
  customer_signed_at: string | null;
  customer_signature_name?: string | null;
  is_locked_for_worker?: boolean;
};

function MobileCustomerEmailStatus({ item }: { item: MobileCustomerEmailStatusItem }) {
  const status = getMobileCustomerEmailStatus(item);
  return <span className={`mobile-customer-email-status ${status.className}`}>{status.label}</span>;
}

function getMobileCustomerEmailStatus(item: MobileCustomerEmailStatusItem): { label: string; className: string } {
  if (!item.customer_email_sent_at) {
    return {
      label: "Mail nicht an Kunden gesendet",
      className: "is-not-sent",
    };
  }
  const signaturePresent = Boolean(item.customer_signed_at || item.customer_signature_name || item.is_locked_for_worker)
    || item.customer_email_signature_present === true;
  if (signaturePresent) {
    return {
      label: "Mail an Kunden gesendet",
      className: "is-complete",
    };
  }
  return {
    label: "Mail an Kunden gesendet",
    className: "is-signature-open",
  };
}

function getDocumentEmailSendHint({
  hasRecipients,
  hasCustomerSignature,
  hasWorkerSignature,
  isLoadingRecipients,
  allowMissingCustomerSignature = false,
}: {
  hasRecipients: boolean;
  hasCustomerSignature: boolean;
  hasWorkerSignature: boolean;
  isLoadingRecipients: boolean;
  allowMissingCustomerSignature?: boolean;
}): string | null {
  if (isLoadingRecipients) {
    return "E-Mail-Empfänger werden geprüft.";
  }
  if (allowMissingCustomerSignature && !hasRecipients) {
    return "E-Mail-Versand möglich, sobald ein Empfänger hinterlegt ist.";
  }
  if (allowMissingCustomerSignature && !hasCustomerSignature) {
    return "Kundenunterschrift fehlt. Versand zur Unterschrift möglich.";
  }
  if (hasRecipients && hasCustomerSignature && hasWorkerSignature) {
    return null;
  }
  return "E-Mail-Versand möglich, sobald Empfänger und Unterschriften vorhanden sind.";
}

function createEmptyExtraWorkEntryForm(workerName = ""): ExtraWorkEntryFormState {
  return {
    component: "",
    floor: "",
    room_number: "",
    axis: "",
    remarks: "",
    material_text: "",
    material_items: [],
    estimated_hours: "",
    worker_rows: [createEmptyExtraWorkWorkerRow(workerName)],
  };
}

function createEmptyExtraWorkWorkerRow(workerName = ""): ExtraWorkWorkerHoursFormRow {
  return {
    id: createClientRowId(),
    person_id: null,
    worker_name: workerName,
    monday_hours: "",
    tuesday_hours: "",
    wednesday_hours: "",
    thursday_hours: "",
    friday_hours: "",
    saturday_hours: "",
    sunday_hours: "",
    monday_surcharge_25_hours: null,
    tuesday_surcharge_25_hours: null,
    wednesday_surcharge_25_hours: null,
    thursday_surcharge_25_hours: null,
    friday_surcharge_25_hours: null,
    saturday_surcharge_25_hours: null,
    sunday_surcharge_25_hours: null,
    monday_surcharge_50_hours: null,
    tuesday_surcharge_50_hours: null,
    wednesday_surcharge_50_hours: null,
    thursday_surcharge_50_hours: null,
    friday_surcharge_50_hours: null,
    saturday_surcharge_50_hours: null,
    sunday_surcharge_50_hours: null,
  };
}

function mapExtraWorkEntryToForm(
  entry: MobileExtraWorkTicketEntry,
  defaultWorkerName = "",
  legacyWorkerNames: string[] = [],
): ExtraWorkEntryFormState {
  return {
    component: entry.component,
    floor: entry.floor,
    room_number: entry.room_number ?? "",
    axis: entry.axis ?? "",
    remarks: entry.remarks ?? "",
    material_text: entry.material_text ?? "",
    material_items: (entry.material_items ?? []).map((item) => ({
      id: createClientRowId(),
      quantity: item.quantity ?? null,
      unit: item.unit ?? null,
      description: item.description,
    })),
    estimated_hours: formatExtraWorkInputValue(entry.estimated_hours),
    worker_rows: entry.worker_rows.length > 0
      ? entry.worker_rows.map((row, index) => ({
        id: createClientRowId(),
        person_id: row.person_id ?? null,
        worker_name: normalizeExtraWorkWorkerName(row.worker_name, defaultWorkerName, legacyWorkerNames, index),
        monday_hours: formatExtraWorkInputValue(row.monday_hours),
        tuesday_hours: formatExtraWorkInputValue(row.tuesday_hours),
        wednesday_hours: formatExtraWorkInputValue(row.wednesday_hours),
        thursday_hours: formatExtraWorkInputValue(row.thursday_hours),
        friday_hours: formatExtraWorkInputValue(row.friday_hours),
        saturday_hours: formatExtraWorkInputValue(row.saturday_hours),
        sunday_hours: formatExtraWorkInputValue(row.sunday_hours),
        monday_surcharge_25_hours: row.monday_surcharge_25_hours ?? null,
        tuesday_surcharge_25_hours: row.tuesday_surcharge_25_hours ?? null,
        wednesday_surcharge_25_hours: row.wednesday_surcharge_25_hours ?? null,
        thursday_surcharge_25_hours: row.thursday_surcharge_25_hours ?? null,
        friday_surcharge_25_hours: row.friday_surcharge_25_hours ?? null,
        saturday_surcharge_25_hours: row.saturday_surcharge_25_hours ?? null,
        sunday_surcharge_25_hours: row.sunday_surcharge_25_hours ?? null,
        monday_surcharge_50_hours: row.monday_surcharge_50_hours ?? null,
        tuesday_surcharge_50_hours: row.tuesday_surcharge_50_hours ?? null,
        wednesday_surcharge_50_hours: row.wednesday_surcharge_50_hours ?? null,
        thursday_surcharge_50_hours: row.thursday_surcharge_50_hours ?? null,
        friday_surcharge_50_hours: row.friday_surcharge_50_hours ?? null,
        saturday_surcharge_50_hours: row.saturday_surcharge_50_hours ?? null,
        sunday_surcharge_50_hours: row.sunday_surcharge_50_hours ?? null,
      }))
      : [createEmptyExtraWorkWorkerRow(defaultWorkerName)],
  };
}

function getExtraWorkDefaultWorkerName(
  person: MobileAssignment["person"] | null | undefined,
  fallbackName: string,
): string {
  const firstName = cleanExtraWorkNamePart(person?.first_name);
  const lastName = cleanExtraWorkNamePart(person?.last_name);
  const combinedName = [firstName, lastName].filter(Boolean).join(" ");
  if (combinedName) {
    return combinedName;
  }
  const displayName = cleanExtraWorkNamePart(person?.display_name);
  if (displayName) {
    return displayName;
  }
  return cleanExtraWorkNamePart(fallbackName);
}

function getExtraWorkLegacyWorkerNames(
  defaultWorkerName: string,
  userDisplayName: string,
  username: string,
): string[] {
  const firstDefaultName = defaultWorkerName.split(/\s+/)[0] ?? "";
  return Array.from(new Set([
    cleanExtraWorkNamePart(userDisplayName),
    cleanExtraWorkNamePart(username),
    cleanExtraWorkNamePart(firstDefaultName),
  ].filter(Boolean)));
}

function normalizeExtraWorkWorkerName(
  workerName: string,
  defaultWorkerName: string,
  legacyWorkerNames: string[],
  rowIndex: number,
): string {
  const currentName = cleanExtraWorkNamePart(workerName);
  if (rowIndex !== 0 || !defaultWorkerName) {
    return currentName;
  }
  if (!currentName) {
    return defaultWorkerName;
  }
  const normalizedCurrent = currentName.toLocaleLowerCase("de-DE");
  const isLegacyAutoName = legacyWorkerNames.some(
    (legacyName) => legacyName.toLocaleLowerCase("de-DE") === normalizedCurrent,
  );
  return isLegacyAutoName ? defaultWorkerName : currentName;
}

function cleanExtraWorkNamePart(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeProjectRecipientEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isValidProjectRecipientEmail(value: string): boolean {
  const [, domain = ""] = value.split("@");
  return Boolean(value.includes("@") && domain.includes("."));
}

function createClientRowId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cleanOptionalFormText(value: string): string | null {
  const cleaned = value.trim();
  return cleaned || null;
}

function parseNullableExtraWorkHoursInput(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatExtraWorkInputValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "";
  }
  return String(numeric).replace(".", ",");
}

function calculateExtraWorkWorkerTotal(row: ExtraWorkWorkerHoursFormRow): number {
  const normalHours = EXTRA_WORK_WEEK_DAYS.reduce(
    (sum, day) => sum + parseExtraWorkHoursInput(row[day.key]),
    0,
  );
  const hiddenSurchargeHours = EXTRA_WORK_HIDDEN_SURCHARGE_KEYS.reduce(
    (sum, key) => sum + parseExtraWorkStoredHours(row[key]),
    0,
  );
  return normalHours + hiddenSurchargeHours;
}

function getExtraWorkRowDailyHoursError(
  row: ExtraWorkWorkerHoursFormRow,
  day: (typeof EXTRA_WORK_WEEK_DAYS)[number],
): string | null {
  return getExtraWorkDailyHoursTotalError([
    row[day.key],
    row[day.surcharge25Key],
    row[day.surcharge50Key],
  ]);
}

function getExtraWorkHoursFingerprint(rows: ExtraWorkWorkerHoursFormRow[]): string {
  const enteredRows = rows
    .map((row) => EXTRA_WORK_WEEK_DAYS.map((day) => parseExtraWorkHoursInput(row[day.key])))
    .filter((hours) => hours.some((value) => value > 0));
  return JSON.stringify(enteredRows);
}

function calculateExtraWorkPayloadWorkerTotal(row: Record<ExtraWorkWeekdayKey, number>): number {
  return EXTRA_WORK_WEEK_DAYS.reduce((sum, day) => sum + row[day.key], 0);
}

function hasExtraWorkSurchargeHours(
  row: Pick<MobileExtraWorkWorkerHours, ExtraWorkHiddenSurchargeKey>,
): boolean {
  return EXTRA_WORK_HIDDEN_SURCHARGE_KEYS.some((key) => {
    const value = row[key];
    return value !== null && value !== undefined && value !== "";
  });
}

function parseExtraWorkStoredHours(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const parsed = Number(String(value).trim().replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatMobileExtraWorkOrderDate(order: MobileExtraWorkTicket): string {
  const dateValue = order.status === "signed" || order.status === "reviewed"
    ? order.updated_at
    : order.submitted_at || order.created_at;
  return formatMobileDateValue(dateValue);
}

function getExtraWorkAutomaticOrderDate(createdAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(createdAt);
  if (match) {
    return match[1];
  }
  const today = new Date();
  return [
    String(today.getFullYear()).padStart(4, "0"),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
}

function buildExtraWorkIsoWeekOptions(
  automaticIsoYear: number,
  selectedIsoYear: number,
): Array<{ value: string; label: string }> {
  const currentIsoYear = getIsoWeekInfo(getExtraWorkAutomaticOrderDate(new Date().toISOString())).isoYear;
  const years = new Set<number>();
  for (const anchor of [automaticIsoYear, selectedIsoYear, currentIsoYear]) {
    for (let year = anchor - 2; year <= anchor + 2; year += 1) {
      if (year >= 1 && year <= 9999) {
        years.add(year);
      }
    }
  }
  return [...years]
    .sort((left, right) => left - right)
    .flatMap((isoYear) => Array.from({ length: getIsoWeeksInYear(isoYear) }, (_, index) => {
      const week = index + 1;
      return {
        value: `${isoYear}-${week}`,
        label: `KW ${String(week).padStart(2, "0")} / ${isoYear}`,
      };
    }));
}

function parseExtraWorkIsoWeekValue(value: string): { isoYear: number; week: number } | null {
  const match = /^(\d{1,4})-(\d{1,2})$/.exec(value);
  if (!match) {
    return null;
  }
  const isoYear = Number(match[1]);
  const week = Number(match[2]);
  try {
    getIsoWeekRange(isoYear, week);
    return { isoYear, week };
  } catch {
    return null;
  }
}

function getMobileExtraWorkOrderStatusBadge(order: MobileExtraWorkTicket): { label: string; className: string } {
  if (order.status === "reviewed") {
    return { label: "Geprüft", className: "mobile-batch-status-reviewed" };
  }
  if (order.status === "signed" || order.customer_signed_at) {
    return { label: "Unterschrieben", className: "mobile-batch-status-signed" };
  }
  if (order.status === "submitted") {
    return { label: "Eingereicht", className: "mobile-batch-status-submitted" };
  }
  if (order.status === "draft" && hasMobileExtraWorkOrderContent(order)) {
    return { label: "Unterschrift fehlt", className: "mobile-batch-status-signature-missing" };
  }
  return { label: "Entwurf", className: "mobile-batch-status-draft" };
}

function hasMobileExtraWorkOrderContent(order: MobileExtraWorkTicket): boolean {
  const totalHours = Number(order.total_hours ?? 0);
  return (Number.isFinite(totalHours) && totalHours > 0) || order.entry_count > 0;
}

function mergeMobileMeasurementBatchAreaRow(batch: MobileMeasurementBatch, areaRow: MeasurementAreaRow): MobileMeasurementBatch {
  const currentRows = batch.area_rows ?? [];
  const areaKey = getMeasurementAreaKey(areaRow.area_or_comment);
  const nextRows = currentRows.some((row) => getMeasurementAreaKey(row.area_or_comment) === areaKey)
    ? currentRows.map((row) => (getMeasurementAreaKey(row.area_or_comment) === areaKey ? areaRow : row))
    : [...currentRows, areaRow];
  return {
    ...batch,
    area_rows: [...nextRows].sort((left, right) => left.sort_order - right.sort_order || left.id - right.id),
  };
}

function sortMobileMeasurementBatches(batches: MobileMeasurementBatch[]): MobileMeasurementBatch[] {
  return [...batches].sort((left, right) => {
    const leftCreatedAt = Date.parse(left.created_at);
    const rightCreatedAt = Date.parse(right.created_at);
    const leftRank = Number.isFinite(leftCreatedAt) ? leftCreatedAt : left.id;
    const rightRank = Number.isFinite(rightCreatedAt) ? rightCreatedAt : right.id;
    return rightRank - leftRank || right.id - left.id;
  });
}

function formatMobileMeasurementBatchTitle(batch: MobileMeasurementBatch, siteNumber?: string | null): string {
  const cleanSiteNumber = siteNumber?.trim();
  if (cleanSiteNumber) {
    return `Aufmaß ${cleanSiteNumber}.${String(batch.number).padStart(2, "0")}`;
  }
  return batch.title?.trim() || `Aufmaß ${String(batch.number).padStart(2, "0")}`;
}

function formatMobileSignatureLocation(site: MobileAssignment["site"]): string {
  const address = site.address?.trim();
  if (address) {
    return address;
  }
  const location = site.location?.trim();
  if (location) {
    return location;
  }
  return "Baustelle";
}

function formatMobileSiteAddressLabel(site: MobileAssignment["site"]): string {
  return [site.location, site.address].map((part) => part?.trim()).filter(Boolean).join(" - ");
}

function buildGoogleMapsDirectionsUrl(site: MobileAssignment["site"]): string | null {
  const address = site.address?.trim();
  const location = site.location?.trim();
  const destination = address || location;
  if (!destination) {
    return null;
  }
  const destinationWithCountry = /deutschland/i.test(destination) ? destination : `${destination}, Deutschland`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destinationWithCountry)}&travelmode=driving&dir_action=navigate`;
}

function getMobileMeasurementPdfFilename(batch: MobileMeasurementBatch): string {
  return `${formatMobileMeasurementBatchTitle(batch).replace(/\s+/g, "_")}.pdf`;
}

function getMobileMeasurementBatchStatusBadge(batch: MobileMeasurementBatch): { label: string; className: string } {
  const status = batch.status.toLowerCase();
  if (isClosedMobileMeasurementBatchStatus(status)) {
    return { label: "Geschlossen", className: "mobile-batch-status-closed" };
  }
  if (isReviewedMobileMeasurementBatchStatus(status)) {
    return { label: "Geprüft", className: "mobile-batch-status-reviewed" };
  }
  if (isCustomerSignedMobileMeasurementBatch(batch)) {
    return { label: "Unterschrieben", className: "mobile-batch-status-signed" };
  }
  if (isSubmittedMobileMeasurementBatchStatus(status) || batch.submitted_at) {
    return { label: "Eingereicht", className: "mobile-batch-status-submitted" };
  }
  return { label: "Entwurf", className: "mobile-batch-status-draft" };
}

function getCustomerSignatureActionState(batch: MobileMeasurementBatch): { disabled: boolean; hint: string | null } {
  if (batch.available_actions) {
    return {
      disabled: !batch.available_actions.can_customer_sign,
      hint: batch.block_reasons?.customer_sign ?? null,
    };
  }
  if (isCustomerSignedMobileMeasurementBatch(batch)) {
    return { disabled: false, hint: null };
  }
  if (!hasMobileMeasurementBatchContent(batch)) {
    return {
      disabled: true,
      hint: "Für die Kundenunterschrift muss mindestens eine Aufmaßzeile erfasst sein.",
    };
  }

  const status = batch.status.toLowerCase();
  if (["approved", "billed", "checked", "closed"].includes(status)) {
    return {
      disabled: true,
      hint: "Dieses Aufmaß ist bereits intern erledigt.",
    };
  }
  if (status === "reviewed") {
    return { disabled: false, hint: null };
  }
  return {
    disabled: true,
    hint: "Kundenunterschrift ist erst nach Projektleiterprüfung möglich.",
  };
}

function hasMobileMeasurementBatchContent(batch: MobileMeasurementBatch): boolean {
  return batch.entry_count > 0 || (batch.area_rows?.length ?? 0) > 0;
}

function getCompactCustomerSignatureHint(hint: string | null): string | null {
  if (!hint) {
    return null;
  }
  if (hint.includes("mindestens eine Aufmaßzeile")) {
    return "Prüfung durch Projektleiter erforderlich.";
  }
  if (hint.includes("Projektleiterprüfung")) {
    return "Prüfung durch Projektleiter erforderlich.";
  }
  if (hint.includes("intern erledigt")) {
    return "Bereits intern erledigt.";
  }
  return hint;
}

function formatMobileMeasurementBatchDate(batch: MobileMeasurementBatch): string {
  const status = batch.status.toLowerCase();
  const dateValue = isCustomerSignedMobileMeasurementBatch(batch)
    ? batch.customer_signed_at
    : isReviewedMobileMeasurementBatchStatus(status)
    ? batch.updated_at
    : batch.submitted_at || batch.created_at;
  return formatMobileDateValue(dateValue);
}

function formatMobileDateValue(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parsed);
}

function formatDateTimeLabel(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

async function prepareMeasurementPhotoFile(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/heic" || file.type === "image/heif") {
    return file;
  }
  try {
    const startedAt = performance.now();
    const bitmap = await createImageBitmap(file);
    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return file;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY);
    });
    if (!blob) {
      return file;
    }
    console.info("Document photo optimized", {
      bytesBefore: file.size,
      bytesAfter: blob.size,
      dimensionsBefore: `${originalWidth}x${originalHeight}`,
      dimensionsAfter: `${width}x${height}`,
      durationMs: Math.round(performance.now() - startedAt),
    });
    const baseName = file.name.replace(/\.[^.]+$/, "") || "aufmass-foto";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

function isReviewedMobileMeasurementBatchStatus(status: string): boolean {
  return ["approved", "billed", "reviewed", "checked", "closed"].includes(status);
}

function isClosedMobileMeasurementBatchStatus(status: string): boolean {
  return ["approved", "billed", "checked", "closed"].includes(status);
}

function isSubmittedMobileMeasurementBatchStatus(status: string): boolean {
  return ["submitted", "in_review", "rejected"].includes(status);
}

function isCustomerSignedMobileMeasurementBatch(batch: MobileMeasurementBatch): boolean {
  return Boolean(batch.customer_signed_at || batch.customer_signature_name || batch.is_locked_for_worker);
}

function canEditMobileExtraWorkContent(order: MobileExtraWorkTicket): boolean {
  const status = (order.status || "").trim().toLowerCase();
  const completedStatuses = [
    "billed",
    "approved",
    "closed",
    "completed",
    "finalized",
    "abgeschlossen",
  ];
  return !order.deleted_at
    && !order.customer_signed_at
    && !["signed", "customer_signed", ...completedStatuses].includes(status);
}

function canEditExtraWorkPhotoCaption(order: MobileExtraWorkTicket): boolean {
  return canEditMobileExtraWorkContent(order);
}

function mobileStatusLabel(status: string): string {
  if (["approved", "billed", "edited"].includes(status)) {
    return "Erfasst";
  }
  return "Offen";
}

function isMobileMeasurementItemCaptured(item: MobileMeasurementItem): boolean {
  const reportedQuantity = Number(item.reported_quantity);
  return item.entries.length > 0 || (Number.isFinite(reportedQuantity) && reportedQuantity !== 0);
}
