import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: [new URL('../src/lib/api.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node',
  define: { 'import.meta.env': JSON.stringify({ VITE_API_BASE_URL: 'http://auth-test.invalid/api' }) },
});
let instance = 0;
async function fixture(t, responder) {
  let token = 'expired';
  t.mock.method(globalThis, 'fetch', responder);
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => token, setItem: (_key, value) => { token = value; },
  } });
  t.after(() => oldStorage ? Object.defineProperty(globalThis, 'localStorage', oldStorage) : delete globalThis.localStorage);
  const module = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64') + '#' + instance++);
  return { ...module, logout: () => { token = null; }, switchAccount: () => { token = "different-user"; } };
}
const json = (data, status = 200) => Response.json(data, { status });
const download = api => api.projectPhotoAppendixPdf(1);

test('JSON and downloads share one refresh while preserving binary contents', async t => {
  let refreshCount = 0;
  const requests = [];
  const { api } = await fixture(t, async (url, options) => {
    requests.push([url, options.headers.get('Authorization'), options.headers.get('Accept')]);
    if (url.endsWith('/auth/refresh')) {
      refreshCount++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return json({ access_token: 'renewed' });
    }
    if (options.headers.get('Authorization') !== 'Bearer renewed') return json({ detail: 'expired' }, 401);
    return url.endsWith('/auth/me') ? json({ id: 7 }) : new Response(new Uint8Array([0, 255, 13, 10]));
  });
  const [me, blobA, blobB] = await Promise.all([api.me(), download(api), download(api)]);
  assert.equal(me.id, 7);
  for (const blob of [blobA, blobB]) assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 255, 13, 10]);
  assert.equal(refreshCount, 1);
  assert.equal(requests.length, 7);
  assert(requests.some(([url, auth, accept]) => url.includes('photo-appendix') && auth === 'Bearer renewed' && accept === '*/*'));
});

test('permanent unauthorized sessions stop after one refresh and one retry', async t => {
  let refreshCount = 0, downloadCount = 0;
  const { api, ApiError } = await fixture(t, async url => {
    if (url.endsWith('/auth/refresh')) { refreshCount++; return json({ access_token: 'still-invalid' }); }
    downloadCount++; return json({ detail: 'Session beendet' }, 401);
  });
  await assert.rejects(download(api), error => error instanceof ApiError && error.status === 401);
  assert.equal(refreshCount, 1); assert.equal(downloadCount, 2);
});

test('failed refresh does not retry a download or recurse', async t => {
  const calls = [];
  const { api } = await fixture(t, async url => { calls.push(url); return json({ detail: 'abgelaufen' }, 401); });
  await assert.rejects(download(api), { status: 401 });
  assert.equal(calls.length, 2);
});

test('a late 401 reuses an already refreshed token', async t => {
  let refreshCount = 0;
  const { api } = await fixture(t, async (url, options) => {
    if (url.endsWith('/auth/refresh')) { refreshCount++; return json({ access_token: 'renewed' }); }
    if (options.headers.get('Authorization') === 'Bearer expired') {
      if (url.endsWith('/auth/me')) await new Promise(resolve => setTimeout(resolve, 25));
      return json({ detail: 'expired' }, 401);
    }
    return url.endsWith('/auth/me') ? json({ id: 7 }) : new Response('file');
  });
  await Promise.all([api.me(), download(api)]);
  assert.equal(refreshCount, 1);
});

test('logout during refresh cannot restore the old session', async t => {
  let release, refreshStarted;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { refreshStarted = resolve; });
  const { api, logout, getAccessToken } = await fixture(t, async url => {
    if (url.endsWith('/auth/refresh')) { refreshStarted(); await pending; return json({ access_token: 'renewed' }); }
    return json({ detail: 'expired' }, 401);
  });
  const result = assert.rejects(download(api), { status: 401 });
  await started; logout(); release(); await result;
  assert.equal(getAccessToken(), null);
});

test('aborting a file request during shared refresh prevents its retry', async t => {
  let release, refreshStarted, downloadCount = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { refreshStarted = resolve; });
  const controller = new AbortController();
  const { api } = await fixture(t, async url => {
    if (url.endsWith('/auth/refresh')) { refreshStarted(); await pending; return json({ access_token: 'renewed' }); }
    downloadCount++; return json({ detail: 'expired' }, 401);
  });
  const result = assert.rejects(api.siteExtraWorkTicketPhotoContent(1, 2, 3, { signal: controller.signal }), { name: 'AbortError' });
  await started; controller.abort(); release(); await result;
  assert.equal(downloadCount, 1);
});


test('a delayed unauthorized response is not replayed under a newly logged-in account', async t => {
  let release, requestStarted, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requestStarted = resolve; });
  const { api, switchAccount } = await fixture(t, async () => {
    calls++; requestStarted(); await pending; return json({ detail: 'expired' }, 401);
  });
  const result = assert.rejects(download(api), { status: 401 });
  await started; switchAccount(); release(); await result;
  assert.equal(calls, 1);
});
