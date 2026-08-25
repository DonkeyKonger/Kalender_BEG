import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { setExtraWorkTicketInvoicedValue } from "../src/lib/extraWorkInvoiced.ts";
import { filterExtraWorkOverviewTickets } from "../src/lib/extraWorkOverview.ts";

const [pageSource, styles, apiSource, typeSource, overviewSource, schemaSource, serviceSource, routeSource] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/types/site.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/extraWorkOverview.ts", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/schemas/extra_work.py", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/services/extra_work_service.py", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/api/routes/sites.py", import.meta.url), "utf8"),
]);

const tabStart = pageSource.indexOf("function ExtraWorkTab");
const tabEnd = pageSource.indexOf("function MeasurementTab", tabStart);
const tabSource = pageSource.slice(tabStart, tabEnd);

test("the invoiced value update preserves ticket order and unrelated fields", () => {
  const tickets = [
    { id: 9, status: "draft", is_invoiced: false },
    { id: 3, status: "signed", is_invoiced: false },
  ];

  const updated = setExtraWorkTicketInvoicedValue(tickets, 3, true);

  assert.deepEqual(updated.map((ticket) => ticket.id), [9, 3]);
  assert.equal(updated[0], tickets[0]);
  assert.deepEqual(updated[1], { id: 3, status: "signed", is_invoiced: true });
});

test("search results retain the invoiced value from the list response", () => {
  const ticket = {
    id: 4,
    display_number: "8007.Z04",
    sequence_number: 4,
    title: "Brandschott",
    is_invoiced: true,
  };
  const site = { site_number: "8007", name: "Klinik", customer: "BEG" };

  const filtered = filterExtraWorkOverviewTickets([ticket], site, "Brandschott");

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].is_invoiced, true);
});

test("Abgerechnet is the compact third master column with an isolated checkbox interaction", () => {
  const headerStart = tabSource.indexOf('className="project-extra-work-master-head"');
  const headerEnd = tabSource.indexOf("</div>", headerStart);
  const headerSource = tabSource.slice(headerStart, headerEnd);
  const labels = [...headerSource.matchAll(/<span role="columnheader">([^<]+)<\/span>/g)]
    .map((match) => match[1]);
  const cellStart = tabSource.indexOf('className="project-extra-work-master-invoiced"');
  const cellEnd = tabSource.indexOf("</div>", cellStart);
  const cellSource = tabSource.slice(cellStart, cellEnd);

  assert.deepEqual(labels, [
    "Status",
    "Titel / Nummer",
    "Abgerechnet",
    "Erstellt am",
    "Ersteller",
    "Stunden",
  ]);
  assert.match(cellSource, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(cellSource, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(cellSource, /type="checkbox"/);
  assert.match(cellSource, /checked=\{ticket\.is_invoiced\}/);
  assert.match(cellSource, /onChange=\{\(\) => onToggleInvoiced\(ticket\)\}/);
  assert.match(cellSource, /aria-label=\{`\$\{formatExtraWorkOverviewTitle\(ticket\)\}/);
});

test("the checked marker is red, keyboard-focused and remains a compact touch target", () => {
  assert.match(styles, /\.project-extra-work-invoiced-control \{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*cursor:\s*pointer/s);
  assert.match(styles, /\.project-extra-work-invoiced-box \{[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*color:\s*#dc2626/s);
  assert.match(styles, /input:checked \+ \.project-extra-work-invoiced-box \{[^}]*border-color:\s*#dc2626;[^}]*background:\s*#fff7f7/s);
  assert.match(styles, /input:focus-visible \+ \.project-extra-work-invoiced-box \{[^}]*outline:\s*2px solid #3b82f6/s);
});

test("the optimistic toggle rolls back only the marker and reports save failures", () => {
  const handlerStart = pageSource.indexOf("async function toggleExtraWorkTicketInvoiced");
  const handlerEnd = pageSource.indexOf("async function updateMeasurementBase", handlerStart);
  const handlerSource = pageSource.slice(handlerStart, handlerEnd);

  assert.match(handlerSource, /const previousValue = ticket\.is_invoiced/);
  assert.match(handlerSource, /const nextValue = !previousValue/);
  assert.match(handlerSource, /setExtraWorkTicketInvoicedValue\(current, ticket\.id, nextValue\)/);
  assert.match(handlerSource, /api\.updateSiteExtraWorkTicketInvoiced/);
  assert.match(handlerSource, /catch \(requestError\)[\s\S]*setExtraWorkTicketInvoicedValue\(current, ticket\.id, previousValue\)/);
  assert.match(handlerSource, /setExtraWorkInvoicedError\(readApiError/);
  assert.match(tabSource, /project-extra-work-invoiced-error" role="alert"/);
});

test("API and read models expose one independent persistent invoiced field", () => {
  assert.match(typeSource, /status:[^\n]+\n\s+is_invoiced: boolean;/);
  assert.match(schemaSource, /class ExtraWorkTicketInvoicedUpdate\(BaseModel\):\n\s+is_invoiced: bool/);
  assert.match(schemaSource, /class ExtraWorkTicketRead\(BaseModel\):[\s\S]*is_invoiced: bool = False/);
  assert.match(apiSource, /updateSiteExtraWorkTicketInvoiced[\s\S]*\/invoiced`[\s\S]*method: "PATCH"[\s\S]*is_invoiced: isInvoiced/);
  assert.match(routeSource, /extra-work-tickets\/\{ticket_id\}\/invoiced[\s\S]*Depends\(CAN_SITES_WRITE\)/);
  assert.match(serviceSource, /def set_site_ticket_invoiced[\s\S]*include_deleted=True[\s\S]*ticket\.is_invoiced = is_invoiced/);
});

test("active and archived lists keep stable newest-first order instead of updated-at resorting", () => {
  assert.match(serviceSource, /if archived_only:[\s\S]*statement\.order_by\([\s\S]*ExtraWorkTicket\.sequence_number\.desc\(\)\.nulls_last\(\),[\s\S]*ExtraWorkTicket\.created_at\.desc\(\),[\s\S]*ExtraWorkTicket\.id\.desc\(\)/);
  assert.match(tabSource, /\[\.\.\.tickets\]\.sort\(compareExtraWorkTicketsNewestFirst\)/);
  assert.match(overviewSource, /function compareExtraWorkTicketsNewestFirst/);
  const comparatorSource = overviewSource.slice(
    overviewSource.indexOf("export function compareExtraWorkTicketsNewestFirst"),
    overviewSource.indexOf("export function calculateExtraWorkOverviewPageSize"),
  );
  assert.doesNotMatch(comparatorSource, /updated_at|submitted_at|customer_signed_at/);
});

test("the moderate desktop split keeps the six-column master readable and stacks responsively", () => {
  assert.match(styles, /--project-extra-work-master-column: minmax\(680px, 52%\)/);
  assert.match(styles, /grid-template-columns: 148px minmax\(152px, 1fr\) 104px 88px 104px 68px/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*grid-template-columns: 140px minmax\(136px, 1fr\) 100px 88px 104px 68px/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*--project-extra-work-master-column: minmax\(0, 1fr\)/);
  assert.match(styles, /\.project-extra-work-master \{[\s\S]*overflow-x: auto/);
});
