export type PayrollCorrectionDraft = {
  start_time: string;
  end_time: string;
  break_minutes: string;
  hours: string;
};

export type PayrollTimeBasisField = "start_time" | "end_time" | "break_minutes";

export type PayrollTimeCalculation =
  | { status: "incomplete" }
  | { status: "invalid"; error: string }
  | { status: "valid"; minutes: number; formattedHours: string };

export function applyPayrollTimeBasisChange(
  draft: PayrollCorrectionDraft,
  field: PayrollTimeBasisField,
  value: string,
): PayrollCorrectionDraft {
  const nextDraft = { ...draft, [field]: value };
  const calculation = calculatePayrollTime(nextDraft);
  if (calculation.status === "valid") {
    return { ...nextDraft, hours: calculation.formattedHours };
  }
  if (calculation.status === "invalid") {
    return { ...nextDraft, hours: "" };
  }
  return nextDraft;
}

export function calculatePayrollTime(
  draft: Pick<PayrollCorrectionDraft, "start_time" | "end_time" | "break_minutes">,
): PayrollTimeCalculation {
  const startValue = draft.start_time.trim();
  const endValue = draft.end_time.trim();
  const breakValue = draft.break_minutes.trim();
  if (!startValue || !endValue || !breakValue) {
    return { status: "incomplete" };
  }

  const startMinutes = parseClockMinutes(startValue);
  const endMinutes = parseClockMinutes(endValue);
  if (startMinutes === null || endMinutes === null) {
    return { status: "invalid", error: "Beginn und Ende müssen im Format HH:MM eingetragen werden." };
  }
  if (!/^\d+$/.test(breakValue)) {
    return { status: "invalid", error: "Pause muss als ganze, nicht negative Minutenzahl eingetragen werden." };
  }

  const pauseMinutes = Number(breakValue);
  if (!Number.isSafeInteger(pauseMinutes) || pauseMinutes < 0) {
    return { status: "invalid", error: "Pause muss als ganze, nicht negative Minutenzahl eingetragen werden." };
  }
  if (startMinutes === endMinutes) {
    return { status: "invalid", error: "Beginn und Ende dürfen nicht identisch sein." };
  }

  const grossMinutes = endMinutes > startMinutes
    ? endMinutes - startMinutes
    : endMinutes + 24 * 60 - startMinutes;
  const netMinutes = grossMinutes - pauseMinutes;
  if (netMinutes <= 0) {
    return { status: "invalid", error: "Pause muss kürzer als die Arbeitszeit sein." };
  }

  return {
    status: "valid",
    minutes: netMinutes,
    formattedHours: formatPayrollHours(netMinutes),
  };
}

export function parsePayrollBreakMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return null;
  }
  const minutes = Number(trimmed);
  return Number.isSafeInteger(minutes) && minutes >= 0 ? minutes : null;
}

export function resolvePayrollCorrectionWorkMinutes(
  draft: Pick<PayrollCorrectionDraft, "start_time" | "end_time" | "break_minutes">,
  manuallyEnteredMinutes: number | null,
): number | null {
  const calculation = calculatePayrollTime(draft);
  return calculation.status === "valid" ? calculation.minutes : manuallyEnteredMinutes;
}

export function formatPayrollHours(minutes: number): string {
  return (minutes / 60).toFixed(2).replace(".", ",");
}

function parseClockMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}
