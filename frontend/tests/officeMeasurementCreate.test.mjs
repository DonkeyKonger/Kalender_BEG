import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("desktop measurement creation uses the protected shared measurement endpoint", () => {
  assert.match(apiSource, /createOfficeMeasurementBatch/);
  assert.match(apiSource, /`\/sites\/\$\{siteId\}\/measurement-batches`/);
  assert.match(apiSource, /siteMeasurementWorkers/);
  assert.match(apiSource, /`\/sites\/\$\{siteId\}\/measurement-workers`/);
});

test("measurement review exposes the office dialog and reuses the controlled picker", () => {
  assert.match(pageSource, /<Plus aria-hidden="true" size=\{15\} \/>\s*Aufmaß anlegen/);
  assert.match(pageSource, /Bereich\/Ort \*/);
  assert.match(pageSource, /Aufmaßdatum \*/);
  assert.match(pageSource, /Verantwortlicher Monteur/);
  assert.match(pageSource, /<DashboardNotePicker/);
  assert.match(pageSource, /setCreateMeasurementDate\(toLocalDateKey\(new Date\(\)\)\)/);
  assert.match(pageSource, /await selectMeasurementBatch\(created\)/);
  assert.doesNotMatch(pageSource, /Angebotsgrundlage auswählen/);
  assert.doesNotMatch(pageSource, /Das Aufmaß wird als Blanko-Aufmaß ohne Angebotspositionen angelegt\./);
});

test("office measurements reuse the standard measurement table without a blank-mode branch", () => {
  assert.match(pageSource, /<MeasurementReviewTable\s+items=\{itemsWithEntries\}/);
  assert.match(pageSource, /const displayColumnCount = Math\.max\(MEASUREMENT_TABLE_MIN_COLUMNS/);
  assert.match(pageSource, />Pos\.-Nr\.<\/th>/);
  assert.match(pageSource, />Beschreibung<\/th>/);
  assert.match(pageSource, />Einheit<\/th>/);
  assert.match(pageSource, />Bauteil \/ Ort<\/th>/);
  assert.doesNotMatch(pageSource, /isBlankMode/);
  assert.doesNotMatch(pageSource, /Noch keine Positionen in diesem Blanko-Aufmaß\./);
  assert.doesNotMatch(apiSource, /deleteSiteMeasurementFreeItem/);
  assert.doesNotMatch(styles, /\.measurement-blank-/);
});

test("office origin does not create a special presentation and never offers a fake worker original", () => {
  assert.doesNotMatch(pageSource, /Dieses Aufmaß wurde im Büro angelegt und nicht durch einen Monteur eingereicht\./);
  assert.match(pageSource, /batch\.has_original_worker_submission \? \(/);
  assert.doesNotMatch(styles, /\.measurement-review-origin-note/);
  assert.match(styles, /\.measurement-create-modal\s*\{[^}]*border-radius:\s*0/s);
});
