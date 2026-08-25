export const PDF_PREVIEW_MAX_PAGE_PIXELS = 4_000_000;
export const PDF_PREVIEW_MAX_DOCUMENT_PIXELS = 16_000_000;
export const PDF_PREVIEW_RENDER_ERROR_MESSAGE = "PDF konnte nicht angezeigt werden. Bitte erneut versuchen.";

const PDF_PREVIEW_RENDER_QUALITY_MULTIPLIER = 1.35;
const PDF_PREVIEW_MIN_RENDER_PIXEL_RATIO = 1.5;
const PDF_PREVIEW_MAX_RENDER_PIXEL_RATIO = 2.5;

export function getPdfPreviewRenderScale(
  cssWidth: number,
  cssHeight: number,
  pageCount: number,
  devicePixelRatio: number,
): number {
  const normalizedPageCount = Math.max(1, Math.floor(pageCount));
  const pagePixelBudget = Math.min(
    PDF_PREVIEW_MAX_PAGE_PIXELS,
    PDF_PREVIEW_MAX_DOCUMENT_PIXELS / normalizedPageCount,
  );
  const cssPixels = Math.max(cssWidth * cssHeight, 1);
  const pixelBudgetScale = Math.sqrt(pagePixelBudget / cssPixels);
  const targetScale = Math.min(
    Math.max(
      Math.max(devicePixelRatio, 1) * PDF_PREVIEW_RENDER_QUALITY_MULTIPLIER,
      PDF_PREVIEW_MIN_RENDER_PIXEL_RATIO,
    ),
    PDF_PREVIEW_MAX_RENDER_PIXEL_RATIO,
  );
  return Math.max(1, Math.min(targetScale, pixelBudgetScale));
}

export async function renderPdfPagesSequentially<T>({
  isCancelled,
  onPageDiscarded,
  onPageRendered,
  pageCount,
  renderPage,
}: {
  isCancelled: () => boolean;
  onPageDiscarded?: (page: T, pageNumber: number) => void;
  onPageRendered: (page: T, pageNumber: number) => void;
  pageCount: number;
  renderPage: (pageNumber: number) => Promise<T>;
}): Promise<boolean> {
  const normalizedPageCount = Math.max(0, Math.floor(pageCount));
  for (let pageNumber = 1; pageNumber <= normalizedPageCount; pageNumber += 1) {
    if (isCancelled()) {
      return false;
    }
    const renderedPage = await renderPage(pageNumber);
    if (isCancelled()) {
      onPageDiscarded?.(renderedPage, pageNumber);
      return false;
    }
    onPageRendered(renderedPage, pageNumber);
  }
  return true;
}
