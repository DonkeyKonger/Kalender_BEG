import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { PROJECT_DOCUMENT_DRAG_TYPE } from "../src/lib/projectDocumentMove.ts";

const compiled = await build({ entryPoints: [fileURLToPath(new URL("../src/pages/useProjectDocumentDrag.ts", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external",
  plugins: [{ name: "mock-api", setup(build) { build.onResolve({ filter: /^\.\.\/lib\/api$/ }, () => ({ path: "mock-api", external: true })); } }],
});
globalThis.Element = class { closest() { return false; } };
globalThis.Node = class {};
const source = { folderKey: "fotos", parentId: "nested" };
const target = { folderKey: "dokumentation", parentId: null };
const item = { id: "file", name: "Foto.jpg", is_folder: false };
function setup(canEdit = true, move = async () => item) {
  const values = [];
  const calls = [];
  let refreshed = 0;
  const react = { useRef: current => ({ current }), useState: initial => {
    const index = values.length; values.push(initial);
    return [initial, next => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
  } };
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(name => name === "react" ? react : {
    api: { moveProjectFolderDocument: (...args) => { calls.push(args); return move(); } }, ApiError: Error,
  }, module, module.exports);
  const hook = module.exports.useProjectDocumentDrag(7, canEdit, () => refreshed++);
  const data = new Map();
  const event = { target: new Element(), preventDefault() { this.prevented = true; }, stopPropagation() {},
    dataTransfer: { get types() { return [...data.keys()]; }, setData: (type, value) => data.set(type, value), getData: type => data.get(type), dropEffect: "", effectAllowed: "" } };
  return { hook, event, values, calls, get refreshed() { return refreshed; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("drag moves exactly one internal file and refreshes only after success", async () => {
  const s = setup();
  s.hook.sourceProps(item, source).onDragStart(s.event);
  assert.equal(s.event.dataTransfer.effectAllowed, "move");
  s.hook.targetProps(target).onDragOver(s.event);
  assert.equal(s.event.dataTransfer.dropEffect, "move");
  s.hook.targetProps(target).onDrop(s.event);
  s.hook.targetProps(target).onDrop(s.event);
  assert.deepEqual(s.calls, [[7, "fotos", "file", "dokumentation", null]]);
  assert.equal(s.refreshed, 0);
  await settle();
  assert.equal(s.refreshed, 1);
  assert.deepEqual(s.values[5], { source, target, item });
});

test("same-folder drops, external uploads and cancelled drags do not move anything", () => {
  const s = setup();
  s.hook.targetProps(target).onDrop(s.event);
  s.hook.sourceProps(item, source).onDragStart(s.event);
  s.hook.targetProps(source).onDragOver(s.event);
  assert.equal(s.event.dataTransfer.dropEffect, "none");
  s.hook.targetProps(source).onDrop(s.event);
  s.hook.sourceProps(item, source).onDragStart(s.event);
  s.hook.sourceProps(item, source).onDragEnd(s.event);
  s.hook.targetProps(target).onDrop(s.event);
  assert.deepEqual(s.calls, []);
});

test("read-only users, folders and mismatched drag payloads cannot move files", () => {
  const s = setup(false);
  assert.equal(s.hook.sourceProps(item, source).draggable, false);
  s.hook.sourceProps(item, source).onDragStart(s.event);
  assert.equal(s.event.prevented, true);
  s.hook.targetProps(target).onDrop(s.event);
  assert.deepEqual(s.calls, []);
  const editable = setup();
  assert.equal(editable.hook.sourceProps({ ...item, is_folder: true }, source).draggable, false);
  editable.hook.sourceProps(item, source).onDragStart(editable.event);
  editable.event.dataTransfer.setData(PROJECT_DOCUMENT_DRAG_TYPE, "forged-id");
  editable.hook.targetProps(target).onDrop(editable.event);
  assert.deepEqual(editable.calls, []);
});

test("conflicts leave data intact and surface the error; pending moves reject another drag", async () => {
  let reject;
  const s = setup(true, () => new Promise((_, fail) => { reject = fail; }));
  s.hook.sourceProps(item, source).onDragStart(s.event);
  s.hook.targetProps(target).onDrop(s.event);
  s.event.prevented = false;
  s.hook.sourceProps(item, source).onDragStart(s.event);
  assert.equal(s.event.prevented, true);
  reject(new Error("Namenskonflikt"));
  await settle();
  assert.equal(s.refreshed, 0);
  assert.equal(s.values[5], null);
  assert.equal(s.values[4], "Namenskonflikt");
  assert.equal(s.values[1], false);
});
