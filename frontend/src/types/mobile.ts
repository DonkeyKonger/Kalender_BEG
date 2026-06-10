import type { AssignmentType, SiteStatus } from "./matrix";

export type MobilePerson = {
  id: number;
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
