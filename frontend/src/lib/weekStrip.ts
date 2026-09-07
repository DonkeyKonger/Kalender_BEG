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

export function trailingWeekWindowStart(
  selectedIndex: number,
  optionCount: number,
  visibleCount = PAYROLL_WEEK_VISIBLE_COUNT,
): number {
  if (selectedIndex < 0 || selectedIndex >= optionCount) {
    return 0;
  }
  const preferredPosition = Math.max(1, visibleCount) - 1;
  return clampWeekWindowStart(selectedIndex - preferredPosition, optionCount, visibleCount);
}

export function isoWeeksInYear(year: number): number {
  const firstWeekday = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return firstWeekday === 4 || (firstWeekday === 3 && isLeapYear) ? 53 : 52;
}
