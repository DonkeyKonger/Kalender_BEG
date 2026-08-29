import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyOvernightStatusToWorkDate,
  getOvernightStatusPresentation,
  summarizeOvernightStatuses,
} from "../src/lib/overnightStatus.ts";


const [componentSource, controlSource, pageSource, apiSource, styles] = await Promise.all([
  readFile(new URL("../src/components/OvernightStatusIndicator.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/PayrollOvernightStatusControl.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);


test("payroll overnight states keep their payer badge and accessible meaning", () => {
  assert.deepEqual(getOvernightStatusPresentation("none"), {
    badge: null,
    label: "Keine Übernachtung",
    tone: "none",
  });
  assert.deepEqual(getOvernightStatusPresentation("self_paid"), {
    badge: "MA",
    label: "Übernachtung – Hotel vom Monteur bezahlt",
    tone: "self-paid",
  });
  assert.deepEqual(getOvernightStatusPresentation("beg_paid"), {
    badge: "BEG",
    label: "Übernachtung – Hotel durch BEG bezahlt",
    tone: "beg-paid",
  });
  assert.deepEqual(getOvernightStatusPresentation(null), {
    badge: null,
    label: "Übernachtungsstatus nicht erfasst",
    tone: "none",
  });
  assert.deepEqual(
    {
      badge: getOvernightStatusPresentation(null).badge,
      tone: getOvernightStatusPresentation(null).tone,
    },
    {
      badge: getOvernightStatusPresentation("none").badge,
      tone: getOvernightStatusPresentation("none").tone,
    },
  );
});


test("the indicator keeps payer text inside the bed square while no overnight stays visually empty", () => {
  assert.match(componentSource, /import \{ BedDouble \} from "lucide-react"/);
  assert.match(componentSource, /aria-label=\{label\}/);
  assert.match(componentSource, /title=\{label\}/);
  assert.match(componentSource, /role="img"/);
  assert.match(componentSource, /time-review-overnight-bed/);
  assert.match(componentSource, /if \(presentation\.tone === "none"\) \{[\s\S]*?className=\{`time-review-overnight-indicator is-\$\{presentation\.tone\}`\}[\s\S]*?\/>/);
  assert.doesNotMatch(componentSource, /presentation\.marker/);
  assert.match(componentSource, /time-review-overnight-payer-strip/);
  assert.match(componentSource, /\{presentation\.badge\}/);
  assert.doesNotMatch(componentSource, /time-review-overnight-badge/);
  assert.doesNotMatch(componentSource, /🏨|🛏|💶|🧾/);
});


test("the day header shows one overnight editor and time rows contain no overnight cell", () => {
  const tableStart = pageSource.indexOf('className="time-review-week-check-table"');
  const tableEnd = pageSource.indexOf("{payrollDatePicker &&", tableStart);
  const tableSource = pageSource.slice(tableStart, tableEnd);

  assert.ok(tableStart >= 0);
  assert.ok(tableEnd > tableStart);
  assert.match(
    tableSource,
    /<span role="columnheader" aria-label="Baustelle" title="Baustelle">[\s\S]*?<span className="time-review-column-label-full">Baustelle<\/span>[\s\S]*?<span role="columnheader" aria-label="Montagebeginn" title="Montagebeginn">/,
  );
  assert.doesNotMatch(tableSource, /aria-label="Übernachtung" title="Übernachtung"/);
  assert.match(tableSource, /<PayrollOvernightStatusControl/);
  assert.match(tableSource, /editable=\{canManageTimeEntries && !selectedReviewWorker\.isReviewed\}/);
  assert.match(tableSource, /hasConflict=\{day\.hasOvernightStatusConflict\}/);
  assert.match(tableSource, /status=\{day\.overnightStatus\}/);
  assert.match(tableSource, /className="time-review-day-group-summary"/);
  assert.doesNotMatch(tableSource, /time-review-week-overnight/);
  assert.doesNotMatch(tableSource, /colSpan/);
  assert.match(pageSource, /summarizeOvernightStatuses\(dayEntries\.map\(\(entry\) => entry\.overnight_status\)\)/);
  assert.doesNotMatch(tableSource, /api\.timeEntryDayStatus/);
});


test("a mixed legacy day is surfaced as a conflict instead of choosing one payer", () => {
  assert.deepEqual(summarizeOvernightStatuses(["self_paid", "self_paid", null]), {
    status: "self_paid",
    hasConflict: false,
  });
  assert.deepEqual(summarizeOvernightStatuses(["self_paid", "beg_paid", null]), {
    status: null,
    hasConflict: true,
  });
  assert.deepEqual(summarizeOvernightStatuses([null, undefined]), {
    status: null,
    hasConflict: false,
  });
  assert.match(componentSource, /Widersprüchliche Übernachtungszuordnungen – bitte prüfen/);
  assert.match(componentSource, /is-conflict/);
  assert.match(controlSource, /hasConflict = false/);
});


test("the desktop table reserves a compact type column after removing the repeated overnight column", () => {
  assert.match(
    styles,
    /\.time-review-week-check-head,[\s\S]*?grid-template-columns:[^;]*minmax\(72px, 0\.65fr\) minmax\(66px, 0\.5fr\) minmax\(140px, 1\.35fr\) repeat\(4,/,
  );
  assert.match(styles, /\.time-review-week-check-(?:head|row)[\s\S]*?min-width:\s*924px/);
  assert.match(styles, /\.time-review-overnight-marker\s*\{[\s\S]*?border-radius:\s*2px/);
  assert.match(styles, /\.time-review-overnight-bed\s*\{[\s\S]*?border-radius:\s*2px/);
  assert.match(styles, /\.time-review-overnight-bed\s*\{[^}]*position:\s*relative;[^}]*width:\s*var\(--time-review-overnight-symbol-width\);[^}]*height:\s*28px;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.time-review-overnight-payer-strip\s*\{[^}]*position:\s*absolute;[^}]*right:\s*1px;[^}]*bottom:\s*1px;[^}]*left:\s*1px;[^}]*height:\s*12px;[^}]*border-top:\s*1px solid;[^}]*font-size:\s*0\.5rem;/s);
  assert.match(styles, /\.time-review-overnight-indicator\.is-self-paid \.time-review-overnight-payer-strip\s*\{[^}]*border-color:\s*rgb\(79 125 88 \/ 36%\);[^}]*background:\s*rgb\(143 184 150 \/ 54%\);[^}]*color:\s*#14532d;/s);
  assert.match(styles, /\.time-review-overnight-indicator\.is-beg-paid \.time-review-overnight-payer-strip\s*\{[^}]*border-color:\s*rgb\(151 112 48 \/ 34%\);[^}]*background:\s*rgb\(215 180 115 \/ 55%\);[^}]*color:\s*#6b4f15;/s);
  assert.doesNotMatch(styles, /\.time-review-overnight-badge/);
});


test("all payroll overnight states share one axis and align in the day header", () => {
  assert.match(styles, /--time-review-overnight-status-width:\s*55px/);
  assert.match(styles, /--time-review-overnight-symbol-width:\s*29px/);
  assert.match(styles, /\.time-review-day-group-summary\s*\{[^}]*--time-review-weekday-label-inline-size:\s*80px;[^}]*display:\s*inline-grid;[^}]*grid-template-columns:\s*var\(--time-review-weekday-label-inline-size\) max-content;[^}]*align-items:\s*center;[^}]*column-gap:\s*7px/s);
  assert.match(styles, /\.time-review-day-group-weekday\s*\{[^}]*inline-size:\s*var\(--time-review-weekday-label-inline-size\);/s);
  assert.match(
    styles,
    /\.time-review-overnight-indicator\s*\{[^}]*width:\s*var\(--time-review-overnight-status-width\);[^}]*height:\s*28px;[^}]*align-items:\s*flex-end;[^}]*justify-content:\s*flex-start/s,
  );
  assert.match(styles, /\.time-review-overnight-marker\s*\{[^}]*width:\s*var\(--time-review-overnight-symbol-width\);[^}]*height:\s*28px;[^}]*flex:\s*0 0 var\(--time-review-overnight-symbol-width\)/s);
  assert.match(styles, /\.time-review-overnight-bed\s*\{[^}]*width:\s*var\(--time-review-overnight-symbol-width\);[^}]*height:\s*28px;[^}]*flex:\s*0 0 var\(--time-review-overnight-symbol-width\)/s);
  assert.match(styles, /\.time-review-overnight-payer-strip\s*\{[^}]*right:\s*1px;[^}]*bottom:\s*1px;[^}]*left:\s*1px;[^}]*height:\s*12px;/s);
  assert.match(styles, /\.time-review-overnight-indicator\.is-conflict \.time-review-overnight-marker\s*\{[^}]*background:\s*#fff4d6/s);
  assert.doesNotMatch(styles, /\.time-review-overnight-indicator[^}]*transform:/s);
  assert.equal(styles.includes(["is", "unknown"].join("-")), false);
});


test("open payroll weeks expose one portal-based three-option overnight menu", () => {
  for (const status of ["none", "self_paid", "beg_paid"]) {
    assert.match(controlSource, new RegExp(`status: "${status}"`));
  }
  assert.match(controlSource, /if \(!editable\) \{\s*return <OvernightStatusIndicator status=\{status\} hasConflict=\{hasConflict\} \/>/);
  assert.match(controlSource, /aria-haspopup="menu"/);
  assert.match(controlSource, /role="menuitemradio"/);
  assert.match(controlSource, /aria-checked=\{isSelected\}/);
  assert.match(controlSource, /resolveViewportPopoverPosition/);
  assert.match(controlSource, /createPortal\(/);
  assert.match(controlSource, /event\.key === "Escape"/);
  assert.match(controlSource, /window\.addEventListener\("pointerdown", closeOnPointerDown\)/);
  assert.match(controlSource, /window\.addEventListener\("scroll", closeOnViewportChange, true\)/);
});


test("opening the overnight menu never saves, while an active option selection does", () => {
  const toggleStart = controlSource.indexOf("function togglePopover()");
  const selectStart = controlSource.indexOf("async function selectStatus", toggleStart);
  const renderStart = controlSource.indexOf("if (!editable)", selectStart);

  assert.ok(toggleStart >= 0);
  assert.ok(selectStart > toggleStart);
  assert.ok(renderStart > selectStart);
  assert.doesNotMatch(controlSource.slice(toggleStart, selectStart), /onChange/);
  assert.match(controlSource.slice(selectStart, renderStart), /await onChange\(nextStatus\)/);
  assert.match(controlSource.slice(selectStart, renderStart), /if \(nextStatus === status\)/);
});


test("a saved payroll day status updates every same-person same-day row", () => {
  const entries = [
    { id: 1, person_id: 7, work_date: "2026-08-19", overnight_status: "beg_paid" },
    { id: 2, person_id: 7, work_date: "2026-08-19", overnight_status: "beg_paid" },
    { id: 3, person_id: 7, work_date: "2026-08-20", overnight_status: "none" },
    { id: 4, person_id: 8, work_date: "2026-08-19", overnight_status: "none" },
  ];
  const updated = applyOvernightStatusToWorkDate(entries, {
    person_id: 7,
    work_date: "2026-08-19",
    overnight_status: "self_paid",
  });

  assert.deepEqual(updated.map((entry) => entry.overnight_status), ["self_paid", "self_paid", "none", "none"]);
  assert.match(pageSource, /setReviewEntries\(\(current\) => applyOvernightStatusToWorkDate\(current, savedDay\)\)/);
  assert.match(pageSource, /setReviewAllEntries\(\(current\) => applyOvernightStatusToWorkDate\(current, savedDay\)\)/);
});


test("the payroll day API is dedicated, permission-backed and reloads canonical state after failures", () => {
  assert.match(apiSource, /setTimeEntryDayOvernightStatus/);
  assert.match(apiSource, /request<PersonWorkDay>\(`\/time-entries\/day-status\?\$\{search\.toString\(\)\}`/);
  assert.match(apiSource, /method: "PATCH"/);
  assert.match(pageSource, /api\.setTimeEntryDayOvernightStatus/);
  assert.match(pageSource, /Promise\.allSettled\(\[/);
  assert.match(pageSource, /api\.timeEntryDayStatus\(\{ personId, workDate \}\)/);
  assert.match(pageSource, /api\.timeEntryWeeklyReviews\(/);
  assert.match(pageSource, /setReviewWeeklyReviews\(weeklyReviewsResult\.value\)/);
});


test("the compact overnight editor keeps its header geometry", () => {
  assert.match(styles, /\.time-review-overnight-trigger\s*\{[^}]*width:\s*var\(--time-review-overnight-status-width\);[^}]*height:\s*28px/s);
  assert.match(styles, /\.time-review-overnight-popover\s*\{[^}]*min-width:\s*250px/s);
  assert.match(styles, /\.time-review-overnight-popover button\s*\{[^}]*grid-template-columns:\s*var\(--time-review-overnight-status-width\) minmax\(0, 1fr\) 14px/s);
});
