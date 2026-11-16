import assert from "node:assert/strict";
import test from "node:test";

import {
  LatestSerialTaskQueue,
  MATERIAL_ORDER_PREVIEW_MAX_PIXELS,
  MaterialOrderPreviewResourceCache,
  getMaterialOrderPreviewCacheKey,
  getMaterialOrderPreviewOutputScale,
} from "../src/lib/materialOrderPreview.ts";

test("material-order previews use the full display DPR through three without exceeding the page budget", () => {
  const cssWidth = 595.2755 * 1.5;
  const cssHeight = 841.8898 * 1.5;
  const scale = getMaterialOrderPreviewOutputScale(cssWidth, cssHeight, 3);
  const renderedPixels = cssWidth * cssHeight * scale ** 2;

  assert.equal(scale, 3);
  assert.ok(renderedPixels <= MATERIAL_ORDER_PREVIEW_MAX_PIXELS);
  assert.equal(getMaterialOrderPreviewOutputScale(cssWidth, cssHeight, 4), 3);
  assert.equal(getMaterialOrderPreviewOutputScale(cssWidth, cssHeight, 2), 2);
});

test("material-order preview scaling reduces only oversized renders to the pixel budget", () => {
  const cssWidth = 2_000;
  const cssHeight = 3_000;
  const scale = getMaterialOrderPreviewOutputScale(cssWidth, cssHeight, 3);

  assert.ok(scale < 3);
  assert.ok(Math.abs((cssWidth * cssHeight * scale ** 2) - MATERIAL_ORDER_PREVIEW_MAX_PIXELS) < 0.001);
  assert.equal(getMaterialOrderPreviewOutputScale(Number.NaN, 0, Number.NaN), 1);
});

test("rapid preview requests run serially and only publish the newest generation", async () => {
  const queue = new LatestSerialTaskQueue();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const started = [];
  let active = 0;
  let peakActive = 0;

  const run = (name, gate = Promise.resolve()) => queue.enqueue(async () => {
    started.push(name);
    active += 1;
    peakActive = Math.max(peakActive, active);
    await gate;
    active -= 1;
    return name;
  });

  const first = run("first", firstGate);
  await Promise.resolve();
  const skippedMiddle = run("middle");
  const newest = run("newest");
  releaseFirst();

  assert.equal(await first, null);
  assert.equal(await skippedMiddle, null);
  assert.equal(await newest, "newest");
  assert.deepEqual(started, ["first", "newest"]);
  assert.equal(peakActive, 1);
  await queue.whenIdle();
});

test("invalidating the queue prevents an in-flight preview from being published", async () => {
  const queue = new LatestSerialTaskQueue();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const result = queue.enqueue(async () => {
    await gate;
    return "stale";
  });
  await Promise.resolve();
  queue.invalidate();
  release();
  assert.equal(await result, null);
});

test("folder-scoped material-order resources deduplicate successful loads and retry failures", async () => {
  const resources = { form: { width: 600, height: 800, fields: [] }, template: new Blob(["pdf"]) };
  let loads = 0;
  const cache = new MaterialOrderPreviewResourceCache(async () => {
    loads += 1;
    return resources;
  });

  const [first, second] = await Promise.all([cache.resources(), cache.resources()]);
  assert.equal(first, resources);
  assert.equal(second, resources);
  assert.equal(loads, 1);

  let attempts = 0;
  const retryingCache = new MaterialOrderPreviewResourceCache(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary");
    return resources;
  });
  await assert.rejects(retryingCache.resources(), /temporary/);
  assert.equal(await retryingCache.resources(), resources);
  assert.equal(attempts, 2);
});

test("folder-scoped preview cache shares one pending render and retains only its latest blob", async () => {
  const cache = new MaterialOrderPreviewResourceCache(async () => ({
    form: { width: 600, height: 800, fields: [] },
    template: new Blob(["pdf"]),
  }));
  let resolvePreview;
  const gate = new Promise((resolve) => { resolvePreview = resolve; });
  let renders = 0;
  const create = async () => {
    renders += 1;
    return gate;
  };

  const first = cache.previewFor("125:1500x2100", create);
  const second = cache.previewFor("125:1500x2100", create);
  const firstBlob = new Blob(["first"]);
  resolvePreview(firstBlob);
  assert.equal(await first, firstBlob);
  assert.equal(await second, firstBlob);
  assert.equal(renders, 1);
  assert.equal(cache.cachedPreview("125:1500x2100"), firstBlob);

  const secondBlob = new Blob(["second"]);
  assert.equal(await cache.previewFor("150:1800x2520", async () => secondBlob), secondBlob);
  assert.equal(cache.cachedPreview("125:1500x2100"), null);
  assert.equal(cache.cachedPreview("150:1800x2520"), secondBlob);
});

test("preview cache keys follow the bounded physical output dimensions", () => {
  const form = { width: 595.2755, height: 841.8898 };
  assert.equal(getMaterialOrderPreviewCacheKey(form, 100, 2), "100:1191x1684");
  assert.equal(getMaterialOrderPreviewCacheKey(form, 100, 4), "100:1786x2526");
});
