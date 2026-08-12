import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

const browserStart = pageSource.indexOf("function ProjectFolderDocumentBrowser");
const browserEnd = pageSource.indexOf("function ProjectDocumentSortHeader", browserStart);
const browserSource = pageSource.slice(browserStart, browserEnd);

test("project file toolbar keeps upload and folder actions without SharePoint or close controls", () => {
  assert.match(browserSource, /<span>\{isUploading \? "Lädt\.\.\." : "Hochladen"\}<\/span>/);
  assert.match(browserSource, /<Folder aria-hidden="true" size=\{15\} \/>\s*<span>Ordner<\/span>/);
  assert.doesNotMatch(browserSource, /project-document-sharepoint-link/);
  assert.doesNotMatch(browserSource, /<span>SharePoint<\/span>/);
  assert.doesNotMatch(browserSource, /project-document-close-action/);
  assert.doesNotMatch(browserSource, /Dateiansicht schließen/);
});

test("removed toolbar controls leave no hidden placeholders or exclusive styling behind", () => {
  assert.doesNotMatch(browserSource, /onClose:\s*\(\) => void/);
  assert.doesNotMatch(styles, /\.project-document-sharepoint-link/);
  assert.doesNotMatch(styles, /\.project-document-close-action/);
});
