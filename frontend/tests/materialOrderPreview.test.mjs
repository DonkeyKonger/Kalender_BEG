import assert from "node:assert/strict";
import test from "node:test";

import {
  LatestSerialTaskQueue,
  MATERIAL_ORDER_PREVIEW_MAX_PIXELS,
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
