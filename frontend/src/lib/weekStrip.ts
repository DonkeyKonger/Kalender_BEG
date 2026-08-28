export const PAYROLL_WEEK_VISIBLE_COUNT = 4;

export function clampWeekWindowStart(
  requestedStart: number,
  optionCount: number,
  visibleCount = PAYROLL_WEEK_VISIBLE_COUNT,
): number {
  const safeVisibleCount = Math.max(1, visibleCount);
  const maxStart = Math.max(0, optionCount - safeVisibleCount);
  return Math.min(maxStart, Math.max(0, requestedStart));
}

export function centeredWeekWindowStart(
  selectedIndex: number,
  optionCount: number,
  visibleCount = PAYROLL_WEEK_VISIBLE_COUNT,
): number {
  if (selectedIndex < 0 || selectedIndex >= optionCount) {
    return 0;
  }
  const preferredPosition = Math.floor((Math.max(1, visibleCount) - 1) / 2);
  return clampWeekWindowStart(selectedIndex - preferredPosition, optionCount, visibleCount);
}
