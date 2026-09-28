import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: [fileURLToPath(new URL("../src/components/ProjectFolderPhotoGrid.tsx", import.meta.url))], bundle: true, write: false, format: "cjs", platform: "node", packages: "external", loader: { ".css": "empty" }, define: { "import.meta.env": "{}" }, jsx: "automatic" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
const { renderToStaticMarkup } = require("react-dom/server");
const css = await readFile(new URL("../src/components/ProjectFolderPhotoGrid.css", import.meta.url), "utf8");
const page = await readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const collect = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(collect) : [node, ...collect(node.props?.children)];
const photo = { id: "photo", name: "Bild.jpg", is_folder: false, mime_type: "image/jpeg", file_extension: "jpg" };
const folder = { id: "folder", name: "Archiv", is_folder: true };
const pdf = { id: "pdf", name: "Plan.pdf", is_folder: false, mime_type: "application/pdf", file_extension: "pdf" };
function tree(overrides = {}) {
  return module.exports.ProjectFolderPhotoGrid({ siteId: 7, folderKey: "fotos", items: [folder, photo, pdf], sort: { key: "uploaded", direction: "desc" }, canEdit: true, openingItemId: null, downloadingItemId: null, deletingItemId: null, folderNavigationLoading: false, ...overrides });
}

test("desktop photo folder uses exactly five flexible square previews without affecting mobile grid", () => {
  assert.match(css, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css, /aspect-ratio: 1/);
  assert.match(css, /object-fit: cover/);
  assert.match(page, /folder.folder_key === "fotos" \? \(\s*<ProjectFolderPhotoGrid/);
  assert.match(page, /items=\{visibleItems\}/);
});

test("mixed content preserves folders and non-photo documents without requesting their thumbnails", () => {
  const html = renderToStaticMarkup(tree());
  assert.equal((html.match(/class="project-photo-preview"/g) || []).length, 1);
  assert.match(html, /project-photo-subfolder/);
  assert.match(html, /project-photo-card is-document/);
  assert.match(html, /Archiv/);
  assert.match(html, /Plan.pdf/);
  assert.match(css, /\.project-photo-subfolder \{ grid-column: 1 \/ -1/);
});

test("preview, folder, download, delete, rename and sort keep the existing callbacks", async () => {
  const calls = [];
  const nodes = collect(tree({ onOpen: item => calls.push(["open", item.id]), onOpenFolder: item => calls.push(["folder", item.id]), onDownload: item => calls.push(["download", item.id]), onDelete: item => calls.push(["delete", item.id]), onRename: (item, name) => calls.push(["rename", item.id, name]), onSort: key => calls.push(["sort", key]) }));
  nodes.find(n => n.props?.className === "project-photo-preview").props.onOpen();
  nodes.find(n => n.props?.className === "project-photo-subfolder").props.onClick();
  nodes.find(n => n.props?.["aria-label"] === "Herunterladen: Bild.jpg").props.onClick();
  nodes.find(n => n.props?.["aria-label"] === "Datei „Bild.jpg“ löschen").props.onClick();
  await nodes.find(n => n.props?.name === "Bild.jpg").props.onRename("Neu.jpg");
  nodes.find(n => n.props?.["aria-label"] === "Dateiname aufsteigend sortieren").props.onClick();
  assert.deepEqual(calls, [["open", "photo"], ["folder", "folder"], ["download", "photo"], ["delete", "photo"], ["rename", "photo", "Neu.jpg"], ["sort", "name"]]);
});

test("read-only users cannot rename or delete photos and pending downloads stay disabled", () => {
  const nodes = collect(tree({ canEdit: false, downloadingItemId: "photo" }));
  assert.equal(nodes.find(n => n.props?.name === "Bild.jpg").props.editable, false);
  assert.equal(nodes.some(n => n.props?.["aria-label"] === "Datei „Bild.jpg“ löschen"), false);
  assert.equal(nodes.find(n => n.props?.["aria-label"] === "Herunterladen: Bild.jpg").props.disabled, true);
});
