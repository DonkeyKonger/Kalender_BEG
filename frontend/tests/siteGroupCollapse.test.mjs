import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  initialCollapsedSiteGroupKeys,
  siteGroupKeyForProjectManager,
  withNewForeignSiteGroupsCollapsed,
} from "../src/lib/siteGroupCollapse.ts";

const sitesPageSource = await readFile(new URL("../src/pages/SitesPage.tsx", import.meta.url), "utf8");

test("only the signed-in person's site group starts expanded", () => {
  const collapsed = initialCollapsedSiteGroupKeys(["11", "22", "33", "unassigned"], 22);

  assert.deepEqual([...collapsed], ["11", "33", "unassigned"]);
  assert.equal(collapsed.has("22"), false);
});

test("all site groups start collapsed when no group matches the signed-in person", () => {
  const collapsed = initialCollapsedSiteGroupKeys(["11", "22", "unassigned"], 99);

  assert.deepEqual([...collapsed], ["11", "22", "unassigned"]);
  assert.deepEqual([...initialCollapsedSiteGroupKeys(["11", "22"], null)], ["11", "22"]);
});

test("new foreign groups are collapsed without resetting manual choices", () => {
  const collapsed = withNewForeignSiteGroupsCollapsed(
    new Set(["22"]),
    new Set(["11", "22"]),
    ["11", "22", "33", "44"],
    11,
  );

  assert.deepEqual([...collapsed], ["22", "33", "44"]);
  assert.equal(collapsed.has("11"), false);
});

test("a newly appearing own group stays expanded and project manager ids have stable keys", () => {
  const collapsed = withNewForeignSiteGroupsCollapsed(
    new Set(["11"]),
    new Set(["11"]),
    ["11", "22"],
    22,
  );

  assert.equal(collapsed.has("22"), false);
  assert.equal(siteGroupKeyForProjectManager(22), "22");
  assert.equal(siteGroupKeyForProjectManager(null), "unassigned");
});

test("the sites page initializes collapse state from unfiltered groups and stable auth identity", () => {
  assert.match(sitesPageSource, /groupSites\(sites, "all"\)/);
  assert.match(sitesPageSource, /initialCollapsedSiteGroupKeys\(allSiteGroupKeys, user\.person_id\)/);
  assert.match(sitesPageSource, /withNewForeignSiteGroupsCollapsed\([\s\S]*previousKnownGroupKeys/);
  assert.doesNotMatch(sitesPageSource, /hasInitializedProjectManagerFilter/);
});
