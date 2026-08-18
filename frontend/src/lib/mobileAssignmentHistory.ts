import type { MobileAssignment } from "../types/mobile";

export type MobileAssignmentHistoryPeriod = {
  start: string;
  end: string;
};

export type MobileAssignmentHistoryWeek = {
  isoYear: number;
  isoWeek: number;
  weekStart: string;
  periods: MobileAssignmentHistoryPeriod[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildMobileAssignmentHistoryWeeks(
  assignments: MobileAssignment[],
): MobileAssignmentHistoryWeek[] {
  const uniqueDates = new Set<string>();
  assignments.forEach((assignment) => {
    let day = parseIsoDateUtc(assignment.start_date);
    const lastDay = parseIsoDateUtc(assignment.end_date);
    while (day <= lastDay) {
      uniqueDates.add(toIsoDateUtc(day));
      day = new Date(day.getTime() + DAY_MS);
    }
  });

  const weekDates = new Map<string, { isoYear: number; isoWeek: number; weekStart: string; dates: string[] }>();
  Array.from(uniqueDates).sort().forEach((date) => {
    const week = getIsoWeek(date);
    const key = `${week.isoYear}-${week.isoWeek}`;
    const current = weekDates.get(key) ?? { ...week, dates: [] };
    current.dates.push(date);
    weekDates.set(key, current);
  });

  return Array.from(weekDates.values())
    .map((week) => ({
      isoYear: week.isoYear,
      isoWeek: week.isoWeek,
      weekStart: week.weekStart,
      periods: groupContiguousDates(week.dates),
    }))
    .sort((left, right) => right.weekStart.localeCompare(left.weekStart));
}

function groupContiguousDates(dates: string[]): MobileAssignmentHistoryPeriod[] {
  const periods: MobileAssignmentHistoryPeriod[] = [];
  dates.forEach((date) => {
    const previous = periods.at(-1);
    if (previous && addUtcDays(previous.end, 1) === date) {
      previous.end = date;
      return;
    }
    periods.push({ start: date, end: date });
  });
  return periods;
}

function getIsoWeek(value: string): { isoYear: number; isoWeek: number; weekStart: string } {
  const date = parseIsoDateUtc(value);
  const weekdayFromMonday = (date.getUTCDay() + 6) % 7;
  const weekStartDate = new Date(date.getTime() - weekdayFromMonday * DAY_MS);
  const weekThursday = new Date(weekStartDate.getTime() + 3 * DAY_MS);
  const isoYear = weekThursday.getUTCFullYear();
  const januaryFourth = new Date(Date.UTC(isoYear, 0, 4));
  const januaryFourthWeekday = (januaryFourth.getUTCDay() + 6) % 7;
  const firstWeekStart = new Date(januaryFourth.getTime() - januaryFourthWeekday * DAY_MS);
  const isoWeek = Math.floor((weekStartDate.getTime() - firstWeekStart.getTime()) / (7 * DAY_MS)) + 1;
  return { isoYear, isoWeek, weekStart: toIsoDateUtc(weekStartDate) };
}

function addUtcDays(value: string, count: number): string {
  return toIsoDateUtc(new Date(parseIsoDateUtc(value).getTime() + count * DAY_MS));
}

function parseIsoDateUtc(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toIsoDateUtc(value: Date): string {
  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-");
}
