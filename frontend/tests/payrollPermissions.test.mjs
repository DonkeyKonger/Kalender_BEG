import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canAccessMainPage } from "../src/auth/pageAccess.ts";

function currentUser(role, permissions = []) {
  return {
    id: 7,
    username: "office-user",
    display_name: "Office User",
    role,
    is_active: true,
    must_change_password: false,
    office_page_permissions: permissions,
    person_id: null,
  };
}

test("payroll opt-in grants office users normal payroll page actions", () => {
  const optedInOffice = currentUser("office", ["payroll"]);
  const officeWithoutOptIn = currentUser("office", ["export"]);

  assert.equal(canAccessMainPage(optedInOffice, "payroll"), true);
  assert.equal(canAccessMainPage(officeWithoutOptIn, "payroll"), false);
});

test("payroll page and week downloads use payroll access without a phone GPS verification tab", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const permissionSource = await readFile(new URL("../src/auth/permissions.ts", import.meta.url), "utf8");
  const pageSource = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");

  assert.match(appSource, /path="time-entries"[\s\S]*?<TimeEntriesPage/);
  assert.match(appSource, /officePermission="payroll"[\s\S]*?path="time-entries"/);
  assert.match(permissionSource, /return canAccessMainPage\(user, pageKey\)/);
  assert.match(pageSource, /canManageTimeEntries = canEditMainPage\(user, "payroll"\)/);
  assert.match(pageSource, /api\.weeklyAllWorkersTimeEntriesXlsx/);
  assert.match(pageSource, /api\.weeklyWorkerTimeEntriesXlsx/);
  assert.doesNotMatch(pageSource, /gpsVerification|GPS-Prüfung|recentGpsLocationPoints/);
});
