import type { SiteStatus } from "./matrix";

export type SiteLocationStatus = "unchecked" | "geocoded" | "ambiguous" | "failed";

export type SitePerson = {
  id: number;
  display_name: string;
  short_code: string;
  email: string | null;
  phone: string | null;
};


export type SiteSummaryPerson = {
  id: number;
  display_name: string;
  short_code: string;
};

export type SiteSummary = {
  id: number;
  site_number: string | null;
  name: string;
  location: string | null;
  city: string | null;
  customer: string | null;
  customer_id: number | null;
  project_manager_person_id: number | null;
  project_manager: SiteSummaryPerson | null;
  status: SiteStatus;
  color: string | null;
  requires_extra_work_approval: boolean;
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
  customer_id: number | null;
  project_manager_person_id: number | null;
  project_manager: SitePerson | null;
  status: SiteStatus;
  info: string | null;
  color: string | null;
  planned_work_minutes: number | null;
  requires_extra_work_approval: boolean;
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
  customer_id: number | null;
  project_manager_person_id: number | null;
  status: SiteStatus;
  info: string | null;
  color: string | null;
  planned_work_minutes?: number | null;
  requires_extra_work_approval?: boolean;
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



export type MeasurementBase = {
  id: number;
  site_id: number;
  name: string;
  base_type: string | null;
  status: "draft" | "active" | "closed" | "archived" | string;
  released_to_mobile: boolean;
  source_note: string | null;
  import_label: string | null;
  closed_at: string | null;
  item_count: number;
  batch_count: number;
  created_at: string;
  updated_at: string;
};

export type MeasurementBaseUpdate = {
  name?: string;
  status?: "draft" | "active" | "closed" | "archived";
  released_to_mobile?: boolean;
  source_note?: string | null;
  import_label?: string | null;
};

export type MeasurementImportOptions = {
  importMode: "append_existing" | "create_new";
  measurementBaseId?: number | null;
  measurementBaseName?: string | null;
};

export type MeasurementNumericValue = string | number | null;

export type MeasurementItem = {
  id: number;
  site_id: number;
  measurement_base_id: number;
  source_file_name: string | null;
  source_project_number: string | null;
  source_invoice_number: string | null;
  source_customer_name: string | null;
  source_section_key: string | null;
  source_section_title: string | null;
  position: string;
  description: string;
  list_quantity: MeasurementNumericValue;
  unit: string | null;
  minutes_per_unit: MeasurementNumericValue;
  list_minutes_total: MeasurementNumericValue;
  is_nep: boolean;
  is_free_position: boolean;
  is_hidden: boolean;
  sort_order: number;
  measurement_base: MeasurementBase | null;
  created_at: string;
  updated_at: string;
};

export type MeasurementItemUpdatePayload = {
  position?: string | null;
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

export type MeasurementAreaRow = {
  id: number;
  measurement_batch_id: number;
  site_id: number;
  area_or_comment: string;
  sort_order: number;
  created_by_user_id: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

export type MeasurementAreaRowPayload = {
  area_or_comment: string;
};

export type MobileMeasurementFreeItemPayload = {
  position?: string | null;
  description: string;
  unit: string;
  quantity?: number;
  area_or_comment?: string | null;
};

export type MobileMeasurementBatch = {
  id: number;
  site_id: number;
  measurement_base_id: number;
  measurement_base_name: string | null;
  offer_id: number;
  offer_name: string | null;
  is_current_offer: boolean;
  number: number;
  title: string;
  status: "draft" | "submitted" | "reviewed" | "customer_signed" | "billed" | "in_review" | "approved" | "rejected" | "closed" | string;
  created_by_user_id: number | null;
  created_by_name: string | null;
  submitted_by_user_id: number | null;
  submitted_by_name: string | null;
  submitted_at: string | null;
  customer_signed_at: string | null;
  customer_signature_name: string | null;
  customer_signature_place: string | null;
  customer_email_sent_at: string | null;
  customer_email_signature_present: boolean | null;
  worker_signed_at: string | null;
  worker_signature_name: string | null;
  is_locked_for_worker: boolean;
  created_at: string;
  updated_at: string;
  position_count: number;
  entry_count: number;
  reported_minutes: MeasurementNumericValue;
  reported_hours: MeasurementNumericValue;
  photo_count: number;
  available_actions?: {
    can_customer_sign: boolean;
  };
  block_reasons?: {
    customer_sign?: string | null;
  };
  area_rows?: MeasurementAreaRow[];
};

export type MobileMeasurementBatchPhoto = {
  id: number;
  site_id: number;
  measurement_batch_id: number;
  filename: string;
  content_type: string;
  file_size_bytes: number | null;
  external_web_url: string | null;
  uploaded_by_name: string | null;
  taken_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MobileExtraWorkTicket = {
  id: number;
  site_id: number;
  sequence_number: number;
  display_number: string;
  title: string | null;
  kind: "billing" | "approval" | string;
  approval_ticket_id: number | null;
  status: "draft" | "submitted" | "reviewed" | "signed" | string;
  created_by_user_id: number | null;
  created_by_name: string | null;
  submitted_by_user_id: number | null;
  submitted_at: string | null;
  notes: string | null;
  customer_signature_type: "billing_customer" | "approval_customer" | string | null;
  customer_signature_name: string | null;
  customer_signature_place: string | null;
  customer_signed_at: string | null;
  customer_email_sent_at: string | null;
  customer_email_signature_present: boolean | null;
  worker_signature_name: string | null;
  worker_signed_at: string | null;
  entry_count: number;
  photo_count: number;
  total_hours: MeasurementNumericValue;
  estimated_hours: MeasurementNumericValue | null;
  created_at: string;
  updated_at: string;
};

export type SiteEmailRecipient = {
  id: number | null;
  email: string;
  label: string | null;
  source: string | null;
  is_selected: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export type SiteEmailRecipientsResponse = {
  site_id: number;
  recipients: SiteEmailRecipient[];
  suggestions: SiteEmailRecipient[];
};

export type SiteEmailRecipientsUpdate = {
  recipients: Array<{
    email: string;
    label?: string | null;
  }>;
};

export type ExtraWorkTicketEmailSendResponse = {
  sent_at: string;
  recipients: string[];
  filename: string;
};

export type MobileExtraWorkTicketPhoto = {
  id: number;
  site_id: number;
  extra_work_ticket_id: number;
  filename: string;
  content_type: string;
  file_size_bytes: number | null;
  external_web_url: string | null;
  uploaded_by_name: string | null;
  taken_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MobileExtraWorkWorkerHours = {
  worker_name: string;
  monday_hours: MeasurementNumericValue;
  tuesday_hours: MeasurementNumericValue;
  wednesday_hours: MeasurementNumericValue;
  thursday_hours: MeasurementNumericValue;
  friday_hours: MeasurementNumericValue;
  saturday_hours: MeasurementNumericValue;
  sunday_hours: MeasurementNumericValue;
};

export type MobileExtraWorkTicketEntryPayload = {
  component: string;
  floor: string;
  room_number?: string | null;
  axis?: string | null;
  remarks?: string | null;
  material_text?: string | null;
  estimated_hours?: number | null;
  worker_rows: MobileExtraWorkWorkerHours[];
};

export type MobileExtraWorkTicketEntry = MobileExtraWorkTicketEntryPayload & {
  id: number;
  ticket_id: number;
  site_id: number;
  total_hours: MeasurementNumericValue;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

export type CustomerSignaturePoint = {
  x: number;
  y: number;
};

export type CustomerSignatureStroke = CustomerSignaturePoint[];

export type CustomerSignaturePayload = {
  customer_name: string;
  signature_strokes: CustomerSignatureStroke[];
};

export type ExtraWorkCustomerSignaturePayload = CustomerSignaturePayload & {
  customer_place?: string | null;
};

export type WorkerSignaturePayload = {
  worker_name: string;
  signature_strokes: CustomerSignatureStroke[];
};

export type MobileMeasurementItem = MeasurementItem & {
  entries: MeasurementEntry[];
  reported_quantity: MeasurementNumericValue;
  reported_minutes: MeasurementNumericValue;
  reported_hours: MeasurementNumericValue;
  mobile_status: "open" | "edited" | "billed" | string;
};

export type MeasurementTimesheetKpi = {
  position_count: number;
  planned_minutes: MeasurementNumericValue;
  measured_minutes: MeasurementNumericValue;
  open_minutes: MeasurementNumericValue;
  progress_percent: number | null;
  captured_count: number;
  not_captured_count: number;
  has_planned_basis: boolean;
};

export type MeasurementTimesheetRow = {
  position_id: number;
  position_number: string;
  description: string;
  unit: string | null;
  target_quantity: MeasurementNumericValue;
  measured_quantity: MeasurementNumericValue;
  remaining_quantity: MeasurementNumericValue;
  minutes_per_unit: MeasurementNumericValue;
  planned_minutes: MeasurementNumericValue;
  measured_minutes: MeasurementNumericValue;
  progress_percent: number | null;
  is_captured: boolean;
  search_text: string;
};

export type MeasurementTimesheet = {
  site_id: number;
  measurement_base_id: number | null;
  active_batch_ids: number[];
  active_measurement_label: string | null;
  last_import_label: string | null;
  last_import_at: string | null;
  kpi: MeasurementTimesheetKpi;
  rows: MeasurementTimesheetRow[];
};

export type MeasurementTimeAnalysisExtraWorkTicket = {
  id: number;
  display_number: string;
  title: string | null;
  status: string;
  relevant_at: string | null;
  planned_minutes: MeasurementNumericValue;
};

export type MeasurementTimeAnalysisRow = {
  measurement_batch_id: number;
  measurement_number: number;
  measurement_title: string;
  measurement_status: string;
  analysis_at: string | null;
  period_start: string | null;
  period_end: string | null;
  measurement_minutes: MeasurementNumericValue;
  extra_work_minutes: MeasurementNumericValue;
  planned_minutes: MeasurementNumericValue;
  actual_minutes: MeasurementNumericValue;
  deviation_minutes: MeasurementNumericValue;
  consumption_percent: number | null;
  extra_work_tickets: MeasurementTimeAnalysisExtraWorkTicket[];
};

export type MeasurementTimeAnalysisTotals = {
  planned_minutes: MeasurementNumericValue;
  actual_minutes: MeasurementNumericValue;
  deviation_minutes: MeasurementNumericValue;
  consumption_percent: number | null;
};

export type MeasurementTimeAnalysis = {
  site_id: number;
  totals: MeasurementTimeAnalysisTotals;
  rows: MeasurementTimeAnalysisRow[];
};

export type MeasurementImportResponse = {
  imported_count: number;
  measurement_base: MeasurementBase;
  source_project_number: string | null;
  source_invoice_number: string | null;
  source_customer_name: string | null;
  timesheet_document_saved: boolean;
  timesheet_document_name: string | null;
  timesheet_document_error: string | null;
  items: MeasurementItem[];
};

export type MeasurementDashboardSubmission = {
  message_key: string;
  batch_id: number | null;
  extra_work_ticket_id: number | null;
  site_id: number;
  site_name: string;
  site_number: string | null;
  title: string;
  status: string;
  message_type: "measurement_submitted" | "measurement_customer_signed" | "extra_work_submitted" | string;
  event_at: string | null;
  submitted_by_name: string | null;
  submitted_at: string | null;
  customer_signature_name: string | null;
  customer_signed_at: string | null;
  entry_count: number;
  position_count: number;
};
