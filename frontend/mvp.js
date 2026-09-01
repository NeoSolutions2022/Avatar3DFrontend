let runtimeObject = "Pose skeleton Preview";
const pollIntervalMs = 2200;
const maxPollAttempts = 140;

const fallbackCatalog = {
  defaultAvatar: "asuna",
  avatars: [
    { id: "asuna", name: "Asuna", manifestUrl: "asuna/manifest.json" },
    { id: "lia", name: "LIA", manifestUrl: "lia/manifest.json" },
    { id: "elia", name: "ELIA", manifestUrl: "elia/manifest.json" },
  ],
};
const avatarZoomLevels = { asuna: 1, lia: 1.28, elia: 1.28 };
const supportedAvatars = new Set(["asuna", "lia", "elia"]);

let unityInstance = null;
let pendingPose = null;
let activePose = null;
let activePhrase = "";
let processing = false;
let toastTimer = null;
let poseLoadContext = null;
let poseLoadTimer = null;
let avatarCatalog = null;
let selectedAvatar = supportedAvatars.has(localStorage.getItem("neotalk-avatar"))
  ? localStorage.getItem("neotalk-avatar")
  : "asuna";
let selectedAvatarName = selectedAvatar === "asuna" ? "Asuna" : selectedAvatar.toUpperCase();
let zoomLevel = avatarZoomLevels[selectedAvatar] || 1;
let avatarLoadSequence = 0;
let unityLoaderScript = null;
let activeWords = [];
let floatingAvatar = false;
let avatarDrag = null;

const minZoom = 0.76;
const maxZoom = 1.48;
const zoomStep = 0.12;

const elements = {
  avatarCaption: document.querySelector("#avatar-caption"),
  avatarFloatToggle: document.querySelector("#avatar-float-toggle"),
  avatarHeading: document.querySelector(".avatar-heading"),
  avatarOptions: [...document.querySelectorAll("[data-avatar]")],
  avatarPanel: document.querySelector(".avatar-panel"),
  avatarLive: document.querySelector("#avatar-live"),
  appVersion: document.querySelector("#app-version"),
  avatarWords: document.querySelector("#avatar-words"),
  canvas: document.querySelector("#unity-canvas"),
  chatScroll: document.querySelector("#chat-scroll"),
  composer: document.querySelector("#composer"),
  headerStatus: document.querySelector("#header-status"),
  input: document.querySelector("#message-input"),
  loader: document.querySelector("#unity-loader"),
  loaderMessage: document.querySelector("#loader-message"),
  loaderTitle: document.querySelector("#loader-title"),
  layout: document.querySelector(".mvp-layout"),
  messages: document.querySelector("#messages"),
  micButton: document.querySelector("#mic-button"),
  progress: document.querySelector("#unity-progress"),
  replayButton: document.querySelector("#replay-button"),
  sendButton: document.querySelector("#send-button"),
  toast: document.querySelector("#toast"),
  welcome: document.querySelector("#welcome"),
  zoomInButton: document.querySelector("#zoom-in-button"),
  zoomOutButton: document.querySelector("#zoom-out-button"),
  zoomResetButton: document.querySelector("#zoom-reset-button"),
};

// This capture-phase barrier is installed before the Unity loader. Unity 6
// otherwise receives keyboard events at window level before the HTML input.
for (const eventName of ["keydown", "keypress", "keyup"]) {
  window.addEventListener(eventName, (event) => {
    if (event.target === elements.input) event.stopImmediatePropagation();
  }, true);
}

elements.input.addEventListener("pointerdown", () => {
  elements.canvas.blur();
});

function errorMessage(error, fallback = "Não foi possível concluir a solicitação.") {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show${isError ? " error" : ""}`;
  toastTimer = setTimeout(() => { elements.toast.className = "toast"; }, 4300);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* empty response */ }
  if (!response.ok && response.status !== 202) {
    const error = new Error(payload?.detail || `Falha HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return { response, payload: payload || {} };
}

function sendUnity(method, value) {
  if (!unityInstance) return false;
  if (value === undefined) unityInstance.SendMessage(runtimeObject, method);
  else unityInstance.SendMessage(runtimeObject, method, String(value));
  return true;
}

function runtimeAssetUrl(value, runtimeBase, manifest) {
  const url = new URL(value, runtimeBase);
  url.searchParams.set("build", manifest.builtAtUtc || "20260901-elia6");
  return url.href;
}

function setAvatarOptionState(isLoading = false) {
  for (const option of elements.avatarOptions) {
    const isActive = option.dataset.avatar === selectedAvatar;
    option.classList.toggle("active", isActive);
    option.setAttribute("aria-pressed", String(isActive));
    option.disabled = isLoading;
  }
}

async function getAvatarCatalog() {
  if (avatarCatalog) return avatarCatalog;
  try {
    const response = await fetch("/webgl/catalog.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Catálogo indisponível");
    avatarCatalog = await response.json();
  } catch (_) {
    avatarCatalog = fallbackCatalog;
  }
  return avatarCatalog;
}

async function unloadAvatar() {
  const instance = unityInstance;
  unityInstance = null;
  if (instance?.Quit) {
    try { await instance.Quit(); } catch (_) { /* runtime already stopped */ }
  }
  if (unityLoaderScript) {
    unityLoaderScript.remove();
    unityLoaderScript = null;
  }
}

async function initializeAvatar(avatarId = selectedAvatar) {
  const loadSequence = ++avatarLoadSequence;
  const resumePose = poseLoadContext
    ? { ...poseLoadContext }
    : activePose
      ? { pose: activePose, words: activeWords, phrase: activePhrase, statusMessage: null }
      : pendingPose;

  clearTimeout(poseLoadTimer);
  poseLoadContext = null;
  pendingPose = null;
  selectedAvatar = avatarId;
  selectedAvatarName = avatarId === "asuna" ? "Asuna" : avatarId.toUpperCase();
  zoomLevel = avatarZoomLevels[avatarId] || 1;
  elements.zoomResetButton.textContent = `${Math.round(zoomLevel * 100)}%`;
  localStorage.setItem("neotalk-avatar", avatarId);
  setAvatarOptionState(true);
  elements.loader.classList.remove("hidden");
  elements.loaderTitle.textContent = `Preparando ${selectedAvatarName}`;
  elements.loaderMessage.textContent = "Carregando o avatar 3D...";
  elements.progress.style.width = "0%";
  elements.avatarLive.textContent = "Carregando";
  elements.avatarLive.classList.remove("ready");
  elements.headerStatus.className = "header-status";
  elements.headerStatus.innerHTML = "<i aria-hidden=\"true\"></i>Conectando ao avatar";
  elements.canvas.setAttribute("aria-label", `Avatar ${selectedAvatarName} 3D`);
  elements.zoomInButton.disabled = true;
  elements.zoomOutButton.disabled = true;
  elements.zoomResetButton.disabled = true;

  try {
    await unloadAvatar();
    if (loadSequence !== avatarLoadSequence) return;

    const catalog = await getAvatarCatalog();
    const avatar = catalog.avatars.find((item) => item.id === avatarId)
      || catalog.avatars.find((item) => item.id === catalog.defaultAvatar)
      || fallbackCatalog.avatars[0];
    selectedAvatarName = avatar.name;
    const manifestUrl = new URL(avatar.manifestUrl, `${window.location.origin}/webgl/`);
    const manifestResponse = await fetch(manifestUrl, { cache: "no-store" });
    if (!manifestResponse.ok) throw new Error("Build WebGL não encontrado.");
    const manifest = await manifestResponse.json();
    runtimeObject = manifest.runtimeObject || runtimeObject;
    const runtimeBase = new URL("./", manifestUrl);
    const script = document.createElement("script");
    script.src = runtimeAssetUrl(manifest.loaderUrl, runtimeBase, manifest);
    script.async = true;
    unityLoaderScript = script;
    document.body.appendChild(script);
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error("Falha ao carregar o motor 3D."));
    });

    const nextInstance = await createUnityInstance(
      elements.canvas,
      {
        dataUrl: runtimeAssetUrl(manifest.dataUrl, runtimeBase, manifest),
        frameworkUrl: runtimeAssetUrl(manifest.frameworkUrl, runtimeBase, manifest),
        codeUrl: runtimeAssetUrl(manifest.codeUrl, runtimeBase, manifest),
        streamingAssetsUrl: new URL("StreamingAssets", runtimeBase).href,
        companyName: "NeoTalk",
        productName: `NeoTalk ${selectedAvatarName}`,
        productVersion: "2026.09.01-elia.6",
        matchWebGLToCanvasSize: true,
        // LIA has finer facial and hand geometry. A slightly higher cap keeps
        // fingers and blend-shape contours crisp on high-density mobile screens
        // without paying the cost of an unrestricted 3x/4x WebGL framebuffer.
        devicePixelRatio: Math.min(
          window.devicePixelRatio || 1,
          selectedAvatar === "asuna" ? 2 : 2.25,
        ),
      },
      (value) => { elements.progress.style.width = `${Math.round(value * 100)}%`; },
    );

    if (loadSequence !== avatarLoadSequence) {
      if (nextInstance?.Quit) await nextInstance.Quit();
      return;
    }
    unityInstance = nextInstance;
    elements.appVersion.title = `${selectedAvatarName} WebGL ${manifest.builtAtUtc || "sem data"}`;
    sendUnity("SetBackgroundColor", "#ffffff");
    sendUnity("SetCameraZoom", zoomLevel.toFixed(2));
    sendUnity("PausePlayback");
    elements.loader.classList.add("hidden");
    elements.avatarLive.textContent = "Online";
    elements.avatarLive.classList.add("ready");
    elements.headerStatus.className = "header-status ready";
    elements.headerStatus.innerHTML = "<i aria-hidden=\"true\"></i>Avatar conectado";
    elements.zoomInButton.disabled = false;
    elements.zoomOutButton.disabled = false;
    elements.zoomResetButton.disabled = false;
    setAvatarOptionState(false);

    const poseToResume = pendingPose || resumePose;
    pendingPose = null;
    if (poseToResume) {
      playPose(
        poseToResume.pose,
        poseToResume.words,
        poseToResume.phrase,
        poseToResume.statusMessage,
      );
    }
  } catch (error) {
    if (loadSequence !== avatarLoadSequence) return;
    const message = errorMessage(error, "Renderizador indisponível.");
    elements.loaderTitle.textContent = "Renderizador indisponível";
    elements.loaderMessage.textContent = message;
    elements.headerStatus.className = "header-status error";
    elements.headerStatus.innerHTML = "<i aria-hidden=\"true\"></i>Avatar indisponível";
    elements.avatarLive.textContent = "Offline";
    setAvatarOptionState(false);
    showToast(message, true);
  }
}

function nowLabel() {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

function scrollToLatest() {
  requestAnimationFrame(() => {
    elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
  });
}

function addMessage({ role, text, title = "", processingMessage = false, replay = false }) {
  elements.welcome.classList.add("hidden");
  const row = document.createElement("div");
  row.className = `message-row ${role}`;

  if (role === "system") {
    const play = document.createElement("button");
    play.type = "button";
    play.className = "message-play";
    play.setAttribute("aria-label", replay ? "Repetir pose" : "Mensagem do sistema");
    play.textContent = replay ? "\u25b6" : "\u2022";
    play.disabled = !replay;
    if (replay) play.addEventListener("click", () => sendUnity("PlayFromStart"));
    row.appendChild(play);
  }

  const bubble = document.createElement("div");
  bubble.className = `message-bubble${processingMessage ? " processing" : ""}`;
  if (title) {
    const heading = document.createElement("strong");
    heading.textContent = title;
    bubble.appendChild(heading);
  }
  const copy = document.createElement("p");
  copy.textContent = text;
  bubble.appendChild(copy);

  if (processingMessage) {
    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.innerHTML = "<i></i><i></i><i></i>";
    copy.appendChild(dots);
  }

  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = nowLabel();
  bubble.appendChild(time);
  row.appendChild(bubble);
  elements.messages.appendChild(row);
  scrollToLatest();
  return { row, bubble, copy };
}

function updateProcessingMessage(message, { title = "", text, isError = false }) {
  if (!message) return;
  message.bubble.className = "message-bubble";
  message.bubble.replaceChildren();
  if (title) {
    const heading = document.createElement("strong");
    heading.textContent = title;
    message.bubble.appendChild(heading);
  }
  const copy = document.createElement("p");
  copy.textContent = text;
  if (isError) copy.style.color = "#b42318";
  message.bubble.appendChild(copy);
  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = nowLabel();
  message.bubble.appendChild(time);
  scrollToLatest();
}

function cleanWords(words) {
  return (Array.isArray(words) ? words : [])
    .map((word) => String(word).replace(/\.pose$/i, ""))
    .filter(Boolean);
}

function resolvePoseContentUrl(value) {
  const parsed = new URL(value, window.location.origin);
  return new URL(`${parsed.pathname}${parsed.search}`, window.location.origin).href;
}

function finishPoseLoad(success, message = "") {
  if (!poseLoadContext) return;
  clearTimeout(poseLoadTimer);
  const { pose, words, phrase, statusMessage } = poseLoadContext;
  poseLoadContext = null;

  if (!success) {
    const detail = message || `${selectedAvatarName} não conseguiu carregar os movimentos.`;
    updateProcessingMessage(statusMessage, {
      title: "Falha ao carregar a pose",
      text: detail,
      isError: true,
    });
    elements.avatarCaption.textContent = "Falha ao carregar movimentos";
    elements.avatarWords.textContent = detail;
    elements.replayButton.disabled = true;
    showToast(detail, true);
    return;
  }

  activePose = pose;
  activePhrase = phrase;
  activeWords = Array.isArray(words) ? [...words] : [];
  const cleaned = cleanWords(words);
  const wordsLabel = cleaned.length ? cleaned.join(", ") : "nenhum sinal identificado";
  updateProcessingMessage(statusMessage, {
    title: "Pose pronta!",
    text: `Frase enviada: ${phrase}\nPalavras encontradas: ${wordsLabel}`,
  });
  elements.avatarCaption.textContent = phrase;
  elements.avatarWords.textContent = cleaned.length
    ? `Sinais encontrados: ${wordsLabel}`
    : "Pose pronta para reprodução.";
  elements.replayButton.disabled = false;
}

function playPose(pose, words, phrase, statusMessage) {
  clearTimeout(poseLoadTimer);
  activePose = null;
  activePhrase = "";
  poseLoadContext = { pose, words, phrase, statusMessage };
  sendUnity("SetBackgroundColor", "#ffffff");
  sendUnity("SetFps", pose.fps || 30);
  sendUnity("LoadPoseUrl", resolvePoseContentUrl(pose.content_url));
  elements.avatarCaption.textContent = "Carregando movimentos";
  elements.avatarWords.textContent = phrase;
  elements.replayButton.disabled = true;
  poseLoadTimer = setTimeout(() => {
    finishPoseLoad(false, `${selectedAvatarName} não confirmou o carregamento da pose.`);
  }, 45000);
}

window.addEventListener("avatar3d-pose-load", (event) => {
  const detail = event.detail || {};
  finishPoseLoad(detail.status === "success", detail.message);
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function pollTask(taskId, phrase, statusMessage) {
  let transientFailures = 0;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    await wait(pollIntervalMs);
    try {
      const { response, payload } = await api(`/api/v1/mvp/tasks/${encodeURIComponent(taskId)}`);
      if (response.status === 202) continue;
      updateProcessingMessage(statusMessage, {
        title: "Pose recebida",
        text: `Carregando os movimentos em ${selectedAvatarName}...`,
      });

      if (unityInstance) {
        playPose(payload.pose, payload.palavras_encontradas, phrase, statusMessage);
      } else {
        pendingPose = {
          pose: payload.pose,
          words: payload.palavras_encontradas,
          phrase,
          statusMessage,
        };
      }
      return;
    } catch (error) {
      if (error.status === 502 && transientFailures < 5) {
        transientFailures += 1;
        continue;
      }
      throw error;
    }
  }
  throw new Error("A tradução demorou mais que o esperado. Tente novamente.");
}

async function submitPhrase(phrase) {
  processing = true;
  refreshComposer();
  addMessage({ role: "user", text: phrase });
  const statusMessage = addMessage({
    role: "system",
    text: "Traduzindo a frase para LIBRAS",
    processingMessage: true,
  });
  elements.avatarCaption.textContent = "Processando tradução";
  elements.avatarWords.textContent = phrase;

  try {
    const { payload } = await api("/api/v1/mvp/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase }),
    });
    await pollTask(payload.task_id, phrase, statusMessage);
  } catch (error) {
    const message = errorMessage(error);
    updateProcessingMessage(statusMessage, {
      title: "Não foi possível gerar a pose",
      text: message,
      isError: true,
    });
    elements.avatarCaption.textContent = "Falha na tradução";
    elements.avatarWords.textContent = "Tente novamente em alguns instantes.";
    showToast(message, true);
  } finally {
    processing = false;
    refreshComposer();
    elements.input.focus();
  }
}

function refreshComposer() {
  const hasText = elements.input.value.trim().length > 0;
  elements.sendButton.disabled = processing || !hasText;
  elements.input.setAttribute("aria-busy", String(processing));
  elements.micButton.disabled = processing;
}

elements.input.addEventListener("input", refreshComposer);
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const phrase = elements.input.value.trim();
  if (!phrase || processing) return;
  elements.input.value = "";
  refreshComposer();
  submitPhrase(phrase);
});

elements.replayButton.addEventListener("click", () => {
  if (activePose) {
    sendUnity("SetBackgroundColor", "#ffffff");
    sendUnity("PlayFromStart");
    elements.avatarCaption.textContent = activePhrase;
  }
});

function setZoom(nextZoom) {
  zoomLevel = Math.min(maxZoom, Math.max(minZoom, nextZoom));
  avatarZoomLevels[selectedAvatar] = zoomLevel;
  sendUnity("SetCameraZoom", zoomLevel.toFixed(2));
  elements.zoomResetButton.textContent = `${Math.round(zoomLevel * 100)}%`;
  elements.zoomOutButton.disabled = !unityInstance || zoomLevel <= minZoom;
  elements.zoomInButton.disabled = !unityInstance || zoomLevel >= maxZoom;
}

elements.zoomOutButton.addEventListener("click", () => setZoom(zoomLevel - zoomStep));
elements.zoomInButton.addEventListener("click", () => setZoom(zoomLevel + zoomStep));
elements.zoomResetButton.addEventListener("click", () => setZoom(1));

function clampFloatingAvatar() {
  if (!floatingAvatar || window.innerWidth > 560) return;
  const rect = elements.avatarPanel.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(
    Math.max(margin, rect.left),
    Math.max(margin, window.innerWidth - rect.width - margin),
  );
  const top = Math.min(
    Math.max(64 + margin, rect.top),
    Math.max(64 + margin, window.innerHeight - rect.height - margin),
  );
  elements.avatarPanel.style.setProperty("--float-x", `${left}px`);
  elements.avatarPanel.style.setProperty("--float-y", `${top}px`);
}

function setFloatingAvatar(enabled) {
  floatingAvatar = Boolean(enabled) && window.innerWidth <= 560;
  elements.avatarPanel.classList.toggle("floating", floatingAvatar);
  elements.layout.classList.toggle("avatar-floating", floatingAvatar);
  elements.avatarFloatToggle.classList.toggle("active", floatingAvatar);
  elements.avatarFloatToggle.setAttribute("aria-pressed", String(floatingAvatar));
  elements.avatarFloatToggle.textContent = floatingAvatar ? "Fixar" : "Flutuar";
  elements.avatarFloatToggle.title = floatingAvatar
    ? "Fixar avatar na página"
    : "Usar avatar flutuante";

  if (floatingAvatar) {
    const width = Math.min(window.innerWidth * 0.86, 340);
    elements.avatarPanel.style.setProperty("--float-x", `${window.innerWidth - width - 10}px`);
    elements.avatarPanel.style.setProperty("--float-y", "74px");
    requestAnimationFrame(clampFloatingAvatar);
  } else {
    elements.avatarPanel.style.removeProperty("--float-x");
    elements.avatarPanel.style.removeProperty("--float-y");
  }
  window.dispatchEvent(new Event("resize"));
}

elements.avatarFloatToggle.addEventListener("click", () => {
  setFloatingAvatar(!floatingAvatar);
});

elements.avatarHeading.addEventListener("pointerdown", (event) => {
  if (!floatingAvatar || event.button !== 0 || event.target.closest("button")) return;
  const rect = elements.avatarPanel.getBoundingClientRect();
  avatarDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  elements.avatarHeading.setPointerCapture(event.pointerId);
  elements.avatarPanel.classList.add("dragging");
  event.preventDefault();
});

elements.avatarHeading.addEventListener("pointermove", (event) => {
  if (!avatarDrag || avatarDrag.pointerId !== event.pointerId) return;
  elements.avatarPanel.style.setProperty(
    "--float-x", `${event.clientX - avatarDrag.offsetX}px`,
  );
  elements.avatarPanel.style.setProperty(
    "--float-y", `${event.clientY - avatarDrag.offsetY}px`,
  );
  clampFloatingAvatar();
});

function stopAvatarDrag(event) {
  if (!avatarDrag || avatarDrag.pointerId !== event.pointerId) return;
  avatarDrag = null;
  elements.avatarPanel.classList.remove("dragging");
}

elements.avatarHeading.addEventListener("pointerup", stopAvatarDrag);
elements.avatarHeading.addEventListener("pointercancel", stopAvatarDrag);
window.addEventListener("resize", () => {
  if (window.innerWidth > 560 && floatingAvatar) setFloatingAvatar(false);
  else requestAnimationFrame(clampFloatingAvatar);
});

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.lang = "pt-BR";
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.addEventListener("start", () => {
    elements.micButton.classList.add("listening");
    elements.micButton.setAttribute("aria-label", "Ouvindo; clique para parar");
    showToast("Ouvindo... fale sua mensagem.");
  });
  recognition.addEventListener("result", (event) => {
    let transcript = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      transcript += event.results[index][0].transcript;
    }
    elements.input.value = transcript.trim();
    refreshComposer();
  });
  recognition.addEventListener("end", () => {
    elements.micButton.classList.remove("listening");
    elements.micButton.setAttribute("aria-label", "Falar mensagem");
    elements.input.focus();
  });
  recognition.addEventListener("error", (event) => {
    const labels = {
      "not-allowed": "Permissão do microfone negada.",
      "no-speech": "Nenhuma fala foi identificada.",
      network: "O reconhecimento de voz está indisponível.",
    };
    showToast(labels[event.error] || "Não foi possível usar o microfone.", true);
  });
  elements.micButton.addEventListener("click", () => {
    if (elements.micButton.classList.contains("listening")) recognition.stop();
    else recognition.start();
  });
} else {
  elements.micButton.addEventListener("click", () => {
    showToast("Seu navegador não oferece reconhecimento de voz.", true);
  });
}

for (const option of elements.avatarOptions) {
  option.addEventListener("click", () => {
    const avatarId = option.dataset.avatar;
    if (!avatarId || avatarId === selectedAvatar) return;
    initializeAvatar(avatarId);
  });
}

setAvatarOptionState(false);
refreshComposer();
initializeAvatar(selectedAvatar);
