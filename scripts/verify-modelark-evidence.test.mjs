import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildEvidenceCommitment,
  buildPortableEvidencePacket,
  generatePortableSigningKey,
  signPortableReceipt,
} from "@agent-airlock/portable-promotion-receipt";
import {
  liveModelArkEvidenceDirectoryName,
  liveModelArkLatestEvidenceName,
} from "./modelark-conformance-evidence.mjs";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const verifierPath = path.join(projectRoot, "scripts", "verify-modelark-evidence.mjs");

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function createPacket() {
  const evidence = buildEvidenceCommitment([
    {
      schemaVersion: 1,
      identity: "validation:execution-profile",
      category: "validation",
      status: "passed",
      required: true,
      durationMs: 12,
      summary:
        "Airlock attested the configured ModelArk Responses profile using a redacted profile digest.",
      valueHash: digest("modelark-profile"),
    },
  ]);
  const receipt = {
    protocol: {
      schema: "agent-airlock/portable-promotion-receipt",
      schemaVersion: 1,
      canonicalization: "RFC8785",
      digestAlgorithm: "SHA-256",
    },
    decision: {
      runId: "run-modelark-live",
      agentId: "agent-modelark-live",
      disposition: "promoted",
      decidedAt: "2026-08-28T00:00:00.000Z",
      clockClaim: "signer-clock-not-external-timestamp",
    },
    state: {
      before: {
        stateId: "state-before",
        compositeHash: digest("state-before"),
        builtinResources: [
          { kind: "workspace", fingerprint: digest("workspace-before") },
        ],
        providerResources: [],
      },
      after: {
        stateId: "state-after",
        compositeHash: digest("state-after"),
        builtinResources: [
          { kind: "codex-session", fingerprint: digest("session-after") },
          { kind: "external-actions", fingerprint: digest("actions-after") },
          { kind: "sqlite", fingerprint: digest("sqlite-after") },
          { kind: "workspace", fingerprint: digest("workspace-after") },
        ],
        providerResources: [],
      },
    },
    outcomeContract: {
      schemaVersion: 1,
      version: 1,
      digest: digest("modelark-outcome-contract"),
    },
    validationEvidence: {
      root: evidence.root,
      leafCount: evidence.leaves.length,
      ordering: "canonical-identity-ascending",
    },
    externalActions: {
      commitment: digest("modelark-live-ready"),
      deliveredCount: 1,
    },
    selection: null,
    assurance: null,
    ancestry: {
      rootRunId: "run-modelark-live",
      parentRunId: null,
      depth: 0,
      maxDepth: 3,
      previousReceiptDigest: null,
    },
  };
  const signingKey = generatePortableSigningKey();
  const envelope = signPortableReceipt({
    receipt,
    privateKey: signingKey.privateKeyPem,
    disclosures: evidence.disclosures,
  });
  return buildPortableEvidencePacket({
    envelope,
    anchor: null,
    evmPayload: null,
  });
}

function runVerifier(stateRoot) {
  return spawnSync(process.execPath, [verifierPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AIRLOCK_MODELARK_DEMO_DATA_ROOT: stateRoot,
    },
    encoding: "utf8",
  });
}

test("verifies a recorded signed ModelArk packet and labels it historical", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-modelark-verify-"));
  const evidenceDirectory = path.join(
    stateRoot,
    liveModelArkEvidenceDirectoryName,
  );
  const evidencePath = path.join(evidenceDirectory, liveModelArkLatestEvidenceName);
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
    const packet = createPacket();
    await writeFile(evidencePath, JSON.stringify(packet), { mode: 0o600 });

    const valid = runVerifier(stateRoot);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /Recorded live ModelArk conformance: VALID/);
    assert.match(valid.stdout, /historical signed evidence/);
    assert.match(valid.stdout, /Execution profile disclosed: yes/);
    assert.doesNotMatch(valid.stdout + valid.stderr, /ark-synthetic|Bearer|ep-/i);

    const tampered = structuredClone(packet);
    tampered.envelope.signature = `${
      tampered.envelope.signature[0] === "A" ? "B" : "A"
    }${tampered.envelope.signature.slice(1)}`;
    await writeFile(evidencePath, JSON.stringify(tampered), { mode: 0o600 });
    const invalid = runVerifier(stateRoot);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout, /Recorded live ModelArk conformance: INVALID/);
    assert.match(invalid.stdout, /historical signed evidence/);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
