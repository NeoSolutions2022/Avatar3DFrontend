import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../frontend/widget.js', import.meta.url), 'utf8');

test('a mirrored widget plays a shared pose without submitting another task', async () => {
  const emitted = [];
  const unityCalls = [];
  const listeners = new Map();
  const element = () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {}, hidden: false, textContent: '' });
  const window = {
    location: { origin: 'https://avatar.example', search: '' },
    parent: { postMessage: (message) => emitted.push(message) },
    addEventListener: (name, handler) => listeners.set(name, handler),
    setTimeout,
    clearTimeout,
    devicePixelRatio: 1,
  };
  const document = { querySelector: element, documentElement: { style: { setProperty() {} } }, referrer: '' };
  let signRequests = 0;
  const sandbox = {
    window,
    document,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    unityCalls,
    listeners,
    fetch: async () => { signRequests += 1; return new Promise(() => {}); },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  vm.runInContext(`state.unity = { SendMessage(_target, method, value) { unityCalls.push({ method, value }); if (method === 'LoadPoseUrl') queueMicrotask(() => listeners.get('avatar3d-pose-load')({ detail: { status: 'success' } })); } };`, context);
  sandbox.message = { type: 'neotalk:load-pose', phrase: 'TESTE', pose: { content_url: '/api/v1/poses/id/content', fps: 24 }, words: ['TESTE'] };
  await vm.runInContext('runCommand(message)', context);
  assert.equal(signRequests, 1); // bootstrap config fetch only
  assert.ok(unityCalls.some(({ method }) => method === 'LoadPoseUrl'));
  assert.ok(emitted.some(({ type, shared }) => type === 'neotalk:playing' && shared));
});

test('the primary widget shares one completed pose before playback', async () => {
  const emitted = [];
  const listeners = new Map();
  const requests = [];
  const element = () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {}, hidden: false, textContent: '' });
  const window = {
    location: { origin: 'https://avatar.example', search: '' },
    parent: { postMessage: (message) => emitted.push(message) },
    addEventListener: (name, handler) => listeners.set(name, handler),
    setTimeout,
    clearTimeout,
    devicePixelRatio: 1,
  };
  const response = (status, payload) => ({ status, ok: status < 400, json: async () => payload, headers: { get: () => null } });
  const sandbox = {
    window,
    document: { querySelector: element, documentElement: { style: { setProperty() {} } }, referrer: '' },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    listeners,
    fetch: async (path) => {
      requests.push(path);
      if (path === '/api/v1/widget/config') return new Promise(() => {});
      if (path === '/api/v1/mvp/sign') return response(202, { task_id: 'task-1' });
      return response(200, { pose: { content_url: '/api/v1/poses/id/content', fps: 24 }, palavras_encontradas: ['OLA.pose'] });
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  vm.runInContext(`pollScheduleMs[0] = 0; state.unity = { SendMessage(_target, method) { if (method === 'LoadPoseUrl') queueMicrotask(() => listeners.get('avatar3d-pose-load')({ detail: { status: 'success' } })); } };`, context);
  await vm.runInContext("requestSign('OLA')", context);
  assert.equal(requests.filter((path) => path === '/api/v1/mvp/sign').length, 1);
  assert.equal(requests.filter((path) => path.startsWith('/api/v1/mvp/tasks/')).length, 1);
  const readyIndex = emitted.findIndex(({ type }) => type === 'neotalk:pose-ready');
  const playingIndex = emitted.findIndex(({ type }) => type === 'neotalk:playing');
  assert.ok(readyIndex >= 0 && readyIndex < playingIndex);
  assert.equal(emitted[readyIndex].pose.content_url, '/api/v1/poses/id/content');
});
