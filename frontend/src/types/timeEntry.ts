export type TimeEntryStatus = "draft" | "submitted" | "reviewed";
export type TimeEntrySource = "manual";

export type TimeEntry = {
  id: number;
  person_id: number;
  person_name: string;
  site_id: number | null;
  site_name: string | null;
  site_number: string | null;
  assignment_id: number | null;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  travel_minutes: number;
  work_minutes: number;
  note: string | null;
  source: TimeEntrySource;
  status: TimeEntryStatus;
  created_by_user_id: number | null;
  reviewed_by_user_id: number | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TimeEntryCreate = {
  person_id: number;
  site_id?: number | null;
  assignment_id?: number | null;
  work_date: string;
  start_time?: string | null;
  end_time?: string | null;
  break_minutes?: number | null;
  travel_minutes?: number | null;
  work_minutes?: number | null;
  note?: string | null;
  source?: TimeEntrySource;
  status?: TimeEntryStatus;
};

export type TimeEntryUpdate = Partial<TimeEntryCreate>;
