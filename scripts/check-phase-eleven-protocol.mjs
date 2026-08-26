import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSignedTransparencyCheckpoint,
  createTransparencyInclusionProof,
  generatePortableSigningKey,
  LocalTransparencyLog,
} from "../packages/portable-promotion-receipt/dist/index.js";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = path.join(
  projectRoot,
  "packages",
  "portable-promotion-receipt",
);
const cliPath = path.join(packageRoot, "dist", "cli.js");
const vectorPath = path.join(
  packageRoot,
  "vectors",
  "portable-receipt-v1.golden.json",
);
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "airlock-phase-eleven-protocol-"),
);

try {
  const vectorSource = await readFile(vectorPath, "utf8");
  if (/PRIVATE KEY|\/Users\/|\/private\//.test(vectorSource)) {
    throw new Error("Published receipt vector crossed the private-data boundary");
  }
  const vector = JSON.parse(vectorSource);
  const envelopePath = path.join(temporaryRoot, "envelope.json");
  await writeFile(envelopePath, JSON.stringify(vector.envelope) + "\n", {
    mode: 0o600,
  });

  const verified = JSON.parse(
    await capture(process.execPath, [cliPath, "verify", envelopePath, "--json"]),
  );
  if (!verified.valid || verified.receiptDigest !== vector.envelope.receiptDigest) {
    throw new Error("A separate CLI process did not verify the golden receipt");
  }

  const tampered = structuredClone(vector.envelope);
  tampered.receipt.decision.agentId += "-tampered";
  const tamperedPath = path.join(temporaryRoot, "tampered.json");
  await writeFile(tamperedPath, JSON.stringify(tampered) + "\n", { mode: 0o600 });
  const rejected = await captureFailure(process.execPath, [
    cliPath,
    "verify",
    tamperedPath,
    "--json",
  ]);
  const rejectionReport = JSON.parse(rejected.stdout);
  if (rejected.code !== 1 || rejectionReport.valid) {
    throw new Error("A separate CLI process accepted tampered receipt content");
  }

  const evm = JSON.parse(
    await capture(process.execPath, [
      cliPath,
      "evm-payload",
      vector.envelope.receiptDigest,
    ]),
  );
  if (
    evm.functionSelector !== "0xeecdf927" ||
    evm.receiptDigest !== vector.envelope.receiptDigest ||
    evm.networkCalls !== 0 ||
    evm.fundsSpent !== 0
  ) {
    throw new Error("Offline EVM payload did not match the frozen digest-only vector");
  }

  const transparencyKey = generatePortableSigningKey();
  const checkpoint = createSignedTransparencyCheckpoint({
    receiptDigests: [vector.envelope.receiptDigest],
    priorCheckpointDigest: null,
    createdAt: "2026-08-26T00:00:01.000Z",
    privateKey: transparencyKey.privateKeyPem,
  });
  const anchorPath = path.join(temporaryRoot, "anchor.json");
  await writeFile(
    anchorPath,
    JSON.stringify({
      checkpoint,
      inclusionProof: createTransparencyInclusionProof(
        [vector.envelope.receiptDigest],
        0,
      ),
    }) + "\n",
    { mode: 0o600 },
  );
  const anchorReport = JSON.parse(
    await capture(process.execPath, [
      cliPath,
      "verify-anchor",
      envelopePath,
      anchorPath,
      "--json",
    ]),
  );
  if (!anchorReport.valid) {
    throw new Error("A separate CLI process did not verify the optional anchor");
  }

  const concurrentKeyPath = path.join(temporaryRoot, "concurrent-key.pem");
  const concurrentLogPath = path.join(temporaryRoot, "concurrent-log.json");
  await writeFile(concurrentKeyPath, transparencyKey.privateKeyPem, { mode: 0o600 });
  const concurrentLog = new LocalTransparencyLog(
    concurrentLogPath,
    transparencyKey.privateKeyPem,
  );
  await concurrentLog.initialize();
  const appendWorker = [
    "import { readFile } from 'node:fs/promises';",
    "import { LocalTransparencyLog } from '@agent-airlock/portable-promotion-receipt';",
    "const [logPath,keyPath,digest,at]=process.argv.slice(1);",
    "const log=new LocalTransparencyLog(logPath,await readFile(keyPath,'utf8'));",
    "await log.initialize();",
    "await log.append(digest,at);",
  ].join("");
  const [firstAppend, secondAppend] = [
    ["sha256:" + "6".repeat(64), "2026-08-26T00:00:02.000Z"],
    ["sha256:" + "7".repeat(64), "2026-08-26T00:00:03.000Z"],
  ];
  await Promise.all(
    [firstAppend, secondAppend].map(([digest, at]) =>
      capture(process.execPath, [
        "--input-type=module",
        "--eval",
        appendWorker,
        concurrentLogPath,
        concurrentKeyPath,
        digest,
        at,
      ]),
    ),
  );
  const reopenedConcurrentLog = new LocalTransparencyLog(
    concurrentLogPath,
    transparencyKey.privateKeyPem,
  );
  await reopenedConcurrentLog.initialize();
  if (reopenedConcurrentLog.snapshot().entries.length !== 2) {
    throw new Error("Cross-process transparency append lost a receipt digest");
  }

  process.stdout.write(
    "Phase 11 cross-process receipt, tamper, anchor, concurrent log, and offline EVM vectors passed.\n",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function capture(command, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
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
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(command + " failed: " + stderr.trim()));
    });
  });
}

function captureFailure(command, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
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
    child.once("exit", (code) => {
      if (code === 0 || code === null) {
        reject(new Error("Expected the child process to reject the input"));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}
