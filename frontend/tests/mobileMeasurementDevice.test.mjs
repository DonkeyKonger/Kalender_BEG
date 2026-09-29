import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {usesMeasurementTable} from '../src/lib/mobileMeasurementDevice.ts';

test('Pro Max and smaller phones remain lists in both orientations',()=>{
 for(const [w,h] of [[440,956],[430,932],[393,852],[360,800]]) {
  assert.equal(usesMeasurementTable(w,h),false);
  assert.equal(usesMeasurementTable(h,w),false);
 }
});
test('devices larger than the phone reference use the table without an upper cutoff',()=>{
 for(const [w,h] of [[441,957],[600,960],[744,1133],[768,1024],[834,1194],[1024,1366],[1440,900]]) {
  assert.equal(usesMeasurementTable(w,h),true);
  assert.equal(usesMeasurementTable(h,w),true);
 }
});
test('invalid dimensions do not select a tablet',()=>{
 for(const [w,h] of [[0,0],[NaN,900],[600,Infinity],[-1,900]]) assert.equal(usesMeasurementTable(w,h),false);
});
test('device detection uses screen dimensions, not keyboard or split-view viewport width',()=>{
 const page=readFileSync(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
 assert.match(page,/usesMeasurementTable\(window\.screen\.width, window\.screen\.height\)/);
 assert.match(page,/const canUseInlineMeasurementTable = useMeasurementTableDevice\(\)/);
 assert.doesNotMatch(page,/TABLET_INLINE_MEASUREMENT_QUERY/);
});
