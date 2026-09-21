import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {build} from 'esbuild';
const source=await readFile(new URL('../src/pages/MyAssignmentsPage.tsx',import.meta.url),'utf8');
const styles=await readFile(new URL('../src/styles.css',import.meta.url),'utf8');
const card=source.slice(source.indexOf('function MobileHomeTimelineCard('),source.indexOf('function MobileAssignmentSiteCard('));
const compiled=await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
  import {ChevronRight,UsersRound} from 'lucide-react';
  import {formatAssignmentColleagues} from './src/lib/mobileAssignmentColleagues';
  export {formatAssignmentColleagues};
  const Link=({children,to,state,...props})=><a href={to} {...props}>{children}</a>;
  const formatHomeTimelineDateRange=(a,b)=>a+' '+b,formatHomeTimelineWeekdayRange=()=> 'Mo–Fr',formatRangeLabel=(a,b)=>a+' '+b,formatDate=a=>a;
  ${card}
  export const render=assignment=>renderToStaticMarkup(<MobileHomeTimelineCard isNext today="2026-09-21" item={{start:'2026-09-21',end:'2026-09-25',dayCount:5,assignment}}/>);
`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const peer=(person_id,last_name,start,end=start)=>({person_id,last_name,start_date:start,end_date:end});
const format=peers=>module.exports.formatAssignmentColleagues(peers,'2026-09-21','2026-09-25',1);

test('team periods distinguish full ranges, single days, gaps and duplicate plans',()=>{
  assert.deepEqual(format([
    peer(1,'Eigener','2026-09-21','2026-09-25'),
    peer(2,'Koehle','2026-09-20','2026-09-23'),peer(2,'Koehle','2026-09-21','2026-09-22'),
    peer(3,'Tietz','2026-09-24'),
    peer(4,'Müller','2026-09-21'),peer(4,'Müller','2026-09-24'),
    peer(5,'Nicht gemeinsam','2026-09-28'),
  ]),[
    {personId:2,name:'Koehle',period:'Mo–Mi'},
    {personId:4,name:'Müller',period:'Mo, Do'},
    {personId:3,name:'Tietz',period:'Do'},
  ]);
  assert.equal(format([peer(2,'A','2026-09-21','2026-09-23'),peer(2,'A','2026-09-24','2026-09-26')])[0].period,'Mo–Fr');
});

test('same surnames remain separate people and multiweek ranges are unambiguous',()=>{
  assert.equal(format([peer(2,'Müller','2026-09-21'),peer(3,'Müller','2026-09-21')]).length,2);
  const rows=module.exports.formatAssignmentColleagues([peer(2,'A','2026-10-23','2026-10-26')],'2026-10-19','2026-10-30',1);
  assert.equal(rows[0].period,'Fr 23.10.–Mo 26.10.');
});

test('home cards replace commission and customer with colleagues without changing navigation',()=>{
  const assignment={id:42,person:{id:1},site:{name:'Testbaustelle',site_number:'9999',customer:'Nicht anzeigen'},colleagues:[peer(2,'Koehle','2026-09-21','2026-09-23'),peer(3,'Tietz','2026-09-24')]};
  const html=module.exports.render(assignment);
  assert.match(html,/Koehle/);assert.match(html,/\(Mo–Mi\)/);assert.match(html,/\(Do\)/);
  assert.match(html,/href="\/me\/assignments\/42"/);
  assert.doesNotMatch(html,/9999|Nicht anzeigen/);
  assert.match(module.exports.render({...assignment,colleagues:[]}),/Keine Kollegen mitgeplant/);
  assert.match(module.exports.render({...assignment,colleagues:undefined}),/Teamdaten nicht verfügbar/);
  assert.match(module.exports.render(null),/Antippen, falls du trotzdem auf Baustelle bist/);
});

test('colleagues use two equal columns with full-width empty messages and shared slider rows',()=>{
  assert.match(styles,/\.mobile-home-timeline-team-list \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*overflow-wrap: anywhere;/);
  assert.match(styles,/\.mobile-home-timeline-team-empty \{ grid-column: 1 \/ -1; \}/);
  const empty=module.exports.render({id:42,person:{id:1},site:{name:'Test'},colleagues:[]});
  assert.match(empty,/class="mobile-home-timeline-team-empty">Keine Kollegen mitgeplant/);
  assert.match(styles,/@supports \(grid-template-rows: subgrid\) \{\s*\.mobile-home-timeline-track \{\s*grid-template-rows: repeat\(2, minmax\(clamp\(84px, 24vw, 98px\), auto\)\);/);
  assert.match(styles,/\.mobile-home-timeline-page \{\s*grid-row: span 2;\s*grid-template-rows: subgrid;/);
  assert.match(styles,/\.mobile-home-timeline-page \{[^}]*grid-auto-rows: minmax\(clamp\(84px, 24vw, 98px\), 1fr\);/);
});
