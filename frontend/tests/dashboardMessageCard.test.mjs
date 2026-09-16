import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const compiled = await build({
  stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {DashboardMessageCard} from './src/components/DashboardMessageCard';
    export const render = props => renderToStaticMarkup(React.createElement(MemoryRouter,{},React.createElement(DashboardMessageCard,props)));
    export const tree = props => DashboardMessageCard(props);`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic",
  loader: { ".css": "empty" },
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { render, tree } = module.exports;
const base = {message_key:"measurement_submitted:4",message_type:"measurement_submitted",title:"Aufmaß 4",status:"submitted",
  site_id:7,site_name:"Schüchtermann Klinik",site_number:"8007",submitted_by_name:"Marcin Cholewka",event_at:"2026-08-19T17:31:00",submitted_at:null};
const props = message => ({message:{...base,...message},busy:false,onOpenNote:()=>{},onOpenToolIssue:()=>{},onDismiss:()=>{}});

test("measurement cards separate title/status, site/person and date/read action", () => {
  const html = render(props({}));
  assert.match(html, /Aufmaß 4/);
  assert.match(html, /Eingereicht/);
  assert.match(html, /Schüchtermann Klinik/);
  assert.match(html, /Marcin Cholewka · 8007/);
  assert.match(html, /19\.08\.26, 17:31/);
  assert.match(html, /<time dateTime="2026-08-19T17:31:00"/);
  assert.match(html, /Als gelesen markieren/);
  assert.match(html, /\/sites\/7\?tab=measurement&amp;measurementSubtab=review/);
  assert.doesNotMatch(html, /wurde zur Prüfung|wurde vom Kunden/);
  assert.ok(html.indexOf("</a>") < html.indexOf("<footer"), "read action is outside the navigation link");
});

test("signed cards show the signer, while extra work keeps its own destination", () => {
  const signed = render(props({message_type:"measurement_customer_signed",customer_signature_name:"Zimmermann"}));
  assert.match(signed, /Unterschrieben/);
  assert.match(signed, /Zimmermann · 8007/);
  assert.doesNotMatch(signed, /Marcin Cholewka/);
  assert.match(render(props({message_type:"extra_work_submitted",title:"Stundenzettel 7282.SZ01"})), /\/sites\/7\?tab=extra-work/);
});

test("notes and tools preserve context, due dates, previews and special actions", () => {
  const note = render(props({message_type:"dashboard_note_shared",title:"Geteilte Notiz",site_name:null,site_number:null,
    note_preview:"Bitte Details prüfen",note_due_date:"2026-09-20",note_created_at:"2026-09-16T10:00:00"}));
  assert.match(note, /Allgemeine Notiz/);
  assert.match(note, /Bitte Details prüfen/);
  assert.match(note, /Fällig 20\.09\.2026/);
  assert.match(note, /16\.09\.26, 10:00/);
  assert.match(note, /Geteilt/);
  const tool = render(props({message_type:"tool_issue_reported",title:"Werkzeug defekt",message_text:"Bohrer beschädigt",event_at:null}));
  assert.match(tool, /Bohrer beschädigt/);
  assert.match(tool, /Gemeldet/);
  assert.match(tool, /Als erledigt markieren/);
  assert.match(tool, /Zeitpunkt unbekannt/);
  assert.doesNotMatch(tool, /Als gelesen markieren/);
});

test("card controls forward the correct message and honor pending actions", () => {
  for (const type of ["dashboard_note_shared", "tool_issue_reported"]) {
    const called = [], p = props({message_type:type});
    p.busy = true;
    p.onOpenNote = value => called.push(["note", value]);
    p.onOpenToolIssue = value => called.push(["tool", value]);
    p.onDismiss = value => called.push(["dismiss", value]);
    const [open, footer] = tree(p).props.children;
    const read = footer.props.children[1];
    assert.equal(open.props.disabled, true);
    assert.equal(read.props.disabled, true);
    open.props.onClick(); read.props.onClick();
    assert.deepEqual(called, [[type === "dashboard_note_shared" ? "note" : "tool", p.message], ["dismiss", p.message]]);
  }
});
