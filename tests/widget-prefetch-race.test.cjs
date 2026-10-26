const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/widget.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; }
function harness() {
  const events = [], fetches = [], loads = [], warm = deferred();
  const element = () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {} });
  const c = vm.createContext({ URL, URLSearchParams, AbortSignal, setTimeout, clearTimeout, queueMicrotask,
    window: { location: { search: '', origin: 'https://avatar.test' }, parent: { postMessage() {} }, setTimeout, addEventListener() {} },
    document: { querySelector: element, documentElement: { style: { setProperty() {} } }, referrer: '' },
    fetch: async () => new Promise(() => {}),
  });
  vm.runInContext(source, c);
  c.fetchSignPose = async (phrase, current) => { fetches.push({ phrase, current }); return { phrase, pose: { content_url: '/pose/' + phrase }, words: [phrase] }; };
  c.prefetchPoseFile = () => warm.promise;
  c.loadPose = async pose => { loads.push(pose); return {}; };
  c.postToParent = (type, data) => events.push({ type, ...data });
  c.emitStatus = () => {};
  return { c, warm, events, fetches, loads };
}

test('handoff joins the whole in-flight warmup rather than racing another URL load', async () => {
  const h = harness();
  const prefetch = h.c.prefetchSign('AMIGO'); await flush();
  const sign = h.c.requestSign('AMIGO'); await flush();
  assert.equal(h.fetches.length, 1);
  assert.equal(h.loads.length, 0, 'API readiness is not file readiness');
  h.warm.resolve(); await Promise.all([prefetch, sign]);
  assert.equal(h.loads.length, 1);
  assert.equal(vm.runInContext('state.prefetchTasks.size', h.c), 0);
});

test('optional warm download failure still admits the one real pose for playback', async () => {
  const h = harness(); const prefetch = h.c.prefetchSign('AMIGO'); await flush();
  const sign = h.c.requestSign('AMIGO'); h.warm.reject(new Error('download unavailable'));
  await Promise.all([prefetch, sign]);
  assert.equal(h.loads.length, 1); assert.equal(h.fetches.length, 1);
  assert.equal(h.events.filter(e => e.type === 'neotalk:prefetch-error').length, 0);
});

test('warmup concurrency remains bounded and busy notification is non-blocking', async () => {
  const h = harness();
  const jobs = ['AMIGO', 'APRENDER', 'TRABALHAR', 'LIBRAS'].map(phrase => h.c.prefetchSign(phrase));
  await flush(); assert.equal(h.fetches.length, 2);
  assert.equal(vm.runInContext('state.prefetchTasks.size', h.c), 2);
  assert.equal(h.events.filter(e => e.type === 'neotalk:prefetch-error' && e.code === 'prefetch_busy').length, 2);
  h.warm.resolve(); await Promise.all(jobs);
  assert.equal(vm.runInContext('state.prefetchTasks.size', h.c), 0);
  assert.equal(h.loads.length, 0, 'prefetch must not interrupt the active clip');
});

test('avatar generation invalidation cancels stale prefetch publication and cache eligibility', async () => {
  const h = harness(); const job = h.c.prefetchSign('AMIGO'); await flush();
  vm.runInContext('state.prefetchGeneration++', h.c);
  assert.equal(h.fetches[0].current(), false);
  h.warm.resolve(); await job;
  assert.equal(h.events.filter(e => e.type === 'neotalk:prefetch-ready').length, 0);
  assert.equal(vm.runInContext('state.prefetchedPoses.size', h.c), 0);
});

test('a burst cannot create an unbounded service fanout and later playback still works', async () => {
  const h = harness();
  const jobs = Array.from({ length: 100 }, (_, i) => h.c.prefetchSign('SINAL_' + i));
  await flush(); assert.equal(h.fetches.length, 2);
  assert.equal(h.events.filter(e => e.code === 'prefetch_busy').length, 98);
  h.warm.resolve(); await Promise.all(jobs);
  await h.c.requestSign('SINAL_99');
  assert.equal(h.loads.length, 1, 'busy prefetch is not a failed translation');
  assert.equal(h.fetches.length, 3, 'on-demand playback stays available');
});

test('prefetch failure releases its slot and sign retries without retaining the failed task', async () => {
  const h = harness(); let attempts = 0;
  h.c.fetchSignPose = async phrase => {
    if (++attempts === 1) throw new Error('HTTP 502');
    return { phrase, pose: { content_url: '/pose/a' }, words: ['AMIGO'] };
  };
  await h.c.prefetchSign('AMIGO');
  assert.equal(vm.runInContext('state.prefetchTasks.size', h.c), 0);
  await h.c.requestSign('AMIGO');
  assert.equal(attempts, 2); assert.equal(h.loads.length, 1);
});

test('real HTTP warmup/handoff transfers the source once, not twice (Unity/API controlled)', { timeout: 10000 }, async () => {
  const http = require('node:http');
  const requested = deferred(), release = deferred(); let requests = 0;
  const server = http.createServer(async (_req, response) => {
    requests++; requested.resolve(); await release.promise;
    response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('immutable fixture bytes');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const h = harness(), address = 'http://127.0.0.1:' + server.address().port + '/pose/a';
  h.c.fetch = fetch; h.c.resolvePoseUrl = () => address;
  h.c.Blob = Blob;
  vm.runInContext(source.slice(source.indexOf('async function prefetchPoseFile('), source.indexOf('async function prefetchSign(')), h.c);
  let consumed;
  h.c.loadPose = async () => {
    const cached = vm.runInContext('state.poseFiles.get(' + JSON.stringify(address) + ')', h.c);
    consumed = await (await fetch(cached?.url || address)).text(); return {};
  };
  let deadline;
  try {
    const prefetch = h.c.prefetchSign('AMIGO');
    await Promise.race([requested.promise, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Loopback HTTP request unavailable')), 3000);
    })]);
    clearTimeout(deadline);
    const sign = h.c.requestSign('AMIGO'); await flush(); release.resolve();
    await Promise.all([prefetch, sign]);
    assert.equal(requests, 1); assert.equal(consumed, 'immutable fixture bytes');
  } finally {
    clearTimeout(deadline);
    release.resolve();
    for (const item of vm.runInContext('[...state.poseFiles.values()]', h.c)) URL.revokeObjectURL(item.url);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
