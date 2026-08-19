export const MAX_EXTRA_WORK_PHOTOS = 5;
export const MAX_EXTRA_WORK_PHOTO_BYTES = 15 * 1024 * 1024;
export const EXTRA_WORK_PHOTO_ACCEPT = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
].join(",");

const EXTRA_WORK_PHOTO_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export type ExtraWorkAttachmentKind = "image" | "pdf" | "file";

export type ExtraWorkPhotoUploadCandidate = {
  file: File;
  error: string | null;
};

export function validateExtraWorkPhotoFiles(
  files: ArrayLike<File>,
  persistedPhotoCount: number,
): ExtraWorkPhotoUploadCandidate[] {
  let remainingSlots = Math.max(0, MAX_EXTRA_WORK_PHOTOS - persistedPhotoCount);
  return Array.from(files).map((file) => {
    const normalizedContentType = file.type.trim().toLowerCase();
    if (!EXTRA_WORK_PHOTO_CONTENT_TYPES.has(normalizedContentType)) {
      return {
        file,
        error: "Erlaubt sind JPEG, PNG, WebP, HEIC und HEIF.",
      };
    }
    if (file.size <= 0) {
      return { file, error: "Die Datei ist leer." };
    }
    if (file.size > MAX_EXTRA_WORK_PHOTO_BYTES) {
      return { file, error: "Die Datei ist größer als 15 MB." };
    }
    if (remainingSlots <= 0) {
      return { file, error: "Maximal 5 Fotos pro Zusatzauftrag erlaubt." };
    }
    remainingSlots -= 1;
    return { file, error: null };
  });
}

export function getExtraWorkAttachmentKind(contentType: string): ExtraWorkAttachmentKind {
  const normalizedContentType = contentType.trim().toLowerCase();
  if (normalizedContentType.startsWith("image/")) {
    return "image";
  }
  if (normalizedContentType === "application/pdf" || normalizedContentType.includes("pdf")) {
    return "pdf";
  }
  return "file";
}

