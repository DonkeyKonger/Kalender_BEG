import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { ProtectedRoute } from "./auth/ProtectedRoute";
import { useAuth } from "./auth/AuthContext";
import { canAccessMainPage, firstAccessiblePath } from "./auth/permissions";
import { AppShell } from "./layout/AppShell";
import { AbsencesPage } from "./pages/AbsencesPage";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { CustomersPage } from "./pages/CustomersPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ExportsPage } from "./pages/ExportsPage";
import { LoginPage, PasswordChangePage } from "./pages/LoginPage";
import { MobileTimeEntryPage } from "./pages/MobileTimeEntryPage";
import { MiscellaneousPage } from "./pages/MiscellaneousPage";
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
const MobileAssignmentDetailPage = lazy(() =>
  import("./pages/MobileAssignmentDetailPage").then((module) => ({ default: module.MobileAssignmentDetailPage })),
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
          <Route element={<ProtectedRoute roles={["admin", "project_manager", "office"]} officePermission="calendar" />}>
            <Route
              path="matrix"
              element={
                <Suspense fallback={<div className="empty-state">Planmatrix wird geladen...</div>}>
                  <MatrixPage />
                </Suspense>
              }
            />
          </Route>
          <Route element={<ProtectedRoute roles={["admin", "project_manager", "office"]} officePermission="payroll" />}>
            <Route
              path="time-entries"
              element={
                <Suspense fallback={<div className="empty-state">Lohnprüfung wird geladen...</div>}>
                  <TimeEntriesPage />
                </Suspense>
              }
            />
          </Route>
          <Route element={<ProtectedRoute roles={["admin", "project_manager", "office"]} officePermission="sites" />}>
            <Route path="sites" element={<SitesPage />} />
            <Route
              path="sites/:siteId"
              element={
                <Suspense fallback={<div className="empty-state">Projektakte wird geladen...</div>}>
                  <SiteDetailPage />
                </Suspense>
              }
            />
          </Route>
          <Route element={<ProtectedRoute roles={["admin", "project_manager", "office"]} officePermission="map" />}>
            <Route
              path="site-map"
              element={
                <Suspense fallback={<div className="empty-state">Baustellenkarte wird geladen...</div>}>
                  <SiteMapPage />
                </Suspense>
              }
            />
          </Route>
          <Route element={<ProtectedRoute roles={["admin", "project_manager", "office"]} officePermission="absences" />}>
            <Route path="absences" element={<AbsencesPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={["admin", "project_manager", "office"]} officePermission="export" />}>
            <Route path="exports" element={<ExportsPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={["admin"]} />}>
            <Route path="sonstige" element={<MiscellaneousPage />} />
            <Route path="users" element={<AdminUsersPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={["admin", "project_manager", "office"]} officePermission="customers" />}>
            <Route path="customers" element={<CustomersPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={["admin", "project_manager", "office"]} officePermission="employees" />}>
            <Route path="persons" element={<PersonsPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={["office"]} />}>
            <Route path="no-office-pages" element={<NoOfficePages />} />
          </Route>
          <Route element={<ProtectedRoute roles={["monteur"]} />}>
            <Route path="me/assignments" element={<MyAssignmentsPage />} />
            <Route
              path="me/assignments/:assignmentId"
              element={
                <Suspense fallback={<div className="empty-state">Einsatzdetails werden geladen...</div>}>
                  <MobileAssignmentDetailPage />
                </Suspense>
              }
            />
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
  if (user?.role === "office" && !canAccessMainPage(user, "overview")) {
    const fallbackPath = firstAccessiblePath(user);
    return fallbackPath ? <Navigate to={fallbackPath} replace /> : <NoOfficePages />;
  }
  return <DashboardPage />;
}

function NoOfficePages() {
  return (
    <div className="empty-state">
      <strong>Für diesen Benutzer wurden noch keine Seiten freigeschaltet.</strong>
      <span>Bitte wenden Sie sich an einen Administrator.</span>
    </div>
  );
}
