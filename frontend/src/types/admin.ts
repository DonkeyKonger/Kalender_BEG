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
  drive: MicrosoftGraphResource | null;
  root_folder: MicrosoftGraphResource | null;
  site: MicrosoftGraphResource | null;
};
