import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundled = await build({
  stdin: {
    contents: `export { offerUploadPollDelay, useOfferUploadJobs } from "./src/priceComparison/offerUploadJobs";`,
    resolveDir: frontendRoot,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  plugins: [{
    name: "offer-upload-job-runtime-stubs",
    setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "offer-upload-test" }));
      builder.onResolve({ filter: /^\.\/uploads$/ }, () => ({ path: "uploads", namespace: "offer-upload-test" }));
      builder.onResolve({ filter: /^\.\/client$/ }, () => ({ path: "client", namespace: "offer-upload-test" }));
      builder.onLoad({ filter: /^react$/, namespace: "offer-upload-test" }, () => ({
        contents: `
          export const useCallback = (...args) => globalThis.__offerUploadHooks.useCallback(...args);
          export const useEffect = (...args) => globalThis.__offerUploadHooks.useEffect(...args);
          export const useMemo = (...args) => globalThis.__offerUploadHooks.useMemo(...args);
          export const useRef = (...args) => globalThis.__offerUploadHooks.useRef(...args);
          export const useState = (...args) => globalThis.__offerUploadHooks.useState(...args);
        `,
        loader: "js",
      }));
      builder.onLoad({ filter: /^uploads$/, namespace: "offer-upload-test" }, () => ({
        contents: `
          export const listOfferUploadJobs = (...args) => globalThis.__offerUploadDependencies.list(...args);
          export const createOfferUploadJob = (...args) => globalThis.__offerUploadDependencies.create(...args);
          export const confirmOfferUploadJob = (...args) => globalThis.__offerUploadDependencies.confirm(...args);
          export const cancelOfferUploadJob = (...args) => globalThis.__offerUploadDependencies.cancel(...args);
        `,
        loader: "js",
      }));
      builder.onLoad({ filter: /^client$/, namespace: "offer-upload-test" }, () => ({
        contents: `
          export class PriceComparisonError extends Error {
            constructor(status, message, detail) { super(message); this.status = status; this.detail = detail; }
          }
        `,
        loader: "js",
      }));
    },
  }],
});
const runtimeModule = { exports: {} };
new Function("require", "module", "exports", bundled.outputFiles[0].text)(createRequire(import.meta.url), runtimeModule, runtimeModule.exports);
const { offerUploadPollDelay, useOfferUploadJobs } = runtimeModule.exports;

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function job(id, status, overrides = {}) {
  return {
    id,
    client_request_id: `request-${id}`,
    status,
    file_names: [`${id}.pdf`],
    created_at: "2026-11-26T08:00:00Z",
    updated_at: "2026-11-26T08:01:00Z",
    ...overrides,
  };
}

function queuedDependencies() {
  const calls = { list: [], create: [], confirm: [], cancel: [] };
  const add = (name, args) => {
    const pending = deferred();
    calls[name].push({ args, pending });
    return pending.promise;
  };
  return {
    calls,
    list: (...args) => add("list", args),
    create: (...args) => add("create", args),
    confirm: (...args) => add("confirm", args),
    cancel: (...args) => add("cancel", args),
  };
}

function createHookHarness(t, dependencies, initialVisibility = "visible") {
  const originals = new Map([
    ["window", Object.getOwnPropertyDescriptor(globalThis, "window")],
    ["document", Object.getOwnPropertyDescriptor(globalThis, "document")],
    ["__offerUploadHooks", Object.getOwnPropertyDescriptor(globalThis, "__offerUploadHooks")],
    ["__offerUploadDependencies", Object.getOwnPropertyDescriptor(globalThis, "__offerUploadDependencies")],
  ]);
  const documentTarget = new EventTarget();
  const windowTarget = new EventTarget();
  const timers = new Map();
  let visibility = initialVisibility;
  let timerId = 0;
  Object.defineProperty(documentTarget, "visibilityState", { get: () => visibility });
  windowTarget.setTimeout = (callback, delay) => {
    timerId += 1;
    timers.set(timerId, { callback, delay });
    return timerId;
  };
  windowTarget.clearTimeout = (id) => timers.delete(id);
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentTarget });
  globalThis.__offerUploadDependencies = dependencies;

  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  const dependenciesChanged = (previous, next) => !previous || previous.length !== next.length
    || next.some((value, index) => !Object.is(value, previous[index]));
  globalThis.__offerUploadHooks = {
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
    useCallback(callback, dependenciesList) {
      return this.useMemo(() => callback, dependenciesList);
    },
    useMemo(factory, dependenciesList) {
      const index = cursor++;
      if (!slots[index] || dependenciesChanged(slots[index].dependencies, dependenciesList)) {
        slots[index] = { kind: "memo", dependencies: dependenciesList, value: factory() };
      }
      return slots[index].value;
    },
    useEffect(effect, dependenciesList) {
      const index = cursor++;
      const slot = slots[index];
      if (slot && !dependenciesChanged(slot.dependencies, dependenciesList)) return;
      const next = { kind: "effect", dependencies: dependenciesList, cleanup: slot?.cleanup };
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
  const render = (sessionKey, onCompleted, flush = true) => {
    cursor = 0;
    const result = useOfferUploadJobs(sessionKey, onCompleted);
    if (flush) flushEffects();
    return result;
  };
  let mounted = true;
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

  return {
    render,
    flushEffects,
    unmount,
    timers,
    setVisibility(next) {
      visibility = next;
      documentTarget.dispatchEvent(new Event("visibilitychange"));
    },
    tickNextTimer() {
      const entry = timers.entries().next().value;
      assert.ok(entry, "expected a scheduled poll");
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
    },
  };
}

async function settle() {
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

test("polling is fast for active work and idle otherwise", () => {
  assert.equal(offerUploadPollDelay([job("queued", "queued")]), 1_000);
  assert.equal(offerUploadPollDelay([job("confirm", "awaiting_confirmation")]), 10_000);
  assert.equal(offerUploadPollDelay([], [{ status: "uncertain" }]), 1_000);
  assert.equal(offerUploadPollDelay([], []), 10_000);
});

test("polling pauses while hidden and checks immediately when visible", async (t) => {
  const dependencies = queuedDependencies();
  const hook = createHookHarness(t, dependencies, "hidden");
  const completed = [];
  const onCompleted = (value) => completed.push(value);

  hook.render("session", onCompleted);
  assert.equal(dependencies.calls.list.length, 0);
  assert.equal(hook.timers.size, 0);

  hook.setVisibility("visible");
  assert.equal(dependencies.calls.list.length, 1);
  dependencies.calls.list[0].pending.resolve({ jobs: [job("running", "processing")] });
  await settle();
  assert.equal(hook.render("session", onCompleted).jobs[0].status, "processing");
  assert.equal([...hook.timers.values()][0].delay, 1_000);

  hook.tickNextTimer();
  assert.equal(dependencies.calls.list.length, 2);
  hook.setVisibility("hidden");
  assert.equal(dependencies.calls.list[1].args[0].aborted, true);
  assert.equal(hook.timers.size, 0);
});

test("a newly queued job completed before the first successful poll still publishes its revision", async (t) => {
  const dependencies = queuedDependencies();
  const hook = createHookHarness(t, dependencies);
  const completed = [];
  const onCompleted = (value) => completed.push(value);
  let current = hook.render(7, onCompleted);
  current.enqueue([new File(["pdf"], "Schnell.pdf", { type: "application/pdf" })]);
  const clientRequestId = dependencies.calls.create[0].args[1];
  dependencies.calls.create[0].pending.resolve({ job: job("fast", "queued", { client_request_id: clientRequestId }) });
  await settle();
  assert.equal(dependencies.calls.list[0].args[0].aborted, true);
  assert.equal(dependencies.calls.list.length, 2);

  dependencies.calls.list[1].pending.resolve({ jobs: [job("fast", "completed", {
    client_request_id: clientRequestId,
    result_revision: "revision-fast",
  })] });
  await settle();

  current = hook.render(7, onCompleted);
  assert.equal(current.jobs[0].status, "completed");
  assert.deepEqual(completed.map((value) => value.result_revision), ["revision-fast"]);
});

test("unmount invalidates an in-flight enqueue completion", async (t) => {
  const dependencies = queuedDependencies();
  const hook = createHookHarness(t, dependencies);
  const completed = [];
  const onCompleted = (value) => completed.push(value);
  let current = hook.render("auth-a", onCompleted);
  current.enqueue([new File(["pdf"], "Spaet.pdf", { type: "application/pdf" })]);
  hook.unmount();
  dependencies.calls.create[0].pending.resolve({ job: job("late-submit", "completed", { result_revision: "late-submit" }) });
  await settle();
  assert.deepEqual(completed, []);
});

test("unmount invalidates an in-flight confirmation completion", async (t) => {
  const dependencies = queuedDependencies();
  const hook = createHookHarness(t, dependencies);
  const completed = [];
  const onCompleted = (value) => completed.push(value);
  const waiting = job("waiting", "awaiting_confirmation", {
    confirmation_revision: "revision-confirm",
    duplicates: [{ offer_number: "1", keep: "Neu.pdf", remove: "Alt.pdf" }],
  });
  let current = hook.render("auth-b", onCompleted);
  dependencies.calls.list[0].pending.resolve({ jobs: [waiting] });
  await settle();
  current = hook.render("auth-b", onCompleted);
  current.confirm(waiting);
  hook.unmount();
  dependencies.calls.confirm[0].pending.resolve({ job: job("waiting", "completed", { result_revision: "late-confirm" }) });
  await settle();
  assert.deepEqual(completed, []);
});

test("session change hides old jobs immediately and rejects the old response", async (t) => {
  const dependencies = queuedDependencies();
  const hook = createHookHarness(t, dependencies);
  const onCompleted = () => {};
  hook.render("person-a", onCompleted);
  dependencies.calls.list[0].pending.resolve({ jobs: [job("old", "processing")] });
  await settle();
  assert.equal(hook.render("person-a", onCompleted).jobs[0].id, "old");

  hook.tickNextTimer();
  const oldPoll = dependencies.calls.list[1];
  const firstNewRender = hook.render("person-b", onCompleted, false);
  assert.deepEqual(firstNewRender.jobs, []);
  assert.equal(firstNewRender.loading, true);
  hook.flushEffects();
  assert.equal(oldPoll.args[0].aborted, true);
  assert.equal(dependencies.calls.list.length, 3);

  oldPoll.pending.resolve({ jobs: [job("leak", "completed", { result_revision: "wrong" })] });
  await settle();
  assert.deepEqual(hook.render("person-b", onCompleted).jobs, []);
});

test("a poll error keeps known jobs stale and refresh recovers", async (t) => {
  const dependencies = queuedDependencies();
  const hook = createHookHarness(t, dependencies);
  const onCompleted = () => {};
  hook.render(1, onCompleted);
  dependencies.calls.list[0].pending.resolve({ jobs: [job("known", "processing")] });
  await settle();
  hook.render(1, onCompleted);

  hook.tickNextTimer();
  dependencies.calls.list[1].pending.reject(new Error("Netz nicht erreichbar"));
  await settle();
  const stale = hook.render(1, onCompleted);
  assert.equal(stale.jobs[0].id, "known");
  assert.equal(stale.stale, true);
  assert.equal(stale.error, "Netz nicht erreichbar");

  stale.refresh();
  assert.equal(dependencies.calls.list.length, 3);
  dependencies.calls.list[2].pending.resolve({ jobs: [job("known", "completed", { result_revision: "revision-recovered" })] });
  await settle();
  const recovered = hook.render(1, onCompleted);
  assert.equal(recovered.stale, false);
  assert.equal(recovered.error, null);
});

test("the UUID fallback remains RFC 4122 when randomUUID is unavailable", (t) => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: (bytes) => { bytes.fill(0x2a); return bytes; } },
  });
  t.after(() => originalCrypto
    ? Object.defineProperty(globalThis, "crypto", originalCrypto)
    : delete globalThis.crypto);
  const dependencies = queuedDependencies();
  const hook = createHookHarness(t, dependencies);
  const current = hook.render("session", () => {});

  current.enqueue([new File(["pdf"], "UUID.pdf", { type: "application/pdf" })]);

  const clientRequestId = dependencies.calls.create[0].args[1];
  assert.match(clientRequestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(clientRequestId, "2a2a2a2a-2a2a-4a2a-aa2a-2a2a2a2a2a2a");
});
