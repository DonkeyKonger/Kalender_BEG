import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getToolMaterialCategoryDefinition,
  toolMaterialCategoryOptions,
} from "../src/lib/toolMaterialCategories.ts";


const [pageSource, homeSource, appSource, apiSource, mobileTypesSource, styles, toolFormSource] = await Promise.all([
  readFile(new URL("../src/pages/MobilePersonalFilePage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MyAssignmentsPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/types/mobile.ts", import.meta.url), "utf8"),
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
  assert.match(toolFormSource, /<ToolMaterialFixedSelect\s+label="Kategorie"\s+options=\{toolMaterialCategoryOptions\}/);
  assert.match(toolFormSource, /category:\s*draft\.category/);
  assert.doesNotMatch(toolFormSource, /tool-material-col-category/);
});


test("mobile dashboard and protected routes open the personal file", () => {
  assert.match(homeSource, /title="Persönliche Akte"[\s\S]*navigate\("\/me\/personal-file"\)/);
  assert.match(appSource, /path="me\/personal-file" element=\{<MobilePersonalFilePage \/>\}/);
  assert.match(appSource, /path="me\/personal-file\/vacation"[\s\S]*absenceType="vacation"/);
  assert.match(appSource, /path="me\/personal-file\/sickness"[\s\S]*absenceType="sick"/);
  assert.match(appSource, /path="me\/personal-file\/tools" element=\{<MobilePersonalFileToolsPage \/>\}/);
});


test("personal file API never accepts an employee ID and bypasses persistent caches", () => {
  assert.match(apiSource, /myPersonalFile\(\): Promise<MobilePersonalFile>/);
  assert.match(apiSource, /request<MobilePersonalFile>\("\/me\/personal-file", \{ cache: "no-store" \}\)/);
  assert.match(apiSource, /myPersonalFileAbsences\(params:[\s\S]*\/me\/personal-file\/absences\?\$\{search\.toString\(\)\}/);
  assert.match(apiSource, /request<MobilePersonalFileTool\[]>\("\/me\/personal-file\/tools", \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(apiSource, /myPersonalFile\([^)]*personId/);
  assert.doesNotMatch(apiSource, /myPersonalFileAbsences\([^)]*personId/);
});


test("vacation and sickness cards open read-only weekly details", () => {
  assert.match(pageSource, /aria-label="Urlaubsdetails öffnen"[\s\S]*navigate\("\/me\/personal-file\/vacation"\)/);
  assert.match(pageSource, /aria-label="Krankheitsdetails öffnen"[\s\S]*navigate\("\/me\/personal-file\/sickness"\)/);
  assert.match(pageSource, /export function MobilePersonalFileAbsencePage/);
  assert.match(pageSource, /data\.weeks\.map/);
  assert.match(pageSource, /mobile-personal-absence-entry-week[\s\S]*KW \{week\.iso_week\}/);
  assert.doesNotMatch(pageSource, /formatCompactDateRange/);
  assert.doesNotMatch(pageSource, /mobile-personal-absence-entry-type/);
  assert.match(pageSource, /entry\.day_count/);
  assert.match(pageSource, /− \{formatDays\(data\.taken_vacation_days\)\}/);
  assert.match(pageSource, /\+ \{formatDays\(data\.vacation_carryover_days\)\}/);
  assert.match(pageSource, /Übertrag \{data\.year - 1\}/);
  assert.match(pageSource, /data\.vacation_carryover_days/);
  assert.match(pageSource, /Keine \{isVacation \? "Urlaubstage" : "Krankheitstage"\} in \{data\.year\}/);
  assert.doesNotMatch(pageSource, /MobilePersonalFileAbsencePage[\s\S]*Fehlzeit hinzufügen/);
});


test("absence details use the established green and red status colors without horizontal scrolling", () => {
  assert.match(styles, /\.mobile-personal-absence-entry::before \{[^}]*background:\s*#16a34a/s);
  assert.match(styles, /\.mobile-personal-absence-entry\.is-sick::before \{[^}]*background:\s*#dc2626/s);
  assert.match(styles, /\.mobile-personal-absence-entry-week \{[^}]*color:\s*#243f5f/s);
  assert.match(styles, /\.mobile-personal-absence-weeks \{[^}]*gap:\s*7px/s);
  assert.doesNotMatch(styles, /mobile-personal-absence-entry-type/);
  assert.doesNotMatch(styles, /\.mobile-personal-absence-(?:content|weeks|week|entry)[^{]*\{[^}]*overflow-x:\s*(?:auto|scroll)/s);
  assert.match(styles, /\.mobile-personal-absence-summary\.is-vacation \{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s);
});


test("summary shows at most three tools and only offers the full list above three", () => {
  assert.match(pageSource, /data\.tool_preview\.map/);
  assert.match(pageSource, /data\.tool_count > 3/);
  assert.match(pageSource, /Alle \{data\.tool_count\} anzeigen/);
  assert.match(pageSource, /data\.vehicle\?\.license_plate/);
  assert.match(pageSource, /data\.vehicle\.manufacturer/);
  assert.match(pageSource, /Kein Fahrzeug zugeordnet/);
  assert.match(pageSource, /keine Werkzeuge oder Materialien zugeordnet/);
});


test("personal file renders the overtime account from the summary response", () => {
  assert.match(mobileTypesSource, /hours_account:\s*MobilePersonalFileHoursAccount/);
  assert.match(mobileTypesSource, /current_balance_minutes:\s*number/);
  assert.match(mobileTypesSource, /last_entry_at:\s*string \| null/);
  assert.match(pageSource, /Überstundenkonto/);
  assert.match(pageSource, /data\.hours_account\.current_balance_minutes/);
  assert.match(pageSource, /formatOvertimeHours\(data\.hours_account\.current_balance_minutes\)/);
  assert.match(pageSource, /formatHoursAccountStand\(data\.hours_account\.last_entry_at\)/);
  assert.match(pageSource, /hoursAccountStatusLabel\(data\.hours_account\.current_balance_minutes\)/);
  assert.match(pageSource, /"Guthaben"/);
  assert.match(pageSource, /"Ausgeglichen"/);
  assert.match(pageSource, /"Minusstunden"/);
  assert.match(pageSource, /Noch keine Buchungen/);
});


test("mobile personal file has responsive cards and bounded tablet width", () => {
  assert.match(styles, /\.mobile-personal-file-page \{[^}]*width:\s*min\(100%, 720px\);[^}]*max-width:\s*720px/s);
  assert.match(styles, /\.mobile-personal-stat-grid \{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /\.mobile-personal-hours-card \{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto/s);
  assert.match(styles, /\.mobile-personal-hours-badge \{[^}]*white-space:\s*nowrap/s);
  assert.match(styles, /\.mobile-personal-file-skeleton \.is-hours,\s*\.mobile-personal-file-skeleton \.is-vehicle \{[^}]*min-height:\s*104px/s);
  assert.match(styles, /@media \(max-width: 350px\) \{[\s\S]*\.mobile-personal-stat-grid \{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(styles, /\.mobile-personal-tool-row strong \{[^}]*overflow-wrap:\s*anywhere/s);
  assert.doesNotMatch(styles, /\.mobile-personal-(?:stat|hours|vehicle|tools)[^{]*\{[^}]*overflow-x:\s*(?:auto|scroll)/s);
});


test("loading, retry and focus refresh states are present", () => {
  assert.match(pageSource, /MobilePersonalFileSkeleton/);
  assert.match(pageSource, /MobilePersonalFileError/);
  assert.match(pageSource, /Erneut versuchen/);
  assert.match(pageSource, /window\.addEventListener\("focus", refresh\)/);
  assert.match(pageSource, /document\.addEventListener\("visibilitychange", refresh\)/);
});
