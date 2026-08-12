import type { ProjectFolderDocumentItem } from "../types/site";
import { formatFileSize, formatGermanDateTimeShort } from "./formatters";
import { getProjectDocumentTypeLabel } from "./projectDocumentSort";

export type ProjectDocumentKind = "folder" | "pdf" | "word" | "excel" | "image" | "mail" | "file";

type ProjectDocumentMetaOptions = {
  includeFallbackType?: boolean;
};

export function getProjectDocumentKind(item: ProjectFolderDocumentItem): ProjectDocumentKind {
  const extension = item.file_extension?.toLowerCase();
  const mimeType = item.mime_type?.toLowerCase() ?? "";

  if (item.is_folder) {
    return "folder";
  }
  if (extension === "pdf" || mimeType.includes("pdf")) {
    return "pdf";
  }
  if (["doc", "docx"].includes(extension ?? "") || mimeType.includes("word")) {
    return "word";
  }
  if (["xls", "xlsx", "xlsm", "csv"].includes(extension ?? "") || mimeType.includes("spreadsheet") || mimeType.includes("excel")) {
    return "excel";
  }
  if (["jpg", "jpeg", "png", "webp"].includes(extension ?? "") || mimeType.startsWith("image/")) {
    return "image";
  }
  if (["msg", "eml"].includes(extension ?? "") || mimeType.includes("message")) {
    return "mail";
  }
  return "file";
}

export function formatProjectFileSize(size: number | null | undefined): string | null {
  return formatFileSize(size);
}

export function formatProjectDocumentMeta(item: ProjectFolderDocumentItem, options: ProjectDocumentMetaOptions = {}): string {
  const type = getProjectDocumentTypeLabel(item, options.includeFallbackType ?? true);
  const changed = item.last_modified_date_time ? `Geändert ${formatGermanDateTimeShort(item.last_modified_date_time)}` : null;
  const size = item.is_folder ? null : formatProjectFileSize(item.size);
  return [type, changed, size].filter(Boolean).join(" · ") || "Datei";
}
