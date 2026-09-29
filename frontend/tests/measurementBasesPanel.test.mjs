import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const source = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const panel = source.slice(source.indexOf("function MeasurementBasesPanel("), source.indexOf("type MeasurementEntryDraft ="));
const nameFormatter = source.slice(source.indexOf("function formatMeasurementBaseName("), source.indexOf("function normalizeSiteNotesInput("));
const css = readFileSync(new URL("../src/components/MeasurementBasesPanel.css", import.meta.url), "utf8");
// Render the real panel and name formatter extracted from the page.
const compiled = await build({
  stdin: { contents: `import React, {useMemo} from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {FileText, Trash2} from 'lucide-react';
    import {formatGermanDateTimeShort as formatDateTime} from './src/lib/formatters';
    ${nameFormatter}\n${panel}
    export const render = props => renderToStaticMarkup(React.createElement(MeasurementBasesPanel, props));`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic",
});
const compiledModule = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), compiledModule, compiledModule.exports);
const base = { id: 1, name: "Hauptauftrag", status: "draft", released_to_mobile: false, source_note: "8007 / P250092", item_count: 112, batch_count: 0, created_at: "2026-06-19T12:17:00" };
const active = { ...base, id: 2, name: "Aufmaß 8007.02", status: "active", released_to_mobile: true, item_count: 132, batch_count: 2, created_at: "2026-08-14T15:08:00" };
const render = (overrides = {}) => compiledModule.exports.render({ bases: [base, active], message: null, error: null, onUpdateBase() {}, onActivateBase() {}, onDeleteBase() {}, ...overrides });

test("timesheets display the released list first, then inactive lists with retained metadata", () => {
  const html = render();
  assert.match(html, /<h2>Zeitenlisten<\/h2>/);
  assert.ok(html.indexOf('aria-label="Aktuell für Monteure"') < html.indexOf('aria-label="Inaktive Zeitenlisten"'));
  assert.ok(html.indexOf('title="Aufmaß 8007.02"') < html.indexOf('title="Hauptauftrag"'));
  assert.match(html, /132 Positionen · Importiert am/);
  assert.match(html, /value="8007 \/ P250092"/);
  assert.match(html, /Für Monteure sichtbar/);
  assert.match(html, />Deaktivieren<\/button>/);
  assert.match(html, /class="primary-action"[^>]*>Aktivieren<\/button>/);
  assert.doesNotMatch(html, /Angebotsübersicht|Angebote verwalten/);
});

test("icon delete buttons retain accessible names and all deletion guards", () => {
  const html = render({ bases: [base, active, { ...base, id: 3, name: "Verwendete Liste", batch_count: 1 }, { ...base, id: 4, name: "Nicht freigegeben", status: "active" }] });
  assert.equal((html.match(/class="measurement-base-delete-action"/g) || []).length, 4);
  assert.equal((html.match(/aria-label="Zeitenliste [^"]+ löschen" disabled=""/g) || []).length, 3);
  assert.match(html, /aria-label="Zeitenliste Hauptauftrag löschen" title="Zeitenliste löschen"/);
  assert.match(panel, /onClick=\{\(\) => onDeleteBase\(base\)\}/);
});

test("release state, empty groups, and request messages are not confused with active status alone", () => {
  assert.match(render({ bases: [] }), /Noch keine Zeitenliste vorhanden/);
  assert.match(render({ bases: [base] }), /Aktuell ist keine Zeitenliste für Monteure freigegeben/);
  assert.match(render({ bases: [active] }), /Keine inaktiven Zeitenlisten/);
  assert.doesNotMatch(render({ bases: [{ ...active, released_to_mobile: false }] }), /Für Monteure sichtbar/);
  assert.match(render({ error: "Fehlgeschlagen", message: "Gespeichert" }), /Fehlgeschlagen/);
  assert.match(render({ error: "Fehlgeschlagen", message: "Gespeichert" }), /Gespeichert/);
});

test("editable identifiers and activation handlers remain wired; deactivation refreshes dependent views", () => {
  assert.match(panel, /onActivateBase\(base\)/);
  assert.match(panel, /onUpdateBase\(base, \{ status: "draft", released_to_mobile: false \}\)/);
  assert.match(panel, /onUpdateBase\(base, \{ source_note: nextValue \|\| null \}\)/);
  assert.match(panel, /event.key === "Escape"/);
  const update = source.slice(source.indexOf("  async function updateMeasurementBase("), source.indexOf("  async function activateMeasurementBase("));
  assert.match(update, /payload.status !== undefined \|\| payload.released_to_mobile !== undefined/);
  assert.match(update, /setMeasurementTimesheet\(await api.measurementTimesheet\(site.id\)\)/);
  assert.match(update, /setMeasurementBatchesLoaded\(false\)/);
});

test("long titles are escaped and layout rules stay scoped without touching import controls", () => {
  const name = '<script>Very long name & '.repeat(10);
  const html = render({ bases: [{ ...base, name }] });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 1000px\)/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.doesNotMatch(css, /measurement-import|project-record-subtabs/);
  assert.doesNotMatch(panel, /Zeitenliste importieren/);
});

test("timesheet content joins the existing toolbar without an inset frame or gutter", () => {
  assert.match(source, /activeSubtab === "bases" \? " is-measurement-bases-panel" : ""/);
  assert.match(css, /\.project-record-tab-panel\.is-measurement-bases-panel \{\s*gap: 0;\s*padding: 0;/);
  assert.match(css, /\.is-measurement-bases-panel > \.project-record-subtab-bar \{\s*width: 100%;\s*margin: 0;/);
  assert.match(css, /\.measurement-bases-panel \{\s*gap: 0;\s*border: 0;/);
});
