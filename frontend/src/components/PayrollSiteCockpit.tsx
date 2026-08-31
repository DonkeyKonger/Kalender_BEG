import { CircleHelp, Clock3, ReceiptText, TrendingDown, TrendingUp } from "lucide-react";
import type { ReactNode } from "react";

import { formatPayrollSiteMinutes, formatPayrollSiteSignedMinutes } from "../lib/payrollSiteCockpit";
import type { PayrollSiteCockpit as PayrollSiteCockpitData } from "../types/timeEntry";

type Props = { data: PayrollSiteCockpitData | null; error: string | null; isLoading: boolean; onRetry: () => void };

export function PayrollSiteCockpit({ data, error, isLoading, onRetry }: Props) {
  if (error) return <div className="payroll-site-cockpit-state" role="alert">{error}<button type="button" onClick={onRetry}>Erneut laden</button></div>;
  if (isLoading || !data) return <div className="payroll-site-cockpit-state" role="status">Baustellen-Auswertung wird geladen...</div>;
  const totals = data.totals;
  return <section className="payroll-site-cockpit payroll-site-realization" aria-label="Monatliche Baustellenleistung">
    <header className="payroll-site-realization-head"><div><h2>Monatlicher Leistungsabgleich</h2><p>Realisierte Leistung aus Aufmaß-Einreichungen im gewählten Monat.</p></div></header>
    <details className="payroll-site-calculation-info"><summary><CircleHelp aria-hidden="true" size={16} />So wird berechnet</summary><p>Eine Aufmaß-Einreichung ist das Realisierungsereignis: Alle bis dahin noch nicht realisierten Monteurstunden dieser Baustelle werden in ihrem Einreichungsmonat als Arbeitsstunden zugeordnet. Aufmaßstunden zählen genau einmal über das unveränderliche erste Einreichdatum. Zusatzaufträge zählen nur als abgerechnet und werden über ihr Abrechnungsdatum dem nächsten passenden Aufmaßereignis zugeordnet; noch nicht realisierte oder nicht abgerechnete Werte bleiben offen. Ergebnis = Aufmaßstunden + Zusatzauftragsstunden − Arbeitsstunden. Positiv ist günstig, negativ ungünstig.</p></details>
    <div className="payroll-site-realization-metrics"><Metric icon={<ReceiptText />} label="Aufmaßstunden" value={formatPayrollSiteMinutes(totals.measurement_minutes)} /><Metric icon={<TrendingUp />} label="Zusatzaufträge" value={formatPayrollSiteMinutes(totals.supplementary_minutes)} /><Metric icon={<Clock3 />} label="Arbeitsstunden" value={formatPayrollSiteMinutes(totals.realized_actual_minutes)} /><Metric icon={<TrendingDown />} label="Ergebnis" value={formatPayrollSiteSignedMinutes(totals.result_minutes)} /></div>
    {data.sites.length ? <div className="payroll-site-realization-list" role="list">{data.sites.map((site) => <article className={`payroll-site-realization-row is-${site.result_tone}`} key={site.site_id} role="listitem"><header><strong>{site.site_name}</strong><small>{site.site_number}</small></header><dl><div><dt>Aufmaß</dt><dd>{formatPayrollSiteMinutes(site.measurement_minutes)}</dd></div><div><dt>Zusatzauftrag</dt><dd>{formatPayrollSiteMinutes(site.supplementary_minutes)}</dd></div><div><dt>Leistung</dt><dd>{formatPayrollSiteMinutes(site.performance_minutes)}</dd></div><div><dt>Arbeitsstunden</dt><dd>{formatPayrollSiteMinutes(site.realized_actual_minutes)}</dd></div><div><dt>Ergebnis</dt><dd>{formatPayrollSiteSignedMinutes(site.result_minutes)}</dd></div></dl></article>)}</div> : <div className="payroll-site-empty-state">Im gewählten Monat gab es keine Aufmaß-Realisierung.</div>}
  </section>;
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) { return <article className="payroll-site-metric"><span className="payroll-site-metric-icon">{icon}</span><span className="payroll-site-metric-copy"><span>{label}</span><strong>{value}</strong></span></article>; }
