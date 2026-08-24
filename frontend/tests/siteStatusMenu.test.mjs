import assert from "node:assert/strict";
import test from "node:test";

import { getSiteStatusMenuNavigationIndex } from "../src/lib/siteStatusMenu.ts";

test("site status menu cycles predictably with arrows and supports edge keys", () => {
  assert.equal(getSiteStatusMenuNavigationIndex(-1, 5, "ArrowDown"), 0);
  assert.equal(getSiteStatusMenuNavigationIndex(-1, 5, "ArrowUp"), 4);
  assert.equal(getSiteStatusMenuNavigationIndex(4, 5, "ArrowDown"), 0);
  assert.equal(getSiteStatusMenuNavigationIndex(0, 5, "ArrowUp"), 4);
  assert.equal(getSiteStatusMenuNavigationIndex(2, 5, "Home"), 0);
  assert.equal(getSiteStatusMenuNavigationIndex(2, 5, "End"), 4);
  assert.equal(getSiteStatusMenuNavigationIndex(2, 5, "Escape"), null);
  assert.equal(getSiteStatusMenuNavigationIndex(0, 0, "ArrowDown"), null);
});
