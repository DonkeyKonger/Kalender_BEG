import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, apiSource, typeSource] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/types/site.ts", import.meta.url), "utf8"),
]);

const tabStart = pageSource.indexOf("function ExtraWorkTab");
const tabEnd = pageSource.indexOf("function MeasurementTab", tabStart);
const tabSource = pageSource.slice(tabStart, tabEnd);
const archiveCardStart = tabSource.indexOf("if (archiveMode)");
const archiveReturnStart = tabSource.indexOf("return (", archiveCardStart);
const archiveCardEnd = tabSource.indexOf("\n            return (", archiveReturnStart + "return (".length);
const archiveCardSource = tabSource.slice(archiveCardStart, archiveCardEnd);
const deleteStart = pageSource.indexOf("async function deleteExtraWorkTicket");
const deleteEnd = pageSource.indexOf("async function restoreExtraWorkTicket", deleteStart);
const deleteSource = pageSource.slice(deleteStart, deleteEnd);

test("extra-work API and type expose archive metadata, archive filter, and restore", () => {
  assert.match(typeSource, /MobileExtraWorkTicket[\s\S]*deleted_at: string \| null/);
  assert.match(typeSource, /MobileExtraWorkTicket[\s\S]*deleted_by_user_id: number \| null/);
  assert.match(typeSource, /MobileExtraWorkTicket[\s\S]*deleted_by_name: string \| null/);
  assert.match(apiSource, /siteExtraWorkTickets[\s\S]*archivedOnly[\s\S]*archived_only/);
  assert.match(apiSource, /restoreSiteExtraWorkTicket[\s\S]*extra-work-tickets\/\$\{ticketId\}\/restore[\s\S]*method: "POST"/);
});

test("extra-work archive stays in the existing tab with the requested copy and empty state", () => {
  assert.match(pageSource, /const \[extraWorkArchiveMode, setExtraWorkArchiveMode\] = useState\(false\)/);
  assert.match(tabSource, /"Archivierte Zusatzaufträge"/);
  assert.match(tabSource, /"Gelöschte Zusatzaufträge können hier wiederhergestellt werden\."/);
  assert.match(tabSource, /"Aktive Zusatzaufträge anzeigen" : "Archiv anzeigen"/);
  assert.match(tabSource, /"Keine archivierten Zusatzaufträge vorhanden\."/);
  assert.match(pageSource, /siteExtraWorkTickets\(site\.id, \{ archivedOnly \}\)/);
});

test("archive cards keep original information and offer restore without a PDF action", () => {
  assert.match(archiveCardSource, /statusBadge\.label/);
  assert.match(archiveCardSource, /formatExtraWorkTicketTitle\(ticket\)/);
  assert.match(archiveCardSource, /formatExtraWorkTicketSubmitter\(ticket\)/);
  assert.match(archiveCardSource, /ticket\.deleted_at/);
  assert.match(archiveCardSource, /ticket\.deleted_by_name/);
  assert.match(archiveCardSource, /ticket\.entry_count/);
  assert.match(archiveCardSource, /ticket\.photo_count/);
  assert.match(archiveCardSource, /onRestoreTicket\(ticket\)/);
  assert.match(archiveCardSource, /Wiederherstellen/);
  assert.doesNotMatch(archiveCardSource, />PDF</);
  assert.doesNotMatch(archiveCardSource, /onOpenPdf/);
  assert.doesNotMatch(archiveCardSource, /onDownloadPdf/);
});

test("delete uses one recoverable archive confirmation and removes the active card", () => {
  assert.equal(deleteSource.match(/window\.confirm/g)?.length, 1);
  assert.match(deleteSource, /wird ins Archiv verschoben und kann wiederhergestellt werden/);
  assert.doesNotMatch(deleteSource, /Endgültig löschen/);
  assert.match(deleteSource, /current\.filter\(\(entry\) => entry\.id !== ticket\.id\)/);
});
