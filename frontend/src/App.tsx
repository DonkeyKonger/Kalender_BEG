import { Route, Routes } from "react-router-dom";

import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AppShell } from "./layout/AppShell";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { MatrixPage } from "./pages/MatrixPage";
import { MyAssignmentsPage } from "./pages/MyAssignmentsPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";

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
            <Route
              path="sites"
              element={<PlaceholderPage eyebrow="Stammdaten" title="Baustellen" />}
            />
          </Route>
          <Route element={<ProtectedRoute roles={["admin", "project_manager"]} />}>
            <Route
              path="persons"
              element={<PlaceholderPage eyebrow="Stammdaten" title="Personen" />}
            />
          </Route>
          <Route element={<ProtectedRoute roles={["monteur"]} />}>
            <Route path="me/assignments" element={<MyAssignmentsPage />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}
