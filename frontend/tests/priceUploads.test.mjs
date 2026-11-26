import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/priceComparison/uploads.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadModule(priceRequest = async () => ({ revision: "revision-next" })) {
  const exports = {};
  const require = (specifier) => {
    assert.equal(specifier, "./client");
    return { priceRequest };
  };
  new Function("require", "exports", compiled)(require, exports);
  return exports;
}

function candidate(name, size = 1, type = "") {
  return { name, size, type };
}

const MIB = 1024 * 1024;

test("offer validation accepts a complete case-insensitive PDF selection", () => {
  const { validateOfferFiles } = loadModule();
  assert.equal(validateOfferFiles([
    candidate("Erstes Angebot.pdf", 12, "application/octet-stream"),
    candidate("ZWEITES.PDF", 34, ""),
  ]), null);
});

test("offer validation rejects empty, non-PDF and empty-file selections as a whole", () => {
  const { validateOfferFiles } = loadModule();
  assert.match(validateOfferFiles([]), /mindestens eine PDF-Datei/);
  assert.match(validateOfferFiles([
    candidate("Gültig.pdf"),
    candidate("Kein PDF.txt"),
  ]), /ausschließlich PDF-Dateien/);
  assert.match(validateOfferFiles([
    candidate("Gültig.pdf"),
    candidate("Leer.pdf", 0),
  ]), /Leer\.pdf.*leer/);
});

test("offer validation mirrors the per-file, batch and count limits", () => {
  const { validateOfferFiles } = loadModule();
  assert.equal(validateOfferFiles([candidate("Grenze.pdf", 40 * MIB)]), null);
  assert.match(validateOfferFiles([candidate("Zu groß.pdf", 40 * MIB + 1)]), /40 MB/);

  assert.equal(validateOfferFiles([
    candidate("A.pdf", 40 * MIB),
    candidate("B.pdf", 40 * MIB),
    candidate("C.pdf", 40 * MIB),
    candidate("D.pdf", 40 * MIB),
  ]), null);
  assert.match(validateOfferFiles([
    candidate("A.pdf", 40 * MIB),
    candidate("B.pdf", 40 * MIB),
    candidate("C.pdf", 40 * MIB),
    candidate("D.pdf", 40 * MIB),
    candidate("E.pdf", 1),
  ]), /160 MB/);

  assert.equal(validateOfferFiles(
    Array.from({ length: 200 }, (_, index) => candidate(`Angebot-${index}.pdf`)),
  ), null);
  assert.match(validateOfferFiles(
    Array.from({ length: 201 }, (_, index) => candidate(`Angebot-${index}.pdf`)),
  ), /höchstens 200/);
});

test("offer validation rejects duplicate and backend-incompatible names", () => {
  const { validateOfferFiles } = loadModule();
  assert.match(validateOfferFiles([
    candidate("Angebot.PDF"),
    candidate("angebot.pdf"),
  ]), /Dateinamen nur einmal/);
  assert.match(validateOfferFiles([candidate(" Angebot.pdf")]), /Dateiname.*ungültig/);
  assert.match(validateOfferFiles([candidate(".pdf")]), /Dateiname.*ungültig/);
  assert.match(validateOfferFiles([candidate(`${"a".repeat(217)}.pdf`)]), /Dateiname.*ungültig/);
});

test("upload forwards every file and the unchanged initial multipart fields", async () => {
  const requests = [];
  const expected = { revision: "revision-next" };
  const { uploadPriceFiles } = loadModule(async (...args) => {
    requests.push(args);
    return expected;
  });
  const files = [
    new File(["first"], "Erstes.pdf", { type: "application/pdf" }),
    new File(["second"], "Zweites.PDF", { type: "application/pdf" }),
  ];

  assert.equal(await uploadPriceFiles("offers", files, "revision-before"), expected);
  assert.equal(requests.length, 1);
  const [path, options] = requests[0];
  assert.equal(path, "/price-comparison/files");
  assert.equal(options.method, "POST");
  assert.equal(options.body.get("kind"), "offers");
  assert.equal(options.body.get("expected_revision"), "revision-before");
  assert.deepEqual(options.body.getAll("files").map((file) => file.name), [
    "Erstes.pdf",
    "Zweites.PDF",
  ]);
  assert.equal(options.body.has("confirmed_duplicates"), false);
  assert.equal(options.headers, undefined);
});

test("confirmed duplicate names use the existing JSON multipart field", async () => {
  const requests = [];
  const { uploadPriceFiles } = loadModule(async (...args) => {
    requests.push(args);
    return { revision: "revision-confirmed" };
  });
  const files = [new File(["data"], "Ersatz.pdf", { type: "application/pdf" })];
  const duplicates = ["Alt.pdf", "Virtuell.pdf"];

  const result = await uploadPriceFiles("offers", files, "revision-preview", duplicates);
  const body = requests[0][1].body;
  assert.deepEqual(result, { revision: "revision-confirmed" });
  assert.equal(body.get("kind"), "offers");
  assert.equal(body.get("expected_revision"), "revision-preview");
  assert.equal(body.get("confirmed_duplicates"), JSON.stringify(duplicates));
  assert.equal(body.getAll("files").length, files.length);
});

test("offer jobs enqueue one persistent multipart job with the supplied idempotency UUID", async () => {
  const requests = [];
  const { createOfferUploadJob } = loadModule(async (...args) => {
    requests.push(args);
    return { job: { id: "job-1" } };
  });
  const files = [
    new File(["first"], "Erstes.pdf", { type: "application/pdf" }),
    new File(["second"], "Zweites.pdf", { type: "application/pdf" }),
  ];

  await createOfferUploadJob(files, "ddc3cb4e-3719-4935-b268-a07f6138b27e");

  const [path, options] = requests[0];
  assert.equal(path, "/price-comparison/upload-jobs");
  assert.equal(options.method, "POST");
  assert.equal(options.body.get("kind"), "offers");
  assert.equal(options.body.get("client_request_id"), "ddc3cb4e-3719-4935-b268-a07f6138b27e");
  assert.deepEqual(options.body.getAll("files").map((file) => file.name), ["Erstes.pdf", "Zweites.pdf"]);
});

test("job polling, duplicate confirmation and cancellation use the queue endpoints without resending PDFs", async () => {
  const requests = [];
  const module = loadModule(async (...args) => {
    requests.push(args);
    return args[0].endsWith("upload-jobs") ? { jobs: [] } : { job: { id: "job / 7" } };
  });
  const controller = new AbortController();

  await module.listOfferUploadJobs(controller.signal);
  await module.confirmOfferUploadJob("job / 7", "revision-preview", ["Alt.pdf"]);
  await module.cancelOfferUploadJob("job / 7");

  assert.deepEqual(requests.map(([path, options]) => [path, options.method]), [
    ["/price-comparison/upload-jobs", undefined],
    ["/price-comparison/upload-jobs/job%20%2F%207/confirm", "POST"],
    ["/price-comparison/upload-jobs/job%20%2F%207", "DELETE"],
  ]);
  assert.strictEqual(requests[0][1].signal, controller.signal);
  assert.deepEqual(JSON.parse(requests[1][1].body), {
    expected_revision: "revision-preview",
    confirmed_duplicates: ["Alt.pdf"],
  });
  assert.equal(requests[1][1].body instanceof FormData, false);
});
