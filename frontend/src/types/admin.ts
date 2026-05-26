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
  missing_config: string[];
  drive: MicrosoftGraphResource | null;
  root_folder: MicrosoftGraphResource | null;
  site: MicrosoftGraphResource | null;
};
