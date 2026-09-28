import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/ProjectDocumentFilename.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

function harness(onRename = async () => {}, editable = true) {
  const values = [];
  let cursor = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], (v) => { values[i] = v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; },
  };
  const exports = {};
  new Function("require", "exports", compiled)((id) => id === "react" ? hooks : require(id), exports);
  const render = () => { cursor = 0; return exports.ProjectDocumentFilename({ name: "Alt.pdf", editable, onRename }); };
  const start = () => { render().props.onDoubleClick({ stopPropagation() {} }); };
  const input = () => render().props.children[0];
  const key = (key) => input().props.onKeyDown({ key, preventDefault() {}, nativeEvent: {} });
  return { render, start, input, key };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("double click edits in place and selects the basename, not the extension", () => {
  const h = harness(); h.start();
  let selection;
  h.input().props.onFocus({ target: { value: "Alt.pdf", setSelectionRange: (...args) => { selection = args; } } });
  assert.deepEqual(selection, [0, 3]);
  assert.equal(h.input().props.value, "Alt.pdf");
});

test("Enter and blur issue one rename and finish after success", async () => {
  let finish; const names = [];
  const h = harness((name) => { names.push(name); return new Promise((resolve) => { finish = resolve; }); });
  h.start(); h.input().props.onChange({ target: { value: " Neu.pdf " } });
  h.key("Enter"); h.input().props.onBlur();
  assert.deepEqual(names, ["Neu.pdf"]);
  assert.equal(h.input().props.disabled, true);
  finish(); await settle();
  assert.equal(h.render().type, "strong");
});

test("Escape cancels without saving even if blur follows", async () => {
  const names = []; const h = harness(async (name) => { names.push(name); });
  h.start(); h.input().props.onChange({ target: { value: "Neu.pdf" } });
  const input = h.input(); h.key("Escape"); input.props.onBlur(); await settle();
  assert.deepEqual(names, []); assert.equal(h.render().type, "strong");
});

test("invalid filenames stay editable and never reach the server", () => {
  const names = []; const h = harness(async (name) => { names.push(name); });
  h.start(); h.input().props.onChange({ target: { value: "../Plan.pdf" } }); h.key("Enter");
  assert.deepEqual(names, []); assert.equal(h.input().props["aria-invalid"], true);
});

test("name conflicts preserve the draft and permit retry", async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new Error("Name bereits vorhanden"); });
  h.start(); h.input().props.onChange({ target: { value: "Neu.pdf" } }); h.key("Enter"); await settle();
  assert.equal(h.input().props.value, "Neu.pdf");
  assert.equal(h.render().props.children[1].props.children, "Name bereits vorhanden");
  fail = false; h.key("Enter"); await settle(); assert.equal(h.render().type, "strong");
});

test("read-only files and folder names do not offer an editor", () => {
  const h = harness(undefined, false);
  assert.equal(h.render().props.onDoubleClick, undefined);
});
