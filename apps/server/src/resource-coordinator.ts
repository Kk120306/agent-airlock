import { lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertResourcePromotionPlanMatchesCandidate,
  parsePreparedResource,
  createResourcePromotionIdempotencyKey,
  parseResourceChangeEvidence,
  parseResourceDiscardResult,
  parseResourcePromotionPlan,
  parseResourceQuarantineHandle,
  parseResourceReconciliationResult,
  parseResourceValidationEvidence,
  parseResourceVersionReference,
  ResourceLifecycleError,
  type PreparedResource,
  type ResourceCapabilityClaim,
  type ResourceCandidateHandle,
  type ResourceChangeEvidence,
  type ResourceDiscardResult,
  type ResourceLifecycleStage,
  type ResourcePromotionPlan,
  type ResourceProviderManifest,
  type ResourceQuarantineHandle,
  type ResourceReconciliationResult,
  type ResourceRuntimeBinding,
  type ResourceValidationEvidence,
  type ResourceVersionReference,
} from "@agent-airlock/transactional-resource-sdk";
import {
  ResourceRegistry,
  type RegisteredResourceProvider,
} from "./resource-registry.js";
import type {
  ProviderRegistryDescriptor,
  ProviderRegistryVerification,
} from "./workspace.js";

const maximumLifecycleEvents = 256;
const maximumValidationCount = 64;
const maximumValidationBytes = 65_536;

export interface ResourceLifecycleEvent {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  stage: ResourceLifecycleStage;
  status: "passed" | "failed";
  summary: string;
  at: string;
}

export type ResourceEventRecorder = (
  event: ResourceLifecycleEvent,
) => void | Promise<void>;

export interface CoordinatedRuntimeBinding extends ResourceRuntimeBinding {
  hostPath: string;
  runtimePath: string;
}

export interface CoordinatedPreparedResource {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  label: string;
  required: boolean;
  capabilities: ResourceCapabilityClaim;
  source: ResourceVersionReference;
  candidate: ResourceCandidateHandle;
  runtimeBinding: CoordinatedRuntimeBinding | null;
}

export interface RestorablePreparedResource {
  providerId: string;
  resourceKind: string;
  source: ResourceVersionReference;
  candidate: ResourceCandidateHandle;
  runtimeBinding: ResourceRuntimeBinding | null;
}

export interface CoordinatedResourceEvidence {
  schemaVersion: 1;
  providerId: string;
  resourceKind: string;
  label: string;
  required: boolean;
  capabilities: ResourceCapabilityClaim;
  source: ResourceVersionReference;
  candidate: ResourceCandidateHandle;
  change: ResourceChangeEvidence;
  validations: ResourceValidationEvidence[];
  promotionPlan: ResourcePromotionPlan | null;
  installedVersion: ResourceVersionReference | null;
  quarantine: ResourceQuarantineHandle | null;
}

export interface PrepareResourceSetInput {
  agentId: string;
  runId: string;
  candidateStateId: string;
  candidateResourcesRoot: string;
  sourceVersions: readonly ResourceVersionReference[];
  repairQuarantines?: readonly ResourceQuarantineHandle[];
  repairSourceRunId?: string | null;
  onEvent?: ResourceEventRecorder;
  onPrepared?: (
    resources: readonly CoordinatedPreparedResource[],
  ) => void | Promise<void>;
}

export interface CandidateResourceSetInput {
  agentId: string;
  runId: string;
  candidateStateId: string;
  candidateResourcesRoot: string;
  prepared: readonly CoordinatedPreparedResource[];
  providerIds?: readonly string[];
  onEvent?: ResourceEventRecorder;
}

export interface PlannedResourceSetInput extends CandidateResourceSetInput {
  plans: readonly ResourcePromotionPlan[];
}

export interface ValidatedResourceSetInput extends CandidateResourceSetInput {
  evidence: readonly CoordinatedResourceEvidence[];
}

export interface QuarantineResourceSetInput extends CandidateResourceSetInput {
  evidence?: readonly CoordinatedResourceEvidence[];
  failureStage: ResourceLifecycleStage;
  onQuarantine?: (
    quarantines: readonly ResourceQuarantineHandle[],
  ) => void | Promise<void>;
}

export interface ReconcileResourceSetInput {
  agentId: string;
  runId: string;
  plans: readonly ResourcePromotionPlan[];
  expectedVersions: readonly ResourceVersionReference[];
  visibility: "canonical-manifest" | "post-promotion-reconciled";
  providerIds?: readonly string[];
  onEvent?: ResourceEventRecorder;
}

export interface DiscardResourceSetInput {
  agentId: string;
  runId: string;
  candidateStateId: string;
  candidateResourcesRoot: string;
  prepared: readonly CoordinatedPreparedResource[];
  quarantines: readonly ResourceQuarantineHandle[];
  allowPartialPrepared?: boolean;
  providerIds?: readonly string[];
  onEvent?: ResourceEventRecorder;
  onDiscard?: (
    results: readonly ResourceDiscardResult[],
  ) => void | Promise<void>;
}

export class ResourcePreparationError extends Error {
  readonly prepared: CoordinatedPreparedResource[];
  readonly cleanupCompleted: boolean;

  constructor(options: {
    cause: unknown;
    prepared: readonly CoordinatedPreparedResource[];
    cleanupCompleted: boolean;
  }) {
    const causeMessage =
      options.cause instanceof ResourceLifecycleError
        ? options.cause.safeSummary
        : "Resource Provider preparation failed";
    super(
      options.cleanupCompleted
        ? causeMessage + "; prepared provider state was discarded before Runtime"
        : causeMessage + "; provider cleanup failed and Candidate State was retained",
      { cause: options.cause },
    );
    this.name = "ResourcePreparationError";
    this.prepared = structuredClone([...options.prepared]);
    this.cleanupCompleted = options.cleanupCompleted;
  }
}

export class ResourceQuarantineError extends Error {
  readonly quarantines: ResourceQuarantineHandle[];

  constructor(cause: unknown, quarantines: readonly ResourceQuarantineHandle[]) {
    super("One or more Resource Providers failed to retain Quarantine", { cause });
    this.name = "ResourceQuarantineError";
    this.quarantines = structuredClone([...quarantines]);
  }
}

export class ResourceDiscardError extends Error {
  readonly results: ResourceDiscardResult[];

  constructor(cause: unknown, results: readonly ResourceDiscardResult[]) {
    super("One or more Resource Providers failed evidence-preserving Discard", {
      cause,
    });
    this.name = "ResourceDiscardError";
    this.results = structuredClone([...results]);
  }
}

export class ResourceRuntimeBoundaryError extends Error {
  constructor(cause: unknown) {
    super("Resource Runtime binding failed post-execution confinement checks", {
      cause,
    });
    this.name = "ResourceRuntimeBoundaryError";
  }
}

export class ResourceCoordinator {
  constructor(private readonly registry: ResourceRegistry) {}

  manifests(): ResourceProviderManifest[] {
    return this.registry.manifests();
  }

  initialVersions(): ResourceVersionReference[] {
    return this.registry.initialVersions();
  }

  registryDescriptors(): ProviderRegistryDescriptor[] {
    return this.registry.list().map((entry) => ({
      providerId: entry.manifest.providerId,
      resourceKind: entry.manifest.resourceKind,
      manifestFingerprint: createHash("sha256")
        .update(stableJson(entry.manifest))
        .digest("hex"),
    }));
  }

  async verifyProviderOnboarding(
    agentId: string,
    versions: readonly ResourceVersionReference[],
  ): Promise<ProviderRegistryVerification[]> {
    const acceptedVersions = indexedVersions(versions, "onboarding");
    const results: ProviderRegistryVerification[] = [];
    for (const version of acceptedVersions.values()) {
      const entry = this.registry.get(version.providerId);
      const acceptedVersion = parseResourceVersionReference(
        version,
        entry.manifest,
      );
      const runId =
        "registry-" +
        createHash("sha256")
          .update(
            stableJson({
              agentId,
              providerId: acceptedVersion.providerId,
              resourceKind: acceptedVersion.resourceKind,
              versionId: acceptedVersion.versionId,
              fingerprint: acceptedVersion.fingerprint,
            }),
          )
          .digest("hex");
      const plan: ResourcePromotionPlan = {
        schemaVersion: 1,
        providerId: acceptedVersion.providerId,
        resourceKind: acceptedVersion.resourceKind,
        runId,
        idempotencyKey: this.idempotencyKey(runId, entry.manifest),
        sourceVersionId: acceptedVersion.versionId,
        sourceFingerprint: acceptedVersion.fingerprint,
        targetVersionId: acceptedVersion.versionId,
        targetFingerprint: acceptedVersion.fingerprint,
        metadata: {},
      };
      const reconciliation = await this.invoke(
        entry,
        "reconcile",
        undefined,
        () =>
          entry.provider.reconcile({
            schemaVersion: 1,
            agentId,
            runId,
            plan,
            expectedVersion: acceptedVersion,
          }),
        (raw) => parseResourceReconciliationResult(raw, entry.manifest),
      );
      if (
        (reconciliation.status !== "installed" &&
          reconciliation.status !== "canonical") ||
        !sameVersion(reconciliation.version, acceptedVersion)
      ) {
        throw this.contractError(
          entry,
          "reconcile",
          "Configured onboarding source was not independently verified",
          "source-mismatch",
        );
      }
      results.push({
        providerId: acceptedVersion.providerId,
        resourceKind: acceptedVersion.resourceKind,
        versionId: acceptedVersion.versionId,
        fingerprint: acceptedVersion.fingerprint,
        summary: reconciliation.summary,
      });
    }
    return results;
  }

  async restorePrepared(
    candidateResourcesRoot: string,
    values: readonly RestorablePreparedResource[],
    options: {
      allowPartial?: boolean;
      providerIds?: readonly string[];
    } = {},
  ): Promise<CoordinatedPreparedResource[]> {
    const indexed = new Map<string, RestorablePreparedResource>();
    for (const value of values) {
      if (indexed.has(value.providerId)) {
        throw new Error("Duplicate persisted Resource Provider " + value.providerId);
      }
      indexed.set(value.providerId, value);
    }
    const entries = this.entriesForScope(options.providerIds);
    if (!options.allowPartial) {
      this.assertProviders(indexed, entries, "Persisted resource");
    }
    const restored: CoordinatedPreparedResource[] = [];
    for (const entry of entries) {
      const value = indexed.get(entry.manifest.providerId);
      if (!value && options.allowPartial) continue;
      if (!value || value.resourceKind !== entry.manifest.resourceKind) {
        throw new Error("Persisted Resource identity does not match the registry");
      }
      const source = parseResourceVersionReference(value.source, entry.manifest);
      const prepared = parsePreparedResource(
        {
          schemaVersion: 1,
          candidate: value.candidate,
          runtimeBinding: value.runtimeBinding,
        },
        entry.manifest,
      );
      this.assertCandidateSource(prepared, source);
      const candidateResourcePath = this.providerCandidatePath(
        candidateResourcesRoot,
        entry.manifest.providerId,
      );
      restored.push({
        schemaVersion: 1,
        providerId: entry.manifest.providerId,
        resourceKind: entry.manifest.resourceKind,
        label: entry.manifest.label,
        required: entry.required,
        capabilities: structuredClone(entry.manifest.capabilities),
        source,
        candidate: prepared.candidate,
        runtimeBinding: await this.resolveRuntimeBinding(
          candidateResourcePath,
          entry.manifest,
          prepared,
        ),
      });
    }
    return restored;
  }

  async prepareAll(
    input: PrepareResourceSetInput,
  ): Promise<CoordinatedPreparedResource[]> {
    const sources = indexedVersions(input.sourceVersions, "source");
    const repairQuarantines = indexedQuarantines(
      input.repairQuarantines ?? [],
      null,
    );
    if (input.repairSourceRunId) {
      this.assertExactProviders(repairQuarantines, "Repair Quarantine");
      if (
        [...repairQuarantines.values()].some(
          (quarantine) => quarantine.runId !== input.repairSourceRunId,
        )
      ) {
        throw new Error("Repair Resource Quarantine belongs to a different source Run");
      }
    } else if (repairQuarantines.size > 0) {
      throw new Error("Ordinary Run cannot consume a Resource Quarantine");
    }
    this.assertExactProviders(sources, "source version");
    await mkdir(input.candidateResourcesRoot, { recursive: true });
    const prepared: CoordinatedPreparedResource[] = [];
    try {
      for (const entry of this.registry.list()) {
        const source = sources.get(entry.manifest.providerId);
        if (!source) throw new Error("Missing source version for " + entry.manifest.providerId);
        const candidateResourcePath = this.providerCandidatePath(
          input.candidateResourcesRoot,
          entry.manifest.providerId,
        );
        await mkdir(candidateResourcePath, { recursive: false });
        const result = await this.invoke(
          entry,
          "prepare",
          input.onEvent,
          () =>
            entry.provider.prepare({
              schemaVersion: 1,
              agentId: input.agentId,
              runId: input.runId,
              candidateStateId: input.candidateStateId,
              candidateResourcePath,
              source,
              repairSource: repairQuarantines.get(entry.manifest.providerId) ?? null,
            }),
          (raw) => {
            const accepted = parsePreparedResource(raw, entry.manifest);
            this.assertCandidateSource(accepted, source);
            return accepted;
          },
        );
        const coordinated: CoordinatedPreparedResource = {
          schemaVersion: 1,
          providerId: entry.manifest.providerId,
          resourceKind: entry.manifest.resourceKind,
          label: entry.manifest.label,
          required: entry.required,
          capabilities: structuredClone(entry.manifest.capabilities),
          source,
          candidate: result.candidate,
          runtimeBinding: null,
        };
        prepared.push(coordinated);
        await input.onPrepared?.(prepared);
        coordinated.runtimeBinding = await this.resolveRuntimeBinding(
          candidateResourcePath,
          entry.manifest,
          result,
        );
        await input.onPrepared?.(prepared);
      }
      return prepared;
    } catch (error) {
      const cleanupCompleted = await this.discardPreparedAfterPrepareFailure(
        input,
        prepared,
      );
      throw new ResourcePreparationError({
        cause: error,
        prepared,
        cleanupCompleted,
      });
    }
  }

  async describeAndValidate(
    input: CandidateResourceSetInput,
  ): Promise<CoordinatedResourceEvidence[]> {
    const entries = this.entriesForScope(input.providerIds);
    const prepared = this.indexPrepared(input.prepared, false, entries);
    const evidence: CoordinatedResourceEvidence[] = [];
    for (const entry of entries) {
      const resource = this.requirePrepared(prepared, entry);
      const context = this.candidateContext(input, resource);
      const change = await this.invoke(
        entry,
        "describe",
        input.onEvent,
        () => entry.provider.describe(context),
        (raw) => {
          const accepted = parseResourceChangeEvidence(raw, entry.manifest);
          if (accepted.fingerprintBefore !== resource.source.fingerprint) {
            throw this.contractError(
              entry,
              "describe",
              "Resource change evidence contradicts the source version",
            );
          }
          return accepted;
        },
      );
      const validations = await this.invoke(
        entry,
        "validate",
        input.onEvent,
        () => entry.provider.validate(context),
        (raw) => {
          if (!Array.isArray(raw)) {
            throw this.contractError(
              entry,
              "validate",
              "Resource Provider returned non-array Validation evidence",
            );
          }
          const accepted = raw.map((validation) =>
            parseResourceValidationEvidence(validation, entry.manifest),
          );
          if (accepted.length === 0 || accepted.length > maximumValidationCount) {
            throw this.contractError(
              entry,
              "validate",
              "Resource Provider must return between 1 and 64 Validations",
            );
          }
          if (Buffer.byteLength(JSON.stringify(accepted), "utf8") > maximumValidationBytes) {
            throw this.contractError(
              entry,
              "validate",
              "Resource Provider Validation evidence exceeds 65536 bytes",
            );
          }
          return accepted;
        },
      );
      evidence.push({
        schemaVersion: 1,
        providerId: resource.providerId,
        resourceKind: resource.resourceKind,
        label: resource.label,
        required: resource.required,
        capabilities: structuredClone(resource.capabilities),
        source: structuredClone(resource.source),
        candidate: structuredClone(resource.candidate),
        change,
        validations,
        promotionPlan: null,
        installedVersion: null,
        quarantine: null,
      });
    }
    return evidence;
  }

  async assertRuntimeBindingsSafe(
    preparedResources: readonly CoordinatedPreparedResource[],
    providerIds?: readonly string[],
  ): Promise<void> {
    try {
      const entries = this.entriesForScope(providerIds);
      const prepared = this.indexPrepared(preparedResources, false, entries);
      for (const entry of entries) {
        const resource = this.requirePrepared(prepared, entry);
        if (!resource.runtimeBinding) continue;
        const relativeParts = resource.runtimeBinding.relativePath.split("/");
        let candidateRoot = resource.runtimeBinding.hostPath;
        for (let index = 0; index < relativeParts.length; index += 1) {
          candidateRoot = path.dirname(candidateRoot);
        }
        await this.assertTreeHasNoSymlinks(candidateRoot, entry);
        const refreshed = await this.resolveRuntimeBinding(candidateRoot, entry.manifest, {
          schemaVersion: 1,
          candidate: resource.candidate,
          runtimeBinding: {
            schemaVersion: 1,
            relativePath: resource.runtimeBinding.relativePath,
            access: resource.runtimeBinding.access,
          },
        });
        if (
          !refreshed ||
          refreshed.hostPath !== resource.runtimeBinding.hostPath ||
          refreshed.runtimePath !== resource.runtimeBinding.runtimePath
        ) {
          throw this.contractError(
            entry,
            "describe",
            "Resource Runtime binding changed after Runtime execution",
          );
        }
      }
    } catch (error) {
      throw new ResourceRuntimeBoundaryError(error);
    }
  }

  async planAll(input: ValidatedResourceSetInput): Promise<ResourcePromotionPlan[]> {
    const entries = this.entriesForScope(input.providerIds);
    const prepared = this.indexPrepared(input.prepared, false, entries);
    const evidence = this.indexEvidence(input.evidence, entries);
    const plans: ResourcePromotionPlan[] = [];
    for (const entry of entries) {
      const resource = this.requirePrepared(prepared, entry);
      const acceptedEvidence = evidence.get(entry.manifest.providerId);
      if (!acceptedEvidence) {
        throw new Error("Missing validated Resource evidence for " + entry.manifest.providerId);
      }
      const plan = await this.invoke(
        entry,
        "plan-promotion",
        input.onEvent,
        () => entry.provider.planPromotion(this.candidateContext(input, resource)),
        (raw) => {
          const accepted = parseResourcePromotionPlan(raw, entry.manifest);
          assertResourcePromotionPlanMatchesCandidate({
            plan: accepted,
            candidate: resource.candidate,
            runId: input.runId,
            candidateFingerprint: acceptedEvidence.change.fingerprintCandidate,
          });
          return accepted;
        },
      );
      plans.push(plan);
    }
    return plans;
  }

  async promoteBeforeCanonical(
    input: PlannedResourceSetInput,
  ): Promise<ResourceVersionReference[]> {
    return this.promoteVisible(input, "canonical-manifest");
  }

  async promoteAfterCanonical(
    input: PlannedResourceSetInput,
  ): Promise<ResourceVersionReference[]> {
    return this.promoteVisible(input, "post-promotion-reconciled");
  }

  async reconcile(input: ReconcileResourceSetInput): Promise<ResourceReconciliationResult[]> {
    const entries = this.entriesForScope(input.providerIds);
    const visibleEntries = entries.filter(
      (entry) =>
        entry.manifest.capabilities.promotionVisibility === input.visibility,
    );
    const plans = indexedPlans(input.plans);
    const expected = indexedVersions(input.expectedVersions, "expected");
    this.assertProviders(plans, entries, "Promotion plan");
    const expectedProviderIds = [...expected.keys()].sort();
    const scopedProviderIds = entries
      .map((entry) => entry.manifest.providerId)
      .sort();
    const expectedContainsFullScope =
      expectedProviderIds.length === scopedProviderIds.length &&
      expectedProviderIds.every(
        (providerId, index) => providerId === scopedProviderIds[index],
      );
    if (!expectedContainsFullScope) {
      this.assertProviders(expected, visibleEntries, "Expected version");
    }
    const visibleProviderIds = new Set(
      visibleEntries.map((entry) => entry.manifest.providerId),
    );
    const visibleExpected = new Map(
      [...expected].filter(([providerId]) => visibleProviderIds.has(providerId)),
    );
    this.assertProviders(visibleExpected, visibleEntries, "Expected version");
    const results: ResourceReconciliationResult[] = [];
    for (const entry of visibleEntries) {
      const plan = plans.get(entry.manifest.providerId);
      if (!plan) throw new Error("Missing Promotion plan for " + entry.manifest.providerId);
      const result = await this.invoke(
        entry,
        "reconcile",
        input.onEvent,
        () =>
          entry.provider.reconcile({
            schemaVersion: 1,
            agentId: input.agentId,
            runId: input.runId,
            plan,
            expectedVersion: visibleExpected.get(entry.manifest.providerId) ?? null,
          }),
        (raw) => {
          const accepted = parseResourceReconciliationResult(raw, entry.manifest);
          const expectedVersion = visibleExpected.get(entry.manifest.providerId);
          if (accepted.status === "contradiction") {
            throw this.contractError(
              entry,
              "reconcile",
              accepted.summary,
              "recovery-contradiction",
            );
          }
          if (expectedVersion && !sameVersion(accepted.version, expectedVersion)) {
            throw this.contractError(
              entry,
              "reconcile",
              "Resource reconciliation result contradicts the expected immutable version",
              "recovery-contradiction",
            );
          }
          return accepted;
        },
      );
      results.push(result);
    }
    return results;
  }

  async quarantineAll(
    input: QuarantineResourceSetInput,
  ): Promise<ResourceQuarantineHandle[]> {
    const entries = this.entriesForScope(input.providerIds);
    const prepared = this.indexPrepared(input.prepared, false, entries);
    const evidence = input.evidence
      ? this.indexEvidence(input.evidence, entries)
      : null;
    const quarantines: ResourceQuarantineHandle[] = [];
    let firstFailure: unknown = null;
    for (const entry of entries) {
      const resource = this.requirePrepared(prepared, entry);
      const acceptedEvidence = evidence?.get(entry.manifest.providerId) ?? null;
      try {
        const quarantine = await this.invoke(
          entry,
          "quarantine",
          input.onEvent,
          () =>
            entry.provider.quarantine({
              ...this.candidateContext(input, resource),
              failureStage: input.failureStage,
            }),
          (raw) => {
            const accepted = parseResourceQuarantineHandle(raw, entry.manifest);
            if (
              accepted.runId !== input.runId ||
              (acceptedEvidence &&
                accepted.candidateFingerprint !==
                  acceptedEvidence.change.fingerprintCandidate)
            ) {
              throw this.contractError(
                entry,
                "quarantine",
                "Resource Quarantine contradicts the prepared Candidate",
              );
            }
            return accepted;
          },
        );
        quarantines.push(quarantine);
        await input.onQuarantine?.(quarantines);
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure) throw new ResourceQuarantineError(firstFailure, quarantines);
    return quarantines;
  }

  async discardAll(input: DiscardResourceSetInput): Promise<ResourceDiscardResult[]> {
    const entries = this.entriesForScope(input.providerIds);
    const prepared = this.indexPrepared(
      input.prepared,
      input.allowPartialPrepared ?? false,
      entries,
    );
    const quarantines = indexedQuarantines(input.quarantines, input.runId);
    const results: ResourceDiscardResult[] = [];
    let firstFailure: unknown = null;
    for (const entry of entries) {
      const resource = prepared.get(entry.manifest.providerId) ?? null;
      try {
        const result = await this.invoke(
          entry,
          "discard",
          input.onEvent,
          () =>
            entry.provider.discard({
              schemaVersion: 1,
              agentId: input.agentId,
              runId: input.runId,
              candidateStateId: input.candidateStateId,
              candidateResourcePath: this.providerCandidatePath(
                input.candidateResourcesRoot,
                entry.manifest.providerId,
              ),
              candidate: resource?.candidate ?? null,
              quarantine: quarantines.get(entry.manifest.providerId) ?? null,
            }),
          (raw) => {
            const accepted = parseResourceDiscardResult(raw, entry.manifest);
            if (!accepted.discarded || !accepted.evidenceRetained) {
              throw this.contractError(
                entry,
                "discard",
                "Resource Provider did not complete evidence-preserving Discard",
              );
            }
            return accepted;
          },
        );
        results.push(result);
        await input.onDiscard?.(results);
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure) throw new ResourceDiscardError(firstFailure, results);
    return results;
  }

  private async promoteVisible(
    input: PlannedResourceSetInput,
    visibility: "canonical-manifest" | "post-promotion-reconciled",
  ): Promise<ResourceVersionReference[]> {
    const entries = this.entriesForScope(input.providerIds);
    const prepared = this.indexPrepared(input.prepared, false, entries);
    const plans = indexedPlans(input.plans);
    this.assertProviders(plans, entries, "Promotion plan");
    const installed: ResourceVersionReference[] = [];
    for (const entry of entries) {
      if (entry.manifest.capabilities.promotionVisibility !== visibility) continue;
      const resource = this.requirePrepared(prepared, entry);
      const plan = plans.get(entry.manifest.providerId);
      if (!plan) throw new Error("Missing Promotion plan for " + entry.manifest.providerId);
      const version = await this.invoke(
        entry,
        "promote",
        input.onEvent,
        () =>
          entry.provider.promote({
            ...this.candidateContext(input, resource),
            plan,
          }),
        (raw) => {
          const accepted = parseResourceVersionReference(raw, entry.manifest);
          if (!sameVersion(accepted, versionFromPlan(plan))) {
            throw this.contractError(
              entry,
              "promote",
              "Installed Resource version contradicts its durable Promotion plan",
              "recovery-contradiction",
            );
          }
          return accepted;
        },
      );
      installed.push(version);
    }
    return installed;
  }

  private candidateContext(
    input: CandidateResourceSetInput,
    resource: CoordinatedPreparedResource,
  ) {
    return {
      schemaVersion: 1 as const,
      agentId: input.agentId,
      runId: input.runId,
      candidateStateId: input.candidateStateId,
      candidateResourcePath: this.providerCandidatePath(
        input.candidateResourcesRoot,
        resource.providerId,
      ),
      candidate: resource.candidate,
    };
  }

  private async resolveRuntimeBinding(
    providerRoot: string,
    manifest: ResourceProviderManifest,
    prepared: PreparedResource,
  ): Promise<CoordinatedRuntimeBinding | null> {
    if (!prepared.runtimeBinding) return null;
    await this.assertTreeHasNoSymlinks(providerRoot, { manifest });
    const unresolved = path.resolve(providerRoot, prepared.runtimeBinding.relativePath);
    const relative = path.relative(providerRoot, unresolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw this.contractError(
        { manifest } as RegisteredResourceProvider,
        "prepare",
        "Resource Runtime binding escapes the provider Candidate root",
      );
    }
    const info = await stat(unresolved);
    if (!info.isFile() && !info.isDirectory()) {
      throw this.contractError(
        { manifest } as RegisteredResourceProvider,
        "prepare",
        "Resource Runtime binding is not a regular file or directory",
      );
    }
    const [resolvedRoot, resolvedBinding] = await Promise.all([
      realpath(providerRoot),
      realpath(unresolved),
    ]);
    const resolvedRelative = path.relative(resolvedRoot, resolvedBinding);
    if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
      throw this.contractError(
        { manifest } as RegisteredResourceProvider,
        "prepare",
        "Resource Runtime binding resolves outside the provider Candidate root",
      );
    }
    return {
      ...prepared.runtimeBinding,
      hostPath: resolvedBinding,
      runtimePath:
        "/airlock/resources/" +
        manifest.providerId +
        "/" +
        prepared.runtimeBinding.relativePath,
    };
  }

  private async assertTreeHasNoSymlinks(
    root: string,
    entry: Pick<RegisteredResourceProvider, "manifest">,
  ): Promise<void> {
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const item of entries) {
        const target = path.join(directory, item.name);
        const details = await lstat(target);
        if (details.isSymbolicLink()) {
          throw this.contractError(
            entry,
            "describe",
            "Resource Candidate contains a symbolic link",
          );
        }
        if (details.isDirectory()) await visit(target);
      }
    };
    await visit(root);
  }

  private async discardPreparedAfterPrepareFailure(
    input: PrepareResourceSetInput,
    prepared: CoordinatedPreparedResource[],
  ): Promise<boolean> {
    try {
      await this.discardAll({
        agentId: input.agentId,
        runId: input.runId,
        candidateStateId: input.candidateStateId,
        candidateResourcesRoot: input.candidateResourcesRoot,
        prepared,
        quarantines: [],
        allowPartialPrepared: true,
        ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      });
      await rm(input.candidateResourcesRoot, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private assertCandidateSource(
    prepared: PreparedResource,
    source: ResourceVersionReference,
  ): void {
    if (
      prepared.candidate.sourceVersionId !== source.versionId ||
      prepared.candidate.sourceFingerprint !== source.fingerprint
    ) {
      throw new Error("Prepared Resource Candidate contradicts its source version");
    }
  }

  private assertExactProviders(
    indexed: ReadonlyMap<string, unknown>,
    label: string,
  ): void {
    this.assertProviders(indexed, this.registry.list(), label);
  }

  private assertProviders(
    indexed: ReadonlyMap<string, unknown>,
    entries: readonly RegisteredResourceProvider[],
    label: string,
  ): void {
    const expected = entries.map((entry) => entry.manifest.providerId);
    const actual = [...indexed.keys()].sort();
    const expectedSorted = [...expected].sort();
    if (
      actual.length !== expectedSorted.length ||
      actual.some((value, index) => value !== expectedSorted[index])
    ) {
      throw new Error(label + " provider set does not match the Resource Registry");
    }
  }

  private indexPrepared(
    values: readonly CoordinatedPreparedResource[],
    allowPartial = false,
    entries: readonly RegisteredResourceProvider[] = this.registry.list(),
  ): Map<string, CoordinatedPreparedResource> {
    const result = new Map<string, CoordinatedPreparedResource>();
    for (const value of values) {
      if (result.has(value.providerId)) {
        throw new Error("Duplicate prepared Resource Provider " + value.providerId);
      }
      result.set(value.providerId, value);
    }
    if (!allowPartial) this.assertProviders(result, entries, "Prepared resource");
    for (const providerId of result.keys()) {
      if (!entries.some((entry) => entry.manifest.providerId === providerId)) {
        throw new Error(
          "Prepared resource contains a provider outside the selected registry generation",
        );
      }
    }
    return result;
  }

  private entriesForScope(
    providerIds: readonly string[] | undefined,
  ): RegisteredResourceProvider[] {
    if (providerIds === undefined) return [...this.registry.list()];
    const unique = new Set(providerIds);
    if (unique.size !== providerIds.length) {
      throw new Error("Historical Resource Provider scope contains duplicates");
    }
    const entries = providerIds.map((providerId) => this.registry.get(providerId));
    entries.sort((left, right) =>
      (left.manifest.resourceKind + "\u0000" + left.manifest.providerId).localeCompare(
        right.manifest.resourceKind + "\u0000" + right.manifest.providerId,
      ),
    );
    return entries;
  }

  private indexEvidence(
    values: readonly CoordinatedResourceEvidence[],
    entries: readonly RegisteredResourceProvider[] = this.registry.list(),
  ): Map<string, CoordinatedResourceEvidence> {
    const result = new Map<string, CoordinatedResourceEvidence>();
    for (const value of values) {
      if (result.has(value.providerId)) {
        throw new Error("Duplicate Resource evidence for " + value.providerId);
      }
      result.set(value.providerId, value);
    }
    this.assertProviders(result, entries, "Validated resource evidence");
    return result;
  }

  private requirePrepared(
    indexed: ReadonlyMap<string, CoordinatedPreparedResource>,
    entry: RegisteredResourceProvider,
  ): CoordinatedPreparedResource {
    const resource = indexed.get(entry.manifest.providerId);
    if (!resource || resource.resourceKind !== entry.manifest.resourceKind) {
      throw new Error("Prepared Resource does not match " + entry.manifest.providerId);
    }
    return resource;
  }

  private providerCandidatePath(root: string, providerId: string): string {
    return path.join(root, providerId);
  }

  private idempotencyKey(runId: string, manifest: ResourceProviderManifest): string {
    return createResourcePromotionIdempotencyKey({
      runId,
      providerId: manifest.providerId,
      resourceKind: manifest.resourceKind,
    });
  }

  private async invoke<T, R = T>(
    entry: RegisteredResourceProvider,
    stage: ResourceLifecycleStage,
    recorder: ResourceEventRecorder | undefined,
    operation: () => Promise<T>,
    accept: (value: T) => R = ((value: T) => value as unknown as R),
  ): Promise<R> {
    let raw: T;
    try {
      raw = await operation();
    } catch (error) {
      const wrapped = this.providerError(entry, stage, error);
      await recorder?.(
        this.event(entry, stage, "failed", wrapped.safeSummary),
      );
      throw wrapped;
    }
    try {
      const result = accept(raw);
      await recorder?.(
        this.event(entry, stage, "passed", entry.manifest.label + " completed " + stage),
      );
      return result;
    } catch (error) {
      const wrapped =
        error instanceof ResourceLifecycleError
          ? error
          : this.contractError(
              entry,
              stage,
              "Resource Provider returned invalid " + stage + " evidence",
              "capability-mismatch",
              error,
            );
      await recorder?.(
        this.event(entry, stage, "failed", wrapped.safeSummary),
      );
      throw wrapped;
    }
  }

  private providerError(
    entry: RegisteredResourceProvider,
    stage: ResourceLifecycleStage,
    error: unknown,
  ): ResourceLifecycleError {
    const providerCode =
      error instanceof ResourceLifecycleError &&
      error.stage === stage &&
      resourceErrorCodes.has(error.code)
        ? error.code
        : "provider-unavailable";
    return this.contractError(
      entry,
      stage,
      "Resource Provider failed " + stage,
      providerCode,
      error,
    );
  }

  private event(
    entry: RegisteredResourceProvider,
    stage: ResourceLifecycleStage,
    status: "passed" | "failed",
    summary: string,
  ): ResourceLifecycleEvent {
    if (summary.length > 512) summary = summary.slice(0, 509) + "...";
    return {
      schemaVersion: 1,
      providerId: entry.manifest.providerId,
      resourceKind: entry.manifest.resourceKind,
      stage,
      status,
      summary,
      at: new Date().toISOString(),
    };
  }

  private contractError(
    entry: Pick<RegisteredResourceProvider, "manifest">,
    stage: ResourceLifecycleStage,
    summary: string,
    code: ConstructorParameters<typeof ResourceLifecycleError>[0]["code"] =
      "capability-mismatch",
    cause?: unknown,
  ): ResourceLifecycleError {
    return new ResourceLifecycleError({
      stage,
      code,
      retryable: code === "provider-unavailable" || code === "timeout",
      safeSummary:
        entry.manifest.label + ": " +
        (summary.length <= 400 ? summary : summary.slice(0, 397) + "..."),
      cause,
    });
  }
}

function indexedVersions(
  versions: readonly ResourceVersionReference[],
  label: string,
): Map<string, ResourceVersionReference> {
  const result = new Map<string, ResourceVersionReference>();
  for (const raw of versions) {
    const version = parseResourceVersionReference(raw);
    if (result.has(version.providerId)) {
      throw new Error("Duplicate " + label + " version for " + version.providerId);
    }
    result.set(version.providerId, version);
  }
  return result;
}

function indexedPlans(
  plans: readonly ResourcePromotionPlan[],
): Map<string, ResourcePromotionPlan> {
  const result = new Map<string, ResourcePromotionPlan>();
  for (const raw of plans) {
    const plan = parseResourcePromotionPlan(raw);
    if (result.has(plan.providerId)) {
      throw new Error("Duplicate Promotion plan for " + plan.providerId);
    }
    result.set(plan.providerId, plan);
  }
  return result;
}

function indexedQuarantines(
  quarantines: readonly ResourceQuarantineHandle[],
  runId: string | null,
): Map<string, ResourceQuarantineHandle> {
  const result = new Map<string, ResourceQuarantineHandle>();
  for (const raw of quarantines) {
    const quarantine = parseResourceQuarantineHandle(raw);
    if (runId && quarantine.runId !== runId) {
      throw new Error("Resource Quarantine belongs to a different Run");
    }
    if (result.has(quarantine.providerId)) {
      throw new Error("Duplicate Resource Quarantine for " + quarantine.providerId);
    }
    result.set(quarantine.providerId, quarantine);
  }
  return result;
}

function sameVersion(
  actual: ResourceVersionReference | null,
  expected: ResourceVersionReference,
): boolean {
  return (
    actual?.providerId === expected.providerId &&
    actual.resourceKind === expected.resourceKind &&
    actual.versionId === expected.versionId &&
    actual.fingerprint === expected.fingerprint &&
    stableJson(actual.metadata) === stableJson(expected.metadata)
  );
}

function versionFromPlan(plan: ResourcePromotionPlan): ResourceVersionReference {
  return {
    schemaVersion: 1,
    providerId: plan.providerId,
    resourceKind: plan.resourceKind,
    versionId: plan.targetVersionId,
    fingerprint: plan.targetFingerprint,
    metadata: structuredClone(plan.metadata),
  };
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

const resourceErrorCodes = new Set([
  "invalid-input",
  "source-mismatch",
  "candidate-missing",
  "candidate-corrupt",
  "validation-failed",
  "provider-unavailable",
  "timeout",
  "response-too-large",
  "capability-mismatch",
  "recovery-contradiction",
  "unsupported",
]);

export function appendBoundedResourceEvent(
  events: ResourceLifecycleEvent[],
  event: ResourceLifecycleEvent,
): void {
  if (events.length >= maximumLifecycleEvents) {
    throw new Error("Resource lifecycle evidence exceeds 256 events");
  }
  events.push(structuredClone(event));
}
import { createHash } from "node:crypto";
