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

test("toolbar separates master controls from the aligned detail action rail", () => {
  const toolbarStart = tabSource.indexOf('<header className="project-record-toolbar project-extra-work-toolbar');
  const toolbarEnd = tabSource.indexOf("</header>", toolbarStart);
  const toolbarSource = tabSource.slice(toolbarStart, toolbarEnd);
  const masterIndex = toolbarSource.indexOf('className="project-extra-work-toolbar-master"');
  const searchIndex = toolbarSource.indexOf('className="project-extra-work-search"');
  const detailIndex = toolbarSource.indexOf('className="project-extra-work-toolbar-detail"');
  const createIndex = toolbarSource.indexOf("onClick={onCreate}");

  assert.match(tabSource, /\+ Zusatzauftrag erstellen/);
  assert.match(tabSource, /type="search"/);
  assert.match(tabSource, /placeholder="Suche\.\.\."/);
  assert.doesNotMatch(toolbarSource, /<p>/);
  assert.doesNotMatch(toolbarSource, /Mobile Stundenzettel und Zusatzaufträge/);
  assert.ok(masterIndex >= 0 && masterIndex < searchIndex && searchIndex < detailIndex && detailIndex < createIndex);
  assert.match(toolbarSource, /className="project-extra-work-toolbar-master"[\s\S]*className="project-extra-work-search"/);
  assert.match(toolbarSource, /className="project-extra-work-toolbar-detail"[\s\S]*onClick=\{onCreate\}/);
  assert.match(toolbarSource, /className="primary-action project-extra-work-key-action project-extra-work-key-action--filled"[\s\S]*onClick=\{onCreate\}/);
  assert.doesNotMatch(tabSource, /Filter/);
});

test("active and archived overview modes use one accessible two-state switch", () => {
  const toolbarStart = tabSource.indexOf('<header className="project-record-toolbar project-extra-work-toolbar');
  const toolbarEnd = tabSource.indexOf("</header>", toolbarStart);
  const toolbarSource = tabSource.slice(toolbarStart, toolbarEnd);

  assert.match(toolbarSource, /archiveMode \? "Archivierte Zusatzaufträge" : "Zusatzaufträge"/);
  assert.match(toolbarSource, /className="project-extra-work-mode-switch" role="group" aria-label="Zusatzauftragsansicht"/);
  assert.match(toolbarSource, /aria-pressed=\{!archiveMode\}[\s\S]*onClick=\{\(\) => archiveMode && onToggleArchive\(\)\}[\s\S]*Aktiv/);
  assert.match(toolbarSource, /aria-pressed=\{archiveMode\}[\s\S]*onClick=\{\(\) => !archiveMode && onToggleArchive\(\)\}[\s\S]*Archiv/);
  assert.match(toolbarSource, /disabled=\{actionBusy\}/);
  assert.doesNotMatch(toolbarSource, />Archiv anzeigen</);
  assert.doesNotMatch(toolbarSource, /Aktive Zusatzaufträge anzeigen/);
});

test("detail overflow menu preserves archive and restore paths with full keyboard lifecycle", () => {
  const detailStart = tabSource.indexOf("function ExtraWorkOverviewDetail");
  const detailSource = tabSource.slice(detailStart);

  assert.match(tabSource, />Öffnen</);
  assert.match(tabSource, /"PDF"/);
  assert.match(detailSource, /aria-haspopup="menu"/);
  assert.match(detailSource, /aria-expanded=\{isActionMenuOpen\}/);
  assert.match(detailSource, /aria-controls=\{isActionMenuOpen \? actionMenuId : undefined\}/);
  assert.match(detailSource, /<MoreHorizontal aria-hidden="true"/);
  assert.match(detailSource, /role="menu"/);
  assert.match(detailSource, /role="menuitem"/);
  assert.match(detailSource, /archiveMode \? "Wiederherstellen" : "Archivieren"/);
  assert.match(detailSource, /if \(archiveMode\) \{[\s\S]*onRestoreTicket\(selectedTicket\);[\s\S]*\} else \{[\s\S]*onArchiveTicket\(selectedTicket\);/);
  assert.match(detailSource, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/);
  assert.match(detailSource, /document\.addEventListener\("keydown", handleKeyDown\)/);
  assert.match(detailSource, /event\.key === "Escape"[\s\S]*closeActionMenu\(true\)/);
  assert.match(detailSource, /event\.key === "Tab"[\s\S]*event\.preventDefault\(\)[\s\S]*menuItemRef\.current\?\.focus\(\)/);
  assert.match(detailSource, /requestAnimationFrame\(\(\) => menuItemRef\.current\?\.focus\(\)\)/);
  assert.match(detailSource, /triggerRef\.current\?\.focus\(\)/);
  assert.match(detailSource, /disabled=\{actionMenuBusy\}/);
  assert.doesNotMatch(detailSource, /onClick=\{\(\) => onArchiveTicket\(ticket\)\}/);
  assert.doesNotMatch(detailSource, /onClick=\{\(\) => onRestoreTicket\(ticket\)\}/);
  assert.doesNotMatch(tabSource, />Löschen</);
});

test("desktop header and detail actions share the 52-48 grid and one action-rail width", () => {
  assert.match(
    styles,
    /\.project-extra-work-overview \{[\s\S]*--project-extra-work-master-column: minmax\(680px, 52%\);[\s\S]*--project-extra-work-action-rail-width: 264px;/,
  );
  assert.match(
    styles,
    /\.project-record-toolbar\.project-extra-work-toolbar\.measurement-review-toolbar \{[\s\S]*grid-template-columns: var\(--project-extra-work-master-column\) minmax\(0, 1fr\);/,
  );
  assert.match(
    styles,
    /\.project-extra-work-toolbar-master \{[\s\S]*display: flex;[\s\S]*padding: 10px 0 10px var\(--project-extra-work-header-inline-padding\);/,
  );
  assert.match(
    styles,
    /\.project-extra-work-search \{[\s\S]*margin-left: auto;[\s\S]*width: 224px;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-toolbar-detail \{[\s\S]*justify-content: flex-end;[\s\S]*border-left: 1px solid var\(--project-extra-work-divider\);[\s\S]*overflow-y: auto;[\s\S]*scrollbar-gutter: stable;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-toolbar-detail \.project-extra-work-key-action--filled \{[\s\S]*width: var\(--project-extra-work-action-rail-width\);/,
  );
  assert.match(
    styles,
    /\.project-extra-work-detail-actions \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\) 34px;[\s\S]*width: var\(--project-extra-work-action-rail-width\);/,
  );
  assert.match(
    styles,
    /@media \(max-width: 760px\) \{[\s\S]*\.project-extra-work-toolbar-master \{[\s\S]*flex-wrap: wrap;[\s\S]*\.project-extra-work-detail-actions \{[\s\S]*max-width: 100%;/,
  );
  assert.match(
    styles,
    /@media \(max-width: 600px\) \{[\s\S]*\.project-extra-work-toolbar-detail \.project-extra-work-key-action--filled \{[\s\S]*width: 100%;/,
  );
});

test("the two key overview actions reuse the selected payroll week blue with clear hierarchy", () => {
  const genericWorkspacePrimaryIndex = styles.indexOf(
    ".site-detail-page.is-project-file-workspace .primary-action {",
  );
  const genericWorkspaceSecondaryIndex = styles.indexOf(
    ".site-detail-page.is-project-file-workspace .secondary-action {",
  );
  const extraWorkFilledIndex = styles.indexOf(
    ".site-detail-page.is-project-file-workspace .project-extra-work-key-action--filled {",
  );

  assert.equal(tabSource.match(/project-extra-work-key-action(?:\s|")/g)?.length, 2);
  assert.doesNotMatch(tabSource, /project-extra-work-primary-action/);
  assert.match(
    tabSource,
    /className="primary-action project-extra-work-key-action project-extra-work-key-action--filled"[\s\S]*onClick=\{onCreate\}/,
  );
  assert.match(
    tabSource,
    /className="secondary-action project-extra-work-key-action project-extra-work-key-action--outline"[\s\S]*onClick=\{\(\) => onOpenTicket\(ticket\)\}>Öffnen/,
  );
  assert.ok(extraWorkFilledIndex > genericWorkspacePrimaryIndex);
  assert.ok(extraWorkFilledIndex > genericWorkspaceSecondaryIndex);
  assert.match(
    styles,
    /:root \{[\s\S]*--time-week-active-blue: #284f76;/,
  );
  assert.match(
    styles,
    /\.time-week-strip button\.is-active \{[\s\S]*border-color: var\(--time-week-active-blue\);[\s\S]*background: var\(--time-week-active-blue\);[\s\S]*color: #ffffff;/,
  );
  assert.match(
    styles,
    /\.time-entries-page\.is-figma-times-workspace \.time-week-strip button\.is-active \{[\s\S]*border-color: var\(--time-week-active-blue\);[\s\S]*background: var\(--time-week-active-blue\);[\s\S]*color: #ffffff;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-key-action--filled \{[\s\S]*border-color: var\(--time-week-active-blue\);[\s\S]*background: var\(--time-week-active-blue\);[\s\S]*color: #ffffff;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-key-action--filled:hover:not\(:disabled\) \{[\s\S]*border-color: #174678;[\s\S]*background: #174678;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-key-action--filled:active:not\(:disabled\) \{[\s\S]*border-color: #0f172a;[\s\S]*background: #0f172a;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-key-action--outline \{[\s\S]*border-color: var\(--time-week-active-blue\);[\s\S]*background: #ffffff;[\s\S]*color: var\(--time-week-active-blue\);/,
  );
  assert.match(
    styles,
    /\.project-extra-work-key-action--outline:hover:not\(:disabled\) \{[\s\S]*border-color: #9bbce0;[\s\S]*background: #f3f8ff;[\s\S]*color: #174678;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-key-action--outline:active:not\(:disabled\) \{[\s\S]*border-color: #3b82f6;[\s\S]*background: #eff6ff;[\s\S]*color: #1e40af;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-key-action:focus-visible \{[\s\S]*outline: 2px solid #3b82f6;[\s\S]*outline-offset: 2px;/,
  );
  assert.match(
    styles,
    /\.project-extra-work-key-action:disabled \{[\s\S]*cursor: not-allowed;[\s\S]*opacity: 0\.58;/,
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
  assert.match(styles, /\.project-extra-work-toolbar-detail > \.primary-action,[\s\S]*\.project-extra-work-search \{[\s\S]*height: var\(--project-extra-work-control-height\)/);
  assert.match(styles, /\.project-extra-work-search input \{[\s\S]*appearance: none;[\s\S]*height: 100%/);
  assert.match(styles, /\.project-record-toolbar\.project-extra-work-toolbar\.measurement-review-toolbar \{[\s\S]*grid-template-columns: var\(--project-extra-work-master-column\) minmax\(0, 1fr\);[\s\S]*border-bottom: 0/);
  assert.match(styles, /\.project-extra-work-toolbar-detail \{[\s\S]*border-left: 1px solid var\(--project-extra-work-divider\)/);
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
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*\.project-extra-work-toolbar-detail \{[\s\S]*border-top: 1px solid var\(--project-extra-work-divider\);[\s\S]*border-left: 0/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.project-extra-work-toolbar-master \{[\s\S]*flex-wrap: wrap/);
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
  assert.match(styles, /\.project-extra-work-toolbar-detail \{[\s\S]*border-left: 1px solid var\(--project-extra-work-divider\)/);
  assert.match(styles, /\.project-extra-work-workspace \{[\s\S]*border: 1px solid var\(--project-extra-work-divider\)/);
  assert.match(styles, /\.project-extra-work-master-row \{[\s\S]*border-bottom: 1px solid var\(--project-extra-work-divider-soft\)/);
  assert.match(styles, /\.project-extra-work-detail-head \{[\s\S]*border-bottom: 1px solid var\(--project-extra-work-divider\)/);
  assert.match(styles, /\.project-extra-work-key-data > div \+ div,[\s\S]*border-left: 1px solid var\(--project-extra-work-divider-soft\)/);
  assert.match(styles, /\.project-extra-work-description \{[\s\S]*border: 1px solid var\(--project-extra-work-divider\)/);
  assert.match(styles, /\.project-extra-work-search \{[\s\S]*border: 1px solid var\(--pf-border\)/);
});

test("search reaches the split while detail actions share the responsive right inset", () => {
  assert.match(styles, /\.project-extra-work-overview \{[\s\S]*--project-extra-work-header-inline-padding: 18px/);
  assert.match(styles, /\.project-extra-work-toolbar-master \{[\s\S]*padding: 10px 0 10px var\(--project-extra-work-header-inline-padding\)/);
  assert.match(styles, /\.project-extra-work-toolbar-detail \{[\s\S]*padding: 10px var\(--project-extra-work-header-inline-padding\)/);
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
