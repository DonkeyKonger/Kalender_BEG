import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/pages/MobileProjectFile.css", import.meta.url), "utf8");
const icon = await readFile(new URL("../src/components/MobileBackButton.tsx", import.meta.url), "utf8");
const listStyles = await readFile(new URL("../src/pages/MobileMeasurementList.css", import.meta.url), "utf8");

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
  assert.match(styles, /mobile-detail-page \.mobile-project-back-button \{[^}]*min-height: 44px;[^}]*border: 0;[^}]*background: transparent;[^}]*font-size: 1.25rem;[^}]*line-height: 1.3;[^}]*white-space: nowrap;/);
  assert.match(styles, /mobile-project-back-button > svg \{[^}]*flex-shrink: 0;[^}]*width: 25px;[^}]*height: 25px;/);
  assert.match(listStyles, /mobile-measurement-page-topbar \{[^}]*flex-wrap: wrap;/);
  assert.match(listStyles, /mobile-measurement-new-action \{[^}]*margin-left: auto;/);
});
