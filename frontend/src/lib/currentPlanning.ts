import type { MatrixResponse, MatrixRow } from "../types/matrix";

/** Filter rows only: calendar columns, groups and source data stay unchanged. */
export function currentlyPlannedRows(matrix: MatrixResponse): MatrixRow[] {
  const start = matrix.current_planning_start;
  const end = matrix.current_planning_end;
  if (!start || !end) return [];
  const hasCompleteWindow = matrix.start_date <= start && matrix.end_date >= end;
  return matrix.rows.filter((row) => hasCompleteWindow
    // Use live cells so local edits immediately update the filter as well.
    ? row.cells.some((cell) => cell.date >= start && cell.date <= end && cell.assignments.length > 0)
    // In year view, the two-week window can cross into the adjacent year.
    : row.has_current_planning === true);
}
