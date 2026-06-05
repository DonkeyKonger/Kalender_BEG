type DateKeyYearFormat = "2-digit" | "numeric";

export function formatGermanDateKey(value: string, year: DateKeyYearFormat = "2-digit"): string {
  const parsed = parseDateKey(value);
  if (!parsed) {
    return value;
  }
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year }).format(parsed);
}

export function formatGermanDateKeyRange(start: string, end: string, year: DateKeyYearFormat = "2-digit"): string {
  return `${formatGermanDateKey(start, year)} bis ${formatGermanDateKey(end, year)}`;
}

export function formatGermanDateTimeShort(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

export function formatGermanTimeShort(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatGermanMonthYear(value: Date): string {
  return new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" }).format(value);
}

export function formatGermanDetailDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(parseDateKey(value) ?? new Date(value));
}

export function formatGermanWeekdayShort(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { weekday: "short" }).format(parseDateKey(value) ?? new Date(value));
}

export function formatGermanWeekdayShortCompact(value: string): string {
  return formatGermanWeekdayShort(value).replace(".", "");
}

export function formatVerboseMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) {
    return "-";
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${rest} Min.`;
  }
  return `${hours} Std. ${rest} Min.`;
}

export function formatHalfHourFromMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) {
    return "-";
  }
  const roundedHours = Math.round(minutes / 30) / 2;
  const normalizedHours = Object.is(roundedHours, -0) ? 0 : roundedHours;
  return `${formatGermanDecimal(normalizedHours, 1)} h`;
}

export function formatHalfHourDeltaFromMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) {
    return "-";
  }
  const roundedSteps = Math.round(minutes / 30);
  if (roundedSteps === 0) {
    return "0,0 h";
  }
  const prefix = minutes > 0 ? "+" : minutes < 0 ? "-" : "";
  return `${prefix}${formatHalfHourFromMinutes(Math.abs(minutes))}`;
}

export function formatHoursFromMinutes(minutes: number): string {
  return `${formatGermanDecimal(minutes / 60, 1)} h`;
}

export function formatFileSize(size: number | null | undefined): string | null {
  if (typeof size !== "number") {
    return null;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function parseDateKey(value: string): Date | null {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(year, month - 1, day);
}

function formatGermanDecimal(value: number, fractionDigits: number): string {
  return value.toLocaleString("de-DE", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}
