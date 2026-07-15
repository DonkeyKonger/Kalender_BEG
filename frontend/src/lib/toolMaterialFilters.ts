export const toolMaterialColumnKeys = [
  "beg_number",
  "manufacturer",
  "designation",
  "item_type",
  "device_number",
  "serial_number",
  "employee",
  "item_date",
  "delivery_note",
  "remarks",
  "supplier",
  "invoice_number",
  "stock",
] as const;

export type ToolMaterialColumnKey = (typeof toolMaterialColumnKeys)[number];
export type ToolMaterialSortDirection = "asc" | "desc";

export type ToolMaterialColumnFilter = {
  query?: string;
  values?: string[];
  dateFrom?: string;
  dateTo?: string;
  stockMin?: string;
  stockMax?: string;
};

export type ToolMaterialFilters = Partial<Record<ToolMaterialColumnKey, ToolMaterialColumnFilter>>;

export type ToolMaterialListParams = {
  search?: string;
  filters?: ToolMaterialFilters;
  sortBy?: ToolMaterialColumnKey;
  sortDirection?: ToolMaterialSortDirection;
};

export function isToolMaterialColumnFilterActive(filter: ToolMaterialColumnFilter | undefined): boolean {
  return Boolean(
    filter?.query?.trim()
      || filter?.values?.length
      || filter?.dateFrom
      || filter?.dateTo
      || filter?.stockMin?.trim()
      || filter?.stockMax?.trim(),
  );
}

export function hasToolMaterialFilters(filters: ToolMaterialFilters): boolean {
  return toolMaterialColumnKeys.some((key) => isToolMaterialColumnFilterActive(filters[key]));
}

export function clearToolMaterialColumnFilter(
  filters: ToolMaterialFilters,
  key: ToolMaterialColumnKey,
): ToolMaterialFilters {
  const next = { ...filters };
  delete next[key];
  return next;
}

export function clearAllToolMaterialFilters(): ToolMaterialFilters {
  return {};
}

export function buildToolMaterialSearchParams(params: ToolMaterialListParams = {}): URLSearchParams {
  const search = new URLSearchParams();
  const cleanedSearch = params.search?.trim();
  if (cleanedSearch) {
    search.set("search", cleanedSearch);
  }

  for (const key of toolMaterialColumnKeys) {
    const filter = params.filters?.[key];
    const query = filter?.query?.trim();
    if (query && !["item_date", "stock"].includes(key)) {
      search.set(`filter_${key}`, query);
    }
    for (const value of filter?.values ?? []) {
      search.append(`values_${key}`, value);
    }
    if (key === "item_date") {
      if (filter?.dateFrom) {
        search.set("date_from", filter.dateFrom);
      }
      if (filter?.dateTo) {
        search.set("date_to", filter.dateTo);
      }
    }
    if (key === "stock") {
      const stockMin = filter?.stockMin?.trim();
      const stockMax = filter?.stockMax?.trim();
      if (stockMin) {
        search.set("stock_min", stockMin);
      }
      if (stockMax) {
        search.set("stock_max", stockMax);
      }
    }
  }

  if (params.sortBy) {
    search.set("sort_by", params.sortBy);
    search.set("sort_direction", params.sortDirection ?? "asc");
  }
  return search;
}
