import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
  assertResourceFingerprint,
  assertTransactionalResourceConformance,
  createResourcePromotionIdempotencyKey,
  assessRequiredResourceEligibility,
  parsePreparedResource,
  parseResourceCandidateHandle,
  parseResourcePromotionPlan,
  parseResourceProviderManifest,
  parseResourceReconciliationResult,
  redactSensitiveText,
  runTransactionalResourceConformance,
  validateMetadata,
  validateTransactionalResourceProvider,
} from "./index.js";
import type {
  JsonValue,
  ResourceCandidateHandle,
  ResourceConformanceFixture,
  ResourcePromotionPlan,
  ResourceProviderManifest,
  ResourceQuarantineHandle,
  ResourceVersionReference,
  TransactionalResourceProvider,
} from "./index.js";

const digest = (value: JsonValue) =>
  createHash("sha256").update(stableJson(value)).digest("hex");

const manifest: ResourceProviderManifest = {
  sdkSchemaVersion: 1,
  providerId: "fixture.object",
  resourceKind: "versioned-object",
  label: "Versioned object",
  capabilities: {
    schemaVersion: 1,
    isolation: "provider-branch",
    promotionVisibility: "canonical-manifest",
    promotionIdempotency: "run-keyed",
    reconciliation: "forward",
    quarantine: "retained",
    discard: "idempotent",
    repair: "fork",
    runtimeAccess: "none",
  },
  failureSemantics: AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
  metadata: { protocol: "fixture-v1", usageUnits: 0 },
};

interface FixtureState {
  candidates: Map<string, JsonValue>;
  versions: Map<string, JsonValue>;
  quarantines: Map<string, JsonValue>;
  discarded: Set<string>;
}

class FixtureProvider implements TransactionalResourceProvider {
  readonly manifest = manifest;

  constructor(private readonly state: FixtureState) {}

  async prepare(context: Parameters<TransactionalResourceProvider["prepare"]>[0]) {
    const source = context.repairSource
      ? this.state.quarantines.get(context.repairSource.quarantineId)
      : this.state.versions.get(context.source.versionId);
    if (source === undefined) throw new Error("source missing");
    const copied = structuredClone(source);
    this.state.candidates.set(context.runId, copied);
    return {
      schemaVersion: 1 as const,
      candidate: this.handle(context.runId, context.source, copied),
      runtimeBinding: null,
    };
  }

  async describe(context: Parameters<TransactionalResourceProvider["describe"]>[0]) {
    const value = this.requireCandidate(context.candidate.candidateId);
    const candidateFingerprint = digest(value);
    return {
      schemaVersion: 1 as const,
      providerId: manifest.providerId,
      resourceKind: manifest.resourceKind,
      changed: candidateFingerprint !== context.candidate.sourceFingerprint,
      fingerprintBefore: context.candidate.sourceFingerprint,
      fingerprintCandidate: candidateFingerprint,
      summary: "Versioned object comparison",
      metadata: {},
    };
  }

  async validate(context: Parameters<TransactionalResourceProvider["validate"]>[0]) {
    const value = this.requireCandidate(context.candidate.candidateId);
    const fingerprint = digest(value);
    context.candidate.candidateFingerprint = fingerprint;
    return [
      {
        schemaVersion: 1 as const,
        providerId: manifest.providerId,
        resourceKind: manifest.resourceKind,
        name: "object-shape",
        status: "passed" as const,
        required: true,
        durationMs: 0,
        summary: "Candidate object is bounded JSON",
        output: null,
      },
    ];
  }

  async planPromotion(
    context: Parameters<TransactionalResourceProvider["planPromotion"]>[0],
  ): Promise<ResourcePromotionPlan> {
    const value = this.requireCandidate(context.candidate.candidateId);
    const targetFingerprint = digest(value);
    context.candidate.candidateFingerprint = targetFingerprint;
    return {
      schemaVersion: 1,
      providerId: manifest.providerId,
      resourceKind: manifest.resourceKind,
      runId: context.runId,
      idempotencyKey: createResourcePromotionIdempotencyKey({
        runId: context.runId,
        providerId: manifest.providerId,
        resourceKind: manifest.resourceKind,
      }),
      sourceVersionId: context.candidate.sourceVersionId,
      sourceFingerprint: context.candidate.sourceFingerprint,
      targetVersionId: "version-" + context.runId,
      targetFingerprint,
      metadata: {},
    };
  }

  async promote(context: Parameters<TransactionalResourceProvider["promote"]>[0]) {
    const existing = this.state.versions.get(context.plan.targetVersionId);
    const candidate = this.requireCandidate(context.candidate.candidateId);
    if (existing !== undefined && digest(existing) !== context.plan.targetFingerprint) {
      throw new Error("installed version contradicts plan");
    }
    this.state.versions.set(context.plan.targetVersionId, structuredClone(candidate));
    return this.version(context.plan.targetVersionId, candidate);
  }

  async quarantine(
    context: Parameters<TransactionalResourceProvider["quarantine"]>[0],
  ) {
    const value = this.requireCandidate(context.candidate.candidateId);
    this.state.quarantines.set(context.runId, value);
    this.state.candidates.delete(context.candidate.candidateId);
    return {
      schemaVersion: 1 as const,
      providerId: manifest.providerId,
      resourceKind: manifest.resourceKind,
      runId: context.runId,
      quarantineId: context.runId,
      candidateFingerprint: digest(value),
      metadata: {},
    };
  }

  async discard(context: Parameters<TransactionalResourceProvider["discard"]>[0]) {
    const id =
      context.quarantine?.quarantineId ??
      context.candidate?.candidateId ??
      context.runId;
    const alreadyDiscarded = this.state.discarded.has(id);
    this.state.quarantines.delete(id);
    this.state.candidates.delete(id);
    this.state.discarded.add(id);
    return {
      schemaVersion: 1 as const,
      providerId: manifest.providerId,
      resourceKind: manifest.resourceKind,
      discarded: true,
      alreadyDiscarded,
      evidenceRetained: true,
    };
  }

  async reconcile(context: Parameters<TransactionalResourceProvider["reconcile"]>[0]) {
    const value = this.state.versions.get(context.plan.targetVersionId);
    if (value === undefined) {
      return {
        schemaVersion: 1 as const,
        providerId: manifest.providerId,
        resourceKind: manifest.resourceKind,
        status: "not-installed" as const,
        version: null,
        summary: "No immutable version is installed",
      };
    }
    const version = this.version(context.plan.targetVersionId, value);
    if (
      version.fingerprint !== context.plan.targetFingerprint ||
      (context.expectedVersion &&
        stableJson(context.expectedVersion) !== stableJson(version))
    ) {
      return {
        schemaVersion: 1 as const,
        providerId: manifest.providerId,
        resourceKind: manifest.resourceKind,
        status: "contradiction" as const,
        version: null,
        summary: "Installed version contradicts Promotion plan",
      };
    }
    return {
      schemaVersion: 1 as const,
      providerId: manifest.providerId,
      resourceKind: manifest.resourceKind,
      status: "installed" as const,
      version,
      summary: "Installed version matches Promotion plan",
    };
  }

  private handle(
    candidateId: string,
    source: ResourceVersionReference,
    value: JsonValue,
  ): ResourceCandidateHandle {
    return {
      schemaVersion: 1,
      providerId: manifest.providerId,
      resourceKind: manifest.resourceKind,
      candidateId,
      sourceVersionId: source.versionId,
      sourceFingerprint: source.fingerprint,
      candidateFingerprint: digest(value),
      metadata: {},
    };
  }

  private version(versionId: string, value: JsonValue): ResourceVersionReference {
    return {
      schemaVersion: 1,
      providerId: manifest.providerId,
      resourceKind: manifest.resourceKind,
      versionId,
      fingerprint: digest(value),
      metadata: {},
    };
  }

  private requireCandidate(candidateId: string): JsonValue {
    const value = this.state.candidates.get(candidateId);
    if (value === undefined) throw new Error("candidate missing");
    return value;
  }
}

async function createFixture(): Promise<ResourceConformanceFixture> {
  const sourceValue = { release: "canonical" };
  const source: ResourceVersionReference = {
    schemaVersion: 1,
    providerId: manifest.providerId,
    resourceKind: manifest.resourceKind,
    versionId: "version-source",
    fingerprint: digest(sourceValue),
    metadata: {},
  };
  const state: FixtureState = {
    candidates: new Map(),
    versions: new Map([[source.versionId, sourceValue]]),
    quarantines: new Map(),
    discarded: new Set(),
  };
  const provider = new FixtureProvider(state);
  return {
    provider,
    context: {
      schemaVersion: 1,
      agentId: "agent-fixture",
      runId: "run-fixture",
      candidateStateId: "state-candidate",
      candidateResourcePath: "/candidate/resources/fixture.object",
      source,
      repairSource: null,
    },
    async mutateCandidate(candidate, value) {
      state.candidates.set(candidate.candidateId, structuredClone(value));
      candidate.candidateFingerprint = digest(value);
    },
    async readVersion(reference) {
      const value = state.versions.get(reference.versionId);
      if (value === undefined) throw new Error("version missing");
      return structuredClone(value);
    },
    async readCandidate(candidate) {
      const value = state.candidates.get(candidate.candidateId);
      if (value === undefined) throw new Error("candidate missing");
      return structuredClone(value);
    },
    async candidateExists(candidate) {
      return state.candidates.has(candidate.candidateId);
    },
    async quarantineExists(quarantine) {
      return state.quarantines.has(quarantine.quarantineId);
    },
    async mutableStateExistsForRun(runId) {
      return state.candidates.has(runId) || state.quarantines.has(runId);
    },
    async createRepairContext(quarantine) {
      return {
        schemaVersion: 1,
        agentId: "agent-fixture",
        runId: "run-fixture-repair",
        candidateStateId: "state-candidate-repair",
        candidateResourcePath: "/candidate/resources/fixture.object-repair",
        source,
        repairSource: quarantine,
      };
    },
    async restartProvider() {
      return new FixtureProvider(state);
    },
    async dispose() {},
  };
}

async function createLeakyFixture(): Promise<ResourceConformanceFixture> {
  const fixture = await createFixture();
  fixture.provider.prepare = async () => {
    const privateKeyLabel = ["PRIVATE", "KEY"].join(" ");
    throw new Error(
      [
        "provider failed with Bearer supersecretcredential123456",
        "-----BEGIN " + privateKeyLabel + "-----",
        "private-key-material-that-must-not-survive",
        "-----END " + privateKeyLabel + "-----",
      ].join("\n"),
    );
  };
  return fixture;
}

async function createMalformedFixture(): Promise<ResourceConformanceFixture> {
  const fixture = await createFixture();
  const prepare = fixture.provider.prepare.bind(fixture.provider);
  fixture.provider.prepare = async (context) =>
    ({ ...(await prepare(context)), unexpected: true }) as never;
  return fixture;
}

async function createSourceReuseFixture(): Promise<ResourceConformanceFixture> {
  const fixture = await createFixture();
  const planPromotion = fixture.provider.planPromotion.bind(fixture.provider);
  fixture.provider.planPromotion = async (context) => ({
    ...(await planPromotion(context)),
    targetVersionId: context.candidate.sourceVersionId,
  });
  return fixture;
}

async function createCredentialIdFixture(): Promise<ResourceConformanceFixture> {
  const fixture = await createFixture();
  const prepare = fixture.provider.prepare.bind(fixture.provider);
  fixture.provider.prepare = async (context) => {
    const prepared = await prepare(context);
    return {
      ...prepared,
      candidate: {
        ...prepared.candidate,
        candidateId: fakeOpenAiStyleSecret(),
      },
    };
  };
  return fixture;
}

async function createKeyedCredentialIdFixture(): Promise<ResourceConformanceFixture> {
  const fixture = await createFixture();
  const prepare = fixture.provider.prepare.bind(fixture.provider);
  fixture.provider.prepare = async (context) => {
    const prepared = await prepare(context);
    return {
      ...prepared,
      candidate: {
        ...prepared.candidate,
        candidateId: "token:syntheticcredential123456",
      },
    };
  };
  return fixture;
}

async function createCredentialSummaryFixture(): Promise<ResourceConformanceFixture> {
  const fixture = await createFixture();
  const describe = fixture.provider.describe.bind(fixture.provider);
  fixture.provider.describe = async (context) => ({
    ...(await describe(context)),
    summary: "password=summarycredential123456789",
  });
  return fixture;
}

async function createCredentialReconciliationFixture(): Promise<ResourceConformanceFixture> {
  const fixture = await createFixture();
  const poison = (provider: TransactionalResourceProvider) => {
    const reconcile = provider.reconcile.bind(provider);
    provider.reconcile = async (context) => ({
      ...(await reconcile(context)),
      summary: "token:reconciliationcredential123456",
    });
    return provider;
  };
  poison(fixture.provider);
  const restartProvider = fixture.restartProvider.bind(fixture);
  fixture.restartProvider = async () => poison(await restartProvider());
  return fixture;
}

async function createCredentialRuntimePathFixture(): Promise<ResourceConformanceFixture> {
  const fixture = await createFixture();
  const prepare = fixture.provider.prepare.bind(fixture.provider);
  fixture.provider.prepare = async (context) => ({
    ...(await prepare(context)),
    runtimeBinding: {
      schemaVersion: 1,
      relativePath: "password=runtimecredential123456",
      access: "read-write",
    },
  });
  return fixture;
}

describe("Transactional Resource SDK", () => {
  it("redacts ModelArk endpoint identifiers without changing ordinary words", () => {
    const input =
      "Runtime failed for ep-private-endpoint-123 during step-by-step recovery of an ephemeral worker";

    expect(redactSensitiveText(input)).toBe(
      "Runtime failed for [REDACTED] during step-by-step recovery of an ephemeral worker",
    );
    expect(redactSensitiveText("EP-release episode kept ep- incomplete")).toBe(
      "EP-release episode kept ep- incomplete",
    );
  });

  it("derives stable bounded Promotion idempotency keys", () => {
    const first = createResourcePromotionIdempotencyKey({
      runId: "run-001",
      providerId: "fixture-object",
      resourceKind: "object",
    });
    const replay = createResourcePromotionIdempotencyKey({
      runId: "run-001",
      providerId: "fixture-object",
      resourceKind: "object",
    });
    const sibling = createResourcePromotionIdempotencyKey({
      runId: "run-002",
      providerId: "fixture-object",
      resourceKind: "object",
    });

    expect(first).toMatch(/^airlock:v1:[a-f0-9]{64}$/);
    expect(replay).toBe(first);
    expect(sibling).not.toBe(first);
  });

  it("executes the provider-neutral conformance suite", async () => {
    const report = await runTransactionalResourceConformance(createFixture);

    expect(report.passed).toBe(true);
    expect(report.cases.map((item) => item.id)).toEqual([
      "required-capabilities",
      "candidate-isolation",
      "bounded-evidence",
      "idempotent-promotion",
      "quarantine-and-discard",
      "prepare-replay-and-run-cleanup",
      "repair-fork",
      "restart-reconciliation",
    ]);
    expect(report.cases.every((item) => item.status === "passed")).toBe(true);
    expect(() => assertTransactionalResourceConformance(report)).not.toThrow();
  });

  it("redacts provider failures before they enter conformance evidence", async () => {
    const report = await runTransactionalResourceConformance(createLeakyFixture);
    const serialized = JSON.stringify(report);

    expect(report.passed).toBe(false);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("supersecretcredential123456");
    expect(serialized).not.toContain("private-key-material-that-must-not-survive");
  });

  it("does not certify lifecycle values that strict core admission rejects", async () => {
    const report = await runTransactionalResourceConformance(
      createMalformedFixture,
    );

    expect(report.passed).toBe(false);
    expect(
      report.cases.some(
        (item) =>
          item.status === "failed" && item.summary.includes("unknown field"),
      ),
    ).toBe(true);
  });

  it("rejects a changed Candidate that reuses its immutable source version identifier", async () => {
    const report = await runTransactionalResourceConformance(
      createSourceReuseFixture,
    );

    expect(report.passed).toBe(false);
    expect(
      report.cases.some(
        (item) =>
          item.status === "failed" &&
          item.summary.includes("Promotion plan contradicts"),
      ),
    ).toBe(true);
  });

  it.each([
    ["opaque secret identifier", createCredentialIdFixture],
    ["keyed opaque identifier", createKeyedCredentialIdFixture],
    ["summary", createCredentialSummaryFixture],
    ["reconciliation", createCredentialReconciliationFixture],
    ["Runtime path", createCredentialRuntimePathFixture],
  ] as const)("rejects credential-like provider %s evidence", async (_label, factory) => {
    const report = await runTransactionalResourceConformance(factory);
    const serialized = JSON.stringify(report);

    expect(report.passed).toBe(false);
    expect(serialized).not.toContain("summarycredential123456789");
    expect(serialized).not.toContain("reconciliationcredential123456");
    expect(serialized).not.toContain("syntheticcredential123456");
    expect(serialized).not.toContain("runtimecredential123456");
    expect(serialized).not.toContain(fakeOpenAiStyleSecret());
  });

  it("rejects unknown, unsafe, credential-like, and contradictory manifest data", () => {
    expect(() =>
      parseResourceProviderManifest({ ...manifest, unexpected: true }),
    ).toThrow(/unknown field/);
    expect(() =>
      parseResourceProviderManifest({ ...manifest, providerId: "../escape" }),
    ).toThrow(/safe lowercase identifier/);
    expect(() =>
      parseResourceProviderManifest({
        ...manifest,
        metadata: { apiKey: "not-even-a-real-key" },
      }),
    ).toThrow(/sensitive key/);
    for (const key of ["token", "cookie", "session", "connectionString"]) {
      expect(() =>
        parseResourceProviderManifest({
          ...manifest,
          metadata: { [key]: "credential-like-value" },
        }),
      ).toThrow(/sensitive key/);
    }
    expect(() =>
      parseResourceProviderManifest({
        ...manifest,
        metadata: { endpoint: "postgres://user:password@database.invalid/app" },
      }),
    ).toThrow(/credential-like value/);
    expect(() =>
      parseResourceProviderManifest({
        ...manifest,
        metadata: { model: "ep-private-endpoint-123" },
      }),
    ).toThrow(/credential-like value/);
    const contradictoryProvider = new FixtureProvider({
      candidates: new Map(),
      versions: new Map(),
      quarantines: new Map(),
      discarded: new Set(),
    });
    Object.defineProperty(contradictoryProvider, "manifest", {
      value: {
        ...manifest,
        capabilities: {
          ...manifest.capabilities,
          isolation: "deferred-intent",
          runtimeAccess: "read-write",
        },
      },
    });
    expect(() =>
      validateTransactionalResourceProvider(contradictoryProvider),
    ).toThrow(/deferred-intent/);
  });

  it("makes unsupported guarantees explicit for required resources", () => {
    const eligibility = assessRequiredResourceEligibility({
      ...manifest.capabilities,
      promotionVisibility: "best-effort",
      promotionIdempotency: "none",
      reconciliation: "observe-only",
      quarantine: "evidence-only",
      discard: "best-effort",
      repair: "unsupported",
    });

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons).toHaveLength(6);
    expect(eligibility.reasons.join(" ")).toContain("canonical-manifest");
  });

  it("strictly parses every persisted lifecycle boundary", () => {
    const sourceFingerprint = digest({ source: true });
    const candidateFingerprint = digest({ candidate: true });
    const candidate = parseResourceCandidateHandle(
      {
        schemaVersion: 1,
        providerId: manifest.providerId,
        resourceKind: manifest.resourceKind,
        candidateId: "candidate-1",
        sourceVersionId: "version-1",
        sourceFingerprint,
        candidateFingerprint,
        metadata: {},
      },
      manifest,
    );
    expect(
      parsePreparedResource(
        { schemaVersion: 1, candidate, runtimeBinding: null },
        manifest,
      ).candidate,
    ).toEqual(candidate);
    expect(
      parseResourcePromotionPlan(
        {
          schemaVersion: 1,
          providerId: manifest.providerId,
          resourceKind: manifest.resourceKind,
          runId: "run-1",
          idempotencyKey: "run-1:fixture.object",
          sourceVersionId: "version-1",
          sourceFingerprint,
          targetVersionId: "version-2",
          targetFingerprint: candidateFingerprint,
          metadata: {},
        },
        manifest,
      ).targetVersionId,
    ).toBe("version-2");
    expect(
      parseResourceReconciliationResult(
        {
          schemaVersion: 1,
          providerId: manifest.providerId,
          resourceKind: manifest.resourceKind,
          status: "not-installed",
          version: null,
          summary: "No version",
        },
        manifest,
      ).status,
    ).toBe("not-installed");
    expect(() =>
      parseResourceReconciliationResult(
        {
          schemaVersion: 1,
          providerId: manifest.providerId,
          resourceKind: manifest.resourceKind,
          status: "installed",
          version: null,
          summary: "Impossible",
        },
        manifest,
      ),
    ).toThrow(/must include a version/);
    expect(() =>
      parsePreparedResource(
        {
          schemaVersion: 1,
          candidate,
          runtimeBinding: {
            schemaVersion: 1,
            relativePath: "../escape",
            access: "read-write",
          },
        },
        {
          ...manifest,
          capabilities: { ...manifest.capabilities, runtimeAccess: "read-write" },
        },
      ),
    ).toThrow(/safe relative POSIX path/);
    expect(() =>
      parsePreparedResource(
        {
          schemaVersion: 1,
          candidate,
          runtimeBinding: {
            schemaVersion: 1,
            relativePath: "password=runtimecredential123456",
            access: "read-write",
          },
        },
        {
          ...manifest,
          capabilities: { ...manifest.capabilities, runtimeAccess: "read-write" },
        },
      ),
    ).toThrow(/credential-like/);
    expect(() =>
      parseResourceCandidateHandle(
        { ...candidate, candidateId: "token:syntheticcredential123456" },
        manifest,
      ),
    ).toThrow(/credential-like/);
    expect(() =>
      parseResourceReconciliationResult(
        {
          schemaVersion: 1,
          providerId: manifest.providerId,
          resourceKind: manifest.resourceKind,
          status: "not-installed",
          version: null,
          summary: "password=summarycredential123456789",
        },
        manifest,
      ),
    ).toThrow(/credential-like/);
  });

  it("bounds JSON metadata and SHA-256 fingerprints", () => {
    expect(validateMetadata({ usageUnits: 42 }, "metadata")).toEqual({
      usageUnits: 42,
    });
    expect(() => validateMetadata({ accessToken: "value" }, "metadata")).toThrow(
      /sensitive key/,
    );
    expect(() => validateMetadata({ output: "Bearer abcdefghijk" }, "metadata"))
      .toThrow(/credential-like/);
    expect(() =>
      validateMetadata(
        { output: "ark-11111111-2222-3333-4444-555555555555-test1" },
        "metadata",
      ),
    ).toThrow(/credential-like/);
    expect(assertResourceFingerprint("a".repeat(64), "hash")).toHaveLength(64);
    expect(() => assertResourceFingerprint("A".repeat(64), "hash")).toThrow(
      /lowercase SHA-256/,
    );
  });
});

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function fakeOpenAiStyleSecret(): string {
  return ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
}
