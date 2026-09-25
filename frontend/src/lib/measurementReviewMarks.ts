const PREFIX = "beg:measurement-review-marks:v1";
const MAX_MARKS = 10000;

export function measurementReviewMarksKey(userId: number | undefined, siteId: number, batchId: number): string | null {
  return userId == null ? null : `${PREFIX}:${userId}:${siteId}:${batchId}`;
}

export function measurementReviewCellKey(row: string, column: string): string {
  return JSON.stringify([row, column]);
}

export function readMeasurementReviewMarks(storage: Pick<Storage, "getItem">, key: string): Set<string> {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    if (!Array.isArray(value)) return new Set();
    return new Set(value.slice(0, MAX_MARKS).filter((entry): entry is string => {
      if (typeof entry !== "string" || entry.length > 2048) return false;
      try {
        const cell = JSON.parse(entry);
        return Array.isArray(cell) && cell.length === 2 && cell.every(part => typeof part === "string");
      } catch { return false; }
    }));
  } catch { return new Set(); }
}

export function writeMeasurementReviewMarks(storage: Pick<Storage, "setItem" | "removeItem">, key: string, marks: Set<string>): void {
  try {
    if (marks.size) storage.setItem(key, JSON.stringify([...marks].slice(0, MAX_MARKS)));
    else storage.removeItem(key);
  } catch { /* A full/disabled browser cache must not block reviewing or editing. */ }
}

export function toggleMeasurementReviewMark(marks: Set<string>, key: string): void {
  if (!marks.delete(key)) marks.add(key);
}

// Only this view's explicit row/column keys participate, never screen indices.
export function getMeasurementReviewCell(target: EventTarget | null, table: HTMLTableElement): HTMLTableCellElement | null {
  if (!(target instanceof Element) || target.closest('[role="listbox"]')) return null;
  const cell = target.closest<HTMLTableCellElement>("td, th");
  return cell?.closest("table") === table && cell.dataset.reviewMarkKey ? cell : null;
}

// Some browsers select a word for their native context menu, even on read-only
// cells. Only clear the clicked cell's selection; keep other drafts/focus intact.
export function clearMeasurementReviewSelection(cell: HTMLTableCellElement): void {
  const document = cell.ownerDocument;
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed
    && (cell.contains(selection.anchorNode) || cell.contains(selection.focusNode))) {
    selection.removeAllRanges();
  }
  const editor = document.activeElement;
  if (editor && cell.contains(editor) && (editor.tagName === "INPUT" || editor.tagName === "TEXTAREA")) {
    const input = editor as HTMLInputElement | HTMLTextAreaElement;
    if (input.selectionEnd !== null && input.selectionStart !== input.selectionEnd) {
      input.setSelectionRange(input.selectionEnd, input.selectionEnd);
    }
  }
}

export function paintMeasurementReviewMarks(table: HTMLTableElement, marks: Set<string>): void {
  const columns = Array.from(table.querySelectorAll<HTMLTableColElement>("col[data-review-column]"), col => col.dataset.reviewColumn!);
  for (const row of Array.from(table.rows)) {
    if (!row.dataset.reviewRow) continue;
    for (const cell of Array.from(row.cells)) {
      const column = columns[cell.cellIndex];
      if (!column) continue;
      const key = measurementReviewCellKey(row.dataset.reviewRow, column);
      cell.dataset.reviewMarkKey = key;
      if (marks.has(key)) cell.dataset.reviewMarked = "true";
      else delete cell.dataset.reviewMarked;
    }
  }
}
