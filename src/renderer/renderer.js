const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const SETTINGS_STORAGE_KEY = 'text-recognition-studio-settings-v2';
const EMPTY_STATE_HTML = `
    <div class="empty-state">
        <div class="empty-icon">OCR</div>
        <p>Ready for a document</p>
    </div>
`;

const defaultScanOptions = {
    ocrMode: 'best',
    outputStyle: 'paragraphs',
    preserveLayout: true,
    detectCodes: true,
    mergeCodesIntoText: true,
    languageMode: 'manual',
    languages: ['en'],
    useDocling: false,
    customWords: '',
    ignoredWords: '',
    preprocessing: {
        autoRotate: true,
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

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp']);
const acceptedExtensions = new Set([...imageExtensions, '.heic', '.heif', '.pdf']);

const elements = {
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('fileInput'),
    folderInput: document.getElementById('folderInput'),
    browseBtn: document.getElementById('browseBtn'),
    folderBtn: document.getElementById('folderBtn'),
    pasteBtn: document.getElementById('pasteBtn'),
    cameraBtn: document.getElementById('cameraBtn'),
    previewPanel: document.getElementById('previewPanel'),
    previewName: document.getElementById('previewName'),
    previewImg: document.getElementById('previewImg'),
    previewPlaceholder: document.getElementById('previewPlaceholder'),
    selectionOverlay: document.getElementById('selectionOverlay'),
    selectionBox: document.getElementById('selectionBox'),
    selectRegionBtn: document.getElementById('selectRegionBtn'),
    scanRegionBtn: document.getElementById('scanRegionBtn'),
    copyRegionBtn: document.getElementById('copyRegionBtn'),
    clearRegionBtn: document.getElementById('clearRegionBtn'),
    regionStatus: document.getElementById('regionStatus'),
    clearBtn: document.getElementById('clearBtn'),
    processingIndicator: document.getElementById('processingIndicator'),
    processingDetail: document.getElementById('processingDetail'),
    resultsContainer: document.getElementById('resultsContainer'),
    copyBtn: document.getElementById('copyBtn'),
    copyMarkdownBtn: document.getElementById('copyMarkdownBtn'),
    copyTableBtn: document.getElementById('copyTableBtn'),
    copyJsonBtn: document.getElementById('copyJsonBtn'),
    metadata: document.getElementById('metadata'),
    methodUsed: document.getElementById('methodUsed'),
    confidenceScore: document.getElementById('confidenceScore'),
    languageDetected: document.getElementById('languageDetected'),
    charCount: document.getElementById('charCount'),
    engineStatus: document.getElementById('engineStatus'),
    queueStatus: document.getElementById('queueStatus'),
    detectedCodes: document.getElementById('detectedCodes'),
    warningPanel: document.getElementById('warningPanel'),
    structurePanel: document.getElementById('structurePanel'),
    batchPanel: document.getElementById('batchPanel'),
    ocrMode: document.getElementById('ocrMode'),
    outputStyle: document.getElementById('outputStyle'),
    languageMode: document.getElementById('languageMode'),
    languageSelect: document.getElementById('languageSelect'),
    preserveLayout: document.getElementById('preserveLayout'),
    detectCodes: document.getElementById('detectCodes'),
    mergeCodesIntoText: document.getElementById('mergeCodesIntoText'),
    useDocling: document.getElementById('useDocling'),
    customWords: document.getElementById('customWords'),
    ignoredWords: document.getElementById('ignoredWords'),
    cameraModal: document.getElementById('cameraModal'),
    cameraVideo: document.getElementById('cameraVideo'),
    closeCameraBtn: document.getElementById('closeCameraBtn'),
    cancelCameraBtn: document.getElementById('cancelCameraBtn'),
    captureBtn: document.getElementById('captureBtn'),
};

const state = {
    currentPaths: [],
    currentResult: null,
    extractedText: '',
    markdownText: '',
    jsonText: '',
    tableText: '',
    region: null,
    regionMode: false,
    dragStart: null,
    lastCopyButton: null,
    cameraStream: null,
    copyRegionAfterScan: false,
};

loadSavedSettings();
syncSettingsState();
resetPanels();

elements.browseBtn.addEventListener('click', () => elements.fileInput.click());
elements.folderBtn.addEventListener('click', () => elements.folderInput.click());
elements.pasteBtn.addEventListener('click', () => ipcRenderer.send('paste-from-clipboard'));
elements.cameraBtn.addEventListener('click', openCamera);
elements.clearBtn.addEventListener('click', resetUI);
elements.selectRegionBtn.addEventListener('click', toggleRegionMode);
elements.scanRegionBtn.addEventListener('click', scanSelectedRegion);
elements.copyRegionBtn.addEventListener('click', copySelectedRegion);
elements.clearRegionBtn.addEventListener('click', clearRegion);
elements.copyBtn.addEventListener('click', () => copyText(state.extractedText, elements.copyBtn));
elements.copyMarkdownBtn.addEventListener('click', () => copyText(state.markdownText, elements.copyMarkdownBtn));
elements.copyTableBtn.addEventListener('click', () => copyText(state.tableText, elements.copyTableBtn));
elements.copyJsonBtn.addEventListener('click', () => copyText(state.jsonText, elements.copyJsonBtn));
elements.closeCameraBtn.addEventListener('click', closeCamera);
elements.cancelCameraBtn.addEventListener('click', closeCamera);
elements.captureBtn.addEventListener('click', captureCameraFrame);

elements.fileInput.addEventListener('change', (event) => handleFileList(event.target.files));
elements.folderInput.addEventListener('change', (event) => handleFileList(event.target.files));

elements.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('dragover');
});

elements.dropZone.addEventListener('dragleave', () => {
    elements.dropZone.classList.remove('dragover');
});

elements.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('dragover');
    handleDrop(event);
});

elements.previewImg.addEventListener('load', () => {
    renderSelectionFromRegion();
});

elements.selectionOverlay.addEventListener('pointerdown', startRegionSelection);
document.addEventListener('pointermove', updateRegionSelection);
document.addEventListener('pointerup', finishRegionSelection);

document.querySelectorAll('select, input[type="checkbox"], textarea').forEach((input) => {
    input.addEventListener('change', () => {
        syncSettingsState();
        saveSettings();
    });
    input.addEventListener('input', () => {
        saveSettings();
    });
});

document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        if (!isTextInput(document.activeElement)) {
            event.preventDefault();
            elements.pasteBtn.click();
        }
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && state.extractedText) {
        if (!isTextInput(document.activeElement)) {
            elements.copyBtn.click();
        }
    }

    if (event.key === 'Escape') {
        if (state.regionMode) {
            setRegionMode(false);
        } else if (state.currentPaths.length) {
            resetUI();
        }
    }
});

document.addEventListener('paste', (event) => {
    if (!isTextInput(document.activeElement)) {
        event.preventDefault();
        elements.pasteBtn.click();
    }
});

ipcRenderer.on('clipboard-image', (event, imagePath) => {
    if (!imagePath) {
        showNotification('No image found in clipboard', 'error');
        return;
    }

    handlePaths([imagePath]);
});

ipcRenderer.on('camera-capture-saved', (event, imagePath) => {
    if (!imagePath) {
        showNotification('Camera capture failed', 'error');
        return;
    }
    closeCamera();
    handlePaths([imagePath]);
});

ipcRenderer.on('copied-to-clipboard', (event, success) => {
    if (!success || !state.lastCopyButton) {
        return;
    }
    flashCopied(state.lastCopyButton);
    state.lastCopyButton = null;
});

ipcRenderer.on('ocr-result', (event, result) => {
    elements.processingIndicator.style.display = 'none';
    elements.engineStatus.textContent = 'Idle';

    if (result.success) {
        displayResults(result);
        return;
    }

    showError(result.error || 'Failed to scan input');
});

function handleDrop(event) {
    const paths = [];
    for (const file of Array.from(event.dataTransfer.files || [])) {
        if (file.path) {
            paths.push(file.path);
        }
    }
    handlePaths(paths);
}

function handleFileList(fileList) {
    const paths = Array.from(fileList || [])
        .map((file) => file.path)
        .filter(Boolean);
    handlePaths(paths);
}

function handlePaths(paths) {
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (!uniquePaths.length) {
        showNotification('No readable files found', 'error');
        return;
    }

    const supportedPaths = uniquePaths.filter((filePath) => {
        if (isDirectory(filePath)) {
            return true;
        }
        return acceptedExtensions.has(path.extname(filePath).toLowerCase());
    });

    if (!supportedPaths.length) {
        showNotification('Use PNG, JPG, TIFF, HEIC, PDF, or a folder', 'error');
        return;
    }

    state.currentPaths = supportedPaths;
    state.region = null;
    setRegionMode(false);
    updateQueueStatus();
    displayPreview(supportedPaths[0], supportedPaths.length);
    processPaths(supportedPaths);
}

function displayPreview(filePath, count = 1) {
    elements.previewPanel.style.display = 'flex';
    elements.dropZone.style.display = 'none';
    elements.previewName.textContent = count > 1 ? `${count} inputs selected` : path.basename(filePath);
    elements.regionStatus.textContent = 'Full page';
    elements.selectionBox.style.display = 'none';

    const extension = path.extname(filePath).toLowerCase();
    if (imageExtensions.has(extension)) {
        elements.previewPlaceholder.style.display = 'none';
        elements.previewImg.style.display = 'block';
        elements.previewImg.src = filePath;
        elements.selectRegionBtn.disabled = false;
    } else {
        elements.previewImg.removeAttribute('src');
        elements.previewImg.style.display = 'none';
        elements.previewPlaceholder.style.display = 'flex';
        elements.previewPlaceholder.textContent = extension === '.pdf'
            ? 'PDF selected'
            : acceptedExtensions.has(extension) ? 'Image selected' : 'Folder batch selected';
        elements.selectRegionBtn.disabled = true;
    }

    elements.scanRegionBtn.disabled = true;
    elements.copyRegionBtn.disabled = true;
    elements.clearRegionBtn.disabled = true;
}

function processPaths(paths, region = null) {
    resetPanels();
    state.currentResult = null;
    state.extractedText = '';
    state.markdownText = '';
    state.jsonText = '';
    state.tableText = '';

    elements.processingIndicator.style.display = 'flex';
    elements.processingDetail.textContent = paths.length > 1 ? `Processing ${paths.length} inputs` : path.basename(paths[0]);
    elements.engineStatus.textContent = 'Scanning';
    elements.resultsContainer.innerHTML = '<div class="empty-state"><div class="spinner small"></div><p>Processing...</p></div>';
    setCopyButtons(false);

    const options = getScanOptions();
    if (region) {
        options.region = region;
    }

    ipcRenderer.send('process-paths', {
        imagePath: paths[0],
        paths,
        options,
    });
}

function scanSelectedRegion() {
    if (!state.currentPaths.length || !state.region) {
        return;
    }
    processPaths([state.currentPaths[0]], state.region);
}

function copySelectedRegion() {
    if (!state.currentPaths.length || !state.region) {
        return;
    }
    state.copyRegionAfterScan = true;
    processPaths([state.currentPaths[0]], state.region);
}

function displayResults(result) {
    state.currentResult = result;
    state.extractedText = result.text || result.ocrText || '';
    state.markdownText = result.markdown || state.extractedText;
    state.jsonText = JSON.stringify(result.jsonData || result, null, 2);
    state.tableText = (result.tables || []).map((table) => table.markdown).filter(Boolean).join('\n\n');

    const displayText = state.extractedText || state.markdownText || state.jsonText;
    elements.resultsContainer.innerHTML = `<pre class="result-text">${escapeHtml(displayText)}</pre>`;

    elements.methodUsed.textContent = result.method || 'OCR';
    updateConfidenceDisplay(result.confidence, result.method);
    elements.languageDetected.textContent = formatLanguage(result.language);
    elements.charCount.textContent = `${Number(result.charCount || displayText.length || 0).toLocaleString()} chars`;
    elements.engineStatus.textContent = 'Complete';

    setCopyButtons(true);
    elements.copyMarkdownBtn.disabled = !state.markdownText;
    elements.copyJsonBtn.disabled = !state.jsonText;
    elements.copyTableBtn.disabled = !state.tableText;

    renderBatch(result.items || []);
    renderCodes(result.codes || []);
    renderWarnings(result.warnings || []);
    renderStructure(result);

    if (state.copyRegionAfterScan) {
        state.copyRegionAfterScan = false;
        copyText(state.extractedText, elements.copyRegionBtn);
    }
}

function renderBatch(items) {
    if (!items.length) {
        elements.batchPanel.style.display = 'none';
        elements.batchPanel.innerHTML = '';
        return;
    }

    elements.batchPanel.style.display = 'block';
    elements.batchPanel.innerHTML = `
        <div class="panel-title">
            <strong>Batch</strong>
            <span>${items.filter((item) => item.success).length}/${items.length} complete</span>
        </div>
        <div class="batch-list">
            ${items.map((item) => `
                <div class="batch-item ${item.success ? 'success' : 'error'}">
                    <span>${escapeHtml(path.basename(item.sourcePath || 'Input'))}</span>
                    <span>${item.success ? `${Number(item.confidence || 0).toFixed(1)}%` : escapeHtml(item.error || 'Failed')}</span>
                </div>
            `).join('')}
        </div>
    `;
}

function renderCodes(codes) {
    if (!codes.length) {
        elements.detectedCodes.style.display = 'none';
        elements.detectedCodes.innerHTML = '';
        return;
    }

    elements.detectedCodes.style.display = 'block';
    elements.detectedCodes.innerHTML = `
        <div class="panel-title">
            <strong>QR & Barcodes</strong>
            <span>${codes.length} detected</span>
        </div>
        <div class="code-list">
            ${codes.map((code) => `
                <article class="code-card">
                    <div class="code-card-header">
                        <span class="code-type">${escapeHtml(code.type || 'CODE')}</span>
                        <span>${escapeHtml(code.source || 'decoder')}${code.page ? ` - page ${code.page}` : ''}</span>
                    </div>
                    <div class="code-value">${escapeHtml(code.text || '')}</div>
                </article>
            `).join('')}
        </div>
    `;
}

function renderWarnings(warnings) {
    if (!warnings.length) {
        elements.warningPanel.style.display = 'none';
        elements.warningPanel.innerHTML = '';
        return;
    }

    const visible = warnings.slice(0, 8);
    elements.warningPanel.style.display = 'block';
    elements.warningPanel.innerHTML = `
        <div class="panel-title">
            <strong>Review Marks</strong>
            <span>${warnings.length} flagged</span>
        </div>
        <div class="warning-list">
            ${visible.map((warning) => `
                <div class="warning-item ${escapeHtml(warning.severity || 'medium')}">
                    <span>${escapeHtml(warning.type || 'warning').replace(/_/g, ' ')}</span>
                    <p>${escapeHtml(warning.sample || warning.message || '')}</p>
                </div>
            `).join('')}
        </div>
    `;
}

function renderStructure(result) {
    const tables = result.tables || [];
    const keyValues = result.keyValues || [];
    const formFields = result.formFields || [];
    const cleanup = result.cleanupActions || [];

    if (!tables.length && !keyValues.length && !formFields.length && !cleanup.length) {
        elements.structurePanel.style.display = 'none';
        elements.structurePanel.innerHTML = '';
        return;
    }

    elements.structurePanel.style.display = 'block';
    elements.structurePanel.innerHTML = `
        <div class="panel-title">
            <strong>Structure</strong>
            <span>${tables.length} tables - ${keyValues.length} pairs - ${formFields.length} fields</span>
        </div>
        ${keyValues.length ? `
            <div class="kv-list">
                ${keyValues.slice(0, 8).map((item) => `
                    <div><strong>${escapeHtml(item.key)}</strong><span>${escapeHtml(item.value)}</span></div>
                `).join('')}
            </div>
        ` : ''}
        ${tables.length ? `<pre class="mini-table">${escapeHtml(tables[0].markdown || '')}</pre>` : ''}
        ${cleanup.length ? `<div class="cleanup-list">${cleanup.slice(0, 8).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
    `;
}

function updateConfidenceDisplay(confidence, method) {
    if (!method || method === 'Code Detection Only') {
        elements.confidenceScore.textContent = 'Code only';
        elements.confidenceScore.dataset.level = 'neutral';
        return;
    }

    const numericConfidence = Number(confidence || 0);
    elements.confidenceScore.textContent = `${numericConfidence.toFixed(1)}%`;
    if (numericConfidence >= 80) {
        elements.confidenceScore.dataset.level = 'high';
    } else if (numericConfidence >= 60) {
        elements.confidenceScore.dataset.level = 'medium';
    } else {
        elements.confidenceScore.dataset.level = 'low';
    }
}

function showError(message) {
    state.copyRegionAfterScan = false;
    resetPanels();
    elements.resultsContainer.innerHTML = `
        <div class="error-state">
            <strong>Scan failed</strong>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
    setCopyButtons(false);
    elements.engineStatus.textContent = 'Error';
}

function resetUI() {
    state.currentPaths = [];
    state.currentResult = null;
    state.extractedText = '';
    state.markdownText = '';
    state.jsonText = '';
    state.tableText = '';
    state.region = null;
    setRegionMode(false);

    elements.dropZone.style.display = 'flex';
    elements.previewPanel.style.display = 'none';
    elements.processingIndicator.style.display = 'none';
    elements.resultsContainer.innerHTML = EMPTY_STATE_HTML;
    elements.previewImg.removeAttribute('src');
    elements.fileInput.value = '';
    elements.folderInput.value = '';
    elements.engineStatus.textContent = 'Idle';
    updateQueueStatus();
    setCopyButtons(false);
    resetPanels();
}

function resetPanels() {
    elements.detectedCodes.style.display = 'none';
    elements.warningPanel.style.display = 'none';
    elements.structurePanel.style.display = 'none';
    elements.batchPanel.style.display = 'none';
    elements.detectedCodes.innerHTML = '';
    elements.warningPanel.innerHTML = '';
    elements.structurePanel.innerHTML = '';
    elements.batchPanel.innerHTML = '';
}

function setCopyButtons(enabled) {
    elements.copyBtn.disabled = !enabled;
    elements.copyMarkdownBtn.disabled = !enabled;
    elements.copyTableBtn.disabled = !enabled;
    elements.copyJsonBtn.disabled = !enabled;
}

function getScanOptions() {
    return {
        ocrMode: elements.ocrMode.value,
        outputStyle: elements.outputStyle.value,
        preserveLayout: elements.preserveLayout.checked,
        detectCodes: elements.detectCodes.checked,
        mergeCodesIntoText: elements.mergeCodesIntoText.checked,
        languageMode: elements.languageMode.value,
        languages: Array.from(elements.languageSelect.selectedOptions).map((option) => option.value),
        useDocling: elements.useDocling.checked,
        customWords: elements.customWords.value,
        ignoredWords: elements.ignoredWords.value,
        preprocessing: getCleanupOptions(),
    };
}

function getCleanupOptions() {
    const cleanup = {};
    document.querySelectorAll('[data-cleanup]').forEach((input) => {
        cleanup[input.dataset.cleanup] = input.checked;
    });
    return cleanup;
}

function syncSettingsState() {
    elements.mergeCodesIntoText.disabled = !elements.detectCodes.checked;
    if (!elements.detectCodes.checked) {
        elements.mergeCodesIntoText.checked = false;
    }
    elements.languageSelect.disabled = elements.languageMode.value === 'auto';
}

function loadSavedSettings() {
    try {
        const rawSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
        const settings = rawSettings ? { ...defaultScanOptions, ...JSON.parse(rawSettings) } : defaultScanOptions;
        applySettings(settings);
    } catch (error) {
        applySettings(defaultScanOptions);
    }
}

function applySettings(settings) {
    elements.ocrMode.value = settings.ocrMode || defaultScanOptions.ocrMode;
    elements.outputStyle.value = settings.outputStyle || defaultScanOptions.outputStyle;
    elements.preserveLayout.checked = Boolean(settings.preserveLayout);
    elements.detectCodes.checked = Boolean(settings.detectCodes);
    elements.mergeCodesIntoText.checked = Boolean(settings.mergeCodesIntoText);
    elements.languageMode.value = settings.languageMode || defaultScanOptions.languageMode;
    elements.useDocling.checked = Boolean(settings.useDocling);
    elements.customWords.value = settings.customWords || '';
    elements.ignoredWords.value = settings.ignoredWords || '';

    const selectedLanguages = new Set(settings.languages || defaultScanOptions.languages);
    Array.from(elements.languageSelect.options).forEach((option) => {
        option.selected = selectedLanguages.has(option.value);
    });

    const cleanup = { ...defaultScanOptions.preprocessing, ...(settings.preprocessing || {}) };
    document.querySelectorAll('[data-cleanup]').forEach((input) => {
        input.checked = Boolean(cleanup[input.dataset.cleanup]);
    });
}

function saveSettings() {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(getScanOptions()));
}

function toggleRegionMode() {
    setRegionMode(!state.regionMode);
}

function setRegionMode(enabled) {
    state.regionMode = enabled;
    elements.selectionOverlay.classList.toggle('active', enabled);
    elements.selectRegionBtn.classList.toggle('active', enabled);
    elements.selectRegionBtn.textContent = enabled ? 'Selecting...' : 'Select Region';
}

function clearRegion() {
    state.region = null;
    elements.selectionBox.style.display = 'none';
    elements.regionStatus.textContent = 'Full page';
    elements.scanRegionBtn.disabled = true;
    elements.copyRegionBtn.disabled = true;
    elements.clearRegionBtn.disabled = true;
}

function startRegionSelection(event) {
    if (!state.regionMode || elements.previewImg.style.display === 'none') {
        return;
    }
    const point = getClampedPoint(event);
    if (!point) {
        return;
    }
    event.preventDefault();
    state.dragStart = point;
    elements.selectionBox.style.display = 'block';
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
    elements.copyRegionBtn.disabled = false;
    elements.clearRegionBtn.disabled = false;
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
    const naturalWidth = elements.previewImg.naturalWidth || state.region.sourceWidth || imageRect.width;
    const naturalHeight = elements.previewImg.naturalHeight || state.region.sourceHeight || imageRect.height;
    const left = imageRect.left + (state.region.x / naturalWidth) * imageRect.width;
    const top = imageRect.top + (state.region.y / naturalHeight) * imageRect.height;
    const right = left + (state.region.width / naturalWidth) * imageRect.width;
    const bottom = top + (state.region.height / naturalHeight) * imageRect.height;
    elements.selectionBox.style.display = 'block';
    updateSelectionBox({ x: left, y: top }, { x: right, y: bottom });
}

function getImageRect() {
    if (!elements.previewImg.src || elements.previewImg.style.display === 'none') {
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
            video: { facingMode: 'environment' },
        });
        elements.cameraVideo.srcObject = state.cameraStream;
        elements.cameraModal.classList.add('open');
        elements.cameraModal.setAttribute('aria-hidden', 'false');
    } catch (error) {
        showNotification('Camera permission was not granted', 'error');
    }
}

function closeCamera() {
    if (state.cameraStream) {
        state.cameraStream.getTracks().forEach((track) => track.stop());
        state.cameraStream = null;
    }
    elements.cameraVideo.srcObject = null;
    elements.cameraModal.classList.remove('open');
    elements.cameraModal.setAttribute('aria-hidden', 'true');
}

function captureCameraFrame() {
    const video = elements.cameraVideo;
    if (!video.videoWidth || !video.videoHeight) {
        return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    ipcRenderer.send('save-camera-capture', canvas.toDataURL('image/png'));
}

function copyText(text, button) {
    if (!text) {
        return;
    }
    state.lastCopyButton = button;
    ipcRenderer.send('copy-to-clipboard', text);
}

function flashCopied(button) {
    const originalText = button.textContent;
    button.textContent = 'Copied';
    button.classList.add('copied');
    setTimeout(() => {
        button.textContent = originalText;
        button.classList.remove('copied');
    }, 1400);
}

function updateQueueStatus() {
    const count = state.currentPaths.length;
    elements.queueStatus.textContent = `${count} ${count === 1 ? 'file' : 'files'}`;
}

function formatLanguage(language) {
    if (!language) {
        return '-';
    }
    if (typeof language === 'string') {
        return language;
    }
    if (language.language) {
        const confidence = language.confidence ? ` ${Number(language.confidence).toFixed(0)}%` : '';
        return `${language.language}${confidence}`;
    }
    return '-';
}

function isDirectory(filePath) {
    try {
        return fs.statSync(filePath).isDirectory();
    } catch (error) {
        return false;
    }
}

function isTextInput(element) {
    return element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;

    document.body.appendChild(notification);
    setTimeout(() => notification.classList.add('show'), 10);
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 250);
    }, 2800);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}
