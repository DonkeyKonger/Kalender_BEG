import type { UserRole } from "./auth";

export type PersonType = "internal" | "external" | "external_temp";
export type PersonLocationStatus = "unchecked" | "geocoded" | "ambiguous" | "failed";

export type Person = {
  id: number;
  user_roles?: UserRole[];
  first_name: string;
  last_name: string;
  display_name: string;
  short_code: string;
  person_type: PersonType;
  is_active: boolean;
  can_sign_measurements_immediately: boolean;
  email: string | null;
  phone: string | null;
  address_postal_code: string | null;
  address_city: string | null;
  address_street: string | null;
  address_house_number: string | null;
  address_extra: string | null;
  address_formatted: string | null;
  address_latitude: number | null;
  address_longitude: number | null;
  address_location_status: PersonLocationStatus;
  notes: string | null;
  deleted_at: string | null;
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
  can_sign_measurements_immediately: boolean;
  email: string | null;
  phone: string | null;
  address_postal_code: string | null;
  address_city: string | null;
  address_street: string | null;
  address_house_number: string | null;
  address_extra: string | null;
  address_formatted: string | null;
  address_latitude: number | null;
  address_longitude: number | null;
  address_location_status: PersonLocationStatus;
  notes: string | null;
};

export type PersonUpdate = Partial<PersonCreate>;

export function calendarPersonCode(
  person: Pick<Person, "first_name" | "last_name" | "display_name" | "short_code"> & {
    person_type?: PersonType;
  },
): string {
  if (person.person_type === "external" || person.person_type === "external_temp") {
    return person.display_name.trim() || person.short_code;
  }
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


export type PersonMapProjectManager = {
  id: number;
  display_name: string;
  short_code: string;
};

export type PersonMapItem = {
  id: number;
  display_name: string;
  short_name: string;
  role: PersonType;
  project_manager_assignment: PersonMapProjectManager | null;
  address_city: string | null;
  address_postal_code: string | null;
  address_formatted: string | null;
  address_latitude: number;
  address_longitude: number;
  address_location_status: PersonLocationStatus;
  active: boolean;
};

export type PersonMapResponse = {
  people: PersonMapItem[];
  missing_location: number;
};

export type PersonGeocodeSearchResult = {
  label: string;
  postal_code: string | null;
  city: string | null;
  street: string | null;
  house_number: string | null;
  latitude: number;
  longitude: number;
  confidence: number | null;
  source: string | null;
};

export type PersonRemovePlan = {
  action: "delete" | "deactivate";
};

export type PersonRemoveResponse = {
  action: "deleted" | "deactivated";
  person: Person | null;
};
