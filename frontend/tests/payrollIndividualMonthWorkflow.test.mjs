import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Download } from "lucide-react";
import ts from "typescript";
import {
  payrollApprovedPersonIds,
  payrollAllWorkersExportAvailable,
} from "../src/lib/payrollMonth.ts";

const source = readFileSync(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
const period = (approvedCount = 3) => ({
  status: "OPEN", snapshot_version: null, artifacts_ready: false,
  person_approval_summary: { approved_count: approvedCount, total_count: 20 },
  person_approvals: Array.from({ length: 20 }, (_, index) => ({
    person_id: index + 1, status: index < approvedCount ? "APPROVED" : "OPEN",
    export_ready: index < approvedCount,
  })),
});

test("monthly queue and total status use personal month approvals, not row checks", () => {
  assert.deepEqual([...payrollApprovedPersonIds(period())], [1, 2, 3]);
  assert.equal(payrollApprovedPersonIds(null).size, 0);
  assert.match(source, /evaluationReviewedWorkerIds = useMemo\(\s*\(\) => payrollApprovedPersonIds\(payrollMonthPeriod\)/);
  assert.doesNotMatch(source, /reviewedWorkersWithAllEntriesReviewed/);
  assert.match(source, /evaluationWorkers = useMemo\([\s\S]*?buildTimeReviewWorkerSummaries\([\s\S]*?evaluationReviewedWorkerIds/s);
  assert.match(source, /evaluationWorkerFilterCounts = useMemo\(\s*\(\) => countTimeReviewWorkersByFilter\(evaluationWorkers\)/);
});

test("combined download needs all individual approvals and artifacts, not a global lock", () => {
  assert.equal(payrollAllWorkersExportAvailable(null), false);
  assert.equal(payrollAllWorkersExportAvailable(period()), false);
  assert.equal(payrollAllWorkersExportAvailable(period(20)), true);
  const incomplete = period(20);
  incomplete.person_approvals[1].export_ready = false;
  assert.equal(payrollAllWorkersExportAvailable(incomplete), false);
  incomplete.person_approvals[1].export_ready = true;
  incomplete.person_approvals[1].status = "OPEN";
  assert.equal(payrollAllWorkersExportAvailable(incomplete), false);
  const duplicate = period(20);
  duplicate.person_approvals[1].person_id = 1;
  assert.equal(payrollAllWorkersExportAvailable(duplicate), false);
  assert.equal(payrollAllWorkersExportAvailable({ ...period(0), person_approvals: [],
    person_approval_summary: { approved_count: 0, total_count: 0 } }), false);
});

test("historical global snapshot downloads still require the retained version and artifact", () => {
  const locked = { ...period(20), status: "LOCKED", snapshot_id: 1, snapshot_version: 2 };
  assert.equal(payrollAllWorkersExportAvailable(locked), false);
  locked.artifacts_ready = true;
  assert.equal(payrollAllWorkersExportAvailable(locked), true);
});

// Render the actual toolbar JSX, not a copied test template. This verifies the
// accessible action set for both open and historical locked months without login.
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let toolbar;
function visit(node) {
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((prop) =>
    ts.isJsxAttribute(prop) && prop.name.text === "className" && ts.isStringLiteral(prop.initializer)
    && prop.initializer.text === "time-evaluation-period-actions is-compact")) toolbar = node;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(toolbar);
function renderToolbar(month) {
  const props = {
    isLoadingPayrollMonthPeriod: false,
    payrollPersonApprovalSummary: month.person_approval_summary,
    isPayrollMonthLocked: month.status === "LOCKED", canManagePayrollClose: true,
    isUpdatingPayrollMonth: false, payrollMonthPeriod: month, setPayrollMonthDialog() {},
    arePayrollMonthExportsAvailable: payrollAllWorkersExportAvailable(month),
    isDownloadingAllPayrollMonthXlsx: false, downloadAllPayrollMonthXlsx() {},
    payrollMonthPeriodError: null, isDownloadingPayrollMonthXlsx: false,
  };
  const code = ts.transpileModule(`function Toolbar() { return (${toolbar.getText(ast)}); }`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const component = new Function("React", "Download", "require", ...Object.keys(props),
    `${code}; return Toolbar;`)(React, Download, createRequire(import.meta.url), ...Object.values(props));
  return renderToStaticMarkup(React.createElement(component));
}

test("open-month toolbar renders progress and download, with no collective approval control", () => {
  const html = renderToolbar(period());
  assert.match(html, /3 von 20 Monteuren geprüft/);
  assert.match(html, /Alle Monteure/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /checkbox|Gesamtmonat geprüft|Monat wieder öffnen/);
  assert.doesNotMatch(renderToolbar(period(20)), /disabled=""/);
  assert.doesNotMatch(source, /api\.lockPayrollMonth|confirmPayrollMonthLock/);
});

test("historically locked month retains only explicit reopening, not a new global approval", () => {
  const html = renderToolbar({ ...period(20), status: "LOCKED", can_reopen: true,
    snapshot_id: 1, snapshot_version: 1, artifacts_ready: true });
  assert.match(html, /Monat wieder öffnen/);
  assert.match(html, /Alle Monteure/);
  assert.doesNotMatch(html, /checkbox|Gesamtmonat geprüft/);
});
