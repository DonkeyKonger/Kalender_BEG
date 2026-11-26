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
    export const CircleMinus = icon;
    export const Download = icon;
    export const Ellipsis = icon;
    export const FileArchive = icon;
    export const FileSpreadsheet = icon;
    export const FileText = icon;
    export const FolderSync = icon;
    export const Info = icon;
    export const LoaderCircle = icon;
    export const Plus = icon;
    export const RefreshCw = icon;
    export const RotateCcw = icon;
    export const Save = icon;
    export const Search = icon;
    export const Trash2 = icon;
    export const TrendingDown = icon;
    export const TrendingUp = icon;
    export const Upload = icon;
    export const X = icon;
  `],
  ["price-client", `
    export const PRICE_COMPARISON_DATA_CHANGED_EVENT = "price-comparison:data-changed";
    export const announcePriceComparisonDataChanged = () => {};
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
    contents: `${pageSource}\nexport { HeaderOfferUpload, nextUploadConfirmationJobId };`,
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
const { HeaderOfferUpload, nextUploadConfirmationJobId } = componentModule.exports;

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

function mount(t, propertyOverrides = {}) {
  const slots = [];
  let cursor = 0;
  let nextId = 0;
  const enqueued = [];
  const confirmed = [];
  const cancelled = [];
  globalThis.__priceHeaderDependencies = { priceRequest: async () => ({}) };
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
  const defaultQueue = {
    jobs: [],
    submissions: [],
    loading: false,
    stale: false,
    error: null,
    enqueue: (files) => enqueued.push(Array.from(files)),
    retrySubmission() {},
    dismissSubmission() {},
    confirm: (job) => confirmed.push(job),
    cancel: (job) => cancelled.push(job),
    refresh() {},
    isActing: () => false,
  };
  const properties = {
    disabled: false,
    blockReason: null,
    ...propertyOverrides,
    queue: { ...defaultQueue, ...propertyOverrides.queue },
  };
  t.after(() => {
    delete globalThis.__priceHeaderDependencies;
    delete globalThis.__priceHeaderHooks;
  });
  return {
    enqueued,
    confirmed,
    cancelled,
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

test("change and drop enqueue every selected PDF while earlier jobs keep processing", (t) => {
  const processingJob = {
    id: "job-1",
    client_request_id: "request-1",
    status: "processing",
    file_names: ["Bereits.pdf"],
    created_at: "2026-11-26T08:00:00Z",
    updated_at: "2026-11-26T08:01:00Z",
  };
  const mounted = mount(t, {
    queue: { jobs: [processingJob] },
  });
  const { input } = headerControls(mounted.render());
  const files = selectedFiles("Erstes.pdf", "Zweites.PDF");
  const currentTarget = { files, value: "chosen" };

  input.props.onChange({ currentTarget });
  assert.equal(currentTarget.value, "");
  assert.deepEqual(mounted.enqueued[0].map((file) => file.name), ["Erstes.pdf", "Zweites.PDF"]);
  const { dropzone } = headerControls(mounted.render());
  assert.match(renderedText(dropzone), /Weitere Angebote hochladen/);
  let prevented = false;
  dropzone.props.onDrop({
    preventDefault() { prevented = true; },
    dataTransfer: { files: selectedFiles("Drop.pdf") },
  });

  assert.equal(prevented, true);
  assert.deepEqual(mounted.enqueued[1].map((file) => file.name), ["Drop.pdf"]);
});

test("validation rejects a mixed selection before it enters the persistent queue", (t) => {
  const mounted = mount(t);
  let { input } = headerControls(mounted.render());
  input.props.onChange({ currentTarget: { files: [selectedFiles("Gut.pdf")[0], new File(["text"], "Falsch.txt")], value: "chosen" } });
  const feedback = findNode(mounted.render(), (node) => node.type === "p" && node.props?.className === "is-error");
  assert.match(renderedText(feedback), /ausschließlich PDF-Dateien/);
  assert.deepEqual(mounted.enqueued, []);
});

test("awaiting duplicate jobs open the existing dialog and confirm by job identity", (t) => {
  const awaiting = {
    id: "job-confirm",
    client_request_id: "request-confirm",
    status: "awaiting_confirmation",
    file_names: ["Neu.pdf"],
    created_at: "2026-11-26T08:00:00Z",
    updated_at: "2026-11-26T08:01:00Z",
    confirmation_revision: "revision-preview",
    message: "Vorhandenes Angebot ersetzen?",
    duplicates: [{ offer_number: "A-7", keep: "Neu.pdf", remove: "Alt.pdf" }],
  };
  const mounted = mount(t, { queue: { jobs: [awaiting] } });
  const initial = mounted.render();
  const trigger = findNode(initial, (node) => node.type === "button" && String(node.props?.className).includes("offer-upload-queue-trigger"));
  trigger.props.onClick();
  const opened = mounted.render();
  findNode(opened, (node) => node.type === "button" && renderedText(node) === "Prüfen").props.onClick();
  const dialog = duplicateDialog(mounted.render());
  assert.ok(dialog);
  assert.equal(dialog.props.preview.revision, "revision-preview");
  assert.deepEqual(dialog.props.preview.duplicates, awaiting.duplicates);
  dialog.props.onConfirm();
  assert.deepEqual(mounted.confirmed, [awaiting]);
  dialog.props.onClose();
  assert.equal(duplicateDialog(mounted.render()), undefined);
  assert.deepEqual(mounted.cancelled, [], "closing a confirmation must leave the server job waiting");
});

test("a newly waiting job never replaces the confirmation currently being reviewed", () => {
  const waiting = (id) => ({ id, status: "awaiting_confirmation" });
  const prompted = new Set(["job-a"]);

  assert.equal(nextUploadConfirmationJobId("job-a", [waiting("job-a"), waiting("job-b")], prompted), "job-a");
  assert.equal(prompted.has("job-b"), false, "the later job remains available for the next prompt");
  assert.equal(nextUploadConfirmationJobId(null, [waiting("job-a"), waiting("job-b")], prompted), "job-b");
});
