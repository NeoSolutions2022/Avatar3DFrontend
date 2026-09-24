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
  pendingPoseLoad: null,
  poseCache: new Map(),
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
  url.searchParams.set("build", manifest.builtAtUtc || "20260918-elia13");
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
  if (previous?.Quit) {
    try { await previous.Quit(); } catch (_) { /* runtime already closed */ }
  }
  if (state.loaderScript) {
    state.loaderScript.remove();
    state.loaderScript = null;
  }
}

async function initializeAvatar(avatarId, resumePose = state.activePose) {
  if (!supportedAvatars.has(avatarId)) throw new Error("Avatar inválido.");
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
      productVersion: "2026.09.18-elia.13",
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
  elements.loader.classList.add("hidden");
  emitStatus("ready");
  postToParent("neotalk:ready", {
    version: "2026.09.18-elia.13",
    avatars: [...supportedAvatars],
    capabilities: ["sign", "replay", "shared-pose", "avatar", "zoom", "loop", "background", "playback"],
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
  };
  clearError();
  emitStatus("loading_pose", { loadId: context.loadId });
  reportPoseStage("pose_available", context);
  sendUnity("SetFps", pose.fps || 30);
  sendUnity("SetLoop", state.loop ? "true" : "false");

  if (state.pendingPoseLoad) {
    clearTimeout(state.pendingPoseLoad.timeout);
    const cancellation = new Error("Carregamento substituído por uma nova pose.");
    cancellation.name = "AbortError";
    state.pendingPoseLoad.reject(cancellation);
    state.pendingPoseLoad = null;
  }

  for (let attempt = 1; attempt <= maxPoseLoadAttempts; attempt += 1) {
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
        }, poseAckTimeoutMs);
        state.pendingPoseLoad = { resolve, reject, timeout, loadId: context.loadId, attempt };
        sendUnity("LoadPoseUrl", url);
      });
      reportPoseStage("unity_ack", context, { attempt, elapsedMs: Date.now() - startedAtWall, networkMs: poseNetworkTiming(url, startedAt), acknowledgedPoseId: false });
      state.activePose = pose;
      sendUnity("SetLoop", state.loop ? "true" : "false");
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
      if (attempt === maxPoseLoadAttempts) {
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

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestSign(rawPhrase) {
  const phrase = String(rawPhrase || "").replace(/\s+/g, " ").trim();
  if (!phrase) throw new Error("A frase está vazia.");
  if (phrase.length > 500) throw new Error("A frase excede o limite de 500 caracteres.");
  const sequence = ++state.requestSequence;
  clearError();
  emitStatus("queued", { phrase });

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
      if (!transient || attempt >= 2 || sequence !== state.requestSequence) throw error;
      emitStatus("processing", { phrase, recovering: true });
      await wait(350 * (attempt + 1));
    }
  }

  let transientFailures = 0;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    const delayMs = pollDelayForAttempt(attempt);
    if (delayMs > 0) await wait(delayMs);
    if (sequence !== state.requestSequence) return;
    try {
      const result = await api(`/api/v1/mvp/tasks/${encodeURIComponent(payload.task_id)}`);
      if (result.response.status === 202) {
        emitStatus("processing", { phrase, taskId: payload.task_id });
        continue;
      }
      const words = Array.isArray(result.payload.palavras_encontradas)
        ? result.payload.palavras_encontradas.map((word) => String(word).replace(/\.pose$/i, ""))
        : [];
      if (sequence !== state.requestSequence) return;
      cachePose(phrase, result.payload.pose, words);
      const loadId = nextPoseLoadId();
      const traceId = result.response.headers.get("X-NeoTalk-Trace-ID");
      postToParent("neotalk:pose-ready", { phrase, pose: result.payload.pose, words, taskId: payload.task_id, loadId, traceId });
      await loadPose(result.payload.pose, { loadId, taskId: payload.task_id, traceId });
      if (sequence !== state.requestSequence) return;
      emitStatus("playing", { phrase, words, taskId: payload.task_id });
      postToParent("neotalk:playing", { phrase, words, taskId: payload.task_id, loadId, traceId });
      return;
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

async function runCommand(message) {
  switch (message.type) {
    case "neotalk:sign":
      await requestSign(message.phrase);
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
