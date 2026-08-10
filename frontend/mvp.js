const runtimeObject = "Pose skeleton Preview";
const pollIntervalMs = 2200;
const maxPollAttempts = 140;

let unityInstance = null;
let pendingPose = null;
let activePose = null;
let activePhrase = "";
let processing = false;
let toastTimer = null;

const elements = {
  avatarCaption: document.querySelector("#avatar-caption"),
  avatarLive: document.querySelector("#avatar-live"),
  avatarWords: document.querySelector("#avatar-words"),
  canvas: document.querySelector("#unity-canvas"),
  chatScroll: document.querySelector("#chat-scroll"),
  composer: document.querySelector("#composer"),
  headerStatus: document.querySelector("#header-status"),
  input: document.querySelector("#message-input"),
  loader: document.querySelector("#unity-loader"),
  loaderMessage: document.querySelector("#loader-message"),
  loaderTitle: document.querySelector("#loader-title"),
  messages: document.querySelector("#messages"),
  micButton: document.querySelector("#mic-button"),
  progress: document.querySelector("#unity-progress"),
  replayButton: document.querySelector("#replay-button"),
  sendButton: document.querySelector("#send-button"),
  toast: document.querySelector("#toast"),
  welcome: document.querySelector("#welcome"),
};

// Unity WebGL installs global keyboard listeners. Even with global capture
// disabled in the player, this barrier keeps keyboard and IME events inside
// the HTML input while it has focus.
for (const eventName of ["keydown", "keypress", "keyup"]) {
  elements.input.addEventListener(eventName, (event) => {
    event.stopPropagation();
  });
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

async function initializeAvatar() {
  try {
    const manifestResponse = await fetch("/webgl/manifest.json", { cache: "no-store" });
    if (!manifestResponse.ok) throw new Error("Build WebGL não encontrado.");
    const manifest = await manifestResponse.json();
    const script = document.createElement("script");
    script.src = `/webgl/${manifest.loaderUrl}`;
    script.async = true;
    document.body.appendChild(script);
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error("Falha ao carregar o motor 3D."));
    });

    unityInstance = await createUnityInstance(
      elements.canvas,
      {
        dataUrl: `/webgl/${manifest.dataUrl}`,
        frameworkUrl: `/webgl/${manifest.frameworkUrl}`,
        codeUrl: `/webgl/${manifest.codeUrl}`,
        streamingAssetsUrl: "/webgl/StreamingAssets",
        companyName: "NeoTalk",
        productName: "Avatar3D",
        productVersion: "1.1.0",
      },
      (value) => { elements.progress.style.width = `${Math.round(value * 100)}%`; },
    );

    sendUnity("SetBackgroundColor", "#ffffff");
    sendUnity("PausePlayback");
    elements.loader.classList.add("hidden");
    elements.avatarLive.textContent = "Online";
    elements.avatarLive.classList.add("ready");
    elements.headerStatus.className = "header-status ready";
    elements.headerStatus.innerHTML = "<i aria-hidden=\"true\"></i>Avatar conectado";

    if (pendingPose) {
      playPose(pendingPose.pose, pendingPose.words, pendingPose.phrase);
      pendingPose = null;
    }
  } catch (error) {
    const message = errorMessage(error, "Renderizador indisponível.");
    elements.loaderTitle.textContent = "Renderizador indisponível";
    elements.loaderMessage.textContent = message;
    elements.headerStatus.className = "header-status error";
    elements.headerStatus.innerHTML = "<i aria-hidden=\"true\"></i>Avatar indisponível";
    elements.avatarLive.textContent = "Offline";
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

function playPose(pose, words, phrase) {
  activePose = pose;
  activePhrase = phrase;
  const cleaned = cleanWords(words);
  sendUnity("SetBackgroundColor", "#ffffff");
  sendUnity("SetFps", pose.fps || 30);
  sendUnity("LoadPoseUrl", pose.content_url);
  elements.avatarCaption.textContent = phrase;
  elements.avatarWords.textContent = cleaned.length
    ? `Sinais encontrados: ${cleaned.join(", ")}`
    : "Pose pronta para reprodução.";
  elements.replayButton.disabled = false;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function pollTask(taskId, phrase, statusMessage) {
  let transientFailures = 0;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    await wait(pollIntervalMs);
    try {
      const { response, payload } = await api(`/api/v1/mvp/tasks/${encodeURIComponent(taskId)}`);
      if (response.status === 202) continue;
      const words = cleanWords(payload.palavras_encontradas);
      const wordsLabel = words.length ? words.join(", ") : "nenhum sinal identificado";
      updateProcessingMessage(statusMessage, {
        title: "Pose pronta!",
        text: `Frase enviada: ${phrase}\nPalavras encontradas: ${wordsLabel}`,
      });

      if (unityInstance) playPose(payload.pose, payload.palavras_encontradas, phrase);
      else pendingPose = { pose: payload.pose, words: payload.palavras_encontradas, phrase };
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

refreshComposer();
initializeAvatar();
