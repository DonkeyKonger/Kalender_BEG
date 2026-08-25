import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_EXTRA_WORK_OVERVIEW_PHOTOS,
  loadExtraWorkOverviewPhotoList,
  loadExtraWorkOverviewThumbnail,
} from "../src/lib/extraWorkPhotoPreview.ts";

const [pageSource, apiSource, styles, modelSource, serviceSource] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/models/extra_work_ticket.py", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/services/extra_work_service.py", import.meta.url), "utf8"),
]);

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
  assert.match(previewSource, /if \(ticket\.photo_count <= 0\) \{[\s\S]*return null/);
  assert.match(previewSource, /api\.siteExtraWorkTicketPhotos\(siteId, ticket\.id/);
  assert.match(previewSource, /api\.siteExtraWorkTicketPhotoThumbnail/);
  assert.match(previewSource, /let active = true/);
  assert.match(previewSource, /if \(active\) \{[\s\S]*setPhotos\(loadedPhotos\)/);
  assert.doesNotMatch(previewSource, /siteExtraWorkTicketPhotoContent/);
  assert.match(apiSource, /siteExtraWorkTicketPhotoThumbnail[\s\S]*\/thumbnail/);
});

test("stored thumbnail bytes stay deferred from ticket-list photo loading", () => {
  assert.match(modelSource, /thumbnail_content:[^\n]*mapped_column\(LargeBinary, deferred=True\)/);
  assert.match(serviceSource, /thumbnail_content = create_document_photo_thumbnail\(optimized_photo\.content\)/);
  assert.match(serviceSource, /thumbnail_content=thumbnail_content/);
  assert.match(serviceSource, /if photo\.thumbnail_content:[\s\S]*return \([\s\S]*photo\.thumbnail_content/);
});

test("the quiet preview is square, cover-cropped, right-aligned and responsive", () => {
  assert.match(styles, /\.project-extra-work-photo-preview \{[^}]*justify-content:\s*flex-end/s);
  assert.match(styles, /\.project-extra-work-photo-list \{[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*8px/s);
  assert.match(styles, /\.project-extra-work-photo \{[^}]*width:\s*clamp\(64px, 6vw, 88px\);[^}]*aspect-ratio:\s*1;/s);
  assert.match(styles, /\.project-extra-work-photo img \{[^}]*object-fit:\s*cover/s);
  assert.doesNotMatch(styles, /project-extra-work-photo-preview[^}]*min-height:/s);
});
