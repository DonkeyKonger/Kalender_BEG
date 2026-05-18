export type AssignmentType = "regular" | "support" | "emergency";
export type AbsenceType = "vacation" | "sick" | "school" | "free" | "other";
export type SiteStatus = "active" | "paused" | "closed" | "archived";

export type MatrixDay = {
  date: string;
  weekday: number;
  is_weekend: boolean;
};

export type MatrixPerson = {
  id: number;
  display_name: string;
  short_code: string;
};

export type MatrixAssignment = {
  id: number;
  person: MatrixPerson;
  start_date: string;
  end_date: string;
  assignment_type: AssignmentType;
  note: string | null;
};

export type MatrixAbsence = {
  person: MatrixPerson;
  absence_type: AbsenceType;
  start_date: string;
  end_date: string;
  note: string | null;
};

export type MatrixCell = {
  date: string;
  assignments: MatrixAssignment[];
  absences: MatrixAbsence[];
};

export type MatrixSite = {
  id: number;
  site_number: string | null;
  name: string;
  location: string | null;
  customer: string | null;
  project_manager_person_id: number | null;
  project_manager: MatrixPerson | null;
  status: SiteStatus;
  info: string | null;
  color: string | null;
};

export type MatrixRow = {
  site: MatrixSite;
  cells: MatrixCell[];
};

export type MatrixResponse = {
  start_date: string;
  end_date: string;
  days: MatrixDay[];
  rows: MatrixRow[];
};

export type MatrixEntryInput = {
  person_id?: number;
  external_name?: string;
};

export type MatrixConflictMessage = {
  severity: string;
  code: string;
  message: string;
  date: string | null;
};

export type MatrixMutationResponse = {
  warnings: MatrixConflictMessage[];
  infos: MatrixConflictMessage[];
};
