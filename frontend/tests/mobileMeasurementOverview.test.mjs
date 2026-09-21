import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source = await readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/pages/MobileMeasurementOverview.css", import.meta.url), "utf8");
const sharedStyles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const overview = source.slice(source.indexOf("function MeasurementBatchOverview("), source.indexOf("type MeasurementPhotoPreview"));
const measurementTab = source.slice(source.indexOf("function MobileMeasurementTab("), source.indexOf("function MeasurementBatchOverview("));
const openPhoto = measurementTab.slice(measurementTab.indexOf("  function openPhotoCapture("), measurementTab.indexOf("  async function handlePhotoInputChange("));
const photoControls = measurementTab.slice(measurementTab.indexOf("  const photoSourceControls ="), measurementTab.indexOf("  async function handleCreateFreePosition("));
const helpers = ["MobileOverviewPhotoAction", "MobileCameraButton", "formatMeasurementNumber", "formatMobileMeasurementBatchTitle", "getMobileMeasurementPdfFilename", "getDocumentEmailSendHint", "getMobileCustomerEmailStatus"]
  .map(name => source.match(new RegExp(`^function ${name}\\([^]*?^}\\n`, "m"))[0]).join("\n");
const compiled = await build({
  stdin: {
    contents: `import React,{useState,useEffect} from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
      import {ArrowLeft,Send,ClipboardList,FileText,UserRound,CheckCircle2,Mail,MailCheck,MailX,AlertTriangle,Images,Camera} from 'lucide-react';
      const getMobileMeasurementBatchStatusBadge = batch => ({label:batch.status,className:'test-status'});
      const formatMobileMeasurementBatchDate = () => '21.09.2026';
      ${helpers}\n${overview}
      export const render = props => renderToStaticMarkup(React.createElement(MeasurementBatchOverview,props));
      export function photoFlow({uploading=false,count=0,open=true}={}) {
        const events=[]; const isUploadingPhoto=uploading; const isPhotoSourceDialogOpen=open;
        const MOBILE_DOCUMENT_PHOTO_LIMIT=5;
        const setPhotoUploadBatch=value=>events.push(['target',value]);
        const setPhotoMessage=value=>events.push(['message',value]);
        const setPhotoMessageTone=value=>events.push(['tone',value]);
        const setIsPhotoSourceDialogOpen=value=>events.push(['dialog',value]);
        const photoInputRef={current:{click:()=>events.push(['camera'])}};
        const photoLibraryInputRef={current:{click:()=>events.push(['library'])}};
        const handlePhotoInputChange=()=>{};
        const ExtraWorkPhotoSourceDialog=()=>null;
        ${openPhoto}\n${photoControls}
        return {request:()=>openPhotoCapture({id:1,photo_count:count}),controls:photoSourceControls,events};
      }`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx",
  },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic",
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const render = (batch = {}, props = {}) => module.exports.render({
  assignmentId: 1, siteNumber: "9999", photoLimit: 5,
  batch: { id: 1, number: 28, status: "draft", entry_count: 1, position_count: 1, reported_hours: "0", photo_count: 0, ...batch },
  customerSignatureDisabled: true, customerSignatureHint: "Prüfung durch Projektleiter erforderlich.",
  ...props,
});

test("measurement overview uses one joined action list and a compact title/status heading", () => {
  const html = render();
  assert.match(html, /is-measurement-overview/);
  assert.match(html, /mobile-measurement-summary-heading"><h2>Aufmaß 9999.28<\/h2><span/);
  assert.doesNotMatch(html, /mobile-customer-email-status|mobile-measurement-summary-status-row/);
  for (const title of ["Aufmaßpositionen erfassen", "Aufmaß anzeigen (PDF)", "Kundenunterschrift einfügen", "Monteursunterschrift einfügen", "Kunden-E-Mail", "Per E-Mail senden", "Hinterlegte Fotos"]) {
    assert.ok(html.includes(title));
  }
  assert.match(html, /<small>Prüfung durch Projektleiter erforderlich\.<\/small>/);
  assert.match(styles, /mobile-measurement-overview-actions \{\s*grid-template-columns: minmax\(0, 1fr\);\s*gap: 0;/);
  assert.match(styles, /mobile-measurement-summary-card \{[^}]*border: 1px solid #d7e3f0;[^}]*border-radius: 7px;[^}]*background: #ffffff;[^}]*padding: 12px 14px;[^}]*box-shadow: none;/s);
});

test("overview preserves submission restrictions, loading states and completed signatures", () => {
  const submitTag = html => html.match(/<button[^>]*mobile-measurement-submit-action[^>]*>/)[0];
  assert.doesNotMatch(submitTag(render()), /disabled/);
  for (const batch of [{ entry_count: 0 }, { status: "submitted" }, { is_locked_for_worker: true }]) {
    assert.match(submitTag(render(batch)), /disabled/);
  }
  assert.match(submitTag(render({}, { isSaving: true })), /disabled/);
  const signed = render({ customer_signed_at: "2026-09-21", worker_signed_at: "2026-09-21", photo_count: 5 });
  assert.match(signed, /Kundenunterschrift vorhanden/);
  assert.match(signed, /Monteursunterschrift vorhanden/);
  assert.doesNotMatch(signed, /Prüfung durch Projektleiter erforderlich/);
  assert.match(signed, /aria-label="Foto aufnehmen"[^>]*disabled/);
  assert.match(render({}, { isItemsLoading: true, isOpeningPdf: true }), /Positionen laden/);
  assert.match(render({}, { isItemsLoading: true, isOpeningPdf: true }), /PDF wird geöffnet/);
});

test("email status remains accessible at the send action in all delivery states", () => {
  assert.match(render(), /mobile-measurement-email-indicator is-not-sent" role="img" aria-label="Mail nicht an Kunden gesendet"/);
  assert.match(render({ customer_email_sent_at: "2026-09-21" }), /mobile-measurement-email-indicator is-signature-open/);
  assert.match(render({ customer_email_sent_at: "2026-09-21", customer_signed_at: "2026-09-21" }), /mobile-measurement-email-indicator is-complete/);
  assert.match(overview, /disabled=\{!emailSendPrerequisitesMet \|\| isSendingEmail \|\| isLoadingEmailRecipients\}/);
  assert.match(overview, /<DocumentEmailSendDialog/);
  for (const handler of ["onBack", "onSubmit", "onOpenPositions", "onOpenPdf", "onCustomerSignature", "onWorkerSignature"]) {
    assert.ok(overview.includes(`onClick={${handler}}`));
  }
  assert.match(overview, /onOpenPhotos=\{onOpenPhotos\}/);
  assert.match(overview, /onTakePhoto=\{onTakePhoto\}/);
});

test("measurement photo action offers camera and library before opening the respective input", () => {
  const flow = module.exports.photoFlow();
  flow.request();
  assert.deepEqual(flow.events.at(-1), ["dialog", true]);
  assert.ok(!flow.events.some(([type]) => type === "camera" || type === "library"));
  const [dialog, camera, library] = flow.controls.props.children;
  assert.equal(camera.props.capture, "environment");
  assert.equal(library.props.capture, undefined);
  assert.equal(camera.props.accept, "image/*");
  assert.equal(library.props.accept, "image/*");
  dialog.props.onTakePhoto();
  assert.deepEqual(flow.events.slice(-2), [["dialog", false], ["camera"]]);
  dialog.props.onChoosePhoto();
  assert.deepEqual(flow.events.slice(-2), [["dialog", false], ["library"]]);
  dialog.props.onClose();
  assert.deepEqual(flow.events.slice(-2), [["dialog", false], ["target", null]]);
  assert.equal((measurementTab.match(/\{photoSourceControls\}/g) ?? []).length, 2);
  assert.match(sharedStyles, /mobile-extra-work-photo-source-dialog \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
  assert.match(sharedStyles, /mobile-extra-work-photo-source-actions button \{[^}]*min-width: 0;[^}]*white-space: normal;/s);
});

test("photo source selection retains upload and five-photo guards", () => {
  const uploading = module.exports.photoFlow({uploading:true});
  uploading.request();
  assert.deepEqual(uploading.events, []);
  const limit = module.exports.photoFlow({count:5});
  limit.request();
  assert.deepEqual(limit.events, [["message", "Maximal 5 Fotos pro Aufmaß erlaubt."], ["tone", "error"]]);
  assert.match(measurementTab, /prepareMeasurementPhotoFile\(file\)/);
  assert.match(measurementTab, /api.uploadMobileMeasurementBatchPhoto\(assignment.id, batch.id, uploadFile\)/);
});

test("locked overview has an orange notice and an unframed back action", () => {
  assert.match(render({is_locked_for_worker:true}), /form-info mobile-measurement-lock-notice/);
  assert.match(styles, /mobile-measurement-lock-notice \{\s*border-color: #d88925;\s*background: #fff4e5;\s*color: #8a4b12;/);
  assert.match(styles, /mobile-back-button \{\s*border: 0;\s*background: transparent;/);
});

test("all mobile measurement lock notices share the same orange presentation", () => {
  const notices = source.match(/<p className="[^"]*">Dieses Aufmaß wurde vom Kunden unterschrieben und ist für Monteure gesperrt\.<\/p>/g);
  assert.equal(notices.length, 4);
  assert.ok(notices.every(notice => notice.includes('className="form-info mobile-measurement-lock-notice"')));
  assert.match(styles, /\.app-shell\.is-mobile-workspace \.mobile-measurement-lock-notice \{/);
});
