export type CalendarMonthSelection = {
  year: number;
  month: number;
};

export type CalendarMonthOption = CalendarMonthSelection & {
  label: string;
  isCurrent: boolean;
};

export function currentCalendarMonth(now = new Date()): CalendarMonthSelection {
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export function calendarMonthRange(selection: CalendarMonthSelection): { start: string; end: string } {
  if (!Number.isInteger(selection.year) || !Number.isInteger(selection.month) || selection.month < 1 || selection.month > 12) {
    throw new RangeError("Ungültiger Kalendermonat.");
  }
  const start = new Date(Date.UTC(selection.year, selection.month - 1, 1));
  const end = new Date(Date.UTC(selection.year, selection.month, 0));
  return {
    start: utcDateInputValue(start),
    end: utcDateInputValue(end),
  };
}

export function buildCalendarMonthOptions(
  selection: CalendarMonthSelection,
  now = new Date(),
): CalendarMonthOption[] {
  const current = currentCalendarMonth(now);
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    return {
      year: selection.year,
      month,
      label: new Intl.DateTimeFormat("de-DE", { month: "long", timeZone: "UTC" })
        .format(new Date(Date.UTC(selection.year, month - 1, 1))),
      isCurrent: selection.year === current.year && month === current.month,
    };
  });
}

export function buildCalendarMonthWindowOptions(
  selection: CalendarMonthSelection,
  now = new Date(),
): CalendarMonthOption[] {
  const previousDecember = buildCalendarMonthOptions({ year: selection.year - 1, month: 12 }, now)[11];
  return [previousDecember, ...buildCalendarMonthOptions(selection, now)];
}

export function formatCalendarMonth(selection: CalendarMonthSelection): string {
  return new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(selection.year, selection.month - 1, 1)));
}

function utcDateInputValue(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
