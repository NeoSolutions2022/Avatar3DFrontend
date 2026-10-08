const params = new URLSearchParams(window.location.search);
const supportedAvatars = new Set(["asuna", "lia", "elia"]);
const initialAvatar = String(params.get("avatar") || "").trim().toLowerCase();
const defaults = { asuna: 1, lia: 1.28, elia: 1.28 };
const minZoom = 0.76;
const maxZoom = 1.48;
const pollScheduleMs = [0, 300, 500, 800, 1200];
// Mantem aproximadamente os mesmos cinco minutos de tolerancia do fluxo
// anterior, mesmo estabilizando as consultas seguintes em 1,2 segundo.
const maxPollAttempts = 250;
const maxCachedPoses = 24;
const poseAckTimeoutMs = 28000;
const maxPoseLoadAttempts = 2;
const initialControllerWindow = window.parent;

const state = {
  allowedOrigins: [],
  trustedParentOrigin: null,
  avatar: supportedAvatars.has(initialAvatar) ? initialAvatar : "lia",
  background: validColor(params.get("background")) || "#ffffff",
  loop: params.get("loop") !== "0" && params.get("loop") !== "false",
  zoom: clampZoom(Number(params.get("zoom")) || 0),
  runtimeObject: "Pose skeleton Preview",
  unity: null,
  loaderScript: null,
  runtimeSequence: 0,
  requestSequence: 0,
  poseLoadSequence: 0,
  activePose: null,
  activePoseRuntimeSequence: null,
  pendingPoseLoad: null,
  poseCache: new Map(),
  prefetchTasks: new Map(),
  prefetchedPoses: new Map(),
  prefetchGeneration: 0,
  nativePlayback: false,
  playbackContext: null,
  poseFiles: new Map(),
  poseFileTasks: new Map(),
  poseFileBytes: 0,
  presentation: null,
  presentationGeneration: 0,
};
if (!state.zoom) state.zoom = defaults[state.avatar];

const elements = {
  stage: document.querySelector("#widget-stage"),
  canvas: document.querySelector("#unity-canvas"),
  loader: document.querySelector("#widget-loader"),
  loaderTitle: document.querySelector("#loader-title"),
  loaderMessage: document.querySelector("#loader-message"),
  progress: document.querySelector("#unity-progress"),
  controls: document.querySelector("#widget-controls"),
  error: document.querySelector("#widget-error"),
  appVersion: document.querySelector("#app-version"),
  zoomOut: document.querySelector("#zoom-out"),
  zoomReset: document.querySelector("#zoom-reset"),
  zoomIn: document.querySelector("#zoom-in"),
};

elements.controls.hidden = params.get("controls") !== "1";
applyBackground(state.background);
refreshZoomLabel();

function validColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function clampZoom(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(maxZoom, Math.max(minZoom, value));
}

function pollDelayForAttempt(attempt) {
  return pollScheduleMs[Math.min(attempt, pollScheduleMs.length - 1)];
}

function normalizeOrigin(value) {
  try { return new URL(value).origin; } catch (_) { return null; }
}

function originAllowed(origin) {
  return Boolean(origin) && (
    state.allowedOrigins.includes("*") || state.allowedOrigins.includes(origin)
  );
}

function applyBackground(value) {
  const color = validColor(value);
  if (!color) return false;
  state.background = color;
  document.documentElement.style.setProperty("--widget-background", color);
  sendUnity("SetBackgroundColor", color);
  return true;
}

function postToParent(type, detail = {}) {
  if (window.parent === window) return;
  // Sandboxed preview frames have the opaque serialized origin `null`, which
  // cannot be used as a postMessage targetOrigin. In the explicitly open
  // widget mode, reply with `*`; inbound messages are still checked by
  // originAllowed before this origin is trusted.
  const targetOrigin = state.trustedParentOrigin && state.trustedParentOrigin !== "null"
    ? state.trustedParentOrigin
    : "*";
  window.parent.postMessage({ type, avatar: state.avatar, ...detail }, targetOrigin);
}

function emitStatus(status, detail = {}) {
  postToParent("neotalk:status", { status, ...detail });
}

function nextPoseLoadId() {
  state.poseLoadSequence += 1;
  return `${Date.now().toString(36)}-${state.poseLoadSequence}`;
}

function reportPoseStage(stage, context, detail = {}) {
  postToParent("neotalk:pose-stage", {
    stage,
    loadId: context.loadId,
    correlationId: context.correlationId || context.loadId,
    traceId: context.traceId || null,
    taskId: context.taskId || null,
    poseId: context.poseId,
    ...detail,
  });
}

function poseNetworkTiming(url, startedAt) {
  if (typeof performance === "undefined" || typeof performance.getEntriesByName !== "function") return null;
  const entries = performance.getEntriesByName(url, "resource");
  const entry = entries.filter((item) => item.startTime >= startedAt - 1).at(-1);
  return entry ? Math.round(entry.responseEnd - entry.startTime) : null;
}

function showError(message, code = "widget_error") {
  elements.error.textContent = message;
  elements.error.hidden = false;
  elements.loader.classList.add("hidden");
  postToParent("neotalk:error", { code, message });
}

function clearError() {
  elements.error.hidden = true;
  elements.error.textContent = "";
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  let payload = {};
  try { payload = await response.json(); } catch (_) { /* empty body */ }
  if (!response.ok && response.status !== 202) {
    const error = new Error(typeof payload.detail === "string" ? payload.detail : `Falha HTTP ${response.status}`);
    error.status = response.status;
    error.stage = response.headers.get("X-NeoTalk-Failure-Stage") || (path === "/api/v1/mvp/sign" ? "submit" : "task_status");
    error.traceId = response.headers.get("X-NeoTalk-Trace-ID");
    throw error;
  }
  return { response, payload };
}

function sendUnity(method, value) {
  if (!state.unity) return false;
  if (value === undefined) state.unity.SendMessage(state.runtimeObject, method);
  else state.unity.SendMessage(state.runtimeObject, method, String(value));
  return true;
}

function runtimeAssetUrl(value, runtimeBase, manifest) {
  const url = new URL(value, runtimeBase);
  url.searchParams.set("build", manifest.builtAtUtc || "20261008-elia29");
  return url.href;
}

function refreshZoomLabel() {
  elements.zoomReset.textContent = `${Math.round(state.zoom * 100)}%`;
}

function phraseKey(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function cachePose(phrase, pose, words) {
  const key = phraseKey(phrase);
  if (!key || !pose?.content_url) return;
  state.poseCache.delete(key);
  state.poseCache.set(key, { pose, words: Array.isArray(words) ? words : [] });
  while (state.poseCache.size > maxCachedPoses) {
    state.poseCache.delete(state.poseCache.keys().next().value);
  }
}

function setZoom(value) {
  const zoom = clampZoom(Number(value));
  if (!zoom) return false;
  state.zoom = zoom;
  refreshZoomLabel();
  sendUnity("SetCameraZoom", zoom.toFixed(2));
  return true;
}

function resolvePoseUrl(value) {
  const parsed = new URL(value, window.location.origin);
  if (parsed.origin !== window.location.origin) {
    throw new Error("A URL da pose precisa pertencer ao servidor do widget.");
  }
  return parsed.href;
}

async function readCatalogAvatar(avatarId) {
  const response = await fetch("/webgl/catalog.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Catálogo de avatares indisponível.");
  const catalog = await response.json();
  return catalog.avatars.find((item) => item.id === avatarId)
    || catalog.avatars.find((item) => item.id === catalog.defaultAvatar);
}

async function unloadRuntime() {
  const previous = state.unity;
  state.unity = null;
  state.playbackContext = null;
  if (previous?.Quit) {
    try { await previous.Quit(); } catch (_) { /* runtime already closed */ }
  }
  if (state.loaderScript) {
    state.loaderScript.remove();
    state.loaderScript = null;
  }
  state.nativePlayback = false;
}

async function initializeAvatar(avatarId, resumePose = state.activePose) {
  if (!supportedAvatars.has(avatarId)) throw new Error("Avatar inválido.");
  if (avatarId !== state.avatar) {
    state.prefetchGeneration += 1;
    state.prefetchedPoses.clear();
    state.prefetchTasks.clear();
  }
  const sequence = ++state.runtimeSequence;
  if (state.pendingPoseLoad) {
    clearTimeout(state.pendingPoseLoad.timeout);
    const cancellation = new Error("Carregamento cancelado pela troca de avatar.");
    cancellation.name = "AbortError";
    state.pendingPoseLoad.reject(cancellation);
    state.pendingPoseLoad = null;
  }
  state.avatar = avatarId;
  if (!params.has("zoom")) state.zoom = defaults[avatarId];
  clearError();
  elements.loader.classList.remove("hidden");
  elements.loaderTitle.textContent = `Preparando ${avatarId === "asuna" ? "Asuna" : avatarId.toUpperCase()}`;
  elements.loaderMessage.textContent = "Carregando o renderizador 3D...";
  elements.progress.style.width = "0%";
  emitStatus("loading_avatar");

  await unloadRuntime();
  if (sequence !== state.runtimeSequence) return;

  const avatar = await readCatalogAvatar(avatarId);
  if (!avatar) throw new Error("Build do avatar não encontrado.");
  const manifestUrl = new URL(avatar.manifestUrl, `${window.location.origin}/webgl/`);
  const manifestResponse = await fetch(manifestUrl, { cache: "no-store" });
  if (!manifestResponse.ok) throw new Error("Manifesto WebGL não encontrado.");
  const manifest = await manifestResponse.json();
  state.runtimeObject = manifest.runtimeObject || state.runtimeObject;
  const runtimeBase = new URL("./", manifestUrl);

  const script = document.createElement("script");
  script.src = runtimeAssetUrl(manifest.loaderUrl, runtimeBase, manifest);
  script.async = true;
  state.loaderScript = script;
  document.body.appendChild(script);
  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(new Error("Falha ao carregar o motor 3D."));
  });

  const instance = await createUnityInstance(
    elements.canvas,
    {
      dataUrl: runtimeAssetUrl(manifest.dataUrl, runtimeBase, manifest),
      frameworkUrl: runtimeAssetUrl(manifest.frameworkUrl, runtimeBase, manifest),
      codeUrl: runtimeAssetUrl(manifest.codeUrl, runtimeBase, manifest),
      streamingAssetsUrl: new URL("StreamingAssets", runtimeBase).href,
      companyName: "NeoTalk",
      productName: `NeoTalk ${avatar.name}`,
      productVersion: "2026.10.08-elia.29",
      matchWebGLToCanvasSize: true,
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, avatarId === "asuna" ? 2 : 2.25),
    },
    (value) => { elements.progress.style.width = `${Math.round(value * 100)}%`; },
  );

  if (sequence !== state.runtimeSequence) {
    if (instance?.Quit) await instance.Quit();
    return;
  }

  state.unity = instance;
  elements.appVersion.title = `${avatar.name} WebGL ${manifest.builtAtUtc || "sem data"}`;
  sendUnity("SetBackgroundColor", state.background);
  sendUnity("SetCameraZoom", state.zoom.toFixed(2));
  sendUnity("SetLoop", state.loop ? "true" : "false");
  sendUnity("PausePlayback");
  refreshZoomLabel();
  elements.canvas.setAttribute("aria-label", `Avatar ${avatar.name} 3D`);
  // A native runtime is technically ready before its first prepared pose is
  // rendered. Keep the loading cover until that real frame, not the load ACK.
  if (!state.nativePlayback) elements.loader.classList.add("hidden");
  else {
    elements.loaderTitle.textContent = "Pronta para sinalizar";
    elements.loaderMessage.textContent = "Aguardando o primeiro trecho...";
  }
  // A preview has no speech command to unlock the native loading cover.
  // Prepare the bundled source, then hold its first actually rendered frame.
  // This is presentation only: never report it as a translated room phrase.
  if (state.nativePlayback && !resumePose && avatarId === "elia") {
    await loadPose({ content_url: new URL("StreamingAssets/frase_hoje_eu_aprender_libras_entao_comunicacao_melhorar.pose", runtimeBase).href, fps: 30 }, { preview: true });
  }
  emitStatus("ready");
  postToParent("neotalk:ready", {
    version: "2026.10.08-elia.29",
    avatars: [...supportedAvatars],
    capabilities: ["sign", "replay", "shared-pose", "prefetch", "prefetch-pose", "presentation-playlist", "avatar", "zoom", "loop", "background", "playback", ...(state.nativePlayback ? ["native-playback-progress"] : [])],
  });

  if (resumePose) await loadPose(resumePose);
}

async function loadPose(pose, options = {}) {
  if (!state.unity) throw new Error("O avatar ainda não está pronto.");
  if (!pose || !pose.content_url) throw new Error("A resposta não contém uma pose válida.");
  const url = resolvePoseUrl(pose.content_url);
  const context = {
    loadId: options.loadId || nextPoseLoadId(),
    correlationId: options.correlationId,
    traceId: options.traceId,
    taskId: options.taskId,
    poseId: new URL(url).pathname.split("/").at(-2) || "unknown",
    preview: options.preview === true,
    presentationId: options.presentationId,
  };
  clearError();
  reportPoseStage("pose_available", context);
  sendUnity("SetFps", pose.fps || 30);
  sendUnity("SetLoop", state.loop ? "true" : "false");

  // Recarregar a pose ativa reinicia a preparação corporal do Unity. O loop
  // deve reiniciar a reprodução existente, sem recriar os dados de retarget.
  // Uma nova instância do avatar precisa carregar a pose normalmente.
  if (!state.pendingPoseLoad
      && state.activePoseRuntimeSequence === state.runtimeSequence
      && state.activePose?.content_url
      && resolvePoseUrl(state.activePose.content_url) === url) {
    state.playbackContext = { ...context, phrase: options.phrase, finished: false };
    if (state.nativePlayback) sendUnity("SetPlaybackId", context.loadId);
    sendUnity("PlayFromStart");
    reportPoseStage("play_requested", context, { cached: true, reloaded: false });
    return context;
  }

  emitStatus("loading_pose", { loadId: context.loadId });

  if (state.pendingPoseLoad) {
    clearTimeout(state.pendingPoseLoad.timeout);
    const cancellation = new Error("Carregamento substituído por uma nova pose.");
    cancellation.name = "AbortError";
    state.pendingPoseLoad.reject(cancellation);
    state.pendingPoseLoad = null;
  }

  const attempts = context.presentationId ? 1 : maxPoseLoadAttempts;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
    const startedAtWall = Date.now();
    reportPoseStage("load_sent", context, { attempt });
    try {
      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          state.pendingPoseLoad = null;
          const error = new Error("O avatar não confirmou o carregamento da pose.");
          error.code = "pose_ack_timeout";
          reject(error);
        }, context.presentationId ? 300000 : poseAckTimeoutMs);
        state.pendingPoseLoad = { resolve, reject, timeout, loadId: context.loadId, attempt, url };
        sendUnity("LoadPoseUrl", state.poseFiles?.get(url)?.url || url);
      });
      reportPoseStage("unity_ack", context, { attempt, elapsedMs: Date.now() - startedAtWall, networkMs: poseNetworkTiming(url, startedAt), acknowledgedPoseId: false });
      state.activePose = pose;
      state.activePoseRuntimeSequence = state.runtimeSequence;
      sendUnity("SetLoop", state.loop ? "true" : "false");
      state.playbackContext = { ...context, phrase: options.phrase, finished: false };
      if (state.nativePlayback) sendUnity("SetPlaybackId", context.loadId);
      sendUnity("PlayFromStart");
      reportPoseStage("play_requested", context, { attempt });
      return context;
    } catch (error) {
      if (error.name === "AbortError") {
        reportPoseStage("cancelled", context, { attempt });
        throw error;
      }
      reportPoseStage(error.code === "pose_ack_timeout" ? "unity_ack_timeout" : "unity_load_error", context, {
        attempt,
        elapsedMs: Date.now() - startedAtWall,
        networkMs: poseNetworkTiming(url, startedAt),
      });
      if (attempt === attempts) {
        error.code = error.code || "pose_load_failed";
        error.loadId = context.loadId;
        error.correlationId = context.correlationId || context.loadId;
        error.traceId = context.traceId || null;
        throw error;
      }
      emitStatus("recovering", { loadId: context.loadId });
    }
  }
}

window.addEventListener("avatar3d-pose-load", (event) => {
  const pending = state.pendingPoseLoad;
  if (!pending) return;
  const detail = event.detail || {};
  if (detail.loadId && detail.loadId !== pending.loadId) return;
  state.pendingPoseLoad = null;
  clearTimeout(pending.timeout);
  if (detail.status === "success") pending.resolve();
  else pending.reject(new Error(detail.message || "Falha ao carregar a pose."));
});

window.addEventListener("avatar3d-playback", (event) => {
  const detail = event.detail || {};
  if (detail.status === "ready") {
    state.nativePlayback = true;
    return;
  }
  if (!state.nativePlayback) return;
  const context = state.playbackContext;
  if (!context || detail.playbackId !== context.loadId || context.finished) return;
  if (!["preparing", "started", "progress", "finished"].includes(detail.status)) return;
  if (!Number.isInteger(detail.frame) || !Number.isInteger(detail.frameCount)
      || detail.frame < 0 || detail.frameCount < 1 || detail.frame >= detail.frameCount) return;
  if (detail.status === "finished" && detail.frame !== detail.frameCount - 1) return;
  if (detail.status === "started" || detail.status === "progress" || detail.status === "finished") elements.loader.classList.add("hidden");
  if (context.presentationId) {
    const presentation = state.presentation;
    if (!presentation || presentation.id !== context.presentationId) return;
    if (!presentation.ready && ["started", "progress", "finished"].includes(detail.status)) {
      sendUnity("PausePlayback");
      presentation.ready = true;
      clearTimeout(presentation.timeout);
      postToParent("neotalk:presentation-ready", { playlistId: presentation.id, frameCount: detail.frameCount, sequences: presentation.sequences });
    }
    postToParent("neotalk:presentation-frame", { playlistId: presentation.id, status: detail.status, frame: detail.frame, frameCount: detail.frameCount, fps: detail.fps });
    return;
  }
  if (context.preview) {
    if (detail.status === "started" || detail.status === "progress" || detail.status === "finished") {
      sendUnity("PausePlayback");
      context.finished = true;
    }
    return;
  }
  if (detail.status === "finished") context.finished = true;
  postToParent("neotalk:playback-frame", {
    status: detail.status, loadId: context.loadId,
    correlationId: context.correlationId || context.loadId,
    frame: detail.frame, frameCount: detail.frameCount,
    revision: detail.revision, fps: detail.fps,
  });
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchSignPose(phrase, isCurrent = () => true, quiet = false) {
  let payload;
  for (let attempt = 0; ; attempt += 1) {
    try {
      ({ payload } = await api("/api/v1/mvp/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase }),
      }));
      break;
    } catch (error) {
      const transient = [408, 429, 500, 502, 503, 504].includes(error.status);
      if (!transient || attempt >= 2 || !isCurrent()) throw error;
      if (!quiet) emitStatus("processing", { phrase, recovering: true });
      await wait(350 * (attempt + 1));
    }
  }

  let transientFailures = 0;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    const delayMs = pollDelayForAttempt(attempt);
    if (delayMs > 0) await wait(delayMs);
    if (!isCurrent()) return null;
    try {
      const result = await api(`/api/v1/mvp/tasks/${encodeURIComponent(payload.task_id)}`);
      if (result.response.status === 202) {
        if (!quiet) emitStatus("processing", { phrase, taskId: payload.task_id });
        continue;
      }
      const words = Array.isArray(result.payload.palavras_encontradas)
        ? result.payload.palavras_encontradas.map((word) => String(word).replace(/\.pose$/i, ""))
        : [];
      if (!isCurrent()) return null;
      cachePose(phrase, result.payload.pose, words);
      return { phrase, pose: result.payload.pose, words, taskId: payload.task_id, traceId: result.response.headers.get("X-NeoTalk-Trace-ID") };
    } catch (error) {
      if (error.status === 502 && transientFailures < 5) {
        transientFailures += 1;
        continue;
      }
      throw error;
    }
  }
  throw new Error("A tradução demorou mais que o esperado.");
}

// Fetch the actual immutable content during the preceding clip. API task
// readiness alone does not eliminate the download at the playback handoff.
// Blob URLs are instance-local; the original URL remains the pose identity.
async function prefetchPoseFile(pose) {
  const url = resolvePoseUrl(pose.content_url);
  if (state.poseFiles.has(url)) return;
  if (state.poseFileTasks.has(url)) return state.poseFileTasks.get(url);
  if (state.poseFileTasks.size >= 2) return;
  const task = (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Pose download ${response.status}`);
    const blob = await response.blob();
    if (!blob.size || blob.size > 16 * 1024 * 1024) return;
    while (state.poseFiles.size >= 4 || state.poseFileBytes + blob.size > 32 * 1024 * 1024) {
      const key = [...state.poseFiles.keys()].find(key => key !== state.pendingPoseLoad?.url);
      if (!key) return;
      const previous = state.poseFiles.get(key);
      URL.revokeObjectURL(previous.url);
      state.poseFileBytes -= previous.bytes;
      state.poseFiles.delete(key);
    }
    state.poseFiles.set(url, { url: URL.createObjectURL(blob), bytes: blob.size });
    state.poseFileBytes += blob.size;
  })();
  state.poseFileTasks.set(url, task);
  try { await task; } finally { state.poseFileTasks.delete(url); }
}

async function prefetchSign(rawPhrase) {
  const phrase = String(rawPhrase || "").replace(/\s+/g, " ").trim();
  if (!phrase || phrase.length > 500) return;
  const key = phraseKey(phrase);
  if (state.prefetchedPoses.has(key) || state.prefetchTasks.has(key)) return;
  const generation = state.prefetchGeneration;
  const task = fetchSignPose(phrase, () => true, true);
  state.prefetchTasks.set(key, task);
  try {
    const result = await task;
    if (!result || generation !== state.prefetchGeneration) return;
    // A failed warm download never prevents the normal URL load/retry path.
    try { await prefetchPoseFile(result.pose); } catch (_) { /* load on demand */ }
    if (generation !== state.prefetchGeneration) return;
    state.prefetchedPoses.set(key, result);
    while (state.prefetchedPoses.size > 2) state.prefetchedPoses.delete(state.prefetchedPoses.keys().next().value);
    postToParent("neotalk:prefetch-ready", { ...result, loadId: nextPoseLoadId() });
  } catch (error) {
    if (generation === state.prefetchGeneration) postToParent("neotalk:prefetch-error", { phrase, message: error.message || "Pré-carregamento indisponível." });
  } finally {
    if (state.prefetchTasks.get(key) === task) state.prefetchTasks.delete(key);
  }
}

async function requestSign(rawPhrase) {
  const phrase = String(rawPhrase || "").replace(/\s+/g, " ").trim();
  if (!phrase) throw new Error("A frase está vazia.");
  if (phrase.length > 500) throw new Error("A frase excede o limite de 500 caracteres.");
  const sequence = ++state.requestSequence;
  clearError();
  emitStatus("queued", { phrase });
  const key = phraseKey(phrase);
  let result = state.prefetchedPoses.get(key);
  if (!result && state.prefetchTasks.has(key)) {
    try { result = await state.prefetchTasks.get(key); } catch (_) { /* normal request below */ }
  }
  if (!result) result = await fetchSignPose(phrase, () => sequence === state.requestSequence);
  if (!result || sequence !== state.requestSequence) return;
  state.prefetchedPoses.delete(key);
  const loadId = nextPoseLoadId();
  postToParent("neotalk:pose-ready", { ...result, loadId });
  await loadPose(result.pose, { loadId, taskId: result.taskId, traceId: result.traceId });
  if (sequence !== state.requestSequence) return;
  emitStatus("playing", { phrase, words: result.words, taskId: result.taskId });
  postToParent("neotalk:playing", { phrase, words: result.words, taskId: result.taskId, loadId, traceId: result.traceId });
}

async function replayCachedPhrase(rawPhrase) {
  const phrase = String(rawPhrase || "").replace(/\s+/g, " ").trim();
  const cached = state.poseCache.get(phraseKey(phrase));
  if (!cached) {
    const error = new Error("A pose não está mais disponível no cache desta sessão.");
    error.code = "pose_cache_miss";
    throw error;
  }
  emitStatus("loading_pose", { phrase, cached: true });
  const loadId = nextPoseLoadId();
  postToParent("neotalk:pose-ready", { phrase, pose: cached.pose, words: cached.words, cached: true, loadId });
  await loadPose(cached.pose, { loadId });
  emitStatus("playing", { phrase, words: cached.words, cached: true });
  postToParent("neotalk:playing", { phrase, words: cached.words, cached: true, loadId });
}

async function playSharedPose(message) {
  const phrase = String(message.phrase || "").replace(/\s+/g, " ").trim();
  const pose = message.pose;
  if (!phrase || !pose || typeof pose.content_url !== "string") throw new Error("Pose compartilhada inválida.");
  // The widget accepts commands only from its authorized controller; the pose
  // URL is additionally restricted to this widget's origin by loadPose().
  const words = Array.isArray(message.words) ? message.words.map(String).slice(0, 100) : [];
  cachePose(phrase, pose, words);
  const context = await loadPose(pose, { correlationId: message.loadId || message.correlationId, traceId: message.traceId, taskId: message.taskId });
  emitStatus("playing", { phrase, words, shared: true });
  postToParent("neotalk:playing", { phrase, words, shared: true, loadId: context.loadId, correlationId: context.correlationId, traceId: context.traceId });
}

function concatenatePresentationPoses(contents) {
  let nextFrame = 0;
  const output = contents.map(content => {
    const ids = new Map();
    const result = content.replace(/^# Frame: (.*?) - (.+ Keypoints)\s*$/gm, (_line, source, section) => {
      if (!ids.has(source)) ids.set(source, nextFrame++);
      return `# Frame: frame_${String(ids.get(source)).padStart(12, "0")}_keypoints.json - ${section}`;
    });
    if (!ids.size || !/ - Body Keypoints/.test(result)) throw new Error("Pose de demonstração inválida.");
    if (nextFrame > 12000) throw new Error("A apresentação excede 12.000 frames. Reduza a lista de sequências.");
    return result.trim();
  });
  if (!nextFrame) throw new Error("A apresentação não contém frames.");
  return { content: output.join("\n\n") + "\n", frameCount: nextFrame };
}

function stopPresentation() {
  state.presentationGeneration++;
  state.presentation?.controller.abort();
  const previous = state.presentation;
  if (previous?.timeout) clearTimeout(previous.timeout);
  state.presentation = null;
  sendUnity("PausePlayback");
  state.loop = false; sendUnity("SetLoop", "false");
  if (previous?.url && state.poseFiles.has(previous.url) && state.pendingPoseLoad?.url !== previous.url) {
    const file = state.poseFiles.get(previous.url);
    URL.revokeObjectURL(file.url); state.poseFileBytes -= file.bytes; state.poseFiles.delete(previous.url);
  }
}

async function preparePresentation(message) {
  if (!state.nativePlayback) throw new Error("Atualize o WebGL para preparar apresentações.");
  if (!Array.isArray(message.poses) || message.poses.length < 2 || message.poses.length > 64) throw new Error("Escolha de 2 a 64 sequências para a apresentação.");
  const urls = message.poses.map(pose => resolvePoseUrl(pose.content_url));
  if (typeof message.playlistId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(message.playlistId)) throw new Error("Identificador de apresentação inválido.");
  stopPresentation();
  const generation = state.presentationGeneration;
  const controller = new AbortController();
  const presentation = { id: message.playlistId, controller, ready: false, sequences: urls.length, url: null, timeout: null };
  state.presentation = presentation;
  presentation.timeout = window.setTimeout(() => {
    if (state.presentation !== presentation || presentation.ready) return;
    stopPresentation();
    postToParent("neotalk:presentation-error", { playlistId: message.playlistId, message: "A preparação excedeu dez minutos. Desative e tente novamente com uma lista menor." });
  }, 600000);
  try {
    const contents = new Array(urls.length); let cursor = 0, bytes = 0;
    const worker = async () => {
      while (cursor < urls.length) {
        const index = cursor++;
        const cached = state.poseFiles.get(urls[index]);
        const response = await fetch(cached?.url || urls[index], { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        if (!response.ok) throw new Error(`Falha ao preparar apresentação (${response.status}).`);
        const text = await response.text();
        bytes += new Blob([text]).size;
        if (bytes > 64 * 1024 * 1024) throw new Error("A apresentação excede o limite de 64 MB.");
        contents[index] = text;
      }
    };
    await Promise.all([worker(), worker()]);
    if (generation !== state.presentationGeneration) return;
    const combined = concatenatePresentationPoses(contents);
    const blob = new Blob([combined.content], { type: "text/plain" });
    const url = new URL(`/presentation/${message.playlistId}.pose`, window.location.origin).href;
    presentation.url = url;
    state.poseFiles.set(url, { url: URL.createObjectURL(blob), bytes: blob.size }); state.poseFileBytes += blob.size;
    state.loop = true;
    await loadPose({ content_url: url, fps: 30, frame_count: combined.frameCount }, { presentationId: presentation.id });
    // Readiness is emitted only on the real first native frame, not this ACK.
  } catch (error) {
    if (generation !== state.presentationGeneration) return;
    stopPresentation();
    postToParent("neotalk:presentation-error", { playlistId: message.playlistId, message: error.message || "Falha ao preparar demonstração." });
  }
}

async function runCommand(message) {
  switch (message.type) {
    case "neotalk:prepare-presentation":
      await preparePresentation(message);
      break;
    case "neotalk:stop-presentation":
      stopPresentation();
      break;
    case "neotalk:sign":
      await requestSign(message.phrase);
      break;
    case "neotalk:prefetch":
      await prefetchSign(message.phrase);
      break;
    case "neotalk:prefetch-pose":
      try { await prefetchPoseFile(message.pose); } catch (_) { /* optional warmup */ }
      break;
    case "neotalk:replay":
      await replayCachedPhrase(message.phrase);
      break;
    case "neotalk:load-pose":
      await playSharedPose(message);
      break;
    case "neotalk:set-avatar":
      await initializeAvatar(String(message.avatar || "").toLowerCase());
      break;
    case "neotalk:set-zoom":
      if (!setZoom(message.zoom)) throw new Error("Zoom inválido.");
      break;
    case "neotalk:set-loop":
      state.loop = Boolean(message.loop);
      sendUnity("SetLoop", state.loop ? "true" : "false");
      break;
    case "neotalk:set-background":
      if (!applyBackground(message.background)) throw new Error("Cor de fundo inválida. Use #RRGGBB.");
      break;
    case "neotalk:play": sendUnity("ResumePlayback"); break;
    case "neotalk:pause": sendUnity("PausePlayback"); break;
    case "neotalk:restart": sendUnity("PlayFromStart"); break;
    default: throw new Error("Comando de widget desconhecido.");
  }
}

function controllerSourceAllowed(source) {
  if (source === window.parent || source === initialControllerWindow) return true;
  try {
    return Boolean(window.parent.opener) && source === window.parent.opener;
  } catch (_) {
    return false;
  }
}

window.addEventListener("message", (event) => {
  if (!controllerSourceAllowed(event.source) || !originAllowed(event.origin)) return;
  const message = event.data;
  if (!message || typeof message !== "object" || !String(message.type || "").startsWith("neotalk:")) return;
  state.trustedParentOrigin = event.origin;
  runCommand(message).catch((error) => {
    if (error.name === "AbortError") return;
    if (["pose_ack_timeout", "pose_load_failed", "pose_cache_miss"].includes(error.code)) {
      clearError();
      postToParent("neotalk:error", { code: error.code, message: error.message, loadId: error.loadId, correlationId: error.correlationId, traceId: error.traceId });
      return;
    }
    if ([408, 429, 500, 502, 503, 504].includes(error.status)) {
      clearError();
      emitStatus("recovering", { stage: error.stage || "unknown" });
      postToParent("neotalk:error", { code: "transient_api_error", message: `Falha HTTP ${error.status}`, stage: error.stage || "unknown", traceId: error.traceId || null });
      return;
    }
    showError(error.message, error.code || "command_failed");
  });
});

elements.zoomOut.addEventListener("click", () => setZoom(state.zoom - 0.12));
elements.zoomIn.addEventListener("click", () => setZoom(state.zoom + 0.12));
elements.zoomReset.addEventListener("click", () => setZoom(defaults[state.avatar]));

async function bootstrap() {
  try {
    const configResponse = await fetch("/api/v1/widget/config", { cache: "no-store" });
    if (!configResponse.ok) throw new Error("Configuração do widget indisponível.");
    const config = await configResponse.json();
    state.allowedOrigins = Array.isArray(config.allowed_origins) ? config.allowed_origins : [];
    const referrerOrigin = normalizeOrigin(document.referrer);
    if (originAllowed(referrerOrigin)) state.trustedParentOrigin = referrerOrigin;

    await initializeAvatar(state.avatar, null);
    const initialPhrase = params.get("phrase");
    if (initialPhrase) await requestSign(initialPhrase);
  } catch (error) {
    if (error.name === "AbortError") return;
    showError(error.message || "Não foi possível iniciar o widget.", "startup_failed");
  }
}

bootstrap();
