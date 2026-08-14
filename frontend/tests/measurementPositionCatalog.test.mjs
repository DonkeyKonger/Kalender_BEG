import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDesktopMeasurementPositionGroups,
  buildMeasurementSourceDocumentGroups,
} from "../src/lib/measurementPositionGroups.ts";

const sitePageSource = await readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const mobilePageSource = await readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const stylesSource = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("every successful offer import refreshes the selected batch position catalog", () => {
  const importStart = sitePageSource.indexOf("async function importMeasurementTimesheet(");
  const importEnd = sitePageSource.indexOf("function updateSiteDraft(", importStart);
  const importSource = sitePageSource.slice(importStart, importEnd);

  assert.match(importSource, /const selectedBatchId = selectedMeasurementBatch\?\.id \?\? null/);
  assert.doesNotMatch(importSource, /selectedMeasurementBatch\?\.measurement_base_id === result\.measurement_base\.id/);
  assert.match(importSource, /api\.siteMeasurementBatchItems\(site\.id, selectedBatchId\)/);
  assert.match(importSource, /setMeasurementBatchItems\(orderMeasurementItemsByColumnPosition\(selectedBatchItems\)\)/);
});

test("desktop and mobile position catalogs always bypass stale HTTP responses", () => {
  assert.match(
    apiSource,
    /siteMeasurementBatchItems[\s\S]*?measurement-batches\/\$\{batchId\}\/items`, \{\s*cache: "no-store"/,
  );
  assert.match(
    apiSource,
    /mobileMeasurementBatchItems[\s\S]*?measurement-batches\/\$\{batchId\}\/items`, \{\s*cache: "no-store"/,
  );
});

test("catalog refresh does not add empty offer positions to the correction matrix", () => {
  assert.match(sitePageSource, /const itemsWithEntries = batchItems\.filter\(\(item\) => item\.entries\.length > 0\)/);
  assert.match(
    sitePageSource,
    /const tableItems = isFreePositionOnlyBatch\s*\? batchItems\.filter\(hasMeaningfulFreeMeasurementData\)\s*: itemsWithEntries/,
  );
  assert.match(sitePageSource, /positionSuggestions=\{reviewPositionSuggestions\}/);
  assert.match(sitePageSource, /buildMeasurementPositionCatalog\(catalogItems\)/);
});

test("desktop review keeps historical batch positions while extending suggestions from the active catalog", () => {
  assert.match(sitePageSource, /const reviewPositionSuggestions = useMemo<MeasurementPositionSuggestion\[]>/);
  assert.match(sitePageSource, /buildMeasurementPositionCatalog\(batchItems\)/);
  assert.match(sitePageSource, /\[\.\.\.historicalSuggestions, \.\.\.projectPositionSuggestions\]/);
  assert.match(sitePageSource, /getMeasurementPositionCatalogKey\(suggestion\.position\)/);
});

test("mobile keeps the existing position selection and grouping behavior", () => {
  assert.match(mobilePageSource, /const response = await api\.mobileMeasurementBatchItems\(assignment\.id, batch\.id\);\s*setItems\(response\)/);
  assert.match(mobilePageSource, /const capturedGroup = groups\.find\(\(group\) => group\.kind === "captured" && group\.count > 0\)/);
  assert.match(mobilePageSource, /return capturedGroup\.key/);
});

test("mobile groups a main offer and appended supplement even below thirty positions", () => {
  const items = [
    ...Array.from({ length: 20 }, (_, index) => sourceItem(
      index + 1,
      `444.4.${310 + index * 10}`,
      "Hauptangebot.pdf",
      "A-100",
    )),
    ...Array.from({ length: 5 }, (_, index) => sourceItem(
      index + 21,
      `N1.${(index + 1) * 10}`,
      "Nachtrag N1.pdf",
      "N1",
    )),
  ];

  const groups = buildMeasurementSourceDocumentGroups(items);

  assert.deepEqual(groups.map((group) => group.label), ["Hauptangebot", "N1"]);
  assert.deepEqual(groups.map((group) => group.items.length), [20, 5]);
  assert.match(mobilePageSource, /const hasMultipleSourceDocuments = sourceDocumentGroups\.length > 1/);
  assert.match(mobilePageSource, /offerItems\.length < 30 && !hasMultipleSourceDocuments/);
  assert.match(mobilePageSource, /const prefixGroups = hasMultipleSourceDocuments\s*\? \[\]/);
  assert.match(mobilePageSource, /if \(!hasMultipleSourceDocuments && sourceSectionGroups\.length === 0/);
  assert.match(mobilePageSource, /const catalogGroups = \[\.\.\.sourceGroups, \.\.\.prefixGroups\]/);
});

test("mobile keeps each appended import in its own stable supplement group", () => {
  const groups = buildMeasurementSourceDocumentGroups([
    sourceItem(1, "1.10", "Angebot.pdf", "A-100"),
    sourceItem(2, "N1.10", "Nachtrag-1.pdf", "N1"),
    sourceItem(3, "N1.20", "Nachtrag-1.pdf", "N1"),
    sourceItem(4, "N2.10", "Nachtrag-2.pdf", "N2"),
  ]);

  assert.deepEqual(groups.map((group) => group.label), ["Hauptangebot", "N1", "N2"]);
  assert.deepEqual(groups.map((group) => [...group.items.map((item) => item.id)]), [[1], [2, 3], [4]]);
});

test("mobile can separate a legacy main offer from a sourced supplement", () => {
  const groups = buildMeasurementSourceDocumentGroups([
    sourceItem(1, "1.10", null, null),
    sourceItem(2, "1.20", null, null),
    sourceItem(3, "N1.10", "Nachtrag.pdf", null),
  ]);

  assert.deepEqual(groups.map((group) => group.label), ["Hauptangebot", "N1"]);
  assert.deepEqual(groups.map((group) => group.items.length), [2, 1]);
});

test("source grouping keeps supplements separate even when import metadata is identical or missing", () => {
  const groups = buildMeasurementSourceDocumentGroups([
    sourceItem(3, "N2.10", "Gesamtangebot.pdf", "A-100"),
    sourceItem(2, "N1.10", "Gesamtangebot.pdf", "A-100"),
    sourceItem(1, "1.10", "Gesamtangebot.pdf", "A-100"),
    sourceItem(4, "N3.10", null, null),
  ]);

  assert.deepEqual(groups.map((group) => group.label), ["Hauptangebot", "N1", "N2", "N3"]);
  assert.deepEqual(groups.map((group) => group.items.length), [1, 1, 1, 1]);
});

test("desktop replaces captured-state filters with offer groups and a manual-only group", () => {
  const groups = buildDesktopMeasurementPositionGroups([
    desktopItem(1, "1.10", "Hauptangebot.pdf", "A-100"),
    desktopItem(2, "N1.10", "Nachtrag N1.pdf", "N1"),
    desktopItem(3, "N1.20", "Nachtrag N1.pdf", "N1"),
    desktopItem(4, "FREI-1", null, null, true),
  ]);

  assert.deepEqual(groups.map((group) => group.label), [
    "Alle Positionen",
    "Hauptangebot",
    "N1",
    "Manuell erfasst",
  ]);
  assert.deepEqual(groups.map((group) => group.count), [4, 1, 2, 1]);
  assert.deepEqual([...groups.at(-1).itemIds], [4]);
  assert.doesNotMatch(sitePageSource, /Noch nicht erfasst/);
  assert.doesNotMatch(sitePageSource, /MeasurementTimesheetFilter/);
  assert.match(sitePageSource, /buildDesktopMeasurementPositionGroups/);
});

test("desktop execution status omits the remaining quantity column and captured-row marker", () => {
  assert.doesNotMatch(sitePageSource, />Restmenge</);
  assert.doesNotMatch(sitePageSource, /row\.remainingQuantity/);
  assert.equal([...sitePageSource.matchAll(/colSpan=\{9\}/g)].length, 2);
  assert.doesNotMatch(stylesSource, /tr\.has-quantity td:nth-child\(2\)/);
});

function sourceItem(id, position, sourceFileName, sourceInvoiceNumber) {
  return {
    id,
    position,
    source_file_name: sourceFileName,
    source_invoice_number: sourceInvoiceNumber,
  };
}

function desktopItem(id, position, sourceFileName, sourceInvoiceNumber, isFreePosition = false) {
  return {
    ...sourceItem(id, position, sourceFileName, sourceInvoiceNumber),
    is_free_position: isFreePosition,
    is_hidden: false,
  };
}
