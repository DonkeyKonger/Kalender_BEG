export const toolMaterialColumns = [
  { key: "beg_number", label: "BEG-Nr.", type: "text" },
  { key: "manufacturer", label: "Fabrikat", type: "text" },
  { key: "designation", label: "Bezeichnung", type: "text" },
  { key: "item_type", label: "Typ", type: "text" },
  { key: "device_number", label: "Gerätenummer", type: "text" },
  { key: "serial_number", label: "Seriennummer", type: "text" },
  { key: "employee", label: "Mitarbeiter", type: "text" },
  { key: "item_date", label: "Datum", type: "date" },
  { key: "delivery_note", label: "Lieferschein", type: "text" },
  { key: "remarks", label: "Bemerkungen", type: "text" },
  { key: "supplier", label: "Lieferant", type: "text" },
  { key: "invoice_number", label: "RG-Nr.", type: "text" },
  { key: "status", label: "Status", type: "enum" },
] as const;

export type ToolMaterialColumn = (typeof toolMaterialColumns)[number];
export type ToolMaterialColumnKey = ToolMaterialColumn["key"];
export const toolMaterialColumnKeys: readonly ToolMaterialColumnKey[] = toolMaterialColumns.map(
  (column) => column.key,
);
export type ToolMaterialSortDirection = "asc" | "desc";

export type ToolMaterialColumnFilter = {
  query?: string;
  values?: string[];
  dateFrom?: string;
  dateTo?: string;
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
      || filter?.dateTo,
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
    if (query && key !== "item_date") {
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
  }

  if (params.sortBy) {
    search.set("sort_by", params.sortBy);
    search.set("sort_direction", params.sortDirection ?? "asc");
  }
  return search;
}
