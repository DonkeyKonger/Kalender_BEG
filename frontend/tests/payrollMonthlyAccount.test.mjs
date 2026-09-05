import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const desktop = readFileSync(new URL("../src/pages/PersonsPage.tsx", import.meta.url), "utf8");
const mobile = readFileSync(new URL("../src/pages/MobilePersonalFilePage.tsx", import.meta.url), "utf8");
const payroll = readFileSync(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");

function sourceFunction(source, name) {
  const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = ast.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  const js = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${js}; return ${name};`)();
}

test("unknown balances are not rendered as zero on desktop or mobile", () => {
  const desktopFormat = sourceFunction(desktop, "formatHoursAccountMinutes");
  const mobileFormat = sourceFunction(mobile, "formatOvertimeHours");
  const status = sourceFunction(mobile, "hoursAccountStatusLabel");
  assert.equal(desktopFormat(null), "Kontostand offen");
  assert.equal(mobileFormat(null), "Kontostand offen");
  assert.equal(status(null), "Klärung offen");
  assert.equal(status(0), "Ausgeglichen");
  assert.equal(desktopFormat(0), "0,0 h");
  assert.equal(desktopFormat(120), "+2,0 h");
  assert.equal(mobileFormat(-60), "-1,00 Std.");
  assert.doesNotMatch(desktop, /current_balance_minutes\s*\?\?\s*0/);
  assert.match(desktop, /account\?\.notices\?\.map/);
});

test("monthly transitions and exact reversals retain meaningful log labels", () => {
  const title = sourceFunction(desktop, "hoursAccountEntryTitle");
  const label = sourceFunction(desktop, "hoursAccountEntrySourceLabel");
  assert.equal(title({ entry_type: "monthly_balance" }), "Monatsbewegung gemäß Excel");
  assert.equal(title({ entry_type: "monthly_reversal" }), "Monatsbewegung zurückgenommen");
  assert.match(label({ source_type: "monthly_transition", ledger_system: "legacy" }), /Umstellungszeitpunkt/);
});

test("normal payroll keeps review and approval controls without mandatory setup", () => {
  assert.doesNotMatch(payroll, /PayrollSetupDialog|Stundenkonto einrichten|isPayrollSetupOpen/);
  assert.match(payroll, /Gesamtmonat geprüft/);
  assert.match(payroll, /Stundenkonto wird erst beim Monatsabschluss aktualisiert/);
});
