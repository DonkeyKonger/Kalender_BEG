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


export type MeasurementNumericValue = string | number | null;

export type MeasurementItem = {
  id: number;
  site_id: number;
  source_file_name: string | null;
  source_project_number: string | null;
  source_invoice_number: string | null;
  source_customer_name: string | null;
  position: string;
  description: string;
  list_quantity: MeasurementNumericValue;
  unit: string | null;
  minutes_per_unit: MeasurementNumericValue;
  list_minutes_total: MeasurementNumericValue;
  is_nep: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};



export type MeasurementEntry = {
  id: number;
  measurement_batch_id: number;
  measurement_item_id: number;
  site_id: number;
  quantity: MeasurementNumericValue;
  area_or_comment: string;
  status: string;
  created_by_user_id: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

export type MeasurementEntryPayload = {
  area_or_comment: string;
  quantity: number;
};

export type MobileMeasurementBatch = {
  id: number;
  site_id: number;
  number: number;
  title: string;
  status: "draft" | "submitted" | "billed" | "in_review" | "approved" | "rejected" | "closed" | string;
  created_by_user_id: number | null;
  submitted_by_user_id: number | null;
  submitted_by_name: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  position_count: number;
  entry_count: number;
  reported_minutes: MeasurementNumericValue;
  reported_hours: MeasurementNumericValue;
};

export type MobileMeasurementItem = MeasurementItem & {
  entries: MeasurementEntry[];
  reported_quantity: MeasurementNumericValue;
  reported_minutes: MeasurementNumericValue;
  reported_hours: MeasurementNumericValue;
  mobile_status: "open" | "edited" | "billed" | string;
};

export type MeasurementImportResponse = {
  imported_count: number;
  source_project_number: string | null;
  source_invoice_number: string | null;
  source_customer_name: string | null;
  items: MeasurementItem[];
};

export type MeasurementDashboardSubmission = {
  batch_id: number;
  site_id: number;
  site_name: string;
  site_number: string | null;
  title: string;
  status: string;
  submitted_by_name: string | null;
  submitted_at: string | null;
  entry_count: number;
  position_count: number;
};
