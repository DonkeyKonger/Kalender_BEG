import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTRA_WORK_OVERVIEW_DEFAULT_PAGE_SIZE,
  calculateExtraWorkOverviewPageSize,
  buildExtraWorkOverviewEntrySummary,
  compareExtraWorkTicketsOldestFirst,
  filterExtraWorkOverviewTickets,
  formatExtraWorkOverviewCreatorName,
  formatExtraWorkOverviewIsoWeek,
  formatExtraWorkOverviewTitle,
  getExtraWorkOverviewMasterHeight,
  getExtraWorkOverviewDescription,
  getExtraWorkOverviewPageForIndex,
  getExtraWorkOverviewPageItems,
  getExtraWorkOverviewPageWindow,
  getExtraWorkOverviewScrollbarWidth,
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

test("overview order stays oldest first across status changes and pagination", () => {
  const tickets = [
    ticket({
      id: 15,
      sequence_number: 15,
      display_number: "9999.SZ15",
      created_at: "2026-08-24T08:05:00Z",
      updated_at: "2026-08-25T14:10:00Z",
      submitted_at: "2026-08-25T14:00:00Z",
      status: "completed",
    }),
    ticket({ id: 19, sequence_number: 19, display_number: "9999.Z19", created_at: "2026-08-24T08:20:00Z" }),
    ticket({ id: 18, sequence_number: 18, display_number: "9999.Z18", created_at: "2026-08-24T08:15:00Z" }),
    ticket({ id: 17, sequence_number: 17, display_number: "9999.Z17", created_at: "2026-08-24T08:10:00Z" }),
    ticket({ id: 16, sequence_number: 16, display_number: "9999.SZ16", created_at: "2026-08-24T08:05:00Z" }),
    ticket({ id: 14, sequence_number: 14, display_number: "9999.SZ14", created_at: "2026-08-24T08:00:00Z" }),
    ...Array.from({ length: 7 }, (_, index) => ticket({
      id: 20 + index,
      sequence_number: 20 + index,
      display_number: `9999.Z${20 + index}`,
      created_at: `2026-08-24T08:${25 + index * 5}:00Z`,
    })),
  ];
  const expectedNumbers = [
    "9999.SZ14",
    "9999.SZ15",
    "9999.SZ16",
    "9999.Z17",
    "9999.Z18",
    "9999.Z19",
    "9999.Z20",
    "9999.Z21",
    "9999.Z22",
    "9999.Z23",
    "9999.Z24",
    "9999.Z25",
    "9999.Z26",
  ];
  const sorted = [...tickets].sort(compareExtraWorkTicketsOldestFirst);
  const firstPage = getExtraWorkOverviewPageWindow(sorted.length, 1, 6);
  const secondPage = getExtraWorkOverviewPageWindow(sorted.length, 2, 6);
  const thirdPage = getExtraWorkOverviewPageWindow(sorted.length, 3, 6);

  assert.deepEqual(sorted.map((item) => item.display_number), expectedNumbers);
  assert.deepEqual(
    sorted.slice(firstPage.start, firstPage.end).map((item) => item.display_number),
    expectedNumbers.slice(0, 6),
  );
  assert.deepEqual(
    sorted.slice(secondPage.start, secondPage.end).map((item) => item.display_number),
    expectedNumbers.slice(6, 12),
  );
  assert.deepEqual(
    sorted.slice(thirdPage.start, thirdPage.end).map((item) => item.display_number),
    expectedNumbers.slice(12),
  );

  const selectedTicketId = 15;
  const updatedTickets = tickets.map((item) => item.id === selectedTicketId
    ? {
        ...item,
        status: "completed",
        total_hours: 27,
        notes: "Status und Inhalt geändert",
        customer_signed_at: "2026-08-26T12:00:00Z",
        updated_at: "2026-08-26T12:05:00Z",
      }
    : item);
  const sortedAfterUpdate = [...updatedTickets].sort(compareExtraWorkTicketsOldestFirst);

  assert.deepEqual(sortedAfterUpdate.map((item) => item.display_number), expectedNumbers);
  assert.equal(
    sortedAfterUpdate.findIndex((item) => item.id === selectedTicketId),
    sorted.findIndex((item) => item.id === selectedTicketId),
  );
});

test("overview order uses sequence and id as deterministic creation-time tie breakers", () => {
  const commonCreatedAt = "2026-08-24T08:05:00Z";
  const tiedTickets = [
    ticket({ id: 170, sequence_number: 17, display_number: "9999.Z17", created_at: commonCreatedAt }),
    ticket({ id: 151, sequence_number: 15, display_number: "9999.SZ15", created_at: commonCreatedAt }),
    ticket({ id: 150, sequence_number: 15, display_number: "9999.SZ15", created_at: commonCreatedAt }),
    ticket({ id: 160, sequence_number: 16, display_number: "9999.SZ16", created_at: commonCreatedAt }),
  ];

  assert.deepEqual(
    [...tiedTickets].sort(compareExtraWorkTicketsOldestFirst).map((item) => item.id),
    [150, 151, 160, 170],
  );
});

test("search and archived ticket data preserve the shared chronological order", () => {
  const archivedTickets = [
    ticket({
      id: 17,
      sequence_number: 17,
      display_number: "9999.Z17",
      title: "Treffer später",
      created_at: "2026-08-24T09:00:00Z",
      deleted_at: "2026-08-25T08:00:00Z",
    }),
    ticket({
      id: 15,
      sequence_number: 15,
      display_number: "9999.SZ15",
      title: "Treffer früher",
      created_at: "2026-08-24T08:00:00Z",
      deleted_at: "2026-08-26T08:00:00Z",
    }),
    ticket({
      id: 16,
      sequence_number: 16,
      display_number: "9999.SZ16",
      title: "Nicht gesucht",
      created_at: "2026-08-24T08:30:00Z",
      deleted_at: "2026-08-24T12:00:00Z",
    }),
  ];
  const sortedArchive = [...archivedTickets].sort(compareExtraWorkTicketsOldestFirst);
  const searchResult = filterExtraWorkOverviewTickets(sortedArchive, site, "Treffer");

  assert.deepEqual(sortedArchive.map((item) => item.id), [15, 16, 17]);
  assert.deepEqual(searchResult.map((item) => item.id), [15, 17]);
});

test("resizing keeps the selected row on the page for the new page size", () => {
  assert.equal(getExtraWorkOverviewPageForIndex(17, 10), 2);
  assert.equal(getExtraWorkOverviewPageForIndex(17, 8), 3);
  assert.equal(getExtraWorkOverviewPageForIndex(17, 4), 5);
  assert.equal(getExtraWorkOverviewPageForIndex(-1, 8), 1);
});

test("overview creator names use one initial while preserving the full accessible name", () => {
  assert.deepEqual(formatExtraWorkOverviewCreatorName("Christopher Eriksen"), {
    accessibleName: "Christopher Eriksen",
    fullName: "Christopher Eriksen",
    shortName: "C. Eriksen",
  });
  assert.equal(formatExtraWorkOverviewCreatorName("Marcin Cholewka").shortName, "M. Cholewka");
  assert.equal(formatExtraWorkOverviewCreatorName("Detlef von Salzen").shortName, "D. von Salzen");
  assert.equal(formatExtraWorkOverviewCreatorName("Alexandru-Stefan Ardelean").shortName, "A. Ardelean");
  assert.deepEqual(formatExtraWorkOverviewCreatorName("  Cher   "), {
    accessibleName: "Cher",
    fullName: "Cher",
    shortName: "Cher",
  });
  assert.deepEqual(formatExtraWorkOverviewCreatorName("  Anna   Maria   von   Beispiel  "), {
    accessibleName: "Anna Maria von Beispiel",
    fullName: "Anna Maria von Beispiel",
    shortName: "A. Maria von Beispiel",
  });
  assert.deepEqual(formatExtraWorkOverviewCreatorName("   "), {
    accessibleName: "Ersteller nicht angegeben",
    fullName: "",
    shortName: "–",
  });
});

test("master scrollbar width is reserved only for real overflow", () => {
  assert.equal(getExtraWorkOverviewScrollbarWidth({
    clientHeight: 264,
    scrollHeight: 264,
    clientWidth: 548,
    offsetWidth: 563,
  }), 0);
  assert.equal(getExtraWorkOverviewScrollbarWidth({
    clientHeight: 264,
    scrollHeight: 265,
    clientWidth: 548,
    offsetWidth: 563,
  }), 0);
  assert.equal(getExtraWorkOverviewScrollbarWidth({
    clientHeight: 264,
    scrollHeight: 396,
    clientWidth: 548,
    offsetWidth: 563,
  }), 15);
  assert.equal(getExtraWorkOverviewScrollbarWidth({
    clientHeight: 264,
    scrollHeight: 396,
    clientWidth: 563,
    offsetWidth: 563,
  }), 0);
});

test("compact pagination keeps edge pages and a small current-page window", () => {
  assert.deepEqual(getExtraWorkOverviewPageItems(7, 4), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(getExtraWorkOverviewPageItems(20, 1), [1, 2, 3, 4, 5, "ellipsis-right", 20]);
  assert.deepEqual(getExtraWorkOverviewPageItems(20, 10), [1, "ellipsis-left", 9, 10, 11, "ellipsis-right", 20]);
  assert.deepEqual(getExtraWorkOverviewPageItems(20, 20), [1, "ellipsis-left", 16, 17, 18, 19, 20]);
  assert.deepEqual(getExtraWorkOverviewPageItems(20, 99), [1, "ellipsis-left", 16, 17, 18, 19, 20]);
});

test("local overview search covers structured ticket and entry contents", () => {
  const tickets = [ticket()];
  for (const query of [
    "SZ13",
    "erichsen",
    "christopher erichsen",
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

test("detail period formatting shows the effective ISO calendar week only", () => {
  assert.equal(formatExtraWorkOverviewIsoWeek(ticket()), "KW 35");
  assert.equal(formatExtraWorkOverviewIsoWeek(ticket({
    manual_execution_start: null,
    manual_execution_end: null,
    manual_execution_week: 1,
    manual_execution_week_year: 2027,
  })), "KW 1");
  assert.equal(formatExtraWorkOverviewIsoWeek(ticket({
    manual_execution_start: "2020-12-28",
    manual_execution_end: "2021-01-03",
    manual_execution_week: null,
    manual_execution_week_year: null,
  })), "KW 53");
  assert.equal(formatExtraWorkOverviewIsoWeek(ticket({
    manual_execution_start: "2021-01-01",
    manual_execution_end: "2021-01-03",
    manual_execution_week: null,
    manual_execution_week_year: null,
  })), "KW 53");
  assert.equal(formatExtraWorkOverviewIsoWeek(ticket({
    created_at: "ungültig",
    manual_execution_start: null,
    manual_execution_end: null,
    manual_execution_week: null,
    manual_execution_week_year: null,
  })), "–");
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
