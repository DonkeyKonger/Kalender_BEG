import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PAYROLL_CUTOVER_DATE,
  payrollBusinessDateIso,
} from "../src/lib/payrollMonth.ts";

const page = readFileSync(new URL("../src/pages/PersonsPage.tsx", import.meta.url), "utf8");
const personTypes = readFileSync(new URL("../src/types/person.ts", import.meta.url), "utf8");

test("hours-account bookings default to the Europe/Berlin business date", () => {
  assert.equal(payrollBusinessDateIso(new Date("2026-09-02T21:59:59Z")), "2026-09-02");
  assert.equal(payrollBusinessDateIso(new Date("2026-09-02T22:00:00Z")), "2026-09-03");
});

test("manual adjustments and payouts require a post-cutover effective date", () => {
  assert.equal(PAYROLL_CUTOVER_DATE, "2026-08-01");
  assert.match(personTypes, /PersonHoursManualAdjustmentPayload[\s\S]*?effective_date: string;/);
  assert.match(personTypes, /PersonHoursPayoutPayload[\s\S]*?effective_date: string;/);
  assert.match(page, /useState\(\(\) => payrollBusinessDateIso\(\)\)/);
  assert.match(page, /Fachliches Wirksamkeitsdatum \*[\s\S]*?min=\{PAYROLL_CUTOVER_DATE\}[\s\S]*?required[\s\S]*?type="date"/s);
  assert.match(page, /effectiveDate < PAYROLL_CUTOVER_DATE[\s\S]*?darf nicht vor dem 01\.08\.2026 liegen/s);
  assert.match(page, /createPersonHoursManualAdjustment[\s\S]*?effective_date: effectiveDate/s);
  assert.match(page, /createPersonHoursPayout[\s\S]*?effective_date: effectiveDate/s);
});

test("locked-month conflicts keep the backend's actionable message", () => {
  assert.match(page, /function readHoursAccountMutationError[\s\S]*?error\.status === 409[\s\S]*?return error\.message/s);
  assert.match(page, /catch \(requestError\)[\s\S]*?setError\(readHoursAccountMutationError\(requestError\)\)/s);
});

test("the hours-account log distinguishes business date and ledger source", () => {
  assert.match(personTypes, /PersonHoursAccountEntry[\s\S]*?ledger_system: string;[\s\S]*?effective_date: string \| null;[\s\S]*?source_type: string \| null;/s);
  assert.match(page, /entry\.effective_date[\s\S]*?Wirksam am \$\{formatIsoDate\(entry\.effective_date\)\}[\s\S]*?Gebucht am/s);
  assert.match(page, /Quelle: Legacy-Buchung/);
  assert.match(page, /Quelle: Monatsabschluss/);
  assert.match(page, /Quelle: Wochenabschluss/);
  assert.match(page, /Quelle: Manuelle Korrektur/);
  assert.match(page, /Quelle: Auszahlung/);
  assert.match(page, /entry\.effective_date \? <small>Erfasst am \{formatHoursAccountDate\(entry\.created_at\)\}<\/small> : null/);
});
