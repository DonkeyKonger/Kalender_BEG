import assert from "node:assert/strict";
import test from "node:test";

import { offerComparisonQualityPresentation, offerPriceLevelDisplayValue, offerPriceLevelPresentation } from "../src/priceComparison/offerPriceLevel.ts";

const reliableQuality = {
  method_version: "basket-v2",
  as_of: "2026-11-26",
  window_start: "2023-11-01",
  status: "reliable",
  reason: null,
  total_positions: 8,
  eligible_positions: 7,
  matched_positions: 6,
  excluded_positions: 2,
  reference_offer_count: 12,
  value_coverage_pct: 74.5,
  position_coverage_pct: 75,
};

test("missing and invalid values have no comparison presentation", () => {
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(offerPriceLevelPresentation(value), {
      tone: "none",
      label: "Ohne Vergleich",
    });
  }
});

test("zero is neutral while positive levels change tone at ten percent", () => {
  assert.deepEqual(offerPriceLevelPresentation(0), {
    tone: "neutral",
    label: "gleichauf",
  });
  assert.deepEqual(offerPriceLevelPresentation(9.99), {
    tone: "above",
    label: "darüber",
  });
  assert.deepEqual(offerPriceLevelPresentation(10), {
    tone: "high",
    label: "darüber",
  });
});

test("tiny non-zero deviations stay directional instead of looking exactly equal", () => {
  assert.equal(offerPriceLevelDisplayValue(-0.0049, "0,0 %"), "<0,01 %");
  assert.equal(offerPriceLevelDisplayValue(0.0049, "0,0 %"), "<0,01 %");
  assert.equal(offerPriceLevelDisplayValue(0, "0,0 %"), "0,0 %");
  assert.equal(offerPriceLevelDisplayValue(-0.005, "-0,01 %"), "-0,01 %");
});

test("negative and large deviations preserve their direction and tone", () => {
  assert.deepEqual(offerPriceLevelPresentation(-10), {
    tone: "below",
    label: "darunter",
  });
  assert.deepEqual(offerPriceLevelPresentation(-20), {
    tone: "below",
    label: "darunter",
  });
  assert.deepEqual(offerPriceLevelPresentation(-100), {
    tone: "below",
    label: "darunter",
  });
  assert.deepEqual(offerPriceLevelPresentation(100), {
    tone: "high",
    label: "darüber",
  });
});

test("missing quality metadata preserves the legacy comparison labels", () => {
  assert.deepEqual(offerComparisonQualityPresentation(undefined), {
    unavailableLabel: "Ohne Vergleich",
    summary: null,
    tooltip: null,
  });
});

test("reliable quality summarizes articles and value coverage with method details", () => {
  const presentation = offerComparisonQualityPresentation(reliableQuality);

  assert.equal(presentation.unavailableLabel, "Ohne Vergleich");
  assert.equal(presentation.summary, "6/7 Artikel · 74,5 % Wertabdeckung");
  assert.match(presentation.tooltip, /Belastbare Vergleichsbasis/);
  assert.match(presentation.tooltip, /Verglichen: 6 von 7 prüfbaren Artikeln/);
  assert.match(presentation.tooltip, /Gesamtpositionen: 8/);
  assert.match(presentation.tooltip, /Historische Erstangebote: 12/);
  assert.match(presentation.tooltip, /Ausgeschlossen: 2 Positionen/);
  assert.match(presentation.tooltip, /Methode: basket-v2/);
  assert.match(presentation.tooltip, /Stand: 26\.11\.2026/);
  assert.match(presentation.tooltip, /Fenster ab: 01\.11\.2023/);
});

test("unavailable quality has a clear label and a specific compact reason", () => {
  const reasons = [
    ["insufficient_references", "Zu wenige historische Erstangebote"],
    ["insufficient_coverage", "Wertabdeckung unter 60 %"],
    ["invalid_prices", "Fehlende oder ungültige Preise"],
    ["invalid_date", "Ungültiges Angebotsdatum"],
    ["no_comparable_positions", "Keine vergleichbaren Positionen"],
  ];

  for (const [reason, label] of reasons) {
    const presentation = offerComparisonQualityPresentation({ ...reliableQuality, status: "unavailable", reason });
    assert.equal(presentation.unavailableLabel, "Keine belastbare Vergleichsbasis");
    assert.equal(presentation.summary, label);
    assert.match(presentation.tooltip, new RegExp(`Keine belastbare Vergleichsbasis: ${label}`));
  }
});
