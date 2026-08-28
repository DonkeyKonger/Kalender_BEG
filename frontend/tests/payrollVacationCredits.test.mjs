import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  payrollWeekPersonsById,
  payrollWeekTotalMinutes,
  vacationCreditMinutesForDate,
} from "../src/lib/payrollWeek.ts";

const vacationWeek = {
  person_id: 17,
  work_minutes: 0,
  vacation_credit_minutes: 2400,
  total_minutes: 2400,
  vacation_days: [
    { work_date: "2026-07-27", vacation_credit_minutes: 480 },
    { work_date: "2026-07-28", vacation_credit_minutes: 480 },
    { work_date: "2026-07-29", vacation_credit_minutes: 480 },
    { work_date: "2026-07-30", vacation_credit_minutes: 480 },
    { work_date: "2026-07-31", vacation_credit_minutes: 480 },
  ],
};

test("serverseitige Urlaubswerte speisen Wochen- und Tagesanzeige", () => {
  const persons = payrollWeekPersonsById([vacationWeek]);

  assert.equal(payrollWeekTotalMinutes(persons.get(17), 0), 2400);
  assert.equal(vacationCreditMinutesForDate(persons.get(17), "2026-07-27"), 480);
  assert.equal(vacationCreditMinutesForDate(persons.get(17), "2026-08-01"), 0);
});

test("bei fehlender Serverzusammenfassung bleibt die bisherige Zeitsumme erhalten", () => {
  assert.equal(payrollWeekTotalMinutes(undefined, 375), 375);
});

test("Stundenprüfung lädt und rendert den serverseitigen Urlaubswert", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");

  assert.match(source, /api\.timeEntryPayrollWeek\(/);
  assert.match(source, /payrollWeekTotalMinutes\(payrollWeekPerson,/);
  assert.match(source, /className=\{`time-review-work-time-cell\$\{hasVacationCredit \? " time-review-week-time" : ""\}`\} role="cell"/);
  assert.match(source, /formatTimeEntryMinutes\(day\.vacationCreditMinutes, "hours"\)/);
  assert.doesNotMatch(source, /vacation[^\n]*480|480[^\n]*vacation/i);
});
