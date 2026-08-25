import assert from "node:assert/strict";
import test from "node:test";

import {
  formatExtraWorkDocumentMaterialText,
  formatExtraWorkMaterialQuantity,
  parseExtraWorkMaterialInput,
  rehydrateExtraWorkMaterialItems,
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

test("piece aliases are case-insensitive and normalize without confusing hours", () => {
  for (const input of [
    "2 St US 5",
    "2 st US 5",
    "2 Stk US 5",
    "2 stk US 5",
    "2 Stck US 5",
    "2 stck US 5",
    "2 Stck. US 5",
    "2 Stück US 5",
    "2 stueck US 5",
    "2Stk US 5",
  ]) {
    assert.deepEqual(parseExtraWorkMaterialInput(input), {
      quantity: 2,
      unit: "Stk",
      description: "US 5",
    });
  }
  assert.deepEqual(parseExtraWorkMaterialInput("3 Std Montagehilfe"), {
    quantity: 3,
    unit: "Std",
    description: "Montagehilfe",
  });
  assert.deepEqual(parseExtraWorkMaterialInput("3 std Montagehilfe"), {
    quantity: 3,
    unit: "Std",
    description: "Montagehilfe",
  });
});

test("construction unit aliases normalize to compact canonical units", () => {
  const cases = [
    ["10m RKSM 610", 10, "m", "RKSM 610"],
    ["10 Meter RKSM 610", 10, "m", "RKSM 610"],
    ["10 LFM RKSM 610", 10, "m", "RKSM 610"],
    ["2,5 m Kabelrinne", 2.5, "m", "Kabelrinne"],
    ["2.5m Kabelrinne", 2.5, "m", "Kabelrinne"],
    ["25 MM Dübel", 25, "mm", "Dübel"],
    ["3 CM Abstand", 3, "cm", "Abstand"],
    ["5 KG Gips", 5, "kg", "Gips"],
    ["500 G Schrauben", 500, "g", "Schrauben"],
    ["1 Rolle Leitung", 1, "Rolle", "Leitung"],
    ["2 Pakete Dübel", 2, "Paket", "Dübel"],
    ["1 Packung Schrauben", 1, "Packung", "Schrauben"],
    ["1 Satz Bohrer", 1, "Satz", "Bohrer"],
  ];
  for (const [input, quantity, unit, description] of cases) {
    assert.deepEqual(parseExtraWorkMaterialInput(String(input)), { quantity, unit, description });
  }
});

test("unrecognized material text is retained without inventing a quantity", () => {
  assert.deepEqual(parseExtraWorkMaterialInput("Kleinmaterial Befestigung"), {
    quantity: null,
    unit: null,
    description: "Kleinmaterial Befestigung",
  });
  assert.deepEqual(parseExtraWorkMaterialInput("100 Schutzkappen"), {
    quantity: null,
    unit: null,
    description: "100 Schutzkappen",
  });
  assert.equal(parseExtraWorkMaterialInput("   "), null);
});

test("material badges use compact German quantities", () => {
  assert.equal(formatExtraWorkMaterialQuantity(2, "x"), "2×");
  assert.equal(formatExtraWorkMaterialQuantity(10, "m"), "10 m");
  assert.equal(formatExtraWorkMaterialQuantity(2.5, "m"), "2,5 m");
  assert.equal(formatExtraWorkMaterialQuantity(3, "Std"), "3 Std");
  assert.equal(formatExtraWorkMaterialQuantity(null, null), "");
});

test("ten quick material rows can be parsed locally without API coordination", () => {
  const items = Array.from({ length: 10 }, (_, index) => (
    parseExtraWorkMaterialInput(`${index + 1}x Material ${index + 1}`)
  ));
  assert.equal(items.length, 10);
  assert.equal(items.every((item) => item?.description.startsWith("Material ")), true);
});

test("saved material items rehydrate exactly and match the PDF-backed document field", () => {
  const storedItems = [
    { quantity: 2, unit: "x", description: "Stiel US 5 bis 500" },
    { quantity: 2.555, unit: "m", description: "Kabelrinne Ä/Ö & Dübel\nTyp B" },
    { quantity: 0, unit: null, description: "Leere Menge zulässig" },
    { quantity: null, unit: null, description: "Kleinmaterial" },
  ];
  let nextId = 0;

  assert.deepEqual(rehydrateExtraWorkMaterialItems(storedItems, () => `row-${++nextId}`), [
    { id: "row-1", quantity: 2, unit: "x", description: "Stiel US 5 bis 500" },
    { id: "row-2", quantity: 2.555, unit: "m", description: "Kabelrinne Ä/Ö & Dübel\nTyp B" },
    { id: "row-3", quantity: 0, unit: null, description: "Leere Menge zulässig" },
    { id: "row-4", quantity: null, unit: null, description: "Kleinmaterial" },
  ]);
  assert.deepEqual(rehydrateExtraWorkMaterialItems(null, () => "unused"), []);
  assert.equal(formatExtraWorkDocumentMaterialText("Altmaterial\r\nZeile 2", storedItems), (
    "Altmaterial\nZeile 2\n"
    + "2x Stiel US 5 bis 500; "
    + "2,56 m Kabelrinne Ä/Ö & Dübel Typ B; "
    + "0 Leere Menge zulässig; Kleinmaterial"
  ));
});
