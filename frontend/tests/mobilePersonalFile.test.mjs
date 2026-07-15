import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getToolMaterialCategoryDefinition,
  toolMaterialCategoryOptions,
} from "../src/lib/toolMaterialCategories.ts";


const [pageSource, homeSource, appSource, apiSource, styles, toolFormSource] = await Promise.all([
  readFile(new URL("../src/pages/MobilePersonalFilePage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MyAssignmentsPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MiscellaneousPage.tsx", import.meta.url), "utf8"),
]);


const expectedCategories = [
  "drilling_screwing",
  "grinding_cutting",
  "sawing",
  "vacuuming",
  "measuring",
  "batteries_charging",
  "hand_tools",
  "ladders_work_equipment",
  "testing_equipment",
  "vehicle_accessories",
  "material",
  "other",
];


test("tool material categories use stable keys and an unknown-category fallback", () => {
  assert.deepEqual(toolMaterialCategoryOptions.map(({ value }) => value), expectedCategories);
  assert.equal(getToolMaterialCategoryDefinition("future-category").value, "other");
  assert.equal(new Set(toolMaterialCategoryOptions.map(({ icon }) => icon)).size, 12);
});


test("desktop tool form persists category without adding a desktop table column", () => {
  assert.match(toolFormSource, /<span>Kategorie<\/span>[\s\S]*toolMaterialCategoryOptions\.map/);
  assert.match(toolFormSource, /category:\s*draft\.category/);
  assert.doesNotMatch(toolFormSource, /tool-material-col-category/);
});


test("mobile dashboard and protected routes open the personal file", () => {
  assert.match(homeSource, /title="Persönliche Akte"[\s\S]*navigate\("\/me\/personal-file"\)/);
  assert.match(appSource, /path="me\/personal-file" element=\{<MobilePersonalFilePage \/>\}/);
  assert.match(appSource, /path="me\/personal-file\/tools" element=\{<MobilePersonalFileToolsPage \/>\}/);
});


test("personal file API never accepts an employee ID and bypasses persistent caches", () => {
  assert.match(apiSource, /myPersonalFile\(\): Promise<MobilePersonalFile>/);
  assert.match(apiSource, /request<MobilePersonalFile>\("\/me\/personal-file", \{ cache: "no-store" \}\)/);
  assert.match(apiSource, /request<MobilePersonalFileTool\[]>\("\/me\/personal-file\/tools", \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(apiSource, /myPersonalFile\([^)]*personId/);
});


test("summary shows at most three tools and only offers the full list above three", () => {
  assert.match(pageSource, /data\.tool_preview\.map/);
  assert.match(pageSource, /data\.tool_count > 3/);
  assert.match(pageSource, /Alle \{data\.tool_count\} anzeigen/);
  assert.match(pageSource, /Kein Fahrzeug zugeordnet/);
  assert.match(pageSource, /keine Werkzeuge oder Materialien zugeordnet/);
});


test("mobile personal file has responsive cards and bounded tablet width", () => {
  assert.match(styles, /\.mobile-personal-file-page \{[^}]*width:\s*min\(100%, 720px\);[^}]*max-width:\s*720px/s);
  assert.match(styles, /\.mobile-personal-stat-grid \{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /@media \(max-width: 350px\) \{[\s\S]*\.mobile-personal-stat-grid \{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(styles, /\.mobile-personal-tool-row strong \{[^}]*overflow-wrap:\s*anywhere/s);
  assert.doesNotMatch(styles, /\.mobile-personal-(?:stat|vehicle|tools)[^{]*\{[^}]*overflow-x:\s*(?:auto|scroll)/s);
});


test("loading, retry and focus refresh states are present", () => {
  assert.match(pageSource, /MobilePersonalFileSkeleton/);
  assert.match(pageSource, /MobilePersonalFileError/);
  assert.match(pageSource, /Erneut versuchen/);
  assert.match(pageSource, /window\.addEventListener\("focus", refresh\)/);
  assert.match(pageSource, /document\.addEventListener\("visibilitychange", refresh\)/);
});
