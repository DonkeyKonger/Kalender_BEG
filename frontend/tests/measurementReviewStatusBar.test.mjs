import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { getMeasurementReviewSteps } from "../src/lib/measurementReviewSteps.ts";

const compiled = await build({
  stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MeasurementReviewStatusBar } from './src/components/MeasurementReviewStatusBar';
    export const tree = props => MeasurementReviewStatusBar(props);
    export const render = props => renderToStaticMarkup(React.createElement(MeasurementReviewStatusBar, props));
  `, resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external",
  jsx: "automatic", loader: { ".css": "empty" },
});
const result = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), result, result.exports);
const { tree, render } = result.exports;
const batch = { id: 7, origin: "MONTEUR", status: "submitted", submitted_at: "2026-09-11T12:00:00Z", customer_signed_at: null, customer_signature_name: null };
const props = { batch, busy: false, isBilled: false, canReview: true, onMarkOpen() {}, onMarkReviewed() {}, onMarkBilled() {} };
const states = data => getMeasurementReviewSteps(data).map(step => step.state);
function buttons(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(buttons);
  return [...(node.type === "button" ? [node.props] : []), ...buttons(node.props?.children)];
}

test("workflow follows the stored status and independent evidence, never inferred signatures or review", () => {
  assert.deepEqual(states(batch), ["current", "pending", "pending", "pending"]);
  assert.deepEqual(states({ ...batch, status: "reviewed" }), ["reached", "current", "pending", "pending"]);
  assert.deepEqual(states({ ...batch, status: "customer_signed", customer_signed_at: "2026-09-12" }), ["reached", "pending", "current", "pending"]);
  assert.deepEqual(states({ ...batch, status: "billed" }), ["reached", "pending", "pending", "current"]);
  assert.deepEqual(states({ ...batch, status: "billed", customer_signed_at: "2026-09-12" }), ["reached", "pending", "reached", "current"]);
  assert.deepEqual(states({ ...batch, status: "draft", submitted_at: null }), ["pending", "pending", "pending", "pending"]);
  assert.deepEqual(states({ ...batch, status: "unknown", submitted_at: null }), ["pending", "pending", "pending", "pending"]);
  assert.deepEqual(states({ ...batch, status: "customer_signed", submitted_at: null }), ["pending", "pending", "pending", "pending"]);
  // Reopening retains a real signature, but the stored status is Eingereicht again.
  assert.deepEqual(states({ ...batch, customer_signed_at: "2026-09-12" }), ["current", "pending", "reached", "pending"]);
});

test("rendered steps are informative, ordered and identify exactly the current step", () => {
  for (const [status, label] of [["submitted", "Eingereicht"], ["reviewed", "Geprüft"], ["customer_signed", "Unterschrieben"], ["billed", "Abgeschlossen"]]) {
    const html = render({ ...props, batch: { ...batch, status, customer_signed_at: status === "customer_signed" ? "2026-09-12" : null } });
    assert.match(html, /<ol[^>]+aria-label="Prüfstatus"/);
    assert.equal((html.match(/aria-current="step"/g) ?? []).length, 1);
    assert.match(html, new RegExp(`aria-current="step"[\\s\\S]*?<span>${label}</span>`));
    assert.doesNotMatch(html, /Undo|Monteurstand zurücksetzen|Wieder auf Eingereicht setzen/);
    assert.equal((html.match(/<li/g) ?? []).length, 4);
  }
});

test("reset invokes only the original onMarkOpen with the selected batch, not a data reset", () => {
  const selected = { ...batch, id: 21, status: "billed" };
  const calls = [];
  const actions = buttons(tree({ ...props, batch: selected, isBilled: true,
    onMarkOpen: value => calls.push(value),
    onMarkBilled() { assert.fail("Wrong handler"); }, onMarkReviewed() { assert.fail("Wrong handler"); },
  }));
  assert.equal(actions.length, 1);
  actions[0].onClick();
  assert.deepEqual(calls, [selected]);
  const html = render({ ...props, batch: selected, isBilled: true });
  assert.match(html, /Status zurücksetzen/);
  assert.doesNotMatch(html, /Prüfung abschließen|Aufmaß abschließen/);
  assert.equal(buttons(tree({ ...props, isBilled: true, busy: true }))[0].disabled, true);
});

test("existing review and completion actions retain callbacks, conditions and loading locks", () => {
  const calls = [];
  const actions = buttons(tree({ ...props, onMarkReviewed: value => calls.push(["review", value]), onMarkBilled: value => calls.push(["complete", value]) }));
  actions.forEach(action => action.onClick());
  assert.deepEqual(calls, [["review", batch], ["complete", batch]]);
  assert.equal(buttons(tree({ ...props, canReview: false })).length, 1);
  assert.ok(buttons(tree({ ...props, busy: true })).every(button => button.disabled));
  const office = render({ ...props, batch: { ...batch, origin: "OFFICE" }, canReview: false });
  assert.doesNotMatch(office, /<ol|Prüfung abschließen/);
  assert.match(office, /Aufmaß abschließen/);
});

test("page keeps the mark-open API binding, removes only obsolete UI wiring and preserves error handling", () => {
  const page = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  assert.match(page, /onMarkOpen=\{\(batch\) => void setMeasurementBatchBillingStatus\(batch, "submitted"\)\}/);
  assert.match(page, /onMarkOpen=\{onMarkOpen\} onMarkReviewed=\{onMarkReviewed\} onMarkBilled=\{onMarkBilled\}/);
  assert.match(page, /await api\.markSiteMeasurementBatchOpen\(site\.id, batch\.id\)/);
  assert.match(page, /setMeasurementReviewError\(readApiError\(requestError, "Abschlussstatus konnte nicht gespeichert werden\."\)\)/);
  assert.doesNotMatch(page, /undoLastEntryChange|resetMeasurementBatchToSubmitted|onResetToSubmitted/);
  assert.match(api, /measurement-batches\/\$\{batchId\}\/mark-open/);
  assert.match(api, /measurement-batches\/\$\{batchId\}\/reset-to-submitted/);
});
