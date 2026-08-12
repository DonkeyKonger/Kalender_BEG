import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getOperationalAbsenceOptionalDetails } from "../src/lib/operationalAbsenceDetails.ts";

const [matrixSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MatrixPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("operational absences are loaded with the matrix and every background refresh", () => {
  const calls = matrixSource.match(/api\.operationalAbsences\(\{ startDate: activeRange\.start, endDate: activeRange\.end \}\)/g) ?? [];
  assert.ok(calls.length >= 3, "Initial load, explicit refresh and background refresh must load operational absences");
  assert.match(matrixSource, /applyOperationalAbsenceData\(operationalAbsenceData\)/);
  assert.match(matrixSource, /subscribeToOperationalAbsenceUpdates\(\(\) => \{[\s\S]*refreshOperationalAbsencesOnly\(\)/);
});

test("all absence loaders share a last-write-wins guard against stale cross-tab responses", () => {
  assert.match(matrixSource, /const classicAbsenceLoadRequestIdRef = useRef\(0\)/);
  assert.match(matrixSource, /const operationalAbsenceLoadRequestIdRef = useRef\(0\)/);
  const operationalRequestIds = matrixSource.match(/const operationalAbsenceRequestId = \+\+operationalAbsenceLoadRequestIdRef\.current/g) ?? [];
  assert.ok(operationalRequestIds.length >= 4, "Every operational load must share the request generation");
  assert.match(matrixSource, /operationalAbsenceRequestId === operationalAbsenceLoadRequestIdRef\.current[\s\S]*applyOperationalAbsenceData\(operationalAbsenceData\)/);
  assert.match(matrixSource, /operationalAbsenceLoadRequestIdRef\.current \+= 1;[\s\S]*setOperationalAbsences\(\(current\) => current\.filter/);
});

test("an operational-only cross-tab refresh cannot discard a valid classic absence response", () => {
  const operationalOnlyStart = matrixSource.indexOf("const refreshOperationalAbsencesOnly");
  const operationalOnlyEnd = matrixSource.indexOf("useEffect(() => subscribeToOperationalAbsenceUpdates", operationalOnlyStart);
  const operationalOnlyLoader = matrixSource.slice(operationalOnlyStart, operationalOnlyEnd);
  assert.ok(operationalOnlyStart >= 0 && operationalOnlyEnd > operationalOnlyStart);
  assert.doesNotMatch(operationalOnlyLoader, /classicAbsenceLoadRequestIdRef/);
  assert.doesNotMatch(operationalOnlyLoader, /setAbsences\(/);
  assert.match(matrixSource, /classicAbsenceRequestId === classicAbsenceLoadRequestIdRef\.current[\s\S]*setAbsences\(absenceData\)/);
});

test("cross-tab updates reconcile an open detail and delete failures do not restore a stale snapshot", () => {
  assert.match(matrixSource, /const applyOperationalAbsenceData = useCallback[\s\S]*items\.find\(\(item\) => item\.id === current\.absence\.id\)[\s\S]*currentAbsence \? \{ \.\.\.current, absence: currentAbsence \} : null/);
  assert.match(matrixSource, /catch \(requestError\) \{[\s\S]*await refreshOperationalAbsencesOnly\(\)[\s\S]*setOperationalAbsences\(\(current\) => \(/);
  assert.doesNotMatch(matrixSource, /setOperationalAbsences\(previousAbsences\)/);
});

test("all absence types are centrally sorted before visible and overflow rendering", () => {
  assert.match(matrixSource, /type PlanningAbsenceItem = PlanningClassicAbsenceItem \| PlanningOperationalAbsenceItem/);
  assert.match(matrixSource, /const items = sortPlanningAbsenceEntries\(\[\.\.\.operationalItems, \.\.\.classicItems\]\)/);
  assert.match(matrixSource, /dayAbsenceItems\.slice\(0, MAX_VISIBLE_ABSENCES_PER_DAY\)/);
  assert.match(matrixSource, /items=\{dayAbsenceItems\}/);
  assert.match(matrixSource, /\{items\.map\(\(item\) =>/);
});

test("operational entries use stable priority ordering and collision-free keys", () => {
  assert.match(matrixSource, /sortPlanningAbsenceEntries/);
  assert.match(matrixSource, /`operational-\$\{item\.operationalAbsence\.id\}`/);
  assert.match(matrixSource, /`absence-\$\{item\.absence\.id\}`/);
});

test("left click opens a read-only viewport-aware detail popup with optional sections", () => {
  assert.match(matrixSource, /function OperationalAbsenceDetailPopup/);
  assert.match(matrixSource, /role="dialog"/);
  const popupStart = matrixSource.indexOf("function OperationalAbsenceDetailPopup");
  const popupEnd = matrixSource.indexOf("type AbsenceCellEditorPopupProps", popupStart);
  const popupSource = matrixSource.slice(popupStart, popupEnd);
  assert.ok(popupStart >= 0 && popupEnd > popupStart);
  assert.doesNotMatch(popupSource, /<dt>Datum<\/dt>/);
  assert.match(matrixSource, /<dt>Zeitraum<\/dt>/);
  assert.match(matrixSource, /<dt>Baustelle<\/dt>/);
  assert.match(matrixSource, /<dt>Notizen<\/dt>/);
  assert.match(popupSource, /optionalDetails\.hasSite &&/);
  assert.match(popupSource, /optionalDetails\.noteText &&/);
  assert.doesNotMatch(popupSource, /<dt>Baustelle<\/dt>[\s\S]*?Keine Angabe/);
  assert.doesNotMatch(popupSource, /<dt>Notizen<\/dt>[\s\S]*?Keine Angabe/);
  assert.match(popupSource, /className="operational-absence-detail-notes"/);
  assert.doesNotMatch(popupSource, /dangerouslySetInnerHTML|<br\s*\/>/);
  assert.match(matrixSource, /event\.key === "Escape"/);
  assert.match(styles, /\.operational-absence-detail-popover \{[^}]*position:\s*fixed;[^}]*max-height:\s*calc\(100vh - 16px\)/s);
  assert.match(styles, /\.operational-absence-detail-notes \{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/s);
});

test("optional operational absence details only expose meaningful content", () => {
  const site = { id: 8015, site_number: "8015", name: "FFW Barmbek Hamburg" };

  assert.deepEqual(
    getOperationalAbsenceOptionalDetails({ site: null, text: null }),
    { hasSite: false, noteText: null },
  );
  assert.deepEqual(
    getOperationalAbsenceOptionalDetails({ site, text: null }),
    { hasSite: true, noteText: null },
  );
  assert.deepEqual(
    getOperationalAbsenceOptionalDetails({ site: null, text: "Baubesprechung vor Ort" }),
    { hasSite: false, noteText: "Baubesprechung vor Ort" },
  );
  assert.deepEqual(
    getOperationalAbsenceOptionalDetails({ site, text: "Baubesprechung\nanschließend Aufmaß" }),
    { hasSite: true, noteText: "Baubesprechung\nanschließend Aufmaß" },
  );
  assert.deepEqual(
    getOperationalAbsenceOptionalDetails({ site: null, text: " \n\n\t " }),
    { hasSite: false, noteText: null },
  );
});

test("absence overflow hover opens only from the explicit accessible more button", () => {
  const rowStart = matrixSource.indexOf("function MatrixAbsencePlanningRow");
  const rowEnd = matrixSource.indexOf("function AbsenceOverflowPopover", rowStart);
  const rowSource = matrixSource.slice(rowStart, rowEnd);

  assert.ok(rowStart >= 0 && rowEnd > rowStart);
  assert.match(rowSource, /aria-expanded=\{props\.absenceOverflowDetail\?\.date === date\}/);
  assert.match(rowSource, /aria-haspopup="dialog"/);
  assert.match(rowSource, /className="absence-planning-more"[\s\S]*onMouseEnter=\{\(event\) => openOverflowFromTrigger\(date, event\.currentTarget\)\}/);
  assert.match(rowSource, /className="absence-planning-more"[\s\S]*onMouseLeave=\{scheduleOverflowClose\}/);
  assert.match(rowSource, /function openOverflowFromTrigger[\s\S]*props\.onToggleAbsenceOverflow\(/);
  assert.doesNotMatch(rowSource, /<td[^>]*onMouseEnter=/);
  assert.doesNotMatch(rowSource, /<button\s+className=\{absencePlanningBlockClassName\(item\)\}[^>]*onMouseEnter=/);
  assert.doesNotMatch(styles, /has-absence-overflow:hover[\s\S]*absence-overflow-popover/);
  assert.doesNotMatch(styles, /has-absence-overflow:focus-within[\s\S]*absence-overflow-popover/);
  assert.doesNotMatch(styles, /\.absence-overflow-popover \{[^}]*display:\s*none/s);
});

test("absence overflow trigger and portal share one delayed hover close lifecycle", () => {
  const rowStart = matrixSource.indexOf("function MatrixAbsencePlanningRow");
  const rowEnd = matrixSource.indexOf("function MatrixTableGroup", rowStart);
  const rowSource = matrixSource.slice(rowStart, rowEnd);

  assert.match(matrixSource, /const ABSENCE_OVERFLOW_HOVER_CLOSE_DELAY_MS = 200/);
  assert.match(rowSource, /overflowCloseTimerRef/);
  assert.match(rowSource, /window\.setTimeout\([\s\S]*ABSENCE_OVERFLOW_HOVER_CLOSE_DELAY_MS/);
  assert.match(rowSource, /onMouseEnter=\{cancelOverflowClose\}/);
  assert.match(rowSource, /onMouseLeave=\{scheduleOverflowClose\}/);
  assert.match(rowSource, /window\.clearTimeout\(overflowCloseTimerRef\.current\)/);
});

test("absence overflow has explicit outside-click and Escape lifecycle cleanup", () => {
  const popupStart = matrixSource.indexOf("function AbsenceOverflowPopover");
  const popupEnd = matrixSource.indexOf("function MatrixTableGroup", popupStart);
  const popupSource = matrixSource.slice(popupStart, popupEnd);

  assert.ok(popupStart >= 0 && popupEnd > popupStart);
  assert.match(popupSource, /role="dialog"/);
  assert.match(popupSource, /createPortal\(/);
  assert.match(popupSource, /document\.addEventListener\("pointerdown", handlePointerDown\)/);
  assert.match(popupSource, /document\.removeEventListener\("pointerdown", handlePointerDown\)/);
  assert.match(popupSource, /event\.key === "Escape"/);
  assert.match(popupSource, /document\.removeEventListener\("keydown", handleKeyDown\)/);
  assert.match(styles, /\.absence-overflow-popover \{[^}]*position:\s*fixed;[^}]*max-height:\s*calc\(100vh - 16px\)/s);
});

test("operational detail and absence overflow close each other before opening", () => {
  assert.match(matrixSource, /function openOperationalAbsenceDetail[\s\S]*setAbsenceOverflowDetail\(null\)[\s\S]*setOperationalAbsenceDetail\(\{ absence, anchor \}\)/);
  assert.match(matrixSource, /function toggleAbsenceOverflowDetail[\s\S]*setOperationalAbsenceDetail\(null\)[\s\S]*setAbsenceOverflowDetail/);
  assert.match(matrixSource, /current\?\.date === date \? null : \{ date, anchor \}/);
});

test("right click deletes via the dedicated API independently of calendar edit mode", () => {
  assert.match(matrixSource, /window\.confirm\(`Abwesenheit von \$\{managerName\}/);
  assert.match(matrixSource, /await api\.deleteOperationalAbsence\(absence\.id\)/);
  assert.match(matrixSource, /item\.kind === "operational"[\s\S]*props\.onDeleteOperationalAbsence\(item\.operationalAbsence\)/);
});

test("operational bubbles use the same light pastel logic in direct and overflow views", () => {
  assert.match(styles, /\.absence-planning-chip\.operational-absence-chip \{[^}]*border-color:\s*#c9bcd8;[^}]*background:\s*#e7e1ee;[^}]*color:\s*#5e4e73/s);
  assert.match(styles, /\.absence-overflow-item\.operational-absence-overflow \{[^}]*border-left-color:\s*#c9bcd8;[^}]*background:\s*#e7e1ee;[^}]*color:\s*#5e4e73/s);
  assert.match(styles, /\.absence-overflow-item\.operational-absence-overflow em \{[^}]*color:\s*#5e4e73/s);
});
