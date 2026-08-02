import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildPayrollManualEntryPayload,
  OFFICE_ONLY_TIME_ENTRY_NOTE,
} from "../src/lib/payrollTimeCorrection.ts";
import { formatGermanDateKey, formatGermanWeekdayShort } from "../src/lib/formatters.ts";

const validDraft = {
  work_date: "2026-08-03",
  site_id: "72",
  start_time: "08:00",
  end_time: "17:00",
  break_minutes: "60",
  hours: "8,00",
  travel_minutes: "30",
};

function build(draft = validDraft) {
  return buildPayrollManualEntryPayload({
    personId: 17,
    draft,
    allowedWorkDates: ["2026-08-03", "2026-08-04"],
    allowedSiteIds: [72, 73],
  });
}

test("manual payroll entry stores the selected stable site id and entered values", () => {
  const result = build();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.payload, {
    person_id: 17,
    site_id: 72,
    assignment_id: null,
    work_date: "2026-08-03",
    start_time: "08:00",
    end_time: "17:00",
    break_minutes: 60,
    travel_minutes: 30,
    work_minutes: 480,
    note: OFFICE_ONLY_TIME_ENTRY_NOTE,
    source: "manual",
    status: "draft",
  });
});

test("manual payroll entry requires a site from the loaded site master", () => {
  const missing = build({ ...validDraft, site_id: "" });
  const unknown = build({ ...validDraft, site_id: "999" });

  assert.deepEqual(missing, {
    ok: false,
    field: "site",
    error: "Bitte eine gültige Baustelle auswählen.",
  });
  assert.deepEqual(unknown, missing);
});

test("manual payroll entry only accepts dates from the open calendar week", () => {
  const result = build({ ...validDraft, work_date: "2026-08-10" });

  assert.equal(result.ok, false);
  assert.equal(result.field, "date");
});

test("manual total is stored even when it overrides the calculated total", () => {
  const result = build({ ...validDraft, hours: "7,50" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.work_minutes, 450);
});

test("invalid pause and negative travel time are rejected", () => {
  const excessivePause = build({ ...validDraft, break_minutes: "540" });
  const negativeTravel = build({ ...validDraft, travel_minutes: "-1" });

  assert.equal(excessivePause.ok, false);
  assert.equal(excessivePause.field, "time");
  assert.equal(negativeTravel.ok, false);
  assert.equal(negativeTravel.field, "travel");
});

test("manual payroll date is German and does not parse through UTC", () => {
  assert.equal(
    `${formatGermanWeekdayShort("2026-08-03")}, ${formatGermanDateKey("2026-08-03", "numeric")}`,
    "Mo, 03.08.2026",
  );
});

test("manual create and existing-entry diagnostics use explicit dialog modes", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
  const createStart = source.indexOf('timeReviewDialogMode === "create" ? (');
  const editStart = source.indexOf('aria-label="Arbeitszeit-Diagnosewerte"', createStart);
  const weekSiteCellStart = source.indexOf('<div className="time-review-week-site" role="cell">');
  const weekSiteCellEnd = source.indexOf('</div>', weekSiteCellStart);

  assert.match(source, /type TimeReviewDialogMode = "create" \| "edit"/);
  assert.match(source, /setTimeReviewDialogMode\("create"\)/);
  assert.match(source, /setTimeReviewDialogMode\("edit"\)/);
  assert.match(source, /"Zeit manuell eintragen" : "Arbeitszeit-Prüfung"/);
  assert.match(source, /id="payroll-manual-site-label">Baustelle \*<\/span>/);
  assert.match(source, /searchPlaceholder="Nummer, Name oder Ort suchen…"/);
  assert.ok(createStart >= 0);
  assert.ok(editStart > createStart);
  assert.doesNotMatch(source.slice(createStart, editStart), /Eingetragene Monteurstunden|Erkannte Handy GPS Stunden/);
  assert.match(source.slice(editStart), /timeReviewDiagnosticRows\(timeReviewDiagnosticEntry\)/);
  assert.match(source, /await api\.createTimeEntry\(result\.payload\)/);
  assert.match(source, /closeTimeReviewDiagnostic\(\)/);
  assert.match(
    source,
    /setPayrollManualSiteId\(timeReviewDialogMode === "create" \? "" : String\(timeReviewDiagnosticEntry\.site_id \?\? ""\)\)/,
  );
  assert.ok(weekSiteCellStart >= 0);
  assert.ok(weekSiteCellEnd > weekSiteCellStart);
  assert.match(source.slice(weekSiteCellStart, weekSiteCellEnd), /timeEntrySiteName\(check\.entry\)/);
  assert.match(source.slice(weekSiteCellStart, weekSiteCellEnd), /check\.entry\.site_number/);
  assert.doesNotMatch(source.slice(weekSiteCellStart, weekSiteCellEnd), /original_site|planned_site|gps_detected/);
  assert.match(source, /key={`\$\{day\.date\}-\$\{check\.entry\.id\}`}/);
});

test("office-created entries display their directly stored times without requiring a later correction", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /return entry\.payroll_corrected_start_time \?\? entry\.start_time;/,
  );
  assert.match(
    source,
    /return entry\.payroll_corrected_end_time \?\? entry\.end_time;/,
  );
  assert.match(
    source,
    /isOfficeOnlyTimeEntry\(entry\) && !hasDirectOfficeTime\(entry\)/,
  );
  assert.match(source, /entry\.payroll_corrected_break_minutes \?\? entry\.break_minutes/);
  assert.match(source, /entry\.work_minutes \+ \(entry\.travel_minutes \|\| 0\)/);
});
