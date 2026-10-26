import type { PayrollMonthLockStatus } from "../types/payrollMonth";

export const ABSENCE_PAYROLL_LOCK_MESSAGE = "Abrechnungsmonat bereits abgeschlossen, bitte Rücksprache mit der Buchhaltung, damit Fehlzeiten der Vergangenheit angepasst werden können";
export const ABSENCE_PAYROLL_CHECK_MESSAGE = "Abschlussstatus wird geprüft. Bitte kurz warten oder erneut laden.";
export type AbsencePayrollRange = { person_id: number; start_date: string; end_date: string };

export function absencePayrollMonths(start: string, end: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return [];
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  if (startYear < 2000 || endYear > 2100 || startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) return [];
  const keys: string[] = [];
  for (let index = startYear * 12 + startMonth - 1; index <= endYear * 12 + endMonth - 1; index++) {
    keys.push(`${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`);
  }
  return keys;
}

export function absenceRangeLock(
  statuses: Record<string, PayrollMonthLockStatus>, range: AbsencePayrollRange,
): "locked" | "unknown" | null {
  const months = absencePayrollMonths(range.start_date, range.end_date);
  let unknown = !months.length || !range.person_id;
  for (const key of months) {
    const status = statuses[key];
    if (!status || `${status.year}-${String(status.month).padStart(2, "0")}` !== key) {
      unknown = true;
    } else if (status.status === "LOCKED" || (Array.isArray(status.approved_person_ids) && status.approved_person_ids.includes(range.person_id))) {
      return "locked";
    } else if (status.status !== "OPEN" || !Array.isArray(status.approved_person_ids)) {
      unknown = true;
    }
  }
  return unknown ? "unknown" : null;
}

export function isAbsencePayrollLockError(detail: unknown): boolean {
  if (!detail || typeof detail !== "object" || !("code" in detail)) return false;
  return detail.code === "payroll_month_locked" || detail.code === "payroll_person_month_locked";
}
