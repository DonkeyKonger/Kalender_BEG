import { LogOut, Warehouse } from "lucide-react";

import { useAuth } from "../auth/AuthContext";
import "./WarehousePage.css";

/** Separate shared-tablet entry point; tool workflows will be designed next. */
export function WarehousePage() {
  const { user, logout } = useAuth();

  return (
    <div className="warehouse-workspace">
      <header className="warehouse-header">
        <div className="warehouse-brand">
          <img src="/beg-sidebar-logo.svg" alt="BEG Logo" width={40} height={40} />
          <div><h1>Lager</h1><p>Angemeldet als {user?.display_name}</p></div>
        </div>
        <button type="button" className="icon-button secondary" onClick={() => void logout()}>
          <LogOut size={20} aria-hidden="true" /><span>Abmelden</span>
        </button>
      </header>
      <main className="warehouse-placeholder">
        <Warehouse size={40} aria-hidden="true" />
        <h2>Lagerbereich</h2>
        <p>Der Lagerzugang ist eingerichtet.</p>
        <p>Die Werkzeugausgabe und -rücknahme wird im nächsten Schritt ergänzt.</p>
      </main>
    </div>
  );
}
