const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/widget.js'), 'utf8');
const functionSource = source.slice(source.indexOf('async function loadPose('), source.indexOf('window.addEventListener("avatar3d-pose-load"'));

function createRuntime() {
  const commands = [];
  const state = { unity: {}, runtimeSequence: 1, activePose: null, activePoseRuntimeSequence: null, pendingPoseLoad: null, loop: false };
  const sandbox = {
    state, URL, Date, performance, clearTimeout,
    window: { setTimeout },
    nextPoseLoadId: () => 'test-load',
    resolvePoseUrl: value => new URL(value, 'https://avatar.test').href,
    clearError() {}, emitStatus() {}, reportPoseStage() {}, poseNetworkTiming: () => 0,
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
  vm.runInContext(functionSource + '\nthis.loadPose = loadPose;', sandbox);
  return { state, commands, loadPose: sandbox.loadPose };
}

test('repeating the active pose restarts playback without rebuilding the Unity pose', async () => {
  const runtime = createRuntime();
  const pose = { content_url: '/pose/amigo/content', fps: 30 };
  for (let iteration = 0; iteration < 12; iteration++) await runtime.loadPose(pose);
  assert.equal(runtime.commands.filter(c => c.method === 'LoadPoseUrl').length, 1);
  assert.equal(runtime.commands.filter(c => c.method === 'PlayFromStart').length, 12);
});

test('a different pose and a replacement avatar runtime must load normally', async () => {
  const runtime = createRuntime();
  await runtime.loadPose({ content_url: '/pose/amigo/content' });
  await runtime.loadPose({ content_url: '/pose/aprender/content' });
  runtime.state.runtimeSequence++;
  await runtime.loadPose({ content_url: '/pose/aprender/content' });
  assert.equal(runtime.commands.filter(c => c.method === 'LoadPoseUrl').length, 3);
});
