import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const [pageSource, pickerSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MiscellaneousPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/DashboardNotePickers.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);


test("category and status reuse the common non-native picker in create and edit forms", () => {
  assert.doesNotMatch(pageSource, /<select/);
  assert.match(
    pageSource,
    /<ToolMaterialFixedSelect\s+label="Kategorie"\s+options=\{toolMaterialCategoryOptions\}\s+value=\{draft\.category\}/,
  );
  assert.match(
    pageSource,
    /<ToolMaterialFixedSelect\s+label="Status"\s+options=\{toolMaterialStatusOptions\}\s+value=\{draft\.status\}/,
  );
  assert.match(pageSource, /includeEmptyOption=\{false\}/);
  assert.match(pageSource, /searchable=\{false\}/);
  assert.match(pageSource, /getToolMaterialStatusChange\(value as ToolMaterialStatus\)/);
});


test("searchless picker keeps the shared trigger, listbox and selected value", () => {
  assert.match(pickerSource, /searchable = true/);
  assert.match(pickerSource, /searchable \? \([\s\S]*dashboard-note-picker-search/);
  assert.match(pickerSource, /aria-selected=\{isSelected\}/);
  assert.match(pickerSource, /selected \?\? first\)\?\.focus\(\)/);
  assert.match(pickerSource, /createPortal\(/);
});


test("picker opens above when needed and supports keyboard option navigation", () => {
  assert.match(pickerSource, /availableBelow < preferredHeight && availableAbove > availableBelow/);
  assert.match(pickerSource, /bottom:\s*Math\.max\(margin, window\.innerHeight - rect\.top \+ gap\)/);
  assert.match(pickerSource, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
  assert.match(pickerSource, /optionButtons\[nextIndex\]\?\.focus\(\)/);
  assert.match(pickerSource, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(pickerSource, /event\.target\.click\(\)/);
});


test("shared trigger and popup remain square in all controlled states", () => {
  assert.match(styles, /\.dashboard-note-picker-trigger \{[^}]*border-radius:\s*0/s);
  assert.match(styles, /\.dashboard-note-picker-trigger:hover \{/);
  assert.match(styles, /\.dashboard-note-picker-trigger:focus-visible,[\s\S]*\.dashboard-note-picker-trigger\.is-open/);
  assert.match(styles, /\.dashboard-note-picker-popup \{[^}]*border-radius:\s*0/s);
  assert.match(styles, /\.dashboard-note-picker-popup\.is-searchless \{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/s);
});
