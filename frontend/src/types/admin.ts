export type MicrosoftGraphResource = {
  id: string | null;
  name: string | null;
  web_url: string | null;
};

export type MicrosoftGraphConnectionTestResponse = {
  connected: boolean;
  graph_enabled: boolean;
  reason: string | null;
  status_code: number | null;
  safe_error_code: string | null;
  failed_step: string | null;
  missing_config: string[];
  config_loaded: boolean;
  token_request_attempted: boolean;
  token_acquired: boolean;
  token_error_status_code: number | null;
  drive_check_attempted: boolean;
  drive_check_status: number | null;
  drive_error_status_code: number | null;
  root_folder_check_attempted: boolean;
  root_folder_check_status: number | null;
  root_folder_error_status_code: number | null;
  site_check_attempted: boolean;
  site_check_status: number | null;
  site_error_status_code: number | null;
  token_audience: string | null;
  authorization_header_present: boolean;
  authorization_header_scheme: string | null;
  graph_base_url_used: string | null;
  drive_url_shape: string | null;
  microsoft_error_code: string | null;
  microsoft_error_message_short: string | null;
  drive: MicrosoftGraphResource | null;
  root_folder: MicrosoftGraphResource | null;
  site: MicrosoftGraphResource | null;
};


export type MicrosoftGraphCreatedSubfolder = {
  sort_order: number;
  name: string;
  id: string | null;
  web_url: string | null;
};

export type MicrosoftGraphCreateTestFolderResponse = {
  created: boolean;
  root_folder: MicrosoftGraphResource;
  subfolders: MicrosoftGraphCreatedSubfolder[];
};

export type MicrosoftGraphBackfillCreatedSite = {
  site_id: number;
  site_number: string | null;
  site_name: string;
  folder_name: string | null;
  web_url: string | null;
};

export type MicrosoftGraphBackfillSkippedSite = {
  site_id: number;
  site_number: string | null;
  site_name: string;
  reason: string;
};

export type MicrosoftGraphBackfillErrorSite = {
  site_id: number;
  site_number: string | null;
  site_name: string;
  safe_error: string;
};

export type MicrosoftGraphBackfillProjectFoldersResponse = {
  total_candidates: number;
  created_count: number;
  skipped_count: number;
  error_count: number;
  created: MicrosoftGraphBackfillCreatedSite[];
  skipped: MicrosoftGraphBackfillSkippedSite[];
  errors: MicrosoftGraphBackfillErrorSite[];
};
