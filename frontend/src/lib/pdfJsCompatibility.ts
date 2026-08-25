import legacyPdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

import { installPdfJsLegacyCompatibility } from "./pdfJsLegacyPolyfills";

type PdfJsLegacyModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let compatiblePdfJsLoader: Promise<PdfJsLegacyModule> | null = null;

export function loadCompatiblePdfJs(): Promise<PdfJsLegacyModule> {
  if (!compatiblePdfJsLoader) {
    installPdfJsLegacyCompatibility();
    compatiblePdfJsLoader = import("pdfjs-dist/legacy/build/pdf.mjs")
      .then((pdfjsLib) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = legacyPdfWorkerUrl;
        return pdfjsLib;
      })
      .catch((error) => {
        compatiblePdfJsLoader = null;
        throw error;
      });
  }
  return compatiblePdfJsLoader;
}
