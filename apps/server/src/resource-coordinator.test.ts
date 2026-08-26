import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
  createResourcePromotionIdempotencyKey,
  type JsonValue,
  type ResourceCandidateContext,
  type ResourceDiscardContext,
  type ResourcePrepareContext,
  type ResourcePromotionContext,
  type ResourceProviderManifest,
  type ResourceQuarantineHandle,
  type ResourceQuarantineContext,
  type ResourceReconcileContext,
  type ResourceVersionReference,
  type TransactionalResourceProvider,
} from "@agent-airlock/transactional-resource-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  ResourceCoordinator,
  type ResourceLifecycleEvent,
} from "./resource-coordinator.js";
import { ResourceRegistry } from "./resource-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

interface FixtureCandidate {
  filePath: string;
  source: ResourceVersionReference;
}

interface FixtureState {
  versions: Map<string, JsonValue>;
  candidates: Map<string, FixtureCandidate>;
  quarantines: Map<string, JsonValue>;
  discarded: Set<string>;
  calls: string[];
}

interface FixtureOptions {
  providerId: string;
  resourceKind: string;
  visibility?: "canonical-manifest" | "post-promotion-reconciled";
  prepareFailure?: boolean;
  unsafeBinding?: boolean;
  validationStatus?: "passed" | "failed" | "error";
  runtimeAccess?: "none" | "read-only" | "read-write";
  quarantineFailure?: boolean;
  discardFailure?: boolean;
}

class FixtureProvider implements TransactionalResourceProvider {
  readonly manifest: ResourceProviderManifest;

  constructor(
    private readonly state: FixtureState,
    private readonly options: FixtureOptions,
  ) {
    this.manifest = manifestFor(options);
  }

  async prepare(context: ResourcePrepareContext) {
    this.call("prepare");
    if (this.options.prepareFailure) throw new Error("fixture unavailable");
    const source = this.state.versions.get(context.source.versionId);
    if (source === undefined) throw new Error("source version missing");
    const candidateId = this.options.providerId + "-" + context.runId;
    const filePath = path.join(context.candidateResourcePath, "object.json");
    await writeFile(filePath, JSON.stringify(source) + "\n", "utf8");
    this.state.candidates.set(candidateId, {
      filePath,
      source: structuredClone(context.source),
    });
    return {
      schemaVersion: 1 as const,
      candidate: {
        schemaVersion: 1 as const,
        providerId: this.options.providerId,
        resourceKind: this.options.resourceKind,
        candidateId,
        sourceVersionId: context.source.versionId,
        sourceFingerprint: context.source.fingerprint,
        candidateFingerprint: context.source.fingerprint,
        metadata: {},
      },
      runtimeBinding: {
        schemaVersion: 1 as const,
        relativePath: this.options.unsafeBinding ? "../escape.json" : "object.json",
        access: "read-write" as const,
      },
    };
  }

  async describe(context: ResourceCandidateContext) {
    this.call("describe");
    const candidate = this.candidate(context.candidate.candidateId);
    const fingerprintCandidate = await fileFingerprint(candidate.filePath);
    return {
      schemaVersion: 1 as const,
      providerId: this.options.providerId,
      resourceKind: this.options.resourceKind,
      changed: fingerprintCandidate !== candidate.source.fingerprint,
      fingerprintBefore: candidate.source.fingerprint,
      fingerprintCandidate,
      summary: "Fixture object comparison completed",
      metadata: {},
    };
  }

  async validate(context: ResourceCandidateContext) {
    this.call("validate");
    this.candidate(context.candidate.candidateId);
    return [
      {
        schemaVersion: 1 as const,
        providerId: this.options.providerId,
        resourceKind: this.options.resourceKind,
        name: "fixture-shape",
        status: this.options.validationStatus ?? "passed",
        required: true,
        durationMs: 1,
        summary: "Fixture object is bounded JSON",
        output: null,
      },
    ];
  }

  async planPromotion(context: ResourceCandidateContext) {
    this.call("plan-promotion");
    const candidate = this.candidate(context.candidate.candidateId);
    return {
      schemaVersion: 1 as const,
      providerId: this.options.providerId,
      resourceKind: this.options.resourceKind,
      runId: context.runId,
      idempotencyKey: createResourcePromotionIdempotencyKey({
        runId: context.runId,
        providerId: this.options.providerId,
        resourceKind: this.options.resourceKind,
      }),
      sourceVersionId: candidate.source.versionId,
      sourceFingerprint: candidate.source.fingerprint,
      targetVersionId: "version-" + context.runId,
      targetFingerprint: await fileFingerprint(candidate.filePath),
      metadata: {},
    };
  }

  async promote(context: ResourcePromotionContext) {
    this.call("promote");
    const candidate = this.candidate(context.candidate.candidateId);
    const value = JSON.parse(await readFile(candidate.filePath, "utf8")) as JsonValue;
    const existing = this.state.versions.get(context.plan.targetVersionId);
    if (existing !== undefined && stableJson(existing) !== stableJson(value)) {
      throw new Error("idempotency contradiction");
    }
    this.state.versions.set(context.plan.targetVersionId, value);
    return versionReference(
      this.options,
      context.plan.targetVersionId,
      context.plan.targetFingerprint,
    );
  }

  async quarantine(context: ResourceQuarantineContext) {
    this.call("quarantine");
    if (this.options.quarantineFailure) {
      throw new Error("fixture Quarantine unavailable");
    }
    const candidate = this.candidate(context.candidate.candidateId);
    const value = JSON.parse(await readFile(candidate.filePath, "utf8")) as JsonValue;
    const quarantineId = "quarantine-" + context.runId;
    const candidateFingerprint = await fileFingerprint(candidate.filePath);
    this.state.quarantines.set(quarantineId, value);
    return {
      schemaVersion: 1 as const,
      providerId: this.options.providerId,
      resourceKind: this.options.resourceKind,
      runId: context.runId,
      quarantineId,
      candidateFingerprint,
      metadata: {},
    };
  }

  async discard(context: ResourceDiscardContext) {
    this.call("discard");
    if (this.options.discardFailure) throw new Error("fixture Discard unavailable");
    const key = this.options.providerId + ":" + context.runId;
    const alreadyDiscarded = this.state.discarded.has(key);
    if (context.candidate) this.state.candidates.delete(context.candidate.candidateId);
    this.state.candidates.delete(this.options.providerId + "-" + context.runId);
    if (context.quarantine) {
      this.state.quarantines.delete(context.quarantine.quarantineId);
    }
    this.state.discarded.add(key);
    return {
      schemaVersion: 1 as const,
      providerId: this.options.providerId,
      resourceKind: this.options.resourceKind,
      discarded: true,
      alreadyDiscarded,
      evidenceRetained: true,
    };
  }

  async reconcile(context: ResourceReconcileContext) {
    this.call("reconcile");
    const value = this.state.versions.get(context.plan.targetVersionId);
    if (value === undefined) {
      return {
        schemaVersion: 1 as const,
        providerId: this.options.providerId,
        resourceKind: this.options.resourceKind,
        status: "not-installed" as const,
        version: null,
        summary: "Fixture version is not installed",
      };
    }
    return {
      schemaVersion: 1 as const,
      providerId: this.options.providerId,
      resourceKind: this.options.resourceKind,
      status: "installed" as const,
      version: versionReference(
        this.options,
        context.plan.targetVersionId,
        fingerprint(value),
      ),
      summary: "Fixture version is installed",
    };
  }

  private candidate(candidateId: string): FixtureCandidate {
    const candidate = this.state.candidates.get(candidateId);
    if (!candidate) throw new Error("candidate missing");
    return candidate;
  }

  private call(stage: string): void {
    this.state.calls.push(this.options.providerId + ":" + stage);
  }
}

describe("Resource Registry", () => {
  it("validates, sorts, and rejects duplicate or incompatible required providers", () => {
    const alpha = fixture({ providerId: "provider-b", resourceKind: "alpha" });
    const zeta = fixture({ providerId: "provider-a", resourceKind: "zeta" });
    const registry = new ResourceRegistry([
      registration(zeta),
      registration(alpha),
    ]);

    expect(registry.manifests().map((manifest) => manifest.resourceKind)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(
      () =>
        new ResourceRegistry([
          registration(alpha),
          registration(alpha),
        ]),
    ).toThrow(/Duplicate Resource Provider identifier/);

    const incompatible = fixture({
      providerId: "provider-c",
      resourceKind: "optional",
    });
    Object.defineProperty(incompatible.provider, "manifest", {
      value: {
        ...incompatible.provider.manifest,
        capabilities: {
          ...incompatible.provider.manifest.capabilities,
          promotionVisibility: "best-effort",
        },
      },
    });
    expect(
      () => new ResourceRegistry([registration(incompatible)]),
    ).toThrow(/incompatible Capability Claims/);
    expect(
      () =>
        new ResourceRegistry([
          { ...registration(incompatible), required: false },
        ]),
    ).toThrow(/Optional Resource Providers are not supported/);

    const dotted = fixture({
      providerId: "provider.name",
      resourceKind: "dotted-kind",
    });
    const dashed = fixture({
      providerId: "provider-name",
      resourceKind: "dashed-kind",
    });
    expect(
      () =>
        new ResourceRegistry([
          registration(dotted),
          registration(dashed),
        ]),
    ).toThrow(/collide at Runtime environment name/);
  });

  it("rejects Runtime access that the configured execution boundary cannot enforce", () => {
    const readOnly = fixture({
      providerId: "provider-read-only",
      resourceKind: "read-only-object",
      runtimeAccess: "read-only",
    });

    expect(
      () =>
        new ResourceRegistry([registration(readOnly)], {
          supportedRuntimeAccess: ["none", "read-write"],
        }),
    ).toThrow(/unsupported Runtime access read-only/);
  });
});

describe("Resource Coordinator", () => {
  it("verifies exact immutable source versions before provider onboarding", async () => {
    const resource = fixture({ providerId: "provider-a", resourceKind: "alpha" });
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([registration(resource)]),
    );
    const source = sourceVersion(resource);

    await expect(
      coordinator.verifyProviderOnboarding("agent-onboarding", [source]),
    ).resolves.toEqual([
      expect.objectContaining({
        providerId: "provider-a",
        versionId: source.versionId,
        fingerprint: source.fingerprint,
      }),
    ]);
    await expect(
      coordinator.verifyProviderOnboarding("agent-onboarding", [
        { ...source, fingerprint: "f".repeat(64) },
      ]),
    ).rejects.toMatchObject({ code: "source-mismatch" });
  });

  it("executes a deterministic validated lifecycle for required canonical-manifest providers", async () => {
    const root = await temporaryRoot();
    const alpha = fixture({
      providerId: "provider-b",
      resourceKind: "alpha",
      visibility: "canonical-manifest",
    });
    const zeta = fixture({
      providerId: "provider-a",
      resourceKind: "zeta",
      visibility: "canonical-manifest",
    });
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([
        registration(zeta),
        registration(alpha),
      ]),
    );
    const sources = [sourceVersion(alpha), sourceVersion(zeta)];
    const events: ResourceLifecycleEvent[] = [];
    const base = {
      agentId: "agent-001",
      runId: "run-001",
      candidateStateId: "candidate-001",
      candidateResourcesRoot: path.join(root, "resources"),
      onEvent: (event: ResourceLifecycleEvent) => events.push(event),
    };
    const prepared = await coordinator.prepareAll({ ...base, sourceVersions: sources });
    expect(prepared.map((resource) => resource.resourceKind)).toEqual(["alpha", "zeta"]);
    expect(prepared.map((resource) => resource.runtimeBinding?.runtimePath)).toEqual([
      "/airlock/resources/provider-b/object.json",
      "/airlock/resources/provider-a/object.json",
    ]);
    for (const resource of prepared) {
      await writeFile(
        resource.runtimeBinding?.hostPath ?? "missing",
        JSON.stringify({ accepted: resource.resourceKind }) + "\n",
        "utf8",
      );
    }

    const evidence = await coordinator.describeAndValidate({ ...base, prepared });
    expect(evidence.every((resource) => resource.change.changed)).toBe(true);
    expect(
      evidence.every((resource) =>
        resource.validations.every((validation) => validation.status === "passed"),
      ),
    ).toBe(true);
    const plans = await coordinator.planAll({ ...base, prepared, evidence });
    const beforeCanonical = await coordinator.promoteBeforeCanonical({
      ...base,
      prepared,
      plans,
    });
    const afterCanonical = await coordinator.promoteAfterCanonical({
      ...base,
      prepared,
      plans,
    });
    expect(beforeCanonical.map((version) => version.resourceKind)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(afterCanonical).toEqual([]);

    await expect(
      coordinator.reconcile({
        agentId: base.agentId,
        runId: base.runId,
        plans,
        expectedVersions: beforeCanonical,
        visibility: "canonical-manifest",
        onEvent: base.onEvent,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: "installed", resourceKind: "alpha" }),
      expect.objectContaining({ status: "installed", resourceKind: "zeta" }),
    ]);
    await expect(
      coordinator.reconcile({
        agentId: base.agentId,
        runId: base.runId,
        plans,
        expectedVersions: [],
        visibility: "post-promotion-reconciled",
        onEvent: base.onEvent,
      }),
    ).resolves.toEqual([]);

    expect(alpha.state.calls.slice(0, 5)).toEqual([
      "provider-b:prepare",
      "provider-b:describe",
      "provider-b:validate",
      "provider-b:plan-promotion",
      "provider-b:promote",
    ]);
    expect(zeta.state.calls.slice(0, 5)).toEqual([
      "provider-a:prepare",
      "provider-a:describe",
      "provider-a:validate",
      "provider-a:plan-promotion",
      "provider-a:promote",
    ]);
    expect(events.every((event) => event.status === "passed")).toBe(true);
    expect(events.map((event) => event.providerId).slice(0, 2)).toEqual([
      "provider-b",
      "provider-a",
    ]);
  });

  it("retains and idempotently discards every rejected provider Candidate", async () => {
    const root = await temporaryRoot();
    const first = fixture({ providerId: "provider-a", resourceKind: "alpha" });
    const second = fixture({
      providerId: "provider-b",
      resourceKind: "zeta",
      validationStatus: "failed",
    });
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([registration(second), registration(first)]),
    );
    const base = {
      agentId: "agent-002",
      runId: "run-002",
      candidateStateId: "candidate-002",
      candidateResourcesRoot: path.join(root, "resources"),
    };
    const prepared = await coordinator.prepareAll({
      ...base,
      sourceVersions: [sourceVersion(first), sourceVersion(second)],
    });
    const evidence = await coordinator.describeAndValidate({ ...base, prepared });
    expect(
      evidence.flatMap((resource) => resource.validations).map((item) => item.status),
    ).toContain("failed");
    const quarantines = await coordinator.quarantineAll({
      ...base,
      prepared,
      evidence,
      failureStage: "validate",
    });
    expect(quarantines).toHaveLength(2);
    const firstDiscard = await coordinator.discardAll({
      ...base,
      prepared,
      quarantines,
    });
    const replayDiscard = await coordinator.discardAll({
      ...base,
      prepared,
      quarantines,
    });
    expect(firstDiscard.every((result) => !result.alreadyDiscarded)).toBe(true);
    expect(replayDiscard.every((result) => result.alreadyDiscarded)).toBe(true);
    expect(first.state.quarantines.size + second.state.quarantines.size).toBe(0);
  });

  it("returns and records partial Quarantine and Discard progress", async () => {
    const root = await temporaryRoot();
    const first = fixture({ providerId: "provider-a", resourceKind: "alpha" });
    const second = fixture({
      providerId: "provider-b",
      resourceKind: "zeta",
      quarantineFailure: true,
      discardFailure: true,
    });
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([registration(first), registration(second)]),
    );
    const base = {
      agentId: "agent-partial",
      runId: "run-partial",
      candidateStateId: "candidate-partial",
      candidateResourcesRoot: path.join(root, "resources"),
    };
    const prepared = await coordinator.prepareAll({
      ...base,
      sourceVersions: [sourceVersion(first), sourceVersion(second)],
    });
    const evidence = await coordinator.describeAndValidate({ ...base, prepared });
    const quarantineSnapshots: ResourceQuarantineHandle[][] = [];

    await expect(
      coordinator.quarantineAll({
        ...base,
        prepared,
        evidence,
        failureStage: "validate",
        onQuarantine: (quarantines) => {
          quarantineSnapshots.push(structuredClone([...quarantines]));
        },
      }),
    ).rejects.toMatchObject({
      name: "ResourceQuarantineError",
      quarantines: [{ providerId: "provider-a", runId: "run-partial" }],
    });
    expect(quarantineSnapshots.at(-1)).toEqual([
      expect.objectContaining({ providerId: "provider-a" }),
    ]);

    const discardSnapshots: Array<Array<{ providerId: string }>> = [];
    await expect(
      coordinator.discardAll({
        ...base,
        prepared,
        quarantines: quarantineSnapshots.at(-1) ?? [],
        onDiscard: (results) => {
          discardSnapshots.push(structuredClone([...results]));
        },
      }),
    ).rejects.toMatchObject({
      name: "ResourceDiscardError",
      results: [{ providerId: "provider-a", discarded: true }],
    });
    expect(discardSnapshots.at(-1)).toEqual([
      expect.objectContaining({ providerId: "provider-a", discarded: true }),
    ]);
    expect(first.state.candidates.size).toBe(0);
    expect(second.state.candidates.size).toBe(1);
  });

  it("fails closed, records the failing provider, and cleans prior Candidates", async () => {
    const root = await temporaryRoot();
    const first = fixture({ providerId: "provider-a", resourceKind: "alpha" });
    const broken = fixture({
      providerId: "provider-b",
      resourceKind: "zeta",
      prepareFailure: true,
    });
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([registration(broken), registration(first)]),
    );
    const events: ResourceLifecycleEvent[] = [];
    const candidateResourcesRoot = path.join(root, "resources");

    await expect(
      coordinator.prepareAll({
        agentId: "agent-003",
        runId: "run-003",
        candidateStateId: "candidate-003",
        candidateResourcesRoot,
        sourceVersions: [sourceVersion(first), sourceVersion(broken)],
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      name: "ResourcePreparationError",
      cleanupCompleted: true,
      cause: {
        name: "ResourceLifecycleError",
        stage: "prepare",
        code: "provider-unavailable",
      },
    });
    await expect(readFile(candidateResourcesRoot, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(first.state.calls).toEqual(["provider-a:prepare", "provider-a:discard"]);
    expect(events).toEqual([
      expect.objectContaining({
        providerId: "provider-a",
        stage: "prepare",
        status: "passed",
      }),
      expect.objectContaining({
        providerId: "provider-b",
        stage: "prepare",
        status: "failed",
      }),
      expect.objectContaining({
        providerId: "provider-a",
        stage: "discard",
        status: "passed",
      }),
      expect.objectContaining({
        providerId: "provider-b",
        stage: "discard",
        status: "passed",
      }),
    ]);
  });

  it("rejects an unsafe Runtime binding before reporting prepare success", async () => {
    const root = await temporaryRoot();
    const unsafe = fixture({
      providerId: "provider-a",
      resourceKind: "alpha",
      unsafeBinding: true,
    });
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([registration(unsafe)]),
    );
    const events: ResourceLifecycleEvent[] = [];

    await expect(
      coordinator.prepareAll({
        agentId: "agent-004",
        runId: "run-004",
        candidateStateId: "candidate-004",
        candidateResourcesRoot: path.join(root, "resources"),
        sourceVersions: [sourceVersion(unsafe)],
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      cleanupCompleted: true,
      cause: { stage: "prepare", code: "capability-mismatch" },
    });
    expect(events).toEqual([
      expect.objectContaining({ stage: "prepare", status: "failed" }),
      expect.objectContaining({ stage: "discard", status: "passed" }),
    ]);
  });
});

function fixture(options: FixtureOptions) {
  const initial = { release: "canonical" } satisfies JsonValue;
  const state: FixtureState = {
    versions: new Map([["version-source", initial]]),
    candidates: new Map(),
    quarantines: new Map(),
    discarded: new Set(),
    calls: [],
  };
  return { options, state, provider: new FixtureProvider(state, options) };
}

function manifestFor(options: FixtureOptions): ResourceProviderManifest {
  return {
    sdkSchemaVersion: 1,
    providerId: options.providerId,
    resourceKind: options.resourceKind,
    label: "Fixture " + options.resourceKind,
    capabilities: {
      schemaVersion: 1,
      isolation: "provider-branch",
      promotionVisibility: options.visibility ?? "canonical-manifest",
      promotionIdempotency: "run-keyed",
      reconciliation: "forward",
      quarantine: "retained",
      discard: "idempotent",
      repair: "fork",
      runtimeAccess: options.runtimeAccess ?? "read-write",
    },
    failureSemantics: AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
    metadata: {},
  };
}

function sourceVersion(target: ReturnType<typeof fixture>): ResourceVersionReference {
  return versionReference(
    target.options,
    "version-source",
    fingerprint(target.state.versions.get("version-source")),
  );
}

function registration(target: ReturnType<typeof fixture>) {
  return {
    provider: target.provider,
    initialVersion: sourceVersion(target),
  };
}

function versionReference(
  options: Pick<FixtureOptions, "providerId" | "resourceKind">,
  versionId: string,
  versionFingerprint: string,
): ResourceVersionReference {
  return {
    schemaVersion: 1,
    providerId: options.providerId,
    resourceKind: options.resourceKind,
    versionId,
    fingerprint: versionFingerprint,
    metadata: {},
  };
}

async function fileFingerprint(filePath: string): Promise<string> {
  return fingerprint(JSON.parse(await readFile(filePath, "utf8")));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
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

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-resource-coordinator-"));
  temporaryDirectories.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
