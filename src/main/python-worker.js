const { spawn } = require("child_process");
const { createInterface } = require("readline");

class PythonWorker {
  constructor(command, args) {
    this.command = command;
    this.args = args;
    this.process = null;
    this.pending = new Map();
    this.nextId = 0;
    this.stopped = false;
  }

  start() {
    const child = spawn(this.command, this.args, {
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      windowsHide: true,
    });
    this.process = child;
    let errorOutput = "";
    const lines = createInterface({ input: child.stdout });
    const fail = (error) => {
      if (this.process !== child) {
        return;
      }
      this.process = null;
      for (const { reject } of this.pending.values()) {
        reject(error);
      }
      this.pending.clear();
      lines.close();
      child.kill();
    };

    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line);
        const request = this.pending.get(response.id);
        if (!request || typeof response.result?.success !== "boolean") {
          throw new Error("Unexpected OCR worker response");
        }
        this.pending.delete(response.id);
        request.resolve(response.result);
      } catch (error) {
        fail(new Error(`Invalid OCR worker response: ${error.message}`));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      errorOutput = (errorOutput + data).slice(-16384);
      console.error("Python:", data.trimEnd());
    });
    child.on("error", (error) => {
      fail(new Error(`Could not start OCR worker: ${error.message}`));
    });
    child.stdin.on("error", (error) => {
      fail(new Error(`Could not send OCR request: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      fail(
        new Error(
          `OCR worker exited (${signal || code}). ${errorOutput.trim()}`.trim(),
        ),
      );
    });
  }

  request(args) {
    if (this.stopped) {
      return Promise.reject(new Error("OCR worker has been stopped"));
    }
    if (!this.process) {
      this.start();
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${JSON.stringify({ id, args })}\n`);
    });
  }

  stop() {
    this.stopped = true;
    const child = this.process;
    this.process = null;
    for (const { reject } of this.pending.values()) {
      reject(new Error("OCR worker stopped"));
    }
    this.pending.clear();
    if (child) {
      child.kill();
    }
  }
}

module.exports = { PythonWorker };
