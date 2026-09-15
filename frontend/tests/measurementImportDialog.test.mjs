import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("new measurement imports default to Hauptauftrag on initial render and every new file", () => {
  assert.match(page, /const MEASUREMENT_IMPORT_DEFAULT_NAME = "Hauptauftrag"/);
  assert.match(page, /useState\(MEASUREMENT_IMPORT_DEFAULT_NAME\)/);
  assert.match(page, /function openImportDialog[\s\S]*?setNewBaseName\(MEASUREMENT_IMPORT_DEFAULT_NAME\)/);
  assert.doesNotMatch(page, /getSuggestedMeasurementSheetName/);
  assert.match(page, /onChange=\{\(event\) => setNewBaseName\(event.target.value\)\}/);
  assert.match(page, /measurementBaseName: importMode === "create_new" \? newBaseName : null/);
  assert.match(page, /onChange=\{\(\) => setImportMode\("create_new"\)\}/);
});

test("import dialog constrains intrinsic grid widths and retains vertical scrolling", () => {
  assert.match(css, /\.measurement-import-modal \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.measurement-import-modal \{[^}]*grid-auto-rows: max-content/);
  assert.match(css, /\.measurement-import-modal \{[^}]*max-height: calc\(100dvh - 48px\)/);
  assert.match(css, /\.measurement-import-modal \{[^}]*overflow-y: auto/);
  assert.match(css, /\.measurement-import-modal-options \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.measurement-import-file-row span \{[^}]*min-width: 0/);
  assert.match(page, /<span title=\{pendingFile.name\}>\{pendingFile.name\}<\/span>/);
});
