const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let pythonProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Handle OCR processing
ipcMain.on('process-image', (event, imagePath) => {
  console.log('Processing image:', imagePath);
  
  const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
  const scriptPath = path.join(__dirname, '..', 'python', 'ocr_engine.py');
  
  pythonProcess = spawn(pythonExecutable, [scriptPath, imagePath]);
  
  let dataString = '';
  let errorString = '';
  
  pythonProcess.stdout.on('data', (data) => {
    dataString += data.toString();
  });
  
  pythonProcess.stderr.on('data', (data) => {
    errorString += data.toString();
    console.error('Python Error:', data.toString());
  });
  
  pythonProcess.on('close', (code) => {
    if (code !== 0) {
      event.reply('ocr-result', { 
        error: errorString || 'OCR processing failed',
        success: false 
      });
    } else {
      try {
        const result = JSON.parse(dataString);
        event.reply('ocr-result', { 
          text: result.text,
          method: result.method,
          confidence: result.confidence,
          success: true 
        });
      } catch (e) {
        event.reply('ocr-result', { 
          error: 'Failed to parse OCR result: ' + e.message,
          success: false 
        });
      }
    }
  });
});

// Handle clipboard paste
ipcMain.on('paste-from-clipboard', (event) => {
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const buffer = image.toPNG();
    const tempPath = path.join(app.getPath('temp'), `clipboard_${Date.now()}.png`);
    require('fs').writeFileSync(tempPath, buffer);
    event.reply('clipboard-image', tempPath);
  } else {
    event.reply('clipboard-image', null);
  }
});

// Handle copy to clipboard
ipcMain.on('copy-to-clipboard', (event, text) => {
  clipboard.writeText(text);
  event.reply('copied-to-clipboard', true);
});

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (pythonProcess) {
    pythonProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill();
  }
});
