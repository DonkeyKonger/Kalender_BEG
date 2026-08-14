import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildMeasurementPositionCatalog,
  getMeasurementPositionCatalogKey,
} from "../src/lib/measurementPositionCatalog.ts";

const sitePageSource = await readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");

function catalogItem({ id, position, sortOrder = id, isFree = false, isHidden = false }) {
  return {
    id,
    position,
    description: `Beschreibung ${position}`,
    unit: "ST",
    sort_order: sortOrder,
    is_free_position: isFree,
    is_hidden: isHidden,
  };
}

test("active catalog combines main offer and supplement positions but excludes free rows", () => {
  const mainOffer = Array.from({ length: 20 }, (_, index) => catalogItem({
    id: index + 1,
    position: `444.4.${String(index + 1).padStart(3, "0")}`,
  }));
  const supplement = Array.from({ length: 5 }, (_, index) => catalogItem({
    id: index + 21,
    position: `N1.${(index + 1) * 10}`,
  }));

  const catalog = buildMeasurementPositionCatalog([
    ...mainOffer,
    ...supplement,
    catalogItem({ id: 26, position: "N1", isFree: true }),
    catalogItem({ id: 27, position: "N1.60", isHidden: true }),
  ]);

  assert.equal(catalog.length, 25);
  assert.deepEqual(catalog.slice(-5).map((item) => item.position), [
    "N1.10",
    "N1.20",
    "N1.30",
    "N1.40",
    "N1.50",
  ]);
});

test("desktop review loads the active catalog independently from batch matrix rows", () => {
  assert.match(
    sitePageSource,
    /api\.measurementItems\(site\.id, \{ activeOnly: true \}\)/,
  );
  assert.match(
    sitePageSource,
    /positionSuggestions=\{reviewPositionSuggestions\}/,
  );
  assert.match(sitePageSource, /\.\.\.historicalSuggestions, \.\.\.projectPositionSuggestions/);
  assert.doesNotMatch(
    sitePageSource,
    /positionSuggestions=\{isFreePositionOnlyBatch[\s\S]*?batchItems\.filter\(\(item\) => !item\.is_free_position\)/,
  );
  assert.match(
    apiSource,
    /measurementItems[\s\S]*?measurement-items\$\{suffix\}`, \{\s*cache: "no-store"/,
  );
});

test("historical and active catalog copies share one stable position key", () => {
  assert.equal(getMeasurementPositionCatalogKey("  N1.10  "), "n1.10");
  assert.equal(getMeasurementPositionCatalogKey("444.4.310"), "444.4.310");
  assert.match(sitePageSource, /usedPositionSuggestionKeys/);
  assert.match(sitePageSource, /getMeasurementPositionCatalogKey\(item\.position\)/);
});
