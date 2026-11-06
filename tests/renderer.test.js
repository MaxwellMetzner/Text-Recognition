const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function loadRenderer() {
  const elements = new Map();
  const listeners = new Map();
  const sent = [];
  const makeElement = () => ({
    style: {},
    dataset: {},
    options: [],
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    removeAttribute() {},
    setAttribute() {},
  });
  const context = vm.createContext({
    require: (name) =>
      name === "electron"
        ? {
            ipcRenderer: {
              on: (channel, handler) => listeners.set(channel, handler),
              send: (...args) => sent.push(args),
            },
          }
        : require(name),
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: makeElement,
    },
    window: { addEventListener() {} },
    localStorage: { getItem: () => null },
    console,
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "..", "src", "renderer", "renderer.js"),
      "utf8",
    ),
    context,
  );
  return {
    elements,
    sent,
    reply: (result) => listeners.get("ocr-result")({}, result),
    run: (code) => vm.runInContext(code, context),
  };
}

test("duplicate scan clicks do not enqueue redundant scans", () => {
  const renderer = loadRenderer();
  renderer.run(
    'handlePaths(["sample.png"]); scanCurrentImage(); scanCurrentImage()',
  );
  assert.equal(renderer.sent.length, 1);
  assert.equal(renderer.elements.get("scanImageBtn").disabled, true);
  const requestId = renderer.sent[0][1].requestId;
  renderer.reply({ requestId, success: true, text: "Recognized text" });
  assert.equal(renderer.elements.get("scanImageBtn").disabled, false);
  assert.equal(renderer.run("state.extractedText"), "Recognized text");
});

test("old results cannot replace a newly selected image's results", () => {
  const renderer = loadRenderer();
  renderer.run('handlePaths(["first.png"]); scanCurrentImage()');
  const oldId = renderer.sent[0][1].requestId;
  renderer.run('handlePaths(["second.png"]); scanCurrentImage()');
  const newId = renderer.sent[1][1].requestId;
  renderer.reply({ requestId: oldId, success: true, text: "Old text" });
  assert.equal(renderer.run("state.extractedText"), "");
  assert.equal(renderer.run("state.scanning"), true);
  renderer.reply({ requestId: newId, success: true, text: "New text" });
  assert.equal(renderer.run("state.extractedText"), "New text");
});

test("clearing input invalidates pending results and scan errors restore controls", () => {
  const renderer = loadRenderer();
  renderer.run('handlePaths(["first.png"]); scanCurrentImage(); resetUI()');
  const requestId = renderer.sent[0][1].requestId;
  renderer.reply({ requestId, success: true, text: "Old text" });
  assert.equal(renderer.run("state.extractedText"), "");
  renderer.run('handlePaths(["second.png"]); scanCurrentImage()');
  renderer.reply({
    requestId: renderer.sent[1][1].requestId,
    success: false,
    error: "Scan failed",
  });
  assert.equal(renderer.run("state.scanning"), false);
  assert.equal(renderer.elements.get("scanImageBtn").disabled, false);
});
