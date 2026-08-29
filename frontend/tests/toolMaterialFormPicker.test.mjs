import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getDashboardNotePickerNavigationIndex } from "../src/lib/pickerKeyboard.ts";


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
  assert.match(pickerSource, /aria-activedescendant=\{isOpen \? activeOptionId : undefined\}/);
  assert.match(pickerSource, /className=\{`dashboard-note-picker-option\$\{isSelected \? " is-selected" : ""\}\$\{activeOptionValue === option\.value \? " is-active" : ""\}`\}/);
  assert.match(pickerSource, /event\.key === "Enter" && activeOptionValue !== null/);
  assert.match(pickerSource, /event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?selectOption\(activeOptionValue\)/);
  assert.match(pickerSource, /event\.key === "Escape"[\s\S]*?closeAndFocusTrigger\(\)/);
  assert.match(pickerSource, /scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.match(styles, /\.dashboard-note-picker-option\.is-active \{[^}]*background: #f2f6fb;[^}]*outline: 1px solid #8aa8cf;/s);
});

test("picker keyboard navigation wraps active suggestions and has no option when empty", () => {
  assert.equal(getDashboardNotePickerNavigationIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(getDashboardNotePickerNavigationIndex(2, 3, "ArrowDown"), 0);
  assert.equal(getDashboardNotePickerNavigationIndex(-1, 3, "ArrowUp"), 2);
  assert.equal(getDashboardNotePickerNavigationIndex(0, 3, "ArrowUp"), 2);
  assert.equal(getDashboardNotePickerNavigationIndex(1, 3, "Home"), 0);
  assert.equal(getDashboardNotePickerNavigationIndex(1, 3, "End"), 2);
  assert.equal(getDashboardNotePickerNavigationIndex(0, 0, "ArrowDown"), null);
});


test("shared trigger and popup remain square in all controlled states", () => {
  assert.match(styles, /\.dashboard-note-picker-trigger \{[^}]*border-radius:\s*0/s);
  assert.match(styles, /\.dashboard-note-picker-trigger:hover \{/);
  assert.match(styles, /\.dashboard-note-picker-trigger:focus-visible,[\s\S]*\.dashboard-note-picker-trigger\.is-open/);
  assert.match(styles, /\.dashboard-note-picker-popup \{[^}]*border-radius:\s*0/s);
  assert.match(styles, /\.dashboard-note-picker-popup\.is-searchless \{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/s);
});
