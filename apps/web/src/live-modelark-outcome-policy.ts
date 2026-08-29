import type { AgentRun, OutcomeContract, RunTransaction } from "./types";

export const liveModelArkPrompt =
  "Create modelark-proof.txt containing exactly modelark-live followed by a newline. Then use Node.js built-in node:sqlite to update the inventory row with id demo in .airlock/demo.sqlite so value is modelark-live and updated_at is 2026-08-28T00:00:00.000Z. Append exactly one demo.notification.requested JSON object to AIRLOCK_OUTBOX_PATH with id modelark-live-ready, destination demo-console, subject ModelArk release ready, and body The live Whole-Agent Candidate passed. Use no dependencies. Verify the file and database values before finishing.";

const liveStateValidationCommand = [
  'test "$(cat modelark-proof.txt)" = modelark-live',
  "node --no-warnings --experimental-sqlite --input-type=module -e 'import { DatabaseSync } from \"node:sqlite\"; const database = new DatabaseSync(\".airlock/demo.sqlite\"); const row = database.prepare(\"SELECT value, updated_at FROM inventory WHERE id = ?\").get(\"demo\"); database.close(); if (row?.value !== \"modelark-live\" || row?.updated_at !== \"2026-08-28T00:00:00.000Z\") process.exit(1);'",
].join(" && ");

const liveModelArkContract = {
  requiredPaths: ["AGENTS.md", "modelark-proof.txt"],
  protectedPaths: ["AGENTS.md"],
  maxChangedFiles: 4,
  maxAddedBytes: 65_536,
  secretPatterns: [
    {
      name: "ark-api-key-assignment",
      pattern: "ARK_API_KEY\\s*[:=]\\s*['\\\"]?[^\\s'\\\"]{8,}",
    },
    {
      name: "ark-model-api-key",
      pattern:
        "\\bark-[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}-[A-Za-z0-9]{4,}\\b",
    },
    {
      name: "bearer-token",
      pattern: "Bearer\\s+[A-Za-z0-9._~+/-]{12,}=*",
    },
  ],
  validationCommands: [
    {
      name: "modelark-live-state",
      command: liveStateValidationCommand,
      required: true,
      timeoutMs: 10_000,
    },
  ],
} as const;

const requiredResources = [
  ["workspace", "Workspace"],
  ["codex-session", "Agent memory"],
  ["sqlite", "SQLite data"],
  ["external-actions", "External actions"],
] as const;

const requiredValidationNames = [
  "execution-profile",
  "path-safety",
  "protected-paths",
  "required-paths",
  "change-limits",
  "secret-patterns",
  "command:modelark-live-state",
  "sqlite-resource",
  "external-action-intents",
] as const;

const modelArkPreflightMaxAgeMs = 2 * 60 * 60 * 1_000;
const modelArkPreflightFutureToleranceMs = 60_000;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;

function hasExactObjectKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function isFiniteTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function comparableContract(contract: OutcomeContract) {
  return {
    requiredPaths: contract.requiredPaths,
    protectedPaths: contract.protectedPaths,
    maxChangedFiles: contract.maxChangedFiles,
    maxAddedBytes: contract.maxAddedBytes,
    secretPatterns: contract.secretPatterns,
    validationCommands: contract.validationCommands,
  };
}

function hasExactLiveOutcomeContract(transaction: RunTransaction): boolean {
  const contract = transaction.outcomeContract;
  return (
    contract.schemaVersion === 1 &&
    Number.isInteger(contract.version) &&
    contract.version >= 1 &&
    transaction.outcomeContractVersion === contract.version &&
    isFiniteTimestamp(contract.createdAt) &&
    JSON.stringify(comparableContract(contract)) ===
      JSON.stringify(liveModelArkContract)
  );
}

function hasExactRequiredValidations(
  validations: RunTransaction["validations"],
): boolean {
  if (!Array.isArray(validations)) return false;
  const names = validations.map((validation) => validation?.name);
  if (new Set(names).size !== names.length) return false;
  const required = validations.filter(
    (validation) => validation?.required === true,
  );
  return (
    JSON.stringify(required.map((validation) => validation.name)) ===
      JSON.stringify(requiredValidationNames) &&
    required.every((validation) => validation.status === "passed")
  );
}

function hasExactPromotedResources(transaction: RunTransaction): boolean {
  if (
    !Array.isArray(transaction.resources) ||
    transaction.resources.length !== requiredResources.length ||
    !Array.isArray(transaction.providerResources) ||
    transaction.providerResources.length !== 0 ||
    !Array.isArray(transaction.providerResourceEvents) ||
    transaction.providerResourceEvents.length !== 0
  ) {
    return false;
  }
  return requiredResources.every(([kind, label], index) => {
    const resource = transaction.resources[index];
    return (
      resource?.kind === kind &&
      resource.label === label &&
      resource.disposition === "promoted" &&
      sha256Pattern.test(resource.fingerprintBefore ?? "") &&
      sha256Pattern.test(resource.fingerprintAfter ?? "")
    );
  });
}

function hasBoundModelArkPreflight(
  validation: RunTransaction["validations"][number] | undefined,
  nowMs: number,
  runCreatedAtMs: number,
): boolean {
  if (
    validation?.status !== "passed" ||
    validation.required !== true ||
    typeof validation.output !== "string" ||
    validation.output.length > 4_096
  ) {
    return false;
  }
  try {
    const profile: unknown = JSON.parse(validation.output);
    if (
      !hasExactObjectKeys(profile, [
        "schemaVersion",
        "attestation",
        "inferenceMode",
        "executor",
        "runtimeProvider",
        "providerProtocol",
        "modelCommitment",
        "preflight",
      ]) ||
      !hasExactObjectKeys(profile.preflight, [
        "checkedAt",
        "generatedAssistantOutput",
        "endpointOriginCommitment",
        "attemptCount",
        "requestCount",
        "retryDelayMs",
      ])
    ) {
      return false;
    }
    const preflight = profile.preflight;
    const checkedAtMs = Date.parse(String(preflight.checkedAt ?? ""));
    const ageAtCaptureMs = nowMs - checkedAtMs;
    const ageAtAdmissionMs = runCreatedAtMs - checkedAtMs;
    return (
      profile.schemaVersion === 2 &&
      profile.attestation === "airlock-control-plane" &&
      profile.inferenceMode === "modelark" &&
      profile.executor === "codex-cli" &&
      profile.runtimeProvider === "container" &&
      profile.providerProtocol === "responses" &&
      sha256Pattern.test(String(profile.modelCommitment ?? "")) &&
      preflight.generatedAssistantOutput === true &&
      sha256Pattern.test(String(preflight.endpointOriginCommitment ?? "")) &&
      isFiniteTimestamp(preflight.checkedAt) &&
      Number.isFinite(checkedAtMs) &&
      ageAtCaptureMs >= -modelArkPreflightFutureToleranceMs &&
      ageAtCaptureMs <= modelArkPreflightMaxAgeMs &&
      ageAtAdmissionMs >= -modelArkPreflightFutureToleranceMs &&
      ageAtAdmissionMs <= modelArkPreflightMaxAgeMs &&
      Number.isInteger(preflight.attemptCount) &&
      Number(preflight.attemptCount) >= 1 &&
      Number(preflight.attemptCount) <= 4 &&
      Number.isInteger(preflight.requestCount) &&
      Number(preflight.requestCount) >= Number(preflight.attemptCount) &&
      Number(preflight.requestCount) <= 16 &&
      Number.isInteger(preflight.retryDelayMs) &&
      Number(preflight.retryDelayMs) >= 0 &&
      Number(preflight.retryDelayMs) <= 15_000
    );
  } catch {
    return false;
  }
}

async function commitment(value: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    ),
  );
  return `sha256:${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function hasExactSqliteState(
  transaction: RunTransaction,
): Promise<boolean> {
  const sqlite = transaction.sqlite;
  const candidate = sqlite?.candidate;
  const after = sqlite?.after;
  const expectedRows = [
    {
      id: "demo",
      value: "modelark-live",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  ];
  const expectedContentHash = await commitment(JSON.stringify(expectedRows));
  const sqliteResource = transaction.resources.find(
    (resource) => resource.kind === "sqlite",
  );
  return (
    sqlite?.databasePath === ".airlock/demo.sqlite" &&
    sqlite.integrity === "passed" &&
    candidate?.rowCount === 1 &&
    after?.rowCount === 1 &&
    JSON.stringify(candidate.rows) === JSON.stringify(expectedRows) &&
    JSON.stringify(after.rows) === JSON.stringify(expectedRows) &&
    candidate.contentHash === expectedContentHash &&
    after.contentHash === expectedContentHash &&
    sqliteResource?.fingerprintAfter === expectedContentHash
  );
}

async function hasExactDeliveredEffect(
  transaction: RunTransaction,
  runId: string,
): Promise<boolean> {
  const actions = transaction.externalActions;
  const intents = actions?.intents;
  if (!Array.isArray(intents) || intents.length !== 1) return false;
  const intent = intents[0];
  const normalizedPayload = JSON.stringify({
    destination: "demo-console",
    subject: "ModelArk release ready",
    body: "The live Whole-Agent Candidate passed.",
  });
  const expectedIdempotencyKey = await commitment(
    [
      runId,
      "modelark-live-ready",
      "demo.notification.requested",
      normalizedPayload,
    ].join("\0"),
  );
  const expectedResourceFingerprint = await commitment(
    JSON.stringify([
      {
        idempotencyKey: expectedIdempotencyKey,
        deliveredAt: intent?.deliveredAt,
      },
    ]),
  );
  const resource = transaction.resources.find(
    (candidate) => candidate.kind === "external-actions",
  );
  return (
    actions.outboxPath === "Candidate State/outbox/intents.jsonl" &&
    actions.deliveredCount === 1 &&
    intent?.id === "modelark-live-ready" &&
    intent.type === "demo.notification.requested" &&
    intent.destination === "demo-console" &&
    intent.subject === "ModelArk release ready" &&
    intent.idempotencyKey === expectedIdempotencyKey &&
    intent.status === "delivered" &&
    isFiniteTimestamp(intent.deliveredAt) &&
    resource?.fingerprintAfter === expectedResourceFingerprint
  );
}

export async function isCompleteLiveModelArkPromotion(
  run: AgentRun,
  nowMs = Date.now(),
): Promise<boolean> {
  const transaction = run.transaction;
  const createdAtMs = Date.parse(run.createdAt ?? "");
  const completedAtMs = Date.parse(run.completedAt ?? "");
  if (
    !safeIdentifierPattern.test(run.id ?? "") ||
    !safeIdentifierPattern.test(run.agentId ?? "") ||
    run.status !== "completed" ||
    run.candidateSetId !== null ||
    run.competitorId !== null ||
    run.prompt !== liveModelArkPrompt ||
    !isFiniteTimestamp(run.createdAt) ||
    !isFiniteTimestamp(run.completedAt) ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(completedAtMs) ||
    completedAtMs < createdAtMs ||
    !Number.isFinite(nowMs) ||
    !transaction ||
    transaction.id !== run.id ||
    transaction.assuranceEvidenceVersion !== 1 ||
    transaction.status !== "promoted" ||
    transaction.disposition !== "promoted" ||
    !safeIdentifierPattern.test(transaction.candidateStateId ?? "") ||
    transaction.quarantinePath !== null ||
    transaction.quarantineAvailable !== false ||
    transaction.discardedAt !== null ||
    transaction.recovery?.journalPhase !== "completed" ||
    transaction.recovery.recoveryError !== null ||
    !hasExactLiveOutcomeContract(transaction) ||
    !hasExactRequiredValidations(transaction.validations) ||
    !hasExactPromotedResources(transaction)
  ) {
    return false;
  }

  const [exactSqliteState, exactDeliveredEffect] = await Promise.all([
    hasExactSqliteState(transaction),
    hasExactDeliveredEffect(transaction, run.id),
  ]);
  if (!exactSqliteState || !exactDeliveredEffect) return false;

  const executionProfile = transaction.validations.find(
    (validation) => validation.name === "execution-profile",
  );
  const liveStateValidation = transaction.validations.find(
    (validation) => validation.name === "command:modelark-live-state",
  );
  const promotionReceipt = transaction.promotionReceipt;
  return (
    hasBoundModelArkPreflight(executionProfile, nowMs, createdAtMs) &&
    liveStateValidation?.required === true &&
    liveStateValidation.status === "passed" &&
    safeIdentifierPattern.test(transaction.canonicalStateIdBefore ?? "") &&
    safeIdentifierPattern.test(transaction.canonicalStateIdAfter ?? "") &&
    transaction.canonicalStateIdAfter !== transaction.canonicalStateIdBefore &&
    sha256Pattern.test(transaction.canonicalContentHashBefore ?? "") &&
    sha256Pattern.test(transaction.canonicalContentHashAfter ?? "") &&
    transaction.canonicalContentHashAfter !==
      transaction.canonicalContentHashBefore &&
    promotionReceipt?.runTransactionId === run.id &&
    promotionReceipt.disposition === "promoted" &&
    promotionReceipt.outcomeContractVersion === transaction.outcomeContractVersion &&
    promotionReceipt.canonicalStateIdBefore === transaction.canonicalStateIdBefore &&
    promotionReceipt.canonicalStateIdAfter === transaction.canonicalStateIdAfter &&
    promotionReceipt.canonicalContentHashBefore ===
      transaction.canonicalContentHashBefore &&
    promotionReceipt.canonicalContentHashAfter ===
      transaction.canonicalContentHashAfter &&
    sha256Pattern.test(promotionReceipt.validationEvidenceHash ?? "")
  );
}

export async function findCompleteLiveModelArkPromotion(
  runs: AgentRun[],
  nowMs = Date.now(),
): Promise<AgentRun | null> {
  const qualified = (
    await Promise.all(
      runs.map(async (run) => ({
        run,
        qualified: await isCompleteLiveModelArkPromotion(run, nowMs),
      })),
    )
  )
    .filter((candidate) => candidate.qualified)
    .map((candidate) => candidate.run)
    .sort(
      (left, right) =>
        Date.parse(right.completedAt ?? "") -
          Date.parse(left.completedAt ?? "") || right.id.localeCompare(left.id),
    );
  return qualified[0] ?? null;
}
