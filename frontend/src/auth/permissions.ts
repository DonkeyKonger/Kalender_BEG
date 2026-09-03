import { navigationItems } from "../config/navigation";
import { canAccessMainPage, canShowNavItem } from "./pageAccess";
import type { CurrentUser, OfficePagePermission } from "../types/auth";

export { canAccessMainPage, canManagePayrollMonthClose, canShowNavItem } from "./pageAccess";

export function canEditMainPage(user: CurrentUser | null, pageKey: OfficePagePermission): boolean {
  if (!user || !["admin", "project_manager", "office"].includes(user.role)) {
    return false;
  }
  return canAccessMainPage(user, pageKey);
}

export function firstAccessiblePath(user: CurrentUser): string | null {
  const item = navigationItems.find((navItem) => canShowNavItem(user, navItem));
  return item?.path ?? null;
}
