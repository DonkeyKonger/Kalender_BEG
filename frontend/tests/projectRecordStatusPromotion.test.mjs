import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extraWorkStatusPromotionOptions,
  measurementStatusPromotionOptions,
} from "../src/lib/projectRecordStatuses.ts";

const pageSource = await readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("measurement status control offers only higher non-signature states", () => {
  assert.deepEqual(measurementStatusPromotionOptions("draft", null).map(({ value }) => value), [
    "submitted",
    "reviewed",
    "billed",
  ]);
  assert.deepEqual(measurementStatusPromotionOptions("submitted", null).map(({ value }) => value), [
    "reviewed",
    "billed",
  ]);
  assert.deepEqual(measurementStatusPromotionOptions("reviewed", null).map(({ value }) => value), ["billed"]);
  assert.deepEqual(measurementStatusPromotionOptions("customer_signed", "2026-08-12T08:00:00Z").map(({ value }) => value), ["billed"]);
  assert.deepEqual(measurementStatusPromotionOptions("billed", null), []);
  assert.deepEqual(measurementStatusPromotionOptions("billed", "2026-08-12T08:00:00Z"), []);
});

test("extra-work status control skips the protected signature state", () => {
  assert.deepEqual(extraWorkStatusPromotionOptions("draft", null).map(({ value }) => value), [
    "submitted",
    "billed",
  ]);
  assert.deepEqual(extraWorkStatusPromotionOptions("submitted", null).map(({ value }) => value), ["billed"]);
  assert.deepEqual(extraWorkStatusPromotionOptions("signed", "2026-08-12T08:00:00Z").map(({ value }) => value), ["billed"]);
  assert.deepEqual(extraWorkStatusPromotionOptions("closed", null), []);
  assert.deepEqual(extraWorkStatusPromotionOptions("billed", "2026-08-12T08:00:00Z"), []);
});

test("both project-record lists use the shared anchored status popover and APIs", () => {
  assert.match(pageSource, /function ProjectRecordStatusControl/);
  assert.match(pageSource, /createPortal\(/);
  assert.match(pageSource, /document\.addEventListener\("pointerdown"/);
  assert.match(pageSource, /event\.key === "Escape"/);
  assert.match(pageSource, /measurementStatusPromotionOptions/);
  assert.match(pageSource, /extraWorkStatusPromotionOptions/);
  assert.match(apiSource, /measurement-batches\/\$\{batchId\}\/status/);
  assert.match(apiSource, /extra-work-tickets\/\$\{ticketId\}\/status/);
  assert.match(styles, /\.project-record-status-popover\s*\{[^}]*position:\s*fixed/s);
});

test("extra-work list status keeps full menu semantics without a visible caret", () => {
  const tabStart = pageSource.indexOf("function ExtraWorkTab");
  const tabEnd = pageSource.indexOf("function MeasurementTab", tabStart);
  const tabSource = pageSource.slice(tabStart, tabEnd);
  const masterStart = tabSource.indexOf("visibleTickets.map");
  const masterEnd = tabSource.indexOf("<ExtraWorkOverviewDetail", masterStart);
  const masterSource = tabSource.slice(masterStart, masterEnd);
  const controlStart = pageSource.indexOf("function ProjectRecordStatusControl");
  const controlEnd = pageSource.indexOf("function mergeExtraWorkOverviewEntrySummaries", controlStart);
  const controlSource = pageSource.slice(controlStart, controlEnd);

  assert.match(masterSource, /showCaret=\{false\}/);
  assert.doesNotMatch(masterSource, /measurement-review-status-caret/);
  assert.match(controlSource, /aria-haspopup="menu"/);
  assert.match(controlSource, /aria-expanded=\{active\}/);
  assert.match(controlSource, /aria-label=\{ariaLabel\}/);
  assert.match(controlSource, /onClick=\{onToggle\}/);
  assert.match(controlSource, /event\.key === "Escape"/);
  assert.match(controlSource, /onClick=\{\(\) => onSelect\(option\.value\)\}/);
  assert.match(controlSource, /showCaret \? <span aria-hidden="true" className="measurement-review-status-caret">⌄<\/span> : null/);
});

test("extra-work editable statuses reuse static chip geometry with distinct semantic accents", () => {
  assert.match(styles, /\.project-extra-work-master-status \.measurement-review-status-trigger \{[\s\S]*border-left: 0;[\s\S]*background: transparent;[\s\S]*cursor: pointer/);
  assert.match(styles, /\.project-extra-work-master-status \.measurement-review-status-trigger:hover,[\s\S]*\[aria-expanded="true"\][\s\S]*background: rgba\(15, 23, 42, 0\.06\)/);
  assert.match(styles, /\.project-extra-work-master-status \.measurement-review-status-trigger:focus-visible \{[\s\S]*outline: 2px solid #3b82f6/);
  assert.match(styles, /\.measurement-review-status-badge\.is-draft::before \{[\s\S]*background: #64748b/);
  assert.match(styles, /\.measurement-review-status-badge\.is-signed-review::before,[\s\S]*\.measurement-review-status-badge\.is-signed::before \{[\s\S]*background: #0891b2/);
  assert.match(styles, /\.measurement-review-status-badge\.is-billed::before,[\s\S]*\.measurement-review-status-badge\.is-closed::before \{[\s\S]*background: #16a34a/);
});
