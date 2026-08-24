import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXTRA_WORK_PDF_TEXTAREA_LAYOUTS,
  constrainExtraWorkRemarksChange,
  extraWorkRemarksFit,
  extraWorkRemarksTextWidth,
  wrapExtraWorkRemarks,
} from "../src/lib/extraWorkDocument.ts";

const [desktopSource, mobileSource] = await Promise.all([
  readFile(new URL("../src/components/SupplementaryOrderDetail.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8"),
]);

function repeatedWordAtCapacity(word = "Test") {
  let value = "";
  while (true) {
    const candidate = value ? `${value} ${word}` : word;
    if (!extraWorkRemarksFit(candidate)) return value;
    value = candidate;
  }
}

test("repeated Test reaches all 18 printable PDF lines and blocks the first excess character", () => {
  const value = repeatedWordAtCapacity();
  assert.equal(EXTRA_WORK_PDF_TEXTAREA_LAYOUTS.remarks.maxLines, 18);
  assert.equal(wrapExtraWorkRemarks(value).length, 18);
  assert.equal(extraWorkRemarksFit(value), true);

  const next = constrainExtraWorkRemarksChange(value, `${value} Test`);
  assert.equal(next.value, value);
  assert.equal(next.limited, true);
});

test("manual breaks, long words and Helvetica narrow/wide characters use deterministic capacity", () => {
  assert.equal(extraWorkRemarksFit(Array(18).fill("Zeile").join("\n")), true);
  assert.equal(extraWorkRemarksFit(Array(19).fill("Zeile").join("\n")), false);

  const longWord = "W".repeat(400);
  assert.equal(wrapExtraWorkRemarks(longWord).join(""), longWord);
  assert.equal(extraWorkRemarksTextWidth("Test"), 14.5875);
  assert.equal(extraWorkRemarksTextWidth("ÄÖÜ äöü ß €"), 43.77);
  assert.ok(extraWorkRemarksTextWidth("WWWW") > extraWorkRemarksTextWidth("iiii"));
  assert.ok(wrapExtraWorkRemarks("W".repeat(120)).length > wrapExtraWorkRemarks("i".repeat(120)).length);
  assert.ok(repeatedWordAtCapacity("i").length > repeatedWordAtCapacity("W").length);
});

test("an oversized paste keeps only its printable prefix and preserves existing suffix text", () => {
  const pasted = constrainExtraWorkRemarksChange("ENDE", `${"Test ".repeat(1000)}ENDE`);
  assert.equal(pasted.limited, true);
  assert.equal(pasted.value.endsWith("ENDE"), true);
  assert.equal(extraWorkRemarksFit(pasted.value), true);
  assert.equal(extraWorkRemarksFit(`${pasted.value}W`), false);
});

test("legacy overflow is never truncated silently and can be shortened progressively", () => {
  const boundary = repeatedWordAtCapacity();
  const legacy = `${boundary} Test`;
  assert.equal(extraWorkRemarksFit(legacy), false);
  assert.deepEqual(constrainExtraWorkRemarksChange(legacy, `${legacy} W`), {
    value: legacy,
    limited: true,
  });
  const shortened = constrainExtraWorkRemarksChange(legacy, legacy.slice(0, -5));
  assert.equal(shortened.limited, false);
  assert.equal(shortened.value, boundary);
});

test("desktop and mobile editors share the PDF limiter and show explicit feedback", () => {
  assert.match(desktopSource, /pdfCapacity="remarks"/);
  assert.match(desktopSource, /constrainExtraWorkRemarksChange\(value, event\.target\.value\)/);
  assert.match(mobileSource, /constrainExtraWorkRemarksChange\(form\.remarks, requested\)/);
  assert.match(desktopSource, /Maximale Länge für die PDF erreicht/);
  assert.match(mobileSource, /Maximale Länge für die PDF erreicht/);
  assert.match(desktopSource, /Gespeicherter Alttext ist zu lang für die PDF/);
  assert.match(mobileSource, /Gespeicherter Alttext ist zu lang für die PDF/);
});
