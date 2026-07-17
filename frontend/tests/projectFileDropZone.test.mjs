import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { containsDraggedFiles } from "../src/lib/fileDrag.ts";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("only operating-system file drags activate the project file drop zone", () => {
  assert.equal(containsDraggedFiles(["Files"]), true);
  assert.equal(containsDraggedFiles(["application/x-moz-file"]), true);
  assert.equal(containsDraggedFiles(["text/plain", "text/uri-list"]), false);
  assert.match(pageSource, /if \(!containsDraggedFiles\(event\.dataTransfer\.types\)\) \{\s*return;/);
});

test("the full document browser uses a counter-backed, browser-safe drop target", () => {
  assert.match(pageSource, /const fileDragDepthRef = useRef\(0\)/);
  assert.match(pageSource, /fileDragDepthRef\.current \+= 1/);
  assert.match(pageSource, /fileDragDepthRef\.current = Math\.max\(0, fileDragDepthRef\.current - 1\)/);
  assert.match(pageSource, /onDragEnter=\{handleFileDragEnter\}/);
  assert.match(pageSource, /onDragOver=\{handleFileDragOver\}/);
  assert.match(pageSource, /onDragLeave=\{handleFileDragLeave\}/);
  assert.match(pageSource, /onDrop=\{handleFileDrop\}/);
  assert.match(pageSource, /event\.preventDefault\(\);[\s\S]*event\.dataTransfer\.dropEffect/);
});

test("drop and upload button share the existing upload callback with a synchronous duplicate guard", () => {
  assert.match(pageSource, /onUploadFiles=\{uploadFilesToFolder\}/);
  assert.match(pageSource, /const fileDropUploadPendingRef = useRef\(false\)/);
  assert.match(pageSource, /fileDropUploadPendingRef\.current = true;\s*void onUpload\(event\.dataTransfer\.files\)\.finally/);
  assert.match(pageSource, /className="project-upload-input"[\s\S]*void onUpload\(event\.target\.files\)/);
});

test("the drag hint is a temporary square Office-style overlay over the whole right pane", () => {
  assert.match(pageSource, /isFileDropActive \? \([\s\S]*project-document-drop-overlay[\s\S]*Dateien hier ablegen/);
  assert.match(styles, /\.project-document-browser \{[^}]*position:\s*relative/s);
  assert.match(styles, /\.project-document-drop-overlay \{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*box-shadow:\s*inset[^}]*pointer-events:\s*none/s);
});
