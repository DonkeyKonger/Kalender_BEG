import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXTRA_WORK_CHECKBOX_RECTS,
  EXTRA_WORK_PDF_FIELD_RECTS,
  EXTRA_WORK_PDF_FORM_LINE_Y,
  EXTRA_WORK_PDF_HEIGHT,
  EXTRA_WORK_PDF_TEXTAREA_LAYOUTS,
  EXTRA_WORK_PDF_WIDTH,
  buildExtraWorkDocumentPayload,
  chunkExtraWorkWorkerRows,
  createEmptyExtraWorkWorkerRow,
  createExtraWorkDocumentDraft,
  extraWorkPdfLineRect,
  extraWorkPdfPointsToCqw,
  extraWorkPdfRectToPercent,
  formatExtraWorkSignaturePlace,
  getExtraWorkHourRect,
  getExtraWorkWorkerNameRect,
  isExtraWorkDocumentLocked,
  parseExtraWorkNumericValue,
} from "../src/lib/extraWorkDocument.ts";
import {
  SIGNATURE_SVG_HEIGHT,
  SIGNATURE_SVG_WIDTH,
  signatureStrokeToSvgPoints,
  validSignatureStrokes,
} from "../src/lib/signatureCanvas.ts";

const [pageSource, componentSource, mobileSource, apiSource, typeSource, styles, pdfServiceSource] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/SupplementaryOrderDetail.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/types/site.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../../backend/app/services/extra_work_pdf_service.py", import.meta.url), "utf8"),
]);

function ticket(overrides = {}) {
  return {
    id: 7,
    site_id: 3,
    sequence_number: 1,
    display_number: "9999.01",
    title: null,
    kind: "billing",
    approval_ticket_id: null,
    status: "draft",
    created_by_user_id: 2,
    created_by_name: "Büro Test",
    submitted_by_user_id: null,
    submitted_at: null,
    notes: null,
    ordered_by_name: null,
    ordered_by_company: null,
    billing_type: null,
    estimated_order_value: null,
    material_required: null,
    material_separate_attachment: null,
    executed_by_lead_monteur: null,
    executed_by_monteur: null,
    executed_by_helper: null,
    executor_other_name: null,
    work_description: null,
    manual_order_date: null,
    manual_execution_week: null,
    manual_execution_week_year: null,
    manual_execution_start: null,
    manual_execution_end: null,
    customer_signature_type: null,
    customer_signature_name: null,
    customer_signature_place: null,
    customer_signed_at: null,
    customer_email_sent_at: null,
    customer_email_signature_present: null,
    worker_signature_name: null,
    worker_signature_place: null,
    worker_signature_date: null,
    worker_signed_at: null,
    deleted_at: null,
    deleted_by_user_id: null,
    deleted_by_name: null,
    entry_count: 0,
    photo_count: 0,
    total_hours: 0,
    estimated_hours: null,
    created_at: "2026-08-19T08:15:00Z",
    updated_at: "2026-08-19T08:15:00Z",
    ...overrides,
  };
}

function entry(workerRows) {
  return {
    id: 11,
    ticket_id: 7,
    site_id: 3,
    component: "",
    floor: "",
    room_number: null,
    axis: null,
    remarks: null,
    material_text: null,
    estimated_hours: null,
    worker_rows: workerRows,
    total_hours: 0,
    created_by_user_id: 2,
    created_at: "2026-08-19T08:15:00Z",
    updated_at: "2026-08-19T08:15:00Z",
  };
}

function documentRead(overrides = {}) {
  return {
    ticket: ticket(),
    entry: null,
    resolved_dates: {
      order_date: "2026-08-20",
      approval_date: "2026-08-19",
      approval_place: "Bretten",
      execution_start: "2026-08-17",
      execution_end: "2026-08-23",
    },
    worker_signature: { name: null, place: "Bretten", date: null, signed_at: null, strokes: null },
    customer_signature: { type: null, name: null, place: null, signed_at: null, strokes: null },
    ...overrides,
  };
}

test("desktop extra-work creation is permission-gated, persistent, double-click safe and opens the document detail", () => {
  assert.match(pageSource, /extraWorkCreateInFlightRef\.current/);
  assert.match(pageSource, /api\.createSiteExtraWorkTicket\(site\.id\)/);
  assert.match(pageSource, /setSelectedExtraWorkTicket\(created\)/);
  assert.match(pageSource, /canCreate=\{canEditSite\}/);
  assert.match(pageSource, /"\+ Zusatzauftrag erstellen"/);
  assert.match(pageSource, /<SupplementaryOrderDetail/);
  assert.match(pageSource, /onOpenTicket=\{setSelectedExtraWorkTicket\}/);
});

test("opened extra-work records replace the project shell with one exclusive document workspace", () => {
  const exclusiveDetailReturn = pageSource.indexOf('if (activeTab === "extra-work" && selectedExtraWorkTicket)');
  const projectShellReturn = pageSource.indexOf('<section\n      className={`site-detail-page');
  assert.ok(exclusiveDetailReturn >= 0);
  assert.ok(projectShellReturn > exclusiveDetailReturn);
  assert.match(pageSource, /if \(activeTab === "extra-work" && selectedExtraWorkTicket\) \{[\s\S]*return \([\s\S]*<SupplementaryOrderDetail/);
  assert.match(pageSource, /onBack=\{\(\) => \{\s*setSelectedExtraWorkTicket\(null\);\s*setExtraWorkDocumentDirty\(false\);/);
  assert.doesNotMatch(pageSource, /is-extra-work-detail-workspace/);
  assert.match(componentSource, /supplementary-order-detail supplementary-order-document-mode/);
  assert.match(componentSource, /supplementary-order-document-toolbar/);
  assert.doesNotMatch(componentSource, /supplementary-order-sidebar"/);
  assert.doesNotMatch(componentSource, /Zurück zu Zusatzaufträgen/);
  assert.match(componentSource, /appSidebar\.inert = true;/);
  assert.match(componentSource, /appSidebar\.setAttribute\("aria-hidden", "true"\);/);
  assert.match(componentSource, /appSidebar\.inert = previousSidebarInert;/);
  assert.match(styles, /body\.supplementary-order-document-open \.app-shell > \.sidebar,[\s\S]*visibility:\s*hidden;/);
});

test("document toolbar owns back, attachment, PDF and save actions without browser fullscreen", () => {
  assert.match(componentSource, /supplementary-order-document-back[\s\S]*Zurück/);
  assert.match(componentSource, /Anlagen \(\{photos\.length\}\)/);
  assert.match(componentSource, /PDF herunterladen/);
  assert.match(componentSource, /isSaving \? "Speichert\.\.\." : "Speichern"/);
  assert.match(componentSource, /Ungespeicherte Änderungen verwerfen und zur Liste zurückkehren/);
  assert.doesNotMatch(componentSource, /requestFullscreen|exitFullscreen/);
  assert.match(styles, /\.supplementary-order-detail\.supplementary-order-document-mode \{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s);
  assert.match(styles, /\.supplementary-order-workspace \{[^}]*overflow:\s*auto;[^}]*overscroll-behavior:\s*contain;/s);
  assert.match(styles, /\.supplementary-order-paper-viewport \{[^}]*overflow:\s*visible;/s);
});

test("site API uses one shared document, template and archived-photo contract", () => {
  assert.match(apiSource, /createSiteExtraWorkTicket[\s\S]*method: "POST"[\s\S]*JSON\.stringify\(\{\}\)/);
  assert.match(apiSource, /siteExtraWorkTicketDocument[\s\S]*\/document\$\{suffix\}/);
  assert.match(apiSource, /saveSiteExtraWorkTicketDocument[\s\S]*method: "PUT"/);
  assert.match(apiSource, /siteExtraWorkTemplate[\s\S]*extra-work-template/);
  assert.match(apiSource, /siteExtraWorkTicketPhotos[\s\S]*include_deleted=true/);
  assert.match(apiSource, /siteExtraWorkTicketPhotoContent[\s\S]*include_deleted=true/);
  assert.match(typeSource, /type ExtraWorkTicketDocumentRead = \{[\s\S]*resolved_dates: ExtraWorkTicketResolvedDates;[\s\S]*worker_signature: ExtraWorkTicketWorkerSignatureRead;[\s\S]*customer_signature: ExtraWorkTicketCustomerSignatureRead;/);
});

test("PDF point rectangles convert proportionally to the A4 overlay coordinate system", () => {
  assert.equal(EXTRA_WORK_PDF_WIDTH, 595.276);
  assert.equal(EXTRA_WORK_PDF_HEIGHT, 841.89);
  const customer = extraWorkPdfRectToPercent(EXTRA_WORK_PDF_FIELD_RECTS.customer);
  assert.ok(Math.abs(customer.left - ((103.2 / 595.276) * 100)) < 1e-10);
  assert.ok(Math.abs(customer.top - (((EXTRA_WORK_PDF_FORM_LINE_Y.customer - 14.173) / 841.89) * 100)) < 1e-10);
  assert.match(componentSource, /annotationMode: pdfjsLib\.AnnotationMode\.DISABLE/);
  assert.match(styles, /\.supplementary-order-paper[\s\S]*container-type: inline-size/);
});

test("classic form-line fields use their PDF line as bottom anchor at every zoom", () => {
  const anchoredFields = [
    ["customer", "customer"],
    ["project", "customer"],
    ["orderedByName", "orderedByName"],
    ["manualOrderDate", "orderedByName"],
    ["orderedByCompany", "orderedByCompany"],
    ["commissionNumber", "orderedByCompany"],
    ["estimatedHours", "estimatedHours"],
    ["estimatedOrderValue", "estimatedHours"],
    ["executorOtherName", "executorOtherName"],
    ["authorizationPlace", "authorizationPlace"],
    ["authorizationDate", "authorizationPlace"],
    ["documentNumber", "documentNumber"],
    ["executionStart", "documentNumber"],
    ["executionEnd", "documentNumber"],
    ["component", "component"],
    ["floor", "component"],
    ["roomNumber", "component"],
    ["axis", "component"],
    ["workerSignaturePlace", "signaturePlace"],
    ["workerSignatureDate", "signaturePlace"],
    ["customerSignaturePlace", "signaturePlace"],
    ["customerSignatureDate", "signaturePlace"],
  ];
  for (const [fieldName, lineName] of anchoredFields) {
    const rect = EXTRA_WORK_PDF_FIELD_RECTS[fieldName];
    const lineY = EXTRA_WORK_PDF_FORM_LINE_Y[lineName];
    assert.ok(Math.abs((rect.y + rect.height) - lineY) < 1e-10, fieldName);
    for (const zoom of [0.25, 0.5, 0.75, 1]) {
      assert.ok(Math.abs(((rect.y + rect.height) * zoom) - (lineY * zoom)) < 1e-10, `${fieldName} at ${zoom}`);
    }
  }
  assert.deepEqual(extraWorkPdfLineRect(10, 30, 40, 12), { x: 10, y: 18, width: 40, height: 12 });
});

test("line anchoring preserves box dimensions and leaves table and checkbox geometry unchanged", () => {
  assert.equal(EXTRA_WORK_PDF_FIELD_RECTS.orderedByName.width, 351.607);
  assert.equal(EXTRA_WORK_PDF_FIELD_RECTS.orderedByName.height, 14.173);
  assert.equal(EXTRA_WORK_PDF_FIELD_RECTS.estimatedHours.width, 111.24);
  assert.equal(EXTRA_WORK_PDF_FIELD_RECTS.estimatedHours.height, 11.339);
  assert.deepEqual(getExtraWorkWorkerNameRect(0), { x: 57.48, y: 446.97, width: 101.76, height: 45.72 });
  assert.deepEqual(getExtraWorkHourRect(0, "normal", 0), { x: 184.68, y: 446.25, width: 21.36, height: 14.52 });
  assert.deepEqual(EXTRA_WORK_CHECKBOX_RECTS.billingHourly, { x: 230, y: 215, width: 16, height: 16 });
  assert.deepEqual(EXTRA_WORK_PDF_FIELD_RECTS.remarks, { x: 416.476, y: 445.923, width: 136.08, height: 176.76 });
  assert.deepEqual(EXTRA_WORK_PDF_FIELD_RECTS.materialText, { x: 62.76, y: 641.85, width: 484.92, height: 54.819 });
});

test("the ruled material editor shares the final PDF typography and three-line capacity", () => {
  const materialRect = EXTRA_WORK_PDF_FIELD_RECTS.materialText;
  const materialLayout = EXTRA_WORK_PDF_TEXTAREA_LAYOUTS.materialText;
  assert.deepEqual(materialLayout, {
    fontSize: 8,
    lineHeight: 18,
    paddingTop: 0,
    paddingInline: 2,
    maxLines: 3,
  });
  assert.ok(materialRect.height >= materialLayout.lineHeight * materialLayout.maxLines);
  assert.ok(materialRect.height < materialLayout.lineHeight * (materialLayout.maxLines + 1));
  assert.equal(extraWorkPdfPointsToCqw(18), (18 / EXTRA_WORK_PDF_WIDTH) * 100);
  assert.match(
    pdfServiceSource,
    /FIELD_RECTS\["Material"\],[\s\S]*entry\.material_text or "",[\s\S]*size=8,[\s\S]*max_lines=3,[\s\S]*line_height=18/,
  );
});

test("the material textarea scales with the paper, preserves wrapping and warns without clipping data", () => {
  assert.match(componentSource, /layout=\{EXTRA_WORK_PDF_TEXTAREA_LAYOUTS\.materialText\}/);
  assert.match(componentSource, /--pdf-textarea-font-size[\s\S]*extraWorkPdfPointsToCqw\(layout\.fontSize\)/);
  assert.match(componentSource, /textarea\.scrollHeight > textarea\.clientHeight \+ 1/);
  assert.match(componentSource, /new ResizeObserver\(updateOverflow\)/);
  assert.match(componentSource, /Mehr als \{layout\?\.maxLines\} Druckzeilen/);
  assert.match(styles, /\.supplementary-order-paper-field\.is-pdf-line-grid textarea \{[\s\S]*font-size: var\(--pdf-textarea-font-size\);[\s\S]*line-height: var\(--pdf-textarea-line-height\);[\s\S]*padding: var\(--pdf-textarea-padding-top\) var\(--pdf-textarea-padding-inline\) 0;[\s\S]*white-space: pre-wrap;/);
  assert.match(styles, /\.supplementary-order-paper-field\.is-pdf-line-grid\.has-overflow textarea \{[\s\S]*overflow-y: auto;/);
  assert.match(styles, /\.supplementary-order-paper-field textarea \{[\s\S]*resize: none;/);
  const lineGridRule = styles.match(/\.supplementary-order-paper-field\.is-pdf-line-grid textarea \{([^}]*)\}/)?.[1] ?? "";
  assert.doesNotMatch(lineGridRule, /background-image|linear-gradient/);
});

test("legacy defaults match the PDF fallback while visible dates come only from the server resolver", () => {
  const draft = createExtraWorkDocumentDraft(documentRead(), {
    orderedByCompanyFallback: "Kunde GmbH",
    orderedByNameFallback: "Besteller Alt",
  });
  assert.equal(draft.billing_type, "hourly");
  assert.equal(draft.material_required, false);
  assert.equal(draft.executed_by_monteur, true);
  assert.equal(draft.ordered_by_company, "Kunde GmbH");
  assert.equal(draft.ordered_by_name, "Besteller Alt");
  assert.equal(draft.manual_order_date, "2026-08-20");
  assert.equal(draft.manual_execution_start, "2026-08-17");
  assert.equal(draft.manual_execution_end, "2026-08-23");
  assert.equal(draft.worker_signature_place, "Bretten");
  assert.equal(formatExtraWorkSignaturePlace("Am Kurpark 1, 49214 Bad Rothenfelde"), "Bad Rothenfelde");

  const explicitLegacyFalseDraft = createExtraWorkDocumentDraft(documentRead({
    ticket: ticket({
      executed_by_lead_monteur: false,
      executed_by_monteur: false,
      executed_by_helper: false,
    }),
  }));
  assert.equal(explicitLegacyFalseDraft.executed_by_monteur, false);

  const weekTicket = ticket({ manual_execution_week: 1, manual_execution_week_year: 2025 });
  const weekDraft = createExtraWorkDocumentDraft(documentRead({
    ticket: weekTicket,
    resolved_dates: { ...documentRead().resolved_dates, execution_start: "2024-12-30", execution_end: "2025-01-05" },
  }));
  assert.equal(weekDraft.manual_execution_start, "2024-12-30");
  assert.equal(weekDraft.manual_execution_end, "2025-01-05");
  const untouchedPayload = buildExtraWorkDocumentPayload(weekDraft, 0, {
    originalTicket: weekTicket,
    dirtyFields: new Set(),
  });
  assert.equal(untouchedPayload.manual_execution_week, 1);
  assert.equal(untouchedPayload.manual_execution_week_year, 2025);
  assert.equal(untouchedPayload.manual_execution_start, null);
  assert.equal(untouchedPayload.manual_execution_end, null);
  const editedPayload = buildExtraWorkDocumentPayload(weekDraft, 0, {
    executionRangeEdited: true,
    originalTicket: weekTicket,
    dirtyFields: new Set(["manual_execution_start", "manual_execution_end"]),
  });
  assert.equal(editedPayload.manual_execution_week, null);
  assert.equal(editedPayload.manual_execution_week_year, null);
});

test("German decimal input becomes numeric payload and multiline text is preserved exactly", () => {
  const draft = createExtraWorkDocumentDraft(documentRead());
  draft.estimated_order_value = "1234,50";
  draft.entry.estimated_hours = "8,25";
  draft.work_description = "  Erste Zeile\nZweite Zeile  ";
  draft.entry.remarks = "  Hinweis\nmit Umbruch  ";
  draft.entry.material_text = "  Kabel\nKlemmen  ";
  draft.entry.worker_rows[0].worker_name = "Monteur Eins";
  draft.entry.worker_rows[0].monday_hours = "1,5";
  draft.entry.worker_rows[0].monday_surcharge_25_hours = "0,25";
  const payload = buildExtraWorkDocumentPayload(draft, 0);

  assert.equal(payload.estimated_order_value, 1234.5);
  assert.equal(payload.entry.estimated_hours, 8.25);
  assert.equal(payload.entry.worker_rows[0].monday_hours, 1.5);
  assert.equal(payload.entry.worker_rows[0].monday_surcharge_25_hours, 0.25);
  assert.equal(payload.work_description, draft.work_description);
  assert.equal(payload.entry.remarks, draft.entry.remarks);
  assert.equal(payload.entry.material_text, draft.entry.material_text);
  assert.throws(() => parseExtraWorkNumericValue("1,2,3", "Stunden"), /gültige positive Zahl/);
  assert.equal(parseExtraWorkNumericValue("1.250,50", "Auftragswert", { allowGermanGrouping: true }), 1250.5);
});

test("server numeric values are displayed in German without changing their numeric save value", () => {
  const numericDraft = createExtraWorkDocumentDraft(documentRead({
    ticket: ticket({ estimated_order_value: 1250.5 }),
    entry: entry([{ ...createEmptyExtraWorkWorkerRow(), worker_name: "Marta", monday_hours: 8.5 }]),
  }));
  assert.equal(numericDraft.estimated_order_value, "1.250,50");
  assert.equal(numericDraft.entry.worker_rows[0].monday_hours, "8,5");
  const payload = buildExtraWorkDocumentPayload(numericDraft, 1);
  assert.equal(payload.estimated_order_value, 1250.5);
  assert.equal(payload.entry.worker_rows[0].monday_hours, 8.5);
});

test("display-only legacy fallbacks remain null when only the title is edited", () => {
  const originalTicket = ticket();
  const draft = createExtraWorkDocumentDraft(documentRead({ ticket: originalTicket }), {
    orderedByNameFallback: "Besteller Alt",
    orderedByCompanyFallback: "Kunde GmbH",
  });
  draft.title = "Neue Bezeichnung";
  const payload = buildExtraWorkDocumentPayload(draft, 0, {
    originalTicket,
    dirtyFields: new Set(["title"]),
  });
  assert.equal(payload.title, "Neue Bezeichnung");
  assert.equal(payload.ordered_by_name, null);
  assert.equal(payload.ordered_by_company, null);
  assert.equal(payload.billing_type, null);
  assert.equal(payload.material_required, null);
  assert.equal(payload.material_separate_attachment, null);
  assert.equal(payload.executed_by_lead_monteur, null);
  assert.equal(payload.executed_by_monteur, null);
  assert.equal(payload.executed_by_helper, null);
  assert.equal(payload.manual_order_date, null);
  assert.equal(payload.worker_signature_place, null);
  assert.equal(payload.worker_signature_date, null);
  assert.equal(payload.worker_signature_strokes, null);
});

test("empty new worker slots are removed while all loaded rows beyond the paper remain intact", () => {
  const originalRows = Array.from({ length: 4 }, (_, index) => ({
    ...createEmptyExtraWorkWorkerRow(),
    worker_name: index === 3 ? "Folgeseite" : `Monteur ${index + 1}`,
  }));
  const legacyDraft = createExtraWorkDocumentDraft(documentRead({ ticket: ticket(), entry: entry(originalRows) }));
  legacyDraft.entry.worker_rows[3].monday_surcharge_50_hours = "1,5";
  const pages = chunkExtraWorkWorkerRows(legacyDraft.entry.worker_rows);
  assert.equal(pages.length, 2);
  assert.equal(pages[1][0].worker_name, "Folgeseite");
  assert.equal(pages[1][0].monday_surcharge_50_hours, "1,5");
  const legacyPayload = buildExtraWorkDocumentPayload(legacyDraft, 4);
  assert.equal(legacyPayload.entry.worker_rows.length, 4);
  assert.equal(legacyPayload.entry.worker_rows[3].worker_name, "Folgeseite");
  assert.equal(legacyPayload.entry.worker_rows[3].monday_surcharge_50_hours, 1.5);

  const newDraft = createExtraWorkDocumentDraft(documentRead());
  newDraft.entry.worker_rows[0].worker_name = "Neu";
  const newPayload = buildExtraWorkDocumentPayload(newDraft, 0);
  assert.equal(newPayload.entry.worker_rows.length, 1);
});

test("submitted and worker-signed records stay editable but permission, customer signature, archive and terminal status lock", () => {
  assert.equal(isExtraWorkDocumentLocked(ticket({ status: "submitted" }), true), false);
  assert.equal(isExtraWorkDocumentLocked(ticket({ worker_signed_at: "2026-08-19T09:00:00Z" }), true), false);
  assert.equal(isExtraWorkDocumentLocked(ticket(), false), true);
  assert.equal(isExtraWorkDocumentLocked(ticket({ customer_signed_at: "2026-08-19T09:00:00Z" }), true), true);
  assert.equal(isExtraWorkDocumentLocked(ticket({ deleted_at: "2026-08-19T09:00:00Z" }), true), true);
  assert.equal(isExtraWorkDocumentLocked(ticket({ status: "billed" }), true), true);
});

test("detail has explicit save, dirty guards, annotation-free canvas and no archived PDF action", () => {
  assert.match(componentSource, /api\.saveSiteExtraWorkTicketDocument/);
  assert.match(componentSource, /Ungespeicherte Änderungen verwerfen/);
  assert.match(componentSource, /beforeunload/);
  assert.equal(componentSource.match(/disabled=\{pdfBusy \|\| isDirty\}/g)?.length, 1);
  assert.match(componentSource, /Vor dem PDF-Download zuerst speichern/);
  assert.match(componentSource, /!documentTicket\.deleted_at \? \(/);
  assert.match(componentSource, /siteExtraWorkTicketPhotos\(site\.id, ticket\.id, \{ includeDeleted \}\)/);
  assert.match(componentSource, /type="text"[\s\S]*inputMode="decimal"[\s\S]*pattern="\[0-9\]\+\(\[,.\]\[0-9\]\+\)\?"/);
});

test("paper preview mirrors multi-page PDF chunks, document numbering, totals and signatures", () => {
  assert.match(componentSource, /chunkExtraWorkWorkerRows\(draft\?\.entry\.worker_rows/);
  assert.match(componentSource, /pageIndex \* EXTRA_WORK_VISIBLE_WORKER_ROWS/);
  assert.match(componentSource, /getExtraWorkOverallHours\(workers\)/);
  assert.match(componentSource, /`\$\{ticket\.display_number\} \/ Blatt \$\{pageIndex \+ 1\}`/);
  assert.match(componentSource, /isLastPage \? \(/);
  assert.match(componentSource, /function PaperSignature/);
  assert.match(componentSource, /draft\.worker_signature_strokes/);
  assert.match(componentSource, /document\.customer_signature\.strokes/);
  assert.match(componentSource, /document\.resolved_dates\.approval_date/);
  assert.match(componentSource, /EXTRA_WORK_PDF_FIELD_RECTS\.title/);
  assert.match(componentSource, /if \(value <= 0\) \{\s*return "";/);
});

test("the incorrect upper work-description textarea is absent from both rects and the React tree", () => {
  assert.equal("workDescription" in EXTRA_WORK_PDF_FIELD_RECTS, false);
  assert.doesNotMatch(componentSource, /EXTRA_WORK_PDF_FIELD_RECTS\.workDescription/);
  assert.doesNotMatch(componentSource, /label="Beschreibung der auszuführenden Arbeiten"/);
});

test("editable text fields keep their Acrobat highlight while paper choices stay transparent", () => {
  assert.match(styles, /\.supplementary-order-paper-field input,[\s\S]*border: 1px solid transparent;[\s\S]*background: transparent;/);
  assert.match(styles, /\.supplementary-order-paper-field\.is-editable input,[\s\S]*background: rgb\(190 215 250 \/ 26%\);/);
  assert.match(styles, /\.supplementary-order-paper-field input:hover:not\(\[readonly\]\)[\s\S]*background: rgb\(180 210 250 \/ 40%\);/);
  assert.match(styles, /\.supplementary-order-paper-field input\[readonly\],[\s\S]*background: transparent;/);
  assert.match(styles, /\.supplementary-order-paper-choice\.is-editable \{[^}]*border-color: transparent;[^}]*background: transparent;/s);
  assert.match(styles, /\.supplementary-order-paper-choice:hover:not\(:disabled\) \{[^}]*background: transparent;/s);
  assert.match(styles, /\.supplementary-order-paper-choice:focus-visible:not\(:disabled\) \{[^}]*background: transparent;[^}]*outline: 1px solid/s);
  assert.doesNotMatch(styles, /\.supplementary-order-paper-choice\.is-editable \{[^}]*rgb\(190 215 250/s);
  assert.match(componentSource, /className=\{`supplementary-order-paper-choice[^`]*`\}[\s\S]*aria-pressed=\{selected\}[\s\S]*onClick=\{onSelect\}/);
  assert.match(componentSource, /autoComplete="off"/);
  assert.match(componentSource, /className="supplementary-order-paper-signature"/);
});

test("desktop worker signature reuses normalized mobile strokes with a proportional non-black renderer", () => {
  const strokes = validSignatureStrokes([
    [{ x: 0.1, y: 0.2 }, { x: 0.75, y: 0.8 }],
    [{ x: Number.NaN, y: 0.2 }],
  ]);
  assert.equal(strokes.length, 1);
  assert.equal(SIGNATURE_SVG_WIDTH / SIGNATURE_SVG_HEIGHT, 3);
  assert.equal(signatureStrokeToSvgPoints(strokes[0]), "120,80 900,320");
  assert.match(componentSource, /preserveAspectRatio="xMidYMid meet"/);
  assert.doesNotMatch(componentSource, /viewBox="0 0 1 1"/);
  assert.match(componentSource, /function WorkerSignatureDialog/);
  assert.match(componentSource, /onPointerDown=\{startStroke\}/);
  assert.match(componentSource, /onPointerMove=\{appendPoint\}/);
  assert.match(componentSource, /onPointerUp=\{finishStroke\}/);
  assert.match(componentSource, /onPointerCancel=/);
  assert.match(styles, /\.supplementary-order-signature-canvas[\s\S]*background: transparent;[\s\S]*touch-action: none;/);
  assert.match(mobileSource, /import \{ drawSignatureCanvas, getNormalizedSignaturePoint \} from "\.\.\/lib\/signatureCanvas"/);
});

test("worker signature place, date and strokes share the existing document save payload", () => {
  const originalTicket = ticket();
  const draft = createExtraWorkDocumentDraft(documentRead({ ticket: originalTicket }));
  draft.worker_signature_name = "Max Monteur";
  draft.worker_signature_place = "Bad Rothenfelde";
  draft.worker_signature_date = "2026-08-19";
  draft.worker_signature_strokes = [[{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.7 }]];
  const payload = buildExtraWorkDocumentPayload(draft, 0, {
    originalTicket,
    dirtyFields: new Set(["worker_signature_name", "worker_signature_place", "worker_signature_date", "worker_signature_strokes"]),
  });
  assert.equal(payload.worker_signature_name, "Max Monteur");
  assert.equal(payload.worker_signature_place, "Bad Rothenfelde");
  assert.equal(payload.worker_signature_date, "2026-08-19");
  assert.deepEqual(payload.worker_signature_strokes, draft.worker_signature_strokes);
  assert.match(componentSource, /worker_signature_date: draft\.worker_signature_date \|\| currentLocalDate\(\)/);
});
