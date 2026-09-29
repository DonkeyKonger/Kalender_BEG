import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");

test("project tabs follow the requested order and labels without changing navigation keys", () => {
  const config = source.slice(source.indexOf("const projectRecordTabs:"), source.indexOf("const timeEntryStatusLabels:"));
  assert.deepEqual([...config.matchAll(/key: "([^"]+)", label: "([^"]+)"/g)].map(match => [match[1], match[2]]), [
    ["overview", "Übersicht"], ["folders", "Dateien"], ["measurement", "Aufmaß"],
    ["extra-work", "Zusatzaufträge"], ["assembly-times", "Auswertung"], ["tools-material", "Werkzeuge"],
  ]);
});

test("all main tabs retain the compact width in overview and other workspaces", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.site-detail-page\.is-project-file-workspace \.project-record-tabs \{\s*\/\*[^]*?\*\/\s*--project-record-tab-width: 136px;/);
  assert.match(css, /\.site-detail-page\.is-project-file-workspace \.project-record-tabs button \{\s*box-sizing: border-box;\s*flex: 0 0 var\(--project-record-tab-width\);\s*width: var\(--project-record-tab-width\);/);
  assert.match(css, /\.site-detail-page\.is-project-overview \.project-record-tabs button \{\s*flex: 0 0 var\(--project-record-tab-width\);/);
  // Only the navigation label is shortened, not the tools/material content.
  assert.match(source, /title="Werkzeuge & Material"/);
});

test("measurement navigation prioritizes review without removing the other sections", () => {
  const config = source.slice(source.indexOf("const measurementSubtabs:"), source.indexOf("const projectRecordTabs:"));
  assert.deepEqual([...config.matchAll(/key: "([^"]+)", label: "([^"]+)"/g)].map(match => [match[1], match[2]]), [
    ["review", "Prüfung"], ["timesheet", "Ausführungsstand"],
    ["time-analysis", "Zeitauswertung"], ["bases", "Zeitenlisten"],
  ]);
});

test("initial and default URL navigation open review while explicit deep links are retained", () => {
  assert.match(source, /\[measurementSubtab, setMeasurementSubtab\] = useState<MeasurementSubtab>\("review"\)/);
  assert.match(source, /setMeasurementSubtab\(\s*measurementSubtabs.some\(\(tab\) => tab.key === requestedMeasurementSubtab\)\s*\? requestedMeasurementSubtab as MeasurementSubtab\s*: "review"/);
});

test("every click on Aufmaß selects review; other main tabs preserve the subtab", () => {
  const handler = source.slice(source.indexOf("  function changeProjectRecordTab("), source.indexOf("  async function selectMeasurementBatch("))
    .replace("(nextTab: ProjectRecordTab): void", "(nextTab)");
  const calls = [];
  const changeTab = new Function("setActiveTab", "setMeasurementSubtab", "setSelectedExtraWorkTicket", "setExtraWorkDocumentDirty",
    `const selectedExtraWorkTicket = null; const extraWorkDocumentDirty = false; ${handler}; return changeProjectRecordTab;`)(
      value => calls.push(["main", value]), value => calls.push(["sub", value]), () => {}, () => {},
    );
  changeTab("measurement");
  changeTab("folders");
  changeTab("measurement");
  assert.deepEqual(calls, [["main", "measurement"], ["sub", "review"], ["main", "folders"], ["main", "measurement"], ["sub", "review"]]);
});
