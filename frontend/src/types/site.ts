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
  project_folder_id: string | null;
  project_folder_web_url: string | null;
  project_folder_name: string | null;
  project_folder_status: string;
  project_folder_error: string | null;
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

export type SiteGeocodeSearchResult = {
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

export type SiteRemovePlan = {
  action: "delete";
};

export type SiteRemoveResponse = {
  action: "deleted";
  site: Site | null;
};

export type ProjectFolder = {
  id: number;
  site_id: number;
  sort_order: number;
  name: string;
  folder_key: string;
  is_active: boolean;
  external_provider: string | null;
  external_drive_id: string | null;
  external_item_id: string | null;
  external_web_url: string | null;
  created_at: string;
  updated_at: string;
};


export type ProjectFolderDocumentItem = {
  id: string;
  name: string;
  web_url: string | null;
  size: number | null;
  last_modified_date_time: string | null;
  mime_type: string | null;
  file_extension: string | null;
  is_folder: boolean;
};

export type ProjectFolderDocumentList = {
  folder_key: string;
  folder_name: string;
  items: ProjectFolderDocumentItem[];
};
