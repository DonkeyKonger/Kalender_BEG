import assert from "node:assert/strict";
import test from "node:test";
import { absencePayrollMonths, absenceRangeLock, isAbsencePayrollLockError, ABSENCE_PAYROLL_LOCK_MESSAGE } from "../src/lib/absencePayrollLock.ts";
const statuses = {
  "2026-07": { year: 2026, month: 7, status: "OPEN", approved_person_ids: [] },
  "2026-08": { year: 2026, month: 8, status: "OPEN", approved_person_ids: [3] },
  "2026-09": { year: 2026, month: 9, status: "OPEN", approved_person_ids: [] },
};
const range = { person_id: 3, start_date: "2026-08-01", end_date: "2026-08-31" };
test("an approval locks only that person's month and reopening enables editing", () => {
  assert.equal(absenceRangeLock(statuses, range), "locked");
  assert.equal(absenceRangeLock(statuses, { ...range, person_id: 4 }), null);
  assert.equal(absenceRangeLock({ ...statuses, "2026-08": { ...statuses["2026-08"], approved_person_ids: [] } }, range), null);
});
test("global month closure locks every person", () => {
  assert.equal(absenceRangeLock({ ...statuses, "2026-08": { ...statuses["2026-08"], status: "LOCKED" } }, { ...range, person_id: 4 }), "locked");
});
test("ranges include middle months and year boundaries", () => {
  assert.equal(absenceRangeLock(statuses, { ...range, start_date: "2026-07-31", end_date: "2026-09-01" }), "locked");
  assert.deepEqual(absencePayrollMonths("2026-11-30", "2027-02-01"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
});
test("missing or mismatched status never enables mutation", () => {
  assert.equal(absenceRangeLock({}, range), "unknown");
  assert.equal(absenceRangeLock({ "2026-08": { ...statuses["2026-08"], month: 9 } }, range), "unknown");
  assert.equal(absenceRangeLock({ "2026-08": { ...statuses["2026-08"], approved_person_ids: undefined } }, range), "unknown");
  assert.equal(absenceRangeLock(statuses, { ...range, start_date: "", end_date: "" }), "unknown");
  assert.deepEqual(absencePayrollMonths("2026-13-01", "2027-01-01"), []);
});
test("both API conflict scopes use the requested accounting notice", () => {
  assert.equal(isAbsencePayrollLockError({ code: "payroll_month_locked" }), true);
  assert.equal(isAbsencePayrollLockError({ code: "payroll_person_month_locked" }), true);
  assert.equal(isAbsencePayrollLockError({ code: "other" }), false);
  assert.equal(isAbsencePayrollLockError(null), false);
  assert.equal(ABSENCE_PAYROLL_LOCK_MESSAGE, "Abrechnungsmonat bereits abgeschlossen, bitte Rücksprache mit der Buchhaltung, damit Fehlzeiten der Vergangenheit angepasst werden können");
});
