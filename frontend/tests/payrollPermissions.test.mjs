import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canAccessMainPage, canManagePayrollMonthClose } from "../src/auth/pageAccess.ts";

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

test("month close and setup use the general payroll permission without person assignment", () => {
  assert.equal(canManagePayrollMonthClose(currentUser("admin")), true);
  assert.equal(canManagePayrollMonthClose(currentUser("project_manager")), true);
  assert.equal(canManagePayrollMonthClose(currentUser("office", ["payroll"])), true);
  assert.equal(canManagePayrollMonthClose(currentUser("office", ["export"])), false);
  assert.equal(canManagePayrollMonthClose(currentUser("monteur")), false);
  assert.equal(canManagePayrollMonthClose(null), false);
});

test("payroll page and week downloads use payroll access without a phone GPS verification tab", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const permissionSource = await readFile(new URL("../src/auth/permissions.ts", import.meta.url), "utf8");
  const pageSource = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");

  assert.match(appSource, /path="time-entries"[\s\S]*?<TimeEntriesPage/);
  assert.match(appSource, /officePermission="payroll"[\s\S]*?path="time-entries"/);
  assert.match(permissionSource, /return canAccessMainPage\(user, pageKey\)/);
  assert.match(pageSource, /canManageTimeEntries = canEditMainPage\(user, "payroll"\)/);
  assert.match(pageSource, /canManagePayrollClose = canManagePayrollMonthClose\(user\)/);
  assert.match(pageSource, /payrollPersonApprovalDisabledReason[\s\S]*?Für den Monatsabschluss fehlt die allgemeine Lohnprüfungsberechtigung/s);
  assert.match(pageSource, /aria-describedby=\{disabledReason \? "payroll-person-month-toggle-reason" : undefined\}/);
  assert.doesNotMatch(pageSource, /Stundenkonto einrichten|PayrollSetupDialog/);
  assert.match(pageSource, /api\.weeklyAllWorkersTimeEntriesXlsx/);
  assert.match(pageSource, /api\.weeklyWorkerTimeEntriesXlsx/);
  assert.match(pageSource, /api\.payrollMonthlyWorkersXlsx/);
  assert.match(pageSource, /api\.payrollMonthlyWorkerXlsx/);
  assert.doesNotMatch(pageSource, /gpsVerification|GPS-Prüfung|recentGpsLocationPoints/);
});
