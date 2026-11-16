export type NamedBlob = {
  blob: Blob;
  filename: string | null;
};

export function parseContentDispositionFilename(headerValue: string | null): string | null {
  if (!headerValue) {
    return null;
  }

  const extendedValue = readDispositionParameter(headerValue, "filename*");
  if (extendedValue !== null) {
    const decoded = decodeExtendedFilename(extendedValue);
    if (decoded !== null) {
      const filename = normalizeFilename(decoded);
      if (filename !== null) {
        return filename;
      }
    }
  }

  const fallbackValue = readDispositionParameter(headerValue, "filename");
  return fallbackValue === null ? null : normalizeFilename(fallbackValue);
}

export function createNamedBlobObjectUrl(blob: Blob, filename: string | null): string {
  // Keep the server name as File metadata for consumers that inspect it. Native PDF viewers may
  // still derive their own title from the blob URL, so named previews provide an explicit download.
  const source = filename && typeof File !== "undefined"
    ? new File([blob], filename, {
      type: blob.type || "application/octet-stream",
      lastModified: Date.now(),
    })
    : blob;
  return URL.createObjectURL(source);
}

export function showNamedPdfPreview(targetWindow: Window, blob: Blob, filename: string): () => void {
  const previewUrl = createNamedBlobObjectUrl(blob, filename);
  let disposed = false;

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    targetWindow.removeEventListener("pagehide", dispose);
    targetWindow.removeEventListener("unload", dispose);
    URL.revokeObjectURL(previewUrl);
  };

  targetWindow.opener = null;
  const previewDocument = targetWindow.document;
  previewDocument.documentElement.lang = "de";

  const viewport = previewDocument.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";

  const style = previewDocument.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body { display: flex; flex-direction: column; overflow: hidden; background: #e8edf3; color: #17283a; font: 14px/1.35 Arial, sans-serif; }
    .named-pdf-preview-header { display: grid; grid-template-columns: minmax(0, 1fr) auto 34px; align-items: center; gap: 10px; min-height: 48px; padding: 7px 10px 7px 14px; border-bottom: 1px solid #b9c7d6; background: #fff; }
    .named-pdf-preview-filename { min-width: 0; overflow: hidden; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
    .named-pdf-preview-download { display: inline-flex; align-items: center; justify-content: center; min-height: 32px; padding: 0 12px; border: 1px solid #315f91; border-radius: 0; background: #315f91; color: #fff; font-weight: 700; text-decoration: none; }
    .named-pdf-preview-download:hover, .named-pdf-preview-download:focus-visible { background: #244b75; outline: 2px solid #86a9cd; outline-offset: 1px; }
    .named-pdf-preview-close { width: 34px; height: 32px; padding: 0; border: 1px solid #aebdcb; border-radius: 0; background: #f6f8fa; color: #17283a; font: 22px/1 Arial, sans-serif; cursor: pointer; }
    .named-pdf-preview-close:hover, .named-pdf-preview-close:focus-visible { background: #e4eaf0; outline: 2px solid #86a9cd; outline-offset: 1px; }
    .named-pdf-preview-frame { width: 100%; min-height: 0; flex: 1 1 auto; border: 0; background: #e8edf3; }
    @media (max-width: 480px) {
      .named-pdf-preview-header { grid-template-columns: minmax(0, 1fr) auto 34px; gap: 6px; padding-left: 10px; }
      .named-pdf-preview-download { padding: 0 8px; font-size: 12px; }
    }
    @media print {
      .named-pdf-preview-header { display: none; }
      .named-pdf-preview-frame { width: 100vw; height: 100vh; }
    }
  `;
  previewDocument.head.replaceChildren(viewport, style);
  previewDocument.title = filename;

  const header = previewDocument.createElement("header");
  header.className = "named-pdf-preview-header";

  const title = previewDocument.createElement("div");
  title.className = "named-pdf-preview-filename";
  title.textContent = filename;
  title.title = filename;

  const download = previewDocument.createElement("a");
  download.className = "named-pdf-preview-download";
  download.href = previewUrl;
  download.download = filename;
  download.textContent = "Herunterladen";

  const close = previewDocument.createElement("button");
  close.className = "named-pdf-preview-close";
  close.type = "button";
  close.setAttribute("aria-label", "Vorschau schließen");
  close.title = "Vorschau schließen";
  close.textContent = "×";
  close.addEventListener("click", () => {
    dispose();
    targetWindow.close();
  });

  header.append(title, download, close);

  const frame = previewDocument.createElement("iframe");
  frame.className = "named-pdf-preview-frame";
  frame.src = previewUrl;
  frame.title = `PDF-Vorschau ${filename}`;

  previewDocument.body.replaceChildren(header, frame);
  targetWindow.addEventListener("pagehide", dispose, { once: true });
  targetWindow.addEventListener("unload", dispose, { once: true });
  close.focus();
  return dispose;
}

export function buildNamedPdfCachePath(filename: string, cacheDirectory: number): string {
  const safeFilename = normalizeFilename(filename) ?? "dokument.pdf";
  return `pdf-cache/${cacheDirectory}/${safeFilename}`;
}

function readDispositionParameter(headerValue: string, parameterName: string): string | null {
  const escapedName = parameterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`(?:^|;)\\s*${escapedName}\\s*=\\s*(?:"((?:\\\\.|[^"])*)"|([^;]*))`, "i");
  const match = matcher.exec(headerValue);
  if (!match) {
    return null;
  }
  if (match[1] !== undefined) {
    return match[1].replace(/\\(["\\])/g, "$1");
  }
  return match[2].trim();
}

function decodeExtendedFilename(value: string): string | null {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value.trim());
  if (!match || !/^utf-8$/i.test(match[1])) {
    return null;
  }
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

function normalizeFilename(value: string): string | null {
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const filename = withoutControls.split(/[\\/]/).at(-1)?.trim() ?? "";
  return filename && filename !== "." && filename !== ".." ? filename : null;
}
