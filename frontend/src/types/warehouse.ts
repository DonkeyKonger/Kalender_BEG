import type { CustomerSignatureStroke } from "./site";

export type WarehouseDirection = "issue" | "return";
export type WarehousePerson = { id: number; display_name: string; short_code: string };
export type WarehouseTool = {
  id: number;
  beg_number: string | null;
  designation: string;
  manufacturer: string | null;
  item_type: string | null;
  device_number: string | null;
  serial_number: string | null;
  category: string;
};
export type WarehouseToolPage = { items: WarehouseTool[]; total: number };
export type WarehouseBooking = {
  request_id: string;
  direction: WarehouseDirection;
  employee_id: number;
  tool_ids: number[];
  signature_strokes: CustomerSignatureStroke[];
};
export type WarehouseReceipt = {
  id: number;
  direction: WarehouseDirection;
  employee_name: string;
  items: WarehouseTool[];
  created_at: string;
};

export type WarehouseHistoryEntry = WarehouseReceipt & { actor_name: string };
export type WarehouseHistoryPage = { items: WarehouseHistoryEntry[]; total: number; page: number; page_size: number };
export type WarehouseHistoryDetail = WarehouseHistoryEntry & { signature_strokes: CustomerSignatureStroke[] };
export type WarehouseHistoryFilters = { search: string; direction: WarehouseDirection | ""; dateFrom: string; dateTo: string; page: number };
