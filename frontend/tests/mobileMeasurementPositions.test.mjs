import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/pages/MobileMeasurementPositions.css", import.meta.url), "utf8");
const detail = source.slice(source.indexOf("function MeasurementBatchDetail("), source.indexOf("function MeasurementFreePositionForm("));
const list = detail.slice(detail.indexOf('if (viewMode === "list")'), detail.indexOf('className="mobile-detail-panel mobile-measurement-panel mobile-measurement-positions-page is-table-view"'));

test("mobile positions group navigation and existing search above the list actions", () => {
  assert.match(list, /<header className="mobile-measurement-list-header">[\s\S]*<MobileBackButton label="Zurück zum Aufmaß" onClick=\{onBack\} \/>[\s\S]*<h1>Aufmaß<\/h1>[\s\S]*\{searchControl\}[\s\S]*<\/header>/);
  assert.match(detail, /aria-label="Position oder Leistung suchen"[\s\S]*value=\{searchTerm\}[\s\S]*onSearchChange\(event.target.value\)/);
  assert.match(list, /<h2[^>]*>Positionen<\/h2>[\s\S]*onClick=\{onCreatePosition\}[\s\S]*disabled=\{batch.is_locked_for_worker\}/);
  assert.match(styles, /mobile-measurement-list-content \{[^}]*gap: 16px;/s);
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

test("mobile descriptions stop at three lines and rows form one responsive list", () => {
  assert.match(styles, /mobile-measurement-position-description \{[^}]*overflow: hidden;[^}]*-webkit-line-clamp: 3;/s);
  assert.match(styles, /mobile-measurement-position-row \+ \.mobile-measurement-position-row \{[^}]*border-top:/s);
  assert.match(styles, /mobile-measurement-position-copy \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/s);
  assert.match(styles, /mobile-measurement-list-actions \{[^}]*flex-wrap: wrap;/s);
  assert.doesNotMatch(styles, /position:\s*(fixed|sticky)|linear-gradient/);
});

test("only positions scroll while title, search and create action remain in the viewport", () => {
  assert.match(styles, /\.app-main:has\(\.mobile-measurement-positions-page\.is-list-view\) \{[^}]*height: 100dvh;[^}]*min-height: 0;[^}]*overflow: hidden;/s);
  assert.match(styles, /mobile-measurement-list-content \{[^}]*grid-template-rows: auto minmax\(0, 1fr\);[^}]*min-height: 0;[^}]*overflow: hidden;/s);
  assert.match(styles, /mobile-measurement-position-scroll \{[^}]*min-height: 0;[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;/s);
  const scrollStart = list.indexOf('className="mobile-measurement-position-scroll"');
  assert.ok(scrollStart > list.indexOf('<span>Position erstellen</span>'));
  assert.match(list.slice(scrollStart), /role="region" aria-label="Aufmaßpositionen" tabIndex=\{0\}/);
  assert.ok(list.indexOf('className="mobile-measurement-position-list"') > scrollStart);
});
