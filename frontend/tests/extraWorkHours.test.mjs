import assert from "node:assert/strict";
import test from "node:test";

import {
  formatExtraWorkHours,
  getExtraWorkDailyHoursError,
  getExtraWorkDailyHoursTotalError,
  parseExtraWorkHoursInput,
} from "../src/lib/extraWorkHours.ts";

test("daily extra-work hours accept zero, decimals and the inclusive 24-hour limit", () => {
  ["0", "0,25", "1", "8", "12,5", "24", "24,00", "8.5"].forEach((value) => {
    assert.equal(getExtraWorkDailyHoursError(value), null, value);
  });
});

test("daily extra-work hours reject negative and over-24 values without clamping", () => {
  assert.equal(getExtraWorkDailyHoursError("24,01"), "Maximal 24,00 h pro Tag");
  assert.equal(getExtraWorkDailyHoursError("55"), "Maximal 24,00 h pro Tag");
  assert.equal(getExtraWorkDailyHoursError("-1"), "Mindestens 0,00 h pro Tag");
  assert.equal(parseExtraWorkHoursInput("55"), 55);
  assert.equal(parseExtraWorkHoursInput("-1"), -1);
});

test("the 24-hour limit stays per worker and weekday instead of limiting week totals", () => {
  const oneWorkerWeek = ["20", "20", "20"].map(parseExtraWorkHoursInput);
  const twoWorkersMonday = ["20", "20"].map(parseExtraWorkHoursInput);

  assert.equal(oneWorkerWeek.reduce((sum, hours) => sum + hours, 0), 60);
  assert.equal(twoWorkersMonday.every((hours) => hours <= 24), true);
});

test("existing surcharge hours count toward the same worker-day limit", () => {
  assert.equal(getExtraWorkDailyHoursTotalError([20, 2, 2]), null);
  assert.equal(getExtraWorkDailyHoursTotalError([20, 3, 2]), "Maximal 24,00 h pro Tag");
});

test("extra-work hour displays always use German decimal separators", () => {
  assert.equal(formatExtraWorkHours(60), "60,00");
  assert.equal(formatExtraWorkHours("24.5"), "24,50");
  assert.equal(formatExtraWorkHours(0), "0,00");
});
