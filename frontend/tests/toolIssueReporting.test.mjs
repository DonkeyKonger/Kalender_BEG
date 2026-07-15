import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildToolMaterialSearchParams } from "../src/lib/toolMaterialFilters.ts";
import {
  buildToolMaterialIssuePath,
  clearToolMaterialIdFilter,
  getToolMaterialIdFilter,
} from "../src/lib/toolMaterialRouting.ts";


const [mobileSource, dashboardSource, toolsSource, apiSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MobilePersonalFilePage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MiscellaneousPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);


test("preview and full list share the two-reason report action", () => {
  assert.match(mobileSource, /data\.tool_preview\.map[\s\S]*<MobilePersonalToolRow/);
  assert.match(mobileSource, /items\.map[\s\S]*<MobilePersonalToolRow/);
  assert.match(mobileSource, /Problem mit diesem Werkzeug melden/);
  assert.match(mobileSource, /chooseReason\("DEFECTIVE"\)/);
  assert.match(mobileSource, /chooseReason\("STOLEN"\)/);
  assert.match(mobileSource, /Der Werkzeug-Beauftragte wird informiert/);
  assert.match(apiSource, /\/me\/personal-file\/tools\/\$\{toolId\}\/report/);
  assert.match(styles, /\.mobile-tool-issue-trigger \{[^}]*width:\s*44px;[^}]*height:\s*44px/s);
  assert.match(styles, /\.mobile-tool-issue-sheet \{[^}]*max-height:\s*calc\(100dvh - 32px\)/s);
});


test("message navigation and API filtering use the stable tool ID", () => {
  const path = buildToolMaterialIssuePath(25043);
  const search = new URLSearchParams(path.split("?")[1]);
  assert.equal(path, "/sonstige?tab=toolsMaterial&toolId=25043");
  assert.equal(getToolMaterialIdFilter(search), 25043);
  assert.equal(buildToolMaterialSearchParams({ toolId: 25043 }).get("tool_id"), "25043");
  assert.equal(clearToolMaterialIdFilter(search).has("toolId"), false);
  assert.match(dashboardSource, /await api\.dismissDashboardMessage\(message\.message_key\)[\s\S]*navigate\(buildToolMaterialIssuePath\(message\.tool_id\)\)/);
  assert.match(toolsSource, /Werkzeug-ID \{toolIdFilter\}/);
  assert.match(toolsSource, /Das gemeldete Werkzeug ist nicht mehr verfügbar/);
});


test("manual remarks and red structured system notes remain separate", () => {
  assert.match(toolsSource, /item\.remarks \? <span title=\{item\.remarks\}>\{item\.remarks\}<\/span>/);
  assert.match(toolsSource, /item\.open_issue_reports\.map/);
  assert.match(toolsSource, /report\.reason === "DEFECTIVE" \? "Maschine defekt" : "Maschine entwendet"/);
  assert.match(styles, /\.tool-material-system-note \{[^}]*color:\s*#a23f3f/s);
});
