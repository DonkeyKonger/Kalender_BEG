export const MAX_EXTRA_WORK_DAILY_HOURS = 24;
const MAX_EXTRA_WORK_DAILY_HOURS_ERROR = "Maximal 24,00 h pro Tag";

export function parseExtraWorkHoursInput(value: string): number {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) {
    return 0;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getExtraWorkDailyHoursTotalError(
  values: readonly (string | number | null | undefined)[],
): string | null {
  let total = 0;
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    const parsed = Number(String(value).trim().replace(",", "."));
    if (!Number.isFinite(parsed)) {
      return "Bitte gültige Stunden eingeben";
    }
    if (parsed < 0) {
      return "Mindestens 0,00 h pro Tag";
    }
    total += parsed;
  }
  if (total > MAX_EXTRA_WORK_DAILY_HOURS) {
    return MAX_EXTRA_WORK_DAILY_HOURS_ERROR;
  }
  return null;
}

export function formatExtraWorkHours(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "-";
  }
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}
