import assert from "node:assert/strict";
import test from "node:test";

import { offerPriceLevelDisplayValue, offerPriceLevelPresentation } from "../src/priceComparison/offerPriceLevel.ts";

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
