import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source = await readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/pages/MobileMeasurementEntry.css", import.meta.url), "utf8");
const keypad = source.slice(source.indexOf("function MeasurementQuantityKeypad("), source.indexOf("function PdfCanvasPreview("));
const quantityStart = source.indexOf("function applyMeasurementQuantityKey(");
const quantity = source.slice(quantityStart, source.indexOf("\nfunction ", quantityStart + 1));
const compiled = await build({
  stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {Delete,Trash2} from 'lucide-react'; ${keypad} ${quantity}
    export const tree = props => MeasurementQuantityKeypad(props);
    export const render = props => renderToStaticMarkup(React.createElement(MeasurementQuantityKeypad, props));
    export {applyMeasurementQuantityKey};`,
  resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic",
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { tree, render, applyMeasurementQuantityKey } = module.exports;

test("entry keypad uses twelve numeric keys and two icon-only actions", () => {
  const props = {variant: "entry", disabled: false, onKeyPress: () => {}};
  const buttons = tree(props).props.children;
  assert.equal(buttons.length, 14);
  assert.deepEqual(buttons.slice(0, 12).map(button => button.props.children), ["1", "2", "3", "4", "5", "6", "7", "8", "9", ",", "0", "−"]);
  assert.deepEqual(buttons.slice(12).map(button => button.props["aria-label"]), ["Letzte Ziffer entfernen", "Menge leeren"]);
  const html = render(props);
  assert.doesNotMatch(html, />Zurück<|>Leeren</);
  assert.equal((html.match(/<svg/g) ?? []).length, 2);
  assert.match(styles, /grid-template-rows: repeat\(4, minmax\(44px, 1fr\)\)/);
  assert.match(styles, /is-backspace \{\s*grid-row: 1 \/ span 2;/);
  assert.match(styles, /is-clear \{\s*grid-row: 3 \/ span 2;/);
});

test("keypad preserves decimal, negative, backspace and clear behavior", () => {
  let value = "";
  const buttons = tree({variant: "entry", onKeyPress: key => { value = applyMeasurementQuantityKey(value, key); }}).props.children;
  for (const key of ["1", "2", ",", "5", "minus"]) buttons.find(button => button.key === key).props.onClick();
  assert.equal(value, "-12,5");
  buttons.find(button => button.key === "backspace").props.onClick();
  assert.equal(value, "-12,");
  buttons.find(button => button.key === "clear").props.onClick();
  assert.equal(value, "");
  assert.ok(tree({variant: "entry", disabled: true}).props.children.every(button => button.props.disabled));
});

test("free-position keypad retains its default layout and text actions", () => {
  const html = render({disabled: false, onKeyPress: () => {}});
  assert.match(html, />Zurück</);
  assert.match(html, />Leeren</);
  assert.equal(tree({}).props.children.length, 15);
  assert.doesNotMatch(html, /is-entry-keypad/);
});

test("capture redesign retains existing data controls and limits descriptions to three lines", () => {
  const detail = source.slice(source.indexOf("function MeasurementDetail("), source.indexOf("type MeasurementQuantityKey"));
  assert.match(detail, /<h1>Position erfassen<\/h1>/);
  assert.match(detail, /<MobileBackButton label="Zurück zu den Positionen" onClick=\{onBack\}/);
  assert.match(detail, /variant="entry"\s*disabled=\{isSaving\}/);
  assert.match(detail, /const isEditable = isDraft && !isLockedForWorker/);
  assert.match(detail, /onClick=\{onSave\} disabled=\{isSaving\}/);
  assert.match(detail, /onDeleteEntries\(area.entries\)/);
  assert.match(detail, /Bereichsvorschläge/);
  assert.match(detail, /<label htmlFor="mobile-measurement-entry-area">Bereich \/ Ort<\/label>/);
  assert.match(detail, /id="mobile-measurement-entry-area"/);
  assert.doesNotMatch(detail, /Details anzeigen|<details|measuredQuantity|siteNumber/);
  assert.doesNotMatch(detail, /measurement-status|mobileStatusLabel|item\.mobile_status/);
  assert.match(styles, /mobile-entry-head h2 \{\s*margin: 0 0 3px;/);
  assert.match(detail, /<X aria-hidden="true" size=\{15\} strokeWidth=\{1\.5\} \/>/);
  assert.match(styles, /mobile-measurement-entry > span \{\s*font-weight: 400;/);
  assert.match(styles, /mobile-measurement-entry-delete \{[^}]*min-height: 30px;[^}]*border: 0;[^}]*background: transparent;/s);
  assert.match(styles, /-webkit-line-clamp: 3/);
});
