import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("  async function handleUploadToCurrentFolder("), source.indexOf("  async function handleCreateFolder("));
const compiled = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const apiMethod = apiSource.slice(apiSource.indexOf("  async uploadProjectFolderDocument("), apiSource.indexOf("  async measurementBases("));
const apiCompiled = ts.transpileModule(`const api = {${apiMethod}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("upload API carries the optional subfolder in multipart data, preserving root requests", async () => {
  const requests = [];
  const uploadApi = new Function("request", `${apiCompiled}; return api;`)((...args) => { requests.push(args); return Promise.resolve({}); });
  const file = new File(["test"], "Plan.txt", { type: "text/plain" });
  await uploadApi.uploadProjectFolderDocument(7, "aufmass", file, "child-id");
  await uploadApi.uploadProjectFolderDocument(7, "aufmass", file);
  assert.equal(requests[0][0], "/sites/7/documents/folders/aufmass/upload");
  assert.equal(requests[0][1].body.get("parent_item_id"), "child-id");
  assert.equal(requests[0][1].body.get("file").name, "Plan.txt");
  assert.equal(requests[1][1].body.has("parent_item_id"), false);
});

function harness(overrides = {}) {
  const refreshed = { items: [{ id: "uploaded", name: "Neu.pdf" }] };
  const state = { stack: [{ itemId: "parent", documents: { items: [] } }, { itemId: "child", documents: { items: [] } }], calls: [], errors: [], refreshes: [] };
  const dependencies = {
    canUploadToCurrentFolder: true, isUploading: false,
    fileDropUploadPendingRef: { current: false }, browserMountedRef: { current: true },
    currentLevel: { itemId: "child" }, siteId: 7, folder: { folder_key: "aufmass" },
    onUpload: async (...args) => { state.calls.push(args); },
    api: { projectFolderItemChildren: async (...args) => { state.refreshes.push(args); return refreshed; } },
    setFolderStack: (update) => { state.stack = update(state.stack); },
    setFolderNavigationError: (value) => state.errors.push(value),
    readApiError: (_error, fallback) => fallback,
    ...overrides,
  };
  return { state, dependencies, refreshed, upload: new Function(...Object.keys(dependencies), `${compiled}; return handleUploadToCurrentFolder;`)(...Object.values(dependencies)) };
}

test("both upload paths preserve current subfolder and replace only its cached documents", async () => {
  const h = harness();
  const files = [{ name: "Neu.pdf" }, { name: "Plan.pdf" }];
  await h.upload(files);
  assert.deepEqual(h.state.calls, [[files, "child"]]);
  assert.deepEqual(h.state.refreshes, [[7, "aufmass", "child"]]);
  assert.deepEqual(h.state.stack[0].documents, { items: [] });
  assert.equal(h.state.stack[1].documents, h.refreshed);
  assert.equal(h.dependencies.fileDropUploadPendingRef.current, false);
});

test("root uploads retain the existing root refresh flow", async () => {
  const h = harness({ currentLevel: undefined });
  await h.upload([{ name: "Neu.pdf" }]);
  assert.equal(h.state.calls[0][1], undefined);
  assert.deepEqual(h.state.refreshes, []);
});

test("rapid button and drop uploads share one synchronous guard and copy the file list", async () => {
  let finish;
  let received;
  const h = harness({ onUpload: (files) => { received = files; return new Promise((resolve) => { finish = resolve; }); } });
  const files = [{ name: "Neu.pdf" }];
  const first = h.upload(files);
  files.length = 0;
  await h.upload([{ name: "Duplicate.pdf" }]);
  assert.deepEqual(received, [{ name: "Neu.pdf" }]);
  finish();
  await first;
  assert.equal(h.state.refreshes.length, 1);
});

test("failed refresh keeps current files and releases upload guard", async () => {
  const h = harness({ api: { projectFolderItemChildren: async () => { throw new Error("offline"); } } });
  await h.upload([{ name: "Neu.pdf" }]);
  assert.match(h.state.errors.at(-1), /erneut öffnen/);
  assert.deepEqual(h.state.stack[1].documents, { items: [] });
  assert.equal(h.dependencies.fileDropUploadPendingRef.current, false);
});

test("unmounted browsers are not refreshed by a completed upload", async () => {
  const h = harness({ browserMountedRef: { current: false } });
  await h.upload([{ name: "Neu.pdf" }]);
  assert.deepEqual(h.state.refreshes, []);
});
