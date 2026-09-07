import type { PayrollMonthLockStatus, PayrollMonthPeriod } from "../types/payrollMonth";

export const PAYROLL_CUTOVER_DATE = "2026-08-01";

export type PayrollMonthSelection = {
  year: number;
  month: number;
};

export function payrollApprovedPersonIds(period: PayrollMonthPeriod | null): Set<number> {
  return new Set(period?.person_approvals
    .filter((approval) => approval.status === "APPROVED")
    .map((approval) => approval.person_id) ?? []);
}

export function payrollAllWorkersExportAvailable(period: PayrollMonthPeriod | null): boolean {
  if (!period) return false;
  if (period.status === "LOCKED") {
    return payrollSnapshotVersion(period) !== null && period.artifacts_ready;
  }
  const approvals = period.person_approvals;
  const summary = period.person_approval_summary;
  return Boolean(summary && summary.total_count > 0
    && summary.approved_count === summary.total_count
    && approvals.length === summary.total_count
    && payrollApprovedPersonIds(period).size === summary.total_count
    && approvals.every((approval) => approval.export_ready));
}

export function payrollBusinessDateIso(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new RangeError("Das fachliche Tagesdatum konnte nicht bestimmt werden.");
  }
  return `${year}-${month}-${day}`;
}

export function payrollMonthKey(selection: PayrollMonthSelection): string {
  return `${selection.year}-${String(selection.month).padStart(2, "0")}`;
}

export function payrollMonthKeyForDate(value: string): string | null {
  const selection = payrollMonthSelectionForDate(value);
  return selection ? payrollMonthKey(selection) : null;
}

export function payrollWorkDateLock(
  statuses: Record<string, PayrollMonthLockStatus>,
  workDate: string,
  personId: number | null,
): "unknown" | "month" | "person" | null {
  const key = payrollMonthKeyForDate(workDate);
  const period = key ? statuses[key] : undefined;
  if (!period || !key || payrollMonthKey(period) !== key) return "unknown";
  if (period.status === "LOCKED") return "month";
  if (period.status !== "OPEN" || personId === null || !Array.isArray(period.approved_person_ids)) return "unknown";
  return period.approved_person_ids.includes(personId) ? "person" : null;
}

export function payrollMonthSelectionsForDateRange(start: string, end: string): PayrollMonthSelection[] {
  const uniqueSelections = new Map<string, PayrollMonthSelection>();
  for (const value of [start, end]) {
    const selection = payrollMonthSelectionForDate(value);
    if (selection) {
      uniqueSelections.set(payrollMonthKey(selection), selection);
    }
  }
  return [...uniqueSelections.values()];
}

export function formatPayrollMonthWorkDateContext(value: string | null | undefined): string {
  if (!value) {
    return "Gesamter Monat";
  }
  const parsedDate = parsePayrollDate(value);
  if (!parsedDate) {
    return value;
  }
  const { week, year } = isoWeekForUtcDate(parsedDate);
  const dateLabel = new Intl.DateTimeFormat("de-DE", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parsedDate);
  return `${dateLabel} · KW ${week}/${year}`;
}

export function payrollSnapshotVersion(period: PayrollMonthPeriod | null): number | null {
  if (!period || period.status !== "LOCKED" || !Number.isInteger(period.snapshot_version)) {
    return null;
  }
  return period.snapshot_version;
}

export function payrollMonthFilename(baseName: string, period: PayrollMonthPeriod): string {
  const version = payrollSnapshotVersion(period);
  return `${baseName}${version === null ? "" : `_v${version}`}.xlsx`;
}

function payrollMonthSelectionForDate(value: string): PayrollMonthSelection | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 1 && month >= 1 && month <= 12 ? { year, month } : null;
}

function parsePayrollDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(Date.UTC(year, month - 1, day));
  if (
    result.getUTCFullYear() !== year
    || result.getUTCMonth() !== month - 1
    || result.getUTCDate() !== day
  ) {
    return null;
  }
  return result;
}

function isoWeekForUtcDate(value: Date): { year: number; week: number } {
  const thursday = new Date(value);
  const weekday = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const year = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return { year, week };
}
