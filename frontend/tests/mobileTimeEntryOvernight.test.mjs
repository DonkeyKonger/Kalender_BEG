import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyOvernightStatusToWorkDate,
  buildOvernightStatusPayload,
  DEFAULT_OVERNIGHT_STATUS,
  resolveOvernightStatusForWorkDate,
} from "../src/lib/overnightStatus.ts";


const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MobileTimeEntryPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

const entry = (overrides = {}) => ({
  id: 1,
  person_id: 7,
  work_date: "2026-08-17",
  overnight_status: null,
  ...overrides,
});


test("new and historical work days default explicitly to no overnight stay", () => {
  assert.equal(DEFAULT_OVERNIGHT_STATUS, "none");
  assert.equal(resolveOvernightStatusForWorkDate({ entries: [], workDate: "2026-08-17" }), "none");
  assert.equal(resolveOvernightStatusForWorkDate({
    entries: [entry()],
    workDate: "2026-08-17",
  }), "none");
});


test("a persisted same-day status is restored and a previous day is never inherited", () => {
  const entries = [entry({ overnight_status: "self_paid" })];
  assert.equal(resolveOvernightStatusForWorkDate({ entries, workDate: "2026-08-17" }), "self_paid");
  assert.equal(resolveOvernightStatusForWorkDate({ entries, workDate: "2026-08-18" }), "none");
});


test("saving one entry updates the status shown by every entry of that person and day", () => {
  const first = entry({ id: 1, overnight_status: "self_paid" });
  const second = entry({ id: 2, overnight_status: "self_paid" });
  const otherDay = entry({ id: 3, work_date: "2026-08-18", overnight_status: "none" });
  const saved = entry({ id: 2, overnight_status: "beg_paid" });

  const updated = applyOvernightStatusToWorkDate([first, second, otherDay], saved);

  assert.deepEqual(updated.map((item) => item.overnight_status), ["beg_paid", "beg_paid", "none"]);
});


test("the dialog uses one native radio group with the three stable values", () => {
  for (const value of ["none", "self_paid", "beg_paid"]) {
    assert.match(pageSource, new RegExp(`value: "${value}"`));
  }
  assert.match(pageSource, /name="overnight-status"/);
  assert.match(pageSource, /type="radio"/);
  assert.match(pageSource, /checked=\{isSelected\}/);
  assert.match(pageSource, /buildOvernightStatusPayload\(isTravelTimeEntry, overnightStatus\)/);
});


test("work entries send the selected overnight status and travel entries omit it", () => {
  for (const overnightStatus of ["none", "self_paid", "beg_paid"]) {
    assert.deepEqual(buildOvernightStatusPayload(false, overnightStatus), {
      overnight_status: overnightStatus,
    });
    assert.deepEqual(buildOvernightStatusPayload(true, overnightStatus), {});
  }
});


test("the overnight choices render only outside the travel-time mode", () => {
  assert.match(
    pageSource,
    /\{sheetMode !== "travel" \? \(\s*<fieldset className="mobile-time-overnight">/,
  );

  const openTravelStart = pageSource.indexOf("function openTravelTimeEntry()");
  const openTravelEnd = pageSource.indexOf("function closeTimeEntrySheet()", openTravelStart);
  assert.doesNotMatch(pageSource.slice(openTravelStart, openTravelEnd), /initializeOvernightStatus/);
});


test("the refreshed dialog removes legacy gross and suggestion copy and stays responsive", () => {
  const dialogStart = pageSource.indexOf('className="mobile-project-email-dialog mobile-time-sheet mobile-modal-scroll-region"');
  const dialogEnd = pageSource.indexOf("{isBreakPickerOpen", dialogStart);
  const dialogSource = pageSource.slice(dialogStart, dialogEnd);
  assert.doesNotMatch(dialogSource, /Zeiten vom letzten Eintrag vorgeschlagen/);
  assert.doesNotMatch(dialogSource, />Brutto</);
  assert.doesNotMatch(dialogSource, /Arbeitszeit netto/);
  assert.match(dialogSource, />Pause</);
  assert.match(dialogSource, />Arbeitszeit</);
  assert.match(styles, /\.mobile-time-summary \{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /@media \(max-width: 350px\) \{[\s\S]*?\.mobile-time-summary \{[^}]*grid-template-columns:\s*1fr/s);
});
