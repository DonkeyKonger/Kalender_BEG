import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";

const source = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const start = source.indexOf("  async function loadMeasurementBatches(");
const code = transformSync(source.slice(start, source.indexOf("  async function loadMeasurementWorkers(", start)), {loader:"tsx"}).code;

function harness() {
  const state = {MeasurementBatches: [{id:1}], MeasurementArchiveMode:false, MeasurementBatchesLoaded:true};
  const requests = [];
  const context = {
    site:{id:7}, measurementArchiveMode:false, measurementBatchesRequestRef:{current:0},
    readApiError: () => "Testfehler",
    api:{siteMeasurementBatches: (site, options) => new Promise((resolve,reject) => requests.push({site,options,resolve,reject}))},
    ...Object.fromEntries(["MeasurementBatches", "MeasurementArchiveMode", "MeasurementBatchesLoaded", "MeasurementBatchesLoading", "MeasurementArchiveSwitching", "MeasurementBatchesError", "MeasurementReviewError", "MeasurementReviewMessage", "SelectedMeasurementBatch", "MeasurementBatchItems"].map(name=>[`set${name}`, value=>{state[name]=typeof value==='function'?value(state[name]):value;}])),
  };
  const load = new Function(...Object.keys(context), `${code}; return loadMeasurementBatches;`)(...Object.values(context));
  return {load,state,requests,context};
}

test("archive switch preserves current contents and mode until the complete result arrives", async () => {
  const h = harness();
  const pending = h.load(true,true);
  assert.equal(h.state.MeasurementArchiveSwitching,true);
  assert.deepEqual(h.state.MeasurementBatches,[{id:1}]);
  assert.equal(h.state.MeasurementArchiveMode,false);
  assert.notEqual(h.state.MeasurementBatchesLoading,true);
  h.requests[0].resolve([{id:2}]);
  await pending;
  assert.deepEqual(h.state.MeasurementBatches,[{id:2}]);
  assert.equal(h.state.MeasurementArchiveMode,true);
  assert.equal(h.state.MeasurementArchiveSwitching,false);
});

test("empty archive and return to active are valid atomic results", async () => {
  const h = harness();
  let pending=h.load(true,true);
  h.requests[0].resolve([]);
  await pending;
  assert.deepEqual(h.state.MeasurementBatches,[]);
  assert.equal(h.state.MeasurementArchiveMode,true);
  pending=h.load(false,true);
  h.requests[1].resolve([{id:1}]);
  await pending;
  assert.deepEqual(h.state.MeasurementBatches,[{id:1}]);
  assert.equal(h.state.MeasurementArchiveMode,false);
});

test("failed switching keeps the working list and releases the controls for retry", async () => {
  const h=harness();
  const pending=h.load(true,true);
  h.requests[0].reject(new Error("failure"));
  await pending;
  assert.deepEqual(h.state.MeasurementBatches,[{id:1}]);
  assert.equal(h.state.MeasurementArchiveMode,false);
  assert.equal(h.state.MeasurementReviewError,"Testfehler");
  assert.equal(h.state.MeasurementBatchesError,null);
  assert.equal(h.state.MeasurementArchiveSwitching,false);
});

test("obsolete request cannot overwrite another request or a different site's state", async () => {
  const h=harness();
  const old=h.load(true,true);
  const latest=h.load(false,true);
  h.requests[0].resolve([{id:99}]);
  await old;
  assert.equal(h.state.MeasurementArchiveSwitching,true);
  assert.deepEqual(h.state.MeasurementBatches,[{id:1}]);
  h.context.measurementBatchesRequestRef.current += 1;
  h.requests[1].resolve([{id:100}]);
  await latest;
  assert.deepEqual(h.state.MeasurementBatches,[{id:1}]);
});
