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
    export const useRef = value => globalThis.__priceHeaderHooks.useRef(value);
    export const useState = value => globalThis.__priceHeaderHooks.useState(value);
    export const useId = () => globalThis.__priceHeaderHooks.useId();
    export const useCallback = value => value;
    export const useEffect = () => {};
    export const useLayoutEffect = () => {};
    export const useMemo = factory => factory();
  `],
  ["react/jsx-runtime", `
    const element = (type, props, key) => ({ type, key: key ?? null, props: props ?? {} });
    export const jsx = element;
    export const jsxs = element;
    export const Fragment = Symbol.for("price-header-test-fragment");
  `],
  ["react-dom", "export const createPortal = value => value;"],
  ["react-router-dom", "export const useSearchParams = () => [new URLSearchParams(), () => {}];"],
  ["../auth/AuthContext", "export const useAuth = () => ({ user: { role: 'admin' } });"],
  ["../components/MapFilterSelect", "export const MapFilterSelect = () => null;"],
  ["lucide-react", `
    const icon = props => ({ type: "icon", props });
    export const Calculator = icon;
    export const ChartNoAxesCombined = icon;
    export const Check = icon;
    export const ChevronLeft = icon;
    export const ChevronRight = icon;
    export const Download = icon;
    export const FileArchive = icon;
    export const FileSpreadsheet = icon;
    export const FileText = icon;
    export const FolderSync = icon;
    export const LoaderCircle = icon;
    export const Plus = icon;
    export const RefreshCw = icon;
    export const RotateCcw = icon;
    export const Save = icon;
    export const Search = icon;
    export const Trash2 = icon;
    export const Upload = icon;
    export const X = icon;
  `],
  ["price-client", `
    export const PRICE_COMPARISON_DATA_CHANGED_EVENT = "price-comparison:data-changed";
    export class PriceComparisonError extends Error {
      constructor(status, message, detail) {
        super(message);
        this.name = "PriceComparisonError";
        this.status = status;
        this.detail = detail;
      }
    }
    export const priceRequest = (...args) => globalThis.__priceHeaderDependencies.priceRequest(...args);
    export const priceDownload = (...args) => globalThis.__priceHeaderDependencies.priceDownload?.(...args);
    export const queryPath = path => path;
    export const triggerDownload = () => {};
  `],
]);

const bundled = await build({
  stdin: {
    contents: `${pageSource}\nexport { HeaderOfferUpload, PriceComparisonError as HeaderPriceComparisonError };`,
    resolveDir: dirname(pagePath),
    sourcefile: "PriceComparisonPage.header-upload.test.tsx",
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  loader: { ".css": "empty" },
  plugins: [{
    name: "price-header-upload-stubs",
    setup(builder) {
      for (const name of ["react", "react/jsx-runtime", "react-dom", "react-router-dom", "lucide-react"]) {
        builder.onResolve({ filter: new RegExp(`^${name.replaceAll("/", "\\/")}$`) }, () => ({
          path: name,
          namespace: "price-header-test",
        }));
      }
      for (const name of ["../auth/AuthContext", "../components/MapFilterSelect"]) {
        builder.onResolve({ filter: new RegExp(`^${name.replaceAll(".", "\\.").replaceAll("/", "\\/")}$`) }, () => ({
          path: name,
          namespace: "price-header-test",
        }));
      }
      builder.onResolve({ filter: /^(\.\/client|\.\.\/priceComparison\/client)$/ }, () => ({
        path: "price-client",
        namespace: "price-header-test",
      }));
      builder.onLoad({ filter: /.*/, namespace: "price-header-test" }, ({ path }) => ({
        contents: stubModules.get(path),
        loader: "js",
      }));
    },
  }],
});

const componentModule = { exports: {} };
new Function("module", "exports", bundled.outputFiles[0].text)(componentModule, componentModule.exports);
const { HeaderOfferUpload, HeaderPriceComparisonError } = componentModule.exports;

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function eventually(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.fail(message);
}

function visit(node, callback) {
  if (Array.isArray(node)) {
    node.forEach((child) => visit(child, callback));
    return;
  }
  if (!node || typeof node !== "object") return;
  callback(node);
  visit(node.props?.children, callback);
}

function maybeNode(tree, predicate) {
  let match;
  visit(tree, (node) => {
    if (match === undefined && predicate(node)) match = node;
  });
  return match;
}

function findNode(tree, predicate) {
  const match = maybeNode(tree, predicate);
  assert.ok(match, "expected component node was not rendered");
  return match;
}

function renderedText(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join("");
  return renderedText(node.props?.children);
}

function mount(t, { priceRequest, ...propertyOverrides }) {
  const slots = [];
  let cursor = 0;
  let nextId = 0;
  const busyChanges = [];
  const uploaded = [];
  globalThis.__priceHeaderDependencies = { priceRequest };
  globalThis.__priceHeaderHooks = {
    useRef(initialValue) {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) slots[index] = { current: initialValue };
      return slots[index];
    },
    useState(initialValue) {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) slots[index] = { value: typeof initialValue === "function" ? initialValue() : initialValue };
      return [slots[index].value, (nextValue) => {
        slots[index].value = typeof nextValue === "function" ? nextValue(slots[index].value) : nextValue;
      }];
    },
    useId() {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) {
        nextId += 1;
        slots[index] = `price-header-id-${nextId}`;
      }
      return slots[index];
    },
  };
  const properties = {
    disabled: false,
    blockReason: null,
    onBusyChange: (value) => busyChanges.push(value),
    onUploaded: (revision) => uploaded.push(revision),
    ...propertyOverrides,
  };
  t.after(() => {
    delete globalThis.__priceHeaderDependencies;
    delete globalThis.__priceHeaderHooks;
  });
  return {
    busyChanges,
    uploaded,
    render() {
      cursor = 0;
      return HeaderOfferUpload(properties);
    },
  };
}

function headerControls(tree) {
  return {
    input: findNode(tree, (node) => node.type === "input" && node.props?.["aria-label"] === "Angebots-PDFs auswählen"),
    dropzone: findNode(tree, (node) => node.type === "button" && String(node.props?.className).includes("price-offer-dropzone")),
  };
}

function duplicateDialog(tree) {
  return maybeNode(tree, (node) => (
    node.props?.preview?.kind === "offers"
    && typeof node.props?.onConfirm === "function"
    && typeof node.props?.onClose === "function"
  ));
}

function selectedFiles(...names) {
  return names.map((name) => new File([`content:${name}`], name, { type: "application/pdf" }));
}

test("change and drop both preflight and send every selected file as multipart", async (t) => {
  const calls = [];
  let preflights = 0;
  let uploads = 0;
  const mounted = mount(t, {
    priceRequest: async (path, options = {}) => {
      calls.push([path, options]);
      if (options.method === "POST") {
        uploads += 1;
        return { revision: `after-${uploads}` };
      }
      preflights += 1;
      return { revision: preflights === 1 ? "fresh-change" : "fresh-drop" };
    },
  });
  const { input } = headerControls(mounted.render());
  const files = selectedFiles("Erstes.pdf", "Zweites.PDF");
  const currentTarget = { files, value: "chosen" };

  input.props.onChange({ currentTarget });
  assert.equal(currentTarget.value, "");
  await eventually(() => mounted.uploaded.length === 1);

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "/price-comparison/files");
  assert.equal(calls[0][1].method, undefined);
  const body = calls[1][1].body;
  assert.equal(calls[1][0], "/price-comparison/files");
  assert.equal(calls[1][1].method, "POST");
  assert.equal(body.get("kind"), "offers");
  assert.equal(body.get("expected_revision"), "fresh-change");
  assert.deepEqual(body.getAll("files").map((file) => file.name), ["Erstes.pdf", "Zweites.PDF"]);
  assert.equal(body.has("confirmed_duplicates"), false);
  const { dropzone } = headerControls(mounted.render());
  let prevented = false;
  dropzone.props.onDrop({
    preventDefault() { prevented = true; },
    dataTransfer: { files: selectedFiles("Drop.pdf") },
  });
  await eventually(() => mounted.uploaded.length === 2);

  assert.equal(prevented, true);
  assert.equal(calls.length, 4);
  assert.equal(calls[3][1].body.get("expected_revision"), "fresh-drop");
  assert.deepEqual(calls[3][1].body.getAll("files").map((file) => file.name), ["Drop.pdf"]);
  assert.deepEqual(mounted.busyChanges, [true, false, true, false]);
  assert.deepEqual(mounted.uploaded, ["after-1", "after-2"]);
});

test("the synchronous busy ref prevents a second change or drop from starting", async (t) => {
  const preflight = deferred();
  const calls = [];
  const mounted = mount(t, {
    priceRequest: async (path, options = {}) => {
      calls.push([path, options]);
      if (options.method !== "POST") return preflight.promise;
      return { revision: "after-first" };
    },
  });
  const { input, dropzone } = headerControls(mounted.render());
  input.props.onChange({ currentTarget: { files: selectedFiles("First.pdf"), value: "chosen" } });
  dropzone.props.onDrop({ preventDefault() {}, dataTransfer: { files: selectedFiles("Second.pdf") } });

  assert.equal(calls.length, 1);
  assert.deepEqual(mounted.busyChanges, [true]);
  preflight.resolve({ revision: "fresh-first" });
  await eventually(() => mounted.uploaded.length === 1);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1].body.getAll("files").map((file) => file.name), ["First.pdf"]);
  assert.deepEqual(mounted.busyChanges, [true, false]);
});

function duplicateError(revision = "duplicate-revision") {
  return new HeaderPriceComparisonError(409, "Bestätigung erforderlich", {
    code: "duplicate_offers",
    message: "Vorhandenes Angebot ersetzen?",
    revision,
    duplicates: [{ offer_number: "A-7", keep: "Neu.pdf", remove: "Alt.pdf" }],
  });
}

test("cancelling the duplicate preview performs no replacement request", async (t) => {
  const calls = [];
  const mounted = mount(t, {
    priceRequest: async (path, options = {}) => {
      calls.push([path, options]);
      if (options.method === "POST") throw duplicateError();
      return { revision: "preflight-revision" };
    },
  });
  const { input } = headerControls(mounted.render());
  input.props.onChange({ currentTarget: { files: selectedFiles("Neu.pdf"), value: "chosen" } });
  await eventually(() => Boolean(duplicateDialog(mounted.render())));

  const dialog = duplicateDialog(mounted.render());
  assert.ok(dialog);
  assert.equal(calls.length, 2);
  dialog.props.onClose();
  assert.equal(duplicateDialog(mounted.render()), undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(mounted.uploaded, []);
});

test("confirming duplicates uses the server preview revision and exact removal list", async (t) => {
  const calls = [];
  const mounted = mount(t, {
    priceRequest: async (path, options = {}) => {
      calls.push([path, options]);
      if (options.method !== "POST") return { revision: "stale-preflight" };
      if (!options.body.has("confirmed_duplicates")) throw duplicateError("server-preview-revision");
      return { revision: "after-confirmation" };
    },
  });
  const { input } = headerControls(mounted.render());
  input.props.onChange({ currentTarget: { files: selectedFiles("Neu.pdf"), value: "chosen" } });
  await eventually(() => Boolean(duplicateDialog(mounted.render())));

  duplicateDialog(mounted.render()).props.onConfirm();
  await eventually(() => mounted.uploaded.length === 1);

  assert.equal(calls.length, 3, "confirmation must not perform another revision preflight");
  const confirmationBody = calls[2][1].body;
  assert.equal(confirmationBody.get("expected_revision"), "server-preview-revision");
  assert.equal(confirmationBody.get("confirmed_duplicates"), JSON.stringify(["Alt.pdf"]));
  assert.deepEqual(confirmationBody.getAll("files").map((file) => file.name), ["Neu.pdf"]);
  assert.deepEqual(mounted.uploaded, ["after-confirmation"]);
  assert.equal(duplicateDialog(mounted.render()), undefined);
});

test("validation and request failures show errors and always release busy state", async (t) => {
  let requests = 0;
  const mounted = mount(t, {
    priceRequest: async (_path, options = {}) => {
      requests += 1;
      if (options.method === "POST") throw new Error("Upload nicht erreichbar");
      return { revision: "fresh-error" };
    },
  });
  let { input } = headerControls(mounted.render());
  input.props.onChange({ currentTarget: { files: [new File(["text"], "Falsch.txt")], value: "chosen" } });
  let feedback = findNode(mounted.render(), (node) => node.type === "p" && node.props?.className === "is-error");
  assert.match(renderedText(feedback), /ausschließlich PDF-Dateien/);
  assert.equal(requests, 0);

  ({ input } = headerControls(mounted.render()));
  input.props.onChange({ currentTarget: { files: selectedFiles("Fehler.pdf"), value: "chosen" } });
  await eventually(() => mounted.busyChanges.at(-1) === false);
  feedback = findNode(mounted.render(), (node) => node.type === "p" && node.props?.className === "is-error");
  assert.match(renderedText(feedback), /Upload nicht erreichbar/);
  assert.equal(requests, 2);
  assert.deepEqual(mounted.busyChanges, [true, false]);
  assert.deepEqual(mounted.uploaded, []);
});
