import type { WarehouseHistoryFilters } from "../types/warehouse";

export const warehouseHistoryPageSize = 50;
export function warehouseHistorySearch(filters: WarehouseHistoryFilters): string {
  const query = new URLSearchParams({ page: String(filters.page), page_size: String(warehouseHistoryPageSize) });
  if (filters.search.trim()) query.set("search", filters.search.trim());
  if (filters.direction) query.set("direction", filters.direction);
  if (filters.reviewStatus) query.set("review_status", filters.reviewStatus);
  if (filters.dateFrom) query.set("date_from", filters.dateFrom);
  if (filters.dateTo) query.set("date_to", filters.dateTo);
  return query.toString();
}

export function warehouseHistoryDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
