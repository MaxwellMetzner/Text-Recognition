const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PythonWorker } = require("../src/main/python-worker");

const script = `
const { createInterface } = require("readline");
let count = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, args } = JSON.parse(line);
  if (args[0] === "crash") process.exit(7);
  if (args[0] === "invalid") {
    console.log("invalid JSON");
    return;
  }
  const result = { success: true, pid: process.pid, count: ++count, text: "caf\\u00e9", args };
  const response = Buffer.from(JSON.stringify({ id, result }) + "\\n");
  const split = response.indexOf(Buffer.from("\\u00e9")) + 1;
  process.stdout.write(response.subarray(0, split));
  setTimeout(() => process.stdout.write(response.subarray(split)), 5);
});
`;

function workerFor(t, source = script) {
  const worker = new PythonWorker(process.execPath, ["-e", source]);
  t.after(() => worker.stop());
  return worker;
}

test("reuses the process and decodes split UTF-8 output", async (t) => {
  const worker = workerFor(t);
  const first = await worker.request(["first"]);
  const second = await worker.request(["second"]);
  assert.equal(first.pid, second.pid);
  assert.equal(second.count, 2);
  assert.equal(second.text, "caf\u00e9");
  assert.deepEqual(second.args, ["second"]);
});

test("routes concurrent requests by their ID", async (t) => {
  const worker = workerFor(
    t,
    `require("readline").createInterface({input: process.stdin}).on("line", line => {
      const {id, args} = JSON.parse(line);
      setTimeout(() => console.log(JSON.stringify({id, result: {success: true, args}})),
        args[0] === "first" ? 30 : 0);
    });`,
  );
  const results = await Promise.all([
    worker.request(["first"]),
    worker.request(["second"]),
  ]);
  assert.deepEqual(
    results.map((result) => result.args),
    [["first"], ["second"]],
  );
});

test("rejects all outstanding requests on crash and restarts on demand", async (t) => {
  const worker = workerFor(t);
  const first = await worker.request(["first"]);
  const results = await Promise.allSettled([
    worker.request(["crash"]),
    worker.request(["queued"]),
  ]);
  assert.ok(results.every((result) => result.status === "rejected"));
  const restarted = await worker.request(["restart"]);
  assert.notEqual(restarted.pid, first.pid);
  assert.equal(restarted.count, 1);
});

test("surfaces malformed output and recovers for the next request", async (t) => {
  const worker = workerFor(t);
  await assert.rejects(
    worker.request(["invalid"]),
    /Invalid OCR worker response/,
  );
  assert.equal((await worker.request(["restart"])).success, true);
});

test("reports a missing Python executable", async (t) => {
  const worker = new PythonWorker(
    "text-recognition-missing-executable-for-test",
    [],
  );
  t.after(() => worker.stop());
  await assert.rejects(worker.request([]), /Could not start OCR worker/);
});

test("shutdown rejects pending and future requests", async (t) => {
  const worker = workerFor(t);
  const rejection = assert.rejects(
    worker.request(["pending"]),
    /worker stopped/,
  );
  worker.stop();
  await rejection;
  await assert.rejects(worker.request([]), /worker has been stopped/);
});
