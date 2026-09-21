import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/pages/MobileProjectFile.css", import.meta.url), "utf8");
const icon = await readFile(new URL("../src/components/MobileBackButton.tsx", import.meta.url), "utf8");
const listStyles = await readFile(new URL("../src/pages/MobileMeasurementList.css", import.meta.url), "utf8");
const sharedStyles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const timeSource = await readFile(new URL("../src/pages/MobileTimeEntryPage.tsx", import.meta.url), "utf8");
const overviewStyles = await readFile(new URL("../src/pages/MobileMeasurementOverview.css", import.meta.url), "utf8");

test("all project-file labelled return buttons use the same heading-sized presentation", () => {
  const buttons = [...source.matchAll(/<button\b(?:(?!<\/button>)[\s\S])*<\/button>/g)]
    .map(match => match[0]).filter(button => button.includes("<span>Projektakte</span>"));
  assert.equal(buttons.length, 3, "overview, extra work and measurements; folders show the site name");
  for (const button of buttons) {
    assert.match(button, /mobile-project-back-button/);
    assert.match(button, /size=\{25\}/);
    assert.match(button, /onClick=/);
  }
  assert.match(icon, /size=\{25\}/);
  assert.match(styles, /mobile-project-file-heading h1 \{[^}]*font-size: 1.25rem;[^}]*line-height: 1.3;/);
  assert.match(sharedStyles, /button:is\(\.mobile-back-button[^}]*min-height: 44px;[^}]*border: 0;[^}]*background: transparent;[^}]*font-size: 1.25rem;[^}]*line-height: 1.3;[^}]*white-space: normal;/);
  assert.match(sharedStyles, /\.mobile-back-icon-button\) > svg \{[^}]*flex-shrink: 0;[^}]*width: 25px;[^}]*height: 25px;/);
  assert.match(listStyles, /mobile-measurement-page-topbar \{[^}]*flex-wrap: wrap;/);
  assert.match(listStyles, /mobile-measurement-new-action \{[^}]*margin-left: auto;/);
});

test("every mobile back arrow uses 25px, including nested documents and time entry", () => {
  const arrows = [...(source + timeSource + icon).matchAll(/<ArrowLeft\b[^>]*\/>/g)];
  assert.equal(arrows.length, 17);
  for (const [arrow] of arrows) assert.match(arrow, /size=\{25\}/);
  for (const className of ["mobile-back-button", "mobile-calendar-back", "mobile-document-preview-back", "mobile-folder-project-back"]) {
    assert.ok(sharedStyles.includes(className), className);
  }
  assert.match(overviewStyles, /mobile-measurement-detail-topbar \{[^}]*flex-wrap: wrap;/);
  assert.match(overviewStyles, /button:not\(\.mobile-back-button\) svg/);
  assert.match(overviewStyles, /mobile-measurement-submit-action \{[^}]*margin-left: auto;/);
  // Previous-month and photo-carousel chevrons are not page-back controls.
  assert.match(timeSource, /<ChevronLeft aria-hidden="true" size=\{21\}/);
  assert.match(source, /<ChevronLeft aria-hidden="true" size=\{20\}/);
});
