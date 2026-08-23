import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { formatGermanDayMonth } from "../src/lib/formatters.ts";
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
  assert.equal(getIsoWeeksInYear(2026), 53);
  assert.deepEqual(getIsoWeekRange(2026, 53), { start: "2026-12-28", end: "2027-01-03" });
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
  assert.match(pageSource, /placeholder="z\. B\. 681"/);
  assert.doesNotMatch(pageSource, /placeholder="z\. B\. A-B-5-5\.1"/);
  assert.match(pageSource, /placeholder="z\. B\. 1-2 \/ A-B"/);
  assert.match(pageSource, /placeholder="z\. B\. Beschreibung der Arbeiten, Besonderheiten \.\.\."/);
  assert.match(pageSource, /placeholder="z\. B\. 2x Stiel US 5 bis 500"/);
  assert.match(pageSource, /className="mobile-extra-work-location-label">Bauteil/);
  assert.match(pageSource, /mobile-extra-work-location-input\$\{form\.component\.trim\(\) \? " is-filled" : ""\}/);
  assert.match(styles, /\.mobile-extra-work-location-input \{[^}]*min-height:\s*48px;[^}]*border:\s*1px solid/s);
  assert.match(styles, /\.mobile-extra-work-location-input:focus-within \{[^}]*border-color:\s*#4f83c2;[^}]*box-shadow:/s);
});

test("invalid daily hours stay visible, explain the limit and block saving", () => {
  assert.match(pageSource, /getExtraWorkRowDailyHoursError\(row, day\)/);
  assert.match(pageSource, /aria-invalid=\{Boolean\(validationError\)\}/);
  assert.match(pageSource, /mobile-extra-work-hours-error/);
  assert.match(pageSource, /Bitte ungültige Tagesstunden korrigieren\./);
  assert.match(pageSource, /disabled=\{isSaving \|\| !canEdit \|\| hasInvalidDailyHours\}/);
  assert.match(styles, /label\.is-invalid \.mobile-extra-work-hours-input input \{[^}]*border-color:\s*#c2414f/s);
});

test("mobile execution week persists through the existing typed details endpoint", () => {
  const entrySource = pageSource.slice(
    pageSource.indexOf("function ExtraWorkEntryPage"),
    pageSource.indexOf("function OverviewPanel"),
  );
  assert.match(entrySource, /order\.manual_execution_week_year \?\? automaticWeek\.isoYear/);
  assert.match(entrySource, /order\.manual_execution_week \?\? automaticWeek\.week/);
  assert.match(entrySource, /setSelectedWeek\(nextWeek\)/);
  assert.match(entrySource, /api\.updateMobileExtraWorkTicketDetails\(assignmentId, order\.id/);
  assert.match(entrySource, /await api\.saveMobileExtraWorkTicketEntry[\s\S]*const executionWeekChanged[\s\S]*api\.updateMobileExtraWorkTicketDetails/);
  assert.match(entrySource, /manual_execution_week: usesAutomaticWeek \? null : selectedWeek\.week/);
  assert.match(entrySource, /manual_execution_week_year: usesAutomaticWeek \? null : selectedWeek\.isoYear/);
  assert.match(entrySource, /onOrderUpdated\(updatedOrder\)/);
  assert.match(entrySource, /getIsoWeeksInYear\(visibleYear\)/);
  assert.doesNotMatch(entrySource, /function persistExecutionWeek/);
});

test("changing week protects only unsaved hour input with an explicit confirmation", () => {
  assert.match(pageSource, /getExtraWorkHoursFingerprint\(form\.worker_rows\) !== savedHoursFingerprint/);
  assert.match(pageSource, /if \(hasUnsavedHours\) \{[\s\S]*setPendingWeek\(nextWeek\)/);
  assert.match(pageSource, />Kalenderwoche ändern\?</);
  assert.match(pageSource, /Bereits eingegebene, noch nicht gespeicherte Stunden beziehen sich auf die aktuelle KW\./);
  assert.match(pageSource, />Abbrechen<\/button>/);
  assert.match(pageSource, /"KW ändern"/);
});

test("week picker centers its relevant week only on open and real year changes", () => {
  const dialogSource = pageSource.slice(
    pageSource.indexOf("function ExtraWorkWeekPickerDialog"),
    pageSource.indexOf("function ExtraWorkWeekChangeConfirmDialog"),
  );
  assert.match(dialogSource, /const scrollContainerRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(dialogSource, /const scrollTargetRef = useRef<HTMLButtonElement>\(null\)/);
  assert.match(dialogSource, /getExtraWorkWeekPickerTargetWeek\(selectedWeek, visibleYear\)/);
  assert.match(dialogSource, /useLayoutEffect\(\(\) => \{[\s\S]*scrollContainer\.scrollTop = Math\.min\(Math\.max\(centeredScrollTop, 0\), maxScrollTop\);[\s\S]*\}, \[scrollTargetWeek, visibleYear\]\)/);
  assert.match(dialogSource, /ref=\{scrollContainerRef\}\s*className="mobile-extra-work-week-options mobile-modal-scroll-region"/);
  assert.match(dialogSource, /ref=\{week === scrollTargetWeek \? scrollTargetRef : undefined\}/);
  assert.match(dialogSource, /isValidExtraWorkIsoWeek\(selectedWeek\) \? selectedWeek\.week : currentWeek\.week/);
  assert.match(dialogSource, /getIsoWeekInfo\(toDateInputValue\(new Date\(\)\)\)/);
  assert.match(dialogSource, /Math\.min\(sourceWeek, getIsoWeeksInYear\(visibleYear\)\)/);
  assert.doesNotMatch(dialogSource, /scrollIntoView|behavior:\s*"smooth"|setTimeout/);
  assert.match(styles, /\.mobile-extra-work-week-dialog \{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\);[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.mobile-extra-work-week-options \{[^}]*min-height:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior-y:\s*contain;/s);
});

test("mobile performance entry has sticky back navigation and narrow touch-safe grids", () => {
  assert.match(pageSource, /<nav className="mobile-extra-work-sticky-nav"[\s\S]*<MobileBackButton label="Zurück zum Stundenzettel" onClick=\{requestBack\} \/>\s*<h1>\{isApproval \? "Stundenfreigabe erfassen" : "Leistungen erfassen"\}<\/h1>/);
  assert.match(pageSource, /<header className="mobile-extra-work-entry-header-card">\s*<h2 className="mobile-extra-work-entry-title">\{formatMobileExtraWorkEntrySubtitle\(order\)\}<\/h2>/);
  assert.doesNotMatch(pageSource, /mobile-extra-work-sticky-nav[\s\S]{0,300}className="icon-button secondary mobile-back-button"/);
  assert.match(styles, /\.mobile-extra-work-sticky-nav \{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*display:\s*grid;[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);/s);
  assert.match(styles, /\.mobile-personal-file-header h1,\s*\.mobile-extra-work-sticky-nav h1 \{[^}]*font-size:\s*1\.36rem;[^}]*line-height:\s*1\.15;/s);
  assert.match(styles, /\.mobile-extra-work-entry-title \{[^}]*font-size:\s*1\.15rem;[^}]*font-weight:\s*850;/s);
  assert.doesNotMatch(styles, /\.mobile-extra-work-sticky-nav \.mobile-back-button/);
  assert.match(styles, /\.mobile-extra-work-location-grid \{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
  assert.match(styles, /\.mobile-extra-work-week-grid \{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/s);
  assert.match(styles, /\.mobile-extra-work-week-button \{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /@media \(max-width: 375px\)[\s\S]*\.mobile-extra-work-week-grid/s);
});

test("extra-work fields expose stable empty, filled and focus states", () => {
  for (const field of ["component", "floor", "room_number", "axis"]) {
    assert.match(pageSource, new RegExp(`mobile-extra-work-location-input\\$\\{form\\.${field}\\.trim\\(\\) \\? " is-filled" : ""\\}`));
  }
  assert.match(pageSource, /className=\{form\.remarks\.trim\(\) \? "is-filled" : undefined\}/);
  assert.match(pageSource, /mobile-extra-work-material-quick-input\$\{materialQuickInput\.trim\(\) \? " is-filled" : ""\}/);
  assert.match(styles, /\.mobile-extra-work-location-input\.is-filled \{[^}]*border-color:[^}]*background:/s);
  assert.match(styles, /\.mobile-extra-work-location-input\.is-filled \.mobile-extra-work-location-icon \{[^}]*background:[^}]*color:/s);
  assert.match(styles, /\.mobile-extra-work-text-card textarea\.is-filled \{[^}]*border-color:[^}]*background:/s);
  assert.match(styles, /\.mobile-extra-work-material-quick-input\.is-filled input \{[^}]*border-color:[^}]*background:/s);
  assert.doesNotMatch(styles, /\.mobile-extra-work-location-input\.is-filled \{[^}]*(?:border-width|transform):/s);
  assert.match(styles, /\.mobile-extra-work-location-input:focus-within \{[^}]*border-color:\s*#4f83c2;[^}]*box-shadow:/s);
});

test("material quick rows stay local, editable and backward compatible", () => {
  const entrySource = pageSource.slice(
    pageSource.indexOf("function ExtraWorkEntryPage"),
    pageSource.indexOf("function ExtraWorkWeekPickerDialog"),
  );
  assert.match(entrySource, /parseExtraWorkMaterialInput\(materialQuickInput\)/);
  assert.match(entrySource, /material_items: \[\.\.\.current\.material_items, \{ id: createClientRowId\(\), \.\.\.parsed \}\]/);
  assert.match(entrySource, /<div className="mobile-extra-work-material-list">[\s\S]*<div className=\{`mobile-extra-work-material-quick-input/);
  assert.match(entrySource, /window\.requestAnimationFrame\(keepMaterialQuickInputActive\)/);
  assert.match(entrySource, /focus\(\{ preventScroll: true \}\)/);
  assert.match(entrySource, /ref=\{materialQuickInputRef\}[\s\S]*?autoCapitalize="characters"[\s\S]*?autoCorrect="off"[\s\S]*?spellCheck=\{false\}/);
  assert.equal((entrySource.match(/autoCapitalize="characters"/g) ?? []).length, 1);
  assert.doesNotMatch(entrySource, /materialQuickInput[^\n]*\.toUpperCase\(/);
  assert.match(entrySource, /scrollIntoView\(\{ block: "nearest", inline: "nearest", behavior: "auto" \}\)/);
  assert.match(entrySource, /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(entrySource, /startEditingMaterial\(item\)/);
  assert.match(entrySource, /removeMaterialItem\(item\.id\)/);
  assert.match(entrySource, /material_items: materialItems\.map/);
  assert.match(entrySource, />Bisherige Materialangaben</);
  assert.doesNotMatch(entrySource, /mobile-extra-work-add-material|>Material hinzufügen<|focusMaterialQuickInput/);
  assert.doesNotMatch(styles, /\.mobile-extra-work-add-material/);
  assert.doesNotMatch(entrySource, /api\.[A-Za-z]+\([^\n]*materialQuickInput/);
});

test("hours use one-time select-all and a continuous Monday-to-Sunday keyboard flow", () => {
  const entrySource = pageSource.slice(
    pageSource.indexOf("function ExtraWorkEntryPage"),
    pageSource.indexOf("function ExtraWorkWeekPickerDialog"),
  );
  assert.match(entrySource, /function selectHoursInput[\s\S]*document\.activeElement === input[\s\S]*input\.select\(\)/);
  assert.match(entrySource, /enterKeyHint=\{day\.key === "sunday_hours" \? "done" : "next"\}/);
  assert.match(entrySource, /handleHoursInputKeyDown\(event, row\.id, day\.key\)/);
  assert.match(entrySource, /hoursInputRefs\.current\.get\(`\$\{rowId\}:\$\{nextDay\.key\}`\)\?\.focus\(\)/);
  assert.match(entrySource, /if \(!nextDay\) \{[\s\S]*event\.currentTarget\.blur\(\)/);
  assert.doesNotMatch(entrySource, /handleHoursInputKeyDown[\s\S]{0,900}(?:saveEntry|type="submit")/);
});

test("dirty tracking warns only for changed form content and never after successful close", () => {
  const entrySource = pageSource.slice(
    pageSource.indexOf("function ExtraWorkEntryPage"),
    pageSource.indexOf("function OverviewPanel"),
  );
  assert.match(entrySource, /setSavedEntryFingerprint\(getExtraWorkEntryFingerprint\(nextForm, loadedExecutionWeek\)\)/);
  assert.match(entrySource, /currentEntryFingerprint !== savedEntryFingerprint[\s\S]*materialQuickInput\.trim\(\)[\s\S]*hasExtraWorkMaterialEditChanges/);
  assert.match(entrySource, /function requestBack\(\)[\s\S]*if \(hasUnsavedChanges\)[\s\S]*setIsDiscardConfirmOpen\(true\)[\s\S]*onBack\(\)/);
  assert.match(entrySource, />Änderungen verwerfen\?</);
  assert.match(entrySource, />Abbrechen<\/button>[\s\S]*>Verwerfen<\/button>/);
  assert.match(entrySource, /await onSaved\(\)/);
  assert.match(pageSource, /setIsEditingEntry\(false\)[\s\S]*setMessage\("Leistungen gespeichert\."\)/);
});

test("remarks autosize only from content and week choices expose ISO date ranges", () => {
  assert.equal(formatGermanDayMonth("2026-08-17"), "17.08.");
  assert.equal(formatGermanDayMonth("2026-08-23"), "23.08.");
  assert.match(pageSource, /useLayoutEffect\(\(\) => \{[\s\S]*resizeExtraWorkRemarksTextarea\(remarksTextareaRef\.current\)[\s\S]*\}, \[form\.remarks, isLoading\]\)/);
  assert.match(pageSource, /rows=\{2\}/);
  assert.match(pageSource, /formatGermanDayMonth\(range\.start\)[\s\S]*formatGermanDayMonth\(range\.end\)/);
  assert.match(styles, /\.mobile-extra-work-text-card textarea \{[^}]*height:\s*56px;[^}]*min-height:\s*56px;[^}]*max-height:\s*118px;/s);
  assert.match(styles, /\.mobile-extra-work-week-options button small \{[^}]*white-space:\s*nowrap/s);
  assert.match(styles, /\.mobile-extra-work-entry-header-meta \.measurement-status \{[^}]*font-size:\s*0\.72rem/s);
});

test("save stays in normal form flow without keyboard positioning", () => {
  const entrySource = pageSource.slice(
    pageSource.indexOf("function ExtraWorkEntryPage"),
    pageSource.indexOf("function ExtraWorkWeekPickerDialog"),
  );
  assert.match(entrySource, /<form[\s\S]*<div className="mobile-form-actions">[\s\S]*type="submit"[\s\S]*\{isSaving \? "Speichert\.\.\." : "Speichern"\}/);
  assert.match(entrySource, /await api\.saveMobileExtraWorkTicketEntry[\s\S]*await onSaved\(\)/);
  assert.match(pageSource, /onSaved=\{async \(\) => \{[\s\S]*await api\.mobileExtraWorkTicket[\s\S]*setIsEditingEntry\(false\)/);
  assert.match(entrySource, /catch \(requestError\) \{[\s\S]*setError\(readApiError/);
  assert.match(styles, /\.mobile-extra-work-entry-page \.mobile-form-actions \{[^}]*position:\s*static;[^}]*bottom:\s*auto;[^}]*z-index:\s*auto;[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.mobile-extra-work-entry-page \{[^}]*padding-bottom:\s*max\(14px, env\(safe-area-inset-bottom, 0px\)\);/s);
  assert.match(styles, /\.mobile-extra-work-entry-page \.mobile-extra-work-form input,[\s\S]*font-size:\s*1rem;/s);
  assert.doesNotMatch(entrySource, /mobile-extra-work-save-dock|visualViewport|keyboard-offset|ensureActiveInputVisible|onFocusCapture/);
  assert.doesNotMatch(styles, /mobile-extra-work-save-dock|--mobile-extra-work-keyboard-offset|\.mobile-extra-work-entry-page::after/);
});

test("mobile extra-work inputs avoid iOS focus zoom without locking viewport accessibility", () => {
  assert.match(indexHtml, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
  assert.doesNotMatch(indexHtml, /user-scalable=no|maximum-scale=1/);
  assert.match(styles, /\.mobile-extra-work-entry-page \.mobile-extra-work-form input,[\s\S]*\.mobile-extra-work-entry-page \.mobile-extra-work-form textarea,[\s\S]*font-size:\s*1rem;/s);
  assert.match(styles, /\.mobile-extra-work-text-card textarea \{[^}]*height:\s*56px;[^}]*min-height:\s*56px;/s);
  assert.match(styles, /\.mobile-measurement-form \.mobile-extra-work-location-input:focus-within \{[^}]*border-color:[^}]*box-shadow:/s);
  assert.doesNotMatch(styles, /\.mobile-measurement-form \.mobile-extra-work-location-input:focus-within \{[^}]*transform:/s);
});
