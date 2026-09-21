import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source=await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const styles=await readFile(new URL('../src/pages/MobileMeasurementOverview.css',import.meta.url),'utf8');
const overview=source.slice(source.indexOf('function ExtraWorkOrderOverview('),source.indexOf('function ExtraWorkTitleDialog('));
const helpers=['MobileOverviewPhotoAction','MobileCameraButton','getMobileCustomerEmailStatus','getDocumentEmailSendHint','formatMobileExtraWorkOrderTitle','getMobileExtraWorkOrderFixedTitle','getMobileExtraWorkOrderTitleSuffix','formatMobileExtraWorkKindLabel']
  .map(name=>source.match(new RegExp(`^function ${name}\\([^]*?^}\\n`,'m'))[0]).join('\n');
const compiled=await build({stdin:{contents:`import {renderToStaticMarkup} from 'react-dom/server';
  import {ArrowLeft,Send,Pencil,ClipboardList,FileText,UserRound,CheckCircle2,Mail,MailCheck,MailX,AlertTriangle,Images,Camera} from 'lucide-react';
  import {formatExtraWorkHours} from './src/lib/extraWorkHours';
  const EXTRA_WORK_DEFAULT_TITLE_SUFFIX='Hauptauftrag';
  const useAuth=()=>({user:{display_name:'Testmonteur'}});
  const useEffect=()=>{};
  const getMobileExtraWorkOrderStatusBadge=order=>({label:order.status,className:'test-status'});
  const formatMobileExtraWorkOrderDate=()=> '21.09.2026';
  ${helpers}
  export function tree(props,states={}) {
    let index=0;const updates=[];
    const useState=initial=>{const key=index++;return [key in states?states[key]:initial,value=>updates.push([key,value])];};
    ${overview}
    return {tree:ExtraWorkOrderOverview(props),updates};
  }
  export const render=(props,states)=>renderToStaticMarkup(tree(props,states).tree);`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const base={assignmentId:1,assignmentStartDate:'2026-09-21',order:{id:1,sequence_number:24,kind:'timesheet',status:'draft',title:'Hauptauftrag',total_hours:'2.5',photo_count:0},photoLimit:5,isSaving:false,isUploadingPhoto:false,message:null,error:null,messageTone:'info'};
const render=(order={},props={},states={})=>module.exports.render({...base,...props,order:{...base.order,...order}},states);
const collect=tree=>{const result=[];const visit=n=>{if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(visit);return;}result.push(n);visit(n.props?.children);};visit(tree);return result;};

test('time sheet overview shares the measurement layout and presents kind/status above the editable title',()=>{
  const html=render();
  assert.match(html,/is-measurement-overview is-extra-work-overview/);
  assert.match(html,/mobile-measurement-summary-heading/);
  assert.match(html,/<h2>Stundenzettel 24 - Hauptauftrag<\/h2>/);
  assert.match(html,/aria-label="Stundenzettel benennen"/);
  assert.match(html,/aria-label="Stundenzettel-Details öffnen"/);
  assert.doesNotMatch(html,/mobile-customer-email-status|mobile-measurement-summary-status-row/);
  for(const label of ['Leistungen erfassen','Stundenzettel anzeigen (PDF)','Kundenunterschrift einfügen','Monteursunterschrift einfügen','Kunden-E-Mail','Per E-Mail senden','Hinterlegte Fotos'])assert.ok(html.includes(label));
  assert.match(styles,/is-extra-work-overview \.mobile-measurement-card-meta \{\s*justify-content: flex-end;/);
});

test('submission, signing, rename and photo restrictions remain intact',()=>{
  const submit=html=>html.match(/<button[^>]*mobile-measurement-submit-action[^>]*>/)[0];
  assert.doesNotMatch(submit(render()),/disabled/);
  assert.match(submit(render({status:'submitted'})),/disabled/);
  assert.match(submit(render({}, {isSaving:true})),/disabled/);
  const signed=render({customer_signed_at:'2026-09-21',worker_signed_at:'2026-09-21',photo_count:5});
  assert.doesNotMatch(signed,/aria-label="Stundenzettel benennen"/);
  assert.match(signed,/disabled=""[^>]*>[^]*?Kundenunterschrift vorhanden/);
  assert.match(signed,/Monteursunterschrift vorhanden/);
  assert.match(signed,/aria-label="Foto aufnehmen"[^>]*disabled/);
  assert.match(signed,/Maximal 5 Fotos pro Stundenzettel/);
});

test('time sheets and approvals group actions into four cards with worker signature first',()=>{
  for(const kind of ['timesheet','approval']){
    const {tree,updates}=module.exports.tree({...base,order:{...base.order,kind}});
    const groups=collect(tree).filter(n=>n.props?.className==='mobile-measurement-overview-action-group');
    assert.deepEqual(groups.map(n=>n.props['aria-label']),['Erfassung und PDF','Unterschriften','E-Mail','Fotos']);
    assert.deepEqual(groups.map(n=>collect(n).filter(child=>child.type==='button').length),[2,2,2,0]);
    const signatures=collect(groups[1]).filter(n=>n.type==='button');
    assert.match(module.exports.render({...base,order:{...base.order,kind}}),/Monteursunterschrift einfügen[^]*Kundenunterschrift einfügen/);
    signatures[0].props.onClick();
    signatures[1].props.onClick();
    assert.match(overview,/setIsSigningWorker\(true\)[^]*setIsSigningCustomer\(true\)/);
    assert.equal(updates.filter(([,value])=>value===true).length,2);
    assert.equal(groups[3].props.children.props.onTakePhoto,base.onTakePhoto);
  }
});

test('delivery indicator exposes unsent, unsigned-sent, signed-sent and error states',()=>{
  assert.match(render(),/is-not-sent" role="img" aria-label="Mail nicht an Kunden gesendet"/);
  assert.match(render({customer_email_sent_at:'2026-09-21'}),/mobile-measurement-email-indicator is-signature-open/);
  assert.match(render({customer_email_sent_at:'2026-09-21',customer_signed_at:'2026-09-21'}),/mobile-measurement-email-indicator is-complete/);
  assert.match(render({}, {}, {10:'E-Mail konnte nicht gesendet werden.'}),/aria-label="E-Mail konnte nicht gesendet werden\."/);
  assert.match(overview,/disabled=\{!emailSendPrerequisitesMet \|\| isSendingEmail \|\| isLoadingEmailRecipients\}/);
});

test('approval variant retains estimate and appropriate action labels',()=>{
  const html=render({kind:'approval',estimated_hours:'8'});
  assert.match(html,/Stundenfreigabe 24/);
  assert.match(html,/Freigabe erfassen/);
  assert.match(html,/Stundenfreigabe anzeigen \(PDF\)/);
  assert.match(html,/Vorgabe: 8,00/);
});

test('overview callbacks and modal entry points remain connected',()=>{
  const calls=[];
  const result=module.exports.tree({...base,onBack:()=>calls.push('back'),onSubmit:()=>calls.push('submit'),onOpenEntry:()=>calls.push('entry'),onOpenPhotos:()=>calls.push('photos'),onTakePhoto:()=>calls.push('camera')});
  const nodes=collect(result.tree);
  for(const cls of ['mobile-back-button','mobile-measurement-submit-action','is-primary'])nodes.find(n=>n.type==='button'&&n.props.className.includes(cls)).props.onClick();
  nodes.find(n=>n.props?.['aria-label']==='Stundenzettel benennen').props.onClick({stopPropagation(){}});
  nodes.find(n=>n.props?.['aria-label']==='Stundenzettel-Details öffnen').props.onClick();
  const photo=nodes.find(n=>n.props?.onTakePhoto);
  photo.props.onOpenPhotos();photo.props.onTakePhoto();
  assert.deepEqual(calls,['back','submit','entry','photos','camera']);
  assert.ok(result.updates.some(([index,value])=>index===3&&value===true));
  assert.ok(result.updates.some(([index,value])=>index===4&&value===true));
});
