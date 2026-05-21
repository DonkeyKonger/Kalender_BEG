import type { SiteStatus } from "./matrix";

export type SiteLocationStatus = "unchecked" | "geocoded" | "ambiguous" | "failed";

export type SitePerson = {
  id: number;
  display_name: string;
  short_code: string;
  email: string | null;
  phone: string | null;
};

export type Site = {
  id: number;
  site_number: string | null;
  name: string;
  location: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  street: string | null;
  house_number: string | null;
  address_extra: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number;
  location_status: SiteLocationStatus;
  customer: string | null;
  project_manager_person_id: number | null;
  project_manager: SitePerson | null;
  status: SiteStatus;
  info: string | null;
  color: string | null;
  closed_at: string | null;
  closed_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

export type SiteCreate = {
  site_number: string | null;
  name: string;
  location: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  street: string | null;
  house_number: string | null;
  address_extra: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number;
  location_status: SiteLocationStatus;
  customer: string | null;
  project_manager_person_id: number | null;
  status: SiteStatus;
  info: string | null;
  color: string | null;
};

export type SiteUpdate = Partial<SiteCreate>;


export type SiteMapProjectManager = SitePerson;

export type SiteMapItem = {
  id: number;
  name: string;
  number: string | null;
  city: string | null;
  postal_code: string | null;
  street: string | null;
  house_number: string | null;
  project_manager: SiteMapProjectManager | null;
  status: SiteStatus;
  color: string | null;
  latitude: number;
  longitude: number;
  geofence_radius_m: number;
  location_status: SiteLocationStatus;
};

export type SiteMapResponse = {
  sites: SiteMapItem[];
  missing_location: number;
};
