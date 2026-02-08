const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// DOM Elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const pasteBtn = document.getElementById('pasteBtn');
const imagePreview = document.getElementById('imagePreview');
const previewImg = document.getElementById('previewImg');
const clearBtn = document.getElementById('clearBtn');
const processingIndicator = document.getElementById('processingIndicator');
const resultsContainer = document.getElementById('resultsContainer');
const copyBtn = document.getElementById('copyBtn');
const metadata = document.getElementById('metadata');
const methodUsed = document.getElementById('methodUsed');
const confidenceScore = document.getElementById('confidenceScore');
const charCount = document.getElementById('charCount');

let currentImagePath = null;
let extractedText = '';

// Drag and Drop handlers
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        handleFile(files[0]);
    }
});

// Browse button handler
browseBtn.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
});

// Paste from clipboard handler
pasteBtn.addEventListener('click', () => {
    ipcRenderer.send('paste-from-clipboard');
});

ipcRenderer.on('clipboard-image', (event, imagePath) => {
    if (imagePath) {
        currentImagePath = imagePath;
        displayImage(imagePath);
        processImage(imagePath);
    } else {
        showNotification('No image found in clipboard', 'error');
    }
});

// Clear button handler
clearBtn.addEventListener('click', () => {
    resetUI();
});

// Copy button handler
copyBtn.addEventListener('click', () => {
    if (extractedText) {
        ipcRenderer.send('copy-to-clipboard', extractedText);
    }
});

ipcRenderer.on('copied-to-clipboard', (event, success) => {
    if (success) {
        showNotification('Text copied to clipboard!', 'success');
        
        // Visual feedback on button
        const originalText = copyBtn.innerHTML;
        copyBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Copied!
        `;
        copyBtn.classList.add('copied');
        
        setTimeout(() => {
            copyBtn.innerHTML = originalText;
            copyBtn.classList.remove('copied');
        }, 2000);
    }
});

// Handle file selection
function handleFile(file) {
    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/bmp', 'image/tiff'];
    if (!validTypes.includes(file.type)) {
        showNotification('Please select a valid image file (PNG, JPG, BMP, TIFF)', 'error');
        return;
    }
    
    currentImagePath = file.path;
    displayImage(file.path);
    processImage(file.path);
}

// Display image preview
function displayImage(imagePath) {
    previewImg.src = imagePath;
    dropZone.style.display = 'none';
    imagePreview.style.display = 'block';
}

// Process image with OCR
function processImage(imagePath) {
    // Show processing indicator
    processingIndicator.style.display = 'flex';
    resultsContainer.innerHTML = '<div class="empty-state"><div class="spinner"></div><p>Processing...</p></div>';
    copyBtn.disabled = true;
    metadata.style.display = 'none';
    
    // Send to main process for OCR
    ipcRenderer.send('process-image', imagePath);
}

// Handle OCR results
ipcRenderer.on('ocr-result', (event, result) => {
    processingIndicator.style.display = 'none';
    
    if (result.success && result.text) {
        extractedText = result.text;
        displayResults(result);
    } else {
        showError(result.error || 'Failed to extract text from image');
    }
});

// Display OCR results
function displayResults(result) {
    // Display text
    resultsContainer.innerHTML = `
        <div class="result-text">${escapeHtml(result.text)}</div>
    `;
    
    // Enable copy button
    copyBtn.disabled = false;
    
    // Show metadata
    metadata.style.display = 'flex';
    methodUsed.textContent = result.method || 'Unknown';
    confidenceScore.textContent = result.confidence ? `${result.confidence}%` : 'N/A';
    charCount.textContent = result.text.length.toLocaleString();
    
    // Add confidence color coding
    const confidence = result.confidence || 0;
    if (confidence >= 80) {
        confidenceScore.style.color = '#22c55e';
    } else if (confidence >= 60) {
        confidenceScore.style.color = '#f59e0b';
    } else {
        confidenceScore.style.color = '#ef4444';
    }
}

// Show error message
function showError(message) {
    resultsContainer.innerHTML = `
        <div class="error-state">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <p>Error</p>
            <p class="small-text">${escapeHtml(message)}</p>
        </div>
    `;
}

// Reset UI
function resetUI() {
    currentImagePath = null;
    extractedText = '';
    
    dropZone.style.display = 'flex';
    imagePreview.style.display = 'none';
    processingIndicator.style.display = 'none';
    
    resultsContainer.innerHTML = `
        <div class="empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            <p>Upload an image to extract text</p>
            <p class="small-text">Supports: PNG, JPG, JPEG, BMP, TIFF</p>
        </div>
    `;
    
    copyBtn.disabled = true;
    metadata.style.display = 'none';
    previewImg.src = '';
    fileInput.value = '';
}

// Show notification
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Trigger animation
    setTimeout(() => notification.classList.add('show'), 10);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Utility function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + V for paste
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
            e.preventDefault();
            pasteBtn.click();
        }
    }
    
    // Ctrl/Cmd + C for copy (when results are visible)
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && extractedText) {
        if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
            // Let default copy behavior work, but also trigger our copy
            copyBtn.click();
        }
    }
    
    // Escape to clear
    if (e.key === 'Escape' && currentImagePath) {
        clearBtn.click();
    }
});

// Paste event listener for the entire document
document.addEventListener('paste', (e) => {
    if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        pasteBtn.click();
    }
});
