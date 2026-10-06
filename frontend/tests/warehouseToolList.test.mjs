import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createWarehouseToolList } from "../src/lib/warehouseToolList.ts";

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const list = createWarehouseToolList((search, offset, signal) => new Promise((resolve, reject) => {
    calls.push({ search, offset, signal, resolve, reject });
  }));
  t.after(() => list.pause());
  return { list, calls, tick: (ms) => t.mock.timers.tick(ms) };
}
const flush = () => Promise.resolve();
const page = (id, total = 80) => ({ items: [{ id, designation: `Werkzeug ${id}` }], total });

test("initial load, pagination and retry start immediately without a search debounce", async (t) => {
  const { list, calls } = fixture(t);
  assert.equal(calls.length, 0);
  list.resume();
  assert.equal(calls.length, 1);
  calls[0].resolve(page(1)); await flush();
  list.goTo(40);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].offset, 40);
  calls[1].reject(new Error("Offline")); await flush();
  list.retry();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].offset, 40);
});

test("only typing is debounced; old page stays stable and pagination stays tied to visible data", async (t) => {
  const { list, calls, tick } = fixture(t);
  list.resume(); calls[0].resolve(page(1)); await flush();
  list.goTo(40); calls[1].resolve(page(41)); await flush();
  const previousPage = list.getSnapshot().page;
  list.search("B"); tick(100);
  list.search("Bosch"); tick(179);
  assert.equal(calls.length, 2);
  assert.equal(list.getSnapshot().page, previousPage);
  assert.equal(list.getSnapshot().pageOffset, 40);
  assert.equal(list.getSnapshot().offset, 0);
  assert.equal(list.getSnapshot().loading, true);
  list.goTo(80);
  assert.equal(calls.length, 2, "cannot page through stale results while searching");
  tick(1);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].search, "Bosch");
  assert.equal(calls[2].offset, 0);
  calls[2].resolve(page(2, 1)); await flush();
  assert.equal(list.getSnapshot().page.items[0].id, 2);
  assert.equal(list.getSnapshot().pageOffset, 0);
  assert.equal(list.getSnapshot().pageSearch, "Bosch");
  assert.equal(list.getSnapshot().loading, false);
});

test("clearing search loads immediately and whitespace-only edits do not refetch", async (t) => {
  const { list, calls, tick } = fixture(t);
  list.resume(); calls[0].resolve(page(1)); await flush();
  list.search(" Akku "); tick(180);
  assert.equal(calls[1].search, "Akku");
  calls[1].resolve(page(2)); await flush();
  list.search("Akku  "); tick(200);
  assert.equal(calls.length, 2);
  list.search("");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].search, "");
});

test("late responses and late errors cannot overwrite a newer query", async (t) => {
  const { list, calls, tick } = fixture(t);
  list.resume(); calls[0].resolve(page(1)); await flush();
  list.search("Alt"); tick(180);
  list.search("Neu"); tick(180);
  assert.equal(calls[1].signal.aborted, true);
  calls[2].resolve(page(3)); await flush();
  calls[1].resolve(page(2)); await flush();
  assert.equal(list.getSnapshot().page.items[0].id, 3);
  list.search("Fehler"); tick(180);
  list.search("Erfolg"); tick(180);
  calls[4].resolve(page(4)); await flush();
  calls[3].reject(new Error("Old error")); await flush();
  assert.equal(list.getSnapshot().error, null);
  assert.equal(list.getSnapshot().page.items[0].id, 4);
});

test("signature step preserves query, page and data, then immediately revalidates on return", async (t) => {
  const { list, calls, tick } = fixture(t);
  list.resume(); calls[0].resolve(page(1)); await flush();
  list.search("Bosch"); tick(180); calls[1].resolve(page(2)); await flush();
  list.goTo(40); calls[2].resolve(page(42)); await flush();
  const previous = list.getSnapshot();
  list.pause(); tick(10000);
  assert.equal(calls.length, 3);
  assert.equal(list.getSnapshot(), previous);
  list.resume();
  assert.equal(calls.length, 4);
  assert.equal(calls[3].search, "Bosch");
  assert.equal(calls[3].offset, 40);
  assert.equal(list.getSnapshot().page, previous.page);
  assert.equal(list.getSnapshot().loading, true);
  calls[3].resolve(page(43)); await flush();
  assert.equal(list.getSnapshot().page.items[0].id, 43);
});

test("leaving cancels pending searches and requests, and isolated contexts start empty", async (t) => {
  const { list, calls, tick } = fixture(t);
  list.resume();
  list.pause();
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve(page(1)); await flush();
  assert.equal(list.getSnapshot().page, null);
  list.resume(); calls[1].resolve(page(2)); await flush();
  list.search("Bosch"); list.pause(); tick(500);
  assert.equal(calls.length, 2);
  list.resume();
  assert.equal(calls[2].search, "Bosch", "pending query survives step navigation");
  const another = createWarehouseToolList(async () => page(99));
  assert.equal(another.getSnapshot().page, null);
  assert.equal(another.getSnapshot().search, "");
  assert.equal(another.getSnapshot().offset, 0);
});

test("refresh errors preserve visible results and retry recovers without blanking them", async (t) => {
  const { list, calls } = fixture(t);
  list.resume(); calls[0].resolve(page(1)); await flush();
  const previousPage = list.getSnapshot().page;
  list.goTo(40); calls[1].reject(new Error("Offline")); await flush();
  assert.equal(list.getSnapshot().page, previousPage);
  assert.equal(list.getSnapshot().pageOffset, 0);
  assert.equal(list.getSnapshot().loading, false);
  assert.equal(list.getSnapshot().error.message, "Offline");
  list.goTo(0);
  assert.equal(calls.length, 2, "failed stale page remains noninteractive");
  list.retry();
  assert.equal(list.getSnapshot().page, previousPage);
  calls[2].resolve(page(41)); await flush();
  assert.equal(list.getSnapshot().pageOffset, 40);
  assert.equal(list.getSnapshot().error, null);
});

test("snapshot subscriptions are stable, notify updates and clean up", async (t) => {
  const { list, calls } = fixture(t);
  assert.equal(list.getSnapshot(), list.getSnapshot());
  let notifications = 0;
  const unsubscribe = list.subscribe(() => notifications++);
  list.resume();
  calls[0].resolve(page(1)); await flush();
  assert.equal(notifications, 2);
  unsubscribe(); list.retry();
  assert.equal(notifications, 2);
});

test("revalidation moves to a valid page if stock shrank during review", async (t) => {
  const { list, calls } = fixture(t);
  list.resume(); calls[0].resolve(page(1)); await flush();
  list.goTo(40); calls[1].resolve(page(41)); await flush();
  list.pause(); list.resume();
  calls[2].resolve({ items: [], total: 25 }); await flush();
  assert.equal(calls[3].offset, 0);
  assert.equal(list.getSnapshot().page.items[0].id, 41, "retain old page until replacement arrives");
  calls[3].resolve(page(2, 25)); await flush();
  assert.equal(list.getSnapshot().pageOffset, 0);
  assert.equal(list.getSnapshot().offset, 0);
});

test("empty stock resets pagination, and initial errors allow immediate retry", async (t) => {
  const { list, calls } = fixture(t);
  list.resume(); calls[0].reject(new Error("Offline")); await flush();
  assert.equal(list.getSnapshot().page, null);
  assert.equal(list.getSnapshot().loading, false);
  list.retry(); calls[1].resolve(page(1)); await flush();
  list.goTo(40); calls[2].resolve({ items: [], total: 0 }); await flush();
  assert.deepEqual(list.getSnapshot().page, { items: [], total: 0 });
  assert.equal(list.getSnapshot().offset, 0);
  assert.equal(list.getSnapshot().pageOffset, 0);
  assert.equal(list.getSnapshot().loading, false);
});

test("UI retains list data above the signature step and protects stale visible results", async () => {
  const source = await readFile(new URL("../src/pages/WarehousePage.tsx", import.meta.url), "utf8");
  const hook = await readFile(new URL("../src/hooks/useWarehouseToolList.ts", import.meta.url), "utf8");
  const selection = source.slice(source.indexOf("function ToolSelection("), source.indexOf("function BookingReview("));
  assert.match(source, /useWarehouseToolList\(direction, person\?\.id \?\? null, !!person && !review\)/);
  assert.match(source, /tools=\{toolList\}/);
  assert.match(hook, /\[direction, personId\]/);
  assert.match(hook, /return \(\) => list\.pause\(\)/);
  assert.match(selection, /\{page && <div className="wh-tool-results" aria-busy=\{loading\}>/);
  assert.match(selection, /disabled=\{unavailable \|\| \(!checked && selected\.length === 100\)\}/);
  assert.doesNotMatch(selection, /useEffect|setTimeout|setPage|setSearch/);
});
