import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const page = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../src/components/ProjectFolderCreateDialog.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("folder dialog, input and actions use square corners", () => {
  for (const selector of [".project-folder-create-dialog", ".project-folder-create-dialog input", ".project-folder-create-actions button"]) {
    const block = styles.slice(styles.indexOf(`${selector} {`)).split("}")[0];
    assert.match(block, /border-radius: 0;/);
  }
});

test("folder creation replaces the external link and targets the current folder", () => {
  assert.doesNotMatch(page, /canOpenSharePointDirectly/);
  assert.match(page, /<span>Ordner erstellen<\/span>/);
  assert.match(page, /const parentItemId = currentLevel\?\.itemId \?\? null/);
  assert.match(page, /api.createProjectSubfolder\(siteId, folder.folder_key, name, parentItemId\)/);
  assert.match(page, /level.itemId === parentItemId/);
  assert.match(page, /hasSharePointFolder && canDeleteDocuments/);
});

test("native modal has labelled input, focus containment, cancellation and duplicate-submit protection", () => {
  assert.match(dialog, /dialog\?\.showModal\(\)/);
  assert.match(dialog, /aria-labelledby=/);
  assert.match(dialog, /<label htmlFor=/);
  assert.match(dialog, /autoFocus/);
  assert.match(dialog, /onCancel=/);
  assert.match(dialog, /if \(pendingRef.current\) return/);
  assert.match(dialog, /await onCreate\(trimmed\);\s*close\(\)/);
  assert.match(dialog, /dialogRef.current\?\.close\(\);\s*onClose\(\)/);
  assert.match(dialog, /role="alert"/);
  assert.match(dialog, /disabled=\{saving \|\| !name.trim\(\)\}/);
});
