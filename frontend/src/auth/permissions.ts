import { navigationItems } from "../config/navigation";
import type { CurrentUser, OfficePagePermission } from "../types/auth";
import type { NavigationItem } from "../types/navigation";

export function canAccessMainPage(user: CurrentUser, pageKey: OfficePagePermission): boolean {
  if (user.role === "admin") {
    return true;
  }
  if (user.role !== "office") {
    return true;
  }
  return (user.office_page_permissions ?? []).includes(pageKey);
}

export function canShowNavItem(user: CurrentUser, item: NavigationItem): boolean {
  if (!item.roles.includes(user.role)) {
    return false;
  }
  if (item.adminOnly && user.role !== "admin") {
    return false;
  }
  if (user.role !== "office") {
    return true;
  }
  if (!item.officePermission) {
    return false;
  }
  return canAccessMainPage(user, item.officePermission);
}

export function firstAccessiblePath(user: CurrentUser): string | null {
  const item = navigationItems.find((navItem) => canShowNavItem(user, navItem));
  return item?.path ?? null;
}
