import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { canEditMeasurementContent } from "../src/lib/measurementReviewContent.ts";

const item = { id: 1, position: "1.01", description: "Originaltext", unit: "m", sort_order: 1, is_free_position: false,
  entries: [{ id: 3, area_or_comment: "EG BTB", quantity: 34, status: "submitted" }] };
const batch = { status: "submitted", deleted_at: null, customer_signed_at: null, has_signed_snapshot: false };
const noop = () => {};
const source = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const compiled = await build({
  stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {MeasurementReviewTable} from './src/pages/SiteDetailPage';
    export const render = props => renderToStaticMarkup(React.createElement(MeasurementReviewTable, props));`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic", loader: { ".css": "empty" },
  define: { "import.meta.env.DEV": "false" },
  plugins: [{ name: "table-test", setup(build) {
    build.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: "empty" }));
    build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export default '';", loader: "js" }));
    build.onLoad({ filter: /SiteDetailPage\.tsx$/ }, () => ({ contents: source.replace("function MeasurementReviewTable(", "export function MeasurementReviewTable("), loader: "tsx" }));
    build.onLoad({ filter: /lib\/api\.ts$/ }, () => ({ contents: "export class ApiError extends Error{}; export const api={}; export const getApiBaseUrl=()=>''; export const getAccessToken=()=>null;", loader: "js" }));
  } }],
});
const result = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), result, result.exports);
const render = data => result.exports.render({ items: [item], positionSuggestions: [], freePositionOnly: false,
  canEditRows: true, reviewActionLoading: false, savingEntryId: null, onDraftSave: noop, onDraftReset: noop,
  onRenameArea: noop, onCellCreate: noop, onFreeItemCreate: noop, onFreeItemUpdate: noop, onFreeItemDelete: noop, ...data });

test("draft, submitted, reviewed and really signed are editable; completed and read-only roles never are", () => {
  for (const status of ["draft", "submitted", "reviewed", "customer_signed"]) {
    const data = { ...batch, status, customer_signed_at: status === "customer_signed" ? "2026-09-14" : null, has_signed_snapshot: true };
    assert.equal(canEditMeasurementContent(data, true), true);
    assert.equal(canEditMeasurementContent(data, false), false);
  }
  for (const status of ["billed", "approved", "closed", "completed", "finalized", "abgeschlossen", "archived"]) {
    assert.equal(canEditMeasurementContent({ ...batch, status }, true), false);
  }
  assert.equal(canEditMeasurementContent({ ...batch, deleted_at: "2026-09-14" }, true), false);
  assert.equal(canEditMeasurementContent({ ...batch, customer_signed_at: "2026-09-14" }, true), false);
});

test("real offer positions render all five editable fields, and all are disabled when completed", () => {
  for (const canEditRows of [true, false]) {
    const html = render({ canEditRows });
    for (const label of ["Positionsnummer für Originaltext", "Beschreibung für Position 1.01", "Einheit für Position 1.01", "Bauteil oder Ort", "Menge EG BTB für 1.01"]) {
      const tag = html.match(new RegExp(`<[^>]+aria-label="${label}"[^>]*>`))?.[0];
      assert.ok(tag, `Missing ${label}`);
      assert.equal(tag.includes('disabled=""'), !canEditRows, label);
    }
  }
});

test("all persisted columns have the same small centered delete control in both modes", () => {
  for (const freePositionOnly of [true, false]) {
    for (const canEditRows of [true, false]) {
      const html = render({ freePositionOnly, canEditRows });
      const button = html.match(/<button[^>]+aria-label="Position 1.01 löschen"[^>]*>[\s\S]*?<\/button>/)?.[0];
      assert.ok(button);
      assert.equal(button.includes('disabled=""'), !canEditRows);
      assert.match(button, /<svg[^>]+width="10"[^>]+height="10"/);
    }
  }
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = styles.match(/\.measurement-review-detail\.is-table-view \.measurement-free-position-delete\s*\{([^}]+)\}/)[1];
  for (const declaration of ["width: 16px", "height: 16px", "align-items: center", "justify-content: center"]) assert.ok(rule.includes(declaration));
});

test("all review descriptions reserve six lines, including new and completed positions", () => {
  for (const canEditRows of [true, false]) {
    for (const description of ["Kurz", "Lange Positionsbeschreibung ".repeat(30)]) {
      const textareas = render({ canEditRows, items: [{ ...item, description }] }).match(/<textarea\b[^>]*>/g);
      assert.ok(textareas.length >= 2, "Existing and new position descriptions must be present");
      for (const textarea of textareas) assert.match(textarea, /rows="6"/);
    }
  }
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = styles.match(/\.measurement-review-detail\.is-table-view textarea\.measurement-placeholder-header-input\s*\{([^}]+)\}/)[1];
  assert.match(rule, /height: calc\(6\.3em \+ 2px\)/);
  assert.match(rule, /overflow: auto/);
  assert.match(rule, /resize: none/);
});

test("review positions are about ten percent narrower and descriptions one pixel larger", () => {
  for (const canEditRows of [true, false]) {
    const html = render({ canEditRows });
    assert.match(html, /--measurement-position-width:121px/);
    assert.match(html, /--measurement-axis-width:216px/);
  }
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = styles.match(/\.measurement-review-detail\.is-table-view \.measurement-matrix-description-heading\s*\{([^}]+)\}/)[1];
  assert.match(rule, /font-size: calc\(0\.63rem \+ 1px\) !important/);
});

test("review axis stays at the scroll origin with independently painted cell borders", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const scope = ".measurement-review-detail.is-table-view";
  const rule = selector => styles.slice(styles.indexOf(`${selector} {`)).split("}")[0];
  const wrap = rule(`${scope} .measurement-review-table-wrap`);
  assert.match(wrap, /scrollbar-gutter: stable;/);
  assert.doesNotMatch(wrap, /both-edges/);
  const table = rule(`${scope} .measurement-review-table.measurement-table-view`);
  assert.match(table, /border-collapse: separate;/);
  assert.match(table, /border-spacing: 0;/);
  const axis = rule(`${scope} .measurement-review-table .measurement-matrix-axis`);
  assert.match(axis, /position: sticky;/);
  assert.match(axis, /left: 0;/);
  assert.match(axis, /box-shadow: 1px 0 0 #cbd5e1;/);
  const html = render();
  for (const label of ["Pos.-Nr.", "Beschreibung", "Einheit", "Bauteil / Ort", "Gesamt"]) {
    assert.ok(html.includes(`class="measurement-matrix-axis" scope="row">${label}</th>`));
  }
});

test("only description fields use normal font weight, including new and completed positions", () => {
  for (const canEditRows of [true, false]) {
    const textareas = render({ canEditRows }).match(/<textarea\b[^>]*>/g);
    assert.ok(textareas.length >= 2);
    for (const textarea of textareas) assert.match(textarea, /class="measurement-placeholder-header-input is-description"/);
  }
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const descriptionRule = styles.match(/\.measurement-review-detail\.is-table-view textarea\.measurement-placeholder-header-input\.is-description\s*\{([^}]+)\}/)[1];
  assert.match(descriptionRule, /font-weight: 400;/);
  const headerRule = styles.match(/\.measurement-review-detail\.is-table-view \.measurement-placeholder-header-input\s*\{([^}]+)\}/)[1];
  assert.match(headerRule, /font-weight: 800/);
});

test("description scrollbars are hidden without disabling scrolling or changing the six-line height", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const selector = ".measurement-review-detail.is-table-view textarea.measurement-placeholder-header-input";
  const rule = suffix => styles.slice(styles.indexOf(`${selector}${suffix} {`)).split("}")[0];
  assert.match(rule(""), /overflow: auto;/);
  assert.match(rule(""), /height: calc\(6\.3em \+ 2px\);/);
  assert.match(rule(".is-description"), /scrollbar-width: none;/);
  assert.match(rule(".is-description::-webkit-scrollbar"), /display: none;/);
});

test("review detail temporarily hides both navigation rows and uses available viewport height", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const scope = ".site-detail-page.is-measurement-review-workspace:has(.measurement-review-detail.is-table-view)";
  assert.ok(styles.includes(`${scope} > .project-record-tabs,\n${scope} > .project-record-tab-panel > .project-record-subtab-bar {\n  display: none;\n}`));
  assert.match(source, /if \(selectedBatch && !archiveMode\)/);
  assert.match(source, /onBackToBatchList=\{\(\) => \{\s*setSelectedMeasurementBatch\(null\)/);
  assert.match(styles, /max-height: var\(--measurement-review-available-height, calc\(100vh - 330px\)\)/);
  assert.match(source, /viewportHeight - node\.getBoundingClientRect\(\)\.top - 16/);
  assert.match(source, /observer\.observe\(workspace\)/);
  assert.match(source, /window\.removeEventListener\("resize", updateViewportColumns\)/);
});

test("the calendar displays only latest values in normal text, even after signing", () => {
  const changed = { ...item, position: "9.99", description: "Neuer Text", unit: "St", entries: [{ ...item.entries[0], quantity: 40.55 }] };
  const html = render({ items: [changed], canEditRows: canEditMeasurementContent({ ...batch, status: "customer_signed", customer_signed_at: "2026-09-14", has_signed_snapshot: true }, true) });
  assert.match(html, /40,55/);
  assert.match(html, /Neuer Text/);
  assert.doesNotMatch(html, /<del|measurement-correction|Originaltext|34,00/);
  assert.doesNotMatch(source, /signedSnapshot|measurement-original|measurement-correction|measurement-removed/);
});

test("renamed and deleted content disappears from the calendar; old content is PDF-only", () => {
  const moved = { ...item, entries: [{ ...item.entries[0], area_or_comment: "1. OG BTB", quantity: 40.55 }] };
  const html = render({ items: [moved] });
  assert.match(html, /1. OG BTB/);
  assert.doesNotMatch(html, /EG BTB|<del/);
  assert.doesNotMatch(render({ items: [] }), /Originaltext/);
});

test("persisted empty locations are editable without duplicating locations with quantities", () => {
  const html = render({ persistedAreas: [{ area_or_comment: "UG", sort_order: 1 }, { area_or_comment: "EG BTB", sort_order: 2 }] });
  assert.match(html, /value="UG"/);
  assert.equal((html.match(/value="EG BTB"/g) ?? []).length, 1);
});

test("equivalent imported units do not create corrections merely by focusing and leaving the field", () => {
  const html = render({ items: [{ ...item, unit: "M" }] });
  assert.match(html, /aria-label="Einheit für Position 1.01"[^>]*value="m"/);
  const saveText = source.slice(source.indexOf("async function saveFreeItemTextDraft"), source.indexOf("async function deleteFreeItem"));
  assert.match(saveText, /normalizeMeasurementUnitDisplay\(item.unit\)/);
  assert.match(saveText, /if \(nextValue === currentValue/);
});

test("the integration uses a single atomic area request and invalidates derived summaries", () => {
  assert.match(source, /api\.renameSiteMeasurementArea\(site.id, batch.id, previous, replacement\)/);
  assert.match(source, /await onRenameArea\(area.label, nextLabel\)/);
  assert.match(source, /invalidateMeasurementContentSummary\(\)/);
});
