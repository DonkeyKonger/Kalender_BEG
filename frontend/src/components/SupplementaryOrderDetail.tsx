import { ArrowLeft, Download, ExternalLink, File as FileIcon, FileImage, FileText, LoaderCircle, LockKeyhole, Paperclip, Save, Trash2, UploadCloud, X } from "lucide-react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { ApiError, api } from "../lib/api";
import {
  EXTRA_WORK_PHOTO_ACCEPT,
  MAX_EXTRA_WORK_PHOTOS,
  getExtraWorkAttachmentKind,
  validateExtraWorkPhotoFiles,
} from "../lib/extraWorkAttachments";
import {
  EXTRA_WORK_CHECKBOX_RECTS,
  EXTRA_WORK_DAYS,
  EXTRA_WORK_PDF_FIELD_RECTS,
  EXTRA_WORK_PDF_HEIGHT,
  EXTRA_WORK_PDF_TEXTAREA_LAYOUTS,
  EXTRA_WORK_PDF_WIDTH,
  EXTRA_WORK_VISIBLE_WORKER_ROWS,
  buildExtraWorkDocumentPayload,
  chunkExtraWorkWorkerRows,
  createExtraWorkDocumentDraft,
  extraWorkPdfPointsToCqw,
  extraWorkPdfRectToPercent,
  getExtraWorkHourRect,
  getExtraWorkOverallHours,
  getExtraWorkRowTotalRect,
  getExtraWorkWorkerNameRect,
  getExtraWorkWorkerTierTotal,
  isExtraWorkDocumentLocked,
  type ExtraWorkDocumentDraft,
  type ExtraWorkDocumentDirtyField,
  type ExtraWorkHoursField,
  type ExtraWorkHoursTier,
  type ExtraWorkPdfRect,
  type ExtraWorkPdfTextareaLayout,
} from "../lib/extraWorkDocument";
import { containsDraggedFiles } from "../lib/fileDrag";
import { formatProjectFileSize } from "../lib/projectFiles";
import {
  SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_LEVELS,
  getSupplementaryOrderAutoFitWidth,
  getSupplementaryOrderFinalPaperWidth,
  normalizeSupplementaryOrderDocumentZoom,
  readSupplementaryOrderDocumentZoom,
  writeSupplementaryOrderDocumentZoom,
  type SupplementaryOrderDocumentZoom,
} from "../lib/supplementaryOrderZoom";
import {
  SIGNATURE_SVG_HEIGHT,
  SIGNATURE_SVG_WIDTH,
  drawSignatureCanvas,
  getNormalizedSignaturePoint,
  signatureStrokeToSvgPoints,
  validSignatureStrokes,
} from "../lib/signatureCanvas";
import type {
  CustomerSignatureStroke,
  ExtraWorkTicketDocumentRead,
  MobileExtraWorkTicket,
  MobileExtraWorkTicketPhoto,
  MobileExtraWorkWorkerHours,
  Site,
} from "../types/site";

let supplementaryOrderPdfJsLoader: Promise<typeof import("pdfjs-dist")> | null = null;

type ExtraWorkAttachmentUpload = {
  key: number;
  name: string;
  status: "queued" | "uploading" | "error";
  error: string | null;
};

function loadSupplementaryOrderPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (!supplementaryOrderPdfJsLoader) {
    supplementaryOrderPdfJsLoader = import("pdfjs-dist").then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjsLib;
    });
  }
  return supplementaryOrderPdfJsLoader;
}

function getSupplementaryOrderZoomStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function SupplementaryOrderDetail({
  site,
  ticket,
  canEdit,
  includeDeleted,
  pdfBusy,
  actionError,
  onBack,
  onDirtyChange,
  onTicketUpdated,
  onDownloadPdf,
}: {
  site: Site;
  ticket: MobileExtraWorkTicket;
  canEdit: boolean;
  includeDeleted: boolean;
  pdfBusy: boolean;
  actionError: string | null;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onTicketUpdated: (ticket: MobileExtraWorkTicket) => void;
  onDownloadPdf: (ticket: MobileExtraWorkTicket) => void;
}) {
  const [documentTicket, setDocumentTicket] = useState(ticket);
  const [documentData, setDocumentData] = useState<ExtraWorkTicketDocumentRead | null>(null);
  const [draft, setDraft] = useState<ExtraWorkDocumentDraft | null>(null);
  const [originalWorkerRowCount, setOriginalWorkerRowCount] = useState(0);
  const [photos, setPhotos] = useState<MobileExtraWorkTicketPhoto[]>([]);
  const [templateData, setTemplateData] = useState<ArrayBuffer | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [executionRangeEdited, setExecutionRangeEdited] = useState(false);
  const [dirtyFields, setDirtyFields] = useState<Set<ExtraWorkDocumentDirtyField>>(() => new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [openingPhotoId, setOpeningPhotoId] = useState<number | null>(null);
  const [deletingPhotoId, setDeletingPhotoId] = useState<number | null>(null);
  const [attachmentUploads, setAttachmentUploads] = useState<ExtraWorkAttachmentUpload[]>([]);
  const [isAttachmentDragActive, setIsAttachmentDragActive] = useState(false);
  const [isAttachmentsOpen, setIsAttachmentsOpen] = useState(false);
  const [documentZoom, setDocumentZoom] = useState<SupplementaryOrderDocumentZoom>(() => (
    readSupplementaryOrderDocumentZoom(getSupplementaryOrderZoomStorage())
  ));
  const [autoFitPaperWidth, setAutoFitPaperWidth] = useState<number | null>(null);
  const [isWorkerSignatureOpen, setIsWorkerSignatureOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const attachmentDragDepthRef = useRef(0);
  const attachmentUploadPendingRef = useRef(false);
  const attachmentUploadSequenceRef = useRef(0);
  const paperViewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let isCancelled = false;
    setIsLoading(true);
    setLoadError(null);
    setTemplateError(null);
    setPhotoError(null);
    setSaveError(null);
    setSaveMessage(null);
    setDraft(null);
    setDocumentData(null);
    setTemplateData(null);
    setPhotos([]);
    setAttachmentUploads([]);
    setIsAttachmentDragActive(false);
    setIsAttachmentsOpen(false);
    setDeletingPhotoId(null);
    attachmentDragDepthRef.current = 0;
    attachmentUploadPendingRef.current = false;
    setIsDirty(false);
    setExecutionRangeEdited(false);
    setDirtyFields(new Set());

    async function loadDocument(): Promise<void> {
      const [documentResult, templateResult, photosResult] = await Promise.allSettled([
        api.siteExtraWorkTicketDocument(site.id, ticket.id, { includeDeleted }),
        api.siteExtraWorkTemplate(site.id),
        api.siteExtraWorkTicketPhotos(site.id, ticket.id, { includeDeleted }),
      ]);
      if (isCancelled) {
        return;
      }

      if (documentResult.status === "rejected") {
        setLoadError(readError(documentResult.reason, "Zusatzauftrag konnte nicht geladen werden."));
      } else {
        setDocumentData(documentResult.value);
        setDocumentTicket(documentResult.value.ticket);
        setOriginalWorkerRowCount(documentResult.value.entry?.worker_rows.length ?? 0);
        setDraft(createExtraWorkDocumentDraft(documentResult.value, {
          orderedByNameFallback: documentResult.value.customer_signature.name,
          orderedByCompanyFallback: site.customer,
        }));
      }

      if (templateResult.status === "rejected") {
        setTemplateError(readError(templateResult.reason, "Master-Vorlage konnte nicht geladen werden."));
      } else {
        setTemplateData(await templateResult.value.arrayBuffer());
      }

      if (photosResult.status === "rejected") {
        setPhotoError(readError(photosResult.reason, "Fotos konnten nicht geladen werden."));
      } else {
        setPhotos(photosResult.value);
      }
      setIsLoading(false);
    }

    void loadDocument();
    return () => {
      isCancelled = true;
    };
  }, [includeDeleted, reloadKey, site.customer, site.id, ticket.id]);

  useEffect(() => {
    onDirtyChange(isDirty);
    return () => onDirtyChange(false);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    const appSidebar = document.querySelector<HTMLElement>(".app-shell > .sidebar");
    const previousSidebarAriaHidden = appSidebar?.getAttribute("aria-hidden") ?? null;
    const previousSidebarInert = appSidebar?.inert ?? false;
    document.documentElement.classList.add("supplementary-order-document-open");
    document.body.classList.add("supplementary-order-document-open");
    if (appSidebar) {
      appSidebar.inert = true;
      appSidebar.setAttribute("aria-hidden", "true");
    }
    return () => {
      document.documentElement.classList.remove("supplementary-order-document-open");
      document.body.classList.remove("supplementary-order-document-open");
      if (appSidebar) {
        appSidebar.inert = previousSidebarInert;
        if (previousSidebarAriaHidden === null) {
          appSidebar.removeAttribute("aria-hidden");
        } else {
          appSidebar.setAttribute("aria-hidden", previousSidebarAriaHidden);
        }
      }
    };
  }, []);

  useLayoutEffect(() => {
    const viewport = paperViewportRef.current;
    if (!viewport) {
      return;
    }
    const updateAutoFitWidth = (availableWidth: number) => {
      setAutoFitPaperWidth(getSupplementaryOrderAutoFitWidth(availableWidth));
    };
    updateAutoFitWidth(viewport.clientWidth);
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      updateAutoFitWidth(entry.contentRect.width);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [isLoading, loadError]);

  useEffect(() => {
    if (!isDirty) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  const isLocked = isExtraWorkDocumentLocked(documentTicket, canEdit);
  const workerPages = useMemo(
    () => chunkExtraWorkWorkerRows(draft?.entry.worker_rows ?? []),
    [draft?.entry.worker_rows],
  );
  const isAttachmentUploading = attachmentUploads.some((upload) => upload.status !== "error");
  const isPhotoLimitReached = photos.length >= MAX_EXTRA_WORK_PHOTOS;
  const finalPaperWidth = autoFitPaperWidth === null
    ? null
    : getSupplementaryOrderFinalPaperWidth(autoFitPaperWidth, documentZoom);

  function changeDocumentZoom(value: string): void {
    const nextZoom = normalizeSupplementaryOrderDocumentZoom(value);
    setDocumentZoom(nextZoom);
    writeSupplementaryOrderDocumentZoom(getSupplementaryOrderZoomStorage(), nextZoom);
  }

  function changeDraft(patch: Partial<ExtraWorkDocumentDraft>): void {
    if (isLocked) {
      return;
    }
    setDraft((current) => current ? { ...current, ...patch } : current);
    setDirtyFields((current) => {
      const next = new Set(current);
      Object.keys(patch).forEach((field) => {
        if (field !== "entry") {
          next.add(field as ExtraWorkDocumentDirtyField);
        }
      });
      return next;
    });
    markDirty();
  }

  function changeEntry(patch: Partial<ExtraWorkDocumentDraft["entry"]>): void {
    if (isLocked) {
      return;
    }
    setDraft((current) => current ? { ...current, entry: { ...current.entry, ...patch } } : current);
    markDirty();
  }

  function changeWorker(workerIndex: number, patch: Partial<MobileExtraWorkWorkerHours>): void {
    if (isLocked) {
      return;
    }
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const workerRows = current.entry.worker_rows.map((row, index) => (
        index === workerIndex ? { ...row, ...patch } : row
      ));
      return { ...current, entry: { ...current.entry, worker_rows: workerRows } };
    });
    markDirty();
  }

  function markDirty(): void {
    setIsDirty(true);
    setSaveMessage(null);
    setSaveError(null);
  }

  function handleBack(): void {
    if (isDirty && !window.confirm("Ungespeicherte Änderungen verwerfen und zur Liste zurückkehren?")) {
      return;
    }
    onBack();
  }

  async function saveDocument(): Promise<void> {
    if (!draft || isLocked || isSaving) {
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const saved = await api.saveSiteExtraWorkTicketDocument(
        site.id,
        documentTicket.id,
        buildExtraWorkDocumentPayload(draft, originalWorkerRowCount, {
          executionRangeEdited,
          originalTicket: documentTicket,
          dirtyFields,
        }),
      );
      setDocumentData(saved);
      setDocumentTicket(saved.ticket);
      setOriginalWorkerRowCount(saved.entry?.worker_rows.length ?? 0);
      setDraft(createExtraWorkDocumentDraft(saved, {
        orderedByNameFallback: saved.customer_signature.name,
        orderedByCompanyFallback: site.customer,
      }));
      setIsDirty(false);
      setExecutionRangeEdited(false);
      setDirtyFields(new Set());
      setSaveMessage("Zusatzauftrag wurde gespeichert.");
      onTicketUpdated(saved.ticket);
    } catch (requestError) {
      setSaveError(readError(requestError, "Zusatzauftrag konnte nicht gespeichert werden."));
    } finally {
      setIsSaving(false);
    }
  }

  async function openPhoto(photo: MobileExtraWorkTicketPhoto): Promise<void> {
    if (openingPhotoId !== null) {
      return;
    }
    if (photo.external_web_url) {
      window.open(photo.external_web_url, "_blank", "noopener,noreferrer");
      return;
    }
    const openedWindow = window.open("about:blank", "_blank", "noopener,noreferrer");
    setOpeningPhotoId(photo.id);
    setPhotoError(null);
    try {
      const blob = await api.siteExtraWorkTicketPhotoContent(site.id, documentTicket.id, photo.id, { includeDeleted });
      const url = window.URL.createObjectURL(blob);
      if (openedWindow) {
        openedWindow.location.href = url;
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
    } catch (requestError) {
      openedWindow?.close();
      setPhotoError(readError(requestError, "Foto konnte nicht geöffnet werden."));
    } finally {
      setOpeningPhotoId(null);
    }
  }

  function updatePersistedPhotoCount(count: number): void {
    const updatedTicket = { ...documentTicket, photo_count: count };
    setDocumentTicket(updatedTicket);
    onTicketUpdated(updatedTicket);
  }

  async function uploadAttachments(files: ArrayLike<File>): Promise<void> {
    if (isLocked || attachmentUploadPendingRef.current || files.length === 0) {
      return;
    }
    const candidates = validateExtraWorkPhotoFiles(files, photos.length);
    const uploads = candidates.map((candidate) => ({
      key: ++attachmentUploadSequenceRef.current,
      name: candidate.file.name,
      status: candidate.error ? "error" as const : "queued" as const,
      error: candidate.error,
    }));
    setAttachmentUploads(uploads);
    const uploadable = candidates.flatMap((candidate, index) => {
      const upload = uploads[index];
      return candidate.error || !upload ? [] : [{ candidate, upload }];
    });
    if (uploadable.length === 0) {
      return;
    }

    attachmentUploadPendingRef.current = true;
    setPhotoError(null);
    let persistedPhotos = photos;
    try {
      for (const { candidate, upload } of uploadable) {
        setAttachmentUploads((current) => current.map((item) => (
          item.key === upload.key ? { ...item, status: "uploading" } : item
        )));
        try {
          const storedPhoto = await api.uploadSiteExtraWorkTicketPhoto(
            site.id,
            documentTicket.id,
            candidate.file,
          );
          persistedPhotos = [...persistedPhotos, storedPhoto];
          setPhotos(persistedPhotos);
          updatePersistedPhotoCount(persistedPhotos.length);
          setAttachmentUploads((current) => current.filter((item) => item.key !== upload.key));
        } catch (requestError) {
          setAttachmentUploads((current) => current.map((item) => (
            item.key === upload.key
              ? {
                  ...item,
                  status: "error",
                  error: readError(requestError, `${candidate.file.name} konnte nicht hochgeladen werden.`),
                }
              : item
          )));
        }
      }
    } finally {
      attachmentUploadPendingRef.current = false;
    }
  }

  async function deleteAttachment(photo: MobileExtraWorkTicketPhoto): Promise<void> {
    if (
      isLocked
      || deletingPhotoId !== null
      || !window.confirm(`„${photo.filename}“ wirklich löschen?`)
    ) {
      return;
    }
    setDeletingPhotoId(photo.id);
    setPhotoError(null);
    try {
      await api.deleteSiteExtraWorkTicketPhoto(site.id, documentTicket.id, photo.id);
      const persistedPhotos = photos.filter((item) => item.id !== photo.id);
      setPhotos(persistedPhotos);
      updatePersistedPhotoCount(persistedPhotos.length);
    } catch (requestError) {
      setPhotoError(readError(requestError, `${photo.filename} konnte nicht gelöscht werden.`));
    } finally {
      setDeletingPhotoId(null);
    }
  }

  function resetAttachmentDragState(): void {
    attachmentDragDepthRef.current = 0;
    setIsAttachmentDragActive(false);
  }

  function handleAttachmentDragEnter(event: ReactDragEvent<HTMLDivElement>): void {
    if (!containsDraggedFiles(event.dataTransfer.types)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (isLocked || attachmentUploadPendingRef.current) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    attachmentDragDepthRef.current += 1;
    setIsAttachmentDragActive(true);
  }

  function handleAttachmentDragOver(event: ReactDragEvent<HTMLDivElement>): void {
    if (!containsDraggedFiles(event.dataTransfer.types)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = isLocked || attachmentUploadPendingRef.current ? "none" : "copy";
  }

  function handleAttachmentDragLeave(event: ReactDragEvent<HTMLDivElement>): void {
    if (!containsDraggedFiles(event.dataTransfer.types)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1);
    if (attachmentDragDepthRef.current === 0) {
      setIsAttachmentDragActive(false);
    }
  }

  function handleAttachmentDrop(event: ReactDragEvent<HTMLDivElement>): void {
    if (!containsDraggedFiles(event.dataTransfer.types)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    resetAttachmentDragState();
    if (isLocked || attachmentUploadPendingRef.current || event.dataTransfer.files.length === 0) {
      return;
    }
    void uploadAttachments(event.dataTransfer.files);
  }

  if (isLoading) {
    return (
      <div className="supplementary-order-detail supplementary-order-document-mode">
        <header className="supplementary-order-document-toolbar">
          <button type="button" className="supplementary-order-document-back" onClick={handleBack}>
            <ArrowLeft aria-hidden="true" size={16} />
            Zurück
          </button>
        </header>
        <div className="supplementary-order-document-state matrix-state">Zusatzauftrag wird geladen...</div>
      </div>
    );
  }

  if (loadError || !draft || !documentData) {
    return (
      <div className="supplementary-order-detail supplementary-order-document-mode">
        <header className="supplementary-order-document-toolbar">
          <button type="button" className="supplementary-order-document-back" onClick={handleBack}>
            <ArrowLeft aria-hidden="true" size={16} />
            Zurück
          </button>
        </header>
        <div className="supplementary-order-document-state">
          <div className="project-record-empty-state is-error supplementary-order-load-error">
            <strong>{loadError ?? "Zusatzauftrag konnte nicht geladen werden."}</strong>
            <button type="button" className="secondary-action" onClick={() => setReloadKey((value) => value + 1)}>Erneut laden</button>
          </div>
        </div>
      </div>
    );
  }

  const lockReason = getLockReason(documentTicket, canEdit);

  return (
    <div className="supplementary-order-detail supplementary-order-document-mode">
      <header className="supplementary-order-document-toolbar">
        <div className="supplementary-order-document-leading-actions">
          <button type="button" className="supplementary-order-document-back" onClick={handleBack}>
            <ArrowLeft aria-hidden="true" size={16} />
            Zurück
          </button>
          <label className="supplementary-order-document-zoom">
            <span>Dokumentzoom</span>
            <select
              aria-label="Dokumentzoom"
              value={documentZoom}
              onChange={(event) => changeDocumentZoom(event.target.value)}
            >
              {SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_LEVELS.map((zoom) => (
                <option key={zoom} value={zoom}>{zoom} %</option>
              ))}
            </select>
          </label>
        </div>
        <div className="supplementary-order-document-actions">
          <button
            type="button"
            className="secondary-action"
            aria-expanded={isAttachmentsOpen}
            aria-controls="supplementary-order-attachment-panel"
            onClick={() => setIsAttachmentsOpen(true)}
          >
            <Paperclip aria-hidden="true" size={15} />
            Anlagen ({photos.length})
          </button>
          {!documentTicket.deleted_at ? (
            <button
              type="button"
              className="secondary-action"
              disabled={pdfBusy || isDirty}
              title={isDirty ? "Vor dem PDF-Download zuerst speichern." : undefined}
              onClick={() => onDownloadPdf(documentTicket)}
            >
              <Download aria-hidden="true" size={15} />
              {pdfBusy ? "PDF wird erstellt..." : isDirty ? "Zuerst speichern" : "PDF herunterladen"}
            </button>
          ) : null}
          {!isLocked ? (
            <button
              type="button"
              className="primary-action"
              disabled={!isDirty || isSaving}
              onClick={() => void saveDocument()}
            >
              <Save aria-hidden="true" size={15} />
              {isSaving ? "Speichert..." : "Speichern"}
            </button>
          ) : null}
        </div>
      </header>

      {lockReason || saveError || actionError || saveMessage ? (
        <div className="supplementary-order-document-feedback">
          {lockReason ? (
            <div className="supplementary-order-lock-note" role="status">
              <LockKeyhole aria-hidden="true" size={16} />
              <span><strong>Nur Lesen.</strong> {lockReason}</span>
            </div>
          ) : null}
          {saveError ? <div className="project-record-empty-state is-error">{saveError}</div> : null}
          {actionError ? <div className="project-record-empty-state is-error">{actionError}</div> : null}
          {saveMessage ? <div className="project-record-empty-state is-success">{saveMessage}</div> : null}
        </div>
      ) : null}

      <div className="supplementary-order-workspace">
        <div className="supplementary-order-paper-viewport" ref={paperViewportRef}>
          <div
            className="supplementary-order-paper-stack"
            data-document-zoom={documentZoom}
            style={finalPaperWidth === null ? undefined : { width: `${finalPaperWidth}px` }}
          >
            {workerPages.map((workers, pageIndex) => (
              <SupplementaryOrderPaperPage
                key={pageIndex}
                site={site}
                document={documentData}
                draft={draft}
                workers={workers}
                pageIndex={pageIndex}
                pageCount={workerPages.length}
                templateData={templateData}
                templateError={templateError}
                readOnly={isLocked}
                onDraftChange={changeDraft}
                onEntryChange={changeEntry}
                onWorkerChange={(localIndex, patch) => changeWorker((pageIndex * EXTRA_WORK_VISIBLE_WORKER_ROWS) + localIndex, patch)}
                onExecutionRangeEdited={() => setExecutionRangeEdited(true)}
                onEditWorkerSignature={() => setIsWorkerSignatureOpen(true)}
              />
            ))}
          </div>
        </div>

      </div>

      {isAttachmentsOpen ? (
        <div className="supplementary-order-attachment-panel-backdrop" onMouseDown={() => setIsAttachmentsOpen(false)}>
          <aside
            id="supplementary-order-attachment-panel"
            className="supplementary-order-attachment-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="supplementary-order-attachment-panel-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2 id="supplementary-order-attachment-panel-title">Fotos / Anlagen</h2>
                <p>{photos.length} von {MAX_EXTRA_WORK_PHOTOS} Anlagen</p>
              </div>
              <button type="button" aria-label="Anlagen schließen" onClick={() => setIsAttachmentsOpen(false)}>
                <X aria-hidden="true" size={18} />
              </button>
            </header>
            <div className="supplementary-order-attachment-panel-content">
            <div
              className={`supplementary-order-attachments${isAttachmentDragActive ? " is-drag-active" : ""}`}
              onDragEnter={handleAttachmentDragEnter}
              onDragOver={handleAttachmentDragOver}
              onDragLeave={handleAttachmentDragLeave}
              onDragEnd={resetAttachmentDragState}
              onDrop={handleAttachmentDrop}
            >
              {photoError ? <p className="form-error">{photoError}</p> : null}
              {photos.length === 0 && isLocked ? (
                <p className="supplementary-order-sidebar-empty">Keine Fotos oder Anlagen vorhanden.</p>
              ) : null}
              {photos.length > 0 ? (
                <div className="supplementary-order-photo-list">
                  {photos.map((photo) => (
                    <ExtraWorkAttachmentRow
                      key={photo.id}
                      siteId={site.id}
                      ticketId={documentTicket.id}
                      photo={photo}
                      includeDeleted={includeDeleted}
                      readOnly={isLocked}
                      isOpening={openingPhotoId === photo.id}
                      isDeleting={deletingPhotoId === photo.id}
                      actionsDisabled={openingPhotoId !== null || deletingPhotoId !== null}
                      onOpen={() => void openPhoto(photo)}
                      onDelete={() => void deleteAttachment(photo)}
                    />
                  ))}
                </div>
              ) : null}
              {attachmentUploads.length > 0 ? (
                <div className="supplementary-order-upload-list" aria-live="polite">
                  {attachmentUploads.map((upload) => (
                    <div key={upload.key} className={upload.status === "error" ? "is-error" : "is-pending"}>
                      {upload.status === "error" ? <FileImage aria-hidden="true" size={16} /> : <LoaderCircle aria-hidden="true" className="is-spinning" size={16} />}
                      <span>
                        <strong title={upload.name}>{upload.name}</strong>
                        <small>{upload.status === "queued" ? "Wartet auf Upload…" : upload.status === "uploading" ? "Wird hochgeladen…" : upload.error}</small>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {!isLocked ? (
                <label className={`supplementary-order-attachment-dropzone${photos.length > 0 ? " is-compact" : ""}${isAttachmentUploading || isPhotoLimitReached ? " is-disabled" : ""}`}>
                  <UploadCloud aria-hidden="true" size={photos.length > 0 ? 17 : 22} />
                  <span>
                    <strong>{photos.length > 0 ? "Weitere Fotos hinzufügen" : "Datei hier ablegen"}</strong>
                    <small>{photos.length > 0 ? "Ablegen oder auswählen" : "oder klicken zum Auswählen"}</small>
                  </span>
                  <input
                    type="file"
                    accept={EXTRA_WORK_PHOTO_ACCEPT}
                    multiple
                    disabled={isAttachmentUploading || isPhotoLimitReached}
                    onChange={(event) => {
                      if (event.target.files) {
                        void uploadAttachments(event.target.files);
                        event.target.value = "";
                      }
                    }}
                  />
                </label>
              ) : null}
              {!isLocked ? (
                <p className={`supplementary-order-attachment-limit${isPhotoLimitReached ? " is-reached" : ""}`}>
                  {isPhotoLimitReached ? "Maximal 5 Fotos erreicht." : "JPEG, PNG, WebP oder HEIC · max. 15 MB · 5 Fotos"}
                </p>
              ) : null}
              {isAttachmentDragActive ? (
                <div className="supplementary-order-attachment-drop-hint" role="status">
                  <UploadCloud aria-hidden="true" size={24} />
                  <strong>Fotos hier ablegen</strong>
                </div>
              ) : null}
            </div>
            </div>
          </aside>
        </div>
      ) : null}

      {isWorkerSignatureOpen ? (
        <WorkerSignatureDialog
          initialName={draft.worker_signature_name ?? draft.entry.worker_rows.find((row) => row.worker_name.trim())?.worker_name ?? ""}
          initialStrokes={draft.worker_signature_strokes}
          onCancel={() => setIsWorkerSignatureOpen(false)}
          onApply={({ name, strokes }) => {
            changeDraft({
              worker_signature_name: name,
              worker_signature_place: draft.worker_signature_place?.trim()
                ? draft.worker_signature_place
                : signaturePlaceShort(formatSiteSignatureLocation(site)),
              worker_signature_date: draft.worker_signature_date || currentLocalDate(),
              worker_signature_strokes: strokes,
            });
            setIsWorkerSignatureOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function SupplementaryOrderPaperPage({
  site,
  document,
  draft,
  workers,
  pageIndex,
  pageCount,
  templateData,
  templateError,
  readOnly,
  onDraftChange,
  onEntryChange,
  onWorkerChange,
  onExecutionRangeEdited,
  onEditWorkerSignature,
}: {
  site: Site;
  document: ExtraWorkTicketDocumentRead;
  draft: ExtraWorkDocumentDraft;
  workers: MobileExtraWorkWorkerHours[];
  pageIndex: number;
  pageCount: number;
  templateData: ArrayBuffer | null;
  templateError: string | null;
  readOnly: boolean;
  onDraftChange: (patch: Partial<ExtraWorkDocumentDraft>) => void;
  onEntryChange: (patch: Partial<ExtraWorkDocumentDraft["entry"]>) => void;
  onWorkerChange: (workerIndex: number, patch: Partial<MobileExtraWorkWorkerHours>) => void;
  onExecutionRangeEdited: () => void;
  onEditWorkerSignature: () => void;
}) {
  const ticket = document.ticket;
  const isLastPage = pageIndex === pageCount - 1;
  const documentNumber = pageCount > 1
    ? `${ticket.display_number} / Blatt ${pageIndex + 1}`
    : ticket.display_number;
  const pageHours = getExtraWorkOverallHours(workers);
  const customerSignaturePlace = signaturePlaceShort(document.customer_signature.place || formatSiteSignatureLocation(site));

  return (
    <div
      className={`supplementary-order-paper${readOnly ? " is-read-only" : ""}`}
      style={{ aspectRatio: `${EXTRA_WORK_PDF_WIDTH} / ${EXTRA_WORK_PDF_HEIGHT}` }}
      data-page-number={pageIndex + 1}
    >
      {templateData ? <SupplementaryOrderPdfBackground data={templateData} /> : null}
      {templateError ? <div className="supplementary-order-template-error">{templateError}</div> : null}
      <div className="supplementary-order-overlay" aria-label={`Zusatzauftrag bearbeiten, Blatt ${pageIndex + 1}`}>
        <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.customer} label="Kunde" value={site.customer ?? ""} />
        <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.project} label="Projekt" value={site.name} />
        <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.orderedByName} label="Anordnung von" value={draft.ordered_by_name ?? ""} readOnly={readOnly} onChange={(value) => onDraftChange({ ordered_by_name: value })} />
        <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.manualOrderDate} label="Datum der Auftragserteilung" type="date" value={draft.manual_order_date ?? ""} readOnly={readOnly} onChange={(value) => onDraftChange({ manual_order_date: value || null })} />
        <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.orderedByCompany} label="Firma" value={draft.ordered_by_company ?? ""} readOnly={readOnly} onChange={(value) => onDraftChange({ ordered_by_company: value })} />
        <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.commissionNumber} label="Kommissionsnummer" value={site.site_number ?? ""} />

        <PaperChoice rect={EXTRA_WORK_CHECKBOX_RECTS.billingFlatRate} label="Pauschal" selected={draft.billing_type === "flat_rate"} disabled={readOnly} onSelect={() => onDraftChange({ billing_type: "flat_rate" })} />
        <PaperChoice rect={EXTRA_WORK_CHECKBOX_RECTS.billingHourly} label="Nach Stundensätzen" selected={draft.billing_type === "hourly"} disabled={readOnly} onSelect={() => onDraftChange({ billing_type: "hourly" })} />
        <PaperChoice rect={EXTRA_WORK_CHECKBOX_RECTS.billingUnitPrice} label="Nach Einheitspreisen" selected={draft.billing_type === "unit_price"} disabled={readOnly} onSelect={() => onDraftChange({ billing_type: "unit_price" })} />
        <PaperNumberInput rect={EXTRA_WORK_PDF_FIELD_RECTS.estimatedHours} label="Stundenvorgabe" value={draft.entry.estimated_hours} readOnly={readOnly} onChange={(value) => onEntryChange({ estimated_hours: value })} />
        <PaperNumberInput rect={EXTRA_WORK_PDF_FIELD_RECTS.estimatedOrderValue} label="Geschätzter Auftragswert" value={draft.estimated_order_value} readOnly={readOnly} onChange={(value) => onDraftChange({ estimated_order_value: value })} />

        <PaperChoice rect={EXTRA_WORK_CHECKBOX_RECTS.materialYes} label="Material ja" selected={draft.material_required} disabled={readOnly} onSelect={() => onDraftChange({ material_required: true })} />
        <PaperChoice rect={EXTRA_WORK_CHECKBOX_RECTS.materialNo} label="Material nein" selected={!draft.material_required} disabled={readOnly} onSelect={() => onDraftChange({ material_required: false })} />
        <PaperChoice rect={EXTRA_WORK_CHECKBOX_RECTS.materialAttachment} label="Material laut Anlage" selected={draft.material_separate_attachment} disabled={readOnly} onSelect={() => onDraftChange({ material_separate_attachment: !draft.material_separate_attachment })} />
        <PaperChoice rect={EXTRA_WORK_CHECKBOX_RECTS.executedByLeadMonteur} label="Ausführung durch Obermonteur" selected={draft.executed_by_lead_monteur} disabled={readOnly} onSelect={() => onDraftChange({ executed_by_lead_monteur: !draft.executed_by_lead_monteur })} />
        <PaperChoice rect={EXTRA_WORK_CHECKBOX_RECTS.executedByMonteur} label="Ausführung durch Monteur" selected={draft.executed_by_monteur} disabled={readOnly} onSelect={() => onDraftChange({ executed_by_monteur: !draft.executed_by_monteur })} />
        <PaperChoice rect={EXTRA_WORK_CHECKBOX_RECTS.executedByHelper} label="Ausführung durch Helfer" selected={draft.executed_by_helper} disabled={readOnly} onSelect={() => onDraftChange({ executed_by_helper: !draft.executed_by_helper })} />
        <PaperChoice rect={EXTRA_WORK_CHECKBOX_RECTS.executedByOther} label="Andere ausführende Person" selected={Boolean(draft.executor_other_name?.trim())} disabled={readOnly} onSelect={() => {
          if (draft.executor_other_name?.trim()) {
            onDraftChange({ executor_other_name: null });
          }
        }} />
        <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.executorOtherName} label="Andere ausführende Person" value={draft.executor_other_name ?? ""} readOnly={readOnly} onChange={(value) => onDraftChange({ executor_other_name: value })} />
        <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.authorizationPlace} label="Ort der Ausführungsgenehmigung" value={ticket.kind === "approval" ? (document.resolved_dates.approval_place ?? "") : ""} />
        <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.authorizationDate} label="Datum der Ausführungsgenehmigung" value={ticket.kind === "approval" ? formatPaperDate(document.resolved_dates.approval_date) : ""} />

        <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.documentNumber} label="Zusatzstundennachweis Nummer" value={documentNumber} />
        <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.title} label="Bezeichnung" value={draft.title ?? ""} />
        <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.executionStart} label="Ausführung von" type="date" value={draft.manual_execution_start ?? ""} readOnly={readOnly} onChange={(value) => {
          onExecutionRangeEdited();
          onDraftChange({ manual_execution_start: value || null, manual_execution_week: null, manual_execution_week_year: null });
        }} />
        <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.executionEnd} label="Ausführung bis" type="date" value={draft.manual_execution_end ?? ""} readOnly={readOnly} onChange={(value) => {
          onExecutionRangeEdited();
          onDraftChange({ manual_execution_end: value || null, manual_execution_week: null, manual_execution_week_year: null });
        }} />
        <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.component} label="Bauteil" value={draft.entry.component} readOnly={readOnly} onChange={(value) => onEntryChange({ component: value })} />
        <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.floor} label="Etage" value={draft.entry.floor} readOnly={readOnly} onChange={(value) => onEntryChange({ floor: value })} />
        <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.roomNumber} label="Raumnummer" value={draft.entry.room_number ?? ""} readOnly={readOnly} onChange={(value) => onEntryChange({ room_number: value })} />
        <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.axis} label="Achse" value={draft.entry.axis ?? ""} readOnly={readOnly} onChange={(value) => onEntryChange({ axis: value })} />

        {workers.map((worker, localWorkerIndex) => (
          <WorkerPaperFields
            key={(pageIndex * EXTRA_WORK_VISIBLE_WORKER_ROWS) + localWorkerIndex}
            worker={worker}
            workerIndex={localWorkerIndex}
            readOnly={readOnly}
            onChange={(patch) => onWorkerChange(localWorkerIndex, patch)}
          />
        ))}
        <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.overallHours} label="Gesamtstunden dieses Blatts" value={formatPaperHours(pageHours)} />
        <PaperTextarea rect={EXTRA_WORK_PDF_FIELD_RECTS.remarks} label="Bemerkungen" value={draft.entry.remarks ?? ""} readOnly={readOnly} onChange={(value) => onEntryChange({ remarks: value })} />
        <PaperTextarea rect={EXTRA_WORK_PDF_FIELD_RECTS.materialText} layout={EXTRA_WORK_PDF_TEXTAREA_LAYOUTS.materialText} label="Material" value={draft.entry.material_text ?? ""} readOnly={readOnly} onChange={(value) => onEntryChange({ material_text: value })} />

        {isLastPage ? (
          <>
            <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.workerSignaturePlace} label="Ort Monteur-Unterschrift" value={draft.worker_signature_place ?? ""} readOnly={readOnly} centered onChange={(value) => onDraftChange({ worker_signature_place: value })} />
            <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.workerSignatureDate} label="Datum Monteur-Unterschrift" type="date" value={draft.worker_signature_date ?? ""} readOnly={readOnly} centered onChange={(value) => onDraftChange({ worker_signature_date: value || null })} />
            <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.customerSignaturePlace} label="Ort Kundenunterschrift" value={customerSignaturePlace} centered />
            <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.customerSignatureDate} label="Datum Kundenunterschrift" value={formatPaperDate(document.customer_signature.signed_at)} centered />
            <PaperSignature rect={EXTRA_WORK_PDF_FIELD_RECTS.workerSignature} label="Unterschrift Monteur" strokes={draft.worker_signature_strokes} readOnly={readOnly} onEdit={onEditWorkerSignature} />
            <PaperSignature rect={EXTRA_WORK_PDF_FIELD_RECTS.customerSignature} label="Unterschrift Besteller oder Kunde" strokes={document.customer_signature.strokes} readOnly />
          </>
        ) : null}
      </div>
    </div>
  );
}

function SupplementaryOrderPdfBackground({ data }: { data: ArrayBuffer }) {
  const paperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderVersion, setRenderVersion] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const paper = paperRef.current;
    if (!paper || typeof ResizeObserver === "undefined") {
      return;
    }
    let lastWidth = Math.round(paper.getBoundingClientRect().width);
    let timer: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width);
      if (nextWidth <= 0 || Math.abs(nextWidth - lastWidth) < 4) {
        return;
      }
      lastWidth = nextWidth;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => setRenderVersion((value) => value + 1), 120);
    });
    observer.observe(paper);
    return () => {
      observer.disconnect();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    const paper = paperRef.current;
    const canvas = canvasRef.current;
    if (!paper || !canvas) {
      return;
    }
    const paperNode = paper;
    const canvasNode = canvas;
    let isCancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let pdfDocument: PDFDocumentProxy | null = null;
    setRenderError(null);

    async function renderPage(): Promise<void> {
      try {
        const pdfjsLib = await loadSupplementaryOrderPdfJs();
        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) });
        pdfDocument = await loadingTask.promise;
        const page = await pdfDocument.getPage(1);
        if (isCancelled) {
          return;
        }
        const baseViewport = page.getViewport({ scale: 1 });
        const cssScale = Math.max(paperNode.clientWidth, 1) / baseViewport.width;
        const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
        const renderViewport = page.getViewport({ scale: cssScale * pixelRatio });
        const context = canvasNode.getContext("2d", { alpha: false });
        if (!context) {
          throw new Error("Canvas konnte nicht initialisiert werden.");
        }
        canvasNode.width = Math.ceil(renderViewport.width);
        canvasNode.height = Math.ceil(renderViewport.height);
        await page.render({
          canvas: canvasNode,
          canvasContext: context,
          viewport: renderViewport,
          annotationMode: pdfjsLib.AnnotationMode.DISABLE,
        }).promise;
      } catch (error) {
        if (!isCancelled) {
          console.error("Supplementary order template render failed", error);
          setRenderError("Master-Vorlage konnte nicht dargestellt werden.");
        }
      }
    }

    void renderPage();
    return () => {
      isCancelled = true;
      void loadingTask?.destroy();
      void pdfDocument?.cleanup();
    };
  }, [data, renderVersion]);

  return (
    <div className="supplementary-order-pdf-background" ref={paperRef} aria-hidden="true">
      <canvas ref={canvasRef} />
      {renderError ? <span>{renderError}</span> : null}
    </div>
  );
}

function WorkerPaperFields({
  worker,
  workerIndex,
  readOnly,
  onChange,
}: {
  worker: MobileExtraWorkWorkerHours;
  workerIndex: number;
  readOnly: boolean;
  onChange: (patch: Partial<MobileExtraWorkWorkerHours>) => void;
}) {
  const tiers: Array<{ key: ExtraWorkHoursTier; field: "normal" | "surcharge25" | "surcharge50"; label: string }> = [
    { key: "normal", field: "normal", label: "Normalstunden" },
    { key: "surcharge25", field: "surcharge25", label: "25-Prozent-Zuschlag" },
    { key: "surcharge50", field: "surcharge50", label: "50-Prozent-Zuschlag" },
  ];
  return (
    <>
      <PaperTextarea rect={getExtraWorkWorkerNameRect(workerIndex)} label={`Name Monteur ${workerIndex + 1}`} value={worker.worker_name} readOnly={readOnly} centered onChange={(value) => onChange({ worker_name: value })} />
      {tiers.map((tier) => (
        <span key={tier.key}>
          {EXTRA_WORK_DAYS.map((day, dayIndex) => {
            const field = day[tier.field] as ExtraWorkHoursField;
            return (
              <PaperNumberInput
                key={field}
                rect={getExtraWorkHourRect(workerIndex, tier.key, dayIndex)}
                label={`${day.label}, ${tier.label}, Monteur ${workerIndex + 1}`}
                value={worker[field]}
                readOnly={readOnly}
                compact
                onChange={(value) => onChange({ [field]: value })}
              />
            );
          })}
          <PaperValue
            rect={getExtraWorkRowTotalRect(workerIndex, tier.key)}
            label={`Summe ${tier.label}, Monteur ${workerIndex + 1}`}
            value={formatPaperHours(getExtraWorkWorkerTierTotal(worker, tier.key))}
          />
        </span>
      ))}
    </>
  );
}

function PaperInput({ rect, label, value, readOnly, onChange, type = "text", centered = false }: {
  rect: ExtraWorkPdfRect;
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  type?: "text" | "date";
  centered?: boolean;
}) {
  return (
    <label className={`supplementary-order-paper-field${readOnly ? " is-read-only" : " is-editable"}${centered ? " is-centered" : ""}`} style={paperRectStyle(rect)} title={label}>
      <span className="sr-only">{label}</span>
      <input autoComplete="off" type={type} value={value} readOnly={readOnly} aria-label={label} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function PaperNumberInput({ rect, label, value, readOnly, onChange, compact = false }: {
  rect: ExtraWorkPdfRect;
  label: string;
  value: string | number | null | undefined;
  readOnly: boolean;
  onChange: (value: string | number | null) => void;
  compact?: boolean;
}) {
  const visibleValue = compact && Number(String(value ?? "").replace(",", ".")) === 0
    ? ""
    : value ?? "";
  return (
    <label className={`supplementary-order-paper-field is-number${readOnly ? " is-read-only" : " is-editable"}${compact ? " is-compact" : ""}`} style={paperRectStyle(rect)} title={label}>
      <span className="sr-only">{label}</span>
      <input
        type="text"
        autoComplete="off"
        inputMode="decimal"
        pattern="[0-9]+([,.][0-9]+)?"
        value={visibleValue}
        readOnly={readOnly}
        aria-label={label}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      />
    </label>
  );
}

function PaperTextarea({ rect, layout, label, value, readOnly, onChange, centered = false }: {
  rect: ExtraWorkPdfRect;
  layout?: ExtraWorkPdfTextareaLayout;
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  centered?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !layout) {
      setIsOverflowing(false);
      return;
    }
    const updateOverflow = () => {
      setIsOverflowing(textarea.scrollHeight > textarea.clientHeight + 1);
    };
    updateOverflow();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [layout, value]);

  const overflowMessage = layout && isOverflowing
    ? `${label}: Der Text überschreitet die ${layout.maxLines} druckbaren Zeilen.`
    : null;
  return (
    <label
      className={`supplementary-order-paper-field is-textarea${layout ? " is-pdf-line-grid" : ""}${isOverflowing ? " has-overflow" : ""}${readOnly ? " is-read-only" : " is-editable"}${centered ? " is-centered" : ""}`}
      style={paperTextareaStyle(rect, layout)}
      title={overflowMessage ?? label}
    >
      <span className="sr-only">{label}</span>
      <textarea
        ref={textareaRef}
        autoComplete="off"
        value={value}
        readOnly={readOnly}
        aria-label={label}
        aria-invalid={isOverflowing || undefined}
        data-max-lines={layout?.maxLines}
        onChange={(event) => onChange(event.target.value)}
      />
      {overflowMessage ? <span className="supplementary-order-paper-overflow-note" role="status">Mehr als {layout?.maxLines} Druckzeilen</span> : null}
    </label>
  );
}

function PaperValue({ rect, label, value, centered = false }: { rect: ExtraWorkPdfRect; label: string; value: string; centered?: boolean }) {
  return <span className={`supplementary-order-paper-value${centered ? " is-centered" : ""}`} style={paperRectStyle(rect)} title={label} aria-label={`${label}: ${value || "Nicht angegeben"}`}>{value}</span>;
}

function PaperSignature({ rect, label, strokes, readOnly, onEdit }: {
  rect: ExtraWorkPdfRect;
  label: string;
  strokes: CustomerSignatureStroke[] | null;
  readOnly: boolean;
  onEdit?: () => void;
}) {
  const validStrokes = validSignatureStrokes(strokes);
  if (validStrokes.length === 0 && readOnly) {
    return null;
  }
  const signature = validStrokes.length > 0 ? (
    <svg
      className="supplementary-order-paper-signature"
      viewBox={`0 0 ${SIGNATURE_SVG_WIDTH} ${SIGNATURE_SVG_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {validStrokes.map((stroke, index) => (
        <polyline
          key={index}
          points={signatureStrokeToSvgPoints(stroke)}
          fill="none"
          strokeWidth="12"
        />
      ))}
    </svg>
  ) : null;
  if (readOnly || !onEdit) {
    return (
      <span className="supplementary-order-paper-signature-field is-read-only" style={paperRectStyle(rect)} role="img" aria-label={label}>
        {signature}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`supplementary-order-paper-signature-field is-editable${validStrokes.length > 0 ? " is-signed" : ""}`}
      style={paperRectStyle(rect)}
      aria-label={label}
      title={validStrokes.length > 0 ? "Monteursunterschrift ersetzen" : "Monteursunterschrift eintragen"}
      onClick={onEdit}
    >
      {signature}
    </button>
  );
}

function WorkerSignatureDialog({ initialName, initialStrokes, onCancel, onApply }: {
  initialName: string;
  initialStrokes: CustomerSignatureStroke[] | null;
  onCancel: () => void;
  onApply: (value: { name: string; strokes: CustomerSignatureStroke[] }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [strokes, setStrokes] = useState<CustomerSignatureStroke[]>(() => validSignatureStrokes(initialStrokes));
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => drawSignatureCanvas(canvasRef.current, strokes));
    return () => window.cancelAnimationFrame(frame);
  }, [strokes]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onCancel();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  function startStroke(event: ReactPointerEvent<HTMLCanvasElement>): void {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    isDrawingRef.current = true;
    const point = getNormalizedSignaturePoint(event.currentTarget, event.clientX, event.clientY);
    if (point) {
      setStrokes((current) => [...current, [point]]);
      setError(null);
    }
  }

  function appendPoint(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!isDrawingRef.current) {
      return;
    }
    event.preventDefault();
    const point = getNormalizedSignaturePoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) {
      return;
    }
    setStrokes((current) => {
      const next = current.slice();
      const lastStroke = next.at(-1) ?? [];
      next[next.length - 1] = [...lastStroke, point];
      return next;
    });
  }

  function finishStroke(event: ReactPointerEvent<HTMLCanvasElement>): void {
    isDrawingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function apply(): void {
    const normalizedName = name.trim();
    const normalizedStrokes = validSignatureStrokes(strokes);
    if (!normalizedName) {
      setError("Bitte Monteurnamen eintragen.");
      return;
    }
    if (normalizedStrokes.length === 0) {
      setError("Bitte eine Unterschrift zeichnen.");
      return;
    }
    onApply({ name: normalizedName, strokes: normalizedStrokes });
  }

  return (
    <div className="supplementary-order-signature-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="supplementary-order-signature-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="supplementary-order-signature-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h3 id="supplementary-order-signature-title">Unterschrift Monteur</h3>
          <p>Mit Maus, Touch oder Stift unterschreiben.</p>
        </header>
        <label>
          <span>Monteur</span>
          <input autoFocus autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <canvas
          ref={canvasRef}
          className="supplementary-order-signature-canvas"
          aria-label="Zeichenfläche für die Monteurunterschrift"
          onPointerDown={startStroke}
          onPointerMove={appendPoint}
          onPointerUp={finishStroke}
          onPointerCancel={(event) => {
            isDrawingRef.current = false;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
        />
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <footer>
          <button type="button" className="secondary-action" onClick={() => {
            setStrokes([]);
            setError(null);
          }}>Löschen</button>
          <span />
          <button type="button" className="secondary-action" onClick={onCancel}>Abbrechen</button>
          <button type="button" className="primary-action" onClick={apply}>Übernehmen</button>
        </footer>
      </section>
    </div>
  );
}

function PaperChoice({ rect, label, selected, disabled, onSelect }: {
  rect: ExtraWorkPdfRect;
  label: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`supplementary-order-paper-choice${disabled ? " is-read-only" : " is-editable"}${selected ? " is-selected" : ""}`}
      style={paperRectStyle(rect)}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      disabled={disabled}
      onClick={onSelect}
    >
      {selected ? "✓" : ""}
    </button>
  );
}

function ExtraWorkAttachmentRow({
  siteId,
  ticketId,
  photo,
  includeDeleted,
  readOnly,
  isOpening,
  isDeleting,
  actionsDisabled,
  onOpen,
  onDelete,
}: {
  siteId: number;
  ticketId: number;
  photo: MobileExtraWorkTicketPhoto;
  includeDeleted: boolean;
  readOnly: boolean;
  isOpening: boolean;
  isDeleting: boolean;
  actionsDisabled: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const kind = getExtraWorkAttachmentKind(photo.content_type);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "image") {
      setThumbnailUrl(null);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    void api.siteExtraWorkTicketPhotoContent(siteId, ticketId, photo.id, { includeDeleted })
      .then((blob) => {
        if (!active) {
          return;
        }
        objectUrl = window.URL.createObjectURL(blob);
        setThumbnailUrl(objectUrl);
      })
      .catch(() => {
        if (active) {
          setThumbnailUrl(null);
        }
      });
    return () => {
      active = false;
      if (objectUrl) {
        window.URL.revokeObjectURL(objectUrl);
      }
    };
  }, [includeDeleted, kind, photo.id, siteId, ticketId]);

  const typeLabel = kind === "image" ? "Foto" : kind === "pdf" ? "PDF" : "Datei";
  const sizeLabel = formatProjectFileSize(photo.file_size_bytes);
  return (
    <div className="supplementary-order-attachment-row">
      <button
        type="button"
        className="supplementary-order-attachment-open"
        disabled={actionsDisabled}
        title={photo.filename}
        onClick={onOpen}
      >
        <span className="supplementary-order-attachment-preview" aria-hidden="true">
          {thumbnailUrl ? <img src={thumbnailUrl} alt="" /> : kind === "image" ? <FileImage size={18} /> : kind === "pdf" ? <FileText size={18} /> : <FileIcon size={18} />}
        </span>
        <span className="supplementary-order-attachment-copy">
          <strong>{photo.filename}</strong>
          <small>{[typeLabel, sizeLabel].filter(Boolean).join(" · ")}{isOpening ? " · Wird geöffnet…" : ""}</small>
        </span>
        <ExternalLink aria-hidden="true" size={13} />
      </button>
      {!readOnly ? (
        <button
          type="button"
          className="supplementary-order-attachment-delete"
          aria-label={`${photo.filename} löschen`}
          title={`${photo.filename} löschen`}
          disabled={actionsDisabled}
          onClick={onDelete}
        >
          {isDeleting ? <LoaderCircle aria-hidden="true" className="is-spinning" size={14} /> : <Trash2 aria-hidden="true" size={14} />}
        </button>
      ) : null}
    </div>
  );
}

function paperRectStyle(rect: ExtraWorkPdfRect): CSSProperties {
  const percent = extraWorkPdfRectToPercent(rect);
  return {
    left: `${percent.left}%`,
    top: `${percent.top}%`,
    width: `${percent.width}%`,
    height: `${percent.height}%`,
  };
}

type PaperTextareaStyle = CSSProperties & {
  "--pdf-textarea-font-size"?: string;
  "--pdf-textarea-line-height"?: string;
  "--pdf-textarea-padding-top"?: string;
  "--pdf-textarea-padding-inline"?: string;
};

function paperTextareaStyle(
  rect: ExtraWorkPdfRect,
  layout?: ExtraWorkPdfTextareaLayout,
): PaperTextareaStyle {
  const style: PaperTextareaStyle = paperRectStyle(rect);
  if (!layout) {
    return style;
  }
  style["--pdf-textarea-font-size"] = `${extraWorkPdfPointsToCqw(layout.fontSize)}cqw`;
  style["--pdf-textarea-line-height"] = `${extraWorkPdfPointsToCqw(layout.lineHeight)}cqw`;
  style["--pdf-textarea-padding-top"] = `${extraWorkPdfPointsToCqw(layout.paddingTop)}cqw`;
  style["--pdf-textarea-padding-inline"] = `${extraWorkPdfPointsToCqw(layout.paddingInline)}cqw`;
  return style;
}

function getLockReason(ticket: MobileExtraWorkTicket, canEdit: boolean): string | null {
  if (!canEdit) return "Für diese Projektakte besteht keine Bearbeitungsberechtigung.";
  if (ticket.deleted_at) return "Archivierte Zusatzaufträge können erst nach der Wiederherstellung bearbeitet werden.";
  if (ticket.customer_signed_at) return "Nach der Kundenunterschrift bleiben die erfassten Werte unverändert.";
  if (isExtraWorkDocumentLocked(ticket, canEdit)) return "Der abgeschlossene Status sperrt die fachlichen Angaben.";
  return null;
}

function formatPaperHours(value: number): string {
  if (value <= 0) {
    return "";
  }
  return value.toLocaleString("de-DE", { minimumFractionDigits: value % 1 === 0 ? 0 : 1, maximumFractionDigits: 2 });
}

function formatPaperDate(value: string | null): string {
  if (!value) {
    return "";
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function formatSiteSignatureLocation(site: Site): string {
  const street = [site.street?.trim(), site.house_number?.trim()].filter(Boolean).join(" ");
  const city = [site.postal_code?.trim(), site.city?.trim()].filter(Boolean).join(" ");
  const structured = [street, city].filter(Boolean).join(", ");
  return structured || site.address?.trim() || site.location?.trim() || site.city?.trim() || "";
}

function signaturePlaceShort(place: string | null): string {
  const value = place?.trim() ?? "";
  if (!value) {
    return "";
  }
  const candidate = value.split(",").at(-1)?.trim() ?? value;
  return candidate.replace(/^\d{5}\s+/, "") || candidate;
}

function currentLocalDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readError(error: unknown, fallback: string): string {
  if (error instanceof Error && !(error instanceof ApiError)) {
    return error.message || fallback;
  }
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  return typeof error.detail === "string" ? error.detail : error.message;
}
