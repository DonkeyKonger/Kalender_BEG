export type UserRole = "admin" | "project_manager" | "office" | "monteur";
export type OfficePagePermission =
  | "overview"
  | "calendar"
  | "absences"
  | "sites"
  | "map"
  | "payroll"
  | "customers"
  | "employees"
  | "export";

export type CurrentUser = {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  office_page_permissions: OfficePagePermission[];
  person_id: number | null;
};

export type LoginResponse = {
  access_token: string;
  token_type: "bearer";
  must_change_password: boolean;
};
