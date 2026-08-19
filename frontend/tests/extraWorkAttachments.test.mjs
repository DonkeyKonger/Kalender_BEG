import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXTRA_WORK_PHOTO_ACCEPT,
  MAX_EXTRA_WORK_PHOTO_BYTES,
  MAX_EXTRA_WORK_PHOTOS,
  getExtraWorkAttachmentKind,
  validateExtraWorkPhotoFiles,
} from "../src/lib/extraWorkAttachments.ts";

const [componentSource, apiSource, styles] = await Promise.all([
  readFile(new URL("../src/components/SupplementaryOrderDetail.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

function file(name, type, size = 1024) {
  return { name, type, size };
}

test("extra-work photo validation mirrors the existing five-photo and 15 MB backend rules", () => {
  assert.equal(MAX_EXTRA_WORK_PHOTOS, 5);
  assert.equal(MAX_EXTRA_WORK_PHOTO_BYTES, 15 * 1024 * 1024);
  assert.match(EXTRA_WORK_PHOTO_ACCEPT, /image\/jpeg/);
  assert.match(EXTRA_WORK_PHOTO_ACCEPT, /image\/heic/);

  const candidates = validateExtraWorkPhotoFiles([
    file("eins.png", "image/png"),
    file("plan.pdf", "application/pdf"),
    file("leer.jpg", "image/jpeg", 0),
    file("gross.webp", "image/webp", MAX_EXTRA_WORK_PHOTO_BYTES + 1),
    file("zwei.heic", "image/heic"),
  ], 3);

  assert.equal(candidates[0].error, null);
  assert.match(candidates[1].error, /JPEG, PNG, WebP, HEIC und HEIF/);
  assert.equal(candidates[2].error, "Die Datei ist leer.");
  assert.equal(candidates[3].error, "Die Datei ist größer als 15 MB.");
  assert.equal(candidates[4].error, null);
});

test("multi-file validation reports every item beyond the persisted photo limit", () => {
  const candidates = validateExtraWorkPhotoFiles([
    file("vier.jpg", "image/jpeg"),
    file("fuenf.jpg", "image/jpeg"),
    file("sechs.jpg", "image/jpeg"),
  ], 3);

  assert.deepEqual(candidates.map((candidate) => candidate.error), [
    null,
    null,
    "Maximal 5 Fotos pro Zusatzauftrag erlaubt.",
  ]);
});

test("existing attachment metadata supports thumbnails plus document fallbacks", () => {
  assert.equal(getExtraWorkAttachmentKind("image/jpeg"), "image");
  assert.equal(getExtraWorkAttachmentKind("application/pdf"), "pdf");
  assert.equal(getExtraWorkAttachmentKind("application/octet-stream"), "file");
});

test("desktop uses the shared site photo API for immediate upload and delete", () => {
  assert.match(apiSource, /uploadSiteExtraWorkTicketPhoto[\s\S]*new FormData\(\)[\s\S]*method:\s*"POST"/);
  assert.match(apiSource, /deleteSiteExtraWorkTicketPhoto[\s\S]*method:\s*"DELETE"/);
  assert.match(componentSource, /api\.uploadSiteExtraWorkTicketPhoto\(/);
  assert.match(componentSource, /api\.deleteSiteExtraWorkTicketPhoto\(/);
  assert.match(componentSource, /updatePersistedPhotoCount\(persistedPhotos\.length\)/);
});

test("attachment area reuses the project file drag guard and contains browser-safe drop handling", () => {
  assert.match(componentSource, /containsDraggedFiles\(event\.dataTransfer\.types\)/);
  assert.match(componentSource, /event\.preventDefault\(\);[\s\S]*event\.dataTransfer\.dropEffect/);
  assert.match(componentSource, /onDragEnter=\{handleAttachmentDragEnter\}/);
  assert.match(componentSource, /onDrop=\{handleAttachmentDrop\}/);
  assert.match(componentSource, /type="file"[\s\S]*accept=\{EXTRA_WORK_PHOTO_ACCEPT\}[\s\S]*multiple/);
  assert.match(componentSource, /attachmentUploadPendingRef\.current/);
});

test("attachments move into one temporary document overlay without duplicating upload logic", () => {
  const attachmentPanelSource = componentSource.slice(
    componentSource.indexOf("{isAttachmentsOpen ? ("),
    componentSource.indexOf("{isWorkerSignatureOpen ? ("),
  );
  assert.match(componentSource, /aria-controls="supplementary-order-attachment-panel"/);
  assert.match(componentSource, /supplementary-order-attachment-panel-backdrop/);
  assert.match(componentSource, /role="dialog"[\s\S]*aria-modal="true"/);
  assert.match(componentSource, /onMouseDown=\{\(\) => setIsAttachmentsOpen\(false\)\}/);
  assert.match(componentSource, /aria-label="Anlagen schließen"/);
  assert.equal(componentSource.match(/onDrop=\{handleAttachmentDrop\}/g)?.length, 1);
  assert.equal(componentSource.match(/api\.uploadSiteExtraWorkTicketPhoto\(/g)?.length, 1);
  assert.doesNotMatch(attachmentPanelSource, /Escape/);
  assert.match(styles, /\.supplementary-order-attachment-panel-backdrop \{[^}]*position:\s*fixed;[^}]*justify-content:\s*flex-end;/s);
  assert.match(styles, /\.supplementary-order-attachment-panel-content \{[^}]*overflow-y:\s*auto;/s);
});

test("editable tickets show upload and delete while locked tickets retain only the list", () => {
  assert.match(componentSource, /!isLocked \? \([\s\S]*supplementary-order-attachment-dropzone/);
  assert.match(componentSource, /!readOnly \? \([\s\S]*supplementary-order-attachment-delete/);
  assert.match(componentSource, /isLocked[\s\S]*event\.dataTransfer\.dropEffect = "none"/);
  assert.match(componentSource, /window\.confirm\(`„\$\{photo\.filename\}“ wirklich löschen\?`\)/);
});

test("compact attachment rows preserve thumbnail aspect ratio and truncate long names", () => {
  assert.match(componentSource, /className="supplementary-order-attachment-preview"[\s\S]*thumbnailUrl[\s\S]*<img/);
  assert.match(styles, /\.supplementary-order-attachment-preview img \{[^}]*object-fit:\s*cover/s);
  assert.match(styles, /\.supplementary-order-attachment-copy strong,[^{]*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s);
  assert.match(styles, /\.supplementary-order-attachment-drop-hint \{[^}]*position:\s*absolute;[^}]*pointer-events:\s*none/s);
});
