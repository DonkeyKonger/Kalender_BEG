import { priceRequest, type PriceFile } from "./client";

const MAX_UPLOAD_FILES = 200;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_BATCH_BYTES = 160 * 1024 * 1024;
const MAX_FILENAME_CHARACTERS = 220;
const INVALID_FILENAME_CHARACTERS = new Set('/\\:*?"<>|');

export type PriceUploadResult = { revision: string };

export type OfferUploadJobStatus =
  | "queued"
  | "processing"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled";

export type OfferUploadDuplicate = {
  offer_number: string;
  keep: string;
  remove: string;
};

export type OfferUploadJob = {
  id: string;
  client_request_id: string;
  status: OfferUploadJobStatus;
  file_names: string[];
  created_at: string;
  updated_at: string;
  message?: string | null;
  error?: string | null;
  duplicates?: OfferUploadDuplicate[] | null;
  confirmation_revision?: string | null;
  result_revision?: string | null;
};

export type OfferUploadJobsResult = { jobs: OfferUploadJob[] };
export type OfferUploadJobResult = { job: OfferUploadJob };

/** Validate the complete header selection; callers must never upload a subset. */
export function validateOfferFiles(files: readonly File[]): string | null {
  if (!files.length) return "Bitte mindestens eine PDF-Datei auswählen.";
  if (files.length > MAX_UPLOAD_FILES) {
    return "Bitte höchstens 200 PDF-Dateien auswählen.";
  }

  const normalizedNames = new Set<string>();
  let batchBytes = 0;
  for (const file of files) {
    const name = file.name;
    if (!name.toLowerCase().endsWith(".pdf")) {
      return "Bitte ausschließlich PDF-Dateien auswählen.";
    }
    if (
      name !== name.trim()
      || name.startsWith(".")
      || name.endsWith(".")
      || Array.from(name).length > MAX_FILENAME_CHARACTERS
      || Array.from(name).some((character) => (
        (character.codePointAt(0) ?? 0) < 32
        || INVALID_FILENAME_CHARACTERS.has(character)
      ))
    ) {
      return `Der Dateiname „${name}“ ist ungültig.`;
    }
    if (file.size <= 0) return `Die Datei „${name}“ ist leer.`;
    if (file.size > MAX_FILE_BYTES) {
      return `Die Datei „${name}“ ist größer als 40 MB.`;
    }

    batchBytes += file.size;
    if (batchBytes > MAX_BATCH_BYTES) {
      return "Der Upload ist größer als 160 MB.";
    }

    const normalizedName = name.toLocaleLowerCase("de-DE").replaceAll("ß", "ss");
    if (normalizedNames.has(normalizedName)) {
      return "Ein Upload darf jeden Dateinamen nur einmal enthalten.";
    }
    normalizedNames.add(normalizedName);
  }
  return null;
}

export function uploadPriceFiles(
  kind: PriceFile["kind"],
  files: readonly File[],
  expectedRevision: string,
  confirmedDuplicates?: string[],
): Promise<PriceUploadResult> {
  const body = new FormData();
  body.append("kind", kind);
  body.append("expected_revision", expectedRevision);
  files.forEach((file) => body.append("files", file));
  if (confirmedDuplicates !== undefined) {
    body.append("confirmed_duplicates", JSON.stringify(confirmedDuplicates));
  }
  return priceRequest<PriceUploadResult>("/price-comparison/files", {
    method: "POST",
    body,
  });
}

export function createOfferUploadJob(
  files: readonly File[],
  clientRequestId: string,
): Promise<OfferUploadJobResult> {
  const body = new FormData();
  body.append("kind", "offers");
  body.append("client_request_id", clientRequestId);
  files.forEach((file) => body.append("files", file));
  return priceRequest<OfferUploadJobResult>("/price-comparison/upload-jobs", {
    method: "POST",
    body,
  });
}

export function listOfferUploadJobs(signal?: AbortSignal): Promise<OfferUploadJobsResult> {
  return priceRequest<OfferUploadJobsResult>("/price-comparison/upload-jobs", { signal });
}

export function confirmOfferUploadJob(
  jobId: string,
  expectedRevision: string,
  confirmedDuplicates: readonly string[],
): Promise<OfferUploadJobResult> {
  return priceRequest<OfferUploadJobResult>(`/price-comparison/upload-jobs/${encodeURIComponent(jobId)}/confirm`, {
    method: "POST",
    body: JSON.stringify({
      expected_revision: expectedRevision,
      confirmed_duplicates: confirmedDuplicates,
    }),
  });
}

export function cancelOfferUploadJob(jobId: string): Promise<OfferUploadJobResult> {
  return priceRequest<OfferUploadJobResult>(`/price-comparison/upload-jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}
