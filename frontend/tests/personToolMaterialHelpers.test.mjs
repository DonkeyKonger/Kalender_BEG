import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPersonToolMaterialDate,
  getPersonToolMaterialViewState,
  PERSON_TOOL_MATERIAL_EMPTY_TEXT,
} from "../src/lib/personToolMaterialView.ts";


const item = {
  beg_number: "BEG-2",
  manufacturer: "Bosch",
  designation: "Bohrmaschine",
  item_date: "2026-07-15",
};


test("person tool material view exposes loading, error, empty and ready states", () => {
  assert.equal(getPersonToolMaterialViewState({ isLoading: true, error: null, items: [] }), "loading");
  assert.equal(getPersonToolMaterialViewState({ isLoading: false, error: "Fehler", items: [] }), "error");
  assert.equal(getPersonToolMaterialViewState({ isLoading: false, error: null, items: [] }), "empty");
  assert.equal(getPersonToolMaterialViewState({ isLoading: false, error: null, items: [item] }), "ready");
});


test("person tool material empty text and date format match the compact view", () => {
  assert.equal(
    PERSON_TOOL_MATERIAL_EMPTY_TEXT,
    "Diesem Mitarbeiter sind aktuell keine Werkzeuge oder Materialien zugeordnet.",
  );
  assert.equal(formatPersonToolMaterialDate("2026-07-15"), "15.07.2026");
  assert.equal(formatPersonToolMaterialDate(null), "–");
});
