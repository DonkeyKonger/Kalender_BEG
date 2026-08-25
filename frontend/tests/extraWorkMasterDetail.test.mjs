import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles, typeSource, schemaSource, serviceSource, routeSource, documentSource] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/types/site.ts", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/schemas/extra_work.py", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/services/extra_work_service.py", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/api/routes/sites.py", import.meta.url), "utf8"),
  readFile(new URL("../src/components/SupplementaryOrderDetail.tsx", import.meta.url), "utf8"),
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

test("newest-first ticket order is applied before shared search and pagination paths", () => {
  const sortIndex = tabSource.indexOf("sort(compareExtraWorkTicketsNewestFirst)");
  const filterIndex = tabSource.indexOf("filterExtraWorkOverviewTickets(sortedTickets");
  const paginationIndex = tabSource.indexOf("filteredTickets.slice(pageWindow.start, pageWindow.end)");

  assert.ok(sortIndex >= 0 && sortIndex < filterIndex && filterIndex < paginationIndex);
  assert.match(pageSource, /createSiteExtraWorkTicket[\s\S]*sort\(compareExtraWorkTicketsNewestFirst\)/);
  assert.doesNotMatch(pageSource, /compareExtraWorkTicketsOldestFirst/);
  assert.match(
    serviceSource,
    /order_by\([\s\S]*ExtraWorkTicket\.sequence_number\.desc\(\)\.nulls_last\(\)[\s\S]*ExtraWorkTicket\.created_at\.desc\(\)[\s\S]*ExtraWorkTicket\.id\.desc\(\)/,
  );
});

test("master rows keep their status control while the detail removes its duplicate status row", () => {
  const masterRowsStart = tabSource.indexOf("visibleTickets.map");
  const masterRowsEnd = tabSource.indexOf("<ExtraWorkOverviewDetail", masterRowsStart);
  const masterRowsSource = tabSource.slice(masterRowsStart, masterRowsEnd);
  const detailStart = tabSource.indexOf("function ExtraWorkOverviewDetail");
  const detailSource = tabSource.slice(detailStart);

  assert.notEqual(masterRowsStart, -1);
  assert.ok(masterRowsEnd > masterRowsStart);
  assert.doesNotMatch(masterRowsSource, /getCustomerEmailStatus\(ticket\)/);
  assert.match(masterRowsSource, /ProjectRecordStatusControl/);
  assert.match(masterRowsSource, /onPromoteStatus\(ticket, status\)/);
  assert.doesNotMatch(detailSource, /project-extra-work-detail-statuses/);
  assert.doesNotMatch(detailSource, /ProjectRecordStatusControl/);
  assert.doesNotMatch(detailSource, /<span>Status<\/span>/);
});

test("detail moves delivery state into the fourth customer-project field as an accessible icon", () => {
  const detailStart = tabSource.indexOf("function ExtraWorkOverviewDetail");
  const customerProjectStart = tabSource.indexOf("<h4>Kunde &amp; Projekt</h4>", detailStart);
  const customerProjectEnd = tabSource.indexOf("</dl>", customerProjectStart);
  const customerProjectSource = tabSource.slice(customerProjectStart, customerProjectEnd);
  const labels = [...customerProjectSource.matchAll(/<dt>([^<]+)<\/dt>/g)].map((match) => match[1]);

  assert.deepEqual(labels, ["Kunde", "Projekt", "Kom.-Nr.", "Versandstatus"]);
  assert.match(customerProjectSource, /emailStatus\.isSent \? <MailCheck/);
  assert.match(customerProjectSource, /: <MailX/);
  assert.match(customerProjectSource, /role="img"/);
  assert.match(customerProjectSource, /tabIndex=\{0\}/);
  assert.match(customerProjectSource, /aria-label=\{emailStatus\.accessibleLabel\}/);
  assert.match(customerProjectSource, /aria-describedby=\{emailStatusTooltipId\}/);
  assert.match(customerProjectSource, /role="tooltip"/);
  assert.equal(customerProjectSource.includes("{emailStatus.label}"), false);
});

test("master rows show only the creation date while the detail keeps date and time", () => {
  const masterRowsStart = tabSource.indexOf("visibleTickets.map");
  const masterRowsEnd = tabSource.indexOf("<ExtraWorkOverviewDetail", masterRowsStart);
  const masterRowsSource = tabSource.slice(masterRowsStart, masterRowsEnd);

  assert.match(masterRowsSource, /const createdDate = formatExtraWorkOverviewCreatedDate\(ticket\.created_at\)/);
  assert.match(masterRowsSource, /<time role="gridcell" dateTime=\{ticket\.created_at\}>\{createdDate\}<\/time>/);
  assert.doesNotMatch(masterRowsSource, /created\.time/);
  assert.match(tabSource.slice(masterRowsEnd), /<dt>Erstelldatum<\/dt><dd>\{formatDateTime\(ticket\.created_at\)\}<\/dd>/);
});

test("detail shows the effective ISO week without changing its period field position", () => {
  const detailStart = tabSource.indexOf("function ExtraWorkOverviewDetail");
  const detailSource = tabSource.slice(detailStart);
  assert.match(detailSource, /<div><dt>Zeitraum<\/dt><dd>\{formatExtraWorkOverviewIsoWeek\(ticket\)\}<\/dd><\/div>/);
  assert.doesNotMatch(detailSource, /formatExtraWorkOverviewPeriod/);
  assert.doesNotMatch(detailSource, /formatDateOnly\(period\.start\)/);
});

test("master creator names stay abbreviated and fully accessible", () => {
  assert.match(tabSource, /formatExtraWorkOverviewCreatorName\(ticket\.created_by_name\)/);
  assert.match(tabSource, /className="project-extra-work-master-creator"[\s\S]*aria-label=\{creatorName\.accessibleName\}[\s\S]*title=\{creatorName\.fullName \|\| undefined\}[\s\S]*creatorName\.shortName/);
  assert.match(styles, /\.project-extra-work-master-row > \.project-extra-work-master-creator \{[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap/);
});

test("toolbar contains only create, archive switch and global search", () => {
  const toolbarStart = tabSource.indexOf('<header className="project-record-toolbar project-extra-work-toolbar');
  const toolbarEnd = tabSource.indexOf("</header>", toolbarStart);
  const toolbarSource = tabSource.slice(toolbarStart, toolbarEnd);
  const searchIndex = toolbarSource.indexOf('className="project-extra-work-search"');
  const archiveIndex = toolbarSource.indexOf("onClick={onToggleArchive}");
  const createIndex = toolbarSource.indexOf("onClick={onCreate}");

  assert.match(tabSource, /\+ Zusatzauftrag erstellen/);
  assert.match(tabSource, /Archiv anzeigen/);
  assert.match(tabSource, /type="search"/);
  assert.match(tabSource, /placeholder="Suche\.\.\."/);
  assert.doesNotMatch(toolbarSource, /<p>/);
  assert.doesNotMatch(toolbarSource, /Mobile Stundenzettel und Zusatzaufträge/);
  assert.ok(searchIndex >= 0 && searchIndex < archiveIndex && archiveIndex < createIndex);
  assert.match(toolbarSource, /className="secondary-action"[\s\S]*onClick=\{onToggleArchive\}/);
  assert.match(toolbarSource, /className="primary-action project-extra-work-primary-action"[\s\S]*onClick=\{onCreate\}/);
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

test("only the two primary overview actions use the active sidebar blue variant", () => {
  const genericWorkspacePrimaryIndex = styles.indexOf(
    ".site-detail-page.is-project-file-workspace .primary-action {",
  );
  const extraWorkPrimaryIndex = styles.indexOf(
    ".site-detail-page.is-project-file-workspace .project-extra-work-primary-action {",
  );

  assert.equal(tabSource.match(/project-extra-work-primary-action/g)?.length, 2);
  assert.match(
    tabSource,
    /className="primary-action project-extra-work-primary-action"[\s\S]*onClick=\{onCreate\}/,
  );
  assert.match(
    tabSource,
    /className="primary-action project-extra-work-primary-action"[\s\S]*onClick=\{\(\) => onOpenTicket\(ticket\)\}>Öffnen/,
  );
  assert.doesNotMatch(
    tabSource,
    /className="secondary-action project-extra-work-primary-action"/,
  );
  assert.ok(extraWorkPrimaryIndex > genericWorkspacePrimaryIndex);
  assert.match(
    styles,
    /:root \{[\s\S]*--sidebar-active-blue-rgb: 42 116 191;/,
  );
  assert.match(
    styles,
    /\.nav-list a\.active,[\s\S]*\.nav-list a:hover \{[\s\S]*background: rgb\(var\(--sidebar-active-blue-rgb\) \/ 42%\);/,
  );
  assert.match(
    styles,
    /\.project-extra-work-primary-action \{[\s\S]*border-color: rgb\(var\(--sidebar-active-blue-rgb\)\);[\s\S]*background: rgb\(var\(--sidebar-active-blue-rgb\)\);[\s\S]*color: #ffffff;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-primary-action:hover:not\(:disabled\) \{[\s\S]*border-color: #1b6fbb;[\s\S]*background: #1b6fbb;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-primary-action:active:not\(:disabled\) \{[\s\S]*border-color: #0b4b8f;[\s\S]*background: #0b4b8f;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-primary-action:focus-visible \{[\s\S]*border-color: rgb\(var\(--sidebar-active-blue-rgb\)\);[\s\S]*background: rgb\(var\(--sidebar-active-blue-rgb\)\);[\s\S]*outline: 2px solid #041d38;[\s\S]*outline-offset: 2px;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-primary-action:disabled \{[\s\S]*border-color: rgb\(var\(--sidebar-active-blue-rgb\)\);[\s\S]*background: rgb\(var\(--sidebar-active-blue-rgb\)\);[\s\S]*cursor: not-allowed;[\s\S]*opacity: 0\.58;/,
  );
});

test("additional information shows only the four location fields without removing form data", () => {
  const headingStart = tabSource.indexOf("<h4>Weitere Informationen</h4>");
  const listEnd = tabSource.indexOf("</dl>", headingStart);
  const additionalInformationSource = tabSource.slice(headingStart, listEnd);
  const labels = [...additionalInformationSource.matchAll(/<dt>([^<]+)<\/dt>/g)].map((match) => match[1]);

  assert.deepEqual(labels, [
    "Bauteil",
    "Etage",
    "Raum Nr.",
    "Achse",
  ]);
  for (const removedLabel of ["Material", "Ausführung", "Firma", "Monteure"]) {
    assert.doesNotMatch(additionalInformationSource, new RegExp(`<dt>${removedLabel}</dt>`));
  }
  assert.match(styles, /\.project-extra-work-detail \{[\s\S]*--project-extra-work-detail-columns: minmax\(0, 1fr\) 180px 108px 100px/);
  assert.match(styles, /\.project-extra-work-key-data,[\s\S]*\.project-extra-work-project-data \{[\s\S]*grid-template-columns: var\(--project-extra-work-detail-columns\)/);
  assert.match(styles, /\.project-extra-work-additional-data \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.project-extra-work-key-data,[\s\S]*\.project-extra-work-project-data \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.project-extra-work-additional-data \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 480px\)[\s\S]*\.project-extra-work-key-data,[\s\S]*\.project-extra-work-project-data \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 480px\)[\s\S]*\.project-extra-work-additional-data \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);

  for (const field of ["ordered_by_name", "billing_type", "estimated_order_value", "estimated_hours"]) {
    assert.match(typeSource, new RegExp(`${field}[?]?:`));
  }
  assert.match(documentSource, /label="Anordnung von"[\s\S]*draft\.ordered_by_name/);
  assert.match(documentSource, /label="Firma"[\s\S]*draft\.ordered_by_company/);
  assert.match(documentSource, /draft\.billing_type === "flat_rate"/);
  assert.match(documentSource, /label="Stundenvorgabe"[\s\S]*draft\.entry\.estimated_hours/);
  assert.match(documentSource, /label="Geschätzter Auftragswert"[\s\S]*draft\.estimated_order_value/);
  for (const field of [
    "ordered_by_company",
    "material_required",
    "material_separate_attachment",
    "executed_by_lead_monteur",
    "executed_by_monteur",
    "executed_by_helper",
    "executor_other_name",
  ]) {
    assert.match(typeSource, new RegExp(`${field}:`));
    assert.match(documentSource, new RegExp(`draft\\.${field}`));
  }
  assert.match(typeSource, /worker_names: string\[\]/);
});

test("additional information keeps closed outer edges and single responsive separators", () => {
  const gridRule = [...styles.matchAll(/(?:^|\n)\.project-extra-work-additional-data \{([^}]*)\}/g)]
    .map((match) => match[1])
    .find((rule) => rule.includes("border: solid")) ?? "";

  assert.match(gridRule, /border: solid var\(--project-extra-work-divider\)/);
  assert.match(gridRule, /border-width: 1px/);
  assert.doesNotMatch(gridRule, /border-width: 1px 0/);
  assert.match(
    styles,
    /\.project-extra-work-additional-data > div:not\(:nth-child\(4n \+ 1\)\) \{[\s\S]*border-left: 1px solid var\(--project-extra-work-divider-soft\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 760px\)[\s\S]*\.project-extra-work-additional-data > div:nth-child\(n\) \{[\s\S]*border-left: 0[\s\S]*\.project-extra-work-additional-data > div:nth-child\(2n\) \{[\s\S]*border-left: 1px solid var\(--project-extra-work-divider-soft\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 480px\)[\s\S]*\.project-extra-work-additional-data > div:nth-child\(n\) \{[\s\S]*border-left: 0/,
  );
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
  assert.match(styles, /--project-extra-work-master-column: minmax\(680px, 52%\)/);
  assert.match(styles, /\.project-extra-work-workspace \{[\s\S]*grid-template-columns: var\(--project-extra-work-master-column\) minmax\(0, 1fr\)/);
  assert.match(styles, /grid-template-columns: 148px minmax\(152px, 1fr\) 104px 88px 104px 68px/);
  assert.match(styles, /--project-extra-work-control-height: 32px/);
  assert.match(styles, /\.project-extra-work-toolbar \.measurement-review-header-actions > \.secondary-action,[\s\S]*\.project-extra-work-toolbar \.measurement-review-header-actions > \.primary-action,[\s\S]*\.project-extra-work-search \{[\s\S]*height: var\(--project-extra-work-control-height\)/);
  assert.match(styles, /\.project-extra-work-search input \{[\s\S]*appearance: none;[\s\S]*height: 100%/);
  assert.match(styles, /\.project-record-toolbar\.project-extra-work-toolbar\.measurement-review-toolbar \{[\s\S]*grid-template-columns: var\(--project-extra-work-master-column\) minmax\(0, 1fr\);[\s\S]*border-bottom: 0/);
  assert.match(styles, /--project-extra-work-header-separator-inset: 8px/);
  assert.match(styles, /\.project-extra-work-toolbar \.measurement-review-header-actions::before \{[\s\S]*top: var\(--project-extra-work-header-separator-inset\);[\s\S]*bottom: var\(--project-extra-work-header-separator-inset\);[\s\S]*left: 0;[\s\S]*width: 1px;[\s\S]*background: var\(--project-extra-work-divider\)/);
  assert.match(styles, /\.site-detail-status-trigger \{[\s\S]*border-radius: 0/);
  assert.match(styles, /\.site-detail-status-menu \{[\s\S]*border-radius: 0/);
  assert.match(styles, /\.project-extra-work-detail-head \{[\s\S]*height: 60px;[\s\S]*padding: 10px var\(--project-extra-work-header-inline-padding\)/);
  assert.doesNotMatch(styles, /\.project-extra-work-detail-statuses/);
  assert.match(styles, /\.project-extra-work-detail \{[\s\S]*--project-extra-work-detail-columns: minmax\(0, 1fr\) 180px 108px 100px/);
  assert.match(styles, /\.project-extra-work-key-data,[\s\S]*\.project-extra-work-project-data \{[\s\S]*grid-template-columns: var\(--project-extra-work-detail-columns\)/);
  assert.match(styles, /\.project-extra-work-additional-data \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(styles, /\.project-extra-work-project-data \{[\s\S]*grid-template-columns: 1\.2fr/);
  assert.match(styles, /\.project-extra-work-detail dd \{[\s\S]*overflow-wrap: anywhere/);
  assert.match(styles, /\.project-extra-work-delivery-status\.is-not-sent \{[\s\S]*color: #b42318/);
  assert.match(styles, /\.project-extra-work-delivery-status\.is-signature-open,[\s\S]*\.project-extra-work-delivery-status\.is-complete \{[\s\S]*color: #22c55e/);
  assert.match(styles, /\.project-extra-work-delivery-status:focus-visible \{[\s\S]*outline: 2px solid/);
  assert.match(styles, /\.project-extra-work-delivery-status:hover \.project-extra-work-delivery-tooltip,[\s\S]*\.project-extra-work-delivery-status:focus-visible \.project-extra-work-delivery-tooltip/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.project-extra-work-project-data \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 480px\)[\s\S]*\.project-extra-work-project-data \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 480px\)[\s\S]*\.project-extra-work-delivery-tooltip \{[\s\S]*right: auto;[\s\S]*left: 0/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*--project-extra-work-master-column: minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*\.project-extra-work-toolbar \.measurement-review-header-actions \{[\s\S]*border-top: 1px solid var\(--project-extra-work-divider\)/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*\.project-extra-work-toolbar \.measurement-review-header-actions::before \{[\s\S]*display: none/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.project-extra-work-toolbar \.measurement-review-header-actions \{[\s\S]*flex-wrap: wrap/);
  assert.match(styles, /\.project-extra-work-master-row\.is-selected::before/);
  assert.match(styles, /\.project-extra-work-overview \.secondary-action,[\s\S]*border-radius: 2px/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*\.project-extra-work-workspace/);
  assert.doesNotMatch(overviewStyles, /\nbutton\s*\{/);
});

test("structural dividers become lighter only inside the extra-work overview", () => {
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace \{[\s\S]*--pf-border: #d1d9e6/);
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace \.project-record-tabs \{[\s\S]*border-bottom: 1px solid var\(--pf-border\)/);
  assert.match(styles, /\.project-extra-work-overview \{[\s\S]*--project-extra-work-divider: #e3e6eb;[\s\S]*--project-extra-work-divider-soft: #edf0f3/);
  assert.match(styles, /\.project-record-toolbar\.project-extra-work-toolbar\.measurement-review-toolbar \{[\s\S]*border-color: var\(--project-extra-work-divider\)/);
  assert.match(styles, /\.project-extra-work-toolbar \.measurement-review-header-actions::before \{[\s\S]*background: var\(--project-extra-work-divider\)/);
  assert.match(styles, /\.project-extra-work-workspace \{[\s\S]*border: 1px solid var\(--project-extra-work-divider\)/);
  assert.match(styles, /\.project-extra-work-master-row \{[\s\S]*border-bottom: 1px solid var\(--project-extra-work-divider-soft\)/);
  assert.match(styles, /\.project-extra-work-detail-head \{[\s\S]*border-bottom: 1px solid var\(--project-extra-work-divider\)/);
  assert.match(styles, /\.project-extra-work-key-data > div \+ div,[\s\S]*border-left: 1px solid var\(--project-extra-work-divider-soft\)/);
  assert.match(styles, /\.project-extra-work-description \{[\s\S]*border: 1px solid var\(--project-extra-work-divider\)/);
  assert.match(styles, /\.project-extra-work-search \{[\s\S]*border: 1px solid var\(--pf-border\)/);
});

test("toolbar and detail action edges share the responsive right inset", () => {
  assert.match(styles, /\.project-extra-work-overview \{[\s\S]*--project-extra-work-header-inline-padding: 18px/);
  assert.match(styles, /\.project-extra-work-toolbar \.measurement-review-header-actions \{[\s\S]*overflow-y: auto;[\s\S]*padding: 10px var\(--project-extra-work-header-inline-padding\);[\s\S]*scrollbar-gutter: stable/);
  assert.match(styles, /\.project-extra-work-detail-head \{[\s\S]*padding: 10px var\(--project-extra-work-header-inline-padding\)/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*--project-extra-work-header-inline-padding: 14px/);
});

test("extra-work typography is locally strengthened without changing compact geometry", () => {
  assert.match(styles, /\.project-extra-work-master-head \{[\s\S]*font-size: 0\.75rem/);
  assert.match(styles, /\.project-extra-work-master-row \{[\s\S]*min-height: 66px;[\s\S]*font-size: 0\.82rem;[\s\S]*font-weight: 550/);
  assert.match(styles, /\.project-extra-work-master-title strong \{[\s\S]*font-size: 0\.84rem;[\s\S]*font-weight: 650/);
  assert.match(styles, /\.project-extra-work-detail dt \{[\s\S]*font-size: 0\.75rem/);
  assert.match(styles, /\.project-extra-work-detail dd \{[\s\S]*font-size: 0\.82rem;[\s\S]*font-weight: 600/);
  assert.match(styles, /\.project-extra-work-detail-section h4 \{[\s\S]*font-size: 0\.875rem/);
  assert.match(styles, /\.project-extra-work-detail-head \{[\s\S]*height: 60px/);
  assert.match(styles, /--project-extra-work-detail-columns: minmax\(0, 1fr\) 180px 108px 100px/);
});

test("the right master columns align headers and values on shared axes", () => {
  assert.match(styles, /\.project-extra-work-master-head > span:nth-child\(4\),[\s\S]*\.project-extra-work-master-row > time:nth-child\(4\),[\s\S]*\.project-extra-work-master-row > span:nth-child\(5\) \{[\s\S]*justify-self: stretch;[\s\S]*text-align: left/);
  assert.match(styles, /\.project-extra-work-master-head > span:nth-child\(6\),[\s\S]*\.project-extra-work-master-row > strong:nth-child\(6\) \{[\s\S]*justify-self: stretch;[\s\S]*text-align: right/);
  assert.match(styles, /\.project-extra-work-master-head > span:nth-child\(n \+ 3\) \{[\s\S]*white-space: nowrap/);
  assert.match(styles, /\.project-extra-work-master-head > span,[\s\S]*\.project-extra-work-master-row > \* \{[\s\S]*padding: 0 10px/);
  assert.match(styles, /\.project-extra-work-master \{[\s\S]*--project-extra-work-master-scrollbar-width: 0px/);
  assert.match(styles, /\.project-extra-work-master-head \{[\s\S]*padding-right: var\(--project-extra-work-master-scrollbar-width\)/);
  assert.match(styles, /\.project-extra-work-master-body \{[\s\S]*overflow-y: auto/);
  assert.doesNotMatch(styles, /\.project-extra-work-master-body \{[^}]*scrollbar-gutter: stable/s);
  assert.match(styles, /grid-template-columns: 148px minmax\(152px, 1fr\) 104px 88px 104px 68px/);
});
