export type TimeEntryStatus = "draft" | "submitted" | "reviewed";
export type TimeEntrySource = "manual" | "gps_suggestion";
export type TimeEntryGpsStatus = "not_checkable" | "missing" | "partial" | "matched" | "mismatch";
export type TimeReviewStatus = "open" | "manually_approved" | "corrected" | "not_verifiable" | "clarification" | "auto_closed_by_deadline";
export type TimeReviewMethod = "accept_manual" | "accept_gps" | "manual_confirmed" | "manual_correction" | "assign_site" | "mark_not_verifiable" | "clarification" | "deadline";
export type TimeReviewDecision = "accept_manual" | "accept_gps" | "corrected" | "assign_site" | "mark_not_verifiable" | "mark_clarification";
export type OvernightStatus = "none" | "self_paid" | "beg_paid";

export type TimeEntry = {
  id: number;
  person_id: number;
  person_name: string;
  person_type: "internal" | "external" | "external_temp" | string | null;
  site_id: number | null;
  site_name: string | null;
  site_number: string | null;
  original_site_id: number | null;
  original_site_name: string | null;
  original_site_number: string | null;
  assignment_id: number | null;
  work_date: string;
  overnight_status: OvernightStatus | null;
  original_work_date: string | null;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  travel_minutes: number;
  work_minutes: number;
  original_work_minutes: number | null;
  corrected_work_minutes: number | null;
  payroll_corrected_start_time: string | null;
  payroll_corrected_end_time: string | null;
  payroll_corrected_break_minutes: number | null;
  payroll_corrected_work_minutes: number | null;
  project_mounting_multiplier: number;
  project_mounting_external_person_count: number;
  project_mounting_participant_ids: number[];
  project_mounting_participant_names: string[];
  project_mounting_base_work_minutes: number | null;
  project_mounting_work_minutes: number | null;
  project_mounting_break_minutes: number | null;
  project_mounting_travel_minutes: number | null;
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
  payroll_reviewed_by_user_id: number | null;
  payroll_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  review_source: "manual" | "gps_suggestion";
  is_gps_suggestion: boolean;
  has_manual_entry: boolean;
  gps_suggestion_key: string | null;
  planned_site_labels: string[];
  gps_detected_site_id: number | null;
  gps_detected_site_name: string | null;
  gps_detected_site_number: string | null;
  gps_detected_location_type: "site" | "company" | "unknown" | null;
  planned_vs_gps_mismatch: boolean;
  manual_vs_planned_mismatch: boolean;
  manual_vs_gps_mismatch: boolean;
  gps_not_checkable: boolean;
  mismatch_notice: string | null;
  review_notices: string[];
  payroll_review_state?: {
    state: "open" | "auto_plausible" | "checked" | string;
    is_auto_plausible: boolean;
  };
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
  source?: "manual";
  status?: TimeEntryStatus;
  overnight_status?: OvernightStatus;
};

export type PersonWorkDay = {
  person_id: number;
  work_date: string;
  overnight_status: OvernightStatus | null;
};

export type TimeEntryUpdate = Partial<TimeEntryCreate>;

export type TimeEntryCorrection = {
  corrected_work_minutes: number;
};

export type TimeEntryPayrollCorrection = {
  payroll_corrected_start_time?: string | null;
  payroll_corrected_end_time?: string | null;
  payroll_corrected_break_minutes?: number | null;
  payroll_corrected_work_minutes?: number | null;
};

export type TimeEntryPayrollDateCorrection = {
  work_date: string;
};

export type TimeEntryPayrollDeleteResult = {
  entry_id: number;
  person_id: number;
  iso_year: number;
  iso_week: number;
  weekly_review_reset: boolean;
};

export type TimeEntryReviewDecisionPayload = {
  decision: TimeReviewDecision;
  final_work_minutes?: number | null;
  reviewed_site_id?: number | null;
};

export type TimeEntryWeeklyReview = {
  id: number;
  person_id: number;
  iso_year: number;
  iso_week: number;
  status: "reviewed" | "reset" | string;
  reviewed_by_user_id: number | null;
  reviewed_at: string;
  created_at: string;
  updated_at: string;
};

export type TimeEntryPayrollWeekDay = {
  work_date: string;
  vacation_credit_minutes: number;
};

export type TimeEntryPayrollWeekPerson = {
  person_id: number;
  work_minutes: number;
  vacation_credit_minutes: number;
  total_minutes: number;
  vacation_days: TimeEntryPayrollWeekDay[];
};

export type TimeEntryPayrollWeek = {
  iso_year: number;
  iso_week: number;
  start_date: string;
  end_date: string;
  persons: TimeEntryPayrollWeekPerson[];
};
