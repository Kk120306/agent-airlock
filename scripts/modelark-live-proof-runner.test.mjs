import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LIVE_MODELARK_PROOF_RESULT_NAME,
  LiveModelArkProofError,
  assertSafeLiveModelArkProofResult,
  buildLiveModelArkProofResult,
  classifyLiveModelArkLauncherFailure,
  resolveLiveModelArkProofExitCode,
  runLiveModelArkProofSession,
  safeLiveModelArkFailure,
  writeLiveModelArkProofResult,
} from "./modelark-live-proof-runner.mjs";
import { liveModelArkEvidenceDirectoryName } from "./modelark-conformance-evidence.mjs";
import {
  liveModelArkContract,
  liveModelArkPrompt,
} from "./modelark-demo-profile.mjs";

const receiptDigest = "sha256:" + "c".repeat(64);
const commitment = (value) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");

function passedValidation(name, required = true) {
  return {
    name,
    required,
    status: "passed",
    summary: name + " passed.",
    durationMs: 1,
    output: null,
  };
}

function completeRun(overrides = {}) {
  const checkedAt = new Date().toISOString();
  const completedAt = new Date(Date.parse(checkedAt) + 1_000).toISOString();
  const rows = [
    {
      id: "demo",
      value: "modelark-live",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  ];
  const sqliteContentHash = commitment(JSON.stringify(rows));
  const normalizedPayload = JSON.stringify({
    destination: "demo-console",
    subject: "ModelArk release ready",
    body: "The live Whole-Agent Candidate passed.",
  });
  const idempotencyKey = commitment(
    [
      "run-live-modelark-proof",
      "modelark-live-ready",
      "demo.notification.requested",
      normalizedPayload,
    ].join("\0"),
  );
  const externalActionsFingerprint = commitment(
    JSON.stringify([{ idempotencyKey, deliveredAt: completedAt }]),
  );
  return {
    id: "run-live-modelark-proof",
    agentId: "agent-live-modelark",
    candidateSetId: null,
    competitorId: null,
    status: "completed",
    prompt: liveModelArkPrompt,
    createdAt: checkedAt,
    completedAt,
    transaction: {
      id: "run-live-modelark-proof",
      assuranceEvidenceVersion: 1,
      status: "promoted",
      disposition: "promoted",
      candidateStateId: "candidate-live-modelark-proof",
      canonicalStateIdBefore: "state-before",
      canonicalStateIdAfter: "state-after",
      canonicalContentHashBefore: "sha256:" + "1".repeat(64),
      canonicalContentHashAfter: "sha256:" + "2".repeat(64),
      outcomeContractVersion: 2,
      outcomeContract: {
        schemaVersion: 1,
        version: 2,
        ...structuredClone(liveModelArkContract),
        createdAt: checkedAt,
      },
      quarantinePath: null,
      quarantineAvailable: false,
      discardedAt: null,
      providerResources: [],
      providerResourceEvents: [],
      recovery: {
        journalPhase: "completed",
        recoveryError: null,
      },
      promotionReceipt: {
        runTransactionId: "run-live-modelark-proof",
        disposition: "promoted",
        outcomeContractVersion: 2,
        canonicalStateIdBefore: "state-before",
        canonicalStateIdAfter: "state-after",
        canonicalContentHashBefore: "sha256:" + "1".repeat(64),
        canonicalContentHashAfter: "sha256:" + "2".repeat(64),
        validationEvidenceHash: "sha256:" + "3".repeat(64),
      },
      validations: [
        {
          name: "execution-profile",
          required: true,
          status: "passed",
          summary:
            "A fresh provider preflight generated assistant output. Airlock control plane attested real Codex CLI against the configured ModelArk Responses profile.",
          output: JSON.stringify({
            schemaVersion: 2,
            attestation: "airlock-control-plane",
            inferenceMode: "modelark",
            executor: "codex-cli",
            runtimeProvider: "container",
            providerProtocol: "responses",
            modelCommitment: "sha256:" + "a".repeat(64),
            preflight: {
              checkedAt,
              generatedAssistantOutput: true,
              endpointOriginCommitment: "sha256:" + "b".repeat(64),
              attemptCount: 1,
              requestCount: 1,
              retryDelayMs: 0,
            },
          }),
          durationMs: 0,
        },
        passedValidation("path-safety"),
        passedValidation("protected-paths"),
        passedValidation("required-paths"),
        passedValidation("change-limits"),
        passedValidation("secret-patterns"),
        passedValidation("assurance-catalog-rule:private-key-block:v1", false),
        passedValidation("command:modelark-live-state"),
        passedValidation("sqlite-resource"),
        passedValidation("external-action-intents"),
      ],
      resources: [
        ["workspace", "Workspace", "4", "5"],
        ["codex-session", "Agent memory", "6", "7"],
        ["sqlite", "SQLite data", "8", null],
        ["external-actions", "External actions", "9", null],
      ].map(([kind, label, before, after]) => ({
        kind,
        label,
        disposition: "promoted",
        fingerprintBefore: "sha256:" + before.repeat(64),
        fingerprintAfter:
          kind === "sqlite"
            ? sqliteContentHash
            : kind === "external-actions"
              ? externalActionsFingerprint
              : "sha256:" + after.repeat(64),
      })),
      sqlite: {
        databasePath: ".airlock/demo.sqlite",
        integrity: "passed",
        candidate: { contentHash: sqliteContentHash, rowCount: 1, rows },
        after: { contentHash: sqliteContentHash, rowCount: 1, rows },
      },
      externalActions: {
        outboxPath: "Candidate State/outbox/intents.jsonl",
        deliveredCount: 1,
        intents: [
          {
            id: "modelark-live-ready",
            type: "demo.notification.requested",
            destination: "demo-console",
            subject: "ModelArk release ready",
            idempotencyKey,
            status: "delivered",
            deliveredAt: completedAt,
          },
        ],
      },
    },
    ...overrides,
  };
}

function browserFixture(events) {
  return {
    async invokeLiveCandidate() {
      events.push("invoked");
    },
    async assertBoundVerdict(runId) {
      assert.equal(runId, "run-live-modelark-proof");
      events.push("verdict");
    },
    async close() {
      events.push("closed");
    },
  };
}

function fetchFixture(runsAfterInvocation) {
  let runRequests = 0;
  return async (url) => {
    if (url.endsWith("/api/agents")) {
      return Response.json({
        agents: [{ id: "agent-live-modelark", name: "Live ModelArk Proof" }],
      });
    }
    if (url.endsWith("/api/agents/agent-live-modelark/runs")) {
      runRequests += 1;
      return Response.json({
        runs: runRequests === 1 ? [] : runsAfterInvocation,
      });
    }
    return new Response(null, { status: 404 });
  };
}

test("drives one browser Run and writes an owner-only verified result", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-live-proof-"));
  const events = [];
  try {
    const result = await runLiveModelArkProofSession({
      baseUrl: "http://127.0.0.1:3201",
      stateRoot,
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([completeRun()]),
      observedAt: () => "2026-08-28T09:30:00.000Z",
      verifyEvidence: async ({ packetFile }) => {
        assert.equal(
          packetFile,
          "modelark-live-run-live-modelark-proof.packet.json",
        );
        return {
          valid: true,
          runId: "run-live-modelark-proof",
          receiptDigest,
          packetFile,
        };
      },
    });

    assert.equal(result.outcome, "passed");
    assert.equal(result.receiptDigest, receiptDigest);
    assert.equal(
      result.packetFile,
      "modelark-live-run-live-modelark-proof.packet.json",
    );
    assert.deepEqual(events, ["invoked", "verdict", "closed"]);
    const resultPath = path.join(
      stateRoot,
      liveModelArkEvidenceDirectoryName,
      LIVE_MODELARK_PROOF_RESULT_NAME,
    );
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), result);
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(
      await readFile(resultPath, "utf8"),
      /Bearer|ARK_API_KEY|https?:\/\/|\bep-|\bark-/i,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("fails closed when the browser-created Run is quarantined", async () => {
  const events = [];
  const quarantined = completeRun({
    status: "completed",
    transaction: {
      ...completeRun().transaction,
      status: "quarantined",
      disposition: "quarantined",
    },
  });
  await assert.rejects(
    runLiveModelArkProofSession({
      baseUrl: "http://127.0.0.1:3201",
      stateRoot: "/bounded-test-root",
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([quarantined]),
    }),
    (error) =>
      error instanceof LiveModelArkProofError &&
      error.failureClass === "run-quarantined",
  );
  assert.deepEqual(events, ["invoked", "closed"]);
});

test("bounds a Run that never reaches a terminal decision", async () => {
  let clock = 0;
  const events = [];
  await assert.rejects(
    runLiveModelArkProofSession({
      baseUrl: "http://127.0.0.1:3201",
      stateRoot: "/bounded-test-root",
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([]),
      now: () => clock,
      runTimeoutMs: 2,
      pollIntervalMs: 1,
      waitImpl: async (milliseconds) => {
        clock += milliseconds;
      },
    }),
    (error) =>
      error instanceof LiveModelArkProofError &&
      error.failureClass === "run-timeout",
  );
  assert.deepEqual(events, ["invoked", "closed"]);
});

test("rejects a captured packet that fails offline verification", async () => {
  const events = [];
  await assert.rejects(
    runLiveModelArkProofSession({
      baseUrl: "http://127.0.0.1:3201",
      stateRoot: "/bounded-test-root",
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([completeRun()]),
      verifyEvidence: async () => ({
        valid: false,
        runId: "run-live-modelark-proof",
        receiptDigest,
      }),
    }),
    (error) =>
      error instanceof LiveModelArkProofError &&
      error.failureClass === "evidence-invalid",
  );
  assert.deepEqual(events, ["invoked", "verdict", "closed"]);
});

test("rejects a packet whose exact filename contains another Run", async () => {
  const events = [];
  await assert.rejects(
    runLiveModelArkProofSession({
      baseUrl: "http://127.0.0.1:3201",
      stateRoot: "/bounded-test-root",
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([completeRun()]),
      verifyEvidence: async () => ({
        valid: true,
        runId: "run-other-modelark-proof",
        receiptDigest,
      }),
    }),
    (error) =>
      error instanceof LiveModelArkProofError &&
      error.failureClass === "evidence-invalid",
  );
  assert.deepEqual(events, ["invoked", "verdict", "closed"]);
});

test("bounds signed evidence capture after a valid Promotion", async () => {
  let clock = 0;
  const events = [];
  await assert.rejects(
    runLiveModelArkProofSession({
      baseUrl: "http://127.0.0.1:3201",
      stateRoot: "/bounded-test-root",
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([completeRun()]),
      verifyEvidence: async () => {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
      now: () => clock,
      evidenceTimeoutMs: 2,
      pollIntervalMs: 1,
      waitImpl: async (milliseconds) => {
        clock += milliseconds;
      },
    }),
    (error) =>
      error instanceof LiveModelArkProofError &&
      error.failureClass === "evidence-timeout",
  );
  assert.deepEqual(events, ["invoked", "verdict", "closed"]);
});

test("retries a verified packet during its transient immutable publication", async () => {
  let attempts = 0;
  let clock = 0;
  const events = [];
  const result = await runLiveModelArkProofSession({
    baseUrl: "http://127.0.0.1:3201",
    stateRoot: "/bounded-test-root",
    browserDriver: browserFixture(events),
    fetchImpl: fetchFixture([completeRun()]),
    now: () => clock,
    pollIntervalMs: 1,
    waitImpl: async (milliseconds) => {
      clock += milliseconds;
    },
    verifyEvidence: async ({ packetFile }) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("publication in progress");
        error.code = "EVIDENCE_PUBLICATION_IN_PROGRESS";
        throw error;
      }
      return {
        valid: true,
        runId: "run-live-modelark-proof",
        receiptDigest,
        packetFile,
      };
    },
    writeResult: async () => {},
  });
  assert.equal(result.outcome, "passed");
  assert.equal(attempts, 2);
  assert.deepEqual(events, ["invoked", "verdict", "closed"]);
});

test("closes Chrome when the production control cannot be invoked", async () => {
  const events = [];
  const browserDriver = {
    async invokeLiveCandidate() {
      events.push("invoked");
      throw new LiveModelArkProofError("browser-failed");
    },
    async assertBoundVerdict() {
      assert.fail("a failed invocation must not assert a verdict");
    },
    async close() {
      events.push("closed");
    },
  };
  await assert.rejects(
    runLiveModelArkProofSession({
      baseUrl: "http://127.0.0.1:3201",
      stateRoot: "/bounded-test-root",
      browserDriver,
      fetchImpl: fetchFixture([]),
    }),
    (error) =>
      error instanceof LiveModelArkProofError &&
      error.failureClass === "browser-failed",
  );
  assert.deepEqual(events, ["invoked", "closed"]);
});

test("closes Chrome when the operator interrupts the proof", async () => {
  const controller = new AbortController();
  const events = [];
  controller.abort();
  await assert.rejects(
    runLiveModelArkProofSession({
      baseUrl: "http://127.0.0.1:3201",
      stateRoot: "/bounded-test-root",
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([]),
      signal: controller.signal,
    }),
    (error) =>
      error instanceof LiveModelArkProofError &&
      error.failureClass === "interrupted",
  );
  assert.deepEqual(events, ["closed"]);
});

test("does not publish success when interruption arrives after evidence verification", async () => {
  const controller = new AbortController();
  const events = [];
  let wroteResult = false;
  await assert.rejects(
    runLiveModelArkProofSession({
      baseUrl: "http://127.0.0.1:3201",
      stateRoot: "/bounded-test-root",
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([completeRun()]),
      signal: controller.signal,
      verifyEvidence: async ({ packetFile }) => {
        controller.abort();
        return {
          valid: true,
          runId: "run-live-modelark-proof",
          receiptDigest,
          packetFile,
        };
      },
      writeResult: async () => {
        wroteResult = true;
      },
    }),
    (error) =>
      error instanceof LiveModelArkProofError &&
      error.failureClass === "interrupted",
  );
  assert.equal(wroteResult, false);
  assert.deepEqual(events, ["invoked", "verdict", "closed"]);
});

test("an interruption before the real result rename preserves the prior capsule", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-live-proof-"));
  const controller = new AbortController();
  const events = [];
  const prior = buildLiveModelArkProofResult({
    observedAt: "2026-08-28T09:29:00.000Z",
    runId: "run-prior-live-proof",
    receiptDigest: "sha256:" + "b".repeat(64),
  });
  try {
    const resultPath = await writeLiveModelArkProofResult({
      stateRoot,
      result: prior,
    });
    await assert.rejects(
      runLiveModelArkProofSession({
        baseUrl: "http://127.0.0.1:3201",
        stateRoot,
        browserDriver: browserFixture(events),
        fetchImpl: fetchFixture([completeRun()]),
        observedAt: () => "2026-08-28T09:30:00.000Z",
        signal: controller.signal,
        verifyEvidence: async ({ packetFile }) => ({
          valid: true,
          runId: "run-live-modelark-proof",
          receiptDigest,
          packetFile,
        }),
        resultPublicationOperations: {
          beforeCommit: async () => controller.abort(),
        },
      }),
      (error) =>
        error instanceof LiveModelArkProofError &&
        error.failureClass === "interrupted",
    );
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), prior);
    assert.deepEqual(
      await readdir(path.dirname(resultPath)),
      [LIVE_MODELARK_PROOF_RESULT_NAME],
    );
    assert.deepEqual(events, ["invoked", "verdict", "closed"]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("an interruption after the real result rename keeps the proof passed", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-live-proof-"));
  const controller = new AbortController();
  const events = [];
  const prior = buildLiveModelArkProofResult({
    observedAt: "2026-08-28T09:29:00.000Z",
    runId: "run-prior-live-proof",
    receiptDigest: "sha256:" + "b".repeat(64),
  });
  try {
    const resultPath = await writeLiveModelArkProofResult({
      stateRoot,
      result: prior,
    });
    const result = await runLiveModelArkProofSession({
      baseUrl: "http://127.0.0.1:3201",
      stateRoot,
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([completeRun()]),
      observedAt: () => "2026-08-28T09:30:00.000Z",
      signal: controller.signal,
      verifyEvidence: async ({ packetFile }) => ({
        valid: true,
        runId: "run-live-modelark-proof",
        receiptDigest,
        packetFile,
      }),
      resultPublicationOperations: {
        rename: async (temporaryPath, destinationPath) => {
          await rename(temporaryPath, destinationPath);
          controller.abort();
        },
      },
    });
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.outcome, "passed");
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), result);
    assert.deepEqual(events, ["invoked", "verdict", "closed"]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a cleanup signal cannot flip the CLI exit after the capsule commits", () => {
  assert.equal(
    resolveLiveModelArkProofExitCode({
      currentExitCode: undefined,
      interrupted: true,
      proofCommitted: true,
    }),
    0,
  );
  assert.equal(
    resolveLiveModelArkProofExitCode({
      currentExitCode: undefined,
      interrupted: true,
      proofCommitted: false,
    }),
    1,
  );
  assert.equal(
    resolveLiveModelArkProofExitCode({
      currentExitCode: 2,
      interrupted: true,
      proofCommitted: true,
    }),
    2,
  );
});

test("classifies provider capacity without copying child output", () => {
  const error = classifyLiveModelArkLauncherFailure(
    "HTTP 429 RequestBurstTooFast account-private-material",
  );
  const failure = safeLiveModelArkFailure(error);
  assert.equal(failure.failureClass, "provider-unavailable");
  assert.doesNotMatch(JSON.stringify(failure), /account-private-material/);
  assert.equal(
    safeLiveModelArkFailure(new Error("Bearer secret-value")).failureClass,
    "startup-failed",
  );
});

test("refuses private material in a proposed success result", () => {
  const result = buildLiveModelArkProofResult({
    observedAt: "2026-08-28T09:30:00.000Z",
    runId: "run-live-modelark-proof",
    receiptDigest,
  });
  assert.doesNotThrow(() => assertSafeLiveModelArkProofResult(result));
  assert.throws(
    () =>
      assertSafeLiveModelArkProofResult({
        ...result,
        runId: "ark-private-material",
      }),
    (error) =>
      error instanceof LiveModelArkProofError &&
      error.failureClass === "evidence-invalid",
  );
});

test("a failed session never overwrites the previous successful result", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-live-proof-"));
  const resultDirectory = path.join(stateRoot, liveModelArkEvidenceDirectoryName);
  const resultPath = path.join(resultDirectory, LIVE_MODELARK_PROOF_RESULT_NAME);
  try {
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(resultPath, "previous-success\n", { mode: 0o600 });
    await assert.rejects(
      runLiveModelArkProofSession({
        baseUrl: "http://127.0.0.1:3201",
        stateRoot,
        browserDriver: browserFixture([]),
        fetchImpl: fetchFixture([
          completeRun({ status: "failed", transaction: null }),
        ]),
      }),
      LiveModelArkProofError,
    );
    assert.equal(await readFile(resultPath, "utf8"), "previous-success\n");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a later verified success atomically advances the latest proof result", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-live-proof-"));
  const first = buildLiveModelArkProofResult({
    observedAt: "2026-08-28T09:30:00.000Z",
    runId: "run-first-live-proof",
    receiptDigest,
  });
  const second = buildLiveModelArkProofResult({
    observedAt: "2026-08-28T09:31:00.000Z",
    runId: "run-second-live-proof",
    receiptDigest: "sha256:" + "d".repeat(64),
  });
  try {
    const resultPath = await writeLiveModelArkProofResult({ stateRoot, result: first });
    await assert.doesNotReject(
      writeLiveModelArkProofResult({ stateRoot, result: first }),
    );
    await assert.doesNotReject(
      writeLiveModelArkProofResult({ stateRoot, result: second }),
    );
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), second);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a pre-commit result publication failure preserves the prior success", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-live-proof-"));
  const first = buildLiveModelArkProofResult({
    observedAt: "2026-08-28T09:30:00.000Z",
    runId: "run-first-live-proof",
    receiptDigest,
  });
  const second = buildLiveModelArkProofResult({
    observedAt: "2026-08-28T09:31:00.000Z",
    runId: "run-second-live-proof",
    receiptDigest: "sha256:" + "d".repeat(64),
  });
  const resultDirectory = path.join(stateRoot, liveModelArkEvidenceDirectoryName);
  try {
    const resultPath = await writeLiveModelArkProofResult({ stateRoot, result: first });
    await chmod(resultDirectory, 0o755);
    await assert.rejects(
      writeLiveModelArkProofResult({ stateRoot, result: second }),
      (error) =>
        error instanceof LiveModelArkProofError &&
        error.failureClass === "evidence-invalid",
    );
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), first);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
