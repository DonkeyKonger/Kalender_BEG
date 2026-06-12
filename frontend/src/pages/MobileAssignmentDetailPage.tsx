import {
  ArrowLeft,
  Camera,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Hammer,
  Images,
  MapPin,
  Mail,
  Package,
  Pencil,
  Plus,
  ReceiptText,
  Search,
  Send,
  UserRound,
  X,
} from "lucide-react";
import { FileOpener } from "@capacitor-community/file-opener";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent as ReactChangeEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { SiteStatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import { formatGermanDateKey, formatGermanDateKeyRange } from "../lib/formatters";
import { formatProjectDocumentMeta, getProjectDocumentKind, type ProjectDocumentKind } from "../lib/projectFiles";
import type { MobileAssignment, MobileAssignmentsResponse } from "../types/mobile";
import type { CustomerSignatureStroke, ExtraWorkTicketEmailSendResponse, MeasurementEntry, MobileExtraWorkTicket, MobileExtraWorkTicketEntry, MobileExtraWorkTicketPhoto, MobileMeasurementBatch, MobileMeasurementBatchPhoto, MobileMeasurementItem, ProjectFolder, ProjectFolderDocumentItem, ProjectFolderDocumentList, SiteEmailRecipient } from "../types/site";

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

type MobileDetailTab = "overview" | "folders" | "measurement" | "extra-work" | "tools";
type MobileDetailActionKey = MobileDetailTab | "timesheet";
type MeasurementViewMode = "list" | "table";
const PDF_MIN_ZOOM = 0.75;
const PDF_MAX_ZOOM = 2.5;
const PDF_RENDER_QUALITY_MULTIPLIER = 1.6;
const PDF_MAX_RENDER_PIXEL_RATIO = 3.5;
const PDF_MAX_CANVAS_PIXELS = 8_000_000;
const MOBILE_DOCUMENT_PHOTO_LIMIT = 5;
const MAX_PHOTO_DIMENSION = 1600;
const PHOTO_JPEG_QUALITY = 0.8;

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

const MEASUREMENT_VIEW_MODE_STORAGE_KEY = "beg_aufmass_view_mode";
const EXTRA_WORK_WEEK_DAYS = [
  { key: "monday_hours", label: "Mo" },
  { key: "tuesday_hours", label: "Di" },
  { key: "wednesday_hours", label: "Mi" },
  { key: "thursday_hours", label: "Do" },
  { key: "friday_hours", label: "Fr" },
  { key: "saturday_hours", label: "Sa" },
  { key: "sunday_hours", label: "So" },
] as const;
type ExtraWorkWeekdayKey = (typeof EXTRA_WORK_WEEK_DAYS)[number]["key"];
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
        <button className="icon-button secondary mobile-back-button" type="button" onClick={() => navigate("/me/assignments")}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Zurück</span>
        </button>
        <div className="empty-panel">Dieser Einsatz konnte nicht aus dem lokalen Verlauf geladen werden.</div>
      </section>
    );
  }

  const currentAssignment = assignment;
  const isOverviewFlow = activeTab === "overview";
  const isFoldersFlow = activeTab === "folders";
  const isMeasurementFlow = activeTab === "measurement";
  const isExtraWorkFlow = activeTab === "extra-work";
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
      ) : !isMeasurementFlow && !isExtraWorkFlow ? (
        <>
          <button className="icon-button secondary mobile-back-button" type="button" onClick={() => navigate("/me/assignments")}>
            <ArrowLeft aria-hidden="true" size={17} />
            <span>Zurück</span>
          </button>

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
          {activeTab === null ? <MobileProjectPhotoCapture assignment={assignment} /> : null}
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
          order={selectedOrder}
          onBack={() => setIsEditingEntry(false)}
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
                className="mobile-measurement-card"
                key={order.id}
                type="button"
                onClick={() => {
                  setSelectedOrder(order);
                  setIsEditingEntry(false);
                  setMessage(null);
                }}
              >
                <span className={`measurement-status ${statusBadge.className}`}>{statusBadge.label}</span>
                <span className="mobile-measurement-card-date">{formatMobileExtraWorkKindLabel(order.kind)}</span>
                <strong>{formatMobileExtraWorkOrderTitle(order)}</strong>
                <span className="mobile-measurement-card-date">Datum: {formatMobileExtraWorkOrderDate(order)}</span>
                <span className="mobile-measurement-card-meta">
                  <span>Stunden: {formatExtraWorkHours(order.total_hours)}</span>
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
  onEmailRecipientsSaved,
  onEmailSent,
  onWorkerSigned,
  onSubmit,
}: {
  assignmentId: number;
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
  const emailSendPrerequisitesMet = emailRecipients.length > 0 && hasCustomerSignature && hasWorkerSignature;
  const emailSendHint = getExtraWorkEmailSendHint({
    hasRecipients: emailRecipients.length > 0,
    hasCustomerSignature,
    hasWorkerSignature,
    isLoadingRecipients: isLoadingEmailRecipients,
  });

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

      <button
        className={`mobile-measurement-summary-card mobile-extra-work-title-card${canRename ? " is-editable" : " is-locked"}`}
        type="button"
        onClick={() => {
          if (canRename) {
            setIsRenaming(true);
          }
        }}
        aria-label={canRename ? "Stundenzettel benennen" : "Stundenzettel-Name gesperrt"}
      >
        <span className={`measurement-status ${statusBadge.className}`}>{statusBadge.label}</span>
        <span className="mobile-measurement-card-date">{kindLabel}</span>
        <span className="mobile-extra-work-title-line">
          <h2>{formatMobileExtraWorkOrderTitle(order)}</h2>
          {canRename ? <Pencil aria-hidden="true" size={15} /> : null}
        </span>
        <span className="mobile-measurement-card-date">Datum: {formatMobileExtraWorkOrderDate(order)}</span>
        <span className="mobile-measurement-card-meta">
          <span>Stunden: {formatExtraWorkHours(order.total_hours)}</span>
          {isApproval && order.estimated_hours !== null && order.estimated_hours !== undefined ? (
            <span>Vorgabe: {formatExtraWorkHours(order.estimated_hours)}</span>
          ) : null}
        </span>
      </button>
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
          className="mobile-measurement-overview-action"
          type="button"
          onClick={() => {
            setEmailSendError(null);
            setIsConfirmingEmailSend(true);
          }}
          disabled={!emailSendPrerequisitesMet || isSendingEmail || isLoadingEmailRecipients}
        >
          <Mail aria-hidden="true" size={18} />
          <span>{isSendingEmail ? "Wird gesendet..." : "Per E-Mail senden"}</span>
        </button>
        {emailSendHint ? <p className="mobile-measurement-action-hint">{emailSendHint}</p> : null}
        {emailSendError ? <p className="form-error">{emailSendError}</p> : null}
        <button className="mobile-measurement-overview-action" type="button" onClick={onOpenPhotos}>
          <Images aria-hidden="true" size={18} />
          <span>Hinterlegte Fotos{order.photo_count ? ` (${order.photo_count})` : ""}</span>
        </button>
      </div>
      {isPhotoLimitReached ? (
        <p className="mobile-measurement-action-hint">Maximal 5 Fotos pro Stundenzettel erlaubt.</p>
      ) : null}
      {message ? <p className={messageTone === "error" ? "form-error" : "form-info"}>{message}</p> : null}
      <MobileCameraButton
        className="mobile-measurement-camera-button"
        disabled={isUploadingPhoto || isPhotoLimitReached}
        label="Foto aufnehmen"
        onClick={onTakePhoto}
      />
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
        <ExtraWorkEmailSendDialog
          filename={emailPdfFilename}
          isSending={isSendingEmail}
          order={order}
          recipients={emailRecipients}
          error={emailSendError}
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
    <div className="mobile-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="mobile-extra-work-title-dialog"
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

function ExtraWorkEmailSendDialog({
  order,
  recipients,
  filename,
  isSending,
  error,
  onClose,
  onConfirm,
}: {
  order: MobileExtraWorkTicket;
  recipients: SiteEmailRecipient[];
  filename: string;
  isSending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mobile-dialog-backdrop" role="presentation" onClick={isSending ? undefined : onClose}>
      <div
        className="mobile-project-email-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-extra-work-email-send-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mobile-project-email-dialog-head">
          <h2 id="mobile-extra-work-email-send-title">Stundenzettel senden?</h2>
          <p>Der aktuelle {formatMobileExtraWorkKindLabel(order.kind)} wird als vollständige PDF an die ausgewählten Kundenempfänger gesendet.</p>
        </div>

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

  function addEmail(): void {
    const normalizedEmail = normalizeProjectRecipientEmail(newEmail);
    if (!normalizedEmail) {
      setError("Bitte eine E-Mail-Adresse eingeben.");
      return;
    }
    if (!isValidProjectRecipientEmail(normalizedEmail)) {
      setError("E-Mail-Adresse ist nicht gültig.");
      return;
    }
    setError(null);
    setSuggestions((currentSuggestions) => (
      currentSuggestions.some((suggestion) => suggestion.email === normalizedEmail)
        ? currentSuggestions
        : [
          ...currentSuggestions,
          {
            id: null,
            email: normalizedEmail,
            label: null,
            source: "manual",
            is_selected: true,
            created_at: null,
            updated_at: null,
          },
        ]
    ));
    setSelectedEmails((currentEmails) => (
      currentEmails.includes(normalizedEmail) ? currentEmails : [...currentEmails, normalizedEmail]
    ));
    setNewEmail("");
  }

  async function saveRecipients(): Promise<void> {
    setIsSaving(true);
    setError(null);
    try {
      const recipients = selectedEmails.map((email) => {
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
    <div className="mobile-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="mobile-project-email-dialog"
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
              <button className="secondary-action" type="button" onClick={addEmail}>
                Hinzufügen
              </button>
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
  const [customerPlace, setCustomerPlace] = useState(activeOrder.customer_signature_place ?? "");
  const [strokes, setStrokes] = useState<CustomerSignatureStroke[]>([]);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [isSavingSignature, setIsSavingSignature] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const isSigned = Boolean(activeOrder.customer_signed_at);
  const hasSignature = strokes.some((stroke) => stroke.length >= 2);

  useEffect(() => {
    setActiveOrder(order);
    setCustomerName(order.customer_signature_name ?? "");
    setCustomerPlace(order.customer_signature_place ?? "");
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
        customer_place: customerPlace.trim() || null,
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
    <div className="mobile-customer-signature-overlay" role="dialog" aria-modal="true" aria-label="Kundenunterschrift">
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
          <label>
            <span>Ort</span>
            <input
              value={customerPlace}
              onChange={(event) => setCustomerPlace(event.target.value)}
              placeholder="Ort der Unterschrift"
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
    <div className="mobile-dialog-backdrop" role="presentation" onClick={isSavingSignature ? undefined : onClose}>
      <div
        className="mobile-project-email-dialog mobile-worker-signature-dialog"
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
} & Record<ExtraWorkWeekdayKey, string>;

type ExtraWorkEntryFormState = {
  component: string;
  floor: string;
  room_number: string;
  axis: string;
  remarks: string;
  material_text: string;
  estimated_hours: string;
  worker_rows: ExtraWorkWorkerHoursFormRow[];
};

function ExtraWorkEntryPage({
  assignmentId,
  assignmentPerson,
  order,
  onBack,
  onSaved,
}: {
  assignmentId: number;
  assignmentPerson: MobileAssignment["person"];
  order: MobileExtraWorkTicket;
  onBack: () => void;
  onSaved: () => Promise<void>;
}) {
  const { user } = useAuth();
  const isApproval = order.kind === "approval";
  const kindLabel = formatMobileExtraWorkKindLabel(order.kind);
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

  useEffect(() => {
    let isMounted = true;
    async function loadEntry(): Promise<void> {
      setIsLoading(true);
      setError(null);
      try {
        const entry = await api.mobileExtraWorkTicketEntry(assignmentId, order.id);
        if (isMounted) {
          setForm(entry ? mapExtraWorkEntryToForm(entry, defaultWorkerName, legacyWorkerNames) : createEmptyExtraWorkEntryForm(defaultWorkerName));
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

  const totalHours = useMemo(
    () => form.worker_rows.reduce((sum, row) => sum + calculateExtraWorkWorkerTotal(row), 0),
    [form.worker_rows],
  );

  function updateField(key: keyof Omit<ExtraWorkEntryFormState, "worker_rows">, value: string): void {
    setForm((current) => ({ ...current, [key]: value }));
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

  async function saveEntry(): Promise<void> {
    setError(null);
    const component = form.component.trim();
    const floor = form.floor.trim();
    const workerRows = form.worker_rows
      .map((row) => ({
        worker_name: row.worker_name.trim(),
        monday_hours: parseExtraWorkHoursInput(row.monday_hours),
        tuesday_hours: parseExtraWorkHoursInput(row.tuesday_hours),
        wednesday_hours: parseExtraWorkHoursInput(row.wednesday_hours),
        thursday_hours: parseExtraWorkHoursInput(row.thursday_hours),
        friday_hours: parseExtraWorkHoursInput(row.friday_hours),
        saturday_hours: parseExtraWorkHoursInput(row.saturday_hours),
        sunday_hours: parseExtraWorkHoursInput(row.sunday_hours),
      }))
      .filter((row) => row.worker_name || calculateExtraWorkPayloadWorkerTotal(row) > 0);
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
        estimated_hours: isApproval ? parseNullableExtraWorkHoursInput(form.estimated_hours) : null,
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
    <div className="mobile-measurement-entry-page mobile-extra-work-entry-page">
      <div className="mobile-measurement-detail-topbar">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>{kindLabel}</span>
        </button>
      </div>

      <header className="mobile-entry-head">
        <p className="eyebrow">{kindLabel}</p>
        <h1>{isApproval ? "Stundenfreigabe erfassen" : "Leistungen erfassen"}</h1>
        <p>{formatMobileExtraWorkOrderTitle(order)}</p>
      </header>

      {isLoading ? <div className="empty-panel">Eingaben werden geladen...</div> : null}
      {error ? <div className="form-error">{error}</div> : null}

      {!isLoading ? (
        <form
          className="mobile-measurement-form mobile-measurement-entry-form mobile-extra-work-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveEntry();
          }}
        >
          <div className="mobile-measurement-form-grid">
            <label>
              <span>Bauteil</span>
              <input value={form.component} onChange={(event) => updateField("component", event.target.value)} required />
            </label>
            <label>
              <span>Etage</span>
              <input value={form.floor} onChange={(event) => updateField("floor", event.target.value)} required />
            </label>
            <label>
              <span>Raum Nr.</span>
              <input value={form.room_number} onChange={(event) => updateField("room_number", event.target.value)} />
            </label>
            <label>
              <span>Achse</span>
              <input value={form.axis} onChange={(event) => updateField("axis", event.target.value)} />
            </label>
            {isApproval ? (
              <label>
                <span>Stundenvorgabe / geschätzt</span>
                <input
                  inputMode="decimal"
                  value={form.estimated_hours}
                  onChange={(event) => updateField("estimated_hours", event.target.value)}
                  placeholder="z. B. 12,5"
                />
              </label>
            ) : null}
          </div>

          <section className="mobile-extra-work-section">
            <div className="mobile-extra-work-section-head">
              <div>
                <h2>Monteure und Stunden</h2>
                <p>Montag bis Sonntag</p>
              </div>
              <strong>{formatExtraWorkHours(totalHours)} h</strong>
            </div>
            <div className="mobile-extra-work-worker-list">
              {form.worker_rows.map((row, index) => (
                <article className="mobile-extra-work-worker-card" key={row.id}>
                  <div className="mobile-extra-work-worker-head">
                    <label>
                      <span>Name des Monteurs</span>
                      <input
                        value={row.worker_name}
                        onChange={(event) => updateWorkerRow(row.id, "worker_name", event.target.value)}
                        required
                      />
                    </label>
                    {form.worker_rows.length > 1 ? (
                      <button className="mobile-extra-work-remove-worker" type="button" onClick={() => removeWorkerRow(row.id)} aria-label={`Monteur ${index + 1} entfernen`}>
                        <X aria-hidden="true" size={16} />
                      </button>
                    ) : null}
                  </div>
                  <div className="mobile-extra-work-week-grid">
                    {EXTRA_WORK_WEEK_DAYS.map((day) => (
                      <label key={day.key}>
                        <span>{day.label}</span>
                        <input
                          inputMode="decimal"
                          value={row[day.key]}
                          onChange={(event) => updateWorkerRow(row.id, day.key, event.target.value)}
                          placeholder="0"
                        />
                      </label>
                    ))}
                  </div>
                  <p className="mobile-extra-work-worker-total">Summe: {formatExtraWorkHours(calculateExtraWorkWorkerTotal(row))} h</p>
                </article>
              ))}
            </div>
            <button className="secondary-action mobile-extra-work-add-worker" type="button" onClick={addWorkerRow}>
              <Plus aria-hidden="true" size={15} />
              <span>Monteur hinzufügen</span>
            </button>
          </section>

          <label>
            <span>Bemerkungen / ausgeführte Arbeiten</span>
            <textarea value={form.remarks} onChange={(event) => updateField("remarks", event.target.value)} rows={4} />
          </label>
          <label>
            <span>Material</span>
            <textarea value={form.material_text} onChange={(event) => updateField("material_text", event.target.value)} rows={3} />
          </label>

          <div className="mobile-form-actions">
            <button className="primary-action" type="submit" disabled={isSaving}>
              {isSaving ? "Speichert..." : "Speichern"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function OverviewPanel({ assignment }: { assignment: MobileAssignment }) {
  return (
    <div className="mobile-detail-panel">
      <h2>Übersicht</h2>
      <div className="assignment-detail-list">
        {(assignment.site.location || assignment.site.address) && (
          <p><MapPin aria-hidden="true" size={16} /><span>{[assignment.site.location, assignment.site.address].filter(Boolean).join(" - ")}</span></p>
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

function MobileProjectPhotoCapture({ assignment }: { assignment: MobileAssignment }) {
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
      <MobileCameraButton
        className="mobile-project-camera-button"
        disabled={isUploadingProjectPhoto}
        label="Projektfoto aufnehmen"
        onClick={openProjectPhotoCapture}
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
  return (
    <section className="mobile-document-preview" role="dialog" aria-modal="true" aria-label="Dokumentenvorschau">
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
  const [viewMode, setViewMode] = useState<MeasurementViewMode>(() => readMeasurementViewMode());
  const [signatureBatch, setSignatureBatch] = useState<MobileMeasurementBatch | null>(null);
  const [workerSignatureBatch, setWorkerSignatureBatch] = useState<MobileMeasurementBatch | null>(null);
  const [photoGalleryBatch, setPhotoGalleryBatch] = useState<MobileMeasurementBatch | null>(null);
  const [photoUploadBatch, setPhotoUploadBatch] = useState<MobileMeasurementBatch | null>(null);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  const [photoMessageTone, setPhotoMessageTone] = useState<"info" | "error">("info");
  const [photoGalleryVersion, setPhotoGalleryVersion] = useState(0);
  const [isOpeningPdf, setIsOpeningPdf] = useState(false);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

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

  function updateViewMode(mode: MeasurementViewMode): void {
    setViewMode(mode);
    persistMeasurementViewMode(mode);
  }

  function closeBatchOverview(): void {
    setSelectedBatch(null);
    setSelectedItem(null);
    setIsBatchPositionOverviewOpen(false);
    setItems([]);
    setError(null);
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

  useEffect(() => {
    onEntryModeChange?.(Boolean(selectedBatch && selectedItem));
    return () => onEntryModeChange?.(false);
  }, [onEntryModeChange, selectedBatch, selectedItem]);

  if (selectedBatch && selectedItem) {
    return (
      <MeasurementDetail
        batch={selectedBatch}
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
          const quantity = Number(formQuantity.replace(",", "."));
          const normalizedArea = normalizeMeasurementArea(formComment);
          if (!Number.isFinite(quantity) || quantity <= 0) {
            setFormError("Bitte eine gültige Menge größer 0 eingeben.");
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
    const canSignImmediately = Boolean(assignment.person.can_sign_measurements_immediately);
    const customerSignatureAction = getCustomerSignatureActionState(selectedBatch, canSignImmediately);
    const customerSignatureHint = getCompactCustomerSignatureHint(customerSignatureAction.hint);
    if (photoGalleryBatch) {
      return (
        <>
          <MeasurementPhotoGallery
            assignmentId={assignment.id}
            batch={photoGalleryBatch}
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
          batch={selectedBatch}
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
            signaturePlace={formatMobileSignatureLocation(assignment.site)}
            onClose={() => setSignatureBatch(null)}
            onSigned={mergeUpdatedBatch}
          />
        ) : null}
        {workerSignatureBatch ? (
          <WorkerSignatureOverlay
            assignmentId={assignment.id}
            batch={workerSignatureBatch}
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
      <MeasurementBatchDetail
        batch={selectedBatch}
        items={filteredItems}
        allItems={items}
        isItemsLoading={isItemsLoading}
        error={error}
        searchTerm={searchTerm}
        onBack={() => {
          setIsBatchPositionOverviewOpen(false);
          setSelectedItem(null);
          setError(null);
        }}
        viewMode={viewMode}
        onViewModeChange={updateViewMode}
        onSearchChange={setSearchTerm}
        onSelectItem={(item) => {
          setSelectedItem(item);
          setFormComment("");
          setFormQuantity("");
          setFormError(null);
        }}
      />
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
                className={batch.is_current_offer ? "mobile-measurement-card" : "mobile-measurement-card is-old-offer"}
                key={batch.id}
                type="button"
                onClick={() => {
                  setSelectedBatch(batch);
                  setIsBatchPositionOverviewOpen(false);
                  void loadBatchItems(batch);
                }}
              >
                <span className={`measurement-status ${statusBadge.className}`}>{statusBadge.label}</span>
                <strong>{formatMobileMeasurementBatchTitle(batch)}</strong>
                <span className="mobile-measurement-card-date">Datum: {displayDate}</span>
                <span className="mobile-measurement-card-meta">
                  <span>Positionen: {batch.position_count}</span>
                  <span>Stunden: {formatMeasurementNumber(batch.reported_hours)}</span>
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
  batch,
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
  batch: MobileMeasurementBatch;
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
        <span className={`measurement-status ${statusBadge.className}`}>{statusBadge.label}</span>
        <h2>{formatMobileMeasurementBatchTitle(batch)}</h2>
        <span className="mobile-measurement-card-date">Datum: {displayDate}</span>
        <span className="mobile-measurement-card-meta">
          <span>Positionen: {batch.position_count}</span>
          <span>Stunden: {formatMeasurementNumber(batch.reported_hours)}</span>
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
        <button className="mobile-measurement-overview-action" type="button" onClick={onCustomerSignature} disabled={customerSignatureDisabled}>
          <UserRound aria-hidden="true" size={18} />
          <span>Kundenunterschrift einfügen</span>
        </button>
        {customerSignatureHint ? <p className="mobile-measurement-action-hint">{customerSignatureHint}</p> : null}
        <button className="mobile-measurement-overview-action" type="button" onClick={onWorkerSignature}>
          <UserRound aria-hidden="true" size={18} />
          <span>Monteursunterschrift einfügen</span>
        </button>
        <button className="mobile-measurement-overview-action" type="button" onClick={onOpenPhotos}>
          <Images aria-hidden="true" size={18} />
          <span>Hinterlegte Fotos{batch.photo_count ? ` (${batch.photo_count})` : ""}</span>
        </button>
      </div>
      {isPhotoLimitReached ? (
        <p className="mobile-measurement-action-hint">Maximal 5 Fotos pro Aufmaß erlaubt.</p>
      ) : null}
      {photoMessage ? <p className={photoMessageTone === "error" ? "form-error" : "form-info"}>{photoMessage}</p> : null}
      <MobileCameraButton
        className="mobile-measurement-camera-button"
        disabled={isUploadingPhoto || isPhotoLimitReached}
        label="Foto aufnehmen"
        onClick={onTakePhoto}
      />
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
  refreshKey,
  isUploadingPhoto,
  onBack,
  onPhotoCountChange,
  onTakePhoto,
  photoLimit,
}: {
  assignmentId: number;
  batch: MobileMeasurementBatch;
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
        <p>{formatMobileMeasurementBatchTitle(batch)}</p>
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
        <div className="mobile-photo-preview-backdrop" role="presentation" onClick={() => setSelectedPhoto(null)}>
          <figure className="mobile-photo-preview" onClick={(event) => event.stopPropagation()}>
            <img alt={selectedPhoto.photo.filename} src={selectedPhoto.url} />
            <figcaption>
              <strong>{selectedPhoto.photo.filename}</strong>
              <span>{formatDateTimeLabel(selectedPhoto.photo.created_at)}</span>
            </figcaption>
            <button className="secondary-action" type="button" onClick={() => setSelectedPhoto(null)}>Schließen</button>
          </figure>
        </div>
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
        <div className="mobile-photo-preview-backdrop" role="presentation" onClick={() => setSelectedPhoto(null)}>
          <figure className="mobile-photo-preview" onClick={(event) => event.stopPropagation()}>
            <img alt={selectedPhoto.photo.filename} src={selectedPhoto.url} />
            <figcaption>
              <strong>{selectedPhoto.photo.filename}</strong>
              <span>{formatDateTimeLabel(selectedPhoto.photo.created_at)}</span>
            </figcaption>
            <button className="secondary-action" type="button" onClick={() => setSelectedPhoto(null)}>Schließen</button>
          </figure>
        </div>
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
  onViewModeChange,
  onSearchChange,
  onSelectItem,
}: {
  batch: MobileMeasurementBatch;
  items: MobileMeasurementItem[];
  allItems: MobileMeasurementItem[];
  isItemsLoading: boolean;
  error: string | null;
  searchTerm: string;
  viewMode: MeasurementViewMode;
  onBack: () => void;
  onViewModeChange: (mode: MeasurementViewMode) => void;
  onSearchChange: (value: string) => void;
  onSelectItem: (item: MobileMeasurementItem) => void;
}) {
  return (
    <div className="mobile-detail-panel mobile-measurement-panel">
      <div className="mobile-measurement-detail-topbar">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Aufmaß</span>
        </button>
      </div>
      {batch.is_locked_for_worker ? (
        <p className="form-info">Dieses Aufmaß wurde vom Kunden unterschrieben und ist für Monteure gesperrt.</p>
      ) : null}

      <div className="mobile-measurement-search">
        <Search aria-hidden="true" size={17} />
        <input
          type="search"
          placeholder="Position oder Leistung suchen..."
          value={searchTerm}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>

      <div className="mobile-measurement-view-actions">
        <MeasurementViewToggle viewMode={viewMode} onChange={onViewModeChange} />
      </div>

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
          {items.map((item) => {
            const isCaptured = isMobileMeasurementItemCaptured(item);
            return (
              <button
                className={isCaptured ? "mobile-measurement-card is-captured-position" : "mobile-measurement-card is-empty-position"}
                key={item.id}
                type="button"
                onClick={() => onSelectItem(item)}
              >
                <div className="mobile-measurement-row-top">
                  <strong className="mobile-measurement-row-position">{item.position}</strong>
                  <strong className="mobile-measurement-row-quantity">{formatMeasurementNumber(item.reported_quantity)} {item.unit ?? ""}</strong>
                </div>
                <span className="mobile-measurement-row-description">{item.description}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {!isItemsLoading && !error && items.length > 0 && viewMode === "table" ? (
        <MobileMeasurementTable items={items} onSelectItem={onSelectItem} />
      ) : null}
    </div>
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

function MobileMeasurementTable({
  items,
  onSelectItem,
}: {
  items: MobileMeasurementItem[];
  onSelectItem: (item: MobileMeasurementItem) => void;
}) {
  const areaRows = collectMeasurementAreaTags(items);

  return (
    <div className="mobile-measurement-table-wrap" role="region" aria-label="Tabellarische Aufmaßaufstellung">
      <table className="measurement-table-view measurement-matrix-table mobile-measurement-table">
        <thead>
          <tr>
            <th className="measurement-matrix-axis">Pos.-Nr.</th>
            {items.map((item) => (
              <th className="measurement-matrix-position-heading" key={item.id}>
                <button className="measurement-matrix-header-button" type="button" onClick={() => onSelectItem(item)}>
                  {item.position}
                </button>
              </th>
            ))}
          </tr>
          <tr>
            <th className="measurement-matrix-axis">Beschreibung</th>
            {items.map((item) => (
              <th className="measurement-matrix-description-heading" key={item.id}>{item.description}</th>
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
            <tr key={area}>
              <th className="measurement-matrix-axis">{area}</th>
              {items.map((item) => {
                const quantity = getMobileMeasurementAreaQuantity(item, area);
                return (
                  <td className={quantity > 0 ? "measurement-matrix-quantity-cell" : "measurement-matrix-empty-cell"} key={item.id}>
                    <button className="measurement-matrix-cell-button" type="button" onClick={() => onSelectItem(item)}>
                      {quantity > 0 ? formatMeasurementNumber(quantity) : ""}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="measurement-matrix-total-row">
            <th className="measurement-matrix-axis">Gesamt</th>
            {items.map((item) => (
              <td className="measurement-matrix-quantity-cell" key={item.id}>
                <button className="measurement-matrix-cell-button" type="button" onClick={() => onSelectItem(item)}>
                  <strong>{formatMeasurementNumber(item.reported_quantity)}</strong>
                </button>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MeasurementDetail({
  batch,
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
          <h1>Pos. {item.position}</h1>
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
                        onCommentChange(area);
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
                onChange={(event) => onCommentChange(event.target.value)}
                placeholder="z. B. 1. OG"
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
            <span>{formatMeasurementNumber(area.quantity)} {item.unit ?? ""}</span>
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
          <span>Aufmaßnummer <strong>Aufmaß {batch.number}</strong></span>
          <span>Min/Einh. <strong>{formatMeasurementNumber(item.minutes_per_unit)}</strong></span>
          <span>Menge laut Angebot <strong>{formatMeasurementNumber(item.list_quantity)}</strong></span>
          <span>Menge nach Aufmaß <strong>{formatMeasurementNumber(measuredQuantity)}</strong></span>
        </div>
        <div className="mobile-measurement-detail-areas">
          <strong>Verbaute Orte:</strong>
          {measuredAreas.length > 0 ? measuredAreas.map((area) => (
            <span key={area.key}>
              <span>{area.label}:</span>
              <strong>{formatMeasurementNumber(area.quantity)} {item.unit ?? ""}</strong>
            </span>
          )) : <span>Noch keine Orte erfasst.</span>}
        </div>
      </details>
    </div>
  );
}

type MeasurementQuantityKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "," | "." | "backspace" | "clear";

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
    { key: "backspace", label: "Zurück", className: "is-muted", ariaLabel: "Letzte Ziffer entfernen" },
    { key: "clear", label: "Leeren", className: "is-muted is-wide", ariaLabel: "Menge leeren" },
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
  signaturePlace,
  onClose,
  onSigned,
}: {
  assignmentId: number;
  batch: MobileMeasurementBatch;
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
    <div className="mobile-customer-signature-overlay" role="dialog" aria-modal="true" aria-label="Kundenunterschrift">
      <header className="mobile-customer-signature-header">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onClose}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Zurück</span>
        </button>
        <div className="mobile-customer-signature-title">
          <strong>{formatMobileMeasurementBatchTitle(activeBatch)}</strong>
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
  workerName,
  onClose,
  onSigned,
}: {
  assignmentId: number;
  batch: MobileMeasurementBatch;
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
    <div className="mobile-customer-signature-overlay" role="dialog" aria-modal="true" aria-label="Monteursunterschrift">
      <header className="mobile-customer-signature-header">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={onClose}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Zurück</span>
        </button>
        <div className="mobile-customer-signature-title">
          <strong>{formatMobileMeasurementBatchTitle(batch)}</strong>
          <span>Monteursunterschrift erfassen</span>
        </div>
      </header>

      <main className="mobile-worker-signature-content">
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
              disabled={isSavingSignature || !signerName.trim() || !hasSignature}
            >
              {isSavingSignature ? "Speichert..." : "Speichern"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function getSignatureCanvasPoint(event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } | null {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    x: clampNumber((event.clientX - rect.left) / rect.width, 0, 1),
    y: clampNumber((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

function drawSignatureCanvas(canvas: HTMLCanvasElement | null, strokes: CustomerSignatureStroke[]): void {
  if (!canvas) {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * scale));
  const height = Math.max(1, Math.floor(rect.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.clearRect(0, 0, width, height);
  context.save();
  context.scale(scale, scale);
  context.lineWidth = 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#0f2747";
  for (const stroke of strokes) {
    if (stroke.length < 2) {
      continue;
    }
    const firstPoint = stroke[0];
    if (!firstPoint) {
      continue;
    }
    context.beginPath();
    context.moveTo(firstPoint.x * rect.width, firstPoint.y * rect.height);
    for (const point of stroke.slice(1)) {
      context.lineTo(point.x * rect.width, point.y * rect.height);
    }
    context.stroke();
  }
  context.restore();
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

function collectMeasurementAreaTags(items: MobileMeasurementItem[]): string[] {
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

  return sortMeasurementAreaLabels(tags);
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

function getMeasurementEntryQuantity(entry: MeasurementEntry): number {
  const quantity = typeof entry.quantity === "number" ? entry.quantity : Number(entry.quantity);
  return Number.isFinite(quantity) ? quantity : 0;
}

function applyMeasurementQuantityKey(value: string, key: MeasurementQuantityKey): string {
  const normalizedValue = value.replace(".", ",");

  if (key === "clear") {
    return "";
  }
  if (key === "backspace") {
    return normalizedValue.slice(0, -1);
  }
  if (key === "," || key === ".") {
    if (normalizedValue.includes(",")) {
      return normalizedValue;
    }
    return normalizedValue ? `${normalizedValue},` : "0,";
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

function getExtraWorkEmailSendHint({
  hasRecipients,
  hasCustomerSignature,
  hasWorkerSignature,
  isLoadingRecipients,
}: {
  hasRecipients: boolean;
  hasCustomerSignature: boolean;
  hasWorkerSignature: boolean;
  isLoadingRecipients: boolean;
}): string | null {
  if (isLoadingRecipients) {
    return "E-Mail-Empfänger werden geprüft.";
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
    estimated_hours: "",
    worker_rows: [createEmptyExtraWorkWorkerRow(workerName)],
  };
}

function createEmptyExtraWorkWorkerRow(workerName = ""): ExtraWorkWorkerHoursFormRow {
  return {
    id: createClientRowId(),
    worker_name: workerName,
    monday_hours: "",
    tuesday_hours: "",
    wednesday_hours: "",
    thursday_hours: "",
    friday_hours: "",
    saturday_hours: "",
    sunday_hours: "",
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
    estimated_hours: formatExtraWorkInputValue(entry.estimated_hours),
    worker_rows: entry.worker_rows.length > 0
      ? entry.worker_rows.map((row, index) => ({
        id: createClientRowId(),
        worker_name: normalizeExtraWorkWorkerName(row.worker_name, defaultWorkerName, legacyWorkerNames, index),
        monday_hours: formatExtraWorkInputValue(row.monday_hours),
        tuesday_hours: formatExtraWorkInputValue(row.tuesday_hours),
        wednesday_hours: formatExtraWorkInputValue(row.wednesday_hours),
        thursday_hours: formatExtraWorkInputValue(row.thursday_hours),
        friday_hours: formatExtraWorkInputValue(row.friday_hours),
        saturday_hours: formatExtraWorkInputValue(row.saturday_hours),
        sunday_hours: formatExtraWorkInputValue(row.sunday_hours),
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

function parseExtraWorkHoursInput(value: string): number {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) {
    return 0;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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

function formatExtraWorkHours(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "-";
  }
  return new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric);
}

function calculateExtraWorkWorkerTotal(row: ExtraWorkWorkerHoursFormRow): number {
  return EXTRA_WORK_WEEK_DAYS.reduce((sum, day) => sum + parseExtraWorkHoursInput(row[day.key]), 0);
}

function calculateExtraWorkPayloadWorkerTotal(row: Record<ExtraWorkWeekdayKey, number>): number {
  return EXTRA_WORK_WEEK_DAYS.reduce((sum, day) => sum + row[day.key], 0);
}

function formatMobileExtraWorkOrderDate(order: MobileExtraWorkTicket): string {
  const dateValue = order.status === "signed" || order.status === "reviewed"
    ? order.updated_at
    : order.submitted_at || order.created_at;
  return formatMobileDateValue(dateValue);
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

function sortMobileMeasurementBatches(batches: MobileMeasurementBatch[]): MobileMeasurementBatch[] {
  return [...batches].sort((left, right) => {
    const leftCreatedAt = Date.parse(left.created_at);
    const rightCreatedAt = Date.parse(right.created_at);
    const leftRank = Number.isFinite(leftCreatedAt) ? leftCreatedAt : left.id;
    const rightRank = Number.isFinite(rightCreatedAt) ? rightCreatedAt : right.id;
    return rightRank - leftRank || right.id - left.id;
  });
}

function formatMobileMeasurementBatchTitle(batch: MobileMeasurementBatch): string {
  const title = batch.title?.trim() || `Aufmaß ${batch.number}`;
  const offerName = batch.offer_name?.trim() || batch.measurement_base_name?.trim() || "Angebot ohne Namen";
  return `${title} - ${offerName}`;
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

function getMobileMeasurementPdfFilename(batch: MobileMeasurementBatch): string {
  return `${formatMobileMeasurementBatchTitle(batch).replace(/\s+/g, "_")}.pdf`;
}

function getMobileMeasurementBatchStatusBadge(batch: MobileMeasurementBatch): { label: string; className: string } {
  const status = batch.status.toLowerCase();
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

function getCustomerSignatureActionState(
  batch: MobileMeasurementBatch,
  canSignImmediately: boolean,
): { disabled: boolean; hint: string | null } {
  if (isCustomerSignedMobileMeasurementBatch(batch)) {
    return { disabled: false, hint: null };
  }
  if (batch.entry_count === 0) {
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
  if (canSignImmediately && ["draft", "submitted", "reviewed", "rejected"].includes(status)) {
    return { disabled: false, hint: null };
  }
  if (status === "reviewed") {
    return { disabled: false, hint: null };
  }
  return {
    disabled: true,
    hint: "Kundenunterschrift ist erst nach Projektleiterprüfung möglich.",
  };
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

function isSubmittedMobileMeasurementBatchStatus(status: string): boolean {
  return ["submitted", "in_review", "rejected"].includes(status);
}

function isCustomerSignedMobileMeasurementBatch(batch: MobileMeasurementBatch): boolean {
  return Boolean(batch.customer_signed_at || batch.customer_signature_name || batch.is_locked_for_worker);
}

function mobileStatusLabel(status: string): string {
  if (["approved", "billed", "edited"].includes(status)) {
    return "Erfasst";
  }
  return "Offen";
}

function isMobileMeasurementItemCaptured(item: MobileMeasurementItem): boolean {
  const reportedQuantity = Number(item.reported_quantity);
  return item.entries.length > 0 || (Number.isFinite(reportedQuantity) && reportedQuantity > 0);
}
