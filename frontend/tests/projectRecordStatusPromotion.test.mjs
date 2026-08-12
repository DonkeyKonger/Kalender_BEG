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
