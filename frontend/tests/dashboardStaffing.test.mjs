import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {DashboardStaffingOverview} from './src/components/DashboardStaffingOverview';
    export const render = (days,today='2026-09-28') => renderToStaticMarkup(<DashboardStaffingOverview days={days} today={today}/>);`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic',
});
const result = {exports:{}};
new Function('require','module','exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), result, result.exports);
const day = (count = 0, extra = {}) => ({date:'2026-09-28',isWorkday:true,nonWorkdayLabel:null,needs:[],
  freeWorkers:Array.from({length:count},(_,i)=>({id:i,display_name:`Monteur ${i}`,short_code:`M.${i}`,isExternal:i===0})),...extra});

test('renders at most four bubbles and an exact overflow count, without truncating the data',()=>{
  const data = day(14);
  const html = result.exports.render([data]);
  assert.equal((html.match(/class="dashboard-staffing-worker"/g)||[]).length,4);
  assert.match(html,/\+10 mehr/);
  assert.match(html,/aria-haspopup="dialog"/);
  assert.match(html,/>extern</);
  assert.equal(data.freeWorkers.length,14);
});
test('four workers have no overflow; empty working and weekend states differ',()=>{
  assert.doesNotMatch(result.exports.render([day(4)]),/dashboard-staffing-more/);
  assert.match(result.exports.render([day()]),/Keine freien Monteure/);
  const weekend = result.exports.render([day(0,{isWorkday:false,nonWorkdayLabel:'Wochenende'})]);
  assert.match(weekend,/Wochenende/);
  assert.doesNotMatch(weekend,/Keine freien Monteure/);
});
test('renders all eight dates and needs independently from worker availability',()=>{
  const days = [1,2,5,6,7,8,9,12].map(i=>day(0,{date:`2026-10-${String(i).padStart(2,'0')}`}));
  days[0].needs=[{siteName:'Baustelle & Test',siteNumber:'8007',managerLabel:'CE'}];
  const html=result.exports.render(days,'2026-10-01');
  assert.equal((html.match(/<time /g)||[]).length,8);
  assert.equal((html.match(/>Heute</g)||[]).length,1);
  assert.match(html,/Baustelle &amp; Test/);
  assert.match(html,/8007 · CE/);
  assert.match(html,/Kein offener Bedarf/);
  assert.equal((html.match(/has-weekend-gap/g)||[]).length,2);
  assert.doesNotMatch(html,/2026-10-03|2026-10-04/);
});
test('a forecast starting next Monday on a weekend does not label Monday as today or add a leading gap',()=>{
  const html=result.exports.render([day(0,{date:'2026-10-05'})],'2026-10-03');
  assert.doesNotMatch(html,/>Heute</);
  assert.doesNotMatch(html,/has-weekend-gap/);
});
test('popup can open through hover, focus and click and closes with Escape or outside interaction',()=>{
  const source=readFileSync(new URL('../src/components/DashboardStaffingOverview.tsx',import.meta.url),'utf8');
  assert.match(source,/onMouseEnter=\{open\}/);
  assert.match(source,/onFocus=\{open\}/);
  assert.match(source,/onClick=\{open\}/);
  assert.match(source,/event.key === "Escape"/);
  assert.match(source,/document.addEventListener\("pointerdown", pointer\)/);
  assert.match(source,/day.freeWorkers.map\(person/);
});
test('Einsatzplanung gets about twenty percent more height, entirely for sites and taken from the upper desktop row',()=>{
  const page=readFileSync(new URL('../src/pages/DashboardPage.tsx',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');
  assert.match(page,/title="Einsatzplanung"/);
  assert.doesNotMatch(page,/title="Prüfen \/ Konflikte"/);
  assert.match(styles,/--dashboard-staffing-extra-height: 68px/);
  assert.match(styles,/grid-template-rows: auto calc\(112px \+ var\(--dashboard-staffing-extra-height, 68px\)\) minmax\(150px, auto\)/);
  assert.match(styles,/height: calc\(clamp\(440px, 50vh, 540px\) - var\(--dashboard-staffing-extra-height\)\)/);
});
