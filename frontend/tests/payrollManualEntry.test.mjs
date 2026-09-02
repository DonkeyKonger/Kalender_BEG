import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildPayrollManualEntryPayload,
  isTravelOnlyPayrollEntry,
  OFFICE_ONLY_TIME_ENTRY_NOTE,
} from "../src/lib/payrollTimeCorrection.ts";
import { formatGermanDateKey, formatGermanWeekdayShort } from "../src/lib/formatters.ts";

const validDraft = {
  work_date: "2026-08-03",
  site_id: "72",
  start_time: "08:00",
  end_time: "17:00",
  break_minutes: "60",
  hours: "999,00",
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

test("travel-only classification excludes normal work and office-only placeholder entries", () => {
  const sharedEntry = {
    end_time: "16:00",
    has_manual_entry: true,
    id: 42,
    is_gps_suggestion: false,
    note: null,
    start_time: "08:00",
  };

  assert.equal(isTravelOnlyPayrollEntry({ ...sharedEntry, work_minutes: 0, travel_minutes: 45 }), true);
  assert.equal(isTravelOnlyPayrollEntry({ ...sharedEntry, work_minutes: 30, travel_minutes: 45 }), false);
  assert.equal(isTravelOnlyPayrollEntry({ ...sharedEntry, work_minutes: 0, travel_minutes: 45, note: OFFICE_ONLY_TIME_ENTRY_NOTE }), false);
});

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

test("manual payload always uses the calculated total instead of a supplied hours value", () => {
  const result = build({ ...validDraft, hours: "7,50" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.work_minutes, 480);
});

test("manual payload applies the shared pause and quarter-hour calculation", () => {
  const result = build({
    ...validDraft,
    start_time: "06:05",
    end_time: "14:03",
    break_minutes: "0",
    hours: "0,25",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.start_time, "06:05");
  assert.equal(result.payload.end_time, "14:03");
  assert.equal(result.payload.work_minutes, 480);
});

test("manual payload supports overnight work and rejects incomplete time bases", () => {
  const overnight = build({
    ...validDraft,
    start_time: "22:00",
    end_time: "06:00",
    break_minutes: "30",
    hours: "99,00",
  });
  assert.equal(overnight.ok, true);
  if (overnight.ok) {
    assert.equal(overnight.payload.work_minutes, 450);
  }

  const incomplete = build({ ...validDraft, end_time: "" });
  assert.deepEqual(incomplete, {
    ok: false,
    field: "time",
    error: "Bitte Beginn, Ende und Pause vollständig eintragen.",
  });
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
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const createStart = source.indexOf('timeReviewDialogMode === "create" ? (');
  const editStart = source.indexOf('aria-label="Arbeitszeit-Diagnosewerte"', createStart);
  const weekSiteCellStart = source.indexOf('<div className="time-review-week-site" role="cell">');
  const weekSiteCellEnd = source.indexOf('</div>', weekSiteCellStart);

  assert.match(source, /type TimeReviewDialogMode = "create" \| "edit"/);
  assert.match(source, /setTimeReviewDialogMode\("create"\)/);
  assert.match(source, /setTimeReviewDialogMode\(entry\.id < 0 \? "create" : "edit"\)/);
  assert.match(
    source,
    /timeReviewDialogMode === "create" \|\| timeReviewDiagnosticEntry\.id < 0/,
  );
  assert.match(source, /"Zeit manuell eintragen" : "Arbeitszeit manuell anpassen"/);
  assert.match(source, /id="payroll-manual-site-label">Baustelle \*<\/span>/);
  assert.match(source, /searchPlaceholder="Nummer, Name oder Ort suchen…"/);
  assert.match(source, /className="icon-button secondary time-review-diagnostic-cancel"[\s\S]*?onClick=\{closeTimeReviewDiagnostic\}[\s\S]*?>[\s\S]*?Abbrechen/);
  assert.match(source, /className="icon-button time-review-diagnostic-save"/);
  assert.match(source, /<form[\s\S]*?id="payroll-manual-time-entry-form"[\s\S]*?onSubmit=\{submitPayrollManualTimeEntry\}/);
  assert.match(source, /function submitPayrollManualTimeEntry\(event: FormEvent<HTMLFormElement>\): void \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?void savePayrollTimeCorrection\(\);/);
  assert.match(source, /form=\{timeReviewDialogMode === "create" \? "payroll-manual-time-entry-form" : undefined\}/);
  assert.match(source, /type=\{timeReviewDialogMode === "create" \? "submit" : "button"\}/);
  assert.doesNotMatch(source, /Aus Anfang, Ende und Pause berechnet\.|Gesamtstunden werden aus Beginn, Ende und Pause automatisch berechnet\./);
  assert.match(styles, /\.time-review-diagnostic-popover\.is-create \{[^}]*width: min\(780px, calc\(100vw - 32px\)\);/s);
  assert.match(styles, /\.time-review-manual-context \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*align-items: start;/s);
  assert.match(styles, /\.time-review-manual-context > div,[\s\S]*?grid-template-rows: 14px 36px;/s);
  assert.match(styles, /\.time-review-manual-context strong \{[^}]*min-height: 36px;[^}]*border: 1px solid #cbd5e1;/s);
  assert.match(styles, /\.time-review-manual-site-field \{[^}]*background: #ffffff;[^}]*padding: 12px 14px;/s);
  assert.match(styles, /\.time-review-manual-time-grid \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[^}]*gap: 0;[^}]*background: #ffffff;/s);
  assert.match(styles, /\.time-review-manual-time-grid label \{[^}]*grid-template-rows: 14px 36px;[^}]*border-left: 1px solid #e2e8f0;[^}]*background: transparent;/s);
  assert.match(styles, /\.time-review-manual-time-grid label:first-child \{[^}]*border-left: 0;/s);
  assert.match(styles, /\.time-review-manual-time-grid input \{[^}]*min-height: 36px;[^}]*height: 36px;[^}]*border-radius: 0;/s);
  assert.doesNotMatch(styles, /\.time-review-diagnostic-popover\.is-create \.time-review-diagnostic-head/);
  assert.doesNotMatch(styles, /\.time-review-manual-site-field \{[^}]*border-left:/s);
  assert.match(styles, /\.time-review-diagnostic-save,[\s\S]*?\.time-review-diagnostic-cancel \{[^}]*box-sizing: border-box;[^}]*height: 34px;[^}]*min-height: 34px;[^}]*border-radius: 0;[^}]*padding: 6px 12px;/s);
  assert.match(styles, /\.time-review-diagnostic-save \{[^}]*background: #1763c5;/s);
  assert.match(styles, /\.time-review-diagnostic-cancel \{[^}]*border: 1px solid #cbd7e6;[^}]*background: #ffffff;[^}]*color: #243348;/s);
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace \.time-review-diagnostic-cancel \{[^}]*border-radius: 0;/s);
  assert.match(styles, /@media \(max-width: 480px\) \{[\s\S]*?\.time-review-manual-time-grid \{[^}]*grid-template-columns: 1fr;/s);
  assert.ok(createStart >= 0);
  assert.ok(editStart > createStart);
  assert.doesNotMatch(source.slice(createStart, editStart), /Mobile Erfassung|GPS-Erfassung|Büroerfassung/);
  assert.doesNotMatch(source.slice(createStart, editStart), /Fahrtzeit \(Min\.\)|payrollManualTravelMinutes/);
  assert.match(source, /site_id: payrollManualSiteId,[\s\S]*?travel_minutes: "0",[\s\S]*?work_date: payrollManualWorkDate,/);
  assert.doesNotMatch(source, /setPayrollManualTravelMinutes|payrollManualTravelMinutes/);
  const calculatedTotalStart = source.indexOf('<span>Gesamtstunden</span>', createStart);
  const calculatedTotalEnd = source.indexOf("</label>", calculatedTotalStart);
  assert.ok(calculatedTotalStart > createStart);
  assert.ok(calculatedTotalEnd > calculatedTotalStart);
  const calculatedTotalSource = source.slice(calculatedTotalStart, calculatedTotalEnd);
  assert.match(calculatedTotalSource, /value=\{payrollManualTimeCalculation\.status === "valid" \? payrollManualTimeCalculation\.formattedHours : "–"\}/);
  assert.match(calculatedTotalSource, /readOnly/);
  assert.doesNotMatch(calculatedTotalSource, /onChange|payrollCorrectionForm\.hours/);
  assert.doesNotMatch(calculatedTotalSource, /aria-describedby|<small|Aus Anfang, Ende und Pause berechnet/);
  assert.match(source.slice(editStart), /timeReviewDiagnosticRows\(timeReviewDiagnosticEntry\)/);
  assert.match(source, /await api\.createTimeEntry\(result\.payload\)/);
  assert.match(source, /closeTimeReviewDiagnostic\(\)/);
  assert.match(
    source,
    /setPayrollManualSiteId\(timeReviewDialogMode === "create" \? "" : String\(timeReviewDiagnosticEntry\.site_id \?\? ""\)\)/,
  );
  assert.ok(weekSiteCellStart >= 0);
  assert.ok(weekSiteCellEnd > weekSiteCellStart);
  assert.match(source.slice(weekSiteCellStart, weekSiteCellEnd), /timeReviewSiteName\(check\.entry\)/);
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
