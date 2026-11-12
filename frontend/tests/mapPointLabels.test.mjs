import assert from 'node:assert/strict';
import test from 'node:test';
import { mapPointLabelMode } from '../src/lib/mapPointLabels.ts';

test('fewer than 15 visible sites and people get permanent labels, with a shared threshold', () => {
  for (const [sites, people] of [[1, 0], [0, 1], [13, 0], [0, 13], [7, 7], [13, 1]]) {
    assert.equal(mapPointLabelMode(sites, people), 'full', `${sites} sites + ${people} people`);
  }
});

test('15 or more visible points require hover, even when each group has fewer than 15', () => {
  for (const [sites, people] of [[15, 0], [0, 15], [13, 2], [8, 8], [16, 0], [20, 20]]) {
    assert.equal(mapPointLabelMode(sites, people), 'points', `${sites} sites + ${people} people`);
  }
  assert.equal(mapPointLabelMode(0, 0), 'points');
});
