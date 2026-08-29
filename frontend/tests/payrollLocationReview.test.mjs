import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manual site assignment confirms only the location check", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
  const locationCheckStart = source.indexOf("function classifyTimeReviewLocationCheck");
  const timeCheckStart = source.indexOf("function classifyTimeReviewTimeCheck");
  const locationCheck = source.slice(locationCheckStart, timeCheckStart);

  assert.match(locationCheck, /if \(hasManualLocationReview\(entry\)\) \{\s+return "ok";/);
  assert.match(source, /return entry\.original_site_id !== null && entry\.original_site_id !== entry\.site_id;/);
});
