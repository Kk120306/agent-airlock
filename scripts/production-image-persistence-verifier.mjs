#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  realRuntimeProofAgentDescription,
  realRuntimeProofAgentInstructions,
  realRuntimeProofContract,
  productionImageBoundaryPrompt,
} from "./runtime-demo-profile.mjs";

const snapshotSchema = "agent-airlock-production-image-physical-proof/v1";
const transactionSchema = "agent-airlock-production-image-transaction-proof/v1";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const dataSentinelContentPattern = /^protected-data:([a-f0-9]{24})$/;
const workspaceSentinelContentPattern = /^protected-workspaces:([a-f0-9]{24})$/;
const maximumJsonBytes = 8 * 1024 * 1024;
const maximumSqliteBytes = 16 * 1024 * 1024;
const maximumCodexTreeBytes = 16 * 1024 * 1024;
const maximumCodexTreeFiles = 500;
const maximumPersistedTreeBytes = 32 * 1024 * 1024;
const maximumPersistedTreeEntries = 500;
const knownForbiddenPersistedValues = [
  "deterministic-protocol-fixture",
  "phase11-container-verification-token",
];
const sensitiveEnvironmentNamePattern =
  /(?:api[_-]?key|auth[_-]?token|access[_-]?token|bearer[_-]?token|password|passwd|secret|credential|private[_-]?key)/iu;
const sensitiveAssignmentPattern =
  /(?:api[_-]?key|app[_-]?auth[_-]?token|auth[_-]?token|access[_-]?token|bearer[_-]?token|password|passwd|secret(?:[_-]?value)?|credential(?:s)?|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu;
const sensitiveValuePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/u,
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:gh[oprsu]_|github_pat_)[A-Za-z0-9_]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];
const expectedUserPrompt = productionImageBoundaryPrompt;
const expectedAssistantOutput =
  "Protocol fixture completed the requested Candidate edit.";
const expectedAgentName = "Production Image Container Proof";
const externalActionBypassDisclosure =
  "POC boundary: unrestricted Runtime networking could bypass this outbox. The supported action path is deferred until Promotion.";
const expectedValidationNames = [
  "execution-profile",
  "path-safety",
  "protected-paths",
  "required-paths",
  "change-limits",
  "secret-patterns",
  "assurance-catalog-rule:private-key-block:v1",
  "command:protocol-content",
  "sqlite-resource",
  "external-action-intents",
];
const expectedTransactionEvents = [
  ["preparing", "Preparing isolated Candidate State"],
  ["executing", "Agent Runtime is executing against Candidate State"],
  ["validating", "Evaluating the Candidate State outcome"],
  ["promoting", "All required Validations passed"],
  ["promoting", "Canonical State advanced before external action delivery"],
  ["promoted", "Candidate State is now Canonical State"],
];
const expectedResourceProfiles = [
  ["workspace", "Workspace"],
  ["codex-session", "Agent memory"],
  ["sqlite", "SQLite data"],
  ["external-actions", "External actions"],
];
const expectedGitignore = [
  ".codex/",
  "node_modules/",
  "dist/",
  ".env",
  "*.log",
  "",
].join("\n");
const expectedReadme = [
  `# ${expectedAgentName} workspace`,
  "",
  "Files created or edited by the Agent live here.",
  "The platform-generated AGENTS.md contains the current Agent instructions.",
  "",
].join("\n");
const expectedAgentInstructions = [
  "# Platform-managed Agent instructions",
  "",
  `You are the coding Agent named ${expectedAgentName}.`,
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
const canonicalManifestKeys = [
  "schemaVersion",
  "agentId",
  "stateId",
  "workspacePath",
  "codexHomePath",
  "outboxPath",
  "codexThreadId",
  "workspaceContentHash",
  "sessionContentHash",
  "sqliteContentHash",
  "outboxContentHash",
  "providerVersions",
  "contentHash",
  "createdAt",
  "sourceRunId",
];
const candidateManifestKeys = [
  "schemaVersion",
  "agentId",
  "runId",
  "candidateStateId",
  "canonicalStateIdBefore",
  "canonicalContentHashBefore",
  "canonicalWorkspaceHashBefore",
  "canonicalSessionHashBefore",
  "canonicalSqliteHashBefore",
  "canonicalOutboxHashBefore",
  "canonicalProviderVersionsBefore",
  "canonicalThreadIdBefore",
  "candidateThreadId",
  "repairSourceRunId",
  "repairReferenceHash",
  "createdAt",
];
const defaultOutcomeContractPolicy = Object.freeze({
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
});

export class ProductionImagePersistenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProductionImagePersistenceError";
  }
}

function fail(message) {
  throw new ProductionImagePersistenceError(message);
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function forbiddenPersistedValues() {
  const values = new Set(knownForbiddenPersistedValues);
  for (const [name, value] of Object.entries(process.env)) {
    if (
      sensitiveEnvironmentNamePattern.test(name) &&
      typeof value === "string" &&
      value.length >= 12
    ) {
      values.add(value);
    }
  }
  return values;
}

function assertNoPersistedSensitiveContent(bytes, label) {
  const text = bytes.toString("utf8");
  if (
    [...forbiddenPersistedValues()].some((value) => text.includes(value)) ||
    sensitiveAssignmentPattern.test(text) ||
    sensitiveValuePatterns.some((pattern) => pattern.test(text))
  ) {
    fail(`${label} contains forbidden sensitive content`);
  }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

async function assertPhysicalSessionRoot(sessionRoot) {
  if (!path.isAbsolute(sessionRoot ?? "")) {
    fail("Production image session root must be absolute");
  }
  const resolvedRoot = path.resolve(sessionRoot);
  const [physicalRoot, rootMetadata] = await Promise.all([
    realpath(sessionRoot).catch(() => null),
    lstat(sessionRoot).catch(() => null),
  ]);
  if (
    resolvedRoot !== sessionRoot ||
    physicalRoot !== sessionRoot ||
    !rootMetadata?.isDirectory() ||
    rootMetadata.isSymbolicLink()
  ) {
    fail("Production image session root is not a physical directory");
  }
  return sessionRoot;
}

async function assertPhysicalContainedPath(
  sessionRoot,
  target,
  expectedKind,
  label,
  { allowRoot = false } = {},
) {
  const resolvedRoot = path.resolve(sessionRoot);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== target) {
    fail(`${label} path is not canonical`);
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    (relative.length === 0 && !allowRoot) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`${label} escaped the production image session root`);
  }

  let current = resolvedRoot;
  let metadata = await lstat(current).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    fail("Production image session root is not a physical directory");
  }
  const components = relative.length === 0 ? [] : relative.split(path.sep);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    metadata = await lstat(current).catch(() => null);
    const isLeaf = index === components.length - 1;
    const requiredKind = isLeaf ? expectedKind : "directory";
    if (
      metadata?.isSymbolicLink() ||
      (requiredKind === "directory" && !metadata?.isDirectory()) ||
      (requiredKind === "file" && !metadata?.isFile())
    ) {
      fail(`${label} contains an unsafe or unavailable physical path`);
    }
  }

  const [physicalRoot, physicalTarget] = await Promise.all([
    realpath(resolvedRoot).catch(() => null),
    realpath(resolvedTarget).catch(() => null),
  ]);
  if (
    physicalRoot !== resolvedRoot ||
    physicalTarget !== resolvedTarget ||
    (physicalTarget !== physicalRoot && !inside(physicalRoot, physicalTarget))
  ) {
    fail(`${label} escaped its physical session boundary`);
  }
  return metadata;
}

async function assertPhysicalArtifactParent(sessionRoot, target, label) {
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== target) {
    fail(`${label} path is not canonical`);
  }
  if (!inside(path.resolve(sessionRoot), resolvedTarget)) {
    fail(`${label} escaped the production image session root`);
  }
  await assertPhysicalContainedPath(
    sessionRoot,
    path.dirname(resolvedTarget),
    "directory",
    label,
    { allowRoot: true },
  );
  const existing = await lstat(resolvedTarget).catch((error) => {
    if (error?.code === "ENOENT") return null;
    fail(`${label} is unavailable`);
  });
  if (existing?.isSymbolicLink()) {
    fail(`${label} is a symbolic link`);
  }
}

async function boundedRegularFile(target, maximumBytes, label, sessionRoot) {
  const metadata = await assertPhysicalContainedPath(
    sessionRoot,
    target,
    "file",
    label,
  );
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  ) {
    fail(`${label} is not a bounded regular file`);
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    fail(`${label} cannot be opened without following symbolic links`);
  }
  let handle;
  let opened;
  let openedAfter;
  let bytes;
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      fail(`${label} changed before it was opened`);
    }
    bytes = await handle.readFile();
    openedAfter = await handle.stat();
  } catch (error) {
    if (error instanceof ProductionImagePersistenceError) throw error;
    fail(`${label} could not be opened safely`);
  } finally {
    await handle?.close();
  }
  const after = await assertPhysicalContainedPath(
    sessionRoot,
    target,
    "file",
    label,
  );
  if (
    bytes.length !== metadata.size ||
    bytes.length > maximumBytes ||
    openedAfter.dev !== opened.dev ||
    openedAfter.ino !== opened.ino ||
    openedAfter.size !== opened.size ||
    openedAfter.mtimeMs !== opened.mtimeMs ||
    openedAfter.ctimeMs !== opened.ctimeMs ||
    after.dev !== metadata.dev ||
    after.ino !== metadata.ino ||
    after.size !== metadata.size ||
    after.mtimeMs !== metadata.mtimeMs ||
    after.ctimeMs !== metadata.ctimeMs
  ) {
    fail(`${label} changed while it was read`);
  }
  assertNoPersistedSensitiveContent(bytes, label);
  return bytes;
}

async function boundedJson(
  target,
  label,
  sessionRoot,
  maximumBytes = maximumJsonBytes,
) {
  const bytes = await boundedRegularFile(
    target,
    maximumBytes,
    label,
    sessionRoot,
  );
  return { bytes, value: parseJsonBytes(bytes, label) };
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function exactTransactionProof(value) {
  const keys = Object.keys(value ?? {}).sort();
  const expected = [
    "agentId",
    "canonicalContentHashAfter",
    "canonicalStateIdAfter",
    "completedAt",
    "effectDeliveredAt",
    "effectDestination",
    "effectIdempotencyKey",
    "effectIntentId",
    "effectPayloadHash",
    "effectSubject",
    "effectType",
    "outcomeContractVersion",
    "runId",
    "schema",
    "transactionId",
    "validationEvidenceHash",
  ].sort();
  return (
    JSON.stringify(keys) === JSON.stringify(expected) &&
    value.schema === transactionSchema &&
    uuidPattern.test(value.agentId ?? "") &&
    uuidPattern.test(value.runId ?? "") &&
    value.transactionId === value.runId &&
    uuidPattern.test(value.canonicalStateIdAfter ?? "") &&
    sha256Pattern.test(value.canonicalContentHashAfter ?? "") &&
    sha256Pattern.test(value.validationEvidenceHash ?? "") &&
    sha256Pattern.test(value.effectIdempotencyKey ?? "") &&
    value.effectIntentId === "protocol-release-ready" &&
    value.effectType === "demo.notification.requested" &&
    value.effectDestination === "demo-console" &&
    value.effectSubject === "Protocol release ready" &&
    sha256Pattern.test(value.effectPayloadHash ?? "") &&
    canonicalTimestamp(value.completedAt) &&
    canonicalTimestamp(value.effectDeliveredAt) &&
    Date.parse(value.effectDeliveredAt) <= Date.parse(value.completedAt) &&
    value.outcomeContractVersion === 2
  );
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function normalizedJson(value) {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizedJson(value[key])]),
    );
  }
  return value;
}

function semanticallyEqualJson(left, right) {
  return (
    JSON.stringify(normalizedJson(left)) ===
    JSON.stringify(normalizedJson(right))
  );
}

function canonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function exactOutcomeContract(contract, version, policy) {
  return (
    exactKeys(contract, [
      "schemaVersion",
      "version",
      "requiredPaths",
      "protectedPaths",
      "maxChangedFiles",
      "maxAddedBytes",
      "secretPatterns",
      "validationCommands",
      "createdAt",
    ]) &&
    contract.schemaVersion === 1 &&
    contract.version === version &&
    canonicalTimestamp(contract.createdAt) &&
    JSON.stringify({
      requiredPaths: contract.requiredPaths,
      protectedPaths: contract.protectedPaths,
      maxChangedFiles: contract.maxChangedFiles,
      maxAddedBytes: contract.maxAddedBytes,
      secretPatterns: contract.secretPatterns,
      validationCommands: contract.validationCommands,
    }) === JSON.stringify(policy)
  );
}

function externalEffectBinding(runId, intent) {
  if (
    !exactKeys(intent, ["schemaVersion", "id", "type", "payload"]) ||
    intent.schemaVersion !== 1 ||
    intent.id !== "protocol-release-ready" ||
    intent.type !== "demo.notification.requested" ||
    !exactKeys(intent.payload, ["destination", "subject", "body"]) ||
    intent.payload.destination !== "demo-console" ||
    intent.payload.subject !== "Protocol release ready" ||
    intent.payload.body !== "The Whole-Agent Candidate passed."
  ) {
    fail("Canonical external-action outbox is incomplete");
  }
  const normalizedPayload = JSON.stringify({
    destination: intent.payload.destination,
    subject: intent.payload.subject,
    body: intent.payload.body,
  });
  return {
    idempotencyKey: digest(
      [runId, intent.id, intent.type, normalizedPayload].join("\0"),
    ),
    payloadHash: digest(normalizedPayload),
  };
}

function assertExactMessages(database, proof, run) {
  if (!Array.isArray(database.messages) || database.messages.length !== 2) {
    fail("Persisted control-plane message history is not exact");
  }
  const [userMessage, assistantMessage] = database.messages;
  const messageKeys = [
    "id",
    "agentId",
    "runId",
    "role",
    "content",
    "createdAt",
  ];
  if (
    !exactKeys(userMessage, messageKeys) ||
    !uuidPattern.test(userMessage.id ?? "") ||
    userMessage.agentId !== proof.agentId ||
    userMessage.runId !== proof.runId ||
    userMessage.role !== "user" ||
    userMessage.content !== expectedUserPrompt ||
    userMessage.createdAt !== run.createdAt ||
    !canonicalTimestamp(userMessage.createdAt) ||
    !exactKeys(assistantMessage, messageKeys) ||
    !uuidPattern.test(assistantMessage.id ?? "") ||
    assistantMessage.id === userMessage.id ||
    assistantMessage.agentId !== proof.agentId ||
    assistantMessage.runId !== proof.runId ||
    assistantMessage.role !== "assistant" ||
    assistantMessage.content !== expectedAssistantOutput ||
    assistantMessage.createdAt !== proof.completedAt ||
    run.prompt !== expectedUserPrompt ||
    run.output !== expectedAssistantOutput
  ) {
    fail("Persisted control-plane messages contradict the Run Transaction");
  }
}

function assertExactOutcomeContractHistory(
  database,
  proof,
  agent,
  transaction,
) {
  if (
    !exactOutcomeContract(
      agent?.outcomeContract,
      2,
      realRuntimeProofContract,
    ) ||
    !exactOutcomeContract(
      transaction?.outcomeContract,
      2,
      realRuntimeProofContract,
    ) ||
    JSON.stringify(transaction.outcomeContract) !==
      JSON.stringify(agent.outcomeContract) ||
    !Array.isArray(database.outcomeContractVersions) ||
    database.outcomeContractVersions.length !== 2
  ) {
    fail("Persisted Outcome Contract history is incomplete");
  }
  const [created, manual] = database.outcomeContractVersions;
  const recordKeys = [
    "schemaVersion",
    "agentId",
    "contract",
    "provenance",
    "sourceProposalId",
    "rollbackFromVersion",
  ];
  if (
    !exactKeys(created, recordKeys) ||
    created.schemaVersion !== 1 ||
    created.agentId !== proof.agentId ||
    created.provenance !== "created" ||
    created.sourceProposalId !== null ||
    created.rollbackFromVersion !== null ||
    !exactOutcomeContract(created.contract, 1, defaultOutcomeContractPolicy) ||
    !exactKeys(manual, recordKeys) ||
    manual.schemaVersion !== 1 ||
    manual.agentId !== proof.agentId ||
    manual.provenance !== "manual" ||
    manual.sourceProposalId !== null ||
    manual.rollbackFromVersion !== null ||
    JSON.stringify(manual.contract) !== JSON.stringify(agent.outcomeContract) ||
    Date.parse(created.contract.createdAt) >
      Date.parse(manual.contract.createdAt)
  ) {
    fail("Persisted Outcome Contract history contradicts the Agent");
  }
}

function exactPersistedSqliteSnapshot(
  snapshot,
  sqliteContentHash,
  expectedRow,
) {
  return (
    exactKeys(snapshot, ["contentHash", "rowCount", "rows"]) &&
    snapshot.contentHash === sqliteContentHash &&
    snapshot.rowCount === 1 &&
    Array.isArray(snapshot.rows) &&
    snapshot.rows.length === 1 &&
    exactKeys(snapshot.rows[0], ["id", "value", "updatedAt"]) &&
    snapshot.rows[0].id === "demo" &&
    snapshot.rows[0].value === expectedRow.value &&
    snapshot.rows[0].updatedAt === expectedRow.updatedAt
  );
}

function assertExactTransactionResourceCommitments(
  transaction,
  manifest,
  initialManifest,
  proof,
) {
  if (
    !Array.isArray(transaction?.resources) ||
    transaction.resources.length !== 4
  ) {
    fail("Persisted Run Resource evidence is incomplete");
  }
  const resources = new Map(
    transaction.resources.map((resource) => [resource?.kind, resource]),
  );
  const expectedFingerprints = new Map([
    [
      "workspace",
      {
        before: initialManifest.workspaceContentHash,
        after: manifest.workspaceContentHash,
      },
    ],
    [
      "codex-session",
      {
        before: initialManifest.sessionContentHash,
        after: manifest.sessionContentHash,
      },
    ],
    [
      "sqlite",
      {
        before: initialManifest.sqliteContentHash,
        after: manifest.sqliteContentHash,
      },
    ],
    [
      "external-actions",
      {
        before: digest(JSON.stringify([])),
        after: digest(
          JSON.stringify([
            {
              idempotencyKey: proof.effectIdempotencyKey,
              deliveredAt: proof.effectDeliveredAt,
            },
          ]),
        ),
      },
    ],
  ]);
  if (
    JSON.stringify(transaction.resources.map((resource) => resource?.kind)) !==
      JSON.stringify(expectedResourceProfiles.map(([kind]) => kind)) ||
    resources.size !== expectedFingerprints.size ||
    expectedResourceProfiles.some(
      ([kind, label]) =>
        !exactKeys(resources.get(kind), [
          "kind",
          "label",
          "disposition",
          "fingerprintBefore",
          "fingerprintAfter",
          "summary",
        ]) ||
        resources.get(kind).label !== label ||
        resources.get(kind).disposition !== "promoted" ||
        resources.get(kind).fingerprintBefore !==
          expectedFingerprints.get(kind).before ||
        resources.get(kind).fingerprintAfter !==
          expectedFingerprints.get(kind).after ||
        resources.get(kind).summary !==
          `${label} accepted in the new Canonical State`,
    ) ||
    !exactKeys(transaction?.sqlite, [
      "databasePath",
      "integrity",
      "before",
      "candidate",
      "after",
    ]) ||
    transaction?.sqlite?.databasePath !== ".airlock/demo.sqlite" ||
    transaction.sqlite.integrity !== "passed" ||
    !exactPersistedSqliteSnapshot(
      transaction.sqlite.before,
      initialManifest.sqliteContentHash,
      { value: "ready", updatedAt: "1970-01-01T00:00:00.000Z" },
    ) ||
    !exactPersistedSqliteSnapshot(
      transaction.sqlite.candidate,
      manifest.sqliteContentHash,
      {
        value: "candidate-only",
        updatedAt: "2026-08-28T00:00:00.000Z",
      },
    ) ||
    !exactPersistedSqliteSnapshot(
      transaction.sqlite.after,
      manifest.sqliteContentHash,
      {
        value: "candidate-only",
        updatedAt: "2026-08-28T00:00:00.000Z",
      },
    )
  ) {
    fail("Persisted Run Resource evidence contradicts Canonical State");
  }
}

function exactRunUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  const keys = Object.keys(usage).sort();
  if (
    JSON.stringify(keys) !==
      JSON.stringify(["inputTokens", "outputTokens"].sort()) &&
    JSON.stringify(keys) !==
      JSON.stringify(
        ["cachedInputTokens", "inputTokens", "outputTokens"].sort(),
      )
  ) {
    return false;
  }
  return keys.every(
    (key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0,
  );
}

function exactRootLineage(lineage, proof) {
  return (
    exactKeys(lineage, ["rootRunId", "parentRunId", "depth", "maxDepth"]) &&
    lineage.rootRunId === proof.runId &&
    lineage.parentRunId === null &&
    lineage.depth === 0 &&
    lineage.maxDepth === 2
  );
}

function assertExactChanges(changes, expectedChanges) {
  if (
    !exactKeys(changes, [
      "files",
      "totalChangedFiles",
      "totalAddedBytes",
      "truncated",
    ]) ||
    !Array.isArray(changes.files) ||
    !semanticallyEqualJson(changes.files, expectedChanges.files) ||
    changes.totalChangedFiles !== expectedChanges.files.length ||
    changes.totalAddedBytes !== expectedChanges.totalAddedBytes ||
    changes.truncated !== false ||
    changes.files.some(
      (change) =>
        !exactKeys(change, ["path", "kind", "addedBytes"]) ||
        !Number.isSafeInteger(change.addedBytes) ||
        change.addedBytes < 0,
    )
  ) {
    fail("Persisted workspace change evidence is not exact");
  }
}

function assertExactValidations(transaction, proof) {
  if (
    !Array.isArray(transaction.validations) ||
    transaction.validations.length !== expectedValidationNames.length ||
    JSON.stringify(
      transaction.validations.map((validation) => validation?.name),
    ) !== JSON.stringify(expectedValidationNames) ||
    transaction.validations.some(
      (validation) =>
        !exactKeys(validation, [
          "name",
          "status",
          "required",
          "summary",
          "durationMs",
          "output",
        ]) ||
        validation.status !== "passed" ||
        validation.required !==
          (validation.name !== "assurance-catalog-rule:private-key-block:v1") ||
        typeof validation.summary !== "string" ||
        validation.summary.length === 0 ||
        !Number.isSafeInteger(validation.durationMs) ||
        validation.durationMs < 0 ||
        (validation.output !== null && typeof validation.output !== "string"),
    )
  ) {
    fail("Persisted Validation evidence is not the exact required set");
  }
  const catalogValidation = transaction.validations[6];
  if (
    catalogValidation.summary !==
      "Trusted catalog detector found no match in changed files" ||
    catalogValidation.output !== null
  ) {
    fail("Persisted catalog Validation evidence is not exact");
  }
  const profile = transaction.validations[0];
  let attestation;
  try {
    attestation = JSON.parse(profile.output);
  } catch {
    fail("Persisted execution-profile evidence is invalid JSON");
  }
  const modelCommitment = digest("protocol-fixture");
  if (
    !exactKeys(attestation, [
      "schemaVersion",
      "attestation",
      "inferenceMode",
      "executor",
      "runtimeProvider",
      "providerProtocol",
      "modelCommitment",
      "preflight",
    ]) ||
    attestation.schemaVersion !== 2 ||
    attestation.attestation !== "airlock-control-plane" ||
    attestation.inferenceMode !== "local-responses-protocol-fixture" ||
    attestation.executor !== "codex-cli" ||
    attestation.runtimeProvider !== "local-process" ||
    attestation.providerProtocol !== "responses" ||
    attestation.modelCommitment !== modelCommitment ||
    attestation.preflight !== null ||
    profile.summary !==
      "Airlock control plane attested successful execution through real Codex CLI against the local Responses protocol fixture. Model identity is committed without disclosure as " +
        modelCommitment.slice(0, "sha256:".length + 12) +
        "."
  ) {
    fail(
      "Persisted execution-profile evidence contradicts the product fixture",
    );
  }
  const validationEvidenceHash = digest(
    JSON.stringify(transaction.validations),
  );
  if (validationEvidenceHash !== proof.validationEvidenceHash) {
    fail(
      "Persisted Validation evidence hash contradicts the transaction proof",
    );
  }
  return validationEvidenceHash;
}

function assertExactEvents(transaction, proof, run, receipt) {
  if (
    !Array.isArray(transaction.events) ||
    transaction.events.length !== expectedTransactionEvents.length ||
    transaction.events.some(
      (event, index) =>
        !exactKeys(event, ["status", "at", "summary"]) ||
        event.status !== expectedTransactionEvents[index][0] ||
        event.summary !== expectedTransactionEvents[index][1] ||
        !canonicalTimestamp(event.at) ||
        (index > 0 &&
          Date.parse(event.at) < Date.parse(transaction.events[index - 1].at)),
    )
  ) {
    fail("Persisted Run Transaction lifecycle evidence is not exact");
  }
  const [, , , promotionStarted, canonicalAdvanced, promoted] =
    transaction.events;
  if (
    Date.parse(run.createdAt) > Date.parse(transaction.events[0].at) ||
    Date.parse(transaction.events[0].at) > Date.parse(run.startedAt) ||
    Date.parse(run.startedAt) > Date.parse(transaction.events[1].at) ||
    Date.parse(promotionStarted.at) > Date.parse(canonicalAdvanced.at) ||
    Date.parse(canonicalAdvanced.at) > Date.parse(proof.effectDeliveredAt) ||
    Date.parse(proof.effectDeliveredAt) > Date.parse(receipt.createdAt) ||
    Date.parse(receipt.createdAt) > Date.parse(promoted.at) ||
    Date.parse(promoted.at) > Date.parse(run.completedAt)
  ) {
    fail("Persisted Run Transaction chronology is contradictory");
  }
}

function assertPersistedControlPlane(
  database,
  proof,
  binding,
  manifest,
  initialManifest,
  candidate,
  expectedChanges,
) {
  if (
    !exactKeys(database, [
      "version",
      "agents",
      "messages",
      "runs",
      "candidateSets",
      "assuranceProposals",
      "outcomeContractVersions",
    ]) ||
    database.version !== 10 ||
    !Array.isArray(database.agents) ||
    database.agents.length !== 1 ||
    !Array.isArray(database.messages) ||
    !Array.isArray(database.runs) ||
    database.runs.length !== 1 ||
    !Array.isArray(database.candidateSets) ||
    database.candidateSets.length !== 0 ||
    !Array.isArray(database.assuranceProposals) ||
    database.assuranceProposals.length !== 0 ||
    !Array.isArray(database.outcomeContractVersions)
  ) {
    fail("Persisted control-plane database shape is invalid");
  }
  const agent = database.agents[0];
  const run = database.runs[0];
  const transaction = run?.transaction;
  const intent = transaction?.externalActions?.intents?.[0];
  const receipt = transaction?.promotionReceipt;
  if (
    !exactKeys(agent, [
      "id",
      "name",
      "description",
      "instructions",
      "status",
      "workspacePath",
      "canonicalStateId",
      "outcomeContract",
      "codexThreadId",
      "lastError",
      "createdAt",
      "updatedAt",
    ]) ||
    agent?.id !== proof.agentId ||
    agent?.name !== expectedAgentName ||
    agent?.description !== realRuntimeProofAgentDescription ||
    agent?.instructions !== realRuntimeProofAgentInstructions ||
    agent?.status !== "ready" ||
    agent?.workspacePath !== manifest.workspacePath ||
    agent?.canonicalStateId !== proof.canonicalStateIdAfter ||
    agent?.codexThreadId !== manifest.codexThreadId ||
    agent?.lastError !== null ||
    agent?.outcomeContract?.version !== proof.outcomeContractVersion ||
    !canonicalTimestamp(agent?.createdAt) ||
    agent?.updatedAt !== proof.completedAt ||
    Date.parse(agent.createdAt) > Date.parse(initialManifest.createdAt) ||
    !exactKeys(run, [
      "id",
      "agentId",
      "candidateSetId",
      "competitorId",
      "status",
      "prompt",
      "output",
      "error",
      "usage",
      "transaction",
      "startedAt",
      "completedAt",
      "createdAt",
    ]) ||
    run?.id !== proof.runId ||
    run?.agentId !== proof.agentId ||
    run?.candidateSetId !== null ||
    run?.competitorId !== null ||
    run?.status !== "completed" ||
    run?.error !== null ||
    !exactRunUsage(run?.usage) ||
    !canonicalTimestamp(run?.createdAt) ||
    !canonicalTimestamp(run?.startedAt) ||
    run?.completedAt !== proof.completedAt ||
    Date.parse(initialManifest.createdAt) > Date.parse(run.createdAt) ||
    Date.parse(run.createdAt) > Date.parse(run.startedAt) ||
    Date.parse(run.createdAt) > Date.parse(manifest.createdAt) ||
    !exactKeys(transaction, [
      "id",
      "assuranceEvidenceVersion",
      "status",
      "disposition",
      "candidateStateId",
      "canonicalStateIdBefore",
      "canonicalStateIdAfter",
      "canonicalContentHashBefore",
      "canonicalContentHashAfter",
      "outcomeContractVersion",
      "outcomeContract",
      "resources",
      "providerResources",
      "providerResourceEvents",
      "sqlite",
      "externalActions",
      "changes",
      "validations",
      "events",
      "quarantinePath",
      "quarantineAvailable",
      "discardedAt",
      "lineage",
      "recovery",
      "promotionReceipt",
    ]) ||
    transaction?.id !== proof.transactionId ||
    transaction?.assuranceEvidenceVersion !== 1 ||
    transaction?.status !== "promoted" ||
    transaction?.disposition !== "promoted" ||
    transaction?.candidateStateId !== candidate.candidateStateId ||
    transaction?.canonicalStateIdBefore !== initialManifest.stateId ||
    transaction?.canonicalContentHashBefore !== initialManifest.contentHash ||
    transaction?.canonicalStateIdAfter !== proof.canonicalStateIdAfter ||
    transaction?.canonicalContentHashAfter !==
      proof.canonicalContentHashAfter ||
    transaction?.outcomeContractVersion !== proof.outcomeContractVersion ||
    !Array.isArray(transaction?.providerResources) ||
    transaction.providerResources.length !== 0 ||
    !Array.isArray(transaction?.providerResourceEvents) ||
    transaction.providerResourceEvents.length !== 0 ||
    transaction?.quarantinePath !== null ||
    transaction?.quarantineAvailable !== false ||
    transaction?.discardedAt !== null ||
    !exactRootLineage(transaction?.lineage, proof) ||
    !exactKeys(transaction?.recovery, [
      "journalPhase",
      "recoveredAfterRestart",
      "recoveryError",
    ]) ||
    transaction.recovery.journalPhase !== "completed" ||
    transaction.recovery.recoveredAfterRestart !== false ||
    transaction.recovery.recoveryError !== null ||
    !exactKeys(transaction?.externalActions, [
      "outboxPath",
      "intents",
      "deliveredCount",
      "bypassDisclosure",
    ]) ||
    transaction.externalActions.outboxPath !==
      "Candidate State/outbox/intents.jsonl" ||
    transaction.externalActions.bypassDisclosure !==
      externalActionBypassDisclosure ||
    transaction.externalActions.deliveredCount !== 1 ||
    transaction?.externalActions?.intents?.length !== 1 ||
    !exactKeys(intent, [
      "id",
      "type",
      "destination",
      "subject",
      "idempotencyKey",
      "status",
      "deliveredAt",
    ]) ||
    intent?.id !== proof.effectIntentId ||
    intent?.type !== proof.effectType ||
    intent?.destination !== proof.effectDestination ||
    intent?.subject !== proof.effectSubject ||
    intent?.idempotencyKey !== binding.idempotencyKey ||
    intent?.idempotencyKey !== proof.effectIdempotencyKey ||
    intent?.status !== "delivered" ||
    intent?.deliveredAt !== proof.effectDeliveredAt ||
    !exactKeys(receipt, [
      "runTransactionId",
      "disposition",
      "outcomeContractVersion",
      "canonicalStateIdBefore",
      "canonicalStateIdAfter",
      "canonicalContentHashBefore",
      "canonicalContentHashAfter",
      "validationEvidenceHash",
      "lineage",
      "createdAt",
    ]) ||
    receipt?.runTransactionId !== proof.transactionId ||
    receipt?.disposition !== "promoted" ||
    receipt?.outcomeContractVersion !== proof.outcomeContractVersion ||
    receipt?.canonicalStateIdBefore !== initialManifest.stateId ||
    receipt?.canonicalStateIdAfter !== proof.canonicalStateIdAfter ||
    receipt?.canonicalContentHashBefore !== initialManifest.contentHash ||
    receipt?.canonicalContentHashAfter !== proof.canonicalContentHashAfter ||
    receipt?.validationEvidenceHash !== proof.validationEvidenceHash ||
    !exactRootLineage(receipt?.lineage, proof) ||
    !canonicalTimestamp(receipt?.createdAt)
  ) {
    fail("Persisted control-plane database contradicts the transaction proof");
  }
  assertExactChanges(transaction.changes, expectedChanges);
  const validationEvidenceHash = assertExactValidations(transaction, proof);
  if (receipt.validationEvidenceHash !== validationEvidenceHash) {
    fail("Promotion receipt does not bind persisted Validation evidence");
  }
  assertExactEvents(transaction, proof, run, receipt);
  assertExactTransactionResourceCommitments(
    transaction,
    manifest,
    initialManifest,
    proof,
  );
  assertExactMessages(database, proof, run);
  assertExactOutcomeContractHistory(database, proof, agent, transaction);
}

function rolloutCarriesExactThreadIdentity(relative, bytes, threadId) {
  if (!relative.startsWith("sessions/")) return false;
  const filename = path.posix.basename(relative);
  if (
    filename !== `rollout-${threadId}.jsonl` &&
    !(
      filename.startsWith("rollout-") && filename.endsWith(`-${threadId}.jsonl`)
    )
  ) {
    return false;
  }
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return false;
    }
    if (
      record?.type === "session_meta" &&
      (record?.payload?.id === threadId ||
        record?.payload?.thread_id === threadId)
    ) {
      return true;
    }
  }
  return false;
}

async function physicalTreeEvidence(
  root,
  sessionRoot,
  label,
  { maximumBytes, maximumFiles },
) {
  const rootMetadata = await assertPhysicalContainedPath(
    sessionRoot,
    root,
    "directory",
    label,
  );
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail(`${label} is not a physical directory`);
  }
  const hash = createHash("sha256");
  let entryCount = 0;
  let byteCount = 0;
  const directories = new Set();
  const files = new Map();
  const visit = async (directory, relativeRoot) => {
    const directoryBefore = await assertPhysicalContainedPath(
      sessionRoot,
      directory,
      "directory",
      label,
    );
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > maximumFiles) {
        fail(`${label} exceeds its entry boundary`);
      }
      const relative = path.posix.join(relativeRoot, entry.name);
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`${label} contains a symlink`);
      if (entry.isDirectory()) {
        await assertPhysicalContainedPath(
          sessionRoot,
          target,
          "directory",
          label,
        );
        directories.add(relative);
        hash.update(`directory\0${relative}\0`);
        await visit(target, relative);
        continue;
      }
      if (!entry.isFile()) fail(`${label} contains a special file`);
      const bytes = await boundedRegularFile(
        target,
        maximumBytes,
        `${label} artifact`,
        sessionRoot,
      );
      byteCount += bytes.length;
      if (byteCount > maximumBytes) {
        fail(`${label} exceeds its byte boundary`);
      }
      files.set(relative, bytes);
      hash.update(`file\0${relative}\0${bytes.length}\0`);
      hash.update(bytes);
      hash.update("\0");
    }
    const directoryAfter = await assertPhysicalContainedPath(
      sessionRoot,
      directory,
      "directory",
      label,
    );
    if (
      directoryBefore.dev !== directoryAfter.dev ||
      directoryBefore.ino !== directoryAfter.ino ||
      directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
      directoryBefore.ctimeMs !== directoryAfter.ctimeMs
    ) {
      fail(`${label} changed while it was inspected`);
    }
  };
  await visit(root, "");
  return {
    contentHash: `sha256:${hash.digest("hex")}`,
    directories,
    files,
  };
}

async function codexTreeDigest(root, threadId, sessionRoot) {
  const evidence = await physicalTreeEvidence(
    root,
    sessionRoot,
    "Canonical Codex home",
    {
      maximumBytes: maximumCodexTreeBytes,
      maximumFiles: maximumCodexTreeFiles,
    },
  );
  const configFound = evidence.files.has("config.toml");
  const matchingSessionFound = [...evidence.files].some(([relative, bytes]) =>
    rolloutCarriesExactThreadIdentity(relative, bytes, threadId),
  );
  if (!configFound || !matchingSessionFound) {
    fail("Canonical Codex session evidence is incomplete");
  }
  return evidence.contentHash;
}

function exactSortedValues(actual, expected) {
  return (
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

function assertExactRootMountInventories(
  dataEvidence,
  globalCodexEvidence,
  transactionProof,
  dataSentinelContent,
  workspaceSentinelContent,
) {
  const dataMatch =
    typeof dataSentinelContent === "string"
      ? dataSentinelContentPattern.exec(dataSentinelContent)
      : null;
  const workspaceMatch =
    typeof workspaceSentinelContent === "string"
      ? workspaceSentinelContentPattern.exec(workspaceSentinelContent)
      : null;
  const portableReceiptPattern = new RegExp(
    `^portable-decision-journal/${transactionProof.runId}/sha256-[a-f0-9]{64}\\.json$`,
    "u",
  );
  const portableReceiptFiles = [...dataEvidence.files.keys()].filter((value) =>
    portableReceiptPattern.test(value),
  );
  const expectedDirectories = [
    "agent-deletion-journal",
    "federated-admission-journal",
    "federated-admission-journal/pending-bundles",
    "federated-admission-journal/plans",
    "federated-admission-journal/records",
    "federated-admission-journal/transfers",
    "federated-admission-policies",
    "federated-admission-policies/policies",
    "federated-approval-journal",
    "federated-approval-journal/plans",
    "federated-approval-journal/records",
    "portable-decision-journal",
    "portable-decision-journal/.candidate-sets",
    "portable-decision-journal/.discard-cleanup",
    `portable-decision-journal/${transactionProof.runId}`,
    "promotion-journal",
  ];
  if (
    !dataMatch ||
    !workspaceMatch ||
    dataMatch[1] !== workspaceMatch[1] ||
    !exactSortedValues(dataEvidence.directories, expectedDirectories) ||
    portableReceiptFiles.length !== 1 ||
    !exactSortedValues(dataEvidence.files.keys(), [
      ".production-gate-sandbox-sentinel",
      "launchpad.json",
      "mock-deliveries.json",
      `promotion-journal/${transactionProof.runId}.json`,
      portableReceiptFiles[0],
    ]) ||
    !dataEvidence.files
      .get(".production-gate-sandbox-sentinel")
      ?.equals(Buffer.from(`${dataSentinelContent}\n`, "utf8"))
  ) {
    fail("Production image data mount inventory is not exact");
  }
  if (
    globalCodexEvidence.directories.size !== 0 ||
    !exactSortedValues(globalCodexEvidence.files.keys(), ["config.toml"])
  ) {
    fail("Production image global Codex mount inventory is not exact");
  }
}

function directTreeEntries(values, prefix = "") {
  const normalizedPrefix = prefix.length > 0 ? `${prefix}/` : "";
  return [...values]
    .filter((value) => value.startsWith(normalizedPrefix))
    .map((value) => value.slice(normalizedPrefix.length))
    .filter((value) => value.length > 0 && !value.includes("/"));
}

function descendantTreeEntries(values, prefix) {
  const normalizedPrefix = `${prefix}/`;
  return [...values]
    .filter((value) => value.startsWith(normalizedPrefix))
    .map((value) => value.slice(normalizedPrefix.length));
}

function assertEmptyWorkspaceDirectory(evidence, relativeRoot) {
  if (
    [...evidence.directories].some((value) =>
      value.startsWith(`${relativeRoot}/`),
    ) ||
    [...evidence.files.keys()].some((value) =>
      value.startsWith(`${relativeRoot}/`),
    )
  ) {
    fail(
      `Production image workspace transient root ${relativeRoot} is not empty`,
    );
  }
}

function assertWorkspaceMountInventory(
  evidence,
  transactionProof,
  workspaceSentinelContent,
) {
  const transientRoots = [
    ".candidates",
    ".deleted",
    ".federated-preparations",
    ".migrations",
    ".quarantine",
    ".registry-transitions",
  ];
  if (
    typeof workspaceSentinelContent !== "string" ||
    !workspaceSentinelContentPattern.test(workspaceSentinelContent) ||
    !exactSortedValues(directTreeEntries(evidence.directories), [
      ...transientRoots,
      transactionProof.agentId,
    ]) ||
    !exactSortedValues(directTreeEntries(evidence.files.keys()), [
      ".production-gate-sandbox-sentinel",
      ".resource-registry.json",
    ]) ||
    !evidence.files
      .get(".production-gate-sandbox-sentinel")
      ?.equals(Buffer.from(`${workspaceSentinelContent}\n`, "utf8"))
  ) {
    fail("Production image workspace mount inventory is not exact");
  }
  for (const relativeRoot of transientRoots) {
    assertEmptyWorkspaceDirectory(evidence, relativeRoot);
  }

  const agentPrefix = transactionProof.agentId;
  if (
    !exactSortedValues(directTreeEntries(evidence.directories, agentPrefix), [
      ".canonical-history",
      "versions",
    ]) ||
    !exactSortedValues(directTreeEntries(evidence.files.keys(), agentPrefix), [
      "canonical.json",
    ])
  ) {
    fail("Production image Agent workspace inventory is not exact");
  }

  const versionsPrefix = `${agentPrefix}/versions/`;
  const versionIds = [...evidence.directories]
    .filter((value) => value.startsWith(versionsPrefix))
    .map((value) => value.slice(versionsPrefix.length))
    .filter((value) => value.length > 0 && !value.includes("/"));
  const historyPrefix = `${agentPrefix}/.canonical-history/`;
  const historyIds = [...evidence.files.keys()]
    .filter((value) => value.startsWith(historyPrefix))
    .map((value) => value.slice(historyPrefix.length))
    .filter((value) => value.endsWith(".json") && !value.includes("/"))
    .map((value) => value.slice(0, -".json".length));
  if (
    versionIds.length !== 2 ||
    directTreeEntries(evidence.files.keys(), `${agentPrefix}/versions`)
      .length !== 0 ||
    versionIds.some((value) => !uuidPattern.test(value)) ||
    !versionIds.includes(transactionProof.canonicalStateIdAfter) ||
    !exactSortedValues(historyIds, versionIds) ||
    [...evidence.directories].some((value) =>
      value.startsWith(historyPrefix),
    ) ||
    directTreeEntries(
      evidence.files.keys(),
      `${agentPrefix}/.canonical-history`,
    ).length !== 2
  ) {
    fail("Production image Canonical version history is not exact");
  }

  const currentVersionPrefix = `${agentPrefix}/versions/${transactionProof.canonicalStateIdAfter}`;
  const initialStateId = versionIds.find(
    (value) => value !== transactionProof.canonicalStateIdAfter,
  );
  const initialVersionPrefix = `${agentPrefix}/versions/${initialStateId}`;
  const initialWorkspacePrefix = `${initialVersionPrefix}/workspace`;
  const initialCodexPrefix = `${initialVersionPrefix}/codex-home`;
  const initialOutboxPrefix = `${initialVersionPrefix}/outbox`;
  if (
    !exactSortedValues(
      directTreeEntries(evidence.directories, currentVersionPrefix),
      ["codex-home", "outbox", "resources", "workspace"],
    ) ||
    !exactSortedValues(
      directTreeEntries(evidence.files.keys(), currentVersionPrefix),
      ["candidate.json"],
    ) ||
    !exactSortedValues(
      directTreeEntries(evidence.directories, initialVersionPrefix),
      ["codex-home", "outbox", "workspace"],
    ) ||
    directTreeEntries(evidence.files.keys(), initialVersionPrefix).length !==
      0 ||
    !exactSortedValues(
      descendantTreeEntries(evidence.directories, initialWorkspacePrefix),
      [".airlock"],
    ) ||
    !exactSortedValues(
      descendantTreeEntries(evidence.files.keys(), initialWorkspacePrefix),
      [".airlock/demo.sqlite", ".gitignore", "AGENTS.md", "README.md"],
    ) ||
    descendantTreeEntries(evidence.directories, initialCodexPrefix).length !==
      0 ||
    !exactSortedValues(
      descendantTreeEntries(evidence.files.keys(), initialCodexPrefix),
      ["config.toml"],
    ) ||
    descendantTreeEntries(evidence.directories, initialOutboxPrefix).length !==
      0 ||
    descendantTreeEntries(evidence.files.keys(), initialOutboxPrefix).length !==
      0 ||
    [...evidence.directories].some((value) =>
      value.startsWith(`${currentVersionPrefix}/resources/`),
    ) ||
    [...evidence.files.keys()].some((value) =>
      value.startsWith(`${currentVersionPrefix}/resources/`),
    )
  ) {
    fail("Production image Canonical version inventory is not exact");
  }

  const registryBytes = evidence.files.get(".resource-registry.json");
  const registry = registryBytes
    ? parseJsonBytes(registryBytes, "Resource Provider registry")
    : null;
  if (
    !exactKeys(registry, [
      "schemaVersion",
      "generation",
      "providers",
      "updatedAt",
    ]) ||
    registry.schemaVersion !== 1 ||
    registry.generation !== 0 ||
    !Array.isArray(registry.providers) ||
    registry.providers.length !== 0 ||
    !canonicalTimestamp(registry.updatedAt)
  ) {
    fail("Production image Resource Provider registry is not exact");
  }
  return { initialStateId };
}

async function workspaceTreeEvidence(root, sessionRoot) {
  const evidence = await physicalTreeEvidence(
    root,
    sessionRoot,
    "Canonical workspace",
    {
      maximumBytes: maximumSqliteBytes + 1024 * 1024,
      maximumFiles: 8,
    },
  );
  if (
    !exactSortedValues(evidence.directories, [".airlock"]) ||
    !exactSortedValues(evidence.files.keys(), [
      ".airlock/demo.sqlite",
      ".gitignore",
      "AGENTS.md",
      "README.md",
      "protocol-proof.txt",
    ]) ||
    evidence.files.get(".gitignore")?.toString("utf8") !== expectedGitignore ||
    evidence.files.get("AGENTS.md")?.toString("utf8") !==
      expectedAgentInstructions ||
    evidence.files.get("README.md")?.toString("utf8") !== expectedReadme ||
    evidence.files.get("protocol-proof.txt")?.toString("utf8") !==
      "candidate-only\n"
  ) {
    fail("Canonical workspace tree is not the exact promoted fixture");
  }
  return evidence;
}

async function outboxTreeEvidence(root, sessionRoot) {
  const evidence = await physicalTreeEvidence(
    root,
    sessionRoot,
    "Canonical external-action outbox",
    { maximumBytes: 64 * 1024, maximumFiles: 1 },
  );
  if (
    evidence.directories.size !== 0 ||
    !exactSortedValues(evidence.files.keys(), ["intents.jsonl"])
  ) {
    fail("Canonical external-action outbox tree is not exact");
  }
  return evidence;
}

async function sqliteEvidence(
  databasePath,
  expectedBytes,
  sessionRoot,
  expectedRow,
) {
  await assertPhysicalContainedPath(
    sessionRoot,
    databasePath,
    "file",
    "Canonical SQLite database",
  );
  let database;
  let sqliteContentHash;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").get();
    const schema = database
      .prepare(
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    const normalizedSchemaSql = schema[0]?.sql?.replace(/\s+/gu, " ").trim();
    if (
      integrity?.integrity_check !== "ok" ||
      schema.length !== 1 ||
      !exactKeys(schema[0], ["type", "name", "tableName", "sql"]) ||
      schema[0].type !== "table" ||
      schema[0].name !== "inventory" ||
      schema[0].tableName !== "inventory" ||
      normalizedSchemaSql !==
        "CREATE TABLE inventory ( id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL )"
    ) {
      fail("Canonical SQLite schema is invalid");
    }
    const columns = database.prepare("PRAGMA table_info(inventory)").all();
    const columnShape = columns.map((column) => ({
      cid: column.cid,
      name: column.name,
      type: column.type,
      notnull: column.notnull,
      dflt_value: column.dflt_value,
      pk: column.pk,
    }));
    if (
      columns.some(
        (column) =>
          !exactKeys(column, [
            "cid",
            "name",
            "type",
            "notnull",
            "dflt_value",
            "pk",
          ]),
      ) ||
      JSON.stringify(columnShape) !==
        JSON.stringify([
          {
            cid: 0,
            name: "id",
            type: "TEXT",
            notnull: 0,
            dflt_value: null,
            pk: 1,
          },
          {
            cid: 1,
            name: "value",
            type: "TEXT",
            notnull: 1,
            dflt_value: null,
            pk: 0,
          },
          {
            cid: 2,
            name: "updated_at",
            type: "TEXT",
            notnull: 1,
            dflt_value: null,
            pk: 0,
          },
        ])
    ) {
      fail("Canonical SQLite columns are invalid");
    }
    const count = database
      .prepare("SELECT COUNT(*) AS count FROM inventory")
      .get();
    const rows = database
      .prepare(
        "SELECT id, value, updated_at AS updatedAt FROM inventory ORDER BY id",
      )
      .all();
    if (
      !exactKeys(count, ["count"]) ||
      Number(count.count) !== 1 ||
      rows.length !== 1 ||
      !exactKeys(rows[0], ["id", "value", "updatedAt"]) ||
      rows[0].id !== "demo" ||
      rows[0].value !== expectedRow.value ||
      rows[0].updatedAt !== expectedRow.updatedAt
    ) {
      fail("Canonical SQLite evidence is invalid");
    }
    sqliteContentHash = digest(JSON.stringify(rows));
  } catch (error) {
    if (error instanceof ProductionImagePersistenceError) throw error;
    fail("Canonical SQLite evidence is unreadable");
  } finally {
    database?.close();
  }
  const afterBytes = await boundedRegularFile(
    databasePath,
    maximumSqliteBytes,
    "Canonical SQLite database",
    sessionRoot,
  );
  if (!expectedBytes.equals(afterBytes)) {
    fail("Canonical SQLite database changed while it was inspected");
  }
  return sqliteContentHash;
}

async function inspectInitialCanonicalVersion({
  sessionRoot,
  agentId,
  stateId,
}) {
  const versionRoot = path.join(
    sessionRoot,
    "workspaces",
    agentId,
    "versions",
    stateId,
  );
  const workspaceRoot = path.join(versionRoot, "workspace");
  const codexRoot = path.join(versionRoot, "codex-home");
  const outboxRoot = path.join(versionRoot, "outbox");
  const [workspaceEvidence, codexEvidence, outboxEvidence, manifestResult] =
    await Promise.all([
      physicalTreeEvidence(
        workspaceRoot,
        sessionRoot,
        "Initial Canonical workspace",
        {
          maximumBytes: maximumSqliteBytes + 1024 * 1024,
          maximumFiles: 8,
        },
      ),
      physicalTreeEvidence(
        codexRoot,
        sessionRoot,
        "Initial Canonical Codex home",
        { maximumBytes: 1024 * 1024, maximumFiles: 2 },
      ),
      physicalTreeEvidence(
        outboxRoot,
        sessionRoot,
        "Initial Canonical external-action outbox",
        { maximumBytes: 64 * 1024, maximumFiles: 1 },
      ),
      boundedJson(
        path.join(
          sessionRoot,
          "workspaces",
          agentId,
          ".canonical-history",
          `${stateId}.json`,
        ),
        "Initial Canonical manifest history",
        sessionRoot,
      ),
    ]);
  if (
    !exactSortedValues(workspaceEvidence.directories, [".airlock"]) ||
    !exactSortedValues(workspaceEvidence.files.keys(), [
      ".airlock/demo.sqlite",
      ".gitignore",
      "AGENTS.md",
      "README.md",
    ]) ||
    workspaceEvidence.files.get(".gitignore")?.toString("utf8") !==
      expectedGitignore ||
    workspaceEvidence.files.get("AGENTS.md")?.toString("utf8") !==
      expectedAgentInstructions ||
    workspaceEvidence.files.get("README.md")?.toString("utf8") !==
      expectedReadme ||
    codexEvidence.directories.size !== 0 ||
    !exactSortedValues(codexEvidence.files.keys(), ["config.toml"]) ||
    outboxEvidence.directories.size !== 0 ||
    outboxEvidence.files.size !== 0
  ) {
    fail("Initial Canonical State tree is not the exact seeded fixture");
  }
  const sqliteBytes = workspaceEvidence.files.get(".airlock/demo.sqlite");
  const sqliteContentHash = await sqliteEvidence(
    path.join(workspaceRoot, ".airlock", "demo.sqlite"),
    sqliteBytes,
    sessionRoot,
    { value: "ready", updatedAt: "1970-01-01T00:00:00.000Z" },
  );
  const contentHash = digest(
    JSON.stringify({
      workspaceContentHash: workspaceEvidence.contentHash,
      sessionContentHash: codexEvidence.contentHash,
      sqliteContentHash,
      outboxContentHash: outboxEvidence.contentHash,
      codexThreadId: null,
    }),
  );
  const manifest = manifestResult.value;
  const containerVersionRoot = `/app/workspaces/${agentId}/versions/${stateId}`;
  if (
    !exactKeys(manifest, canonicalManifestKeys) ||
    manifest.schemaVersion !== 4 ||
    manifest.agentId !== agentId ||
    manifest.stateId !== stateId ||
    manifest.workspacePath !== `${containerVersionRoot}/workspace` ||
    manifest.codexHomePath !== `${containerVersionRoot}/codex-home` ||
    manifest.outboxPath !== `${containerVersionRoot}/outbox` ||
    manifest.codexThreadId !== null ||
    manifest.workspaceContentHash !== workspaceEvidence.contentHash ||
    manifest.sessionContentHash !== codexEvidence.contentHash ||
    manifest.sqliteContentHash !== sqliteContentHash ||
    manifest.outboxContentHash !== outboxEvidence.contentHash ||
    !Array.isArray(manifest.providerVersions) ||
    manifest.providerVersions.length !== 0 ||
    manifest.contentHash !== contentHash ||
    !canonicalTimestamp(manifest.createdAt) ||
    manifest.sourceRunId !== null
  ) {
    fail("Initial Canonical manifest contradicts physical state");
  }
  return manifest;
}

function assertCandidateManifest(candidate, proof, initial, current) {
  if (
    !exactKeys(candidate, candidateManifestKeys) ||
    candidate.schemaVersion !== 4 ||
    candidate.agentId !== proof.agentId ||
    candidate.runId !== proof.runId ||
    candidate.candidateStateId !== current.stateId ||
    candidate.canonicalStateIdBefore !== initial.stateId ||
    candidate.canonicalContentHashBefore !== initial.contentHash ||
    candidate.canonicalWorkspaceHashBefore !== initial.workspaceContentHash ||
    candidate.canonicalSessionHashBefore !== initial.sessionContentHash ||
    candidate.canonicalSqliteHashBefore !== initial.sqliteContentHash ||
    candidate.canonicalOutboxHashBefore !== initial.outboxContentHash ||
    !semanticallyEqualJson(
      candidate.canonicalProviderVersionsBefore,
      initial.providerVersions,
    ) ||
    candidate.canonicalThreadIdBefore !== initial.codexThreadId ||
    candidate.candidateThreadId !== current.codexThreadId ||
    candidate.repairSourceRunId !== null ||
    candidate.repairReferenceHash !== null ||
    !canonicalTimestamp(candidate.createdAt) ||
    Date.parse(candidate.createdAt) < Date.parse(initial.createdAt) ||
    candidate.createdAt !== current.createdAt
  ) {
    fail("Promoted Candidate manifest contradicts Canonical lineage");
  }
}

export async function inspectProductionImagePersistence({
  sessionRoot,
  transactionProof,
  dataSentinelContent,
  workspaceSentinelContent,
} = {}) {
  await assertPhysicalSessionRoot(sessionRoot);
  if (!exactTransactionProof(transactionProof)) {
    fail("Production image transaction proof is invalid");
  }
  const expectedUid = process.getuid?.();
  const expectedGid = process.getgid?.();
  for (const name of ["data", "workspaces", "codex-home"]) {
    const target = path.join(sessionRoot, name);
    const metadata = await assertPhysicalContainedPath(
      sessionRoot,
      target,
      "directory",
      `Production image ${name} bind mount`,
    );
    if (
      !metadata?.isDirectory() ||
      (expectedUid !== undefined && metadata.uid !== expectedUid) ||
      (expectedGid !== undefined && metadata.gid !== expectedGid)
    ) {
      fail("Production image bind mount ownership is invalid");
    }
  }
  const [dataTreeEvidence, workspaceMountEvidence, globalCodexEvidence] =
    await Promise.all([
      physicalTreeEvidence(
        path.join(sessionRoot, "data"),
        sessionRoot,
        "Persisted data directory",
        {
          maximumBytes: maximumPersistedTreeBytes,
          maximumFiles: maximumPersistedTreeEntries,
        },
      ),
      physicalTreeEvidence(
        path.join(sessionRoot, "workspaces"),
        sessionRoot,
        "Persisted workspace mount",
        {
          maximumBytes: maximumPersistedTreeBytes,
          maximumFiles: maximumPersistedTreeEntries,
        },
      ),
      physicalTreeEvidence(
        path.join(sessionRoot, "codex-home"),
        sessionRoot,
        "Mounted Codex home",
        {
          maximumBytes: maximumPersistedTreeBytes,
          maximumFiles: maximumPersistedTreeEntries,
        },
      ),
    ]);
  assertExactRootMountInventories(
    dataTreeEvidence,
    globalCodexEvidence,
    transactionProof,
    dataSentinelContent,
    workspaceSentinelContent,
  );
  const { initialStateId } = assertWorkspaceMountInventory(
    workspaceMountEvidence,
    transactionProof,
    workspaceSentinelContent,
  );
  const globalCodexConfig = globalCodexEvidence.files.get("config.toml");
  if (!globalCodexConfig) {
    fail("Mounted Codex configuration is incomplete");
  }

  const agentRoot = path.join(
    sessionRoot,
    "workspaces",
    transactionProof.agentId,
  );
  if (!inside(path.join(sessionRoot, "workspaces"), agentRoot)) {
    fail("Production image Agent workspace escaped its mount");
  }
  await assertPhysicalContainedPath(
    sessionRoot,
    agentRoot,
    "directory",
    "Production image Agent workspace",
  );
  const manifestResult = await boundedJson(
    path.join(agentRoot, "canonical.json"),
    "Canonical manifest",
    sessionRoot,
  );
  const manifest = manifestResult.value;
  const stateId = transactionProof.canonicalStateIdAfter;
  const containerVersionRoot = `/app/workspaces/${transactionProof.agentId}/versions/${stateId}`;
  if (
    !exactKeys(manifest, canonicalManifestKeys) ||
    manifest?.schemaVersion !== 4 ||
    manifest?.agentId !== transactionProof.agentId ||
    manifest?.stateId !== stateId ||
    manifest?.workspacePath !== `${containerVersionRoot}/workspace` ||
    manifest?.codexHomePath !== `${containerVersionRoot}/codex-home` ||
    manifest?.outboxPath !== `${containerVersionRoot}/outbox` ||
    typeof manifest?.codexThreadId !== "string" ||
    !uuidPattern.test(manifest.codexThreadId) ||
    !sha256Pattern.test(manifest?.workspaceContentHash ?? "") ||
    !sha256Pattern.test(manifest?.sessionContentHash ?? "") ||
    !sha256Pattern.test(manifest?.sqliteContentHash ?? "") ||
    !sha256Pattern.test(manifest?.outboxContentHash ?? "") ||
    !Array.isArray(manifest?.providerVersions) ||
    manifest.providerVersions.length !== 0 ||
    !canonicalTimestamp(manifest?.createdAt) ||
    Date.parse(manifest.createdAt) >
      Date.parse(transactionProof.effectDeliveredAt) ||
    manifest?.sourceRunId !== transactionProof.runId ||
    manifest?.contentHash !== transactionProof.canonicalContentHashAfter
  ) {
    fail("Canonical manifest contradicts the transaction proof");
  }

  const [initialManifest, currentHistoryResult, candidateResult] =
    await Promise.all([
      inspectInitialCanonicalVersion({
        sessionRoot,
        agentId: transactionProof.agentId,
        stateId: initialStateId,
      }),
      boundedJson(
        path.join(agentRoot, ".canonical-history", `${stateId}.json`),
        "Current Canonical manifest history",
        sessionRoot,
      ),
      boundedJson(
        path.join(agentRoot, "versions", stateId, "candidate.json"),
        "Promoted Candidate manifest",
        sessionRoot,
      ),
    ]);
  if (!semanticallyEqualJson(currentHistoryResult.value, manifest)) {
    fail("Current Canonical history contradicts canonical.json");
  }
  assertCandidateManifest(
    candidateResult.value,
    transactionProof,
    initialManifest,
    manifest,
  );

  const versionRoot = path.join(agentRoot, "versions", stateId);
  const workspaceRoot = path.join(versionRoot, "workspace");
  const outboxRoot = path.join(versionRoot, "outbox");
  const canonicalCodexRoot = path.join(versionRoot, "codex-home");
  for (const [target, label] of [
    [versionRoot, "Canonical version root"],
    [workspaceRoot, "Canonical workspace root"],
    [outboxRoot, "Canonical outbox root"],
    [canonicalCodexRoot, "Canonical Codex home"],
  ]) {
    await assertPhysicalContainedPath(sessionRoot, target, "directory", label);
  }
  const workspaceEvidence = await workspaceTreeEvidence(
    workspaceRoot,
    sessionRoot,
  );
  const protocolBytes = workspaceEvidence.files.get("protocol-proof.txt");
  const sqlitePath = path.join(workspaceRoot, ".airlock", "demo.sqlite");
  const sqliteBytes = workspaceEvidence.files.get(".airlock/demo.sqlite");
  const sqliteContentHash = await sqliteEvidence(
    sqlitePath,
    sqliteBytes,
    sessionRoot,
    {
      value: "candidate-only",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  );

  const outboxEvidence = await outboxTreeEvidence(outboxRoot, sessionRoot);
  const outboxResult = outboxEvidence.files.get("intents.jsonl");
  const sessionContentHash = await codexTreeDigest(
    canonicalCodexRoot,
    manifest.codexThreadId,
    sessionRoot,
  );
  const compositeContentHash = digest(
    JSON.stringify({
      workspaceContentHash: workspaceEvidence.contentHash,
      sessionContentHash,
      sqliteContentHash,
      outboxContentHash: outboxEvidence.contentHash,
      codexThreadId: manifest.codexThreadId,
    }),
  );
  if (
    manifest.workspaceContentHash !== workspaceEvidence.contentHash ||
    manifest.sessionContentHash !== sessionContentHash ||
    manifest.sqliteContentHash !== sqliteContentHash ||
    manifest.outboxContentHash !== outboxEvidence.contentHash ||
    manifest.contentHash !== compositeContentHash
  ) {
    fail("Canonical manifest commitments contradict physical state");
  }
  const outboxLines = outboxResult
    .toString("utf8")
    .split(/\r?\n/u)
    .filter(Boolean);
  let outboxIntent;
  try {
    outboxIntent = outboxLines.length === 1 ? JSON.parse(outboxLines[0]) : null;
  } catch {
    fail("Canonical external-action outbox is invalid JSON");
  }
  const effectBinding = externalEffectBinding(
    transactionProof.runId,
    outboxIntent,
  );
  if (
    effectBinding.idempotencyKey !== transactionProof.effectIdempotencyKey ||
    effectBinding.payloadHash !== transactionProof.effectPayloadHash
  ) {
    fail("Canonical external-action payload contradicts the transaction proof");
  }

  const deliveryBytes = dataTreeEvidence.files.get("mock-deliveries.json");
  if (!deliveryBytes) fail("External-action receipt store is unavailable");
  const deliveryResult = {
    bytes: deliveryBytes,
    value: parseJsonBytes(deliveryBytes, "External-action receipt store"),
  };
  const deliveryStore = deliveryResult.value;
  const delivery = deliveryStore?.deliveries?.[0];
  if (
    !exactKeys(deliveryStore, ["version", "consumerId", "deliveries"]) ||
    !exactKeys(delivery, [
      "idempotencyKey",
      "runId",
      "intentId",
      "type",
      "destination",
      "subject",
      "payloadHash",
      "deliveredAt",
      "deliveryMode",
    ]) ||
    deliveryStore?.version !== 2 ||
    !uuidPattern.test(deliveryStore?.consumerId ?? "") ||
    deliveryStore?.deliveries?.length !== 1 ||
    delivery?.runId !== transactionProof.runId ||
    delivery?.intentId !== "protocol-release-ready" ||
    delivery?.type !== transactionProof.effectType ||
    delivery?.destination !== transactionProof.effectDestination ||
    delivery?.subject !== transactionProof.effectSubject ||
    delivery?.payloadHash !== effectBinding.payloadHash ||
    delivery?.idempotencyKey !== transactionProof.effectIdempotencyKey ||
    delivery?.deliveredAt !== transactionProof.effectDeliveredAt ||
    delivery?.deliveryMode !== "atomic-local-store"
  ) {
    fail("External-action receipt store contradicts the transaction proof");
  }

  const launchpadBytes = dataTreeEvidence.files.get("launchpad.json");
  if (!launchpadBytes) fail("Persisted control-plane database is unavailable");
  const launchpad = {
    bytes: launchpadBytes,
    value: parseJsonBytes(launchpadBytes, "Persisted control-plane database"),
  };
  const expectedChanges = {
    files: [
      {
        path: ".airlock/demo.sqlite",
        kind: "modified",
        addedBytes: sqliteBytes.length,
      },
      {
        path: "protocol-proof.txt",
        kind: "added",
        addedBytes: protocolBytes.length,
      },
    ],
    totalAddedBytes: sqliteBytes.length + protocolBytes.length,
  };
  assertPersistedControlPlane(
    launchpad.value,
    transactionProof,
    effectBinding,
    manifest,
    initialManifest,
    candidateResult.value,
    expectedChanges,
  );
  return {
    schema: snapshotSchema,
    agentId: transactionProof.agentId,
    runId: transactionProof.runId,
    stateId,
    manifestHash: digest(manifestResult.bytes),
    protocolHash: digest(protocolBytes),
    sqliteHash: digest(sqliteBytes),
    codexTreeHash: sessionContentHash,
    outboxHash: digest(outboxResult),
    deliveryStoreHash: digest(deliveryResult.bytes),
    dataTreeHash: dataTreeEvidence.contentHash,
    workspaceTreeHash: workspaceMountEvidence.contentHash,
    globalCodexConfigHash: digest(globalCodexConfig),
    globalCodexTreeHash: globalCodexEvidence.contentHash,
    launchpadHash: digest(launchpad.bytes),
  };
}

async function readTransactionProof(target, sessionRoot) {
  return (
    await boundedJson(
      target,
      "Production image transaction proof",
      sessionRoot,
      32 * 1024,
    )
  ).value;
}

async function writeSnapshot(target, snapshot, sessionRoot) {
  await assertPhysicalArtifactParent(
    sessionRoot,
    target,
    "Physical persistence snapshot",
  );
  const handle = await open(target, "wx", 0o600);
  try {
    const opened = await handle.stat();
    const installed = await assertPhysicalContainedPath(
      sessionRoot,
      target,
      "file",
      "Physical persistence snapshot",
    );
    if (opened.dev !== installed.dev || opened.ino !== installed.ino) {
      fail("Physical persistence snapshot changed while it was created");
    }
    await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readSnapshot(target, sessionRoot) {
  const value = (
    await boundedJson(
      target,
      "Physical persistence snapshot",
      sessionRoot,
      32 * 1024,
    )
  ).value;
  if (
    value?.schema !== snapshotSchema ||
    !uuidPattern.test(value?.agentId ?? "") ||
    !uuidPattern.test(value?.runId ?? "") ||
    !uuidPattern.test(value?.stateId ?? "") ||
    Object.entries(value).some(
      ([key, item]) => key.endsWith("Hash") && !sha256Pattern.test(item),
    )
  ) {
    fail("Physical persistence snapshot is invalid");
  }
  return value;
}

export async function verifyProductionImagePersistence({
  mode,
  sessionRoot,
  snapshotFile,
  transactionProofFile,
  dataSentinelContent,
  workspaceSentinelContent,
} = {}) {
  if (!["create", "restart"].includes(mode)) {
    fail("Physical persistence proof requires create or restart mode");
  }
  for (const target of [snapshotFile, transactionProofFile]) {
    if (typeof target !== "string" || !path.isAbsolute(target)) {
      fail("Physical persistence proof requires absolute artifact paths");
    }
  }
  await assertPhysicalSessionRoot(sessionRoot);
  for (const target of [snapshotFile, transactionProofFile]) {
    if (!inside(sessionRoot, path.resolve(target))) {
      fail("Physical persistence proof artifact escaped the session root");
    }
  }
  const transactionProof = await readTransactionProof(
    transactionProofFile,
    sessionRoot,
  );
  const actual = await inspectProductionImagePersistence({
    sessionRoot,
    transactionProof,
    dataSentinelContent,
    workspaceSentinelContent,
  });
  if (mode === "create") {
    await writeSnapshot(snapshotFile, actual, sessionRoot);
  } else {
    const expected = await readSnapshot(snapshotFile, sessionRoot);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail("Physical persistence evidence changed across restart");
    }
  }
  return actual;
}

function parseArguments(argumentsList) {
  if (argumentsList.length !== 12) {
    fail(
      "Usage: node scripts/production-image-persistence-verifier.mjs --session-root <absolute-path> --transaction-proof <absolute-path> --mode <create|restart> --snapshot-file <absolute-path> --data-sentinel-content <protected-data:24-lowercase-hex> --workspace-sentinel-content <protected-workspaces:24-lowercase-hex>",
    );
  }
  const parsed = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith("--") || !value || parsed.has(key)) {
      fail("Physical persistence proof arguments are invalid");
    }
    parsed.set(key, value);
  }
  if (
    parsed.size !== 6 ||
    !parsed.has("--session-root") ||
    !parsed.has("--transaction-proof") ||
    !parsed.has("--mode") ||
    !parsed.has("--snapshot-file") ||
    !parsed.has("--data-sentinel-content") ||
    !parsed.has("--workspace-sentinel-content")
  ) {
    fail("Physical persistence proof arguments are invalid");
  }
  return {
    mode: parsed.get("--mode"),
    sessionRoot: parsed.get("--session-root"),
    snapshotFile: parsed.get("--snapshot-file"),
    transactionProofFile: parsed.get("--transaction-proof"),
    dataSentinelContent: parsed.get("--data-sentinel-content"),
    workspaceSentinelContent: parsed.get("--workspace-sentinel-content"),
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await verifyProductionImagePersistence(
    parseArguments(process.argv.slice(2)),
  );
  process.stdout.write(
    `Production image physical persistence proof passed for Agent ${result.agentId} and Run ${result.runId}.\n`,
  );
}
