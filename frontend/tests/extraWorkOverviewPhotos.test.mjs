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

  assert.match(pageSource, /<ExtraWorkOverviewPhotos[\s\S]*key=\{`\$\{ticket\.id\}/);
  const emptyCountGuard = previewSource.slice(
    previewSource.indexOf("if (ticket.photo_count <= 0)"),
    previewSource.indexOf("void loadExtraWorkOverviewPhotoList"),
  );
  assert.match(emptyCountGuard, /setPhotos\(\[\]\)/);
  assert.doesNotMatch(emptyCountGuard, /siteExtraWorkTicketPhotos/);
  assert.match(previewSource, /api\.siteExtraWorkTicketPhotos\(siteId, ticket\.id/);
  assert.match(previewSource, /api\.siteExtraWorkTicketPhotoThumbnail/);
  assert.match(previewSource, /let active = true/);
  assert.match(previewSource, /if \(active\) \{[\s\S]*setPhotos\(loadedPhotos\)/);
  assert.doesNotMatch(previewSource, /siteExtraWorkTicketPhotoContent/);
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
  assert.match(previewSource, /aria-label=\{`Freier Fotoplatz \$\{index \+ 1\} von 5`\}/);
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
  const thumbnailSource = pageSource.slice(thumbnailStart, pageSource.indexOf("function MeasurementTab", thumbnailStart));

  assert.match(optimizerSource, /DOCUMENT_PHOTO_THUMBNAIL_SIZE = 320/);
  assert.match(apiSource, /siteExtraWorkTicketPhotoThumbnail[\s\S]*\/thumbnail/);
  assert.match(thumbnailSource, /<img src=\{thumbnailUrl\} alt=\{accessibleName\} loading="eager" decoding="async" \/>/);
  assert.match(thumbnailSource, /title=\{photo\.filename\}/);
});
