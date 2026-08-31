import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_PROOF_CHAIN_DIRECTORY,
  RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  RUNTIME_PROOF_POST_RUN_RESERVE_MS,
  RUNTIME_PROOF_PRESENTATION_DWELL_BUDGET_MS,
  RUNTIME_PROOF_PRESENTATION_DWELL_MS,
  RUNTIME_PROOF_PRESENTATION_TAIL_RESERVE_MS,
  RUNTIME_PROOF_RECORDING_BUDGET_MS,
  RUNTIME_PROOF_RECORDING_HEADROOM_MS,
  RUNTIME_PROOF_RESULT_NAME,
  RUNTIME_PROOF_RUN_POLLING_BUDGET_MS,
  RuntimeProofError,
  assertMatchingRuntimeProofDecisionChainSources,
  assertSafeRuntimeProofResult,
  assertSafeRuntimeProofRoot,
  assertStoppedRuntimeProofSnapshot,
  buildRuntimeProofResult,
  cleanupAbandonedRuntimeProofSessions,
  cleanupRuntimeProofSessionRoot,
  createRuntimeProofPresentationPacer,
  createRuntimeProofSessionRoot,
  finalizeRuntimeProofPublication,
  initializeRuntimeProofRoot,
  offlineVerifierNetworkAction,
  recoverRuntimeProofArtifactPublication,
  resolveRuntimeProofArtifactPaths,
  runRuntimeProofArtifactWorker,
  runRuntimeProofSession,
  runtimeProofChainFile,
  runtimeProofReplayUrl,
  safeRuntimeProofFailure,
  verifyRuntimeProofRuns,
  writeRuntimeProofArtifacts,
} from "./runtime-proof-runner.mjs";
import {
  realRuntimeProofAgentName,
  realRuntimeProofContract,
} from "./runtime-demo-profile.mjs";
import {
  attachBoundedRuntimeProofCapture,
  createOwnedRuntimeProofProcessTree,
  createBoundedRuntimeProofTranscript,
  createRuntimeProofProgress,
  runtimeProofChildExitSucceeded,
  runtimeProofTerminalLimits,
  stopOwnedRuntimeProofProcessTree,
  stopRuntimeProofChild,
  waitForRuntimeProofChildOutcome,
} from "./runtime-proof-terminal.mjs";

const readinessDigest = "sha256:" + "9".repeat(64);
const parentReceiptDigest = "sha256:" + "d".repeat(64);
const leafReceiptDigest = "sha256:" + "e".repeat(64);
const observedAt = "2026-08-28T10:00:00.000Z";
const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function digest(character) {
  return "sha256:" + character.repeat(64);
}

function sourceDigest(source) {
  return "sha256:" + createHash("sha256").update(source).digest("hex");
}

function resources(disposition) {
  return ["workspace", "codex-session", "sqlite", "external-actions"].map(
    (kind) => ({ kind, disposition }),
  );
}

function validation(status) {
  return [{ name: "protocol-fixture-content", required: true, status }];
}

function outcomeContract() {
  return {
    schemaVersion: 1,
    version: 1,
    ...structuredClone(realRuntimeProofContract),
    createdAt: "2026-08-28T09:55:00.000Z",
  };
}

function makeRunSet() {
  const promotion = {
    id: "run-promotion",
    agentId: "agent-runtime-proof",
    candidateSetId: null,
    competitorId: null,
    createdAt: "2026-08-28T10:00:01.000Z",
    status: "completed",
    transaction: {
      status: "promoted",
      disposition: "promoted",
      canonicalStateIdBefore: "state-initial",
      canonicalStateIdAfter: "state-promoted",
      canonicalContentHashBefore: digest("a"),
      canonicalContentHashAfter: digest("b"),
      lineage: {
        rootRunId: "run-promotion",
        parentRunId: null,
        depth: 0,
      },
      outcomeContractVersion: 1,
      outcomeContract: outcomeContract(),
      validations: validation("passed"),
      resources: resources("promoted"),
      changes: { files: [{ path: "protocol-proof.txt", kind: "added" }] },
      events: [
        {
          status: "promoting",
          at: "2026-08-28T10:00:01.100Z",
          summary: "Promotion started",
        },
        {
          status: "promoting",
          at: "2026-08-28T10:00:01.150Z",
          summary: "Canonical State advanced before external action delivery",
        },
        {
          status: "promoted",
          at: "2026-08-28T10:00:01.300Z",
          summary: "Promotion completed",
        },
      ],
      sqlite: {
        candidate: { rows: [{ id: "demo", value: "candidate-only" }] },
        after: { rows: [{ id: "demo", value: "candidate-only" }] },
      },
      externalActions: {
        deliveredCount: 1,
        intents: [
          {
            id: "protocol-release-ready",
            type: "demo.notification.requested",
            status: "delivered",
            idempotencyKey: "effect-promotion",
            deliveredAt: "2026-08-28T10:00:01.200Z",
          },
        ],
      },
      recovery: { journalPhase: "completed" },
    },
  };
  const quarantine = {
    id: "run-quarantine",
    agentId: "agent-runtime-proof",
    candidateSetId: null,
    competitorId: null,
    createdAt: "2026-08-28T10:00:02.000Z",
    status: "completed",
    transaction: {
      status: "quarantined",
      disposition: "quarantined",
      canonicalStateIdBefore: "state-promoted",
      canonicalStateIdAfter: "state-promoted",
      canonicalContentHashBefore: digest("b"),
      canonicalContentHashAfter: digest("b"),
      lineage: {
        rootRunId: "run-quarantine",
        parentRunId: null,
        depth: 0,
      },
      outcomeContractVersion: 1,
      outcomeContract: outcomeContract(),
      validations: validation("failed"),
      resources: resources("quarantined"),
      changes: { files: [{ path: "protocol-proof.txt", kind: "modified" }] },
      events: [],
      sqlite: {
        candidate: { rows: [{ id: "demo", value: "unsafe-candidate" }] },
        after: { rows: [{ id: "demo", value: "candidate-only" }] },
      },
      externalActions: {
        deliveredCount: 0,
        intents: [
          {
            id: "protocol-unsafe",
            type: "demo.notification.requested",
            status: "rejected",
            idempotencyKey: "effect-quarantine",
            deliveredAt: null,
          },
        ],
      },
      recovery: { journalPhase: "not-started" },
    },
  };
  const repair = {
    id: "run-repair",
    agentId: "agent-runtime-proof",
    candidateSetId: null,
    competitorId: null,
    createdAt: "2026-08-28T10:00:03.000Z",
    status: "completed",
    transaction: {
      status: "promoted",
      disposition: "promoted",
      canonicalStateIdBefore: "state-promoted",
      canonicalStateIdAfter: "state-repaired",
      canonicalContentHashBefore: digest("b"),
      canonicalContentHashAfter: digest("c"),
      lineage: {
        rootRunId: "run-quarantine",
        parentRunId: "run-quarantine",
        depth: 1,
      },
      outcomeContractVersion: 1,
      outcomeContract: outcomeContract(),
      validations: validation("passed"),
      resources: resources("promoted"),
      changes: { files: [{ path: "protocol-proof.txt", kind: "modified" }] },
      events: [
        {
          status: "promoting",
          at: "2026-08-28T10:00:03.100Z",
          summary: "Repair Promotion started",
        },
        {
          status: "promoting",
          at: "2026-08-28T10:00:03.150Z",
          summary: "Canonical State advanced before external action delivery",
        },
        {
          status: "promoted",
          at: "2026-08-28T10:00:03.300Z",
          summary: "Repair Promotion completed",
        },
      ],
      sqlite: {
        candidate: { rows: [{ id: "demo", value: "candidate-only" }] },
        after: { rows: [{ id: "demo", value: "candidate-only" }] },
      },
      externalActions: {
        deliveredCount: 1,
        intents: [
          {
            id: "protocol-repair-ready",
            type: "demo.notification.requested",
            status: "delivered",
            idempotencyKey: "effect-repair",
            deliveredAt: "2026-08-28T10:00:03.200Z",
          },
        ],
      },
      recovery: { journalPhase: "completed" },
    },
  };
  return { promotion, quarantine, repair };
}

function clone(value) {
  return structuredClone(value);
}

function apiRuns(runSet) {
  return [runSet.repair, runSet.quarantine, runSet.promotion];
}

function decisionChainSource(runSet = makeRunSet()) {
  return JSON.stringify({
    schema: "agent-airlock/portable-decision-chain",
    schemaVersion: 1,
    packets: [
      {
        envelope: {
          receiptDigest: parentReceiptDigest,
          receipt: {
            decision: {
              runId: runSet.quarantine.id,
              disposition: "quarantined",
            },
            ancestry: {
              rootRunId: runSet.quarantine.id,
              parentRunId: null,
              depth: 0,
              previousReceiptDigest: null,
            },
            state: {
              before: {
                stateId:
                  runSet.quarantine.transaction.canonicalStateIdBefore,
                compositeHash:
                  runSet.quarantine.transaction.canonicalContentHashBefore,
              },
              after: {
                stateId: runSet.quarantine.transaction.canonicalStateIdAfter,
                compositeHash:
                  runSet.quarantine.transaction.canonicalContentHashAfter,
              },
            },
          },
        },
      },
      {
        envelope: {
          receiptDigest: leafReceiptDigest,
          receipt: {
            decision: {
              runId: runSet.repair.id,
              disposition: "promoted",
            },
            ancestry: {
              rootRunId: runSet.quarantine.id,
              parentRunId: runSet.quarantine.id,
              depth: 1,
              previousReceiptDigest: parentReceiptDigest,
            },
            state: {
              before: {
                stateId: runSet.repair.transaction.canonicalStateIdBefore,
                compositeHash:
                  runSet.repair.transaction.canonicalContentHashBefore,
              },
              after: {
                stateId: runSet.repair.transaction.canonicalStateIdAfter,
                compositeHash:
                  runSet.repair.transaction.canonicalContentHashAfter,
              },
            },
          },
        },
      },
    ],
  });
}

function verifiedChainReport() {
  return {
    valid: true,
    packets: [{ valid: true }, { valid: true }],
    leafReceiptDigest,
    checks: [
      { name: "chain-links", valid: true },
      { name: "chain-state-continuity", valid: true },
    ],
  };
}

function browserFixture(events, chainSource = decisionChainSource()) {
  return {
    async invokeCompleteSafetyLoop() {
      events.push("invoked-once");
    },
    async assertSignedRecovery() {
      events.push("signed-recovery");
    },
    async assertRecordingBoard(runs) {
      assert.deepEqual(Object.keys(runs).sort(), [
        "promotion",
        "quarantine",
        "repair",
      ]);
      events.push("desktop-board-and-mobile-replay");
    },
    async captureAndInspectDecisionChain() {
      events.push("zero-upload-verifier");
      return chainSource;
    },
    async close() {
      events.push("closed");
    },
  };
}

function fetchFixture(
  runsAfterInvocation,
  {
    agentContract = outcomeContract(),
    initialRuns = [],
    finalRuns = runsAfterInvocation,
  } = {},
) {
  let runRequests = 0;
  return async (url) => {
    if (url.endsWith("/api/agents")) {
      return Response.json({
        agents: [
          {
            id: "agent-runtime-proof",
            name: realRuntimeProofAgentName,
            canonicalStateId: "state-initial",
            outcomeContract: agentContract,
          },
        ],
      });
    }
    if (url.endsWith("/api/agents/agent-runtime-proof/runs")) {
      runRequests += 1;
      return Response.json({
        runs:
          runRequests === 1
            ? initialRuns
            : runRequests === 2
              ? runsAfterInvocation
              : finalRuns,
      });
    }
    return new Response(null, { status: 404 });
  };
}

async function expectFailure(promise, failureClass) {
  await assert.rejects(
    promise,
    (error) =>
      error instanceof RuntimeProofError &&
      error.failureClass === failureClass,
  );
}

test("presentation pacing is fixed, bounded, and zero-delay when disabled", async () => {
  const moments = Object.keys(RUNTIME_PROOF_PRESENTATION_DWELL_MS);
  const expectedDurations = [15_000, 85_000, 25_000];
  assert.deepEqual(
    moments.map((moment) => RUNTIME_PROOF_PRESENTATION_DWELL_MS[moment]),
    expectedDurations,
  );
  assert.equal(RUNTIME_PROOF_PRESENTATION_DWELL_BUDGET_MS, 125_000);
  assert.ok(RUNTIME_PROOF_PRESENTATION_DWELL_BUDGET_MS < 150_000);
  assert.equal(RUNTIME_PROOF_RECORDING_BUDGET_MS, 180_000);
  assert.equal(RUNTIME_PROOF_RUN_POLLING_BUDGET_MS, 35_000);
  assert.equal(RUNTIME_PROOF_POST_RUN_RESERVE_MS, 115_000);
  assert.equal(RUNTIME_PROOF_PRESENTATION_TAIL_RESERVE_MS, 5_000);
  assert.equal(RUNTIME_PROOF_RECORDING_HEADROOM_MS, 15_000);

  const headlessWaits = [];
  const headless = createRuntimeProofPresentationPacer({
    enabled: false,
    waitImpl: async (milliseconds) => headlessWaits.push(milliseconds),
  });
  for (const moment of moments) await headless.dwell(moment);
  assert.deepEqual(headlessWaits, []);

  const headedWaits = [];
  const headed = createRuntimeProofPresentationPacer({
    enabled: true,
    waitImpl: async (milliseconds) => headedWaits.push(milliseconds),
  });
  for (const moment of moments) await headed.dwell(moment);
  assert.deepEqual(headedWaits, expectedDurations);
  assert.equal(
    headedWaits.reduce((total, milliseconds) => total + milliseconds, 0),
    RUNTIME_PROOF_PRESENTATION_DWELL_BUDGET_MS,
  );
});

test("presentation pacing requires each complete frame before one absolute deadline", async () => {
  let clock = 1_000;
  const waits = [];
  const pacer = createRuntimeProofPresentationPacer({
    enabled: true,
    now: () => clock,
    recordingDeadlineAt: 9_000,
    waitImpl: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
  });

  await expectFailure(pacer.dwell("opening-cta"), "recording-timeout");

  assert.deepEqual(waits, []);
  assert.equal(clock, 1_000);
});

test("desktop presentation preserves its verifier and close tail", async () => {
  let clock = 65_000;
  const waits = [];
  const recordingDeadlineAt = 180_000;
  const pacer = createRuntimeProofPresentationPacer({
    enabled: true,
    now: () => clock,
    recordingDeadlineAt,
    waitImpl: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
  });

  await pacer.dwell("desktop-outcome-brief");
  await pacer.dwell("desktop-verifier");

  assert.deepEqual(waits, [85_000, 25_000]);
  assert.equal(
    recordingDeadlineAt - clock,
    RUNTIME_PROOF_PRESENTATION_TAIL_RESERVE_MS,
  );
});

test("presentation fails instead of shortening promised desktop frames", async () => {
  for (const [moment, clock] of [
    ["desktop-outcome-brief", 65_001],
    ["desktop-verifier", 150_001],
  ]) {
    const waits = [];
    const pacer = createRuntimeProofPresentationPacer({
      enabled: true,
      now: () => clock,
      recordingDeadlineAt: 180_000,
      waitImpl: async (milliseconds) => waits.push(milliseconds),
    });
    await expectFailure(pacer.dwell(moment), "recording-timeout");
    assert.deepEqual(waits, []);
  }
});

test("mobile replay URL binds exactly the three already verified Run IDs", () => {
  const url = new URL(
    runtimeProofReplayUrl({
      baseUrl: "http://127.0.0.1:3222/?existing=kept",
      runs: makeRunSet(),
    }),
  );
  assert.equal(url.searchParams.get("existing"), "kept");
  assert.equal(url.searchParams.get("recording"), "1");
  assert.deepEqual(url.searchParams.getAll("recordingSafeRunId"), [
    "run-promotion",
  ]);
  assert.deepEqual(url.searchParams.getAll("recordingUnsafeRunId"), [
    "run-quarantine",
  ]);
  assert.deepEqual(url.searchParams.getAll("recordingRepairRunId"), [
    "run-repair",
  ]);
  assert.equal(url.searchParams.has("replay"), false);

  const duplicate = makeRunSet();
  duplicate.repair.id = duplicate.quarantine.id;
  assert.throws(
    () =>
      runtimeProofReplayUrl({
        baseUrl: "http://127.0.0.1:3222",
        runs: duplicate,
      }),
    (error) =>
      error instanceof RuntimeProofError &&
      error.failureClass === "run-set-invalid",
  );
});

test("mobile replay must reproduce the exact primary decision-chain source", () => {
  const source = decisionChainSource();
  assert.equal(
    assertMatchingRuntimeProofDecisionChainSources(source, source),
    source,
  );
  for (const replaySource of [null, "", source + "\n"]) {
    assert.throws(
      () =>
        assertMatchingRuntimeProofDecisionChainSources(source, replaySource),
      (error) =>
        error instanceof RuntimeProofError &&
        error.failureClass === "chain-invalid",
    );
  }
});

test("presentation pacing remains interruption-responsive", async () => {
  const controller = new AbortController();
  const pacer = createRuntimeProofPresentationPacer({
    enabled: true,
    signal: controller.signal,
  });
  const pending = pacer.dwell("opening-cta");
  controller.abort();
  await expectFailure(pending, "interrupted");
});

test("presentation pacing preserves the distinct three-minute deadline failure", async () => {
  const controller = new AbortController();
  const pacer = createRuntimeProofPresentationPacer({
    enabled: true,
    signal: controller.signal,
  });
  const pending = pacer.dwell("opening-cta");
  controller.abort(new RuntimeProofError("recording-timeout"));
  await expectFailure(pending, "recording-timeout");
});

test("the offline verifier guard allows setup and then denies every network shape", () => {
  assert.equal(
    offlineVerifierNetworkAction({ guardArmed: false }),
    "continue",
  );
  for (const request of [
    { requestUrl: "http://127.0.0.1:3222/assets/index.js", method: "GET" },
    {
      requestUrl: "http://127.0.0.1:3222/assets/index.js?receipt=secret",
      method: "GET",
    },
    { requestUrl: "http://127.0.0.1:3222/secret-as-path", method: "GET" },
    { requestUrl: "http://127.0.0.1:3222/favicon.svg", method: "HEAD" },
    { requestUrl: "http://127.0.0.1:3222/telemetry", method: "POST" },
    { requestUrl: "https://collector.example/evidence", method: "GET" },
    { requestUrl: "https://collector.example/evidence", method: "POST" },
    { requestUrl: "wss://collector.example/evidence", method: "WEBSOCKET" },
  ]) {
    assert.equal(
      offlineVerifierNetworkAction({ guardArmed: true, ...request }),
      "block",
    );
  }
});

test("drives one exact browser loop and preserves owner-only authority", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-result-"),
  );
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const events = [];
  try {
    const result = await runRuntimeProofSession({
      baseUrl: "http://127.0.0.1:3222",
      artifactRoot,
      readinessDigest,
      browserDriver: browserFixture(events, chainSource),
      fetchImpl: fetchFixture(apiRuns(runSet)),
      verifyChain: async () => verifiedChainReport(),
      observedAt: () => observedAt,
    });

    assert.equal(result.outcome, "passed");
    assert.deepEqual(events, [
      "invoked-once",
      "signed-recovery",
      "desktop-board-and-mobile-replay",
      "zero-upload-verifier",
      "closed",
    ]);
    const evidenceRoot = path.join(
      artifactRoot,
      RUNTIME_PROOF_EVIDENCE_DIRECTORY,
    );
    const chainPath = path.join(evidenceRoot, result.chainFile);
    const resultPath = path.join(evidenceRoot, RUNTIME_PROOF_RESULT_NAME);
    assert.equal(await readFile(chainPath, "utf8"), chainSource);
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), result);
    assert.equal((await stat(evidenceRoot)).mode & 0o777, 0o700);
    assert.equal(
      path.basename(path.dirname(chainPath)),
      RUNTIME_PROOF_CHAIN_DIRECTORY,
    );
    assert.equal((await stat(path.dirname(chainPath))).mode & 0o777, 0o700);
    assert.equal((await stat(chainPath)).mode & 0o777, 0o600);
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(
      await readFile(resultPath, "utf8"),
      /Bearer|ARK_API_KEY|https?:\/\/|\bep-|\bark-|\/Users\//i,
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("a browser close that crosses the recording deadline cannot publish", async () => {
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const events = [];
  const recordingDeadlineAt = 180_000;
  let clock = 1_000;
  let published = false;
  const browserDriver = browserFixture(events, chainSource);
  browserDriver.close = async () => {
    events.push("closed");
    clock = recordingDeadlineAt;
  };

  await expectFailure(
    runRuntimeProofSession({
      baseUrl: "http://127.0.0.1:3222",
      artifactRoot: "/bounded-test-root",
      readinessDigest,
      browserDriver,
      fetchImpl: fetchFixture(apiRuns(runSet)),
      verifyChain: async () => verifiedChainReport(),
      writeArtifacts: async () => {
        published = true;
      },
      now: () => clock,
      recordingDeadlineAt,
    }),
    "recording-timeout",
  );

  assert.equal(published, false);
  assert.deepEqual(events, [
    "invoked-once",
    "signed-recovery",
    "desktop-board-and-mobile-replay",
    "zero-upload-verifier",
    "closed",
  ]);
});

test("rejects stale ordinary Runs before invoking Chrome", async () => {
  const events = [];
  await expectFailure(
    runRuntimeProofSession({
      baseUrl: "http://127.0.0.1:3222",
      artifactRoot: "/bounded-test-root",
      readinessDigest,
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture(apiRuns(makeRunSet()), {
        initialRuns: [makeRunSet().promotion],
      }),
      verifyChain: async () => verifiedChainReport(),
      writeArtifacts: async () => assert.fail("stale state cannot publish"),
    }),
    "stale-state",
  );
  assert.deepEqual(events, ["closed"]);
});

test("rejects malformed or duplicate Run IDs before baselining", async (context) => {
  const cases = [
    ["missing Run id", (runs) => delete runs[0].id],
    ["blank Run id", (runs) => (runs[0].id = "")],
    ["non-string Run id", (runs) => (runs[0].id = 7)],
    ["duplicate Run id", (runs) => runs.push(clone(runs[0]))],
  ];

  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const historicalRun = {
        ...clone(makeRunSet().promotion),
        id: "run-candidate-set-historical",
        candidateSetId: "candidate-set-historical",
        competitorId: "competitor-historical",
      };
      const initialRuns = [historicalRun];
      mutate(initialRuns);
      const events = [];

      await expectFailure(
        runRuntimeProofSession({
          baseUrl: "http://127.0.0.1:3222",
          artifactRoot: "/bounded-test-root",
          readinessDigest,
          browserDriver: browserFixture(events),
          fetchImpl: fetchFixture(apiRuns(makeRunSet()), { initialRuns }),
          verifyChain: async () => verifiedChainReport(),
          writeArtifacts: async () =>
            assert.fail("invalid Run IDs cannot publish"),
        }),
        "run-set-invalid",
      );

      assert.deepEqual(events, ["closed"]);
    });
  }
});

test("counts a fresh Candidate Set Run before validating the three ordinary Runs", async () => {
  const runSet = makeRunSet();
  const candidateSetRun = {
    ...clone(runSet.promotion),
    id: "run-candidate-set-extra",
    candidateSetId: "candidate-set-extra",
    competitorId: "competitor-extra",
    createdAt: "2026-08-28T10:00:04.000Z",
  };
  const events = [];
  let published = false;

  await expectFailure(
    runRuntimeProofSession({
      baseUrl: "http://127.0.0.1:3222",
      artifactRoot: "/bounded-test-root",
      readinessDigest,
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([...apiRuns(runSet), candidateSetRun]),
      verifyChain: async () => verifiedChainReport(),
      writeArtifacts: async () => {
        published = true;
      },
    }),
    "run-set-invalid",
  );

  assert.equal(published, false);
  assert.deepEqual(events, ["invoked-once", "closed"]);
});

test("rejects a reclassified historical Candidate Set Run", async () => {
  const runSet = makeRunSet();
  const historicalCandidateSetRun = {
    ...clone(runSet.promotion),
    candidateSetId: "candidate-set-historical",
    competitorId: "competitor-historical",
  };
  const events = [];
  let published = false;

  await expectFailure(
    runRuntimeProofSession({
      baseUrl: "http://127.0.0.1:3222",
      artifactRoot: "/bounded-test-root",
      readinessDigest,
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture(apiRuns(runSet), {
        initialRuns: [historicalCandidateSetRun],
      }),
      verifyChain: async () => verifiedChainReport(),
      writeArtifacts: async () => {
        published = true;
      },
    }),
    "run-set-invalid",
  );

  assert.equal(published, false);
  assert.deepEqual(events, ["invoked-once", "closed"]);
});

test("allows unrelated historical Candidate Set Runs beside three fresh ordinary Runs", async () => {
  const runSet = makeRunSet();
  const historicalCandidateSetRun = {
    ...clone(runSet.promotion),
    id: "run-candidate-set-historical",
    candidateSetId: "candidate-set-historical",
    competitorId: "competitor-historical",
  };
  const events = [];
  let published = false;
  const runs = [historicalCandidateSetRun, ...apiRuns(runSet)];

  const result = await runRuntimeProofSession({
    baseUrl: "http://127.0.0.1:3222",
    artifactRoot: "/bounded-test-root",
    readinessDigest,
    browserDriver: browserFixture(events),
    fetchImpl: fetchFixture(runs, {
      initialRuns: [historicalCandidateSetRun],
      finalRuns: runs,
    }),
    verifyChain: async () => verifiedChainReport(),
    writeArtifacts: async () => {
      published = true;
    },
    observedAt: () => observedAt,
  });

  assert.equal(result.outcome, "passed");
  assert.equal(published, true);
  assert.deepEqual(events, [
    "invoked-once",
    "signed-recovery",
    "desktop-board-and-mobile-replay",
    "zero-upload-verifier",
    "closed",
  ]);
});

test("fails closed when a baseline Run disappears or is reused", async (context) => {
  const runSet = makeRunSet();
  const proofRuns = apiRuns(runSet);
  const historicalRun = {
    ...clone(runSet.promotion),
    id: "run-candidate-set-historical",
    candidateSetId: "candidate-set-historical",
    competitorId: "competitor-historical",
  };

  await context.test("reclassified ID reuse during polling", async () => {
    const reusedRun = {
      ...clone(historicalRun),
      candidateSetId: null,
      competitorId: null,
    };
    const events = [];
    let published = false;

    await expectFailure(
      runRuntimeProofSession({
        baseUrl: "http://127.0.0.1:3222",
        artifactRoot: "/bounded-test-root",
        readinessDigest,
        browserDriver: browserFixture(events),
        fetchImpl: fetchFixture([reusedRun, ...proofRuns], {
          initialRuns: [historicalRun],
        }),
        verifyChain: async () => verifiedChainReport(),
        writeArtifacts: async () => {
          published = true;
        },
      }),
      "run-set-invalid",
    );

    assert.equal(published, false);
    assert.deepEqual(events, ["invoked-once", "closed"]);
  });

  await context.test("baseline disappearance during final recheck", async () => {
    const events = [];
    let published = false;

    await expectFailure(
      runRuntimeProofSession({
        baseUrl: "http://127.0.0.1:3222",
        artifactRoot: "/bounded-test-root",
        readinessDigest,
        browserDriver: browserFixture(events),
        fetchImpl: fetchFixture([historicalRun, ...proofRuns], {
          initialRuns: [historicalRun],
          finalRuns: proofRuns,
        }),
        verifyChain: async () => verifiedChainReport(),
        writeArtifacts: async () => {
          published = true;
        },
      }),
      "run-set-invalid",
    );

    assert.equal(published, false);
    assert.deepEqual(events, [
      "invoked-once",
      "signed-recovery",
      "desktop-board-and-mobile-replay",
      "zero-upload-verifier",
      "closed",
    ]);
  });
});

test("rejects managed Outcome Contract drift after readiness before invoking Chrome", async () => {
  const events = [];
  const agentContract = outcomeContract();
  agentContract.maxChangedFiles += 1;
  await expectFailure(
    runRuntimeProofSession({
      baseUrl: "http://127.0.0.1:3222",
      artifactRoot: "/bounded-test-root",
      readinessDigest,
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture(apiRuns(makeRunSet()), { agentContract }),
      verifyChain: async () => verifiedChainReport(),
      writeArtifacts: async () => assert.fail("drifted policy cannot publish"),
    }),
    "startup-failed",
  );
  assert.deepEqual(events, ["closed"]);
});

test("returns a distinct bounded Run timeout and closes the browser without publishing", async () => {
  const events = [];
  let clock = 0;
  let published = false;
  await expectFailure(
    runRuntimeProofSession({
      baseUrl: "http://127.0.0.1:3222",
      artifactRoot: "/bounded-test-root",
      readinessDigest,
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([]),
      verifyChain: async () => verifiedChainReport(),
      writeArtifacts: async () => {
        published = true;
      },
      now: () => clock,
      runTimeoutMs: 2,
      pollIntervalMs: 1,
      waitImpl: async (milliseconds) => {
        clock += milliseconds;
      },
    }),
    "run-timeout",
  );
  assert.deepEqual(events, ["invoked-once", "closed"]);
  assert.equal(published, false);
});

test("Run polling clamps its final wait and preserves the complete proof window", async () => {
  const events = [];
  let clock = 1_000;
  const pollingStartedAt = clock;
  const waits = [];
  const recordingDeadlineAt = 166_000;
  await expectFailure(
    runRuntimeProofSession({
      baseUrl: "http://127.0.0.1:3222",
      artifactRoot: "/bounded-test-root",
      readinessDigest,
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture([]),
      verifyChain: async () => verifiedChainReport(),
      writeArtifacts: async () => assert.fail("timed out proof cannot publish"),
      now: () => clock,
      recordingDeadlineAt,
      runTimeoutMs: 100_000,
      pollIntervalMs: 20_000,
      waitImpl: async (milliseconds) => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
    }),
    "run-timeout",
  );

  assert.deepEqual(waits, [20_000, 15_000]);
  assert.equal(clock - pollingStartedAt, RUNTIME_PROOF_RUN_POLLING_BUDGET_MS);
  assert.equal(
    recordingDeadlineAt - clock,
    RUNTIME_PROOF_POST_RUN_RESERVE_MS +
      RUNTIME_PROOF_RECORDING_HEADROOM_MS,
  );
  assert.deepEqual(events, ["invoked-once", "closed"]);
});

test("rejects every required Run-set contradiction", async (context) => {
  const contradictions = [
    [
      "missing Run id",
      "run-set-invalid",
      (runs) => {
        delete runs[0].id;
      },
    ],
    [
      "blank Run id",
      "run-set-invalid",
      (runs) => {
        runs[0].id = "";
      },
    ],
    [
      "non-string Run id",
      "run-set-invalid",
      (runs) => {
        runs[0].id = 7;
      },
    ],
    [
      "extra ordinary Run",
      "run-set-invalid",
      (runs) => runs.push({ ...clone(runs[0]), id: "run-extra" }),
    ],
    [
      "duplicate Run id",
      "run-set-invalid",
      (runs) => {
        runs[1].id = runs[0].id;
      },
    ],
    [
      "foreign Agent Run",
      "run-set-invalid",
      (runs) => {
        runs[0].agentId = "agent-foreign";
      },
    ],
    [
      "Competing Future presented as an ordinary Run",
      "run-set-invalid",
      (runs) => {
        runs[0].competitorId = "competitor-hidden";
      },
    ],
    [
      "out-of-order creation",
      "run-set-invalid",
      (runs) => {
        runs[0].createdAt = "2026-08-28T09:59:00.000Z";
      },
    ],
    [
      "Outcome Contract differs across the proof set",
      "run-set-invalid",
      (runs) => {
        runs.find(
          (run) => run.id === "run-repair",
        ).transaction.outcomeContract.name = "different-contract";
      },
    ],
    [
      "all Run policies drift together after readiness",
      "run-set-invalid",
      (runs) => {
        for (const run of runs) {
          run.transaction.outcomeContract.maxChangedFiles += 1;
        }
      },
    ],
    [
      "all Run contracts use an unsupported schema version",
      "run-set-invalid",
      (runs) => {
        for (const run of runs) {
          run.transaction.outcomeContract.schemaVersion = 2;
        }
      },
    ],
    [
      "all Run contracts contain an unknown policy field",
      "run-set-invalid",
      (runs) => {
        for (const run of runs) {
          run.transaction.outcomeContract.allowNetwork = true;
        }
      },
    ],
    [
      "all Run contracts contain an invalid creation timestamp",
      "run-set-invalid",
      (runs) => {
        for (const run of runs) {
          run.transaction.outcomeContract.createdAt = "not-a-timestamp";
        }
      },
    ],
    [
      "Promotion resource missing",
      "promotion-invalid",
      (runs) => runs.find((run) => run.id === "run-promotion").transaction.resources.pop(),
    ],
    [
      "Promotion Candidate SQLite value is missing",
      "promotion-invalid",
      (runs) => {
        runs.find(
          (run) => run.id === "run-promotion",
        ).transaction.sqlite.candidate.rows = [];
      },
    ],
    [
      "Promotion protocol file evidence is missing",
      "promotion-invalid",
      (runs) => {
        runs.find(
          (run) => run.id === "run-promotion",
        ).transaction.changes.files = [];
      },
    ],
    [
      "Promotion required Validation failed",
      "promotion-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-promotion").transaction.validations[0].status = "failed";
      },
    ],
    [
      "Quarantine fails a different required Validation",
      "quarantine-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-quarantine").transaction.validations = [
          {
            name: "protocol-fixture-content",
            required: true,
            status: "passed",
          },
          { name: "command:other", required: true, status: "failed" },
        ];
      },
    ],
    [
      "Promotion journal incomplete",
      "promotion-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-promotion").transaction.recovery.journalPhase = "prepared";
      },
    ],
    [
      "Quarantine contains Promotion lifecycle evidence",
      "quarantine-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-quarantine").transaction.events.push({
          status: "promoting",
          at: "2026-08-28T10:00:02.100Z",
          summary: "Contradictory Promotion",
        });
      },
    ],
    [
      "Promotion effect not delivered",
      "promotion-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-promotion").transaction.externalActions.deliveredCount = 0;
      },
    ],
    [
      "Promotion effect type drifted",
      "promotion-invalid",
      (runs) => {
        runs.find(
          (run) => run.id === "run-promotion",
        ).transaction.externalActions.intents[0].type = "unexpected.effect";
      },
    ],
    [
      "Repair Candidate SQLite value is missing",
      "repair-invalid",
      (runs) => {
        runs.find(
          (run) => run.id === "run-repair",
        ).transaction.sqlite.candidate.rows = [];
      },
    ],
    [
      "Promotion effect delivered before Promotion began",
      "promotion-invalid",
      (runs) => {
        runs.find(
          (run) => run.id === "run-promotion",
        ).transaction.externalActions.intents[0].deliveredAt =
          "2026-08-28T10:00:01.050Z";
      },
    ],
    [
      "Promotion Canonical-advance evidence is missing",
      "promotion-invalid",
      (runs) => {
        const promotion = runs.find((run) => run.id === "run-promotion");
        promotion.transaction.events = promotion.transaction.events.filter(
          (event) =>
            event.summary !==
            "Canonical State advanced before external action delivery",
        );
      },
    ],
    [
      "Promotion Canonical-advance evidence is duplicated",
      "promotion-invalid",
      (runs) => {
        const promotion = runs.find((run) => run.id === "run-promotion");
        promotion.transaction.events.push(
          clone(
            promotion.transaction.events.find(
              (event) =>
                event.summary ===
                "Canonical State advanced before external action delivery",
            ),
          ),
        );
      },
    ],
    [
      "Promotion Canonical-advance evidence follows effect delivery",
      "promotion-invalid",
      (runs) => {
        runs
          .find((run) => run.id === "run-promotion")
          .transaction.events.find(
            (event) =>
              event.summary ===
              "Canonical State advanced before external action delivery",
          ).at = "2026-08-28T10:00:01.250Z";
      },
    ],
    [
      "Promotion Canonical-advance evidence has a malformed timestamp",
      "promotion-invalid",
      (runs) => {
        runs
          .find((run) => run.id === "run-promotion")
          .transaction.events.find(
            (event) =>
              event.summary ===
              "Canonical State advanced before external action delivery",
          ).at = "not-a-timestamp";
      },
    ],
    [
      "Quarantine changes Canonical fingerprint",
      "quarantine-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-quarantine").transaction.canonicalContentHashAfter = digest("f");
      },
    ],
    [
      "Quarantine required Validation passes",
      "quarantine-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-quarantine").transaction.validations[0].status = "passed";
      },
    ],
    [
      "Quarantine resource promoted",
      "quarantine-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-quarantine").transaction.resources[0].disposition = "promoted";
      },
    ],
    [
      "Quarantine protocol file evidence is missing",
      "quarantine-invalid",
      (runs) => {
        runs.find(
          (run) => run.id === "run-quarantine",
        ).transaction.changes.files = [];
      },
    ],
    [
      "Quarantine delivers an effect",
      "quarantine-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-quarantine").transaction.externalActions.deliveredCount = 1;
      },
    ],
    [
      "Repair parent differs from rejected root",
      "repair-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-repair").transaction.lineage.parentRunId = "run-other";
      },
    ],
    [
      "Repair required Validation failed",
      "repair-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-repair").transaction.validations[0].status = "failed";
      },
    ],
    [
      "Repair journal incomplete",
      "repair-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-repair").transaction.recovery.journalPhase = "promoting";
      },
    ],
    [
      "Repair reuses rejected idempotency key",
      "repair-invalid",
      (runs) => {
        runs.find((run) => run.id === "run-repair").transaction.externalActions.intents[0].idempotencyKey = "effect-quarantine";
      },
    ],
  ];

  for (const [name, failureClass, mutate] of contradictions) {
    await context.test(name, () => {
      const runSet = makeRunSet();
      const runs = apiRuns(runSet);
      mutate(runs);
      assert.throws(
        () =>
          verifyRuntimeProofRuns({
            agent: {
              id: "agent-runtime-proof",
              canonicalStateId: "state-initial",
            },
            runs,
          }),
        (error) =>
          error instanceof RuntimeProofError &&
          error.failureClass === failureClass,
      );
    });
  }
});

test("rechecks the final ordinary Run set after the browser verdict", async () => {
  const runSet = makeRunSet();
  const extra = { ...clone(runSet.promotion), id: "run-after-verdict" };
  const events = [];
  await expectFailure(
    runRuntimeProofSession({
      baseUrl: "http://127.0.0.1:3222",
      artifactRoot: "/bounded-test-root",
      readinessDigest,
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture(apiRuns(runSet), {
        finalRuns: [...apiRuns(runSet), extra],
      }),
      verifyChain: async () => verifiedChainReport(),
      writeArtifacts: async () => assert.fail("contradictory Runs cannot publish"),
    }),
    "run-set-invalid",
  );
  assert.equal(events.at(-1), "closed");
});

test("rejects an ID-stable Run projection change after the browser verdict", async () => {
  const runSet = makeRunSet();
  const finalRunSet = clone(runSet);
  finalRunSet.promotion.transaction.events[0].summary =
    "Changed after the visible verdict";
  const events = [];
  await expectFailure(
    runRuntimeProofSession({
      baseUrl: "http://127.0.0.1:3222",
      artifactRoot: "/bounded-test-root",
      readinessDigest,
      browserDriver: browserFixture(events),
      fetchImpl: fetchFixture(apiRuns(runSet), {
        finalRuns: apiRuns(finalRunSet),
      }),
      verifyChain: async () => verifiedChainReport(),
      writeArtifacts: async () =>
        assert.fail("changed Run evidence cannot publish"),
    }),
    "run-set-invalid",
  );
  assert.equal(events.at(-1), "closed");
});

test("stopped snapshot rejects persisted state created after the live final recheck", async () => {
  const temporaryProject = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-stopped-snapshot-"),
  );
  const artifactRoot = path.join(
    temporaryProject,
    ".local",
    "runtime-proof",
  );
  try {
    await initializeRuntimeProofRoot({
      projectRoot: temporaryProject,
      artifactRoot,
    });
    const session = await createRuntimeProofSessionRoot({ artifactRoot });
    const dataDirectory = path.join(session.sessionRoot, "data");
    await mkdir(dataDirectory, { mode: 0o755 });
    const runSet = makeRunSet();
    const result = buildRuntimeProofResult({
      observedAt,
      readinessDigest,
      runs: runSet,
      chainDigest: sourceDigest(decisionChainSource(runSet)),
      leafReceiptDigest,
    });
    const persistedAgent = {
      id: "agent-runtime-proof",
      name: realRuntimeProofAgentName,
      canonicalStateId: runSet.repair.transaction.canonicalStateIdAfter,
      outcomeContract: outcomeContract(),
    };
    const database = {
      version: 10,
      agents: [persistedAgent],
      messages: [],
      runs: apiRuns(runSet),
      candidateSets: [],
      assuranceProposals: [],
      outcomeContractVersions: [],
    };
    await writeFile(
      path.join(dataDirectory, "launchpad.json"),
      JSON.stringify(database) + "\n",
      { mode: 0o600 },
    );
    await assertStoppedRuntimeProofSnapshot({
      artifactRoot,
      sessionRoot: session.sessionRoot,
      nonce: session.nonce,
      result,
    });

    database.agents.push({
      ...persistedAgent,
      id: "agent-created-after-final-live-recheck",
      name: "Unrelated Agent",
    });
    await writeFile(
      path.join(dataDirectory, "launchpad.json"),
      JSON.stringify(database) + "\n",
      { mode: 0o600 },
    );
    await expectFailure(
      assertStoppedRuntimeProofSnapshot({
        artifactRoot,
        sessionRoot: session.sessionRoot,
        nonce: session.nonce,
        result,
      }),
      "run-set-invalid",
    );

    database.agents.pop();
    database.runs.push({
      ...clone(runSet.promotion),
      id: "run-created-after-final-live-recheck",
    });
    await writeFile(
      path.join(dataDirectory, "launchpad.json"),
      JSON.stringify(database) + "\n",
      { mode: 0o600 },
    );
    await expectFailure(
      assertStoppedRuntimeProofSnapshot({
        artifactRoot,
        sessionRoot: session.sessionRoot,
        nonce: session.nonce,
        result,
      }),
      "run-set-invalid",
    );
  } finally {
    await rm(temporaryProject, { recursive: true, force: true });
  }
});

test("rejects invalid and contradictory signed chains", async (context) => {
  await context.test("offline verifier rejection", async () => {
    const events = [];
    await expectFailure(
      runRuntimeProofSession({
        baseUrl: "http://127.0.0.1:3222",
        artifactRoot: "/bounded-test-root",
        readinessDigest,
        browserDriver: browserFixture(events),
        fetchImpl: fetchFixture(apiRuns(makeRunSet())),
        verifyChain: async () => ({ ...verifiedChainReport(), valid: false }),
        writeArtifacts: async () => assert.fail("invalid chain cannot publish"),
      }),
      "chain-invalid",
    );
  });

  await context.test("offline verifier exception", async () => {
    const events = [];
    await expectFailure(
      runRuntimeProofSession({
        baseUrl: "http://127.0.0.1:3222",
        artifactRoot: "/bounded-test-root",
        readinessDigest,
        browserDriver: browserFixture(events),
        fetchImpl: fetchFixture(apiRuns(makeRunSet())),
        verifyChain: async () => {
          throw new Error("raw verifier output must not escape");
        },
        writeArtifacts: async () => assert.fail("invalid chain cannot publish"),
      }),
      "chain-invalid",
    );
  });

  await context.test("receipt handoff contradiction", async () => {
    const runSet = makeRunSet();
    const chain = JSON.parse(decisionChainSource(runSet));
    chain.packets[1].envelope.receipt.ancestry.previousReceiptDigest = digest("0");
    const events = [];
    await expectFailure(
      runRuntimeProofSession({
        baseUrl: "http://127.0.0.1:3222",
        artifactRoot: "/bounded-test-root",
        readinessDigest,
        browserDriver: browserFixture(events, JSON.stringify(chain)),
        fetchImpl: fetchFixture(apiRuns(runSet)),
        verifyChain: async () => verifiedChainReport(),
        writeArtifacts: async () => assert.fail("contradictory chain cannot publish"),
      }),
      "chain-invalid",
    );
  });
});

test("preserves distinct browser, viewport, verifier, interruption, and cleanup failures", async (context) => {
  for (const [name, failureClass, method] of [
    ["browser invocation", "browser-failed", "invokeCompleteSafetyLoop"],
    ["recording viewport", "viewport-invalid", "assertRecordingBoard"],
    ["zero-upload verifier", "verifier-invalid", "captureAndInspectDecisionChain"],
  ]) {
    await context.test(name, async () => {
      const events = [];
      const browser = browserFixture(events);
      browser[method] = async () => {
        throw new RuntimeProofError(failureClass);
      };
      await expectFailure(
        runRuntimeProofSession({
          baseUrl: "http://127.0.0.1:3222",
          artifactRoot: "/bounded-test-root",
          readinessDigest,
          browserDriver: browser,
          fetchImpl: fetchFixture(apiRuns(makeRunSet())),
          verifyChain: async () => verifiedChainReport(),
          writeArtifacts: async () => assert.fail("failed browser gate cannot publish"),
        }),
        failureClass,
      );
      assert.equal(events.at(-1), "closed");
    });
  }

  await context.test("interruption", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = [];
    await expectFailure(
      runRuntimeProofSession({
        baseUrl: "http://127.0.0.1:3222",
        artifactRoot: "/bounded-test-root",
        readinessDigest,
        browserDriver: browserFixture(events),
        fetchImpl: fetchFixture(apiRuns(makeRunSet())),
        verifyChain: async () => verifiedChainReport(),
        writeArtifacts: async () => assert.fail("interruption cannot publish"),
        signal: controller.signal,
      }),
      "interrupted",
    );
    assert.deepEqual(events, ["closed"]);
  });

  await context.test("Chrome close failure precedes publication", async () => {
    const browser = browserFixture([]);
    browser.close = async () => {
      throw new Error("close failed");
    };
    let published = false;
    await expectFailure(
      runRuntimeProofSession({
        baseUrl: "http://127.0.0.1:3222",
        artifactRoot: "/bounded-test-root",
        readinessDigest,
        browserDriver: browser,
        fetchImpl: fetchFixture(apiRuns(makeRunSet())),
        verifyChain: async () => verifiedChainReport(),
        writeArtifacts: async () => {
          published = true;
        },
      }),
      "cleanup-failed",
    );
    assert.equal(published, false);
  });
});

test("safe failure capsules redact raw errors and reject secret-shaped success data", () => {
  const failure = safeRuntimeProofFailure(
    new RuntimeProofError(
      "browser-failed",
      "Bearer ark-secret at /Users/example/private",
    ),
  );
  assert.deepEqual(failure, {
    schema: "agent-airlock/real-runtime-proof-result",
    schemaVersion: 1,
    outcome: "failed",
    failureClass: "browser-failed",
    message:
      "Chrome could not invoke or observe the production complete safety loop.",
  });
  assert.doesNotMatch(JSON.stringify(failure), /Bearer|ark-secret|\/Users\//);

  const runs = verifyRuntimeProofRuns({
    agent: {
      id: "agent-runtime-proof",
      canonicalStateId: "state-initial",
    },
    runs: apiRuns(makeRunSet()),
  });
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs,
    chainDigest: sourceDigest(decisionChainSource()),
    leafReceiptDigest,
  });
  const unsafe = clone(result);
  unsafe.runs.promotion.runId = "ark-secret-value";
  assert.throws(
    () => assertSafeRuntimeProofResult(unsafe),
    (error) =>
      error instanceof RuntimeProofError &&
      error.failureClass === "artifact-write-failed",
  );
});

test("CLI rejects a port with trailing input through the bounded JSON failure", async () => {
  let failure;
  try {
    await execFile(process.execPath, ["scripts/prove-runtime.mjs", "--json"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AIRLOCK_RUNTIME_PROOF_PORT: "3222junk",
      },
      timeout: 10_000,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.deepEqual(JSON.parse(failure.stdout), {
    schema: "agent-airlock/real-runtime-proof-result",
    schemaVersion: 1,
    outcome: "failed",
    failureClass: "startup-failed",
    message: "The fresh real Runtime proof launcher did not reach its admitted ready state.",
  });
  assert.doesNotMatch(failure.stderr, /3222junk|\/Users\//);
});

test("CLI never repeats an unknown option that contains sensitive text", async () => {
  let failure;
  const sensitiveOption =
    "--https://ark.example.invalid/ep-sensitive?prompt=/Users/operator/private";
  try {
    await execFile(process.execPath, ["scripts/prove-runtime.mjs", sensitiveOption], {
      cwd: projectRoot,
      timeout: 10_000,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.stdout, "");
  assert.equal(failure.stderr, "Unknown real Runtime proof option.\n");
  assert.doesNotMatch(failure.stderr, /https?:|ep-sensitive|prompt=|\/Users\//);
});

test("CLI reset fails closed on a stale proof lease without deleting it", async () => {
  const localRoot = path.join(projectRoot, ".local");
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  const ownerRoot = await mkdtemp(
    path.join(localRoot, "runtime-proof-stale-lease-"),
  );
  const artifactRoot = path.join(ownerRoot, "proof");
  const leasePath = path.join(artifactRoot, ".active-proof.json");
  const leaseSource =
    JSON.stringify({
      schema: "agent-airlock/runtime-proof-lease",
      schemaVersion: 1,
      ownerPid: 999_999_999,
      nonce: "12345678-1234-1234-1234-123456789abc",
    }) + "\n";
  try {
    await initializeRuntimeProofRoot({ projectRoot, artifactRoot });
    await writeFile(leasePath, leaseSource, { mode: 0o600 });
    let failure;
    try {
      await execFile(
        process.execPath,
        ["scripts/prove-runtime.mjs", "--reset", "--json"],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            AIRLOCK_RUNTIME_PROOF_ROOT: artifactRoot,
          },
          timeout: 10_000,
        },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.deepEqual(JSON.parse(failure.stdout), {
      schema: "agent-airlock/real-runtime-proof-result",
      schemaVersion: 1,
      outcome: "failed",
      failureClass: "startup-failed",
      message:
        "The fresh real Runtime proof launcher did not reach its admitted ready state.",
    });
    assert.equal(await readFile(leasePath, "utf8"), leaseSource);
  } finally {
    await rm(ownerRoot, { recursive: true, force: true });
  }
});

test("CLI reset removes a marker-owned abandoned proof session", async () => {
  const localRoot = path.join(projectRoot, ".local");
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  const ownerRoot = await mkdtemp(
    path.join(localRoot, "runtime-proof-abandoned-session-"),
  );
  const artifactRoot = path.join(ownerRoot, "proof");
  const sessionsRoot = path.join(artifactRoot, "sessions");
  const nonce = "12345678-1234-1234-1234-123456789abc";
  const abandonedSession = path.join(
    sessionsRoot,
    `session-999999999-${nonce}`,
  );
  try {
    await initializeRuntimeProofRoot({ projectRoot, artifactRoot });
    await mkdir(abandonedSession, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(
        abandonedSession,
        ".agent-airlock-runtime-proof-session.json",
      ),
      JSON.stringify({
        schema: "agent-airlock/runtime-proof-session",
        schemaVersion: 1,
        ownerPid: 999_999_999,
        nonce,
      }) + "\n",
      { mode: 0o600 },
    );
    let failure;
    try {
      await execFile(
        process.execPath,
        ["scripts/prove-runtime.mjs", "--reset", "--json"],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            AIRLOCK_RUNTIME_PROOF_ROOT: artifactRoot,
            CONTAINER_ENGINE: "agent-airlock-missing-container-engine",
          },
          timeout: 10_000,
        },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(JSON.parse(failure.stdout).failureClass, "runtime-unavailable");
    assert.equal(
      await lstat(abandonedSession).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      }),
      null,
    );
    assert.equal(
      await lstat(path.join(artifactRoot, ".active-proof.json")).catch(
        (error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        },
      ),
      null,
    );
  } finally {
    await rm(ownerRoot, { recursive: true, force: true });
  }
});

test("publication commits before proof ownership is released", async () => {
  const events = [];
  const publication = await finalizeRuntimeProofPublication({
    releaseOwnership: async () => {
      events.push("lease-released");
    },
    publishArtifacts: async ({ beforeCommit, afterCommit }) => {
      events.push("chain-installed");
      beforeCommit();
      events.push("capsule-committed");
      afterCommit();
    },
  });
  assert.deepEqual(events, [
    "chain-installed",
    "capsule-committed",
    "lease-released",
  ]);
  assert.deepEqual(publication, {
    committed: true,
    cleanupIncomplete: false,
  });
});

test("publication rechecks the recording deadline at the commit boundary", async () => {
  const events = [];
  let clock = 1_000;
  await expectFailure(
    finalizeRuntimeProofPublication({
      recordingDeadlineAt: 2_000,
      now: () => clock,
      releaseOwnership: async () => {
        events.push("lease-released");
      },
      publishArtifacts: async ({ beforeCommit, afterCommit }) => {
        events.push("chain-installed");
        clock = 2_000;
        beforeCommit();
        events.push("capsule-committed");
        afterCommit();
      },
    }),
    "recording-timeout",
  );
  assert.deepEqual(events, ["chain-installed", "lease-released"]);
});

test("publication rejects source drift before the capsule pointer can commit", async () => {
  const events = [];
  await expectFailure(
    finalizeRuntimeProofPublication({
      releaseOwnership: async () => {
        events.push("lease-released");
      },
      beforePublicationCommit: () => {
        events.push("source-rechecked");
        throw new RuntimeProofError("source-unverified");
      },
      publishArtifacts: async ({ beforeCommit, afterCommit }) => {
        events.push("chain-installed");
        beforeCommit();
        events.push("capsule-committed");
        afterCommit();
      },
    }),
    "source-unverified",
  );
  assert.deepEqual(events, [
    "chain-installed",
    "source-rechecked",
    "lease-released",
  ]);
});

test("a lease-release failure cannot revoke a valid publication commit", async () => {
  const events = [];
  const publication = await finalizeRuntimeProofPublication({
    releaseOwnership: async () => {
      events.push("lease-release-attempted");
      throw new RuntimeProofError("cleanup-failed");
    },
    publishArtifacts: async ({ beforeCommit, afterCommit }) => {
      beforeCommit();
      events.push("capsule-committed");
      afterCommit();
    },
  });
  assert.deepEqual(events, ["capsule-committed", "lease-release-attempted"]);
  assert.deepEqual(publication, {
    committed: true,
    cleanupIncomplete: true,
  });
});

test("an interruption before the capsule commit preserves the lease until cleanup", async () => {
  const controller = new AbortController();
  const events = [];
  await expectFailure(
    finalizeRuntimeProofPublication({
      signal: controller.signal,
      releaseOwnership: async () => {
        events.push("lease-released");
      },
      publishArtifacts: async ({ beforeCommit }) => {
        events.push("chain-installed");
        controller.abort();
        beforeCommit();
        events.push("capsule-committed");
      },
    }),
    "interrupted",
  );
  assert.deepEqual(events, ["chain-installed", "lease-released"]);
});

test("an interruption after the capsule commit does not revoke committed proof", async () => {
  const controller = new AbortController();
  const events = [];
  const publication = await finalizeRuntimeProofPublication({
    signal: controller.signal,
    releaseOwnership: async () => {
      events.push("lease-released");
    },
    publishArtifacts: async ({ beforeCommit, afterCommit }) => {
      beforeCommit();
      events.push("capsule-committed");
      afterCommit();
      controller.abort();
    },
  });
  assert.deepEqual(events, ["capsule-committed", "lease-released"]);
  assert.deepEqual(publication, {
    committed: true,
    cleanupIncomplete: false,
  });
});

function alternateArtifact(previousResult, version = 2) {
  const chainSource = JSON.stringify({
    schema: "agent-airlock/portable-decision-chain",
    schemaVersion: 1,
    packets: [{ version }, { version }],
  });
  return {
    chainSource,
    result: {
      ...clone(previousResult),
      observedAt: "2026-08-28T10:05:00.000Z",
      chainDigest: sourceDigest(chainSource),
      chainFile: runtimeProofChainFile(sourceDigest(chainSource)),
    },
  };
}

const realFs = {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
};

test("a commit response lost before rename preserves the prior pair", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-rollback-"),
  );
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const runs = verifyRuntimeProofRuns({
    agent: {
      id: "agent-runtime-proof",
      canonicalStateId: "state-initial",
    },
    runs: apiRuns(runSet),
  });
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs,
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  try {
    const paths = await writeRuntimeProofArtifacts({
      artifactRoot,
      chainSource,
      result,
    });
    const priorChain = await readFile(paths.chainPath);
    const priorResult = await readFile(paths.resultPath);
    const alternate = alternateArtifact(result);
    const failOnceArtifactIo = async (anchor, request) => {
      if (
        request.operation === "commit-replace" &&
        request.name === path.basename(paths.resultPath)
      ) {
        throw new RuntimeProofError("artifact-write-failed");
      }
      return runRuntimeProofArtifactWorker(anchor, request);
    };
    await expectFailure(
      writeRuntimeProofArtifacts({
        artifactRoot,
        ...alternate,
        artifactIo: failOnceArtifactIo,
      }),
      "artifact-write-failed",
    );
    assert.deepEqual(await readFile(paths.chainPath), priorChain);
    assert.deepEqual(await readFile(paths.resultPath), priorResult);
    assert.equal(
      await recoverRuntimeProofArtifactPublication({ artifactRoot }),
      false,
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("a live commit worker killed after linking but before rename preserves the prior pair", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-precommit-interrupt-"),
  );
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const runs = verifyRuntimeProofRuns({
    agent: {
      id: "agent-runtime-proof",
      canonicalStateId: "state-initial",
    },
    runs: apiRuns(runSet),
  });
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs,
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  const controller = new AbortController();
  let linkedGateObserved = false;
  let stoppedCommitWorkerPid = null;
  let stoppedCommitWorkerSignal = null;
  try {
    const paths = await writeRuntimeProofArtifacts({
      artifactRoot,
      chainSource,
      result,
    });
    const priorResult = await readFile(paths.resultPath);
    const alternate = alternateArtifact(result);
    const interruptingArtifactIo = async (anchor, request, options) => {
      if (
        request.operation === "commit-replace" &&
        request.name === RUNTIME_PROOF_RESULT_NAME
      ) {
        const spawnLinkedWorker = (command, argumentsList, spawnOptions) => {
          const child = spawn(command, argumentsList, {
            ...spawnOptions,
            env: {
              ...spawnOptions.env,
              AGENT_AIRLOCK_TEST_PAUSE_AFTER_COMMIT_LINK: "1",
            },
            stdio: [...spawnOptions.stdio, "pipe"],
          });
          stoppedCommitWorkerPid = child.pid;
          child.once("close", (_code, signalName) => {
            stoppedCommitWorkerSignal = signalName;
          });
          child.stdio[4].once("data", (chunk) => {
            linkedGateObserved = chunk.toString("utf8") === "linked\n";
            controller.abort();
          });
          return child;
        };
        return runRuntimeProofArtifactWorker(
          anchor,
          {
            ...request,
            testPauseAfterLink: true,
          },
          {
            ...(options ?? {}),
            spawnImpl: spawnLinkedWorker,
          },
        );
      }
      return runRuntimeProofArtifactWorker(anchor, request, options);
    };
    await expectFailure(
      finalizeRuntimeProofPublication({
        signal: controller.signal,
        releaseOwnership: async () => {},
        publishArtifacts: ({ beforeCommit, afterCommit }) =>
          writeRuntimeProofArtifacts({
            artifactRoot,
            ...alternate,
            beforeCommit,
            afterCommit,
            artifactIo: interruptingArtifactIo,
          }),
      }),
      "interrupted",
    );
    assert.equal(linkedGateObserved, true);
    assert.ok(Number.isInteger(stoppedCommitWorkerPid));
    assert.equal(stoppedCommitWorkerSignal, "SIGKILL");
    assert.deepEqual(
      (
        await readdir(
          path.join(artifactRoot, RUNTIME_PROOF_EVIDENCE_DIRECTORY),
        )
      ).filter((name) => name.startsWith(".runtime-proof-tmp-")),
      [],
    );
    assert.deepEqual(await readFile(paths.resultPath), priorResult);
    const resolved = await resolveRuntimeProofArtifactPaths({ artifactRoot });
    assert.deepEqual(
      JSON.parse(await readFile(resolved.resultPath, "utf8")),
      result,
    );
    assert.equal(await readFile(resolved.chainPath, "utf8"), chainSource);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("post-rename response loss and cleanup failure preserve the committed pair", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-postcommit-interrupt-"),
  );
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const runs = verifyRuntimeProofRuns({
    agent: {
      id: "agent-runtime-proof",
      canonicalStateId: "state-initial",
    },
    runs: apiRuns(runSet),
  });
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs,
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  const controller = new AbortController();
  try {
    await writeRuntimeProofArtifacts({ artifactRoot, chainSource, result });
    const alternate = alternateArtifact(result);
    const resultPath = path.join(
      artifactRoot,
      RUNTIME_PROOF_EVIDENCE_DIRECTORY,
      RUNTIME_PROOF_RESULT_NAME,
    );
    const interruptingArtifactIo = async (anchor, request, options) => {
      const response = await runRuntimeProofArtifactWorker(
        anchor,
        request,
        options,
      );
      if (
        request.operation === "commit-replace" &&
        request.name === path.basename(resultPath)
      ) {
        controller.abort();
        throw new RuntimeProofError("interrupted");
      }
      return response;
    };
    const publication = await finalizeRuntimeProofPublication({
      signal: controller.signal,
      releaseOwnership: async () => {
        throw new RuntimeProofError("cleanup-failed");
      },
      publishArtifacts: ({ beforeCommit, afterCommit }) =>
        writeRuntimeProofArtifacts({
          artifactRoot,
          ...alternate,
          beforeCommit,
          afterCommit,
          artifactIo: interruptingArtifactIo,
        }),
    });
    assert.deepEqual(publication, {
      committed: true,
      cleanupIncomplete: true,
    });
    const resolved = await resolveRuntimeProofArtifactPaths({ artifactRoot });
    assert.deepEqual(JSON.parse(await readFile(resolved.resultPath, "utf8")), alternate.result);
    assert.equal(await readFile(resolved.chainPath, "utf8"), alternate.chainSource);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("the release resolver returns exactly one validated capsule and its immutable chain", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-resolver-"),
  );
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const runs = verifyRuntimeProofRuns({
    agent: {
      id: "agent-runtime-proof",
      canonicalStateId: "state-initial",
    },
    runs: apiRuns(runSet),
  });
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs,
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  try {
    const first = await writeRuntimeProofArtifacts({
      artifactRoot,
      chainSource,
      result,
    });
    const firstResolved = await resolveRuntimeProofArtifactPaths({ artifactRoot });
    assert.deepEqual(
      JSON.parse(await readFile(firstResolved.resultPath, "utf8")),
      result,
    );
    assert.equal(firstResolved.chainPath, first.chainPath);
    assert.equal(
      path.basename(path.dirname(firstResolved.resultPath)),
      "capsules",
    );

    const alternate = alternateArtifact(result);
    const second = await writeRuntimeProofArtifacts({
      artifactRoot,
      ...alternate,
    });
    const secondResolved = await resolveRuntimeProofArtifactPaths({ artifactRoot });
    assert.deepEqual(
      JSON.parse(await readFile(secondResolved.resultPath, "utf8")),
      alternate.result,
    );
    assert.equal(secondResolved.chainPath, second.chainPath);
    assert.equal(await readFile(first.chainPath, "utf8"), chainSource);
    assert.notEqual(first.chainPath, second.chainPath);
    await chmod(secondResolved.resultPath, 0o644);
    await expectFailure(
      resolveRuntimeProofArtifactPaths({ artifactRoot }),
      "artifact-write-failed",
    );
    await chmod(secondResolved.resultPath, 0o600);
    await chmod(second.chainPath, 0o644);
    await expectFailure(
      resolveRuntimeProofArtifactPaths({ artifactRoot }),
      "artifact-write-failed",
    );
    await chmod(second.chainPath, 0o600);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("the resolver pins an immutable capsule when latest changes mid-validation", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-resolver-concurrent-"),
  );
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const runs = verifyRuntimeProofRuns({
    agent: {
      id: "agent-runtime-proof",
      canonicalStateId: "state-initial",
    },
    runs: apiRuns(runSet),
  });
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs,
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  const alternate = alternateArtifact(result);
  try {
    await writeRuntimeProofArtifacts({ artifactRoot, chainSource, result });
    let swapped = false;
    const interleavingArtifactIo = async (anchor, request) => {
      const response = await runRuntimeProofArtifactWorker(anchor, request);
      if (
        !swapped &&
        request.operation === "read" &&
        request.name === RUNTIME_PROOF_RESULT_NAME
      ) {
        swapped = true;
        await writeRuntimeProofArtifacts({ artifactRoot, ...alternate });
      }
      return response;
    };
    const resolved = await resolveRuntimeProofArtifactPaths({
      artifactRoot,
      artifactIo: interleavingArtifactIo,
    });
    assert.equal(swapped, true);
    assert.deepEqual(JSON.parse(await readFile(resolved.resultPath, "utf8")), result);
    assert.equal(await readFile(resolved.chainPath, "utf8"), chainSource);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(
            artifactRoot,
            RUNTIME_PROOF_EVIDENCE_DIRECTORY,
            RUNTIME_PROOF_RESULT_NAME,
          ),
          "utf8",
        ),
      ),
      alternate.result,
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("the release resolver fails closed on a symlinked capsule", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-resolver-link-"),
  );
  const outside = path.join(artifactRoot, "outside.json");
  const evidenceDirectory = path.join(
    artifactRoot,
    RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  );
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
    await writeFile(outside, "{}", { mode: 0o600 });
    await symlink(
      outside,
      path.join(evidenceDirectory, RUNTIME_PROOF_RESULT_NAME),
    );
    await expectFailure(
      resolveRuntimeProofArtifactPaths({ artifactRoot }),
      "artifact-write-failed",
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("the release resolver rejects a symlinked chains directory", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-resolver-chain-dir-"),
  );
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-external-chains-"),
  );
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs: verifyRuntimeProofRuns({
      agent: {
        id: "agent-runtime-proof",
        canonicalStateId: "state-initial",
      },
      runs: apiRuns(runSet),
    }),
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  try {
    const paths = await writeRuntimeProofArtifacts({
      artifactRoot,
      chainSource,
      result,
    });
    const chainDirectory = path.dirname(paths.chainPath);
    await writeFile(
      path.join(outside, path.basename(paths.chainPath)),
      await readFile(paths.chainPath),
      { mode: 0o600 },
    );
    await rm(chainDirectory, { recursive: true, force: true });
    await symlink(outside, chainDirectory, "dir");
    await expectFailure(
      resolveRuntimeProofArtifactPaths({ artifactRoot }),
      "artifact-write-failed",
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("the release resolver pins the validated evidence directory identity", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-resolver-swap-"),
  );
  const outsideRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-resolver-outside-"),
  );
  const evidenceDirectory = path.join(
    artifactRoot,
    RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  );
  const heldEvidenceDirectory = path.join(artifactRoot, "evidence-held");
  const outsideEvidenceDirectory = path.join(outsideRoot, "evidence");
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs: verifyRuntimeProofRuns({
      agent: {
        id: "agent-runtime-proof",
        canonicalStateId: "state-initial",
      },
      runs: apiRuns(runSet),
    }),
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  try {
    const paths = await writeRuntimeProofArtifacts({
      artifactRoot,
      chainSource,
      result,
    });
    const outsideChainDirectory = path.join(
      outsideEvidenceDirectory,
      RUNTIME_PROOF_CHAIN_DIRECTORY,
    );
    await mkdir(outsideChainDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(outsideEvidenceDirectory, RUNTIME_PROOF_RESULT_NAME),
      await readFile(paths.resultPath),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(outsideChainDirectory, path.basename(paths.chainPath)),
      await readFile(paths.chainPath),
      { mode: 0o600 },
    );
    let evidenceRealpathCalls = 0;
    const swappingFs = {
      ...realFs,
      async realpath(target) {
        if (target === evidenceDirectory) {
          evidenceRealpathCalls += 1;
          if (evidenceRealpathCalls === 2) {
            await rename(evidenceDirectory, heldEvidenceDirectory);
            await symlink(outsideEvidenceDirectory, evidenceDirectory, "dir");
          }
        }
        return realpath(target);
      },
    };
    await expectFailure(
      resolveRuntimeProofArtifactPaths({
        artifactRoot,
        fsImpl: swappingFs,
      }),
      "artifact-write-failed",
    );
    assert.equal((await lstat(evidenceDirectory)).isSymbolicLink(), true);
    assert.equal(
      await readFile(
        path.join(outsideEvidenceDirectory, RUNTIME_PROOF_RESULT_NAME),
        "utf8",
      ),
      await readFile(paths.resultPath.replace(evidenceDirectory, heldEvidenceDirectory), "utf8"),
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("publication rejects a symlinked content-addressed chain before capsule commit", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-chain-link-"),
  );
  const evidenceDirectory = path.join(
    artifactRoot,
    RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  );
  const chainDirectory = path.join(
    evidenceDirectory,
    RUNTIME_PROOF_CHAIN_DIRECTORY,
  );
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs: verifyRuntimeProofRuns({
      agent: {
        id: "agent-runtime-proof",
        canonicalStateId: "state-initial",
      },
      runs: apiRuns(runSet),
    }),
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  const outside = path.join(artifactRoot, "outside-chain.json");
  const chainPath = path.join(evidenceDirectory, result.chainFile);
  const resultPath = path.join(evidenceDirectory, RUNTIME_PROOF_RESULT_NAME);
  try {
    await mkdir(chainDirectory, { recursive: true, mode: 0o700 });
    await writeFile(outside, chainSource, { mode: 0o600 });
    await symlink(outside, chainPath);
    await expectFailure(
      writeRuntimeProofArtifacts({ artifactRoot, chainSource, result }),
      "artifact-write-failed",
    );
    await assert.rejects(lstat(resultPath), { code: "ENOENT" });
    assert.equal(await readFile(outside, "utf8"), chainSource);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("publication pins the validated chains directory before installing authority", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-chain-swap-"),
  );
  const outsideRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-chain-outside-"),
  );
  const evidenceDirectory = path.join(
    artifactRoot,
    RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  );
  const chainDirectory = path.join(
    evidenceDirectory,
    RUNTIME_PROOF_CHAIN_DIRECTORY,
  );
  const heldChainDirectory = path.join(evidenceDirectory, "chains-held");
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs: verifyRuntimeProofRuns({
      agent: {
        id: "agent-runtime-proof",
        canonicalStateId: "state-initial",
      },
      runs: apiRuns(runSet),
    }),
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  const chainPath = path.join(evidenceDirectory, result.chainFile);
  const resultPath = path.join(evidenceDirectory, RUNTIME_PROOF_RESULT_NAME);
  let swapped = false;
  const swappingArtifactIo = async (anchor, request) => {
    if (
      anchor.directoryPath === chainDirectory &&
      request.operation === "read" &&
      request.name === path.basename(chainPath) &&
      !swapped
    ) {
        swapped = true;
        await rename(chainDirectory, heldChainDirectory);
        await symlink(outsideRoot, chainDirectory, "dir");
    }
    return runRuntimeProofArtifactWorker(anchor, request);
  };
  try {
    await expectFailure(
      writeRuntimeProofArtifacts({
        artifactRoot,
        chainSource,
        result,
        artifactIo: swappingArtifactIo,
      }),
      "artifact-write-failed",
    );
    assert.equal(swapped, true);
    await assert.rejects(lstat(resultPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(outsideRoot, path.basename(chainPath))), {
      code: "ENOENT",
    });
    assert.equal((await lstat(chainDirectory)).isSymbolicLink(), true);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("legacy fixed-name proof artifacts migrate to an immutable chain", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-migration-"),
  );
  const evidenceDirectory = path.join(
    artifactRoot,
    RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  );
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const runs = verifyRuntimeProofRuns({
    agent: {
      id: "agent-runtime-proof",
      canonicalStateId: "state-initial",
    },
    runs: apiRuns(runSet),
  });
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs,
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  const legacyChainPath = path.join(
    evidenceDirectory,
    "real-runtime-decision-chain.latest.json",
  );
  const resultPath = path.join(evidenceDirectory, RUNTIME_PROOF_RESULT_NAME);
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
    await writeFile(legacyChainPath, chainSource, { mode: 0o600 });
    await writeFile(
      resultPath,
      JSON.stringify({
        ...result,
        chainFile: "real-runtime-decision-chain.latest.json",
      }) + "\n",
      { mode: 0o600 },
    );
    assert.equal(
      await recoverRuntimeProofArtifactPublication({ artifactRoot }),
      true,
    );
    const resolved = await resolveRuntimeProofArtifactPaths({ artifactRoot });
    assert.equal(await readFile(resolved.chainPath, "utf8"), chainSource);
    assert.deepEqual(JSON.parse(await readFile(resolved.resultPath, "utf8")), result);
    await assert.rejects(stat(legacyChainPath), { code: "ENOENT" });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("legacy migration rejects a symlinked input without mutating the last good capsule", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-legacy-input-link-"),
  );
  const outsideRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-legacy-input-outside-"),
  );
  const evidenceDirectory = path.join(
    artifactRoot,
    RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  );
  const legacyChainPath = path.join(
    evidenceDirectory,
    "real-runtime-decision-chain.latest.json",
  );
  const resultPath = path.join(evidenceDirectory, RUNTIME_PROOF_RESULT_NAME);
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs: verifyRuntimeProofRuns({
      agent: {
        id: "agent-runtime-proof",
        canonicalStateId: "state-initial",
      },
      runs: apiRuns(runSet),
    }),
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  const legacyResultSource =
    JSON.stringify({
      ...result,
      chainFile: "real-runtime-decision-chain.latest.json",
    }) + "\n";
  const outsideChainPath = path.join(outsideRoot, "chain.json");
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
    await writeFile(outsideChainPath, chainSource, { mode: 0o600 });
    await symlink(outsideChainPath, legacyChainPath);
    await writeFile(resultPath, legacyResultSource, { mode: 0o600 });
    await expectFailure(
      recoverRuntimeProofArtifactPublication({ artifactRoot }),
      "artifact-write-failed",
    );
    assert.equal(await readFile(resultPath, "utf8"), legacyResultSource);
    assert.equal((await lstat(legacyChainPath)).isSymbolicLink(), true);
    assert.equal(await readFile(outsideChainPath, "utf8"), chainSource);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("legacy migration validates an existing immutable chain before committing the capsule", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-legacy-target-link-"),
  );
  const outsideRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-legacy-target-outside-"),
  );
  const evidenceDirectory = path.join(
    artifactRoot,
    RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  );
  const chainDirectory = path.join(
    evidenceDirectory,
    RUNTIME_PROOF_CHAIN_DIRECTORY,
  );
  const legacyChainPath = path.join(
    evidenceDirectory,
    "real-runtime-decision-chain.latest.json",
  );
  const resultPath = path.join(evidenceDirectory, RUNTIME_PROOF_RESULT_NAME);
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs: verifyRuntimeProofRuns({
      agent: {
        id: "agent-runtime-proof",
        canonicalStateId: "state-initial",
      },
      runs: apiRuns(runSet),
    }),
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  const legacyResultSource =
    JSON.stringify({
      ...result,
      chainFile: "real-runtime-decision-chain.latest.json",
    }) + "\n";
  const outsideChainPath = path.join(outsideRoot, "chain.json");
  const destinationChainPath = path.join(
    evidenceDirectory,
    result.chainFile,
  );
  try {
    await mkdir(chainDirectory, { recursive: true, mode: 0o700 });
    await writeFile(legacyChainPath, chainSource, { mode: 0o600 });
    await writeFile(resultPath, legacyResultSource, { mode: 0o600 });
    await writeFile(outsideChainPath, chainSource, { mode: 0o600 });
    await symlink(outsideChainPath, destinationChainPath);
    await expectFailure(
      recoverRuntimeProofArtifactPublication({ artifactRoot }),
      "artifact-write-failed",
    );
    assert.equal(await readFile(resultPath, "utf8"), legacyResultSource);
    assert.equal(await readFile(legacyChainPath, "utf8"), chainSource);
    assert.equal((await lstat(destinationChainPath)).isSymbolicLink(), true);
    assert.equal(await readFile(outsideChainPath, "utf8"), chainSource);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("concurrent publications leave one complete capsule and both immutable chains", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-crash-"),
  );
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const runs = verifyRuntimeProofRuns({
    agent: {
      id: "agent-runtime-proof",
      canonicalStateId: "state-initial",
    },
    runs: apiRuns(runSet),
  });
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs,
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  try {
    const paths = await writeRuntimeProofArtifacts({
      artifactRoot,
      chainSource,
      result,
    });
    const first = alternateArtifact(result, 2);
    const second = alternateArtifact(result, 3);
    const [firstPaths, secondPaths] = await Promise.all([
      writeRuntimeProofArtifacts({
        artifactRoot,
        ...first,
      }),
      writeRuntimeProofArtifacts({
        artifactRoot,
        ...second,
      }),
    ]);
    assert.equal(await readFile(firstPaths.chainPath, "utf8"), first.chainSource);
    assert.equal(
      await readFile(secondPaths.chainPath, "utf8"),
      second.chainSource,
    );
    const resolved = await resolveRuntimeProofArtifactPaths({ artifactRoot });
    const selected = JSON.parse(await readFile(resolved.resultPath, "utf8"));
    assert.ok(
      selected.chainDigest === first.result.chainDigest ||
        selected.chainDigest === second.result.chainDigest,
    );
    assert.equal(
      resolved.chainPath,
      selected.chainDigest === first.result.chainDigest
        ? firstPaths.chainPath
        : secondPaths.chainPath,
    );
    assert.notEqual(paths.chainPath, firstPaths.chainPath);
    assert.notEqual(paths.chainPath, secondPaths.chainPath);
    assert.equal(
      await recoverRuntimeProofArtifactPublication({ artifactRoot }),
      false,
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("a legacy publication lock fails closed and is never removed", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-legacy-lock-"),
  );
  const evidenceDirectory = path.join(
    artifactRoot,
    RUNTIME_PROOF_EVIDENCE_DIRECTORY,
  );
  const lockPath = path.join(
    evidenceDirectory,
    ".real-runtime-proof-publication.lock",
  );
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
    await writeFile(lockPath, "legacy-owner\n", { mode: 0o600 });
    const before = await readFile(lockPath);
    await expectFailure(
      recoverRuntimeProofArtifactPublication({ artifactRoot }),
      "artifact-write-failed",
    );
    assert.deepEqual(await readFile(lockPath), before);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("a mismatched latest pair is never accepted for overwrite", async () => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-mismatch-"),
  );
  const runSet = makeRunSet();
  const chainSource = decisionChainSource(runSet);
  const runs = verifyRuntimeProofRuns({
    agent: {
      id: "agent-runtime-proof",
      canonicalStateId: "state-initial",
    },
    runs: apiRuns(runSet),
  });
  const result = buildRuntimeProofResult({
    observedAt,
    readinessDigest,
    runs,
    chainDigest: sourceDigest(chainSource),
    leafReceiptDigest,
  });
  try {
    const paths = await writeRuntimeProofArtifacts({
      artifactRoot,
      chainSource,
      result,
    });
    await writeFile(paths.chainPath, "{}", { mode: 0o600 });
    await expectFailure(
      writeRuntimeProofArtifacts({
        artifactRoot,
        ...alternateArtifact(result),
      }),
      "artifact-write-failed",
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("proof roots reject equal, parent, sibling-prefix, and symlink escapes", async () => {
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-project-"),
  );
  const localRoot = path.join(projectRoot, ".local");
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-outside-"),
  );
  try {
    await mkdir(localRoot, { mode: 0o700 });
    for (const candidate of [
      localRoot,
      projectRoot,
      path.join(projectRoot, ".locality", "proof"),
    ]) {
      assert.throws(
        () => assertSafeRuntimeProofRoot(projectRoot, candidate),
        (error) =>
          error instanceof RuntimeProofError &&
          error.failureClass === "startup-failed",
      );
    }
    const linkedParent = path.join(localRoot, "linked");
    await symlink(outside, linkedParent, "dir");
    await expectFailure(
      initializeRuntimeProofRoot({
        projectRoot,
        artifactRoot: path.join(linkedParent, "proof"),
      }),
      "startup-failed",
    );
    await assert.rejects(stat(path.join(outside, "proof")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("container fixture preflight never deletes a sessions owner used as state", async () => {
  const localRoot = path.join(projectRoot, ".local");
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  const artifactRoot = await mkdtemp(
    path.join(localRoot, "runtime-proof-fixture-containment-"),
  );
  const sessionsRoot = path.join(artifactRoot, "sessions");
  const sentinelPath = path.join(artifactRoot, "owner-sentinel.txt");
  const nonce = "12345678-1234-1234-1234-123456789abc";
  try {
    await mkdir(sessionsRoot, { mode: 0o700 });
    await writeFile(
      path.join(artifactRoot, ".agent-airlock-runtime-proof-root"),
      "Agent Airlock real Runtime proof artifacts\n",
      { mode: 0o600 },
    );
    await writeFile(sentinelPath, "must survive\n", { mode: 0o600 });
    let failure;
    try {
      await execFile(
        process.execPath,
        ["scripts/run-container-browser-fixture.mjs", "--demo", "--ephemeral"],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            AIRLOCK_RUNTIME_PROOF_ROOT: artifactRoot,
            AIRLOCK_RUNTIME_PROOF_SESSION_ROOT: sessionsRoot,
            AIRLOCK_RUNTIME_PROOF_SESSION_NONCE: nonce,
            AIRLOCK_RUNTIME_PROOF_OWNER_PID: String(process.pid),
          },
          timeout: 10_000,
        },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.match(
      failure.stderr,
      /managed Runtime proof session path is outside its owner root/,
    );
    assert.equal(await readFile(sentinelPath, "utf8"), "must survive\n");
    assert.equal((await stat(sessionsRoot)).isDirectory(), true);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("abandoned session cleanup purges only an exact marker-owned directory", async () => {
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-abandoned-cleanup-"),
  );
  const artifactRoot = path.join(projectRoot, ".local", "runtime-proof");
  const operations = [];
  try {
    await initializeRuntimeProofRoot({ projectRoot, artifactRoot });
    const session = await createRuntimeProofSessionRoot({ artifactRoot });
    await mkdir(path.join(session.sessionRoot, "nested"), { mode: 0o700 });
    await writeFile(
      path.join(session.sessionRoot, "nested", "candidate.txt"),
      "abandoned\n",
    );

    const result = await cleanupAbandonedRuntimeProofSessions({
      artifactRoot,
      processExists: () => false,
      artifactIo: async (anchor, request) => {
        operations.push(request.operation);
        return runRuntimeProofArtifactWorker(anchor, request);
      },
    });

    assert.deepEqual(result, { removedSessions: 1 });
    assert.deepEqual(
      operations.filter((operation) =>
        ["purge-private-directory", "remove-empty-private-directory"].includes(
          operation,
        ),
      ),
      ["purge-private-directory", "remove-empty-private-directory"],
    );
    await assert.rejects(stat(session.sessionRoot), { code: "ENOENT" });
    assert.equal(
      await readFile(
        path.join(artifactRoot, ".agent-airlock-runtime-proof-root"),
        "utf8",
      ),
      "Agent Airlock real Runtime proof artifacts\n",
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("abandoned session cleanup rejects a live marker owner without deleting state", async () => {
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-live-cleanup-"),
  );
  const artifactRoot = path.join(projectRoot, ".local", "runtime-proof");
  try {
    await initializeRuntimeProofRoot({ projectRoot, artifactRoot });
    const session = await createRuntimeProofSessionRoot({ artifactRoot });
    const retainedPath = path.join(session.sessionRoot, "retained.txt");
    await writeFile(retainedPath, "must survive\n");

    await expectFailure(
      cleanupAbandonedRuntimeProofSessions({ artifactRoot }),
      "startup-failed",
    );

    assert.equal(await readFile(retainedPath, "utf8"), "must survive\n");
    assert.equal((await stat(session.sessionRoot)).isDirectory(), true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("abandoned session cleanup fails closed when the session path is substituted before purge", async () => {
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-raced-cleanup-"),
  );
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-raced-target-"),
  );
  const artifactRoot = path.join(projectRoot, ".local", "runtime-proof");
  try {
    await initializeRuntimeProofRoot({ projectRoot, artifactRoot });
    const session = await createRuntimeProofSessionRoot({ artifactRoot });
    const markerPath = path.join(
      session.sessionRoot,
      ".agent-airlock-runtime-proof-session.json",
    );
    const originalMarker = await readFile(markerPath, "utf8");
    const retainedSession = `${session.sessionRoot}.retained`;
    const outsideSentinel = path.join(outside, "must-survive.txt");
    await writeFile(outsideSentinel, "must survive\n");
    let substituted = false;

    await expectFailure(
      cleanupAbandonedRuntimeProofSessions({
        artifactRoot,
        processExists: () => false,
        artifactIo: async (anchor, request) => {
          if (request.operation === "purge-private-directory" && !substituted) {
            substituted = true;
            await rename(session.sessionRoot, retainedSession);
            await symlink(outside, session.sessionRoot, "dir");
          }
          return runRuntimeProofArtifactWorker(anchor, request);
        },
      }),
      "cleanup-failed",
    );

    assert.equal(substituted, true);
    assert.equal(await readFile(outsideSentinel, "utf8"), "must survive\n");
    assert.equal(
      await readFile(
        path.join(
          retainedSession,
          ".agent-airlock-runtime-proof-session.json",
        ),
        "utf8",
      ),
      originalMarker,
    );
    assert.equal((await lstat(session.sessionRoot)).isSymbolicLink(), true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("abandoned session cleanup binds purge to the marker bytes it verified", async () => {
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-marker-race-"),
  );
  const artifactRoot = path.join(projectRoot, ".local", "runtime-proof");
  try {
    await initializeRuntimeProofRoot({ projectRoot, artifactRoot });
    const session = await createRuntimeProofSessionRoot({ artifactRoot });
    const markerPath = path.join(
      session.sessionRoot,
      ".agent-airlock-runtime-proof-session.json",
    );
    const retainedPath = path.join(session.sessionRoot, "retained.txt");
    await writeFile(retainedPath, "must survive\n");
    let markerChanged = false;

    await expectFailure(
      cleanupAbandonedRuntimeProofSessions({
        artifactRoot,
        processExists: () => false,
        artifactIo: async (anchor, request) => {
          if (request.operation === "purge-private-directory" && !markerChanged) {
            markerChanged = true;
            await writeFile(markerPath, "{}\n");
          }
          return runRuntimeProofArtifactWorker(anchor, request);
        },
      }),
      "cleanup-failed",
    );

    assert.equal(markerChanged, true);
    assert.equal(await readFile(retainedPath, "utf8"), "must survive\n");
    assert.equal((await stat(session.sessionRoot)).isDirectory(), true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("session cleanup requires the exact owner marker and never follows symlinks", async () => {
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-cleanup-"),
  );
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "airlock-runtime-proof-target-"),
  );
  const artifactRoot = path.join(projectRoot, ".local", "runtime-proof");
  try {
    await initializeRuntimeProofRoot({ projectRoot, artifactRoot });
    const first = await createRuntimeProofSessionRoot({ artifactRoot });
    await cleanupRuntimeProofSessionRoot({ artifactRoot, ...first });
    await assert.rejects(stat(first.sessionRoot), { code: "ENOENT" });

    const tampered = await createRuntimeProofSessionRoot({ artifactRoot });
    const markerPath = path.join(
      tampered.sessionRoot,
      ".agent-airlock-runtime-proof-session.json",
    );
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(
      markerPath,
      JSON.stringify({ ...marker, ownerPid: process.pid + 1 }) + "\n",
    );
    await expectFailure(
      cleanupRuntimeProofSessionRoot({ artifactRoot, ...tampered }),
      "cleanup-failed",
    );
    assert.equal((await stat(tampered.sessionRoot)).isDirectory(), true);
    await rm(tampered.sessionRoot, { recursive: true, force: true });

    const linked = await createRuntimeProofSessionRoot({ artifactRoot });
    const linkedMarker = await readFile(
      path.join(linked.sessionRoot, ".agent-airlock-runtime-proof-session.json"),
      "utf8",
    );
    await rm(linked.sessionRoot, { recursive: true, force: true });
    await writeFile(path.join(outside, "keep.txt"), "keep\n");
    await writeFile(
      path.join(outside, ".agent-airlock-runtime-proof-session.json"),
      linkedMarker,
    );
    await symlink(outside, linked.sessionRoot, "dir");
    await expectFailure(
      cleanupRuntimeProofSessionRoot({ artifactRoot, ...linked }),
      "cleanup-failed",
    );
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep\n");

    await expectFailure(
      cleanupRuntimeProofSessionRoot({
        artifactRoot,
        sessionRoot: artifactRoot,
        nonce: linked.nonce,
      }),
      "cleanup-failed",
    );
    assert.equal((await stat(artifactRoot)).isDirectory(), true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("forced child shutdown resolves only after the child exit is observed", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    if (signal === "SIGKILL") {
      setTimeout(() => {
        child.signalCode = "SIGKILL";
        child.emit("exit", null, "SIGKILL");
      }, 20);
    }
    return true;
  };
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  await stopRuntimeProofChild(child, {
    gracefulTimeoutMs: 1,
    forcedTimeoutMs: 100,
  });

  assert.equal(exited, true);
  assert.equal(child.signalCode, "SIGKILL");
});

test("forced child shutdown fails when termination cannot be confirmed", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;

  await assert.rejects(
    stopRuntimeProofChild(child, {
      gracefulTimeoutMs: 1,
      forcedTimeoutMs: 1,
    }),
    /did not exit/,
  );
});

async function reserveRuntimeProofRetryPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function assertRuntimeProofRetryPortReleased(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

test(
  "forced Runtime proof launcher shutdown removes stubborn descendants and releases retry ports",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const port = await reserveRuntimeProofRetryPort();
    const listenerSource = `
      import net from "node:net";
      process.on("SIGTERM", () => {});
      const server = net.createServer();
      server.listen({ host: "127.0.0.1", port: Number(process.env.TEST_PORT), exclusive: true }, () => {
        console.log("RUNTIME_PROOF_RETRY_PORT_READY");
      });
      setInterval(() => {}, 1_000);
    `;
    const launcherSource = `
      import { spawn } from "node:child_process";
      process.on("SIGTERM", () => {});
      spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(listenerSource)}], {
        detached: false,
        env: process.env,
        stdio: "inherit",
      });
      setInterval(() => {}, 1_000);
    `;
    const launcher = spawn(
      process.execPath,
      ["--input-type=module", "--eval", launcherSource],
      {
        detached: true,
        env: { ...process.env, TEST_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const ownedTree = createOwnedRuntimeProofProcessTree(launcher);
    const launcherExit = new Promise((resolve) => launcher.once("exit", resolve));

    try {
      await new Promise((resolve, reject) => {
        let readinessOutput = "";
        const timeout = setTimeout(
          () => reject(new Error("The stubborn Runtime proof child did not start")),
          5_000,
        );
        launcher.stdout.on("data", (chunk) => {
          readinessOutput = (readinessOutput + chunk.toString("utf8")).slice(-512);
          if (!readinessOutput.includes("RUNTIME_PROOF_RETRY_PORT_READY")) {
            return;
          }
          clearTimeout(timeout);
          resolve();
        });
        launcher.once("error", reject);
        launcher.once("exit", () =>
          reject(new Error("The Runtime proof launcher exited before readiness")),
        );
      });

      const result = await stopOwnedRuntimeProofProcessTree(ownedTree, {
        gracefulTimeoutMs: 100,
        forcedTimeoutMs: 5_000,
        pollIntervalMs: 10,
      });
      await launcherExit;
      assert.equal(result.forced, true);
      assert.equal(ownedTree.isRunning(), false);
      await assertRuntimeProofRetryPortReleased(port);
    } finally {
      try {
        ownedTree.signal("SIGKILL");
      } catch {}
    }
  },
);

test("launcher success requires a zero exit without a terminating signal", () => {
  assert.equal(
    runtimeProofChildExitSucceeded({ code: 0, signalName: null }),
    true,
  );
  assert.equal(
    runtimeProofChildExitSucceeded({ code: 1, signalName: null }),
    false,
  );
  assert.equal(
    runtimeProofChildExitSucceeded({ code: null, signalName: "SIGKILL" }),
    false,
  );
  assert.equal(
    runtimeProofChildExitSucceeded({ code: 0, error: new Error("spawn") }),
    false,
  );
});

test("subprocess preparation waits end at a deterministic bounded deadline", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  let timeoutCallback = null;
  let cleared = false;
  const pending = waitForRuntimeProofChildOutcome(child, {
    timeoutMs: 25,
    setTimeoutImpl(callback) {
      timeoutCallback = callback;
      return "bounded-timeout";
    },
    clearTimeoutImpl(handle) {
      assert.equal(handle, "bounded-timeout");
      cleared = true;
    },
  });
  assert.equal(typeof timeoutCallback, "function");
  timeoutCallback();
  assert.deepEqual(await pending, { status: "timed-out" });
  assert.equal(cleared, true);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("subprocess preparation waits remain interruption-responsive", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const controller = new AbortController();
  const pending = waitForRuntimeProofChildOutcome(child, {
    timeoutMs: 25,
    signal: controller.signal,
  });
  controller.abort();
  assert.deepEqual(await pending, { status: "aborted" });
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("subprocess output is captured in a bounded buffer and never forwarded to progress", async () => {
  let terminalOutput = "";
  const progress = createRuntimeProofProgress({
    stdout: { write: (value) => (terminalOutput += value) },
    stderr: { write: (value) => (terminalOutput += value) },
  });
  progress.emit("runtime-launch");

  const sensitive = [
    "ARK_API_KEY=ark-terminal-secret",
    "Authorization: Bearer bearer-terminal-secret",
    "ep-sensitive-endpoint-123",
    "https://ark.example.invalid/api/v3/responses",
    "prompt=delete the accepted workspace",
    "/Users/operator/private/agent-airlock",
  ].join("\n");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.stdout.write(${JSON.stringify(sensitive + "\n" + "x".repeat(80_000))}); process.stderr.write(${JSON.stringify(sensitive)});`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const captured = attachBoundedRuntimeProofCapture(child);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
    );
  });
  captured.detach();

  assert.ok(
    captured.byteLength() <= runtimeProofTerminalLimits.subprocessTranscriptBytes,
  );
  assert.equal(
    terminalOutput,
    "[Agent Airlock] Starting the isolated real Runtime proof.\n",
  );
  assert.doesNotMatch(
    terminalOutput,
    /ark-terminal-secret|bearer-terminal-secret|ep-sensitive|https?:|prompt=|\/Users\//,
  );
});

test("curated progress is allowlisted, deduplicated, JSON-safe, and byte-bounded", () => {
  let stdout = "";
  let stderr = "";
  const progress = createRuntimeProofProgress({
    jsonOutput: true,
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
    maximumBytes: 128,
  });

  assert.equal(progress.emit("container-readiness"), true);
  assert.equal(progress.emit("container-readiness"), false);
  assert.equal(progress.emit("application-build"), true);
  assert.throws(
    () => progress.emit("https://secret.invalid/ep-secret?prompt=leak"),
    /Unknown real Runtime proof progress stage/,
  );
  assert.equal(stdout, "");
  assert.ok(Buffer.byteLength(stderr, "utf8") <= 128);
  assert.equal(progress.byteLength(), Buffer.byteLength(stderr, "utf8"));
  assert.doesNotMatch(stderr, /https?:|ep-secret|prompt=|\/Users\//);
});

test("bounded transcript retention uses bytes instead of unbounded string growth", () => {
  const transcript = createBoundedRuntimeProofTranscript({ maximumBytes: 64 });
  transcript.append("a".repeat(40));
  transcript.append(Buffer.from("b".repeat(80)));
  assert.equal(transcript.byteLength(), 64);
  assert.equal(Buffer.byteLength(transcript.text(), "utf8"), 64);
  assert.equal(transcript.text(), "b".repeat(64));
});
