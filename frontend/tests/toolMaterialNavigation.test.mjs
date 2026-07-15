import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canAccessMainPage } from "../src/auth/pageAccess.ts";
import { buildToolMaterialSearchParams } from "../src/lib/toolMaterialFilters.ts";
import {
  buildToolMaterialEditPath,
  getMiscellaneousTab,
  getToolMaterialEmployeeFilterValues,
  normalizeToolMaterialRouteSearch,
  setToolMaterialEmployeeFilterValues,
} from "../src/lib/toolMaterialRouting.ts";


const [personsPageSource, miscellaneousPageSource, appSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/PersonsPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MiscellaneousPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);


test("edit navigation targets the tool-material tab by stable employee ID", () => {
  const path = buildToolMaterialEditPath(47);
  const search = new URLSearchParams(path.split("?")[1]);
  const apiSearch = buildToolMaterialSearchParams({
    filters: { employee: { values: getToolMaterialEmployeeFilterValues(search) } },
  });

  assert.equal(path, "/sonstige?tab=toolsMaterial&employeeId=47");
  assert.equal(getMiscellaneousTab(search), "toolsMaterial");
  assert.deepEqual(getToolMaterialEmployeeFilterValues(search), ["47"]);
  assert.deepEqual(apiSearch.getAll("values_employee"), ["47"]);
  assert.doesNotMatch(path, /Christopher|display_name|employeeName/);
  assert.match(personsPageSource, /closeDrawer\(\);\s*navigate\(buildToolMaterialEditPath\(personId\)\)/);
});


test("employee filter survives refresh and can be changed or removed", () => {
  const refreshed = new URLSearchParams("tab=toolsMaterial&employeeId=47");
  const changed = setToolMaterialEmployeeFilterValues(refreshed, ["82"]);
  const changedToUnassigned = setToolMaterialEmployeeFilterValues(changed, ["__empty__"]);
  const removed = setToolMaterialEmployeeFilterValues(changedToUnassigned, []);

  assert.deepEqual(getToolMaterialEmployeeFilterValues(refreshed), ["47"]);
  assert.deepEqual(getToolMaterialEmployeeFilterValues(changed), ["82"]);
  assert.deepEqual(getToolMaterialEmployeeFilterValues(changedToUnassigned), ["__empty__"]);
  assert.equal(changedToUnassigned.get("employeeUnassigned"), "1");
  assert.equal(changed.get("tab"), "toolsMaterial");
  assert.deepEqual(getToolMaterialEmployeeFilterValues(removed), []);
  assert.equal(removed.get("tab"), "toolsMaterial");
  assert.match(miscellaneousPageSource, /employee:\s*\{ values: employeeFilterValues \}/);
  assert.match(miscellaneousPageSource, /onEmployeeFilterChange\(nextFilter\.values \?\? \[\]\)/);
  assert.match(miscellaneousPageSource, /setFilters\(clearAllToolMaterialFilters\(\)\);\s*onAllRouteFiltersReset\(\)/);
});


test("normal and invalid URLs do not restore a stale or name-based employee filter", () => {
  const normal = new URLSearchParams();
  const invalid = new URLSearchParams(
    "tab=toolsMaterial&employeeId=Christopher&employeeId=-1&employeeId=0",
  );
  const normalized = normalizeToolMaterialRouteSearch(invalid);

  assert.equal(getMiscellaneousTab(normal), "workerEvaluation");
  assert.deepEqual(getToolMaterialEmployeeFilterValues(normal), []);
  assert.deepEqual(getToolMaterialEmployeeFilterValues(invalid), []);
  assert.equal(normalized.has("employeeId"), false);
  assert.equal(normalized.get("tab"), "toolsMaterial");
});


test("edit button uses central miscellaneous access and protected target route", () => {
  assert.equal(canAccessMainPage(currentUser("admin"), "miscellaneous"), true);
  assert.equal(
    canAccessMainPage(currentUser("office", "miscellaneous"), "miscellaneous"),
    true,
  );
  assert.equal(canAccessMainPage(currentUser("office"), "miscellaneous"), false);
  assert.equal(canAccessMainPage(currentUser("project_manager"), "miscellaneous"), false);
  assert.match(
    personsPageSource,
    /canEditToolMaterials = Boolean\(user && canAccessMainPage\(user, "miscellaneous"\)\)/,
  );
  assert.match(
    personsPageSource,
    /action\.key === "equipment" && canEditToolMaterials[\s\S]*<span>Bearbeiten<\/span>/,
  );
  assert.match(
    appSource,
    /ProtectedRoute roles=\{\["admin", "office"\]\} officePermission="miscellaneous"/,
  );
});


test("tool-material subpage header keeps navigation left and edit action right", () => {
  assert.match(
    personsPageSource,
    /person-detail-subpage-heading[\s\S]*customer-detail-back-button[\s\S]*<h3>\{title\}<\/h3>/,
  );
  assert.match(
    personsPageSource,
    /person-detail-subpage-actions[\s\S]*\{actions\}/,
  );
  assert.match(
    styles,
    /\.person-detail-subpage \.customer-detail-subpage-header \{[^}]*justify-content:\s*space-between/s,
  );
  assert.match(
    styles,
    /\.person-tool-material-edit-button \{[^}]*border-radius:\s*0/s,
  );
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
