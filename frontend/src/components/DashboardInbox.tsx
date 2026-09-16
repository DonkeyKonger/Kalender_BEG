import { ChevronRight, Inbox, ReceiptText } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type DashboardBilling } from "../lib/api";
import "./DashboardInbox.css";

const modes = ["messages", "billing"] as const;
type Mode = typeof modes[number];

export function DashboardInbox({ badge, children, canViewBilling }: {
  badge?: ReactNode; children: ReactNode; canViewBilling: boolean;
}) {
  const [selectedMode, setMode] = useState<Mode>("messages");
  const mode = canViewBilling ? selectedMode : "messages";
  const [billing, setBilling] = useState<DashboardBilling | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const tabsRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    // Keep the site counter current even while the messages tab is selected.
    if (!canViewBilling) return;
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      setLoading(true);
      try {
        const result = await api.dashboardBilling();
        if (active) { setBilling(result); setError(false); }
      } catch {
        if (active) setError(true);
      } finally {
        pending = false;
        if (active) setLoading(false);
      }
    }
    void refresh();
    // Also cover invoicing in another browser tab; no changes are made here.
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [mode, canViewBilling, retry]);

  return (
    <article className="dashboard-card dashboard-card-messages dashboard-section--messages dashboard-inbox">
      {canViewBilling ? (
        <div className="dashboard-inbox-tabs" role="tablist" aria-label="Meldungen und Abrechnung" ref={tabsRef}>
          {modes.map((value, index) => (
            <button key={value} type="button" role="tab" id={`${id}-${value}-tab`}
              aria-controls={`${id}-${value}-panel`} aria-selected={mode === value}
              tabIndex={mode === value ? 0 : -1} onClick={() => setMode(value)}
              onKeyDown={event => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
                setMode(modes[next]);
                tabsRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
              }}>
              {value === "messages" ? <Inbox size={15} aria-hidden="true" /> : <ReceiptText size={15} aria-hidden="true" />}
              <span>{value === "messages" ? "Meldungen" : "Abrechnung"}</span>
              {value === "messages" && badge ? <strong className="dashboard-card-badge">{badge}</strong> : null}
              {value === "billing" ? <DashboardBillingCount billing={billing} error={error} /> : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="dashboard-card-header">
          <span><Inbox aria-hidden="true" size={20} /></span>
          <div><h2>Meldungen</h2></div>
          {badge ? <strong className="dashboard-card-badge">{badge}</strong> : null}
        </div>
      )}
      <div className="dashboard-inbox-panel" role={canViewBilling ? "tabpanel" : undefined} id={`${id}-messages-panel`}
        aria-labelledby={canViewBilling ? `${id}-messages-tab` : undefined} hidden={mode !== "messages"} tabIndex={0}>
        {children}
      </div>
      {canViewBilling && (
        <div className="dashboard-inbox-panel dashboard-billing-panel" role="tabpanel" id={`${id}-billing-panel`}
          aria-labelledby={`${id}-billing-tab`} hidden={mode !== "billing"} tabIndex={0} aria-busy={loading}>
          {error ? (
            <div className="dashboard-billing-feedback" role="alert">
              <p>Die Abrechnungsliste konnte nicht aktualisiert werden.</p>
              <button type="button" onClick={() => setRetry(value => value + 1)}>Erneut laden</button>
            </div>
          ) : billing ? <DashboardBillingList billing={billing} />
            : <p className="dashboard-billing-feedback" role="status">Abrechnung wird geladen…</p>}
        </div>
      )}
    </article>
  );
}

export function DashboardBillingCount({ billing, error }: { billing: DashboardBilling | null; error: boolean }) {
  const count = !error && billing ? billing.sites.length : null;
  const label = count === null
    ? error ? "Baustellenanzahl derzeit nicht verfügbar" : "Baustellenanzahl wird geladen"
    : `${count} ${count === 1 ? "Baustelle" : "Baustellen"} mit offenen Abrechnungen`;
  return <strong className="dashboard-card-badge" title={label} aria-label={label}>{count ?? "–"}</strong>;
}

export function DashboardBillingList({ billing }: { billing: DashboardBilling }) {
  return (
    <>
      <p className="dashboard-billing-summary">
        <span>Abgerechnet wird direkt in der Baustelle markiert.</span>
      </p>
      {billing.sites.length ? (
        <div className="dashboard-billing-sites">
          {billing.sites.map(site => (
            <details className="dashboard-billing-site" key={site.site_id}>
              <summary>
                <ChevronRight size={15} aria-hidden="true" />
                <span className="dashboard-billing-site-heading">
                  <strong>{site.site_name}</strong>
                  <small>{[site.site_number, site.project_manager_name].filter(Boolean).join(" · ")}</small>
                </span>
                <span className="dashboard-billing-count" aria-label={`${site.items.length} ${site.items.length === 1 ? "offener Eintrag" : "offene Einträge"}`}>
                  {site.items.length}
                </span>
              </summary>
              <ul>
                {site.items.map(item => (
                  <li key={`${item.kind}-${item.id}`}>
                    <Link to={`/sites/${site.site_id}?tab=${item.kind === "measurement" ? "measurement&measurementSubtab=review" : "extra-work"}`}>
                      <strong>{item.title}</strong>
                      <span className="dashboard-billing-item-meta">
                        <span>{item.status_label}</span>
                        {item.date ? <time dateTime={item.date}>{item.date.split("-").reverse().join(".")}</time> : null}
                        <ChevronRight size={14} aria-hidden="true" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      ) : (
        <div className="dashboard-billing-feedback">
          <strong>Keine offenen Abrechnungen</strong>
          <p>Keine unabgerechneten Aufmaße oder Zusatzaufträge ab Status „Eingereicht“ vorhanden.</p>
        </div>
      )}
    </>
  );
}
