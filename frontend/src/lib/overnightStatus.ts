import type { OvernightStatus, TimeEntry } from "../types/timeEntry";


export type OvernightStatusPresentation = {
  badge: "MA" | "BEG" | null;
  label: string;
  marker: "–" | null;
  tone: "none" | "self-paid" | "beg-paid";
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
      marker: "–",
      tone: "none",
    };
  }
  if (status === "self_paid") {
    return {
      badge: "MA",
      label: "Übernachtung – Hotel vom Monteur bezahlt",
      marker: null,
      tone: "self-paid",
    };
  }
  if (status === "beg_paid") {
    return {
      badge: "BEG",
      label: "Übernachtung – Hotel durch BEG bezahlt",
      marker: null,
      tone: "beg-paid",
    };
  }
  return {
    badge: null,
    label: "Übernachtungsstatus nicht erfasst",
    marker: "–",
    tone: "none",
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
  savedEntry: TimeEntry,
): TimeEntry[] {
  return entries.map((entry) => (
    entry.person_id === savedEntry.person_id && entry.work_date === savedEntry.work_date
      ? { ...entry, overnight_status: savedEntry.overnight_status }
      : entry
  ));
}
