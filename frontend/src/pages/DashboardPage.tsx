import { CalendarDays, ClipboardList, ShieldCheck } from "lucide-react";

import { useAuth } from "../auth/AuthContext";
import { RoleBadge } from "../components/StatusBadge";

export function DashboardPage() {
  const { user } = useAuth();

  return (
    <section className="page-stack">
      <div className="page-header">
        <div>
          <p className="eyebrow">Start</p>
          <h1>Ubersicht</h1>
        </div>
        {user && <RoleBadge role={user.role} />}
      </div>

      <div className="status-grid">
        <article className="status-card">
          <CalendarDays aria-hidden="true" size={22} />
          <div>
            <h2>Planmatrix</h2>
            <p>Die erste Matrixansicht folgt in Schritt 8.</p>
          </div>
        </article>
        <article className="status-card">
          <ClipboardList aria-hidden="true" size={22} />
          <div>
            <h2>Kern-API</h2>
            <p>Personen, Baustellen, Einsaetze, Abwesenheiten und Matrixdaten sind angebunden.</p>
          </div>
        </article>
        <article className="status-card">
          <ShieldCheck aria-hidden="true" size={22} />
          <div>
            <h2>Konflikte</h2>
            <p>Speichern wird verbindlich durch das Backend geprueft.</p>
          </div>
        </article>
      </div>
    </section>
  );
}
