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
  assert.match(css, /\.project-document-delete-action\s*\{[^}]*width: 32px;[^}]*height: 32px;/);
  assert.match(css, /\.project-document-delete-action:focus-visible/);
  assert.match(css, /\.project-document-delete-action svg\s*\{\s*color: inherit;/);
});
