import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getMeasurementNavigationTarget } from "../src/lib/measurementTableNavigation.ts";

const cells = [
  { row: 0, column: 1 }, { row: 0, column: 2 },
  { row: 1, column: 1 }, { row: 1, column: 2 },
  { row: 2, column: 1 }, { row: 2, column: 2 },
  // Row 3 contains labels only. Column 3 has no editable input.
  { row: 4, column: 0 }, { row: 4, column: 1 }, { row: 4, column: 2 }, { row: 4, column: 4 },
  { row: 5, column: 0 }, { row: 5, column: 1 }, { row: 5, column: 2 },
];
for (const [key, expected] of [
  ["ArrowLeft", { row: 4, column: 0 }], ["ArrowRight", { row: 4, column: 2 }],
  ["ArrowUp", { row: 2, column: 1 }], ["ArrowDown", { row: 5, column: 1 }],
]) {
  test(`${key} navigates to the nearest editable cell on the same axis`, () => {
    assert.deepEqual(getMeasurementNavigationTarget(cells, { row: 4, column: 1 }, key), expected);
  });
}
test("skips non-editable cells and never wraps at edges", () => {
  assert.deepEqual(getMeasurementNavigationTarget(cells, { row: 4, column: 2 }, "ArrowRight"), { row: 4, column: 4 });
  assert.equal(getMeasurementNavigationTarget(cells, { row: 4, column: 4 }, "ArrowRight"), undefined);
  assert.equal(getMeasurementNavigationTarget(cells, { row: 0, column: 1 }, "ArrowUp"), undefined);
  assert.equal(getMeasurementNavigationTarget(cells, { row: 5, column: 2 }, "ArrowDown"), undefined);
  assert.equal(getMeasurementNavigationTarget(cells, { row: 4, column: 0 }, "ArrowLeft"), undefined);
});
test("selection does not reorder the supplied cells", () => {
  const original = JSON.stringify(cells);
  getMeasurementNavigationTarget(cells, { row: 4, column: 2 }, "ArrowUp");
  assert.equal(JSON.stringify(cells), original);
});
test("table delegates unhandled keys while preserving suggestion and text-editing shortcuts", () => {
  const page = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
  const helper = readFileSync(new URL("../src/lib/measurementTableNavigation.ts", import.meta.url), "utf8");
  assert.match(page, /onKeyDown=\{\(event\) => navigateMeasurementTable\(event.nativeEvent, event.currentTarget\)\}/);
  assert.match(helper, /event.defaultPrevented \|\| event.isComposing/);
  for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) assert.ok(helper.includes(`event.${modifier}`));
  assert.match(helper, /:not\(\[disabled\]\):not\(\[readonly\]\)/);
  assert.match(helper, /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
});
