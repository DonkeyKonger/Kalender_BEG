import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getIsoWeekInfo, getIsoWeekRange, getIsoWeeksInYear } from "../src/utils/dateRange.ts";

const [pageSource, apiSource, typeSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/types/site.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("ISO week helpers handle year boundaries and years without week 53", () => {
  assert.deepEqual(getIsoWeekInfo("2024-12-30"), { isoYear: 2025, week: 1 });
  assert.deepEqual(getIsoWeekRange(2025, 1), { start: "2024-12-30", end: "2025-01-05" });
  assert.equal(getIsoWeeksInYear(2025), 52);
  assert.throws(() => getIsoWeekRange(2025, 53), /existiert im ISO-Jahr 2025 nicht/);
});

test("the existing information card opens the compact details dialog without another action tile", () => {
  assert.match(pageSource, /aria-label="Stundenzettel-Details öffnen"/);
  assert.match(pageSource, /onClick=\{\(\) => setIsEditingDetails\(true\)\}/);
  assert.match(pageSource, /function ExtraWorkDetailsDialog/);
  assert.match(pageSource, />Stundenzettel-Details</);
  assert.match(pageSource, />Datum der Auftragserteilung</);
  assert.match(pageSource, />Kalenderwoche der Ausführung</);
  assert.doesNotMatch(pageSource, /mobile-measurement-overview-action[^>]*>[\s\S]{0,250}Stundenzettel-Details/);
});

test("manual values share one typed API update and automatic values are persisted as null", () => {
  assert.match(typeSource, /manual_order_date: string \| null/);
  assert.match(typeSource, /manual_execution_week: number \| null/);
  assert.match(typeSource, /manual_execution_week_year: number \| null/);
  assert.match(apiSource, /updateMobileExtraWorkTicketDetails[\s\S]*\/details/);
  assert.match(pageSource, /manual_order_date: orderDate === automaticOrderDate \? null : orderDate/);
  assert.match(pageSource, /manual_execution_week: usesAutomaticWeek \? null : selectedWeek\.week/);
  assert.match(pageSource, /manual_execution_week_year: usesAutomaticWeek \? null : selectedWeek\.isoYear/);
});

test("customer signature makes details read-only while worker-signed and submitted tickets remain editable", () => {
  assert.match(pageSource, /const canEdit = !order\.customer_signed_at/);
  assert.doesNotMatch(pageSource, /const canEdit = [^\n]*order\.status/);
  assert.match(pageSource, /Nach der Kundenunterschrift können diese Angaben nicht mehr geändert werden/);
});

test("details dialog stays touch-friendly and bounded on phones", () => {
  assert.match(styles, /\.mobile-extra-work-details-dialog \{[^}]*width:\s*min\(92vw, 460px\);[^}]*max-height:\s*min\(86vh, 680px\);[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.mobile-extra-work-details-field input,[\s\S]*min-height:\s*48px/s);
  assert.match(styles, /@media \(max-width: 430px\)[\s\S]*\.mobile-extra-work-details-dialog/s);
});
