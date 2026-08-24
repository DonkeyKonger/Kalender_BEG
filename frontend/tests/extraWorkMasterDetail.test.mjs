import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles, typeSource, schemaSource, serviceSource, routeSource] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/types/site.ts", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/schemas/extra_work.py", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/services/extra_work_service.py", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/api/routes/sites.py", import.meta.url), "utf8"),
]);

const tabStart = pageSource.indexOf("function ExtraWorkTab");
const tabEnd = pageSource.indexOf("function MeasurementTab", tabStart);
const tabSource = pageSource.slice(tabStart, tabEnd);

test("desktop extra-work overview uses one lightweight master-detail workspace", () => {
  assert.match(tabSource, /project-extra-work-workspace/);
  assert.match(tabSource, /project-extra-work-master/);
  assert.match(tabSource, /ExtraWorkOverviewDetail/);
  assert.match(tabSource, /aria-selected=\{selectedTicketId === ticket\.id\}/);
  assert.match(tabSource, /onClick=\{\(\) => onSelectTicketId\(ticket\.id\)\}/);
  assert.match(tabSource, /onOpenTicket\(ticket\)/);
  assert.doesNotMatch(tabSource, /pdfjs-dist/);
  assert.doesNotMatch(tabSource, /SupplementaryOrderDetail/);
  assert.doesNotMatch(tabSource, /Hauptauftrag/);
});

test("toolbar contains only create, archive switch and global search", () => {
  assert.match(tabSource, /\+ Zusatzauftrag erstellen/);
  assert.match(tabSource, /Archiv anzeigen/);
  assert.match(tabSource, /type="search"/);
  assert.match(tabSource, /placeholder="Suche\.\.\."/);
  assert.doesNotMatch(tabSource, /Filter/);
});

test("detail action set stays reduced to open, PDF and archive or restore", () => {
  assert.match(tabSource, />Öffnen</);
  assert.match(tabSource, /"PDF"/);
  assert.match(tabSource, /"Archivieren"/);
  assert.match(tabSource, /"Wiederherstellen"/);
  assert.doesNotMatch(tabSource, />Löschen</);
  assert.doesNotMatch(tabSource, /Weitere Aktionen/);
});

test("list response exposes compact structured entry summaries without per-row loading", () => {
  assert.match(typeSource, /entry_summaries\?: ExtraWorkTicketEntrySummary\[\]/);
  assert.match(schemaSource, /class ExtraWorkTicketEntrySummaryRead/);
  assert.match(schemaSource, /worker_names: list\[str\]/);
  assert.match(schemaSource, /material_descriptions: list\[str\]/);
  assert.match(serviceSource, /include_entry_summaries/);
  assert.match(serviceSource, /sorted\(ticket\.entries or \[\], key=/);
  assert.match(routeSource, /include_entry_summaries=True/);
  assert.doesNotMatch(tabSource, /siteExtraWorkTicketDocument/);
});

test("new visual rules stay scoped and keep square Office geometry", () => {
  const overviewStyleStart = styles.indexOf(
    ".site-detail-page.is-project-file-workspace .project-extra-work-toolbar",
  );
  const overviewStyles = styles.slice(overviewStyleStart);

  assert.notEqual(overviewStyleStart, -1);
  assert.match(styles, /\.project-extra-work-workspace \{/);
  assert.match(styles, /grid-template-columns: minmax\(600px, 48%\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.project-extra-work-master-row\.is-selected::before/);
  assert.match(styles, /\.project-extra-work-overview \.secondary-action,[\s\S]*border-radius: 2px/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*\.project-extra-work-workspace/);
  assert.doesNotMatch(overviewStyles, /\nbutton\s*\{/);
});
