import { AlertTriangle, BriefcaseBusiness, ChevronRight, Clock3, Gauge } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useMemo } from "react";

import {
  buildPayrollSiteHistoryChart,
  buildPayrollSiteTrackLayout,
  formatPayrollSiteChartDate,
  formatPayrollSiteMinutes,
  formatPayrollSiteSignedMinutes,
  payrollSitePortfolioScale,
  payrollSiteLabel,
  resolvePayrollSiteActionItems,
} from "../lib/payrollSiteCockpit";
import { formatGermanDateKey } from "../lib/formatters";
import type {
  PayrollSiteActionItem,
  PayrollSiteCockpit as PayrollSiteCockpitData,
  PayrollSiteCockpitSite,
  PayrollSiteHistory,
} from "../types/timeEntry";

type PayrollSiteCockpitProps = {
  data: PayrollSiteCockpitData | null;
  error: string | null;
  history: PayrollSiteHistory | null;
  historyError: string | null;
  isHistoryLoading: boolean;
  isLoading: boolean;
  onRetry: () => void;
  onRetryHistory: () => void;
  onSelectSite: (siteId: number) => void;
  selectedSiteId: number | null;
};

export function PayrollSiteCockpit({
  data,
  error,
  history,
  historyError,
  isHistoryLoading,
  isLoading,
  onRetry,
  onRetryHistory,
  onSelectSite,
  selectedSiteId,
}: PayrollSiteCockpitProps) {
  const actionItems = useMemo(() => data ? resolvePayrollSiteActionItems(data) : [], [data]);
  const trackScaleMinutes = useMemo(() => data ? payrollSitePortfolioScale(data.sites) : 1, [data]);
  const hasForecast = data?.sites.some((site) => site.forecast_minutes !== null) ?? false;
  const selectedSite = data?.sites.find((site) => site.site_id === selectedSiteId) ?? null;

  if (isLoading || !data) {
    if (error) {
      return <CockpitError message={error} onRetry={onRetry} />;
    }
    return <div className="payroll-site-cockpit-state" role="status" aria-live="polite">Baustellen-Cockpit wird geladen...</div>;
  }

  return (
    <section className="payroll-site-cockpit" aria-label="Baustellen-Cockpit" aria-busy={isLoading}>
      {error ? <CockpitError message={error} onRetry={onRetry} compact /> : null}
      <PortfolioMetrics data={data} />

      <div className="payroll-site-cockpit-overview">
        <section className="payroll-site-forecast-panel" aria-labelledby="payroll-site-forecast-heading">
          <header className="payroll-site-panel-heading">
            <div>
              <h2 id="payroll-site-forecast-heading">Stunden-Forecast je Baustelle</h2>
              <p>Kumulierte, lohnrelevante Stunden bis {formatGermanDateKey(data.effective_as_of, "numeric")}</p>
            </div>
            <ForecastLegend hasForecast={hasForecast} />
          </header>
          {data.sites.length > 0 ? (
            <div className="payroll-site-forecast-list" role="listbox" aria-label="Baustelle für den Stundenverlauf auswählen">
              {data.sites.map((site, index) => (
                <ForecastSiteRow
                  isSelected={site.site_id === selectedSiteId}
                  isTabStop={site.site_id === selectedSiteId || (selectedSiteId === null && index === 0)}
                  key={site.site_id}
                  onSelectSite={onSelectSite}
                  scaleMinutes={trackScaleMinutes}
                  site={site}
                />
              ))}
            </div>
          ) : (
            <div className="payroll-site-empty-state">Im gewählten Zeitraum sind keine Baustellenstunden vorhanden.</div>
          )}
        </section>

        <ActionPanel actionItems={actionItems} onSelectSite={onSelectSite} selectedSiteId={selectedSiteId} />
      </div>

      <HistoryPanel
        error={historyError}
        history={history}
        isLoading={isHistoryLoading}
        onRetry={onRetryHistory}
        selectedSite={selectedSite}
      />
    </section>
  );
}

function PortfolioMetrics({ data }: { data: PayrollSiteCockpitData }) {
  const { totals } = data;
  const forecastCoverage = totals.forecast_site_count === 1
    ? "1 belastbare Baustellenprognose"
    : `${totals.forecast_site_count} belastbare Baustellenprognosen`;
  const varianceTone = totals.variance_minutes !== null && totals.variance_minutes > 0 ? " is-danger" : "";
  const offerBudgetNote = `${totals.budget_site_count}/${totals.site_count} Budgets · aktuelle Basis (${formatGermanDateKey(data.offer_budget_as_of)})`;
  const offerBudgetNoteDetail = `${totals.budget_site_count} von ${totals.site_count} Budgets aus der aktuell aktiven und für Monteure freigegebenen Angebotsbasis, Abrufstichtag ${formatGermanDateKey(data.offer_budget_as_of, "numeric")}`;

  return (
    <div className="payroll-site-metrics" aria-label="Portfolio-Kennzahlen">
      <MetricCard
        icon={<BriefcaseBusiness aria-hidden="true" size={23} />}
        label="Angebotsstunden"
        note={offerBudgetNote}
        noteDetail={offerBudgetNoteDetail}
        value={formatPayrollSiteMinutes(totals.offer_minutes)}
      />
      <MetricCard
        icon={<Clock3 aria-hidden="true" size={23} />}
        label="Kumulierte Ist-Stunden"
        note={`Stand ${formatGermanDateKey(data.effective_as_of, "numeric")}`}
        value={formatPayrollSiteMinutes(totals.actual_minutes)}
      />
      <MetricCard
        icon={<Gauge aria-hidden="true" size={23} />}
        label="Prognose Endstand"
        note={totals.forecast_minutes === null ? totals.forecast_reason || "Keine belastbare Prognose" : forecastCoverage}
        value={formatPayrollSiteMinutes(totals.forecast_minutes)}
      />
      <MetricCard
        className={varianceTone}
        icon={<AlertTriangle aria-hidden="true" size={23} />}
        label="Prognostizierte Abweichung"
        note={totals.variance_minutes === null ? "Ohne belastbare Prognose" : "Prognose minus Angebot"}
        value={formatPayrollSiteSignedMinutes(totals.variance_minutes)}
      />
    </div>
  );
}

function MetricCard({
  className = "",
  icon,
  label,
  note,
  noteDetail,
  value,
}: {
  className?: string;
  icon: ReactNode;
  label: string;
  note: string;
  noteDetail?: string;
  value: string;
}) {
  return (
    <article className={`payroll-site-metric${className}`}>
      <span className="payroll-site-metric-icon">{icon}</span>
      <span className="payroll-site-metric-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small aria-label={noteDetail} title={noteDetail}>{note}</small>
      </span>
    </article>
  );
}

function ForecastLegend({ hasForecast }: { hasForecast: boolean }) {
  return (
    <div className="payroll-site-legend-block">
      <div className="payroll-site-legend" aria-label="Legende">
        <span><i className="is-actual" aria-hidden="true" />Ist-Stunden</span>
        {hasForecast ? <span><i className="is-forecast" aria-hidden="true" />Prognose</span> : null}
        <span><i className="is-overrun" aria-hidden="true" />Überzug</span>
        <span><i className="is-budget" aria-hidden="true" />Angebot</span>
      </div>
      {!hasForecast ? <small>Prognose mangels belastbarer Basis nicht verfügbar</small> : null}
    </div>
  );
}

function ForecastSiteRow({
  isSelected,
  isTabStop,
  onSelectSite,
  scaleMinutes,
  site,
}: {
  isSelected: boolean;
  isTabStop: boolean;
  onSelectSite: (siteId: number) => void;
  scaleMinutes: number;
  site: PayrollSiteCockpitSite;
}) {
  const layout = buildPayrollSiteTrackLayout(site, scaleMinutes);
  const label = payrollSiteLabel(site);
  const forecastReason = site.forecast_reason || "Keine belastbare Prognose verfügbar";
  const forecastValue = site.forecast_minutes === null
    ? "–"
    : formatPayrollSiteMinutes(site.forecast_minutes);
  const forecastAccessibleLabel = site.forecast_minutes === null
    ? `nicht verfügbar: ${forecastReason}`
    : forecastValue;
  const actualVariance = site.offer_minutes === null ? null : site.actual_minutes - site.offer_minutes;

  function moveSelection(event: KeyboardEvent<HTMLButtonElement>): void {
    const list = event.currentTarget.closest('[role="listbox"]');
    const rows = list ? Array.from(list.querySelectorAll<HTMLButtonElement>(".payroll-site-forecast-row")) : [];
    const currentIndex = rows.indexOf(event.currentTarget);
    let targetIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") targetIndex = Math.min(rows.length - 1, currentIndex + 1);
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") targetIndex = Math.max(0, currentIndex - 1);
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = rows.length - 1;
    if (targetIndex === null || targetIndex === currentIndex || !rows[targetIndex]) {
      return;
    }
    event.preventDefault();
    rows[targetIndex].focus();
    const targetSiteId = Number(rows[targetIndex].dataset.siteId);
    if (Number.isInteger(targetSiteId)) onSelectSite(targetSiteId);
  }

  return (
    <button
      aria-label={`${label} auswählen. Angebot ${formatPayrollSiteMinutes(site.offer_minutes)}, Ist ${formatPayrollSiteMinutes(site.actual_minutes)}, Prognose ${forecastAccessibleLabel}`}
      aria-selected={isSelected}
      className={`payroll-site-forecast-row${isSelected ? " is-selected" : ""}`}
      data-site-id={site.site_id}
      onClick={() => onSelectSite(site.site_id)}
      onKeyDown={moveSelection}
      role="option"
      tabIndex={isTabStop ? 0 : -1}
      type="button"
    >
      <span className="payroll-site-row-name">
        <strong>{site.site_name}</strong>
        {site.site_number ? <small>{site.site_number}</small> : null}
      </span>
      <span className="payroll-site-budget-track" aria-hidden="true">
        {site.forecast_minutes !== null ? (
          <>
            <i
              className="payroll-site-track-segment is-forecast"
              style={{ left: `${layout.forecastWithinLeftPercent}%`, width: `${layout.forecastWithinPercent}%` }}
            />
            <i
              className="payroll-site-track-segment is-forecast-overrun"
              style={{ left: `${layout.forecastOverrunLeftPercent}%`, width: `${layout.forecastOverrunPercent}%` }}
            />
          </>
        ) : null}
        <i className="payroll-site-track-segment is-actual" style={{ width: `${layout.actualWithinPercent}%` }} />
        <i
          className="payroll-site-track-segment is-overrun"
          style={{ left: `${layout.actualOverrunLeftPercent}%`, width: `${layout.actualOverrunPercent}%` }}
        />
        {layout.budgetMarkerPercent !== null ? (
          <i className="payroll-site-budget-marker" style={{ left: `${layout.budgetMarkerPercent}%` }} />
        ) : null}
      </span>
      <dl className="payroll-site-row-values">
        <div><dt>Angebot</dt><dd>{formatPayrollSiteMinutes(site.offer_minutes)}</dd></div>
        <div><dt>Ist</dt><dd>{formatPayrollSiteMinutes(site.actual_minutes)}</dd></div>
        <div title={forecastReason}><dt>Prognose</dt><dd>{forecastValue}</dd></div>
        <div className={actualVariance !== null && actualVariance > 0 ? "is-danger" : ""}>
          <dt>Ist − Angebot</dt><dd>{formatPayrollSiteSignedMinutes(actualVariance)}</dd>
        </div>
      </dl>
    </button>
  );
}

function ActionPanel({
  actionItems,
  onSelectSite,
  selectedSiteId,
}: {
  actionItems: PayrollSiteActionItem[];
  onSelectSite: (siteId: number) => void;
  selectedSiteId: number | null;
}) {
  return (
    <aside className="payroll-site-action-panel" aria-labelledby="payroll-site-action-heading">
      <header className="payroll-site-panel-heading">
        <div>
          <h2 id="payroll-site-action-heading">Handlungsbedarf</h2>
          <p>Nach belastbarem Risiko priorisiert</p>
        </div>
      </header>
      {actionItems.length > 0 ? (
        <ol>
          {actionItems.map((item) => (
            <li className={`is-${item.risk_level}`} key={item.site_id}>
              <button
                aria-pressed={selectedSiteId === item.site_id}
                onClick={() => onSelectSite(item.site_id)}
                type="button"
              >
                <span className="payroll-site-action-rank" aria-hidden="true">{item.rank}</span>
                <span className="payroll-site-action-copy">
                  <strong>{item.site_name}</strong>
                  {item.site_number ? <small>{item.site_number}</small> : null}
                  <span>{item.reason}</span>
                </span>
                <ChevronRight aria-hidden="true" size={18} />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="payroll-site-empty-state is-compact">Kein akuter Handlungsbedarf aus den vorhandenen Daten.</div>
      )}
    </aside>
  );
}

function HistoryPanel({
  error,
  history,
  isLoading,
  onRetry,
  selectedSite,
}: {
  error: string | null;
  history: PayrollSiteHistory | null;
  isLoading: boolean;
  onRetry: () => void;
  selectedSite: PayrollSiteCockpitSite | null;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const chart = useMemo(
    () => history ? buildPayrollSiteHistoryChart(history.points, history.offer_minutes) : null,
    [history],
  );
  const hasForecastValues = chart?.forecastPath !== null && chart?.forecastPath !== undefined;

  return (
    <section className="payroll-site-history-panel" aria-labelledby="payroll-site-history-heading">
      <header className="payroll-site-panel-heading">
        <div>
          <h2 id="payroll-site-history-heading">Kumulativer Stundenverlauf</h2>
          <p>
            {selectedSite ? payrollSiteLabel(selectedSite) : "Baustelle auswählen"}
            {history ? ` · Angebot: aktive freigegebene Basis, Abruf ${formatGermanDateKey(history.offer_budget_as_of)}` : ""}
          </p>
        </div>
        <div className="payroll-site-legend" aria-label="Legende Stundenverlauf">
          <span><i className="is-actual-line" aria-hidden="true" />Ist</span>
          {chart?.forecastPath ? <span><i className="is-forecast-line" aria-hidden="true" />Prognose</span> : null}
          {chart?.offerY != null ? <span><i className="is-budget-line" aria-hidden="true" />Angebot</span> : null}
        </div>
      </header>
      {!selectedSite ? <div className="payroll-site-empty-state">Baustelle auswählen, um den Verlauf zu öffnen.</div> : null}
      {selectedSite && isLoading ? <div className="payroll-site-history-state" role="status">Stundenverlauf wird geladen...</div> : null}
      {selectedSite && !isLoading && error ? <CockpitError message={error} onRetry={onRetry} compact /> : null}
      {selectedSite && !isLoading && !error && history && chart && chart.points.length > 0 ? (
        <>
          <div className="payroll-site-chart-scroll">
            <svg
              className="payroll-site-history-chart"
              role="img"
              aria-labelledby={`${titleId} ${descriptionId}`}
              viewBox="0 0 920 260"
            >
              <title id={titleId}>Kumulierte Stunden für {payrollSiteLabel(selectedSite)}</title>
              <desc id={descriptionId}>
                Ist-Stunden bis {formatGermanDateKey(history.effective_as_of, "numeric")}
                {history.offer_minutes !== null ? ` bei ${formatPayrollSiteMinutes(history.offer_minutes)} Angebotsstunden` : " ohne hinterlegte Angebotsstunden"}.
              </desc>
              {chart.yTicks.map((tick) => (
                <g key={tick.value}>
                  <line className="payroll-site-chart-grid" x1="58" x2="902" y1={tick.position} y2={tick.position} />
                  <text className="payroll-site-chart-y-label" x="48" y={tick.position + 4}>{formatChartHours(tick.value)}</text>
                </g>
              ))}
              {chart.offerY !== null ? <line className="payroll-site-chart-budget" x1="58" x2="902" y1={chart.offerY} y2={chart.offerY} /> : null}
              {chart.forecastPath ? <path className="payroll-site-chart-forecast" d={chart.forecastPath} /> : null}
              <path className="payroll-site-chart-actual" d={chart.actualPath} />
              {chart.points.at(-1) ? (
                <circle className="payroll-site-chart-current-point" cx={chart.points.at(-1)?.x} cy={chart.points.at(-1)?.actualY} r="3.5" />
              ) : null}
              {chart.xTicks.map((tick) => (
                <text className="payroll-site-chart-x-label" key={tick.date} textAnchor="middle" x={tick.x} y="248">
                  {formatPayrollSiteChartDate(tick.date)}
                </text>
              ))}
            </svg>
          </div>
          <details className="payroll-site-history-values">
            <summary>Verlaufswerte anzeigen</summary>
            <div>
              <table>
                <thead><tr><th>Datum</th><th>Ist kumuliert</th>{hasForecastValues ? <th>Prognose</th> : null}</tr></thead>
                <tbody>
                  {history.points.map((point) => (
                    <tr key={point.date}>
                      <td>{formatGermanDateKey(point.date, "numeric")}</td>
                      <td>{formatPayrollSiteMinutes(point.actual_minutes)}</td>
                      {hasForecastValues ? <td>{formatPayrollSiteMinutes(point.forecast_minutes)}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : null}
      {selectedSite && !isLoading && !error && history && chart?.points.length === 0 ? (
        <div className="payroll-site-empty-state">Für diese Baustelle liegen noch keine Stunden für einen Verlauf vor.</div>
      ) : null}
    </section>
  );
}

function CockpitError({ message, onRetry, compact = false }: { message: string; onRetry: () => void; compact?: boolean }) {
  return (
    <div className={`payroll-site-error${compact ? " is-compact" : ""}`} role="alert">
      <span>{message}</span>
      <button onClick={onRetry} type="button">Erneut laden</button>
    </div>
  );
}

function formatChartHours(minutes: number): string {
  return `${Math.round(minutes / 60).toLocaleString("de-DE")} Std.`;
}
