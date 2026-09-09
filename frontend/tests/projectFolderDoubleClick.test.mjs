import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("  async function handleOpenFolder("), source.indexOf("  function handleBackToParentFolder("));
const compiled = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(load) {
  const state = { stack: [], errors: [], loading: [], calls: 0 };
  const dependencies = {
    folderNavigationPendingRef: { current: false }, browserMountedRef: { current: true },
    siteId: 7, folder: { folder_key: "dokumentation" },
    api: { projectFolderItemChildren: (...args) => { state.calls++; assert.deepEqual(args, [7, "dokumentation", "child"]); return load(); } },
    setFolderNavigationError: (value) => state.errors.push(value),
    setFolderNavigationLoading: (value) => state.loading.push(value),
    setFolderStack: (update) => { state.stack = update(state.stack); },
    resetFileDropState() {}, setQuery() {}, readApiError: (_error, fallback) => fallback,
  };
  return { state, dependencies, open: new Function(...Object.keys(dependencies), `${compiled}; return handleOpenFolder;`)(...Object.values(dependencies)) };
}

test("double-click applies only to folder rows and ignores existing action buttons", () => {
  assert.match(source, /onDoubleClick=\{item.is_folder \? \(event\) =>/);
  assert.match(source, /event.target.closest\("button, a, input"\)/);
  assert.match(source, /onClick=\{\(\) => void handleOpenFolder\(item\)\}/);
});

test("rapid folder opens issue one request and append exactly one level; files do nothing", async () => {
  let resolve;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  await h.open({ id: "file", is_folder: false });
  assert.equal(h.state.calls, 0);
  const item = { id: "child", name: "Unterordner", is_folder: true };
  const first = h.open(item);
  await h.open(item);
  assert.equal(h.state.calls, 1);
  resolve({ items: [] });
  await first;
  assert.equal(h.state.stack.length, 1);
  assert.equal(h.state.stack[0].itemId, "child");
  assert.deepEqual(h.state.loading, [true, false]);
});

test("failed loads leave the current folder intact and allow retry", async () => {
  const h = harness(() => Promise.reject(new Error("offline")));
  const item = { id: "child", is_folder: true };
  await h.open(item);
  await h.open(item);
  assert.equal(h.state.calls, 2);
  assert.deepEqual(h.state.stack, []);
  assert.match(h.state.errors.at(-1), /konnte nicht geladen/);
  assert.equal(h.dependencies.folderNavigationPendingRef.current, false);
});

test("a completed request cannot change an unmounted folder browser", async () => {
  let resolve;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  const request = h.open({ id: "child", is_folder: true });
  h.dependencies.browserMountedRef.current = false;
  resolve({ items: [] });
  await request;
  assert.deepEqual(h.state.stack, []);
});
