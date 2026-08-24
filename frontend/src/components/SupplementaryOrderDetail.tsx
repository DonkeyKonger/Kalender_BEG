import { ArrowLeft, Download, ExternalLink, File as FileIcon, FileImage, FileText, LoaderCircle, LockKeyhole, Paperclip, Save, Trash2, UploadCloud, X } from "lucide-react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
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
  constrainExtraWorkRemarksChange,
  createExtraWorkDocumentDraft,
  extraWorkPdfPointsToCqw,
  extraWorkPdfRectToPercent,
  formatExtraWorkSignaturePlace,
  getExtraWorkHourRect,
  getExtraWorkOverallHours,
  getExtraWorkRowTotalRect,
  getExtraWorkWorkerNameRect,
  getExtraWorkWorkerTierTotal,
  extraWorkRemarksFit,
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
  MobileExtraWorkTicketEntry,
  MobileExtraWorkTicketPhoto,
  MobileExtraWorkWorkerHours,
  Site,
} from "../types/site";

let supplementaryOrderPdfJsLoader: Promise<typeof import("pdfjs-dist")> | null = null;
let supplementaryOrderTemplateLoader: Promise<ArrayBuffer> | null = null;
const supplementaryOrderDocumentLoaders = new Map<string, Promise<ExtraWorkTicketDocumentRead>>();
const supplementaryOrderAttachmentContentLoaders = new Map<string, Promise<Blob>>();
const supplementaryOrderTemplatePreviewLoaders = new WeakMap<ArrayBuffer, Promise<string>>();
const SUPPLEMENTARY_ORDER_TEMPLATE_PREVIEW_WIDTH = 1600;
const SUPPLEMENTARY_ORDER_TEMPLATE_PREVIEW_MAX_PIXELS = 4_000_000;

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

function loadSupplementaryOrderTemplate(siteId: number): Promise<ArrayBuffer> {
  if (!supplementaryOrderTemplateLoader) {
    supplementaryOrderTemplateLoader = api.siteExtraWorkTemplate(siteId)
      .then((blob) => blob.arrayBuffer())
      .catch((error) => {
        supplementaryOrderTemplateLoader = null;
        throw error;
      });
  }
  return supplementaryOrderTemplateLoader;
}

function loadSupplementaryOrderDocument(
  siteId: number,
  ticketId: number,
  includeDeleted: boolean,
): Promise<ExtraWorkTicketDocumentRead> {
  const key = `${siteId}:${ticketId}:${includeDeleted ? "deleted" : "active"}`;
  const existing = supplementaryOrderDocumentLoaders.get(key);
  if (existing) {
    return existing;
  }
  const loader = api.siteExtraWorkTicketDocument(siteId, ticketId, { includeDeleted });
  supplementaryOrderDocumentLoaders.set(key, loader);
  void loader.then(
    () => {
      if (supplementaryOrderDocumentLoaders.get(key) === loader) {
        supplementaryOrderDocumentLoaders.delete(key);
      }
    },
    () => {
      if (supplementaryOrderDocumentLoaders.get(key) === loader) {
        supplementaryOrderDocumentLoaders.delete(key);
      }
    },
  );
  return loader;
}

function loadSupplementaryOrderAttachmentContent(
  siteId: number,
  ticketId: number,
  photoId: number,
  includeDeleted: boolean,
): Promise<Blob> {
  const key = `${siteId}:${ticketId}:${photoId}:${includeDeleted ? "deleted" : "active"}`;
  const existing = supplementaryOrderAttachmentContentLoaders.get(key);
  if (existing) {
    return existing;
  }
  const loader = api.siteExtraWorkTicketPhotoContent(siteId, ticketId, photoId, { includeDeleted });
  supplementaryOrderAttachmentContentLoaders.set(key, loader);
  void loader.then(
    () => {
      if (supplementaryOrderAttachmentContentLoaders.get(key) === loader) {
        supplementaryOrderAttachmentContentLoaders.delete(key);
      }
    },
    () => {
      if (supplementaryOrderAttachmentContentLoaders.get(key) === loader) {
        supplementaryOrderAttachmentContentLoaders.delete(key);
      }
    },
  );
  return loader;
}

function loadSupplementaryOrderTemplatePreview(data: ArrayBuffer): Promise<string> {
  const existing = supplementaryOrderTemplatePreviewLoaders.get(data);
  if (existing) {
    return existing;
  }
  const loader = renderSupplementaryOrderTemplatePreview(data).catch((error) => {
    supplementaryOrderTemplatePreviewLoaders.delete(data);
    throw error;
  });
  supplementaryOrderTemplatePreviewLoaders.set(data, loader);
  return loader;
}

async function renderSupplementaryOrderTemplatePreview(data: ArrayBuffer): Promise<string> {
  const pdfjsLib = await loadSupplementaryOrderPdfJs();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) });
  try {
    const pdfDocument = await loadingTask.promise;
    const page = await pdfDocument.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const aspectRatio = baseViewport.width / baseViewport.height;
    const pixelBudgetWidth = Math.floor(Math.sqrt(SUPPLEMENTARY_ORDER_TEMPLATE_PREVIEW_MAX_PIXELS * aspectRatio));
    const renderWidth = Math.min(SUPPLEMENTARY_ORDER_TEMPLATE_PREVIEW_WIDTH, pixelBudgetWidth);
    const renderViewport = page.getViewport({ scale: renderWidth / baseViewport.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(renderViewport.width);
    canvas.height = Math.ceil(renderViewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Canvas konnte nicht initialisiert werden.");
    }
    await page.render({
      canvas,
      canvasContext: context,
      viewport: renderViewport,
      annotationMode: pdfjsLib.AnnotationMode.DISABLE,
    }).promise;
    const previewBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("PDF-Vorschau konnte nicht erstellt werden."));
        }
      }, "image/png");
    });
    canvas.width = 0;
    canvas.height = 0;
    return URL.createObjectURL(previewBlob);
  } finally {
    void loadingTask.destroy();
  }
}

function useSupplementaryOrderTemplatePreview(data: ArrayBuffer | null): {
  previewUrl: string | null;
  previewError: string | null;
} {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;
    setPreviewUrl(null);
    setPreviewError(null);
    if (!data) {
      return () => {
        isCancelled = true;
      };
    }
    void loadSupplementaryOrderTemplatePreview(data)
      .then((url) => {
        if (!isCancelled) {
          setPreviewUrl(url);
        }
      })
      .catch((error) => {
        console.error("Supplementary order template render failed", error);
        if (!isCancelled) {
          setPreviewError("Master-Vorlage konnte nicht dargestellt werden.");
        }
      });
    return () => {
      isCancelled = true;
    };
  }, [data]);

  return { previewUrl, previewError };
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
  onTicketUpdated: (ticket: MobileExtraWorkTicket, entry?: MobileExtraWorkTicketEntry | null) => void;
  onDownloadPdf: (ticket: MobileExtraWorkTicket) => void;
}) {
  const [documentTicket, setDocumentTicket] = useState(ticket);
  const [documentData, setDocumentData] = useState<ExtraWorkTicketDocumentRead | null>(null);
  const [draft, setDraft] = useState<ExtraWorkDocumentDraft | null>(null);
  const [originalWorkerRowCount, setOriginalWorkerRowCount] = useState(0);
  const [photos, setPhotos] = useState<MobileExtraWorkTicketPhoto[]>([]);
  const [photosLoaded, setPhotosLoaded] = useState(false);
  const [photosLoading, setPhotosLoading] = useState(false);
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
  const [isWorkerSignatureOpen, setIsWorkerSignatureOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const attachmentDragDepthRef = useRef(0);
  const attachmentUploadPendingRef = useRef(false);
  const attachmentUploadSequenceRef = useRef(0);
  const attachmentListRequestRef = useRef<Promise<MobileExtraWorkTicketPhoto[]> | null>(null);
  const attachmentListGenerationRef = useRef(0);
  const templatePreview = useSupplementaryOrderTemplatePreview(documentData ? templateData : null);

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
    setPhotosLoaded(false);
    setPhotosLoading(false);
    setAttachmentUploads([]);
    setIsAttachmentDragActive(false);
    setIsAttachmentsOpen(false);
    setDeletingPhotoId(null);
    attachmentDragDepthRef.current = 0;
    attachmentUploadPendingRef.current = false;
    attachmentListRequestRef.current = null;
    attachmentListGenerationRef.current += 1;
    setIsDirty(false);
    setExecutionRangeEdited(false);
    setDirtyFields(new Set());

    void loadSupplementaryOrderDocument(site.id, ticket.id, includeDeleted)
      .then((document) => {
        if (isCancelled) {
          return;
        }
        setDocumentData(document);
        setDocumentTicket(document.ticket);
        setOriginalWorkerRowCount(document.entry?.worker_rows.length ?? 0);
        setDraft(createExtraWorkDocumentDraft(document, {
          customerNameFallback: site.customer,
          orderedByNameFallback: document.customer_signature.name,
          orderedByCompanyFallback: site.customer,
        }));
      })
      .catch((error) => {
        if (!isCancelled) {
          setLoadError(readError(error, "Zusatzauftrag konnte nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoading(false);
        }
      });

    void loadSupplementaryOrderTemplate(site.id)
      .then((data) => {
        if (!isCancelled) {
          setTemplateData(data);
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          setTemplateError(readError(error, "Master-Vorlage konnte nicht geladen werden."));
        }
      });
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
  const attachmentCount = photosLoaded ? photos.length : documentTicket.photo_count;
  const isPhotoLimitReached = attachmentCount >= MAX_EXTRA_WORK_PHOTOS;
  const changeDocumentZoom = useCallback((value: string): void => {
    const nextZoom = normalizeSupplementaryOrderDocumentZoom(value);
    setDocumentZoom(nextZoom);
    writeSupplementaryOrderDocumentZoom(getSupplementaryOrderZoomStorage(), nextZoom);
  }, []);

  const markDirty = useCallback((): void => {
    setIsDirty(true);
    setSaveMessage(null);
    setSaveError(null);
  }, []);

  const changeDraft = useCallback((patch: Partial<ExtraWorkDocumentDraft>): void => {
    if (isLocked) {
      return;
    }
    setDraft((current) => current ? { ...current, ...patch } : current);
    setDirtyFields((current) => {
      const changedFields = Object.keys(patch).filter((field) => field !== "entry") as ExtraWorkDocumentDirtyField[];
      if (changedFields.every((field) => current.has(field))) {
        return current;
      }
      const next = new Set(current);
      changedFields.forEach((field) => next.add(field));
      return next;
    });
    markDirty();
  }, [isLocked, markDirty]);

  const changeEntry = useCallback((patch: Partial<ExtraWorkDocumentDraft["entry"]>): void => {
    if (isLocked) {
      return;
    }
    setDraft((current) => current ? { ...current, entry: { ...current.entry, ...patch } } : current);
    markDirty();
  }, [isLocked, markDirty]);

  const changeWorker = useCallback((workerIndex: number, patch: Partial<MobileExtraWorkWorkerHours>): void => {
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
  }, [isLocked, markDirty]);

  const markExecutionRangeEdited = useCallback(() => setExecutionRangeEdited(true), []);
  const openWorkerSignature = useCallback(() => setIsWorkerSignatureOpen(true), []);

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
        customerNameFallback: site.customer,
        orderedByNameFallback: saved.customer_signature.name,
        orderedByCompanyFallback: site.customer,
      }));
      setIsDirty(false);
      setExecutionRangeEdited(false);
      setDirtyFields(new Set());
      setSaveMessage("Zusatzauftrag wurde gespeichert.");
      onTicketUpdated(saved.ticket, saved.entry);
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
      const blob = await loadSupplementaryOrderAttachmentContent(site.id, documentTicket.id, photo.id, includeDeleted);
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

  function loadAttachments(): Promise<MobileExtraWorkTicketPhoto[]> {
    if (photosLoaded) {
      return Promise.resolve(photos);
    }
    const pendingRequest = attachmentListRequestRef.current;
    if (pendingRequest) {
      return pendingRequest;
    }
    const generation = attachmentListGenerationRef.current;
    setPhotosLoading(true);
    setPhotoError(null);
    const request = api.siteExtraWorkTicketPhotos(site.id, documentTicket.id, { includeDeleted })
      .then((loadedPhotos) => {
        if (attachmentListGenerationRef.current === generation) {
          setPhotos(loadedPhotos);
          setPhotosLoaded(true);
        }
        return loadedPhotos;
      })
      .catch((error) => {
        if (attachmentListGenerationRef.current === generation) {
          setPhotoError(readError(error, "Fotos und Anlagen konnten nicht geladen werden."));
        }
        return [];
      })
      .finally(() => {
        if (
          attachmentListGenerationRef.current === generation
          && attachmentListRequestRef.current === request
        ) {
          attachmentListRequestRef.current = null;
          setPhotosLoading(false);
        }
      });
    attachmentListRequestRef.current = request;
    return request;
  }

  function openAttachments(): void {
    setIsAttachmentsOpen(true);
    void loadAttachments();
  }

  function updatePersistedPhotoCount(count: number): void {
    const updatedTicket = { ...documentTicket, photo_count: count };
    setDocumentTicket(updatedTicket);
    onTicketUpdated(updatedTicket);
  }

  async function uploadAttachments(files: ArrayLike<File>): Promise<void> {
    if (!photosLoaded || photosLoading || isLocked || attachmentUploadPendingRef.current || files.length === 0) {
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
    if (!photosLoaded || photosLoading || isLocked || attachmentUploadPendingRef.current) {
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
    event.dataTransfer.dropEffect = !photosLoaded || photosLoading || isLocked || attachmentUploadPendingRef.current ? "none" : "copy";
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
    if (!photosLoaded || photosLoading || isLocked || attachmentUploadPendingRef.current || event.dataTransfer.files.length === 0) {
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
            onClick={openAttachments}
          >
            <Paperclip aria-hidden="true" size={15} />
            Anlagen ({attachmentCount})
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
        <SupplementaryOrderPaperViewport documentZoom={documentZoom}>
          {workerPages.map((workers, pageIndex) => (
            <SupplementaryOrderPaperPage
              key={pageIndex}
              site={site}
              document={documentData}
              draft={draft}
              workers={workers}
              pageIndex={pageIndex}
              pageCount={workerPages.length}
              templatePreviewUrl={templatePreview.previewUrl}
              templateLoading={!templateError && !templatePreview.previewError && !templatePreview.previewUrl}
              templateError={templateError ?? templatePreview.previewError}
              readOnly={isLocked}
              onDraftChange={changeDraft}
              onEntryChange={changeEntry}
              workerOffset={pageIndex * EXTRA_WORK_VISIBLE_WORKER_ROWS}
              onWorkerChange={changeWorker}
              onExecutionRangeEdited={markExecutionRangeEdited}
              onEditWorkerSignature={openWorkerSignature}
            />
          ))}
        </SupplementaryOrderPaperViewport>
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
                <p>{attachmentCount} von {MAX_EXTRA_WORK_PHOTOS} Anlagen</p>
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
              {photosLoading ? <p className="supplementary-order-sidebar-empty" role="status">Fotos und Anlagen werden geladen…</p> : null}
              {photoError ? (
                <div className="form-error">
                  <p>{photoError}</p>
                  {!photosLoaded ? <button type="button" className="secondary-action" onClick={() => void loadAttachments()}>Erneut laden</button> : null}
                </div>
              ) : null}
              {photosLoaded && photos.length === 0 && isLocked ? (
                <p className="supplementary-order-sidebar-empty">Keine Fotos oder Anlagen vorhanden.</p>
              ) : null}
              {photosLoaded && photos.length > 0 ? (
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
              {photosLoaded && attachmentUploads.length > 0 ? (
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
              {photosLoaded && !isLocked ? (
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
                    disabled={photosLoading || isAttachmentUploading || isPhotoLimitReached}
                    onChange={(event) => {
                      if (event.target.files) {
                        void uploadAttachments(event.target.files);
                        event.target.value = "";
                      }
                    }}
                  />
                </label>
              ) : null}
              {photosLoaded && !isLocked ? (
                <p className={`supplementary-order-attachment-limit${isPhotoLimitReached ? " is-reached" : ""}`}>
                  {isPhotoLimitReached ? "Maximal 5 Fotos erreicht." : "JPEG, PNG, WebP oder HEIC · max. 15 MB · 5 Fotos"}
                </p>
              ) : null}
              {photosLoaded && isAttachmentDragActive ? (
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
                : formatExtraWorkSignaturePlace(formatSiteSignatureLocation(site)) ?? "",
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

const SupplementaryOrderPaperViewport = memo(function SupplementaryOrderPaperViewport({
  documentZoom,
  children,
}: {
  documentZoom: SupplementaryOrderDocumentZoom;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [autoFitPaperWidth, setAutoFitPaperWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const updateAutoFitWidth = (availableWidth: number) => {
      const nextWidth = getSupplementaryOrderAutoFitWidth(availableWidth);
      setAutoFitPaperWidth((current) => (
        current !== null && Math.abs(current - nextWidth) < 1 ? current : nextWidth
      ));
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
  }, []);

  const finalPaperWidth = autoFitPaperWidth === null
    ? null
    : getSupplementaryOrderFinalPaperWidth(autoFitPaperWidth, documentZoom);

  return (
    <div className="supplementary-order-paper-viewport" ref={viewportRef}>
      <div
        className="supplementary-order-paper-stack"
        data-document-zoom={documentZoom}
        style={finalPaperWidth === null ? undefined : { width: `${finalPaperWidth}px` }}
      >
        {children}
      </div>
    </div>
  );
});

function SupplementaryOrderPaperPage({
  site,
  document,
  draft,
  workers,
  pageIndex,
  pageCount,
  templatePreviewUrl,
  templateLoading,
  templateError,
  readOnly,
  workerOffset,
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
  templatePreviewUrl: string | null;
  templateLoading: boolean;
  templateError: string | null;
  readOnly: boolean;
  workerOffset: number;
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
  const customerSignaturePlace = formatExtraWorkSignaturePlace(
    document.customer_signature.place || formatSiteSignatureLocation(site),
  ) ?? "";

  return (
    <div
      className={`supplementary-order-paper${readOnly ? " is-read-only" : ""}`}
      style={{ aspectRatio: `${EXTRA_WORK_PDF_WIDTH} / ${EXTRA_WORK_PDF_HEIGHT}` }}
      data-page-number={pageIndex + 1}
    >
      <SupplementaryOrderPdfBackground previewUrl={templatePreviewUrl} isLoading={templateLoading} />
      {templateError ? <div className="supplementary-order-template-error">{templateError}</div> : null}
      <div className="supplementary-order-overlay" aria-label={`Zusatzauftrag bearbeiten, Blatt ${pageIndex + 1}`}>
        <PaperInput rect={EXTRA_WORK_PDF_FIELD_RECTS.customer} label="Kunde" value={draft.customer_name ?? ""} readOnly={readOnly} onChange={(value) => onDraftChange({ customer_name: value })} />
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

        <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.documentNumber} label="Zusatzstundennachweis Nummer" value={documentNumber} documentNumber />
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
            workerStateIndex={workerOffset + localWorkerIndex}
            readOnly={readOnly}
            onChange={onWorkerChange}
          />
        ))}
        <PaperValue rect={EXTRA_WORK_PDF_FIELD_RECTS.overallHours} label="Gesamtstunden dieses Blatts" value={formatPaperHours(pageHours)} />
        <PaperTextarea rect={EXTRA_WORK_PDF_FIELD_RECTS.remarks} layout={EXTRA_WORK_PDF_TEXTAREA_LAYOUTS.remarks} pdfCapacity="remarks" label="Bemerkungen" value={draft.entry.remarks ?? ""} readOnly={readOnly} onChange={(value) => onEntryChange({ remarks: value })} />
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

const SupplementaryOrderPdfBackground = memo(function SupplementaryOrderPdfBackground({
  previewUrl,
  isLoading,
}: {
  previewUrl: string | null;
  isLoading: boolean;
}) {
  return (
    <div className="supplementary-order-pdf-background" aria-hidden="true">
      {previewUrl ? <img src={previewUrl} alt="" /> : null}
      {isLoading ? <span className="is-loading">Vorlage wird geladen…</span> : null}
    </div>
  );
});

const WorkerPaperFields = memo(function WorkerPaperFields({
  worker,
  workerIndex,
  workerStateIndex,
  readOnly,
  onChange,
}: {
  worker: MobileExtraWorkWorkerHours;
  workerIndex: number;
  workerStateIndex: number;
  readOnly: boolean;
  onChange: (workerIndex: number, patch: Partial<MobileExtraWorkWorkerHours>) => void;
}) {
  const tiers: Array<{ key: ExtraWorkHoursTier; field: "normal" | "surcharge25" | "surcharge50"; label: string }> = [
    { key: "normal", field: "normal", label: "Normalstunden" },
    { key: "surcharge25", field: "surcharge25", label: "25-Prozent-Zuschlag" },
    { key: "surcharge50", field: "surcharge50", label: "50-Prozent-Zuschlag" },
  ];
  return (
    <>
      <PaperTextarea rect={getExtraWorkWorkerNameRect(workerIndex)} label={`Name Monteur ${workerIndex + 1}`} value={worker.worker_name} readOnly={readOnly} centered onChange={(value) => onChange(workerStateIndex, { worker_name: value })} />
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
                onChange={(value) => onChange(workerStateIndex, { [field]: value })}
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
}, (previous, next) => (
  previous.worker === next.worker
  && previous.workerIndex === next.workerIndex
  && previous.workerStateIndex === next.workerStateIndex
  && previous.readOnly === next.readOnly
));

type PaperInputProps = {
  rect: ExtraWorkPdfRect;
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  type?: "text" | "date";
  centered?: boolean;
};

const PaperInput = memo(function PaperInput({ rect, label, value, readOnly, onChange, type = "text", centered = false }: PaperInputProps) {
  return (
    <label className={`supplementary-order-paper-field${readOnly ? " is-read-only" : " is-editable"}${centered ? " is-centered" : ""}`} style={paperRectStyle(rect)} title={label}>
      <span className="sr-only">{label}</span>
      <input autoComplete="off" type={type} value={value} readOnly={readOnly} aria-label={label} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}, (previous, next) => (
  samePaperRect(previous.rect, next.rect)
  && previous.label === next.label
  && previous.value === next.value
  && previous.readOnly === next.readOnly
  && previous.type === next.type
  && previous.centered === next.centered
));

type PaperNumberInputProps = {
  rect: ExtraWorkPdfRect;
  label: string;
  value: string | number | null | undefined;
  readOnly: boolean;
  onChange: (value: string | number | null) => void;
  compact?: boolean;
};

const PaperNumberInput = memo(function PaperNumberInput({ rect, label, value, readOnly, onChange, compact = false }: PaperNumberInputProps) {
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
}, (previous, next) => (
  samePaperRect(previous.rect, next.rect)
  && previous.label === next.label
  && previous.value === next.value
  && previous.readOnly === next.readOnly
  && previous.compact === next.compact
));

type PaperTextareaProps = {
  rect: ExtraWorkPdfRect;
  layout?: ExtraWorkPdfTextareaLayout;
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  centered?: boolean;
  pdfCapacity?: "remarks";
};

const PaperTextarea = memo(function PaperTextarea({ rect, layout, label, value, readOnly, onChange, centered = false, pdfCapacity }: PaperTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [capacityReached, setCapacityReached] = useState(false);
  const hasLegacyOverflow = pdfCapacity === "remarks" && !extraWorkRemarksFit(value);

  const updateOverflow = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || !layout) {
      setIsOverflowing((current) => current ? false : current);
      return;
    }
    const nextOverflow = textarea.scrollHeight > textarea.clientHeight + 1;
    setIsOverflowing((current) => current === nextOverflow ? current : nextOverflow);
  }, [layout]);

  useLayoutEffect(() => {
    updateOverflow();
  }, [updateOverflow, value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !layout || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [layout, updateOverflow]);

  const overflowMessage = layout && isOverflowing
    ? `${label}: Der Text überschreitet die ${layout.maxLines} druckbaren Zeilen.`
    : null;
  const capacityMessage = hasLegacyOverflow
    ? "Gespeicherter Alttext ist zu lang für die PDF. Bitte kürzen; unverändert bleibt er erhalten."
    : capacityReached
      ? "Maximale Länge für die PDF erreicht"
      : null;
  const feedbackMessage = capacityMessage ?? overflowMessage;
  return (
    <label
      className={`supplementary-order-paper-field is-textarea${layout ? " is-pdf-line-grid" : ""}${isOverflowing || hasLegacyOverflow ? " has-overflow" : ""}${readOnly ? " is-read-only" : " is-editable"}${centered ? " is-centered" : ""}`}
      style={paperTextareaStyle(rect, layout)}
      title={feedbackMessage ?? label}
    >
      <span className="sr-only">{label}</span>
      <textarea
        ref={textareaRef}
        autoComplete="off"
        value={value}
        readOnly={readOnly}
        aria-label={label}
        aria-invalid={isOverflowing || hasLegacyOverflow || undefined}
        data-max-lines={layout?.maxLines}
        onChange={(event) => {
          if (pdfCapacity === "remarks") {
            const constrained = constrainExtraWorkRemarksChange(value, event.target.value);
            setCapacityReached(constrained.limited);
            if (constrained.value !== value) {
              onChange(constrained.value);
            }
            return;
          }
          onChange(event.target.value);
        }}
      />
      {capacityMessage ? (
        <span className="supplementary-order-paper-overflow-note" role="status">{capacityMessage}</span>
      ) : overflowMessage ? (
        <span className="supplementary-order-paper-overflow-note" role="status">Mehr als {layout?.maxLines} Druckzeilen</span>
      ) : null}
    </label>
  );
}, (previous, next) => (
  samePaperRect(previous.rect, next.rect)
  && previous.layout === next.layout
  && previous.label === next.label
  && previous.value === next.value
  && previous.readOnly === next.readOnly
  && previous.centered === next.centered
  && previous.pdfCapacity === next.pdfCapacity
));

const PaperValue = memo(function PaperValue({ rect, label, value, centered = false, documentNumber = false }: { rect: ExtraWorkPdfRect; label: string; value: string; centered?: boolean; documentNumber?: boolean }) {
  return <span className={`supplementary-order-paper-value${centered ? " is-centered" : ""}${documentNumber ? " is-document-number" : ""}`} style={paperRectStyle(rect)} title={label} aria-label={`${label}: ${value || "Nicht angegeben"}`}>{value}</span>;
}, (previous, next) => (
  samePaperRect(previous.rect, next.rect)
  && previous.label === next.label
  && previous.value === next.value
  && previous.centered === next.centered
  && previous.documentNumber === next.documentNumber
));

type PaperSignatureProps = {
  rect: ExtraWorkPdfRect;
  label: string;
  strokes: CustomerSignatureStroke[] | null;
  readOnly: boolean;
  onEdit?: () => void;
};

const PaperSignature = memo(function PaperSignature({ rect, label, strokes, readOnly, onEdit }: PaperSignatureProps) {
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
}, (previous, next) => (
  samePaperRect(previous.rect, next.rect)
  && previous.label === next.label
  && previous.strokes === next.strokes
  && previous.readOnly === next.readOnly
));

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

type PaperChoiceProps = {
  rect: ExtraWorkPdfRect;
  label: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
};

const PaperChoice = memo(function PaperChoice({ rect, label, selected, disabled, onSelect }: PaperChoiceProps) {
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
}, (previous, next) => (
  samePaperRect(previous.rect, next.rect)
  && previous.label === next.label
  && previous.selected === next.selected
  && previous.disabled === next.disabled
));

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
    void loadSupplementaryOrderAttachmentContent(siteId, ticketId, photo.id, includeDeleted)
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

function samePaperRect(previous: ExtraWorkPdfRect, next: ExtraWorkPdfRect): boolean {
  return previous === next || (
    previous.x === next.x
    && previous.y === next.y
    && previous.width === next.width
    && previous.height === next.height
  );
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
