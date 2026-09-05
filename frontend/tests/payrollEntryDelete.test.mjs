import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("payroll row menu deletes the selected database entry by stable id", () => {
  assert.match(pageSource, /className="time-review-day-delete-action"/);
  assert.match(pageSource, /openPayrollDeleteDialog\(payrollDatePickerEntry\)/);
  assert.match(pageSource, /deleteTimeEntryFromPayrollReview\(payrollDeleteDialog\.entry\.id\)/);
  assert.match(apiSource, /`\/time-entries\/\$\{entryId\}\/payroll`[\s\S]*method: "DELETE"/);
});

test("payroll delete uses confirmation, failure handling and reviewed-week reset state", () => {
  assert.match(pageSource, /role="alertdialog"/);
  assert.match(pageSource, /Diese Monteurwoche wurde bereits geprüft/);
  assert.match(pageSource, /Stundenkonto wird erst beim Monatsabschluss aktualisiert/);
  assert.doesNotMatch(pageSource, /Stundenkonto-Buchung neutralisiert/);
  assert.match(pageSource, /setPayrollDeleteError\(readApiError\(requestError, "Zeiteintrag konnte nicht gelöscht werden\."\)\)/);
  assert.match(pageSource, /result\.weekly_review_reset/);
  assert.match(pageSource, /resetMatchingWeeklyReview/);
});

test("delete action stays inside the compact row menu", () => {
  assert.match(styles, /\.time-review-day-move-popover \.time-review-day-delete-action/);
  assert.match(styles, /\.time-review-delete-dialog/);
  assert.doesNotMatch(pageSource, /role="columnheader">Löschen/);
});
