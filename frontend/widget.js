const params = new URLSearchParams(window.location.search);
const supportedAvatars = new Set(["asuna", "lia", "elia"]);
const defaults = { asuna: 1, lia: 1.28, elia: 1.28 };
const minZoom = 0.76;
const maxZoom = 1.48;
const pollIntervalMs = 2200;
const maxPollAttempts = 140;

const state = {
  allowedOrigins: [],
  trustedParentOrigin: null,
  avatar: supportedAvatars.has(params.get("avatar")) ? params.get("avatar") : "lia",
  background: validColor(params.get("background")) || "#ffffff",
  loop: params.get("loop") !== "0" && params.get("loop") !== "false",
  zoom: clampZoom(Number(params.get("zoom")) || 0),
  runtimeObject: "Pose skeleton Preview",
  unity: null,
  loaderScript: null,
  runtimeSequence: 0,
  requestSequence: 0,
  activePose: null,
  pendingPoseLoad: null,
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
    const error = new Error(payload.detail || `Falha HTTP ${response.status}`);
    error.status = response.status;
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
  url.searchParams.set("build", manifest.builtAtUtc || "20260831-elia3");
  return url.href;
}

function refreshZoomLabel() {
  elements.zoomReset.textContent = `${Math.round(state.zoom * 100)}%`;
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
      productVersion: "2026.08.31-elia.3",
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
  postToParent("neotalk:ready", { version: "2026.08.31-elia.3", capabilities: ["sign", "avatar", "zoom", "loop", "background", "playback"] });

  if (resumePose) await loadPose(resumePose);
}

async function loadPose(pose) {
  if (!state.unity) throw new Error("O avatar ainda não está pronto.");
  if (!pose || !pose.content_url) throw new Error("A resposta não contém uma pose válida.");
  clearError();
  state.activePose = pose;
  emitStatus("loading_pose");
  sendUnity("SetFps", pose.fps || 30);
  sendUnity("SetLoop", state.loop ? "true" : "false");

  if (state.pendingPoseLoad) {
    clearTimeout(state.pendingPoseLoad.timeout);
    const cancellation = new Error("Carregamento substituído por uma nova pose.");
    cancellation.name = "AbortError";
    state.pendingPoseLoad.reject(cancellation);
    state.pendingPoseLoad = null;
  }

  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      state.pendingPoseLoad = null;
      reject(new Error("O avatar não confirmou o carregamento da pose."));
    }, 45000);
    state.pendingPoseLoad = { resolve, reject, timeout };
    sendUnity("LoadPoseUrl", resolvePoseUrl(pose.content_url));
  });

  sendUnity("SetLoop", state.loop ? "true" : "false");
  sendUnity("PlayFromStart");
}

window.addEventListener("avatar3d-pose-load", (event) => {
  const pending = state.pendingPoseLoad;
  if (!pending) return;
  state.pendingPoseLoad = null;
  clearTimeout(pending.timeout);
  const detail = event.detail || {};
  if (detail.status === "success") pending.resolve();
  else pending.reject(new Error(detail.message || "Falha ao carregar a pose."));
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestSign(rawPhrase) {
  const phrase = String(rawPhrase || "").replace(/\s+/g, " ").trim();
  if (!phrase) throw new Error("A frase está vazia.");
  if (phrase.length > 500) throw new Error("A frase excede o limite de 500 caracteres.");
  const sequence = ++state.requestSequence;
  emitStatus("queued", { phrase });

  const { payload } = await api("/api/v1/mvp/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phrase }),
  });

  let transientFailures = 0;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    await wait(pollIntervalMs);
    if (sequence !== state.requestSequence) return;
    try {
      const result = await api(`/api/v1/mvp/tasks/${encodeURIComponent(payload.task_id)}`);
      if (result.response.status === 202) {
        emitStatus("processing", { phrase, taskId: payload.task_id });
        continue;
      }
      await loadPose(result.payload.pose);
      if (sequence !== state.requestSequence) return;
      const words = Array.isArray(result.payload.palavras_encontradas)
        ? result.payload.palavras_encontradas.map((word) => String(word).replace(/\.pose$/i, ""))
        : [];
      emitStatus("playing", { phrase, words, taskId: payload.task_id });
      postToParent("neotalk:playing", { phrase, words, taskId: payload.task_id });
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

async function runCommand(message) {
  switch (message.type) {
    case "neotalk:sign":
      await requestSign(message.phrase);
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

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || !originAllowed(event.origin)) return;
  const message = event.data;
  if (!message || typeof message !== "object" || !String(message.type || "").startsWith("neotalk:")) return;
  state.trustedParentOrigin = event.origin;
  runCommand(message).catch((error) => {
    if (error.name !== "AbortError") showError(error.message, "command_failed");
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
