import assert from "node:assert/strict";
import test from "node:test";

import { filterPickerOptions } from "../src/lib/pickerSearch.ts";
import { buildToolMaterialEmployeeOptions } from "../src/lib/toolMaterialEmployees.ts";
import {
  buildToolMaterialSearchParams,
  clearAllToolMaterialFilters,
  clearToolMaterialColumnFilter,
  hasToolMaterialFilters,
  toolMaterialColumnKeys,
  toolMaterialColumns,
} from "../src/lib/toolMaterialFilters.ts";
import {
  getOptimisticToolMaterialStatusItem,
  getSuggestedToolMaterialStatus,
  getToolMaterialStatusChange,
  getToolMaterialStatusPresentation,
  getToolMaterialStatusUpdate,
  saveToolMaterialStatus,
  toolMaterialStatusOptions,
} from "../src/lib/toolMaterialStatus.ts";


test("individual and all tool material filters can be reset", () => {
  const filters = {
    manufacturer: { query: "Bosch" },
    status: { values: ["issued"] },
  };

  const withoutManufacturer = clearToolMaterialColumnFilter(filters, "manufacturer");

  assert.equal(hasToolMaterialFilters(filters), true);
  assert.equal(withoutManufacturer.manufacturer, undefined);
  assert.deepEqual(withoutManufacturer.status, filters.status);
  assert.deepEqual(clearAllToolMaterialFilters(), {});
  assert.equal(hasToolMaterialFilters(clearAllToolMaterialFilters()), false);
});


test("global search, combined column filters and sorting share one API query", () => {
  const params = buildToolMaterialSearchParams({
    search: "Bohrmaschine",
    filters: {
      manufacturer: { query: "Bosch", values: ["Bosch", "Makita"] },
      item_date: { dateFrom: "2026-01-01", dateTo: "2026-12-31" },
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
  assert.deepEqual(params.getAll("values_status"), ["issued", "defective"]);
  assert.equal(params.get("sort_by"), "beg_number");
  assert.equal(params.get("sort_direction"), "desc");
});


test("tool material table has the required columns without stock", () => {
  assert.deepEqual(toolMaterialColumnKeys, [
    "beg_number",
    "manufacturer",
    "designation",
    "item_type",
    "device_number",
    "serial_number",
    "employee",
    "item_date",
    "delivery_note",
    "remarks",
    "supplier",
    "invoice_number",
    "status",
  ]);
  assert.deepEqual(toolMaterialColumns.map((column) => column.label), [
    "BEG-Nr.",
    "Fabrikat",
    "Bezeichnung",
    "Typ",
    "Gerätenummer",
    "Seriennummer",
    "Mitarbeiter",
    "Datum",
    "Lieferschein",
    "Bemerkungen",
    "Lieferant",
    "RG-Nr.",
    "Status",
  ]);
});


test("employee assignment always suggests issued and removal returns issued items to warehouse", () => {
  assert.equal(getSuggestedToolMaterialStatus("warehouse", "7"), "issued");
  assert.equal(getSuggestedToolMaterialStatus("defective", "7"), "issued");
  assert.equal(getSuggestedToolMaterialStatus("issued", ""), "warehouse");
  assert.equal(getSuggestedToolMaterialStatus("defective", ""), "defective");
});


test("warehouse and defective status changes clear the employee immediately", () => {
  assert.deepEqual(getToolMaterialStatusChange("issued"), { status: "issued" });
  assert.deepEqual(getToolMaterialStatusChange("warehouse"), {
    status: "warehouse",
    employee_id: "",
  });
  assert.deepEqual(getToolMaterialStatusChange("defective"), {
    status: "defective",
    employee_id: "",
  });
});


test("inline status updates clear assignments optimistically and in the API payload", () => {
  const item = toolMaterialItem();

  assert.deepEqual(getToolMaterialStatusUpdate("warehouse"), {
    status: "warehouse",
    employee_id: null,
  });
  assert.deepEqual(getToolMaterialStatusUpdate("defective"), {
    status: "defective",
    employee_id: null,
  });
  assert.deepEqual(getToolMaterialStatusUpdate("issued"), { status: "issued" });
  assert.deepEqual(
    getOptimisticToolMaterialStatusItem(item, "defective"),
    { ...item, status: "defective", employee_id: null, employee: null },
  );
});


test("inline status save returns the server item on success", async () => {
  const item = toolMaterialItem();
  const calls = [];
  const result = await saveToolMaterialStatus(item, "warehouse", async (itemId, payload) => {
    calls.push([itemId, payload]);
    return { ...item, ...payload, employee: null };
  });

  assert.deepEqual(calls, [[7, { status: "warehouse", employee_id: null }]]);
  assert.equal(result.ok, true);
  assert.equal(result.item.status, "warehouse");
  assert.equal(result.item.employee_id, null);
});


test("inline status save preserves the previous item on failure", async () => {
  const item = toolMaterialItem();
  const saveError = new Error("Netzwerkfehler");
  const result = await saveToolMaterialStatus(item, "defective", async () => {
    throw saveError;
  });

  assert.equal(result.ok, false);
  assert.equal(result.item, item);
  assert.equal(result.error, saveError);
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

function toolMaterialItem() {
  return {
    id: 7,
    beg_number: "BEG-7",
    manufacturer: "Bosch",
    designation: "Bohrmaschine",
    item_type: null,
    device_number: null,
    serial_number: null,
    employee_id: 3,
    employee: {
      id: 3,
      display_name: "Max Mustermann",
      short_code: "MM",
      person_type: "internal",
      is_active: true,
    },
    item_date: "2026-07-15",
    delivery_note: null,
    remarks: null,
    supplier: null,
    invoice_number: null,
    stock: 1,
    status: "issued",
    created_at: "2026-07-15T08:00:00Z",
    updated_at: "2026-07-15T08:00:00Z",
  };
}
