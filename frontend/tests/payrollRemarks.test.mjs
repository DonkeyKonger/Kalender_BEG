import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { payrollRemarksError, wrapPayrollRemarks } from "../src/lib/payrollRemarks.ts";

const fixture = JSON.parse(readFileSync(new URL("../../backend/app/tests/fixtures/payroll_remarks.json", import.meta.url)));
for (const item of fixture.cases) {
  test(`Excel remarks capacity: ${JSON.stringify(item.text).slice(0, 55)}`, () => {
    assert.deepEqual(wrapPayrollRemarks(item.text, fixture.layout), item.lines);
    assert.equal(payrollRemarksError(item.text, fixture.layout) === null, item.valid);
  });
}

test("unsupported controls cannot reach the Excel XML", () => {
  for (const value of ["Text\x00", "Text\ud800", "Text\ufffe"]) {
    assert.ok(payrollRemarksError(value, fixture.layout));
  }
});
