import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getOvernightStatusPresentation } from "../src/lib/overnightStatus.ts";


const [componentSource, pageSource, styles] = await Promise.all([
  readFile(new URL("../src/components/OvernightStatusIndicator.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);


test("payroll overnight states keep their compact marker, badge and accessible meaning", () => {
  assert.deepEqual(getOvernightStatusPresentation("none"), {
    badge: null,
    label: "Keine Übernachtung",
    marker: "–",
    tone: "none",
  });
  assert.deepEqual(getOvernightStatusPresentation("self_paid"), {
    badge: "MA",
    label: "Übernachtung – Hotel vom Monteur bezahlt",
    marker: null,
    tone: "self-paid",
  });
  assert.deepEqual(getOvernightStatusPresentation("beg_paid"), {
    badge: "BEG",
    label: "Übernachtung – Hotel durch BEG bezahlt",
    marker: null,
    tone: "beg-paid",
  });
  assert.deepEqual(getOvernightStatusPresentation(null), {
    badge: null,
    label: "Übernachtungsstatus nicht erfasst",
    marker: "?",
    tone: "unknown",
  });
});


test("the indicator uses one bed icon, visible text badges and matching tooltip labels", () => {
  assert.match(componentSource, /import \{ BedDouble \} from "lucide-react"/);
  assert.match(componentSource, /aria-label=\{presentation\.label\}/);
  assert.match(componentSource, /title=\{presentation\.label\}/);
  assert.match(componentSource, /role="img"/);
  assert.match(componentSource, /time-review-overnight-bed/);
  assert.match(componentSource, /\{presentation\.badge\}/);
  assert.doesNotMatch(componentSource, /🏨|🛏|💶|🧾/);
});


test("the narrow ÜN column follows the site and reuses one status for every entry of a day", () => {
  const tableStart = pageSource.indexOf('className="time-review-week-check-table"');
  const tableEnd = pageSource.indexOf("{payrollDatePicker &&", tableStart);
  const tableSource = pageSource.slice(tableStart, tableEnd);

  assert.ok(tableStart >= 0);
  assert.ok(tableEnd > tableStart);
  assert.match(
    tableSource,
    /<span role="columnheader">Baustelle<\/span>\s*<span className="time-review-week-overnight" role="columnheader">ÜN<\/span>\s*<span role="columnheader">Montagebeginn<\/span>/,
  );
  assert.match(tableSource, /<OvernightStatusIndicator status=\{day\.overnightStatus\} \/>/);
  assert.match(tableSource, /className="time-review-week-overnight" role="cell" aria-label="Keine Zeitmeldung"/);
  assert.doesNotMatch(tableSource, /colSpan/);
  assert.match(
    pageSource,
    /const overnightStatus = dayEntries\.find\(\(entry\) => entry\.overnight_status !== null\)\?\.overnight_status \?\? null/,
  );
  assert.doesNotMatch(pageSource, /api\.timeEntryDayStatus/);
});


test("the desktop table reserves one square-edged compact column without changing row semantics", () => {
  assert.match(
    styles,
    /\.time-review-week-check-head,[\s\S]*?grid-template-columns:[^;]*minmax\(140px, 1\.35fr\) 58px repeat\(4,/,
  );
  assert.match(styles, /\.time-review-week-check-(?:head|row)[\s\S]*?min-width:\s*924px/);
  assert.match(styles, /\.time-review-overnight-indicator\.is-none,[\s\S]*?border-radius:\s*2px/);
  assert.match(styles, /\.time-review-overnight-bed\s*\{[\s\S]*?border-radius:\s*2px/);
  assert.match(styles, /\.time-review-overnight-indicator\.is-self-paid \.time-review-overnight-badge\s*\{[^}]*background:\s*#d9f3df/s);
  assert.match(styles, /\.time-review-overnight-indicator\.is-beg-paid \.time-review-overnight-badge\s*\{[^}]*background:\s*#f8d761/s);
});
