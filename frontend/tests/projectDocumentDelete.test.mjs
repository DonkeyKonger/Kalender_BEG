import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const browser = page.slice(page.indexOf("function ProjectFolderDocumentBrowser("), page.indexOf("function ProjectDocumentSortHeader("));
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("file deletion requires edit permission, excludes folders, confirms the filename before the request", () => {
  const handler = browser.slice(browser.indexOf("async function handleDelete"), browser.indexOf("const [query"));
  assert.match(handler, /!canDeleteDocuments \|\| item.is_folder \|\| !item.id \|\| deletePendingRef.current/);
  assert.ok(handler.indexOf("window.confirm") < handler.indexOf("api.deleteProjectFolderDocument"));
  assert.match(handler, /item.name.*wirklich löschen/);
  assert.match(handler, /SharePoint-Papierkorb/);
  assert.match(browser, /canEditMainPage\(user, "sites"\)/);
  assert.match(browser, /aria-label=\{`Datei „\$\{item.name\}“ löschen`\}/);
});

test("only successful deletions remove rows; stale folder responses and double clicks are guarded", () => {
  assert.ok(browser.indexOf("await api.deleteProjectFolderDocument") < browser.indexOf("setDeletedItemIds((current)"));
  assert.match(browser, /if \(!browserMountedRef.current\) return/);
  assert.match(browser, /items: sourceDocuments.items.filter\(\(item\) => !deletedItemIds.has\(item.id\)\)/);
  assert.match(browser, /deletePendingRef.current = true/);
  assert.match(browser, /role="alert"/);
  assert.match(page, /key=\{`\$\{site.id\}:\$\{selectedFolder.id\}`\}/);
});

test("delete control keeps a full hit area, half-height divider and visible keyboard focus", () => {
  assert.match(css, /\.project-document-delete-slot::after\s*\{[^}]*top: 25%;[^}]*height: 50%;/);
  assert.match(css, /\.project-document-delete-action\s*\{[^}]*width: var\(--project-document-delete-size\);[^}]*height: var\(--project-document-delete-size\);/);
  assert.match(css, /\.project-document-delete-action:focus-visible/);
  assert.match(css, /\.project-document-delete-action svg\s*\{\s*color: inherit;/);
});

test("compact delete slots align folders with files without adding folder delete controls", () => {
  assert.match(css, /\.project-document-name-cell.has-delete-actions\s*\{[^}]*--project-document-delete-size: 24px;[^}]*gap: 6px;/);
  assert.match(css, /width: calc\(var\(--project-document-delete-size\) \+ 4px\)/);
  assert.match(browser, /item.is_folder \|\| !item.id \? " is-placeholder"/);
  assert.match(browser, /!item.is_folder && item.id \? \(/);
  assert.match(css, /\.project-document-delete-slot.is-placeholder::after\s*\{\s*display: none;/);
  assert.match(css, /@media \(pointer: coarse\)\s*\{\s*\.project-document-name-cell.has-delete-actions\s*\{\s*--project-document-delete-size: 32px;/);
});
