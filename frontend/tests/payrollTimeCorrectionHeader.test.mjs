import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url),
  "utf8",
);

test("Arbeitszeit-Pruefung blendet nur die sichtbare Quellenueberschrift aus", () => {
  const tableStart = pageSource.indexOf('aria-label="Arbeitszeit-Diagnosewerte"');
  const tableEnd = pageSource.indexOf('aria-label="Ort-Diagnosewerte"');
  const tableSource = pageSource.slice(tableStart, tableEnd);

  assert.ok(tableStart >= 0);
  assert.ok(tableEnd > tableStart);
  assert.doesNotMatch(tableSource, /<span role="columnheader">Quelle<\/span>/);
  assert.match(tableSource, /<span role="columnheader" aria-label="Zeilenbezeichnung" \/>/);
  assert.match(tableSource, /<span role="columnheader">Pause<\/span>/);
  assert.match(pageSource, /<span>Lohnprüfung<\/span>\s*<h4 id="time-review-diagnostic-title">\{timeReviewDialogMode === "create" \? "Zeit manuell eintragen" : "Arbeitszeit manuell anpassen"\}<\/h4>/);
  assert.match(pageSource, /source: "Mobile Erfassung"[\s\S]*?source: "GPS-Erfassung"[\s\S]*?source: "Büroerfassung"/s);
  assert.match(pageSource, /source: "Büroerfassung",[\s\S]*?formatTimeEntryClock\(entry\.payroll_corrected_start_time\)[\s\S]*?formatTimeEntryClock\(entry\.payroll_corrected_end_time\)[\s\S]*?formatTimeEntryMinutes\(entry\.payroll_corrected_break_minutes, "minutes"\)[\s\S]*?formatTimeEntryMinutes\(effectivePayrollCorrectedWorkMinutes\(entry\), "hours"\)/s);
  assert.match(pageSource, /function formatTimeEntryClock[\s\S]*?if \(!value\) \{\s*return "-";/s);
  assert.match(pageSource, /function formatTimeEntryMinutes[\s\S]*?if \(typeof value !== "number" \|\| !Number\.isFinite\(value\)\) \{\s*return "-";/s);
  assert.match(tableSource, /Stunden Büro geprüft/);
  assert.match(tableSource, /Pause Büro geprüft in Minuten/);
  assert.match(tableSource, /updatePayrollTimeBasis\("break_minutes", event\.target\.value\)/);
  assert.match(pageSource, /payroll_corrected_break_minutes: breakMinutes/);
});
