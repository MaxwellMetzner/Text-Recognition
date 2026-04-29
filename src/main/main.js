const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let mainWindow;
let pythonProcess = null;

function getPythonCommand() {
  const projectRoot = path.join(__dirname, '..', '..');
  const candidates = process.platform === 'win32'
    ? [
        { command: path.join(projectRoot, '.venv', 'Scripts', 'python.exe'), args: [] },
        { command: 'py', args: ['-3'] },
        { command: 'python', args: [] },
      ]
    : [
        { command: path.join(projectRoot, '.venv', 'bin', 'python'), args: [] },
        { command: 'python3', args: [] },
        { command: 'python', args: [] },
      ];

  return candidates.find((candidate) => isRunnablePython(candidate.command, candidate.args)) || candidates[candidates.length - 1];
}

function isRunnablePython(command, args = []) {
  if (command.includes(path.sep) && !fs.existsSync(command)) {
    return false;
  }

  try {
    const result = spawnSync(command, [...args, '-c', 'print("copilot-python-check")'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    return result.status === 0 && result.stdout.includes('copilot-python-check');
  } catch (error) {
    return false;
  }
}

function replyWithScanResult(event, channel, dataString, errorString, code) {
  const trimmedOutput = dataString.trim();

  if (trimmedOutput) {
    try {
      const result = JSON.parse(trimmedOutput);
      event.reply(channel, {
        ...result,
        success: Boolean(result.success),
      });
      return;
    } catch (error) {
      event.reply(channel, {
        error: `Failed to parse scan result: ${error.message}`,
        success: false,
      });
      return;
    }
  }

  event.reply(channel, {
    error: errorString.trim() || `Scan processing failed with exit code ${code}`,
    success: false,
  });
}

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

function runScan(event, payload, replyChannel = 'ocr-result') {
  const incoming = typeof payload === 'string' ? { imagePath: payload } : payload || {};
  const paths = Array.isArray(incoming.paths)
    ? incoming.paths.filter(Boolean)
    : [incoming.imagePath].filter(Boolean);
  const imagePath = incoming.imagePath || paths[0];
  const options = typeof incoming === 'object' && incoming !== null ? incoming.options || {} : {};

  if (!imagePath) {
    event.reply(replyChannel, {
      error: 'No image, PDF, or folder path provided for processing',
      success: false,
    });
    return;
  }

  const scanOptions = {
    ...options,
    paths: paths.length ? paths : options.paths,
  };

  console.log('Processing scan:', imagePath, scanOptions);

  const pythonCommand = getPythonCommand();
  const scriptPath = path.join(__dirname, '..', 'python', 'ocr_engine.py');

  pythonProcess = spawn(
    pythonCommand.command,
    [...pythonCommand.args, scriptPath, imagePath, JSON.stringify(scanOptions)],
    { windowsHide: true },
  );
  
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
    replyWithScanResult(event, replyChannel, dataString, errorString, code);
    pythonProcess = null;
  });
}

// Handle OCR processing
ipcMain.on('process-image', (event, payload) => {
  runScan(event, payload, 'ocr-result');
});

ipcMain.on('process-paths', (event, payload) => {
  runScan(event, payload, 'ocr-result');
});

// Handle clipboard paste
ipcMain.on('paste-from-clipboard', (event) => {
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const buffer = image.toPNG();
    const tempPath = path.join(app.getPath('temp'), `clipboard_${Date.now()}.png`);
    fs.writeFileSync(tempPath, buffer);
    event.reply('clipboard-image', tempPath);
  } else {
    event.reply('clipboard-image', null);
  }
});

ipcMain.on('save-camera-capture', (event, dataUrl) => {
  if (!dataUrl || typeof dataUrl !== 'string') {
    event.reply('camera-capture-saved', null);
    return;
  }

  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) {
    event.reply('camera-capture-saved', null);
    return;
  }

  const tempPath = path.join(app.getPath('temp'), `camera_capture_${Date.now()}.png`);
  fs.writeFileSync(tempPath, Buffer.from(match[1], 'base64'));
  event.reply('camera-capture-saved', tempPath);
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
