const { ipcRenderer, webUtils } = require("electron");
const fs = require("fs");
const path = require("path");

const SETTINGS_STORAGE_KEY = "text-recognition-studio-settings-v3";
const EMPTY_STATE_HTML = `
    <div class="empty-state">
        <div class="empty-icon">OCR</div>
        <p>Ready for a document</p>
    </div>
`;

const defaultScanOptions = {
  ocrMode: "best",
  outputStyle: "line_breaks",
  preserveLayout: true,
  detectCodes: true,
  mergeCodesIntoText: true,
  languageMode: "manual",
  languages: ["en"],
  useDocling: false,
  customWords: "",
  ignoredWords: "",
  preprocessing: {
    autoRotate: true,
    upscaleSmallText: true,
    deskew: true,
    cropBorders: true,
    denoise: true,
    contrast: true,
    sharpen: false,
    binarize: false,
    removeShadows: true,
    detectPageBoundaries: true,
  },
};

const imageExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".tif",
  ".tiff",
  ".webp",
  ".heic",
  ".heif",
]);
const acceptedExtensions = new Set(imageExtensions);

const elements = {
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  browseBtn: document.getElementById("browseBtn"),
  pasteBtn: document.getElementById("pasteBtn"),
  cameraBtn: document.getElementById("cameraBtn"),
  previewPanel: document.getElementById("previewPanel"),
  previewName: document.getElementById("previewName"),
  previewImg: document.getElementById("previewImg"),
  previewPlaceholder: document.getElementById("previewPlaceholder"),
  selectionOverlay: document.getElementById("selectionOverlay"),
  selectionBox: document.getElementById("selectionBox"),
  scanImageBtn: document.getElementById("scanImageBtn"),
  selectRegionBtn: document.getElementById("selectRegionBtn"),
  scanRegionBtn: document.getElementById("scanRegionBtn"),
  regionStatus: document.getElementById("regionStatus"),
  clearBtn: document.getElementById("clearBtn"),
  processingIndicator: document.getElementById("processingIndicator"),
  processingDetail: document.getElementById("processingDetail"),
  resultsContainer: document.getElementById("resultsContainer"),
  copyBtn: document.getElementById("copyBtn"),
  saveOutputBtn: document.getElementById("saveOutputBtn"),
  metadata: document.getElementById("metadata"),
  methodUsed: document.getElementById("methodUsed"),
  confidenceScore: document.getElementById("confidenceScore"),
  languageDetected: document.getElementById("languageDetected"),
  charCount: document.getElementById("charCount"),
  engineStatus: document.getElementById("engineStatus"),
  queueStatus: document.getElementById("queueStatus"),
  detectedCodes: document.getElementById("detectedCodes"),
  batchPanel: document.getElementById("batchPanel"),
  ocrMode: document.getElementById("ocrMode"),
  outputStyle: document.getElementById("outputStyle"),
  languageMode: document.getElementById("languageMode"),
  languageSelect: document.getElementById("languageSelect"),
  preserveLayout: document.getElementById("preserveLayout"),
  detectCodes: document.getElementById("detectCodes"),
  mergeCodesIntoText: document.getElementById("mergeCodesIntoText"),
  useDocling: document.getElementById("useDocling"),
  customWords: document.getElementById("customWords"),
  ignoredWords: document.getElementById("ignoredWords"),
  checkRuntimeBtn: document.getElementById("checkRuntimeBtn"),
  runtimeStatus: document.getElementById("runtimeStatus"),
  runtimePanel: document.getElementById("runtimePanel"),
  cameraModal: document.getElementById("cameraModal"),
  cameraVideo: document.getElementById("cameraVideo"),
  closeCameraBtn: document.getElementById("closeCameraBtn"),
  cancelCameraBtn: document.getElementById("cancelCameraBtn"),
  captureBtn: document.getElementById("captureBtn"),
};

const state = {
  currentPaths: [],
  currentResult: null,
  extractedText: "",
  markdownText: "",
  jsonText: "",
  tableText: "",
  displayText: "",
  region: null,
  regionMode: false,
  dragStart: null,
  selectionRenderFrame: null,
  lastCopyButton: null,
  cameraStream: null,
  environmentReport: null,
};

loadSavedSettings();
syncSettingsState();
resetPanels();
syncExportControls();

elements.browseBtn.addEventListener("click", () => elements.fileInput.click());
elements.pasteBtn.addEventListener("click", () =>
  ipcRenderer.send("paste-from-clipboard"),
);
elements.cameraBtn.addEventListener("click", openCamera);
elements.clearBtn.addEventListener("click", resetUI);
elements.scanImageBtn.addEventListener("click", scanCurrentImage);
elements.selectRegionBtn.addEventListener("click", toggleRegionMode);
elements.scanRegionBtn.addEventListener("click", scanSelectedRegion);
elements.copyBtn.addEventListener("click", () =>
  copyText(state.extractedText, elements.copyBtn),
);
elements.saveOutputBtn.addEventListener("click", saveOutputFile);
elements.checkRuntimeBtn.addEventListener("click", checkRuntimeEnvironment);
elements.closeCameraBtn.addEventListener("click", closeCamera);
elements.cancelCameraBtn.addEventListener("click", closeCamera);
elements.captureBtn.addEventListener("click", captureCameraFrame);

elements.fileInput.addEventListener("change", (event) =>
  handleFileList(event.target.files),
);

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.ocrMode.value = button.dataset.mode || defaultScanOptions.ocrMode;
    syncModeButtons();
    saveSettings();
  });
});

elements.dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.dropZone.classList.add("dragover");
});

elements.dropZone.addEventListener("dragleave", () => {
  elements.dropZone.classList.remove("dragover");
});

elements.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("dragover");
  handleDrop(event);
});

elements.previewImg.addEventListener("load", scheduleSelectionRender);
window.addEventListener("resize", scheduleSelectionRender);

if (window.ResizeObserver) {
  const selectionResizeObserver = new ResizeObserver(scheduleSelectionRender);
  selectionResizeObserver.observe(elements.previewPanel);
  selectionResizeObserver.observe(elements.selectionOverlay);
}

elements.selectionOverlay.addEventListener("pointerdown", startRegionSelection);
document.addEventListener("pointermove", updateRegionSelection);
document.addEventListener("pointerup", finishRegionSelection);

document
  .querySelectorAll(
    '.settings-panel select, .settings-panel input[type="checkbox"], .settings-panel textarea',
  )
  .forEach((input) => {
    input.addEventListener("change", () => {
      syncSettingsState();
      saveSettings();
    });
    input.addEventListener("input", () => {
      saveSettings();
    });
  });

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
    if (!isTextInput(document.activeElement)) {
      event.preventDefault();
      elements.pasteBtn.click();
    }
  }

  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "c" &&
    state.extractedText
  ) {
    if (!isTextInput(document.activeElement)) {
      elements.copyBtn.click();
    }
  }

  if (event.key === "Escape") {
    if (state.regionMode) {
      setRegionMode(false);
    } else if (state.currentPaths.length) {
      resetUI();
    }
  }
});

document.addEventListener("paste", (event) => {
  if (!isTextInput(document.activeElement)) {
    event.preventDefault();
    elements.pasteBtn.click();
  }
});

ipcRenderer.on("clipboard-image", (event, imagePath) => {
  if (!imagePath) {
    showNotification("No image found in clipboard", "error");
    return;
  }

  handlePaths([imagePath]);
});

ipcRenderer.on("camera-capture-saved", (event, imagePath) => {
  if (!imagePath) {
    showNotification("Camera capture failed", "error");
    return;
  }
  closeCamera();
  handlePaths([imagePath]);
});

ipcRenderer.on("copied-to-clipboard", (event, success) => {
  if (!success || !state.lastCopyButton) {
    return;
  }
  flashCopied(state.lastCopyButton);
  state.lastCopyButton = null;
});

ipcRenderer.on("save-output-result", (event, result) => {
  syncExportControls();

  if (result.canceled) {
    return;
  }

  if (!result.success) {
    showNotification(result.error || "Failed to save export", "error");
    return;
  }

  showNotification(`Saved ${path.basename(result.filePath)}`, "success");
});

ipcRenderer.on("ocr-result", (event, result) => {
  elements.processingIndicator.style.display = "none";
  elements.engineStatus.textContent = "Idle";

  if (result.success) {
    displayResults(result);
    return;
  }

  showError(result.error || "Failed to scan input");
});

ipcRenderer.on("environment-result", (event, result) => {
  elements.checkRuntimeBtn.disabled = false;

  if (result.success) {
    state.environmentReport = result;
    renderEnvironmentReport(result);
    return;
  }

  state.environmentReport = null;
  elements.runtimeStatus.textContent = "Check failed";
  elements.runtimeStatus.dataset.level = "low";
  elements.runtimePanel.innerHTML = `<div class="runtime-error">${escapeHtml(result.error || "Environment check failed")}</div>`;
});

function handleDrop(event) {
  const paths = [];
  for (const file of Array.from(event.dataTransfer.files || [])) {
    const filePath = getNativeFilePath(file);
    if (filePath) {
      paths.push(filePath);
    }
  }
  handlePaths(paths);
}

function handleFileList(fileList) {
  const paths = Array.from(fileList || [])
    .map((file) => getNativeFilePath(file))
    .filter(Boolean);
  handlePaths(paths);
}

function getNativeFilePath(file) {
  if (!file) {
    return "";
  }

  if (webUtils?.getPathForFile) {
    try {
      return webUtils.getPathForFile(file);
    } catch (error) {
      console.warn("Could not resolve native file path:", error);
    }
  }

  return file.path || "";
}

function handlePaths(paths) {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (!uniquePaths.length) {
    showNotification("No readable files found", "error");
    return;
  }

  const supportedPaths = uniquePaths.filter((filePath) => {
    return acceptedExtensions.has(path.extname(filePath).toLowerCase());
  });

  if (!supportedPaths.length) {
    showNotification("Use a PNG, JPG, TIFF, WEBP, or HEIC image", "error");
    return;
  }

  const selectedPath = supportedPaths[0];
  if (supportedPaths.length > 1) {
    showNotification("Using the first image only", "info");
  }

  state.currentPaths = [selectedPath];
  state.currentResult = null;
  state.extractedText = "";
  state.markdownText = "";
  state.jsonText = "";
  state.tableText = "";
  state.displayText = "";
  state.region = null;
  setRegionMode(false);
  resetPanels();
  setCopyButtons(false);
  syncExportControls();
  updateQueueStatus();
  displayPreview(selectedPath);
  elements.processingIndicator.style.display = "none";
  elements.engineStatus.textContent = "Ready";
  elements.resultsContainer.innerHTML = EMPTY_STATE_HTML;
}

function displayPreview(filePath) {
  elements.previewPanel.style.display = "flex";
  elements.dropZone.style.display = "none";
  elements.previewName.textContent = path.basename(filePath);
  elements.regionStatus.textContent = "";
  elements.selectionBox.style.display = "none";

  const extension = path.extname(filePath).toLowerCase();
  if (imageExtensions.has(extension)) {
    elements.previewPlaceholder.style.display = "none";
    elements.previewImg.style.display = "block";
    elements.previewImg.src = filePath;
    elements.selectRegionBtn.disabled = false;
  } else {
    elements.previewImg.removeAttribute("src");
    elements.previewImg.style.display = "none";
    elements.previewPlaceholder.style.display = "flex";
    elements.previewPlaceholder.textContent = "Image selected";
    elements.selectRegionBtn.disabled = true;
  }

  elements.scanImageBtn.disabled = false;
  elements.scanRegionBtn.disabled = true;
}

function checkRuntimeEnvironment() {
  elements.checkRuntimeBtn.disabled = true;
  elements.runtimeStatus.textContent = "Checking...";
  elements.runtimeStatus.dataset.level = "neutral";
  elements.runtimePanel.innerHTML =
    '<div class="runtime-loading"><div class="spinner small"></div><span>Probing Python, CUDA wheels, and OCR imports...</span></div>';
  ipcRenderer.send("check-environment");
}

function scanCurrentImage() {
  if (!state.currentPaths.length) {
    showNotification("Choose an image before scanning", "error");
    return;
  }
  processPaths([state.currentPaths[0]]);
}

function processPaths(paths, region = null) {
  const scanPaths = paths.slice(0, 1);
  if (!scanPaths.length) {
    return;
  }

  resetPanels();
  state.currentResult = null;
  state.extractedText = "";
  state.markdownText = "";
  state.jsonText = "";
  state.tableText = "";
  state.displayText = "";

  elements.processingIndicator.style.display = "flex";
  elements.processingDetail.textContent = path.basename(scanPaths[0]);
  elements.engineStatus.textContent = "Scanning";
  elements.resultsContainer.innerHTML =
    '<div class="empty-state"><div class="spinner small"></div><p>Processing...</p></div>';
  setCopyButtons(false);

  const options = getScanOptions();
  if (region) {
    options.region = region;
  }

  ipcRenderer.send("process-paths", {
    imagePath: scanPaths[0],
    paths: scanPaths,
    options,
  });
}

function scanSelectedRegion() {
  if (!state.currentPaths.length || !state.region) {
    return;
  }
  processPaths([state.currentPaths[0]], state.region);
}

function displayResults(rawResult, options = {}) {
  const result = {
    ...rawResult,
    inputPaths:
      Array.isArray(rawResult?.inputPaths) && rawResult.inputPaths.length
        ? rawResult.inputPaths
        : [...state.currentPaths],
  };

  state.currentResult = result;
  state.extractedText = result.text || result.ocrText || "";
  state.markdownText = result.markdown || state.extractedText;
  state.jsonText =
    result.jsonText || JSON.stringify(result.jsonData || result, null, 2);
  state.tableText =
    result.tableText ||
    (result.tables || [])
      .map((table) => table.markdown)
      .filter(Boolean)
      .join("\n\n");
  state.displayText =
    state.extractedText || state.markdownText || state.jsonText;

  elements.resultsContainer.innerHTML = `<pre class="result-text">${escapeHtml(state.displayText)}</pre>`;

  elements.methodUsed.textContent = result.method || "OCR";
  updateConfidenceDisplay(result.confidence, result.method);
  elements.languageDetected.textContent = formatLanguage(result.language);
  elements.charCount.textContent = `${Number(result.charCount || state.displayText.length || 0).toLocaleString()} chars`;
  elements.engineStatus.textContent = "Complete";

  setCopyButtons(true);
  syncExportControls();

  renderBatch(result.items || []);
  renderCodes(result.codes || []);
}

function renderBatch(items) {
  if (!items.length) {
    elements.batchPanel.style.display = "none";
    elements.batchPanel.innerHTML = "";
    return;
  }

  elements.batchPanel.style.display = "block";
  elements.batchPanel.innerHTML = `
        <div class="panel-title">
            <strong>Batch</strong>
            <span>${items.filter((item) => item.success).length}/${items.length} complete</span>
        </div>
        <div class="batch-list">
            ${items
              .map(
                (item) => `
                <div class="batch-item ${item.success ? "success" : "error"}">
                    <span>${escapeHtml(path.basename(item.sourcePath || "Input"))}</span>
                    <span>${item.success ? `${Number(item.confidence || 0).toFixed(1)}%` : escapeHtml(item.error || "Failed")}</span>
                </div>
            `,
              )
              .join("")}
        </div>
    `;
}

function renderCodes(codes) {
  if (!codes.length) {
    elements.detectedCodes.style.display = "none";
    elements.detectedCodes.innerHTML = "";
    return;
  }

  elements.detectedCodes.style.display = "block";
  elements.detectedCodes.innerHTML = `
        <div class="panel-title">
            <strong>QR & Barcodes</strong>
            <span>${codes.length} detected</span>
        </div>
        <div class="code-list">
            ${codes
              .map(
                (code) => `
                <article class="code-card">
                    <div class="code-card-header">
                        <span class="code-type">${escapeHtml(code.type || "CODE")}</span>
                        <span>${escapeHtml(code.source || "decoder")}${code.page ? ` - page ${code.page}` : ""}</span>
                    </div>
                    <div class="code-value">${escapeHtml(code.text || "")}</div>
                </article>
            `,
              )
              .join("")}
        </div>
    `;
}

function updateConfidenceDisplay(confidence, method) {
  if (!method || method === "Code Detection Only") {
    elements.confidenceScore.textContent = "Code only";
    elements.confidenceScore.dataset.level = "neutral";
    return;
  }

  const numericConfidence = Number(confidence || 0);
  elements.confidenceScore.textContent = `${numericConfidence.toFixed(1)}%`;
  if (numericConfidence >= 80) {
    elements.confidenceScore.dataset.level = "high";
  } else if (numericConfidence >= 60) {
    elements.confidenceScore.dataset.level = "medium";
  } else {
    elements.confidenceScore.dataset.level = "low";
  }
}

function showError(message) {
  resetPanels();
  state.displayText = "";
  elements.resultsContainer.innerHTML = `
        <div class="error-state">
            <strong>Scan failed</strong>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
  setCopyButtons(false);
  syncExportControls();
  elements.engineStatus.textContent = "Error";
}

function resetUI() {
  state.currentPaths = [];
  state.currentResult = null;
  state.extractedText = "";
  state.markdownText = "";
  state.jsonText = "";
  state.tableText = "";
  state.displayText = "";
  state.region = null;
  setRegionMode(false);

  elements.dropZone.style.display = "flex";
  elements.previewPanel.style.display = "none";
  elements.processingIndicator.style.display = "none";
  elements.resultsContainer.innerHTML = EMPTY_STATE_HTML;
  elements.previewImg.removeAttribute("src");
  elements.fileInput.value = "";
  elements.engineStatus.textContent = "Idle";
  elements.scanImageBtn.disabled = true;
  updateQueueStatus();
  setCopyButtons(false);
  syncExportControls();
  resetPanels();
}

function resetPanels() {
  elements.detectedCodes.style.display = "none";
  elements.batchPanel.style.display = "none";
  elements.detectedCodes.innerHTML = "";
  elements.batchPanel.innerHTML = "";
}

function setCopyButtons(enabled) {
  elements.copyBtn.disabled = !enabled;
  syncExportControls();
}

function saveOutputFile() {
  const payload = getExportPayload("text") || getExportPayload("current");
  if (!payload) {
    showNotification("No text is available to save yet", "error");
    syncExportControls();
    return;
  }

  elements.saveOutputBtn.disabled = true;
  ipcRenderer.send("save-output", payload);
}

function syncExportControls() {
  const hasText = Boolean(
    getExportPayload("text") || getExportPayload("current"),
  );
  elements.saveOutputBtn.disabled = !hasText;
}

function getExportPayload(format) {
  const baseName = getSuggestedExportBaseName();
  const descriptors = {
    current: {
      content: state.displayText,
      extension: getCurrentExportExtension(),
      label: "Current Output",
      suggestedName: `${baseName}-output`,
    },
    text: {
      content: state.currentResult?.ocrText || state.extractedText,
      extension: ".txt",
      label: "OCR Text",
      suggestedName: `${baseName}-ocr`,
    },
  };

  const descriptor = descriptors[format];
  if (!descriptor || !descriptor.content) {
    return null;
  }

  return descriptor;
}

function getCurrentExportExtension() {
  return ".txt";
}

function getSuggestedExportBaseName() {
  if (state.currentResult?.items?.length > 1 || state.currentPaths.length > 1) {
    return `text-recognition-batch-${state.currentPaths.length || state.currentResult?.items?.length || 1}`;
  }

  const sourcePath = state.currentResult?.sourcePath || state.currentPaths[0];
  if (!sourcePath) {
    return "text-recognition-output";
  }

  return sanitizeBaseName(path.basename(sourcePath, path.extname(sourcePath)));
}

function sanitizeBaseName(value) {
  return (
    String(value || "text-recognition-output")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "text-recognition-output"
  );
}

function getScanOptions() {
  return {
    ocrMode: elements.ocrMode.value,
    outputStyle: "line_breaks",
    preserveLayout: elements.preserveLayout.checked,
    detectCodes: elements.detectCodes.checked,
    mergeCodesIntoText: elements.mergeCodesIntoText.checked,
    languageMode: "manual",
    languages: ["en"],
    useDocling: elements.useDocling.checked,
    customWords: elements.customWords.value,
    ignoredWords: elements.ignoredWords.value,
    preprocessing: getCleanupOptions(),
  };
}

function getCleanupOptions() {
  const cleanup = {};
  document.querySelectorAll("[data-cleanup]").forEach((input) => {
    cleanup[input.dataset.cleanup] = input.checked;
  });
  return cleanup;
}

function syncSettingsState() {
  elements.mergeCodesIntoText.disabled = !elements.detectCodes.checked;
  if (!elements.detectCodes.checked) {
    elements.mergeCodesIntoText.checked = false;
  }
  elements.outputStyle.value = "line_breaks";
  elements.languageMode.value = "manual";
  Array.from(elements.languageSelect.options).forEach((option) => {
    option.selected = option.value === "en";
  });
  syncModeButtons();
}

function syncModeButtons() {
  const activeMode = elements.ocrMode.value || defaultScanOptions.ocrMode;
  document.querySelectorAll("[data-mode]").forEach((button) => {
    const isActive = button.dataset.mode === activeMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function loadSavedSettings() {
  try {
    const rawSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = rawSettings
      ? { ...defaultScanOptions, ...JSON.parse(rawSettings) }
      : defaultScanOptions;
    applySettings(settings);
  } catch (error) {
    applySettings(defaultScanOptions);
  }
}

function applySettings(settings) {
  elements.ocrMode.value = settings.ocrMode || defaultScanOptions.ocrMode;
  elements.outputStyle.value = "line_breaks";
  elements.preserveLayout.checked = Boolean(settings.preserveLayout);
  elements.detectCodes.checked = Boolean(settings.detectCodes);
  elements.mergeCodesIntoText.checked = Boolean(settings.mergeCodesIntoText);
  elements.languageMode.value = "manual";
  elements.useDocling.checked = Boolean(settings.useDocling);
  elements.customWords.value = settings.customWords || "";
  elements.ignoredWords.value = settings.ignoredWords || "";

  Array.from(elements.languageSelect.options).forEach((option) => {
    option.selected = option.value === "en";
  });

  const cleanup = {
    ...defaultScanOptions.preprocessing,
    ...(settings.preprocessing || {}),
  };
  document.querySelectorAll("[data-cleanup]").forEach((input) => {
    input.checked = Boolean(cleanup[input.dataset.cleanup]);
  });
}

function saveSettings() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(getScanOptions()));
}

function renderEnvironmentReport(report) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const hasCudaRuntime = checks.some((check) => check.cudaUsable);
  const hasCudaWheel = checks.some((check) => check.cudaWheel);
  elements.runtimeStatus.textContent = hasCudaRuntime
    ? "CUDA ready"
    : hasCudaWheel
      ? "Wheel only"
      : "CPU only";
  elements.runtimeStatus.dataset.level = hasCudaRuntime
    ? "high"
    : hasCudaWheel
      ? "medium"
      : "neutral";

  const python = report.python || {};
  const system = report.system || {};
  const nvidiaSmi = system.nvidiaSmi || {};
  const gpuLines =
    Array.isArray(nvidiaSmi.gpus) && nvidiaSmi.gpus.length
      ? nvidiaSmi.gpus
          .map((line) => `<span>${escapeHtml(line)}</span>`)
          .join("")
      : `<span>${escapeHtml(nvidiaSmi.error || "No NVIDIA GPU information reported")}</span>`;

  elements.runtimePanel.innerHTML = `
        <div class="runtime-summary">
            <strong>${escapeHtml(report.summary || "Environment check complete")}</strong>
            <div class="runtime-meta">
                <span>Python ${escapeHtml(python.version || "-")}</span>
                <span>${escapeHtml(python.platform || "-")}</span>
            </div>
            <div class="runtime-path">${escapeHtml(python.executable || "-")}</div>
            <div class="runtime-gpus">${gpuLines}</div>
        </div>
        <div class="runtime-checks">
            ${checks.map((check) => renderEnvironmentCheck(check)).join("")}
        </div>
    `;
}

function renderEnvironmentCheck(check) {
  const detailLines = [];
  if (check.cudaVersion) {
    detailLines.push(`CUDA build ${check.cudaVersion}`);
  }
  if (Array.isArray(check.devices)) {
    detailLines.push(...check.devices);
  }
  if (Array.isArray(check.details)) {
    detailLines.push(...check.details);
  }

  return `
        <article class="runtime-card ${escapeHtml(getEnvironmentLevel(check))}">
            <div class="runtime-card-head">
                <strong>${escapeHtml(check.label || check.id || "Check")}</strong>
                <span>${escapeHtml(getEnvironmentBadge(check))}</span>
            </div>
            <div class="runtime-card-meta">
                <span>${escapeHtml(check.version || "not installed")}</span>
                <span>${escapeHtml(check.probe || "probe")}</span>
            </div>
            <p>${escapeHtml(getEnvironmentSummary(check))}</p>
            ${detailLines.length ? `<div class="runtime-card-details">${detailLines.map((line) => `<span>${escapeHtml(line)}</span>`).join("")}</div>` : ""}
        </article>
    `;
}

function getEnvironmentLevel(check) {
  if (check.cudaUsable) {
    return "high";
  }
  if (check.cudaWheel || check.cpuUsable) {
    return "medium";
  }
  return "low";
}

function getEnvironmentBadge(check) {
  if (check.cudaUsable) {
    return "CUDA usable";
  }
  if (check.cudaWheel && !check.cudaAvailable) {
    return "CUDA wheel";
  }
  if (check.cpuUsable) {
    return "Import OK";
  }
  return "Unavailable";
}

function getEnvironmentSummary(check) {
  if (check.cudaUsable) {
    return "Import succeeded and a CUDA runtime test passed.";
  }
  if (check.cudaWheel && !check.cudaAvailable) {
    return "A CUDA-capable wheel is installed, but no GPU runtime was available.";
  }
  if (check.cudaWheel) {
    return "A CUDA-capable wheel is installed, but the runtime probe did not complete cleanly.";
  }
  if (check.cpuUsable) {
    return "Import succeeded in the current Python environment.";
  }
  return (
    check.error ||
    "The dependency is not importable in the current Python environment."
  );
}

function toggleRegionMode() {
  setRegionMode(!state.regionMode);
}

function setRegionMode(enabled) {
  state.regionMode = enabled;
  elements.selectionOverlay.classList.toggle("active", enabled);
  elements.selectRegionBtn.classList.toggle("active", enabled);
  elements.selectRegionBtn.textContent = enabled
    ? "Selecting..."
    : "Select Region";
}

function clearRegion() {
  state.region = null;
  if (state.selectionRenderFrame) {
    cancelAnimationFrame(state.selectionRenderFrame);
    state.selectionRenderFrame = null;
  }
  elements.selectionBox.style.display = "none";
  elements.regionStatus.textContent = "";
  elements.scanRegionBtn.disabled = true;
}

function startRegionSelection(event) {
  if (!state.regionMode || elements.previewImg.style.display === "none") {
    return;
  }
  const point = getClampedPoint(event);
  if (!point) {
    return;
  }
  event.preventDefault();
  state.dragStart = point;
  elements.selectionBox.style.display = "block";
  updateSelectionBox(point, point);
}

function updateRegionSelection(event) {
  if (!state.dragStart) {
    return;
  }
  const point = getClampedPoint(event);
  if (!point) {
    return;
  }
  updateSelectionBox(state.dragStart, point);
}

function finishRegionSelection(event) {
  if (!state.dragStart) {
    return;
  }
  const point = getClampedPoint(event);
  const start = state.dragStart;
  state.dragStart = null;
  if (!point) {
    return;
  }

  const imageRect = getImageRect();
  const left = Math.min(start.x, point.x);
  const top = Math.min(start.y, point.y);
  const width = Math.abs(point.x - start.x);
  const height = Math.abs(point.y - start.y);

  if (!imageRect || width < 8 || height < 8) {
    clearRegion();
    return;
  }

  const naturalWidth = elements.previewImg.naturalWidth || imageRect.width;
  const naturalHeight = elements.previewImg.naturalHeight || imageRect.height;
  state.region = {
    x: ((left - imageRect.left) / imageRect.width) * naturalWidth,
    y: ((top - imageRect.top) / imageRect.height) * naturalHeight,
    width: (width / imageRect.width) * naturalWidth,
    height: (height / imageRect.height) * naturalHeight,
    sourceWidth: naturalWidth,
    sourceHeight: naturalHeight,
  };

  elements.regionStatus.textContent = `${Math.round(state.region.width)} x ${Math.round(state.region.height)} px`;
  elements.scanRegionBtn.disabled = false;
  setRegionMode(false);
}

function updateSelectionBox(start, end) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  elements.selectionBox.style.left = `${left}px`;
  elements.selectionBox.style.top = `${top}px`;
  elements.selectionBox.style.width = `${width}px`;
  elements.selectionBox.style.height = `${height}px`;
}

function renderSelectionFromRegion() {
  if (!state.region) {
    return;
  }
  const imageRect = getImageRect();
  if (!imageRect) {
    return;
  }
  const naturalWidth =
    elements.previewImg.naturalWidth ||
    state.region.sourceWidth ||
    imageRect.width;
  const naturalHeight =
    elements.previewImg.naturalHeight ||
    state.region.sourceHeight ||
    imageRect.height;
  const left =
    imageRect.left + (state.region.x / naturalWidth) * imageRect.width;
  const top =
    imageRect.top + (state.region.y / naturalHeight) * imageRect.height;
  const right = left + (state.region.width / naturalWidth) * imageRect.width;
  const bottom = top + (state.region.height / naturalHeight) * imageRect.height;
  elements.selectionBox.style.display = "block";
  updateSelectionBox({ x: left, y: top }, { x: right, y: bottom });
}

function scheduleSelectionRender() {
  if (!state.region || state.selectionRenderFrame) {
    return;
  }

  state.selectionRenderFrame = requestAnimationFrame(() => {
    state.selectionRenderFrame = null;
    renderSelectionFromRegion();
  });
}

function getImageRect() {
  if (
    !elements.previewImg.src ||
    elements.previewImg.style.display === "none"
  ) {
    return null;
  }
  const overlayRect = elements.selectionOverlay.getBoundingClientRect();
  const imgRect = elements.previewImg.getBoundingClientRect();
  if (!imgRect.width || !imgRect.height) {
    return null;
  }
  return {
    left: imgRect.left - overlayRect.left,
    top: imgRect.top - overlayRect.top,
    width: imgRect.width,
    height: imgRect.height,
    right: imgRect.left - overlayRect.left + imgRect.width,
    bottom: imgRect.top - overlayRect.top + imgRect.height,
  };
}

function getClampedPoint(event) {
  const imageRect = getImageRect();
  if (!imageRect) {
    return null;
  }
  const overlayRect = elements.selectionOverlay.getBoundingClientRect();
  const rawX = event.clientX - overlayRect.left;
  const rawY = event.clientY - overlayRect.top;
  return {
    x: Math.max(imageRect.left, Math.min(rawX, imageRect.right)),
    y: Math.max(imageRect.top, Math.min(rawY, imageRect.bottom)),
  };
}

async function openCamera() {
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "environment" },
    });
    elements.cameraVideo.srcObject = state.cameraStream;
    elements.cameraModal.classList.add("open");
    elements.cameraModal.setAttribute("aria-hidden", "false");
  } catch (error) {
    showNotification("Camera permission was not granted", "error");
  }
}

function closeCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
  }
  elements.cameraVideo.srcObject = null;
  elements.cameraModal.classList.remove("open");
  elements.cameraModal.setAttribute("aria-hidden", "true");
}

function captureCameraFrame() {
  const video = elements.cameraVideo;
  if (!video.videoWidth || !video.videoHeight) {
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  ipcRenderer.send("save-camera-capture", canvas.toDataURL("image/png"));
}

function copyText(text, button) {
  if (!text) {
    return;
  }
  state.lastCopyButton = button;
  ipcRenderer.send("copy-to-clipboard", text);
}

function flashCopied(button) {
  const originalText = button.textContent;
  button.textContent = "Copied";
  button.classList.add("copied");
  setTimeout(() => {
    button.textContent = originalText;
    button.classList.remove("copied");
  }, 1400);
}

function updateQueueStatus() {
  const count = state.currentPaths.length;
  elements.queueStatus.textContent = `${count} ${count === 1 ? "image" : "images"}`;
}

function formatLanguage(language) {
  if (!language) {
    return "-";
  }
  if (typeof language === "string") {
    return language;
  }
  if (language.language) {
    const confidence = language.confidence
      ? ` ${Number(language.confidence).toFixed(0)}%`
      : "";
    return `${language.language}${confidence}`;
  }
  return "-";
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch (error) {
    return false;
  }
}

function isTextInput(element) {
  return element && ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

function showNotification(message, type = "info") {
  const notification = document.createElement("div");
  notification.className = `notification notification-${type}`;
  notification.textContent = message;

  document.body.appendChild(notification);
  setTimeout(() => notification.classList.add("show"), 10);
  setTimeout(() => {
    notification.classList.remove("show");
    setTimeout(() => notification.remove(), 250);
  }, 2800);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}
