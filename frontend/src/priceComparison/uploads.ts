import { priceRequest, type PriceFile } from "./client";

const MAX_UPLOAD_FILES = 200;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_BATCH_BYTES = 160 * 1024 * 1024;
const MAX_FILENAME_CHARACTERS = 220;
const INVALID_FILENAME_CHARACTERS = new Set('/\\:*?"<>|');

export type PriceUploadResult = { revision: string };

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
