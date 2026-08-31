import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../src/components/PayrollSiteCockpit.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("Baustellenauswertung zeigt die realisierte Monatsleistung mit positivem und negativem Ergebnis", () => {
  assert.match(component, /Aufmaßstunden[\s\S]*?Zusatzaufträge[\s\S]*?Arbeitsstunden[\s\S]*?Ergebnis/s);
  assert.doesNotMatch(component, /Ist realisiert|Realisierte Ist-Stunden/);
  assert.match(component, /measurement_minutes[\s\S]*?supplementary_minutes[\s\S]*?performance_minutes[\s\S]*?realized_actual_minutes[\s\S]*?result_minutes/s);
  assert.match(component, /is-\$\{site\.result_tone\}/);
  assert.match(styles, /\.payroll-site-realization-row\.is-positive[\s\S]*#16a34a/);
  assert.match(styles, /\.payroll-site-realization-row\.is-negative[\s\S]*#dc2626/);
});

test("die Erklärung macht Realisierungsereignis, offene Werte und Formel nachvollziehbar", () => {
  assert.match(component, /So wird berechnet/);
  assert.match(component, /Aufmaß-Einreichung ist das Realisierungsereignis/);
  assert.match(component, /noch nicht realisierten Monteurstunden/);
  assert.match(component, /Zusatzaufträge zählen nur als abgerechnet/);
  assert.match(component, /Monteurstunden dieser Baustelle werden in ihrem Einreichungsmonat als Arbeitsstunden zugeordnet/);
  assert.match(component, /Ergebnis = Aufmaßstunden \+ Zusatzauftragsstunden − Arbeitsstunden/);
});

test("die Baustellenansicht lädt nur die Monatsaggregation und keinen alten Verlauf", () => {
  assert.match(page, /activeEvaluationSubtab !== "sites"[\s\S]*?api\.payrollSiteCockpit\(/s);
  assert.doesNotMatch(page, /payrollSiteHistoryView|selectedEvaluationSiteId/);
});
