import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");

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
