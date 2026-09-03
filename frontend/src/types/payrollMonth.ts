export type PayrollMonthPeriodStatus = "OPEN" | "LOCKED";

export type PayrollMonthBlocker = {
  code: string;
  message: string;
  person_id?: number | null;
  work_date?: string | null;
};

export type PayrollMonthPeriod = {
  year: number;
  month: number;
  status: PayrollMonthPeriodStatus;
  snapshot_id: number | null;
  snapshot_version: number | null;
  locked_at: string | null;
  locked_by_name: string | null;
  can_lock: boolean;
  can_reopen: boolean;
  artifacts_ready: boolean;
  blockers: PayrollMonthBlocker[];
};

export type PayrollWeeklyPlan = {
  id: number | null;
  valid_from: string;
  valid_to: string | null;
  weekday_minutes: number[];
  weekly_minutes: number;
  is_confirmed: boolean;
  confirmed_by_name: string | null;
  confirmed_at: string | null;
};

export type PayrollOpeningBalance = {
  minutes: number | null;
  is_confirmed: boolean;
  confirmed_by_name: string | null;
  confirmed_at: string | null;
};

export type PayrollSetupWorker = {
  person_id: number;
  person_name: string;
  weekly_hours: number | null;
  plan: PayrollWeeklyPlan | null;
  opening_balance: PayrollOpeningBalance | null;
  historical_balance_minutes: number;
};

export type PayrollSetup = {
  effective_date: string;
  is_ready: boolean;
  workers: PayrollSetupWorker[];
};

export type PayrollWeeklyPlanUpdate = {
  valid_from: string;
  weekday_minutes: number[];
  note?: string | null;
  confirm: true;
};

export type PayrollOpeningBalanceUpdate = {
  effective_date: string;
  minutes: number;
  note?: string | null;
  confirm: true;
};
