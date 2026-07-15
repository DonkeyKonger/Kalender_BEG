import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canAccessMainPage, canShowNavItem } from "../src/auth/pageAccess.ts";
import { navigationItems } from "../src/config/navigation.ts";
import {
  allOfficePagePermissions,
  officePagePermissionOptions,
} from "../src/config/officePagePermissions.ts";

const [appSource, userPageSource] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/AdminUsersPage.tsx", import.meta.url), "utf8"),
]);
const miscellaneousNavItem = navigationItems.find((item) => item.path === "/sonstige");


test("miscellaneous is an office opt-in option and an admin or office navigation item", () => {
  assert.ok(miscellaneousNavItem);
  assert.deepEqual(miscellaneousNavItem.roles, ["admin", "office"]);
  assert.equal(miscellaneousNavItem.officePermission, "miscellaneous");
  assert.equal(miscellaneousNavItem.adminOnly, undefined);
  assert.ok(allOfficePagePermissions.includes("miscellaneous"));
  assert.deepEqual(
    officePagePermissionOptions.find((option) => option.key === "miscellaneous"),
    { key: "miscellaneous", label: "Sonstige" },
  );
});


test("miscellaneous access is limited to admin and explicitly opted-in office users", () => {
  const admin = currentUser("admin");
  const optedInOffice = currentUser("office", "miscellaneous");
  const officeWithoutOptIn = currentUser("office");
  const projectManager = currentUser("project_manager", "miscellaneous");
  const monteur = currentUser("monteur", "miscellaneous");

  assert.equal(canAccessMainPage(admin, "miscellaneous"), true);
  assert.equal(canAccessMainPage(optedInOffice, "miscellaneous"), true);
  assert.equal(canAccessMainPage(officeWithoutOptIn, "miscellaneous"), false);
  assert.equal(canAccessMainPage(projectManager, "miscellaneous"), false);
  assert.equal(canAccessMainPage(monteur, "miscellaneous"), false);
  assert.equal(canShowNavItem(admin, miscellaneousNavItem), true);
  assert.equal(canShowNavItem(optedInOffice, miscellaneousNavItem), true);
  assert.equal(canShowNavItem(officeWithoutOptIn, miscellaneousNavItem), false);
  assert.equal(canShowNavItem(projectManager, miscellaneousNavItem), false);
  assert.equal(canShowNavItem(monteur, miscellaneousNavItem), false);
  assert.equal(
    navigationItems.find((item) => canShowNavItem(optedInOffice, item))?.path,
    "/sonstige",
  );
});


test("miscellaneous route and user management use the central office permission", () => {
  assert.match(
    appSource,
    /ProtectedRoute roles=\{\["admin", "office"\]\} officePermission="miscellaneous"/,
  );
  assert.match(userPageSource, /draft\.role === "office"/);
  assert.match(userPageSource, /officePagePermissionOptions\.map/);
  assert.match(userPageSource, /role === "office" \? \{\} : \{ office_page_permissions: \[\] \}/);
});


function currentUser(role, ...permissions) {
  return {
    id: 1,
    username: role,
    display_name: role,
    role,
    is_active: true,
    must_change_password: false,
    office_page_permissions: permissions,
    person_id: null,
  };
}
