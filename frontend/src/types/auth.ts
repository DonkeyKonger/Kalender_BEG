export type UserRole = "admin" | "project_manager" | "office" | "monteur";

export type CurrentUser = {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  person_id: number | null;
};

export type LoginResponse = {
  access_token: string;
  token_type: "bearer";
};
