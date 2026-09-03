import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { isOfficeOnlyPayrollEntry, roundMinutesToQuarterHour } from "../src/lib/payrollTimeCorrection.ts";

const source = readFileSync(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("TimeEntriesPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
// Execute the actual screen calculation without mounting React or copying its rules.
const names = ["effectivePayrollWorkMinutes", "effectivePayrollCorrectedWorkMinutes",
  "hasDirectOfficeTime", "isOfficeOnlyTimeEntry", "clockValueToMinutes"];
const functions = names.map((name) => {
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Screen calculation ${name} must exist`);
  return declaration.getText(ast);
}).join("\n");
const context = vm.createContext({ isOfficeOnlyPayrollEntry, roundMinutesToQuarterHour });
vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
const cases = JSON.parse(readFileSync(new URL("../../backend/app/tests/fixtures/payroll_month_minutes.json", import.meta.url), "utf8"));

for (const scenario of cases) {
  test(`Screen/export minutes contract: ${scenario.name}`, () => {
    const minutes = scenario.entries.reduce((sum, values) => {
      if (values.source === "gps_suggestion") return sum;
      const entry = { start_time: null, end_time: null, break_minutes: 0, work_minutes: 0,
        travel_minutes: 0, payroll_corrected_start_time: null, payroll_corrected_end_time: null,
        payroll_corrected_break_minutes: null, payroll_corrected_work_minutes: null,
        source: "manual", note: null, ...values };
      return sum + (context.effectivePayrollWorkMinutes(entry) ?? 0);
    }, 0);
    assert.equal(minutes, scenario.expected_minutes);
  });
}
