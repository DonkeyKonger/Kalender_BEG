import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

const controlStart = pageSource.indexOf("function SiteHeaderStatusSelect");
const controlEnd = pageSource.indexOf("function ProjectRecordTabs", controlStart);
const controlSource = pageSource.slice(controlStart, controlEnd);

test("project header status uses an anchored accessible custom listbox", () => {
  assert.notEqual(controlStart, -1);
  assert.match(controlSource, /role="combobox"/);
  assert.match(controlSource, /aria-haspopup="listbox"/);
  assert.match(controlSource, /aria-expanded=\{isOpen\}/);
  assert.match(controlSource, /aria-controls=\{isOpen \? listboxId : undefined\}/);
  assert.match(controlSource, /role="listbox"/);
  assert.match(controlSource, /role="option"/);
  assert.match(controlSource, /aria-selected=\{option\.value === value\}/);
  assert.match(controlSource, /siteStatusOptions\.map/);
  assert.match(pageSource, /completed: "Abgeschlossen"/);
  assert.match(pageSource, /planned: "Geplant"/);
  assert.doesNotMatch(controlSource, /<select/);
});

test("custom status trigger is compact while its menu remains independently wide", () => {
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace \.site-detail-status-control \{[^}]*width: max-content;[^}]*min-height: 24px;[^}]*border-radius: 0;/s);
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace \.site-detail-status-trigger \{[^}]*min-width: 64px;[^}]*max-width: 160px;[^}]*height: 24px;[^}]*white-space: nowrap;/s);
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace \.site-detail-status-trigger:focus-visible \{[^}]*outline: 2px solid var\(--pf-active\);/s);
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace \.site-detail-status-caret \{[^}]*pointer-events: none;/s);
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace \.site-detail-status-menu \{[^}]*top: calc\(100% \+ 1px\);[^}]*right: 0;[^}]*width: max\(100%, 168px\);/s);
  assert.match(styles, /\.status-badge-active \{[^}]*background: #e7f7ed;[^}]*color: #126b36;/s);
  assert.match(styles, /\.status-badge-paused,[^}]*background: #fff4d6;[^}]*color: #815500;/s);
  assert.match(styles, /\.status-badge-planned \{[^}]*background: #e8f1ff;[^}]*color: #1d4f91;/s);
  assert.match(styles, /\.status-badge-completed \{[^}]*background: #edf0f4;[^}]*color: #4b5563;/s);
  assert.match(styles, /\.status-badge-deleted \{[^}]*background: #fff1f0;[^}]*color: #8a1f16;/s);
  assert.match(styles, /\.site-card-status-select \{[^}]*border-radius: 999px;/s);
});

test("custom status interaction supports focus, escape, outside click and keyboard selection", () => {
  assert.match(controlSource, /querySelector<HTMLButtonElement>\('\[role="option"\]\[aria-selected="true"\]'\)/);
  assert.match(controlSource, /document\.addEventListener\("pointerdown", closeOnOutsidePointer, true\)/);
  assert.match(controlSource, /event\.key === "Escape"/);
  assert.match(controlSource, /\["ArrowDown", "ArrowUp", "Enter", " "\]/);
  assert.match(controlSource, /getSiteStatusMenuNavigationIndex/);
  assert.match(controlSource, /event\.target\.click\(\)/);
  assert.match(controlSource, /onChange\(option\.value\)/);
});
