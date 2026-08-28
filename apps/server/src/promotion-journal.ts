import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
  parsePreparedResource,
  parseResourceChangeEvidence,
  parseResourcePromotionPlan,
  parseResourceProviderManifest,
  parseResourceQuarantineHandle,
  parseResourceValidationEvidence,
  parseResourceVersionReference,
  type ResourcePromotionPlan,
  type ResourceVersionReference,
} from "@agent-airlock/transactional-resource-sdk";
import type {
  CanonicalStateReference,
  PromotionJournalPhase,
  RunTransaction,
  RunnerResult,
} from "./types.js";
import type { PromotionPlan } from "./workspace.js";

const phaseOrder: PromotionJournalPhase[] = [
  "validated",
  "version-installed",
  "canonical-advanced",
  "effects-delivered",
  "completed",
];
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const maximumJournalBytes = 2_000_000;
const maximumProviders = 64;
const maximumProviderEvents = 256;
const recoveryOutput =
  "Agent Airlock recovered this approved Promotion after a server restart. The original Runtime response was not duplicated into the Promotion journal.";

export interface PromotionJournalRecord {
  schemaVersion: 2;
  runId: string;
  agentId: string;
  authority: PromotionAuthority;
  phase: PromotionJournalPhase;
  plan: PromotionPlan;
  targetCanonical: CanonicalStateReference | null;
  transaction: RunTransaction;
  recoveryResult: RunnerResult;
  createdAt: string;
  updatedAt: string;
}

export type PromotionAuthority =
  | {
      schemaVersion: 1;
      kind: "ordinary-run";
    }
  | {
      schemaVersion: 1;
      kind: "candidate-set";
      candidateSetId: string;
      competitorId: string;
      winnerRunId: string;
      selectionDecisionDigest: string;
      sealDigest: string;
      sourceStateId: string;
      sourceContentHash: string;
    }
  | {
      schemaVersion: 1;
      kind: "federated-admission";
      admissionId: string;
      importIdentifier: string;
      recordDigest: string;
      producerId: string;
      policyDigest: string;
    };

export interface PromotionJournalScanError {
  runId: string | null;
  message: string;
}

export interface PromotionJournalScan {
  records: PromotionJournalRecord[];
  errors: PromotionJournalScanError[];
}

export class PromotionJournal {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async begin(input: {
    plan: PromotionPlan;
    transaction: RunTransaction;
    result: RunnerResult;
    authority?: PromotionAuthority;
  }): Promise<PromotionJournalRecord> {
    this.assertIdentifier(input.plan.runId, "Run");
    let result!: PromotionJournalRecord;
    const operation = this.queue.then(async () => {
      const target = this.filePath(input.plan.runId);
      try {
        await readFile(target, "utf8");
        throw new Error(
          "Promotion journal already exists for Run " + input.plan.runId,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const timestamp = new Date().toISOString();
      const transaction = structuredClone(input.transaction);
      transaction.recovery = {
        journalPhase: "validated",
        recoveredAfterRestart: false,
        recoveryError: null,
      };
      const record: PromotionJournalRecord = {
        schemaVersion: 2,
        runId: input.plan.runId,
        agentId: input.plan.agentId,
        authority: structuredClone(
          input.authority ?? { schemaVersion: 1, kind: "ordinary-run" },
        ),
        phase: "validated",
        plan: structuredClone(input.plan),
        targetCanonical: null,
        transaction,
        recoveryResult: {
          output: recoveryOutput,
          threadId: input.result.threadId,
          usage: input.result.usage
            ? structuredClone(input.result.usage)
            : null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.validateRecord(record);
      await this.persist(record);
      result = structuredClone(record);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async advance(
    runId: string,
    phase: PromotionJournalPhase,
    updates: {
      transaction: RunTransaction;
      targetCanonical?: CanonicalStateReference | null;
    },
  ): Promise<PromotionJournalRecord> {
    let result!: PromotionJournalRecord;
    const operation = this.queue.then(async () => {
      const current = await this.read(runId);
      const currentIndex = phaseOrder.indexOf(current.phase);
      const nextIndex = phaseOrder.indexOf(phase);
      if (nextIndex === currentIndex) {
        result = structuredClone(current);
        return;
      }
      if (nextIndex !== currentIndex + 1) {
        throw new Error(
          "Promotion journal cannot advance from " +
            current.phase +
            " to " +
            phase,
        );
      }
      const transaction = structuredClone(updates.transaction);
      transaction.recovery = {
        ...transaction.recovery,
        journalPhase: phase,
        recoveryError: null,
      };
      const next: PromotionJournalRecord = {
        ...current,
        phase,
        transaction,
        targetCanonical:
          updates.targetCanonical === undefined
            ? current.targetCanonical
            : updates.targetCanonical
              ? structuredClone(updates.targetCanonical)
              : null,
        updatedAt: new Date().toISOString(),
      };
      this.validateRecord(next);
      await this.persist(next);
      result = structuredClone(next);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async recordRecoveryError(
    runId: string,
    transaction: RunTransaction,
    message: string,
  ): Promise<PromotionJournalRecord> {
    let result!: PromotionJournalRecord;
    const operation = this.queue.then(async () => {
      const current = await this.read(runId);
      const nextTransaction = structuredClone(transaction);
      nextTransaction.status = "recovery-error";
      nextTransaction.recovery = {
        ...nextTransaction.recovery,
        journalPhase: current.phase,
        recoveredAfterRestart:
          current.transaction.recovery.recoveredAfterRestart,
        recoveryError: message.slice(0, 500),
      };
      const next = {
        ...current,
        transaction: nextTransaction,
        updatedAt: new Date().toISOString(),
      };
      this.validateRecord(next);
      await this.persist(next);
      result = structuredClone(next);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async updateTransaction(
    runId: string,
    transaction: RunTransaction,
  ): Promise<PromotionJournalRecord> {
    let result!: PromotionJournalRecord;
    const operation = this.queue.then(async () => {
      const current = await this.read(runId);
      const nextTransaction = structuredClone(transaction);
      nextTransaction.recovery.journalPhase = current.phase;
      const next = {
        ...current,
        transaction: nextTransaction,
        updatedAt: new Date().toISOString(),
      };
      this.validateRecord(next);
      await this.persist(next);
      result = structuredClone(next);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async read(runId: string): Promise<PromotionJournalRecord> {
    this.assertIdentifier(runId, "Run");
    const raw = await readFile(this.filePath(runId), "utf8");
    if (Buffer.byteLength(raw, "utf8") > maximumJournalBytes) {
      throw new Error("Promotion journal exceeds 2000000 bytes");
    }
    const parsed = upgradeLegacyResourcePlan(JSON.parse(raw) as unknown);
    this.validateRecord(parsed);
    return structuredClone(parsed);
  }

  async scan(): Promise<PromotionJournalScan> {
    await this.queue;
    const records: PromotionJournalRecord[] = [];
    const errors: PromotionJournalScanError[] = [];
    const entries = await readdir(this.directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const runId = entry.name.slice(0, -5);
      if (!safeIdentifierPattern.test(runId)) {
        errors.push({
          runId: null,
          message: "Unsafe Promotion journal filename",
        });
        continue;
      }
      try {
        const record = await this.read(runId);
        records.push(record);
      } catch (error) {
        errors.push({
          runId,
          message:
            "Promotion journal is corrupt: " +
            (error instanceof Error ? error.message : String(error)),
        });
      }
    }
    return { records, errors };
  }

  private validateRecord(
    value: unknown,
  ): asserts value is PromotionJournalRecord {
    if (!value || typeof value !== "object") {
      throw new Error("Promotion journal must be an object");
    }
    const record = value as PromotionJournalRecord;
    assertExactKeys(
      record,
      [
        "schemaVersion",
        "runId",
        "agentId",
        "authority",
        "phase",
        "plan",
        "targetCanonical",
        "transaction",
        "recoveryResult",
        "createdAt",
        "updatedAt",
      ],
      "Promotion journal",
    );
    if (
      record.schemaVersion !== 2 ||
      !safeIdentifierPattern.test(record.runId) ||
      !safeIdentifierPattern.test(record.agentId) ||
      !phaseOrder.includes(record.phase) ||
      !record.plan ||
      record.plan.runId !== record.runId ||
      record.plan.agentId !== record.agentId ||
      !safeIdentifierPattern.test(record.plan.targetStateId) ||
      !safeIdentifierPattern.test(record.plan.sourceStateId) ||
      !record.transaction ||
      record.transaction.id !== record.runId ||
      !record.recoveryResult ||
      record.recoveryResult.output !== recoveryOutput ||
      typeof record.createdAt !== "string" ||
      typeof record.updatedAt !== "string"
    ) {
      throw new Error("Promotion journal identity or schema is invalid");
    }
    validatePromotionAuthority(record);
    const phaseIndex = phaseOrder.indexOf(record.phase);
    if (phaseIndex >= 1 && !record.targetCanonical) {
      throw new Error(
        "Installed Promotion journal phase requires target fingerprints",
      );
    }
    if (
      record.targetCanonical &&
      record.targetCanonical.stateId !== record.plan.targetStateId
    ) {
      throw new Error("Promotion journal target does not match its plan");
    }
    validateResourceEvidence(record);
  }

  private async persist(record: PromotionJournalRecord): Promise<void> {
    const target = this.filePath(record.runId);
    const temporary = target + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  private filePath(runId: string): string {
    this.assertIdentifier(runId, "Run");
    return path.join(this.directory, runId + ".json");
  }

  private assertIdentifier(value: string, label: string): void {
    if (!safeIdentifierPattern.test(value)) {
      throw new Error(label + " identifier is not safe");
    }
  }
}

function validatePromotionAuthority(record: PromotionJournalRecord): void {
  const authority = record.authority;
  if (!authority || typeof authority !== "object") {
    throw new Error("Promotion journal authority is missing");
  }
  if (authority.kind === "ordinary-run") {
    assertExactKeys(
      authority,
      ["schemaVersion", "kind"],
      "ordinary Run Promotion authority",
    );
    if (authority.schemaVersion !== 1) {
      throw new Error("Promotion journal authority schema is invalid");
    }
    return;
  }
  if (authority.kind === "federated-admission") {
    assertExactKeys(
      authority,
      [
        "schemaVersion",
        "kind",
        "admissionId",
        "importIdentifier",
        "recordDigest",
        "producerId",
        "policyDigest",
      ],
      "Federated Admission Promotion authority",
    );
    if (
      authority.schemaVersion !== 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(authority.admissionId) ||
      !/^sha256:[a-f0-9]{64}$/.test(authority.importIdentifier) ||
      !/^sha256:[a-f0-9]{64}$/.test(authority.recordDigest) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(authority.producerId) ||
      !/^sha256:[a-f0-9]{64}$/.test(authority.policyDigest)
    ) {
      throw new Error("Federated Admission Promotion authority is invalid");
    }
    return;
  }
  if (authority.kind !== "candidate-set") {
    throw new Error("Promotion journal authority kind is invalid");
  }
  assertExactKeys(
    authority,
    [
      "schemaVersion",
      "kind",
      "candidateSetId",
      "competitorId",
      "winnerRunId",
      "selectionDecisionDigest",
      "sealDigest",
      "sourceStateId",
      "sourceContentHash",
    ],
    "Candidate Set Promotion authority",
  );
  const authorityIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if (
    authority.schemaVersion !== 1 ||
    !authorityIdentifierPattern.test(authority.candidateSetId) ||
    !authorityIdentifierPattern.test(authority.competitorId) ||
    !safeIdentifierPattern.test(authority.winnerRunId) ||
    !/^[a-f0-9]{64}$/.test(authority.selectionDecisionDigest) ||
    !/^sha256:[a-f0-9]{64}$/.test(authority.sealDigest) ||
    !authorityIdentifierPattern.test(authority.sourceStateId) ||
    !/^sha256:[a-f0-9]{64}$/.test(authority.sourceContentHash) ||
    authority.winnerRunId !== record.runId ||
    authority.sourceStateId !== record.plan.sourceStateId ||
    authority.sourceContentHash !== record.plan.sourceContentHash ||
    authority.sourceStateId !== record.transaction.canonicalStateIdBefore ||
    authority.sourceContentHash !==
      record.transaction.canonicalContentHashBefore
  ) {
    throw new Error(
      "Candidate Set Promotion authority contradicts its journal",
    );
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(label + " contains unknown or missing fields");
  }
}

function validateResourceEvidence(record: PromotionJournalRecord): void {
  const sourceVersions = parseVersionVector(
    record.plan.sourceProviderVersions,
    "source provider versions",
  );
  const targetVersions = parseVersionVector(
    record.plan.targetProviderVersions,
    "target provider versions",
  );
  const resourcePlans = parsePromotionPlanVector(record.plan.resourcePlans);
  assertSameProviderSet(
    sourceVersions,
    targetVersions,
    "provider version vectors",
  );
  assertSameProviderSet(
    sourceVersions,
    resourcePlans,
    "Resource Promotion plans",
  );

  for (const [providerId, plan] of resourcePlans) {
    const source = sourceVersions.get(providerId);
    const target = targetVersions.get(providerId);
    if (
      !source ||
      !target ||
      source.resourceKind !== plan.resourceKind ||
      target.resourceKind !== plan.resourceKind ||
      source.versionId !== plan.sourceVersionId ||
      source.fingerprint !== plan.sourceFingerprint ||
      target.versionId !== plan.targetVersionId ||
      target.fingerprint !== plan.targetFingerprint
    ) {
      throw new Error(
        "Resource Promotion plan contradicts its version vectors",
      );
    }
  }

  if (!Array.isArray(record.transaction.providerResources)) {
    throw new Error("Promotion journal provider resources must be an array");
  }
  if (record.transaction.providerResources.length > maximumProviders) {
    throw new Error("Promotion journal exceeds 64 Resource Providers");
  }
  const evidenceByProvider = new Map<string, string>();
  for (const resource of record.transaction.providerResources) {
    if (
      resource.schemaVersion !== 1 ||
      resource.required !== true ||
      typeof resource.label !== "string" ||
      resource.label.length === 0 ||
      resource.label.length > 160 ||
      typeof resource.summary !== "string" ||
      resource.summary.length > 512
    ) {
      throw new Error("Promotion journal provider evidence is invalid");
    }
    const manifest = parseResourceProviderManifest({
      sdkSchemaVersion: 1,
      providerId: resource.providerId,
      resourceKind: resource.resourceKind,
      label: resource.label,
      capabilities: resource.capabilities,
      failureSemantics: AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
      metadata: {},
    });
    if (evidenceByProvider.has(manifest.providerId)) {
      throw new Error("Promotion journal has duplicate provider evidence");
    }
    parsePreparedResource(
      {
        schemaVersion: 1,
        candidate: resource.candidate,
        runtimeBinding: resource.runtimeBinding,
      },
      manifest,
    );
    const source = parseResourceVersionReference(resource.source, manifest);
    if (
      resource.change !== null &&
      parseResourceChangeEvidence(resource.change, manifest)
        .fingerprintBefore !== source.fingerprint
    ) {
      throw new Error(
        "Promotion journal Resource change contradicts its source",
      );
    }
    if (
      !Array.isArray(resource.validations) ||
      resource.validations.length > 64
    ) {
      throw new Error("Promotion journal Resource Validations are invalid");
    }
    for (const validation of resource.validations) {
      parseResourceValidationEvidence(validation, manifest);
    }
    const evidencePlan =
      resource.promotionPlan === null
        ? null
        : parseResourcePromotionPlan(resource.promotionPlan, manifest);
    const installed =
      resource.installedVersion === null
        ? null
        : parseResourceVersionReference(resource.installedVersion, manifest);
    if (resource.quarantine !== null) {
      parseResourceQuarantineHandle(resource.quarantine, manifest);
    }
    if (
      resource.disposition !== null &&
      !["promoted", "quarantined", "discarded", "cancelled"].includes(
        resource.disposition,
      )
    ) {
      throw new Error("Promotion journal provider disposition is invalid");
    }
    const plan = resourcePlans.get(manifest.providerId);
    const plannedSource = sourceVersions.get(manifest.providerId);
    const plannedTarget = targetVersions.get(manifest.providerId);
    if (
      !plan ||
      !evidencePlan ||
      !plannedSource ||
      !plannedTarget ||
      stableJson(plan) !== stableJson(evidencePlan) ||
      stableJson(source) !== stableJson(plannedSource) ||
      (installed !== null &&
        stableJson(installed) !== stableJson(plannedTarget))
    ) {
      throw new Error(
        "Promotion journal provider evidence contradicts its durable plan",
      );
    }
    evidenceByProvider.set(manifest.providerId, manifest.resourceKind);
  }
  assertSameProviderSet(
    sourceVersions,
    evidenceByProvider,
    "provider evidence",
  );

  if (
    !Array.isArray(record.transaction.providerResourceEvents) ||
    record.transaction.providerResourceEvents.length > maximumProviderEvents
  ) {
    throw new Error("Promotion journal Resource lifecycle events are invalid");
  }
  const lifecycleStages = new Set([
    "prepare",
    "runtime",
    "describe",
    "validate",
    "plan-promotion",
    "promote",
    "quarantine",
    "discard",
    "reconcile",
  ]);
  for (const event of record.transaction.providerResourceEvents) {
    if (
      event.schemaVersion !== 1 ||
      evidenceByProvider.get(event.providerId) !== event.resourceKind ||
      !lifecycleStages.has(event.stage) ||
      (event.status !== "passed" && event.status !== "failed") ||
      typeof event.summary !== "string" ||
      event.summary.length === 0 ||
      event.summary.length > 512 ||
      !Number.isFinite(Date.parse(event.at))
    ) {
      throw new Error("Promotion journal Resource lifecycle event is invalid");
    }
  }

  if (record.targetCanonical) {
    const canonicalVersions = parseVersionVector(
      record.targetCanonical.providerVersions,
      "target Canonical provider versions",
    );
    assertSameProviderSet(
      targetVersions,
      canonicalVersions,
      "target Canonical versions",
    );
    for (const [providerId, version] of targetVersions) {
      if (
        stableJson(version) !== stableJson(canonicalVersions.get(providerId))
      ) {
        throw new Error(
          "Target Canonical provider version contradicts its plan",
        );
      }
    }
  }
}

function parseVersionVector(
  values: readonly ResourceVersionReference[],
  label: string,
): Map<string, ResourceVersionReference> {
  if (!Array.isArray(values) || values.length > maximumProviders) {
    throw new Error("Promotion journal " + label + " are invalid");
  }
  const indexed = new Map<string, ResourceVersionReference>();
  for (const value of values) {
    const accepted = parseResourceVersionReference(value);
    if (indexed.has(accepted.providerId)) {
      throw new Error("Promotion journal has duplicate " + label);
    }
    indexed.set(accepted.providerId, accepted);
  }
  return indexed;
}

function parsePromotionPlanVector(
  values: readonly ResourcePromotionPlan[],
): Map<string, ResourcePromotionPlan> {
  if (!Array.isArray(values) || values.length > maximumProviders) {
    throw new Error("Promotion journal Resource Promotion plans are invalid");
  }
  const indexed = new Map<string, ResourcePromotionPlan>();
  for (const value of values) {
    const accepted = parseResourcePromotionPlan(value);
    if (indexed.has(accepted.providerId)) {
      throw new Error(
        "Promotion journal has duplicate Resource Promotion plan",
      );
    }
    indexed.set(accepted.providerId, accepted);
  }
  return indexed;
}

function assertSameProviderSet(
  expected: ReadonlyMap<string, unknown>,
  actual: ReadonlyMap<string, unknown>,
  label: string,
): void {
  const expectedIds = [...expected.keys()].sort();
  const actualIds = [...actual.keys()].sort();
  if (
    expectedIds.length !== actualIds.length ||
    expectedIds.some((providerId, index) => providerId !== actualIds[index])
  ) {
    throw new Error(
      "Promotion journal " + label + " provider set is inconsistent",
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function upgradeLegacyResourcePlan(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (!record.plan || typeof record.plan !== "object") return value;
  const plan = record.plan as Record<string, unknown>;
  const transaction =
    record.transaction && typeof record.transaction === "object"
      ? (record.transaction as Record<string, unknown>)
      : null;
  return {
    ...record,
    schemaVersion: record.schemaVersion === 1 ? 2 : record.schemaVersion,
    authority:
      record.schemaVersion === 1 && record.authority === undefined
        ? { schemaVersion: 1, kind: "ordinary-run" }
        : record.authority,
    targetCanonical:
      record.targetCanonical && typeof record.targetCanonical === "object"
        ? {
            ...(record.targetCanonical as Record<string, unknown>),
            providerVersions: Array.isArray(
              (record.targetCanonical as Record<string, unknown>)
                .providerVersions,
            )
              ? (record.targetCanonical as Record<string, unknown>)
                  .providerVersions
              : [],
          }
        : record.targetCanonical,
    transaction: transaction
      ? {
          ...transaction,
          providerResources: Array.isArray(transaction.providerResources)
            ? transaction.providerResources
            : [],
          providerResourceEvents: Array.isArray(
            transaction.providerResourceEvents,
          )
            ? transaction.providerResourceEvents
            : [],
        }
      : record.transaction,
    plan: {
      ...plan,
      sourceProviderVersions: Array.isArray(plan.sourceProviderVersions)
        ? plan.sourceProviderVersions
        : [],
      targetProviderVersions: Array.isArray(plan.targetProviderVersions)
        ? plan.targetProviderVersions
        : [],
      resourcePlans: Array.isArray(plan.resourcePlans)
        ? plan.resourcePlans
        : [],
    },
  };
}
