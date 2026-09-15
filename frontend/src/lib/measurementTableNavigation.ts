export type MeasurementCellCoordinate = { row: number; column: number };
export type MeasurementArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export function getMeasurementNavigationTarget<T extends MeasurementCellCoordinate>(
  cells: readonly T[], current: MeasurementCellCoordinate, key: MeasurementArrowKey,
): T | undefined {
  const vertical = key === "ArrowUp" || key === "ArrowDown";
  const direction = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
  const axis = vertical ? "row" : "column";
  const fixedAxis = vertical ? "column" : "row";
  return cells.filter(cell => cell[fixedAxis] === current[fixedAxis]
      && (cell[axis] - current[axis]) * direction > 0)
    .sort((a, b) => Math.abs(a[axis] - current[axis]) - Math.abs(b[axis] - current[axis]))[0];
}

export function navigateMeasurementTable(event: KeyboardEvent, table: HTMLTableElement): void {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const source = event.target;
  if (!(source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement)) return;
  const sourceCell = source.closest("td, th") as HTMLTableCellElement | null;
  if (!sourceCell || source.closest("table") !== table) return;
  const sourceRow = sourceCell.parentElement as HTMLTableRowElement;
  const cells = Array.from(table.rows).flatMap(row => Array.from(row.cells).flatMap(cell => {
    const input = cell.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([disabled]):not([readonly]):not([type="hidden"]), textarea:not([disabled]):not([readonly])',
    );
    return input ? [{ row: row.rowIndex, column: cell.cellIndex, input }] : [];
  }));
  const target = getMeasurementNavigationTarget(cells,
    { row: sourceRow.rowIndex, column: sourceCell.cellIndex }, event.key as MeasurementArrowKey);
  // At the table edges keep the current cell, without wrapping or page scrolling.
  event.preventDefault();
  if (!target) return;
  target.input.focus({ preventScroll: true });
  target.input.select();
  target.input.scrollIntoView({ block: "nearest", inline: "nearest" });
}
