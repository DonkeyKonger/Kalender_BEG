import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildPayrollSiteActionItems,
  buildPayrollSiteHistoryChart,
  buildPayrollSiteTrackLayout,
  formatPayrollSiteChartDate,
  formatPayrollSiteMinutes,
  formatPayrollSiteSignedMinutes,
  payrollSitePortfolioScale,
  resolvePayrollSiteActionItems,
  resolvePayrollSiteHistoryView,
  roundPayrollSiteMinutes,
  selectPayrollSiteId,
} from "../src/lib/payrollSiteCockpit.ts";

const [componentSource, pageSource, apiSource, styles] = await Promise.all([
  readFile(new URL("../src/components/PayrollSiteCockpit.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

function site(overrides = {}) {
  return {
    site_id: 1,
    site_number: "1001",
    site_name: "Nord",
    offer_minutes: 500,
    actual_minutes: 400,
    forecast_minutes: null,
    forecast_reason: "Keine belastbare Fortschrittsbasis",
    variance_minutes: null,
    utilization_percent: 80,
    risk_level: "none",
    risk_reason: null,
    ...overrides,
  };
}

function cockpit(overrides = {}) {
  return {
    date_from: "2026-08-01",
    date_to: "2026-08-31",
    effective_as_of: "2026-08-30",
    offer_budget_basis: "current_active_released_measurement_base",
    offer_budget_as_of: "2026-08-30",
    totals: {
      offer_minutes: null,
      actual_minutes: 1000,
      forecast_minutes: null,
      forecast_reason: "Keine belastbare Fortschrittsbasis",
      variance_minutes: null,
      site_count: 2,
      budget_site_count: 1,
      forecast_site_count: 0,
    },
    sites: [site(), site({ site_id: 2, site_name: "Süd" })],
    action_items: [],
    ...overrides,
  };
}

test("Budgetspuren verwenden eine gemeinsame Portfolio-Skala", () => {
  const sites = [
    site({ site_id: 1, offer_minutes: 500, actual_minutes: 600 }),
    site({ site_id: 2, offer_minutes: 1000, actual_minutes: 250 }),
  ];
  const scale = payrollSitePortfolioScale(sites);
  const first = buildPayrollSiteTrackLayout(sites[0], scale);
  const second = buildPayrollSiteTrackLayout(sites[1], scale);

  assert.equal(scale, 1000);
  assert.equal(first.budgetMarkerPercent, 50);
  assert.equal(second.budgetMarkerPercent, 100);
  assert.equal(first.actualWithinPercent, 50);
  assert.equal(first.actualOverrunLeftPercent, 50);
  assert.equal(first.actualOverrunPercent, 10);
});

test("Prognosesegmente erscheinen nur bei einer vorhandenen Prognose", () => {
  const unavailable = buildPayrollSiteTrackLayout(site({ forecast_minutes: null }), 1000);
  const available = buildPayrollSiteTrackLayout(site({ actual_minutes: 200, offer_minutes: 300, forecast_minutes: 400 }), 1000);

  assert.equal(unavailable.forecastWithinPercent, 0);
  assert.equal(unavailable.forecastOverrunPercent, 0);
  assert.equal(available.forecastWithinLeftPercent, 20);
  assert.equal(available.forecastWithinPercent, 10);
  assert.equal(available.forecastOverrunLeftPercent, 30);
  assert.equal(available.forecastOverrunPercent, 10);
});

test("Handlungsbedarf bevorzugt die Backend-Priorisierung und fällt deterministisch zurück", () => {
  const serverItems = [
    { rank: 2, site_id: 2, site_number: null, site_name: "Süd", risk_level: "warning", reason: "Beobachten", variance_minutes: null, utilization_percent: 90 },
    { rank: 1, site_id: 1, site_number: null, site_name: "Nord", risk_level: "critical", reason: "Überzogen", variance_minutes: 100, utilization_percent: 120 },
  ];
  assert.deepEqual(resolvePayrollSiteActionItems(cockpit({ action_items: serverItems })).map((item) => item.site_id), [1, 2]);

  const fallback = buildPayrollSiteActionItems([
    site({ site_id: 2, site_name: "Fehlend", offer_minutes: null, risk_level: "missing_data" }),
    site({ site_id: 1, actual_minutes: 650, offer_minutes: 500, risk_level: "critical" }),
  ]);
  assert.deepEqual(fallback.map((item) => item.site_id), [1, 2]);
  assert.match(fallback[0].reason, /^Ist liegt/);
  assert.doesNotMatch(fallback[0].reason, /Voraussichtlich/);
});

test("Baustellenauswahl bleibt stabil und fällt auf das höchste Risiko zurück", () => {
  const sites = [site({ site_id: 1 }), site({ site_id: 2 })];
  const risks = [{ rank: 1, site_id: 2, site_number: null, site_name: "Süd", risk_level: "critical", reason: "Überzogen", variance_minutes: 100, utilization_percent: 120 }];

  assert.equal(selectPayrollSiteId(1, sites, risks), 1);
  assert.equal(selectPayrollSiteId(99, sites, risks), 2);
  assert.equal(selectPayrollSiteId(null, [], []), null);
});

test("Verlauf berechnet sortierte Ist-, Angebots- und optionale Prognosepfade", () => {
  const chart = buildPayrollSiteHistoryChart([
    { date: "2026-02-01", actual_minutes: 180, forecast_minutes: null },
    { date: "2026-01-01", actual_minutes: 60, forecast_minutes: null },
  ], 300, { width: 400, height: 200, left: 40, right: 10, top: 10, bottom: 30 });

  assert.equal(chart.points[0].date, "2026-01-01");
  assert.match(chart.actualPath, /^M /);
  assert.match(chart.actualPath, / L /);
  assert.equal(chart.forecastPath, null);
  assert.equal(typeof chart.offerY, "number");
  assert.ok(chart.yTicks.length >= 2);
});

test("Zeitachsenlabels unterscheiden tägliche Punkte durch Tag, Monat und zweistelliges Jahr", () => {
  assert.equal(formatPayrollSiteChartDate("2026-08-01"), "01.08.26");
  assert.equal(formatPayrollSiteChartDate("2026-08-18"), "18.08.26");
});

test("Cockpit rundet dezimale Minuten kaufmännisch auf ganze Minuten", () => {
  assert.equal(roundPayrollSiteMinutes(67.5), 68);
  assert.equal(roundPayrollSiteMinutes(-67.5), -68);
  assert.equal(formatPayrollSiteMinutes(67.5), "1 Std. 8 Min.");
  assert.equal(formatPayrollSiteMinutes(750.75), "12 Std. 31 Min.");
  assert.equal(formatPayrollSiteSignedMinutes(-67.5), "−1 Std. 8 Min.");
  assert.doesNotMatch(formatPayrollSiteMinutes(750.75), /30\.75/);
});

test("Baustellenwechsel blendet alte Historie und alte Fehler bis zum passenden Request aus", () => {
  const oldHistory = {
    site_id: 1,
    site_number: "1001",
    site_name: "Nord",
    date_from: "2026-08-01",
    date_to: "2026-08-31",
    effective_as_of: "2026-08-30",
    offer_budget_basis: "current_active_released_measurement_base",
    offer_budget_as_of: "2026-08-30",
    offer_minutes: 500,
    forecast_minutes: null,
    forecast_reason: "Nicht verfügbar",
    points: [],
  };
  const staleView = resolvePayrollSiteHistoryView({
    error: "Alter Fehler von Nord",
    history: oldHistory,
    isLoading: false,
    requestKey: "1:2026-08-31",
    selectedRequestKey: "2:2026-08-31",
    selectedSiteId: 2,
  });

  assert.deepEqual(staleView, { error: null, history: null, isLoading: true });
  assert.equal(resolvePayrollSiteHistoryView({
    error: null,
    history: oldHistory,
    isLoading: false,
    requestKey: "1:2026-08-31",
    selectedRequestKey: "1:2026-08-31",
    selectedSiteId: 1,
  }).history, oldHistory);
});

test("Baustellen-Tab lädt nur Aggregate und Historie, keine GPS- oder Abwesenheitsdetails", () => {
  assert.match(apiSource, /payrollSiteCockpit[\s\S]*?\/time-entries\/payroll-site-cockpit\?/);
  assert.match(apiSource, /payrollSiteHistory[\s\S]*?\/time-entries\/payroll-site-cockpit\/\$\{encodeURIComponent/);
  assert.match(pageSource, /activeEvaluationSubtab !== "workers"[\s\S]*?api\.timeEntries\(/s);
  assert.match(pageSource, /activeEvaluationSubtab !== "sites"[\s\S]*?api\.payrollSiteCockpit\(/s);
  assert.match(pageSource, /needsDetailedEntries[\s\S]*?activeEvaluationSubtab === "workers"[\s\S]*?api\.absences\(/s);
  assert.match(pageSource, /includeGpsStatus: true/);
  assert.doesNotMatch(componentSource, /api\.timeEntries|includeGpsStatus|api\.absences/);
});

test("Cockpit rendert fehlende Prognosen ehrlich und bleibt per Tastatur auswählbar", () => {
  assert.match(componentSource, /Prognose mangels belastbarer Basis nicht verfügbar/);
  assert.match(componentSource, /site\.forecast_minutes !== null/);
  assert.match(componentSource, /role="listbox"/);
  assert.match(componentSource, /role="option"/);
  assert.match(componentSource, /ArrowDown[\s\S]*ArrowRight[\s\S]*ArrowUp[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/s);
  assert.match(componentSource, /tabIndex=\{isTabStop \? 0 : -1\}/);
  assert.match(componentSource, /<dt>Ist − Angebot<\/dt>/);
  assert.match(componentSource, /<details className="payroll-site-history-values">/);
  assert.match(componentSource, /aktive freigegebene Basis, Abruf/);
  assert.doesNotMatch(componentSource, /formatVerboseMinutes/);
});

test("Forecast-Zeilen halten fehlende Prognosen sichtbar knapp und zugänglich vollständig", () => {
  assert.match(componentSource, /const forecastValue = site\.forecast_minutes === null\s*\? "–"/);
  assert.match(componentSource, /const forecastAccessibleLabel = site\.forecast_minutes === null[\s\S]*nicht verfügbar: \$\{forecastReason\}/);
  assert.match(componentSource, /aria-label=\{`\$\{label\} auswählen\.[\s\S]*Prognose \$\{forecastAccessibleLabel\}`\}/);
  assert.match(componentSource, /<div title=\{forecastReason\}><dt>Prognose<\/dt><dd>\{forecastValue\}<\/dd><\/div>/);
});

test("Angebots-KPI zeigt eine kurze Basiszeile mit vollständiger zugänglicher Semantik", () => {
  assert.match(componentSource, /Budgets · aktuelle Basis \(\$\{formatGermanDateKey\(data\.offer_budget_as_of\)\}\)/);
  assert.match(componentSource, /aktuell aktiven und für Monteure freigegebenen Angebotsbasis/);
  assert.match(componentSource, /<small aria-label=\{noteDetail\} title=\{noteDetail\}>\{note\}<\/small>/);
});

test("Cockpit bleibt auf breiten und schmalen Flächen scanbar", () => {
  assert.match(styles, /\.payroll-site-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /\.payroll-site-cockpit-overview\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(270px, 320px\)/s);
  assert.match(styles, /@container payroll-site-cockpit \(max-width: 920px\)[\s\S]*?\.payroll-site-metrics\s*\{[^}]*repeat\(2,/s);
  assert.match(styles, /@container payroll-site-cockpit \(max-width: 620px\)[\s\S]*?grid-template-areas:\s*"name" "track" "values"/s);
  assert.match(styles, /\.payroll-site-forecast-row:focus-visible[\s\S]*?outline:/s);
  assert.match(styles, /\.payroll-site-track-segment\.is-overrun\s*\{[^}]*background:\s*var\(--payroll-site-danger\)/s);
});
