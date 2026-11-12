import assert from 'node:assert/strict';
import test from 'node:test';
import { mapPointLabelMode, mapPointLabelModeAfterMove } from '../src/lib/mapPointLabels.ts';

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

test('permanent labels stay visible while panning through dense or empty areas at the same zoom', () => {
  const previous = { mode: 'full', zoom: 11 };
  for (const [sites, persons] of [[8, 8], [20, 30], [0, 0], [13, 1]]) {
    assert.equal(mapPointLabelModeAfterMove(previous, { sites, persons, zoom: 11 }), 'full');
  }
});

test('a changed zoom rechecks the combined threshold in either zoom direction', () => {
  const previous = { mode: 'full', zoom: 11 };
  for (const zoom of [10, 12]) {
    assert.equal(mapPointLabelModeAfterMove(previous, { sites: 7, persons: 7, zoom }), 'full');
    assert.equal(mapPointLabelModeAfterMove(previous, { sites: 7, persons: 8, zoom }), 'points');
    assert.equal(mapPointLabelModeAfterMove(previous, { sites: 16, persons: 0, zoom }), 'points');
    assert.equal(mapPointLabelModeAfterMove(previous, { sites: 0, persons: 0, zoom }), 'points');
  }
});

test('hover mode can still reveal labels when panning into a sparse area and releases them on the next zoom', () => {
  let previous = { mode: 'points', zoom: 11 };
  for (const [sites, persons, zoom, expected] of [
    [8, 8, 11, 'points'],
    [6, 7, 11, 'full'],
    [20, 20, 11, 'full'],
    [20, 20, 12, 'points'],
    [7, 7, 11, 'full'],
  ]) {
    const mode = mapPointLabelModeAfterMove(previous, { sites, persons, zoom });
    assert.equal(mode, expected);
    previous = { mode, zoom };
  }
});
