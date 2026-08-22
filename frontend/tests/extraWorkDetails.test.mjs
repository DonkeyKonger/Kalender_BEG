import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getIsoWeekInfo, getIsoWeekRange, getIsoWeeksInYear } from "../src/utils/dateRange.ts";

const [pageSource, apiSource, typeSource, styles, indexHtml] = await Promise.all([
  readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/types/site.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
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

test("mobile extra-work rows invisibly roundtrip identity and every desktop surcharge field", () => {
  const hiddenFields = [
    "monday_surcharge_25_hours",
    "tuesday_surcharge_25_hours",
    "wednesday_surcharge_25_hours",
    "thursday_surcharge_25_hours",
    "friday_surcharge_25_hours",
    "saturday_surcharge_25_hours",
    "sunday_surcharge_25_hours",
    "monday_surcharge_50_hours",
    "tuesday_surcharge_50_hours",
    "wednesday_surcharge_50_hours",
    "thursday_surcharge_50_hours",
    "friday_surcharge_50_hours",
    "saturday_surcharge_50_hours",
    "sunday_surcharge_50_hours",
  ];
  const emptyRowSource = pageSource.slice(
    pageSource.indexOf("function createEmptyExtraWorkWorkerRow"),
    pageSource.indexOf("function mapExtraWorkEntryToForm"),
  );
  const loadSource = pageSource.slice(
    pageSource.indexOf("function mapExtraWorkEntryToForm"),
    pageSource.indexOf("function getExtraWorkDefaultWorkerName"),
  );
  const saveSource = pageSource.slice(
    pageSource.indexOf("async function saveEntry"),
    pageSource.indexOf("return (", pageSource.indexOf("async function saveEntry")),
  );
  assert.match(pageSource, /type ExtraWorkWorkerHoursFormRow =[\s\S]*"person_id" \| ExtraWorkHiddenSurchargeKey/);
  assert.match(emptyRowSource, /person_id: null/);
  assert.match(loadSource, /person_id: row\.person_id \?\? null/);
  assert.match(saveSource, /person_id: row\.person_id \?\? null/);
  assert.match(saveSource, /estimated_hours: parseNullableExtraWorkHoursInput\(form\.estimated_hours\)/);
  assert.doesNotMatch(saveSource, /estimated_hours: isApproval \?/);
  hiddenFields.forEach((field) => {
    assert.match(emptyRowSource, new RegExp(`${field}: null`));
    assert.match(loadSource, new RegExp(`${field}: row\\.${field} \\?\\? null`));
    assert.match(saveSource, new RegExp(`${field}: row\\.${field} \\?\\? null`));
  });
  assert.match(pageSource, /worker_rows\.filter\(\(row\) => row\.id !== rowId\)/);
});

test("mobile visible totals include normal, 25-percent and 50-percent hours", () => {
  assert.match(pageSource, /function calculateExtraWorkWorkerTotal[\s\S]*EXTRA_WORK_WEEK_DAYS\.reduce[\s\S]*EXTRA_WORK_HIDDEN_SURCHARGE_KEYS\.reduce[\s\S]*return normalHours \+ hiddenSurchargeHours/);
  assert.match(pageSource, /calculateExtraWorkWorkerTotal\(row\)/);
});

test("mobile performance entry keeps all direct fields in one compact card flow", () => {
  assert.match(pageSource, /className="mobile-extra-work-entry-header-card"/);
  assert.match(pageSource, /formatMobileExtraWorkEntrySubtitle\(order\)/);
  assert.doesNotMatch(pageSource, /<p className="eyebrow">\{kindLabel\}<\/p>[\s\S]{0,120}<h1>\{isApproval \? "Stundenfreigabe erfassen" : "Leistungen erfassen"\}<\/h1>/);
  assert.match(pageSource, />Ort \/ Position</);
  assert.match(pageSource, /placeholder="z\. B\. Halle A"/);
  assert.match(pageSource, /placeholder="z\. B\. EG"/);
  assert.match(pageSource, /placeholder="z\. B\. A-B-5-5\.1"/);
  assert.match(pageSource, /placeholder="z\. B\. 1-2 \/ A-B"/);
  assert.match(pageSource, /placeholder="z\. B\. Beschreibung der Arbeiten, Besonderheiten \.\.\."/);
  assert.match(pageSource, /placeholder="z\. B\. 2x Stiel US 5 bis 500"/);
  assert.match(pageSource, /className="mobile-extra-work-location-label">Bauteil/);
  assert.match(pageSource, /className="mobile-extra-work-location-input"/);
  assert.match(styles, /\.mobile-extra-work-location-input \{[^}]*min-height:\s*48px;[^}]*border:\s*1px solid/s);
  assert.match(styles, /\.mobile-extra-work-location-input:focus-within \{[^}]*border-color:\s*#4f83c2;[^}]*box-shadow:/s);
});

test("invalid daily hours stay visible, explain the limit and block saving", () => {
  assert.match(pageSource, /getExtraWorkRowDailyHoursError\(row, day\)/);
  assert.match(pageSource, /aria-invalid=\{Boolean\(validationError\)\}/);
  assert.match(pageSource, /mobile-extra-work-hours-error/);
  assert.match(pageSource, /Bitte ungültige Tagesstunden korrigieren\./);
  assert.match(pageSource, /disabled=\{isLoading \|\| isSaving \|\| !canEdit \|\| hasInvalidDailyHours\}/);
  assert.match(styles, /label\.is-invalid \.mobile-extra-work-hours-input input \{[^}]*border-color:\s*#c2414f/s);
});

test("mobile execution week persists through the existing typed details endpoint", () => {
  const entrySource = pageSource.slice(
    pageSource.indexOf("function ExtraWorkEntryPage"),
    pageSource.indexOf("function OverviewPanel"),
  );
  assert.match(entrySource, /order\.manual_execution_week_year \?\? automaticWeek\.isoYear/);
  assert.match(entrySource, /order\.manual_execution_week \?\? automaticWeek\.week/);
  assert.match(entrySource, /api\.updateMobileExtraWorkTicketDetails\(assignmentId, order\.id/);
  assert.match(entrySource, /manual_execution_week: usesAutomaticWeek \? null : nextWeek\.week/);
  assert.match(entrySource, /manual_execution_week_year: usesAutomaticWeek \? null : nextWeek\.isoYear/);
  assert.match(entrySource, /onOrderUpdated\(updatedOrder\)/);
  assert.match(entrySource, /getIsoWeeksInYear\(visibleYear\)/);
});

test("changing week protects only unsaved hour input with an explicit confirmation", () => {
  assert.match(pageSource, /getExtraWorkHoursFingerprint\(form\.worker_rows\) !== savedHoursFingerprint/);
  assert.match(pageSource, /if \(hasUnsavedHours\) \{[\s\S]*setPendingWeek\(nextWeek\)/);
  assert.match(pageSource, />Kalenderwoche ändern\?</);
  assert.match(pageSource, /Bereits eingegebene, noch nicht gespeicherte Stunden beziehen sich auf die aktuelle KW\./);
  assert.match(pageSource, />Abbrechen<\/button>/);
  assert.match(pageSource, /"KW ändern"/);
});

test("mobile performance entry has sticky back navigation and narrow touch-safe grids", () => {
  assert.match(pageSource, /<nav className="mobile-extra-work-sticky-nav"[\s\S]*<span>Stundenzettel<\/span>/);
  assert.match(styles, /\.mobile-extra-work-sticky-nav \{[^}]*position:\s*sticky;[^}]*top:\s*0;/s);
  assert.match(styles, /\.mobile-extra-work-location-grid \{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
  assert.match(styles, /\.mobile-extra-work-week-grid \{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/s);
  assert.match(styles, /\.mobile-extra-work-week-button \{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.mobile-extra-work-save-dock \{[^}]*position:\s*fixed;[^}]*bottom:\s*var\(--mobile-extra-work-keyboard-offset, 0px\);/s);
  assert.match(styles, /@media \(max-width: 375px\)[\s\S]*\.mobile-extra-work-week-grid/s);
});

test("material quick rows stay local, editable and backward compatible", () => {
  const entrySource = pageSource.slice(
    pageSource.indexOf("function ExtraWorkEntryPage"),
    pageSource.indexOf("function ExtraWorkWeekPickerDialog"),
  );
  assert.match(entrySource, /parseExtraWorkMaterialInput\(materialQuickInput\)/);
  assert.match(entrySource, /material_items: \[\.\.\.current\.material_items, \{ id: createClientRowId\(\), \.\.\.parsed \}\]/);
  assert.match(entrySource, /startEditingMaterial\(item\)/);
  assert.match(entrySource, /removeMaterialItem\(item\.id\)/);
  assert.match(entrySource, /material_items: materialItems\.map/);
  assert.match(entrySource, />Bisherige Materialangaben</);
  assert.doesNotMatch(entrySource, /api\.[A-Za-z]+\([^\n]*materialQuickInput/);
});

test("save remains fixed above safe areas and visual keyboards", () => {
  const entrySource = pageSource.slice(
    pageSource.indexOf("function ExtraWorkEntryPage"),
    pageSource.indexOf("function ExtraWorkWeekPickerDialog"),
  );
  assert.match(entrySource, /window\.innerHeight - visualViewport\.height - visualViewport\.offsetTop/);
  assert.match(entrySource, /style\.setProperty\(\s*"--mobile-extra-work-keyboard-offset"/);
  assert.match(entrySource, /form="mobile-extra-work-entry-form"/);
  assert.match(entrySource, /await api\.saveMobileExtraWorkTicketEntry[\s\S]*await onSaved\(\)/);
  assert.match(pageSource, /onSaved=\{async \(\) => \{[\s\S]*await api\.mobileExtraWorkTicket[\s\S]*setIsEditingEntry\(false\)/);
  assert.match(entrySource, /catch \(requestError\) \{[\s\S]*setError\(readApiError/);
  assert.match(styles, /\.mobile-extra-work-save-dock \{[^}]*position:\s*fixed;[^}]*env\(safe-area-inset-right[^}]*env\(safe-area-inset-left/s);
  assert.match(styles, /\.mobile-extra-work-entry-page \{[^}]*padding-bottom:\s*calc\(\s*92px\s*\+ env\(safe-area-inset-bottom/s);
  assert.match(styles, /\.mobile-extra-work-entry-page::after \{[^}]*position:\s*absolute;[^}]*height:\s*var\(--mobile-extra-work-keyboard-offset/s);
  assert.match(styles, /\.mobile-extra-work-entry-page \.mobile-extra-work-form input,[\s\S]*font-size:\s*1rem;/s);
  assert.match(entrySource, /ensureActiveInputVisible/);
  assert.match(entrySource, /window\.scrollBy\(\{ top: targetRect\.bottom - safeBottom, behavior: "auto" \}\)/);
  assert.doesNotMatch(entrySource, /scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
  assert.doesNotMatch(entrySource, /setBottomOffset/);
});

test("mobile extra-work inputs avoid iOS focus zoom without locking viewport accessibility", () => {
  assert.match(indexHtml, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
  assert.doesNotMatch(indexHtml, /user-scalable=no|maximum-scale=1/);
  assert.match(styles, /\.mobile-extra-work-entry-page \.mobile-extra-work-form input,[\s\S]*\.mobile-extra-work-entry-page \.mobile-extra-work-form textarea,[\s\S]*font-size:\s*1rem;/s);
  assert.match(styles, /\.mobile-extra-work-text-card textarea \{[^}]*height:\s*76px;[^}]*min-height:\s*76px;/s);
  assert.match(styles, /\.mobile-measurement-form \.mobile-extra-work-location-input:focus-within \{[^}]*border-color:[^}]*box-shadow:/s);
  assert.doesNotMatch(styles, /\.mobile-measurement-form \.mobile-extra-work-location-input:focus-within \{[^}]*transform:/s);
});
