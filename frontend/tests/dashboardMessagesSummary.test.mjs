import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("dashboard messages keep the unread badge without a redundant summary box", () => {
  assert.match(
    pageSource,
    /badge=\{dashboardMessages\.length > 0 \? String\(dashboardMessages\.length\) : undefined\}/,
  );
  assert.match(pageSource, /Als gelesen markieren/);
  assert.match(pageSource, /Keine neuen Meldungen/);
  assert.doesNotMatch(pageSource, /dashboard-message-unread-note/);
  assert.doesNotMatch(pageSource, /ungelesene .*Meldung.*bitte prüfen/);
  assert.doesNotMatch(styles, /\.dashboard-message-unread-note\s*\{/);
});
