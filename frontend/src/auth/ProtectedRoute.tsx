import { Navigate, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "./AuthContext";
import type { UserRole } from "../types/auth";

export function ProtectedRoute({ roles }: { roles?: UserRole[] }) {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return <div className="screen-state">Wird geladen...</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
