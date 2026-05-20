import type { AbsenceType } from "./matrix";

export type AbsenceStatus = "active" | "cancelled";

export type Absence = {
  id: number;
  person_id: number;
  absence_type: AbsenceType;
  start_date: string;
  end_date: string;
  status: AbsenceStatus;
  note: string | null;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

export type AbsenceCreate = {
  person_id: number;
  absence_type: AbsenceType;
  start_date: string;
  end_date: string;
  status: AbsenceStatus;
  note: string | null;
};

export type AbsenceUpdate = Partial<AbsenceCreate>;
