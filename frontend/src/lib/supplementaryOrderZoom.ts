export const SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_STORAGE_KEY = "supplementaryOrderDocumentZoom";
export const SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_LEVELS = [25, 50, 75, 90, 100, 110, 125, 150] as const;
export const DEFAULT_SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM = 100;

const MIN_SUPPLEMENTARY_ORDER_PAPER_WIDTH = 760;
const MAX_SUPPLEMENTARY_ORDER_PAPER_WIDTH = 1600;

export type SupplementaryOrderDocumentZoom = typeof SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_LEVELS[number];

type ZoomStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export function normalizeSupplementaryOrderDocumentZoom(value: unknown): SupplementaryOrderDocumentZoom {
  const numericValue = typeof value === "number" ? value : Number(value);
  return SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_LEVELS.includes(numericValue as SupplementaryOrderDocumentZoom)
    ? numericValue as SupplementaryOrderDocumentZoom
    : DEFAULT_SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM;
}

export function readSupplementaryOrderDocumentZoom(storage: ZoomStorage | null): SupplementaryOrderDocumentZoom {
  if (!storage) {
    return DEFAULT_SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM;
  }
  try {
    return normalizeSupplementaryOrderDocumentZoom(
      storage.getItem(SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM;
  }
}

export function writeSupplementaryOrderDocumentZoom(
  storage: ZoomStorage | null,
  zoom: SupplementaryOrderDocumentZoom,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_STORAGE_KEY, String(zoom));
  } catch {
    // Storage can be unavailable in privacy modes; the in-memory selection remains usable.
  }
}

export function getSupplementaryOrderAutoFitWidth(availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    return MIN_SUPPLEMENTARY_ORDER_PAPER_WIDTH;
  }
  return Math.min(
    Math.max(availableWidth, MIN_SUPPLEMENTARY_ORDER_PAPER_WIDTH),
    MAX_SUPPLEMENTARY_ORDER_PAPER_WIDTH,
  );
}

export function getSupplementaryOrderFinalPaperWidth(
  autoFitWidth: number,
  zoom: SupplementaryOrderDocumentZoom,
): number {
  return autoFitWidth * (zoom / 100);
}
