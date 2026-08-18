import type { AssignmentType, SiteStatus } from "./matrix";
import type { ToolMaterialCategory } from "./toolMaterial";

export type MobilePerson = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  phone: string | null;
  email: string | null;
  can_sign_measurements_immediately: boolean;
};

export type MobileSite = {
  id: number;
  site_number: string | null;
  name: string;
  location: string | null;
  address: string | null;
  customer: string | null;
  project_manager: MobilePerson | null;
  status: SiteStatus;
  info: string | null;
  requires_extra_work_approval: boolean;
};

export type MobileAssignment = {
  id: number;
  start_date: string;
  end_date: string;
  assignment_type: AssignmentType;
  note: string | null;
  person: MobilePerson;
  site: MobileSite;
};

export type MobileAssignmentsResponse = {
  start_date: string;
  end_date: string;
  assignments: MobileAssignment[];
};

export type MobileAssignmentSiteSummary = {
  site: MobileSite;
  last_assignment_date: string;
};

export type MobileAssignmentSitesResponse = {
  through_date: string;
  sites: MobileAssignmentSiteSummary[];
};

export type MobileAssignmentSiteHistoryResponse = {
  through_date: string;
  site: MobileSite;
  assignments: MobileAssignment[];
};

export type MobilePersonalFileVehicle = {
  id: number;
  license_plate: string;
  manufacturer: string;
};

export type MobilePersonalFileHoursAccount = {
  current_balance_minutes: number;
  last_entry_at: string | null;
};

export type MobilePersonalFileTool = {
  id: number;
  category: ToolMaterialCategory;
  beg_number: string | null;
  manufacturer: string | null;
  designation: string;
  device_number: string | null;
  item_date: string | null;
  open_issue_reports: MobileToolIssueSummary[];
};

export type MobileToolIssueReason = "DEFECTIVE" | "STOLEN";

export type MobileToolIssueSummary = {
  id: number;
  reason: MobileToolIssueReason;
  status: string;
  description: string;
  created_at: string;
};

export type MobileToolIssueReport = {
  id: number;
  status: string;
  created_at: string;
  message: string;
  already_reported: boolean;
};

export type MobilePersonalFile = {
  current_year: number;
  remaining_vacation_days: number;
  total_vacation_days: number;
  sick_days: number;
  hours_account: MobilePersonalFileHoursAccount;
  vehicle: MobilePersonalFileVehicle | null;
  tool_count: number;
  tool_preview: MobilePersonalFileTool[];
};

export type MobilePersonalFileAbsenceType = "vacation" | "sick";

export type MobilePersonalFileAbsenceEntry = {
  source_id: number;
  absence_type: MobilePersonalFileAbsenceType;
  start_date: string;
  end_date: string;
  day_count: number;
};

export type MobilePersonalFileAbsenceWeek = {
  iso_year: number;
  iso_week: number;
  week_start: string;
  week_end: string;
  entries: MobilePersonalFileAbsenceEntry[];
};

export type MobilePersonalFileAbsenceResponse = {
  year: number;
  absence_type: MobilePersonalFileAbsenceType;
  remaining_vacation_days: number;
  total_vacation_days: number;
  taken_vacation_days: number;
  vacation_carryover_days: number;
  sick_days: number;
  weeks: MobilePersonalFileAbsenceWeek[];
};
