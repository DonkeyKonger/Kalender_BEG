import assert from "node:assert/strict";
import test from "node:test";

import { filterPickerOptions } from "../src/lib/pickerSearch.ts";
import { buildToolMaterialEmployeeOptions } from "../src/lib/toolMaterialEmployees.ts";
import {
  buildToolMaterialSearchParams,
  clearAllToolMaterialFilters,
  clearToolMaterialColumnFilter,
  hasToolMaterialFilters,
} from "../src/lib/toolMaterialFilters.ts";
import {
  getSuggestedToolMaterialStatus,
  getToolMaterialStatusPresentation,
  toolMaterialStatusOptions,
} from "../src/lib/toolMaterialStatus.ts";


test("individual and all tool material filters can be reset", () => {
  const filters = {
    manufacturer: { query: "Bosch" },
    stock: { stockMin: "2", values: ["3"] },
  };

  const withoutManufacturer = clearToolMaterialColumnFilter(filters, "manufacturer");

  assert.equal(hasToolMaterialFilters(filters), true);
  assert.equal(withoutManufacturer.manufacturer, undefined);
  assert.deepEqual(withoutManufacturer.stock, filters.stock);
  assert.deepEqual(clearAllToolMaterialFilters(), {});
  assert.equal(hasToolMaterialFilters(clearAllToolMaterialFilters()), false);
});


test("global search, combined column filters and sorting share one API query", () => {
  const params = buildToolMaterialSearchParams({
    search: "Bohrmaschine",
    filters: {
      manufacturer: { query: "Bosch", values: ["Bosch", "Makita"] },
      item_date: { dateFrom: "2026-01-01", dateTo: "2026-12-31" },
      stock: { stockMin: "1", stockMax: "8" },
      status: { values: ["issued", "defective"] },
    },
    sortBy: "beg_number",
    sortDirection: "desc",
  });

  assert.equal(params.get("search"), "Bohrmaschine");
  assert.equal(params.get("filter_manufacturer"), "Bosch");
  assert.deepEqual(params.getAll("values_manufacturer"), ["Bosch", "Makita"]);
  assert.equal(params.get("date_from"), "2026-01-01");
  assert.equal(params.get("date_to"), "2026-12-31");
  assert.equal(params.get("stock_min"), "1");
  assert.equal(params.get("stock_max"), "8");
  assert.deepEqual(params.getAll("values_status"), ["issued", "defective"]);
  assert.equal(params.get("sort_by"), "beg_number");
  assert.equal(params.get("sort_direction"), "desc");
});


test("employee assignment suggests issued or warehouse without overriding defective", () => {
  assert.equal(getSuggestedToolMaterialStatus("warehouse", "7"), "issued");
  assert.equal(getSuggestedToolMaterialStatus("issued", ""), "warehouse");
  assert.equal(getSuggestedToolMaterialStatus("defective", "7"), "defective");
  assert.equal(getSuggestedToolMaterialStatus("defective", ""), "defective");
});


test("all tool material statuses have the expected Office badge presentation", () => {
  assert.deepEqual(
    toolMaterialStatusOptions.map(({ value, label, badgeClass }) => [value, label, badgeClass]),
    [
      ["issued", "Ausgegeben", "is-issued"],
      ["warehouse", "Lager", "is-warehouse"],
      ["defective", "Defekt", "is-defective"],
    ],
  );
  assert.equal(getToolMaterialStatusPresentation("issued").label, "Ausgegeben");
  assert.equal(getToolMaterialStatusPresentation("warehouse").label, "Lager");
  assert.equal(getToolMaterialStatusPresentation("defective").label, "Defekt");
});


test("employee picker groups and sorts active internal and external people", () => {
  const options = buildToolMaterialEmployeeOptions([
    employee(1, "Zoe Intern", "internal", true),
    employee(2, "anna Intern", "internal", true),
    employee(3, "Aaron Extern", "external", true),
    employee(4, "Nicht gewählt", "external", false),
  ], null);

  assert.deepEqual(options.map(({ label, groupLabel }) => [label, groupLabel]), [
    ["anna Intern", "Interne Mitarbeiter"],
    ["Zoe Intern", "Interne Mitarbeiter"],
    ["Aaron Extern", "Externe Mitarbeiter"],
  ]);
});


test("employee picker search keeps group metadata and inactive historical assignment", () => {
  const historical = employee(8, "Ina Alt", "internal", false);
  const options = buildToolMaterialEmployeeOptions([
    employee(1, "Max Intern", "internal", true),
    employee(2, "Erika Extern", "external_temp", true),
  ], historical);

  const searchResult = filterPickerOptions(options, "extern");

  assert.deepEqual(searchResult.map(({ label, groupLabel }) => [label, groupLabel]), [
    ["Erika Extern", "Externe Mitarbeiter"],
  ]);
  assert.ok(options.some((option) => (
    option.value === "8"
    && option.label === "Ina Alt (inaktiv)"
    && option.groupLabel === "Interne Mitarbeiter"
  )));
});


function employee(id, displayName, personType, isActive) {
  return {
    id,
    display_name: displayName,
    short_code: displayName.slice(0, 2),
    person_type: personType,
    is_active: isActive,
    deleted_at: null,
  };
}
