export type TimeGpsTestDataStatus = {
  enabled: boolean;
  environment: string;
  message: string | null;
};

export type TimeGpsTestDataGenerateRequest = {
  start_date?: string | null;
  end_date?: string | null;
  error_rate?: number;
  seed?: number | null;
  clear_previous_test_data?: boolean;
};

export type TimeGpsTestDataGenerateResponse = {
  batch_id: string;
  start_date: string;
  end_date: string;
  random_seed: number;
  people_used: number;
  sites_used: number;
  assignments_created: number;
  work_time_entries_created: number;
  gps_points_created: number;
  absences_created: number;
  created_test_people: number;
  created_test_sites: number;
  scenarios: Record<string, number>;
  expected_open_review_cases: number;
  expected_checked_cases: number;
  cleared_previous_rows: Record<string, number>;
};

export type TimeGpsTestDataClearResponse = {
  batch_id: string | null;
  all_test_data: boolean;
  deleted_counts: Record<string, number>;
};
