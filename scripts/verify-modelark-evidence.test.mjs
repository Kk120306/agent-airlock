import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildModelArkExecutionProfileDisclosureSummary,
  buildEvidenceCommitment,
  buildPortableEvidencePacket,
  canonicalize,
  generatePortableSigningKey,
  MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY,
  signPortableReceipt,
  verifyPortableEvidencePacketJson,
} from "@agent-airlock/portable-promotion-receipt";
import {
  liveModelArkEvidenceDirectoryName,
  liveModelArkEvidenceNameForRun,
  liveModelArkLatestEvidenceName,
  liveModelArkLatestResultName,
} from "./modelark-conformance-evidence.mjs";
import { assertCanonicalLiveModelArkProofResult } from "./modelark-recorded-evidence.mjs";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const verifierPath = path.join(projectRoot, "scripts", "verify-modelark-evidence.mjs");

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function createPacket({ mutateLeaf = () => {} } = {}) {
  const summary = buildModelArkExecutionProfileDisclosureSummary({
    schemaVersion: 2,
    attestation: "airlock-control-plane",
    inferenceMode: "modelark",
    executor: "codex-cli",
    runtimeProvider: "container",
    providerProtocol: "responses",
    modelCommitment: digest("private-model"),
    preflight: {
      checkedAt: "2026-08-27T23:30:00.000Z",
      generatedAssistantOutput: true,
      endpointOriginCommitment: digest("private-endpoint-origin"),
      attemptCount: 1,
      requestCount: 2,
      retryDelayMs: 250,
    },
  });
  const leaf = {
    schemaVersion: 1,
    identity: MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY,
    category: "validation",
    status: "passed",
    required: true,
    durationMs: 0,
    summary,
    valueHash: digest("modelark-profile"),
  };
  mutateLeaf(leaf);
  const evidence = buildEvidenceCommitment([leaf]);
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

function createResultCapsule({
  runId = "run-modelark-live",
  receiptDigest,
  overrides = {},
}) {
  return {
    schema: "agent-airlock/live-modelark-proof-result",
    schemaVersion: 1,
    outcome: "passed",
    observedAt: "2026-08-28T09:30:00.000Z",
    clockClaim: "observer-clock-not-external-timestamp",
    runId,
    receiptDigest,
    gates: {
      browserInvocation: true,
      completePromotion: true,
      packetCaptured: true,
      offlineVerification: true,
    },
    packetFile: liveModelArkEvidenceNameForRun(runId),
    ...overrides,
  };
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
    assert.match(valid.stdout, /Exact safe execution profile: VERIFIED/);
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

test("follows the result capsule to its immutable packet", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-modelark-pair-"));
  const evidenceDirectory = path.join(
    stateRoot,
    liveModelArkEvidenceDirectoryName,
  );
  const packetFile = liveModelArkEvidenceNameForRun("run-modelark-live");
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
    const packet = createPacket();
    const source = JSON.stringify(packet);
    const receiptDigest =
      verifyPortableEvidencePacketJson(source).receipt.receiptDigest;
    await writeFile(path.join(evidenceDirectory, packetFile), source, {
      mode: 0o600,
    });
    await writeFile(
      path.join(evidenceDirectory, liveModelArkLatestEvidenceName),
      "not the paired packet",
      { mode: 0o600 },
    );
    await writeFile(
      path.join(evidenceDirectory, liveModelArkLatestResultName),
      JSON.stringify(createResultCapsule({ receiptDigest })),
      { mode: 0o600 },
    );

    const valid = runVerifier(stateRoot);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /Recorded live ModelArk conformance: VALID/);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("fails closed for legacy phrases and re-signed semantic profile drift", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-modelark-semantics-"));
  const evidenceDirectory = path.join(
    stateRoot,
    liveModelArkEvidenceDirectoryName,
  );
  const evidencePath = path.join(evidenceDirectory, liveModelArkLatestEvidenceName);
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
    const legacyPacket = createPacket({
      mutateLeaf(leaf) {
        leaf.identity = "validation:legacy-execution-profile";
        leaf.summary =
          "Airlock attested the configured ModelArk Responses profile using a redacted digest.";
      },
    });
    assert.equal(
      verifyPortableEvidencePacketJson(JSON.stringify(legacyPacket)).valid,
      true,
    );
    await writeFile(evidencePath, JSON.stringify(legacyPacket), { mode: 0o600 });
    const legacy = runVerifier(stateRoot);
    assert.equal(legacy.status, 1);
    assert.match(legacy.stdout, /Exact safe execution profile: LEGACY-UNPROVEN/);

    const driftedPacket = createPacket({
      mutateLeaf(leaf) {
        const claim = JSON.parse(leaf.summary);
        claim.profile = "airlock-control-plane:modelark:local-process";
        leaf.summary = canonicalize(claim);
      },
    });
    assert.equal(
      verifyPortableEvidencePacketJson(JSON.stringify(driftedPacket)).valid,
      true,
    );
    await writeFile(evidencePath, JSON.stringify(driftedPacket), { mode: 0o600 });
    const drifted = runVerifier(stateRoot);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stdout, /Exact safe execution profile: INVALID/);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("rejects incomplete or non-passing result capsules", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-modelark-result-"));
  const evidenceDirectory = path.join(
    stateRoot,
    liveModelArkEvidenceDirectoryName,
  );
  const packetFile = liveModelArkEvidenceNameForRun("run-modelark-live");
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
    const packet = createPacket();
    const source = JSON.stringify(packet);
    const receiptDigest =
      verifyPortableEvidencePacketJson(source).receipt.receiptDigest;
    await writeFile(path.join(evidenceDirectory, packetFile), source, {
      mode: 0o600,
    });

    const missingObservedAt = createResultCapsule({ receiptDigest });
    delete missingObservedAt.observedAt;
    const missingGate = createResultCapsule({ receiptDigest });
    delete missingGate.gates.packetCaptured;
    const cases = [
      ["missing observedAt", missingObservedAt],
      [
        "wrong clock claim",
        createResultCapsule({
          receiptDigest,
          overrides: { clockClaim: "provider-attested-clock" },
        }),
      ],
      ["missing gate", missingGate],
      [
        "false gate",
        createResultCapsule({
          receiptDigest,
          overrides: {
            gates: {
              browserInvocation: true,
              completePromotion: false,
              packetCaptured: true,
              offlineVerification: true,
            },
          },
        }),
      ],
      [
        "unknown gate",
        createResultCapsule({
          receiptDigest,
          overrides: {
            gates: {
              browserInvocation: true,
              completePromotion: true,
              packetCaptured: true,
              offlineVerification: true,
              providerAuthority: true,
            },
          },
        }),
      ],
      [
        "mismatched packet",
        createResultCapsule({
          receiptDigest,
          overrides: {
            packetFile: liveModelArkEvidenceNameForRun("run-other"),
          },
        }),
      ],
      [
        "unknown result field",
        createResultCapsule({
          receiptDigest,
          overrides: { providerClaim: true },
        }),
      ],
    ];

    for (const [name, capsule] of cases) {
      await context.test(name, async () => {
        await writeFile(
          path.join(evidenceDirectory, liveModelArkLatestResultName),
          JSON.stringify(capsule),
          { mode: 0o600 },
        );
        const invalid = runVerifier(stateRoot);
        assert.equal(invalid.status, 1);
        assert.match(
          invalid.stderr,
          /Recorded live ModelArk conformance evidence could not be verified safely/,
        );
      });
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("rejects private material in a structurally complete result capsule", () => {
  assert.throws(
    () =>
      assertCanonicalLiveModelArkProofResult(
        createResultCapsule({
          runId: "ark-private-material",
          receiptDigest: digest("receipt"),
        }),
      ),
    /contains private material/,
  );
});

test("rejects symlinked, shared, or broadly readable recorded evidence", async (context) => {
  const source = JSON.stringify(createPacket());
  const cases = [
    {
      name: "symbolic link",
      async install({ evidencePath, outsidePath }) {
        await writeFile(outsidePath, source, { mode: 0o600 });
        await symlink(outsidePath, evidencePath);
      },
    },
    {
      name: "multiple hard links",
      async install({ evidencePath, outsidePath }) {
        await writeFile(outsidePath, source, { mode: 0o600 });
        await link(outsidePath, evidencePath);
      },
    },
    {
      name: "group-readable mode",
      async install({ evidencePath }) {
        await writeFile(evidencePath, source, { mode: 0o600 });
        await chmod(evidencePath, 0o640);
      },
    },
  ];

  for (const testCase of cases) {
    await context.test(testCase.name, async () => {
      const stateRoot = await mkdtemp(
        path.join(os.tmpdir(), "airlock-modelark-file-safety-"),
      );
      const outsideRoot = await mkdtemp(
        path.join(os.tmpdir(), "airlock-modelark-outside-"),
      );
      const evidenceDirectory = path.join(
        stateRoot,
        liveModelArkEvidenceDirectoryName,
      );
      const evidencePath = path.join(
        evidenceDirectory,
        liveModelArkLatestEvidenceName,
      );
      const outsidePath = path.join(outsideRoot, "outside.packet.json");
      try {
        await mkdir(evidenceDirectory, { mode: 0o700 });
        await testCase.install({ evidencePath, outsidePath });
        const invalid = runVerifier(stateRoot);
        assert.equal(invalid.status, 1);
        assert.match(
          invalid.stderr,
          /Recorded live ModelArk conformance evidence could not be verified safely/,
        );
      } finally {
        await rm(stateRoot, { recursive: true, force: true });
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });
  }
});
