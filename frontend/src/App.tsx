import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { ProtectedRoute } from "./auth/ProtectedRoute";
import { useAuth } from "./auth/AuthContext";
import { AppShell } from "./layout/AppShell";
import { AbsencesPage } from "./pages/AbsencesPage";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { CustomersPage } from "./pages/CustomersPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ExportsPage } from "./pages/ExportsPage";
import { LoginPage, PasswordChangePage } from "./pages/LoginPage";
import { MobileAssignmentDetailPage } from "./pages/MobileAssignmentDetailPage";
import { MobileTimeEntryPage } from "./pages/MobileTimeEntryPage";
import { MyAssignmentsPage } from "./pages/MyAssignmentsPage";
import { PersonsPage } from "./pages/PersonsPage";
import { SitesPage } from "./pages/SitesPage";

const MatrixPage = lazy(() =>
  import("./pages/MatrixPage").then((module) => ({ default: module.MatrixPage })),
);
const SiteMapPage = lazy(() =>
  import("./pages/SiteMapPage").then((module) => ({ default: module.SiteMapPage })),
);
const SiteDetailPage = lazy(() =>
  import("./pages/SiteDetailPage").then((module) => ({ default: module.SiteDetailPage })),
);
const TimeEntriesPage = lazy(() =>
  import("./pages/TimeEntriesPage").then((module) => ({ default: module.TimeEntriesPage })),
);

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute allowPasswordChange />}>
        <Route path="/change-password" element={<PasswordChangePage />} />
      </Route>
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route index element={<HomeRoute />} />
          <Route
            element={<ProtectedRoute roles={["admin", "project_manager", "office"]} />}
          >
            <Route
              path="matrix"
              element={
                <Suspense fallback={<div className="empty-state">Planmatrix wird geladen...</div>}>
                  <MatrixPage />
                </Suspense>
              }
            />
            <Route
              path="time-entries"
              element={
                <Suspense fallback={<div className="empty-state">Zeiten werden geladen...</div>}>
                  <TimeEntriesPage />
                </Suspense>
              }
            />
            <Route path="sites" element={<SitesPage />} />
            <Route
              path="site-map"
              element={
                <Suspense fallback={<div className="empty-state">Baustellenkarte wird geladen...</div>}>
                  <SiteMapPage />
                </Suspense>
              }
            />
            <Route
              path="sites/:siteId"
              element={
                <Suspense fallback={<div className="empty-state">Projektakte wird geladen...</div>}>
                  <SiteDetailPage />
                </Suspense>
              }
            />
            <Route path="absences" element={<AbsencesPage />} />
            <Route path="exports" element={<ExportsPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={["admin"]} />}>
            <Route path="users" element={<AdminUsersPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={["admin", "project_manager"]} />}>
            <Route path="customers" element={<CustomersPage />} />
            <Route path="persons" element={<PersonsPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={["monteur"]} />}>
            <Route path="me/assignments" element={<MyAssignmentsPage />} />
            <Route path="me/assignments/:assignmentId" element={<MobileAssignmentDetailPage />} />
            <Route path="me/time-entry" element={<MobileTimeEntryPage />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}

function HomeRoute() {
  const { user } = useAuth();
  if (user?.role === "monteur") {
    return <Navigate to="/me/assignments" replace />;
  }
  return <DashboardPage />;
}
