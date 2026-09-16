import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { build, transformSync } from "esbuild";

const compiled = await build({
  stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {DashboardInbox,DashboardBillingList,DashboardBillingCount} from './src/components/DashboardInbox';
    export const render = (name, props) => renderToStaticMarkup(React.createElement(MemoryRouter,{},React.createElement(name === 'list' ? DashboardBillingList : name === 'count' ? DashboardBillingCount : DashboardInbox,props)));`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic",
  loader: { ".css": "empty" }, define: { "import.meta.env": "{}" },
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const render = module.exports.render;
const source = readFileSync(new URL("../src/components/DashboardInbox.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8");

test("project managers and admins get billing tabs; office retains the existing inbox", () => {
  assert.match(page, /canViewBilling=\{user\?\.role === "project_manager" \|\| user\?\.role === "admin"\}/);
  assert.match(page, /key=\{user\?\.id\}/);
  const hidden = render("inbox", {canViewBilling:false,badge:"23",children:"Meldung"});
  assert.doesNotMatch(hidden, /Abrechnung|role="tab"/);
  assert.match(hidden, /<h2>Meldungen<\/h2>/);
  assert.doesNotMatch(hidden, /Eingang/);
  assert.match(hidden, /23/);
  const allowed = render("inbox", {canViewBilling:true,badge:"23",children:"Meldung"});
  assert.equal((allowed.match(/role="tab"/g) || []).length, 2);
  assert.match(allowed, /aria-selected="true"/);
  assert.match(allowed, /hidden=""/);
  assert.doesNotMatch(allowed, /Eingang/);
});

test("billing tab counts sites rather than documents and shares the smaller message badge", () => {
  const html = render("count", {billing:{open_count:63,sites:[{},{}]},error:false});
  assert.match(html, /2 Baustellen mit offenen Abrechnungen/);
  assert.match(html, />2<\/strong>/);
  assert.doesNotMatch(html, /63/);
  assert.match(render("count", {billing:{open_count:0,sites:[]},error:false}), />0<\/strong>/);
  assert.match(render("count", {billing:null,error:false}), /wird geladen/);
  const failed = render("count", {billing:{open_count:63,sites:[{},{}]},error:true});
  assert.match(failed, /nicht verfügbar/);
  assert.doesNotMatch(failed, />2<\/strong>/);
  const styles = readFileSync(new URL("../src/components/DashboardInbox.css", import.meta.url), "utf8");
  assert.match(styles, /\.dashboard-card\.dashboard-inbox \.dashboard-card-badge\s*\{[^}]*height: 16px/s);
});

test("billing renders collapsible site groups with both types, status/date and read-only navigation", () => {
  const html = render("list", {billing:{open_count:2,sites:[{site_id:7,site_number:"8007",site_name:"Klinik <Test>",project_manager_name:"Projekt Leiter",items:[
    {id:1,kind:"measurement",title:"Aufmaß 8007.08",status:"reviewed",status_label:"Geprüft",date:"2026-09-16"},
    {id:1,kind:"extra_work",title:"Zusatzauftrag 8007.Z12",status:"billed",status_label:"Abgeschlossen",date:null},
  ]}]}});
  assert.match(html, /<details/);
  assert.match(html, /<summary/);
  assert.match(html, /Klinik &lt;Test&gt;/);
  assert.match(html, /Geprüft/);
  assert.match(html, /Abgeschlossen/);
  assert.match(html, /16.09.2026/);
  assert.match(html, /\/sites\/7\?tab=measurement&amp;measurementSubtab=review/);
  assert.match(html, /\/sites\/7\?tab=extra-work/);
  assert.doesNotMatch(html, /<input|<button|checkbox|Als gelesen/);
  assert.match(render("list", {billing:{open_count:0,sites:[]}}), /Keine offenen Abrechnungen/);
});

const start = source.indexOf("  useEffect(() => {");
const end = source.indexOf("\n  return (", start);
const effect = transformSync(source.slice(start, end), {loader:"tsx"}).code;
function setup({mode="billing", canViewBilling=true} = {}) {
  let callback, resolve, reject;
  const writes = [], listeners = new Map();
  let calls = 0;
  const context = {mode, canViewBilling, retry:0, useEffect:fn=>{callback=fn;},
    api:{dashboardBilling:()=>{calls++; return new Promise((ok,fail)=>{resolve=ok;reject=fail;});}},
    document:{visibilityState:"visible",addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)},
    window:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),setInterval:fn=>{listeners.set("timer",fn);return 1;},clearInterval:()=>listeners.delete("timer")},
    ...Object.fromEntries(["Loading","Error","Billing"].map(name=>[`set${name}`,value=>writes.push([name,value])])),
  };
  new Function(...Object.keys(context),effect)(...Object.values(context));
  const cleanup = callback();
  return {writes,listeners,context,cleanup,get calls(){return calls;},resolve:value=>resolve(value),reject:()=>reject(Error("offline"))};
}
const flush = () => new Promise(resolve=>setImmediate(resolve));

test("billing count loads on messages tab, refreshes on focus, suppresses concurrent and hidden-tab requests", async () => {
  const messages = setup({mode:"messages"});
  assert.equal(messages.calls, 1);
  messages.cleanup();
  assert.equal(setup({canViewBilling:false}).calls, 0);
  const state = setup();
  assert.equal(state.calls,1);
  state.listeners.get("focus")();
  assert.equal(state.calls,1);
  state.resolve({open_count:1,sites:[]}); await flush();
  state.listeners.get("focus")();
  assert.equal(state.calls,2);
  state.resolve({open_count:0,sites:[]}); await flush();
  assert.deepEqual(state.writes.filter(([name])=>name==="Billing").at(-1),["Billing",{open_count:0,sites:[]}]);
  state.context.document.visibilityState="hidden";
  state.listeners.get("timer")();
  assert.equal(state.calls,2);
  state.cleanup();
  assert.equal(state.listeners.size,0);
});

test("late responses cannot replace another user's view and failures are visible", async () => {
  const stale = setup(); stale.cleanup(); stale.resolve({open_count:50,sites:[]}); await flush();
  assert.equal(stale.writes.filter(([name])=>name==="Billing").length,0);
  const failing = setup(); failing.reject(); await flush();
  assert.deepEqual(failing.writes.at(-2),["Error",true]);
  assert.match(source, /error \? \(/);
  failing.cleanup();
});
