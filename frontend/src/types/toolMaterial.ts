export type ToolMaterialEmployee = {
  id: number;
  display_name: string;
  short_code: string;
  person_type: "internal" | "external" | "external_temp";
  is_active: boolean;
};

export type ToolMaterialStatus = "issued" | "warehouse" | "written_off";

export type ToolMaterialCategory =
  | "drilling_screwing"
  | "grinding_cutting"
  | "sawing"
  | "vacuuming"
  | "measuring"
  | "batteries_charging"
  | "hand_tools"
  | "ladders_work_equipment"
  | "testing_equipment"
  | "vehicle_accessories"
  | "material"
  | "other";

export type ToolMaterialItem = {
  id: number;
  beg_number: string | null;
  manufacturer: string | null;
  designation: string;
  item_type: string | null;
  device_number: string | null;
  serial_number: string | null;
  employee_id: number | null;
  employee: ToolMaterialEmployee | null;
  item_date: string | null;
  delivery_note: string | null;
  remarks: string | null;
  supplier: string | null;
  invoice_number: string | null;
  stock: number | null;
  category: ToolMaterialCategory;
  status: ToolMaterialStatus;
  created_at: string;
  updated_at: string;
  open_issue_reports: ToolIssueSystemNote[];
};

export type ToolIssueSystemNote = {
  id: number;
  reason: "DEFECTIVE" | "STOLEN";
  reporter_last_name_snapshot: string;
  created_at: string;
};

export type ToolMaterialItemCreate = {
  beg_number: string;
  manufacturer?: string | null;
  designation: string;
  item_type?: string | null;
  device_number?: string | null;
  serial_number?: string | null;
  employee_id?: number | null;
  item_date?: string | null;
  delivery_note?: string | null;
  remarks?: string | null;
  supplier?: string | null;
  invoice_number?: string | null;
  stock?: number | null;
  category: ToolMaterialCategory;
  status: ToolMaterialStatus;
};

export type ToolMaterialItemUpdate = Partial<ToolMaterialItemCreate>;

export type ToolMaterialFilterOption = {
  value: string;
  label: string;
};

export type ToolMaterialFilterOptions = {
  columns: Record<string, ToolMaterialFilterOption[]>;
};

export type ToolResponsibleUser = {
  id: number;
  display_name: string;
  is_active: boolean;
  is_valid: boolean;
  invalid_reason: string | null;
};

export type ToolMaterialResponsibility = {
  tool_responsible_user_id: number | null;
  responsible_user: ToolResponsibleUser | null;
};
