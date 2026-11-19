import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: [new URL("../src/priceComparison/client.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [{
    name: "price-comparison-client-stubs",
    setup(builder) {
      builder.onResolve({ filter: /^\.\.\/lib\/api$/ }, () => ({ path: "api", namespace: "price-test" }));
      builder.onResolve({ filter: /^\.\.\/lib\/namedBlob$/ }, () => ({ path: "named-blob", namespace: "price-test" }));
      builder.onLoad({ filter: /^api$/, namespace: "price-test" }, () => ({
        contents: "export const authenticatedFetch = (...args) => globalThis.__priceComparisonFetch(...args);",
        loader: "js",
      }));
      builder.onLoad({ filter: /^named-blob$/, namespace: "price-test" }, () => ({
        contents: "export const parseContentDispositionFilename = () => null;",
        loader: "js",
      }));
    },
  }],
});

let moduleInstance = 0;
async function fixture(t, responder) {
  globalThis.__priceComparisonFetch = responder;
  t.after(() => { delete globalThis.__priceComparisonFetch; });
  const source = Buffer.from(bundled.outputFiles[0].text).toString("base64");
  return import(`data:text/javascript;base64,${source}#${moduleInstance++}`);
}

const gatewayTimeout = () => Response.json({ detail: "Gateway timeout" }, { status: 504 });

test("safe price views and suggestion previews retry one intermediary 504", async (t) => {
  const calls = new Map();
  const { priceRequest } = await fixture(t, async (path) => {
    const count = (calls.get(path) ?? 0) + 1;
    calls.set(path, count);
    return count === 1 ? gatewayTimeout() : Response.json({ path, revision: "ready" });
  });

  const [status, suggestions] = await Promise.all([
    priceRequest("/price-comparison/status"),
    priceRequest("/price-comparison/suggestions/preview", { method: "POST", body: "{}" }),
  ]);

  assert.equal(status.revision, "ready");
  assert.equal(suggestions.revision, "ready");
  assert.equal(calls.get("/price-comparison/status"), 2);
  assert.equal(calls.get("/price-comparison/suggestions/preview"), 2);
});

test("mutating price requests never retry a 504", async (t) => {
  let calls = 0;
  const { priceRequest } = await fixture(t, async () => {
    calls += 1;
    return gatewayTimeout();
  });

  await assert.rejects(
    priceRequest("/price-comparison/maintenance", { method: "POST", body: "{}" }),
    (error) => error.status === 504,
  );
  assert.equal(calls, 1);
});

test("aborting during the 504 backoff prevents the retry", async (t) => {
  let calls = 0;
  const { priceRequest } = await fixture(t, async () => {
    calls += 1;
    return gatewayTimeout();
  });
  const controller = new AbortController();
  const pending = priceRequest("/price-comparison/offers", { signal: controller.signal });
  globalThis.setTimeout(() => controller.abort(), 20);

  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("persistent gateway timeouts stop after two retries", async (t) => {
  let calls = 0;
  const { priceRequest } = await fixture(t, async () => {
    calls += 1;
    return gatewayTimeout();
  });

  await assert.rejects(
    priceRequest("/price-comparison/offers"),
    (error) => error.status === 504,
  );
  assert.equal(calls, 3);
});
