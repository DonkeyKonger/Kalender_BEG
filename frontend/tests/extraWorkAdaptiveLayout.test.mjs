import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

const tabStart = pageSource.indexOf("function ExtraWorkTab");
const tabEnd = pageSource.indexOf("function MeasurementTab", tabStart);
const tabSource = pageSource.slice(tabStart, tabEnd);
const detailStart = tabSource.indexOf("function ExtraWorkOverviewDetail");
const detailSource = tabSource.slice(detailStart);

test("extra-work pagination measures viewport height without triggering data reloads", () => {
  assert.match(tabSource, /calculateExtraWorkOverviewPageSize\(availableHeight\)/);
  assert.match(tabSource, /new ResizeObserver\(scheduleLayout\)/);
  assert.match(tabSource, /requestAnimationFrame\(updateLayout\)/);
  assert.match(tabSource, /cancelAnimationFrame\(frameId\)/);
  assert.match(tabSource, /window\.visualViewport\?\.addEventListener\("resize", scheduleLayout\)/);
  assert.doesNotMatch(tabSource, /loadExtraWorkTickets/);
  assert.doesNotMatch(tabSource, /api\.siteExtraWorkTickets/);
});

test("page-size changes keep the selected ticket in the rendered page", () => {
  assert.match(tabSource, /getExtraWorkOverviewPageForIndex\(selectedIndex, nextPageSize\)/);
  assert.match(tabSource, /getExtraWorkOverviewPageForIndex\(nextIndex, overviewLayout\.pageSize\)/);
  assert.match(tabSource, /ref=\{selectedTicketId === ticket\.id \? selectedRowRef : undefined\}/);
  assert.match(tabSource, /masterBody\.scrollTop -= bodyBounds\.top - rowBounds\.top/);
  assert.match(tabSource, /masterBody\.scrollTop \+= rowBounds\.bottom - bodyBounds\.bottom/);
});

test("master rows scroll independently while pagination stays outside their scroll body", () => {
  const bodyIndex = tabSource.indexOf('className="project-extra-work-master-body"');
  const paginationIndex = tabSource.indexOf('className="project-extra-work-pagination"');

  assert.ok(bodyIndex >= 0 && paginationIndex > bodyIndex);
  assert.match(styles, /\.project-extra-work-workspace \{[\s\S]*height: var\(--project-extra-work-workspace-height[\s\S]*min-height: 0;[\s\S]*overflow: hidden/);
  assert.match(styles, /\.project-extra-work-master-body \{[\s\S]*flex: 1 1 auto;[\s\S]*min-height: 0;[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.project-extra-work-pagination \{[\s\S]*position: sticky;[\s\S]*bottom: 0;[\s\S]*flex: 0 0 auto/);
});

test("desktop detail scroll is independent and resets for a newly selected ticket", () => {
  assert.match(detailSource, /detailRef\.current\.scrollTop = 0/);
  assert.match(detailSource, /\}, \[ticket\?\.id\]\)/);
  assert.match(detailSource, /ref=\{detailRef\}/);
  assert.match(styles, /\.project-extra-work-detail \{[\s\S]*height: 100%;[\s\S]*min-height: 0;[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.project-extra-work-detail-head \{[\s\S]*position: sticky;[\s\S]*z-index: 10;[\s\S]*top: 0;[\s\S]*background: #ffffff/);
});

test("stacked layouts keep a bounded master but return detail content to natural page flow", () => {
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*\.project-extra-work-workspace \{[\s\S]*height: auto;[\s\S]*overflow: visible/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*\.project-extra-work-master \{[\s\S]*height: var\(--project-extra-work-master-height/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*\.project-extra-work-detail \{[\s\S]*height: auto;[\s\S]*overflow: visible/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*\.project-extra-work-detail-head \{[\s\S]*position: static/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*\.project-extra-work-pagination \{[\s\S]*left: 0;[\s\S]*min-width: 100%/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*\.project-extra-work-pagination nav \{[\s\S]*overflow-x: auto/);
});
