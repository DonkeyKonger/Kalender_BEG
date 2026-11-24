import assert from "node:assert/strict";
import test from "node:test";
import { getPriceChartLayout, getPriceChartWindow } from "../src/priceComparison/chartLayout.ts";

test("the last fitting bar needs no scrolling, the next one does", () => {
  const fitting = getPriceChartLayout(25, 800);
  const overflow = getPriceChartLayout(26, 800);
  assert.equal(fitting.visibleCapacity, 25);
  assert.equal(fitting.maxScroll, 0);
  assert.equal(overflow.maxScroll, 32);
  assert.equal(overflow.contentWidth, 832);
});

test("126 offers retain individually readable bars on desktop and phone", () => {
  for (const viewport of [250, 720, 1100, 1600]) {
    const layout = getPriceChartLayout(126, viewport);
    assert.equal(layout.contentWidth, 4032);
    assert.equal(layout.barWidth, 20);
    assert.equal(layout.slotWidth - layout.barWidth, 12);
    const firstLeft = layout.slotWidth / 2 - layout.barWidth / 2;
    const lastRight = 125.5 * layout.slotWidth + layout.barWidth / 2;
    assert.ok(firstLeft >= 0);
    assert.ok(lastRight <= layout.contentWidth);
    assert.ok(layout.maxScroll > 0);
  }
});

test("capacity follows the available width, including fractional CSS pixels", () => {
  for (const width of [250, 719.5, 800, 1119.9, 1600]) {
    const capacity = Math.floor(width / 32);
    assert.equal(getPriceChartLayout(capacity, width).maxScroll, 0);
    assert.ok(getPriceChartLayout(capacity + 1, width).maxScroll > 0);
  }
});

test("small histories fill their viewport without oversized bars", () => {
  for (const count of [0, 1, 5]) {
    const layout = getPriceChartLayout(count, 800);
    assert.equal(layout.contentWidth, 800);
    assert.equal(layout.maxScroll, 0);
    assert.ok(layout.barWidth <= 42);
  }
  assert.deepEqual(getPriceChartWindow(getPriceChartLayout(0, 800), 0, 0), {
    scrollLeft: 0, first: 0, last: 0,
  });
});

test("the last scroll position reaches the last offer without blank space", () => {
  const layout = getPriceChartLayout(126, 800);
  assert.deepEqual(getPriceChartWindow(layout, 126, 0), { scrollLeft: 0, first: 1, last: 25 });
  assert.deepEqual(getPriceChartWindow(layout, 126, 320), { scrollLeft: 320, first: 11, last: 35 });
  assert.deepEqual(getPriceChartWindow(layout, 126, 1e6), { scrollLeft: 3232, first: 102, last: 126 });
  assert.equal(getPriceChartWindow(layout, 126, -100).scrollLeft, 0);
});

test("resizing and filtering clamp the viewport back into valid content", () => {
  const narrow = getPriceChartLayout(30, 320);
  assert.equal(narrow.maxScroll, 640);
  const wider = getPriceChartLayout(30, 800);
  assert.deepEqual(getPriceChartWindow(wider, 30, 640), { scrollLeft: 160, first: 6, last: 30 });
  const fitting = getPriceChartLayout(30, 1000);
  assert.deepEqual(getPriceChartWindow(fitting, 30, 640), { scrollLeft: 0, first: 1, last: 30 });
  const filtered = getPriceChartLayout(3, 320);
  assert.deepEqual(getPriceChartWindow(filtered, 3, 640), { scrollLeft: 0, first: 1, last: 3 });
});

test("date labels retain enough spacing across long histories", () => {
  for (const count of [1, 10, 30, 126, 1000]) {
    const layout = getPriceChartLayout(count, 800);
    assert.ok(layout.labelStep * layout.slotWidth >= 72);
  }
});
