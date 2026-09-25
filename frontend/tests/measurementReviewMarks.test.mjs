import assert from "node:assert/strict";
import test from "node:test";
import { measurementReviewMarksKey, measurementReviewCellKey, readMeasurementReviewMarks, writeMeasurementReviewMarks, toggleMeasurementReviewMark, paintMeasurementReviewMarks } from "../src/lib/measurementReviewMarks.ts";

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test("cache is isolated per user, site and measurement", () => {
  const keys = [[1,2,3],[2,2,3],[1,3,3],[1,2,4]].map(args => measurementReviewMarksKey(...args));
  assert.equal(new Set(keys).size, 4);
  assert.equal(measurementReviewMarksKey(undefined, 2, 3), null);
  const cache = storage();
  const marks = new Set([measurementReviewCellKey("area:eg", "item-7")]);
  writeMeasurementReviewMarks(cache, keys[0], marks);
  assert.deepEqual(readMeasurementReviewMarks(cache, keys[0]), marks);
  for (const key of keys.slice(1)) assert.equal(readMeasurementReviewMarks(cache, key).size, 0);
});

test("second right click removes a mark and empty caches are removed", () => {
  const cache = storage(), marks = new Set(), key = measurementReviewCellKey("description", "item-8");
  toggleMeasurementReviewMark(marks, key);
  writeMeasurementReviewMarks(cache, "batch", marks);
  assert.deepEqual([...readMeasurementReviewMarks(cache, "batch")], [key]);
  toggleMeasurementReviewMark(marks, key);
  writeMeasurementReviewMarks(cache, "batch", marks);
  assert.equal(cache.getItem("batch"), null);
});

test("corrupt or unavailable storage never prevents review", () => {
  for (const value of ["{", "null", "{}", '[null, 42, "invalid", "{}"]']) {
    assert.equal(readMeasurementReviewMarks({getItem: () => value}, "x").size, 0);
  }
  const denied = {getItem(){throw Error();},setItem(){throw Error();},removeItem(){throw Error();}};
  assert.equal(readMeasurementReviewMarks(denied, "x").size, 0);
  assert.doesNotThrow(() => writeMeasurementReviewMarks(denied, "x", new Set(["mark"])));
  assert.doesNotThrow(() => writeMeasurementReviewMarks(denied, "x", new Set()));
});

function table(columns, rowKeys) {
  return {
    querySelectorAll: () => columns.map(key => ({dataset:{reviewColumn:key}})),
    rows: rowKeys.map(key => ({dataset:{reviewRow:key},cells:columns.map((_,cellIndex) => ({cellIndex,dataset:{}}))})),
  };
}

test("all cell kinds including empty, header and total cells paint independently", () => {
  const rows = ["position", "description", "unit", "section", "area:eg", "area:placeholder-area-1", "total"];
  const columns = ["axis", "item-7", "office-extra-column-1", "placeholder-column-1"];
  const grid = table(columns, rows);
  const marks = new Set(rows.map(row => measurementReviewCellKey(row, "item-7")));
  marks.add(measurementReviewCellKey("area:placeholder-area-1", "placeholder-column-1"));
  paintMeasurementReviewMarks(grid, marks);
  assert.equal(grid.rows.flatMap(row => row.cells).filter(cell => cell.dataset.reviewMarked === "true").length, 8);
  assert.equal(grid.rows[0].cells[0].dataset.reviewMarked, undefined);
  paintMeasurementReviewMarks(grid, new Set());
  assert.ok(grid.rows.every(row => row.cells.every(cell => !cell.dataset.reviewMarked)));
});

test("reordered rows and columns retain semantic cells, never their old screen coordinates", () => {
  const mark = measurementReviewCellKey("area:og", "item-8");
  const grid = table(["axis", "item-8", "item-7"], ["area:og", "area:eg"]);
  paintMeasurementReviewMarks(grid, new Set([mark]));
  assert.equal(grid.rows[0].cells[1].dataset.reviewMarked, "true");
  assert.equal(grid.rows[1].cells[2].dataset.reviewMarked, undefined);
  assert.notEqual(measurementReviewCellKey("a:b", "c"), measurementReviewCellKey("a", "b:c"));
});
