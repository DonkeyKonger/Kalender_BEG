import {
  ArrowLeft,
  CalendarClock,
  ChevronRight,
  ClipboardList,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Hammer,
  MapPin,
  Package,
  Plus,
  ReceiptText,
  Search,
  Send,
  UserRound,
} from "lucide-react";
import { FileOpener } from "@capacitor-community/file-opener";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { SiteStatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import { formatGermanDateKey, formatGermanDateKeyRange } from "../lib/formatters";
import { formatProjectDocumentMeta, getProjectDocumentKind, type ProjectDocumentKind } from "../lib/projectFiles";
import type { MobileAssignment, MobileAssignmentsResponse } from "../types/mobile";
import type { CustomerSignatureStroke, MeasurementEntry, MobileMeasurementBatch, MobileMeasurementItem, ProjectFolder, ProjectFolderDocumentItem, ProjectFolderDocumentList } from "../types/site";

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
type MeasurementViewMode = "list" | "table";
const PDF_MIN_ZOOM = 0.75;
const PDF_MAX_ZOOM = 2.5;
const PDF_RENDER_QUALITY_MULTIPLIER = 1.6;
const PDF_MAX_RENDER_PIXEL_RATIO = 3.5;
const PDF_MAX_CANVAS_PIXELS = 8_000_000;

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

const detailTabs: Array<{ key: MobileDetailTab; label: string; description: string; icon: typeof ClipboardList }> = [
  { key: "folders", label: "Ordner", description: "Projektordner und Dateien", icon: FolderOpen },
  { key: "measurement", label: "Aufmaß", description: "Pakete und Positionen erfassen", icon: ReceiptText },
  { key: "extra-work", label: "Stundenzettel", description: "Zusatzstunden erfassen", icon: FileText },
  { key: "tools", label: "Werkzeuge & Material", description: "Status später verfügbar", icon: Package },
];

export function MobileAssignmentDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { assignmentId } = useParams();
  const [activeTab, setActiveTab] = useState<MobileDetailTab | null>(null);
  const [isMeasurementEntryMode, setIsMeasurementEntryMode] = useState(false);

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

  const isOverviewFlow = activeTab === "overview";
  const isMeasurementFlow = activeTab === "measurement";
  const isFocusedEntry = isMeasurementFlow && isMeasurementEntryMode;

  function openOverview(): void {
    setActiveTab("overview");
    setIsMeasurementEntryMode(false);
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
      ) : !isMeasurementFlow ? (
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
                  className={activeTab === tab.key ? "is-active" : ""}
                  key={tab.key}
                  type="button"
                  onClick={() => {
                    setActiveTab(tab.key);
                    if (tab.key !== "measurement") {
                      setIsMeasurementEntryMode(false);
                    }
                  }}
                >
                  <Icon aria-hidden="true" size={16} />
                  <span>
                    <strong>{tab.label}</strong>
                    <small>{tab.description}</small>
                  </span>
                </button>
              );
            })}
          </div>
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
        <MobileExtraWorkPlaceholder
          assignment={assignment}
          onBack={() => setActiveTab(null)}
        />
      )}
      {activeTab === "tools" && <PlaceholderPanel icon={Hammer} text="Werkzeuge & Material wird später Wagen-, Werkzeug- und Materialinformationen anzeigen." />}
    </section>
  );
}

function MobileExtraWorkPlaceholder({
  assignment,
  onBack,
}: {
  assignment: MobileAssignment;
  onBack: () => void;
}) {
  return (
    <div className="mobile-detail-panel mobile-placeholder-panel">
      <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={17} />
        <span>Zurück</span>
      </button>
      <FileText aria-hidden="true" size={24} />
      <h2>Stundenzettel</h2>
      <p className="muted-text">{[assignment.site.site_number, assignment.site.name].filter(Boolean).join(" · ")}</p>
      <p>
        Diese Funktion wird vorbereitet. Später können hier Zusatzstunden zur Baustelle erfasst und als Zettel/PDF übergeben werden.
      </p>
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
                item={item}
                key={item.id || item.name}
                isOpening={openingItemId === item.id || (isLoadingNestedFolder && item.is_folder)}
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
  item,
  isOpening,
  onOpen,
}: {
  item: ProjectFolderDocumentItem;
  isOpening: boolean;
  onOpen: () => void;
}) {
  const content = (
    <>
      {item.is_folder ? <FolderOpen aria-hidden="true" size={18} /> : <FileText aria-hidden="true" size={18} />}
      <span>
        <strong>{item.name}</strong>
        <small>{formatProjectDocumentMeta(item, { includeFallbackType: false })}</small>
      </span>
      {!item.is_folder ? <ExternalLink aria-hidden="true" size={15} /> : null}
    </>
  );

  return (
    <button
      type="button"
      className="mobile-folder-card mobile-folder-file-card"
      disabled={isOpening}
      onClick={onOpen}
    >
      {content}
    </button>
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
  const [isOpeningPdf, setIsOpeningPdf] = useState(false);

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
    return (
      <>
        <MeasurementBatchOverview
          batch={selectedBatch}
          error={error}
          isSaving={isSaving}
          isOpeningPdf={isOpeningPdf}
          isItemsLoading={isItemsLoading}
          customerSignatureDisabled={customerSignatureAction.disabled}
          customerSignatureHint={customerSignatureHint}
          onBack={closeBatchOverview}
          onOpenPdf={() => void openMeasurementBatchPdf(selectedBatch)}
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
            onClose={() => setSignatureBatch(null)}
            onSigned={mergeUpdatedBatch}
          />
        ) : null}
        {workerSignatureBatch ? (
          <WorkerSignatureOverlay
            batch={workerSignatureBatch}
            workerName={assignment.person.display_name}
            onClose={() => setWorkerSignatureBatch(null)}
          />
        ) : null}
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
  customerSignatureDisabled,
  customerSignatureHint,
  onBack,
  onOpenPdf,
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
  customerSignatureDisabled: boolean;
  customerSignatureHint: string | null;
  onBack: () => void;
  onOpenPdf: () => void;
  onCustomerSignature: () => void;
  onWorkerSignature: () => void;
  onOpenPositions: () => void;
  onSubmit: () => void;
}) {
  const isDraft = batch.status === "draft";
  const statusBadge = getMobileMeasurementBatchStatusBadge(batch);
  const displayDate = formatMobileMeasurementBatchDate(batch);
  const canSubmit = isDraft && !isSaving && batch.entry_count > 0 && !batch.is_locked_for_worker;
  return (
    <div className="mobile-detail-panel mobile-measurement-panel">
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
          <span>{isItemsLoading ? "Positionen laden..." : "Positionen bearbeiten"}</span>
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
      </div>
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
  onClose,
  onSigned,
}: {
  assignmentId: number;
  batch: MobileMeasurementBatch;
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
  batch,
  workerName,
  onClose,
}: {
  batch: MobileMeasurementBatch;
  workerName: string;
  onClose: () => void;
}) {
  const [signerName, setSignerName] = useState(workerName);
  const [strokes, setStrokes] = useState<CustomerSignatureStroke[]>([]);
  const [signatureError, setSignatureError] = useState<string | null>(null);
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

  function handleSaveSignature(): void {
    if (!signerName.trim()) {
      setSignatureError("Bitte Monteurnamen eintragen.");
      return;
    }
    if (!hasSignature) {
      setSignatureError("Bitte Unterschrift erfassen.");
      return;
    }
    setSignatureError("Monteursunterschrift kann noch nicht gespeichert werden.");
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
            >
              Leeren
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={handleSaveSignature}
              disabled={!signerName.trim() || !hasSignature}
            >
              Speichern
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
    return "Erst Position erfassen.";
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
