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
const personsPage = readFileSync(new URL("../src/pages/PersonsPage.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("month lock is server controlled and reopening requires a reason", () => {
  assert.match(api, /payrollMonthPeriod[\s\S]*?\/payroll-months\/\$\{params\.year\}\/\$\{params\.month\}/s);
  assert.match(api, /lockPayrollMonth[\s\S]*?\/lock[\s\S]*?confirmed: true/s);
  assert.match(api, /reopenPayrollMonth[\s\S]*?\/reopen[\s\S]*?reason: params\.reason/s);
  assert.doesNotMatch(page, /api\.lockPayrollMonth|confirmPayrollMonthLock|Gesamtmonat geprüft/);
  assert.match(page, /payrollMonthReopenReason\.trim\(\)[\s\S]*?api\.reopenPayrollMonth/s);
  assert.match(page, /Begründung \*[\s\S]*?disabled=\{isUpdatingPayrollMonth \|\| !payrollMonthReopenReason\.trim\(\)\}/s);
  assert.match(page, /`Monat \$\{formatPayrollMonthLabel\(selectedEvaluationMonth\)\} wieder öffnen\?`/);
  assert.match(page, /isPayrollMonthLocked && canManagePayrollClose &&/);
});

test("locked months disable editing and exports use the immutable snapshot version", () => {
  assert.match(page, /arePayrollMonthExportsAvailable = payrollAllWorkersExportAvailable\(payrollMonthPeriod\)/);
  assert.match(page, /canManageTimeEntries=\{canManageTimeEntries && !isPayrollMonthLocked && !isSelectedPayrollPersonApproved\}/);
  assert.match(page, /version: payrollMonthVersion/);
  assert.match(page, /Monteurmonat geprüft/);
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
  assert.deepEqual(suggestWeekdayMinutes(40), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(suggestWeekdayMinutes(40, [1, 2, 3, 4]), [0, 600, 600, 600, 600, 0, 0]);
  assert.deepEqual(suggestWeekdayMinutes(37.5, [0, 2, 4, 6]), [563, 0, 563, 0, 562, 0, 562]);
  assert.equal(sumWeekdayMinutes([600, 600, 600, 600, 0, 0, 0]), 2400);
  assert.match(setup, /Vorausgefüllter Vorschlag – noch nicht verbindlich/);
  assert.match(setup, /weeklySumMatches[\s\S]*?Wochenplan bestätigen/s);
  assert.match(setup, /worker\.plan\?\.is_confirmed[\s\S]*?disabled/s);
});

test("employee details omit the regular working time editor but preserve independent weekly hours", () => {
  assert.doesNotMatch(personsPage, /PersonRegularWorkingTime|Arbeitszeitmodell|Regelmäßige Arbeitszeit|Arbeitszeit festlegen|person-regular-working-time/);
  assert.doesNotMatch(personsPage, /api\.(?:personRegularWorkingTime|savePersonRegularWorkingTime)\(/);
  assert.doesNotMatch(styles, /person-regular-working-time/);
  assert.match(personsPage, /<PersonDetailField label="Wochenstunden">[\s\S]*?ariaLabel="Wochenstunden bearbeiten"[\s\S]*?displayValue=\{formatWeeklyHours\(person\.weekly_hours\)\}[\s\S]*?onSave=\{\(value\) => onInformationSave\(\{ weekly_hours: parseOptionalDecimal\(value\) \}\)\}/s);
  // The address follows master data directly: no empty section or placeholder remains.
  assert.match(personsPage, /<PersonDetailField label="Fahrzeug">[\s\S]*?<\/PersonDetailField>\s*<\/div>\s*<\/section>\s*<section className="detail-read-section customer-detail-address-section person-detail-address-section">/s);
  // Stored/versioned plans and their API are retained; this is only a UI removal.
  assert.match(api, /personRegularWorkingTime[\s\S]*?\/persons\/\$\{personId\}\/regular-working-time/s);
  assert.match(api, /savePersonRegularWorkingTime[\s\S]*?\/persons\/\$\{personId\}\/regular-working-time/s);
});

test("person approval explicitly acknowledges current hints and always enables its retained export", () => {
  assert.match(api, /acknowledged_blocker_count: params\.acknowledgedBlockerCount/);
  assert.match(page, /Ich habe die offenen Hinweise geprüft und bestätige den aktuellen Stand trotzdem/);
  assert.match(page, /canApproveSelectedPayrollPerson = Boolean\([\s\S]*?selectedPayrollPersonApproval\?\.can_approve[\s\S]*?!isUpdatingPayrollPersonMonth/s);
  assert.match(page, /isExportAvailable=\{Boolean\(selectedPayrollPersonApproval\?\.export_ready\)\}/);
  assert.doesNotMatch(page, /Prüfpunkte verhindern den Abschluss/);
});

test("normal payroll no longer requires or mounts an account setup dialog", () => {
  assert.doesNotMatch(page, /Stundenkonto einrichten|PayrollSetupDialog|isPayrollSetupOpen|payrollMonthPeriodRefreshKey/);
  assert.match(page, /Monteurmonat geprüft/);
  // Existing optional schedule/setup code remains intact, not deleted or migrated.
  assert.match(setup, /Wochenpläne ab 01\.08\.2026 und Eröffnungssalden zum 31\.07\.2026/);
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
  assert.doesNotMatch(styles, /\.payroll-month-lock-(?:box|toggle)/);
  assert.match(styles, /\.payroll-month-dialog\s*\{[^}]*border-radius:\s*0;/s);
  assert.match(styles, /\.payroll-setup-dialog\s*\{[^}]*border-radius:\s*0;/s);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.payroll-setup-worker\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
});

test("person month close reserves a stable desktop row above month navigation", () => {
  assert.match(page, /time-evaluation-main\$\{activeEvaluationSubtab === "workers" \? " has-person-month-close" : ""\}/);
  assert.match(styles, /\.payroll-person-month-close\s*\{[^}]*height:\s*112px;[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 33px;/s);
  assert.match(styles, /\.time-evaluation-main\.has-person-month-close\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\);/s);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*?\.payroll-person-month-close\s*\{[^}]*height:\s*auto;[^}]*grid-template-rows:\s*auto auto;/s);
});

test("person blockers open as an anchored non-layout flyout", () => {
  assert.match(page, /className="payroll-person-month-log-anchor"[\s\S]*?aria-controls="payroll-person-month-log-flyout"[\s\S]*?aria-expanded=\{isLogExpanded\}/s);
  assert.match(page, /className="payroll-person-month-log-flyout"[\s\S]*?aria-label="Prüfpunkte schließen"/s);
  assert.match(page, /event\.key === "Escape"[\s\S]*?onToggleLog\(\)/s);
  assert.match(styles, /\.payroll-person-month-log-flyout\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*30;[^}]*top:\s*100%;[^}]*background:\s*#fffdf7;/s);
  assert.match(styles, /\.payroll-person-month-log-list\s*\{[^}]*max-height:\s*min\(320px, calc\(100dvh - 270px\)\);[^}]*overflow:\s*auto;/s);
});
