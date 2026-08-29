import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildEvidenceCommitment,
  buildModelArkExecutionProfileDisclosureSummary,
  buildPortableEvidencePacket,
  generatePortableSigningKey,
  MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY,
  signPortableReceipt,
} from "@agent-airlock/portable-promotion-receipt";
import {
  captureLiveModelArkConformance,
  isCompleteLiveModelArkPromotion,
  liveModelArkEvidenceDirectoryName,
  liveModelArkEvidenceNameForRun,
  liveModelArkLatestEvidenceName,
  publishPrivateModelArkEvidence,
  replacePrivateModelArkEvidence,
} from "./modelark-conformance-evidence.mjs";
import {
  liveModelArkContract,
  liveModelArkPrompt,
} from "./modelark-demo-profile.mjs";

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

function completeRun() {
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
      "run-live-modelark",
      "modelark-live-ready",
      "demo.notification.requested",
      normalizedPayload,
    ].join("\0"),
  );
  const externalActionsFingerprint = commitment(
    JSON.stringify([{ idempotencyKey, deliveredAt: completedAt }]),
  );
  return {
    id: "run-live-modelark",
    agentId: "agent-live-modelark",
    status: "completed",
    candidateSetId: null,
    competitorId: null,
    prompt: liveModelArkPrompt,
    createdAt: checkedAt,
    completedAt,
    transaction: {
      id: "run-live-modelark",
      assuranceEvidenceVersion: 1,
      status: "promoted",
      disposition: "promoted",
      candidateStateId: "candidate-live-modelark",
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
        runTransactionId: "run-live-modelark",
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
            "A fresh provider preflight generated assistant output in 1 bounded request. Airlock control plane attested successful execution through real Codex CLI against the configured ModelArk Responses profile.",
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
  };
}

function exportResult(run) {
  const attestation = JSON.parse(run.transaction.validations[0].output);
  const evidence = buildEvidenceCommitment([
    {
      schemaVersion: 1,
      identity: MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY,
      category: "validation",
      status: "passed",
      required: true,
      durationMs: 0,
      summary: buildModelArkExecutionProfileDisclosureSummary(attestation),
      valueHash: commitment("modelark-execution-profile"),
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
      runId: run.id,
      agentId: run.agentId,
      disposition: "promoted",
      decidedAt: run.completedAt,
      clockClaim: "signer-clock-not-external-timestamp",
    },
    state: {
      before: {
        stateId: "state-before",
        compositeHash: commitment("before"),
        builtinResources: [],
        providerResources: [],
      },
      after: {
        stateId: "state-after",
        compositeHash: commitment("after"),
        builtinResources: [],
        providerResources: [],
      },
    },
    outcomeContract: {
      schemaVersion: 1,
      version: 1,
      digest: commitment("contract"),
    },
    validationEvidence: {
      root: evidence.root,
      leafCount: evidence.leaves.length,
      ordering: "canonical-identity-ascending",
    },
    externalActions: {
      commitment: commitment("actions"),
      deliveredCount: 1,
    },
    selection: null,
    assurance: null,
    ancestry: {
      rootRunId: run.id,
      parentRunId: null,
      depth: 0,
      maxDepth: 2,
      previousReceiptDigest: null,
    },
  };
  const key = generatePortableSigningKey();
  const envelope = signPortableReceipt({
    receipt,
    privateKey: key.privateKeyPem,
    disclosures: evidence.disclosures,
  });
  return {
    verification: { valid: false },
    availableDisclosures: [
      {
        identity: MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY,
        required: true,
        status: "passed",
        summary: evidence.leaves[0].summary,
      },
    ],
    packet: buildPortableEvidencePacket({
      envelope,
      anchor: null,
      evmPayload: null,
    }),
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
  const profile = JSON.parse(wrongProfile.transaction.validations[0].output);
  profile.inferenceMode = "local-responses-protocol-fixture";
  wrongProfile.transaction.validations[0].output = JSON.stringify(profile);
  assert.equal(isCompleteLiveModelArkPromotion(wrongProfile), false);
  const missingPreflight = structuredClone(run);
  const profileWithoutPreflight = JSON.parse(
    missingPreflight.transaction.validations[0].output,
  );
  profileWithoutPreflight.preflight = null;
  missingPreflight.transaction.validations[0].output = JSON.stringify(
    profileWithoutPreflight,
  );
  assert.equal(isCompleteLiveModelArkPromotion(missingPreflight), false);
  const unpersistedCommandName = structuredClone(run);
  unpersistedCommandName.transaction.validations.find(
    (validation) => validation.name === "command:modelark-live-state",
  ).name = "modelark-live-state";
  assert.equal(isCompleteLiveModelArkPromotion(unpersistedCommandName), false);
  const incompleteRecovery = structuredClone(run);
  incompleteRecovery.transaction.recovery.journalPhase = "effects-delivered";
  assert.equal(isCompleteLiveModelArkPromotion(incompleteRecovery), false);
  const extraResource = structuredClone(run);
  extraResource.transaction.resources.push({
    kind: "unexpected",
    disposition: "promoted",
  });
  assert.equal(isCompleteLiveModelArkPromotion(extraResource), false);
  const unchangedCanonicalState = structuredClone(run);
  unchangedCanonicalState.transaction.canonicalStateIdAfter = "state-before";
  assert.equal(isCompleteLiveModelArkPromotion(unchangedCanonicalState), false);
});

test("rejects drifted Runtime facts and stale or unbounded preflight evidence", () => {
  const mutateProfile = (mutate) => {
    const run = completeRun();
    const validation = run.transaction.validations[0];
    const profile = JSON.parse(validation.output);
    mutate(profile);
    validation.output = JSON.stringify(profile);
    return run;
  };
  const mutations = [
    (profile) => {
      profile.executor = "deterministic-fixture";
    },
    (profile) => {
      profile.runtimeProvider = "local-process";
    },
    (profile) => {
      profile.providerProtocol = "chat-completions";
    },
    (profile) => {
      profile.preflight.attemptCount = 5;
    },
    (profile) => {
      profile.preflight.requestCount = 0;
    },
    (profile) => {
      profile.preflight.requestCount = 17;
    },
    (profile) => {
      profile.preflight.retryDelayMs = 15_001;
    },
    (profile) => {
      profile.preflight.checkedAt = "2026-08-28T08:00:00.000+08:00";
    },
  ];
  for (const mutate of mutations) {
    assert.equal(isCompleteLiveModelArkPromotion(mutateProfile(mutate)), false);
  }

  const stale = mutateProfile((profile) => {
    profile.preflight.checkedAt = "2026-08-28T00:00:00.000Z";
  });
  assert.equal(
    isCompleteLiveModelArkPromotion(
      stale,
      Date.parse("2026-08-28T02:00:00.001Z"),
    ),
    false,
  );
});

test("rejects drifted Outcome Contract, required Validation, state, and effect", () => {
  const driftedContract = completeRun();
  driftedContract.transaction.outcomeContract.maxChangedFiles = 5;
  assert.equal(isCompleteLiveModelArkPromotion(driftedContract), false);

  const driftedCommand = completeRun();
  driftedCommand.transaction.outcomeContract.validationCommands[0].command +=
    " && true";
  assert.equal(isCompleteLiveModelArkPromotion(driftedCommand), false);

  const missingRequiredValidation = completeRun();
  missingRequiredValidation.transaction.validations =
    missingRequiredValidation.transaction.validations.filter(
      (validation) => validation.name !== "sqlite-resource",
    );
  assert.equal(isCompleteLiveModelArkPromotion(missingRequiredValidation), false);

  const extraRequiredValidation = completeRun();
  extraRequiredValidation.transaction.validations.push(
    passedValidation("unexpected-required"),
  );
  assert.equal(isCompleteLiveModelArkPromotion(extraRequiredValidation), false);

  const driftedResource = completeRun();
  driftedResource.transaction.resources[1].label = "Session";
  assert.equal(isCompleteLiveModelArkPromotion(driftedResource), false);

  const driftedState = completeRun();
  driftedState.transaction.sqlite.after.rows[0].updatedAt =
    "2026-08-28T00:00:01.000Z";
  assert.equal(isCompleteLiveModelArkPromotion(driftedState), false);

  const driftedEffect = completeRun();
  driftedEffect.transaction.externalActions.intents[0].destination = "other";
  assert.equal(isCompleteLiveModelArkPromotion(driftedEffect), false);
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
    return Response.json(exportResult(run));
  };
  try {
    const captured = await captureLiveModelArkConformance({
      baseUrl: "http://127.0.0.1:3201",
      agentId: "agent-live",
      stateRoot,
      fetchImpl: fetchStub,
      verifyStoredPacket: async (source) => source,
    });
    assert.equal(captured.runId, run.id);
    assert.equal(requests.length, 2);
    assert.deepEqual(JSON.parse(requests[1].options.body).disclosureIdentities, [
      MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY,
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
        verifyStoredPacket: async (source) => source,
      }),
      null,
    );
    assert.equal(requests.length, 3);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("refuses to persist a packet containing provider-private material", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-modelark-private-"));
  const run = completeRun();
  const fetchStub = async (url, options = {}) => {
    if (url.endsWith("/runs")) return Response.json({ runs: [run] });
    const exported = exportResult(run);
    exported.packet.envelope.disclosures[0].leaf.summary =
      "configured ModelArk Responses profile Bearer private-value";
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
    const exported = exportResult(run);
    exported.packet.envelope.disclosures[0].leaf.summary =
      "configured ModelArk Responses profile ark-11111111-2222-3333-4444-555555555555-test1";
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
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("exclusive publication preserves an existing immutable destination", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-publication-"));
  const evidenceDirectory = path.join(
    stateRoot,
    liveModelArkEvidenceDirectoryName,
  );
  const destinationPath = path.join(evidenceDirectory, "existing.packet.json");
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
    await writeFile(destinationPath, "prior-success\n", { mode: 0o600 });
    await assert.rejects(
      publishPrivateModelArkEvidence({
        stateRoot,
        fileName: "existing.packet.json",
        content: "replacement\n",
      }),
      (error) => error?.code === "EVIDENCE_PUBLICATION_CONFLICT",
    );
    assert.equal(await readFile(destinationPath, "utf8"), "prior-success\n");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("exclusive publication recovers a crash after linking the immutable destination", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-publication-"));
  const evidenceDirectory = path.join(
    stateRoot,
    liveModelArkEvidenceDirectoryName,
  );
  const fileName = "interrupted.packet.json";
  const destinationPath = path.join(evidenceDirectory, fileName);
  const interruptedPublicationId = "11111111-2222-4333-8444-555555555555";
  const temporaryPath = path.join(
    evidenceDirectory,
    `.${fileName}.tmp-${interruptedPublicationId}`,
  );
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
    await writeFile(temporaryPath, "completed-content\n", { mode: 0o600 });
    await link(temporaryPath, destinationPath);
    assert.equal((await stat(destinationPath)).nlink, 2);

    const recovered = await publishPrivateModelArkEvidence({
      stateRoot,
      fileName,
      content: "completed-content\n",
    });
    assert.equal(recovered.published, false);
    assert.equal(await readFile(destinationPath, "utf8"), "completed-content\n");
    assert.equal((await stat(destinationPath)).nlink, 1);
    assert.deepEqual(await readdir(evidenceDirectory), [fileName]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("exclusive publication rejects a hostile mismatched interrupted link", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-publication-"));
  const evidenceDirectory = path.join(
    stateRoot,
    liveModelArkEvidenceDirectoryName,
  );
  const fileName = "interrupted.packet.json";
  const destinationPath = path.join(evidenceDirectory, fileName);
  const unrelatedLink = path.join(stateRoot, "unrelated-destination-link");
  const temporaryPath = path.join(
    evidenceDirectory,
    `.${fileName}.tmp-11111111-2222-4333-8444-555555555555`,
  );
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
    await writeFile(destinationPath, "completed-content\n", { mode: 0o600 });
    await link(destinationPath, unrelatedLink);
    await writeFile(temporaryPath, "completed-content\n", { mode: 0o600 });

    await assert.rejects(
      publishPrivateModelArkEvidence({
        stateRoot,
        fileName,
        content: "completed-content\n",
      }),
      (error) => error?.code === "EVIDENCE_TEMPORARY_PATH_UNSAFE",
    );
    assert.equal(await readFile(destinationPath, "utf8"), "completed-content\n");
    assert.equal((await stat(destinationPath)).nlink, 2);
    assert.equal((await stat(temporaryPath)).nlink, 1);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("atomic replacement advances a latest pointer and preserves it on pre-commit failure", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-latest-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-outside-"));
  const evidenceDirectory = path.join(
    stateRoot,
    liveModelArkEvidenceDirectoryName,
  );
  const latestPath = path.join(evidenceDirectory, liveModelArkLatestEvidenceName);
  try {
    const first = await replacePrivateModelArkEvidence({
      stateRoot,
      fileName: liveModelArkLatestEvidenceName,
      content: "first-success\n",
    });
    assert.equal(first.published, true);
    const replay = await replacePrivateModelArkEvidence({
      stateRoot,
      fileName: liveModelArkLatestEvidenceName,
      content: "first-success\n",
    });
    assert.equal(replay.published, false);
    const second = await replacePrivateModelArkEvidence({
      stateRoot,
      fileName: liveModelArkLatestEvidenceName,
      content: "second-success\n",
    });
    assert.equal(second.published, true);
    assert.equal(await readFile(latestPath, "utf8"), "second-success\n");

    const publicationId = "11111111-2222-4333-8444-555555555555";
    const outsideTarget = path.join(outsideRoot, "outside-target");
    const temporaryPath = path.join(
      evidenceDirectory,
      `.${liveModelArkLatestEvidenceName}.tmp-${publicationId}`,
    );
    await writeFile(outsideTarget, "outside-original\n", { mode: 0o600 });
    await symlink(outsideTarget, temporaryPath);
    await assert.rejects(
      replacePrivateModelArkEvidence({
        stateRoot,
        fileName: liveModelArkLatestEvidenceName,
        content: "third-success\n",
        publicationId,
      }),
      (error) => error?.code === "EVIDENCE_TEMPORARY_PATH_UNSAFE",
    );
    assert.equal(await readFile(latestPath, "utf8"), "second-success\n");
    assert.equal(await readFile(outsideTarget, "utf8"), "outside-original\n");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("atomic replacement reports failures only before its rename commit", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-latest-"));
  const latestPath = path.join(
    stateRoot,
    liveModelArkEvidenceDirectoryName,
    liveModelArkLatestEvidenceName,
  );
  try {
    await replacePrivateModelArkEvidence({
      stateRoot,
      fileName: liveModelArkLatestEvidenceName,
      content: "prior-success\n",
    });

    await assert.rejects(
      replacePrivateModelArkEvidence({
        stateRoot,
        fileName: liveModelArkLatestEvidenceName,
        content: "must-not-commit\n",
        publicationOperations: {
          rename: async () => {
            throw new Error("injected failure before rename");
          },
        },
      }),
      /injected failure before rename/,
    );
    assert.equal(await readFile(latestPath, "utf8"), "prior-success\n");

    const lostRenameResponse = await replacePrivateModelArkEvidence({
      stateRoot,
      fileName: liveModelArkLatestEvidenceName,
      content: "rename-committed\n",
      publicationOperations: {
        rename: async (temporaryPath, destinationPath) => {
          await rename(temporaryPath, destinationPath);
          throw new Error("injected response loss after rename");
        },
      },
    });
    assert.equal(lostRenameResponse.committed, true);
    assert.equal(lostRenameResponse.durable, true);
    assert.equal(lostRenameResponse.verified, true);
    assert.equal(await readFile(latestPath, "utf8"), "rename-committed\n");

    const postCommitFailures = await replacePrivateModelArkEvidence({
      stateRoot,
      fileName: liveModelArkLatestEvidenceName,
      content: "post-commit-success\n",
      publicationOperations: {
        syncDirectory: async () => {
          throw new Error("injected directory sync failure");
        },
        verifyInstalled: async () => {
          throw new Error("injected installed-content verification failure");
        },
      },
    });
    assert.equal(postCommitFailures.committed, true);
    assert.equal(postCommitFailures.durable, false);
    assert.equal(postCommitFailures.verified, false);
    assert.equal(await readFile(latestPath, "utf8"), "post-commit-success\n");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("exclusive publication rejects symbolic link directories and temporary paths", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-publication-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-outside-"));
  const evidenceDirectory = path.join(
    stateRoot,
    liveModelArkEvidenceDirectoryName,
  );
  try {
    await symlink(outsideRoot, evidenceDirectory, "dir");
    await assert.rejects(
      publishPrivateModelArkEvidence({
        stateRoot,
        fileName: "linked.packet.json",
        content: "safe\n",
      }),
      (error) => error?.code === "EVIDENCE_DIRECTORY_UNSAFE",
    );
    assert.deepEqual(await readdir(outsideRoot), []);

    await rm(evidenceDirectory);
    await mkdir(evidenceDirectory, { mode: 0o700 });
    const publicationId = "11111111-2222-4333-8444-555555555555";
    const outsideTarget = path.join(outsideRoot, "outside-target");
    const temporaryPath = path.join(
      evidenceDirectory,
      `.linked.packet.json.tmp-${publicationId}`,
    );
    await writeFile(outsideTarget, "outside-original\n", { mode: 0o600 });
    await symlink(outsideTarget, temporaryPath);
    await assert.rejects(
      publishPrivateModelArkEvidence({
        stateRoot,
        fileName: "linked.packet.json",
        content: "safe\n",
        publicationId,
      }),
      (error) => error?.code === "EVIDENCE_TEMPORARY_PATH_UNSAFE",
    );
    const linkedDestination = path.join(
      evidenceDirectory,
      "linked-destination.packet.json",
    );
    await symlink(outsideTarget, linkedDestination);
    await assert.rejects(
      publishPrivateModelArkEvidence({
        stateRoot,
        fileName: "linked-destination.packet.json",
        content: "safe\n",
      }),
      (error) => error?.code === "EVIDENCE_PATH_UNSAFE",
    );
    assert.equal(await readFile(outsideTarget, "utf8"), "outside-original\n");
    assert.deepEqual((await readdir(evidenceDirectory)).sort(), [
      `.linked.packet.json.tmp-${publicationId}`,
      "linked-destination.packet.json",
    ]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("concurrent exclusive publishers converge without replacing content", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-publication-"));
  try {
    const outcomes = await Promise.all([
      publishPrivateModelArkEvidence({
        stateRoot,
        fileName: "race.packet.json",
        content: "one-success\n",
        publicationId: "11111111-2222-4333-8444-555555555555",
      }),
      publishPrivateModelArkEvidence({
        stateRoot,
        fileName: "race.packet.json",
        content: "one-success\n",
        publicationId: "66666666-7777-4888-8999-000000000000",
      }),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.published).sort(),
      [false, true],
    );
    const evidenceDirectory = path.join(
      stateRoot,
      liveModelArkEvidenceDirectoryName,
    );
    assert.equal(
      await readFile(path.join(evidenceDirectory, "race.packet.json"), "utf8"),
      "one-success\n",
    );
    assert.deepEqual(await readdir(evidenceDirectory), ["race.packet.json"]);
    await assert.rejects(
      publishPrivateModelArkEvidence({
        stateRoot,
        fileName: "race.packet.json",
        content: "different-success\n",
      }),
      (error) => error?.code === "EVIDENCE_PUBLICATION_CONFLICT",
    );
    assert.equal(
      await readFile(path.join(evidenceDirectory, "race.packet.json"), "utf8"),
      "one-success\n",
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("reconciles an immutable packet after a crash without re-exporting provider evidence", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-reconcile-"));
  const run = completeRun();
  const artifactFileName = liveModelArkEvidenceNameForRun(run.id);
  const serialized =
    JSON.stringify(
      exportResult(run).packet,
      null,
      2,
    ) + "\n";
  const requests = [];
  const fetchStub = async (url) => {
    requests.push(url);
    if (url.endsWith("/api/agents/agent-live/runs")) {
      return Response.json({ runs: [run] });
    }
    assert.fail("crash reconciliation must not re-export provider evidence");
  };
  const verifyStoredPacket = async (source, runId) => {
    assert.equal(source, serialized);
    assert.equal(runId, run.id);
    return source;
  };
  try {
    const evidenceDirectory = path.join(
      stateRoot,
      liveModelArkEvidenceDirectoryName,
    );
    const artifactPath = path.join(evidenceDirectory, artifactFileName);
    const interruptedTemporaryPath = path.join(
      evidenceDirectory,
      `.${artifactFileName}.tmp-11111111-2222-4333-8444-555555555555`,
    );
    await mkdir(evidenceDirectory, { mode: 0o700 });
    await writeFile(interruptedTemporaryPath, serialized, { mode: 0o600 });
    await link(interruptedTemporaryPath, artifactPath);
    assert.equal((await stat(artifactPath)).nlink, 2);

    const reconciled = await captureLiveModelArkConformance({
      baseUrl: "http://127.0.0.1:3201",
      agentId: "agent-live",
      stateRoot,
      fetchImpl: fetchStub,
      verifyStoredPacket,
    });
    assert.equal(reconciled.reconciled, true);
    assert.equal(reconciled.artifactPath, await realpath(artifactPath));
    assert.equal((await stat(artifactPath)).nlink, 1);
    assert.equal(requests.length, 1);
    assert.equal(
      await readFile(
        path.join(
          stateRoot,
          liveModelArkEvidenceDirectoryName,
          liveModelArkLatestEvidenceName,
        ),
        "utf8",
      ),
      serialized,
    );

    const replay = await captureLiveModelArkConformance({
      baseUrl: "http://127.0.0.1:3201",
      agentId: "agent-live",
      stateRoot,
      fetchImpl: fetchStub,
      verifyStoredPacket,
    });
    assert.equal(replay, null);
    assert.equal(requests.length, 2);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("failed crash reconciliation preserves the prior latest packet", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-reconcile-"));
  const run = completeRun();
  const artifactFileName = liveModelArkEvidenceNameForRun(run.id);
  try {
    await replacePrivateModelArkEvidence({
      stateRoot,
      fileName: liveModelArkLatestEvidenceName,
      content: "prior-success\n",
    });
    await publishPrivateModelArkEvidence({
      stateRoot,
      fileName: artifactFileName,
      content: "unverified-new-packet\n",
    });
    await assert.rejects(
      captureLiveModelArkConformance({
        baseUrl: "http://127.0.0.1:3201",
        agentId: "agent-live",
        stateRoot,
        fetchImpl: async (url) => {
          assert.match(url, /\/api\/agents\/agent-live\/runs$/);
          return Response.json({ runs: [run] });
        },
        verifyStoredPacket: async () => {
          throw new Error("stored packet verification failed");
        },
      }),
      /stored packet verification failed/,
    );
    assert.equal(
      await readFile(
        path.join(
          stateRoot,
          liveModelArkEvidenceDirectoryName,
          liveModelArkLatestEvidenceName,
        ),
        "utf8",
      ),
      "prior-success\n",
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
