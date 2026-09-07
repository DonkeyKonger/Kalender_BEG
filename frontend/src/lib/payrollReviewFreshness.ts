import type { TimeEntryWeeklyReview } from "../types/timeEntry";

export type PayrollReviewDataContext = {
  mode: "week" | "month";
  rangeKey: string;
  personId: number | null;
};

export type PayrollReviewSourceReadiness = {
  expectedKey: string;
  loadedKey: string | null;
  isLoading: boolean;
  error: string | null;
};

export type PayrollMonthSelection = {
  year: number;
  month: number;
};

export function arePayrollReviewSourcesReady(sources: PayrollReviewSourceReadiness[]): boolean {
  return sources.every((source) => (
    source.loadedKey === source.expectedKey
    && !source.isLoading
    && source.error === null
  ));
}

export function isSamePayrollReviewDataContext(
  started: PayrollReviewDataContext,
  current: PayrollReviewDataContext,
): boolean {
  return started.mode === current.mode
    && started.rangeKey === current.rangeKey
    && started.personId === current.personId;
}

export function isPayrollReviewRangeAffected(
  started: PayrollReviewDataContext,
  current: PayrollReviewDataContext,
  workDates: string[],
): boolean {
  if (started.rangeKey === current.rangeKey) {
    return true;
  }
  const [rangeStart, rangeEnd] = current.rangeKey.split(":");
  if (!isIsoDate(rangeStart) || !isIsoDate(rangeEnd)) {
    return false;
  }
  return workDates.some((workDate) => (
    isIsoDate(workDate)
    && workDate >= rangeStart
    && workDate <= rangeEnd
  ));
}

export function payrollMonthSelectionsForWorkDates(workDates: string[]): PayrollMonthSelection[] {
  const selections = new Map<string, PayrollMonthSelection>();
  workDates.forEach((workDate) => {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(workDate);
    if (!match) {
      return;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isInteger(year) || month < 1 || month > 12) {
      return;
    }
    selections.set(`${year}-${month}`, { year, month });
  });
  return [...selections.values()].sort((left, right) => left.year - right.year || left.month - right.month);
}

export function payrollMonthSelectionsForReviewImpact(workDates: string[]): PayrollMonthSelection[] {
  const impactedDates: string[] = [];
  workDates.forEach((workDate) => {
    const parsed = parseUtcDate(workDate);
    if (!parsed) {
      return;
    }
    const isoWeekday = parsed.getUTCDay() || 7;
    parsed.setUTCDate(parsed.getUTCDate() - isoWeekday + 1);
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(parsed);
      date.setUTCDate(parsed.getUTCDate() + offset);
      impactedDates.push(date.toISOString().slice(0, 10));
    }
  });
  return payrollMonthSelectionsForWorkDates(impactedDates);
}

export function weeklyReviewsForSelection(
  reviews: TimeEntryWeeklyReview[],
  selection: { year: number; week: number },
): TimeEntryWeeklyReview[] {
  return reviews.filter((review) => review.iso_year === selection.year && review.iso_week === selection.week);
}

export function replaceWeeklyReviewYear(
  reviews: TimeEntryWeeklyReview[],
  isoYear: number,
  replacement: TimeEntryWeeklyReview[],
): TimeEntryWeeklyReview[] {
  return [
    ...reviews.filter((review) => review.iso_year !== isoYear),
    ...replacement.filter((review) => review.iso_year === isoYear),
  ];
}

export function upsertWeeklyReview(
  reviews: TimeEntryWeeklyReview[],
  next: TimeEntryWeeklyReview,
): TimeEntryWeeklyReview[] {
  return [
    ...reviews.filter((review) => !(
      review.person_id === next.person_id
      && review.iso_year === next.iso_year
      && review.iso_week === next.iso_week
    )),
    next,
  ];
}

export function isoReviewYearsForWorkDates(workDates: string[]): number[] {
  const years = new Set<number>();
  workDates.forEach((workDate) => {
    const parsed = parseUtcDate(workDate);
    if (!parsed) {
      return;
    }
    const day = parsed.getUTCDay() || 7;
    parsed.setUTCDate(parsed.getUTCDate() + 4 - day);
    years.add(parsed.getUTCFullYear());
  });
  return [...years].sort((left, right) => left - right);
}

export function isPayrollPersonBlockersChangedError(error: unknown): boolean {
  if (!isRecord(error) || error.status !== 409 || !isRecord(error.detail)) {
    return false;
  }
  return error.detail.code === "payroll_person_month_blockers_changed";
}

function parseUtcDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function isIsoDate(value: string | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
