export type MiscellaneousTabKey = "workerEvaluation" | "vehicles" | "toolsMaterial";

export const defaultMiscellaneousTab: MiscellaneousTabKey = "workerEvaluation";
export const toolMaterialTab: MiscellaneousTabKey = "toolsMaterial";
const emptyEmployeeFilterValue = "__empty__";

const miscellaneousTabKeys = new Set<MiscellaneousTabKey>([
  "workerEvaluation",
  "vehicles",
  toolMaterialTab,
]);

export function buildToolMaterialEditPath(employeeId: number): string {
  const search = new URLSearchParams({
    tab: toolMaterialTab,
    employeeId: String(employeeId),
  });
  return `/sonstige?${search.toString()}`;
}

export function getMiscellaneousTab(search: URLSearchParams): MiscellaneousTabKey {
  const tab = search.get("tab");
  return tab && miscellaneousTabKeys.has(tab as MiscellaneousTabKey)
    ? tab as MiscellaneousTabKey
    : defaultMiscellaneousTab;
}

export function getToolMaterialEmployeeFilterValues(search: URLSearchParams): string[] {
  const employeeIds = Array.from(new Set(
    search
      .getAll("employeeId")
      .filter((value) => /^[1-9]\d*$/.test(value)),
  ));
  return search.get("employeeUnassigned") === "1"
    ? [...employeeIds, emptyEmployeeFilterValue]
    : employeeIds;
}

export function setToolMaterialEmployeeFilterValues(
  search: URLSearchParams,
  values: readonly string[],
): URLSearchParams {
  const next = new URLSearchParams(search);
  next.delete("employeeId");
  next.delete("employeeUnassigned");
  for (const value of values) {
    if (value === emptyEmployeeFilterValue) {
      next.set("employeeUnassigned", "1");
    } else if (/^[1-9]\d*$/.test(value) && !next.getAll("employeeId").includes(value)) {
      next.append("employeeId", value);
    }
  }
  return next;
}

export function normalizeToolMaterialRouteSearch(search: URLSearchParams): URLSearchParams {
  return setToolMaterialEmployeeFilterValues(
    search,
    getToolMaterialEmployeeFilterValues(search),
  );
}
