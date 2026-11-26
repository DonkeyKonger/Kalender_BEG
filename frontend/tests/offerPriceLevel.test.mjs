import assert from "node:assert/strict";
import test from "node:test";

import { offerPriceLevelDisplayValue, offerPriceLevelPresentation } from "../src/priceComparison/offerPriceLevel.ts";

test("missing and invalid values have no comparison presentation", () => {
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(offerPriceLevelPresentation(value), {
      tone: "none",
      label: "Ohne Vergleich",
      meter: null,
    });
  }
});

test("zero is neutral while positive levels change tone at ten percent", () => {
  assert.deepEqual(offerPriceLevelPresentation(0), {
    tone: "neutral",
    label: "gleichauf",
    meter: { left: 50, width: 0 },
  });
  assert.deepEqual(offerPriceLevelPresentation(9.99), {
    tone: "above",
    label: "darüber",
    meter: { left: 50, width: 24.975 },
  });
  assert.deepEqual(offerPriceLevelPresentation(10), {
    tone: "high",
    label: "darüber",
    meter: { left: 50, width: 25 },
  });
});

test("tiny non-zero deviations stay directional instead of looking exactly equal", () => {
  assert.equal(offerPriceLevelDisplayValue(-0.0049, "0,0 %"), "<0,01 %");
  assert.equal(offerPriceLevelDisplayValue(0.0049, "0,0 %"), "<0,01 %");
  assert.equal(offerPriceLevelDisplayValue(0, "0,0 %"), "0,0 %");
  assert.equal(offerPriceLevelDisplayValue(-0.005, "-0,01 %"), "-0,01 %");
});

test("the diverging meter is capped at twenty percent without changing the value", () => {
  assert.deepEqual(offerPriceLevelPresentation(-10), {
    tone: "below",
    label: "darunter",
    meter: { left: 25, width: 25 },
  });
  assert.deepEqual(offerPriceLevelPresentation(-20), {
    tone: "below",
    label: "darunter",
    meter: { left: 0, width: 50 },
  });
  assert.deepEqual(offerPriceLevelPresentation(-100), {
    tone: "below",
    label: "darunter",
    meter: { left: 0, width: 50 },
  });
  assert.deepEqual(offerPriceLevelPresentation(100), {
    tone: "high",
    label: "darüber",
    meter: { left: 50, width: 50 },
  });
});
