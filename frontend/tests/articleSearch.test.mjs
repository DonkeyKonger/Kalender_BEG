import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(frontendRoot, "src/priceComparison/articleSearch.ts");
const source = readFileSync(sourcePath, "utf8");
const pageSource = readFileSync(resolve(frontendRoot, "src/pages/PriceComparisonPage.tsx"), "utf8");
const bundled = await build({
  stdin: {
    contents: `export { normalizeArticleSearchQuery, searchArticleIndex, useArticleSearchIndex } from "./src/priceComparison/articleSearch";`,
    resolveDir: frontendRoot,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  packages: "external",
  plugins: [{
    name: "article-search-runtime-stubs",
    setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "article-search-test" }));
      builder.onResolve({ filter: /^\.\/client$/ }, () => ({ path: "client", namespace: "article-search-test" }));
      builder.onLoad({ filter: /^react$/, namespace: "article-search-test" }, () => ({
        contents: `
          export const useCallback = (...args) => globalThis.__articleSearchHooks.useCallback(...args);
          export const useEffect = (...args) => globalThis.__articleSearchHooks.useEffect(...args);
          export const useMemo = (...args) => globalThis.__articleSearchHooks.useMemo(...args);
          export const useRef = (...args) => globalThis.__articleSearchHooks.useRef(...args);
          export const useState = (...args) => globalThis.__articleSearchHooks.useState(...args);
        `,
        loader: "js",
      }));
      builder.onLoad({ filter: /^client$/, namespace: "article-search-test" }, () => ({
        contents: `
          export const PRICE_COMPARISON_DATA_CHANGED_EVENT = "price-comparison:data-changed";
          export const priceRequest = (...args) => globalThis.__articleSearchPriceRequest(...args);
          export const queryPath = (path, values) => {
            const query = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== "")).toString();
            return query ? path + "?" + query : path;
          };
        `,
        loader: "js",
      }));
    },
  }],
});
const runtimeModule = { exports: {} };
new Function("require", "module", "exports", bundled.outputFiles[0].text)(createRequire(import.meta.url), runtimeModule, runtimeModule.exports);
const { normalizeArticleSearchQuery, searchArticleIndex, useArticleSearchIndex } = runtimeModule.exports;

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function snapshot(revision, articleNumber = revision) {
  return { revision, rows: [[articleNumber, `Artikel ${articleNumber}`, 12.5, [articleNumber.toLowerCase()]]], casefold: { A: "a" } };
}

function queuedRequester() {
  const requests = [];
  return {
    requests,
    request(path, options) {
      const pending = deferred();
      requests.push({ path, options, pending });
      return pending.promise;
    },
  };
}

function createHookHarness(t, requester, initialVisibility = "visible") {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalHooks = Object.getOwnPropertyDescriptor(globalThis, "__articleSearchHooks");
  const originalRequester = Object.getOwnPropertyDescriptor(globalThis, "__articleSearchPriceRequest");
  const documentTarget = new EventTarget();
  const windowTarget = new EventTarget();
  const intervals = new Map();
  let visibility = initialVisibility;
  let intervalId = 0;
  Object.defineProperty(documentTarget, "visibilityState", { get: () => visibility });
  windowTarget.setInterval = (callback, delay) => {
    intervalId += 1;
    intervals.set(intervalId, { callback, delay });
    return intervalId;
  };
  windowTarget.clearInterval = (id) => intervals.delete(id);
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentTarget });
  globalThis.__articleSearchPriceRequest = requester.request.bind(requester);

  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  const dependenciesChanged = (previous, next) => !previous || previous.length !== next.length
    || next.some((value, index) => !Object.is(value, previous[index]));
  globalThis.__articleSearchHooks = {
    useState(initialValue) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { kind: "state", value: typeof initialValue === "function" ? initialValue() : initialValue };
      return [slots[index].value, (value) => {
        slots[index].value = typeof value === "function" ? value(slots[index].value) : value;
      }];
    },
    useRef(initialValue) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { kind: "ref", value: { current: initialValue } };
      return slots[index].value;
    },
    useCallback(callback, dependencies) {
      return this.useMemo(() => callback, dependencies);
    },
    useMemo(factory, dependencies) {
      const index = cursor++;
      if (!slots[index] || dependenciesChanged(slots[index].dependencies, dependencies)) {
        slots[index] = { kind: "memo", dependencies, value: factory() };
      }
      return slots[index].value;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const slot = slots[index];
      if (slot && !dependenciesChanged(slot.dependencies, dependencies)) return;
      const next = { kind: "effect", dependencies, cleanup: slot?.cleanup };
      slots[index] = next;
      pendingEffects.push(() => {
        next.cleanup?.();
        next.cleanup = effect() ?? undefined;
      });
    },
  };

  const flushEffects = () => {
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((effect) => effect());
  };
  const render = (sessionKey, flush = true) => {
    cursor = 0;
    const result = useArticleSearchIndex(sessionKey);
    if (flush) flushEffects();
    return result;
  };
  const unmount = () => {
    slots.forEach((slot) => { if (slot?.kind === "effect") slot.cleanup?.(); });
  };
  const restore = (name, descriptor) => descriptor
    ? Object.defineProperty(globalThis, name, descriptor)
    : delete globalThis[name];
  t.after(() => {
    unmount();
    restore("window", originalWindow);
    restore("document", originalDocument);
    restore("__articleSearchHooks", originalHooks);
    restore("__articleSearchPriceRequest", originalRequester);
  });

  return {
    render,
    flushEffects,
    intervals,
    setVisibility(next) {
      visibility = next;
      documentTarget.dispatchEvent(new Event("visibilitychange"));
    },
    tickPoll() {
      [...intervals.values()].forEach(({ callback }) => callback());
    },
    mutate() {
      windowTarget.dispatchEvent(new Event("price-comparison:data-changed"));
    },
  };
}

async function settle() {
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

test("query normalization follows Python strip and the server casefold map", () => {
  const casefold = { A: "a", "ß": "ss", "İ": "i̇" };

  assert.equal(normalizeArticleSearchQuery("\u001cAß\u3000", casefold), "ass");
  assert.equal(normalizeArticleSearchQuery("\u00a0İ\u0085", casefold), "i̇");
  assert.equal(normalizeArticleSearchQuery("\ufeffA\ufeff", casefold), "\ufeffa\ufeff", "Python does not strip the JavaScript-only BOM whitespace");
});

test("literal index search covers arbitrary Datanorm values and preserves server order", () => {
  const rows = Array.from({ length: 55 }, (_, index) => [
    `A-${String(index).padStart(2, "0")}`,
    `Artikel ${index}`,
    index,
    index === 52 ? ["a-52", "sonderwert [a+b]"] : [`a-${String(index).padStart(2, "0")}`, `artikel ${index}`],
  ]);
  const snapshot = { revision: "rev-1", rows, casefold: { S: "s", A: "a", B: "b" } };

  assert.deepEqual(searchArticleIndex(snapshot, "Sonderwert [A+B]").map((row) => row.article_number), ["A-52"]);
  assert.deepEqual(searchArticleIndex(snapshot, "", 50).map((row) => row.article_number), rows.slice(0, 50).map((row) => row[0]));
  assert.deepEqual(searchArticleIndex(snapshot, "A-", 0), []);
});

test("the hook pauses while hidden and checks immediately when the page becomes visible", async (t) => {
  const requester = queuedRequester();
  const hook = createHookHarness(t, requester, "hidden");

  assert.equal(hook.render(7).snapshot, null);
  assert.equal(requester.requests.length, 0);
  assert.equal(hook.intervals.size, 0);

  hook.setVisibility("visible");
  assert.equal(requester.requests.length, 1);
  assert.equal(hook.intervals.size, 1);
  assert.equal([...hook.intervals.values()][0].delay, 5_000);
  requester.requests[0].pending.resolve(snapshot("rev-1"));
  await settle();
  assert.equal(hook.render(7).snapshot.revision, "rev-1");

  hook.tickPoll();
  assert.equal(requester.requests.length, 2);
  assert.match(requester.requests[1].path, /known_revision=rev-1/);
  hook.setVisibility("hidden");
  assert.equal(requester.requests[1].options.signal.aborted, true);
  assert.equal(hook.intervals.size, 0);
  requester.requests[1].pending.resolve(snapshot("ignored"));
  await settle();
  assert.equal(hook.render(7).snapshot.revision, "rev-1");

  hook.setVisibility("visible");
  assert.equal(requester.requests.length, 3);
  assert.match(requester.requests[2].path, /known_revision=rev-1/);
});

test("a session change hides the old snapshot synchronously and rejects the old response", async (t) => {
  const requester = queuedRequester();
  const hook = createHookHarness(t, requester);
  hook.render("session-a");
  requester.requests[0].pending.resolve(snapshot("rev-a", "A"));
  await settle();
  assert.equal(hook.render("session-a").snapshot.rows[0][0], "A");

  hook.tickPoll();
  const oldRequest = requester.requests[1];
  const firstNewSessionRender = hook.render("session-b", false);
  assert.equal(firstNewSessionRender.snapshot, null, "the previous account must not be exposed before effects run");
  assert.equal(firstNewSessionRender.loading, true);
  hook.flushEffects();
  assert.equal(oldRequest.options.signal.aborted, true);
  assert.equal(requester.requests.length, 3);

  oldRequest.pending.resolve(snapshot("late-a", "LEAK"));
  await settle();
  assert.equal(hook.render("session-b").snapshot, null);
  requester.requests[2].pending.resolve(snapshot("rev-b", "B"));
  await settle();
  assert.equal(hook.render("session-b").snapshot.rows[0][0], "B");
});

test("a mutation marks the index stale, aborts the poll, and only accepts the replacement", async (t) => {
  const requester = queuedRequester();
  const hook = createHookHarness(t, requester);
  hook.render(11);
  requester.requests[0].pending.resolve(snapshot("rev-1"));
  await settle();
  assert.equal(hook.render(11).stale, false);

  hook.tickPoll();
  const oldPoll = requester.requests[1];
  hook.mutate();
  assert.equal(oldPoll.options.signal.aborted, true);
  assert.equal(requester.requests.length, 3);
  assert.equal(hook.render(11).stale, true);

  oldPoll.pending.resolve(snapshot("late-revision"));
  await settle();
  assert.equal(hook.render(11).snapshot.revision, "rev-1");
  requester.requests[2].pending.resolve(snapshot("rev-2"));
  await settle();
  const current = hook.render(11);
  assert.equal(current.snapshot.revision, "rev-2");
  assert.equal(current.stale, false);
});

test("a background error keeps a stale snapshot and retry accepts an unchanged revision", async (t) => {
  const requester = queuedRequester();
  const hook = createHookHarness(t, requester);
  hook.render(23);
  requester.requests[0].pending.resolve(snapshot("rev-1"));
  await settle();
  const loaded = hook.render(23).snapshot;

  hook.tickPoll();
  requester.requests[1].pending.reject(new Error("Netz nicht erreichbar"));
  await settle();
  const stale = hook.render(23);
  assert.strictEqual(stale.snapshot, loaded);
  assert.equal(stale.stale, true);
  assert.equal(stale.error, "Netz nicht erreichbar");

  stale.retry();
  assert.equal(requester.requests.length, 3);
  requester.requests[2].pending.resolve({ revision: "rev-1", unchanged: true });
  await settle();
  const recovered = hook.render(23);
  assert.strictEqual(recovered.snapshot, loaded);
  assert.equal(recovered.stale, false);
  assert.equal(recovered.error, null);
});

test("the page-owned index polls only in memory and reacts to visibility and mutations", () => {
  assert.match(source, /article-search-index/);
  assert.match(source, /known_revision/);
  assert.match(source, /ARTICLE_SEARCH_POLL_MS\s*=\s*5_000/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /PRICE_COMPARISON_DATA_CHANGED_EVENT/);
  assert.match(source, /stale:\s*Boolean\(current\.snapshot\)/);
  assert.match(source, /currentRequest !== requestId\.current/);
  assert.match(source, /sessionKey/);
  assert.doesNotMatch(source, /localStorage|indexedDB|sessionStorage/);
});

test("article typing filters the page index immediately without a request debounce", () => {
  const articlesView = pageSource.slice(pageSource.indexOf("function ArticlesView"), pageSource.indexOf("const ArticleDetail"));

  assert.match(articlesView, /searchArticleIndex\(articleSearch\.snapshot, query\)/);
  assert.match(articlesView, /onChange=\{\(event\) => setQuery\(event\.target\.value\)\}/);
  assert.doesNotMatch(articlesView, /setTimeout|debounce|\/price-comparison\/articles/);
  assert.match(pageSource, /const ArticleDetail = memo\(/);
});
