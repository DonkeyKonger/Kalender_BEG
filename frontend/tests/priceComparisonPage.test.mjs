import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("price comparison is the final admin and project-manager navigation item", () => {
  const navigation = read("config/navigation.ts");
  const item = navigation.slice(navigation.lastIndexOf("label: \"Preisvergleich\""));

  assert.match(item, /path: "\/price-comparison"/);
  assert.match(item, /roles: \["admin", "project_manager"\]/);
  assert.doesNotMatch(item, /officePermission/);
  assert.ok(navigation.lastIndexOf('label: "Preisvergleich"') > navigation.lastIndexOf('label: "Meine Einsaetze"'));
});

test("price comparison route stays lazy and protected without an office permission", () => {
  const app = read("App.tsx");

  assert.match(app, /const PriceComparisonPage = lazy/);
  assert.match(app, /ProtectedRoute roles=\{\["admin", "project_manager"\]\}/);
  assert.match(app, /path="price-comparison"/);
  assert.match(app, /<PriceComparisonPage \/>/);
});

test("all four native workspaces and guarded duplicate workflows remain present", () => {
  const page = read("pages/PriceComparisonPage.tsx");

  for (const label of ["Artikelvergleich", "Angebote OBO", "Nettopreisabgleich", "Dateien"]) {
    assert.match(page, new RegExp(label.replace(/[()]/g, "\\$&")));
  }
  assert.match(page, /24 Monate/);
  assert.match(page, /nur Erstangebote/);
  assert.match(page, /mindestens 5 Preise/);
  assert.match(page, /\/price-comparison\/maintenance\/preview/);
  assert.match(page, /confirmed_duplicates/);
  assert.match(page, /duplicate_offers/);
  assert.match(page, /Der Datenstand wurde zwischenzeitlich geändert/);
  assert.match(page, /offset: nextOffset, limit: suggestionLimit/);
  assert.match(page, /Median 24 Monate/);
  assert.match(page, /price_change_positions/);
  assert.match(page, /Preisniveau/);
  assert.match(page, /Ø Positionsabweichung/);
  assert.match(page, /36 Kalendermonate/);
  assert.match(page, /drei unterschiedlichen Erstangeboten/);
  assert.match(page, /mindestens 50 % Abdeckung des prüfbaren Positionswerts/);
  assert.doesNotMatch(page, /365-Tage-Fenster/);
  assert.match(page, /offer\.comparison_quality/);
  assert.doesNotMatch(page, /offer-price-quality/);
  assert.match(page, /offer-detail-quality/);
  assert.match(page, /price_level: query\.priceLevel/);
  assert.match(page, /sort: query\.sort/);
  assert.match(page, /offerQueryRef\.current = offerQuery/);
  assert.match(page, /const query = offerQueryRef\.current/);
  assert.match(page, /query === offerQueryRef\.current/);
  assert.match(page, /offerInfoRef\.current\?\.contains/);
  assert.match(page, /event\.key !== "Escape"/);
  assert.match(page, /Cluster-Sicherheit/);
  assert.match(page, /Zur Datanorm/);
  assert.match(page, /new Date\(b\.date\).*new Date\(a\.date\)/);
  assert.match(page, /scrollIntoView/);
  assert.match(page, /prefers-reduced-motion: reduce/);
  assert.match(page, /initialDetailScrollDone\.current/);
});

test("price tabs stay visible without vertical or narrow-screen overflow", () => {
  const styles = read("priceComparison/priceComparison.css");

  assert.match(styles, /\.price-view-tabs\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*?\.price-view-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[^}]*overflow:\s*hidden;/s);
});

test("price downloads reuse the shared authenticated request with refresh", () => {
  const client = read("priceComparison/client.ts");
  const api = read("lib/api.ts");

  assert.match(client, /import \{ authenticatedFetch \} from "\.\.\/lib\/api"/);
  assert.match(client, /return authenticatedFetch\(path, options, retry\)/);
  assert.match(api, /export function authenticatedFetch/);
});

test("offer summaries accept the strict comparison quality contract as optional metadata", () => {
  const client = read("priceComparison/client.ts");

  for (const field of ["method_version", "as_of", "window_start", "total_positions", "eligible_positions", "matched_positions", "excluded_positions", "reference_offer_count", "value_coverage_pct", "position_coverage_pct"]) {
    assert.match(client, new RegExp(`${field}:`));
  }
  assert.match(client, /status: "reliable" \| "unavailable"/);
  assert.match(client, /comparison_quality\?: OfferComparisonQuality \| null/);
  for (const reason of ["insufficient_references", "insufficient_coverage", "invalid_prices", "invalid_date", "no_comparable_positions"]) {
    assert.match(client, new RegExp(reason));
  }
});
