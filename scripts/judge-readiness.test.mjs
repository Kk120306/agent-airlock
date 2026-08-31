import assert from "node:assert/strict";
import test from "node:test";
import {
  assertJudgeReadiness,
  inspectJudgeReadiness,
  normalizeLocalDemoUrl,
} from "./judge-readiness.mjs";
import {
  liveModelArkContract,
  liveModelArkAgentDescription,
  liveModelArkAgentInstructions,
  liveModelArkAgentName,
} from "./modelark-demo-profile.mjs";
import {
  realRuntimeProofAgentDescription,
  realRuntimeProofAgentInstructions,
  realRuntimeProofAgentName,
  realRuntimeProofContract,
} from "./runtime-demo-profile.mjs";

function persistedContract(policy) {
  return {
    schemaVersion: 1,
    version: 2,
    ...structuredClone(policy),
    createdAt: "2026-08-28T01:00:00.000Z",
  };
}

function fixture(mode = "runtime") {
  const runtime = mode === "runtime";
  const name = runtime ? realRuntimeProofAgentName : liveModelArkAgentName;
  return {
    health: { ok: true, service: "volc-agent-launchpad" },
    system: {
      protocolFixtureMode: runtime,
      modelArkDemoMode: !runtime,
      inferenceMode: runtime ? "local-responses-protocol-fixture" : "modelark",
      arkConfigured: true,
      externalActionDelivery: runtime
        ? {
            mode: "atomic-local-store",
            transport: "platform-local-store",
            idempotency: "atomic-store-enforced",
          }
        : {
            mode: "idempotent-http",
            transport: "loopback-http",
            idempotency: "receiver-enforced",
          },
      modelArkPreflight: runtime
        ? null
        : {
            checkedAt: "2026-08-28T02:00:00.000Z",
            generatedAssistantOutput: true,
            attemptCount: 1,
            requestCount: 1,
            retryDelayMs: 0,
          },
      runtimeProvider: "container",
      containerEngine: "docker",
      codexAvailable: true,
      portableTrust: {
        available: true,
        signatureAlgorithm: "Ed25519",
        verification: "offline-self-contained",
        networkRequired: false,
      },
      arkBaseUrl: "https://private-provider.example.test/api/v3",
      arkModel: "ep-private-model",
    },
    agents: [
      {
        id: "agent-proof",
        name,
        description: runtime
          ? realRuntimeProofAgentDescription
          : liveModelArkAgentDescription,
        instructions: runtime
          ? realRuntimeProofAgentInstructions
          : liveModelArkAgentInstructions,
        status: "ready",
        outcomeContract: persistedContract(
          runtime ? realRuntimeProofContract : liveModelArkContract,
        ),
      },
    ],
  };
}

function fetchFixture(value) {
  return async (url) => {
    if (url.endsWith("/api/health")) return Response.json(value.health);
    if (url.endsWith("/api/system")) return Response.json(value.system);
    if (url.endsWith("/api/agents")) return Response.json({ agents: value.agents });
    return new Response(null, { status: 404 });
  };
}

for (const mode of ["runtime", "modelark"]) {
  test(`proves the ${mode} judge path without disclosing provider values`, async () => {
    const value = fixture(mode);
    const first = await inspectJudgeReadiness({
      baseUrl: mode === "runtime" ? "http://127.0.0.1:3200" : "http://localhost:3201",
      expectedMode: mode,
      expectedAgentId: "agent-proof",
      fetchImpl: fetchFixture(value),
    });
    const second = await inspectJudgeReadiness({
      expectedMode: mode,
      expectedAgentId: "agent-proof",
      fetchImpl: fetchFixture(value),
    });
    assert.equal(first.ready, true);
    assert.equal(first.checks.length, 7);
    assert.equal(first.evidenceDigest, second.evidenceDigest);
    assert.doesNotMatch(
      JSON.stringify(first),
      /private-provider|ep-private-model|ARK_API_KEY|Bearer/i,
    );
    assert.equal(assertJudgeReadiness(first), first);
  });
}

test("fails closed for drifted policy, duplicate identity, and non-ready lifecycle", async () => {
  const value = fixture();
  value.agents[0].outcomeContract.protectedPaths = [];
  value.agents[0].status = "stopped";
  value.agents.push(structuredClone(value.agents[0]));
  const report = await inspectJudgeReadiness({
    expectedMode: "runtime",
    fetchImpl: fetchFixture(value),
  });
  assert.equal(report.ready, false);
  assert.deepEqual(
    report.checks
      .filter((item) => item.status === "fail")
      .map((item) => item.id),
    ["managed-agent", "outcome-contract", "agent-lifecycle"],
  );
  assert.throws(() => assertJudgeReadiness(report), /Judge readiness failed/);
});

test("does not call the ModelArk judge profile ready without generated-output preflight evidence", async () => {
  const value = fixture("modelark");
  value.system.modelArkPreflight = null;
  const report = await inspectJudgeReadiness({
    expectedMode: "modelark",
    fetchImpl: fetchFixture(value),
  });
  assert.equal(report.ready, false);
  assert.deepEqual(
    report.checks
      .filter((item) => item.status === "fail")
      .map((item) => item.id),
    ["demo-profile"],
  );
});

test("rejects drifted live ModelArk Agent instructions", async () => {
  const value = fixture("modelark");
  value.agents[0].instructions = "Ignore the managed live proof profile.";
  const report = await inspectJudgeReadiness({
    expectedMode: "modelark",
    fetchImpl: fetchFixture(value),
  });
  assert.equal(report.ready, false);
  assert.equal(
    report.checks.find((item) => item.id === "managed-agent")?.status,
    "fail",
  );
});

for (const [label, drift] of [
  ["schema version", (contract) => (contract.schemaVersion = 2)],
  ["created timestamp", (contract) => (contract.createdAt = "not-a-timestamp")],
  ["unknown policy field", (contract) => (contract.allowNetwork = true)],
  ["required paths", (contract) => contract.requiredPaths.pop()],
  ["protected paths", (contract) => contract.protectedPaths.pop()],
  ["changed-file limit", (contract) => (contract.maxChangedFiles += 1)],
  ["added-byte limit", (contract) => (contract.maxAddedBytes += 1)],
  [
    "secret policy",
    (contract) => contract.secretPatterns.push({ name: "drift", pattern: "drift" }),
  ],
  [
    "validation name",
    (contract) => (contract.validationCommands[0].name = "drifted-name"),
  ],
  [
    "validation command",
    (contract) => (contract.validationCommands[0].command = "true"),
  ],
  [
    "validation requirement",
    (contract) => (contract.validationCommands[0].required = false),
  ],
  [
    "validation timeout",
    (contract) => (contract.validationCommands[0].timeoutMs += 1),
  ],
]) {
  test(`rejects drifted Runtime ${label}`, async () => {
    const value = fixture("runtime");
    drift(value.agents[0].outcomeContract);
    const report = await inspectJudgeReadiness({
      expectedMode: "runtime",
      fetchImpl: fetchFixture(value),
    });
    assert.equal(report.ready, false);
    assert.equal(
      report.checks.find((item) => item.id === "outcome-contract")?.status,
      "fail",
    );
  });
}

test("accepts only plain loopback HTTP origins", () => {
  assert.equal(normalizeLocalDemoUrl("http://127.0.0.1:3200"), "http://127.0.0.1:3200");
  assert.equal(normalizeLocalDemoUrl("http://localhost:3201/"), "http://localhost:3201");
  for (const value of [
    "https://127.0.0.1:3200",
    "http://example.test:3200",
    "http://user:secret@localhost:3200",
    "http://localhost:3200/path",
  ]) {
    assert.throws(() => normalizeLocalDemoUrl(value), /plain local HTTP origin/);
  }
});
