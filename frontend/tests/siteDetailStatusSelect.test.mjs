import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

const controlStart = pageSource.indexOf("site-detail-status-control");
const controlEnd = pageSource.indexOf("</span>", controlStart);
const controlSource = pageSource.slice(controlStart, controlEnd);

test("project header status keeps native select semantics with a dedicated visual caret", () => {
  assert.notEqual(controlStart, -1);
  assert.match(controlSource, /<select/);
  assert.match(controlSource, /aria-label=\{`Status fuer \$\{site\.name\} aendern`\}/);
  assert.match(controlSource, /disabled=\{isSavingSiteStatus\}/);
  assert.match(controlSource, /value=\{site\.status\}/);
  assert.match(controlSource, /onChange=\{\(event\) => void updateSiteHeaderStatus\(event\.target\.value as Site\["status"\]\)\}/);
  assert.match(controlSource, /siteStatusOptions\.map/);
  assert.match(controlSource, /<ChevronDown aria-hidden="true" className="site-detail-status-caret"/);
  assert.doesNotMatch(controlSource, /site-card-status-select/);
});

test("project header status normalizes Safari appearance without changing other selects", () => {
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace \.site-detail-status-control \{[^}]*width: 118px;[^}]*border-radius: 0;/s);
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace \.site-detail-status-select \{[^}]*-webkit-appearance: none;[^}]*appearance: none;[^}]*border-radius: 0;[^}]*cursor: pointer;/s);
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace \.site-detail-status-select:focus-visible \{[^}]*outline: 2px solid var\(--pf-active\);/s);
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace \.site-detail-status-caret \{[^}]*pointer-events: none;/s);
  assert.match(styles, /\.status-badge-active \{[^}]*background: #e7f7ed;[^}]*color: #126b36;/s);
  assert.match(styles, /\.status-badge-paused,[^}]*background: #fff4d6;[^}]*color: #815500;/s);
  assert.match(styles, /\.status-badge-planned \{[^}]*background: #e8f1ff;[^}]*color: #1d4f91;/s);
  assert.match(styles, /\.status-badge-completed \{[^}]*background: #edf0f4;[^}]*color: #4b5563;/s);
  assert.match(styles, /\.status-badge-deleted \{[^}]*background: #fff1f0;[^}]*color: #8a1f16;/s);
  assert.match(styles, /\.site-card-status-select \{[^}]*border-radius: 999px;/s);
});
