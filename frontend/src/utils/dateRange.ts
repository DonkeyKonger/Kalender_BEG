const DAY_MS = 24 * 60 * 60 * 1000;

export type PlanningRange = {
  start: string;
  end: string;
  label: string;
};

export function getDefaultPlanningRange(referenceDate = new Date()): PlanningRange {
  const monday = startOfWeek(referenceDate);
  const start = addDays(monday, -7);
  const end = addDays(monday, 41);
  return {
    start: toDateInputValue(start),
    end: toDateInputValue(end),
    label: `${formatShortDate(start)} - ${formatShortDate(end)}`,
  };
}

export function formatDayHeader(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { weekday: "short" }).format(parseDate(value));
}

export function formatDayNumber(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" }).format(
    parseDate(value),
  );
}

function startOfWeek(date: Date): Date {
  const normalized = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = normalized.getDay() || 7;
  return addDays(normalized, 1 - day);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function parseDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatShortDate(date: Date): string {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}
