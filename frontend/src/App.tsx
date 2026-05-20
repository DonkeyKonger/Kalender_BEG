import { Route, Routes } from "react-router-dom";

import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AppShell } from "./layout/AppShell";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ExportsPage } from "./pages/ExportsPage";
import { LoginPage } from "./pages/LoginPage";
import { MatrixPage } from "./pages/MatrixPage";
import { MyAssignmentsPage } from "./pages/MyAssignmentsPage";
import { PersonsPage } from "./pages/PersonsPage";
import { SiteDetailPage } from "./pages/SiteDetailPage";
import { SitesPage } from "./pages/SitesPage";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route
            element={<ProtectedRoute roles={["admin", "project_manager", "office"]} />}
          >
            <Route path="matrix" element={<MatrixPage />} />
            <Route path="sites" element={<SitesPage />} />
            <Route path="sites/:siteId" element={<SiteDetailPage />} />
            <Route path="exports" element={<ExportsPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={["admin"]} />}>
            <Route path="users" element={<AdminUsersPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={["admin", "project_manager"]} />}>
            <Route path="persons" element={<PersonsPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={["monteur"]} />}>
            <Route path="me/assignments" element={<MyAssignmentsPage />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}
