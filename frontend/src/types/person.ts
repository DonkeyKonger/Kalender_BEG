import type { UserRole } from "./auth";

export type PersonType = "internal" | "external" | "external_temp";

export type Person = {
  id: number;
  first_name: string;
  last_name: string;
  display_name: string;
  short_code: string;
  person_type: PersonType;
  is_active: boolean;
  email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export function canEditMatrix(role: UserRole): boolean {
  return role === "admin" || role === "project_manager";
}
