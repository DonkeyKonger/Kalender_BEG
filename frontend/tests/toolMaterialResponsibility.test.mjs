import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const [pageSource, apiSource, typeSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MiscellaneousPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/types/toolMaterial.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);


test("responsible user control sits before the add action in the tool header", () => {
  assert.match(
    pageSource,
    /miscellaneous-tools-header-actions[\s\S]*<ToolMaterialResponsibleUserControl[\s\S]*miscellaneous-tools-add-button/,
  );
  assert.match(
    styles,
    /\.miscellaneous-tools-header-actions \{[^}]*display:\s*flex;[^}]*align-items:\s*flex-end;[^}]*gap:\s*8px/s,
  );
  assert.match(styles, /\.tool-material-responsibility \{[\s\S]*width:\s*150px/);
  assert.match(styles, /\.miscellaneous-tools-add-button \{[^}]*height:\s*32px;[^}]*margin-top:\s*0/s);
  assert.match(styles, /\.tool-material-responsibility \.dashboard-note-picker-trigger \{[^}]*height:\s*32px/s);
});


test("admin gets the shared searchable picker while office receives read-only text", () => {
  assert.match(pageSource, /const isAdmin = user\?\.role === "admin"/);
  assert.match(pageSource, /canEdit \? \([\s\S]*<DashboardNotePicker/);
  assert.match(pageSource, /searchPlaceholder="Büromitarbeiter suchen…"/);
  assert.match(pageSource, /emptyOptionLabel="Nicht festgelegt"/);
  assert.match(pageSource, /tool-material-responsibility-readonly/);
  assert.match(pageSource, /currentUser && !currentUser\.is_valid/);
});


test("responsibility is loaded and stored exclusively through the stable user ID", () => {
  assert.match(typeSource, /tool_responsible_user_id:\s*number \| null/);
  assert.match(typeSource, /display_name:\s*string/);
  assert.doesNotMatch(typeSource, /ToolResponsibleUser[\s\S]*username:/);
  assert.match(apiSource, /toolMaterialResponsibility\(\)/);
  assert.match(apiSource, /toolMaterialResponsibleUserOptions\(\)/);
  assert.match(apiSource, /method:\s*"PUT"/);
  assert.match(apiSource, /tool_responsible_user_id:\s*toolResponsibleUserId/);
  assert.match(pageSource, /setResponsibilityValue\(previousValue\)/);
});


test("this step does not add any tool notification trigger", () => {
  assert.doesNotMatch(pageSource, /createDashboardMessage|toolNotification/);
  assert.doesNotMatch(apiSource, /createToolMaterialMessage|notifyToolResponsibleUser/);
});
