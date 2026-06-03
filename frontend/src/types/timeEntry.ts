export type TimeEntryStatus = "draft" | "submitted" | "reviewed";
export type TimeEntrySource = "manual" | "gps_suggestion";
export type TimeEntryGpsStatus = "not_checkable" | "missing" | "partial" | "matched" | "mismatch";
export type TimeReviewStatus = "open" | "manually_approved" | "corrected" | "not_verifiable" | "clarification" | "auto_closed_by_deadline";
export type TimeReviewMethod = "accept_manual" | "accept_gps" | "manual_confirmed" | "manual_correction" | "assign_site" | "mark_not_verifiable" | "clarification" | "deadline";
export type TimeReviewDecision = "accept_manual" | "accept_gps" | "corrected" | "assign_site" | "mark_not_verifiable" | "mark_clarification";

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
  original_work_minutes: number | null;
  corrected_work_minutes: number | null;
  note: string | null;
  source: TimeEntrySource;
  status: TimeEntryStatus;
  time_review_status: TimeReviewStatus;
  time_review_method: TimeReviewMethod | null;
  gps_status: TimeEntryGpsStatus | null;
  gps_matched_points: number | null;
  gps_total_points: number | null;
  gps_first_seen_at: string | null;
  gps_last_seen_at: string | null;
  gps_work_minutes: number | null;
  created_by_user_id: number | null;
  reviewed_by_user_id: number | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  review_source: "manual" | "gps_suggestion";
  is_gps_suggestion: boolean;
  has_manual_entry: boolean;
  gps_suggestion_key: string | null;
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

export type TimeEntryCorrection = {
  corrected_work_minutes: number;
};

export type TimeEntryReviewDecisionPayload = {
  decision: TimeReviewDecision;
  final_work_minutes?: number | null;
  reviewed_site_id?: number | null;
};
