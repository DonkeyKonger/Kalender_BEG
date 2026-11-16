import { Check, ChevronDown, LoaderCircle, Printer, RefreshCw, Save, WifiOff, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
import {
  MATERIAL_ORDER_ZOOM_LEVELS,
  MATERIAL_ORDER_DESKTOP_ZOOM,
  MATERIAL_ORDER_MOBILE_ZOOM,
  clearMaterialOrderRecovery,
  getMaterialOrderRecoveryKey,
  materialOrderRectStyle,
  materialOrderValuesEqual,
  normalizeMaterialOrderValues,
  readMaterialOrderRecovery,
  readMaterialOrderZoom,
  writeMaterialOrderRecovery,
  writeMaterialOrderZoom,
  type MaterialOrderDraft,
  type MaterialOrderField,
  type MaterialOrderForm,
  type MaterialOrderValues,
  type MaterialOrderZoom,
} from "../lib/materialOrders";
import { prepareMaterialOrderPrint, type PreparedMaterialOrderPrint } from "../lib/materialOrderPrinting";
import { loadCompatiblePdfJs } from "../lib/pdfJsCompatibility";
import type { ProjectFolderDocumentItem } from "../types/site";

import "./MaterialOrderDialog.css";

type MaterialOrderDialogProps = {
  siteId: number;
  onClose: () => void;
  onCompleted: (document: ProjectFolderDocumentItem) => void;
};

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
type DialogAction = "close" | "complete" | "print" | "resolve-conflict" | null;

const AUTOSAVE_DELAY_MS = 700;
const PREVIEW_WIDTH = 1_600;
const PREVIEW_MAX_PIXELS = 4_000_000;

function cloneValues(values: MaterialOrderValues): MaterialOrderValues {
  return { ...values };
}

function defaultMaterialOrderZoom(): MaterialOrderZoom {
  return typeof window !== "undefined" && window.innerWidth < 720
    ? MATERIAL_ORDER_MOBILE_ZOOM
    : MATERIAL_ORDER_DESKTOP_ZOOM;
}

function getMaterialOrderStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function materialOrderInputStyle(field: MaterialOrderField, form: MaterialOrderForm): CSSProperties {
  const textColor = field.text_color?.map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255));
  return {
    fontSize: field.font_size ? `${field.font_size / form.width * 100}cqw` : undefined,
    color: textColor ? `rgb(${textColor.join(" ")})` : undefined,
    textAlign: field.text_align ?? undefined,
  };
}

async function renderTemplatePreview(blob: Blob): Promise<string> {
  const data = await blob.arrayBuffer();
  const pdfjsLib = await loadCompatiblePdfJs();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data) });
  try {
    const pdfDocument = await loadingTask.promise;
    const page = await pdfDocument.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const aspectRatio = baseViewport.width / baseViewport.height;
    const budgetWidth = Math.floor(Math.sqrt(PREVIEW_MAX_PIXELS * aspectRatio));
    const renderWidth = Math.min(PREVIEW_WIDTH, budgetWidth);
    const viewport = page.getViewport({ scale: renderWidth / baseViewport.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("PDF-Vorschau konnte nicht initialisiert werden.");
    await page.render({
      canvas,
      canvasContext: context,
      viewport,
      annotationMode: pdfjsLib.AnnotationMode.DISABLE,
    }).promise;
    const preview = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error("PDF-Vorschau konnte nicht erzeugt werden."));
      }, "image/png");
    });
    canvas.width = 0;
    canvas.height = 0;
    return URL.createObjectURL(preview);
  } finally {
    void loadingTask.destroy();
  }
}

export function MaterialOrderDialog({ siteId, onClose, onCompleted }: MaterialOrderDialogProps) {
  const { user } = useAuth();
  const onCloseRef = useRef(onClose);
  const onCompletedRef = useRef(onCompleted);
  onCloseRef.current = onClose;
  onCompletedRef.current = onCompleted;
  const dialogRef = useRef<HTMLElement | null>(null);
  const zoomMenuRef = useRef<HTMLDivElement | null>(null);
  const zoomTriggerRef = useRef<HTMLButtonElement | null>(null);
  const firstFocusRef = useRef<HTMLButtonElement | null>(null);
  const draftRef = useRef<MaterialOrderDraft | null>(null);
  const formRef = useRef<MaterialOrderForm | null>(null);
  const valuesRef = useRef<MaterialOrderValues>({});
  const persistedValuesRef = useRef<MaterialOrderValues>({});
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const actionRef = useRef<DialogAction>(null);
  const printIntentRef = useRef(false);
  const mountedRef = useRef(true);
  const recoveryStoredRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const recoveryRevisionRef = useRef<number | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [draft, setDraft] = useState<MaterialOrderDraft | null>(null);
  const [form, setForm] = useState<MaterialOrderForm | null>(null);
  const [values, setValues] = useState<MaterialOrderValues>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hasRevisionConflict, setHasRevisionConflict] = useState(false);
  const [hasCompletedConflict, setHasCompletedConflict] = useState(false);
  const [hasPendingConflict, setHasPendingConflict] = useState(false);
  const [completionStateUnknown, setCompletionStateUnknown] = useState(false);
  const [isRecoveryStored, setIsRecoveryStored] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [action, setActionState] = useState<DialogAction>(null);
  const [zoom, setZoom] = useState<MaterialOrderZoom>(() => (
    readMaterialOrderZoom(getMaterialOrderStorage(), user?.id, defaultMaterialOrderZoom())
  ));
  const [isZoomOpen, setIsZoomOpen] = useState(false);
  const [activeZoomIndex, setActiveZoomIndex] = useState(() => MATERIAL_ORDER_ZOOM_LEVELS.indexOf(zoom));
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [recoveryNotice, setRecoveryNotice] = useState(false);
  const [hasPrintIntent, setHasPrintIntentState] = useState(false);
  const recoveryKey = useMemo(
    () => getMaterialOrderRecoveryKey(siteId, user?.id),
    [siteId, user?.id],
  );

  const setAction = useCallback((next: DialogAction) => {
    actionRef.current = next;
    setActionState(next);
  }, []);

  const setPrintIntent = useCallback((next: boolean) => {
    printIntentRef.current = next;
    setHasPrintIntentState(next);
  }, []);

  const changeZoom = useCallback((next: MaterialOrderZoom) => {
    setZoom(next);
    setActiveZoomIndex(MATERIAL_ORDER_ZOOM_LEVELS.indexOf(next));
    setIsZoomOpen(false);
    writeMaterialOrderZoom(getMaterialOrderStorage(), user?.id, next);
  }, [user?.id]);

  useEffect(() => {
    if (!isZoomOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!zoomMenuRef.current?.contains(event.target as Node)) setIsZoomOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [isZoomOpen]);

  const persistRecovery = useCallback((draftId: string, revision: number, nextValues: MaterialOrderValues): boolean => {
    const storage = getMaterialOrderStorage();
    const stored = Boolean(storage && writeMaterialOrderRecovery(storage, recoveryKey, {
      draftId,
      revision,
      values: cloneValues(nextValues),
      savedAt: new Date().toISOString(),
    }));
    recoveryStoredRef.current = stored;
    if (mountedRef.current) setIsRecoveryStored(stored);
    return stored;
  }, [recoveryKey]);

  const discardRecovery = useCallback(() => {
    const storage = getMaterialOrderStorage();
    if (storage) clearMaterialOrderRecovery(storage, recoveryKey);
    recoveryStoredRef.current = false;
    if (mountedRef.current) setIsRecoveryStored(false);
  }, [recoveryKey]);

  useEffect(() => {
    valuesRef.current = values;
  }, [values]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const appShell = document.querySelector<HTMLElement>(".app-shell");
    const opener = openerRef.current;
    const previousInert = appShell?.inert ?? false;
    const previousAriaHidden = appShell?.getAttribute("aria-hidden") ?? null;
    document.body.classList.add("material-order-dialog-open");
    if (appShell) {
      appShell.inert = true;
      appShell.setAttribute("aria-hidden", "true");
    }
    return () => {
      document.body.classList.remove("material-order-dialog-open");
      if (appShell) {
        appShell.inert = previousInert;
        if (previousAriaHidden === null) appShell.removeAttribute("aria-hidden");
        else appShell.setAttribute("aria-hidden", previousAriaHidden);
      }
      opener?.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let nextPreviewUrl: string | null = null;
    setIsLoading(true);
    setLoadError(null);
    setSaveError(null);
    setHasRevisionConflict(false);
    setHasCompletedConflict(false);
    setHasPendingConflict(false);
    setCompletionStateUnknown(false);
    setIsRecoveryStored(false);
    recoveryStoredRef.current = false;
    setRecoveryNotice(false);
    const storage = getMaterialOrderStorage();
    const recovery = storage ? readMaterialOrderRecovery(storage, recoveryKey) : null;
    let recoveryDraftMissing = false;
    const draftLoader = recovery
      ? api.materialOrderDraft(siteId, recovery.draftId).catch((error) => {
          if (error instanceof ApiError && error.status === 404) {
            recoveryDraftMissing = true;
            return api.createMaterialOrderDraft(siteId);
          }
          throw error;
        })
      : api.createMaterialOrderDraft(siteId);
    void Promise.all([
      draftLoader,
      api.materialOrderForm(siteId),
      api.materialOrderTemplate(siteId),
    ]).then(async ([loadedDraft, nextForm, template]) => {
      nextPreviewUrl = await renderTemplatePreview(template);
      if (cancelled) {
        URL.revokeObjectURL(nextPreviewUrl);
        return;
      }
      let nextDraft = loadedDraft;
      let activeRecovery = recovery;
      if (
        recovery
        && !recoveryDraftMissing
        && recovery.draftId === loadedDraft.id
        && loadedDraft.status === "completed"
      ) {
        const completedValues = normalizeMaterialOrderValues(nextForm, loadedDraft.values);
        const recoveredValues = normalizeMaterialOrderValues(nextForm, recovery.values);
        if (materialOrderValuesEqual(completedValues, recoveredValues)) {
          discardRecovery();
          nextDraft = await api.createMaterialOrderDraft(siteId);
          activeRecovery = null;
          if (cancelled) {
            URL.revokeObjectURL(nextPreviewUrl);
            return;
          }
        }
      }
      const serverValues = normalizeMaterialOrderValues(nextForm, nextDraft.values);
      const hasMatchingRecovery = Boolean(
        activeRecovery && (activeRecovery.draftId === nextDraft.id || recoveryDraftMissing),
      );
      const recoveryValues = hasMatchingRecovery
        ? normalizeMaterialOrderValues(nextForm, activeRecovery?.values)
        : serverValues;
      const hasDifferentRecovery = Boolean(
        hasMatchingRecovery && !materialOrderValuesEqual(recoveryValues, serverValues),
      );
      const hasCompletedRecoveryConflict = hasDifferentRecovery && nextDraft.status === "completed";
      const hasPendingRecoveryConflict = hasDifferentRecovery && nextDraft.completion_pending;
      const hasStaleRecovery = Boolean(
        hasDifferentRecovery
        && !recoveryDraftMissing
        && activeRecovery
        && activeRecovery.revision < nextDraft.revision
        && nextDraft.status === "draft"
        && !nextDraft.completion_pending,
      );
      const initialValues = hasDifferentRecovery ? recoveryValues : serverValues;
      if (nextDraft.status === "completed" && nextDraft.document && !hasDifferentRecovery) {
        discardRecovery();
        window.dispatchEvent(new Event("project-files-changed"));
        onCompletedRef.current(nextDraft.document);
        return;
      }
      draftRef.current = nextDraft;
      formRef.current = nextForm;
      recoveryRevisionRef.current = hasDifferentRecovery && activeRecovery && !recoveryDraftMissing
        ? activeRecovery.revision
        : nextDraft.revision;
      valuesRef.current = initialValues;
      persistedValuesRef.current = serverValues;
      setDraft(nextDraft);
      setForm(nextForm);
      setValues(initialValues);
      setPreviewUrl(nextPreviewUrl);
      setRecoveryNotice(hasDifferentRecovery && !hasStaleRecovery && !hasCompletedRecoveryConflict && !hasPendingRecoveryConflict);
      setHasRevisionConflict(hasStaleRecovery);
      setHasCompletedConflict(hasCompletedRecoveryConflict);
      setHasPendingConflict(hasPendingRecoveryConflict);
      setSaveError(hasCompletedRecoveryConflict
        ? "Diese Bestellung wurde inzwischen an anderer Stelle mit anderen Eingaben abgelegt. Ihre Eingaben bleiben erhalten."
        : hasPendingRecoveryConflict
          ? "Diese Bestellung wird an anderer Stelle mit anderen Eingaben abgelegt. Ihre Eingaben bleiben erhalten."
        : nextDraft.completion_pending
        ? "Die Ablage der PDF ist noch nicht abgeschlossen. Ihre Eingaben sind geschützt."
        : hasStaleRecovery
          ? "Dieser Entwurf wurde inzwischen an anderer Stelle geändert. Ihre Eingaben bleiben erhalten."
          : null);
      setSaveState(hasStaleRecovery || hasCompletedRecoveryConflict || hasPendingRecoveryConflict
        ? "error"
        : materialOrderValuesEqual(initialValues, serverValues) ? "saved" : "dirty");
      window.requestAnimationFrame(() => firstFocusRef.current?.focus());
    }).catch((error) => {
      if (nextPreviewUrl) URL.revokeObjectURL(nextPreviewUrl);
      if (!cancelled) {
        setLoadError(error instanceof Error ? error.message : "Lagerbestellung konnte nicht geladen werden.");
      }
    }).finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
      if (nextPreviewUrl) URL.revokeObjectURL(nextPreviewUrl);
    };
  }, [discardRecovery, loadVersion, recoveryKey, siteId]);

  const queueSave = useCallback((snapshot: MaterialOrderValues): Promise<void> => {
    const queuedValues = cloneValues(snapshot);
    const job = saveQueueRef.current.catch(() => undefined).then(async () => {
      const activeDraft = draftRef.current;
      if (!activeDraft) throw new Error("Der Entwurf ist noch nicht geladen.");
      if (materialOrderValuesEqual(queuedValues, persistedValuesRef.current)) return;
      if (!navigator.onLine) {
        throw new Error(recoveryStoredRef.current
          ? "Keine Netzwerkverbindung. Die Eingaben wurden lokal gesichert."
          : "Keine Netzwerkverbindung. Die Eingaben bleiben nur in diesem geöffneten Fenster erhalten.");
      }
      if (mountedRef.current) {
        setSaveState("saving");
        setSaveError(null);
      }
      try {
        const saved = await api.updateMaterialOrderDraft(siteId, activeDraft.id, {
          revision: activeDraft.revision,
          values: queuedValues,
        });
        draftRef.current = saved;
        recoveryRevisionRef.current = saved.revision;
        persistedValuesRef.current = cloneValues(queuedValues);
        if (mountedRef.current) {
          setDraft(saved);
          setHasRevisionConflict(false);
          setSaveState(materialOrderValuesEqual(valuesRef.current, queuedValues) ? "saved" : "dirty");
          persistRecovery(saved.id, saved.revision, valuesRef.current);
        }
      } catch (error) {
        if (mountedRef.current) {
          setSaveState("error");
          setSaveError(error instanceof Error ? error.message : "Entwurf konnte nicht gespeichert werden.");
          setHasRevisionConflict(error instanceof ApiError && error.status === 409);
        }
        throw error;
      }
    });
    saveQueueRef.current = job.catch(() => undefined);
    return job;
  }, [persistRecovery, siteId]);

  useEffect(() => {
    if (!draft || !form) return;
    if (draft.status === "completed") {
      const completedValues = normalizeMaterialOrderValues(form, draft.values);
      persistedValuesRef.current = completedValues;
      if (materialOrderValuesEqual(values, completedValues)) {
        discardRecovery();
        setSaveState("saved");
      } else {
        persistRecovery(draft.id, draft.revision, values);
        setSaveState("error");
      }
      return;
    }
    persistRecovery(draft.id, recoveryRevisionRef.current ?? draft.revision, values);
    if (materialOrderValuesEqual(values, persistedValuesRef.current)) {
      setSaveState("saved");
      return;
    }
    setSaveState("dirty");
    if (action !== null || hasRevisionConflict || draft.status !== "draft" || draft.completion_pending || completionStateUnknown) return;
    const timer = window.setTimeout(() => {
      if (actionRef.current === null) void queueSave(values).catch(() => undefined);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [action, completionStateUnknown, discardRecovery, draft, form, hasRevisionConflict, persistRecovery, queueSave, values]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      if (!hasRevisionConflict && !completionStateUnknown && draftRef.current?.status === "draft" && !draftRef.current.completion_pending) {
        void queueSave(valuesRef.current).catch(() => undefined);
      }
    };
    const handleOffline = () => setIsOnline(false);
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!materialOrderValuesEqual(valuesRef.current, persistedValuesRef.current)) {
        event.preventDefault();
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [completionStateUnknown, hasRevisionConflict, queueSave]);

  const closeWithSave = useCallback(async () => {
    if (actionRef.current !== null) return;
    if (!draftRef.current) {
      onCloseRef.current();
      return;
    }
    if (hasCompletedConflict) {
      setSaveError("Wählen Sie, ob Sie die abgelegte Bestellung öffnen oder mit Ihren Eingaben eine neue Bestellung beginnen möchten.");
      return;
    }
    if (hasPendingConflict) {
      setSaveError("Die andere Ablage läuft noch. Laden Sie den aktuellen Stand oder prüfen Sie den Status erneut; Ihre Eingaben bleiben bis dahin erhalten.");
      return;
    }
    if (completionStateUnknown && !recoveryStoredRef.current) {
      setSaveError("Der Ablagestatus ist unklar. Ihre Eingaben liegen nur in diesem geöffneten Fenster vor; versuchen Sie die Ablage erneut.");
      return;
    }
    if (draftRef.current.status !== "draft" || draftRef.current.completion_pending || completionStateUnknown) {
      if (!completionStateUnknown) discardRecovery();
      onCloseRef.current();
      return;
    }
    if (hasRevisionConflict) {
      setSaveError("Dieser Entwurf wurde inzwischen an anderer Stelle geändert. Ihre Eingaben bleiben erhalten.");
      return;
    }
    setAction("close");
    setSaveError(null);
    try {
      await queueSave(valuesRef.current);
      discardRecovery();
      onCloseRef.current();
    } catch {
      // The visible error and recovery copy intentionally keep the dialog open.
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [completionStateUnknown, discardRecovery, hasCompletedConflict, hasPendingConflict, hasRevisionConflict, queueSave, setAction]);

  const complete = useCallback(async (options?: {
    snapshot?: MaterialOrderValues;
    onStored?: (storedDraft: MaterialOrderDraft, document: ProjectFolderDocumentItem) => void;
  }): Promise<boolean> => {
    const continuingPrint = actionRef.current === "print" && Boolean(options?.onStored);
    if ((actionRef.current !== null && !continuingPrint) || !draftRef.current) return false;
    const attemptedDraftId = draftRef.current.id;
    if (!continuingPrint) setAction("complete");
    setSaveError(null);
    const snapshot = options?.snapshot ?? cloneValues(valuesRef.current);
    const finishStored = (storedDraft: MaterialOrderDraft, document: ProjectFolderDocumentItem) => {
      const completedDraft = { ...storedDraft, status: "completed" as const, completion_pending: false, document };
      persistedValuesRef.current = formRef.current
        ? normalizeMaterialOrderValues(formRef.current, completedDraft.values)
        : cloneValues(completedDraft.values);
      recoveryRevisionRef.current = completedDraft.revision;
      draftRef.current = completedDraft;
      setDraft(completedDraft);
      discardRecovery();
      window.dispatchEvent(new Event("project-files-changed"));
      if (options?.onStored) options.onStored(completedDraft, document);
      else onCompletedRef.current(document);
    };
    try {
      if (draftRef.current.status === "draft" && !draftRef.current.completion_pending && !completionStateUnknown) {
        await queueSave(snapshot);
      }
      const activeDraft = draftRef.current;
      if (!activeDraft) throw new Error("Der Entwurf ist nicht mehr verfügbar.");
      const result = await api.completeMaterialOrder(siteId, activeDraft.id, {
        revision: activeDraft.revision,
        values: snapshot,
      });
      finishStored(result.draft, result.document);
      return true;
    } catch (error) {
      setCompletionStateUnknown(true);
      try {
        const currentDraft = await api.materialOrderDraft(siteId, attemptedDraftId);
        const activeForm = formRef.current;
        const serverValues = activeForm
          ? normalizeMaterialOrderValues(activeForm, currentDraft.values)
          : cloneValues(currentDraft.values);
        const matchesAttemptedValues = materialOrderValuesEqual(serverValues, snapshot);
        if (currentDraft.status === "completed" && currentDraft.document && matchesAttemptedValues) {
          finishStored(currentDraft, currentDraft.document);
          return true;
        }
        draftRef.current = currentDraft;
        recoveryRevisionRef.current = currentDraft.revision;
        persistedValuesRef.current = cloneValues(serverValues);
        if (currentDraft.completion_pending && matchesAttemptedValues) {
          valuesRef.current = serverValues;
          setValues(serverValues);
          discardRecovery();
        } else if (currentDraft.completion_pending && !matchesAttemptedValues) {
          valuesRef.current = snapshot;
          setValues(snapshot);
          persistRecovery(currentDraft.id, currentDraft.revision, snapshot);
        } else if (currentDraft.status === "completed" && !matchesAttemptedValues) {
          valuesRef.current = snapshot;
          setValues(snapshot);
          persistRecovery(currentDraft.id, currentDraft.revision, snapshot);
        }
        if (mountedRef.current) {
          setDraft(currentDraft);
          setCompletionStateUnknown(false);
          setSaveState("error");
          setSaveError(currentDraft.status === "completed" && !matchesAttemptedValues
            ? "Diese Bestellung wurde inzwischen an anderer Stelle mit anderen Eingaben abgelegt. Ihre Eingaben bleiben erhalten."
            : currentDraft.completion_pending && !matchesAttemptedValues
              ? "Diese Bestellung wird an anderer Stelle mit anderen Eingaben abgelegt. Ihre Eingaben bleiben erhalten."
            : currentDraft.status === "completed"
              ? "Die PDF wurde bereits abgelegt, konnte aber nicht in der Dokumentliste bestätigt werden."
            : currentDraft.completion_pending
            ? "Die Ablage der PDF ist noch nicht abgeschlossen. Ihre Eingaben sind geschützt."
            : error instanceof Error ? error.message : "Lagerbestellung konnte nicht abgeschlossen werden.");
          setHasCompletedConflict(currentDraft.status === "completed" && !matchesAttemptedValues);
          setHasPendingConflict(currentDraft.completion_pending && !matchesAttemptedValues);
          setHasRevisionConflict(currentDraft.status === "draft" && !currentDraft.completion_pending && error instanceof ApiError && error.status === 409);
        }
      } catch {
        if (mountedRef.current) {
          setSaveState("error");
          setSaveError(recoveryStoredRef.current
            ? "Der Ablagestatus konnte nicht geprüft werden. Ihre Eingaben wurden lokal gesichert; versuchen Sie die Ablage erneut."
            : "Der Ablagestatus konnte nicht geprüft werden. Ihre Eingaben liegen nur in diesem geöffneten Fenster vor; versuchen Sie die Ablage erneut.");
        }
      }
      return false;
    } finally {
      if (!continuingPrint && mountedRef.current) setAction(null);
    }
  }, [completionStateUnknown, discardRecovery, persistRecovery, queueSave, setAction, siteId]);

  const printCurrentValues = useCallback(async () => {
    if (
      actionRef.current !== null
      || !draftRef.current
      || hasRevisionConflict
      || hasPendingConflict
      || hasCompletedConflict
    ) return;
    setPrintIntent(true);
    setAction("print");
    setSaveError(null);
    let prepared: PreparedMaterialOrderPrint | null = null;
    let printStarted = false;
    try {
      const snapshot = cloneValues(valuesRef.current);
      if (completionStateUnknown) {
        const currentDraft = await api.materialOrderDraft(siteId, draftRef.current.id);
        const serverValues = formRef.current
          ? normalizeMaterialOrderValues(formRef.current, currentDraft.values)
          : cloneValues(currentDraft.values);
        const valuesMatch = materialOrderValuesEqual(snapshot, serverValues);
        draftRef.current = currentDraft;
        recoveryRevisionRef.current = currentDraft.revision;
        persistedValuesRef.current = serverValues;
        setDraft(currentDraft);
        setCompletionStateUnknown(false);
        if (currentDraft.status === "completed" && !valuesMatch) {
          persistRecovery(currentDraft.id, currentDraft.revision, snapshot);
          setHasCompletedConflict(true);
          setSaveState("error");
          setSaveError("Diese Bestellung wurde inzwischen an anderer Stelle mit anderen Eingaben abgelegt. Ihre Eingaben bleiben erhalten.");
          return;
        }
        if (currentDraft.completion_pending) {
          if (!valuesMatch) {
            persistRecovery(currentDraft.id, currentDraft.revision, snapshot);
            setHasPendingConflict(true);
            setSaveError("Diese Bestellung wird an anderer Stelle mit anderen Eingaben abgelegt. Ihre Eingaben bleiben erhalten.");
            setSaveState("error");
            return;
          }
          valuesRef.current = serverValues;
          setValues(serverValues);
          discardRecovery();
        }
        if (currentDraft.status === "draft" && !valuesMatch) {
          persistRecovery(currentDraft.id, currentDraft.revision, snapshot);
          setHasRevisionConflict(true);
          setSaveState("error");
          setSaveError("Dieser Entwurf wurde inzwischen an anderer Stelle geändert. Ihre Eingaben bleiben erhalten.");
          return;
        }
      }
      let storedDocument = draftRef.current.status === "completed" ? draftRef.current.document : null;
      if (!storedDocument) {
        const storedDocumentRef: { current: ProjectFolderDocumentItem | null } = { current: null };
        const stored = await complete({
          snapshot,
          onStored: (_storedDraft, document) => { storedDocumentRef.current = document; },
        });
        storedDocument = storedDocumentRef.current;
        if (!stored || !storedDocument) return;
      }
      const storedPdf = await api.projectFolderDocumentContent(siteId, "lagerbestellungen", storedDocument.id, "inline");
      prepared = await prepareMaterialOrderPrint(storedPdf);
      prepared.print();
      printStarted = true;
      setPrintIntent(false);
      discardRecovery();
      onCompletedRef.current(storedDocument);
    } catch (error) {
      if (mountedRef.current) {
        setSaveState("error");
        setSaveError(draftRef.current?.status === "completed"
          ? error instanceof Error ? `Die PDF wurde abgelegt. ${error.message}` : "Die PDF wurde abgelegt, der Druck konnte aber nicht gestartet werden."
          : error instanceof Error ? error.message : "Druckansicht konnte nicht erstellt werden.");
        setHasRevisionConflict(error instanceof ApiError && error.status === 409);
      }
    } finally {
      if (!printStarted) prepared?.dispose();
      if (mountedRef.current) setAction(null);
    }
  }, [
    complete,
    completionStateUnknown,
    discardRecovery,
    hasCompletedConflict,
    hasPendingConflict,
    hasRevisionConflict,
    persistRecovery,
    setAction,
    setPrintIntent,
    siteId,
  ]);

  const resolveRevisionConflict = useCallback(async () => {
    if (actionRef.current !== null) return;
    setAction("resolve-conflict");
    setSaveError(null);
    const localValues = cloneValues(valuesRef.current);
    try {
      const activeDraft = draftRef.current;
      if (!activeDraft) throw new Error("Der Entwurf ist nicht mehr verfügbar.");
      const currentDraft = await api.materialOrderDraft(siteId, activeDraft.id);
      draftRef.current = currentDraft;
      recoveryRevisionRef.current = currentDraft.revision;
      setDraft(currentDraft);
      if (formRef.current) {
        persistedValuesRef.current = normalizeMaterialOrderValues(formRef.current, currentDraft.values);
      }
      setHasRevisionConflict(false);
      if (currentDraft.status === "completed") {
        setCompletionStateUnknown(false);
        const matchesCompletedValues = materialOrderValuesEqual(localValues, persistedValuesRef.current);
        if (matchesCompletedValues && currentDraft.document) {
          discardRecovery();
          window.dispatchEvent(new Event("project-files-changed"));
          onCompletedRef.current(currentDraft.document);
          return;
        }
        persistRecovery(currentDraft.id, currentDraft.revision, localValues);
        setHasCompletedConflict(true);
        setSaveError("Diese Bestellung wurde inzwischen an anderer Stelle mit anderen Eingaben abgelegt. Ihre Eingaben bleiben erhalten.");
        setSaveState("error");
        return;
      }
      if (currentDraft.completion_pending && formRef.current) {
        const serverValues = normalizeMaterialOrderValues(formRef.current, currentDraft.values);
        if (!materialOrderValuesEqual(localValues, serverValues)) {
          valuesRef.current = localValues;
          persistRecovery(currentDraft.id, currentDraft.revision, localValues);
          setHasPendingConflict(true);
          setCompletionStateUnknown(false);
          setSaveError("Diese Bestellung wird an anderer Stelle mit anderen Eingaben abgelegt. Ihre Eingaben bleiben erhalten.");
          setSaveState("error");
          return;
        }
        valuesRef.current = serverValues;
        setValues(serverValues);
        discardRecovery();
        setCompletionStateUnknown(false);
        setSaveError("Die Ablage der PDF ist noch nicht abgeschlossen. Ihre Eingaben sind geschützt.");
        setSaveState("error");
        return;
      }
      await queueSave(localValues);
      setRecoveryNotice(true);
    } catch (error) {
      if (mountedRef.current) {
        setSaveState("error");
        setSaveError(error instanceof Error ? error.message : "Der aktuelle Entwurf konnte nicht geladen werden.");
        setHasRevisionConflict(error instanceof ApiError && error.status === 409);
      }
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [discardRecovery, persistRecovery, queueSave, setAction, siteId]);

  const useServerRevision = useCallback(async () => {
    const activeDraft = draftRef.current;
    const activeForm = formRef.current;
    if (!activeDraft || !activeForm || actionRef.current !== null) return;
    setAction("resolve-conflict");
    try {
      const currentDraft = await api.materialOrderDraft(siteId, activeDraft.id);
      const serverValues = normalizeMaterialOrderValues(activeForm, currentDraft.values);
      draftRef.current = currentDraft;
      valuesRef.current = serverValues;
      persistedValuesRef.current = cloneValues(serverValues);
      recoveryRevisionRef.current = currentDraft.revision;
      setDraft(currentDraft);
      setValues(serverValues);
      setHasRevisionConflict(false);
      setHasCompletedConflict(false);
      setHasPendingConflict(false);
      setRecoveryNotice(false);
      setSaveState(currentDraft.status === "draft" && !currentDraft.completion_pending ? "saved" : "error");
      setSaveError(currentDraft.status === "completed"
        ? "Diese Lagerbestellung wurde inzwischen fertig abgelegt."
        : currentDraft.completion_pending
          ? "Die Ablage der PDF ist noch nicht abgeschlossen. Ihre Eingaben sind geschützt."
          : null);
      if (currentDraft.status === "draft" && !currentDraft.completion_pending) {
        persistRecovery(currentDraft.id, currentDraft.revision, serverValues);
      } else {
        discardRecovery();
      }
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "Der aktuelle Entwurf konnte nicht geladen werden.");
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [discardRecovery, persistRecovery, setAction, siteId]);

  const openCompletedConflict = useCallback(() => {
    const completedDocument = draftRef.current?.document;
    if (!hasCompletedConflict || !completedDocument || actionRef.current !== null) return;
    discardRecovery();
    window.dispatchEvent(new Event("project-files-changed"));
    onCompletedRef.current(completedDocument);
  }, [discardRecovery, hasCompletedConflict]);

  const continueCompletedConflictAsNew = useCallback(async () => {
    if (!hasCompletedConflict || actionRef.current !== null || !formRef.current) return;
    const localValues = cloneValues(valuesRef.current);
    setAction("resolve-conflict");
    try {
      const nextDraft = await api.createMaterialOrderDraft(siteId);
      if (nextDraft.status !== "draft" || nextDraft.completion_pending) {
        throw new Error("Eine neue Lagerbestellung konnte noch nicht vorbereitet werden.");
      }
      const serverValues = normalizeMaterialOrderValues(formRef.current, nextDraft.values);
      draftRef.current = nextDraft;
      recoveryRevisionRef.current = nextDraft.revision;
      persistedValuesRef.current = serverValues;
      valuesRef.current = localValues;
      setDraft(nextDraft);
      setValues(localValues);
      setHasCompletedConflict(false);
      setHasRevisionConflict(false);
      setCompletionStateUnknown(false);
      persistRecovery(nextDraft.id, nextDraft.revision, localValues);
      await queueSave(localValues);
      setSaveError(null);
      setRecoveryNotice(true);
    } catch (error) {
      if (mountedRef.current) {
        setSaveState("error");
        setSaveError(error instanceof Error ? error.message : "Die Eingaben konnten nicht in eine neue Bestellung übernommen werden.");
      }
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [hasCompletedConflict, persistRecovery, queueSave, setAction, siteId]);

  const refreshPendingConflict = useCallback(async () => {
    const activeDraft = draftRef.current;
    const activeForm = formRef.current;
    if (!hasPendingConflict || !activeDraft || !activeForm || actionRef.current !== null) return;
    const localValues = cloneValues(valuesRef.current);
    setAction("resolve-conflict");
    try {
      const currentDraft = await api.materialOrderDraft(siteId, activeDraft.id);
      const serverValues = normalizeMaterialOrderValues(activeForm, currentDraft.values);
      const valuesMatch = materialOrderValuesEqual(localValues, serverValues);
      draftRef.current = currentDraft;
      recoveryRevisionRef.current = currentDraft.revision;
      persistedValuesRef.current = serverValues;
      setDraft(currentDraft);
      setCompletionStateUnknown(false);
      if (currentDraft.status === "completed" && valuesMatch && currentDraft.document) {
        discardRecovery();
        window.dispatchEvent(new Event("project-files-changed"));
        onCompletedRef.current(currentDraft.document);
        return;
      }
      if (currentDraft.status === "completed") {
        persistRecovery(currentDraft.id, currentDraft.revision, localValues);
        setHasPendingConflict(false);
        setHasCompletedConflict(true);
        setSaveState("error");
        setSaveError("Diese Bestellung wurde inzwischen an anderer Stelle mit anderen Eingaben abgelegt. Ihre Eingaben bleiben erhalten.");
        return;
      }
      if (currentDraft.completion_pending && !valuesMatch) {
        persistRecovery(currentDraft.id, currentDraft.revision, localValues);
        setSaveState("error");
        setSaveError("Die andere Ablage läuft noch. Ihre Eingaben bleiben erhalten.");
        return;
      }
      if (currentDraft.completion_pending) {
        valuesRef.current = serverValues;
        setValues(serverValues);
        discardRecovery();
        setHasPendingConflict(false);
        setSaveState("error");
        setSaveError("Die Ablage der PDF ist noch nicht abgeschlossen. Ihre Eingaben sind geschützt.");
        return;
      }
      setHasPendingConflict(false);
      setHasRevisionConflict(!valuesMatch);
      setSaveState(valuesMatch ? "saved" : "error");
      setSaveError(valuesMatch
        ? null
        : "Dieser Entwurf wurde inzwischen an anderer Stelle geändert. Ihre Eingaben bleiben erhalten.");
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "Der Ablagestatus konnte nicht geprüft werden.");
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [discardRecovery, hasPendingConflict, persistRecovery, setAction, siteId]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        void printCurrentValues();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (isZoomOpen) {
          setIsZoomOpen(false);
          window.requestAnimationFrame(() => zoomTriggerRef.current?.focus());
          return;
        }
        void closeWithSave();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hidden && element.tabIndex >= 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeWithSave, isZoomOpen, printCurrentValues]);

  function updateField(event: ChangeEvent<HTMLInputElement>, name: string, type: "text" | "checkbox") {
    const value = type === "checkbox" ? event.currentTarget.checked : event.currentTarget.value;
    setSaveError(null);
    setRecoveryNotice(false);
    setValues((current) => {
      const next = { ...current, [name]: value };
      valuesRef.current = next;
      return next;
    });
  }

  function keepFocusInside(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key === "Enter" && event.target === event.currentTarget) {
      event.preventDefault();
    }
  }

  const isBusy = action !== null;
  const isFormReadOnly = isBusy || draft?.status === "completed" || Boolean(draft?.completion_pending) || completionStateUnknown;
  const paperStyle = form ? {
    width: `${form.width * zoom / 100}px`,
    height: `${form.height * zoom / 100}px`,
  } satisfies CSSProperties : undefined;

  const status = completionStateUnknown
    ? {
        icon: <LoaderCircle aria-hidden="true" className="is-spinning" />,
        text: isRecoveryStored ? "Ablage unklar – lokal gesichert" : "Ablage unklar – nur in diesem Fenster",
        tone: "warning",
      }
    : draft?.completion_pending
    ? { icon: <LoaderCircle aria-hidden="true" className="is-spinning" />, text: "Ablage noch nicht abgeschlossen", tone: "warning" }
    : !isOnline
    ? {
        icon: <WifiOff aria-hidden="true" />,
        text: isRecoveryStored ? "Offline – lokal gesichert" : "Offline – nur in diesem Fenster",
        tone: "warning",
      }
    : saveState === "saving" || action === "close"
      ? { icon: <LoaderCircle aria-hidden="true" className="is-spinning" />, text: "Wird gespeichert …", tone: "working" }
      : saveState === "saved"
        ? { icon: <Check aria-hidden="true" />, text: "Alle Änderungen gespeichert", tone: "success" }
        : saveState === "error"
          ? {
              icon: <WifiOff aria-hidden="true" />,
              text: isRecoveryStored
                ? "Speichern fehlgeschlagen – lokal gesichert"
                : "Speichern fehlgeschlagen – nur in diesem Fenster",
              tone: "danger",
            }
          : { icon: <Save aria-hidden="true" />, text: "Ungespeicherte Änderungen", tone: "neutral" };
  const showSaveStatus = !isLoading && (
    saveState !== "saved" || !isOnline || completionStateUnknown || Boolean(draft?.completion_pending)
  );

  return createPortal(
    <div className="material-order-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="material-order-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="material-order-dialog-title"
        onKeyDown={keepFocusInside}
      >
        <header className="material-order-dialog-header">
          <div className="material-order-header-title">
            <h2 id="material-order-dialog-title">Neue Lagerbestellung</h2>
            {showSaveStatus ? (
              <span className={`material-order-save-status is-${status.tone}`} role="status" aria-live="polite">
                {status.icon}<span>{status.text}</span>
              </span>
            ) : null}
          </div>
          <div className="material-order-header-actions">
            <div className="material-order-zoom" ref={zoomMenuRef}>
              <button
                ref={zoomTriggerRef}
                type="button"
                role="combobox"
                className="material-order-zoom-trigger"
                aria-label="Dokumentzoom"
                aria-haspopup="listbox"
                aria-expanded={isZoomOpen}
                aria-controls="material-order-zoom-options"
                aria-activedescendant={isZoomOpen ? `material-order-zoom-option-${activeZoomIndex}` : undefined}
                onClick={() => {
                  setActiveZoomIndex(MATERIAL_ORDER_ZOOM_LEVELS.indexOf(zoom));
                  setIsZoomOpen((current) => !current);
                }}
                onKeyDown={(event) => {
                  const selectedIndex = MATERIAL_ORDER_ZOOM_LEVELS.indexOf(zoom);
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setIsZoomOpen(false);
                    zoomTriggerRef.current?.focus();
                    return;
                  }
                  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    const nextIndex = event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? MATERIAL_ORDER_ZOOM_LEVELS.length - 1
                        : !isZoomOpen
                          ? selectedIndex
                          : Math.max(0, Math.min(
                              MATERIAL_ORDER_ZOOM_LEVELS.length - 1,
                              activeZoomIndex + (event.key === "ArrowDown" ? 1 : -1),
                            ));
                    setActiveZoomIndex(nextIndex);
                    setIsZoomOpen(true);
                  } else if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    if (isZoomOpen) changeZoom(MATERIAL_ORDER_ZOOM_LEVELS[activeZoomIndex] ?? zoom);
                    else {
                      setActiveZoomIndex(selectedIndex);
                      setIsZoomOpen(true);
                    }
                  }
                }}
              >
                <span>{zoom} %</span><ChevronDown aria-hidden="true" />
              </button>
              {isZoomOpen ? (
                <div className="material-order-zoom-options" id="material-order-zoom-options" role="listbox" aria-label="Dokumentzoom">
                  {MATERIAL_ORDER_ZOOM_LEVELS.map((level, index) => (
                    <button
                      key={level}
                      id={`material-order-zoom-option-${index}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={level === zoom}
                      className={index === activeZoomIndex ? "is-active" : ""}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => changeZoom(level)}
                    >
                      <span>{level} %</span>{level === zoom ? <Check aria-hidden="true" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="material-order-secondary-button material-order-print-button"
              aria-label="Drucken und ablegen"
              title="Drucken und ablegen"
              disabled={isBusy || isLoading || !draft || hasRevisionConflict || hasPendingConflict || hasCompletedConflict}
              onClick={() => void printCurrentValues()}
            >
              {action === "print" ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Printer aria-hidden="true" />}
              <span>Drucken</span>
            </button>
            <button
              ref={firstFocusRef}
              type="button"
              className="material-order-icon-button"
              aria-label="Schließen – Entwurf bleibt erhalten"
              title="Schließen – Entwurf bleibt erhalten"
              disabled={isBusy}
              onClick={() => void closeWithSave()}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        {recoveryNotice ? (
          <p className="material-order-recovery-note" role="status">
            Ihre zuletzt eingegebenen Daten wurden wiederhergestellt.
          </p>
        ) : null}
        {saveError ? (
          <div className="material-order-error" role="alert">
            <span>{saveError}</span>
            {hasCompletedConflict ? (
              <span className="material-order-conflict-actions">
                <button type="button" disabled={isBusy || !draft?.document} onClick={openCompletedConflict}>
                  Abgelegten Stand übernehmen
                </button>
                <button type="button" disabled={isBusy} onClick={() => void continueCompletedConflictAsNew()}>
                  <RefreshCw aria-hidden="true" /> Als neue Bestellung fortsetzen
                </button>
              </span>
            ) : hasPendingConflict ? (
              <span className="material-order-conflict-actions">
                <button type="button" disabled={isBusy} onClick={useServerRevision}>Aktuellen Stand laden</button>
                <button type="button" disabled={isBusy} onClick={() => void refreshPendingConflict()}>
                  <RefreshCw aria-hidden="true" /> Status erneut prüfen
                </button>
              </span>
            ) : hasRevisionConflict ? (
              <span className="material-order-conflict-actions">
                <button type="button" disabled={isBusy} onClick={useServerRevision}>Aktuellen Entwurf laden</button>
                <button type="button" disabled={isBusy} onClick={() => void resolveRevisionConflict()}>
                  <RefreshCw aria-hidden="true" /> Meine Eingaben übernehmen
                </button>
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="material-order-workspace">
          {isLoading ? (
            <div className="material-order-loading" role="status">
              <LoaderCircle aria-hidden="true" className="is-spinning" />
              <strong>Lagerbestellung wird vorbereitet …</strong>
              <span>Vorlage und Formularfelder werden geladen.</span>
            </div>
          ) : loadError ? (
            <div className="material-order-loading is-error" role="alert">
              <strong>Lagerbestellung konnte nicht geöffnet werden.</strong>
              <span>{loadError}</span>
              <button type="button" onClick={() => setLoadVersion((current) => current + 1)}>
                <RefreshCw aria-hidden="true" /> Erneut versuchen
              </button>
            </div>
          ) : form && previewUrl ? (
            <div className="material-order-paper-stage">
              <div className="material-order-paper" style={paperStyle} data-document-zoom={zoom}>
                <img className="material-order-pdf-background" src={previewUrl} alt="Lagerbestellungsformular" draggable="false" />
                <div className="material-order-field-overlay">
                  {form.fields.map((field) => {
                    const style = materialOrderRectStyle(field.rect, form);
                    const fieldValue = values[field.name];
                    if (field.type === "checkbox") {
                      return (
                        <label key={field.name} className="material-order-checkbox-field" style={style} title={field.label}>
                          <span className="material-order-visually-hidden">{field.label}</span>
                          <input
                            type="checkbox"
                            checked={fieldValue === true}
                            disabled={isFormReadOnly}
                            onChange={(event) => updateField(event, field.name, field.type)}
                          />
                        </label>
                      );
                    }
                    return (
                      <label key={field.name} className="material-order-text-field" style={style} title={field.label}>
                        <span className="material-order-visually-hidden">{field.label}</span>
                        <input
                          type="text"
                          aria-label={field.label}
                          autoComplete="off"
                          maxLength={field.max_length ?? undefined}
                          style={materialOrderInputStyle(field, form)}
                          value={typeof fieldValue === "string" ? fieldValue : ""}
                          disabled={isFormReadOnly}
                          onChange={(event) => updateField(event, field.name, field.type)}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <footer className="material-order-dialog-footer">
          <div>
            <button
              type="button"
              className="material-order-secondary-button"
              disabled={isBusy || isLoading || !draft}
              onClick={() => void closeWithSave()}
            >
              {action === "close" ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Save aria-hidden="true" />}
              Später fortsetzen
            </button>
            <button
              type="button"
              className="material-order-primary-button"
              disabled={
                isBusy
                || isLoading
                || !draft
                || hasRevisionConflict
                || hasPendingConflict
                || hasCompletedConflict
                || (draft.status === "completed" && !hasPrintIntent)
              }
              onClick={() => void (hasPrintIntent ? printCurrentValues() : complete())}
            >
              {action === "complete" || action === "print"
                ? <LoaderCircle aria-hidden="true" className="is-spinning" />
                : hasPrintIntent ? <Printer aria-hidden="true" /> : <Check aria-hidden="true" />}
              {hasPrintIntent && draft?.status === "completed"
                ? "Drucken erneut versuchen"
                : hasPrintIntent
                  ? "Ablage & Drucken erneut versuchen"
                : draft?.status === "completed"
                  ? "Bereits abgelegt"
                : draft?.completion_pending || completionStateUnknown
                  ? "Ablage erneut versuchen"
                  : "Speichern & schließen"}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
