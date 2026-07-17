export const UNASSIGNED_SITE_GROUP_KEY = "unassigned";

export function siteGroupKeyForProjectManager(personId: number | null | undefined): string {
  return personId === null || personId === undefined
    ? UNASSIGNED_SITE_GROUP_KEY
    : String(personId);
}

export function initialCollapsedSiteGroupKeys(
  groupKeys: Iterable<string>,
  currentPersonId: number | null | undefined,
): Set<string> {
  const ownGroupKey = currentPersonId === null || currentPersonId === undefined
    ? null
    : siteGroupKeyForProjectManager(currentPersonId);

  return new Set([...groupKeys].filter((groupKey) => groupKey !== ownGroupKey));
}

export function withNewForeignSiteGroupsCollapsed(
  collapsedGroupKeys: ReadonlySet<string>,
  knownGroupKeys: ReadonlySet<string>,
  currentGroupKeys: Iterable<string>,
  currentPersonId: number | null | undefined,
): Set<string> {
  const ownGroupKey = currentPersonId === null || currentPersonId === undefined
    ? null
    : siteGroupKeyForProjectManager(currentPersonId);
  const next = new Set(collapsedGroupKeys);

  for (const groupKey of currentGroupKeys) {
    if (!knownGroupKeys.has(groupKey) && groupKey !== ownGroupKey) {
      next.add(groupKey);
    }
  }

  return next;
}
