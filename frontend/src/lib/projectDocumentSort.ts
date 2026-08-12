import type { ProjectFolderDocumentItem } from "../types/site";

export type ProjectDocumentSortKey = "name" | "type" | "modified" | "size";
export type ProjectDocumentSortDirection = "asc" | "desc";
export type ProjectDocumentSort = {
  key: ProjectDocumentSortKey;
  direction: ProjectDocumentSortDirection;
};

export const DEFAULT_PROJECT_DOCUMENT_SORT: ProjectDocumentSort = {
  key: "modified",
  direction: "desc",
};

const projectDocumentNameCollator = new Intl.Collator("de-DE", {
  numeric: true,
  sensitivity: "base",
});

export function getProjectDocumentTypeLabel(
  item: ProjectFolderDocumentItem,
  includeFallbackType = true,
): string | null {
  if (item.is_folder) {
    return "Ordner";
  }
  return item.file_extension?.toUpperCase() ?? item.mime_type ?? (includeFallbackType ? "Datei" : null);
}

export function getNextProjectDocumentSort(
  current: ProjectDocumentSort,
  key: ProjectDocumentSortKey,
): ProjectDocumentSort {
  if (current.key === key) {
    return {
      key,
      direction: current.direction === "asc" ? "desc" : "asc",
    };
  }
  return {
    key,
    direction: key === "modified" ? "desc" : "asc",
  };
}

export function sortProjectDocumentItems(
  items: readonly ProjectFolderDocumentItem[],
  sort: ProjectDocumentSort,
): ProjectFolderDocumentItem[] {
  return [...items].sort((left, right) => {
    const primaryResult = compareProjectDocumentItems(left, right, sort);
    if (primaryResult !== 0) {
      return primaryResult;
    }

    const nameResult = projectDocumentNameCollator.compare(left.name, right.name);
    if (nameResult !== 0) {
      return nameResult;
    }
    return projectDocumentNameCollator.compare(left.id, right.id);
  });
}

function compareProjectDocumentItems(
  left: ProjectFolderDocumentItem,
  right: ProjectFolderDocumentItem,
  sort: ProjectDocumentSort,
): number {
  if (sort.key === "name") {
    return applyDirection(projectDocumentNameCollator.compare(left.name, right.name), sort.direction);
  }
  if (sort.key === "type") {
    const leftType = getProjectDocumentTypeLabel(left) ?? "Datei";
    const rightType = getProjectDocumentTypeLabel(right) ?? "Datei";
    return applyDirection(projectDocumentNameCollator.compare(leftType, rightType), sort.direction);
  }
  if (sort.key === "modified") {
    return compareOptionalNumbers(
      parseProjectDocumentTimestamp(left.last_modified_date_time),
      parseProjectDocumentTimestamp(right.last_modified_date_time),
      sort.direction,
    );
  }
  return compareOptionalNumbers(
    left.is_folder ? null : left.size,
    right.is_folder ? null : right.size,
    sort.direction,
  );
}

function applyDirection(result: number, direction: ProjectDocumentSortDirection): number {
  return direction === "asc" ? result : -result;
}

function compareOptionalNumbers(
  left: number | null,
  right: number | null,
  direction: ProjectDocumentSortDirection,
): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return applyDirection(left - right, direction);
}

function parseProjectDocumentTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
