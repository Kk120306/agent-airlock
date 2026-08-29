import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
  createResourcePromotionIdempotencyKey,
  type JsonValue,
  type ResourceCandidateContext,
  type ResourceDiscardContext,
  type ResourcePrepareContext,
  type ResourcePromotionPlan,
  type ResourcePromotionContext,
  type ResourceProviderManifest,
  type ResourceQuarantineContext,
  type ResourceReconcileContext,
  type ResourceVersionReference,
  type TransactionalResourceProvider,
} from "@agent-airlock/transactional-resource-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { hasCompleteProviderDiscardEvidence } from "./portable-decision-journal.js";
import { ResourceCoordinator } from "./resource-coordinator.js";
import { ResourceRegistry } from "./resource-registry.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunTransaction, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import {
  waitForRunStatus,
  waitForRunToFinish,
} from "../test/agent-service-workflow.js";
import { persistFixtureSession } from "../test/session-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface CandidateRecord {
  filePath: string;
  source: ResourceVersionReference;
}

class AcceptanceObjectProvider implements TransactionalResourceProvider {
  readonly manifest: ResourceProviderManifest;

  readonly versions = new Map<string, JsonValue>();
  readonly candidates = new Map<string, CandidateRecord>();
  readonly quarantines = new Map<string, JsonValue>();
  readonly discarded = new Set<string>();
  failPrepare = false;
  failDiscard = false;
  failValidation = false;
  contradictPromotion = false;
  changeSummaryOverride: string | null = null;
  reconciliationSummaryOverride: string | null = null;

  constructor(
    providerId = "acceptance-object",
    resourceKind = "json-object",
    label = "Acceptance object",
  ) {
    this.manifest = {
      sdkSchemaVersion: 1,
      providerId,
      resourceKind,
      label,
      capabilities: {
        schemaVersion: 1,
        isolation: "provider-branch",
        promotionVisibility: "canonical-manifest",
        promotionIdempotency: "run-keyed",
        reconciliation: "forward",
        quarantine: "retained",
        discard: "idempotent",
        repair: "fork",
        runtimeAccess: "read-write",
      },
      failureSemantics: AIRLOCK_RESOURCE_FAILURE_SEMANTICS,
      metadata: {},
    };
  }

  async prepare(context: ResourcePrepareContext) {
    if (this.failPrepare) throw new Error("simulated provider prepare outage");
    const sourceValue = context.repairSource
      ? this.quarantines.get(context.repairSource.quarantineId)
      : this.versions.get(context.source.versionId);
    if (sourceValue === undefined)
      throw new Error("Source object is unavailable");
    const candidateId = "candidate-" + context.runId;
    const filePath = path.join(context.candidateResourcePath, "object.json");
    await writeFile(filePath, JSON.stringify(sourceValue) + "\n", "utf8");
    this.candidates.set(candidateId, {
      filePath,
      source: structuredClone(context.source),
    });
    return {
      schemaVersion: 1 as const,
      candidate: {
        schemaVersion: 1 as const,
        providerId: this.manifest.providerId,
        resourceKind: this.manifest.resourceKind,
        candidateId,
        sourceVersionId: context.source.versionId,
        sourceFingerprint: context.source.fingerprint,
        candidateFingerprint: fingerprint(sourceValue),
        metadata: {},
      },
      runtimeBinding: {
        schemaVersion: 1 as const,
        relativePath: "object.json",
        access: "read-write" as const,
      },
    };
  }

  async describe(context: ResourceCandidateContext) {
    const candidate = this.requireCandidate(context.candidate.candidateId);
    const candidateFingerprint = await fileFingerprint(candidate.filePath);
    return {
      schemaVersion: 1 as const,
      providerId: this.manifest.providerId,
      resourceKind: this.manifest.resourceKind,
      changed: candidateFingerprint !== candidate.source.fingerprint,
      fingerprintBefore: candidate.source.fingerprint,
      fingerprintCandidate: candidateFingerprint,
      summary:
        this.changeSummaryOverride ??
        "Candidate JSON object was compared with its Canonical version",
      metadata: {},
    };
  }

  async validate(context: ResourceCandidateContext) {
    const candidate = this.requireCandidate(context.candidate.candidateId);
    const value = JSON.parse(
      await readFile(candidate.filePath, "utf8"),
    ) as unknown;
    const valid =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).release === "string" &&
      !this.failValidation;
    return [
      {
        schemaVersion: 1 as const,
        providerId: this.manifest.providerId,
        resourceKind: this.manifest.resourceKind,
        name: "object-shape",
        status: valid ? ("passed" as const) : ("failed" as const),
        required: true,
        durationMs: 1,
        summary: valid
          ? "Candidate object has a release label"
          : "Candidate object is missing a release label",
        output: null,
      },
    ];
  }

  async planPromotion(context: ResourceCandidateContext) {
    const candidate = this.requireCandidate(context.candidate.candidateId);
    return {
      schemaVersion: 1 as const,
      providerId: this.manifest.providerId,
      resourceKind: this.manifest.resourceKind,
      runId: context.runId,
      idempotencyKey: createResourcePromotionIdempotencyKey({
        runId: context.runId,
        providerId: this.manifest.providerId,
        resourceKind: this.manifest.resourceKind,
      }),
      sourceVersionId: candidate.source.versionId,
      sourceFingerprint: candidate.source.fingerprint,
      targetVersionId: "version-" + context.runId,
      targetFingerprint: await fileFingerprint(candidate.filePath),
      metadata: {},
    };
  }

  async promote(context: ResourcePromotionContext) {
    this.requireCandidate(context.candidate.candidateId);
    if (this.contradictPromotion) {
      return reference(
        context.plan.targetVersionId,
        fingerprint({ release: "contradictory-provider-response" }),
        this.manifest.providerId,
        this.manifest.resourceKind,
      );
    }
    const value = JSON.parse(
      await readFile(
        path.join(context.candidateResourcePath, "object.json"),
        "utf8",
      ),
    ) as JsonValue;
    const existing = this.versions.get(context.plan.targetVersionId);
    if (existing !== undefined && stableJson(existing) !== stableJson(value)) {
      throw new Error("Promotion replay contradicted the installed object");
    }
    this.versions.set(context.plan.targetVersionId, value);
    return reference(
      context.plan.targetVersionId,
      context.plan.targetFingerprint,
      this.manifest.providerId,
      this.manifest.resourceKind,
    );
  }

  async quarantine(context: ResourceQuarantineContext) {
    const candidate = this.requireCandidate(context.candidate.candidateId);
    const value = JSON.parse(
      await readFile(candidate.filePath, "utf8"),
    ) as JsonValue;
    const quarantineId = "quarantine-" + context.runId;
    const candidateFingerprint = fingerprint(value);
    this.quarantines.set(quarantineId, value);
    return {
      schemaVersion: 1 as const,
      providerId: this.manifest.providerId,
      resourceKind: this.manifest.resourceKind,
      runId: context.runId,
      quarantineId,
      candidateFingerprint,
      metadata: {},
    };
  }

  async discard(context: ResourceDiscardContext) {
    if (this.failDiscard) throw new Error("simulated provider discard outage");
    const key = context.runId;
    const alreadyDiscarded = this.discarded.has(key);
    if (context.candidate)
      this.candidates.delete(context.candidate.candidateId);
    if (context.quarantine)
      this.quarantines.delete(context.quarantine.quarantineId);
    this.discarded.add(key);
    return {
      schemaVersion: 1 as const,
      providerId: this.manifest.providerId,
      resourceKind: this.manifest.resourceKind,
      discarded: true,
      alreadyDiscarded,
      evidenceRetained: true,
    };
  }

  async reconcile(context: ResourceReconcileContext) {
    const value = this.versions.get(context.plan.targetVersionId);
    return value === undefined
      ? {
          schemaVersion: 1 as const,
          providerId: this.manifest.providerId,
          resourceKind: this.manifest.resourceKind,
          status: "not-installed" as const,
          version: null,
          summary:
            this.reconciliationSummaryOverride ??
            "Immutable object version is not installed",
        }
      : {
          schemaVersion: 1 as const,
          providerId: this.manifest.providerId,
          resourceKind: this.manifest.resourceKind,
          status: "installed" as const,
          version: reference(
            context.plan.targetVersionId,
            fingerprint(value),
            this.manifest.providerId,
            this.manifest.resourceKind,
          ),
          summary:
            this.reconciliationSummaryOverride ??
            "Immutable object version is installed",
        };
  }

  private requireCandidate(candidateId: string): CandidateRecord {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error("Candidate object is unavailable");
    return candidate;
  }
}

class InterruptedDiscardWorkspace extends WorkspaceManager {
  override async discardQuarantine(): Promise<boolean> {
    throw new Error("simulated interruption after Discard authority");
  }
}

describe("Phase 8 registered Resource Provider acceptance", () => {
  it("verifies the immutable provider source before creating the first Agent", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-create-"),
    );
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const provider = new AcceptanceObjectProvider();
    const unavailableValue = { release: "not-installed" } satisfies JsonValue;
    const initialVersion = reference(
      "version-not-installed",
      fingerprint(unavailableValue),
    );
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([{ provider, initialVersion }]),
    );
    const runtime: AgentRunner = {
      run: async () => {
        throw new Error("An unverified first Agent must never execute Runtime");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        coordinator.initialVersions(),
      ),
      runtime,
      undefined,
      undefined,
      coordinator,
    );
    await service.initialize();

    await expect(
      service.createAgent({ name: "Unverified first Agent" }),
    ).rejects.toThrow(
      /Configured onboarding source was not independently verified/,
    );
    expect(service.listAgents()).toEqual([]);
  });

  it("onboards a provider into an existing deployment before the next Run", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-onboard-"),
    );
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const originalRuntime: AgentRunner = {
      run: async (request) => {
        await persistFixtureSession(
          request,
          "thread-before-provider",
          "pre-provider-deployment",
        );
        return {
          output: "completed before provider onboarding",
          threadId: "thread-before-provider",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const originalWorkspaces = new WorkspaceManager(config.workspaceRoot);
    const original = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      originalWorkspaces,
      originalRuntime,
    );
    await original.initialize();
    const agent = await original.createAgent({ name: "Provider onboarding" });
    const originalStarted = await original.sendMessage(
      agent.id,
      "complete one Run before provider registration",
    );
    const originalCompleted = await waitForRun(
      original,
      originalStarted.run.id,
    );
    expect(originalCompleted.status).toBe("completed");
    const canonicalBefore = await originalWorkspaces.readCanonical(agent.id);
    expect(canonicalBefore.providerVersions).toEqual([]);

    const provider = new AcceptanceObjectProvider();
    const initialValue = { release: "onboarded" } satisfies JsonValue;
    provider.versions.set("version-initial", initialValue);
    const initialVersion = reference(
      "version-initial",
      fingerprint(initialValue),
    );
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([{ provider, initialVersion }]),
    );
    const upgradedWorkspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    const runtime: AgentRunner = {
      run: async (request) => {
        const objectPath = request.resourceBindings?.[0]?.hostPath;
        if (!objectPath)
          throw new Error("Runtime did not receive provider binding");
        await writeFile(objectPath, '{"release":"after-upgrade"}\n', "utf8");
        await persistFixtureSession(
          request,
          "thread-upgrade",
          "provider-onboarding",
        );
        return { output: "upgraded", threadId: "thread-upgrade", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const upgraded = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      upgradedWorkspaces,
      runtime,
      undefined,
      undefined,
      coordinator,
    );
    await upgraded.initialize();

    const canonicalOnboarded = await upgradedWorkspaces.readCanonical(agent.id);
    expect(canonicalOnboarded).toMatchObject({
      workspaceContentHash: canonicalBefore.workspaceContentHash,
      sessionContentHash: canonicalBefore.sessionContentHash,
      sqliteContentHash: canonicalBefore.sqliteContentHash,
      outboxContentHash: canonicalBefore.outboxContentHash,
      providerVersions: [initialVersion],
    });
    expect(canonicalOnboarded.stateId).not.toBe(canonicalBefore.stateId);
    expect(canonicalOnboarded.contentHash).not.toBe(
      canonicalBefore.contentHash,
    );
    expect(upgraded.getAgent(agent.id)).toMatchObject({
      canonicalStateId: canonicalOnboarded.stateId,
      status: "ready",
      lastError: null,
    });
    const registry = JSON.parse(
      await readFile(
        path.join(config.workspaceRoot, ".resource-registry.json"),
        "utf8",
      ),
    ) as { generation: number };
    expect(registry.generation).toBe(1);

    const started = await upgraded.sendMessage(
      agent.id,
      "use the onboarded provider",
    );
    const completed = await waitForRun(upgraded, started.run.id);
    expect(completed).toMatchObject({
      status: "completed",
      transaction: {
        disposition: "promoted",
        providerResources: [{ disposition: "promoted" }],
      },
    });
    const canonicalAfterRun = await upgradedWorkspaces.readCanonical(agent.id);
    expect(canonicalAfterRun.providerVersions[0]?.versionId).toBe(
      "version-" + started.run.id,
    );
    expect(
      provider.versions.get(
        canonicalAfterRun.providerVersions[0]?.versionId ?? "missing",
      ),
    ).toEqual({ release: "after-upgrade" });
  });

  it.each([
    ["after-validated", false],
    ["after-version-installed", false],
    ["after-canonical-advanced", false],
    ["after-validated", true],
    ["after-version-installed", true],
    ["after-canonical-advanced", true],
  ] as const)(
    "recovers a %s Promotion across an additive registry upgrade with prior provider=%s",
    async (faultPoint, withPriorProvider) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "airlock-phase-eight-generation-recovery-"),
      );
      temporaryDirectories.push(root);
      const config = loadConfig({
        NODE_ENV: "test",
        APP_DATA_DIR: path.join(root, "data"),
        AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
        CODEX_HOME: path.join(root, "codex"),
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
      });
      const providerA = new AcceptanceObjectProvider(
        "provider-a",
        "json-object-a",
        "Provider A",
      );
      const valueA = { release: "provider-a-initial" } satisfies JsonValue;
      providerA.versions.set("version-a", valueA);
      const versionA = reference(
        "version-a",
        fingerprint(valueA),
        "provider-a",
        "json-object-a",
      );
      const firstCoordinator = new ResourceCoordinator(
        new ResourceRegistry(
          withPriorProvider
            ? [{ provider: providerA, initialVersion: versionA }]
            : [],
        ),
      );
      const firstWorkspaces = new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        firstCoordinator.initialVersions(),
      );
      const firstRuntime: AgentRunner = {
        run: async (request) => {
          const providerPath = request.resourceBindings?.find(
            (binding) => binding.providerId === "provider-a",
          )?.hostPath;
          if (withPriorProvider) {
            if (!providerPath)
              throw new Error("Historical provider binding is missing");
            await writeFile(
              providerPath,
              '{"release":"provider-a-promoted"}\n',
              "utf8",
            );
          }
          await persistFixtureSession(
            request,
            "thread-before-registry-upgrade",
            faultPoint,
          );
          return {
            output: "prepared before registry upgrade",
            threadId: "thread-before-registry-upgrade",
            usage: null,
          };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      };
      let injected = false;
      const first = new AgentService(
        config,
        new JsonStore(path.join(config.dataDirectory, "db.json")),
        firstWorkspaces,
        firstRuntime,
        undefined,
        (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error("simulated prior-generation interruption");
          }
        },
        firstCoordinator,
      );
      await first.initialize();
      const agent = await first.createAgent({ name: "Generation recovery" });
      const started = await first.sendMessage(
        agent.id,
        "finish this Promotion before onboarding the next provider",
      );
      const interrupted = await waitForRun(first, started.run.id);
      expect(interrupted.status).toBe("failed");

      const providerB = new AcceptanceObjectProvider(
        "provider-b",
        "json-object-b",
        "Provider B",
      );
      const valueB = { release: "provider-b-initial" } satisfies JsonValue;
      providerB.versions.set("version-b", valueB);
      const versionB = reference(
        "version-b",
        fingerprint(valueB),
        "provider-b",
        "json-object-b",
      );
      const nextCoordinator = new ResourceCoordinator(
        new ResourceRegistry([
          ...(withPriorProvider
            ? [{ provider: providerA, initialVersion: versionA }]
            : []),
          { provider: providerB, initialVersion: versionB },
        ]),
      );
      const nextWorkspaces = new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        nextCoordinator.initialVersions(),
      );
      const restarted = new AgentService(
        config,
        new JsonStore(path.join(config.dataDirectory, "db.json")),
        nextWorkspaces,
        {
          run: async () => {
            throw new Error("Startup recovery must not replay Runtime");
          },
          cancel: async () => false,
          isAvailable: async () => true,
        },
        undefined,
        undefined,
        nextCoordinator,
      );
      await restarted.initialize();

      expect(restarted.getRun(started.run.id)).toMatchObject({
        status: "completed",
        error: null,
        transaction: {
          disposition: "promoted",
          recovery: { recoveredAfterRestart: true },
        },
      });
      expect(restarted.getAgent(agent.id)).toMatchObject({
        status: "ready",
        lastError: null,
      });
      const canonical = await nextWorkspaces.readCanonical(agent.id);
      expect(
        canonical.providerVersions.map((version) => version.providerId),
      ).toEqual(
        withPriorProvider ? ["provider-a", "provider-b"] : ["provider-b"],
      );
      expect(providerB.versions.get("version-b")).toEqual(valueB);
      if (withPriorProvider) {
        expect(providerA.versions.get("version-" + started.run.id)).toEqual({
          release: "provider-a-promoted",
        });
      }
      const registry = JSON.parse(
        await readFile(
          path.join(config.workspaceRoot, ".resource-registry.json"),
          "utf8",
        ),
      ) as { generation: number };
      expect(registry.generation).toBe(withPriorProvider ? 2 : 1);
    },
  );

  it("leaves Canonical State untouched when provider onboarding cannot verify its source", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-onboard-fail-"),
    );
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const runtime: AgentRunner = {
      run: async () => {
        throw new Error(
          "A failed registry transition must not execute the Runtime",
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const originalWorkspaces = new WorkspaceManager(config.workspaceRoot);
    const original = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      originalWorkspaces,
      runtime,
    );
    await original.initialize();
    const agent = await original.createAgent({
      name: "Failed provider onboarding",
    });
    const canonicalBefore = await originalWorkspaces.readCanonical(agent.id);
    const manifestPath = path.join(
      config.workspaceRoot,
      agent.id,
      "canonical.json",
    );
    const registryPath = path.join(
      config.workspaceRoot,
      ".resource-registry.json",
    );
    const manifestBefore = await readFile(manifestPath, "utf8");
    const registryBefore = await readFile(registryPath, "utf8");

    const provider = new AcceptanceObjectProvider();
    const missingValue = { release: "missing" } satisfies JsonValue;
    const missingVersion = reference(
      "version-missing",
      fingerprint(missingValue),
    );
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([{ provider, initialVersion: missingVersion }]),
    );
    const failed = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        coordinator.initialVersions(),
      ),
      runtime,
      undefined,
      undefined,
      coordinator,
    );
    await failed.initialize();

    expect(failed.getAgent(agent.id)).toMatchObject({
      canonicalStateId: canonicalBefore.stateId,
      status: "error",
      lastError: expect.stringContaining(
        "Configured onboarding source was not independently verified",
      ),
    });
    await expect(
      failed.sendMessage(agent.id, "must not run on an uncommitted registry"),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(
      failed.createAgent({ name: "Must not inherit an unverified provider" }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
    const recoveryView = new WorkspaceManager(config.workspaceRoot);
    await recoveryView.initialize();
    await expect(recoveryView.readCanonical(agent.id)).resolves.toEqual(
      canonicalBefore,
    );
    expect(await readFile(registryPath, "utf8")).toBe(registryBefore);
  });

  it("rejects a keyed credential summary before an onboarding journal is persisted", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-onboard-secret-"),
    );
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const runtime: AgentRunner = {
      run: async () => {
        throw new Error(
          "Credential-bearing onboarding must not execute Runtime",
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const originalWorkspaces = new WorkspaceManager(config.workspaceRoot);
    const original = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      originalWorkspaces,
      runtime,
    );
    await original.initialize();
    const agent = await original.createAgent({
      name: "Credential-safe onboarding",
    });
    const canonicalBefore = await originalWorkspaces.readCanonical(agent.id);
    const manifestPath = path.join(
      config.workspaceRoot,
      agent.id,
      "canonical.json",
    );
    const registryPath = path.join(
      config.workspaceRoot,
      ".resource-registry.json",
    );
    const manifestBefore = await readFile(manifestPath, "utf8");
    const registryBefore = await readFile(registryPath, "utf8");

    const credential = "password=onboardingcredential123456";
    const provider = new AcceptanceObjectProvider();
    const initialValue = { release: "credential-safe" } satisfies JsonValue;
    provider.versions.set("version-initial", initialValue);
    provider.reconciliationSummaryOverride = credential;
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([
        {
          provider,
          initialVersion: reference(
            "version-initial",
            fingerprint(initialValue),
          ),
        },
      ]),
    );
    const upgraded = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        coordinator.initialVersions(),
      ),
      runtime,
      undefined,
      undefined,
      coordinator,
    );
    await upgraded.initialize();

    const failedAgent = upgraded.getAgent(agent.id);
    expect(failedAgent.status).toBe("error");
    expect(JSON.stringify(failedAgent)).not.toContain(credential);
    await expect(
      readFile(
        path.join(
          config.workspaceRoot,
          ".registry-transitions",
          agent.id + ".json",
        ),
        "utf8",
      ),
    ).rejects.toThrow();
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
    expect(await readFile(registryPath, "utf8")).toBe(registryBefore);
    expect(
      await readFile(path.join(config.dataDirectory, "db.json"), "utf8"),
    ).not.toContain(credential);
    const recoveryView = new WorkspaceManager(config.workspaceRoot);
    await recoveryView.initialize();
    await expect(recoveryView.readCanonical(agent.id)).resolves.toEqual(
      canonicalBefore,
    );
  });

  it("rejects keyed provider evidence before it enters a persisted Run transaction", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-run-secret-"),
    );
    temporaryDirectories.push(root);
    const provider = new AcceptanceObjectProvider();
    const initialValue = { release: "canonical" } satisfies JsonValue;
    provider.versions.set("version-initial", initialValue);
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([
        {
          provider,
          initialVersion: reference(
            "version-initial",
            fingerprint(initialValue),
          ),
        },
      ]),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const workspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    const runtime: AgentRunner = {
      run: async (request) => {
        const binding = request.resourceBindings?.[0]?.hostPath;
        if (!binding) throw new Error("provider binding missing");
        await writeFile(binding, '{"release":"candidate"}\n', "utf8");
        await persistFixtureSession(
          request,
          "thread-credential-safe",
          "credential-safe",
        );
        return {
          output: "candidate returned",
          threadId: "thread-credential-safe",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      runtime,
      undefined,
      undefined,
      coordinator,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Credential-safe Run" });
    const credential = "token:runtransactioncredential123456";
    provider.changeSummaryOverride = credential;

    const started = await service.sendMessage(
      agent.id,
      "reject credential evidence",
    );
    const failed = await waitForRun(service, started.run.id);

    expect(failed.status).toBe("failed");
    expect(failed.transaction?.disposition).toBe("quarantined");
    expect(JSON.stringify(failed)).not.toContain(credential);
    expect(
      await readFile(path.join(config.dataDirectory, "db.json"), "utf8"),
    ).not.toContain(credential);
  });

  it("discards a retained Quarantine through its historical provider generation", async () => {
    const fixture = await createRejectedProviderFixture("generation-discard");
    const quarantineId =
      fixture.rejected.transaction?.providerResources[0]?.quarantine
        ?.quarantineId;
    expect(quarantineId).toBeTruthy();

    const initialValue = { release: "canonical" } satisfies JsonValue;
    const initialVersion = reference(
      "version-initial",
      fingerprint(initialValue),
    );
    const providerB = new AcceptanceObjectProvider(
      "provider-b",
      "json-object-b",
      "Provider B",
    );
    const valueB = { release: "provider-b-initial" } satisfies JsonValue;
    providerB.versions.set("version-b", valueB);
    const versionB = reference(
      "version-b",
      fingerprint(valueB),
      "provider-b",
      "json-object-b",
    );
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([
        { provider: fixture.provider, initialVersion },
        { provider: providerB, initialVersion: versionB },
      ]),
    );
    const restarted = new AgentService(
      fixture.config,
      new JsonStore(path.join(fixture.config.dataDirectory, "db.json")),
      new WorkspaceManager(
        fixture.config.workspaceRoot,
        undefined,
        undefined,
        coordinator.initialVersions(),
      ),
      {
        run: async () => {
          throw new Error("Historical Discard must not execute Runtime");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      undefined,
      undefined,
      coordinator,
    );
    await restarted.initialize();
    const canonical = await new WorkspaceManager(
      fixture.config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    ).readCanonical(fixture.agentId);
    expect(
      canonical.providerVersions.map((version) => version.providerId).sort(),
    ).toEqual(["acceptance-object", "provider-b"]);

    await restarted.discardRun(fixture.runId);

    expect(restarted.getRun(fixture.runId).transaction).toMatchObject({
      disposition: "discarded",
      quarantineAvailable: false,
      providerResources: [
        { providerId: "acceptance-object", disposition: "discarded" },
      ],
    });
    expect(fixture.provider.quarantines.has(quarantineId ?? "missing")).toBe(
      false,
    );
    expect(providerB.discarded.has(fixture.runId)).toBe(false);
  });

  it("retains cleanup-only Quarantine when cancellation cannot discard provider state", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-cancel-"),
    );
    temporaryDirectories.push(root);
    const provider = new AcceptanceObjectProvider();
    const initialValue = { release: "canonical" } satisfies JsonValue;
    provider.versions.set("version-initial", initialValue);
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([
        {
          provider,
          initialVersion: reference(
            "version-initial",
            fingerprint(initialValue),
          ),
        },
      ]),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    let rejectRuntime!: (error: Error) => void;
    let signalStarted!: () => void;
    const runtimeStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const runner: AgentRunner = {
      run: async (): Promise<RunnerResult> => {
        signalStarted();
        return new Promise<RunnerResult>((_resolve, reject) => {
          rejectRuntime = reject;
        });
      },
      cancel: async () => {
        rejectRuntime(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    };
    const workspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      runner,
      undefined,
      undefined,
      coordinator,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Cancellation cleanup" });
    const canonicalBefore = await workspaces.readCanonical(agent.id);
    const started = await service.sendMessage(
      agent.id,
      "wait for cancellation",
    );
    await runtimeStarted;
    provider.failDiscard = true;

    await service.stopAgent(agent.id);
    const retained = service.getRun(started.run.id);
    expect(retained).toMatchObject({
      status: "failed",
      transaction: {
        disposition: "quarantined",
        quarantineAvailable: true,
      },
    });
    expect(retained.transaction?.quarantinePath).toBeTruthy();
    await expect(
      access(retained.transaction?.quarantinePath ?? "missing"),
    ).resolves.toBeUndefined();
    await expect(workspaces.readCanonical(agent.id)).resolves.toEqual(
      canonicalBefore,
    );
    expect(provider.candidates.has("candidate-" + started.run.id)).toBe(true);

    provider.failDiscard = false;
    await service.discardRun(started.run.id);
    expect(provider.candidates.has("candidate-" + started.run.id)).toBe(false);
  });

  it("rejects a post-Runtime provider symlink before trusted hooks can read it", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-symlink-"),
    );
    temporaryDirectories.push(root);
    const provider = new AcceptanceObjectProvider();
    const initialValue = { release: "canonical" } satisfies JsonValue;
    provider.versions.set("version-initial", initialValue);
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([
        {
          provider,
          initialVersion: reference(
            "version-initial",
            fingerprint(initialValue),
          ),
        },
      ]),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const outside = path.join(root, "outside-secret.json");
    await writeFile(outside, '{"release":"must-not-be-read"}\n', "utf8");
    const runner: AgentRunner = {
      run: async (request) => {
        const binding = request.resourceBindings?.[0]?.hostPath;
        if (!binding) throw new Error("provider binding missing");
        await unlink(binding);
        await symlink(outside, binding);
        return { output: "swapped binding", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const workspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      runner,
      undefined,
      undefined,
      coordinator,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Symlink boundary" });
    const before = await workspaces.readCanonical(agent.id);
    const started = await service.sendMessage(agent.id, "attempt binding swap");
    const rejected = await waitForRun(service, started.run.id);

    expect(rejected.status).toBe("failed");
    expect(rejected.error).toContain("post-execution confinement checks");
    expect(rejected.transaction).toMatchObject({
      disposition: "quarantined",
      quarantineAvailable: true,
      providerResourceEvents: [
        { stage: "prepare", status: "passed" },
        { stage: "discard", status: "passed" },
      ],
    });
    expect(provider.quarantines.size).toBe(0);
    expect(provider.versions.size).toBe(1);
    await expect(workspaces.readCanonical(agent.id)).resolves.toEqual(before);
  });

  it("aborts before Runtime and makes failed prepare cleanup retryable", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-prepare-"),
    );
    temporaryDirectories.push(root);
    const provider = new AcceptanceObjectProvider();
    const initialValue = { release: "canonical" } satisfies JsonValue;
    provider.versions.set("version-initial", initialValue);
    provider.failPrepare = true;
    provider.failDiscard = true;
    const initialVersion = reference(
      "version-initial",
      fingerprint(initialValue),
    );
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([{ provider, initialVersion }]),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const workspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    let runtimeCalls = 0;
    const runner: AgentRunner = {
      run: async () => {
        runtimeCalls += 1;
        throw new Error(
          "Runtime must not execute after Resource prepare fails",
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      runner,
      undefined,
      undefined,
      coordinator,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Prepare failure" });
    const canonicalBefore = await workspaces.readCanonical(agent.id);
    const started = await service.sendMessage(
      agent.id,
      "must abort before Runtime",
    );
    const failed = await waitForRun(service, started.run.id);

    expect(runtimeCalls).toBe(0);
    expect(failed).toMatchObject({
      status: "failed",
      transaction: {
        disposition: "quarantined",
        quarantineAvailable: true,
        providerResources: [],
        providerResourceEvents: [
          { stage: "prepare", status: "failed" },
          { stage: "discard", status: "failed" },
        ],
      },
    });
    const quarantinePath = failed.transaction?.quarantinePath;
    if (!quarantinePath)
      throw new Error("Prepare cleanup failure was not retained");
    await expect(access(quarantinePath)).resolves.toBeUndefined();
    await expect(workspaces.readCanonical(agent.id)).resolves.toEqual(
      canonicalBefore,
    );

    await expect(service.repairRun(started.run.id)).rejects.toThrow(
      /cannot start a Repair Run/,
    );

    await expect(service.discardRun(started.run.id)).rejects.toThrow(
      /failed evidence-preserving Discard/,
    );
    expect(
      service.getRun(started.run.id).transaction?.quarantineAvailable,
    ).toBe(true);
    await expect(access(quarantinePath)).resolves.toBeUndefined();

    provider.failDiscard = false;
    const discarded = await service.discardRun(started.run.id);
    expect(discarded.transaction).toMatchObject({
      disposition: "discarded",
      quarantineAvailable: false,
    });
    expect(provider.discarded.has(started.run.id)).toBe(true);
    await expect(access(quarantinePath)).rejects.toThrow();
    expect(runtimeCalls).toBe(0);

    const retried = await service.sendMessage(
      agent.id,
      "abort cleanly before Runtime",
    );
    const cleanAbort = await waitForRun(service, retried.run.id);
    expect(cleanAbort).toMatchObject({
      status: "failed",
      transaction: {
        disposition: "discarded",
        quarantinePath: null,
        quarantineAvailable: false,
        providerResourceEvents: [
          { stage: "prepare", status: "failed" },
          { stage: "discard", status: "passed" },
        ],
      },
    });
    await expect(workspaces.readCanonical(agent.id)).resolves.toEqual(
      canonicalBefore,
    );
    expect(runtimeCalls).toBe(0);

    const cleanupFactPath = path.join(
      config.dataDirectory,
      "portable-decision-journal",
      ".discard-cleanup",
      retried.run.id,
    );
    await expect(access(cleanupFactPath)).rejects.toThrow();
    const restartedAfterCleanAbort = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        coordinator.initialVersions(),
      ),
      runner,
      undefined,
      undefined,
      coordinator,
    );
    await restartedAfterCleanAbort.initialize();
    expect(restartedAfterCleanAbort.getRun(retried.run.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("before Runtime"),
      transaction: {
        disposition: "discarded",
        quarantinePath: null,
        quarantineAvailable: false,
        providerResourceEvents: [
          { stage: "prepare", status: "failed" },
          { stage: "discard", status: "passed" },
        ],
      },
    });
    expect(restartedAfterCleanAbort.getAgent(agent.id)).toMatchObject({
      status: "error",
      lastError: cleanAbort.error,
    });
  });

  it("limits multi-provider prepare-abort cleanup to attempted providers", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-multi-prepare-"),
    );
    temporaryDirectories.push(root);
    const providers = [
      new AcceptanceObjectProvider("provider-a", "kind-a", "Provider A"),
      new AcceptanceObjectProvider("provider-b", "kind-b", "Provider B"),
      new AcceptanceObjectProvider("provider-c", "kind-c", "Provider C"),
    ];
    const entries = providers.map((provider, index) => {
      const value = { release: "canonical-" + provider.manifest.providerId };
      const versionId = "version-" + String(index + 1);
      provider.versions.set(versionId, value);
      return {
        provider,
        initialVersion: reference(
          versionId,
          fingerprint(value),
          provider.manifest.providerId,
          provider.manifest.resourceKind,
        ),
      };
    });
    providers[1]!.failPrepare = true;
    const coordinator = new ResourceCoordinator(new ResourceRegistry(entries));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    let runtimeCalls = 0;
    const runtime: AgentRunner = {
      run: async () => {
        runtimeCalls += 1;
        throw new Error("Prepare-abort must not execute Runtime");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        coordinator.initialVersions(),
      ),
      runtime,
      undefined,
      undefined,
      coordinator,
    );
    await service.initialize();
    const agent = await service.createAgent({
      name: "Bounded multi-provider prepare-abort",
    });
    const started = await service.sendMessage(
      agent.id,
      "abort after the second provider",
    );
    const failed = await waitForRun(service, started.run.id);
    expect(runtimeCalls).toBe(0);
    expect(failed.transaction).toMatchObject({
      status: "discarded",
      disposition: "discarded",
      providerResources: [{ providerId: "provider-a" }],
      providerResourceEvents: [
        { providerId: "provider-a", stage: "prepare", status: "passed" },
        { providerId: "provider-b", stage: "prepare", status: "failed" },
        { providerId: "provider-a", stage: "discard", status: "passed" },
        { providerId: "provider-b", stage: "discard", status: "passed" },
      ],
    });
    expect(providers[0]!.discarded.has(started.run.id)).toBe(true);
    expect(providers[1]!.discarded.has(started.run.id)).toBe(true);
    expect(providers[2]!.discarded.has(started.run.id)).toBe(false);
    if (!failed.transaction) {
      throw new Error("Prepare-abort has no terminal transaction");
    }
    expect(hasCompleteProviderDiscardEvidence(failed.transaction)).toBe(true);

    const legacyAllProviderCleanup = structuredClone(failed.transaction);
    legacyAllProviderCleanup.providerResourceEvents.push({
      schemaVersion: 1,
      providerId: "provider-c",
      resourceKind: "kind-c",
      stage: "discard",
      status: "passed",
      summary: "Legacy cleanup visited an unattempted provider",
      at: new Date().toISOString(),
    });
    expect(hasCompleteProviderDiscardEvidence(legacyAllProviderCleanup)).toBe(
      true,
    );
    const selfAuthorizedCleanup = structuredClone(legacyAllProviderCleanup);
    selfAuthorizedCleanup.providerResources = [];
    selfAuthorizedCleanup.providerResourceEvents =
      selfAuthorizedCleanup.providerResourceEvents.filter(
        (event) => event.providerId === "provider-c",
      );
    expect(hasCompleteProviderDiscardEvidence(selfAuthorizedCleanup)).toBe(
      false,
    );

    const cleanupFactPath = path.join(
      config.dataDirectory,
      "portable-decision-journal",
      ".discard-cleanup",
      started.run.id,
    );
    await expect(access(cleanupFactPath)).rejects.toThrow();
    const restarted = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        coordinator.initialVersions(),
      ),
      runtime,
      undefined,
      undefined,
      coordinator,
    );
    await restarted.initialize();
    expect(restarted.getRun(started.run.id)).toMatchObject({
      status: "failed",
      transaction: {
        status: "discarded",
        disposition: "discarded",
      },
    });
    expect(runtimeCalls).toBe(0);
  });

  it("promotes, rejects, repairs, and discards one provider without core-specific code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-eight-"));
    temporaryDirectories.push(root);
    const provider = new AcceptanceObjectProvider();
    const initialValue = { release: "canonical" } satisfies JsonValue;
    provider.versions.set("version-initial", initialValue);
    const initialVersion = reference(
      "version-initial",
      fingerprint(initialValue),
    );
    const registry = new ResourceRegistry([{ provider, initialVersion }]);
    const coordinator = new ResourceCoordinator(registry);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const workspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    let turn = 0;
    const runner: AgentRunner = {
      run: async (request) => {
        const objectPath = request.resourceBindings?.[0]?.hostPath;
        if (!objectPath)
          throw new Error("Runtime did not receive provider binding");
        if (turn === 0) {
          await writeFile(objectPath, '{"release":"accepted-one"}\n', "utf8");
          await writeFile(
            path.join(request.workspacePath, "accepted.txt"),
            "accepted\n",
          );
        } else if (turn === 1) {
          await writeFile(
            objectPath,
            '{"release":"rejected-future"}\n',
            "utf8",
          );
          await unlink(path.join(request.workspacePath, "AGENTS.md"));
        } else if (request.repairReferencePath) {
          await expect(readFile(objectPath, "utf8")).resolves.toContain(
            "rejected-future",
          );
          await writeFile(
            objectPath,
            '{"release":"repaired-future"}\n',
            "utf8",
          );
          await writeFile(
            path.join(request.workspacePath, "AGENTS.md"),
            await readFile(
              path.join(request.repairReferencePath, "AGENTS.md"),
              "utf8",
            ),
            "utf8",
          );
        } else {
          await writeFile(objectPath, '{"release":"discard-me"}\n', "utf8");
          await unlink(path.join(request.workspacePath, "AGENTS.md"));
        }
        await persistFixtureSession(
          request,
          "thread-phase-eight",
          "turn-" + turn,
        );
        turn += 1;
        return {
          output: "fixture turn " + turn,
          threadId: "thread-phase-eight",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      runner,
      undefined,
      undefined,
      coordinator,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Provider acceptance" });

    const promoted = await service.sendMessage(agent.id, "promote provider");
    const promotedRun = await waitForRun(service, promoted.run.id);
    const acceptedCanonical = await workspaces.readCanonical(agent.id);
    expect(promotedRun.transaction).toMatchObject({
      disposition: "promoted",
      providerResources: [
        {
          providerId: "acceptance-object",
          disposition: "promoted",
          capabilities: { promotionVisibility: "canonical-manifest" },
          validations: [{ name: "object-shape", status: "passed" }],
        },
      ],
    });
    expect(acceptedCanonical.providerVersions).toHaveLength(1);
    expect(
      provider.versions.get(
        acceptedCanonical.providerVersions[0]?.versionId ?? "missing",
      ),
    ).toEqual({ release: "accepted-one" });

    const rejected = await service.sendMessage(agent.id, "reject provider");
    const rejectedRun = await waitForRun(service, rejected.run.id);
    expect(rejectedRun.transaction).toMatchObject({
      disposition: "quarantined",
      providerResources: [
        {
          disposition: "quarantined",
          quarantine: { runId: rejected.run.id },
        },
      ],
    });
    await expect(workspaces.readCanonical(agent.id)).resolves.toEqual(
      acceptedCanonical,
    );

    const repair = await service.repairRun(rejected.run.id);
    const repairedRun = await waitForRun(service, repair.run.id);
    const repairedCanonical = await workspaces.readCanonical(agent.id);
    expect(repairedRun.transaction?.disposition).toBe("promoted");
    expect(
      provider.versions.get(
        repairedCanonical.providerVersions[0]?.versionId ?? "missing",
      ),
    ).toEqual({ release: "repaired-future" });

    const discardCandidate = await service.sendMessage(
      agent.id,
      "reject provider again",
    );
    const discardCandidateRun = await waitForRun(
      service,
      discardCandidate.run.id,
    );
    const quarantineId =
      discardCandidateRun.transaction?.providerResources[0]?.quarantine
        ?.quarantineId;
    expect(provider.quarantines.has(quarantineId ?? "missing")).toBe(true);
    const discarded = await service.discardRun(discardCandidate.run.id);
    expect(discarded.transaction).toMatchObject({
      disposition: "discarded",
      providerResources: [{ disposition: "discarded" }],
    });
    expect(provider.quarantines.has(quarantineId ?? "missing")).toBe(false);
    await expect(workspaces.readCanonical(agent.id)).resolves.toEqual(
      repairedCanonical,
    );
  });

  it("quarantines every Candidate resource when provider Validation fails", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-validation-"),
    );
    temporaryDirectories.push(root);
    const provider = new AcceptanceObjectProvider();
    const initialValue = { release: "canonical" } satisfies JsonValue;
    provider.versions.set("version-initial", initialValue);
    provider.failValidation = true;
    const initialVersion = reference(
      "version-initial",
      fingerprint(initialValue),
    );
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([{ provider, initialVersion }]),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const workspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    const runner: AgentRunner = {
      run: async (request) => {
        const objectPath = request.resourceBindings?.[0]?.hostPath;
        if (!objectPath)
          throw new Error("Runtime did not receive provider binding");
        await writeFile(
          objectPath,
          '{"release":"provider-rejected"}\n',
          "utf8",
        );
        await persistFixtureSession(
          request,
          "thread-validation",
          "provider-rejected",
        );
        return {
          output: "candidate",
          threadId: "thread-validation",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      runner,
      undefined,
      undefined,
      coordinator,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Provider rejection" });
    const canonicalBefore = await workspaces.readCanonical(agent.id);
    const started = await service.sendMessage(agent.id, "provider must reject");
    const rejected = await waitForRun(service, started.run.id);

    expect(rejected).toMatchObject({
      status: "completed",
      transaction: {
        disposition: "quarantined",
        providerResources: [
          {
            disposition: "quarantined",
            quarantine: { runId: started.run.id },
          },
        ],
      },
    });
    expect(
      rejected.transaction?.validations.find(
        (validation) => validation.name === "acceptance-object:object-shape",
      ),
    ).toMatchObject({ status: "failed", required: true });
    expect(
      rejected.transaction?.resources.every(
        (resource) => resource.disposition === "quarantined",
      ),
    ).toBe(true);
    await expect(workspaces.readCanonical(agent.id)).resolves.toEqual(
      canonicalBefore,
    );
  });

  it("turns contradictory provider Promotion evidence into durable recovery error", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-contradiction-"),
    );
    temporaryDirectories.push(root);
    const provider = new AcceptanceObjectProvider();
    const initialValue = { release: "canonical" } satisfies JsonValue;
    provider.versions.set("version-initial", initialValue);
    provider.contradictPromotion = true;
    const initialVersion = reference(
      "version-initial",
      fingerprint(initialValue),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([{ provider, initialVersion }]),
    );
    const workspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    let runtimeCalls = 0;
    const runner: AgentRunner = {
      run: async (request) => {
        runtimeCalls += 1;
        const objectPath = request.resourceBindings?.[0]?.hostPath;
        if (!objectPath)
          throw new Error("Runtime did not receive provider binding");
        await writeFile(objectPath, '{"release":"must-not-install"}\n', "utf8");
        await persistFixtureSession(
          request,
          "thread-contradiction",
          "must-not-install",
        );
        return {
          output: "candidate",
          threadId: "thread-contradiction",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const first = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      runner,
      undefined,
      undefined,
      coordinator,
    );
    await first.initialize();
    const agent = await first.createAgent({ name: "Promotion contradiction" });
    const canonicalBefore = await workspaces.readCanonical(agent.id);
    const started = await first.sendMessage(agent.id, "reject contradiction");
    const failed = await waitForRun(first, started.run.id);
    expect(failed.status).toBe("failed");
    expect(runtimeCalls).toBe(1);

    const restartedCoordinator = new ResourceCoordinator(
      new ResourceRegistry([{ provider, initialVersion }]),
    );
    const restarted = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        restartedCoordinator.initialVersions(),
      ),
      {
        run: async () => {
          runtimeCalls += 1;
          throw new Error("Recovery must not replay Runtime");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      undefined,
      undefined,
      restartedCoordinator,
    );
    await restarted.initialize();

    expect(restarted.getRun(started.run.id)).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        recovery: {
          recoveredAfterRestart: true,
          recoveryError: expect.stringContaining(
            "Installed Resource version contradicts its durable Promotion plan",
          ),
        },
      },
    });
    expect(
      restarted
        .getRun(started.run.id)
        .transaction?.providerResourceEvents.some(
          (event) => event.stage === "promote" && event.status === "failed",
        ),
    ).toBe(true);
    expect(runtimeCalls).toBe(1);
    await expect(workspaces.readCanonical(agent.id)).resolves.toEqual(
      canonicalBefore,
    );
    expect(provider.versions.size).toBe(1);
  });

  it("discards provider Quarantine before expired local state is removed", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-expiry-"),
    );
    temporaryDirectories.push(root);
    const provider = new AcceptanceObjectProvider();
    const initialValue = { release: "canonical" } satisfies JsonValue;
    provider.versions.set("version-initial", initialValue);
    const initialVersion = reference(
      "version-initial",
      fingerprint(initialValue),
    );
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([{ provider, initialVersion }]),
    );
    const configInput = {
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    };
    const config = loadConfig(configInput);
    const workspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    const runner: AgentRunner = {
      run: async (request) => {
        const objectPath = request.resourceBindings?.[0]?.hostPath;
        if (!objectPath)
          throw new Error("Runtime did not receive provider binding");
        await writeFile(objectPath, '{"release":"expired-future"}\n', "utf8");
        await unlink(path.join(request.workspacePath, "AGENTS.md"));
        await persistFixtureSession(request, "thread-expiry", "expired-future");
        return { output: "rejected", threadId: "thread-expiry", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const first = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      runner,
      undefined,
      undefined,
      coordinator,
    );
    await first.initialize();
    const agent = await first.createAgent({ name: "Provider expiry" });
    const canonicalBefore = await workspaces.readCanonical(agent.id);
    const started = await first.sendMessage(
      agent.id,
      "retain a rejected future",
    );
    const rejected = await waitForRun(first, started.run.id);
    const quarantinePath = rejected.transaction?.quarantinePath;
    const quarantineId =
      rejected.transaction?.providerResources[0]?.quarantine?.quarantineId;
    if (!quarantinePath || !quarantineId) {
      throw new Error("Fixture did not retain composite Quarantine");
    }
    expect(provider.quarantines.has(quarantineId)).toBe(true);
    const manifestPath = path.join(quarantinePath, "candidate.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    manifest.createdAt = "2000-01-01T00:00:00.000Z";
    await writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );

    const restartConfig = loadConfig({
      ...configInput,
      AIRLOCK_QUARANTINE_RETENTION_HOURS: "0.000001",
    });
    const restartedCoordinator = new ResourceCoordinator(
      new ResourceRegistry([{ provider, initialVersion }]),
    );
    const restartedWorkspaces = new WorkspaceManager(
      restartConfig.workspaceRoot,
      undefined,
      undefined,
      restartedCoordinator.initialVersions(),
    );
    const failedCleanup = new AgentService(
      restartConfig,
      new JsonStore(path.join(restartConfig.dataDirectory, "db.json")),
      restartedWorkspaces,
      runner,
      undefined,
      undefined,
      restartedCoordinator,
    );
    provider.failDiscard = true;
    await failedCleanup.initialize();
    expect(failedCleanup.getRun(started.run.id).transaction).toMatchObject({
      disposition: "quarantined",
      quarantineAvailable: true,
    });
    await expect(access(quarantinePath)).resolves.toBeUndefined();
    expect(provider.quarantines.has(quarantineId)).toBe(true);

    provider.failDiscard = false;
    const restarted = new AgentService(
      restartConfig,
      new JsonStore(path.join(restartConfig.dataDirectory, "db.json")),
      restartedWorkspaces,
      runner,
      undefined,
      undefined,
      restartedCoordinator,
    );
    await restarted.initialize();

    expect(restarted.getRun(started.run.id).transaction).toMatchObject({
      disposition: "discarded",
      quarantineAvailable: false,
      providerResources: [{ disposition: "discarded" }],
    });
    expect(provider.quarantines.has(quarantineId)).toBe(false);
    expect(provider.discarded.has(started.run.id)).toBe(true);
    await expect(access(quarantinePath)).rejects.toThrow();
    await expect(restartedWorkspaces.readCanonical(agent.id)).resolves.toEqual(
      canonicalBefore,
    );
  });

  it("refuses to bless mutable provider evidence after local Quarantine disappears", async () => {
    const fixture = await createRejectedProviderFixture("discard-interruption");
    const transaction = fixture.rejected.transaction;
    if (!transaction?.quarantinePath) {
      throw new Error("Fixture did not retain a composite Quarantine");
    }
    const internalRunner = (
      fixture.service as unknown as {
        runner: {
          discardProviderQuarantines(
            agentId: string,
            transaction: RunTransaction,
          ): Promise<RunTransaction>;
        };
      }
    ).runner;
    const cleaned = await internalRunner.discardProviderQuarantines(
      fixture.agentId,
      transaction,
    );
    await fixture.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === fixture.runId);
      if (!run) throw new Error("Fixture Run disappeared");
      run.transaction = structuredClone(cleaned);
    });
    await fixture.workspaces.discardQuarantine(fixture.runId);

    const restarted = new AgentService(
      fixture.config,
      new JsonStore(path.join(fixture.config.dataDirectory, "db.json")),
      new WorkspaceManager(
        fixture.config.workspaceRoot,
        undefined,
        undefined,
        fixture.coordinator.initialVersions(),
      ),
      fixture.runtime,
      undefined,
      undefined,
      fixture.coordinator,
    );
    await restarted.initialize();

    expect(restarted.getRun(fixture.runId)).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        disposition: "quarantined",
        quarantineAvailable: false,
        recovery: {
          recoveryError: expect.stringContaining(
            "Authoritative Quarantine is missing",
          ),
        },
      },
    });
  });

  it("recovers when Discard authority exists before interrupted local removal", async () => {
    const fixture = await createRejectedProviderFixture(
      "discard-authority-interruption",
    );
    const quarantinePath = fixture.rejected.transaction?.quarantinePath;
    if (!quarantinePath) {
      throw new Error("Fixture did not retain a composite Quarantine");
    }
    const interrupted = new AgentService(
      fixture.config,
      new JsonStore(path.join(fixture.config.dataDirectory, "db.json")),
      new InterruptedDiscardWorkspace(
        fixture.config.workspaceRoot,
        undefined,
        undefined,
        fixture.coordinator.initialVersions(),
      ),
      fixture.runtime,
      undefined,
      undefined,
      fixture.coordinator,
    );
    await interrupted.initialize();
    await expect(interrupted.discardRun(fixture.runId)).rejects.toThrow(
      "simulated interruption after Discard authority",
    );
    await expect(access(quarantinePath)).resolves.toBeUndefined();
    expect(
      await readdir(
        path.join(
          fixture.config.dataDirectory,
          "portable-decision-journal",
          ".discard-cleanup",
          fixture.runId,
        ),
      ),
    ).toHaveLength(1);

    const restarted = new AgentService(
      fixture.config,
      new JsonStore(path.join(fixture.config.dataDirectory, "db.json")),
      new WorkspaceManager(
        fixture.config.workspaceRoot,
        undefined,
        undefined,
        fixture.coordinator.initialVersions(),
      ),
      fixture.runtime,
      undefined,
      undefined,
      fixture.coordinator,
    );
    await restarted.initialize();

    expect(restarted.getRun(fixture.runId)).toMatchObject({
      status: "failed",
      transaction: {
        status: "discarded",
        disposition: "discarded",
        quarantineAvailable: false,
        recovery: { recoveryError: null },
      },
    });
    await expect(access(quarantinePath)).rejects.toThrow();
  });

  it("fails closed when Discard authority outlives both provider cleanup and its local recovery handle", async () => {
    const fixture = await createRejectedProviderFixture(
      "discard-authority-without-cleanup",
    );
    const quarantinePath = fixture.rejected.transaction?.quarantinePath;
    const providerQuarantineId =
      fixture.rejected.transaction?.providerResources[0]?.quarantine
        ?.quarantineId;
    if (!quarantinePath || !providerQuarantineId) {
      throw new Error("Fixture did not retain a composite Quarantine");
    }

    fixture.provider.failDiscard = true;
    await expect(fixture.service.discardRun(fixture.runId)).rejects.toThrow(
      "evidence-preserving Discard",
    );
    await expect(access(quarantinePath)).resolves.toBeUndefined();
    expect(fixture.provider.quarantines.has(providerQuarantineId)).toBe(true);

    await fixture.workspaces.discardQuarantine(fixture.runId);
    fixture.provider.failDiscard = false;
    const restarted = new AgentService(
      fixture.config,
      new JsonStore(path.join(fixture.config.dataDirectory, "db.json")),
      new WorkspaceManager(
        fixture.config.workspaceRoot,
        undefined,
        undefined,
        fixture.coordinator.initialVersions(),
      ),
      fixture.runtime,
      undefined,
      undefined,
      fixture.coordinator,
    );
    await restarted.initialize();

    expect(restarted.getRun(fixture.runId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("missing provider cleanup evidence"),
      transaction: {
        status: "recovery-error",
        recovery: {
          recoveredAfterRestart: true,
          recoveryError: expect.stringContaining(
            "missing provider cleanup evidence",
          ),
        },
      },
    });
    expect(fixture.provider.quarantines.has(providerQuarantineId)).toBe(true);
    expect(restarted.getAgent(fixture.agentId)).toMatchObject({
      status: "error",
    });
  });

  it.skipIf(process.platform === "win32")(
    "retains local recovery state when provider cleanup fact publication fails",
    async () => {
      const fixture = await createRejectedProviderFixture(
        "discard-cleanup-publication",
      );
      const quarantinePath = fixture.rejected.transaction?.quarantinePath;
      const providerQuarantineId =
        fixture.rejected.transaction?.providerResources[0]?.quarantine
          ?.quarantineId;
      if (!quarantinePath || !providerQuarantineId) {
        throw new Error("Fixture did not retain a composite Quarantine");
      }
      const cleanupRoot = path.join(
        fixture.config.dataDirectory,
        "portable-decision-journal",
        ".discard-cleanup",
      );
      await chmod(cleanupRoot, 0o500);
      try {
        await expect(
          fixture.service.discardRun(fixture.runId),
        ).rejects.toThrow();
      } finally {
        await chmod(cleanupRoot, 0o700);
      }

      expect(fixture.provider.quarantines.has(providerQuarantineId)).toBe(
        false,
      );
      await expect(access(quarantinePath)).resolves.toBeUndefined();
      await expect(
        fixture.service.discardRun(fixture.runId),
      ).resolves.toMatchObject({
        transaction: {
          status: "discarded",
          disposition: "discarded",
        },
      });
      await expect(access(quarantinePath)).rejects.toThrow();
    },
  );

  it("rejects a structurally valid cleanup fact with forged provider coverage", async () => {
    const fixture = await createRejectedProviderFixture(
      "forged-discard-cleanup",
    );
    await fixture.service.discardRun(fixture.runId);
    const cleanupDirectory = path.join(
      fixture.config.dataDirectory,
      "portable-decision-journal",
      ".discard-cleanup",
      fixture.runId,
    );
    const originalName = (await readdir(cleanupDirectory)).find((entry) =>
      entry.endsWith(".json"),
    );
    if (!originalName) throw new Error("Discard cleanup fact is missing");
    const originalPath = path.join(cleanupDirectory, originalName);
    const forged = JSON.parse(await readFile(originalPath, "utf8")) as Record<
      string,
      unknown
    >;
    const events = forged.providerDiscardEvents as Array<
      Record<string, unknown>
    >;
    events[0]!.providerId = "forged-provider";
    const { cleanupDigest: _cleanupDigest, ...unsigned } = forged;
    const forgedDigest = "sha256:" + fingerprint(unsigned);
    forged.cleanupDigest = forgedDigest;
    await unlink(originalPath);
    await writeFile(
      path.join(
        cleanupDirectory,
        forgedDigest.replace("sha256:", "sha256-") + ".json",
      ),
      JSON.stringify(forged) + "\n",
      "utf8",
    );

    const restarted = new AgentService(
      fixture.config,
      new JsonStore(path.join(fixture.config.dataDirectory, "db.json")),
      new WorkspaceManager(
        fixture.config.workspaceRoot,
        undefined,
        undefined,
        fixture.coordinator.initialVersions(),
      ),
      fixture.runtime,
      undefined,
      undefined,
      fixture.coordinator,
    );
    await restarted.initialize();
    expect(restarted.getRun(fixture.runId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("discard provider evidence"),
      transaction: {
        status: "recovery-error",
        recovery: {
          recoveryError: expect.stringContaining("discard provider evidence"),
        },
      },
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves every Quarantine when Discard authority publication fails",
    async () => {
      const fixture = await createRejectedProviderFixture(
        "discard-authority-publication",
      );
      const quarantinePath = fixture.rejected.transaction?.quarantinePath;
      const providerQuarantineId =
        fixture.rejected.transaction?.providerResources[0]?.quarantine
          ?.quarantineId;
      if (!quarantinePath || !providerQuarantineId) {
        throw new Error("Fixture did not retain a composite Quarantine");
      }
      const authorityDirectory = path.join(
        fixture.config.dataDirectory,
        "portable-decision-journal",
        fixture.runId,
      );
      await chmod(authorityDirectory, 0o500);
      try {
        await expect(
          fixture.service.discardRun(fixture.runId),
        ).rejects.toThrow();
      } finally {
        await chmod(authorityDirectory, 0o700);
      }

      expect(fixture.service.getRun(fixture.runId).transaction).toMatchObject({
        disposition: "quarantined",
        quarantineAvailable: true,
        providerResources: [{ disposition: "quarantined" }],
      });
      expect(providerQuarantineId).toBeTruthy();
      expect(fixture.provider.quarantines.has(providerQuarantineId)).toBe(true);
      await expect(access(quarantinePath)).resolves.toBeUndefined();
      expect(
        (await readdir(authorityDirectory)).filter((entry) =>
          entry.endsWith(".json"),
        ),
      ).toHaveLength(1);

      await expect(
        fixture.service.discardRun(fixture.runId),
      ).resolves.toMatchObject({
        transaction: { disposition: "discarded" },
      });
      expect(fixture.provider.quarantines.has(providerQuarantineId)).toBe(
        false,
      );
      await expect(access(quarantinePath)).rejects.toThrow();
    },
  );

  it("fails closed when mutable Quarantine disappears without provider Discard", async () => {
    const fixture = await createRejectedProviderFixture(
      "discard-contradiction",
    );
    const quarantineId =
      fixture.rejected.transaction?.providerResources[0]?.quarantine
        ?.quarantineId;
    if (!quarantineId)
      throw new Error("Fixture did not retain provider Quarantine");
    await fixture.workspaces.discardQuarantine(fixture.runId);

    const restarted = new AgentService(
      fixture.config,
      new JsonStore(path.join(fixture.config.dataDirectory, "db.json")),
      new WorkspaceManager(
        fixture.config.workspaceRoot,
        undefined,
        undefined,
        fixture.coordinator.initialVersions(),
      ),
      fixture.runtime,
      undefined,
      undefined,
      fixture.coordinator,
    );
    await restarted.initialize();

    expect(restarted.getRun(fixture.runId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Authoritative Quarantine is missing"),
      transaction: {
        status: "recovery-error",
        disposition: "quarantined",
        quarantineAvailable: false,
        recovery: {
          recoveredAfterRestart: true,
          recoveryError: expect.stringContaining(
            "Authoritative Quarantine is missing",
          ),
        },
      },
    });
    expect(fixture.provider.quarantines.has(quarantineId)).toBe(true);
    await expect(restarted.deleteAgent(fixture.agentId)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("retained Quarantine"),
    });
    expect(restarted.getAgent(fixture.agentId).id).toBe(fixture.agentId);
    expect(fixture.provider.quarantines.has(quarantineId)).toBe(true);
  });

  it.each([
    "after-validated",
    "after-version-install",
    "after-canonical-advance",
    "after-completed",
  ] as const)(
    "reconciles provider Promotion after a crash at %s",
    async (faultPoint) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "airlock-phase-eight-crash-"),
      );
      temporaryDirectories.push(root);
      const provider = new AcceptanceObjectProvider();
      const initialValue = { release: "canonical" } satisfies JsonValue;
      provider.versions.set("version-initial", initialValue);
      const initialVersion = reference(
        "version-initial",
        fingerprint(initialValue),
      );
      const config = loadConfig({
        NODE_ENV: "test",
        APP_DATA_DIR: path.join(root, "data"),
        AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
        CODEX_HOME: path.join(root, "codex"),
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
      });
      const firstCoordinator = new ResourceCoordinator(
        new ResourceRegistry([{ provider, initialVersion }]),
      );
      const firstWorkspaces = new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        firstCoordinator.initialVersions(),
      );
      const firstRunner: AgentRunner = {
        run: async (request) => {
          const objectPath = request.resourceBindings?.[0]?.hostPath;
          if (!objectPath)
            throw new Error("Runtime did not receive provider binding");
          await writeFile(objectPath, '{"release":"crash-safe"}\n', "utf8");
          await persistFixtureSession(request, "thread-crash", "crash-safe");
          return { output: "prepared", threadId: "thread-crash", usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      };
      let injected = false;
      const firstService = new AgentService(
        config,
        new JsonStore(path.join(config.dataDirectory, "db.json")),
        firstWorkspaces,
        firstRunner,
        undefined,
        (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error("simulated process interruption");
          }
        },
        firstCoordinator,
      );
      await firstService.initialize();
      const agent = await firstService.createAgent({ name: "Crash recovery" });
      const started = await firstService.sendMessage(
        agent.id,
        "promote crash-safe object",
      );
      const interrupted = await waitForRun(firstService, started.run.id);
      expect(interrupted.status).toBe("failed");
      const databaseBeforeRecovery = await readFile(
        path.join(config.dataDirectory, "db.json"),
        "utf8",
      );

      const restartedCoordinator = new ResourceCoordinator(
        new ResourceRegistry([{ provider, initialVersion }]),
      );
      const restartedRunner: AgentRunner = {
        run: async () => {
          throw new Error("Recovery must not execute the Runtime twice");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      };
      const restarted = new AgentService(
        config,
        new JsonStore(path.join(config.dataDirectory, "db.json")),
        new WorkspaceManager(
          config.workspaceRoot,
          undefined,
          undefined,
          restartedCoordinator.initialVersions(),
        ),
        restartedRunner,
        undefined,
        undefined,
        restartedCoordinator,
      );
      await restarted.initialize();
      const recovered = restarted.getRun(started.run.id);
      const canonical = await new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        restartedCoordinator.initialVersions(),
      ).readCanonical(agent.id);
      expect(recovered).toMatchObject({
        status: "completed",
        error: null,
        transaction: {
          disposition: "promoted",
          recovery: { journalPhase: "completed", recoveredAfterRestart: true },
          providerResources: [{ disposition: "promoted" }],
        },
      });
      expect(provider.versions.size).toBe(2);
      expect(
        provider.versions.get(
          canonical.providerVersions[0]?.versionId ?? "missing",
        ),
      ).toEqual({ release: "crash-safe" });

      if (faultPoint === "after-completed") {
        const recoveredProviderEventCount =
          recovered.transaction?.providerResourceEvents.length;
        if (recoveredProviderEventCount === undefined) {
          throw new Error("Recovered Promotion has no provider evidence");
        }
        for (let repeatedCrash = 1; repeatedCrash <= 3; repeatedCrash += 1) {
          await writeFile(
            path.join(config.dataDirectory, "db.json"),
            databaseBeforeRecovery,
            "utf8",
          );
          const repeatedRestart = new AgentService(
            config,
            new JsonStore(path.join(config.dataDirectory, "db.json")),
            new WorkspaceManager(
              config.workspaceRoot,
              undefined,
              undefined,
              restartedCoordinator.initialVersions(),
            ),
            restartedRunner,
            undefined,
            undefined,
            restartedCoordinator,
          );
          await repeatedRestart.initialize();
          expect(repeatedRestart.getRun(started.run.id)).toMatchObject({
            status: "completed",
            error: null,
            transaction: {
              disposition: "promoted",
              recovery: {
                journalPhase: "completed",
                recoveredAfterRestart: true,
                recoveryError: null,
              },
            },
          });
          const journal = JSON.parse(
            await readFile(
              path.join(
                config.dataDirectory,
                "promotion-journal",
                started.run.id + ".json",
              ),
              "utf8",
            ),
          ) as { transaction: RunTransaction };
          expect(journal.transaction.providerResourceEvents).toHaveLength(
            recoveredProviderEventCount,
          );
          expect(provider.versions.size).toBe(2);
        }

        const promotionJournalPath = path.join(
          config.dataDirectory,
          "promotion-journal",
          started.run.id + ".json",
        );
        const accumulatedJournal = JSON.parse(
          await readFile(promotionJournalPath, "utf8"),
        ) as { transaction: RunTransaction };
        const providerCount =
          accumulatedJournal.transaction.providerResources.length;
        const priorRecoveryBatch =
          accumulatedJournal.transaction.providerResourceEvents.slice(
            -providerCount,
          );
        for (let batch = 1; batch <= 2; batch += 1) {
          for (const event of priorRecoveryBatch) {
            accumulatedJournal.transaction.providerResourceEvents.push({
              ...structuredClone(event),
              at: new Date(Date.parse(event.at) + batch).toISOString(),
            });
          }
        }
        await writeFile(
          promotionJournalPath,
          JSON.stringify(accumulatedJournal, null, 2) + "\n",
          "utf8",
        );
        await writeFile(
          path.join(config.dataDirectory, "db.json"),
          databaseBeforeRecovery,
          "utf8",
        );
        const compatibilityRestart = new AgentService(
          config,
          new JsonStore(path.join(config.dataDirectory, "db.json")),
          new WorkspaceManager(
            config.workspaceRoot,
            undefined,
            undefined,
            restartedCoordinator.initialVersions(),
          ),
          restartedRunner,
          undefined,
          undefined,
          restartedCoordinator,
        );
        await compatibilityRestart.initialize();
        expect(compatibilityRestart.getRun(started.run.id)).toMatchObject({
          status: "completed",
          error: null,
          transaction: {
            disposition: "promoted",
            recovery: {
              journalPhase: "completed",
              recoveredAfterRestart: true,
              recoveryError: null,
            },
          },
        });
        expect(provider.versions.size).toBe(2);

        const targetVersion = canonical.providerVersions[0];
        if (!targetVersion) {
          throw new Error("Recovered Promotion has no provider target version");
        }
        const installedValue = provider.versions.get(targetVersion.versionId);
        if (installedValue === undefined) {
          throw new Error("Recovered provider target is unavailable");
        }
        provider.versions.delete(targetVersion.versionId);
        await writeFile(
          path.join(config.dataDirectory, "db.json"),
          databaseBeforeRecovery,
          "utf8",
        );
        const failedVerificationRestart = new AgentService(
          config,
          new JsonStore(path.join(config.dataDirectory, "db.json")),
          new WorkspaceManager(
            config.workspaceRoot,
            undefined,
            undefined,
            restartedCoordinator.initialVersions(),
          ),
          restartedRunner,
          undefined,
          undefined,
          restartedCoordinator,
        );
        await failedVerificationRestart.initialize();
        expect(failedVerificationRestart.getRun(started.run.id)).toMatchObject({
          status: "failed",
          error: expect.stringContaining(
            "Resource reconciliation result contradicts",
          ),
          transaction: {
            status: "promoted",
            recovery: {
              journalPhase: "completed",
              recoveredAfterRestart: true,
              recoveryError: null,
            },
          },
        });
        const failedJournal = JSON.parse(
          await readFile(promotionJournalPath, "utf8"),
        ) as { transaction: RunTransaction };
        expect(failedJournal.transaction.providerResourceEvents).toHaveLength(
          accumulatedJournal.transaction.providerResourceEvents.length,
        );
        expect(failedJournal.transaction).toMatchObject({
          status: "recovery-error",
          recovery: {
            journalPhase: "completed",
            recoveredAfterRestart: true,
            recoveryError: expect.stringContaining(
              "Resource reconciliation result contradicts",
            ),
          },
        });

        provider.versions.set(targetVersion.versionId, installedValue);
        const recoveredVerificationRestart = new AgentService(
          config,
          new JsonStore(path.join(config.dataDirectory, "db.json")),
          new WorkspaceManager(
            config.workspaceRoot,
            undefined,
            undefined,
            restartedCoordinator.initialVersions(),
          ),
          restartedRunner,
          undefined,
          undefined,
          restartedCoordinator,
        );
        await recoveredVerificationRestart.initialize();
        expect(
          recoveredVerificationRestart.getRun(started.run.id),
        ).toMatchObject({
          status: "completed",
          error: null,
          transaction: {
            status: "promoted",
            disposition: "promoted",
            recovery: {
              journalPhase: "completed",
              recoveredAfterRestart: true,
              recoveryError: null,
            },
          },
        });
        const normalizedJournal = JSON.parse(
          await readFile(promotionJournalPath, "utf8"),
        ) as { transaction: RunTransaction };
        expect(normalizedJournal.transaction).toMatchObject({
          status: "promoted",
          recovery: {
            journalPhase: "completed",
            recoveredAfterRestart: true,
            recoveryError: null,
          },
        });
        expect(
          normalizedJournal.transaction.providerResourceEvents,
        ).toHaveLength(
          accumulatedJournal.transaction.providerResourceEvents.length,
        );
      }
    },
  );

  it("replaces repeated predecessor recovery fragments", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eight-partial-recovery-"),
    );
    temporaryDirectories.push(root);
    const providers = [
      new AcceptanceObjectProvider("provider-a", "kind-a", "Provider A"),
      new AcceptanceObjectProvider("provider-b", "kind-b", "Provider B"),
    ];
    const entries = providers.map((provider, index) => {
      const value = { release: "canonical-" + provider.manifest.providerId };
      const versionId = "version-" + String(index + 1);
      provider.versions.set(versionId, value);
      return {
        provider,
        initialVersion: reference(
          versionId,
          fingerprint(value),
          provider.manifest.providerId,
          provider.manifest.resourceKind,
        ),
      };
    });
    const coordinator = new ResourceCoordinator(new ResourceRegistry(entries));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    let runtimeCalls = 0;
    const runtime: AgentRunner = {
      run: async (request) => {
        runtimeCalls += 1;
        for (const binding of request.resourceBindings ?? []) {
          await writeFile(
            binding.hostPath,
            JSON.stringify({ release: "candidate-" + binding.providerId }) +
              "\n",
            "utf8",
          );
        }
        await persistFixtureSession(
          request,
          "thread-partial-recovery",
          "partial-recovery",
        );
        return {
          output: "prepared",
          threadId: "thread-partial-recovery",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    let injected = false;
    const first = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        coordinator.initialVersions(),
      ),
      runtime,
      undefined,
      (point) => {
        if (!injected && point === "after-completed") {
          injected = true;
          throw new Error("simulated predecessor recovery interruption");
        }
      },
      coordinator,
    );
    await first.initialize();
    const agent = await first.createAgent({
      name: "Partial provider recovery compatibility",
    });
    const started = await first.sendMessage(
      agent.id,
      "promote before a partial recovery replay",
    );
    await waitForRunStatus(first, started.run.id, "failed");
    expect(runtimeCalls).toBe(1);

    const journalPath = path.join(
      config.dataDirectory,
      "promotion-journal",
      started.run.id + ".json",
    );
    const predecessorJournal = JSON.parse(
      await readFile(journalPath, "utf8"),
    ) as {
      transaction: RunTransaction;
      plan: { resourcePlans: ResourcePromotionPlan[] };
      targetCanonical: { providerVersions: ResourceVersionReference[] };
    };
    const baselineEventCount =
      predecessorJournal.transaction.providerResourceEvents.length;
    const providerBResource =
      predecessorJournal.transaction.providerResources.find(
        (resource) => resource.providerId === "provider-b",
      );
    const providerBVersionId = providerBResource?.installedVersion?.versionId;
    if (!providerBVersionId) {
      throw new Error("Provider B Promotion version is missing");
    }
    const providerBValue = providers[1]?.versions.get(providerBVersionId);
    if (providerBValue === undefined) {
      throw new Error("Provider B Promotion value is missing");
    }
    providers[1]!.versions.delete(providerBVersionId);
    const predecessorEvents: RunTransaction["providerResourceEvents"] = [];
    await expect(
      coordinator.reconcile({
        agentId: agent.id,
        runId: started.run.id,
        plans: predecessorJournal.plan.resourcePlans,
        expectedVersions: predecessorJournal.targetCanonical.providerVersions,
        visibility: "canonical-manifest",
        providerIds: ["provider-a", "provider-b"],
        onEvent: (event) => {
          predecessorEvents.push(event);
        },
      }),
    ).rejects.toThrow("Resource reconciliation result contradicts");
    expect(
      predecessorEvents.map((event) => [event.providerId, event.status]),
    ).toEqual([
      ["provider-a", "passed"],
      ["provider-b", "failed"],
    ]);
    const repeatedFailedAttempt = predecessorEvents.map((event) => ({
      ...structuredClone(event),
      at: new Date(Date.parse(event.at) + 1).toISOString(),
    }));
    predecessorJournal.transaction.providerResourceEvents.push(
      ...predecessorEvents,
      ...repeatedFailedAttempt,
      {
        ...structuredClone(predecessorEvents[0]!),
        at: new Date(Date.parse(predecessorEvents[0]!.at) + 2).toISOString(),
      },
      {
        ...structuredClone(predecessorEvents[0]!),
        at: new Date(Date.parse(predecessorEvents[0]!.at) + 3).toISOString(),
      },
    );
    predecessorJournal.transaction.status = "recovery-error";
    predecessorJournal.transaction.recovery.recoveredAfterRestart = true;
    predecessorJournal.transaction.recovery.recoveryError =
      "Promotion recovery failed: predecessor provider verification failed";
    expect(
      predecessorJournal.transaction.providerResourceEvents
        .slice(-6)
        .map((event) => [event.providerId, event.status]),
    ).toEqual([
      ["provider-a", "passed"],
      ["provider-b", "failed"],
      ["provider-a", "passed"],
      ["provider-b", "failed"],
      ["provider-a", "passed"],
      ["provider-a", "passed"],
    ]);
    await writeFile(
      journalPath,
      JSON.stringify(predecessorJournal, null, 2) + "\n",
      "utf8",
    );
    providers[1]!.versions.set(providerBVersionId, providerBValue);

    const recoveryOnlyRuntime: AgentRunner = {
      run: async () => {
        runtimeCalls += 1;
        throw new Error("Recovery must not execute Runtime twice");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };

    const restarted = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(
        config.workspaceRoot,
        undefined,
        undefined,
        coordinator.initialVersions(),
      ),
      recoveryOnlyRuntime,
      undefined,
      undefined,
      coordinator,
    );
    await restarted.initialize();
    expect(restarted.getRun(started.run.id)).toMatchObject({
      status: "completed",
      error: null,
      transaction: {
        status: "promoted",
        disposition: "promoted",
        recovery: {
          journalPhase: "completed",
          recoveredAfterRestart: true,
          recoveryError: null,
        },
      },
    });
    const repairedJournal = JSON.parse(await readFile(journalPath, "utf8")) as {
      transaction: RunTransaction;
    };
    expect(repairedJournal.transaction.providerResourceEvents).toHaveLength(
      baselineEventCount + providers.length,
    );
    expect(
      repairedJournal.transaction.providerResourceEvents
        .slice(-providers.length)
        .map((event) => [event.providerId, event.status]),
    ).toEqual([
      ["provider-a", "passed"],
      ["provider-b", "passed"],
    ]);
    expect(runtimeCalls).toBe(1);
  });
});

async function createRejectedProviderFixture(label: string) {
  const root = await mkdtemp(
    path.join(tmpdir(), "airlock-phase-eight-" + label + "-"),
  );
  temporaryDirectories.push(root);
  const provider = new AcceptanceObjectProvider();
  const initialValue = { release: "canonical" } satisfies JsonValue;
  provider.versions.set("version-initial", initialValue);
  const initialVersion = reference(
    "version-initial",
    fingerprint(initialValue),
  );
  const coordinator = new ResourceCoordinator(
    new ResourceRegistry([{ provider, initialVersion }]),
  );
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(config.dataDirectory, "db.json"));
  const workspaces = new WorkspaceManager(
    config.workspaceRoot,
    undefined,
    undefined,
    coordinator.initialVersions(),
  );
  const runtime: AgentRunner = {
    run: async (request) => {
      const objectPath = request.resourceBindings?.[0]?.hostPath;
      if (!objectPath)
        throw new Error("Runtime did not receive provider binding");
      await writeFile(objectPath, '{"release":"rejected-discard"}\n', "utf8");
      await unlink(path.join(request.workspacePath, "AGENTS.md"));
      await persistFixtureSession(request, "thread-discard", label);
      return { output: "rejected", threadId: "thread-discard", usage: null };
    },
    cancel: async () => false,
    isAvailable: async () => true,
  };
  const service = new AgentService(
    config,
    store,
    workspaces,
    runtime,
    undefined,
    undefined,
    coordinator,
  );
  await service.initialize();
  const agent = await service.createAgent({ name: "Discard recovery" });
  const started = await service.sendMessage(agent.id, "retain rejected future");
  const rejected = await waitForRun(service, started.run.id);
  expect(rejected.transaction).toMatchObject({
    disposition: "quarantined",
    quarantineAvailable: true,
  });
  return {
    config,
    coordinator,
    provider,
    rejected,
    runId: started.run.id,
    agentId: agent.id,
    runtime,
    service,
    store,
    workspaces,
  };
}

async function waitForRun(service: AgentService, runId: string) {
  return waitForRunToFinish(service, runId);
}

function reference(
  versionId: string,
  versionFingerprint: string,
  providerId = "acceptance-object",
  resourceKind = "json-object",
): ResourceVersionReference {
  return {
    schemaVersion: 1,
    providerId,
    resourceKind,
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
