import { loadCompatiblePdfJs } from "./pdfJsCompatibility";

export type PreparedMaterialOrderPrint = {
  print: () => void;
  dispose: () => void;
};

const PRINT_ROOT_ID = "material-order-print-root";
const PRINT_CLASS = "material-order-print-ready";
let activePrint: PreparedMaterialOrderPrint | null = null;

const PRINT_STYLES = `
#${PRINT_ROOT_ID} { display: none; }
@media print {
  @page { size: A4 portrait; margin: 0; }
  html.${PRINT_CLASS}, html.${PRINT_CLASS} body {
    display: block !important; position: static !important;
    width: auto !important; height: auto !important; min-height: 0 !important;
    margin: 0 !important; padding: 0 !important; overflow: visible !important;
    background: white !important;
  }
  html.${PRINT_CLASS} body > :not(#${PRINT_ROOT_ID}) { display: none !important; }
  html.${PRINT_CLASS} #${PRINT_ROOT_ID} {
    display: block !important; position: static !important;
    /* Leave a small tolerance for physical-unit rounding in browser printing. */
    width: 209.5mm !important; margin: 0 auto !important; padding: 0 !important;
  }
  html.${PRINT_CLASS} #${PRINT_ROOT_ID} canvas {
    display: block !important;
    /* Keep the page wide and inset its content: shrinking the root lets Safari
       fit it back to full width, overflowing when headers/footers are enabled. */
    width: 190mm !important; height: auto !important; max-height: 270mm !important;
    margin: 0 auto !important; padding: 0 !important; border: 0 !important;
    break-inside: avoid; page-break-inside: avoid;
    print-color-adjust: exact; -webkit-print-color-adjust: exact;
  }
  html.${PRINT_CLASS} #${PRINT_ROOT_ID} canvas:not(:last-child) {
    break-after: page; page-break-after: always;
  }
}
`;

/** Render before saving; printing itself needs neither a popup nor a PDF plugin. */
export async function prepareMaterialOrderPrint(blob: Blob): Promise<PreparedMaterialOrderPrint> {
  const pdfjs = await loadCompatiblePdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  const root = document.createElement("div");
  root.id = PRINT_ROOT_ID;
  root.setAttribute("aria-hidden", "true");
  const style = document.createElement("style");
  style.textContent = PRINT_STYLES;
  const canvases: HTMLCanvasElement[] = [];
  try {
    const pdf = await loadingTask.promise;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      // PDF.js creates font faces in this document. Rendering here avoids the
      // missing fonts seen when drawing directly into a separate print window.
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.setAttribute("aria-label", `Lagerbestellung Seite ${pageNumber}`);
      canvases.push(canvas);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Die Druckansicht konnte nicht vorbereitet werden.");
      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        intent: "print",
        annotationMode: pdfjs.AnnotationMode.ENABLE,
      }).promise;
      root.append(canvas);
    }
  } catch (error) {
    for (const canvas of canvases) { canvas.width = 0; canvas.height = 0; }
    throw error;
  } finally {
    void loadingTask.destroy();
  }

  let disposed = false;
  let started = false;
  let cleanupTimer: number | null = null;
  const prepared: PreparedMaterialOrderPrint = {
    print() {
      if (disposed) throw new Error("Die Druckansicht ist nicht mehr verfügbar. Bitte erneut drucken.");
      if (started) return;
      activePrint?.dispose();
      activePrint = prepared;
      started = true;
      document.head.append(style);
      document.body.append(root);
      document.documentElement.classList.add(PRINT_CLASS);
      window.addEventListener("afterprint", prepared.dispose, { once: true });
      try {
        // Keep the canvases independent of the dialog: Safari can return from
        // print() before afterprint, and the saved form may already be closed.
        window.print();
        // Some embedded browsers omit afterprint. The next interaction in the
        // app is a safe fallback: native print-dialog input never targets it.
        cleanupTimer = window.setTimeout(() => {
          if (disposed) return;
          document.addEventListener("pointerdown", prepared.dispose, { once: true, capture: true });
          document.addEventListener("keydown", prepared.dispose, { once: true, capture: true });
        }, 0);
      } catch (error) {
        prepared.dispose();
        throw error;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("afterprint", prepared.dispose);
      if (cleanupTimer !== null) window.clearTimeout(cleanupTimer);
      document.removeEventListener("pointerdown", prepared.dispose, true);
      document.removeEventListener("keydown", prepared.dispose, true);
      root.remove();
      style.remove();
      for (const canvas of canvases) { canvas.width = 0; canvas.height = 0; }
      if (activePrint === prepared) {
        document.documentElement.classList.remove(PRINT_CLASS);
        activePrint = null;
      }
    },
  };
  return prepared;
}
