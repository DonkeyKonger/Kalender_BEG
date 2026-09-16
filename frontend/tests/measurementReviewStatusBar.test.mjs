import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test, { beforeEach, afterEach } from "node:test";
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
const props = { batch, busy: false, isBilled: false, canReview: true, onRollbackStatus() {}, onMarkReviewed() {}, onMarkBilled() {} };
const states = data => getMeasurementReviewSteps(data).map(step => step.state);
function buttons(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(buttons);
  return [...(node.type === "button" ? [node.props] : []), ...buttons(node.props?.children)];
}
const rollbackButtons = data => buttons(tree(data)).filter(button => button.className.includes("is-rollback"));
const originalWindow = globalThis.window;
beforeEach(() => { globalThis.window = { confirm: () => true }; });
afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

test("rollback asks for confirmation with the target and cancellation changes nothing", () => {
  const selected = { ...batch, status: "billed", previous_status: "reviewed", status_revision: 2 };
  const calls = [], messages = [];
  let confirmed = false;
  globalThis.window.confirm = message => { messages.push(message); return confirmed; };
  const action = rollbackButtons({ ...props, batch: selected, onRollbackStatus: value => calls.push(value) })[0];
  action.onClick();
  assert.deepEqual(calls, []);
  assert.match(messages[0], /wirklich auf „Geprüft“ zurücksetzen/);
  assert.match(messages[0], /Mengen und Positionen bleiben erhalten/);
  confirmed = true;
  action.onClick();
  assert.deepEqual(calls, [selected]);
});

test("fallback is explained before confirmation and busy actions do not open a dialog", () => {
  const selected = { ...batch, status: "billed", previous_status: "submitted", status_rollback_is_fallback: true };
  const messages = [];
  globalThis.window.confirm = message => { messages.push(message); return false; };
  rollbackButtons({ ...props, batch: selected })[0].onClick();
  assert.match(messages[0], /„Eingereicht“/);
  assert.match(messages[0], /keine verlässliche Statushistorie/);
  rollbackButtons({ ...props, batch: selected, busy: true })[0].onClick();
  assert.equal(messages.length, 1);
});

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

test("reset invokes only the original onRollbackStatus with the selected batch, not a data reset", () => {
  const selected = { ...batch, id: 21, status: "billed", previous_status: "reviewed", status_revision: 2 };
  const calls = [];
  const actions = buttons(tree({ ...props, batch: selected, isBilled: true,
    onRollbackStatus: value => calls.push(value),
    onMarkBilled() { assert.fail("Wrong handler"); }, onMarkReviewed() { assert.fail("Wrong handler"); },
  }));
  assert.equal(actions.length, 1);
  actions[0].onClick();
  assert.deepEqual(calls, [selected]);
  const html = render({ ...props, batch: selected, isBilled: true });
  assert.match(html, /aria-label="Auf Geprüft zurücksetzen"/);
  assert.doesNotMatch(html, /Status zurücksetzen/);
  assert.doesNotMatch(html, /Prüfung abschließen|Aufmaß abschließen/);
  assert.equal(rollbackButtons({ ...props, batch: selected, isBilled: true, busy: true })[0].disabled, true);
});

test("existing review and completion actions retain callbacks, conditions and loading locks", () => {
  const calls = [];
  const actions = buttons(tree({ ...props, onMarkReviewed: value => calls.push(["review", value]), onMarkBilled: value => calls.push(["complete", value]) }));
  actions.slice(0, 2).forEach(action => action.onClick());
  assert.deepEqual(calls, [["review", batch], ["complete", batch]]);
  assert.equal(buttons(tree({ ...props, canReview: false })).length, 1);
  assert.ok(buttons(tree({ ...props, busy: true })).every(button => button.disabled));
  const office = render({ ...props, batch: { ...batch, origin: "OFFICE" }, canReview: false });
  assert.doesNotMatch(office, /Prüfung abschließen/);
  assert.match(office, /<ol/);
  assert.match(office, /Aufmaß abschließen/);
});

test("page uses revision-guarded rollback instead of mark-open and preserves error handling", () => {
  const page = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  assert.match(page, /onRollbackStatus=\{\(batch\) => void setMeasurementBatchBillingStatus\(batch, "previous"\)\}/);
  assert.match(page, /onRollbackStatus=\{onRollbackStatus\} onMarkReviewed=\{onMarkReviewed\} onMarkBilled=\{onMarkBilled\}/);
  assert.match(page, /await api\.rollbackSiteMeasurementBatchStatus\(site\.id, batch\.id, batch\.status_revision \?\? 0\)/);
  assert.doesNotMatch(page, /api\.markSiteMeasurementBatchOpen/);
  assert.match(page, /setMeasurementReviewError\(readApiError\(requestError, "Abschlussstatus konnte nicht gespeichert werden\."\)\)/);
  assert.doesNotMatch(page, /undoLastEntryChange|resetMeasurementBatchToSubmitted|onResetToSubmitted/);
  assert.match(api, /measurement-batches\/\$\{batchId\}\/mark-open/);
  assert.match(api, /measurement-batches\/\$\{batchId\}\/rollback-status/);
  assert.match(api, /measurement-batches\/\$\{batchId\}\/reset-to-submitted/);
});

test("reset uses only server-provided predecessors, including legacy fallbacks", () => {
  for (const status of ["submitted", "reviewed", "customer_signed", "billed"]) {
    const data = { ...batch, status, previous_status: "submitted" };
    const reset = rollbackButtons({ ...props, batch: data, isBilled: status === "billed" })[0];
    assert.equal(reset.disabled, false);
  }
  assert.equal(rollbackButtons(props).length, 0);
  for (const status of ["draft", "reviewed", "customer_signed", "billed"]) {
    for (const previous_status of ["submitted"]) {
      const data = { ...batch, status, previous_status, status_rollback_is_fallback: true };
      const calls = [];
      const reset = rollbackButtons({ ...props, batch: data, onRollbackStatus: value => calls.push(value) })[0];
      assert.equal(reset.disabled, false);
      assert.match(reset.title, /Keine verlässliche Statushistorie.*Eingereicht/);
      reset.onClick();
      assert.deepEqual(calls, [data]);
      assert.equal(rollbackButtons({ ...props, batch: data, busy: true })[0].disabled, true);
    }
  }
  assert.deepEqual(states({ ...batch, status: "billed", status_path: ["submitted", "reviewed", "billed"] }), ["reached", "reached", "pending", "current"]);
  assert.deepEqual(states({ ...batch, status: "draft", status_path: ["draft"] }), ["pending", "pending", "pending", "pending"]);
});

test("an explicit rollback barrier never falls back to submitted in the UI", () => {
  for (const status of ["draft", "customer_signed", "signed", "billed"]) {
    for (const origin of ["OFFICE", "MONTEUR"]) {
      assert.equal(rollbackButtons({ ...props, batch: { ...batch, origin, status, previous_status: null } }).length, 0);
    }
  }
  const signed = { ...batch, status: "billed", previous_status: "customer_signed", customer_signed_at: "2026-09-16", status_rollback_floor: "customer_signed", status_rollback_is_fallback: true };
  const action = rollbackButtons({ ...props, batch: signed })[0];
  assert.equal(action["aria-label"], "Auf Unterschrieben zurücksetzen");
  assert.match(action.title, /auf Unterschrieben zurücksetzen/);
  const draft = rollbackButtons({ ...props, batch: { ...batch, previous_status: "draft", status_rollback_is_fallback: true } })[0];
  assert.equal(draft["aria-label"], "Auf Entwurf zurücksetzen");
});

test("only the actual predecessor is clickable, including office batches and non-standard stages", () => {
  for (const origin of ["MONTEUR", "OFFICE"]) {
    for (const [previous_status, label] of [["reviewed", "Geprüft"], ["customer_signed", "Unterschrieben"], ["draft", "Entwurf"], ["rejected", "Zurückgewiesen"], ["checked", "Geprüft"]]) {
      const data = { ...props, batch: { ...batch, origin, status: "billed", previous_status, status_path: ["submitted", "reviewed", "billed"] }, isBilled: true };
      const actions = rollbackButtons(data);
      assert.equal(actions.length, 1);
      assert.equal(actions[0]["aria-label"], `Auf ${label} zurücksetzen`);
      assert.equal(actions[0].type, "button");
      const html = render(data);
      assert.match(html, /<ol[\s\S]*<button[\s\S]*<\/button>[\s\S]*<\/ol>/);
      assert.doesNotMatch(html, /Status zurücksetzen/);
    }
  }
});
