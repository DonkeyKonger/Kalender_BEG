import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ExtraWorkPhotoOriginalCache,
  orderExtraWorkOriginalPhotoIds,
  shouldPrefetchExtraWorkOriginalPhotos,
} from "../src/lib/extraWorkPhotoOriginalCache.ts";

const pageSource = await readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const previewStart = pageSource.indexOf("function ExtraWorkOverviewPhotos");
const modalStart = pageSource.indexOf("function ExtraWorkOverviewPhotoModal", previewStart);
const previewSource = pageSource.slice(previewStart, modalStart);
const modalSource = pageSource.slice(modalStart, pageSource.indexOf("function MeasurementTab", modalStart));

test("original cache deduplicates in-flight loads and serves a settled blob", async () => {
  const cache = new ExtraWorkPhotoOriginalCache();
  let resolveLoad;
  let calls = 0;
  const loader = () => {
    calls += 1;
    return new Promise((resolve) => { resolveLoad = resolve; });
  };
  const first = cache.load(1, loader);
  const concurrent = cache.load(1, loader);
  assert.strictEqual(first, concurrent);
  const blob = new Blob(["original"]);
  resolveLoad(blob);
  assert.strictEqual(await first, blob);
  assert.strictEqual(cache.get(1), blob);
  assert.strictEqual(await cache.load(1, loader), blob);
  assert.equal(calls, 1);
});

test("ticket cleanup aborts running requests and failures remain retryable", async () => {
  const cache = new ExtraWorkPhotoOriginalCache();
  let aborted = false;
  const pending = cache.load(7, (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("Aborted", "AbortError"));
    });
  }));
  cache.clear();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(aborted, true);
  const recovered = new Blob(["retry"]);
  assert.strictEqual(await cache.load(7, async () => recovered), recovered);
});

test("photo changes retain only current ids and memory stays bounded", async () => {
  const cache = new ExtraWorkPhotoOriginalCache({ maxBytes: 8, maxEntries: 2 });
  await cache.load(1, async () => new Blob(["1111"]));
  await cache.load(2, async () => new Blob(["2222"]));
  await cache.load(3, async () => new Blob(["3333"]));
  assert.equal(cache.get(1), null);
  assert.ok(cache.get(2));
  assert.ok(cache.get(3));
  cache.retain([3]);
  assert.equal(cache.get(2), null);
  assert.ok(cache.get(3));
});

test("save-data and very slow connections skip background originals", () => {
  assert.equal(shouldPrefetchExtraWorkOriginalPhotos({ saveData: true, effectiveType: "4g" }), false);
  assert.equal(shouldPrefetchExtraWorkOriginalPhotos({ effectiveType: "slow-2g" }), false);
  assert.equal(shouldPrefetchExtraWorkOriginalPhotos({ effectiveType: "2g" }), false);
  assert.equal(shouldPrefetchExtraWorkOriginalPhotos({ effectiveType: "3g" }), true);
  assert.equal(shouldPrefetchExtraWorkOriginalPhotos(undefined), true);
});

test("current or first photo is prioritized without duplicates", () => {
  assert.deepEqual(orderExtraWorkOriginalPhotoIds([3, 1, 2, 1], 2), [2, 3, 1]);
  assert.deepEqual(orderExtraWorkOriginalPhotoIds([3, 1, 2], 9), [3, 1, 2]);
});

test("prefetch starts on browser idle, stays serial and cleans up with the ticket", () => {
  assert.match(previewSource, /photoOwnerTicketId !== ticket\.id/);
  assert.match(previewSource, /window\.requestIdleCallback\(idleCallback, \{ timeout: 1500 \}\)/);
  assert.match(previewSource, /window\.setTimeout\(idleCallback, 350\)/);
  assert.match(previewSource, /for \(const photoId of orderedPhotoIds\)[\s\S]*await originalPhotoCache\.load/);
  assert.doesNotMatch(previewSource, /Promise\.all/);
  assert.match(previewSource, /shouldPrefetchExtraWorkOriginalPhotos\(connection\)/);
  assert.match(previewSource, /originalPhotoCache\.clear\(\)/);
  assert.match(previewSource, /window\.cancelIdleCallback\(idleId\)/);
});

test("viewer reuses a cache hit without a loading paint and preserves manual fallback", () => {
  assert.match(modalSource, /useState\(\(\) => originalPhotoCache\.get\(initialPhotoId\) === null\)/);
  assert.match(modalSource, /useLayoutEffect\(\(\) =>/);
  assert.match(modalSource, /const cachedBlob = originalPhotoCache\.get\(activePhoto\.id\)/);
  assert.match(modalSource, /if \(cachedBlob\)[\s\S]*setIsLoading\(false\)/);
  assert.match(modalSource, /originalPhotoCache\.load\(activePhoto\.id[\s\S]*siteExtraWorkTicketPhotoContent/);
  assert.match(modalSource, /window\.URL\.createObjectURL\(cachedBlob\)/);
  assert.match(modalSource, /window\.URL\.revokeObjectURL\(objectUrl\)/);
  assert.match(modalSource, /originalPhotoCache\.abort\(activePhoto\.id\)/);
});
