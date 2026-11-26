import { authenticatedFetch } from "../lib/api";
import { parseContentDispositionFilename } from "../lib/namedBlob";

export type PriceComparisonStatus = {
  configured: boolean;
  mode: "local" | "onedrive";
  folder_name: string;
  source_version: string;
  offer_count: number;
  datanorm_count: number;
  active_datanorm: string | null;
  revision: string;
};

export type TableResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total: number;
  clusters?: string[];
  active_file?: string | null;
  warnings?: string[];
  unavailable_sources?: string[];
  revision: string;
};

export type ReferenceArticle = { article_number: string; weight: number };

export type SuggestionResult = TableResult & {
  meta: {
    reference_ratio: number | null;
    reference_deviation_pct: number | null;
    reference_articles_valid: string[];
    eligible_article_count: number;
  };
};

export type ReferencePresets = {
  defaults: ReferenceArticle[];
  presets: Record<string, ReferenceArticle[]>;
  revision: string;
};

export type OfferType = "Erstangebot" | "Folgeangebot" | "Verhandeltes Angebot";
export type OfferPriceLevel = "all" | "below" | "above" | "none";
export type OfferSort = "uploaded" | "date" | "price_asc" | "price_desc";
export type OfferComparisonUnavailableReason =
  | "insufficient_references"
  | "insufficient_coverage"
  | "invalid_prices"
  | "invalid_date"
  | "no_comparable_positions";

export type OfferComparisonQuality = {
  method_version: string;
  as_of: string;
  window_start: string;
  status: "reliable" | "unavailable";
  reason?: OfferComparisonUnavailableReason | null;
  total_positions: number;
  eligible_positions: number;
  matched_positions: number;
  excluded_positions: number;
  reference_offer_count: number;
  value_coverage_pct: number;
  position_coverage_pct: number;
};

export type OfferSummary = {
  source: string;
  original_available?: boolean;
  project: string;
  offer_number: string;
  date: string | null;
  uploaded_at?: string | null;
  offer_type: OfferType;
  discount: number;
  align_netto: boolean;
  position_count: number;
  total_net: number | null;
  price_change: number | null;
  price_change_positions: number | null;
  comparison_quality?: OfferComparisonQuality | null;
};

export type OffersResult = {
  offers: OfferSummary[];
  total: number;
  price_level_counts: Record<OfferPriceLevel, number>;
  warnings?: string[];
  revision: string;
};

export type OfferPositionsResult = TableResult & { offer: OfferSummary };

export type ArticleSummary = {
  article_number: string;
  description: string;
  net_price: number | null;
};

export type ArticlesResult = { articles: ArticleSummary[]; revision: string };

export type ArticleDetailResult = {
  article: Record<string, unknown>;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  statistics: {
    article?: string;
    offer_count?: number;
    offer_count_24m?: number;
    median_24m?: number | null;
    datanorm_price?: number | null;
    median_delta_pct?: number;
    minimum?: number | null;
    maximum?: number | null;
    median?: number | null;
  };
  warnings?: string[];
  unavailable_sources?: string[];
  revision: string;
};

export type RebuildPreview = {
  duplicates: Array<{ offer_number: string; keep: string; remove: string }>;
  revision: string;
  warnings?: string[];
};

export type PriceFile = {
  kind: "offers" | "datanorm";
  name: string;
  size: number;
  modified: string;
  active: boolean;
  original_available?: boolean;
  included_in_comparison?: boolean;
};

export type FilesResult = { files: PriceFile[]; revision: string };

export class PriceComparisonError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PriceComparisonError";
  }
}

type NamedDownload = { blob: Blob; filename: string | null };
export const PRICE_COMPARISON_DATA_CHANGED_EVENT = "price-comparison:data-changed";
const GATEWAY_RETRY_LIMIT = 2;
const GATEWAY_RETRY_DELAY_MS = 1_000;

async function send(path: string, options: RequestInit, retry = true): Promise<Response> {
  return authenticatedFetch(path, options, retry);
}

function mayRetryGatewayTimeout(path: string, options: RequestInit): boolean {
  const method = (options.method ?? "GET").toUpperCase();
  if (method === "GET") return true;
  return method === "POST" && path.split("?", 1)[0] === "/price-comparison/suggestions/preview";
}

function waitForGatewayRetry(signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Abgebrochen", "AbortError"));
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, GATEWAY_RETRY_DELAY_MS);
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Abgebrochen", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function sendJsonWithGatewayRetry(path: string, options: RequestInit): Promise<Response> {
  const retryGatewayTimeout = mayRetryGatewayTimeout(path, options);
  let response = await send(path, options);
  for (let attempt = 0; retryGatewayTimeout && response.status === 504 && attempt < GATEWAY_RETRY_LIMIT; attempt += 1) {
    await waitForGatewayRetry(options.signal);
    response = await send(path, options);
  }
  return response;
}

async function errorFrom(response: Response): Promise<PriceComparisonError> {
  const contentType = response.headers.get("content-type") ?? "";
  let message = `Anfrage fehlgeschlagen (${response.status}).`;
  let detail: unknown;
  try {
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (typeof body === "string" && body.trim()) message = body;
    if (body && typeof body === "object") {
      detail = (body as { detail?: unknown; message?: unknown }).detail
        ?? (body as { message?: unknown }).message;
      if (typeof detail === "string") message = detail;
      else if (Array.isArray(detail)) {
        const messages = detail
          .map((item) => item && typeof item === "object" && typeof (item as { msg?: unknown }).msg === "string" ? String((item as { msg: string }).msg) : "")
          .filter(Boolean);
        if (messages.length) message = messages.join(" ");
      }
      else if (detail && typeof detail === "object" && typeof (detail as { message?: unknown }).message === "string") {
        message = String((detail as { message: string }).message);
      }
    }
  } catch {
    // Keep the useful status fallback when the server did not return a readable body.
  }
  return new PriceComparisonError(response.status, message, detail);
}

export async function priceRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await sendJsonWithGatewayRetry(path, { ...options, headers });
  if (!response.ok) throw await errorFrom(response);
  const result = response.status === 204 ? undefined : await response.json() as unknown;
  if (isPriceComparisonDataMutation(path, options.method)) {
    notifyPriceComparisonDataChanged(path, options.method, result);
  }
  return result as T;
}

function isPriceComparisonDataMutation(path: string, rawMethod?: string): boolean {
  const method = (rawMethod ?? "GET").toUpperCase();
  const pathname = path.split("?", 1)[0];
  if (!pathname.startsWith("/price-comparison/")) return false;
  // Queue operations change only the upload job itself. The data revision is
  // announced when polling observes the completed server-side job.
  if (pathname.startsWith("/price-comparison/upload-jobs")) return false;
  if (method === "PUT" || method === "DELETE" || method === "PATCH") return true;
  return method === "POST" && (pathname === "/price-comparison/files" || pathname === "/price-comparison/maintenance");
}

export function announcePriceComparisonDataChanged(revision: string): void {
  notifyPriceComparisonDataChanged(
    "/price-comparison/upload-jobs",
    "POST",
    { revision },
  );
}

function notifyPriceComparisonDataChanged(path: string, rawMethod: string | undefined, result: unknown): void {
  if (typeof window === "undefined") return;
  const revision = result && typeof result === "object" && typeof (result as { revision?: unknown }).revision === "string"
    ? String((result as { revision: string }).revision)
    : null;
  window.dispatchEvent(new CustomEvent(PRICE_COMPARISON_DATA_CHANGED_EVENT, {
    detail: { path, method: (rawMethod ?? "GET").toUpperCase(), revision },
  }));
}

export async function priceDownload(path: string, options: RequestInit = {}): Promise<NamedDownload> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "*/*");
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await send(path, { ...options, headers });
  if (!response.ok) throw await errorFrom(response);
  return {
    blob: await response.blob(),
    filename: parseContentDispositionFilename(response.headers.get("content-disposition")),
  };
}

export function triggerDownload({ blob, filename }: NamedDownload, fallbackName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename || fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export function queryPath(path: string, values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
