import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8");
const helpers = source.slice(
  source.indexOf("function getManagerSummary("),
  source.indexOf("function getDashboardRange("),
);
const context = vm.createContext({});
vm.runInContext(
  ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
  context,
);

const manager = {
  id: 42,
  display_name: "CC",
  short_code: "C.Eck",
  person_type: "internal",
};

test("dashboard manager label prefers the short code stored in the person record", () => {
  const peopleById = new Map([[42, { short_code: " CE " }]]);

  assert.equal(context.getManagerLabel(manager, peopleById), "CE");
  assert.equal(context.getManagerSummary(manager, peopleById).label, "CE");
});

test("dashboard manager label keeps matrix, display-name and unassigned fallbacks", () => {
  assert.equal(context.getManagerLabel(manager, new Map()), "CE");
  assert.equal(
    context.getManagerLabel({ ...manager, short_code: "", display_name: "CC" }, new Map()),
    "CC",
  );
  assert.equal(context.getManagerLabel(manager, new Map([[42, { short_code: "   " }]])), "CE");
  assert.equal(context.getManagerLabel(null, new Map()), "Ohne PL");
});
