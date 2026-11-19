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

export type OfferSummary = {
  source: string;
  project: string;
  offer_number: string;
  date: string | null;
  offer_type: OfferType;
  discount: number;
  align_netto: boolean;
  position_count: number;
  total_net: number | null;
  price_change: number | null;
  price_change_positions: number | null;
};

export type OffersResult = {
  offers: OfferSummary[];
  total: number;
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

async function send(path: string, options: RequestInit, retry = true): Promise<Response> {
  return authenticatedFetch(path, options, retry);
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
  const response = await send(path, { ...options, headers });
  if (!response.ok) throw await errorFrom(response);
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
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
