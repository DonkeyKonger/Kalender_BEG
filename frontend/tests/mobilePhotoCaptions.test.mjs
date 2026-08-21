import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [viewerSource, pageSource, apiSource, typeSource, styles] = await Promise.all([
  readFile(new URL("../src/components/MobilePhotoCaptionViewer.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/types/site.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("all three mobile photo galleries reuse one caption viewer", () => {
  assert.equal(pageSource.match(/<MobilePhotoCaptionViewer/g)?.length, 3);
  assert.match(pageSource, /updateProjectFolderDocumentCaption/);
  assert.match(pageSource, /updateMobileMeasurementBatchPhotoCaption/);
  assert.match(pageSource, /updateMobileExtraWorkTicketPhotoCaption/);
});

test("the shared viewer provides an explicit mobile dirty-save flow", () => {
  assert.match(viewerSource, /placeholder="Beschriftung hinzufügen …"/);
  assert.match(viewerSource, /<textarea[\s\S]*rows=\{3\}/);
  assert.match(viewerSource, /disabled=\{!isDirty \|\| isSaving\}/);
  assert.match(viewerSource, /Beschriftung gespeichert\./);
  assert.match(viewerSource, /<time>\{dateLabel\}<\/time>/);
  assert.match(viewerSource, /<small title=\{filename\}>\{filename\}<\/small>/);
  assert.match(styles, /\.mobile-photo-caption-section textarea/);
});

test("caption APIs and photo response types share the nullable caption property", () => {
  assert.match(apiSource, /items\/\$\{encodeURIComponent\(itemId\)\}\/caption/);
  assert.match(apiSource, /extra-work-tickets\/\$\{ticketId\}\/photos\/\$\{photoId\}\/caption/);
  assert.match(apiSource, /measurement-batches\/\$\{batchId\}\/photos\/\$\{photoId\}\/caption/);
  assert.ok((typeSource.match(/caption: string \| null;/g)?.length ?? 0) >= 3);
});

test("locked measurement and extra-work photos remain read-only", () => {
  assert.match(pageSource, /canEdit=\{!batch\.is_locked_for_worker\}/);
  assert.match(pageSource, /canEdit=\{canEditExtraWorkPhotoCaption\(order\)\}/);
  assert.match(viewerSource, /readOnly=\{!canEdit\}/);
});
