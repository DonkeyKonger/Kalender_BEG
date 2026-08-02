import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPayrollTimeBasisChange,
  calculatePayrollTime,
} from "../src/lib/payrollTimeCorrection.ts";


test("payroll correction calculates hours from start, end and pause", () => {
  const result = calculatePayrollTime({
    start_time: "05:30",
    end_time: "17:30",
    break_minutes: "60",
  });

  assert.deepEqual(result, {
    status: "valid",
    minutes: 660,
    formattedHours: "11,00",
  });
});


test("payroll correction calculates overnight shifts", () => {
  const result = calculatePayrollTime({
    start_time: "22:00",
    end_time: "06:00",
    break_minutes: "30",
  });

  assert.deepEqual(result, {
    status: "valid",
    minutes: 450,
    formattedHours: "7,50",
  });
});


test("manual total remains until a time basis field changes again", () => {
  const manualDraft = {
    start_time: "05:30",
    end_time: "17:30",
    break_minutes: "60",
    hours: "10,75",
  };

  assert.equal(manualDraft.hours, "10,75");
  assert.equal(
    applyPayrollTimeBasisChange(manualDraft, "break_minutes", "30").hours,
    "11,50",
  );
});


test("incomplete and implausible time bases are not calculated", () => {
  assert.deepEqual(
    calculatePayrollTime({ start_time: "05:30", end_time: "", break_minutes: "60" }),
    { status: "incomplete" },
  );
  assert.equal(
    calculatePayrollTime({ start_time: "08:00", end_time: "08:00", break_minutes: "0" }).status,
    "invalid",
  );
  assert.equal(
    calculatePayrollTime({ start_time: "08:00", end_time: "09:00", break_minutes: "60" }).status,
    "invalid",
  );
});
