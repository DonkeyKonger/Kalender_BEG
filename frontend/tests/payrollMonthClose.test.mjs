import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatSignedHoursMinutes,
  parseSignedHoursMinutes,
  payrollMonthFilename,
  suggestWeekdayMinutes,
  sumWeekdayMinutes,
} from "../src/lib/payrollMonth.ts";

const page = readFileSync(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
const setup = readFileSync(new URL("../src/components/PayrollSetupDialog.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("month lock is server controlled and reopening requires a reason", () => {
  assert.match(api, /payrollMonthPeriod[\s\S]*?\/payroll-months\/\$\{params\.year\}\/\$\{params\.month\}/s);
  assert.match(api, /lockPayrollMonth[\s\S]*?\/lock[\s\S]*?confirmed: true/s);
  assert.match(api, /reopenPayrollMonth[\s\S]*?\/reopen[\s\S]*?reason: params\.reason/s);
  assert.match(page, /checked=\{isPayrollMonthLocked\}[\s\S]*?onChange=\{\(\) => setPayrollMonthDialog\(isPayrollMonthLocked \? "reopen" : "lock"\)\}/s);
  assert.match(page, /const updatedPeriod = await api\.lockPayrollMonth[\s\S]*?setPayrollMonthPeriod\(updatedPeriod\)/s);
  assert.match(page, /payrollMonthReopenReason\.trim\(\)[\s\S]*?api\.reopenPayrollMonth/s);
  assert.match(page, /Begründung \*[\s\S]*?disabled=\{isUpdatingPayrollMonth \|\| \(payrollMonthDialog === "reopen" && !payrollMonthReopenReason\.trim\(\)\)\}/s);
  assert.match(page, /`Monat \$\{formatPayrollMonthLabel\(selectedEvaluationMonth\)\} abschließen\?`/);
  assert.match(page, /`Monat \$\{formatPayrollMonthLabel\(selectedEvaluationMonth\)\} wieder öffnen\?`/);
  assert.match(page, /Monat verbindlich abschließen/);
});

test("locked months disable editing and exports use the immutable snapshot version", () => {
  assert.match(page, /arePayrollMonthExportsAvailable = isPayrollMonthLocked[\s\S]*?artifacts_ready/s);
  assert.match(page, /canManageTimeEntries=\{canManageTimeEntries && !isPayrollMonthLocked\}/);
  assert.match(page, /version: payrollMonthVersion/);
  assert.match(page, /Der Monat kann noch bearbeitet werden\./);
  assert.match(page, /Monat abgeschlossen – Änderungen gesperrt/);
  assert.equal(
    payrollMonthFilename("Lohnabrechnung_2026_08_Test", {
      year: 2026,
      month: 8,
      status: "LOCKED",
      snapshot_id: 1,
      snapshot_version: 3,
      locked_at: null,
      locked_by_name: null,
      can_lock: false,
      can_reopen: true,
      artifacts_ready: true,
      blockers: [],
    }),
    "Lohnabrechnung_2026_08_Test_v3.xlsx",
  );
});

test("setup suggestion stays editable and must match weekly hours before confirmation", () => {
  assert.deepEqual(suggestWeekdayMinutes(40), [480, 480, 480, 480, 480, 0, 0]);
  assert.deepEqual(suggestWeekdayMinutes(36), [432, 432, 432, 432, 432, 0, 0]);
  assert.equal(sumWeekdayMinutes([600, 600, 600, 600, 0, 0, 0]), 2400);
  assert.match(setup, /Vorausgefüllter Vorschlag – noch nicht verbindlich/);
  assert.match(setup, /weeklySumMatches[\s\S]*?Wochenplan bestätigen/s);
  assert.match(setup, /worker\.plan\?\.is_confirmed[\s\S]*?disabled/s);
});

test("positive and negative opening balances roundtrip as integer minutes", () => {
  assert.equal(parseSignedHoursMinutes("+18:30"), 1110);
  assert.equal(parseSignedHoursMinutes("-01:30"), -90);
  assert.equal(parseSignedHoursMinutes("0:00"), 0);
  assert.equal(parseSignedHoursMinutes("1:75"), null);
  assert.equal(formatSignedHoursMinutes(1110), "+18:30");
  assert.equal(formatSignedHoursMinutes(-90), "−01:30");
  assert.match(setup, /effective_date: PAYROLL_OPENING_BALANCE_DATE[\s\S]*?minutes,[\s\S]*?confirm: true/s);
});

test("month close and setup geometry remains locally scoped and square", () => {
  assert.match(styles, /\.payroll-month-lock-box\s*\{[^}]*border-radius:\s*0;/s);
  assert.match(styles, /\.payroll-month-dialog\s*\{[^}]*border-radius:\s*0;/s);
  assert.match(styles, /\.payroll-setup-dialog\s*\{[^}]*border-radius:\s*0;/s);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.payroll-setup-worker\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
});
