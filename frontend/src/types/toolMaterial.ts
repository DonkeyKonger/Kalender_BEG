export type ToolMaterialEmployee = {
  id: number;
  display_name: string;
  short_code: string;
  person_type: "internal" | "external" | "external_temp";
  is_active: boolean;
};

export type ToolMaterialStatus = "issued" | "warehouse" | "defective";

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
  status: ToolMaterialStatus;
  created_at: string;
  updated_at: string;
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
