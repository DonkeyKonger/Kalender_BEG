import { Navigate, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "./AuthContext";
import { canAccessMainPage, firstAccessiblePath } from "./permissions";
import type { OfficePagePermission, UserRole } from "../types/auth";

export function ProtectedRoute({
  roles,
  officePermission,
  allowPasswordChange = false,
}: {
  roles?: UserRole[];
  officePermission?: OfficePagePermission;
  allowPasswordChange?: boolean;
}) {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return <div className="screen-state">Wird geladen...</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (user.must_change_password && !allowPasswordChange) {
    return <Navigate to="/change-password" replace state={{ from: location }} />;
  }

  if (roles && !roles.includes(user.role)) {
    return <Navigate to={firstAccessiblePath(user) ?? "/no-office-pages"} replace />;
  }

  if (officePermission && !canAccessMainPage(user, officePermission)) {
    return <Navigate to={firstAccessiblePath(user) ?? "/no-office-pages"} replace />;
  }

  return <Outlet />;
}
