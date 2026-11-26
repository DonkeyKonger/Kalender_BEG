import assert from "node:assert/strict";
import test from "node:test";
import { getPriceChartDateLabels, getPriceChartLayout, getPriceChartOfferScroll, getPriceChartWindow } from "../src/priceComparison/chartLayout.ts";

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

test("filtering to short histories retains the same bar width and left-aligned positions", () => {
  for (const count of [0, 1, 2, 5, 9, 25]) {
    const layout = getPriceChartLayout(count, 800);
    assert.equal(layout.contentWidth, 800);
    assert.equal(layout.maxScroll, 0);
    assert.equal(layout.barWidth, 20);
    assert.equal(layout.slotWidth, 32);
    assert.equal(layout.slotWidth / 2 - layout.barWidth / 2, 6);
  }
  assert.deepEqual(getPriceChartWindow(getPriceChartLayout(0, 800), 0, 0), {
    scrollLeft: 0, first: 0, last: 0,
  });
});

test("short bar histories keep dates under the bars without overlapping or jumping to the right edge", () => {
  for (const count of [1, 2, 3, 5, 9, 30, 126]) {
    const layout = getPriceChartLayout(count, 800);
    const labels = getPriceChartDateLabels(layout, count);
    assert.equal(labels[0].index, 0);
    for (const [index, label] of labels.entries()) {
      assert.ok(label.x >= 24 && label.x <= layout.contentWidth - 24);
      assert.ok(label.x < count * layout.slotWidth);
      if (index > 0) assert.ok(label.x - labels[index - 1].x >= 72);
    }
  }
  assert.deepEqual(getPriceChartDateLabels(getPriceChartLayout(0, 800), 0), []);
});

test("line charts retain the spread of points across the available width", () => {
  const layout = getPriceChartLayout(5, 800, "line");
  assert.equal(layout.slotWidth, 160);
  assert.equal(layout.maxScroll, 0);
  assert.deepEqual(getPriceChartDateLabels(layout, 5).map(({ x }) => x), [80, 240, 400, 560, 720]);
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

test("opening a selected offer reveals its bar in long desktop and mobile histories", () => {
  for (const width of [250, 720, 1600]) {
    const layout = getPriceChartLayout(126, width);
    for (const index of [0, 23, 75, 125]) {
      const scroll = getPriceChartOfferScroll(layout, index);
      const visible = getPriceChartWindow(layout, 126, scroll);
      assert.ok(visible.first <= index + 1 && visible.last >= index + 1);
      assert.ok(scroll >= 0 && scroll <= layout.maxScroll);
      const left = (index + .5) * layout.slotWidth - layout.barWidth / 2;
      assert.ok(left >= scroll && left + layout.barWidth <= scroll + width);
    }
  }
});

test("absent, filtered-out, and short-history selections do not create a scroll offset", () => {
  assert.equal(getPriceChartOfferScroll(getPriceChartLayout(126, 720), -1), 0);
  for (const index of [0, 4, 8]) {
    assert.equal(getPriceChartOfferScroll(getPriceChartLayout(9, 720), index), 0);
  }
});
