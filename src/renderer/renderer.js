const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const SETTINGS_STORAGE_KEY = 'text-recognition-studio-settings-v2';
const HISTORY_STORAGE_KEY = 'text-recognition-studio-history-v1';
const FAVORITES_STORAGE_KEY = 'text-recognition-studio-favorites-v1';
const MAX_HISTORY_ITEMS = 12;
const MAX_FAVORITE_ITEMS = 10;
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
    favoriteOutputBtn: document.getElementById('favoriteOutputBtn'),
    revealSourceBtn: document.getElementById('revealSourceBtn'),
    revealSavedBtn: document.getElementById('revealSavedBtn'),
    exportFormat: document.getElementById('exportFormat'),
    saveOutputBtn: document.getElementById('saveOutputBtn'),
    exportAllBtn: document.getElementById('exportAllBtn'),
    exportZipBtn: document.getElementById('exportZipBtn'),
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
    comparePanel: document.getElementById('comparePanel'),
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
    checkRuntimeBtn: document.getElementById('checkRuntimeBtn'),
    runtimeStatus: document.getElementById('runtimeStatus'),
    runtimePanel: document.getElementById('runtimePanel'),
    historyCount: document.getElementById('historyCount'),
    historyList: document.getElementById('historyList'),
    historySearch: document.getElementById('historySearch'),
    clearHistoryBtn: document.getElementById('clearHistoryBtn'),
    favoritesCount: document.getElementById('favoritesCount'),
    favoritesList: document.getElementById('favoritesList'),
    clearFavoritesBtn: document.getElementById('clearFavoritesBtn'),
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
    displayText: '',
    favoriteOutputs: [],
    scanHistory: [],
    activeHistoryId: null,
    historyQuery: '',
    compareSelectionIds: [],
    lastSavedPath: '',
    region: null,
    regionMode: false,
    dragStart: null,
    lastCopyButton: null,
    cameraStream: null,
    copyRegionAfterScan: false,
    environmentReport: null,
};

loadSavedSettings();
loadFavoriteOutputs();
loadScanHistory();
syncSettingsState();
resetPanels();
renderFavorites();
renderHistory();
renderComparePanel();
syncExportControls();
syncFavoriteControls();
syncRevealControls();

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
elements.favoriteOutputBtn.addEventListener('click', toggleCurrentFavorite);
elements.revealSourceBtn.addEventListener('click', revealCurrentSourcePath);
elements.revealSavedBtn.addEventListener('click', revealLastSavedPath);
elements.exportFormat.addEventListener('change', syncExportControls);
elements.saveOutputBtn.addEventListener('click', saveOutputFile);
elements.exportAllBtn.addEventListener('click', exportAllOutputs);
elements.exportZipBtn.addEventListener('click', exportZipOutputs);
elements.checkRuntimeBtn.addEventListener('click', checkRuntimeEnvironment);
elements.clearHistoryBtn.addEventListener('click', clearScanHistory);
elements.historyList.addEventListener('click', handleHistoryAction);
elements.historySearch.addEventListener('input', handleHistorySearch);
elements.clearFavoritesBtn.addEventListener('click', clearFavoriteOutputs);
elements.favoritesList.addEventListener('click', handleFavoriteAction);
elements.comparePanel.addEventListener('click', handleCompareAction);
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

document.querySelectorAll('.settings-panel select, .settings-panel input[type="checkbox"], .settings-panel textarea').forEach((input) => {
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

ipcRenderer.on('save-output-result', (event, result) => {
    syncExportControls();

    if (result.canceled) {
        return;
    }

    if (!result.success) {
        showNotification(result.error || 'Failed to save export', 'error');
        return;
    }

    state.lastSavedPath = result.filePath || state.lastSavedPath;
    syncRevealControls();
    showNotification(`Saved ${path.basename(result.filePath)}`, 'success');
});

ipcRenderer.on('export-output-bundle-result', (event, result) => {
    syncExportControls();

    if (result.canceled) {
        return;
    }

    if (!result.success) {
        showNotification(result.error || 'Failed to export files', 'error');
        return;
    }

    state.lastSavedPath = result.dirPath || state.lastSavedPath;
    syncRevealControls();
    showNotification(`Saved ${Number(result.fileCount || 0)} files to ${path.basename(result.dirPath || 'folder')}`, 'success');
});

ipcRenderer.on('export-output-zip-result', (event, result) => {
    syncExportControls();

    if (result.canceled) {
        return;
    }

    if (!result.success) {
        showNotification(result.error || 'Failed to create ZIP export', 'error');
        return;
    }

    state.lastSavedPath = result.filePath || state.lastSavedPath;
    syncRevealControls();
    showNotification(`Saved ZIP ${path.basename(result.filePath || 'export.zip')} with ${Number(result.fileCount || 0)} files`, 'success');
});

ipcRenderer.on('reveal-path-result', (event, result) => {
    syncRevealControls();

    if (!result.success) {
        showNotification(result.error || 'Failed to reveal path', 'error');
        return;
    }

    showNotification(`Opened ${path.basename(result.path || 'location')} in Explorer`, 'success');
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

ipcRenderer.on('environment-result', (event, result) => {
    elements.checkRuntimeBtn.disabled = false;

    if (result.success) {
        state.environmentReport = result;
        renderEnvironmentReport(result);
        return;
    }

    state.environmentReport = null;
    elements.runtimeStatus.textContent = 'Check failed';
    elements.runtimeStatus.dataset.level = 'low';
    elements.runtimePanel.innerHTML = `<div class="runtime-error">${escapeHtml(result.error || 'Environment check failed')}</div>`;
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

function checkRuntimeEnvironment() {
    elements.checkRuntimeBtn.disabled = true;
    elements.runtimeStatus.textContent = 'Checking...';
    elements.runtimeStatus.dataset.level = 'neutral';
    elements.runtimePanel.innerHTML = '<div class="runtime-loading"><div class="spinner small"></div><span>Probing Python, CUDA wheels, and OCR imports...</span></div>';
    ipcRenderer.send('check-environment');
}

function processPaths(paths, region = null) {
    resetPanels();
    state.currentResult = null;
    state.extractedText = '';
    state.markdownText = '';
    state.jsonText = '';
    state.tableText = '';
    state.displayText = '';

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

function displayResults(rawResult, options = {}) {
    const result = {
        ...rawResult,
        inputPaths: Array.isArray(rawResult?.inputPaths) && rawResult.inputPaths.length
            ? rawResult.inputPaths
            : [...state.currentPaths],
    };

    state.currentResult = result;
    state.extractedText = result.text || result.ocrText || '';
    state.markdownText = result.markdown || state.extractedText;
    state.jsonText = result.jsonText || JSON.stringify(result.jsonData || result, null, 2);
    state.tableText = result.tableText || (result.tables || []).map((table) => table.markdown).filter(Boolean).join('\n\n');
    state.displayText = state.extractedText || state.markdownText || state.jsonText;

    elements.resultsContainer.innerHTML = `<pre class="result-text">${escapeHtml(state.displayText)}</pre>`;

    elements.methodUsed.textContent = result.method || 'OCR';
    updateConfidenceDisplay(result.confidence, result.method);
    elements.languageDetected.textContent = formatLanguage(result.language);
    elements.charCount.textContent = `${Number(result.charCount || state.displayText.length || 0).toLocaleString()} chars`;
    elements.engineStatus.textContent = 'Complete';

    setCopyButtons(true);
    elements.copyMarkdownBtn.disabled = !state.markdownText;
    elements.copyJsonBtn.disabled = !state.jsonText;
    elements.copyTableBtn.disabled = !state.tableText;
    syncExportControls();
    syncFavoriteControls();
    syncRevealControls();

    renderBatch(result.items || []);
    renderCodes(result.codes || []);
    renderWarnings(result.warnings || []);
    renderStructure(result);

    if (!options.skipHistory) {
        recordScanHistory(result);
    } else if (options.historyId) {
        state.activeHistoryId = options.historyId;
        renderHistory();
    }

    renderComparePanel();

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
    state.displayText = '';
    elements.resultsContainer.innerHTML = `
        <div class="error-state">
            <strong>Scan failed</strong>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
    setCopyButtons(false);
    syncExportControls();
    syncFavoriteControls();
    syncRevealControls();
    elements.engineStatus.textContent = 'Error';
}

function resetUI() {
    state.currentPaths = [];
    state.currentResult = null;
    state.extractedText = '';
    state.markdownText = '';
    state.jsonText = '';
    state.tableText = '';
    state.displayText = '';
    state.activeHistoryId = null;
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
    syncExportControls();
    syncFavoriteControls();
    syncRevealControls();
    renderFavorites();
    renderHistory();
    renderComparePanel();
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

function toggleCurrentFavorite() {
    if (!state.currentResult) {
        return;
    }

    const currentSignature = getResultSignature(state.currentResult);
    if (!currentSignature) {
        showNotification('No current output is available to favorite', 'error');
        return;
    }

    const existingFavorite = state.favoriteOutputs.find((entry) => entry.signature === currentSignature);
    if (existingFavorite) {
        removeFavoriteOutput(existingFavorite.id, false);
        showNotification('Removed output from favorites', 'success');
        return;
    }

    addFavoriteOutput(createFavoriteEntryFromResult(state.currentResult, {
        title: getCurrentResultTitle(),
    }));
    showNotification('Added output to favorites', 'success');
}

function saveOutputFile() {
    const payload = getExportPayload(elements.exportFormat.value);
    if (!payload) {
        showNotification('No export is available for that format yet', 'error');
        syncExportControls();
        return;
    }

    elements.saveOutputBtn.disabled = true;
    ipcRenderer.send('save-output', payload);
}

function exportAllOutputs() {
    const entries = getAllExportPayloads();
    if (!entries.length) {
        showNotification('No exports are available yet', 'error');
        syncExportControls();
        return;
    }

    elements.exportAllBtn.disabled = true;
    ipcRenderer.send('export-output-bundle', {
        entries,
        suggestedFolderName: `${getSuggestedExportBaseName()}-exports`,
    });
}

function exportZipOutputs() {
    const entries = getAllExportPayloads();
    if (!entries.length) {
        showNotification('No exports are available yet', 'error');
        syncExportControls();
        return;
    }

    elements.exportZipBtn.disabled = true;
    ipcRenderer.send('export-output-zip', {
        entries,
        suggestedFileName: `${getSuggestedExportBaseName()}-exports`,
    });
}

function exportCompareDiff(format) {
    const payload = getCompareExportPayload(format);
    if (!payload) {
        showNotification('Choose two history entries before exporting a diff', 'error');
        return;
    }

    ipcRenderer.send('save-output', payload);
}

function revealCurrentSourcePath() {
    const revealPath = getPrimarySourcePath();
    if (!revealPath) {
        showNotification('No source path is available for this result', 'error');
        syncRevealControls();
        return;
    }

    elements.revealSourceBtn.disabled = true;
    ipcRenderer.send('reveal-path', { path: revealPath });
}

function revealLastSavedPath() {
    if (!state.lastSavedPath) {
        showNotification('No saved export is available yet', 'error');
        syncRevealControls();
        return;
    }

    elements.revealSavedBtn.disabled = true;
    ipcRenderer.send('reveal-path', { path: state.lastSavedPath });
}

function syncExportControls() {
    const availableFormats = {
        current: Boolean(getExportPayload('current')),
        text: Boolean(getExportPayload('text')),
        markdown: Boolean(getExportPayload('markdown')),
        table: Boolean(getExportPayload('table')),
        json: Boolean(getExportPayload('json')),
    };

    Array.from(elements.exportFormat.options).forEach((option) => {
        option.disabled = !availableFormats[option.value];
    });

    if (!availableFormats[elements.exportFormat.value]) {
        elements.exportFormat.value = getPreferredExportFormat(availableFormats);
    }

    elements.saveOutputBtn.disabled = !availableFormats[elements.exportFormat.value];
    elements.exportAllBtn.disabled = !Object.values(availableFormats).some(Boolean);
    elements.exportZipBtn.disabled = !Object.values(availableFormats).some(Boolean);
}

function syncFavoriteControls() {
    const currentSignature = getResultSignature(state.currentResult);
    const isFavorited = Boolean(currentSignature && state.favoriteOutputs.some((entry) => entry.signature === currentSignature));
    elements.favoriteOutputBtn.disabled = !currentSignature;
    elements.favoriteOutputBtn.textContent = isFavorited ? 'Unfavorite Output' : 'Favorite Output';
}

function syncRevealControls() {
    elements.revealSourceBtn.disabled = !getPrimarySourcePath();
    elements.revealSavedBtn.disabled = !state.lastSavedPath;
}

function getPreferredExportFormat(availableFormats) {
    const outputStyle = state.currentResult?.options?.outputStyle || elements.outputStyle.value;
    const preferred = outputStyle === 'json'
        ? 'json'
        : outputStyle === 'markdown'
            ? 'markdown'
            : outputStyle === 'tables'
                ? 'table'
                : 'text';

    if (availableFormats[preferred]) {
        return preferred;
    }

    return ['current', 'text', 'markdown', 'table', 'json'].find((key) => availableFormats[key]) || 'current';
}

function getExportPayload(format) {
    const baseName = getSuggestedExportBaseName();
    const descriptors = {
        current: {
            content: state.displayText,
            extension: getCurrentExportExtension(),
            label: 'Current Output',
            suggestedName: `${baseName}-output`,
        },
        text: {
            content: state.currentResult?.ocrText || state.extractedText,
            extension: '.txt',
            label: 'OCR Text',
            suggestedName: `${baseName}-ocr`,
        },
        markdown: {
            content: state.markdownText,
            extension: '.md',
            label: 'Markdown',
            suggestedName: `${baseName}-notes`,
        },
        table: {
            content: state.tableText,
            extension: '.md',
            label: 'Table Export',
            suggestedName: `${baseName}-table`,
        },
        json: {
            content: state.jsonText,
            extension: '.json',
            label: 'JSON Export',
            suggestedName: `${baseName}-data`,
        },
    };

    const descriptor = descriptors[format];
    if (!descriptor || !descriptor.content) {
        return null;
    }

    return descriptor;
}

function getAllExportPayloads() {
    return ['current', 'text', 'markdown', 'table', 'json']
        .map((format) => getExportPayload(format))
        .filter(Boolean);
}

function getCurrentExportExtension() {
    const outputStyle = state.currentResult?.options?.outputStyle || elements.outputStyle.value;
    if (outputStyle === 'json') {
        return '.json';
    }
    if (outputStyle === 'markdown' || outputStyle === 'tables') {
        return '.md';
    }
    return '.txt';
}

function getSuggestedExportBaseName() {
    if (state.currentResult?.items?.length > 1 || state.currentPaths.length > 1) {
        return `text-recognition-batch-${state.currentPaths.length || state.currentResult?.items?.length || 1}`;
    }

    const sourcePath = state.currentResult?.sourcePath || state.currentPaths[0];
    if (!sourcePath) {
        return 'text-recognition-output';
    }

    return sanitizeBaseName(path.basename(sourcePath, path.extname(sourcePath)));
}

function getPrimarySourcePath() {
    return state.currentResult?.sourcePath
        || state.currentResult?.inputPaths?.[0]
        || state.currentPaths[0]
        || '';
}

function getCurrentResultTitle() {
    const primarySourcePath = getPrimarySourcePath();
    if (state.currentResult?.fileCount > 1 || state.currentPaths.length > 1) {
        return `Favorite ${state.currentResult?.fileCount || state.currentPaths.length || 1} inputs`;
    }
    return primarySourcePath ? path.basename(primarySourcePath) : 'Favorite Output';
}

function getResultSignature(result) {
    if (!result) {
        return '';
    }

    const sourcePath = result.sourcePath || result.inputPaths?.[0] || '';
    const text = String(result.ocrText || result.text || result.markdown || '').slice(0, 800);
    const options = result.options || {};
    return JSON.stringify([
        sourcePath,
        result.method || '',
        options.ocrMode || '',
        options.outputStyle || '',
        text,
    ]);
}

function createFavoriteEntryFromResult(result, overrides = {}) {
    const inputPaths = Array.isArray(result.inputPaths) ? result.inputPaths.filter(Boolean) : [];
    const signature = getResultSignature(result);
    return {
        id: `favorite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        title: overrides.title || getCurrentResultTitle(),
        preview: String(result.ocrText || result.text || composeCodePreview(result.codes || []) || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        sourcePath: result.sourcePath || inputPaths[0] || '',
        method: result.method || 'OCR',
        confidence: Number(result.confidence || 0),
        signature,
        ocrMode: result.options?.ocrMode || '',
        outputStyle: result.options?.outputStyle || '',
        result: serializeResultForHistory(result, inputPaths),
    };
}

function sanitizeBaseName(value) {
    return String(value || 'text-recognition-output')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'text-recognition-output';
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

function loadScanHistory() {
    try {
        const rawHistory = localStorage.getItem(HISTORY_STORAGE_KEY);
        const parsedHistory = rawHistory ? JSON.parse(rawHistory) : [];
        state.scanHistory = Array.isArray(parsedHistory)
            ? parsedHistory
                .filter((item) => item && item.id && item.result)
                .map((item) => ({
                    ...item,
                    pinned: Boolean(item.pinned),
                }))
            : [];
    } catch (error) {
        state.scanHistory = [];
    }
}

function loadFavoriteOutputs() {
    try {
        const rawFavorites = localStorage.getItem(FAVORITES_STORAGE_KEY);
        const parsedFavorites = rawFavorites ? JSON.parse(rawFavorites) : [];
        state.favoriteOutputs = Array.isArray(parsedFavorites)
            ? parsedFavorites.filter((item) => item && item.id && item.signature && item.result)
            : [];
    } catch (error) {
        state.favoriteOutputs = [];
    }
}

function persistFavoriteOutputs() {
    let favoritesToSave = [...state.favoriteOutputs];

    while (favoritesToSave.length) {
        try {
            localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favoritesToSave));
            if (favoritesToSave.length !== state.favoriteOutputs.length) {
                state.favoriteOutputs = favoritesToSave;
            }
            return true;
        } catch (error) {
            favoritesToSave = favoritesToSave.slice(0, -1);
        }
    }

    try {
        localStorage.removeItem(FAVORITES_STORAGE_KEY);
    } catch (error) {
        // Ignore cleanup failures.
    }

    state.favoriteOutputs = [];
    return false;
}

function addFavoriteOutput(entry) {
    state.favoriteOutputs = [entry, ...state.favoriteOutputs.filter((item) => item.signature !== entry.signature)].slice(0, MAX_FAVORITE_ITEMS);
    if (!persistFavoriteOutputs()) {
        showNotification('The favorite output was too large to store locally', 'error');
    }
    renderFavorites();
    renderHistory();
    syncFavoriteControls();
}

function removeFavoriteOutput(favoriteId, notify = true) {
    const entry = state.favoriteOutputs.find((item) => item.id === favoriteId);
    state.favoriteOutputs = state.favoriteOutputs.filter((item) => item.id !== favoriteId);
    persistFavoriteOutputs();
    renderFavorites();
    renderHistory();
    syncFavoriteControls();
    if (notify) {
        showNotification(`Removed ${entry?.title || 'favorite output'}`, 'success');
    }
}

function clearFavoriteOutputs() {
    state.favoriteOutputs = [];
    try {
        localStorage.removeItem(FAVORITES_STORAGE_KEY);
    } catch (error) {
        // Ignore cleanup failures.
    }
    renderFavorites();
    renderHistory();
    syncFavoriteControls();
    showNotification('Favorite outputs cleared', 'success');
}

function renderFavorites() {
    const count = state.favoriteOutputs.length;
    elements.favoritesCount.textContent = `${count} saved ${count === 1 ? 'output' : 'outputs'}`;
    elements.clearFavoritesBtn.disabled = count === 0;

    if (!count) {
        elements.favoritesList.innerHTML = '<div class="history-empty">Favorited outputs will appear here.</div>';
        return;
    }

    elements.favoritesList.innerHTML = state.favoriteOutputs.map((entry) => `
        <article class="history-item favorite-item">
            <div class="history-card-head">
                <strong>${escapeHtml(entry.title || 'Favorite Output')}</strong>
                <span>${escapeHtml(formatHistoryTime(entry.createdAt))}</span>
            </div>
            <div class="history-meta">
                <span>${escapeHtml(entry.method || 'OCR')}</span>
                <span>${Number(entry.confidence || 0).toFixed(1)}%</span>
            </div>
            <div class="history-tags">
                ${renderHistoryTagHtml(entry)}
            </div>
            <p class="history-path">${escapeHtml(entry.sourcePath || 'Saved output')}</p>
            <p class="history-preview">${escapeHtml(entry.preview || 'No preview available')}</p>
            <div class="history-actions">
                <button class="btn btn-secondary history-btn" type="button" data-favorite-action="load" data-favorite-id="${escapeHtml(entry.id)}">Load</button>
                <button class="btn btn-ghost history-btn" type="button" data-favorite-action="reveal" data-favorite-id="${escapeHtml(entry.id)}" ${entry.sourcePath ? '' : 'disabled'}>Reveal</button>
                <button class="btn btn-ghost history-btn history-delete-btn" type="button" data-favorite-action="remove" data-favorite-id="${escapeHtml(entry.id)}">Remove</button>
            </div>
        </article>
    `).join('');
}

function persistScanHistory() {
    let historyToSave = [...state.scanHistory];

    while (historyToSave.length) {
        try {
            localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(historyToSave));
            if (historyToSave.length !== state.scanHistory.length) {
                state.scanHistory = historyToSave;
            }
            return true;
        } catch (error) {
            historyToSave = historyToSave.slice(0, -1);
        }
    }

    try {
        localStorage.removeItem(HISTORY_STORAGE_KEY);
    } catch (error) {
        // Ignore storage cleanup failures.
    }

    state.scanHistory = [];
    return false;
}

function recordScanHistory(result) {
    const entry = createHistoryEntry(result);
    state.scanHistory = [entry, ...state.scanHistory.filter((item) => item.id !== entry.id)].slice(0, MAX_HISTORY_ITEMS);

    if (!persistScanHistory()) {
        showNotification('The latest result was too large to keep in local history', 'error');
        renderHistory();
        return;
    }

    state.activeHistoryId = entry.id;
    renderHistory();
}

function createHistoryEntry(result) {
    const inputPaths = Array.isArray(result.inputPaths) ? result.inputPaths.filter(Boolean) : [];
    const fileCount = Number(result.fileCount || result.items?.length || inputPaths.length || 1);
    const sourcePath = result.sourcePath || inputPaths[0] || '';
    const title = fileCount > 1
        ? `${fileCount} inputs scanned`
        : path.basename(sourcePath || 'Untitled Scan');
    const previewSource = result.ocrText || result.text || composeCodePreview(result.codes || []);
    const scanOptions = result.options || getScanOptions();

    return {
        id: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        pinned: false,
        title,
        customLabel: '',
        preview: String(previewSource || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        sourcePath,
        inputPaths,
        fileCount,
        method: result.method || 'OCR',
        confidence: Number(result.confidence || 0),
        ocrMode: scanOptions.ocrMode || '',
        outputStyle: scanOptions.outputStyle || '',
        result: serializeResultForHistory(result, inputPaths),
    };
}

function serializeResultForHistory(result, inputPaths) {
    return {
        text: result.text || result.ocrText || '',
        ocrText: result.ocrText || result.text || '',
        markdown: result.markdown || result.text || result.ocrText || '',
        jsonText: result.jsonText || state.jsonText || '',
        tableText: result.tableText || state.tableText || '',
        method: result.method || 'OCR',
        confidence: Number(result.confidence || 0),
        language: result.language || null,
        charCount: Number(result.charCount || 0),
        sourcePath: result.sourcePath || inputPaths[0] || '',
        inputPaths,
        options: result.options || getScanOptions(),
        items: Array.isArray(result.items)
            ? result.items.map((item) => ({
                sourcePath: item.sourcePath || '',
                success: Boolean(item.success),
                confidence: Number(item.confidence || 0),
                error: item.error || '',
            }))
            : [],
        codes: Array.isArray(result.codes) ? result.codes : [],
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        tables: Array.isArray(result.tables) ? result.tables : [],
        keyValues: Array.isArray(result.keyValues) ? result.keyValues : [],
        formFields: Array.isArray(result.formFields) ? result.formFields : [],
        cleanupActions: Array.isArray(result.cleanupActions) ? result.cleanupActions : [],
        fileCount: Number(result.fileCount || result.items?.length || inputPaths.length || 1),
    };
}

function getVisibleHistoryEntries() {
    const query = state.historyQuery.trim().toLowerCase();
    const sortedEntries = [...state.scanHistory].sort((left, right) => {
        if (Boolean(left.pinned) !== Boolean(right.pinned)) {
            return left.pinned ? -1 : 1;
        }
        return String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
    });

    if (!query) {
        return sortedEntries;
    }

    return sortedEntries.filter((entry) => {
        const haystack = [
            getHistoryDisplayTitle(entry),
            entry.preview,
            entry.sourcePath,
            entry.method,
            getHistoryMode(entry),
            getHistoryOutputStyle(entry),
        ].join(' ').toLowerCase();
        return haystack.includes(query);
    });
}

function renderHistory() {
    const totalCount = state.scanHistory.length;
    const visibleEntries = getVisibleHistoryEntries();
    const visibleCount = visibleEntries.length;
    elements.historyCount.textContent = state.historyQuery.trim()
        ? `${visibleCount} of ${totalCount} scans`
        : `${totalCount} recent ${totalCount === 1 ? 'scan' : 'scans'}`;
    elements.clearHistoryBtn.disabled = totalCount === 0;

    if (!totalCount) {
        elements.historyList.innerHTML = '<div class="history-empty">Recent scans will appear here.</div>';
        return;
    }

    if (!visibleCount) {
        elements.historyList.innerHTML = '<div class="history-empty">No history entries match this search.</div>';
        return;
    }

    elements.historyList.innerHTML = visibleEntries.map((entry) => `
        <article class="history-item ${entry.id === state.activeHistoryId ? 'active' : ''}">
            <div class="history-card-head">
                <strong>${escapeHtml(entry.pinned ? `[Pinned] ${getHistoryDisplayTitle(entry)}` : getHistoryDisplayTitle(entry))}</strong>
                <span>${escapeHtml(formatHistoryTime(entry.createdAt))}</span>
            </div>
            <div class="history-meta">
                <span>${escapeHtml(entry.method || 'OCR')}</span>
                <span>${Number(entry.confidence || 0).toFixed(1)}%</span>
                <span>${Number(entry.fileCount || 1)} ${Number(entry.fileCount || 1) === 1 ? 'file' : 'files'}</span>
            </div>
            <div class="history-tags">
                ${renderHistoryTagHtml(entry)}
            </div>
            <p class="history-path">${escapeHtml(entry.sourcePath || 'Saved result')}</p>
            <p class="history-preview">${escapeHtml(entry.preview || 'No preview available')}</p>
            <div class="history-actions">
                <button class="btn btn-secondary history-btn" type="button" data-history-action="load" data-history-id="${escapeHtml(entry.id)}">Load</button>
                <button class="btn btn-ghost history-btn" type="button" data-history-action="rescan" data-history-id="${escapeHtml(entry.id)}" ${entry.inputPaths?.length ? '' : 'disabled'}>Re-scan</button>
                <button class="btn btn-ghost history-btn" type="button" data-history-action="reveal" data-history-id="${escapeHtml(entry.id)}" ${entry.sourcePath ? '' : 'disabled'}>Reveal</button>
                <button class="btn btn-ghost history-btn" type="button" data-history-action="compare" data-history-id="${escapeHtml(entry.id)}">${state.compareSelectionIds.includes(entry.id) ? 'Remove Compare' : 'Compare'}</button>
                <button class="btn btn-ghost history-btn" type="button" data-history-action="favorite" data-history-id="${escapeHtml(entry.id)}">${isHistoryEntryFavorited(entry) ? 'Unfavorite' : 'Favorite'}</button>
                <button class="btn btn-ghost history-btn" type="button" data-history-action="rename" data-history-id="${escapeHtml(entry.id)}">Rename</button>
                <button class="btn btn-ghost history-btn" type="button" data-history-action="pin" data-history-id="${escapeHtml(entry.id)}">${entry.pinned ? 'Unpin' : 'Pin'}</button>
                <button class="btn btn-ghost history-btn history-delete-btn" type="button" data-history-action="delete" data-history-id="${escapeHtml(entry.id)}">Delete</button>
            </div>
        </article>
    `).join('');
}

function getHistoryDisplayTitle(entry) {
    return entry?.customLabel || entry?.title || 'Scan';
}

function getHistoryMode(entry) {
    return entry.ocrMode || entry.result?.options?.ocrMode || '';
}

function getHistoryOutputStyle(entry) {
    return entry.outputStyle || entry.result?.options?.outputStyle || '';
}

function formatHistoryTag(value) {
    if (!value) {
        return '';
    }

    return String(value)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderHistoryTagHtml(entry) {
    const tags = [getHistoryMode(entry), getHistoryOutputStyle(entry)]
        .filter(Boolean)
        .map((value) => `<span class="history-tag">${escapeHtml(formatHistoryTag(value))}</span>`);
    return tags.join('');
}

function handleHistorySearch(event) {
    state.historyQuery = event.target.value || '';
    renderHistory();
}

function handleHistoryAction(event) {
    const actionButton = event.target.closest('[data-history-action]');
    if (!actionButton) {
        return;
    }

    const entryId = actionButton.dataset.historyId;
    if (!entryId) {
        return;
    }

    if (actionButton.dataset.historyAction === 'load') {
        loadHistoryEntry(entryId);
        return;
    }

    if (actionButton.dataset.historyAction === 'rescan') {
        rescanHistoryEntry(entryId);
        return;
    }

    if (actionButton.dataset.historyAction === 'reveal') {
        revealHistoryEntrySource(entryId);
        return;
    }

    if (actionButton.dataset.historyAction === 'compare') {
        toggleCompareSelection(entryId);
        return;
    }

    if (actionButton.dataset.historyAction === 'favorite') {
        toggleFavoriteForHistoryEntry(entryId);
        return;
    }

    if (actionButton.dataset.historyAction === 'rename') {
        renameHistoryEntry(entryId);
        return;
    }

    if (actionButton.dataset.historyAction === 'pin') {
        togglePinHistoryEntry(entryId);
        return;
    }

    if (actionButton.dataset.historyAction === 'delete') {
        deleteHistoryEntry(entryId);
    }
}

function handleFavoriteAction(event) {
    const actionButton = event.target.closest('[data-favorite-action]');
    if (!actionButton) {
        return;
    }

    const favoriteId = actionButton.dataset.favoriteId;
    if (!favoriteId) {
        return;
    }

    if (actionButton.dataset.favoriteAction === 'load') {
        loadFavoriteOutput(favoriteId);
        return;
    }

    if (actionButton.dataset.favoriteAction === 'reveal') {
        revealFavoriteOutput(favoriteId);
        return;
    }

    if (actionButton.dataset.favoriteAction === 'remove') {
        removeFavoriteOutput(favoriteId);
    }
}

function handleCompareAction(event) {
    const actionButton = event.target.closest('[data-compare-action]');
    if (!actionButton) {
        return;
    }

    if (actionButton.dataset.compareAction === 'clear') {
        state.compareSelectionIds = [];
        renderHistory();
        renderComparePanel();
        return;
    }

    if (actionButton.dataset.compareAction === 'swap' && state.compareSelectionIds.length === 2) {
        state.compareSelectionIds = [...state.compareSelectionIds].reverse();
        renderHistory();
        renderComparePanel();
        return;
    }

    if (actionButton.dataset.compareAction === 'export-markdown') {
        exportCompareDiff('markdown');
        return;
    }

    if (actionButton.dataset.compareAction === 'export-json') {
        exportCompareDiff('json');
    }
}

function loadHistoryEntry(entryId) {
    const entry = state.scanHistory.find((item) => item.id === entryId);
    if (!entry) {
        return;
    }

    displayResults({
        ...entry.result,
        inputPaths: entry.inputPaths || entry.result.inputPaths || [],
        jsonText: entry.result.jsonText || '',
        tableText: entry.result.tableText || '',
    }, { skipHistory: true, historyId: entry.id });
    showNotification('Loaded result from history', 'success');
}

function rescanHistoryEntry(entryId) {
    const entry = state.scanHistory.find((item) => item.id === entryId);
    const inputPaths = Array.isArray(entry?.inputPaths) ? entry.inputPaths.filter(Boolean) : [];
    if (!inputPaths.length) {
        showNotification('No source files are saved for that history entry', 'error');
        return;
    }

    handlePaths(inputPaths);
}

function revealHistoryEntrySource(entryId) {
    const entry = state.scanHistory.find((item) => item.id === entryId);
    if (!entry?.sourcePath) {
        showNotification('No source path is saved for that history entry', 'error');
        return;
    }

    ipcRenderer.send('reveal-path', { path: entry.sourcePath });
}

function clearScanHistory() {
    state.scanHistory = [];
    state.activeHistoryId = null;
    state.historyQuery = '';
    state.compareSelectionIds = [];
    elements.historySearch.value = '';
    try {
        localStorage.removeItem(HISTORY_STORAGE_KEY);
    } catch (error) {
        // Ignore storage cleanup failures.
    }
    renderHistory();
    renderComparePanel();
    showNotification('Scan history cleared', 'success');
}

function toggleFavoriteForHistoryEntry(entryId) {
    const entry = state.scanHistory.find((item) => item.id === entryId);
    if (!entry) {
        return;
    }

    const existingFavorite = state.favoriteOutputs.find((item) => item.signature === getResultSignature(entry.result));
    if (existingFavorite) {
        removeFavoriteOutput(existingFavorite.id, false);
        showNotification('Removed output from favorites', 'success');
        return;
    }

    addFavoriteOutput({
        ...createFavoriteEntryFromResult({
            ...entry.result,
            inputPaths: entry.inputPaths || entry.result.inputPaths || [],
        }, {
            title: getHistoryDisplayTitle(entry),
        }),
        sourcePath: entry.sourcePath || entry.result?.sourcePath || '',
        ocrMode: getHistoryMode(entry),
        outputStyle: getHistoryOutputStyle(entry),
    });
    showNotification('Added output to favorites', 'success');
}

function isHistoryEntryFavorited(entry) {
    const signature = getResultSignature(entry?.result);
    return Boolean(signature && state.favoriteOutputs.some((item) => item.signature === signature));
}

function renameHistoryEntry(entryId) {
    const entry = state.scanHistory.find((item) => item.id === entryId);
    if (!entry) {
        return;
    }

    const nextLabel = window.prompt('Rename history entry. Leave blank to reset the default label.', entry.customLabel || getHistoryDisplayTitle(entry));
    if (nextLabel === null) {
        return;
    }

    const trimmedLabel = nextLabel.trim();
    state.scanHistory = state.scanHistory.map((item) => item.id === entryId ? { ...item, customLabel: trimmedLabel } : item);
    persistScanHistory();
    renderHistory();
    renderComparePanel();
}

function togglePinHistoryEntry(entryId) {
    state.scanHistory = state.scanHistory.map((entry) => entry.id === entryId ? { ...entry, pinned: !entry.pinned } : entry);
    if (!persistScanHistory()) {
        showNotification('Failed to update scan history', 'error');
    }
    renderHistory();
    renderComparePanel();
}

function deleteHistoryEntry(entryId) {
    const entry = state.scanHistory.find((item) => item.id === entryId);
    state.scanHistory = state.scanHistory.filter((item) => item.id !== entryId);
    if (state.activeHistoryId === entryId) {
        state.activeHistoryId = null;
    }
    state.compareSelectionIds = state.compareSelectionIds.filter((id) => id !== entryId);
    persistScanHistory();
    renderHistory();
    renderComparePanel();
    showNotification(`Deleted ${getHistoryDisplayTitle(entry)}`, 'success');
}

function toggleCompareSelection(entryId) {
    if (state.compareSelectionIds.includes(entryId)) {
        state.compareSelectionIds = state.compareSelectionIds.filter((id) => id !== entryId);
    } else {
        state.compareSelectionIds = [...state.compareSelectionIds, entryId].slice(-2);
    }

    renderHistory();
    renderComparePanel();
}

function getCompareEntries() {
    const availableIds = new Set(state.scanHistory.map((entry) => entry.id));
    state.compareSelectionIds = state.compareSelectionIds.filter((id) => availableIds.has(id));
    return state.compareSelectionIds
        .map((id) => state.scanHistory.find((entry) => entry.id === id))
        .filter(Boolean);
}

function renderComparePanel() {
    const compareEntries = getCompareEntries();

    if (!compareEntries.length) {
        elements.comparePanel.style.display = 'none';
        elements.comparePanel.innerHTML = '';
        return;
    }

    if (compareEntries.length === 1) {
        elements.comparePanel.style.display = 'block';
        elements.comparePanel.innerHTML = `
            <div class="compare-header">
                <div>
                    <strong>Compare History</strong>
                    <span>Select one more history item to compare against ${escapeHtml(getHistoryDisplayTitle(compareEntries[0]))}.</span>
                </div>
                <div class="compare-actions">
                    <button class="btn btn-ghost compare-btn" type="button" data-compare-action="clear">Clear</button>
                </div>
            </div>
        `;
        return;
    }

    const comparison = buildComparisonRows(compareEntries[0], compareEntries[1]);
    elements.comparePanel.style.display = 'block';
    elements.comparePanel.innerHTML = `
        <div class="compare-header">
            <div>
                <strong>Compare History</strong>
                <span>${comparison.changedCount} changed ${comparison.changedCount === 1 ? 'line' : 'lines'} across ${comparison.totalRows} rows${comparison.truncated ? ' - showing first 250 rows' : ''}.</span>
            </div>
            <div class="compare-actions">
                <button class="btn btn-secondary compare-btn" type="button" data-compare-action="export-markdown">Diff Markdown</button>
                <button class="btn btn-secondary compare-btn" type="button" data-compare-action="export-json">Diff JSON</button>
                <button class="btn btn-ghost compare-btn" type="button" data-compare-action="swap">Swap</button>
                <button class="btn btn-ghost compare-btn" type="button" data-compare-action="clear">Clear</button>
            </div>
        </div>
        <div class="compare-grid">
            <section class="compare-column">
                ${renderCompareColumn(compareEntries[0], comparison.rows, 'left')}
            </section>
            <section class="compare-column">
                ${renderCompareColumn(compareEntries[1], comparison.rows, 'right')}
            </section>
        </div>
    `;
}

function buildComparisonRows(leftEntry, rightEntry, rowLimit = 250) {
    const leftLines = getComparisonText(leftEntry).split(/\r?\n/);
    const rightLines = getComparisonText(rightEntry).split(/\r?\n/);
    const totalRows = Math.max(leftLines.length, rightLines.length, 1);
    const limit = Number.isFinite(rowLimit) ? rowLimit : totalRows;
    const visibleRows = Math.min(totalRows, limit);
    const rows = [];
    let changedCount = 0;

    for (let index = 0; index < visibleRows; index += 1) {
        const leftText = leftLines[index] ?? '';
        const rightText = rightLines[index] ?? '';
        const same = leftText === rightText;
        if (!same) {
            changedCount += 1;
        }
        rows.push({
            lineNumber: index + 1,
            leftText,
            rightText,
            same,
        });
    }

    return {
        changedCount,
        rows,
        changedRows: rows.filter((row) => !row.same),
        totalRows,
        truncated: totalRows > rowLimit,
    };
}

function getComparisonText(entry) {
    const candidate = entry?.result?.ocrText || entry?.result?.text || entry?.result?.markdown || '';
    const normalized = String(candidate || '').replace(/\r\n?/g, '\n');
    return normalized || '[No text available]';
}

function renderCompareColumn(entry, rows, side) {
    return `
        <div class="compare-column-head">
            <div>
                <strong>${escapeHtml(getHistoryDisplayTitle(entry))}</strong>
                <div class="compare-tags">${renderHistoryTagHtml(entry)}</div>
            </div>
            <span>${escapeHtml(entry.method || 'OCR')}</span>
        </div>
        <div class="compare-lines">
            ${rows.map((row) => renderCompareLine(row, side)).join('')}
        </div>
    `;
}

function renderCompareLine(row, side) {
    const text = side === 'left' ? row.leftText : row.rightText;
    return `
        <div class="compare-line ${row.same ? 'same' : 'different'}">
            <span class="compare-line-number">${row.lineNumber}</span>
            <code>${escapeHtml(text || ' ')}</code>
        </div>
    `;
}

function getCompareExportPayload(format) {
    const compareEntries = getCompareEntries();
    if (compareEntries.length !== 2) {
        return null;
    }

    const comparison = buildComparisonRows(compareEntries[0], compareEntries[1], Number.POSITIVE_INFINITY);
    const baseName = `${sanitizeBaseName(getHistoryDisplayTitle(compareEntries[0]))}-vs-${sanitizeBaseName(getHistoryDisplayTitle(compareEntries[1]))}`;

    if (format === 'markdown') {
        return {
            content: buildCompareMarkdown(compareEntries[0], compareEntries[1], comparison),
            extension: '.md',
            label: 'Comparison Diff',
            suggestedName: `${baseName}-diff`,
        };
    }

    if (format === 'json') {
        return {
            content: JSON.stringify(buildCompareJson(compareEntries[0], compareEntries[1], comparison), null, 2),
            extension: '.json',
            label: 'Comparison Diff',
            suggestedName: `${baseName}-diff`,
        };
    }

    return null;
}

function buildCompareMarkdown(leftEntry, rightEntry, comparison) {
    const changedRows = comparison.changedRows.length ? comparison.changedRows : comparison.rows;
    const sections = [
        '# OCR Comparison Diff',
        '',
        `- Left: ${getHistoryDisplayTitle(leftEntry)} (${leftEntry.method || 'OCR'})`,
        `- Right: ${getHistoryDisplayTitle(rightEntry)} (${rightEntry.method || 'OCR'})`,
        `- Changed lines: ${comparison.changedCount} of ${comparison.totalRows}`,
        '',
        '## Changed Lines',
        '',
    ];

    changedRows.forEach((row) => {
        sections.push(`### Line ${row.lineNumber}`);
        sections.push('Left');
        sections.push('```text');
        sections.push(row.leftText || '');
        sections.push('```');
        sections.push('Right');
        sections.push('```text');
        sections.push(row.rightText || '');
        sections.push('```');
        sections.push('');
    });

    return sections.join('\n').trim();
}

function buildCompareJson(leftEntry, rightEntry, comparison) {
    return {
        generatedAt: new Date().toISOString(),
        left: {
            title: getHistoryDisplayTitle(leftEntry),
            method: leftEntry.method || 'OCR',
            mode: getHistoryMode(leftEntry),
            outputStyle: getHistoryOutputStyle(leftEntry),
            sourcePath: leftEntry.sourcePath || '',
        },
        right: {
            title: getHistoryDisplayTitle(rightEntry),
            method: rightEntry.method || 'OCR',
            mode: getHistoryMode(rightEntry),
            outputStyle: getHistoryOutputStyle(rightEntry),
            sourcePath: rightEntry.sourcePath || '',
        },
        totalRows: comparison.totalRows,
        changedCount: comparison.changedCount,
        changedRows: comparison.changedRows,
    };
}

function loadFavoriteOutput(favoriteId) {
    const entry = state.favoriteOutputs.find((item) => item.id === favoriteId);
    if (!entry) {
        return;
    }

    displayResults({
        ...entry.result,
        inputPaths: entry.result.inputPaths || [],
        jsonText: entry.result.jsonText || '',
        tableText: entry.result.tableText || '',
    }, { skipHistory: true });
    showNotification('Loaded favorite output', 'success');
}

function revealFavoriteOutput(favoriteId) {
    const entry = state.favoriteOutputs.find((item) => item.id === favoriteId);
    if (!entry?.sourcePath) {
        showNotification('No source path is saved for that favorite output', 'error');
        return;
    }

    ipcRenderer.send('reveal-path', { path: entry.sourcePath });
}

function composeCodePreview(codes) {
    if (!Array.isArray(codes) || !codes.length) {
        return '';
    }

    return codes.map((code) => `${code.type || 'CODE'}: ${code.text || ''}`).join(' | ');
}

function formatHistoryTime(value) {
    if (!value) {
        return 'Unknown time';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'Unknown time';
    }

    return date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

function renderEnvironmentReport(report) {
    const checks = Array.isArray(report.checks) ? report.checks : [];
    const hasCudaRuntime = checks.some((check) => check.cudaUsable);
    const hasCudaWheel = checks.some((check) => check.cudaWheel);
    elements.runtimeStatus.textContent = hasCudaRuntime ? 'CUDA ready' : hasCudaWheel ? 'Wheel only' : 'CPU only';
    elements.runtimeStatus.dataset.level = hasCudaRuntime ? 'high' : hasCudaWheel ? 'medium' : 'neutral';

    const python = report.python || {};
    const system = report.system || {};
    const nvidiaSmi = system.nvidiaSmi || {};
    const gpuLines = Array.isArray(nvidiaSmi.gpus) && nvidiaSmi.gpus.length
        ? nvidiaSmi.gpus.map((line) => `<span>${escapeHtml(line)}</span>`).join('')
        : `<span>${escapeHtml(nvidiaSmi.error || 'No NVIDIA GPU information reported')}</span>`;

    elements.runtimePanel.innerHTML = `
        <div class="runtime-summary">
            <strong>${escapeHtml(report.summary || 'Environment check complete')}</strong>
            <div class="runtime-meta">
                <span>Python ${escapeHtml(python.version || '-')}</span>
                <span>${escapeHtml(python.platform || '-')}</span>
            </div>
            <div class="runtime-path">${escapeHtml(python.executable || '-')}</div>
            <div class="runtime-gpus">${gpuLines}</div>
        </div>
        <div class="runtime-checks">
            ${checks.map((check) => renderEnvironmentCheck(check)).join('')}
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
                <strong>${escapeHtml(check.label || check.id || 'Check')}</strong>
                <span>${escapeHtml(getEnvironmentBadge(check))}</span>
            </div>
            <div class="runtime-card-meta">
                <span>${escapeHtml(check.version || 'not installed')}</span>
                <span>${escapeHtml(check.probe || 'probe')}</span>
            </div>
            <p>${escapeHtml(getEnvironmentSummary(check))}</p>
            ${detailLines.length ? `<div class="runtime-card-details">${detailLines.map((line) => `<span>${escapeHtml(line)}</span>`).join('')}</div>` : ''}
        </article>
    `;
}

function getEnvironmentLevel(check) {
    if (check.cudaUsable) {
        return 'high';
    }
    if (check.cudaWheel || check.cpuUsable) {
        return 'medium';
    }
    return 'low';
}

function getEnvironmentBadge(check) {
    if (check.cudaUsable) {
        return 'CUDA usable';
    }
    if (check.cudaWheel && !check.cudaAvailable) {
        return 'CUDA wheel';
    }
    if (check.cpuUsable) {
        return 'Import OK';
    }
    return 'Unavailable';
}

function getEnvironmentSummary(check) {
    if (check.cudaUsable) {
        return 'Import succeeded and a CUDA runtime test passed.';
    }
    if (check.cudaWheel && !check.cudaAvailable) {
        return 'A CUDA-capable wheel is installed, but no GPU runtime was available.';
    }
    if (check.cudaWheel) {
        return 'A CUDA-capable wheel is installed, but the runtime probe did not complete cleanly.';
    }
    if (check.cpuUsable) {
        return 'Import succeeded in the current Python environment.';
    }
    return check.error || 'The dependency is not importable in the current Python environment.';
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
