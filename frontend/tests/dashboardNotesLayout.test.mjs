import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("dashboard note cards keep a compact minimum height and grow with their content", () => {
  const desktopCardRule = cssRule(".dashboard-section--notes .dashboard-note-row");

  assert.match(desktopCardRule, /height:\s*auto/);
  assert.match(desktopCardRule, /min-height:\s*92px/);
  assert.match(desktopCardRule, /flex:\s*0 0 auto/);
  assert.match(desktopCardRule, /flex-shrink:\s*0/);
  assert.doesNotMatch(desktopCardRule, /(?:^|\n)\s*height:\s*92px/);
  assert.doesNotMatch(desktopCardRule, /overflow(?:-y)?:\s*(?:hidden|auto|scroll)/);
});

test("long note text and metadata wrap without clipping", () => {
  const bodyRule = cssRule(".dashboard-note-body");
  const metadataItemRule = cssRule(".dashboard-note-meta span");

  for (const rule of [bodyRule, metadataItemRule]) {
    assert.match(rule, /white-space:\s*normal/);
    assert.match(rule, /overflow-wrap:\s*anywhere/);
    assert.match(rule, /word-break:\s*break-word/);
    assert.doesNotMatch(rule, /line-clamp|max-height|overflow:\s*hidden/);
  }
});

test("the note list remains the only vertical scroll area and starts at the top", () => {
  const listRule = cssRule(".dashboard-section--notes .dashboard-note-list");
  const actionRule = cssRule(".dashboard-note-row-actions");

  assert.match(listRule, /flex-direction:\s*column/);
  assert.match(listRule, /align-items:\s*flex-start/);
  assert.match(listRule, /justify-content:\s*flex-start/);
  assert.match(listRule, /overflow-y:\s*auto/);
  assert.match(actionRule, /align-self:\s*start/);
});

function cssRule(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `CSS-Regel ${selector} fehlt`);
  const end = styles.indexOf("}", start);
  return styles.slice(start, end + 1);
}
