const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function loadMain() {
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  const workers = [];
  class Worker {
    constructor(command, args) {
      this.command = command;
      this.args = args;
      this.calls = [];
      this.result = { success: true, text: "Recognized text" };
      workers.push(this);
    }
    async request(args) {
      this.calls.push(args);
      if (this.error) throw this.error;
      return this.result;
    }
    stop() {
      this.stopped = true;
    }
  }
  const directory = path.join(__dirname, "..", "src", "main");
  const context = vm.createContext({
    require: (name) => {
      if (name === "electron") return { app, ipcMain };
      if (name === "./python-worker") return { PythonWorker: Worker };
      return require(name);
    },
    __dirname: directory,
    process,
    console: { log() {}, error() {} },
  });
  vm.runInContext(
    fs.readFileSync(path.join(directory, "main.js"), "utf8"),
    context,
  );
  vm.runInContext(
    `const discoverPython = getPythonCommand;
     getPythonCommand = () => ({command: "test-python", args: [], ocrReady: true})`,
    context,
  );
  return { app, ipcMain, workers, context };
}

function eventFor(replies, destroyed = false) {
  return {
    sender: { isDestroyed: () => destroyed },
    reply: (channel, result) => replies.push({ channel, result }),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("scan IPC reuses one worker and preserves request IDs and options", async () => {
  const main = loadMain();
  const replies = [];
  for (const requestId of [1, 2]) {
    main.ipcMain.emit("process-paths", eventFor(replies), {
      paths: ["sample.png"],
      options: {
        ocrMode: "best",
        region: { x: 10, y: 20, width: 30, height: 40 },
      },
      requestId,
    });
  }
  await settle();
  assert.equal(main.workers.length, 1);
  const worker = main.workers[0];
  assert.equal(worker.args.at(-1), "--worker");
  assert.equal(worker.calls.length, 2);
  assert.equal(JSON.parse(worker.calls[0][1]).ocrMode, "best");
  assert.deepEqual(JSON.parse(worker.calls[0][1]).paths, ["sample.png"]);
  assert.equal(JSON.parse(worker.calls[0][1]).region.width, 30);
  assert.deepEqual(
    replies.map((reply) => reply.result.requestId),
    [1, 2],
  );
  assert.ok(replies.every((reply) => reply.channel === "ocr-result"));
  main.app.emit("before-quit");
  assert.equal(worker.stopped, true);
});

test("worker errors reach the renderer and destroyed windows are ignored", async () => {
  const main = loadMain();
  const replies = [];
  main.ipcMain.emit("process-image", eventFor(replies), {
    imagePath: "sample.png",
    requestId: 1,
  });
  await settle();
  main.workers[0].error = new Error("Worker crashed");
  main.ipcMain.emit("process-image", eventFor(replies), {
    imagePath: "sample.png",
    requestId: 2,
  });
  main.ipcMain.emit("process-image", eventFor(replies, true), {
    imagePath: "sample.png",
    requestId: 3,
  });
  await settle();
  assert.equal(replies.length, 2);
  assert.equal(replies[1].result.success, false);
  assert.equal(replies[1].result.error, "Worker crashed");
  assert.equal(replies[1].result.requestId, 2);
});

test("Python discovery stops after the first OCR-ready runtime", () => {
  const main = loadMain();
  const calls = vm.runInContext(
    `
    const probes = [];
    buildPythonCandidates = () => [
      {command: "ready", args: []}, {command: "unused", args: []}
    ];
    isRunnablePython = command => { probes.push(command); return true; };
    hasCoreOcrPackages = () => true;
    discoverPython();
    discoverPython();
    probes;
  `,
    main.context,
  );
  assert.deepEqual(Array.from(calls), ["ready"]);
});
