import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTRA_WORK_OVERVIEW_DEFAULT_PAGE_SIZE,
  calculateExtraWorkOverviewPageSize,
  buildExtraWorkOverviewEntrySummary,
  filterExtraWorkOverviewTickets,
  formatExtraWorkOverviewTitle,
  getExtraWorkOverviewMasterHeight,
  getExtraWorkOverviewDescription,
  getExtraWorkOverviewPageForIndex,
  getExtraWorkOverviewPageWindow,
  normalizeExtraWorkOverviewSearch,
  resolveExtraWorkOverviewPeriod,
} from "../src/lib/extraWorkOverview.ts";

const site = {
  site_number: "9999",
  name: "Testbaustelle Finienweg",
  customer: "Projektkunde GmbH",
};

function ticket(overrides = {}) {
  return {
    id: 13,
    site_id: 3,
    sequence_number: 13,
    display_number: "9999.SZ13",
    title: "Hauptauftrag",
    created_by_name: "Christopher Erichsen",
    customer_name: "Müller Generalunternehmer GmbH",
    ordered_by_name: "Frau Schüßler",
    ordered_by_company: "ebm elektro-bau-montage GmbH",
    notes: null,
    work_description: "Zusätzliche Kabeltrasse im Serverraum montiert",
    executor_other_name: null,
    worker_signature_name: null,
    customer_signature_name: null,
    total_hours: 4,
    estimated_order_value: 1200,
    created_at: "2026-08-24T12:06:00Z",
    manual_execution_start: "2026-08-24",
    manual_execution_end: "2026-08-30",
    manual_execution_week: 35,
    manual_execution_week_year: 2026,
    entry_summaries: [{
      id: 1,
      component: "Halle A",
      floor: "1. OG",
      room_number: "Serverraum Süd",
      axis: "A-1",
      remarks: "Brandschott nach Montage dokumentiert",
      material_text: "Kabelrinne und Befestiger",
      material_descriptions: ["Kabelrinne 60 mm"],
      worker_names: ["Marcin Cholewka"],
      estimated_hours: 8,
    }],
    ...overrides,
  };
}

test("overview title deliberately omits the internal Hauptauftrag suffix", () => {
  assert.equal(formatExtraWorkOverviewTitle(ticket()), "Zusatzauftrag 9999.SZ13");
  assert.equal(EXTRA_WORK_OVERVIEW_DEFAULT_PAGE_SIZE, 8);
});

test("overview page size follows available height between four and ten real rows", () => {
  assert.equal(calculateExtraWorkOverviewPageSize(280), 4);
  assert.equal(calculateExtraWorkOverviewPageSize(356), 4);
  assert.equal(calculateExtraWorkOverviewPageSize(620), 8);
  assert.equal(calculateExtraWorkOverviewPageSize(752), 10);
  assert.equal(calculateExtraWorkOverviewPageSize(1200), 10);
  assert.equal(getExtraWorkOverviewMasterHeight(4), 356);
  assert.equal(getExtraWorkOverviewMasterHeight(10), 752);
});

test("overview pages stay stable for full and partially filled final pages", () => {
  assert.deepEqual(getExtraWorkOverviewPageWindow(21, 1, 10), {
    start: 0,
    end: 10,
    page: 1,
    pageCount: 3,
  });
  assert.deepEqual(getExtraWorkOverviewPageWindow(21, 3, 10), {
    start: 20,
    end: 21,
    page: 3,
    pageCount: 3,
  });
  assert.deepEqual(getExtraWorkOverviewPageWindow(3, 8, 4), {
    start: 0,
    end: 3,
    page: 1,
    pageCount: 1,
  });
});

test("resizing keeps the selected row on the page for the new page size", () => {
  assert.equal(getExtraWorkOverviewPageForIndex(17, 10), 2);
  assert.equal(getExtraWorkOverviewPageForIndex(17, 8), 3);
  assert.equal(getExtraWorkOverviewPageForIndex(17, 4), 5);
  assert.equal(getExtraWorkOverviewPageForIndex(-1, 8), 1);
});

test("local overview search covers structured ticket and entry contents", () => {
  const tickets = [ticket()];
  for (const query of [
    "SZ13",
    "erichsen",
    "muller general",
    "schuessler",
    "server",
    "KABEL",
    "brandschott",
    "cholewka",
    "9999",
  ]) {
    assert.equal(filterExtraWorkOverviewTickets(tickets, site, query).length, 1, query);
  }
  assert.equal(filterExtraWorkOverviewTickets(tickets, site, "kein treffer").length, 0);
  assert.equal(filterExtraWorkOverviewTickets(tickets, site, "   ").length, 1);
});

test("local overview search finds both legacy and current extra-work numbers", () => {
  const tickets = [
    ticket(),
    ticket({ id: 14, sequence_number: 14, display_number: "9999.Z14" }),
  ];

  assert.deepEqual(
    filterExtraWorkOverviewTickets(tickets, site, "SZ13").map((item) => item.id),
    [13],
  );
  assert.deepEqual(
    filterExtraWorkOverviewTickets(tickets, site, "Z14").map((item) => item.id),
    [14],
  );
});

test("German search normalization is case-insensitive and umlaut tolerant", () => {
  assert.equal(normalizeExtraWorkOverviewSearch("  MÜLLER  Straße "), "muller strasse");
});

test("description and execution period reuse the existing structured fields", () => {
  assert.equal(
    getExtraWorkOverviewDescription(ticket()),
    "Zusätzliche Kabeltrasse im Serverraum montiert",
  );
  assert.deepEqual(resolveExtraWorkOverviewPeriod(ticket()), {
    start: "2026-08-24",
    end: "2026-08-30",
  });
  assert.deepEqual(resolveExtraWorkOverviewPeriod(ticket({
    manual_execution_start: null,
    manual_execution_end: null,
    manual_execution_week: 1,
    manual_execution_week_year: 2027,
  })), {
    start: "2027-01-04",
    end: "2027-01-10",
  });
});

test("a saved document entry refreshes the compact overview data without another request", () => {
  assert.deepEqual(buildExtraWorkOverviewEntrySummary({
    id: 7,
    component: "Bauteil B",
    floor: "2. OG",
    room_number: "2.14",
    axis: "B-4",
    remarks: "Neue Beschreibung",
    material_text: "Altmaterial ausgebaut",
    material_items: [
      { quantity: 3, unit: "m", description: " Kabelrinne " },
      { quantity: 1, unit: "Stk", description: "" },
    ],
    estimated_hours: 6,
    worker_rows: [
      { worker_name: " Christopher Monteur " },
      { worker_name: "" },
    ],
  }), {
    id: 7,
    component: "Bauteil B",
    floor: "2. OG",
    room_number: "2.14",
    axis: "B-4",
    remarks: "Neue Beschreibung",
    material_text: "Altmaterial ausgebaut",
    material_descriptions: ["Kabelrinne"],
    worker_names: ["Christopher Monteur"],
    estimated_hours: 6,
  });
});
