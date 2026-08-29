import type { TimeEntryCreate } from "../types/timeEntry";

export const OFFICE_ONLY_TIME_ENTRY_NOTE = "Büroprüfung ohne Monteur-Zeitmeldung.";

type PayrollEntryClassificationInput = {
  end_time: string | null;
  has_manual_entry: boolean;
  id: number;
  is_gps_suggestion: boolean;
  note: string | null;
  start_time: string | null;
  travel_minutes: number | null;
  work_minutes: number;
};

export function isOfficeOnlyPayrollEntry(entry: PayrollEntryClassificationInput): boolean {
  return (
    entry.note === OFFICE_ONLY_TIME_ENTRY_NOTE
    || (
      entry.id < 0
      && !entry.is_gps_suggestion
      && !entry.has_manual_entry
      && entry.work_minutes === 0
      && !entry.start_time
      && !entry.end_time
    )
  );
}

export function isTravelOnlyPayrollEntry(entry: PayrollEntryClassificationInput): boolean {
  return !isOfficeOnlyPayrollEntry(entry) && entry.work_minutes === 0 && (entry.travel_minutes || 0) > 0;
}

export type PayrollCorrectionDraft = {
  start_time: string;
  end_time: string;
  break_minutes: string;
  hours: string;
};

export type PayrollTimeBasisField = "start_time" | "end_time" | "break_minutes";

export type PayrollManualEntryDraft = Omit<PayrollCorrectionDraft, "hours"> & {
  site_id: string;
  travel_minutes: string;
  work_date: string;
};

export type PayrollManualEntryValidationError = {
  ok: false;
  field: "date" | "person" | "site" | "time" | "travel";
  error: string;
};

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

  const roundedMinutes = roundMinutesToQuarterHour(netMinutes);
  return {
    status: "valid",
    minutes: roundedMinutes,
    formattedHours: formatPayrollHours(roundedMinutes),
  };
}

export function roundMinutesToQuarterHour(minutes: number): number {
  return Math.round(minutes / 15) * 15;
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

export function buildPayrollManualEntryPayload({
  personId,
  draft,
  allowedWorkDates,
  allowedSiteIds,
}: {
  personId: number;
  draft: PayrollManualEntryDraft;
  allowedWorkDates: readonly string[];
  allowedSiteIds: readonly number[];
}): { ok: true; payload: TimeEntryCreate } | PayrollManualEntryValidationError {
  if (!Number.isInteger(personId) || personId <= 0) {
    return { ok: false, field: "person", error: "Monteur fehlt für den manuellen Zeiteintrag." };
  }
  if (!allowedWorkDates.includes(draft.work_date)) {
    return { ok: false, field: "date", error: "Bitte einen Tag aus der geöffneten Kalenderwoche auswählen." };
  }

  const siteId = Number(draft.site_id);
  if (!Number.isInteger(siteId) || siteId <= 0 || !allowedSiteIds.includes(siteId)) {
    return { ok: false, field: "site", error: "Bitte eine gültige Baustelle auswählen." };
  }

  const calculation = calculatePayrollTime(draft);
  if (calculation.status === "incomplete") {
    return { ok: false, field: "time", error: "Bitte Beginn, Ende und Pause vollständig eintragen." };
  }
  if (calculation.status === "invalid") {
    return { ok: false, field: "time", error: calculation.error };
  }

  const breakMinutes = parsePayrollBreakMinutes(draft.break_minutes);
  if (breakMinutes === null) {
    return {
      ok: false,
      field: "time",
      error: "Pause muss als ganze, nicht negative Minutenzahl eingetragen werden.",
    };
  }
  const travelMinutes = parseOptionalNonNegativeMinutes(draft.travel_minutes);
  if (!travelMinutes.ok) {
    return travelMinutes;
  }

  return {
    ok: true,
    payload: {
      person_id: personId,
      site_id: siteId,
      assignment_id: null,
      work_date: draft.work_date,
      start_time: draft.start_time,
      end_time: draft.end_time,
      break_minutes: breakMinutes,
      travel_minutes: travelMinutes.value,
      work_minutes: calculation.minutes,
      note: OFFICE_ONLY_TIME_ENTRY_NOTE,
      source: "manual",
      status: "draft",
    },
  };
}

function parseClockMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseOptionalNonNegativeMinutes(
  value: string,
): { ok: true; value: number } | PayrollManualEntryValidationError {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: 0 };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, field: "travel", error: "Fahrtzeit muss als ganze, nicht negative Minutenzahl eingetragen werden." };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false, field: "travel", error: "Fahrtzeit muss als ganze, nicht negative Minutenzahl eingetragen werden." };
  }
  return { ok: true, value: parsed };
}
