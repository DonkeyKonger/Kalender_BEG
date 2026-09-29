import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");

test("project tabs follow the requested order and labels without changing navigation keys", () => {
  const config = source.slice(source.indexOf("const projectRecordTabs:"), source.indexOf("const timeEntryStatusLabels:"));
  assert.deepEqual([...config.matchAll(/key: "([^"]+)", label: "([^"]+)"/g)].map(match => [match[1], match[2]]), [
    ["overview", "Übersicht"], ["folders", "Projektdateien"], ["measurement", "Aufmaß"],
    ["extra-work", "Zusatzaufträge"], ["assembly-times", "Projektauswertung"], ["tools-material", "Werkzeuge"],
  ]);
});

test("main tabs use their label width without artificial widening in any workspace", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /--project-record-tab-width/);
  assert.match(css, /\.site-detail-page\.is-project-file-workspace \.project-record-tabs button \{\s*box-sizing: border-box;\s*flex: 0 0 auto;\s*width: auto;/);
  assert.match(css, /\.site-detail-page\.is-project-overview \.project-record-tabs button \{\s*flex: 0 0 auto;/);
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

test("main navigation retains the white surface and subtle blue active tabs in every workspace", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  for (const workspace of ["is-project-file-workspace", "is-measurement-review-workspace"]) {
    const selector = `.site-detail-page.${workspace} .project-record-tabs`;
    const strip = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
    const active = css.slice(css.indexOf(`${selector} button.is-active {`)).split("}")[0];
    assert.match(strip, /background: var\(--(?:pf|figma)-surface\);/);
    assert.match(strip, /gap: 0;/);
    assert.match(strip, /padding: 0 18px;/);
    assert.match(active, /background: #eff6ff;/);
    assert.match(active, /border-bottom-color: var\(--(?:pf|figma)-active\);/);
  }
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
