const {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  dialog,
  shell,
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

let mainWindow;
let cachedPythonCommand;

function getPythonCommand() {
  if (cachedPythonCommand) {
    return cachedPythonCommand;
  }

  const candidates = buildPythonCandidates();
  const runnableCandidates = candidates.filter((candidate) =>
    isRunnablePython(candidate.command, candidate.args),
  );
  const ocrReadyCandidate = runnableCandidates.find((candidate) =>
    hasCoreOcrPackages(candidate.command, candidate.args),
  );

  cachedPythonCommand =
    ocrReadyCandidate ||
    runnableCandidates[0] ||
    candidates[candidates.length - 1];

  cachedPythonCommand.ocrReady = Boolean(ocrReadyCandidate);
  if (!cachedPythonCommand.ocrReady) {
    cachedPythonCommand.packageError =
      "No Python runtime with the required OCR packages was found.";
  }

  console.log(
    "Using Python:",
    cachedPythonCommand.command,
    cachedPythonCommand.args.join(" "),
    cachedPythonCommand.ocrReady
      ? "(OCR packages ready)"
      : "(OCR packages missing)",
  );

  return cachedPythonCommand;
}

function buildPythonCandidates() {
  const candidates = [];
  const roots = getCandidateRoots();
  const venvRelativePath =
    process.platform === "win32"
      ? [".venv", "Scripts", "python.exe"]
      : [".venv", "bin", "python"];
  const envPython =
    process.env.TEXT_RECOGNITION_PYTHON || process.env.OCR_PYTHON || "";

  if (envPython) {
    candidates.push({ command: envPython, args: [] });
  }

  for (const root of roots) {
    candidates.push({
      command: path.join(root, ...venvRelativePath),
      args: [],
    });
  }

  if (process.platform === "win32") {
    candidates.push({ command: "py", args: ["-3.11"] });
    candidates.push({ command: "py", args: ["-3"] });
    candidates.push({ command: "python", args: [] });
  } else {
    candidates.push({ command: "python3", args: [] });
    candidates.push({ command: "python", args: [] });
  }

  return dedupePythonCandidates(candidates);
}

function getCandidateRoots() {
  const starts = [
    path.join(__dirname, "..", ".."),
    ...getPortableExecutableRoots(),
    getAppPathSafely(),
    process.resourcesPath,
    process.execPath ? path.dirname(process.execPath) : "",
    process.cwd(),
  ].filter(Boolean);
  const roots = [];
  const seen = new Set();

  for (const start of starts) {
    let current = resolveDirectory(start);
    while (current && !seen.has(current)) {
      seen.add(current);
      roots.push(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return roots;
}

function getPortableExecutableRoots() {
  const roots = [];
  const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const portableExecutableFile = process.env.PORTABLE_EXECUTABLE_FILE;

  if (portableExecutableDir) {
    roots.push(portableExecutableDir);
  }

  if (portableExecutableFile) {
    roots.push(path.dirname(portableExecutableFile));
  }

  return roots;
}

function getAppPathSafely() {
  try {
    return app.getAppPath();
  } catch (error) {
    return "";
  }
}

function resolveDirectory(candidatePath) {
  if (!candidatePath) {
    return "";
  }

  const resolved = path.resolve(candidatePath);
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return path.dirname(resolved);
    }
  } catch (error) {
    return path.dirname(resolved);
  }

  return resolved;
}

function dedupePythonCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\0${candidate.args.join("\0")}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isPathLikeCommand(command) {
  return (
    path.isAbsolute(command) ||
    command.includes(path.sep) ||
    command.includes("/") ||
    command.includes("\\")
  );
}

function isRunnablePython(command, args = []) {
  if (isPathLikeCommand(command) && !fs.existsSync(command)) {
    return false;
  }

  try {
    const result = spawnSync(
      command,
      [...args, "-c", 'print("copilot-python-check")'],
      {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      },
    );
    return (
      result.status === 0 && result.stdout.includes("copilot-python-check")
    );
  } catch (error) {
    return false;
  }
}

function hasCoreOcrPackages(command, args = []) {
  if (isPathLikeCommand(command) && !fs.existsSync(command)) {
    return false;
  }

  try {
    const script = [
      "import importlib.util",
      "missing = [name for name in ('PIL', 'cv2', 'pytesseract') if importlib.util.find_spec(name) is None]",
      "print('ocr-core-check:' + ('ok' if not missing else ','.join(missing)))",
      "raise SystemExit(1 if missing else 0)",
    ].join("; ");
    const result = spawnSync(command, [...args, "-c", script], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    return result.status === 0 && result.stdout.includes("ocr-core-check:ok");
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
    error:
      errorString.trim() || `Scan processing failed with exit code ${code}`,
    success: false,
  });
}

function runPythonJson(event, args, replyChannel) {
  const pythonCommand = getPythonCommand();
  const isDoctor = args[0] === "--doctor";
  if (!isDoctor && !pythonCommand.ocrReady) {
    event.reply(replyChannel, {
      error: `${pythonCommand.packageError} Start the app from the project launcher or install requirements.txt into the project .venv.`,
      success: false,
    });
    return;
  }

  const scriptPath = path.join(__dirname, "..", "python", "ocr_engine.py");
  const pythonProcess = spawn(
    pythonCommand.command,
    [...pythonCommand.args, scriptPath, ...args],
    {
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      windowsHide: true,
    },
  );

  let dataString = "";
  let errorString = "";

  pythonProcess.stdout.on("data", (data) => {
    dataString += data.toString();
  });

  pythonProcess.stderr.on("data", (data) => {
    errorString += data.toString();
    console.error("Python Error:", data.toString());
  });

  pythonProcess.on("close", (code) => {
    replyWithScanResult(event, replyChannel, dataString, errorString, code);
  });
}

function sanitizeFileName(fileName) {
  return (
    String(fileName || "text-recognition-output")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, " ")
      .trim() || "text-recognition-output"
  );
}

function normalizeExtension(extension) {
  if (typeof extension !== "string") {
    return ".txt";
  }

  const trimmed = extension.trim();
  if (!trimmed) {
    return ".txt";
  }

  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function appendDefaultExtension(filePath, extension) {
  if (path.extname(filePath)) {
    return filePath;
  }

  return `${filePath}${extension}`;
}

function getUniqueFilePath(directoryPath, suggestedName, extension) {
  const baseName = sanitizeFileName(suggestedName || "export");
  let candidatePath = path.join(
    directoryPath,
    appendDefaultExtension(baseName, extension),
  );
  let index = 2;

  while (fs.existsSync(candidatePath)) {
    candidatePath = path.join(
      directoryPath,
      `${baseName}-${index}${extension}`,
    );
    index += 1;
  }

  return candidatePath;
}

function getUniqueDirectoryPath(parentPath, suggestedName) {
  const baseName = sanitizeFileName(suggestedName || "text-recognition-export");
  let candidatePath = path.join(parentPath, baseName);
  let index = 2;

  while (fs.existsSync(candidatePath)) {
    candidatePath = path.join(parentPath, `${baseName}-${index}`);
    index += 1;
  }

  return candidatePath;
}

function escapePowerShellString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function writeBundleEntriesToDirectory(directoryPath, entries) {
  const savedFiles = [];
  for (const entry of entries) {
    const extension = normalizeExtension(entry.extension);
    const filePath = getUniqueFilePath(
      directoryPath,
      entry.suggestedName,
      extension,
    );
    fs.writeFileSync(filePath, entry.content, "utf8");
    savedFiles.push(filePath);
  }
  return savedFiles;
}

function createZipArchive(sourceDirectory, destinationZipPath) {
  if (process.platform !== "win32") {
    throw new Error(
      "ZIP export is currently available on Windows only in this build.",
    );
  }

  const command = [
    `$source = ${escapePowerShellString(sourceDirectory)}`,
    `$destination = ${escapePowerShellString(destinationZipPath)}`,
    "if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }",
    "Compress-Archive -Path $source -DestinationPath $destination -CompressionLevel Optimal",
  ].join("; ");

  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `Compress-Archive failed with exit code ${result.status}`,
    );
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
    icon: path.join(__dirname, "..", "..", "assets", "icon.png"),
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Open DevTools in development
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function runScan(event, payload, replyChannel = "ocr-result") {
  const incoming =
    typeof payload === "string" ? { imagePath: payload } : payload || {};
  const paths = Array.isArray(incoming.paths)
    ? incoming.paths.filter(Boolean)
    : [incoming.imagePath].filter(Boolean);
  const imagePath = incoming.imagePath || paths[0];
  const options =
    typeof incoming === "object" && incoming !== null
      ? incoming.options || {}
      : {};

  if (!imagePath) {
    event.reply(replyChannel, {
      error: "No image, PDF, or folder path provided for processing",
      success: false,
    });
    return;
  }

  const scanOptions = {
    ...options,
    paths: paths.length ? paths : options.paths,
  };

  console.log("Processing scan:", imagePath, scanOptions);

  runPythonJson(event, [imagePath, JSON.stringify(scanOptions)], replyChannel);
}

// Handle OCR processing
ipcMain.on("process-image", (event, payload) => {
  runScan(event, payload, "ocr-result");
});

ipcMain.on("process-paths", (event, payload) => {
  runScan(event, payload, "ocr-result");
});

ipcMain.on("check-environment", (event) => {
  runPythonJson(event, ["--doctor"], "environment-result");
});

ipcMain.on("save-output", async (event, payload) => {
  const content = typeof payload?.content === "string" ? payload.content : "";
  if (!content.trim()) {
    event.reply("save-output-result", {
      error: "Nothing to export yet",
      success: false,
    });
    return;
  }

  const extension = normalizeExtension(payload?.extension);
  const suggestedName = sanitizeFileName(payload?.suggestedName);
  const defaultPath = path.join(
    app.getPath("documents"),
    `${suggestedName}${extension}`,
  );

  try {
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath,
      filters: [
        {
          name: payload?.label || "Export File",
          extensions: [extension.slice(1)],
        },
        {
          name: "All Files",
          extensions: ["*"],
        },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      event.reply("save-output-result", {
        canceled: true,
        success: false,
      });
      return;
    }

    const filePath = appendDefaultExtension(saveResult.filePath, extension);
    fs.writeFileSync(filePath, content, "utf8");
    event.reply("save-output-result", {
      filePath,
      success: true,
    });
  } catch (error) {
    event.reply("save-output-result", {
      error: `Failed to save export: ${error.message}`,
      success: false,
    });
  }
});

ipcMain.on("export-output-bundle", async (event, payload) => {
  const rawEntries = Array.isArray(payload?.entries) ? payload.entries : [];
  const entries = rawEntries.filter(
    (entry) => typeof entry?.content === "string" && entry.content.trim(),
  );

  if (!entries.length) {
    event.reply("export-output-bundle-result", {
      error: "Nothing to export yet",
      success: false,
    });
    return;
  }

  try {
    const folderResult = await dialog.showOpenDialog(mainWindow, {
      defaultPath: app.getPath("documents"),
      properties: ["openDirectory", "createDirectory"],
    });

    if (folderResult.canceled || !folderResult.filePaths?.length) {
      event.reply("export-output-bundle-result", {
        canceled: true,
        success: false,
      });
      return;
    }

    const parentDirectory = folderResult.filePaths[0];
    const exportDirectory = getUniqueDirectoryPath(
      parentDirectory,
      payload?.suggestedFolderName,
    );
    fs.mkdirSync(exportDirectory, { recursive: true });

    const savedFiles = writeBundleEntriesToDirectory(exportDirectory, entries);

    event.reply("export-output-bundle-result", {
      dirPath: exportDirectory,
      fileCount: savedFiles.length,
      files: savedFiles,
      success: true,
    });
  } catch (error) {
    event.reply("export-output-bundle-result", {
      error: `Failed to export files: ${error.message}`,
      success: false,
    });
  }
});

ipcMain.on("export-output-zip", async (event, payload) => {
  const rawEntries = Array.isArray(payload?.entries) ? payload.entries : [];
  const entries = rawEntries.filter(
    (entry) => typeof entry?.content === "string" && entry.content.trim(),
  );

  if (!entries.length) {
    event.reply("export-output-zip-result", {
      error: "Nothing to export yet",
      success: false,
    });
    return;
  }

  const zipName = `${sanitizeFileName(payload?.suggestedFileName || "text-recognition-export")}.zip`;
  const defaultPath = path.join(app.getPath("documents"), zipName);
  let tempDirectory = null;

  try {
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath,
      filters: [
        {
          name: "ZIP Archive",
          extensions: ["zip"],
        },
        {
          name: "All Files",
          extensions: ["*"],
        },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      event.reply("export-output-zip-result", {
        canceled: true,
        success: false,
      });
      return;
    }

    const destinationZipPath = appendDefaultExtension(
      saveResult.filePath,
      ".zip",
    );
    tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "text-recognition-export-"),
    );
    const bundleDirectory = path.join(
      tempDirectory,
      sanitizeFileName(payload?.suggestedFileName || "text-recognition-export"),
    );
    fs.mkdirSync(bundleDirectory, { recursive: true });
    const savedFiles = writeBundleEntriesToDirectory(bundleDirectory, entries);
    createZipArchive(bundleDirectory, destinationZipPath);

    event.reply("export-output-zip-result", {
      fileCount: savedFiles.length,
      filePath: destinationZipPath,
      success: true,
    });
  } catch (error) {
    event.reply("export-output-zip-result", {
      error: `Failed to create ZIP export: ${error.message}`,
      success: false,
    });
  } finally {
    if (tempDirectory) {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  }
});

ipcMain.on("reveal-path", async (event, payload) => {
  const targetPath = typeof payload === "string" ? payload : payload?.path;

  if (!targetPath) {
    event.reply("reveal-path-result", {
      error: "No path was provided",
      success: false,
    });
    return;
  }

  if (!fs.existsSync(targetPath)) {
    event.reply("reveal-path-result", {
      error: `Path not found: ${targetPath}`,
      success: false,
    });
    return;
  }

  try {
    const stats = fs.statSync(targetPath);
    if (stats.isDirectory()) {
      const openError = await shell.openPath(targetPath);
      if (openError) {
        throw new Error(openError);
      }
    } else {
      shell.showItemInFolder(targetPath);
    }

    event.reply("reveal-path-result", {
      path: targetPath,
      success: true,
    });
  } catch (error) {
    event.reply("reveal-path-result", {
      error: `Failed to reveal path: ${error.message}`,
      success: false,
    });
  }
});

// Handle clipboard paste
ipcMain.on("paste-from-clipboard", (event) => {
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const buffer = image.toPNG();
    const tempPath = path.join(
      app.getPath("temp"),
      `clipboard_${Date.now()}.png`,
    );
    fs.writeFileSync(tempPath, buffer);
    event.reply("clipboard-image", tempPath);
  } else {
    event.reply("clipboard-image", null);
  }
});

ipcMain.on("save-camera-capture", (event, dataUrl) => {
  if (!dataUrl || typeof dataUrl !== "string") {
    event.reply("camera-capture-saved", null);
    return;
  }

  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) {
    event.reply("camera-capture-saved", null);
    return;
  }

  const tempPath = path.join(
    app.getPath("temp"),
    `camera_capture_${Date.now()}.png`,
  );
  fs.writeFileSync(tempPath, Buffer.from(match[1], "base64"));
  event.reply("camera-capture-saved", tempPath);
});

// Handle copy to clipboard
ipcMain.on("copy-to-clipboard", (event, text) => {
  clipboard.writeText(text);
  event.reply("copied-to-clipboard", true);
});

app.on("ready", createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on("before-quit", () => {});
