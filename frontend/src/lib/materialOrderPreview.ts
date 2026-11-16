const MATERIAL_ORDER_PREVIEW_MAX_DEVICE_PIXEL_RATIO = 3;
export const MATERIAL_ORDER_PREVIEW_MAX_PIXELS = 12_000_000;

type PdfJsLegacyModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDocumentLoadingTask = ReturnType<PdfJsLegacyModule["getDocument"]>;
type PdfDocumentProxy = Awaited<PdfDocumentLoadingTask["promise"]>;
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy["getPage"]>>;
type PdfRenderTask = ReturnType<PdfPageProxy["render"]>;

function normalizedPositiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getMaterialOrderPreviewOutputScale(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  const width = normalizedPositiveNumber(cssWidth, 1);
  const height = normalizedPositiveNumber(cssHeight, 1);
  const requestedScale = Math.min(
    Math.max(normalizedPositiveNumber(devicePixelRatio, 1), 1),
    MATERIAL_ORDER_PREVIEW_MAX_DEVICE_PIXEL_RATIO,
  );
  const budgetScale = Math.sqrt(MATERIAL_ORDER_PREVIEW_MAX_PIXELS / (width * height));
  return Math.min(requestedScale, budgetScale);
}

export class LatestSerialTaskQueue {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: (isCurrent: () => boolean) => Promise<T>): Promise<T | null> {
    const generation = ++this.generation;
    const isCurrent = () => generation === this.generation;
    const result = this.tail.then(async () => {
      if (!isCurrent()) return null;
      const value = await task(isCurrent);
      return isCurrent() ? value : null;
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  invalidate(): void {
    this.generation += 1;
  }

  whenIdle(): Promise<void> {
    return this.tail;
  }
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PDF-Vorschau konnte nicht erzeugt werden."));
    }, "image/png");
  });
}

function isRenderingCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

export class MaterialOrderTemplateRenderer {
  private readonly tasks = new LatestSerialTaskQueue();
  private readonly loadingTask: PdfDocumentLoadingTask;
  private readonly page: PdfPageProxy;
  private readonly baseWidth: number;
  private readonly annotationMode: number;
  private activeRenderTask: PdfRenderTask | null = null;
  private disposed = false;

  private constructor(
    loadingTask: PdfDocumentLoadingTask,
    page: PdfPageProxy,
    baseWidth: number,
    annotationMode: number,
  ) {
    this.loadingTask = loadingTask;
    this.page = page;
    this.baseWidth = baseWidth;
    this.annotationMode = annotationMode;
  }

  static async create(template: Blob): Promise<MaterialOrderTemplateRenderer> {
    const [{ loadCompatiblePdfJs }, data] = await Promise.all([
      import("./pdfJsCompatibility"),
      template.arrayBuffer(),
    ]);
    const pdfjs = await loadCompatiblePdfJs();
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
    try {
      const pdfDocument = await loadingTask.promise;
      const page = await pdfDocument.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      return new MaterialOrderTemplateRenderer(
        loadingTask,
        page,
        baseViewport.width,
        pdfjs.AnnotationMode.DISABLE,
      );
    } catch (error) {
      void loadingTask.destroy();
      throw error;
    }
  }

  render(cssWidth: number, cssHeight: number, devicePixelRatio: number): Promise<Blob | null> {
    if (this.disposed) return Promise.resolve(null);
    this.cancelActiveRender();
    return this.tasks.enqueue(async (isCurrent) => {
      if (this.disposed || !isCurrent()) return null;
      const outputScale = getMaterialOrderPreviewOutputScale(cssWidth, cssHeight, devicePixelRatio);
      const viewport = this.page.getViewport({
        scale: (normalizedPositiveNumber(cssWidth, this.baseWidth) / this.baseWidth) * outputScale,
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        canvas.width = 0;
        canvas.height = 0;
        throw new Error("PDF-Vorschau konnte nicht initialisiert werden.");
      }
      try {
        const renderTask = this.page.render({
          canvas,
          canvasContext: context,
          viewport,
          annotationMode: this.annotationMode,
          background: "#ffffff",
        });
        this.activeRenderTask = renderTask;
        try {
          await renderTask.promise;
        } catch (error) {
          if (this.disposed || !isCurrent() || isRenderingCancelled(error)) return null;
          throw error;
        } finally {
          if (this.activeRenderTask === renderTask) this.activeRenderTask = null;
        }
        if (this.disposed || !isCurrent()) return null;
        const blob = await canvasToPngBlob(canvas);
        return this.disposed || !isCurrent() ? null : blob;
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    });
  }

  cancelPendingRender(): void {
    this.tasks.invalidate();
    this.cancelActiveRender();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPendingRender();
    await this.tasks.whenIdle();
    this.page.cleanup();
    await this.loadingTask.destroy();
  }

  private cancelActiveRender(): void {
    try {
      this.activeRenderTask?.cancel();
    } catch {
      // A task that finished between the checks no longer needs cancellation.
    }
  }
}

export async function createDecodedMaterialOrderPreviewUrl(blob: Blob): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    if (typeof image.decode === "function") {
      await image.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => reject(new Error("PDF-Vorschau konnte nicht geladen werden.")), { once: true });
      });
    }
    return url;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export function observeMaterialOrderDevicePixelRatio(onChange: (devicePixelRatio: number) => void): () => void {
  let resolutionQuery: MediaQueryList | null = null;
  let animationFrame: number | null = null;

  const removeResolutionListener = () => {
    resolutionQuery?.removeEventListener("change", scheduleUpdate);
    resolutionQuery = null;
  };
  const armResolutionListener = () => {
    removeResolutionListener();
    if (typeof window.matchMedia !== "function") return;
    const ratio = normalizedPositiveNumber(window.devicePixelRatio, 1);
    resolutionQuery = window.matchMedia(`(resolution: ${ratio}dppx)`);
    resolutionQuery.addEventListener("change", scheduleUpdate);
  };
  const commitUpdate = () => {
    animationFrame = null;
    onChange(normalizedPositiveNumber(window.devicePixelRatio, 1));
    armResolutionListener();
  };
  function scheduleUpdate(): void {
    if (animationFrame !== null) return;
    animationFrame = window.requestAnimationFrame(commitUpdate);
  }

  armResolutionListener();
  window.addEventListener("resize", scheduleUpdate);
  window.visualViewport?.addEventListener("resize", scheduleUpdate);
  return () => {
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    removeResolutionListener();
    window.removeEventListener("resize", scheduleUpdate);
    window.visualViewport?.removeEventListener("resize", scheduleUpdate);
  };
}
