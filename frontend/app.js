const runtimeObject = "Pose skeleton Preview";
let unityInstance = null;
let activePoseId = null;
let toastTimer = null;

const elements = {
  canvas: document.querySelector("#unity-canvas"),
  loader: document.querySelector("#unity-loader"),
  loaderTitle: document.querySelector("#loader-title"),
  loaderMessage: document.querySelector("#loader-message"),
  progress: document.querySelector("#unity-progress"),
  connection: document.querySelector("#connection-status"),
  uploadForm: document.querySelector("#upload-form"),
  uploadButton: document.querySelector("#upload-button"),
  fileInput: document.querySelector("#pose-file"),
  fileLabel: document.querySelector("#file-label"),
  fps: document.querySelector("#fps"),
  apiKey: document.querySelector("#api-key"),
  dropzone: document.querySelector("#dropzone"),
  poseList: document.querySelector("#pose-list"),
  activePose: document.querySelector("#active-pose"),
  toast: document.querySelector("#toast"),
};

function apiHeaders() {
  const value = elements.apiKey.value.trim();
  return value ? { "X-API-Key": value } : {};
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show${error ? " error" : ""}`;
  toastTimer = setTimeout(() => { elements.toast.className = "toast"; }, 4200);
}

function setConnection(label, mode = "") {
  elements.connection.className = `connection ${mode}`.trim();
  elements.connection.innerHTML = `<span></span>${label}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = `Falha HTTP ${response.status}`;
    try {
      const payload = await response.json();
      detail = payload.detail || detail;
    } catch (_) { /* response was not JSON */ }
    throw new Error(detail);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function initializeUnity() {
  try {
    const manifestResponse = await fetch("/webgl/manifest.json", { cache: "no-store" });
    if (!manifestResponse.ok) {
      throw new Error("Build WebGL ainda não foi gerado. Execute o script de build do Unity.");
    }
    const manifest = await manifestResponse.json();
    const loaderUrl = `/webgl/${manifest.loaderUrl}`;
    const script = document.createElement("script");
    script.src = loaderUrl;
    script.async = true;
    document.body.appendChild(script);
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error("Não foi possível carregar o Unity WebGL."));
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
        productVersion: "1.0.0",
      },
      (value) => { elements.progress.style.width = `${Math.round(value * 100)}%`; },
    );
    elements.loader.classList.add("hidden");
    setConnection("Renderizador pronto", "ready");

    const poseId = new URLSearchParams(window.location.search).get("poseId");
    if (poseId) await loadPose(poseId);
  } catch (error) {
    elements.loaderTitle.textContent = "Renderizador indisponível";
    elements.loaderMessage.textContent = error.message;
    setConnection("WebGL indisponível", "error");
    showToast(error.message, true);
  }
}

function send(method, value) {
  if (!unityInstance) {
    showToast("O renderizador ainda está inicializando.", true);
    return false;
  }
  if (value === undefined) unityInstance.SendMessage(runtimeObject, method);
  else unityInstance.SendMessage(runtimeObject, method, String(value));
  return true;
}

function resolvePoseContentUrl(value) {
  const parsed = new URL(value, window.location.origin);
  return new URL(`${parsed.pathname}${parsed.search}`, window.location.origin).href;
}

async function loadPose(poseId) {
  if (!unityInstance) throw new Error("O renderizador ainda não está pronto.");
  const pose = await api(`/api/v1/poses/${encodeURIComponent(poseId)}`);
  send("SetFps", pose.fps);
  send("LoadPoseUrl", resolvePoseContentUrl(pose.content_url));
  activePoseId = pose.id;
  elements.activePose.textContent = `${pose.name} · ${pose.frame_count} frames · ${pose.fps} FPS`;
  document.querySelectorAll(".pose-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.id === pose.id);
  });
  const url = new URL(window.location.href);
  url.searchParams.set("poseId", pose.id);
  history.replaceState(null, "", url);
  showToast(`${pose.name} enviada para a Asuna.`);
  return pose;
}

async function refreshPoses() {
  try {
    const payload = await api("/api/v1/poses?limit=100");
    if (!payload.items.length) {
      elements.poseList.innerHTML = '<p class="empty">Nenhuma pose enviada ainda.</p>';
      return;
    }
    elements.poseList.innerHTML = payload.items.map((pose, index) => `
      <button class="pose-item${pose.id === activePoseId ? " active" : ""}" data-id="${pose.id}" type="button">
        <span class="pose-index">${String(index + 1).padStart(2, "0")}</span>
        <span class="pose-copy">
          <strong title="${escapeHtml(pose.name)}">${escapeHtml(pose.name)}</strong>
          <small>${pose.frame_count} frames · ${pose.source_dimensions}D original</small>
        </span>
        <span class="pose-action">›</span>
      </button>
    `).join("");
    elements.poseList.querySelectorAll(".pose-item").forEach((button) => {
      button.addEventListener("click", () => loadPose(button.dataset.id).catch(handleError));
    });
  } catch (error) { handleError(error); }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[character]));
}

function handleError(error) {
  console.error(error);
  showToast(error.message || "Ocorreu um erro inesperado.", true);
}

elements.fileInput.addEventListener("change", () => {
  const file = elements.fileInput.files[0];
  elements.fileLabel.textContent = file ? file.name : "Solte um arquivo .pose";
});

["dragenter", "dragover"].forEach((eventName) => elements.dropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  elements.dropzone.classList.add("drag");
}));
["dragleave", "drop"].forEach((eventName) => elements.dropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  elements.dropzone.classList.remove("drag");
}));
elements.dropzone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  elements.fileInput.files = transfer.files;
  elements.fileLabel.textContent = file.name;
});

elements.uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = elements.fileInput.files[0];
  if (!file) return showToast("Selecione um arquivo .pose.", true);
  elements.uploadButton.disabled = true;
  elements.uploadButton.firstChild.textContent = "Processando… ";
  try {
    const form = new FormData();
    form.append("file", file);
    form.append("fps", elements.fps.value || "30");
    const pose = await api("/api/v1/poses", {
      method: "POST",
      headers: apiHeaders(),
      body: form,
    });
    await refreshPoses();
    await loadPose(pose.id);
  } catch (error) { handleError(error); }
  finally {
    elements.uploadButton.disabled = false;
    elements.uploadButton.firstChild.textContent = "Validar e reproduzir ";
  }
});

document.querySelector("#restart-button").addEventListener("click", () => send("PlayFromStart"));
document.querySelector("#play-button").addEventListener("click", () => send("ResumePlayback"));
document.querySelector("#pause-button").addEventListener("click", () => send("PausePlayback"));
document.querySelector("#loop-toggle").addEventListener("change", (event) => send("SetLoop", event.target.checked));
document.querySelector("#refresh-button").addEventListener("click", refreshPoses);

window.Avatar3D = {
  loadPose,
  play: () => send("ResumePlayback"),
  pause: () => send("PausePlayback"),
  restart: () => send("PlayFromStart"),
  setLoop: (enabled) => send("SetLoop", Boolean(enabled)),
  async uploadPoseText(content, { name = "runtime.pose", fps = 30, apiKey = "" } = {}) {
    const pose = await api("/api/v1/poses/text", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-API-Key": apiKey } : {}),
      },
      body: JSON.stringify({ name, content, fps }),
    });
    await refreshPoses();
    await loadPose(pose.id);
    return pose;
  },
};

refreshPoses();
initializeUnity();
