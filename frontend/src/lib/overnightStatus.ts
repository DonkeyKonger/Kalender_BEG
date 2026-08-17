import type { OvernightStatus, TimeEntry } from "../types/timeEntry";


export const DEFAULT_OVERNIGHT_STATUS: OvernightStatus = "none";


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
