import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  inspectProductionImagePersistence,
  verifyProductionImagePersistence,
} from "./production-image-persistence-verifier.mjs";
import {
  realRuntimeProofAgentDescription,
  realRuntimeProofAgentInstructions,
  realRuntimeProofContract,
  productionImageBoundaryPrompt,
} from "./runtime-demo-profile.mjs";

const agentId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const stateId = "33333333-3333-4333-8333-333333333333";
const threadId = "44444444-4444-4444-8444-444444444444";
const initialStateId = "55555555-5555-4555-8555-555555555555";
const userMessageId = "66666666-6666-4666-8666-666666666666";
const assistantMessageId = "77777777-7777-4777-8777-777777777777";
const userPrompt = productionImageBoundaryPrompt;
const assistantOutput =
  "Protocol fixture completed the requested Candidate edit.";
const agentName = "Production Image Container Proof";
const initialSqliteUpdatedAt = "1970-01-01T00:00:00.000Z";
const sqliteUpdatedAt = "2026-08-28T00:00:00.000Z";
const workspaceSentinelContent =
  "protected-workspaces:0123456789abcdef01234567";
const dataSentinelContent = "protected-data:0123456789abcdef01234567";
const externalActionBypassDisclosure =
  "POC boundary: unrestricted Runtime networking could bypass this outbox. The supported action path is deferred until Promotion.";
const expectedGitignore = [
  ".codex/",
  "node_modules/",
  "dist/",
  ".env",
  "*.log",
  "",
].join("\n");
const expectedReadme = [
  `# ${agentName} workspace`,
  "",
  "Files created or edited by the Agent live here.",
  "The platform-generated AGENTS.md contains the current Agent instructions.",
  "",
].join("\n");
const expectedAgentInstructions = [
  "# Platform-managed Agent instructions",
  "",
  `You are the coding Agent named ${agentName}.`,
  `Purpose: ${realRuntimeProofAgentDescription}`,
  "",
  "## Instructions",
  "",
  realRuntimeProofAgentInstructions,
  "",
  "## Workspace rules",
  "",
  "- Work only inside this workspace unless the user explicitly requests otherwise.",
  "- Preserve existing user files and avoid destructive operations.",
  "- Build and test changes when practical.",
  "- Never print environment variables or credentials.",
  "- The transactional SQLite database is .airlock/demo.sqlite.",
  "- The approved database table is inventory(id, value, updated_at).",
  "- To request a demo notification, append one JSON object per line to the file named by AIRLOCK_OUTBOX_PATH.",
  '- Use {"schemaVersion":1,"id":"unique-id","type":"demo.notification.requested","payload":{"destination":"demo-console","subject":"Subject","body":"Body"}}.',
  "- External action intents remain deferred until the entire Candidate State is promoted.",
  "",
  "This file is regenerated when the Agent configuration is updated.",
  "",
].join("\n");
const hash = (character) => `sha256:${character.repeat(64)}`;
const effectPayload = {
  destination: "demo-console",
  subject: "Protocol release ready",
  body: "The Whole-Agent Candidate passed.",
};
const effectPayloadJson = JSON.stringify(effectPayload);
const commitment = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const effectPayloadHash = commitment(effectPayloadJson);
const effectIdempotencyKey = commitment(
  [
    runId,
    "protocol-release-ready",
    "demo.notification.requested",
    effectPayloadJson,
  ].join("\0"),
);
const protocolModelCommitment = commitment("protocol-fixture");

const defaultOutcomeContract = {
  schemaVersion: 1,
  version: 1,
  requiredPaths: ["AGENTS.md", "README.md"],
  protectedPaths: ["AGENTS.md"],
  maxChangedFiles: 200,
  maxAddedBytes: 2_097_152,
  secretPatterns: [
    {
      name: "ark-api-key-assignment",
      pattern: "ARK_API_KEY\\s*[:=]\\s*['\\\"]?[^\\s'\\\"]{8,}",
    },
    {
      name: "bearer-token",
      pattern: "Bearer\\s+[A-Za-z0-9._~+/-]{12,}=*",
    },
  ],
  validationCommands: [],
  createdAt: "2026-08-31T00:00:00.000Z",
};
const configuredOutcomeContract = {
  schemaVersion: 1,
  version: 2,
  ...structuredClone(realRuntimeProofContract),
  createdAt: "2026-08-31T00:00:01.000Z",
};

function transactionProof(canonicalContentHashAfter, validationEvidenceHash) {
  return {
    schema: "agent-airlock-production-image-transaction-proof/v1",
    agentId,
    runId,
    transactionId: runId,
    completedAt: "2026-08-31T00:00:04.000Z",
    canonicalStateIdAfter: stateId,
    canonicalContentHashAfter,
    outcomeContractVersion: 2,
    validationEvidenceHash,
    effectIdempotencyKey,
    effectIntentId: "protocol-release-ready",
    effectType: "demo.notification.requested",
    effectDestination: effectPayload.destination,
    effectSubject: effectPayload.subject,
    effectPayloadHash,
    effectDeliveredAt: "2026-08-31T00:00:03.000Z",
  };
}

async function treeContentHash(root) {
  const digest = createHash("sha256");
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        digest.update(`directory\0${relative}\0`);
        await visit(absolute);
        continue;
      }
      assert.equal(metadata.isFile(), true);
      const bytes = await readFile(absolute);
      digest.update(`file\0${relative}\0${metadata.size}\0`);
      digest.update(bytes);
      digest.update("\0");
    }
  };
  await visit(root);
  return `sha256:${digest.digest("hex")}`;
}

async function fixture() {
  let root = await mkdtemp(path.join(os.tmpdir(), "airlock-physical-proof-"));
  root = await realpath(root);
  const versionRoot = path.join(
    root,
    "workspaces",
    agentId,
    "versions",
    stateId,
  );
  const workspaces = path.join(root, "workspaces");
  const agentRoot = path.join(workspaces, agentId);
  const historyRoot = path.join(agentRoot, ".canonical-history");
  const initialVersionRoot = path.join(agentRoot, "versions", initialStateId);
  const workspace = path.join(versionRoot, "workspace");
  const canonicalCodex = path.join(versionRoot, "codex-home");
  const data = path.join(root, "data");
  const globalCodex = path.join(root, "codex-home");
  await Promise.all([
    mkdir(path.join(workspace, ".airlock"), { recursive: true }),
    mkdir(path.join(canonicalCodex, "sessions", "2026"), { recursive: true }),
    mkdir(path.join(versionRoot, "outbox"), { recursive: true }),
    mkdir(path.join(versionRoot, "resources"), { recursive: true }),
    mkdir(path.join(initialVersionRoot, "workspace", ".airlock"), {
      recursive: true,
    }),
    mkdir(path.join(initialVersionRoot, "codex-home"), { recursive: true }),
    mkdir(path.join(initialVersionRoot, "outbox"), { recursive: true }),
    mkdir(historyRoot, { recursive: true }),
    ...[
      ".candidates",
      ".deleted",
      ".federated-preparations",
      ".migrations",
      ".quarantine",
      ".registry-transitions",
    ].map((relative) =>
      mkdir(path.join(workspaces, relative), { recursive: true }),
    ),
    mkdir(data, { recursive: true }),
    mkdir(globalCodex, { recursive: true }),
    ...[
      "agent-deletion-journal",
      "federated-admission-journal/pending-bundles",
      "federated-admission-journal/plans",
      "federated-admission-journal/records",
      "federated-admission-journal/transfers",
      "federated-admission-policies/policies",
      "federated-approval-journal/plans",
      "federated-approval-journal/records",
      "portable-decision-journal/.candidate-sets",
      "portable-decision-journal/.discard-cleanup",
      `portable-decision-journal/${runId}`,
      "promotion-journal",
    ].map((relative) => mkdir(path.join(data, relative), { recursive: true })),
  ]);
  await Promise.all([
    writeFile(path.join(workspace, ".gitignore"), expectedGitignore),
    writeFile(path.join(workspace, "AGENTS.md"), expectedAgentInstructions),
    writeFile(path.join(workspace, "README.md"), expectedReadme),
    writeFile(path.join(workspace, "protocol-proof.txt"), "candidate-only\n"),
    writeFile(
      path.join(initialVersionRoot, "workspace", ".gitignore"),
      expectedGitignore,
    ),
    writeFile(
      path.join(initialVersionRoot, "workspace", "AGENTS.md"),
      expectedAgentInstructions,
    ),
    writeFile(
      path.join(initialVersionRoot, "workspace", "README.md"),
      expectedReadme,
    ),
    writeFile(
      path.join(initialVersionRoot, "codex-home", "config.toml"),
      "model = 'fixture'\n",
    ),
    writeFile(
      path.join(workspaces, ".resource-registry.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        providers: [],
        updatedAt: "2026-08-31T00:00:00.000Z",
      })}\n`,
    ),
    writeFile(
      path.join(workspaces, ".production-gate-sandbox-sentinel"),
      `${workspaceSentinelContent}\n`,
    ),
    writeFile(
      path.join(data, ".production-gate-sandbox-sentinel"),
      `${dataSentinelContent}\n`,
    ),
    writeFile(path.join(data, "promotion-journal", `${runId}.json`), "{}\n"),
    writeFile(
      path.join(
        data,
        "portable-decision-journal",
        runId,
        `sha256-${"a".repeat(64)}.json`,
      ),
      "{}\n",
    ),
  ]);
  const database = new DatabaseSync(
    path.join(workspace, ".airlock", "demo.sqlite"),
  );
  database.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  database
    .prepare("INSERT INTO inventory (id, value, updated_at) VALUES (?, ?, ?)")
    .run("demo", "candidate-only", sqliteUpdatedAt);
  database.close();
  const initialDatabase = new DatabaseSync(
    path.join(initialVersionRoot, "workspace", ".airlock", "demo.sqlite"),
  );
  initialDatabase.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  initialDatabase
    .prepare("INSERT INTO inventory (id, value, updated_at) VALUES (?, ?, ?)")
    .run("demo", "ready", initialSqliteUpdatedAt);
  initialDatabase.close();
  await writeFile(
    path.join(canonicalCodex, "config.toml"),
    "model = 'fixture'\n",
  );
  await writeFile(
    path.join(
      canonicalCodex,
      "sessions",
      "2026",
      `rollout-2026-08-31T00-00-00-${threadId}.jsonl`,
    ),
    `${JSON.stringify({ type: "session_meta", payload: { id: threadId } })}\n`,
  );
  await writeFile(
    path.join(versionRoot, "outbox", "intents.jsonl"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "protocol-release-ready",
      type: "demo.notification.requested",
      payload: effectPayload,
    })}\n`,
  );
  const workspaceContentHash = await treeContentHash(workspace);
  const sessionContentHash = await treeContentHash(canonicalCodex);
  const outboxContentHash = await treeContentHash(
    path.join(versionRoot, "outbox"),
  );
  const sqliteContentHash = commitment(
    JSON.stringify([
      { id: "demo", value: "candidate-only", updatedAt: sqliteUpdatedAt },
    ]),
  );
  const contentHash = commitment(
    JSON.stringify({
      workspaceContentHash,
      sessionContentHash,
      sqliteContentHash,
      outboxContentHash,
      codexThreadId: threadId,
    }),
  );
  const initialWorkspaceContentHash = await treeContentHash(
    path.join(initialVersionRoot, "workspace"),
  );
  const initialSessionContentHash = await treeContentHash(
    path.join(initialVersionRoot, "codex-home"),
  );
  const initialOutboxContentHash = await treeContentHash(
    path.join(initialVersionRoot, "outbox"),
  );
  const initialSqliteContentHash = commitment(
    JSON.stringify([
      {
        id: "demo",
        value: "ready",
        updatedAt: initialSqliteUpdatedAt,
      },
    ]),
  );
  const initialContentHash = commitment(
    JSON.stringify({
      workspaceContentHash: initialWorkspaceContentHash,
      sessionContentHash: initialSessionContentHash,
      sqliteContentHash: initialSqliteContentHash,
      outboxContentHash: initialOutboxContentHash,
      codexThreadId: null,
    }),
  );
  const candidateSqliteBytes = await readFile(
    path.join(workspace, ".airlock", "demo.sqlite"),
  );
  const changes = {
    files: [
      {
        path: ".airlock/demo.sqlite",
        kind: "modified",
        addedBytes: candidateSqliteBytes.length,
      },
      {
        path: "protocol-proof.txt",
        kind: "added",
        addedBytes: Buffer.byteLength("candidate-only\n"),
      },
    ],
    totalChangedFiles: 2,
    totalAddedBytes:
      candidateSqliteBytes.length + Buffer.byteLength("candidate-only\n"),
    truncated: false,
  };
  const executionAttestation = {
    schemaVersion: 2,
    attestation: "airlock-control-plane",
    inferenceMode: "local-responses-protocol-fixture",
    executor: "codex-cli",
    runtimeProvider: "local-process",
    providerProtocol: "responses",
    modelCommitment: protocolModelCommitment,
    preflight: null,
  };
  const validations = [
    {
      name: "execution-profile",
      status: "passed",
      required: true,
      summary:
        "Airlock control plane attested successful execution through real Codex CLI against the local Responses protocol fixture. Model identity is committed without disclosure as " +
        protocolModelCommitment.slice(0, "sha256:".length + 12) +
        ".",
      durationMs: 0,
      output: JSON.stringify(executionAttestation, null, 2),
    },
    ...[
      "path-safety",
      "protected-paths",
      "required-paths",
      "change-limits",
      "secret-patterns",
    ].map((name) => ({
      name,
      status: "passed",
      required: true,
      summary: `${name} passed`,
      durationMs: 1,
      output: null,
    })),
    {
      name: "assurance-catalog-rule:private-key-block:v1",
      status: "passed",
      required: false,
      summary: "Trusted catalog detector found no match in changed files",
      durationMs: 1,
      output: null,
    },
    ...[
      "protocol-fixture-content",
      "sqlite-resource",
      "external-action-intents",
    ].map((name) => ({
      name,
      status: "passed",
      required: true,
      summary: `${name} passed`,
      durationMs: 1,
      output: null,
    })),
  ];
  const validationEvidenceHash = commitment(JSON.stringify(validations));
  const initialManifest = {
    schemaVersion: 4,
    agentId,
    stateId: initialStateId,
    workspacePath: `/app/workspaces/${agentId}/versions/${initialStateId}/workspace`,
    codexHomePath: `/app/workspaces/${agentId}/versions/${initialStateId}/codex-home`,
    outboxPath: `/app/workspaces/${agentId}/versions/${initialStateId}/outbox`,
    codexThreadId: null,
    workspaceContentHash: initialWorkspaceContentHash,
    sessionContentHash: initialSessionContentHash,
    sqliteContentHash: initialSqliteContentHash,
    outboxContentHash: initialOutboxContentHash,
    providerVersions: [],
    contentHash: initialContentHash,
    createdAt: "2026-08-31T00:00:01.000Z",
    sourceRunId: null,
  };
  const proof = transactionProof(contentHash, validationEvidenceHash);
  const manifest = {
    schemaVersion: 4,
    agentId,
    stateId,
    workspacePath: `/app/workspaces/${agentId}/versions/${stateId}/workspace`,
    codexHomePath: `/app/workspaces/${agentId}/versions/${stateId}/codex-home`,
    outboxPath: `/app/workspaces/${agentId}/versions/${stateId}/outbox`,
    codexThreadId: threadId,
    workspaceContentHash,
    sessionContentHash,
    sqliteContentHash,
    outboxContentHash,
    providerVersions: [],
    contentHash,
    createdAt: "2026-08-31T00:00:02.150Z",
    sourceRunId: runId,
  };
  const candidateManifest = {
    schemaVersion: 4,
    agentId,
    runId,
    candidateStateId: stateId,
    canonicalStateIdBefore: initialStateId,
    canonicalContentHashBefore: initialContentHash,
    canonicalWorkspaceHashBefore: initialWorkspaceContentHash,
    canonicalSessionHashBefore: initialSessionContentHash,
    canonicalSqliteHashBefore: initialSqliteContentHash,
    canonicalOutboxHashBefore: initialOutboxContentHash,
    canonicalProviderVersionsBefore: [],
    canonicalThreadIdBefore: null,
    candidateThreadId: threadId,
    repairSourceRunId: null,
    repairReferenceHash: null,
    createdAt: manifest.createdAt,
  };
  const manifestPath = path.join(root, "workspaces", agentId, "canonical.json");
  const initialHistoryPath = path.join(historyRoot, `${initialStateId}.json`);
  const currentHistoryPath = path.join(historyRoot, `${stateId}.json`);
  const candidatePath = path.join(versionRoot, "candidate.json");
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(currentHistoryPath, `${JSON.stringify(manifest)}\n`),
    writeFile(initialHistoryPath, `${JSON.stringify(initialManifest)}\n`),
    writeFile(candidatePath, `${JSON.stringify(candidateManifest)}\n`),
  ]);
  await writeFile(path.join(globalCodex, "config.toml"), "model = 'fixture'\n");
  const persistedIntent = {
    id: "protocol-release-ready",
    type: "demo.notification.requested",
    destination: effectPayload.destination,
    subject: effectPayload.subject,
    idempotencyKey: effectIdempotencyKey,
    status: "delivered",
    deliveredAt: "2026-08-31T00:00:03.000Z",
  };
  const launchpad = {
    version: 10,
    agents: [
      {
        id: agentId,
        name: agentName,
        description: realRuntimeProofAgentDescription,
        instructions: realRuntimeProofAgentInstructions,
        status: "ready",
        workspacePath: manifest.workspacePath,
        canonicalStateId: stateId,
        codexThreadId: threadId,
        outcomeContract: structuredClone(configuredOutcomeContract),
        lastError: null,
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:04.000Z",
      },
    ],
    messages: [
      {
        id: userMessageId,
        agentId,
        runId,
        role: "user",
        content: userPrompt,
        createdAt: "2026-08-31T00:00:02.000Z",
      },
      {
        id: assistantMessageId,
        agentId,
        runId,
        role: "assistant",
        content: assistantOutput,
        createdAt: "2026-08-31T00:00:04.000Z",
      },
    ],
    runs: [
      {
        id: runId,
        agentId,
        candidateSetId: null,
        competitorId: null,
        status: "completed",
        prompt: userPrompt,
        output: assistantOutput,
        error: null,
        usage: { inputTokens: 1, outputTokens: 1 },
        startedAt: "2026-08-31T00:00:02.100Z",
        createdAt: "2026-08-31T00:00:02.000Z",
        completedAt: "2026-08-31T00:00:04.000Z",
        transaction: {
          id: runId,
          assuranceEvidenceVersion: 1,
          status: "promoted",
          disposition: "promoted",
          candidateStateId: stateId,
          canonicalStateIdBefore: initialStateId,
          canonicalContentHashBefore: initialContentHash,
          canonicalStateIdAfter: stateId,
          canonicalContentHashAfter: contentHash,
          outcomeContractVersion: 2,
          outcomeContract: structuredClone(configuredOutcomeContract),
          resources: [
            {
              kind: "workspace",
              label: "Workspace",
              disposition: "promoted",
              fingerprintBefore: initialWorkspaceContentHash,
              fingerprintAfter: workspaceContentHash,
              summary: "Workspace accepted in the new Canonical State",
            },
            {
              kind: "codex-session",
              label: "Agent memory",
              disposition: "promoted",
              fingerprintBefore: initialSessionContentHash,
              fingerprintAfter: sessionContentHash,
              summary: "Agent memory accepted in the new Canonical State",
            },
            {
              kind: "sqlite",
              label: "SQLite data",
              disposition: "promoted",
              fingerprintBefore: initialSqliteContentHash,
              fingerprintAfter: sqliteContentHash,
              summary: "SQLite data accepted in the new Canonical State",
            },
            {
              kind: "external-actions",
              label: "External actions",
              disposition: "promoted",
              fingerprintBefore: commitment(JSON.stringify([])),
              fingerprintAfter: commitment(
                JSON.stringify([
                  {
                    idempotencyKey: effectIdempotencyKey,
                    deliveredAt: "2026-08-31T00:00:03.000Z",
                  },
                ]),
              ),
              summary: "External actions accepted in the new Canonical State",
            },
          ],
          providerResources: [],
          providerResourceEvents: [],
          sqlite: {
            databasePath: ".airlock/demo.sqlite",
            integrity: "passed",
            before: {
              contentHash: initialSqliteContentHash,
              rowCount: 1,
              rows: [
                {
                  id: "demo",
                  value: "ready",
                  updatedAt: initialSqliteUpdatedAt,
                },
              ],
            },
            candidate: {
              contentHash: sqliteContentHash,
              rowCount: 1,
              rows: [
                {
                  id: "demo",
                  value: "candidate-only",
                  updatedAt: sqliteUpdatedAt,
                },
              ],
            },
            after: {
              contentHash: sqliteContentHash,
              rowCount: 1,
              rows: [
                {
                  id: "demo",
                  value: "candidate-only",
                  updatedAt: sqliteUpdatedAt,
                },
              ],
            },
          },
          externalActions: {
            outboxPath: "Candidate State/outbox/intents.jsonl",
            deliveredCount: 1,
            intents: [persistedIntent],
            bypassDisclosure: externalActionBypassDisclosure,
          },
          changes,
          validations,
          events: [
            {
              status: "preparing",
              at: "2026-08-31T00:00:02.050Z",
              summary: "Preparing isolated Candidate State",
            },
            {
              status: "executing",
              at: "2026-08-31T00:00:02.200Z",
              summary: "Agent Runtime is executing against Candidate State",
            },
            {
              status: "validating",
              at: "2026-08-31T00:00:02.400Z",
              summary: "Evaluating the Candidate State outcome",
            },
            {
              status: "promoting",
              at: "2026-08-31T00:00:02.600Z",
              summary: "All required Validations passed",
            },
            {
              status: "promoting",
              at: "2026-08-31T00:00:02.700Z",
              summary:
                "Canonical State advanced before external action delivery",
            },
            {
              status: "promoted",
              at: "2026-08-31T00:00:03.200Z",
              summary: "Candidate State is now Canonical State",
            },
          ],
          quarantinePath: null,
          quarantineAvailable: false,
          discardedAt: null,
          lineage: {
            rootRunId: runId,
            parentRunId: null,
            depth: 0,
            maxDepth: 2,
          },
          recovery: {
            journalPhase: "completed",
            recoveredAfterRestart: false,
            recoveryError: null,
          },
          promotionReceipt: {
            runTransactionId: runId,
            disposition: "promoted",
            outcomeContractVersion: 2,
            canonicalStateIdBefore: initialStateId,
            canonicalStateIdAfter: stateId,
            canonicalContentHashBefore: initialContentHash,
            canonicalContentHashAfter: contentHash,
            validationEvidenceHash,
            lineage: {
              rootRunId: runId,
              parentRunId: null,
              depth: 0,
              maxDepth: 2,
            },
            createdAt: "2026-08-31T00:00:03.100Z",
          },
        },
      },
    ],
    candidateSets: [],
    assuranceProposals: [],
    outcomeContractVersions: [
      {
        schemaVersion: 1,
        agentId,
        contract: structuredClone(defaultOutcomeContract),
        provenance: "created",
        sourceProposalId: null,
        rollbackFromVersion: null,
      },
      {
        schemaVersion: 1,
        agentId,
        contract: structuredClone(configuredOutcomeContract),
        provenance: "manual",
        sourceProposalId: null,
        rollbackFromVersion: null,
      },
    ],
  };
  await writeFile(
    path.join(data, "launchpad.json"),
    `${JSON.stringify(launchpad)}\n`,
  );
  await writeFile(
    path.join(data, "mock-deliveries.json"),
    `${JSON.stringify({
      version: 2,
      consumerId: "55555555-5555-4555-8555-555555555555",
      deliveries: [
        {
          runId,
          intentId: "protocol-release-ready",
          idempotencyKey: effectIdempotencyKey,
          type: "demo.notification.requested",
          destination: effectPayload.destination,
          subject: effectPayload.subject,
          payloadHash: effectPayloadHash,
          deliveredAt: "2026-08-31T00:00:03.000Z",
          deliveryMode: "atomic-local-store",
        },
      ],
    })}\n`,
  );
  const transactionProofFile = path.join(root, "transaction-proof.json");
  const snapshotFile = path.join(root, "physical-proof.json");
  await writeFile(transactionProofFile, `${JSON.stringify(proof)}\n`);
  return {
    agentRoot,
    canonicalCodex,
    candidatePath,
    candidates: path.join(workspaces, ".candidates"),
    data,
    dataSentinelPath: path.join(data, ".production-gate-sandbox-sentinel"),
    dataSentinelContent,
    globalCodex,
    historyRoot,
    initialHistoryPath,
    initialManifest,
    initialVersionRoot,
    launchpad: path.join(data, "launchpad.json"),
    manifestPath,
    currentHistoryPath,
    outbox: path.join(versionRoot, "outbox"),
    proof,
    root,
    snapshotFile,
    transactionProofFile,
    versionRoot,
    workspace,
    workspaces,
    workspaceSentinelPath: path.join(
      workspaces,
      ".production-gate-sandbox-sentinel",
    ),
    workspaceSentinelContent,
  };
}

async function replaceDirectoryWithExternalSymlink(target) {
  const outsideRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-physical-proof-outside-"),
  );
  const outsideTarget = path.join(outsideRoot, path.basename(target));
  await rename(target, outsideTarget);
  await symlink(outsideTarget, target, "dir");
  return outsideRoot;
}

async function mutateJsonFile(target, mutate) {
  const value = JSON.parse(await readFile(target, "utf8"));
  mutate(value);
  await writeFile(target, `${JSON.stringify(value)}\n`);
}

test("physical persistence verifier binds Canonical resources and restart bytes", async () => {
  const value = await fixture();
  try {
    const created = await verifyProductionImagePersistence({
      mode: "create",
      sessionRoot: value.root,
      snapshotFile: value.snapshotFile,
      transactionProofFile: value.transactionProofFile,
      dataSentinelContent: value.dataSentinelContent,
      workspaceSentinelContent: value.workspaceSentinelContent,
    });
    const restarted = await verifyProductionImagePersistence({
      mode: "restart",
      sessionRoot: value.root,
      snapshotFile: value.snapshotFile,
      transactionProofFile: value.transactionProofFile,
      dataSentinelContent: value.dataSentinelContent,
      workspaceSentinelContent: value.workspaceSentinelContent,
    });
    assert.deepEqual(restarted, created);
  } finally {
    await rm(value.root, { force: true, recursive: true });
  }
});

test("physical persistence verifier binds the entire workspace mount across restart", async () => {
  const value = await fixture();
  try {
    await verifyProductionImagePersistence({
      mode: "create",
      sessionRoot: value.root,
      snapshotFile: value.snapshotFile,
      transactionProofFile: value.transactionProofFile,
      dataSentinelContent: value.dataSentinelContent,
      workspaceSentinelContent: value.workspaceSentinelContent,
    });
    const currentHistory = JSON.parse(
      await readFile(value.currentHistoryPath, "utf8"),
    );
    await writeFile(
      value.currentHistoryPath,
      `${JSON.stringify(currentHistory, null, 2)}\n`,
    );
    await assert.rejects(
      verifyProductionImagePersistence({
        mode: "restart",
        sessionRoot: value.root,
        snapshotFile: value.snapshotFile,
        transactionProofFile: value.transactionProofFile,
        dataSentinelContent: value.dataSentinelContent,
        workspaceSentinelContent: value.workspaceSentinelContent,
      }),
      /changed across restart/,
    );
  } finally {
    await rm(value.root, { force: true, recursive: true });
  }
});

test("physical persistence verifier binds the exact retained workspace sandbox sentinel", async (context) => {
  for (const [name, mutate, expectedContent] of [
    [
      "missing sentinel",
      (value) => rm(value.workspaceSentinelPath),
      workspaceSentinelContent,
    ],
    [
      "mutated sentinel bytes",
      (value) => writeFile(value.workspaceSentinelPath, "mutated\n"),
      workspaceSentinelContent,
    ],
    [
      "contradictory expected nonce",
      () => undefined,
      "protected-workspaces:fedcba9876543210fedcba98",
    ],
    [
      "malformed expected nonce",
      () => undefined,
      "protected-workspaces:not-a-lowercase-nonce",
    ],
  ]) {
    await context.test(name, async () => {
      const value = await fixture();
      try {
        await mutate(value);
        await assert.rejects(
          inspectProductionImagePersistence({
            sessionRoot: value.root,
            transactionProof: value.proof,
            dataSentinelContent: value.dataSentinelContent,
            workspaceSentinelContent: expectedContent,
          }),
          /mount inventory is not exact/,
        );
      } finally {
        await rm(value.root, { force: true, recursive: true });
      }
    });
  }
});

test("physical persistence verifier binds the exact retained data sandbox sentinel", async (context) => {
  for (const [name, mutate, expectedContent] of [
    [
      "missing sentinel",
      (value) => rm(value.dataSentinelPath),
      dataSentinelContent,
    ],
    [
      "contradictory expected nonce",
      () => undefined,
      "protected-data:fedcba9876543210fedcba98",
    ],
    [
      "workspace/data nonce mismatch",
      () => undefined,
      "protected-data:fedcba9876543210fedcba98",
    ],
  ]) {
    await context.test(name, async () => {
      const value = await fixture();
      try {
        await mutate(value);
        await assert.rejects(
          inspectProductionImagePersistence({
            sessionRoot: value.root,
            transactionProof: value.proof,
            dataSentinelContent: expectedContent,
            workspaceSentinelContent: value.workspaceSentinelContent,
          }),
          /data mount inventory is not exact/,
        );
      } finally {
        await rm(value.root, { force: true, recursive: true });
      }
    });
  }
});

test("physical persistence verifier rejects contradictory persisted lineage", async (context) => {
  for (const [name, target, mutate, expectedError] of [
    [
      "Candidate manifest extra field",
      (value) => value.candidatePath,
      (candidate) => {
        candidate.orphan = true;
      },
      /Promoted Candidate manifest/,
    ],
    [
      "Candidate manifest source state",
      (value) => value.candidatePath,
      (candidate) => {
        candidate.canonicalStateIdBefore =
          "99999999-9999-4999-8999-999999999999";
      },
      /Promoted Candidate manifest/,
    ],
    [
      "Candidate manifest source workspace commitment",
      (value) => value.candidatePath,
      (candidate) => {
        candidate.canonicalWorkspaceHashBefore = hash("c");
      },
      /Promoted Candidate manifest/,
    ],
    [
      "Candidate manifest promoted timestamp",
      (value) => value.candidatePath,
      (candidate) => {
        candidate.createdAt = "2026-08-31T00:00:02.000Z";
      },
      /Promoted Candidate manifest/,
    ],
    [
      "Candidate manifest Repair lineage",
      (value) => value.candidatePath,
      (candidate) => {
        candidate.repairSourceRunId = runId;
      },
      /Promoted Candidate manifest/,
    ],
    [
      "initial Canonical manifest physical commitment",
      (value) => value.initialHistoryPath,
      (initial) => {
        initial.workspaceContentHash = hash("c");
      },
      /Initial Canonical manifest/,
    ],
    [
      "initial Canonical manifest source Run",
      (value) => value.initialHistoryPath,
      (initial) => {
        initial.sourceRunId = runId;
      },
      /Initial Canonical manifest/,
    ],
    [
      "initial Canonical manifest after Run creation",
      (value) => value.initialHistoryPath,
      (manifest) => {
        manifest.createdAt = "2026-08-31T00:00:02.010Z";
      },
      /control-plane database/,
    ],
    [
      "current Canonical history semantic identity",
      (value) => value.currentHistoryPath,
      (current) => {
        current.contentHash = hash("c");
      },
      /Current Canonical history/,
    ],
    [
      "persisted transaction Candidate state",
      (value) => value.launchpad,
      (database) => {
        delete database.runs[0].transaction.candidateStateId;
      },
      /control-plane database/,
    ],
    [
      "persisted transaction source Canonical state",
      (value) => value.launchpad,
      (database) => {
        database.runs[0].transaction.canonicalStateIdBefore =
          "99999999-9999-4999-8999-999999999999";
      },
      /control-plane database/,
    ],
    [
      "persisted transaction source Canonical commitment",
      (value) => value.launchpad,
      (database) => {
        database.runs[0].transaction.canonicalContentHashBefore = hash("c");
      },
      /control-plane database/,
    ],
    [
      "persisted workspace Resource source fingerprint",
      (value) => value.launchpad,
      (database) => {
        database.runs[0].transaction.resources[0].fingerprintBefore = hash("c");
      },
      /Persisted Run Resource/,
    ],
    [
      "persisted SQLite source snapshot omission",
      (value) => value.launchpad,
      (database) => {
        delete database.runs[0].transaction.sqlite.before;
      },
      /Persisted Run Resource/,
    ],
    [
      "persisted SQLite source snapshot drift",
      (value) => value.launchpad,
      (database) => {
        database.runs[0].transaction.sqlite.before.rows[0].value = "unsafe";
      },
      /Persisted Run Resource/,
    ],
    [
      "persisted receipt source Canonical state",
      (value) => value.launchpad,
      (database) => {
        database.runs[0].transaction.promotionReceipt.canonicalStateIdBefore =
          "99999999-9999-4999-8999-999999999999";
      },
      /control-plane database/,
    ],
    [
      "persisted receipt source Canonical commitment",
      (value) => value.launchpad,
      (database) => {
        database.runs[0].transaction.promotionReceipt.canonicalContentHashBefore =
          hash("c");
      },
      /control-plane database/,
    ],
  ]) {
    await context.test(name, async () => {
      const value = await fixture();
      try {
        await mutateJsonFile(target(value), mutate);
        await assert.rejects(
          inspectProductionImagePersistence({
            sessionRoot: value.root,
            transactionProof: value.proof,
            dataSentinelContent: value.dataSentinelContent,
            workspaceSentinelContent: value.workspaceSentinelContent,
          }),
          expectedError,
        );
      } finally {
        await rm(value.root, { force: true, recursive: true });
      }
    });
  }
});

test("physical persistence verifier scans transient workspace roots for credentials", async () => {
  const value = await fixture();
  try {
    const candidateRoot = path.join(value.candidates, runId);
    await mkdir(candidateRoot);
    await writeFile(
      path.join(candidateRoot, "credential.env"),
      "PASSWORD=workspace-candidate-credential-123456\n",
    );
    await assert.rejects(
      inspectProductionImagePersistence({
        sessionRoot: value.root,
        transactionProof: value.proof,
        dataSentinelContent: value.dataSentinelContent,
        workspaceSentinelContent: value.workspaceSentinelContent,
      }),
      /forbidden sensitive content/,
    );
  } finally {
    await rm(value.root, { force: true, recursive: true });
  }
});

test("physical persistence verifier rejects resource mutations", async (context) => {
  for (const [name, mutate] of [
    [
      "retained data sandbox sentinel",
      (value) => writeFile(value.dataSentinelPath, "mutated\n"),
    ],
    [
      "orphan data file",
      (value) => writeFile(path.join(value.data, "orphan.json"), "{}\n"),
    ],
    [
      "orphan data directory",
      (value) => mkdir(path.join(value.data, "orphan")),
    ],
    [
      "orphan global Codex file",
      (value) => writeFile(path.join(value.globalCodex, "orphan"), "orphan\n"),
    ],
    [
      "orphan global Codex directory",
      (value) => mkdir(path.join(value.globalCodex, "orphan")),
    ],
    [
      "Canonical protocol content",
      (value) =>
        writeFile(path.join(value.workspace, "protocol-proof.txt"), "unsafe\n"),
    ],
    [
      "Canonical workspace extra artifact",
      (value) =>
        writeFile(path.join(value.workspace, "orphan.txt"), "orphan\n"),
    ],
    [
      "Canonical workspace extra directory",
      (value) => mkdir(path.join(value.workspace, "orphan")),
    ],
    [
      "nonempty Candidate transient root",
      (value) =>
        writeFile(path.join(value.candidates, "orphan.txt"), "orphan\n"),
    ],
    [
      "extra Agent workspace root",
      (value) =>
        mkdir(
          path.join(value.workspaces, "99999999-9999-4999-8999-999999999999"),
        ),
    ],
    [
      "nested Canonical history directory",
      (value) => mkdir(path.join(value.historyRoot, "orphan")),
    ],
    [
      "Canonical versions root artifact",
      (value) =>
        writeFile(
          path.join(value.agentRoot, "versions", "orphan.txt"),
          "orphan\n",
        ),
    ],
    [
      "initial Canonical version extra artifact",
      (value) =>
        writeFile(
          path.join(value.initialVersionRoot, "workspace", "orphan.txt"),
          "orphan\n",
        ),
    ],
    [
      "promoted Resource snapshot artifact",
      (value) =>
        writeFile(
          path.join(value.versionRoot, "resources", "orphan.json"),
          "{}\n",
        ),
    ],
    [
      "Canonical workspace symlink artifact",
      async (value) => {
        const outside = path.join(value.root, "external-readme.md");
        await writeFile(outside, expectedReadme);
        await rm(path.join(value.workspace, "README.md"));
        await symlink(outside, path.join(value.workspace, "README.md"), "file");
      },
    ],
    [
      "protected AGENTS content",
      (value) =>
        writeFile(path.join(value.workspace, "AGENTS.md"), "mutated\n"),
    ],
    [
      "required README content",
      (value) =>
        writeFile(path.join(value.workspace, "README.md"), "mutated\n"),
    ],
    [
      "Canonical SQLite row",
      async (value) => {
        const database = new DatabaseSync(
          path.join(value.workspace, ".airlock", "demo.sqlite"),
        );
        database
          .prepare("UPDATE inventory SET value = ? WHERE id = ?")
          .run("unsafe", "demo");
        database.close();
      },
    ],
    [
      "Canonical SQLite updated timestamp",
      async (value) => {
        const database = new DatabaseSync(
          path.join(value.workspace, ".airlock", "demo.sqlite"),
        );
        database
          .prepare("UPDATE inventory SET updated_at = ? WHERE id = ?")
          .run("2026-08-29T00:00:00.000Z", "demo");
        database.close();
      },
    ],
    [
      "Canonical SQLite extra row",
      async (value) => {
        const database = new DatabaseSync(
          path.join(value.workspace, ".airlock", "demo.sqlite"),
        );
        database
          .prepare(
            "INSERT INTO inventory (id, value, updated_at) VALUES (?, ?, ?)",
          )
          .run("orphan", "candidate-only", sqliteUpdatedAt);
        database.close();
      },
    ],
    [
      "Canonical SQLite extra table",
      async (value) => {
        const database = new DatabaseSync(
          path.join(value.workspace, ".airlock", "demo.sqlite"),
        );
        database.exec("CREATE TABLE orphan (id TEXT)");
        database.close();
      },
    ],
    [
      "Canonical SQLite extra index",
      async (value) => {
        const database = new DatabaseSync(
          path.join(value.workspace, ".airlock", "demo.sqlite"),
        );
        database.exec("CREATE INDEX inventory_value ON inventory(value)");
        database.close();
      },
    ],
    [
      "Canonical SQLite extra trigger",
      async (value) => {
        const database = new DatabaseSync(
          path.join(value.workspace, ".airlock", "demo.sqlite"),
        );
        database.exec(`
          CREATE TRIGGER inventory_update
          AFTER UPDATE ON inventory
          BEGIN
            SELECT 1;
          END
        `);
        database.close();
      },
    ],
    [
      "Canonical SQLite extra column",
      async (value) => {
        const database = new DatabaseSync(
          path.join(value.workspace, ".airlock", "demo.sqlite"),
        );
        database.exec("ALTER TABLE inventory ADD COLUMN note TEXT");
        database.close();
      },
    ],
    [
      "Canonical Codex session",
      (value) =>
        writeFile(
          path.join(
            value.canonicalCodex,
            "sessions",
            "2026",
            `rollout-2026-08-31T00-00-00-${threadId}.jsonl`,
          ),
          "{}\n",
        ),
    ],
    [
      "external-action receipt",
      (value) =>
        writeFile(
          path.join(value.data, "mock-deliveries.json"),
          '{"version":2,"consumerId":"55555555-5555-4555-8555-555555555555","deliveries":[]}\n',
        ),
    ],
    [
      "Canonical external-action payload",
      (value) =>
        writeFile(
          path.join(value.versionRoot, "outbox", "intents.jsonl"),
          `${JSON.stringify({
            schemaVersion: 1,
            id: "protocol-release-ready",
            type: "demo.notification.requested",
            payload: { ...effectPayload, body: "mutated" },
          })}\n`,
        ),
    ],
    [
      "Canonical outbox extra artifact",
      (value) => writeFile(path.join(value.outbox, "orphan.jsonl"), "{}\n"),
    ],
    ...[
      "workspaceContentHash",
      "sessionContentHash",
      "sqliteContentHash",
      "outboxContentHash",
    ].map((field) => [
      `Canonical manifest ${field}`,
      async (value) => {
        const manifest = JSON.parse(await readFile(value.manifestPath, "utf8"));
        manifest[field] = hash("c");
        await writeFile(value.manifestPath, `${JSON.stringify(manifest)}\n`);
      },
    ]),
    [
      "Canonical manifest composite commitment",
      async (value) => {
        const manifest = JSON.parse(await readFile(value.manifestPath, "utf8"));
        manifest.contentHash = hash("c");
        await writeFile(value.manifestPath, `${JSON.stringify(manifest)}\n`);
      },
    ],
    [
      "Canonical manifest extra field",
      async (value) => {
        const manifest = JSON.parse(await readFile(value.manifestPath, "utf8"));
        manifest.orphan = true;
        await writeFile(value.manifestPath, `${JSON.stringify(manifest)}\n`);
      },
    ],
    [
      "Canonical manifest provider versions",
      async (value) => {
        const manifest = JSON.parse(await readFile(value.manifestPath, "utf8"));
        manifest.providerVersions = [{ providerId: "orphan" }];
        await writeFile(value.manifestPath, `${JSON.stringify(manifest)}\n`);
      },
    ],
    [
      "Canonical manifest source Run",
      async (value) => {
        const manifest = JSON.parse(await readFile(value.manifestPath, "utf8"));
        manifest.sourceRunId = "99999999-9999-4999-8999-999999999999";
        await writeFile(value.manifestPath, `${JSON.stringify(manifest)}\n`);
      },
    ],
    [
      "Canonical manifest creation chronology",
      async (value) => {
        const manifest = JSON.parse(await readFile(value.manifestPath, "utf8"));
        manifest.createdAt = "2026-08-31T00:00:05.000Z";
        await writeFile(value.manifestPath, `${JSON.stringify(manifest)}\n`);
      },
    ],
    [
      "persisted control-plane transaction",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.runs[0].transaction.canonicalStateIdAfter =
          "99999999-9999-4999-8999-999999999999";
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "persisted Agent envelope omission",
      (value) =>
        mutateJsonFile(value.launchpad, (database) => {
          delete database.agents[0].createdAt;
        }),
    ],
    [
      "persisted Run envelope omission",
      (value) =>
        mutateJsonFile(value.launchpad, (database) => {
          delete database.runs[0].startedAt;
        }),
    ],
    [
      "persisted trusted assurance version omission",
      (value) =>
        mutateJsonFile(value.launchpad, (database) => {
          delete database.runs[0].transaction.assuranceEvidenceVersion;
        }),
    ],
    [
      "persisted transaction orphan field",
      (value) =>
        mutateJsonFile(value.launchpad, (database) => {
          database.runs[0].transaction.orphan = true;
        }),
    ],
    [
      "persisted Resource label drift",
      (value) =>
        mutateJsonFile(value.launchpad, (database) => {
          database.runs[0].transaction.resources[0].label = "Orphan";
        }),
    ],
    [
      "persisted Validation evidence drift",
      (value) =>
        mutateJsonFile(value.launchpad, (database) => {
          database.runs[0].transaction.validations[1].durationMs += 1;
        }),
    ],
    [
      "persisted Validation orphan record",
      (value) =>
        mutateJsonFile(value.launchpad, (database) => {
          database.runs[0].transaction.validations.push(
            structuredClone(database.runs[0].transaction.validations[1]),
          );
        }),
    ],
    [
      "persisted change evidence drift",
      (value) =>
        mutateJsonFile(value.launchpad, (database) => {
          database.runs[0].transaction.changes.files[0].addedBytes += 1;
        }),
    ],
    [
      "persisted lifecycle event drift",
      (value) =>
        mutateJsonFile(value.launchpad, (database) => {
          database.runs[0].transaction.events[4].summary = "Invented advance";
        }),
    ],
    [
      "persisted external-action envelope drift",
      (value) =>
        mutateJsonFile(value.launchpad, (database) => {
          database.runs[0].transaction.externalActions.outboxPath = "orphan";
        }),
    ],
    [
      "persisted promotion receipt disposition drift",
      (value) =>
        mutateJsonFile(value.launchpad, (database) => {
          database.runs[0].transaction.promotionReceipt.disposition =
            "quarantined";
        }),
    ],
    [
      "persisted orphan provider Resource",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.runs[0].transaction.providerResources.push({
          providerId: "orphan",
        });
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "persisted workspace Resource fingerprint",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.runs[0].transaction.resources[0].fingerprintAfter = hash("c");
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "persisted SQLite row evidence",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.runs[0].transaction.sqlite.after.rows[0].updatedAt =
          "2026-08-29T00:00:00.000Z";
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "persisted Agent Codex thread",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.agents[0].codexThreadId =
          "99999999-9999-4999-8999-999999999999";
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "persisted Agent workspace path",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.agents[0].workspacePath = "/app/workspaces/orphan/workspace";
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "orphan persisted message",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.messages.push({
          ...database.messages[0],
          id: "88888888-8888-4888-8888-888888888888",
          runId: "99999999-9999-4999-8999-999999999999",
        });
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "contradictory persisted message",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.messages[1].agentId = "99999999-9999-4999-8999-999999999999";
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "contradictory persisted assistant output",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.messages[1].content = "A stale assistant answer.";
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "contradictory persisted production boundary prompt",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.messages[0].content =
          "Apply a stale protocol release through isolated Candidate State.";
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "extra Outcome Contract version",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.outcomeContractVersions.push({
          ...structuredClone(database.outcomeContractVersions[1]),
          contract: {
            ...structuredClone(database.outcomeContractVersions[1].contract),
            version: 3,
            createdAt: "2026-08-31T00:00:05.000Z",
          },
        });
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "contradictory Outcome Contract history",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.outcomeContractVersions[1].contract.maxChangedFiles = 5;
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
    [
      "Codex rollout semantic identity",
      (value) =>
        writeFile(
          path.join(
            value.canonicalCodex,
            "sessions",
            "2026",
            `rollout-2026-08-31T00-00-00-${threadId}.jsonl`,
          ),
          `${JSON.stringify({ note: `contains ${threadId} as text only` })}\n`,
        ),
    ],
    [
      "Codex rollout top-level thread field",
      (value) =>
        writeFile(
          path.join(
            value.canonicalCodex,
            "sessions",
            "2026",
            `rollout-2026-08-31T00-00-00-${threadId}.jsonl`,
          ),
          `${JSON.stringify({ threadId })}\n`,
        ),
    ],
    [
      "Codex rollout filename identity",
      async (value) => {
        const sessions = path.join(value.canonicalCodex, "sessions", "2026");
        await rename(
          path.join(sessions, `rollout-2026-08-31T00-00-00-${threadId}.jsonl`),
          path.join(sessions, `rollout-${threadId}-stale.jsonl`),
        );
      },
    ],
  ]) {
    await context.test(name, async () => {
      const value = await fixture();
      try {
        await mutate(value);
        await assert.rejects(
          inspectProductionImagePersistence({
            sessionRoot: value.root,
            transactionProof: value.proof,
            dataSentinelContent: value.dataSentinelContent,
            workspaceSentinelContent: value.workspaceSentinelContent,
          }),
          /Canonical|Persisted workspace|Production image|Resource Provider|receipt store|control-plane|Outcome Contract|Persisted Run|Validation/,
        );
      } finally {
        await rm(value.root, { force: true, recursive: true });
      }
    });
  }
});

test("physical persistence verifier rejects persisted sensitive content", async (context) => {
  for (const [name, sensitiveValue, mutate] of [
    [
      "known protocol API credential in Canonical Codex",
      "deterministic-protocol-fixture",
      (value) =>
        writeFile(
          path.join(value.canonicalCodex, "leaked.env"),
          "ARK_API_KEY=deterministic-protocol-fixture\n",
        ),
    ],
    [
      "known access token in mounted Codex configuration",
      "phase11-container-verification-token",
      (value) =>
        writeFile(
          path.join(value.globalCodex, "leaked-credentials.toml"),
          'auth_token = "phase11-container-verification-token"\n',
        ),
    ],
    [
      "secret-shaped control-plane field",
      "unrecognized-secret-value-1234",
      async (value) => {
        const database = JSON.parse(await readFile(value.launchpad, "utf8"));
        database.runs[0].apiKey = "unrecognized-secret-value-1234";
        await writeFile(value.launchpad, `${JSON.stringify(database)}\n`);
      },
    ],
  ]) {
    await context.test(name, async () => {
      const value = await fixture();
      try {
        await mutate(value);
        await assert.rejects(
          inspectProductionImagePersistence({
            sessionRoot: value.root,
            transactionProof: value.proof,
            dataSentinelContent: value.dataSentinelContent,
            workspaceSentinelContent: value.workspaceSentinelContent,
          }),
          (error) => {
            assert.match(error.message, /forbidden sensitive content/);
            assert.equal(error.message.includes(sensitiveValue), false);
            return true;
          },
        );
      } finally {
        await rm(value.root, { force: true, recursive: true });
      }
    });
  }
});

test("physical persistence verifier rejects symlinked resource ancestors", async (context) => {
  for (const [name, target] of [
    ["workspaces mount", (value) => path.join(value.root, "workspaces")],
    ["Agent root", (value) => value.agentRoot],
    ["version root", (value) => value.versionRoot],
    ["workspace root", (value) => value.workspace],
    ["SQLite parent", (value) => path.join(value.workspace, ".airlock")],
    ["outbox root", (value) => value.outbox],
    ["Canonical Codex root", (value) => value.canonicalCodex],
    [
      "nested Codex sessions directory",
      (value) => path.join(value.canonicalCodex, "sessions", "2026"),
    ],
    ["data mount", (value) => value.data],
    ["global Codex mount", (value) => value.globalCodex],
  ]) {
    await context.test(name, async () => {
      const value = await fixture();
      let outsideRoot;
      try {
        outsideRoot = await replaceDirectoryWithExternalSymlink(target(value));
        await assert.rejects(
          inspectProductionImagePersistence({
            sessionRoot: value.root,
            transactionProof: value.proof,
            dataSentinelContent: value.dataSentinelContent,
            workspaceSentinelContent: value.workspaceSentinelContent,
          }),
          /physical|escaped|unsafe|symlink/i,
        );
      } finally {
        await rm(value.root, { force: true, recursive: true });
        if (outsideRoot) {
          await rm(outsideRoot, { force: true, recursive: true });
        }
      }
    });
  }
});

test("physical persistence verifier rejects a symlinked artifact parent", async () => {
  const value = await fixture();
  let outsideRoot;
  try {
    outsideRoot = await mkdtemp(
      path.join(os.tmpdir(), "airlock-physical-proof-artifact-outside-"),
    );
    await writeFile(
      path.join(outsideRoot, "transaction-proof.json"),
      `${JSON.stringify(value.proof)}\n`,
    );
    const linkedParent = path.join(value.root, "linked-proof-parent");
    await symlink(outsideRoot, linkedParent, "dir");
    await assert.rejects(
      verifyProductionImagePersistence({
        mode: "create",
        sessionRoot: value.root,
        snapshotFile: value.snapshotFile,
        transactionProofFile: path.join(linkedParent, "transaction-proof.json"),
        dataSentinelContent: value.dataSentinelContent,
        workspaceSentinelContent: value.workspaceSentinelContent,
      }),
      /artifact|physical|escaped|unsafe|symlink/i,
    );
  } finally {
    await rm(value.root, { force: true, recursive: true });
    if (outsideRoot) {
      await rm(outsideRoot, { force: true, recursive: true });
    }
  }
});

test("physical persistence verifier rejects symlinked snapshot parents in both modes", async (context) => {
  for (const mode of ["create", "restart"]) {
    await context.test(mode, async () => {
      const value = await fixture();
      let outsideRoot;
      try {
        outsideRoot = await mkdtemp(
          path.join(os.tmpdir(), "airlock-physical-snapshot-outside-"),
        );
        if (mode === "restart") {
          await verifyProductionImagePersistence({
            mode: "create",
            sessionRoot: value.root,
            snapshotFile: value.snapshotFile,
            transactionProofFile: value.transactionProofFile,
            dataSentinelContent: value.dataSentinelContent,
            workspaceSentinelContent: value.workspaceSentinelContent,
          });
          await rename(
            value.snapshotFile,
            path.join(outsideRoot, "physical-proof.json"),
          );
        }
        const linkedParent = path.join(value.root, "linked-snapshot-parent");
        await symlink(outsideRoot, linkedParent, "dir");
        await assert.rejects(
          verifyProductionImagePersistence({
            mode,
            sessionRoot: value.root,
            snapshotFile: path.join(linkedParent, "physical-proof.json"),
            transactionProofFile: value.transactionProofFile,
            dataSentinelContent: value.dataSentinelContent,
            workspaceSentinelContent: value.workspaceSentinelContent,
          }),
          /snapshot|physical|escaped|unsafe|symlink/i,
        );
      } finally {
        await rm(value.root, { force: true, recursive: true });
        if (outsideRoot) {
          await rm(outsideRoot, { force: true, recursive: true });
        }
      }
    });
  }
});

test("physical persistence verifier rejects non-canonical artifact traversal through a symlink", async () => {
  const value = await fixture();
  let outsideRoot;
  try {
    outsideRoot = await mkdtemp(
      path.join(os.tmpdir(), "airlock-physical-traversal-outside-"),
    );
    await mkdir(path.join(outsideRoot, "child"));
    await writeFile(
      path.join(outsideRoot, "transaction-proof.json"),
      `${JSON.stringify(value.proof)}\n`,
    );
    const linkedChild = path.join(value.root, "linked-child");
    await symlink(path.join(outsideRoot, "child"), linkedChild, "dir");
    const nonCanonicalProof = `${linkedChild}${path.sep}..${path.sep}transaction-proof.json`;
    assert.equal(path.resolve(nonCanonicalProof), value.transactionProofFile);
    await assert.rejects(
      verifyProductionImagePersistence({
        mode: "create",
        sessionRoot: value.root,
        snapshotFile: value.snapshotFile,
        transactionProofFile: nonCanonicalProof,
        dataSentinelContent: value.dataSentinelContent,
        workspaceSentinelContent: value.workspaceSentinelContent,
      }),
      /canonical|artifact|physical|escaped|unsafe|symlink/i,
    );
  } finally {
    await rm(value.root, { force: true, recursive: true });
    if (outsideRoot) {
      await rm(outsideRoot, { force: true, recursive: true });
    }
  }
});

test("physical persistence verifier does not create a snapshot through non-canonical traversal", async () => {
  const value = await fixture();
  let outsideRoot;
  try {
    outsideRoot = await mkdtemp(
      path.join(os.tmpdir(), "airlock-physical-snapshot-traversal-"),
    );
    await mkdir(path.join(outsideRoot, "child"));
    const linkedChild = path.join(value.root, "linked-child");
    await symlink(path.join(outsideRoot, "child"), linkedChild, "dir");
    const nonCanonicalSnapshot = `${linkedChild}${path.sep}..${path.sep}physical-proof.json`;
    await assert.rejects(
      verifyProductionImagePersistence({
        mode: "create",
        sessionRoot: value.root,
        snapshotFile: nonCanonicalSnapshot,
        transactionProofFile: value.transactionProofFile,
        dataSentinelContent: value.dataSentinelContent,
        workspaceSentinelContent: value.workspaceSentinelContent,
      }),
      /canonical|snapshot|artifact|physical|escaped|unsafe|symlink/i,
    );
    await assert.rejects(lstat(path.join(outsideRoot, "physical-proof.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(value.root, { force: true, recursive: true });
    if (outsideRoot) {
      await rm(outsideRoot, { force: true, recursive: true });
    }
  }
});
