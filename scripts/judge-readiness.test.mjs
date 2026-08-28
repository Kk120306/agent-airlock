import assert from "node:assert/strict";
import test from "node:test";
import {
  assertJudgeReadiness,
  inspectJudgeReadiness,
  normalizeLocalDemoUrl,
} from "./judge-readiness.mjs";

function fixture(mode = "runtime") {
  const runtime = mode === "runtime";
  const name = runtime ? "Real Runtime Proof" : "Live ModelArk Proof";
  const requiredArtifact = runtime ? "protocol-proof.txt" : "modelark-proof.txt";
  const validationName = runtime ? "protocol-content" : "modelark-live-state";
  return {
    health: { ok: true, service: "volc-agent-launchpad" },
    system: {
      protocolFixtureMode: runtime,
      modelArkDemoMode: !runtime,
      inferenceMode: runtime ? "local-responses-protocol-fixture" : "modelark",
      arkConfigured: true,
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
        status: "ready",
        outcomeContract: {
          requiredPaths: ["AGENTS.md", requiredArtifact],
          protectedPaths: ["AGENTS.md"],
          validationCommands: [{ name: validationName, required: true }],
        },
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
