import type { OvernightStatus, TimeEntry } from "../types/timeEntry";


export type OvernightStatusPresentation = {
  badge: "MA" | "BEG" | null;
  label: string;
  tone: "none" | "self-paid" | "beg-paid";
};

export type OvernightStatusDaySummary = {
  status: OvernightStatus | null;
  hasConflict: boolean;
};


export const DEFAULT_OVERNIGHT_STATUS: OvernightStatus = "none";


export function buildOvernightStatusPayload(
  isTravelTimeEntry: boolean,
  overnightStatus: OvernightStatus,
): { overnight_status?: OvernightStatus } {
  return isTravelTimeEntry ? {} : { overnight_status: overnightStatus };
}


export function getOvernightStatusPresentation(
  status: OvernightStatus | null | undefined,
): OvernightStatusPresentation {
  if (status === "none") {
    return {
      badge: null,
      label: "Keine Übernachtung",
      tone: "none",
    };
  }
  if (status === "self_paid") {
    return {
      badge: "MA",
      label: "Übernachtung – Hotel vom Monteur bezahlt",
      tone: "self-paid",
    };
  }
  if (status === "beg_paid") {
    return {
      badge: "BEG",
      label: "Übernachtung – Hotel durch BEG bezahlt",
      tone: "beg-paid",
    };
  }
  return {
    badge: null,
    label: "Übernachtungsstatus nicht erfasst",
    tone: "none",
  };
}


export function summarizeOvernightStatuses(
  statuses: Array<OvernightStatus | null | undefined>,
): OvernightStatusDaySummary {
  const recordedStatuses = statuses.filter((status): status is OvernightStatus => status !== null && status !== undefined);
  const distinctStatuses = new Set(recordedStatuses);

  return {
    // An inconsistent historical day must not be rendered as an arbitrary payer.
    // Selecting a value in the payroll editor resolves it for all entries of the day.
    status: distinctStatuses.size === 1 ? recordedStatuses[0] : null,
    hasConflict: distinctStatuses.size > 1,
  };
}


export function resolveOvernightStatusForWorkDate(params: {
  entries: TimeEntry[];
  workDate: string;
  preferredStatus?: OvernightStatus | null;
}): OvernightStatus {
  return params.preferredStatus
    ?? params.entries.find((entry) => (
      entry.work_date === params.workDate && entry.overnight_status !== null
    ))?.overnight_status
    ?? DEFAULT_OVERNIGHT_STATUS;
}


export function applyOvernightStatusToWorkDate(
  entries: TimeEntry[],
  savedEntry: Pick<TimeEntry, "person_id" | "work_date" | "overnight_status">,
): TimeEntry[] {
  return entries.map((entry) => (
    entry.person_id === savedEntry.person_id && entry.work_date === savedEntry.work_date
      ? { ...entry, overnight_status: savedEntry.overnight_status }
      : entry
  ));
}
