import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
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
  runLiveModelArkProofSession,
  safeLiveModelArkFailure,
} from "./modelark-live-proof-runner.mjs";
import { liveModelArkEvidenceDirectoryName } from "./modelark-conformance-evidence.mjs";

const receiptDigest = "sha256:" + "c".repeat(64);

function completeRun(overrides = {}) {
  return {
    id: "run-live-modelark-proof",
    agentId: "agent-live-modelark",
    candidateSetId: null,
    status: "completed",
    transaction: {
      status: "promoted",
      disposition: "promoted",
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
            modelCommitment: "sha256:" + "a".repeat(64),
            preflight: {
              generatedAssistantOutput: true,
              endpointOriginCommitment: "sha256:" + "b".repeat(64),
              requestCount: 1,
            },
          }),
        },
        {
          name: "modelark-live-state",
          required: true,
          status: "passed",
        },
      ],
      resources: [
        "workspace",
        "codex-session",
        "sqlite",
        "external-actions",
      ].map((kind) => ({ kind, disposition: "promoted" })),
      sqlite: {
        after: { rows: [{ id: "demo", value: "modelark-live" }] },
      },
      externalActions: {
        deliveredCount: 1,
        intents: [{ id: "modelark-live-ready", status: "delivered" }],
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
    async assertBoundVerdict() {
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
      verifyEvidence: async () => ({
        valid: true,
        runId: "run-live-modelark-proof",
        receiptDigest,
      }),
    });

    assert.equal(result.outcome, "passed");
    assert.equal(result.receiptDigest, receiptDigest);
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
