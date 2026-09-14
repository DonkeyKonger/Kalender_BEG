import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { currentlyPlannedRows } from "../src/lib/currentPlanning.ts";

const row = (id, date, personType = "internal") => ({site: {id}, cells: [{date, assignments: personType ? [{person: {person_type: personType}}] : [], absences: [{}], mark: "orange"}]});
const matrix = rows => ({start_date: "2026-09-01", end_date: "2026-10-31", current_planning_start: "2026-09-14", current_planning_end: "2026-09-27", rows});

test("current planning includes both full weeks, all person types and weekends, but no empty marks or absences", () => {
  const data = matrix([
    row(1, "2026-09-13"), row(2, "2026-09-14"), row(3, "2026-09-20", "external"),
    row(4, "2026-09-27", "external_temp"), row(5, "2026-09-28"), row(6, "2026-09-18", null),
  ]);
  const before = JSON.stringify(data);
  assert.deepEqual(currentlyPlannedRows(data).map(r => r.site.id), [2,3,4]);
  assert.equal(JSON.stringify(data), before);
});

test("local assignment edits update the selection without trusting stale row flags", () => {
  const data = matrix([row(1, "2026-09-14")]);
  data.rows[0].has_current_planning = false;
  assert.equal(currentlyPlannedRows(data).length, 1);
  data.rows[0].has_current_planning = true;
  data.rows[0].cells[0].assignments = [];
  assert.equal(currentlyPlannedRows(data).length, 0);
});

test("year view uses server coverage when next week's assignments lie outside visible dates", () => {
  const data = {...matrix([row(1,"2026-12-20"), row(2,"2026-12-20")]), start_date:"2026-01-01",end_date:"2026-12-31",current_planning_start:"2026-12-28",current_planning_end:"2027-01-10"};
  data.rows[1].has_current_planning = true;
  assert.deepEqual(currentlyPlannedRows(data).map(r=>r.site.id), [2]);
});

test("missing coverage never invents planning", () => {
  assert.deepEqual(currentlyPlannedRows({rows: []}), []);
});

test("toolbar replaces undo with a reversible read-only row filter before existing PM grouping", () => {
  const source = readFileSync(new URL("../src/pages/MatrixPage.tsx", import.meta.url),"utf8");
  assert.doesNotMatch(source, /Undo|undoLast|undoStack|RotateCcw/);
  assert.match(source, /isCurrentPlanningOnly \? currentlyPlannedRows\(matrix\) : matrix.rows/);
  assert.match(source, /groupMatrixRows\(rows, projectManagerFilter\)/);
  assert.match(source, /aria-pressed=\{isCurrentPlanningOnly\}/);
  assert.match(source, /setIsCurrentPlanningOnly\(\(current\) => !current\)/);
  assert.match(source, /hasPendingMatrixSave \|\| Boolean\(activeCell && !sameEntries/);
  assert.match(source, /matrix=\{matrix\}/);
});

test("current planning hides the complete absence row only while the filter is active", () => {
  const source = readFileSync(new URL("../src/pages/MatrixPage.tsx", import.meta.url), "utf8");
  assert.match(source, /showAbsences=\{!isCurrentPlanningOnly\}/);
  assert.match(source, /props\.showAbsences && <MatrixAbsencePlanningRow \{\.\.\.props\} holidayMap=\{holidayMap\} \/>/);
  assert.match(source, /props\.visibleRowGroups\.map\(\(group\) => \(/);
});

test("current planning hides add-site rows while retaining permission checks in normal mode", () => {
  const source = readFileSync(new URL("../src/pages/MatrixPage.tsx", import.meta.url), "utf8");
  assert.match(source, /canCreateSites=\{matrixIsEditable && !isCurrentPlanningOnly\}/);
  assert.match(source, /props\.canCreateSites && \(\s*<MatrixAddSiteRow/);
});

test("current planning reduces manager separators by 70 percent without changing normal mode", () => {
  const source = readFileSync(new URL("../src/pages/MatrixPage.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /isCurrentPlanningOnly \? "is-current-planning" : ""/);
  assert.match(css, /\.matrix-group-row th \{[^}]*height: 32px;/);
  assert.match(css, /\.matrix-page\.is-current-planning \.matrix-group-row th \{[^}]*height: 9\.6px;[^}]*min-height: 0;[^}]*padding: 0 10px;/);
  assert.match(source, /className="matrix-group-label">\{group.label\}<\/span>/);
  assert.match(css, /\.matrix-page\.is-current-planning\.is-compact \.matrix-table tbody \.matrix-group-row,[\s\S]*?\.matrix-page\.is-current-planning\.is-compact \.matrix-group-row th \{[^}]*height: 10\.2px;[^}]*min-height: 0;/);
});
