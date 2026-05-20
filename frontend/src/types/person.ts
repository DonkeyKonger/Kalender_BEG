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

export type PersonCreate = {
  first_name: string;
  last_name: string;
  display_name: string;
  short_code: string;
  person_type: PersonType;
  is_active: boolean;
  email: string | null;
  phone: string | null;
  notes: string | null;
};

export type PersonUpdate = Partial<PersonCreate>;

export function calendarPersonCode(
  person: Pick<Person, "first_name" | "last_name" | "display_name" | "short_code">,
): string {
  const first = person.first_name.trim() || person.display_name.trim();
  const last = person.last_name.trim() || fallbackLastName(person.display_name);
  if (!first && !last) {
    return person.short_code;
  }
  if (!last) {
    return `${first.slice(0, 1)}.`;
  }
  return `${first.slice(0, 1)}.${last}`;
}

function fallbackLastName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : displayName.trim();
}
