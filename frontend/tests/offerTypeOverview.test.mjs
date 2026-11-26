import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const pagePath = fileURLToPath(new URL("../src/pages/PriceComparisonPage.tsx", import.meta.url));
const pageSource = readFileSync(pagePath, "utf8");
const stubModules = new Map([
  ["react", `
    export const memo = component => component;
    export const useRef = (...args) => globalThis.__offerTypeHooks.useRef(...args);
    export const useState = (...args) => globalThis.__offerTypeHooks.useState(...args);
    export const useId = (...args) => globalThis.__offerTypeHooks.useId(...args);
    export const useCallback = (...args) => globalThis.__offerTypeHooks.useCallback(...args);
    export const useEffect = (...args) => globalThis.__offerTypeHooks.useEffect(...args);
    export const useLayoutEffect = (...args) => globalThis.__offerTypeHooks.useEffect(...args);
    export const useMemo = (...args) => globalThis.__offerTypeHooks.useMemo(...args);
  `],
  ["react/jsx-runtime", `
    const element = (type, props, key) => ({ type, key: key ?? null, props: props ?? {} });
    export const jsx = element;
    export const jsxs = element;
    export const Fragment = Symbol.for("offer-type-test-fragment");
  `],
  ["react-dom", "export const createPortal = value => value;"],
  ["react-router-dom", "export const useSearchParams = () => [new URLSearchParams(), () => {}];"],
  ["../auth/AuthContext", "export const useAuth = () => ({ user: { id: 1, role: 'admin' } });"],
  ["../components/MapFilterSelect", "export const MapFilterSelect = () => null;"],
  ["lucide-react", `
    const icon = props => ({ type: "icon", props });
    export const Calculator = icon; export const ChartNoAxesCombined = icon; export const Check = icon;
    export const ChevronLeft = icon; export const ChevronRight = icon; export const CircleMinus = icon;
    export const Download = icon; export const Ellipsis = icon; export const FileArchive = icon;
    export const FileSpreadsheet = icon; export const FileText = icon; export const FolderSync = icon;
    export const Info = icon; export const LoaderCircle = icon; export const Plus = icon;
    export const RefreshCw = icon; export const RotateCcw = icon; export const Save = icon;
    export const Search = icon; export const Trash2 = icon; export const TrendingDown = icon;
    export const TrendingUp = icon; export const Upload = icon; export const X = icon;
  `],
  ["price-client", `
    export const PRICE_COMPARISON_DATA_CHANGED_EVENT = "price-comparison:data-changed";
    export class PriceComparisonError extends Error {
      constructor(status, message, detail) {
        super(message); this.name = "PriceComparisonError"; this.status = status; this.detail = detail;
      }
    }
    export const priceRequest = (...args) => globalThis.__offerTypePriceRequest(...args);
    export const priceDownload = (...args) => globalThis.__offerTypePriceDownload?.(...args);
    export const queryPath = (path, values) => {
      const query = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== "")).toString();
      return query ? path + "?" + query : path;
    };
    export const announcePriceComparisonDataChanged = () => {};
    export const triggerDownload = () => {};
  `],
]);

const bundled = await build({
  stdin: {
    contents: `${pageSource}\nexport { OffersView, OfferTypeSelect, PriceComparisonError as OfferTypePriceComparisonError };`,
    resolveDir: dirname(pagePath),
    sourcefile: "PriceComparisonPage.offer-type.test.tsx",
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  loader: { ".css": "empty" },
  plugins: [{
    name: "offer-type-overview-stubs",
    setup(builder) {
      for (const name of ["react", "react/jsx-runtime", "react-dom", "react-router-dom", "lucide-react"]) {
        builder.onResolve({ filter: new RegExp(`^${name.replaceAll("/", "\\/")}$`) }, () => ({ path: name, namespace: "offer-type-test" }));
      }
      for (const name of ["../auth/AuthContext", "../components/MapFilterSelect"]) {
        builder.onResolve({ filter: new RegExp(`^${name.replaceAll(".", "\\.").replaceAll("/", "\\/")}$`) }, () => ({ path: name, namespace: "offer-type-test" }));
      }
      builder.onResolve({ filter: /^(\.\/client|\.\.\/priceComparison\/client)$/ }, () => ({ path: "price-client", namespace: "offer-type-test" }));
      builder.onLoad({ filter: /.*/, namespace: "offer-type-test" }, ({ path }) => ({ contents: stubModules.get(path), loader: "js" }));
    },
  }],
});
const componentModule = { exports: {} };
new Function("module", "exports", bundled.outputFiles[0].text)(componentModule, componentModule.exports);
const { OffersView, OfferTypeSelect, OfferTypePriceComparisonError } = componentModule.exports;

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function offer(source, type = "Erstangebot", project = "Projekt Alpha") {
  return {
    source,
    project,
    offer_number: "A-100",
    date: "2026-11-26",
    offer_type: type,
    discount: 0,
    align_netto: false,
    position_count: 4,
    total_net: 1234.56,
    price_change: 2.5,
    price_change_positions: 2.5,
  };
}

function offersResult(revision, offers) {
  return { offers, total: offers.length, price_level_counts: { all: offers.length, below: 0, above: offers.length, none: 0 }, revision };
}

function queuedRequester() {
  const requests = [];
  return {
    requests,
    request(path, options = {}) {
      const pending = deferred();
      requests.push({ path, options, pending });
      return pending.promise;
    },
  };
}

function createHarness(t, requester) {
  const originals = new Map([
    ["window", Object.getOwnPropertyDescriptor(globalThis, "window")],
    ["document", Object.getOwnPropertyDescriptor(globalThis, "document")],
    ["__offerTypeHooks", Object.getOwnPropertyDescriptor(globalThis, "__offerTypeHooks")],
    ["__offerTypePriceRequest", Object.getOwnPropertyDescriptor(globalThis, "__offerTypePriceRequest")],
  ]);
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  windowTarget.matchMedia = () => ({ matches: false });
  windowTarget.requestAnimationFrame = () => 1;
  windowTarget.cancelAnimationFrame = () => {};
  windowTarget.scrollTo = () => {};
  windowTarget.scrollX = 0;
  windowTarget.scrollY = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentTarget });
  globalThis.__offerTypePriceRequest = requester.request.bind(requester);

  const slots = [];
  let cursor = 0;
  let nextId = 0;
  let pendingEffects = [];
  let mounted = true;
  const dependenciesChanged = (previous, next) => !previous || previous.length !== next.length
    || next.some((value, index) => !Object.is(value, previous[index]));
  globalThis.__offerTypeHooks = {
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
    useId() {
      const index = cursor++;
      if (!slots[index]) slots[index] = { kind: "id", value: `offer-type-id-${++nextId}` };
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

  const operations = [];
  const backgroundMutations = [];
  const properties = {
    uploadRevision: null,
    onUploadBlock() {},
    onOperation: (started) => operations.push(started),
    onBackgroundMutation: (revision) => backgroundMutations.push(revision),
  };
  const flushEffects = () => {
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((effect) => effect());
  };
  const render = (flush = true) => {
    cursor = 0;
    const tree = OffersView(properties);
    if (flush) flushEffects();
    return tree;
  };
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    slots.forEach((slot) => { if (slot?.kind === "effect") slot.cleanup?.(); });
  };
  const restore = (name, descriptor) => descriptor
    ? Object.defineProperty(globalThis, name, descriptor)
    : delete globalThis[name];
  t.after(() => {
    unmount();
    originals.forEach((descriptor, name) => restore(name, descriptor));
  });
  return { render, unmount, operations, backgroundMutations };
}

function visit(node, callback, ancestors = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => visit(child, callback, ancestors));
    return;
  }
  if (!node || typeof node !== "object") return;
  callback(node, ancestors);
  visit(node.props?.children, callback, [...ancestors, node]);
}

function findAll(tree, predicate) {
  const matches = [];
  visit(tree, (node, ancestors) => { if (predicate(node, ancestors)) matches.push(node); });
  return matches;
}

function findNode(tree, predicate) {
  const match = findAll(tree, predicate)[0];
  assert.ok(match, "expected component node was not rendered");
  return match;
}

function offerTypeControls(tree) {
  return findAll(tree, (node) => node.type === OfferTypeSelect);
}

function offerTypeFilter(tree) {
  return findNode(tree, (node) => node.props?.label === "Angebotsart" && typeof node.props?.onChange === "function");
}

function offerPagination(tree) {
  return findNode(tree, (node) => node.props?.limit === 20 && typeof node.props?.total === "number" && typeof node.props?.onChange === "function");
}

async function settle() {
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

async function loadInitialOffers(harness, requester, data) {
  harness.render();
  assert.equal(requester.requests.length, 1);
  requester.requests[0].pending.resolve(data);
  await settle();
  return harness.render();
}

test("changing a type PATCHes only offer_type with the current revision, locks duplicates and reloads", async (t) => {
  const requester = queuedRequester();
  const harness = createHarness(t, requester);
  const source = "Angebot / #1.pdf";
  let tree = await loadInitialOffers(harness, requester, offersResult("revision-a", [
    offer(source),
    offer("Zweites.pdf", "Folgeangebot", "Projekt Beta"),
  ]));
  const controls = offerTypeControls(tree);
  assert.equal(controls.length, 2);

  controls[0].props.onChange("Folgeangebot");
  controls[1].props.onChange("Verhandeltes Angebot");
  assert.equal(requester.requests.length, 2, "the synchronous ref must reject a parallel second choice");
  assert.deepEqual(harness.operations, [true]);
  assert.equal(requester.requests[1].path, "/price-comparison/offers/Angebot%20%2F%20%231.pdf");
  assert.equal(requester.requests[1].options.method, "PATCH");
  assert.deepEqual(JSON.parse(requester.requests[1].options.body), {
    expected_revision: "revision-a",
    offer_type: "Folgeangebot",
  });

  requester.requests[1].pending.resolve({ revision: "mutation-revision" });
  await settle();
  assert.equal(requester.requests.length, 3, "a successful mutation must reload the current overview");
  requester.requests[2].pending.resolve(offersResult("revision-b", [
    offer(source, "Folgeangebot"),
    offer("Zweites.pdf", "Folgeangebot", "Projekt Beta"),
  ]));
  await settle();
  tree = harness.render();
  assert.equal(offerTypeControls(tree)[0].props.type, "Folgeangebot");
  assert.deepEqual(harness.operations, [true, false]);

  offerTypeControls(tree)[0].props.onChange("Erstangebot");
  assert.deepEqual(JSON.parse(requester.requests[3].options.body), {
    expected_revision: "revision-b",
    offer_type: "Erstangebot",
  }, "the next mutation must use the revision returned by the reload");
  requester.requests[3].pending.resolve({ revision: "mutation-revision-2" });
  await settle();
  requester.requests[4].pending.resolve(offersResult("revision-c", [offer(source)]));
  await settle();
  assert.deepEqual(harness.operations, [true, false, true, false]);
  assert.deepEqual(harness.backgroundMutations, [], "mounted mutations reload locally without notifying the parent");
});

test("selecting the unchanged type is a no-op", async (t) => {
  const requester = queuedRequester();
  const harness = createHarness(t, requester);
  const tree = await loadInitialOffers(harness, requester, offersResult("revision-a", [offer("Unchanged.pdf")]));

  offerTypeControls(tree)[0].props.onChange("Erstangebot");

  assert.equal(requester.requests.length, 1);
  assert.deepEqual(harness.operations, []);
});

test("a 409 is shown without replaying the PATCH or reloading", async (t) => {
  const requester = queuedRequester();
  const harness = createHarness(t, requester);
  let tree = await loadInitialOffers(harness, requester, offersResult("revision-old", [offer("Conflict.pdf")]));
  offerTypeControls(tree)[0].props.onChange("Folgeangebot");

  requester.requests[1].pending.reject(new OfferTypePriceComparisonError(409, "Konflikt"));
  await settle();
  tree = harness.render();

  assert.equal(requester.requests.length, 2, "a conflicting write must never be replayed automatically");
  assert.deepEqual(harness.operations, [true, false]);
  const notice = findNode(tree, (node) => typeof node.type === "function" && node.props?.tone === "error");
  assert.match(String(notice.props.children), /Datenstand wurde zwischenzeitlich geändert/);
  assert.equal(offerTypeControls(tree)[0].props.disabled, true);
});

test("unmount after PATCH prevents the reload while balancing the operation counter", async (t) => {
  const requester = queuedRequester();
  const harness = createHarness(t, requester);
  const tree = await loadInitialOffers(harness, requester, offersResult("revision-a", [offer("Unmount.pdf")]));
  offerTypeControls(tree)[0].props.onChange("Folgeangebot");
  harness.unmount();

  requester.requests[1].pending.resolve({ revision: "mutation-after-unmount" });
  await settle();

  assert.equal(requester.requests.length, 2, "an unmounted view must not start a list reload");
  assert.deepEqual(harness.operations, [true, false]);
  assert.deepEqual(harness.backgroundMutations, ["mutation-after-unmount"]);
});

test("a filter GET overtaken during PATCH cannot replace the current filtered reload", async (t) => {
  const requester = queuedRequester();
  const harness = createHarness(t, requester);
  const source = "Race.pdf";
  let tree = await loadInitialOffers(harness, requester, offersResult("revision-initial", [offer(source)]));
  offerTypeControls(tree)[0].props.onChange("Folgeangebot");

  offerTypeFilter(tree).props.onChange("Folgeangebot");
  harness.render();
  assert.equal(requester.requests.length, 3);
  assert.match(requester.requests[2].path, /offer_type=Folgeangebot/);

  requester.requests[1].pending.resolve({ revision: "mutation-revision" });
  await settle();
  assert.equal(requester.requests.length, 4, "the PATCH completion reloads with the latest filter");
  assert.equal(requester.requests[2].options.signal.aborted, true, "the older filter GET is superseded");
  assert.match(requester.requests[3].path, /offer_type=Folgeangebot/);

  requester.requests[2].pending.resolve(offersResult("revision-stale", [offer("Stale.pdf", "Folgeangebot")]));
  requester.requests[3].pending.resolve(offersResult("revision-current", [offer(source, "Folgeangebot")]));
  await settle();
  tree = harness.render();
  assert.equal(offerTypeControls(tree)[0].props.source, source);
  assert.deepEqual(harness.operations, [true, false]);

  offerTypeControls(tree)[0].props.onChange("Erstangebot");
  assert.deepEqual(JSON.parse(requester.requests[4].options.body), {
    expected_revision: "revision-current",
    offer_type: "Erstangebot",
  });
  requester.requests[4].pending.resolve({ revision: "second-mutation" });
  await settle();
  requester.requests[5].pending.resolve(offersResult("revision-final", []));
  await settle();
  assert.deepEqual(harness.operations, [true, false, true, false]);
});

test("removing the last filtered row on the last page clamps to page one and adopts its revision", async (t) => {
  const requester = queuedRequester();
  const harness = createHarness(t, requester);
  let tree = await loadInitialOffers(harness, requester, offersResult("revision-all", [offer("Overview.pdf")]));

  offerTypeFilter(tree).props.onChange("Erstangebot");
  harness.render();
  requester.requests[1].pending.resolve(offersResult("revision-filter-page-one", [offer("First.pdf")]));
  await settle();
  tree = harness.render();
  offerPagination(tree).props.onChange(20);
  harness.render();
  assert.match(requester.requests[2].path, /offer_type=Erstangebot/);
  assert.match(requester.requests[2].path, /offset=20/);

  requester.requests[2].pending.resolve({
    ...offersResult("revision-last-page", [offer("Last.pdf")]),
    total: 21,
    price_level_counts: { all: 21, below: 0, above: 21, none: 0 },
  });
  await settle();
  tree = harness.render();
  offerTypeControls(tree)[0].props.onChange("Folgeangebot");
  assert.equal(JSON.parse(requester.requests[3].options.body).expected_revision, "revision-last-page");

  requester.requests[3].pending.resolve({ revision: "mutation-removes-last" });
  await settle();
  assert.match(requester.requests[4].path, /offset=20/);
  requester.requests[4].pending.resolve({
    ...offersResult("revision-clamp-response", []),
    total: 20,
    price_level_counts: { all: 20, below: 0, above: 20, none: 0 },
  });
  await settle();

  harness.render();
  assert.equal(requester.requests.length, 6, "changing the clamped offset starts a page-one reload");
  assert.match(requester.requests[5].path, /offset=0/);
  requester.requests[5].pending.resolve({
    ...offersResult("revision-page-one-current", [offer("First.pdf")]),
    total: 20,
    price_level_counts: { all: 20, below: 0, above: 20, none: 0 },
  });
  await settle();
  tree = harness.render();
  assert.equal(offerPagination(tree).props.offset, 0);
  assert.equal(offerTypeControls(tree)[0].props.source, "First.pdf");

  offerTypeControls(tree)[0].props.onChange("Folgeangebot");
  assert.deepEqual(JSON.parse(requester.requests[6].options.body), {
    expected_revision: "revision-page-one-current",
    offer_type: "Folgeangebot",
  });
  requester.requests[6].pending.resolve({ revision: "final-mutation" });
  await settle();
  requester.requests[7].pending.resolve(offersResult("revision-done", []));
  await settle();
  assert.deepEqual(harness.operations, [true, false, true, false]);
});

test("the native select and row opener are siblings, never nested interactive controls", async (t) => {
  const requester = queuedRequester();
  const harness = createHarness(t, requester);
  const tree = await loadInitialOffers(harness, requester, offersResult("revision-a", [offer("Structure.pdf")]));
  let controlAncestors;
  visit(tree, (node, ancestors) => {
    if (node.type === OfferTypeSelect) controlAncestors = ancestors;
  });
  assert.ok(controlAncestors);
  assert.equal(controlAncestors.some((node) => node.type === "button"), false);
  findNode(tree, (node) => node.type === "button" && node.props?.className === "offer-list-open");

  const renderedControl = OfferTypeSelect({
    source: "Structure.pdf",
    type: "Erstangebot",
    label: "Angebotsart testen",
    disabled: false,
    saving: false,
    onChange() {},
  });
  findNode(renderedControl, (node) => node.type === "select" && node.props?.["aria-label"] === "Angebotsart testen");
});
