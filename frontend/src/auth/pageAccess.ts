import type { CurrentUser, OfficePagePermission } from "../types/auth";
import type { NavigationItem } from "../types/navigation";


export function canAccessMainPage(user: CurrentUser, pageKey: OfficePagePermission): boolean {
  if (pageKey === "miscellaneous") {
    return user.role === "admin"
      || (
        user.role === "office"
        && (user.office_page_permissions ?? []).includes(pageKey)
      );
  }
  if (user.role === "admin") {
    return true;
  }
  if (user.role === "project_manager") {
    return true;
  }
  if (user.role === "office") {
    return (user.office_page_permissions ?? []).includes(pageKey);
  }
  return false;
}

export function canManagePayrollMonthClose(user: CurrentUser | null): boolean {
  return user !== null && canAccessMainPage(user, "payroll");
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
