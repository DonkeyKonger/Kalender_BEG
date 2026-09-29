import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectThumbnailCache } from '../src/lib/projectThumbnailCache.ts';

test('concurrent requests share one load; folder revisits reuse the versioned preview', async () => {
  const cache = createProjectThumbnailCache();
  let calls = 0;
  const blob = new Blob(['photo']);
  const load = () => { calls++; return Promise.resolve(blob); };
  const first = cache.load('user-session', 'site/folder/photo?v=1', load);
  const second = cache.load('user-session', 'site/folder/photo?v=1', load);
  assert.equal(first, second);
  assert.equal(await first, blob);
  assert.equal(await cache.load('user-session', 'site/folder/photo?v=1', load), blob);
  assert.equal(calls, 1);
  await cache.load('user-session', 'site/folder/photo?v=2', load);
  await cache.load('user-session', 'other-site/folder/photo?v=1', load);
  assert.equal(calls, 3);
});

test('session changes and logout clear previews, including pending loads', async () => {
  const cache = createProjectThumbnailCache();
  let finish;
  const old = cache.load('session-A', 'photo', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  const current = new Blob(['current']);
  await cache.load('session-B', 'photo', async () => current);
  finish(new Blob(['old']));
  await old;
  assert.equal(await cache.load('session-B', 'photo', () => assert.fail('cached')), current);
  cache.clear();
  let calls = 0;
  const load = async () => { calls++; return current; };
  await cache.load('session-B', 'photo', load);
  await cache.load(null, 'photo', load);
  await cache.load(null, 'photo', load);
  assert.equal(calls, 3);
});

test('memory and entry limits evict the least recently used previews', async () => {
  const cache = createProjectThumbnailCache(6, 2);
  const calls = [];
  const load = (key, text = 'aaa') => cache.load('session', key, async () => { calls.push(key); return new Blob([text]); });
  await load('one'); await load('two'); await load('one'); await load('three');
  await load('one'); await load('two');
  assert.deepEqual(calls, ['one', 'two', 'three', 'two']);
  await load('oversized', '1234567'); await load('oversized', '1234567');
  assert.equal(calls.filter(key => key === 'oversized').length, 2);
});

test('expired, failed and unversioned previews are fetched again', async () => {
  const cache = createProjectThumbnailCache(100, 10, 0);
  let calls = 0;
  const load = async () => { calls++; return new Blob(['photo']); };
  await cache.load('session', 'photo', load); await cache.load('session', 'photo', load);
  assert.equal(calls, 2);
  const retained = createProjectThumbnailCache();
  await assert.rejects(retained.load('session', 'photo', async () => { throw new Error('network'); }));
  await retained.load('session', 'photo', load, false);
  await retained.load('session', 'photo', load, false);
  assert.equal(calls, 4);
});
