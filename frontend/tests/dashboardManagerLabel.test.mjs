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
  display_name: "CE",
  short_code: "C.CE",
  person_type: "internal",
};

test("dashboard manager label prefers the visible person code over the technical calendar code", () => {
  assert.equal(context.getManagerLabel(manager), "CE");
  assert.equal(context.getManagerSummary(manager).label, "CE");
});

test("dashboard manager label falls back to short code and handles an unassigned site", () => {
  assert.equal(
    context.getManagerLabel({ ...manager, display_name: "", short_code: "A.Biesewig" }),
    "AB",
  );
  assert.equal(context.getManagerLabel(null), "Ohne PL");
});
