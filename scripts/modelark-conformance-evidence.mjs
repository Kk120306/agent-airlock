import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY,
  verifyModelArkExecutionProfileDisclosure,
  verifyPortableEvidencePacketJson,
} from "@agent-airlock/portable-promotion-receipt";
import {
  comparableContract,
  liveModelArkContract,
  liveModelArkPrompt,
} from "./modelark-demo-profile.mjs";

export const liveModelArkEvidenceDirectoryName = "conformance-evidence";
export const liveModelArkLatestEvidenceName = "modelark-live-latest.packet.json";
export const liveModelArkLatestResultName = "modelark-live-latest.result.json";

const requiredResources = [
  ["workspace", "Workspace"],
  ["codex-session", "Agent memory"],
  ["sqlite", "SQLite data"],
  ["external-actions", "External actions"],
];
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
];
const modelArkPreflightMaxAgeMs = 2 * 60 * 60 * 1_000;
const modelArkPreflightFutureToleranceMs = 60_000;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const safeEvidenceFileNamePattern =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const safePublicationIdPattern = /^[a-f0-9-]{36}$/;
const maximumEvidenceBytes = 2_097_152;

function ownedByCurrentUser(status) {
  return typeof process.geteuid !== "function" || status.uid === process.geteuid();
}

function publicationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertSafeEvidenceFileName(fileName) {
  if (
    !safeEvidenceFileNamePattern.test(fileName ?? "") ||
    path.basename(fileName) !== fileName
  ) {
    throw publicationError(
      "The ModelArk evidence publication filename is unsafe",
      "EVIDENCE_PATH_UNSAFE",
    );
  }
}

async function privateEvidenceDirectory(stateRoot) {
  const resolvedRoot = path.resolve(stateRoot);
  const rootStatus = await lstat(resolvedRoot);
  if (
    !rootStatus.isDirectory() ||
    rootStatus.isSymbolicLink() ||
    !ownedByCurrentUser(rootStatus) ||
    (rootStatus.mode & 0o022) !== 0
  ) {
    throw publicationError(
      "The ModelArk evidence state root is unsafe",
      "EVIDENCE_DIRECTORY_UNSAFE",
    );
  }

  const physicalRoot = await realpath(resolvedRoot);
  const evidenceDirectory = path.join(
    physicalRoot,
    liveModelArkEvidenceDirectoryName,
  );
  try {
    await mkdir(evidenceDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const directoryStatus = await lstat(evidenceDirectory);
  if (
    !directoryStatus.isDirectory() ||
    directoryStatus.isSymbolicLink() ||
    !ownedByCurrentUser(directoryStatus) ||
    (directoryStatus.mode & 0o077) !== 0 ||
    (await realpath(evidenceDirectory)) !== evidenceDirectory
  ) {
    throw publicationError(
      "The ModelArk evidence directory is unsafe",
      "EVIDENCE_DIRECTORY_UNSAFE",
    );
  }
  return evidenceDirectory;
}

async function readPrivatePublication(
  filePath,
  { maximumBytes, allowMissing = false },
) {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") {
      throw publicationError(
        "The ModelArk evidence publication is a symbolic link",
        "EVIDENCE_PATH_UNSAFE",
      );
    }
    throw error;
  }

  try {
    const status = await handle.stat();
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      !ownedByCurrentUser(status) ||
      (status.mode & 0o077) !== 0 ||
      status.size < 1 ||
      status.size > maximumBytes
    ) {
      throw publicationError(
        "The ModelArk evidence publication is unsafe",
        "EVIDENCE_PATH_UNSAFE",
      );
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function assertPrivatePublicationInput({
  fileName,
  content,
  maximumBytes,
  publicationId,
}) {
  assertSafeEvidenceFileName(fileName);
  const contentBytes =
    typeof content === "string" ? Buffer.byteLength(content) : 0;
  if (
    typeof content !== "string" ||
    contentBytes < 1 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > maximumEvidenceBytes ||
    contentBytes > maximumBytes ||
    !safePublicationIdPattern.test(publicationId)
  ) {
    throw publicationError(
      "The ModelArk evidence publication input is unsafe",
      "EVIDENCE_PUBLICATION_UNSAFE",
    );
  }
  return contentBytes;
}

async function preparePrivatePublication({
  evidenceDirectory,
  fileName,
  content,
  contentBytes,
  publicationId,
}) {
  const temporaryPath = path.join(
    evidenceDirectory,
    `.${fileName}.tmp-${publicationId}`,
  );
  let handle;
  let ownsTemporaryPath = false;
  try {
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      ownsTemporaryPath = true;
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ELOOP") {
        throw publicationError(
          "The ModelArk evidence temporary publication path is unsafe",
          "EVIDENCE_TEMPORARY_PATH_UNSAFE",
        );
      }
      throw error;
    }

    await handle.writeFile(content, "utf8");
    await handle.sync();
    const temporaryStatus = await handle.stat();
    if (
      !temporaryStatus.isFile() ||
      temporaryStatus.nlink !== 1 ||
      !ownedByCurrentUser(temporaryStatus) ||
      (temporaryStatus.mode & 0o077) !== 0 ||
      temporaryStatus.size !== contentBytes
    ) {
      throw publicationError(
        "The ModelArk evidence temporary publication is unsafe",
        "EVIDENCE_TEMPORARY_PATH_UNSAFE",
      );
    }
    await handle.close();
    handle = null;
    return temporaryPath;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (ownsTemporaryPath) {
      await unlink(temporaryPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    }
    throw error;
  }
}

async function removePreparedPublication(temporaryPath) {
  await unlink(temporaryPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function syncPrivateEvidenceDirectory(evidenceDirectory) {
  const directoryHandle = await open(evidenceDirectory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function assertInstalledPrivatePublication({
  destinationPath,
  content,
  maximumBytes,
}) {
  const installed = await readPrivatePublication(destinationPath, {
    maximumBytes,
  });
  if (installed !== content) {
    throw publicationError(
      "The ModelArk evidence publication changed after installation",
      "EVIDENCE_PUBLICATION_CONFLICT",
    );
  }
}

async function recoverInterruptedImmutablePublication({
  evidenceDirectory,
  destinationPath,
  fileName,
  content,
  maximumBytes,
}) {
  let destinationHandle;
  try {
    destinationHandle = await open(
      destinationPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code === "ELOOP") {
      throw publicationError(
        "The ModelArk evidence publication is a symbolic link",
        "EVIDENCE_PATH_UNSAFE",
      );
    }
    throw error;
  }

  let temporaryHandle;
  try {
    const destinationStatus = await destinationHandle.stat();
    if (destinationStatus.nlink === 1) return false;
    if (
      !destinationStatus.isFile() ||
      destinationStatus.nlink !== 2 ||
      !ownedByCurrentUser(destinationStatus) ||
      (destinationStatus.mode & 0o077) !== 0 ||
      destinationStatus.size < 1 ||
      destinationStatus.size > maximumBytes
    ) {
      throw publicationError(
        "The interrupted ModelArk evidence publication is unsafe",
        "EVIDENCE_PATH_UNSAFE",
      );
    }
    const destinationContent = await destinationHandle.readFile("utf8");
    if (content !== undefined && destinationContent !== content) {
      throw publicationError(
        "The interrupted ModelArk evidence publication has different content",
        "EVIDENCE_PUBLICATION_CONFLICT",
      );
    }

    const temporaryPrefix = `.${fileName}.tmp-`;
    const temporaryNames = (await readdir(evidenceDirectory)).filter(
      (name) =>
        name.startsWith(temporaryPrefix) &&
        safePublicationIdPattern.test(name.slice(temporaryPrefix.length)),
    );
    if (temporaryNames.length !== 1) {
      throw publicationError(
        "The interrupted ModelArk evidence publication is ambiguous",
        "EVIDENCE_PATH_UNSAFE",
      );
    }
    const temporaryPath = path.join(evidenceDirectory, temporaryNames[0]);
    try {
      temporaryHandle = await open(
        temporaryPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw publicationError(
          "The interrupted ModelArk evidence temporary path is unsafe",
          "EVIDENCE_TEMPORARY_PATH_UNSAFE",
        );
      }
      throw error;
    }
    const temporaryStatus = await temporaryHandle.stat();
    if (
      !temporaryStatus.isFile() ||
      temporaryStatus.nlink !== 2 ||
      !ownedByCurrentUser(temporaryStatus) ||
      (temporaryStatus.mode & 0o077) !== 0 ||
      temporaryStatus.size !== destinationStatus.size ||
      temporaryStatus.dev !== destinationStatus.dev ||
      temporaryStatus.ino !== destinationStatus.ino ||
      (await temporaryHandle.readFile("utf8")) !== destinationContent
    ) {
      throw publicationError(
        "The interrupted ModelArk evidence temporary link does not match",
        "EVIDENCE_TEMPORARY_PATH_UNSAFE",
      );
    }

    const [currentDestination, currentTemporary] = await Promise.all([
      lstat(destinationPath),
      lstat(temporaryPath),
    ]);
    if (
      !currentDestination.isFile() ||
      !currentTemporary.isFile() ||
      currentDestination.dev !== destinationStatus.dev ||
      currentDestination.ino !== destinationStatus.ino ||
      currentTemporary.dev !== temporaryStatus.dev ||
      currentTemporary.ino !== temporaryStatus.ino
    ) {
      throw publicationError(
        "The interrupted ModelArk evidence links changed during recovery",
        "EVIDENCE_TEMPORARY_PATH_UNSAFE",
      );
    }

    await unlink(temporaryPath);
    const recoveredStatus = await destinationHandle.stat();
    if (recoveredStatus.nlink !== 1) {
      throw publicationError(
        "The interrupted ModelArk evidence publication did not recover safely",
        "EVIDENCE_PATH_UNSAFE",
      );
    }
    await syncPrivateEvidenceDirectory(evidenceDirectory);
    return true;
  } finally {
    await temporaryHandle?.close().catch(() => {});
    await destinationHandle.close();
  }
}

export async function publishPrivateModelArkEvidence({
  stateRoot,
  fileName,
  content,
  maximumBytes = maximumEvidenceBytes,
  publicationId = randomUUID(),
}) {
  const contentBytes = assertPrivatePublicationInput({
    fileName,
    content,
    maximumBytes,
    publicationId,
  });

  const evidenceDirectory = await privateEvidenceDirectory(stateRoot);
  const destinationPath = path.join(evidenceDirectory, fileName);
  await recoverInterruptedImmutablePublication({
    evidenceDirectory,
    destinationPath,
    fileName,
    content,
    maximumBytes,
  });
  const existing = await readPrivatePublication(destinationPath, {
    maximumBytes,
    allowMissing: true,
  });
  if (existing !== null) {
    if (existing !== content) {
      throw publicationError(
        "The ModelArk evidence publication already exists with different content",
        "EVIDENCE_PUBLICATION_CONFLICT",
      );
    }
    return { path: destinationPath, published: false };
  }

  const temporaryPath = await preparePrivatePublication({
    evidenceDirectory,
    fileName,
    content,
    contentBytes,
    publicationId,
  });
  let installed = false;
  let lostPublicationRace = false;
  try {
    try {
      await link(temporaryPath, destinationPath);
      installed = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      lostPublicationRace = true;
    }
  } finally {
    await removePreparedPublication(temporaryPath);
  }

  if (lostPublicationRace) {
    const concurrent = await readPrivatePublication(destinationPath, {
      maximumBytes,
    });
    if (concurrent !== content) {
      throw publicationError(
        "The ModelArk evidence publication lost an exclusive publication race",
        "EVIDENCE_PUBLICATION_CONFLICT",
      );
    }
    return { path: destinationPath, published: false };
  }
  if (!installed) {
    throw publicationError(
      "The ModelArk evidence publication was not installed",
      "EVIDENCE_PUBLICATION_UNSAFE",
    );
  }

  await assertInstalledPrivatePublication({
    destinationPath,
    content,
    maximumBytes,
  });
  await syncPrivateEvidenceDirectory(evidenceDirectory);
  return { path: destinationPath, published: true };
}

export async function replacePrivateModelArkEvidence({
  stateRoot,
  fileName,
  content,
  maximumBytes = maximumEvidenceBytes,
  publicationId = randomUUID(),
  publicationOperations = {},
}) {
  const contentBytes = assertPrivatePublicationInput({
    fileName,
    content,
    maximumBytes,
    publicationId,
  });
  const evidenceDirectory = await privateEvidenceDirectory(stateRoot);
  const destinationPath = path.join(evidenceDirectory, fileName);
  const existing = await readPrivatePublication(destinationPath, {
    maximumBytes,
    allowMissing: true,
  });
  if (existing === content) {
    return {
      path: destinationPath,
      published: false,
      committed: true,
      durable: true,
      verified: true,
    };
  }

  const temporaryPath = await preparePrivatePublication({
    evidenceDirectory,
    fileName,
    content,
    contentBytes,
    publicationId,
  });
  const renamePublication = publicationOperations.rename ?? rename;
  const beforeCommit = publicationOperations.beforeCommit ?? (() => {});
  const syncDirectory =
    publicationOperations.syncDirectory ?? syncPrivateEvidenceDirectory;
  const verifyInstalled =
    publicationOperations.verifyInstalled ?? assertInstalledPrivatePublication;
  let committed = false;
  try {
    try {
      await beforeCommit({ temporaryPath, destinationPath });
      await renamePublication(temporaryPath, destinationPath);
      committed = true;
    } catch (error) {
      const installed = await readPrivatePublication(destinationPath, {
        maximumBytes,
        allowMissing: true,
      }).catch(() => null);
      if (installed !== content) throw error;
      committed = true;
    }
  } finally {
    if (!committed) await removePreparedPublication(temporaryPath);
  }

  let durable = false;
  let verified = false;
  try {
    await syncDirectory(evidenceDirectory);
    durable = true;
  } catch {}
  try {
    await verifyInstalled({
      destinationPath,
      content,
      maximumBytes,
    });
    verified = true;
  } catch {}
  return {
    path: destinationPath,
    published: true,
    committed: true,
    durable,
    verified,
  };
}

async function readExistingPrivateModelArkEvidence(stateRoot, fileName) {
  assertSafeEvidenceFileName(fileName);
  const evidenceDirectory = await privateEvidenceDirectory(stateRoot);
  const filePath = path.join(evidenceDirectory, fileName);
  await recoverInterruptedImmutablePublication({
    evidenceDirectory,
    destinationPath: filePath,
    fileName,
    content: undefined,
    maximumBytes: maximumEvidenceBytes,
  });
  const content = await readPrivatePublication(filePath, {
    maximumBytes: maximumEvidenceBytes,
    allowMissing: true,
  });
  return content === null ? null : { content, path: filePath };
}

function commitment(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function isFiniteTimestamp(value) {
  return (
    typeof value === "string" &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function hasBoundModelArkPreflight(validation, nowMs, runCreatedAtMs) {
  if (
    validation?.status !== "passed" ||
    validation?.required !== true ||
    typeof validation.output !== "string" ||
    validation.output.length > 4_096
  ) {
    return false;
  }
  try {
    const profile = JSON.parse(validation.output);
    const preflight = profile?.preflight;
    if (
      !hasExactKeys(profile, [
        "schemaVersion",
        "attestation",
        "inferenceMode",
        "executor",
        "runtimeProvider",
        "providerProtocol",
        "modelCommitment",
        "preflight",
      ]) ||
      !hasExactKeys(preflight, [
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
    const checkedAtMs = Date.parse(preflight.checkedAt);
    const ageAtCaptureMs = nowMs - checkedAtMs;
    const ageAtAdmissionMs = runCreatedAtMs - checkedAtMs;
    return (
      profile.schemaVersion === 2 &&
      profile.attestation === "airlock-control-plane" &&
      profile.inferenceMode === "modelark" &&
      profile.executor === "codex-cli" &&
      profile.runtimeProvider === "container" &&
      profile.providerProtocol === "responses" &&
      sha256Pattern.test(profile.modelCommitment ?? "") &&
      preflight.generatedAssistantOutput === true &&
      sha256Pattern.test(preflight.endpointOriginCommitment ?? "") &&
      isFiniteTimestamp(preflight.checkedAt) &&
      Number.isFinite(checkedAtMs) &&
      ageAtCaptureMs >= -modelArkPreflightFutureToleranceMs &&
      ageAtCaptureMs <= modelArkPreflightMaxAgeMs &&
      ageAtAdmissionMs >= -modelArkPreflightFutureToleranceMs &&
      ageAtAdmissionMs <= modelArkPreflightMaxAgeMs &&
      Number.isInteger(preflight.attemptCount) &&
      preflight.attemptCount >= 1 &&
      preflight.attemptCount <= 4 &&
      Number.isInteger(preflight.requestCount) &&
      preflight.requestCount >= preflight.attemptCount &&
      preflight.requestCount <= 16 &&
      Number.isInteger(preflight.retryDelayMs) &&
      preflight.retryDelayMs >= 0 &&
      preflight.retryDelayMs <= 15_000
    );
  } catch {
    return false;
  }
}

function hasExactLiveOutcomeContract(transaction) {
  const contract = transaction?.outcomeContract;
  return (
    contract?.schemaVersion === 1 &&
    Number.isInteger(contract.version) &&
    contract.version >= 1 &&
    transaction.outcomeContractVersion === contract.version &&
    isFiniteTimestamp(contract.createdAt) &&
    JSON.stringify(comparableContract(contract)) ===
      JSON.stringify(liveModelArkContract)
  );
}

function hasExactRequiredValidations(validations) {
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

function hasExactPromotedResources(transaction) {
  const resources = transaction?.resources;
  if (
    !Array.isArray(resources) ||
    resources.length !== requiredResources.length ||
    !Array.isArray(transaction.providerResources) ||
    transaction.providerResources.length !== 0 ||
    !Array.isArray(transaction.providerResourceEvents) ||
    transaction.providerResourceEvents.length !== 0
  ) {
    return false;
  }
  return requiredResources.every(([kind, label], index) => {
    const resource = resources[index];
    return (
      resource?.kind === kind &&
      resource?.label === label &&
      resource?.disposition === "promoted" &&
      sha256Pattern.test(resource?.fingerprintBefore ?? "") &&
      sha256Pattern.test(resource?.fingerprintAfter ?? "")
    );
  });
}

function hasExactSqliteState(transaction) {
  const sqlite = transaction?.sqlite;
  const candidate = sqlite?.candidate;
  const after = sqlite?.after;
  const expectedRows = [
    {
      id: "demo",
      value: "modelark-live",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  ];
  const expectedContentHash = commitment(JSON.stringify(expectedRows));
  const sqliteResource = transaction?.resources?.find(
    (resource) => resource.kind === "sqlite",
  );
  return (
    sqlite?.databasePath === ".airlock/demo.sqlite" &&
    sqlite?.integrity === "passed" &&
    candidate?.rowCount === 1 &&
    after?.rowCount === 1 &&
    JSON.stringify(candidate.rows) === JSON.stringify(expectedRows) &&
    JSON.stringify(after.rows) === JSON.stringify(expectedRows) &&
    candidate.contentHash === expectedContentHash &&
    after.contentHash === expectedContentHash &&
    sqliteResource?.fingerprintAfter === expectedContentHash
  );
}

function hasExactDeliveredEffect(transaction, runId) {
  const actions = transaction?.externalActions;
  const intents = actions?.intents;
  if (!Array.isArray(intents) || intents.length !== 1) return false;
  const intent = intents[0];
  const normalizedPayload = JSON.stringify({
    destination: "demo-console",
    subject: "ModelArk release ready",
    body: "The live Whole-Agent Candidate passed.",
  });
  const expectedIdempotencyKey = commitment(
    [
      runId,
      "modelark-live-ready",
      "demo.notification.requested",
      normalizedPayload,
    ].join("\0"),
  );
  const expectedResourceFingerprint = commitment(
    JSON.stringify([
      {
        idempotencyKey: expectedIdempotencyKey,
        deliveredAt: intent?.deliveredAt,
      },
    ]),
  );
  const resource = transaction?.resources?.find(
    (candidate) => candidate.kind === "external-actions",
  );
  return (
    actions.outboxPath === "Candidate State/outbox/intents.jsonl" &&
    actions.deliveredCount === 1 &&
    intent?.id === "modelark-live-ready" &&
    intent?.type === "demo.notification.requested" &&
    intent?.destination === "demo-console" &&
    intent?.subject === "ModelArk release ready" &&
    intent?.idempotencyKey === expectedIdempotencyKey &&
    intent?.status === "delivered" &&
    isFiniteTimestamp(intent?.deliveredAt) &&
    resource?.fingerprintAfter === expectedResourceFingerprint
  );
}

export function isCompleteLiveModelArkPromotion(run, nowMs = Date.now()) {
  const transaction = run?.transaction;
  const createdAtMs = Date.parse(run?.createdAt ?? "");
  const completedAtMs = Date.parse(run?.completedAt ?? "");
  if (
    !safeIdentifierPattern.test(run?.id ?? "") ||
    !safeIdentifierPattern.test(run?.agentId ?? "") ||
    run?.status !== "completed" ||
    run?.candidateSetId !== null ||
    run?.competitorId !== null ||
    run?.prompt !== liveModelArkPrompt ||
    !isFiniteTimestamp(run?.createdAt) ||
    !isFiniteTimestamp(run?.completedAt) ||
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
    transaction.recovery?.recoveryError !== null ||
    !hasExactLiveOutcomeContract(transaction) ||
    !hasExactRequiredValidations(transaction.validations) ||
    !hasExactPromotedResources(transaction) ||
    !hasExactSqliteState(transaction) ||
    !hasExactDeliveredEffect(transaction, run.id)
  ) {
    return false;
  }
  const executionProfile = transaction.validations?.find(
    (validation) => validation.name === "execution-profile",
  );
  const liveStateValidation = transaction.validations?.find(
    (validation) => validation.name === "command:modelark-live-state",
  );
  const promotionReceipt = transaction.promotionReceipt;
  return (
    hasBoundModelArkPreflight(executionProfile, nowMs, createdAtMs) &&
    liveStateValidation?.required === true &&
    liveStateValidation?.status === "passed" &&
    safeIdentifierPattern.test(transaction.canonicalStateIdBefore ?? "") &&
    safeIdentifierPattern.test(transaction.canonicalStateIdAfter ?? "") &&
    transaction.canonicalStateIdAfter !== transaction.canonicalStateIdBefore &&
    sha256Pattern.test(transaction.canonicalContentHashBefore ?? "") &&
    sha256Pattern.test(transaction.canonicalContentHashAfter ?? "") &&
    transaction.canonicalContentHashAfter !==
      transaction.canonicalContentHashBefore &&
    promotionReceipt?.runTransactionId === run.id &&
    promotionReceipt?.disposition === "promoted" &&
    promotionReceipt.outcomeContractVersion ===
      transaction.outcomeContractVersion &&
    promotionReceipt.canonicalStateIdBefore ===
      transaction.canonicalStateIdBefore &&
    promotionReceipt.canonicalStateIdAfter ===
      transaction.canonicalStateIdAfter &&
    promotionReceipt.canonicalContentHashBefore ===
      transaction.canonicalContentHashBefore &&
    promotionReceipt.canonicalContentHashAfter ===
      transaction.canonicalContentHashAfter &&
    sha256Pattern.test(promotionReceipt.validationEvidenceHash ?? "")
  );
}

export function liveModelArkEvidenceNameForRun(runId) {
  if (!safeIdentifierPattern.test(runId ?? "")) {
    throw new Error("The live ModelArk Run identifier is unsafe");
  }
  return `modelark-live-${runId}.packet.json`;
}

async function requestJson(baseUrl, pathname, options, fetchImpl, signal) {
  const timeout = AbortSignal.timeout(5_000);
  const response = await fetchImpl(baseUrl + pathname, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${pathname}`);
  return response.json();
}

function assertSafeCapturedPacket(exported, runId) {
  const packet = exported?.packet;
  const envelope = packet?.envelope;
  const serialized = JSON.stringify(packet, null, 2) + "\n";
  if (
    /Bearer\s|ARK_API_KEY|api[_-]?key\s*[=:]|https?:\/\/|\bep-[A-Za-z0-9]|\bark-[A-Za-z0-9]/i.test(
      serialized,
    )
  ) {
    throw new Error("The live ModelArk evidence packet contains forbidden private material");
  }
  const verification = verifyPortableEvidencePacketJson(serialized);
  const disclosures = envelope?.disclosures;
  if (
    !verification.valid ||
    packet?.schema !== "agent-airlock/portable-evidence-packet" ||
    envelope?.receipt?.decision?.runId !== runId ||
    envelope.receipt.decision.disposition !== "promoted" ||
    !Array.isArray(disclosures) ||
    disclosures.length !== 1 ||
    disclosures[0]?.leaf?.identity !==
      MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY
  ) {
    throw new Error("The live ModelArk evidence packet did not pass capture admission");
  }
  try {
    verifyModelArkExecutionProfileDisclosure(
      disclosures[0],
      envelope.receipt.decision.decidedAt,
    );
  } catch {
    throw new Error(
      "The live ModelArk evidence packet did not prove the exact safe execution profile",
    );
  }
  return serialized;
}

async function assertSafeStoredPacket(serialized, runId) {
  let packet;
  try {
    packet = JSON.parse(serialized);
  } catch {
    throw new Error("The stored live ModelArk evidence packet is malformed");
  }
  return assertSafeCapturedPacket({ packet }, runId);
}

export async function captureLiveModelArkConformance({
  baseUrl,
  agentId,
  stateRoot,
  fetchImpl = fetch,
  signal,
  verifyStoredPacket = assertSafeStoredPacket,
}) {
  const { runs } = await requestJson(
    baseUrl,
    `/api/agents/${agentId}/runs`,
    {},
    fetchImpl,
    signal,
  );
  const run = runs
    .filter((candidate) => isCompleteLiveModelArkPromotion(candidate))
    .sort(
      (left, right) =>
        Date.parse(right.completedAt) - Date.parse(left.completedAt) ||
        right.id.localeCompare(left.id),
    )[0];
  if (!run) return null;

  const artifactFileName = liveModelArkEvidenceNameForRun(run.id);
  const existingArtifact = await readExistingPrivateModelArkEvidence(
    stateRoot,
    artifactFileName,
  );
  if (existingArtifact) {
    const serialized = await verifyStoredPacket(
      existingArtifact.content,
      run.id,
    );
    const latest = await replacePrivateModelArkEvidence({
      stateRoot,
      fileName: liveModelArkLatestEvidenceName,
      content: serialized,
    });
    if (!latest.published) return null;
    return {
      runId: run.id,
      artifactPath: existingArtifact.path,
      relativePath: path.join(
        liveModelArkEvidenceDirectoryName,
        artifactFileName,
      ),
      reconciled: true,
    };
  }

  const exported = await requestJson(
    baseUrl,
    `/api/runs/${run.id}/portable-receipt`,
    {
      method: "POST",
      body: JSON.stringify({
        disclosureIdentities: [MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY],
        includeAncestry: false,
        localAnchor: false,
        evmPayload: false,
      }),
    },
    fetchImpl,
    signal,
  );
  const serialized = assertSafeCapturedPacket(exported, run.id);
  const artifact = await publishPrivateModelArkEvidence({
    stateRoot,
    fileName: artifactFileName,
    content: serialized,
  });
  await replacePrivateModelArkEvidence({
    stateRoot,
    fileName: liveModelArkLatestEvidenceName,
    content: serialized,
  });
  return {
    runId: run.id,
    artifactPath: artifact.path,
    relativePath: path.join(
      liveModelArkEvidenceDirectoryName,
      artifactFileName,
    ),
    reconciled: false,
  };
}

export async function monitorLiveModelArkConformance({
  baseUrl,
  agentId,
  stateRoot,
  signal,
  fetchImpl = fetch,
  intervalMs = 750,
  onCaptured = () => {},
  onError = () => {},
}) {
  let lastError = null;
  while (!signal.aborted) {
    try {
      const captured = await captureLiveModelArkConformance({
        baseUrl,
        agentId,
        stateRoot,
        fetchImpl,
        signal,
      });
      if (captured) onCaptured(captured);
      lastError = null;
    } catch (error) {
      if (signal.aborted) break;
      const errorClass = error instanceof Error ? error.name : "UnknownError";
      if (errorClass !== lastError) onError();
      lastError = errorClass;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
