import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_PROJECT_DOCUMENT_SORT,
  getNextProjectDocumentSort,
  sortProjectDocumentItems,
} from "../src/lib/projectDocumentSort.ts";

const pageSource = await readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");

function documentItem(overrides) {
  return {
    id: overrides.id,
    name: overrides.name,
    web_url: null,
    size: overrides.size ?? null,
    last_modified_date_time: overrides.modified ?? null,
    mime_type: overrides.mimeType ?? null,
    file_extension: overrides.extension ?? null,
    is_folder: overrides.isFolder ?? false,
  };
}

const documents = [
  documentItem({ id: "old", name: "Plan 10.pdf", extension: "pdf", mimeType: "application/octet-stream", size: 900, modified: "2026-06-01T10:00:00Z" }),
  documentItem({ id: "new", name: "Plan 2.xlsx", extension: "xlsx", mimeType: "application/pdf", size: 1200, modified: "2026-08-01T10:00:00Z" }),
  documentItem({ id: "middle", name: "Angebot.csv", extension: "csv", mimeType: "text/plain", size: 100, modified: "2026-07-01T10:00:00Z" }),
  documentItem({ id: "missing", name: "Ohne Daten", extension: null, size: null, modified: null }),
];

test("project files default to newest modified date without mutating the API array", () => {
  const originalOrder = documents.map((item) => item.id);
  const sorted = sortProjectDocumentItems(documents, DEFAULT_PROJECT_DOCUMENT_SORT);

  assert.deepEqual(sorted.map((item) => item.id), ["new", "middle", "old", "missing"]);
  assert.deepEqual(documents.map((item) => item.id), originalOrder);
  assert.deepEqual(
    sortProjectDocumentItems(documents, { key: "modified", direction: "asc" }).map((item) => item.id),
    ["old", "middle", "new", "missing"],
  );
});

test("name, visible type and numeric byte size sort in both directions", () => {
  assert.deepEqual(
    sortProjectDocumentItems(documents, { key: "name", direction: "asc" }).map((item) => item.name),
    ["Angebot.csv", "Ohne Daten", "Plan 2.xlsx", "Plan 10.pdf"],
  );
  assert.deepEqual(
    sortProjectDocumentItems(documents, { key: "name", direction: "desc" }).map((item) => item.name),
    ["Plan 10.pdf", "Plan 2.xlsx", "Ohne Daten", "Angebot.csv"],
  );
  assert.deepEqual(
    sortProjectDocumentItems(documents, { key: "type", direction: "asc" }).map((item) => item.id),
    ["middle", "missing", "old", "new"],
  );
  assert.deepEqual(
    sortProjectDocumentItems(documents, { key: "size", direction: "asc" }).map((item) => item.id),
    ["middle", "old", "new", "missing"],
  );
  assert.deepEqual(
    sortProjectDocumentItems(documents, { key: "size", direction: "desc" }).map((item) => item.id),
    ["new", "old", "middle", "missing"],
  );
});

test("equal primary values use the filename as a stable tie-breaker", () => {
  const tied = [
    documentItem({ id: "b", name: "B.pdf", extension: "pdf", size: 10, modified: "2026-08-01T10:00:00Z" }),
    documentItem({ id: "a", name: "A.pdf", extension: "pdf", size: 10, modified: "2026-08-01T10:00:00Z" }),
  ];

  assert.deepEqual(
    sortProjectDocumentItems(tied, { key: "modified", direction: "desc" }).map((item) => item.id),
    ["a", "b"],
  );
});

test("header changes share one sort state and use the required first-click directions", () => {
  assert.deepEqual(getNextProjectDocumentSort(DEFAULT_PROJECT_DOCUMENT_SORT, "modified"), { key: "modified", direction: "asc" });
  assert.deepEqual(getNextProjectDocumentSort(DEFAULT_PROJECT_DOCUMENT_SORT, "name"), { key: "name", direction: "asc" });
  assert.deepEqual(getNextProjectDocumentSort({ key: "name", direction: "asc" }, "name"), { key: "name", direction: "desc" });
  assert.deepEqual(getNextProjectDocumentSort({ key: "size", direction: "desc" }, "modified"), { key: "modified", direction: "desc" });
});

test("the file table filters before sorting and exposes accessible sortable column headers", () => {
  assert.match(pageSource, /const filteredItems = normalizedQuery[\s\S]*sortProjectDocumentItems\(filteredItems, documentSort\)/);
  assert.match(pageSource, /<th scope="col" aria-sort=\{ariaSort\}>/);
  assert.match(pageSource, /className=\{`project-document-sort-trigger/);
  assert.match(pageSource, /activeSort\.direction === "asc" \? "↑" : "↓"/);
  assert.match(pageSource, /setDocumentSort\(\(currentSort\) => getNextProjectDocumentSort\(currentSort, key\)\)/);
});
