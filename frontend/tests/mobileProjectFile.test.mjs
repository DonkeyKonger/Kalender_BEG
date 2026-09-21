import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {build} from 'esbuild';

const source=await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const styles=await readFile(new URL('../src/pages/MobileProjectFile.css',import.meta.url),'utf8');
const component=source.slice(source.indexOf('const detailTabs:'),source.indexOf('function MobileProjectFoldersHeader('));
const compiled=await build({stdin:{contents:`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
  import {FolderOpen,ReceiptText,FileText,ClipboardList,Package,ChevronRight,Hammer} from 'lucide-react';
  import {MobileBackButton} from './src/components/MobileBackButton';
  import {SiteStatusBadge} from './src/components/StatusBadge';
  let assignment; export const events=[];
  const useState=value=>[value,next=>events.push(next)]; const useMemo=fn=>fn();
  const useNavigate=()=>path=>events.push(path); const useLocation=()=>({state:{assignment}}); const useParams=()=>({assignmentId:'1'});
  const MobileProjectPhotoCapture=({onOpenPhotos})=><button onClick={onOpenPhotos}>Hinterlegte Fotos</button>;
  const MobileProjectInformationCount=()=>null;
  ${component}
  export function tree(value){assignment=value;events.length=0;return MobileAssignmentDetailPage();}
  export const render=value=>renderToStaticMarkup(tree(value));
`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const assignment={id:1,site:{id:1,name:'Testbaustelle Finienweg',site_number:'9999',customer:'Kunde GmbH',status:'paused'}};
const collect=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(collect):[node,...collect(node.props?.children)];

test('menu accents are muted while keeping icon contrast and the blue camera action',()=>{
  const rgb=hex=>hex.match(/[a-f\d]{2}/gi).map(value=>parseInt(value,16));
  const chroma=hex=>Math.max(...rgb(hex))-Math.min(...rgb(hex));
  const luminance=hex=>rgb(hex).map(value=>value/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
  const accents=[
    ['.is-folders .mobile-project-file-icon','#95630c','#fff4dc'],
    ['.is-measurement .mobile-project-file-icon','#16867b','#e5f8f3'],
    ['.is-extra-work .mobile-project-file-icon','#286398','#eaf4ff'],
    ['.is-timesheet .mobile-project-file-icon','#6552a5','#f1edff'],
    ['.is-project-file .mobile-project-photo-action .mobile-measurement-photo-main-action > svg','#ac4c31','#faece9'],
  ];
  for(const [selector,oldColor,oldBackground] of accents){
    const rule=styles.slice(styles.indexOf(selector)).split('}')[0];
    const color=rule.match(/\bcolor: (#[a-f\d]{6})/)[1];
    const background=rule.match(/\bbackground: (#[a-f\d]{6})/)[1];
    assert.ok(chroma(color)<=chroma(oldColor)*0.65,`${selector}: muted icon`);
    assert.ok(chroma(background)<chroma(oldBackground),`${selector}: muted background`);
    assert.ok((luminance(background)+0.05)/(luminance(color)+0.05)>=3,`${selector}: readable icon`);
  }
  assert.match(styles,/\.mobile-camera-button \{[^}]*background: #315f91;[^}]*color: #ffffff;/);
});

test('project file renders compact summary and all six destinations in one menu',()=>{
  const html=module.exports.render(assignment);
  assert.match(html,/<h1>Projektakte<\/h1>/);
  assert.match(html,/<h2>Testbaustelle Finienweg<\/h2>/);
  assert.match(html,/9999 · Kunde GmbH/);
  assert.match(html,/>Pause</);
  for(const name of ['Ordner','Aufmaß','Stundenzettel','Zeitenliste','Werkzeuge &amp; Material','Hinterlegte Fotos']) assert.ok(html.includes(name));
  assert.equal((html.match(/mobile-project-file-chevron/g)||[]).length,5);
  assert.doesNotMatch(html,/assignment-date|mobile-detail-summary-chevron/);
  assert.match(styles,/mobile-project-file-menu \{[^}]*grid-template-columns: minmax\(0, 1fr\)/s);
});

test('project file preserves summary keyboard entry, navigation and menu actions',()=>{
  const nodes=collect(module.exports.tree(assignment));
  const summary=nodes.find(n=>n.props?.className==='mobile-project-file-summary');
  summary.props.onClick();
  summary.props.onKeyDown({key:'Enter',preventDefault(){}});
  summary.props.onKeyDown({key:' ',preventDefault(){}});
  assert.deepEqual(module.exports.events,['overview',false,'overview',false,'overview',false]);
  for(const key of ['folders','measurement','extra-work','tools']) {
    nodes.find(n=>n.props?.className?.includes('mobile-project-file-action is-'+key)).props.onClick();
    assert.ok(module.exports.events.includes(key));
  }
  nodes.find(n=>n.props?.label==='Zurück zu Meine Einsätze').props.onClick();
  assert.ok(module.exports.events.includes('/me/assignments'));
  nodes.find(n=>n.props?.onOpenPhotos).props.onOpenPhotos();
  assert.ok(module.exports.events.includes('photos'));
});

test('timesheet loading and the existing project photo upload remain intact',()=>{
  assert.match(component,/disabled=\{tab.key === "timesheet" && isOpeningTimesheet\}/);
  assert.match(component,/api.mobileMeasurementTimesheetPdf\(currentAssignment.id\)/);
  const capture=source.slice(source.indexOf('function MobileProjectPhotoCapture('),source.indexOf('function MobileProjectPhotosPanel('));
  assert.match(capture,/disabled=\{isUploadingProjectPhoto\}/);
  assert.match(capture,/api.uploadProjectFolderDocument\(assignment.site.id, "fotos", uploadFile\)/);
  assert.match(capture,/onTakePhoto=\{openProjectPhotoCapture\}/);
  assert.match(capture,/capture="environment"/);
});
