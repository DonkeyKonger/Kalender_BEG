import assert from "node:assert/strict";
import test from "node:test";

import { clampPageOffset, LatestRequestGate } from "../src/priceComparison/latestRequest.ts";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("a delayed mutation refresh reads the current sort and cannot restore the old query", async () => {
  const gate = new LatestRequestGate();
  const patch = deferred();
  const mutationReload = deferred();
  const sortedReload = deferred();
  const published = [];
  const query = { sort: "date" };

  async function load(name, pending) {
    const requestQuery = { ...query };
    const request = gate.begin();
    const value = await pending.promise;
    if (request.isCurrent()) published.push([name, requestQuery.sort, value]);
    request.finish();
    return request.signal.aborted;
  }

  const save = (async () => {
    await patch.promise;
    return load("mutation", mutationReload);
  })();
  query.sort = "price_asc";
  const sortLoad = load("sort", sortedReload);
  patch.resolve();
  await Promise.resolve();

  sortedReload.resolve("superseded sorted rows");
  assert.equal(await sortLoad, true);
  assert.deepEqual(published, []);

  mutationReload.resolve("current rows after save");
  assert.equal(await save, false);
  assert.deepEqual(published, [["mutation", "price_asc", "current rows after save"]]);
});

test("invalidating the view aborts the active request and makes it stale", () => {
  const gate = new LatestRequestGate();
  const request = gate.begin();

  gate.invalidate();

  assert.equal(request.signal.aborted, true);
  assert.equal(request.isCurrent(), false);
});

test("a shrinking result total returns an empty last page to the last valid page", () => {
  assert.equal(clampPageOffset(40, 21, 20), 20);
  assert.equal(clampPageOffset(20, 20, 20), 0);
  assert.equal(clampPageOffset(20, 0, 20), 0);
  assert.equal(clampPageOffset(0, 45, 20), 0);
});
