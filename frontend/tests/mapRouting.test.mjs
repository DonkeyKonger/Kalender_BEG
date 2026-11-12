import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRoutePlaces, createDrivingRouteClient, fillNextRouteField, formatDrivingRoute,
  personRoutePlace, searchRoutePlaces, siteRoutePlace,
} from '../src/lib/mapRouting.ts';

const site = { id: 1, name: 'Klinik Bremen', number: '8001', street: 'Hauptstraße', house_number: '12', postal_code: '28195', city: 'Bremen', latitude: 53.0793, longitude: 8.8017, status: 'active' };
const person = { id: 1, display_name: 'Jörg Müller', short_name: 'J.Müller', address_formatted: 'Markt 1, 20095 Hamburg', address_latitude: 53.5511, address_longitude: 9.9937, active: true };
const start = personRoutePlace(person), end = siteRoutePlace(site);
const empty = () => ({ query: '', place: null });
const signal = () => new AbortController().signal;
const response = (payload = { code: 'Ok', routes: [{ distance: 127467.4, duration: 5166.7 }] }, status = 200) => new Response(JSON.stringify(payload), { status });

test('stored names, numbers, address parts and umlauts are searchable across marker filters', () => {
  const places = buildRoutePlaces([
    site, { ...site, id: 2, status: 'paused' }, { ...site, id: 3, status: 'completed' },
    { ...site, id: 4, latitude: NaN },
  ], [person, { ...person, id: 2, active: false }]);
  assert.equal(places.length, 2);
  assert.deepEqual(searchRoutePlaces(places, 'jorg muller'), [start]);
  assert.deepEqual(searchRoutePlaces(places, '8001 bremen'), [end]);
  assert.deepEqual(searchRoutePlaces(places, 'hauptstrasse 12'), [end]);
  assert.deepEqual(searchRoutePlaces(places, '20095'), [start]);
  assert.equal(start.address, person.address_formatted);
  assert.equal(end.address, 'Hauptstraße 12, 28195 Bremen');
  assert.notEqual(start.key, end.key);
});

test('marker clicks fill first then second, preserve typed addresses and never overwrite a full pair', () => {
  const initial = [empty(), empty()];
  const first = fillNextRouteField(initial, start);
  const second = fillNextRouteField(first, end);
  assert.equal(initial[0].place, null);
  assert.equal(first[0].place, start);
  assert.equal(second[1].place, end);
  assert.equal(fillNextRouteField(second, start), second);
  assert.equal(fillNextRouteField([{ query: 'Bremen', place: null }, empty()], start)[1].place, start);
  assert.equal(fillNextRouteField([empty(), second[1]], start)[0].place, start);
  assert.equal(fillNextRouteField(initial, { ...start, latitude: 91 }), initial);
});

test('driving result uses German kilometers and rounded minutes with correct hour rollover', () => {
  assert.equal(formatDrivingRoute({ distanceMeters: 127467.4, durationSeconds: 5166.7 }), '127,5 km · ca. 1 Std. 26 Min.');
  assert.equal(formatDrivingRoute({ distanceMeters: 1250, durationSeconds: 3599 }), '1,3 km · ca. 1 Std.');
  assert.equal(formatDrivingRoute({ distanceMeters: 0, durationSeconds: 0 }), '0 km · ca. 0 Min.');
  assert.equal(formatDrivingRoute({ distanceMeters: 20, durationSeconds: 5 }), '0 km · ca. 1 Min.');
});

test('requests use longitude/latitude and transmit no names or application credentials; directional results are cached', async () => {
  const calls = [];
  const client = createDrivingRouteClient({ minimumIntervalMs: 0, fetcher: async (url, options) => { calls.push({ url, options }); return response(); } });
  const result = await client(start, end, signal());
  assert.deepEqual(result, { distanceMeters: 127467.4, durationSeconds: 5166.7 });
  assert.equal(await client(start, end, signal()), result);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/9\.9937,53\.5511;8\.8017,53\.0793\?/);
  assert(!calls[0].url.includes('Müller'));
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.headers, undefined);
  await client(end, start, signal());
  assert.equal(calls.length, 2);
});

test('identical coordinates produce zero without contacting the provider; invalid coordinates fail locally', async () => {
  const client = createDrivingRouteClient({ fetcher: async () => assert.fail('No provider call expected') });
  assert.deepEqual(await client(start, { ...start, key: 'another' }, signal()), { distanceMeters: 0, durationSeconds: 0 });
  await assert.rejects(client({ ...start, longitude: Infinity }, end, signal()), /Kartenkoordinaten/);
});

test('missing routes and malformed/provider failures never become straight-line estimates', async () => {
  for (const [payload, status, expected] of [
    [{ code: 'NoRoute' }, 200, /keine befahrbare Route/],
    [{ code: 'NoSegment' }, 400, /keine befahrbare Route/],
    [{ code: 'Ok', routes: [] }, 200, /nicht verfügbar/],
    [{ code: 'Ok', routes: [{ distance: -1, duration: 50 }] }, 200, /nicht verfügbar/],
    [{ code: 'Ok', routes: [{ distance: '500', duration: 50 }] }, 200, /nicht verfügbar/],
    [null, 503, /nicht verfügbar/],
  ]) {
    const client = createDrivingRouteClient({ minimumIntervalMs: 0, fetcher: async () => response(payload, status) });
    await assert.rejects(client(start, end, signal()), expected);
  }
  const client = createDrivingRouteClient({ minimumIntervalMs: 0, fetcher: async () => new Response('<html>Bad gateway</html>') });
  await assert.rejects(client(start, end, signal()), /nicht verfügbar/);
});

test('aborted requests do not fill the cache or block the next route; queued cancellations skip the provider', async () => {
  let calls = 0, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const client = createDrivingRouteClient({ minimumIntervalMs: 0, fetcher: async (_url, options) => {
    calls++;
    if (calls === 1) { entered(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))); }
    return response();
  } });
  const firstController = new AbortController(), queuedController = new AbortController();
  const first = client(start, end, firstController.signal);
  const queued = client(end, start, queuedController.signal);
  const failures = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(queued, { name: 'AbortError' })]);
  await ready;
  queuedController.abort(); firstController.abort();
  await failures;
  await client(start, end, signal());
  assert.equal(calls, 2);
});

test('timeouts and network errors permit retry; expired cache entries are recalculated', async () => {
  let calls = 0;
  const client = createDrivingRouteClient({ minimumIntervalMs: 0, timeoutMs: 15, cacheTtlMs: 0, fetcher: async (_url, options) => {
    calls++;
    if (calls === 1) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
    if (calls === 2) throw new TypeError('network disconnected');
    return response();
  } });
  await assert.rejects(client(start, end, signal()), /nicht verfügbar/);
  await assert.rejects(client(start, end, signal()), /nicht verfügbar/);
  await client(start, end, signal()); await client(start, end, signal());
  assert.equal(calls, 4);
});

test('concurrent provider requests respect the request interval', async () => {
  const times = [];
  const client = createDrivingRouteClient({ minimumIntervalMs: 60, fetcher: async () => { times.push(Date.now()); return response(); } });
  await Promise.all([client(start, end, signal()), client(end, start, signal())]);
  assert.equal(times.length, 2);
  assert(times[1] - times[0] >= 55);
});
