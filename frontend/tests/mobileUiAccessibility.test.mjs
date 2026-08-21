import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");


test("mobile login respects dynamic safe areas and avoids focus zoom", () => {
  assert.match(
    styles,
    /@media \(max-width: 899px\) \{[\s\S]*?\.login-screen \{[^}]*min-height:\s*100dvh;[^}]*safe-area-inset-top[^}]*safe-area-inset-right[^}]*safe-area-inset-bottom[^}]*safe-area-inset-left/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 899px\) \{[\s\S]*?\.login-form input \{[^}]*min-height:\s*44px;[^}]*font-size:\s*1rem;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 899px\) \{[\s\S]*?\.login-form button \{[^}]*min-height:\s*44px;/s,
  );
});


test("timeline pagination keeps compact dots inside accessible touch targets", () => {
  assert.match(
    styles,
    /\.mobile-home-timeline-pagination button \{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*background:\s*transparent;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-timeline-pagination button::before \{[^}]*width:\s*7px;[^}]*height:\s*7px;[^}]*background:\s*#c8d4e3;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-timeline-pagination button\.is-active::before \{[^}]*width:\s*18px;[^}]*background:\s*#315f91;/s,
  );
});


test("primary mobile controls meet the 44 pixel touch target", () => {
  assert.match(
    styles,
    /\.mobile-back-icon-button \{[^}]*width:\s*44px;[^}]*height:\s*44px;/s,
  );
  assert.match(styles, /\.mobile-assignment-history-state button \{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.mobile-segment button \{[^}]*min-height:\s*44px;/s);
  assert.match(
    styles,
    /\.mobile-time-site-mode button,\s*\.mobile-time-secondary-button,\s*\.mobile-time-conflict-actions button \{[^}]*min-height:\s*44px;/s,
  );
  assert.match(styles, /\.mobile-time-picker-wheel button \{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.mobile-time-picker-actions button \{[^}]*min-height:\s*44px;/s);
});


test("mobile time fields use a zoom-safe input font size", () => {
  assert.match(
    styles,
    /\.mobile-time-field input,\s*\.mobile-time-field select,\s*\.mobile-time-value-button \{[^}]*font-size:\s*1rem;/s,
  );
});
