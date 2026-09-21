import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = await readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/pages/MobileMeasurementPositions.css", import.meta.url), "utf8");
const detail = source.slice(source.indexOf("function MeasurementBatchDetail("), source.indexOf("function MeasurementFreePositionForm("));
const list = detail.slice(detail.indexOf('if (viewMode === "list")'), detail.indexOf('className="mobile-detail-panel mobile-measurement-panel mobile-measurement-positions-page is-table-view"'));

test("only captured positions show quantity and unit, including zero totals with entries", () => {
  const helper = source.match(/function isMobileMeasurementItemCaptured\([^]*?\n\}/)[0];
  const isCaptured = new Function(`${stripTypeScriptTypes(helper)}; return isMobileMeasurementItemCaptured;`)();
  assert.equal(isCaptured({ entries: [], reported_quantity: "0" }), false);
  assert.equal(isCaptured({ entries: [], reported_quantity: null }), false);
  assert.equal(isCaptured({ entries: [], reported_quantity: "invalid" }), false);
  assert.equal(isCaptured({ entries: [], reported_quantity: "55" }), true);
  assert.equal(isCaptured({ entries: [], reported_quantity: "-2.5" }), true);
  assert.equal(isCaptured({ entries: [{ quantity: 2 }, { quantity: -2 }], reported_quantity: "0" }), true);
  assert.match(list, /const isCaptured = isMobileMeasurementItemCaptured\(item\)/);
  assert.match(list, /isCaptured \? "is-captured" : "is-uncaptured"/);
  assert.match(list, /\{isCaptured \? \(\s*<span className="mobile-measurement-position-amount">[^]*?\{item.unit \?\? ""\}[^]*?\) : null\}/);
  assert.match(styles, /mobile-measurement-position-row.is-captured \{\s*background: #ffffff;/);
  assert.match(styles, /mobile-measurement-position-row.is-uncaptured \{\s*background: #f1f3f6;/);
});

test("all position descriptions reserve the same amount column even when quantity is hidden", () => {
  assert.match(styles, /mobile-measurement-position-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) 5rem 18px;/s);
  assert.match(styles, /mobile-measurement-position-row > svg \{[^}]*grid-column: 3;/s);
  assert.doesNotMatch(styles, /mobile-measurement-position-row\.is-(?:un)?captured \{[^}]*grid-template-columns:/s);
});

test("mobile positions keep create beside the title and search underneath without a redundant heading", () => {
  assert.match(list, /<header className="mobile-measurement-list-header">[\s\S]*<MobileBackButton label="Zurück zum Aufmaß" onClick=\{onBack\} \/>[\s\S]*<h1>Aufmaß<\/h1>[\s\S]*\{searchControl\}[\s\S]*<\/header>/);
  assert.match(detail, /aria-label="Position oder Leistung suchen"[\s\S]*value=\{searchTerm\}[\s\S]*onSearchChange\(event.target.value\)/);
  assert.match(list, /<h1>Aufmaß<\/h1>\s*<button[\s\S]*onClick=\{onCreatePosition\}[\s\S]*disabled=\{batch.is_locked_for_worker\}[\s\S]*<span>Position erstellen<\/span>[\s\S]*<\/div>\s*\{searchControl\}/);
  assert.doesNotMatch(list, /<h2|mobile-measurement-list-actions|aria-labelledby="mobile-measurement-positions-title"/);
  assert.match(list, /<section className="mobile-measurement-list-content" aria-label="Positionen">/);
  assert.match(styles, /mobile-measurement-create-position-button \{[^}]*min-height: 44px;/s);
});

test("position list retains data, state messages, negative quantities and existing handlers", () => {
  assert.match(list, /items.filter\(\(item\) => !isInlineFreePositionDraftItem\(item\)\).map/);
  assert.match(list, /getMeasurementPositionDisplayLabel\(item\)/);
  assert.match(list, /onClick=\{\(\) => onSelectItem\(item\)\}/);
  assert.match(list, /formatMeasurementNumber\(item.reported_quantity\)/);
  assert.match(list, /measurement-negative-quantity/);
  for (const message of ["Aufmaßpositionen werden geladen...", "Noch keine Aufmaßpositionen importiert.", "Keine Aufmaßposition gefunden.", "für Monteure gesperrt."]) {
    assert.ok(list.includes(message));
  }
  assert.match(list, /\{error \? <div className="form-error">\{error\}/);
});

test("measurement toolbar uses a quiet shared visual treatment without reducing touch targets", () => {
  assert.match(styles, /mobile-measurement-list-header \{[^}]*gap: 12px;[^}]*border-bottom: 1px solid #d7e3f0;[^}]*background: #ffffff;[^}]*padding: 12px 16px 16px;/s);
  assert.match(styles, /mobile-measurement-create-position-button \{[^}]*min-height: 44px;[^}]*border: 1px solid transparent;[^}]*border-radius: 8px;[^}]*background: #eaf1f8;/s);
  assert.match(styles, /mobile-measurement-search \{[^}]*border-radius: 8px;/s);
  assert.match(styles, /mobile-measurement-create-position-button:disabled \{[^}]*background: #f3f5f8;/s);
});

test("mobile descriptions stop at three lines and rows form one responsive list", () => {
  assert.match(styles, /mobile-measurement-position-description \{[^}]*overflow: hidden;[^}]*-webkit-line-clamp: 3;/s);
  assert.match(styles, /mobile-measurement-position-row \+ \.mobile-measurement-position-row \{[^}]*border-top:/s);
  assert.match(styles, /mobile-measurement-position-copy \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/s);
  assert.match(styles, /mobile-measurement-list-title \{[^}]*display: flex;/s);
  assert.doesNotMatch(styles, /mobile-measurement-list-actions/);
  assert.doesNotMatch(styles, /position:\s*(fixed|sticky)|linear-gradient/);
});

test("only positions scroll while title, search and create action remain in the viewport", () => {
  assert.match(styles, /\.app-main:has\(\.mobile-measurement-positions-page\.is-list-view\) \{[^}]*height: 100dvh;[^}]*min-height: 0;[^}]*overflow: hidden;/s);
  assert.match(styles, /mobile-measurement-list-content \{[^}]*grid-template-rows: minmax\(0, 1fr\);[^}]*min-height: 0;[^}]*overflow: hidden;/s);
  assert.match(styles, /mobile-measurement-position-scroll \{[^}]*min-height: 0;[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;/s);
  const scrollStart = list.indexOf('className="mobile-measurement-position-scroll"');
  assert.ok(scrollStart > list.indexOf('<span>Position erstellen</span>'));
  assert.match(list.slice(scrollStart), /role="region" aria-label="Aufmaßpositionen" tabIndex=\{0\}/);
  assert.ok(list.indexOf('className="mobile-measurement-position-list"') > scrollStart);
});
