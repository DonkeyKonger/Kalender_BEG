import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

// Exercise the real helper and rendered React component, not a copy of their logic.
const compiled = await build({
  stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MeasurementReviewOverview } from './src/components/MeasurementReviewOverview';
    export { getMeasurementOverviewWindow, formatMeasurementCount, formatMeasurementOverviewHours } from './src/lib/measurementReviewOverview';
    export { EXTRA_WORK_OVERVIEW_DEFAULT_PAGE_SIZE } from './src/lib/extraWorkOverview';
    export const render = props => renderToStaticMarkup(React.createElement(MeasurementReviewOverview, props));
  `, resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external",
  jsx: "automatic", loader: { ".css": "empty" },
});
const compiledModule = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  createRequire(import.meta.url), compiledModule, compiledModule.exports,
);
const { getMeasurementOverviewWindow: windowFor, formatMeasurementCount, formatMeasurementOverviewHours, render } = compiledModule.exports;
const title = batch => `Aufmaß 9999.${batch.number}`;
const batches = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1, number: 25 - i, title: `Paket ${i + 1}`, status: "draft", origin: "MONTEUR",
  created_by_name: "Anna Büro", submitted_by_name: "Boris Monteur", submitted_at: "2026-08-26T19:07:00",
  measurement_date: null, entry_count: i === 0 ? 0 : 3, position_count: i === 0 ? 0 : 2,
  is_current_offer: i !== 2, has_original_worker_submission: i !== 0,
  customer_email_sent_at: null, customer_email_signature_present: null, customer_signed_at: null,
}));
const state = { selectedId: null, query: "", page: 1 };
const props = {
  site: { id: 7, name: "Testbaustelle Finienweg", customer: "ebm GmbH", site_number: "9999" },
  batches, state, onState() {}, loading: false, error: null, message: null, actionError: null,
  archive: false, busy: false, canCreate: true, onToggleArchive() {}, onRetry() {}, onCreate() {},
  canMarkInvoiced: true, onToggleInvoiced() { throw new Error("Rendering must not change invoiced state"); },
  onOpen() { throw new Error("Rendering must not open or mutate a batch"); },
  async onExport() { throw new Error("Rendering must not export"); },
  canExport: status => ["reviewed", "billed", "customer_signed"].includes(status),
  title, date: value => value.slice(0, 10), dateTime: value => value,
  renderStatus: batch => batch.status, renderActions: () => null,
};

test("initial rendered page uses the same compact row capacity as Zusatzaufträge", () => {
  const html = render(props);
  assert.equal((html.match(/class="measurement-overview-select"/g) ?? []).length,
    compiledModule.exports.EXTRA_WORK_OVERVIEW_DEFAULT_PAGE_SIZE);
});

test("search filters the whole server list before paging, including later pages", () => {
  const view = windowFor(batches, { ...state, query: "  pAKet 12  " }, 4, title);
  assert.equal(view.filtered.length, 1);
  assert.deepEqual(view.visible.map(batch => batch.id), [12]);
  assert.equal(view.selected.id, 12);
  assert.equal(view.page, 1);
  assert.equal(windowFor(batches, { ...state, query: "9999.14" }, 4, title).selected.id, 12);
});

test("page changes pick a real visible record; filtered totals and final partial page are correct", () => {
  const view = windowFor(batches.slice(0, 10), { ...state, page: 3 }, 4, title);
  assert.deepEqual(view.visible.map(batch => batch.id), [9, 10]);
  assert.equal(view.selected.id, 9);
  assert.equal(view.pageCount, 3);
  assert.equal(view.filtered.length, 10);
});

test("selection survives resize, sorting and editor return by stable ID, never by row index", () => {
  const chosen = { selectedId: 7, query: "", page: 2 };
  for (const [list, size] of [[batches, 4], [batches, 8], [[...batches].reverse(), 4]]) {
    const view = windowFor(list, chosen, size, title);
    assert.equal(view.selected.id, 7);
    assert.ok(view.visible.includes(view.selected));
  }
});

test("removal, empty searches and shrinking lists cannot leave stale detail data", () => {
  const view = windowFor(batches.slice(0, 3), { ...state, page: 3, selectedId: 12 }, 4, title);
  assert.equal(view.page, 1);
  assert.equal(view.selected.id, 1);
  assert.equal(windowFor(batches, { ...state, query: "missing" }, 4, title).selected, null);
  assert.equal(windowFor([], state, 4, title).selected, null);
});

test("counts distinguish unknown, zero, one and multiple server entries/positions", () => {
  assert.equal(formatMeasurementCount(null, "Zeile", "Zeilen"), "— Zeilen");
  assert.equal(formatMeasurementCount(undefined, "Zeile", "Zeilen"), "— Zeilen");
  assert.equal(formatMeasurementCount(0, "Zeile", "Zeilen"), "0 Zeilen");
  assert.equal(formatMeasurementCount(1, "Position", "Positionen"), "1 Position");
  assert.equal(formatMeasurementCount(3, "Position", "Positionen"), "3 Positionen");
});

test("hours preserve server totals, decimal strings, zero and negative corrections without inventing missing values", () => {
  for (const [value, expected] of [[12.5, "12,50 h"], ["1234.567", "1.234,57 h"], [0, "0,00 h"], [-1.25, "-1,25 h"], [null, "—"], [undefined, "—"], ["", "—"], [" ", "—"], ["invalid", "—"], [Infinity, "—"]]) {
    assert.equal(formatMeasurementOverviewHours(value), expected);
  }
});

test("Umfang renders calculated hours; details retain positions but omit redundant row count", () => {
  const html = render({ ...props, batches: [{ ...batches[0], entry_count: 18, position_count: 14, reported_minutes: 750, reported_hours: "12.5" }] });
  const table = html.match(/<table>[\s\S]*?<\/table>/)[0];
  assert.match(table, /12,50 h/);
  assert.doesNotMatch(table, /18 Zeilen|14 Positionen|750/);
  assert.doesNotMatch(html, /<dt>Zeilen<\/dt>/);
  assert.match(html, /<dt>Positionen<\/dt><dd>14/);
  const unknown = render({ ...props, batches: [{ ...batches[0], reported_hours: null }] });
  assert.match(unknown, /class="measurement-overview-hours"[^>]*>—<\/td>/);
});

test("independent invoiced checkbox is accessible and gated by permissions, pending work and archive", () => {
  const completed = { ...batches[0], status: "billed", is_invoiced: false };
  const checkbox = override => render({ ...props, batches: [completed], ...override }).match(/<input type="checkbox"[^>]*>/)[0];
  assert.doesNotMatch(checkbox({}), /checked|disabled/);
  assert.match(checkbox({}), /Als abgerechnet markieren/);
  const marked = checkbox({ batches: [{ ...completed, status: "draft", is_invoiced: true }] });
  assert.match(marked, /checked=""/);
  assert.match(marked, /Abrechnungsmarkierung entfernen/);
  for (const override of [{ canMarkInvoiced: false }, { busy: true }, { archive: true }]) {
    assert.match(checkbox(override), /disabled=""/);
  }
});

test("success announcements take no visible banner space while errors stay visible", () => {
  const html = render({ ...props, message: "Abgerechnet und abgeschlossen.", actionError: "Speichern fehlgeschlagen" });
  assert.match(html, /role="status" class="sr-only">Abgerechnet und abgeschlossen\./);
  assert.doesNotMatch(html, /project-record-empty-state is-success/);
  assert.match(html, /role="alert" class="project-record-empty-state is-error">Speichern fehlgeschlagen/);
  assert.match(html, /Als abgerechnet markieren und Aufmaß abschließen/);
});

test("delivery status follows commission number as the shared icon with accessible tooltip for every state", () => {
  for (const [override, stateClass, text, icon] of [
    [{}, "is-not-sent", "Noch nicht an Kunden gesendet", "mail-x"],
    [{ customer_email_sent_at: "2026-09-07T10:00:00Z" }, "is-signature-open", "Unterschrift fehlt", "mail-check"],
    [{ customer_email_sent_at: "2026-09-07T10:00:00Z", customer_email_signature_present: true }, "is-complete", "Unterschrift erhalten", "mail-check"],
  ]) {
    const html = render({ ...props, batches: [{ ...batches[0], ...override }] });
    const project = html.match(/<dl class="measurement-overview-project">([\s\S]*?)<\/dl>/)[1];
    assert.deepEqual([...project.matchAll(/<dt>(.*?)<\/dt>/g)].map(match => match[1]), ["Kunde", "Projekt", "Kom.-Nr.", "Versandstatus"]);
    assert.match(project, new RegExp(`project-extra-work-delivery-status ${stateClass}`));
    assert.match(project, new RegExp(`role="img" tabindex="0" aria-label="[^"]*${text}`));
    assert.match(project, /aria-describedby="measurement-delivery-status-1"/);
    assert.match(project, /id="measurement-delivery-status-1" role="tooltip"/);
    assert.match(project, new RegExp(`lucide-${icon}`));
    assert.doesNotMatch(html, /<h4>Versandstatus|measurement-overview-delivery/);
  }
});

test("rendered overview keeps table headers, creator and submitter distinct and shows old offers", () => {
  const html = render(props);
  for (const name of ["Status", "Titel / Nummer", "Datum", "Ersteller", "Umfang"]) assert.ok(html.includes(`<th scope="col">${name}</th>`));
  assert.match(html, /title="Anna Büro"/);
  assert.match(html, /<dt>Einreicher<\/dt><dd>Boris Monteur/);
  assert.doesNotMatch(html, /<dt>Zeilen<\/dt>/);
  assert.match(html, /<dt>Positionen<\/dt><dd>0/);
  assert.match(html, /Altes Angebot/);
  assert.match(html, /Noch nicht an Kunden gesendet/);
});

test("actual PDF availability remains gated; office origin never fabricates an original", () => {
  const draft = render({ ...props, batches: [{ ...batches[0], origin: "OFFICE" }] });
  assert.doesNotMatch(draft, /Originales Monteur-Aufmaß/);
  assert.match(draft, /disabled="" title="PDF-Export erst nach Prüfung/);
  const reviewed = render({ ...props, batches: [{ ...batches[1], status: "reviewed" }] });
  assert.match(reviewed, /Originales Monteur-Aufmaß/);
  assert.doesNotMatch(reviewed, /disabled="" title="(?:Geprüftes|Originales)/);
  const archived = render({ ...props, batches: [batches[1]], archive: true });
  assert.match(archived, /disabled="" title="Aufmaß vor dem Öffnen wiederherstellen/);
  assert.match(archived, /disabled="" title="Aufmaß vor dem PDF-Export wiederherstellen/);
  assert.doesNotMatch(archived, /Aufmaß anlegen/);
});

test("loading, errors and empty results never expose stale selected documents", () => {
  for (const override of [{ loading: true }, { error: "Testfehler" }, { state: { ...state, query: "missing" } }]) {
    const html = render({ ...props, ...override });
    assert.doesNotMatch(html, /<h3>|Originales Monteur-Aufmaß|<dt>Einreicher/);
  }
  assert.match(render({ ...props, error: "Testfehler" }), /Erneut laden/);
  assert.doesNotMatch(render({ ...props, canCreate: false }), /Aufmaß anlegen/);
});

test("scoped layout shares its divider and keeps rows natural inside independent scroll areas", () => {
  const css = readFileSync(new URL("../src/components/MeasurementReviewOverview.css", import.meta.url), "utf8");
  assert.match(css, /--measurement-overview-columns: minmax\(748px, 52%\) minmax\(0, 1fr\)/);
  assert.match(css, /\.measurement-overview-toolbar,\s*\.measurement-overview-workspace[^}]*grid-template-columns: var\(--measurement-overview-columns\)/);
  assert.match(css, /\.measurement-overview-list \{[^}]*overflow: auto/);
  assert.match(css, /\.measurement-overview-detail \{[^}]*overflow: auto/);
  assert.match(css, /\.measurement-overview-list td \{[^}]*height: 66px/);
  assert.match(css, /@container measurement-review \(max-width: 1279px\)/);
});
