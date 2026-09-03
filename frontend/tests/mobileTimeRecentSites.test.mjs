import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/pages/MobileTimeEntryPage.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const ast = ts.createSourceFile("MobileTimeEntryPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["buildRecentPlannedSiteOptions", "compareSites", "siteOptionLabel", "parseDateInput", "toIsoDate", "addMonths", "formatShortDate"];
const functions = names.map(name => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} must exist`);
  return declaration.getText(ast);
}).join("\n");
const context = vm.createContext({});
vm.runInContext(ts.transpileModule(functions, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, context);
const site = (id, number = String(id)) => ({id, site_number:number, name:`Baustelle ${id}`, location:"Testort"});
const assignment = (id, end, number) => ({site:site(id, number), start_date:end, end_date:end});
const recent = (assignments, options = {}) => context.buildRecentPlannedSiteOptions({
  assignments, selectedDate:"2026-09-03", plannedSiteIds:[], siteById:new Map(), ...options,
});
const ids = rows => Array.from(rows, row => row.id);

test("recent site list keeps all matches, latest-first sorting and date formatting", () => {
  const rows = recent([assignment(1,"2026-08-01"), assignment(2,"2026-08-28"),
    assignment(3,"2026-08-14"), assignment(4,"2026-08-21"), assignment(5,"2026-08-07")]);
  assert.deepEqual(ids(rows), [2,4,3,5,1]);
  assert.equal(context.formatShortDate(rows[0].lastPlannedDate), "28.08.2026");
});

test("recent site list preserves six-month cutoff and excludes current planned or future sites", () => {
  const rows = recent([assignment(1,"2026-03-01"), assignment(2,"2026-02-28"),
    assignment(3,"2026-09-03"), assignment(4,"2026-09-04"), assignment(5,"2026-09-02")],
    {plannedSiteIds:[5]});
  assert.deepEqual(ids(rows), [1]);
});

test("recent site list deduplicates by ID, uses mapped site fields and preserves tie sorting", () => {
  const mapped = {...site(1,"1001"), name:"Name aus bestehender Zuordnung"};
  const rows = recent([assignment(1,"2026-08-01"), assignment(1,"2026-08-28"),
    assignment(2,"2026-08-28","1002")], {siteById:new Map([[1,mapped]])});
  assert.deepEqual(ids(rows), [1,2]);
  assert.equal(rows[0].name, mapped.name);
  assert.equal(rows[0].lastPlannedDate, "2026-08-28");
  assert.equal(recent([]).length, 0);
  assert.equal(recent([assignment(1,"2026-08-28")]).length, 1);
});

test("recent sites use one list, whole-row buttons and the existing locked-week selection handler", () => {
  const start = source.indexOf('<section className="mobile-time-picker-section is-secondary"');
  const section = source.slice(start, source.indexOf("</section>", start));
  assert.match(section, /mobile-time-recent-list[\s\S]*?<ul>[\s\S]*?recentSiteOptions\.map/);
  assert.match(section, /<li key=\{site\.id\}>[\s\S]*?<button[\s\S]*?disabled=\{isSelectedWeekLocked\}[\s\S]*?onClick=\{\(\) => openSiteEntry\(site\.id\)\}/);
  assert.match(section, /MapPin[\s\S]*?site\.site_number[\s\S]*?site\.name[\s\S]*?site\.lastPlannedDate[\s\S]*?ChevronRight/);
  assert.match(section, /mobile-time-recent-empty">Keine vergangenen Baustellen gefunden/);
  assert.doesNotMatch(section, /slice\(|mobile-time-recent-strip|mobile-time-site-card/);
  assert.match(source, /api\.myAssignmentHistory\(\{ start: assignmentLoadRange\.start, end: assignmentLoadRange\.end \}\)/);
  assert.match(source, /\{assignmentLoadError \? <p className="form-error">\{assignmentLoadError\}/);
  assert.match(source, /\{isLoading \? <div className="empty-panel">Kalender wird geladen/);
});

test("recent list stays in page flow with inset separators and bounded long text", () => {
  assert.match(styles, /\.mobile-time-recent-list \{[^}]*min-width:\s*0;[^}]*border-radius:\s*16px;[^}]*background:\s*#ffffff;/s);
  assert.match(styles, /\.mobile-time-recent-list li \+ li \{[^}]*border-top:\s*1px solid #e1e7ef;/s);
  assert.match(styles, /\.mobile-time-recent-copy > span \{[^}]*overflow:\s*hidden;[^}]*overflow-wrap:\s*anywhere;[^}]*-webkit-line-clamp:\s*2;/s);
  assert.match(styles, /\.mobile-time-recent-row:focus-visible \{[^}]*outline:\s*2px solid #123f76;/s);
  assert.match(styles, /\.mobile-time-recent-row:active:not\(:disabled\)/);
  assert.match(styles, /\.mobile-time-recent-row:hover:not\(:disabled\)/);
  assert.match(styles, /\.mobile-time-recent-row:disabled \{[^}]*cursor:\s*not-allowed;/s);
  assert.doesNotMatch(styles, /\.mobile-time-recent-(?:list|row)[^{]*\{[^}]*overflow[^:]*:\s*(?:auto|scroll)/s);
});
