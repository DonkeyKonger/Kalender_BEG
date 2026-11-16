import assert from "node:assert/strict";
import test from "node:test";

import { buildNamedPdfCachePath, parseContentDispositionFilename, showNamedPdfPreview } from "../src/lib/namedBlob.ts";

test("reads UTF-8 filenames from Content-Disposition and prefers filename star", () => {
  assert.equal(
    parseContentDispositionFilename(
      "attachment; filename=legacy.pdf; filename*=UTF-8''8031.03_261103_CHC_Emden.pdf",
    ),
    "8031.03_261103_CHC_Emden.pdf",
  );
  assert.equal(
    parseContentDispositionFilename(
      "inline; filename*=UTF-8'de'8031.Z03_261103_CHC%20Emden.pdf",
    ),
    "8031.Z03_261103_CHC Emden.pdf",
  );
});

test("supports quoted fallback filenames including escaped characters and semicolons", () => {
  assert.equal(
    parseContentDispositionFilename('attachment; filename="8031.03_261103_CHC; \\"Emden\\".pdf"'),
    '8031.03_261103_CHC; "Emden".pdf',
  );
  assert.equal(
    parseContentDispositionFilename("attachment; filename=8031.Z03_261103_CHC_Emden.pdf"),
    "8031.Z03_261103_CHC_Emden.pdf",
  );
});

test("rejects malformed extended values safely and sanitizes fallback paths", () => {
  assert.equal(
    parseContentDispositionFilename(
      "attachment; filename=../safe-name.pdf; filename*=UTF-8''broken%ZZname.pdf",
    ),
    "safe-name.pdf",
  );
  assert.equal(
    parseContentDispositionFilename('attachment; filename="..\\folder\\safe\u0000-name.pdf"'),
    "safe-name.pdf",
  );
  assert.equal(parseContentDispositionFilename(null), null);
  assert.equal(parseContentDispositionFilename("inline"), null);
});

test("Android cache isolation keeps the server filename as the opened file basename", () => {
  assert.equal(
    buildNamedPdfCachePath("8031.Z03_261103_CHC_Emden.pdf", 123456),
    "pdf-cache/123456/8031.Z03_261103_CHC_Emden.pdf",
  );
  assert.equal(
    buildNamedPdfCachePath("../8031.03_261103_CHC_Emden.pdf", 123456),
    "pdf-cache/123456/8031.03_261103_CHC_Emden.pdf",
  );
  const longCanonicalName = `8031.03_261103_${"Ärztehaus (Umbau) & Co. 'Nord' ".repeat(4)}.pdf`;
  assert.equal(
    buildNamedPdfCachePath(longCanonicalName, 123456),
    `pdf-cache/123456/${longCanonicalName}`,
  );
});

test("named PDF preview uses safe text, an explicit download name and close-time URL cleanup", () => {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const revoked = [];
  URL.createObjectURL = () => "blob:named-preview";
  URL.revokeObjectURL = (url) => revoked.push(url);

  try {
    const targetWindow = createFakePreviewWindow();
    const filename = `8031.03_261103_<img src=x onerror=alert(1)> & Ärztehaus.pdf`;
    const dispose = showNamedPdfPreview(targetWindow, new Blob(["pdf"], { type: "application/pdf" }), filename);

    assert.equal(targetWindow.opener, null);
    assert.equal(targetWindow.document.title, filename);
    assert.equal(targetWindow.document.documentElement.lang, "de");

    const [header, frame] = targetWindow.document.body.children;
    const [title, download, close] = header.children;
    assert.equal(title.textContent, filename);
    assert.equal(title.children.length, 0, "filename is assigned as text instead of parsed markup");
    assert.equal(download.href, "blob:named-preview");
    assert.equal(download.download, filename);
    assert.equal(frame.src, "blob:named-preview");
    assert.equal(frame.title, `PDF-Vorschau ${filename}`);
    assert.equal(close.focused, true);

    close.dispatch("click");
    assert.equal(targetWindow.closed, true);
    assert.deepEqual(revoked, ["blob:named-preview"]);
    dispose();
    assert.deepEqual(revoked, ["blob:named-preview"], "cleanup stays idempotent");
  } finally {
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

function createFakePreviewWindow() {
  const document = {
    title: "",
    documentElement: { lang: "" },
    head: new FakeElement("head"),
    body: new FakeElement("body"),
    createElement: (tagName) => new FakeElement(tagName),
  };
  const listeners = new Map();
  return {
    document,
    opener: {},
    closed: false,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    close() {
      this.closed = true;
    },
  };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.focused = false;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  focus() {
    this.focused = true;
  }

  dispatch(type) {
    this.listeners.get(type)?.();
  }
}
