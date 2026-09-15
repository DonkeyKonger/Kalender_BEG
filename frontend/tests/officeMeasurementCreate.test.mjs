import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getMeasurementSuggestionAlignment } from "../src/lib/measurementSuggestionPlacement.ts";

const pageSource = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const overviewSource = readFileSync(new URL("../src/components/MeasurementReviewOverview.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("measurement action menu is heading-free, opens leftwards and offers reversible archiving", () => {
  assert.match(pageSource, /menuLabel="Aufmaßaktionen" menuHeading="" menuAlign="end"/);
  assert.match(pageSource, /menuWidthAnchor="\.measurement-overview-detail-head > div"/);
  assert.match(pageSource, /trigger.closest\(menuWidthAnchor\)\?\.getBoundingClientRect\(\).width/);
  assert.match(pageSource, /width: position.width/);
  assert.match(pageSource, /menuHeading \? <strong>\{menuHeading\}<\/strong> : null/);
  assert.match(pageSource, /archiveMode \? "Wiederherstellen" : "Aufmaß Archivieren"/);
  assert.match(pageSource, /wirklich archivieren\? Das Aufmaß wird ins Archiv verschoben und kann wiederhergestellt werden/);
  assert.match(pageSource, /wurde archiviert\./);
  assert.doesNotMatch(pageSource, /Aufmaß löschen/);
  assert.match(pageSource, /menuAlign === "end" \? rect.right - width : rect.left/);
  assert.match(pageSource, /document.documentElement.clientWidth/);
  assert.match(pageSource, /Math.max\(8, Math.min\(anchorLeft, viewportWidth - width - 8\)\)/);
});

test("desktop measurement creation uses the protected shared measurement endpoint", () => {
  assert.match(apiSource, /createOfficeMeasurementBatch/);
  assert.match(apiSource, /`\/sites\/\$\{siteId\}\/measurement-batches`/);
  assert.match(apiSource, /siteMeasurementWorkers/);
  assert.match(apiSource, /`\/sites\/\$\{siteId\}\/measurement-workers`/);
});

test("measurement review exposes the office dialog and reuses the controlled picker", () => {
  assert.match(overviewSource, /onClick=\{props.onCreate\}[^\n]*Aufmaß anlegen/);
  assert.match(pageSource, /canCreate=\{canCreateBatch\} onCreate=\{openCreateDialog\}/);
  assert.match(pageSource, />Hinweis<\/span>/);
  assert.doesNotMatch(pageSource, /Bitte einen Bereich oder Ort angeben/);
  assert.doesNotMatch(pageSource, /\|\| !createAreaLocation.trim\(\)/);
  assert.match(pageSource, /area_location: areaLocation \|\| null/);
  assert.match(pageSource, /Aufmaßdatum \*/);
  assert.match(pageSource, /Verantwortlicher Monteur/);
  assert.match(pageSource, /<DashboardNotePicker/);
  assert.match(pageSource, /setCreateMeasurementDate\(toLocalDateKey\(new Date\(\)\)\)/);
  assert.match(pageSource, /await selectMeasurementBatch\(created\)/);
  assert.doesNotMatch(pageSource, /Angebotsgrundlage auswählen/);
  assert.doesNotMatch(pageSource, /Das Aufmaß wird als Blanko-Aufmaß ohne Angebotspositionen angelegt\./);
});

test("office measurements reuse the standard measurement table with a compact free-position data mode", () => {
  assert.match(pageSource, /<MeasurementReviewTable\s+items=\{tableItems\}/);
  assert.match(pageSource, /freePositionOnly=\{isFreePositionOnlyBatch\}/);
  assert.match(pageSource, /const displayColumnCount = freePositionOnly\s*\? items\.length \+ freeInputColumnCount/);
  assert.match(pageSource, /const fillerColumnCount = freePositionOnly\s*\? 0/);
  assert.match(pageSource, />Pos\.-Nr\.<\/th>/);
  assert.match(pageSource, />Beschreibung<\/th>/);
  assert.match(pageSource, />Einheit<\/th>/);
  assert.match(pageSource, />Bauteil \/ Ort<\/th>/);
  assert.match(pageSource, /kind: "office-extra" as const/);
  assert.doesNotMatch(pageSource, /Noch keine Positionen in diesem Blanko-Aufmaß\./);
  assert.doesNotMatch(pageSource, /measurement-blank-/);
  assert.doesNotMatch(styles, /\.measurement-blank-/);
});

test("saved blank positions remain fully editable and deletable through the shared free-position API", () => {
  assert.match(pageSource, /saveFreeItemTextDraft/);
  assert.match(pageSource, /onFreeItemUpdate\(item, \{ \[field\]: nextValue \}\)/);
  assert.match(pageSource, /measurement-free-position-delete/);
  assert.match(pageSource, /onFreeItemDelete\(item\)/);
  assert.match(apiSource, /deleteSiteMeasurementFreeItem/);
  assert.match(styles, /\.measurement-review-detail\.is-table-view \.measurement-free-position-delete/);
});

test("office-created measurements hide worker-only review UI while keeping the final completion action", () => {
  assert.match(pageSource, /const isOfficeCreatedBatch = selectedBatch\.origin === "OFFICE"/);
  assert.match(pageSource, /!isOfficeCreatedBatch && showUnsubmittedWarning/);
  assert.match(pageSource, /<MeasurementReviewStatusBar/);
  assert.match(pageSource, /canReview=\{!isOfficeCreatedBatch && !isReviewed && !isCustomerSigned\}/);
});

test("blank measurements expose ten lazy free columns and append one after the last used slot", () => {
  assert.match(pageSource, /const MEASUREMENT_FREE_INPUT_MIN_COLUMNS = 10/);
  assert.match(pageSource, /Math\.max\(MEASUREMENT_FREE_INPUT_MIN_COLUMNS - items\.length, highestActiveFreeColumnIndex \+ 1, 1\)/);
  assert.match(pageSource, /Array\.from\(\{ length: freeInputColumnCount \}/);
  assert.match(pageSource, /createFreeItemFromHeaderDraft/);
  assert.match(pageSource, /await onFreeItemCreate\(\{\s*position: position \|\| null,\s*description,\s*unit,\s*linked_measurement_item_id: draft\.linkedItemId \?\? null,\s*quantity: 0,/s);
  assert.match(pageSource, /\|\| \(item\.unit \?\? ""\)\.trim\(\)\.length > 0/);
});

test("offer-based measurements append one writable position column as soon as the previous draft is used", () => {
  assert.match(pageSource, /const freeInputColumnCount = freePositionOnly[\s\S]*?: Math\.max\(highestActiveFreeColumnIndex \+ 1, 1\);/);
  assert.match(pageSource, /: Math\.max\(MEASUREMENT_TABLE_MIN_COLUMNS, items\.length \+ freeInputColumnCount, viewportColumnCount\);/);
  assert.match(pageSource, /: Math\.max\(0, displayColumnCount - items\.length - freeInputColumnCount\);/);

  const columnsStart = pageSource.indexOf("const displayColumns:");
  const columnsEnd = pageSource.indexOf("const displayAreaRows:", columnsStart);
  const columnsSource = pageSource.slice(columnsStart, columnsEnd);
  const standardColumnsStart = columnsSource.lastIndexOf("return [");
  const standardColumnsSource = columnsSource.slice(standardColumnsStart);

  assert.match(standardColumnsSource, /Array\.from\(\{ length: freeInputColumnCount \}/);
  assert.match(standardColumnsSource, /key: `\$\{MEASUREMENT_OFFICE_EXTRA_COLUMN_KEY\}-\$\{index \+ 1\}`/);
});

test("measurement columns use only the persisted order and append new office positions on the right", () => {
  assert.match(pageSource, /function orderMeasurementItemsByColumnPosition\(items: MobileMeasurementItem\[\]\)/);
  assert.match(pageSource, /left\.sort_order - right\.sort_order \|\| left\.id - right\.id/);
  assert.match(pageSource, /orderMeasurementItemsByColumnPosition\(\[\.\.\.current, createdItem\]\)/);
  assert.match(pageSource, /orderMeasurementItemsByColumnPosition\(\s*await api\.siteMeasurementBatchItems/s);

  const replaceStart = pageSource.indexOf("function replaceMeasurementItem(");
  const replaceEnd = pageSource.indexOf("function orderMeasurementItemsByColumnPosition", replaceStart);
  const replaceSource = pageSource.slice(replaceStart, replaceEnd);
  assert.match(replaceSource, /items\.map/);
  assert.doesNotMatch(replaceSource, /\.sort\(/);
  assert.doesNotMatch(replaceSource, /position\.localeCompare/);
});

test("mobile measurement positions place all writable office columns before viewport fillers", () => {
  const columnsStart = pageSource.indexOf("const displayColumns:");
  const columnsEnd = pageSource.indexOf("const displayAreaRows:", columnsStart);
  const columnsSource = pageSource.slice(columnsStart, columnsEnd);
  const standardColumnsStart = columnsSource.lastIndexOf("return [");
  const standardColumnsSource = columnsSource.slice(standardColumnsStart);

  const officeColumnsIndex = standardColumnsSource.indexOf("Array.from({ length: freeInputColumnCount }");
  const fillerColumnsIndex = standardColumnsSource.indexOf("Array.from({ length: fillerColumnCount }");

  assert.notEqual(officeColumnsIndex, -1);
  assert.notEqual(fillerColumnsIndex, -1);
  assert.ok(officeColumnsIndex < fillerColumnsIndex);
  assert.match(standardColumnsSource, /kind: "office-extra" as const,\s*index: index \+ 1,/);
});

test("measurement position suggestions flip left only when their right edge would leave the viewport", () => {
  assert.equal(getMeasurementSuggestionAlignment({ left: 200 }, 1200), "right");
  assert.equal(getMeasurementSuggestionAlignment({ left: 1000 }, 1200), "left");
  assert.match(pageSource, /is-aligned-\$\{suggestionState\.alignment\}/);
  assert.match(styles, /\.measurement-position-suggestions\.is-aligned-left\s*\{[\s\S]*right:\s*4px;[\s\S]*left:\s*auto;/);
});

test("existing free positions reuse the shared offer autocomplete and stay in the same column", () => {
  assert.match(pageSource, /projectPositionSuggestions/);
  assert.match(pageSource, /buildMeasurementPositionCatalog\(catalogItems\)/);
  assert.match(pageSource, /linkedItem: \{\s*id: item\.id,\s*position: item\.position/s);
  assert.match(pageSource, /item\.position\.toLocaleLowerCase\("de-DE"\)\.includes\(query\)/);
  assert.match(pageSource, /left\.position\.localeCompare\(right\.position, "de-DE", \{ numeric: true/);
  assert.match(pageSource, /setSuggestionState\(null\);\s*if \(existingItem\)/s);
  assert.match(pageSource, /await onFreeItemUpdate\(existingItem, \{\s*position: suggestion\.position,\s*linked_measurement_item_id: suggestion\.id,\s*\}\)/s);
  assert.match(pageSource, /positionSuggestions=\{reviewPositionSuggestions\}/);
  assert.doesNotMatch(pageSource, /usedPositionSuggestionIds/);
  assert.doesNotMatch(pageSource, /usedPositionSuggestionKeys/);
  assert.doesNotMatch(pageSource, /onChange=\{\(event\) => \{\s*if \(!freePositionOnly\) \{\s*return;/s);
  assert.match(pageSource, /closeSuggestionOnOutsidePointer/);
});

test("signed measurements remain editable while completed measurements stay locked", () => {
  assert.match(pageSource, /const canEditRows = canEditMeasurementContent\(selectedBatch, canCreateBatch\)/);
  assert.doesNotMatch(pageSource, /const canEditRows[\s\S]{0,160}&& !isCustomerSigned/);
  assert.match(pageSource, /disabled=\{!canEditRows \|\| reviewActionLoading \|\| isSavingPosition\}/);
});

test("linking a free position invalidates derived execution and time analysis data", () => {
  const handlerStart = pageSource.indexOf("async function updateMeasurementFreeItem(");
  const handlerEnd = pageSource.indexOf("async function deleteMeasurementFreeItem", handlerStart);
  const handlerSource = pageSource.slice(handlerStart, handlerEnd);

  assert.match(handlerSource, /replaceMeasurementItem\(current, updatedItem\)/);
  assert.match(handlerSource, /setMeasurementTimesheet\(null\)/);
  assert.match(handlerSource, /setMeasurementLoaded\(false\)/);
  assert.match(handlerSource, /setMeasurementTimeAnalysis\(null\)/);
  assert.match(handlerSource, /setMeasurementTimeAnalysisLoaded\(false\)/);
});

test("office origin does not create a special presentation and never offers a fake worker original", () => {
  assert.doesNotMatch(pageSource, /Dieses Aufmaß wurde im Büro angelegt und nicht durch einen Monteur eingereicht\./);
  assert.match(overviewSource, /await props.onExport\(batch, "checked"\)/);
  assert.doesNotMatch(overviewSource, /Originales Monteur-Aufmaß|measurement-overview-documents/);
  assert.doesNotMatch(styles, /\.measurement-review-origin-note/);
  assert.match(styles, /\.measurement-create-modal\s*\{[^}]*border-radius:\s*3px/s);
});

test("closing or reopening a measurement invalidates execution progress before the tab is revisited", () => {
  const handlerStart = pageSource.indexOf("async function setMeasurementBatchBillingStatus(");
  const handlerEnd = pageSource.indexOf("async function markMeasurementBatchReviewed", handlerStart);
  const handlerSource = pageSource.slice(handlerStart, handlerEnd);

  assert.match(handlerSource, /markSiteMeasurementBatchBilled/);
  assert.match(handlerSource, /rollbackSiteMeasurementBatchStatus/);
  assert.match(handlerSource, /setMeasurementTimesheet\(null\)/);
  assert.match(handlerSource, /setMeasurementLoaded\(false\)/);
});

test("hours comparison uses backend-calculated completed measurement minutes", () => {
  const panelStart = pageSource.indexOf("function SiteWorkTimesPanel(");
  const panelEnd = pageSource.indexOf("function buildSiteHoursComparison(", panelStart);
  const panelSource = pageSource.slice(panelStart, panelEnd);
  const comparisonStart = pageSource.indexOf("function buildSiteHoursComparison(");
  const comparisonEnd = pageSource.indexOf("function getSiteHoursComparisonStatus(", comparisonStart);
  const comparisonSource = pageSource.slice(comparisonStart, comparisonEnd);

  assert.match(panelSource, /api\.measurementTimesheet\(site\.id\)/);
  assert.doesNotMatch(panelSource, /api\.siteMeasurementBatches\(site\.id\)/);
  assert.match(comparisonSource, /timesheet\?\.kpi\.billed_minutes/);
  assert.match(comparisonSource, /billed_missing_position_count/);
});
