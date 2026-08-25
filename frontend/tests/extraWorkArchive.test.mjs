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
const archiveStart = pageSource.indexOf("async function archiveExtraWorkTicket");
const archiveEnd = pageSource.indexOf("async function restoreExtraWorkTicket", archiveStart);
const archiveSource = pageSource.slice(archiveStart, archiveEnd);

test("extra-work API and type expose archive metadata, archive filter, and restore", () => {
  assert.match(typeSource, /MobileExtraWorkTicket[\s\S]*deleted_at: string \| null/);
  assert.match(typeSource, /MobileExtraWorkTicket[\s\S]*deleted_by_user_id: number \| null/);
  assert.match(typeSource, /MobileExtraWorkTicket[\s\S]*deleted_by_name: string \| null/);
  assert.match(apiSource, /siteExtraWorkTickets[\s\S]*archivedOnly[\s\S]*archived_only/);
  assert.match(apiSource, /restoreSiteExtraWorkTicket[\s\S]*extra-work-tickets\/\$\{ticketId\}\/restore[\s\S]*method: "POST"/);
});

test("archive stays inside the master-detail tab and remains visibly separate", () => {
  assert.match(pageSource, /const \[extraWorkArchiveMode, setExtraWorkArchiveMode\] = useState\(false\)/);
  assert.match(tabSource, /"Archivierte Zusatzaufträge"/);
  assert.doesNotMatch(tabSource, /Archivierte Zusatzaufträge können hier eingesehen und wiederhergestellt werden\./);
  assert.match(tabSource, /className="project-extra-work-mode-switch" role="group" aria-label="Zusatzauftragsansicht"/);
  assert.match(tabSource, /aria-pressed=\{!archiveMode\}/);
  assert.match(tabSource, /aria-pressed=\{archiveMode\}/);
  assert.match(tabSource, /"Keine archivierten Zusatzaufträge vorhanden\."/);
  assert.match(pageSource, /siteExtraWorkTickets\(site\.id, \{ archivedOnly \}\)/);
});

test("overview offers archive and restore but never a delete control", () => {
  assert.match(tabSource, /Archivieren/);
  assert.match(tabSource, /Wiederherstellen/);
  assert.match(tabSource, /onArchiveTicket/);
  assert.match(tabSource, /onRestoreTicket/);
  assert.doesNotMatch(tabSource, /measurement-review-delete-action/);
  assert.doesNotMatch(tabSource, /Zusatzauftrag löschen/);
  assert.doesNotMatch(tabSource, /onDeleteTicket/);
});

test("archive action confirms recoverable archiving and removes the active row", () => {
  assert.equal(archiveSource.match(/window\.confirm/g)?.length, 1);
  assert.match(archiveSource, /wirklich archivieren\?/);
  assert.match(archiveSource, /kann später wiederhergestellt werden/);
  assert.doesNotMatch(archiveSource, /Endgültig löschen/);
  assert.match(archiveSource, /current\.filter\(\(entry\) => entry\.id !== ticket\.id\)/);
});
