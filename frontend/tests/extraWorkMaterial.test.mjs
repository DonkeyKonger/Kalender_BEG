import assert from "node:assert/strict";
import test from "node:test";

import {
  formatExtraWorkMaterialQuantity,
  parseExtraWorkMaterialInput,
} from "../src/lib/extraWorkMaterial.ts";

test("material quick input recognizes common German construction quantities", () => {
  assert.deepEqual(parseExtraWorkMaterialInput("2x Stiel US 5 bis 500"), {
    quantity: 2,
    unit: "x",
    description: "Stiel US 5 bis 500",
  });
  assert.deepEqual(parseExtraWorkMaterialInput("4 x Vertikalgelenk 300/60"), {
    quantity: 4,
    unit: "x",
    description: "Vertikalgelenk 300/60",
  });
  assert.deepEqual(parseExtraWorkMaterialInput("10 m Kabelrinne 200/60"), {
    quantity: 10,
    unit: "m",
    description: "Kabelrinne 200/60",
  });
  assert.deepEqual(parseExtraWorkMaterialInput("2,5m Kabelrinne"), {
    quantity: 2.5,
    unit: "m",
    description: "Kabelrinne",
  });
  assert.deepEqual(parseExtraWorkMaterialInput("2.5 m Kabelrinne"), {
    quantity: 2.5,
    unit: "m",
    description: "Kabelrinne",
  });
  assert.deepEqual(parseExtraWorkMaterialInput("3 Stück Ausleger AW 55/31"), {
    quantity: 3,
    unit: "Stk",
    description: "Ausleger AW 55/31",
  });
});

test("unrecognized material text is retained without inventing a quantity", () => {
  assert.deepEqual(parseExtraWorkMaterialInput("Kleinmaterial Befestigung"), {
    quantity: null,
    unit: null,
    description: "Kleinmaterial Befestigung",
  });
  assert.equal(parseExtraWorkMaterialInput("   "), null);
});

test("material badges use compact German quantities", () => {
  assert.equal(formatExtraWorkMaterialQuantity(2, "x"), "2×");
  assert.equal(formatExtraWorkMaterialQuantity(10, "m"), "10 m");
  assert.equal(formatExtraWorkMaterialQuantity(2.5, "m"), "2,5 m");
  assert.equal(formatExtraWorkMaterialQuantity(null, null), "");
});

test("ten quick material rows can be parsed locally without API coordination", () => {
  const items = Array.from({ length: 10 }, (_, index) => (
    parseExtraWorkMaterialInput(`${index + 1}x Material ${index + 1}`)
  ));
  assert.equal(items.length, 10);
  assert.equal(items.every((item) => item?.description.startsWith("Material ")), true);
});
