import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../frontend/widget.js', import.meta.url), 'utf8');

test('prefetch prepares the next pose without interrupting playback or submitting twice', async () => {
  const emitted = [];
  const requests = [];
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
  const response = (status, payload) => ({ status, ok: status < 400, json: async () => payload, headers: { get: () => null } });
  const sandbox = {
    window,
    document: { querySelector: element, documentElement: { style: { setProperty() {} } }, referrer: '' },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    unityCalls,
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
  vm.runInContext(`state.unity = { SendMessage(_target, method) { unityCalls.push(method); if (method === 'LoadPoseUrl') queueMicrotask(() => listeners.get('avatar3d-pose-load')({ detail: { status: 'success' } })); } };`, context);
  await vm.runInContext("runCommand({ type: 'neotalk:prefetch', phrase: 'OLA' })", context);
  assert.equal(requests.filter((path) => path === '/api/v1/mvp/sign').length, 1);
  assert.equal(unityCalls.filter((method) => method === 'LoadPoseUrl').length, 0);
  assert.ok(emitted.some(({ type }) => type === 'neotalk:prefetch-ready'));
  assert.ok(!emitted.some(({ type }) => type === 'neotalk:playing'));

  await vm.runInContext("runCommand({ type: 'neotalk:sign', phrase: 'OLA' })", context);
  assert.equal(requests.filter((path) => path === '/api/v1/mvp/sign').length, 1);
  assert.equal(unityCalls.filter((method) => method === 'LoadPoseUrl').length, 1);
  assert.ok(emitted.some(({ type }) => type === 'neotalk:playing'));
});

test('sign reuses a prefetch that is still polling', async () => {
  let resolveTask;
  let signRequests = 0;
  const listeners = new Map();
  const emitted = [];
  const element = () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {}, hidden: false, textContent: '' });
  const window = {
    location: { origin: 'https://avatar.example', search: '' },
    parent: { postMessage: (message) => emitted.push(message) },
    addEventListener: (name, handler) => listeners.set(name, handler),
    setTimeout, clearTimeout, devicePixelRatio: 1,
  };
  const response = (status, payload) => ({ status, ok: status < 400, json: async () => payload, headers: { get: () => null } });
  const context = vm.createContext({
    window,
    document: { querySelector: element, documentElement: { style: { setProperty() {} } }, referrer: '' },
    URL, URLSearchParams, setTimeout, clearTimeout, queueMicrotask, listeners,
    fetch: async (path) => {
      if (path === '/api/v1/widget/config') return new Promise(() => {});
      if (path === '/api/v1/mvp/sign') {
        signRequests += 1;
        return response(202, { task_id: 'task-2' });
      }
      return new Promise((resolve) => { resolveTask = () => resolve(response(200, { pose: { content_url: '/api/v1/poses/id/content' }, palavras_encontradas: ['TESTE.pose'] })); });
    },
  });
  vm.runInContext(source, context);
  vm.runInContext(`state.unity = { SendMessage(_target, method) { if (method === 'LoadPoseUrl') queueMicrotask(() => listeners.get('avatar3d-pose-load')({ detail: { status: 'success' } })); } };`, context);
  const prefetch = vm.runInContext("runCommand({ type: 'neotalk:prefetch', phrase: 'TESTE' })", context);
  await new Promise((resolve) => setImmediate(resolve));
  const sign = vm.runInContext("runCommand({ type: 'neotalk:sign', phrase: 'TESTE' })", context);
  resolveTask();
  await Promise.all([prefetch, sign]);
  assert.equal(signRequests, 1);
  assert.ok(emitted.some(({ type }) => type === 'neotalk:playing'));
});
