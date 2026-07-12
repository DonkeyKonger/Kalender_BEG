const DAY_MS = 24 * 60 * 60 * 1000;

export type PlanningRange = {
  start: string;
  end: string;
  label: string;
};

export function getDefaultPlanningRange(referenceDate = new Date()): PlanningRange {
  const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const start = addDays(today, -14);
  const end = addDays(today, 48);
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

export function isWeekendDate(value: string): boolean {
  const day = parseDate(value).getDay();
  return day === 0 || day === 6;
}

export type IsoWeekInfo = {
  isoYear: number;
  week: number;
};

export type HolidayInfo = {
  name: string;
  date: string;
  state: "NI";
};

export function getIsoWeekInfo(value: string): IsoWeekInfo {
  const localDate = parseDate(value);
  const date = new Date(Date.UTC(localDate.getFullYear(), localDate.getMonth(), localDate.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / DAY_MS) + 1) / 7);
  return { isoYear, week };
}

export function getIsoWeekStartDate(referenceDate: Date | string = new Date()): string {
  const parsedDate = typeof referenceDate === "string"
    ? parseDate(referenceDate)
    : new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const isoWeekday = parsedDate.getDay() || 7;
  parsedDate.setDate(parsedDate.getDate() - isoWeekday + 1);
  return toDateInputValue(parsedDate);
}

export function getEasterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

export function getLowerSaxonyPublicHolidays(year: number): HolidayInfo[] {
  const easter = getEasterSunday(year);
  const fixedHoliday = (name: string, month: number, day: number): HolidayInfo => ({
    name,
    date: year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0"),
    state: "NI",
  });
  const easterRelativeHoliday = (name: string, offsetDays: number): HolidayInfo => ({
    name,
    date: toDateInputValue(addDays(easter, offsetDays)),
    state: "NI",
  });

  return [
    fixedHoliday("Neujahr", 1, 1),
    easterRelativeHoliday("Karfreitag", -2),
    easterRelativeHoliday("Ostermontag", 1),
    fixedHoliday("Tag der Arbeit", 5, 1),
    easterRelativeHoliday("Christi Himmelfahrt", 39),
    easterRelativeHoliday("Pfingstmontag", 50),
    fixedHoliday("Tag der Deutschen Einheit", 10, 3),
    fixedHoliday("Reformationstag", 10, 31),
    fixedHoliday("1. Weihnachtstag", 12, 25),
    fixedHoliday("2. Weihnachtstag", 12, 26),
  ].sort((left, right) => left.date.localeCompare(right.date));
}

export function getLowerSaxonyPublicHolidayMap(years: Iterable<number>): Map<string, HolidayInfo> {
  const holidays = new Map<string, HolidayInfo>();
  for (const year of new Set(years)) {
    getLowerSaxonyPublicHolidays(year).forEach((holiday) => {
      holidays.set(holiday.date, holiday);
    });
  }
  return holidays;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function parseDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function toDateInputValue(date: Date): string {
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
