import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const source = await readFile(new URL("../src/pages/MatrixPage.tsx", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("function absencePlanningBlockClassName("), source.indexOf("function matrixAbsenceCellClassName("));
const compiled = ts.transpileModule(helpers, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const { chip, overflow } = new Function(`${compiled}; return { chip: absencePlanningBlockClassName, overflow: absenceOverflowItemClassName };`)();

test("overtime uses dedicated purple styles in matrix chips and overflow, including cancelled entries", () => {
  for (const status of ["approved", "cancelled"]) {
    const item = { kind: "classic", absence: { absence_type: "free", status } };
    assert.equal(chip(item), `absence-planning-chip absence-block-free${status === "cancelled" ? " is-cancelled" : ""}`);
    assert.equal(overflow(item), `absence-overflow-item absence-overflow-free${status === "cancelled" ? " is-cancelled" : ""}`);
  }
  assert.match(styles, /\.absence-planning-chip\.absence-block-free\s*\{[^}]*border-color: #ddd0f6;[^}]*background: #f2ecff;[^}]*color: #5b21b6;/);
  assert.match(styles, /\.absence-overflow-item\.absence-overflow-free\s*\{[^}]*border-left-color: #7c3aed;[^}]*background: #f2ecff;/);
  assert.match(styles, /\.absence-overflow-item\.absence-overflow-free em\s*\{\s*color: #5b21b6;/);
});

test("other absences stay grey and operational absences keep their separate styling", () => {
  assert.match(styles, /\.absence-planning-chip\.absence-block-other\s*\{[^}]*background: #f4f6f8;/);
  assert.match(styles, /\.absence-overflow-item\.absence-overflow-other\s*\{\s*border-left-color: #94a3b8;/);
  assert.equal(chip({ kind: "operational" }), "absence-planning-chip operational-absence-chip");
  assert.equal(overflow({ kind: "operational" }), "absence-overflow-item operational-absence-overflow");
});
