/** Navigation only: no search, planning data or layout preferences are changed. */
export function matrixSiteHref(siteId: number, projectManagerPersonId: number | null): string {
  return `/matrix?site=${siteId}&projectManager=${projectManagerPersonId ?? "all"}`;
}

export function matrixNavigationTarget(search: string): { siteId: number; managerFilter: string } | null {
  const params = new URLSearchParams(search);
  const siteId = Number(params.get("site"));
  if (!Number.isSafeInteger(siteId) || siteId <= 0) return null;
  const manager = Number(params.get("projectManager"));
  return { siteId, managerFilter: Number.isSafeInteger(manager) && manager > 0 ? String(manager) : "all" };
}

export function matrixSiteScrollTop(currentTop: number, rowTop: number, containerTop: number, stickyHeight: number): number {
  return Math.max(0, currentTop + rowTop - containerTop - stickyHeight - 8);
}
