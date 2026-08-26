import type {
  JsonValue,
  ResourceCandidateHandle,
  ResourcePrepareContext,
  ResourceProviderManifest,
  ResourceQuarantineHandle,
  ResourceReconciliationResult,
  ResourceVersionReference,
  TransactionalResourceProvider,
} from "./types.js";
import {
  assessRequiredResourceEligibility,
  assertResourcePromotionPlanMatchesCandidate,
  parsePreparedResource,
  parseResourceChangeEvidence,
  parseResourceDiscardResult,
  parseResourcePromotionPlan,
  parseResourceQuarantineHandle,
  parseResourceReconciliationResult,
  parseResourceValidationEvidence,
  parseResourceVersionReference,
  redactSensitiveText,
  validateTransactionalResourceProvider,
} from "./validation.js";

export type ConformanceCaseStatus = "passed" | "failed";

export interface ConformanceCaseEvidence {
  id: string;
  status: ConformanceCaseStatus;
  durationMs: number;
  summary: string;
}

export interface ResourceConformanceReport {
  schemaVersion: 1;
  provider: ResourceProviderManifest;
  startedAt: string;
  completedAt: string;
  passed: boolean;
  cases: ConformanceCaseEvidence[];
  verification: {
    declared: string[];
    structurallyVerified: string[];
    behaviorallyVerified: string[];
    unverified: string[];
  };
}

export interface ResourceConformanceFixture {
  provider: TransactionalResourceProvider;
  context: ResourcePrepareContext;
  mutateCandidate(
    candidate: ResourceCandidateHandle,
    value: JsonValue,
  ): Promise<void>;
  readCandidate(candidate: ResourceCandidateHandle): Promise<JsonValue>;
  readVersion(reference: ResourceVersionReference): Promise<JsonValue>;
  candidateExists(candidate: ResourceCandidateHandle): Promise<boolean>;
  quarantineExists(quarantine: ResourceQuarantineHandle): Promise<boolean>;
  mutableStateExistsForRun(runId: string): Promise<boolean>;
  createRepairContext(
    quarantine: ResourceQuarantineHandle,
  ): Promise<ResourcePrepareContext>;
  restartProvider(): Promise<TransactionalResourceProvider>;
  dispose(): Promise<void>;
}

export type ResourceConformanceFixtureFactory =
  () => Promise<ResourceConformanceFixture>;

export async function runTransactionalResourceConformance(
  createFixture: ResourceConformanceFixtureFactory,
): Promise<ResourceConformanceReport> {
  const startedAt = new Date().toISOString();
  const first = await createFixture();
  let manifest: ResourceProviderManifest;
  try {
    manifest = validateTransactionalResourceProvider(first.provider);
  } finally {
    await first.dispose();
  }
  const cases: ConformanceCaseEvidence[] = [];
  await runCase(cases, "required-capabilities", async () => {
    const eligibility = assessRequiredResourceEligibility(manifest.capabilities);
    if (!eligibility.eligible) {
      throw new Error(eligibility.reasons.join("; "));
    }
  });
  await runCase(cases, "candidate-isolation", async () => {
    const fixture = await createFixture();
    try {
      const sourceBefore = await fixture.readVersion(fixture.context.source);
      const prepared = acceptPrepared(
        await fixture.provider.prepare(fixture.context),
        manifest,
        fixture.context,
      );
      await fixture.mutateCandidate(prepared.candidate, {
        conformance: "candidate-only",
      });
      const sourceAfter = await fixture.readVersion(fixture.context.source);
      assertJsonEqual(sourceAfter, sourceBefore, "Candidate mutation changed source version");
    } finally {
      await fixture.dispose();
    }
  });
  await runCase(cases, "bounded-evidence", async () => {
    const fixture = await createFixture();
    try {
      const prepared = acceptPrepared(
        await fixture.provider.prepare(fixture.context),
        manifest,
        fixture.context,
      );
      await fixture.mutateCandidate(prepared.candidate, { release: "candidate" });
      const change = parseResourceChangeEvidence(await fixture.provider.describe({
        ...fixture.context,
        candidate: prepared.candidate,
      }), manifest);
      if (change.fingerprintBefore !== prepared.candidate.sourceFingerprint) {
        throw new Error("Change evidence contradicted the prepared source");
      }
      const validations = await fixture.provider.validate({
        ...fixture.context,
        candidate: prepared.candidate,
      });
      const acceptedValidations = validations.map((validation) =>
        parseResourceValidationEvidence(validation, manifest),
      );
      if (Buffer.byteLength(JSON.stringify(change), "utf8") > 16_384) {
        throw new Error("Change evidence exceeds 16384 bytes");
      }
      if (acceptedValidations.length === 0 || acceptedValidations.length > 64) {
        throw new Error("Provider must return between 1 and 64 Validations");
      }
      if (acceptedValidations.some((validation) => validation.required && validation.status !== "passed")) {
        throw new Error("Conformance candidate did not pass required Validation");
      }
      if (Buffer.byteLength(JSON.stringify(acceptedValidations), "utf8") > 65_536) {
        throw new Error("Validation evidence exceeds 65536 bytes");
      }
    } finally {
      await fixture.dispose();
    }
  });
  await runCase(cases, "idempotent-promotion", async () => {
    const fixture = await createFixture();
    try {
      const prepared = acceptPrepared(
        await fixture.provider.prepare(fixture.context),
        manifest,
        fixture.context,
      );
      await fixture.mutateCandidate(prepared.candidate, { release: "accepted" });
      const candidateContext = {
        ...fixture.context,
        candidate: prepared.candidate,
      };
      const change = parseResourceChangeEvidence(
        await fixture.provider.describe(candidateContext),
        manifest,
      );
      const plan = parseResourcePromotionPlan(
        await fixture.provider.planPromotion(candidateContext),
        manifest,
      );
      assertPlan(plan, fixture.context, prepared.candidate, change.fingerprintCandidate);
      const firstVersion = parseResourceVersionReference(await fixture.provider.promote({
        ...candidateContext,
        plan,
      }), manifest);
      const secondVersion = parseResourceVersionReference(await fixture.provider.promote({
        ...candidateContext,
        plan,
      }), manifest);
      assertVersionMatchesPlan(firstVersion, plan);
      assertJsonEqual(secondVersion, firstVersion, "Promotion replay changed version reference");
      assertJsonEqual(
        await fixture.readVersion(firstVersion),
        { release: "accepted" },
        "Promoted version does not contain candidate value",
      );
    } finally {
      await fixture.dispose();
    }
  });
  await runCase(cases, "quarantine-and-discard", async () => {
    const fixture = await createFixture();
    try {
      const prepared = acceptPrepared(
        await fixture.provider.prepare(fixture.context),
        manifest,
        fixture.context,
      );
      await fixture.mutateCandidate(prepared.candidate, { rejected: true });
      const candidateContext = {
        ...fixture.context,
        candidate: prepared.candidate,
      };
      const change = parseResourceChangeEvidence(
        await fixture.provider.describe(candidateContext),
        manifest,
      );
      const quarantine = parseResourceQuarantineHandle(await fixture.provider.quarantine({
        ...candidateContext,
        failureStage: "validate",
      }), manifest);
      if (
        quarantine.runId !== fixture.context.runId ||
        quarantine.candidateFingerprint !== change.fingerprintCandidate
      ) {
        throw new Error("Quarantine contradicted its Candidate");
      }
      if (!(await fixture.quarantineExists(quarantine))) {
        throw new Error("Quarantine was not retained");
      }
      const firstDiscard = parseResourceDiscardResult(await fixture.provider.discard({
        ...fixture.context,
        candidate: null,
        quarantine,
      }), manifest);
      const secondDiscard = parseResourceDiscardResult(await fixture.provider.discard({
        ...fixture.context,
        candidate: null,
        quarantine,
      }), manifest);
      if (!firstDiscard.discarded || firstDiscard.alreadyDiscarded) {
        throw new Error("First Discard did not remove Quarantine exactly once");
      }
      if (!secondDiscard.discarded || !secondDiscard.alreadyDiscarded) {
        throw new Error("Repeated Discard was not idempotent");
      }
      if (!firstDiscard.evidenceRetained || !secondDiscard.evidenceRetained) {
        throw new Error("Discard did not retain decision evidence");
      }
      if (await fixture.quarantineExists(quarantine)) {
        throw new Error("Discard left mutable Quarantine available");
      }
    } finally {
      await fixture.dispose();
    }
  });
  await runCase(cases, "prepare-replay-and-run-cleanup", async () => {
    const fixture = await createFixture();
    try {
      const first = acceptPrepared(
        await fixture.provider.prepare(fixture.context),
        manifest,
        fixture.context,
      );
      const replay = acceptPrepared(
        await fixture.provider.prepare(fixture.context),
        manifest,
        fixture.context,
      );
      assertJsonEqual(replay.candidate, first.candidate, "Prepare replay changed Candidate identity");
      const discarded = parseResourceDiscardResult(
        await fixture.provider.discard({
          ...fixture.context,
          candidate: null,
          quarantine: null,
        }),
        manifest,
      );
      if (!discarded.discarded || !discarded.evidenceRetained) {
        throw new Error("Run-scoped cleanup did not retain Discard evidence");
      }
      if (await fixture.mutableStateExistsForRun(fixture.context.runId)) {
        throw new Error("Run-scoped cleanup left mutable provider state");
      }
    } finally {
      await fixture.dispose();
    }
  });
  await runCase(cases, "repair-fork", async () => {
    const fixture = await createFixture();
    try {
      const sourceBefore = await fixture.readVersion(fixture.context.source);
      const prepared = acceptPrepared(
        await fixture.provider.prepare(fixture.context),
        manifest,
        fixture.context,
      );
      const rejectedValue = { repair: "retained" } satisfies JsonValue;
      await fixture.mutateCandidate(prepared.candidate, rejectedValue);
      const candidateContext = { ...fixture.context, candidate: prepared.candidate };
      const change = parseResourceChangeEvidence(
        await fixture.provider.describe(candidateContext),
        manifest,
      );
      const quarantine = parseResourceQuarantineHandle(
        await fixture.provider.quarantine({
          ...candidateContext,
          failureStage: "validate",
        }),
        manifest,
      );
      if (quarantine.candidateFingerprint !== change.fingerprintCandidate) {
        throw new Error("Repair source Quarantine contradicted its Candidate");
      }
      const repairContext = await fixture.createRepairContext(quarantine);
      const repair = acceptPrepared(
        await fixture.provider.prepare(repairContext),
        manifest,
        repairContext,
      );
      assertJsonEqual(
        await fixture.readCandidate(repair.candidate),
        rejectedValue,
        "Repair Candidate did not fork retained Quarantine content",
      );
      assertJsonEqual(
        await fixture.readVersion(fixture.context.source),
        sourceBefore,
        "Repair fork changed Canonical resource version",
      );
    } finally {
      await fixture.dispose();
    }
  });
  await runCase(cases, "restart-reconciliation", async () => {
    const fixture = await createFixture();
    try {
      const prepared = acceptPrepared(
        await fixture.provider.prepare(fixture.context),
        manifest,
        fixture.context,
      );
      await fixture.mutateCandidate(prepared.candidate, { recovery: "installed" });
      const candidateContext = {
        ...fixture.context,
        candidate: prepared.candidate,
      };
      const change = parseResourceChangeEvidence(
        await fixture.provider.describe(candidateContext),
        manifest,
      );
      const plan = parseResourcePromotionPlan(
        await fixture.provider.planPromotion(candidateContext),
        manifest,
      );
      assertPlan(plan, fixture.context, prepared.candidate, change.fingerprintCandidate);
      const installed = parseResourceVersionReference(await fixture.provider.promote({
        ...candidateContext,
        plan,
      }), manifest);
      const restarted = await fixture.restartProvider();
      const reconciliation = parseResourceReconciliationResult(await restarted.reconcile({
        schemaVersion: 1,
        agentId: fixture.context.agentId,
        runId: fixture.context.runId,
        plan,
        expectedVersion: installed,
      }), manifest);
      assertReconciledVersion(reconciliation, installed);
    } finally {
      await fixture.dispose();
    }
  });
  return {
    schemaVersion: 1,
    provider: manifest,
    startedAt,
    completedAt: new Date().toISOString(),
    passed: cases.every((item) => item.status === "passed"),
    cases,
    verification: {
      declared: Object.entries(manifest.capabilities).map(
        ([name, value]) => name + "=" + String(value),
      ),
      structurallyVerified: [
        "manifest",
        "prepared-resource",
        "change-evidence",
        "validation-evidence",
        "promotion-plan",
        "version-reference",
        "quarantine-handle",
        "discard-result",
        "reconciliation-result",
      ],
      behaviorallyVerified: cases
        .filter((item) => item.status === "passed")
        .map((item) => item.id),
      unverified: ["distributed-atomic-commit", "provider-native-mutable-pointer"],
    },
  };
}

export function assertTransactionalResourceConformance(
  report: ResourceConformanceReport,
): void {
  const failures = report.cases.filter((item) => item.status === "failed");
  if (failures.length === 0) return;
  throw new Error(
    "Transactional Resource conformance failed:\n" +
      failures.map((item) => "- " + item.id + ": " + item.summary).join("\n"),
  );
}

async function runCase(
  cases: ConformanceCaseEvidence[],
  id: string,
  operation: () => Promise<void>,
): Promise<void> {
  const started = performance.now();
  try {
    await operation();
    cases.push({
      id,
      status: "passed",
      durationMs: Math.round(performance.now() - started),
      summary: "Provider satisfied " + id.replaceAll("-", " "),
    });
  } catch (error) {
    cases.push({
      id,
      status: "failed",
      durationMs: Math.round(performance.now() - started),
      summary: boundSummary(
        redactSensitiveText(error instanceof Error ? error.message : String(error)),
      ),
    });
  }
}

function acceptPrepared(
  raw: unknown,
  manifest: ResourceProviderManifest,
  context: ResourcePrepareContext,
) {
  const prepared = parsePreparedResource(raw, manifest);
  if (
    prepared.candidate.sourceVersionId !== context.source.versionId ||
    prepared.candidate.sourceFingerprint !== context.source.fingerprint
  ) {
    throw new Error("Prepared Candidate contradicted its source");
  }
  return prepared;
}

function assertPlan(
  plan: ReturnType<typeof parseResourcePromotionPlan>,
  context: ResourcePrepareContext,
  candidate: ResourceCandidateHandle,
  candidateFingerprint: string,
): void {
  assertResourcePromotionPlanMatchesCandidate({
    plan,
    candidate,
    runId: context.runId,
    candidateFingerprint,
  });
}

function assertVersionMatchesPlan(
  version: ResourceVersionReference,
  plan: ReturnType<typeof parseResourcePromotionPlan>,
): void {
  if (
    version.versionId !== plan.targetVersionId ||
    version.fingerprint !== plan.targetFingerprint
  ) {
    throw new Error("Installed version contradicted Promotion plan");
  }
}

function assertReconciledVersion(
  result: ResourceReconciliationResult,
  installed: ResourceVersionReference,
): void {
  if (result.status !== "installed" && result.status !== "canonical") {
    throw new Error("Reconciliation did not find the installed version");
  }
  assertJsonEqual(result.version, installed, "Reconciliation changed version reference");
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  if (stableJson(actual) !== stableJson(expected)) throw new Error(message);
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

function boundSummary(summary: string): string {
  return summary.length <= 512 ? summary : summary.slice(0, 509) + "...";
}
