const { spawn } = require("child_process");
const path = require("path");

const electronPath = require("electron");
const projectRoot = path.join(__dirname, "..");
const { ELECTRON_RUN_AS_NODE, ...env } = process.env;

const child = spawn(electronPath, [projectRoot, ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error(`Failed to start Electron: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
