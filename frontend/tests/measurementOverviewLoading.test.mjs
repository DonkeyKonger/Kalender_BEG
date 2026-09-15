import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";

const source = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const start = source.lastIndexOf("  useEffect(() => {", source.indexOf("async function loadMeasurementItems()"));
const end = source.indexOf("  useEffect(() => {", start + 1);
const effect = transformSync(source.slice(start, end), {loader: "tsx"}).code;

async function load(overrides = {}) {
  const calls = [];
  const writes = {};
  let callback;
  let done;
  const completion = new Promise(resolve => {done = resolve;});
  const context = {
    site: {id: 8}, activeTab: "measurement", measurementSubtab: "review",
    measurementLoaded: false, measurementLoading: false, measurementError: null,
    measurementBases: [{id: 1}], measurementCatalogItems: [{id: 2}], measurementTimesheet: null,
    ...overrides,
    useEffect: fn => {callback = fn;},
    startMeasurementTimesheetPerformanceTiming: () => 0,
    logMeasurementTimesheetPerformance: () => {},
    readApiError: () => "Fehler",
    api: Object.fromEntries(["measurementBases", "measurementItems", "measurementTimesheet"].map(name => [name, async () => {
      calls.push(name);
      return name === "measurementTimesheet" ? {active_batch_ids: [1], rows: []} : [];
    }])),
    ...Object.fromEntries(["MeasurementLoading", "MeasurementError", "MeasurementBases", "MeasurementCatalogItems", "MeasurementTimesheet", "MeasurementLoaded"].map(name => [`set${name}`, value => {
      writes[name] = value;
      if (name === "MeasurementLoading" && value === false) done();
    }])),
  };
  new Function(...Object.keys(context), effect)(...Object.values(context));
  callback();
  if (calls.length) await completion;
  return {calls, writes};
}

test("overview does not request or reset the aggregated timesheet", async () => {
  const result = await load();
  assert.deepEqual(result.calls, ["measurementBases", "measurementItems"]);
  assert.equal(result.writes.MeasurementLoaded, true);
  assert.equal("MeasurementTimesheet" in result.writes, false);
});

test("switching to execution loads the missing timesheet but reuses catalog and bases", async () => {
  const result = await load({measurementSubtab: "timesheet", measurementLoaded: true});
  assert.deepEqual(result.calls, ["measurementTimesheet"]);
  assert.deepEqual(result.writes.MeasurementTimesheet, {active_batch_ids: [1], rows: []});
});

test("execution deep link loads all required data, bases deep link skips aggregation", async () => {
  assert.equal((await load({measurementSubtab: "timesheet"})).calls.length, 3);
  assert.deepEqual((await load({measurementSubtab: "bases"})).calls, ["measurementBases", "measurementItems"]);
});

test("cached results, in-flight requests and failures do not trigger repeated requests", async () => {
  for (const state of [
    {measurementLoaded: true}, {measurementLoading: true}, {measurementError: "Fehler"},
    {measurementSubtab: "timesheet", measurementLoaded: true, measurementTimesheet: {rows: []}},
    {activeTab: "extra-work"}, {site: null},
  ]) assert.deepEqual((await load(state)).calls, []);
});
