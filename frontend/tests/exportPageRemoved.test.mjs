import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import test from 'node:test';
const read=path=>readFileSync(new URL(`../src/${path}`,import.meta.url),'utf8');

test('main Export page, navigation and office permission are removed',()=>{
 assert.doesNotMatch(read('App.tsx'),/ExportsPage|officePermission="export"/);
 assert.match(read('App.tsx'),/path="exports" element=\{<Navigate to="\/" replace \/>\}/);
 assert.doesNotMatch(read('config/navigation.ts'),/label: "Export"|path: "\/exports"/);
 assert.doesNotMatch(read('config/officePagePermissions.ts'),/key: "export"/);
 assert.doesNotMatch(read('types/auth.ts'),/\| "export"/);
 assert.equal(existsSync(new URL('../src/pages/ExportsPage.tsx',import.meta.url)),false);
});
test('retired API clients and page styles are gone but payroll downloads remain',()=>{
 const api=read('lib/api.ts');
 assert.doesNotMatch(api,/dailyPlanPdf|weeklyPlanPdf|monthlyTimeEntriesXlsx/);
 for(const method of ['payrollMonthlyWorkersXlsx','payrollMonthlyWorkerXlsx','weeklyAllWorkersTimeEntriesXlsx','weeklyWorkerTimeEntriesXlsx']) assert.ok(api.includes(method));
 assert.doesNotMatch(read('styles.css'),/\.exports-page|\.export-grid|\.export-panel/);
});
