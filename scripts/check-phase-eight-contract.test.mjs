import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(".");
const cli = path.join(
  projectRoot,
  "packages/transactional-resource-sdk/dist/cli.js",
);

test("the conformance CLI separates human and JSON evidence", async () => {
  const result = await execute([
    cli,
    "@agent-airlock/http-object-resource/conformance-fixture",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Transactional Resource conformance: PASSED/);
  assert.match(result.stderr, /\[PASSED\] restart-reconciliation/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.provider.providerId, "http-object");
  assert.equal(report.passed, true);
  assert.equal(report.cases.length, 8);
  assert.equal(report.verification.behaviorallyVerified.length, 8);
  assert.equal(report.cases.every((item) => item.status === "passed"), true);
  assert.doesNotMatch(result.stdout, /\/Users\//);
  assert.doesNotMatch(result.stdout, /\/private\/tmp\//);
  assert.doesNotMatch(result.stdout, /candidateResourcePath/);
});

test("the conformance CLI rejects missing provider modules without a stack trace", async () => {
  const result = await execute([cli]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Expected exactly one provider/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.equal(result.stdout, "");
});

function execute(argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code: signal ? 1 : code, stdout, stderr });
    });
  });
}
