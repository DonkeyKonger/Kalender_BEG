import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canAccessMainPage, canShowNavItem } from "../src/auth/pageAccess.ts";
import { navigationItems } from "../src/config/navigation.ts";
import { allOfficePagePermissions } from "../src/config/officePagePermissions.ts";

const source = async (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("warehouse accounts have no calendar, office or worker navigation permissions", () => {
  const user = { role: "warehouse", office_page_permissions: allOfficePagePermissions, person_id: null };
  for (const page of allOfficePagePermissions) assert.equal(canAccessMainPage(user, page), false);
  for (const item of navigationItems) assert.equal(canShowNavItem(user, item), false);
});

test("warehouse opens its own protected workspace outside the calendar shell", async () => {
  const app = await source("App.tsx");
  assert.match(app, /ProtectedRoute roles=\{\["warehouse"\]\}/);
  assert.match(app, /path="warehouse" element=\{<WarehousePage \/>\}/);
  assert.ok(app.indexOf('<WarehousePage />') < app.indexOf('<AppShell />'));
  assert.match(app, /ProtectedRoute roles=\{\["admin", "project_manager", "office", "monteur"\]\}/);
  assert.match(await source("auth/permissions.ts"), /user\.role === "warehouse"[\s\S]*?return "\/warehouse"/);
  const warehouse = await source("pages/WarehousePage.tsx");
  assert.match(warehouse, /logout\(\)/);
  assert.doesNotMatch(warehouse, /api\.|AppShell|person_id/);
});

test("admin warehouse form hides and clears person selection and explains password policy", async () => {
  const users = await source("pages/AdminUsersPage.tsx");
  assert.match(users, /draft\.role !== "warehouse" \? <label>[\s\S]*?<span>Person<\/span>/);
  assert.match(users, /role === "warehouse" \? \{ person_id: null \}/);
  assert.match(users, /person_id: createForm\.role === "warehouse" \? null/);
  assert.match(users, /person_id: draft\.role === "warehouse" \? null/);
  assert.match(users, /const userRoleOrder:[^;]*"warehouse"/);
  assert.match(users, /kein Passwortwechsel erforderlich/);
  assert.match(await source("components/StatusBadge.tsx"), /warehouse: "Lager"/);
});

test("warehouse does not register for worker push notifications", async () => {
  assert.match(await source("auth/AuthContext.tsx"), /user\.role === "warehouse" \|\| !canUsePushNotifications/);
});
