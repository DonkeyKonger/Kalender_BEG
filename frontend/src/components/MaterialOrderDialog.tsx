import { Check, LoaderCircle, Printer, RefreshCw, Save, WifiOff, X } from "lucide-react";
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
  clearMaterialOrderRecovery,
  getMaterialOrderRecoveryKey,
  materialOrderRectStyle,
  materialOrderValuesEqual,
  normalizeMaterialOrderValues,
  readMaterialOrderRecovery,
  writeMaterialOrderRecovery,
  type MaterialOrderDraft,
  type MaterialOrderForm,
  type MaterialOrderValues,
} from "../lib/materialOrders";
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

function initialZoom(): number {
  return typeof window !== "undefined" && window.innerWidth < 720 ? 90 : 125;
}

function getMaterialOrderStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
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

function openPrintWindow(): Window {
  const printWindow = window.open("", "_blank", "popup,width=920,height=820");
  if (!printWindow) throw new Error("Das Druckfenster wurde blockiert. Bitte Pop-ups für den Kalender erlauben.");
  printWindow.document.open();
  printWindow.document.write(`<!doctype html><html lang="de"><head><title>Lagerbestellung</title>
    <style>
      @page { size: A4; margin: 0; }
      html, body { margin: 0; background: #fff; }
      body { font-family: Arial, sans-serif; }
      .loading { display: grid; min-height: 100vh; place-items: center; color: #334155; }
      canvas { display: block; width: 210mm; height: auto; break-after: page; page-break-after: always; }
      canvas:last-child { break-after: auto; page-break-after: auto; }
      @media print { .loading { display: none; } }
    </style></head><body><p class="loading">Druckansicht wird erstellt …</p></body></html>`);
  printWindow.document.close();
  return printWindow;
}

async function renderPdfForPrint(blob: Blob, printWindow: Window): Promise<void> {
  const pdfjsLib = await loadCompatiblePdfJs();
  const data = await blob.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data) });
  try {
    const pdfDocument = await loadingTask.promise;
    const body = printWindow.document.body;
    body.replaceChildren();
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const renderCanvas = document.createElement("canvas");
      renderCanvas.width = Math.ceil(viewport.width);
      renderCanvas.height = Math.ceil(viewport.height);
      const renderContext = renderCanvas.getContext("2d", { alpha: false });
      if (!renderContext) throw new Error("Druckansicht konnte nicht gerendert werden.");
      await page.render({
        canvas: renderCanvas,
        canvasContext: renderContext,
        viewport,
        intent: "print",
        annotationMode: pdfjsLib.AnnotationMode.ENABLE,
      }).promise;
      const printCanvas = printWindow.document.createElement("canvas");
      printCanvas.width = renderCanvas.width;
      printCanvas.height = renderCanvas.height;
      printCanvas.setAttribute("aria-label", `Lagerbestellung Seite ${pageNumber}`);
      const printContext = printCanvas.getContext("2d", { alpha: false });
      if (!printContext) throw new Error("Druckansicht konnte nicht übertragen werden.");
      printContext.drawImage(renderCanvas, 0, 0);
      body.append(printCanvas);
      renderCanvas.width = 0;
      renderCanvas.height = 0;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    if (printWindow.closed) throw new Error("Das Druckfenster wurde vorzeitig geschlossen.");
    printWindow.focus();
    printWindow.print();
  } finally {
    void loadingTask.destroy();
  }
}

export function MaterialOrderDialog({ siteId, onClose, onCompleted }: MaterialOrderDialogProps) {
  const { user } = useAuth();
  const dialogRef = useRef<HTMLElement | null>(null);
  const firstFocusRef = useRef<HTMLButtonElement | null>(null);
  const draftRef = useRef<MaterialOrderDraft | null>(null);
  const formRef = useRef<MaterialOrderForm | null>(null);
  const valuesRef = useRef<MaterialOrderValues>({});
  const persistedValuesRef = useRef<MaterialOrderValues>({});
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const actionRef = useRef<DialogAction>(null);
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
  const [zoom, setZoom] = useState(initialZoom);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [recoveryNotice, setRecoveryNotice] = useState(false);
  const recoveryKey = useMemo(
    () => getMaterialOrderRecoveryKey(siteId, user?.id),
    [siteId, user?.id],
  );

  const setAction = useCallback((next: DialogAction) => {
    actionRef.current = next;
    setActionState(next);
  }, []);

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
      openerRef.current?.focus();
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
    ]).then(async ([nextDraft, nextForm, template]) => {
      nextPreviewUrl = await renderTemplatePreview(template);
      if (cancelled) {
        URL.revokeObjectURL(nextPreviewUrl);
        return;
      }
      const serverValues = normalizeMaterialOrderValues(nextForm, nextDraft.values);
      const hasMatchingRecovery = Boolean(recovery && (recovery.draftId === nextDraft.id || recoveryDraftMissing));
      const recoveryValues = hasMatchingRecovery
        ? normalizeMaterialOrderValues(nextForm, recovery?.values)
        : serverValues;
      const hasDifferentRecovery = Boolean(
        hasMatchingRecovery && !materialOrderValuesEqual(recoveryValues, serverValues),
      );
      const hasCompletedRecoveryConflict = hasDifferentRecovery && nextDraft.status === "completed";
      const hasPendingRecoveryConflict = hasDifferentRecovery && nextDraft.completion_pending;
      const hasStaleRecovery = Boolean(
        hasDifferentRecovery
        && !recoveryDraftMissing
        && recovery
        && recovery.revision < nextDraft.revision
        && nextDraft.status === "draft"
        && !nextDraft.completion_pending,
      );
      const initialValues = hasDifferentRecovery ? recoveryValues : serverValues;
      if (nextDraft.status === "completed" && nextDraft.document && !hasDifferentRecovery) {
        discardRecovery();
        window.dispatchEvent(new Event("project-files-changed"));
        onCompleted(nextDraft.document);
        return;
      }
      draftRef.current = nextDraft;
      formRef.current = nextForm;
      recoveryRevisionRef.current = hasDifferentRecovery && recovery && !recoveryDraftMissing
        ? recovery.revision
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
  }, [discardRecovery, loadVersion, onCompleted, recoveryKey, siteId]);

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
  }, [action, completionStateUnknown, draft, form, hasRevisionConflict, persistRecovery, queueSave, values]);

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
      onClose();
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
      onClose();
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
      onClose();
    } catch {
      // The visible error and recovery copy intentionally keep the dialog open.
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [completionStateUnknown, discardRecovery, hasCompletedConflict, hasPendingConflict, hasRevisionConflict, onClose, queueSave, setAction]);

  const complete = useCallback(async () => {
    if (actionRef.current !== null || !draftRef.current) return;
    const attemptedDraftId = draftRef.current.id;
    setAction("complete");
    setSaveError(null);
    const snapshot = cloneValues(valuesRef.current);
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
      discardRecovery();
      window.dispatchEvent(new Event("project-files-changed"));
      onCompleted(result.document);
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
          discardRecovery();
          window.dispatchEvent(new Event("project-files-changed"));
          onCompleted(currentDraft.document);
          return;
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
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [completionStateUnknown, discardRecovery, onCompleted, persistRecovery, queueSave, setAction, siteId]);

  const printCurrentValues = useCallback(async () => {
    if (actionRef.current !== null || !draftRef.current) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let printWindow: Window;
    try {
      printWindow = openPrintWindow();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Druckfenster konnte nicht geöffnet werden.");
      return;
    }
    printWindow.addEventListener("afterprint", () => {
      if (!printWindow.closed) printWindow.close();
      previousFocus?.focus();
    }, { once: true });
    setAction("print");
    setSaveError(null);
    try {
      await saveQueueRef.current;
      const activeDraft = draftRef.current;
      if (!activeDraft) throw new Error("Der Entwurf ist nicht mehr verfügbar.");
      const pdf = await api.materialOrderPreviewPdf(siteId, activeDraft.id, {
        revision: activeDraft.revision,
        values: cloneValues(valuesRef.current),
      });
      await renderPdfForPrint(pdf, printWindow);
    } catch (error) {
      if (!printWindow.closed) printWindow.close();
      if (mountedRef.current) {
        setSaveError(error instanceof Error ? error.message : "Druckansicht konnte nicht erstellt werden.");
        setHasRevisionConflict(error instanceof ApiError && error.status === 409);
      }
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [setAction, siteId]);

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
          onCompleted(currentDraft.document);
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
  }, [discardRecovery, onCompleted, persistRecovery, queueSave, setAction, siteId]);

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
    onCompleted(completedDocument);
  }, [discardRecovery, hasCompletedConflict, onCompleted]);

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
        onCompleted(currentDraft.document);
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
  }, [discardRecovery, hasPendingConflict, onCompleted, persistRecovery, setAction, siteId]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        void printCurrentValues();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        void closeWithSave();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hidden);
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
  }, [closeWithSave, printCurrentValues]);

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
          <div>
            <span className="material-order-dialog-eyebrow">Baustellendokument</span>
            <h2 id="material-order-dialog-title">Neue Lagerbestellung</h2>
          </div>
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
        </header>

        <div className="material-order-toolbar">
          <div className={`material-order-save-status is-${status.tone}`} role="status" aria-live="polite">
            {status.icon}<span>{status.text}</span>
          </div>
          <label className="material-order-zoom">
            <span>Zoom</span>
            <select aria-label="Dokumentzoom" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
              {MATERIAL_ORDER_ZOOM_LEVELS.map((level) => <option key={level} value={level}>{level} %</option>)}
            </select>
          </label>
          <button
            type="button"
            className="material-order-secondary-button"
            disabled={isBusy || isLoading || !draft}
            onClick={() => void printCurrentValues()}
          >
            {action === "print" ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Printer aria-hidden="true" />}
            Drucken
          </button>
        </div>

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
          <span>Ablage: Lagerbestellungen</span>
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
              disabled={isBusy || isLoading || !draft || hasRevisionConflict || hasPendingConflict || draft.status === "completed"}
              onClick={() => void complete()}
            >
              {action === "complete" ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Check aria-hidden="true" />}
              {draft?.status === "completed"
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
