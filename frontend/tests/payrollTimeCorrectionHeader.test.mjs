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
  assert.match(pageSource, /Eingetragene Monteursstunden/);
  assert.match(tableSource, /Stunden Büro geprüft/);
  assert.match(tableSource, /Pause Büro geprüft in Minuten/);
  assert.match(tableSource, /updatePayrollTimeBasis\("break_minutes", event\.target\.value\)/);
  assert.match(pageSource, /payroll_corrected_break_minutes: breakMinutes/);
});
