import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXTRA_WORK_PHOTO_ACCEPT,
  MAX_EXTRA_WORK_PHOTO_BYTES,
  validateExtraWorkPhotoFiles,
} from "../src/lib/extraWorkAttachments.ts";

const [pageSource, apiSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

const previewStart = pageSource.indexOf("function ExtraWorkOverviewPhotos");
const thumbnailStart = pageSource.indexOf("function ExtraWorkOverviewThumbnail", previewStart);
const modalStart = pageSource.indexOf("function ExtraWorkOverviewPhotoModal", thumbnailStart);
const previewSource = pageSource.slice(previewStart, thumbnailStart);
const modalSource = pageSource.slice(modalStart, pageSource.indexOf("function MeasurementTab", modalStart));

function file(name, type, size = 1024) {
  return { name, type, size };
}

test("clicking an editable free slot opens a single-file picker with the shared accept list", () => {
  const inputStart = previewSource.indexOf("ref={fileInputRef}");
  const inputEnd = previewSource.indexOf("/>", inputStart);
  const inputSource = previewSource.slice(inputStart, inputEnd);

  assert.match(previewSource, /aria-label=\{`Foto hinzufügen, Platz \$\{index \+ 1\} von \$\{MAX_EXTRA_WORK_PHOTOS\}`\}/);
  assert.match(previewSource, /onClick=\{\(\) => openPhotoFilePicker\(index\)\}/);
  assert.match(previewSource, /filePickerSlotRef\.current = slotIndex;[\s\S]*fileInputRef\.current\?\.click\(\)/);
  assert.match(inputSource, /accept=\{EXTRA_WORK_PHOTO_ACCEPT\}/);
  assert.match(inputSource, /type="file"/);
  assert.doesNotMatch(inputSource, /multiple/);
  assert.match(EXTRA_WORK_PHOTO_ACCEPT, /image\/jpeg/);
  assert.match(EXTRA_WORK_PHOTO_ACCEPT, /image\/heic/);
});

test("dragging a file marks only the target slot and dropping cannot navigate the browser", () => {
  assert.match(previewSource, /handlePhotoSlotDragEnter[\s\S]*containsDraggedFiles\(event\.dataTransfer\.types\)/);
  assert.match(previewSource, /handlePhotoSlotDragEnter[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);/);
  assert.match(previewSource, /event\.dataTransfer\.dropEffect = "copy";[\s\S]*setDragOverSlotIndex\(index\)/);
  assert.match(previewSource, /handlePhotoSlotDrop[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);/);
  assert.match(previewSource, /const file = event\.dataTransfer\.files\[0\]/);
  assert.match(previewSource, /onDragOver=\{\(event\) => handlePhotoSlotDragOver\(index, event\)\}/);
  assert.match(previewSource, /onDrop=\{\(event\) => handlePhotoSlotDrop\(index, event\)\}/);
  assert.match(styles, /\.project-extra-work-photo-upload\.is-drag-over \{[^}]*border-style:\s*solid;[^}]*box-shadow:/s);
});

test("one validated file uploads through the existing endpoint before becoming persisted metadata", () => {
  assert.match(previewSource, /validateExtraWorkPhotoFiles\(\[file\], photos\.length\)\[0\]/);
  assert.match(previewSource, /const storedPhoto = await api\.uploadSiteExtraWorkTicketPhoto\([\s\S]*uploadSiteId,[\s\S]*uploadTicketId,[\s\S]*candidate\.file/);
  assert.match(previewSource, /onPhotoCountUpdated\(uploadTicketId, nextPhotoCount\)/);
  assert.match(previewSource, /setPhotos\(\(current\) => \([\s\S]*\[\.\.\.current, storedPhoto\]\.slice\(0, MAX_EXTRA_WORK_PHOTOS\)/);
  assert.match(apiSource, /uploadSiteExtraWorkTicketPhoto[\s\S]*new FormData\(\)[\s\S]*\/photos[\s\S]*method:\s*"POST"/);
  assert.match(previewSource, /photos\.length >= MAX_EXTRA_WORK_PHOTOS/);
});

test("upload state, duplicate protection and understandable validation and request failures stay in the target slot", () => {
  assert.match(previewSource, /photoUploadOperationRef\.current = \{ token: uploadToken, ticketId: uploadTicketId \}/);
  assert.match(previewSource, /canUseUploadSlot[\s\S]*photoUploadOperationRef\.current === null/);
  assert.match(previewSource, /setUploadingSlotIndex\(slotIndex\)/);
  assert.match(previewSource, /aria-busy=\{uploadingSlotIndex === index\}/);
  assert.match(previewSource, /Wird hochgeladen…/);
  assert.match(previewSource, /readApiError\(requestError, `\$\{candidate\.file\.name\} konnte nicht hochgeladen werden\.`\)/);
  assert.match(previewSource, /role="alert">\{uploadError\}/);
  assert.match(styles, /\.project-extra-work-photo-upload\.is-uploading \{[^}]*cursor:\s*wait;/s);

  assert.equal(validateExtraWorkPhotoFiles([file("plan.pdf", "application/pdf")], 0)[0].error, "Erlaubt sind JPEG, PNG, WebP, HEIC und HEIF.");
  assert.equal(validateExtraWorkPhotoFiles([file("gross.jpg", "image/jpeg", MAX_EXTRA_WORK_PHOTO_BYTES + 1)], 0)[0].error, "Die Datei ist größer als 15 MB.");
  assert.equal(validateExtraWorkPhotoFiles([file("sechs.jpg", "image/jpeg")], 5)[0].error, "Maximal 5 Fotos pro Zusatzauftrag erlaubt.");
});

test("selection changes keep upload ownership on the captured ticket and suppress stale local UI", () => {
  assert.match(previewSource, /const uploadSiteId = siteId;[\s\S]*const uploadTicketId = ticket\.id;/);
  assert.match(previewSource, /api\.uploadSiteExtraWorkTicketPhoto\([\s\S]*uploadTicketId/);
  assert.match(previewSource, /onPhotoCountUpdated\(uploadTicketId, nextPhotoCount\)/);
  assert.match(previewSource, /activeTicketIdRef\.current === uploadTicketId[\s\S]*photoUploadOperationRef\.current\?\.token === uploadToken[\s\S]*setPhotos/);
  assert.match(previewSource, /catch \(requestError\) \{[\s\S]*activeTicketIdRef\.current === uploadTicketId[\s\S]*setUploadError/);
  assert.match(previewSource, /useEffect\(\(\) => \{[\s\S]*photoUploadOperationRef\.current = null;[\s\S]*setUploadingSlotIndex\(null\);[\s\S]*\}, \[ticket\.id\]\)/);
  assert.match(previewSource, /isMountedRef\.current = false/);
  assert.match(pageSource, /entry\.id === ticketId \? \{ \.\.\.entry, photo_count: photoCount \} : entry/);
});

test("upload refreshes metadata without changing thumbnail or deferred-original behavior", () => {
  assert.match(previewSource, /initialPhotoCountRef = useRef\(\{ ticketId: ticket\.id, count: ticket\.photo_count \}\)/);
  assert.match(previewSource, /initialPhotoCountRef\.current\.ticketId !== ticket\.id[\s\S]*count: ticket\.photo_count/);
  assert.doesNotMatch(previewSource, /siteExtraWorkTicketPhotoContent/);
  assert.doesNotMatch(previewSource, /requestBlob/);
  assert.match(pageSource.slice(thumbnailStart, modalStart), /api\.siteExtraWorkTicketPhotoThumbnail/);
  assert.match(modalSource, /api\.siteExtraWorkTicketPhotoContent/);
  assert.match(apiSource, /siteExtraWorkTicketPhotos[\s\S]*request<MobileExtraWorkTicketPhoto\[\]>/);
  assert.doesNotMatch(apiSource.slice(apiSource.indexOf("async siteExtraWorkTicketPhotos"), apiSource.indexOf("async uploadSiteExtraWorkTicketPhoto")), /requestBlob/);
});

test("the existing document lock and responsive slot styles gate upload permissions", () => {
  assert.match(pageSource, /canUpload=\{!isExtraWorkDocumentLocked\(ticket, canEdit\)\}/);
  assert.match(previewSource, /canUpload && !isLoading && !hasError \? \([\s\S]*project-extra-work-photo-upload/);
  assert.match(previewSource, /aria-disabled=\{isUploadBlocked\}/);
  assert.match(styles, /\.project-extra-work-photo-upload \{[^}]*justify-items:\s*center;[^}]*cursor:\s*pointer;/s);
  assert.match(styles, /\.project-extra-work-photo-upload:focus-visible \{[^}]*box-shadow:[^}]*outline:\s*0;/s);
});
