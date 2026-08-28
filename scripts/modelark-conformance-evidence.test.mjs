import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureLiveModelArkConformance,
  isCompleteLiveModelArkPromotion,
  liveModelArkEvidenceDirectoryName,
  liveModelArkLatestEvidenceName,
} from "./modelark-conformance-evidence.mjs";

function completeRun() {
  return {
    id: "run-live-modelark",
    transaction: {
      disposition: "promoted",
      validations: [
        {
          name: "execution-profile",
          required: true,
          status: "passed",
          summary:
            "Airlock control plane attested successful execution through real Codex CLI against the configured ModelArk Responses profile.",
        },
        {
          name: "modelark-live-state",
          required: true,
          status: "passed",
          summary: "The exact file and database state passed.",
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
        intents: [
          {
            id: "modelark-live-ready",
            status: "delivered",
          },
        ],
      },
    },
  };
}

function exportResult(runId, disclosures) {
  return {
    verification: { valid: true },
    availableDisclosures: [
      {
        identity: "validation:profile-digest",
        required: true,
        status: "passed",
        summary:
          "Airlock control plane attested successful execution through real Codex CLI against the configured ModelArk Responses profile.",
      },
    ],
    packet: {
      schema: "agent-airlock/portable-evidence-packet",
      schemaVersion: 1,
      envelope: {
        receipt: {
          decision: { runId, disposition: "promoted" },
        },
        disclosures,
      },
      anchor: null,
      evmPayload: null,
    },
  };
}

test("recognizes only a complete provider-backed Whole-Agent Promotion", () => {
  const run = completeRun();
  assert.equal(isCompleteLiveModelArkPromotion(run), true);
  const rejected = structuredClone(run);
  rejected.transaction.disposition = "quarantined";
  assert.equal(isCompleteLiveModelArkPromotion(rejected), false);
  const missingEffect = structuredClone(run);
  missingEffect.transaction.externalActions.deliveredCount = 0;
  assert.equal(isCompleteLiveModelArkPromotion(missingEffect), false);
  const wrongProfile = structuredClone(run);
  wrongProfile.transaction.validations[0].summary =
    "Airlock attested a local deterministic Responses fixture.";
  assert.equal(isCompleteLiveModelArkPromotion(wrongProfile), false);
});

test("captures one private signed packet with the ModelArk profile disclosed", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-modelark-capture-"));
  const requests = [];
  const run = completeRun();
  const fetchStub = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/agents/agent-live/runs")) {
      return Response.json({ runs: [run] });
    }
    const body = JSON.parse(options.body);
    if (body.disclosureIdentities.length === 0) {
      return Response.json(exportResult(run.id, []));
    }
    return Response.json(
      exportResult(run.id, [
        {
          leaf: {
            identity: "validation:profile-digest",
            required: true,
            status: "passed",
            summary: "configured ModelArk Responses profile",
          },
        },
      ]),
    );
  };
  try {
    const captured = await captureLiveModelArkConformance({
      baseUrl: "http://127.0.0.1:3201",
      agentId: "agent-live",
      stateRoot,
      fetchImpl: fetchStub,
    });
    assert.equal(captured.runId, run.id);
    assert.equal(requests.length, 3);
    assert.deepEqual(JSON.parse(requests[2].options.body).disclosureIdentities, [
      "validation:profile-digest",
    ]);
    const latestPath = path.join(
      stateRoot,
      liveModelArkEvidenceDirectoryName,
      liveModelArkLatestEvidenceName,
    );
    const latest = JSON.parse(await readFile(latestPath, "utf8"));
    assert.equal(latest.envelope.receipt.decision.runId, run.id);
    assert.equal(latest.envelope.disclosures.length, 1);
    assert.equal((await stat(latestPath)).mode & 0o777, 0o600);
    assert.equal(
      await captureLiveModelArkConformance({
        baseUrl: "http://127.0.0.1:3201",
        agentId: "agent-live",
        stateRoot,
        fetchImpl: fetchStub,
      }),
      null,
    );
    assert.equal(requests.length, 4);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("refuses to persist a packet containing provider-private material", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-modelark-private-"));
  const run = completeRun();
  const fetchStub = async (url, options = {}) => {
    if (url.endsWith("/runs")) return Response.json({ runs: [run] });
    const body = JSON.parse(options.body);
    if (body.disclosureIdentities.length === 0) {
      return Response.json(exportResult(run.id, []));
    }
    const exported = exportResult(run.id, [
      {
        leaf: {
          identity: "validation:profile-digest",
          required: true,
          status: "passed",
          summary: "configured ModelArk Responses profile Bearer private-value",
        },
      },
    ]);
    return Response.json(exported);
  };
  try {
    await assert.rejects(
      captureLiveModelArkConformance({
        baseUrl: "http://127.0.0.1:3201",
        agentId: "agent-live",
        stateRoot,
        fetchImpl: fetchStub,
      }),
      /forbidden private material/,
    );
    await assert.rejects(
      readFile(
        path.join(
          stateRoot,
          liveModelArkEvidenceDirectoryName,
          liveModelArkLatestEvidenceName,
        ),
      ),
      { code: "ENOENT" },
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("refuses to persist an Ark model API key", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-modelark-key-"));
  const run = completeRun();
  const fetchStub = async (url, options = {}) => {
    if (url.endsWith("/runs")) return Response.json({ runs: [run] });
    const body = JSON.parse(options.body);
    if (body.disclosureIdentities.length === 0) {
      return Response.json(exportResult(run.id, []));
    }
    return Response.json(
      exportResult(run.id, [
        {
          leaf: {
            identity: "validation:profile-digest",
            required: true,
            status: "passed",
            summary:
              "configured ModelArk Responses profile ark-synthetic-private-value",
          },
        },
      ]),
    );
  };
  try {
    await assert.rejects(
      captureLiveModelArkConformance({
        baseUrl: "http://127.0.0.1:3201",
        agentId: "agent-live",
        stateRoot,
        fetchImpl: fetchStub,
      }),
      /forbidden private material/,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
