const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/widget.js'), 'utf8');

function runtime() {
  const state = { unity: {}, runtimeSequence: 1, activePoseRuntimeSequence: null,
    pendingPoseLoad: null, loop: false, nativePlayback: false, playbackContext: null };
  const commands = [], events = [], listeners = {};
  let serial = 0;
  const sandbox = { state, URL, Date, Number, performance, clearTimeout,
    elements: { loader: { classList: { add() {} } } },
    window: { setTimeout, addEventListener: (type, fn) => { listeners[type] = fn; } },
    nextPoseLoadId: () => `play-${++serial}`,
    resolvePoseUrl: value => new URL(value, 'https://widget.test').href,
    clearError() {}, emitStatus() {}, reportPoseStage() {}, poseNetworkTiming: () => 0,
    postToParent: (type, detail) => events.push({ type, ...detail }),
    poseAckTimeoutMs: 1000, maxPoseLoadAttempts: 2,
    sendUnity(method, value) {
      commands.push({ method, value });
      if (method === 'LoadPoseUrl') queueMicrotask(() => {
        const pending = state.pendingPoseLoad;
        clearTimeout(pending.timeout);
        state.pendingPoseLoad = null;
        pending.resolve();
      });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('async function loadPose('), source.indexOf('const wait =')), sandbox);
  return { state, commands, events, load: sandbox.loadPose,
    report: detail => listeners['avatar3d-playback']({ detail }) };
}

test('old runtime never receives the new Unity method', async () => {
  const r = runtime();
  await r.load({ content_url: '/amigo.pose' });
  assert.equal(r.commands.some(c => c.method === 'SetPlaybackId'), false);
});

test('native capability arms a fresh generation after ACK, including cached replay', async () => {
  const r = runtime();
  r.report({ status: 'ready' });
  await r.load({ content_url: '/amigo.pose' });
  await r.load({ content_url: '/amigo.pose' });
  assert.equal(r.commands.filter(c => c.method === 'LoadPoseUrl').length, 1);
  assert.deepEqual(r.commands.filter(c => c.method === 'SetPlaybackId').map(c => c.value), ['play-1', 'play-2']);
  for (let i = 0; i < r.commands.length; i++) {
    if (r.commands[i].method === 'PlayFromStart') assert.equal(r.commands[i - 1].method, 'SetPlaybackId');
  }
});

test('late/invalid/duplicate frames cannot finish another playback', async () => {
  const r = runtime();
  r.report({ status: 'ready' });
  await r.load({ content_url: '/amigo.pose' });
  await r.load({ content_url: '/aprender.pose' });
  const report = (status, playbackId = 'play-2', frame = 9, frameCount = 10) => r.report({ status, playbackId, frame, frameCount, revision: 2, fps: 30 });
  report('finished', 'play-1');
  report('finished', 'play-2', 8);
  report('progress', 'play-2', -1);
  report('unexpected');
  assert.equal(r.events.length, 0);
  report('preparing', 'play-2', 0);
  report('started', 'play-2', 0);
  report('progress', 'play-2', 5);
  report('finished');
  report('finished');
  assert.deepEqual(r.events.map(e => e.status), ['preparing', 'started', 'progress', 'finished']);
  assert.ok(r.events.every(e => e.correlationId === 'play-2'));
});

test('Unity JS bridge preserves native payload without inventing completion', (t) => {
  const file = process.env.ELIA_UNITY_BRIDGE || 'C:/Users/felip/PoseAvatarTest/Assets/Plugins/WebGL/Avatar3DBridge.jslib';
  if (!fs.existsSync(file)) { t.skip('Unity source bridge is not present; set ELIA_UNITY_BRIDGE to validate it'); return; }
  let library, event;
  const sandbox = { LibraryManager: { library: {} }, mergeInto: (_, value) => { library = value; },
    UTF8ToString: value => value, CustomEvent: function(type, options) { this.type = type; this.detail = options.detail; },
    window: { dispatchEvent: value => { event = value; } } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  library.Avatar3DNotifyPlayback(JSON.stringify({ status: 'preparing', frame: 0, frameCount: 20, playbackId: 'a' }));
  assert.equal(event.type, 'avatar3d-playback');
  assert.equal(event.detail.status, 'preparing');
  assert.equal(event.detail.playbackId, 'a');
});

test('silent native preview reveals a rendered posture without completing a room phrase', async () => {
  const r = runtime();
  r.report({ status: 'ready' });
  await r.load({ content_url: '/StreamingAssets/preview.pose' }, { preview: true });
  r.report({ status: 'preparing', playbackId: 'play-1', frame: 0, frameCount: 10 });
  assert.equal(r.commands.some(c => c.method === 'PausePlayback'), false);
  r.report({ status: 'started', playbackId: 'play-1', frame: 0, frameCount: 10 });
  assert.equal(r.commands.at(-1).method, 'PausePlayback');
  assert.equal(r.events.length, 0);
  await r.load({ content_url: '/real.pose' });
  r.report({ status: 'started', playbackId: 'play-2', frame: 0, frameCount: 10 });
  assert.equal(r.events.at(-1).status, 'started');
});

test('Elia initialization prepares its bundled preview before announcing readiness', () => {
  const init = source.slice(source.indexOf('async function initializeAvatar'), source.indexOf('async function loadPose'));
  assert.ok(init.indexOf('{ preview: true }') < init.indexOf('emitStatus("ready")'));
  assert.match(init, /StreamingAssets\/frase_hoje_eu_aprender_libras_entao_comunicacao_melhorar\.pose/);
});
