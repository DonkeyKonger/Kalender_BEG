import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_EXTRA_WORK_OVERVIEW_PHOTOS,
  getExtraWorkOverviewPhotoSlots,
  loadExtraWorkOverviewPhotoList,
  loadExtraWorkOverviewThumbnail,
} from "../src/lib/extraWorkPhotoPreview.ts";

const [pageSource, apiSource, styles, modelSource, serviceSource, optimizerSource] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/models/extra_work_ticket.py", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/services/extra_work_service.py", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/services/document_photo_optimizer.py", import.meta.url), "utf8"),
]);

test("the overview always exposes five ordered photo slots and fills the remainder with null", () => {
  const photos = [{ id: 31 }, { id: 12 }, { id: 88 }];

  const slots = getExtraWorkOverviewPhotoSlots(photos);

  assert.equal(slots.length, 5);
  assert.deepEqual(slots.map((photo) => photo?.id ?? null), [31, 12, 88, null, null]);

  assert.deepEqual(getExtraWorkOverviewPhotoSlots([]), [null, null, null, null, null]);
  assert.deepEqual(
    getExtraWorkOverviewPhotoSlots([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]).map((photo) => photo?.id ?? null),
    [1, 2, 3, 4, null],
  );
  assert.deepEqual(
    getExtraWorkOverviewPhotoSlots([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]).map((photo) => photo?.id ?? null),
    [1, 2, 3, 4, 5],
  );
});

test("preview metadata is in-flight deduplicated and capped at five without becoming stale session data", async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return Array.from({ length: 7 }, (_, id) => ({ id }));
  };

  const first = loadExtraWorkOverviewPhotoList(8101, 9101, false, loader);
  const concurrent = loadExtraWorkOverviewPhotoList(8101, 9101, false, loader);
  assert.strictEqual(first, concurrent);
  assert.equal((await first).length, MAX_EXTRA_WORK_OVERVIEW_PHOTOS);
  assert.equal(calls, 1);

  assert.equal((await loadExtraWorkOverviewPhotoList(8101, 9101, false, loader)).length, 5);
  assert.equal(calls, 2, "metadata is refreshed after the in-flight request has settled");
});

test("successful thumbnail blobs remain session-cached and failed requests can retry", async () => {
  let calls = 0;
  const blob = new Blob(["thumbnail"], { type: "image/jpeg" });
  const first = await loadExtraWorkOverviewThumbnail(8102, 9102, 1, false, async () => {
    calls += 1;
    return blob;
  });
  const cached = await loadExtraWorkOverviewThumbnail(8102, 9102, 1, false, async () => {
    calls += 1;
    return new Blob();
  });
  assert.strictEqual(first, cached);
  assert.equal(calls, 1);

  let failures = 0;
  await assert.rejects(loadExtraWorkOverviewThumbnail(8102, 9102, 2, false, async () => {
    failures += 1;
    throw new Error("temporary");
  }));
  await loadExtraWorkOverviewThumbnail(8102, 9102, 2, false, async () => {
    failures += 1;
    return blob;
  });
  assert.equal(failures, 2);
});

test("only the selected desktop detail loads thumbnail endpoints and guards rapid selection changes", () => {
  const previewStart = pageSource.indexOf("function ExtraWorkOverviewPhotos");
  const previewEnd = pageSource.indexOf("function MeasurementTab", previewStart);
  const previewSource = pageSource.slice(previewStart, previewEnd);
  const modalStart = previewSource.indexOf("function ExtraWorkOverviewPhotoModal");
  const gridSource = previewSource.slice(0, modalStart);
  const modalSource = previewSource.slice(modalStart);

  assert.match(pageSource, /<ExtraWorkOverviewPhotos[\s\S]*key=\{`\$\{ticket\.id\}/);
  const emptyCountGuard = previewSource.slice(
    previewSource.indexOf("if (initialPhotoCountRef.current.count <= 0)"),
    previewSource.indexOf("void loadExtraWorkOverviewPhotoList"),
  );
  assert.match(emptyCountGuard, /setPhotos\(\[\]\)/);
  assert.doesNotMatch(emptyCountGuard, /siteExtraWorkTicketPhotos/);
  assert.match(gridSource, /api\.siteExtraWorkTicketPhotos\(siteId, ticket\.id/);
  assert.match(gridSource, /api\.siteExtraWorkTicketPhotoThumbnail/);
  assert.match(gridSource, /let active = true/);
  assert.match(gridSource, /if \(active\) \{[\s\S]*setPhotos\(loadedPhotos\)/);
  assert.doesNotMatch(gridSource, /siteExtraWorkTicketPhotoContent/);
  assert.match(modalSource, /api\.siteExtraWorkTicketPhotoContent/);
  assert.match(apiSource, /siteExtraWorkTicketPhotoThumbnail[\s\S]*\/thumbnail/);
});

test("the detail renders exactly five accessible slots with photos first and placeholders after them", () => {
  const previewStart = pageSource.indexOf("function ExtraWorkOverviewPhotos");
  const previewEnd = pageSource.indexOf("function ExtraWorkOverviewThumbnail", previewStart);
  const previewSource = pageSource.slice(previewStart, previewEnd);

  assert.match(previewSource, /const photoSlots = getExtraWorkOverviewPhotoSlots\(photos\)/);
  assert.match(previewSource, /photoSlots\.map\(\(photo, index\) =>/);
  assert.match(previewSource, /photo \? \([\s\S]*<ExtraWorkOverviewThumbnail/);
  assert.match(previewSource, /project-extra-work-photo-placeholder/);
  assert.match(previewSource, /aria-label=\{`Freier Fotoplatz \$\{index \+ 1\} von \$\{MAX_EXTRA_WORK_PHOTOS\}`\}/);
  assert.doesNotMatch(previewSource, /if \(!isLoading && !hasError && photos\.length === 0\)/);
});

test("stored thumbnail bytes stay deferred from ticket-list photo loading", () => {
  assert.match(modelSource, /thumbnail_content:[^\n]*mapped_column\(LargeBinary, deferred=True\)/);
  assert.match(serviceSource, /thumbnail_content = create_document_photo_thumbnail\(optimized_photo\.content\)/);
  assert.match(serviceSource, /thumbnail_content=thumbnail_content/);
  assert.match(serviceSource, /if photo\.thumbnail_content:[\s\S]*return \([\s\S]*photo\.thumbnail_content/);
});

test("the preview uses five equal responsive columns and square cover-cropped tiles", () => {
  assert.match(styles, /\.project-extra-work-photo-list \{[^}]*width:\s*100%;[^}]*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\);[^}]*gap:\s*clamp\(6px, 0\.8vw, 10px\);/s);
  assert.match(styles, /\.project-extra-work-photo \{[^}]*width:\s*100%;[^}]*aspect-ratio:\s*1;/s);
  assert.match(styles, /\.project-extra-work-photo img \{[^}]*object-fit:\s*cover/s);
  assert.match(styles, /\.project-extra-work-photo-placeholder \{[^}]*border-style:\s*dashed;[^}]*background:\s*#f4f6f8;/s);
  assert.doesNotMatch(styles, /\.project-extra-work-photo-list \{[^}]*flex-wrap:/s);
});

test("the grid keeps the existing 320-pixel thumbnail API and accessible image names", () => {
  const thumbnailStart = pageSource.indexOf("function ExtraWorkOverviewThumbnail");
  const thumbnailSource = pageSource.slice(thumbnailStart, pageSource.indexOf("function ExtraWorkOverviewPhotoModal", thumbnailStart));

  assert.match(optimizerSource, /DOCUMENT_PHOTO_THUMBNAIL_SIZE = 320/);
  assert.match(apiSource, /siteExtraWorkTicketPhotoThumbnail[\s\S]*\/thumbnail/);
  assert.match(thumbnailSource, /<img src=\{thumbnailUrl\} alt=\{accessibleName\} loading="eager" decoding="async" \/>/);
  assert.match(thumbnailSource, /title=\{`\$\{photo\.filename\} in Großansicht öffnen`\}/);
});

test("original photo bytes are requested only after a real thumbnail opens the modal", () => {
  const previewStart = pageSource.indexOf("function ExtraWorkOverviewPhotos");
  const thumbnailStart = pageSource.indexOf("function ExtraWorkOverviewThumbnail", previewStart);
  const modalStart = pageSource.indexOf("function ExtraWorkOverviewPhotoModal", thumbnailStart);
  const previewSource = pageSource.slice(previewStart, thumbnailStart);
  const thumbnailSource = pageSource.slice(thumbnailStart, modalStart);
  const modalSource = pageSource.slice(modalStart, pageSource.indexOf("function MeasurementTab", modalStart));

  assert.match(previewSource, /selectedPhoto \? \([\s\S]*<ExtraWorkOverviewPhotoModal/);
  assert.match(thumbnailSource, /type="button"[\s\S]*onClick=\{\(event\) => onOpen\(photo, event\.currentTarget\)\}/);
  assert.doesNotMatch(previewSource, /siteExtraWorkTicketPhotoContent/);
  assert.doesNotMatch(thumbnailSource, /siteExtraWorkTicketPhotoContent/);
  assert.match(modalSource, /siteExtraWorkTicketPhotoContent\(siteId, ticketId, activePhoto\.id/);
  assert.match(modalSource, /<img[\s\S]*alt=\{accessibleName\}[\s\S]*src=\{imageUrl\}/);
  assert.match(styles, /\.project-extra-work-photo-modal-stage img \{[^}]*object-fit:\s*contain/s);
});

test("locked placeholders remain non-interactive while editable free slots expose upload buttons", () => {
  const previewStart = pageSource.indexOf("function ExtraWorkOverviewPhotos");
  const thumbnailStart = pageSource.indexOf("function ExtraWorkOverviewThumbnail", previewStart);
  const previewSource = pageSource.slice(previewStart, thumbnailStart);
  const thumbnailSource = pageSource.slice(thumbnailStart, pageSource.indexOf("function ExtraWorkOverviewPhotoModal", thumbnailStart));

  assert.match(previewSource, /canUpload && !isLoading && !hasError \? \([\s\S]*<button[\s\S]*project-extra-work-photo-upload/);
  assert.match(previewSource, /<span[\s\S]*project-extra-work-photo-placeholder[\s\S]*role="img"/);
  assert.match(thumbnailSource, /<button[\s\S]*aria-haspopup="dialog"/);
});

test("the photo modal supports close button, backdrop, Escape, focus containment and focus return", () => {
  const previewStart = pageSource.indexOf("function ExtraWorkOverviewPhotos");
  const modalStart = pageSource.indexOf("function ExtraWorkOverviewPhotoModal", previewStart);
  const previewSource = pageSource.slice(previewStart, modalStart);
  const modalSource = pageSource.slice(modalStart, pageSource.indexOf("function MeasurementTab", modalStart));

  assert.match(modalSource, /aria-modal="true"[\s\S]*role="dialog"/);
  assert.match(modalSource, /aria-labelledby=\{titleId\}/);
  assert.match(modalSource, /aria-label="Fotoansicht schließen"/);
  assert.match(modalSource, /event\.target === event\.currentTarget[\s\S]*onClose\(\)/);
  assert.match(modalSource, /event\.key === "Escape"[\s\S]*onClose\(\)/);
  assert.match(modalSource, /event\.key === "Tab"[\s\S]*closeButtonRef\.current\?\.focus\(\)/);
  assert.match(modalSource, /requestAnimationFrame\(\(\) => closeButtonRef\.current\?\.focus\(\)\)/);
  assert.match(previewSource, /opener\?\.isConnected[\s\S]*opener\.focus\(\)/);
  assert.match(modalSource, /useMobileModalStack\(true\)/);
});

test("the modal exposes loading and failure states and rejects stale original requests", () => {
  const modalStart = pageSource.indexOf("function ExtraWorkOverviewPhotoModal");
  const modalSource = pageSource.slice(modalStart, pageSource.indexOf("function MeasurementTab", modalStart));

  assert.match(modalSource, /Originalfoto wird geladen…/);
  assert.match(modalSource, /Das Originalfoto konnte nicht geladen werden\./);
  assert.match(modalSource, /const controller = new AbortController\(\)/);
  assert.match(modalSource, /let active = true/);
  assert.match(modalSource, /if \(!active\) \{[\s\S]*return;/);
  assert.match(modalSource, /signal: controller\.signal/);
  assert.match(modalSource, /active = false;[\s\S]*controller\.abort\(\)/);
  assert.match(modalSource, /window\.URL\.revokeObjectURL\(objectUrl\)/);
  assert.match(pageSource, /<ExtraWorkOverviewPhotoModal[\s\S]*key=\{ticket\.id\}[\s\S]*initialPhotoId=\{selectedPhoto\.id\}/);
  assert.match(apiSource, /requestBlob\(path: string, signal\?: AbortSignal\)/);
  assert.match(apiSource, /fetch\(`\$\{API_BASE_URL\}\$\{path\}`, \{ headers, signal \}\)/);
});

test("the large view stays a centered, bounded popup and grows responsively on phones", () => {
  assert.match(styles, /\.project-extra-work-photo-modal-backdrop \{[^}]*position:\s*fixed;[^}]*place-items:\s*center;[^}]*background:\s*rgb\(8 18 31 \/ 58%\);/s);
  assert.match(styles, /\.project-extra-work-photo-modal \{[^}]*width:\s*clamp\(420px, 56vw, 920px\);[^}]*height:\s*clamp\(450px, 72\.5dvh, 900px\);/s);
  assert.match(styles, /\.project-extra-work-photo-modal-stage img \{[^}]*position:\s*absolute;[^}]*inset:\s*14px;[^}]*object-fit:\s*contain;/s);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*\.project-extra-work-photo-modal \{[^}]*width:\s*calc\(100vw - 28px\);[^}]*height:\s*min\(92dvh, calc\(100dvh - 28px\)\);/s);
});

test("photo document selection is a separate accessible control with signed locks and rollback", () => {
  assert.match(apiSource, /updateSiteExtraWorkTicketPhotoSelection[\s\S]*customer-document-selection[\s\S]*method: "PATCH"/);
  assert.match(pageSource, /project-extra-work-photo-selection-badge/);
  assert.match(pageSource, /event\.stopPropagation\(\);[\s\S]*onToggleSelection\(photo\)/);
  assert.match(pageSource, /disabled=\{photo\.signed_document_member \|\| selectionPending\}/);
  assert.match(pageSource, /Im unterschriebenen Dokument/);
  assert.match(pageSource, /Nicht im Dokument/);
  assert.match(pageSource, /Nicht mitsenden/);
  assert.match(pageSource, /setSelectionError\(readApiError/);
  assert.match(pageSource, /Fotos im unterschriebenen Dokument ·/);
  assert.match(styles, /\.project-extra-work-photo-wrap\.is-excluded[\s\S]*opacity:\s*0\.55/);
  assert.match(styles, /\.project-extra-work-photo-selection-badge:focus-visible/);
});
