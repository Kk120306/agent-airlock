import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  parseResourceVersionReference,
  redactSensitiveText,
  type ResourcePromotionPlan,
  type ResourceVersionReference,
} from "@agent-airlock/transactional-resource-sdk";
import { SqliteResource } from "./sqlite-resource.js";
import type { Agent, CanonicalStateReference } from "./types.js";

interface CanonicalManifestV1 {
  schemaVersion: 1;
  agentId: string;
  stateId: string;
  workspacePath: string;
  contentHash: string;
  createdAt: string;
  sourceRunId: string | null;
}

type CanonicalManifestV2 = Omit<
  CanonicalStateReference,
  "outboxPath" | "sqliteContentHash" | "outboxContentHash" | "providerVersions"
> & {
  schemaVersion: 2;
  agentId: string;
  createdAt: string;
  sourceRunId: string | null;
};

interface CanonicalManifestV3
  extends Omit<CanonicalStateReference, "providerVersions"> {
  schemaVersion: 3;
  agentId: string;
  createdAt: string;
  sourceRunId: string | null;
}

interface CanonicalManifestV4 extends CanonicalStateReference {
  schemaVersion: 4;
  agentId: string;
  createdAt: string;
  sourceRunId: string | null;
}

interface CandidateManifestV4 {
  schemaVersion: 4;
  agentId: string;
  runId: string;
  candidateStateId: string;
  canonicalStateIdBefore: string;
  canonicalContentHashBefore: string;
  canonicalWorkspaceHashBefore: string;
  canonicalSessionHashBefore: string;
  canonicalSqliteHashBefore: string;
  canonicalOutboxHashBefore: string;
  canonicalProviderVersionsBefore: ResourceVersionReference[];
  canonicalThreadIdBefore: string | null;
  candidateThreadId: string | null;
  repairSourceRunId: string | null;
  repairReferenceHash: string | null;
  createdAt: string;
}

export interface CandidateStateReference {
  candidateStateId: string;
  workspacePath: string;
  codexHomePath: string;
  outboxPath: string;
  canonicalStateIdBefore: string;
  canonicalContentHashBefore: string;
  canonicalWorkspaceHashBefore: string;
  canonicalSessionHashBefore: string;
  canonicalSqliteHashBefore: string;
  canonicalOutboxHashBefore: string;
  canonicalProviderVersionsBefore: ResourceVersionReference[];
  canonicalThreadIdBefore: string | null;
  runtimeThreadId: string | null;
  repairReferencePath: string | null;
}

export interface PromotionPlan {
  runId: string;
  agentId: string;
  targetStateId: string;
  targetThreadId: string | null;
  sourceStateId: string;
  sourceContentHash: string;
  sourceWorkspaceHash: string;
  sourceSessionHash: string;
  sourceSqliteHash: string;
  sourceOutboxHash: string;
  sourceProviderVersions: ResourceVersionReference[];
  targetProviderVersions: ResourceVersionReference[];
  resourcePlans: ResourcePromotionPlan[];
  sourceThreadId: string | null;
}

export interface InterruptedCandidateResult {
  quarantinePath: string | null;
  error: string | null;
}

export interface StateCleanupResult {
  candidateRunIds: string[];
  quarantineRunIds: string[];
  errors: string[];
}

export interface StateCleanupEntry {
  kind: "candidate" | "quarantine";
  runId: string;
  root: string;
}

export interface ProviderRegistryDescriptor {
  providerId: string;
  resourceKind: string;
  manifestFingerprint: string;
}

export interface ProviderRegistryVerification {
  providerId: string;
  resourceKind: string;
  versionId: string;
  fingerprint: string;
  summary: string;
}

export type ProviderRegistryFaultPoint =
  | "after-plan"
  | "after-install"
  | "after-manifest";

export type ProviderRegistryFaultInjector = (
  point: ProviderRegistryFaultPoint,
  agentId: string,
) => void | Promise<void>;

interface ProviderRegistryStateV1 {
  schemaVersion: 1;
  generation: number;
  providers: ProviderRegistryDescriptor[];
  updatedAt: string;
}

interface ProviderRegistryTransitionV1 {
  schemaVersion: 1;
  transitionId: string;
  agentId: string;
  generation: number;
  phase: "planned" | "installed";
  sourceStateId: string;
  sourceContentHash: string;
  targetStateId: string;
  targetContentHash: string | null;
  sourceProviderVersions: ResourceVersionReference[];
  targetProviderVersions: ResourceVersionReference[];
  verifications: ProviderRegistryVerification[];
  createdAt: string;
}

const providerRegistryTransitionKeys = [
  "schemaVersion",
  "transitionId",
  "agentId",
  "generation",
  "phase",
  "sourceStateId",
  "sourceContentHash",
  "targetStateId",
  "targetContentHash",
  "sourceProviderVersions",
  "targetProviderVersions",
  "verifications",
  "createdAt",
] as const;

const providerRegistryVerificationKeys = [
  "providerId",
  "resourceKind",
  "versionId",
  "fingerprint",
  "summary",
] as const;

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const now = () => new Date().toISOString();
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class WorkspaceManager {
  private readonly initialProviderVersions: ResourceVersionReference[];

  constructor(
    private readonly root: string,
    private readonly codexTemplateHome?: string,
    private readonly sqlite = new SqliteResource(),
    initialProviderVersions: readonly ResourceVersionReference[] = [],
    private readonly providerRegistryFaultInjector?: ProviderRegistryFaultInjector,
  ) {
    this.initialProviderVersions = normalizeProviderVersions(initialProviderVersions);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await Promise.all([
      mkdir(path.join(this.root, ".candidates"), { recursive: true }),
      mkdir(path.join(this.root, ".deleted"), { recursive: true }),
      mkdir(path.join(this.root, ".migrations"), { recursive: true }),
      mkdir(path.join(this.root, ".quarantine"), { recursive: true }),
      mkdir(this.providerRegistryTransitionRoot(), { recursive: true }),
    ]);
    await this.recoverProviderRegistryTransitions();
  }

  async create(agent: Agent): Promise<CanonicalStateReference> {
    const stateId = randomUUID();
    const workspacePath = this.versionWorkspacePath(agent.id, stateId);
    const codexHomePath = this.versionCodexHomePath(agent.id, stateId);
    const outboxPath = this.versionOutboxPath(agent.id, stateId);
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(codexHomePath, { recursive: true }),
      mkdir(outboxPath, { recursive: true }),
    ]);
    await this.writeInstructionsAt(workspacePath, agent);
    await this.sqlite.seed(workspacePath);
    await writeFile(
      path.join(workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
    await this.seedCodexHome(codexHomePath);
    return this.publishInitialState(
      agent.id,
      stateId,
      workspacePath,
      codexHomePath,
      null,
      null,
    );
  }

  async ensureCanonical(agent: Agent): Promise<CanonicalStateReference> {
    const canonical = await this.ensureCanonicalForProviderTransition(agent);
    this.assertConfiguredProviderSet(canonical.providerVersions);
    return canonical;
  }

  async ensureCanonicalForProviderTransition(
    agent: Agent,
  ): Promise<CanonicalStateReference> {
    const manifestPath = this.canonicalManifestPath(agent.id);
    if (await fileExists(manifestPath)) {
      const raw = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as
        | CanonicalManifestV1
        | CanonicalManifestV2
        | CanonicalManifestV3
        | CanonicalManifestV4;
      if (manifest.schemaVersion === 1) {
        return this.migrateCanonicalManifest(agent, manifest);
      }
      if (manifest.schemaVersion === 2) {
        return this.migratePhaseFourManifest(agent, manifest);
      }
      if (manifest.schemaVersion === 3) {
        return this.migratePhaseEightManifest(agent, manifest);
      }
      return this.readCanonicalForProviderTransition(agent.id);
    }

    const legacyPath = agent.workspacePath;
    if (!legacyPath || !(await fileExists(legacyPath))) {
      throw new Error("Canonical workspace is missing for Agent " + agent.id);
    }

    const migrationPath = path.join(
      this.root,
      ".migrations",
      agent.id + "-" + randomUUID(),
    );
    const agentRoot = this.agentRoot(agent.id);
    const legacyIsAgentRoot = path.resolve(legacyPath) === path.resolve(agentRoot);
    if (legacyIsAgentRoot) {
      await rename(legacyPath, migrationPath);
    } else {
      await cp(legacyPath, migrationPath, {
        recursive: true,
        preserveTimestamps: true,
      });
    }

    const stateId = randomUUID();
    const workspacePath = this.versionWorkspacePath(agent.id, stateId);
    const codexHomePath = this.versionCodexHomePath(agent.id, stateId);
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await rename(migrationPath, workspacePath);
    await this.sqlite.seed(workspacePath);
    await Promise.all([
      mkdir(codexHomePath, { recursive: true }),
      mkdir(this.versionOutboxPath(agent.id, stateId), { recursive: true }),
    ]);
    await this.seedCodexHome(codexHomePath);
    const preservedThread = await this.copyLegacySession(
      agent.codexThreadId,
      codexHomePath,
    );
    return this.publishInitialState(
      agent.id,
      stateId,
      workspacePath,
      codexHomePath,
      preservedThread ? agent.codexThreadId : null,
      null,
      [],
    );
  }

  async readCanonical(agentId: string): Promise<CanonicalStateReference> {
    const canonical = await this.readCanonicalForProviderTransition(agentId);
    this.assertConfiguredProviderSet(canonical.providerVersions);
    return canonical;
  }

  async readCanonicalForProviderTransition(
    agentId: string,
  ): Promise<CanonicalStateReference> {
    const raw = await readFile(this.canonicalManifestPath(agentId), "utf8");
    const manifest = JSON.parse(raw) as CanonicalManifestV4;
    if (
      manifest.schemaVersion !== 4 ||
      manifest.agentId !== agentId ||
      typeof manifest.stateId !== "string" ||
      typeof manifest.workspacePath !== "string" ||
      typeof manifest.codexHomePath !== "string" ||
      typeof manifest.outboxPath !== "string" ||
      (manifest.codexThreadId !== null && typeof manifest.codexThreadId !== "string") ||
      typeof manifest.workspaceContentHash !== "string" ||
      typeof manifest.sessionContentHash !== "string" ||
      typeof manifest.sqliteContentHash !== "string" ||
      typeof manifest.outboxContentHash !== "string" ||
      !Array.isArray(manifest.providerVersions) ||
      typeof manifest.contentHash !== "string"
    ) {
      throw new Error("Invalid canonical manifest for Agent " + agentId);
    }
    const expectedWorkspace = this.versionWorkspacePath(agentId, manifest.stateId);
    const expectedCodexHome = this.versionCodexHomePath(agentId, manifest.stateId);
    const expectedOutbox = this.versionOutboxPath(agentId, manifest.stateId);
    if (
      path.resolve(manifest.workspacePath) !== path.resolve(expectedWorkspace) ||
      path.resolve(manifest.codexHomePath) !== path.resolve(expectedCodexHome) ||
      path.resolve(manifest.outboxPath) !== path.resolve(expectedOutbox)
    ) {
      throw new Error("Canonical manifest contains an unexpected resource path");
    }
    await Promise.all([
      access(expectedWorkspace),
      access(expectedCodexHome),
      access(expectedOutbox),
    ]);
    const providerVersions = normalizeProviderVersions(manifest.providerVersions);
    const actual = await this.buildStateReference(
      agentId,
      manifest.stateId,
      manifest.codexThreadId,
      providerVersions,
    );
    if (
      actual.workspaceContentHash !== manifest.workspaceContentHash ||
      actual.sessionContentHash !== manifest.sessionContentHash ||
      actual.sqliteContentHash !== manifest.sqliteContentHash ||
      actual.outboxContentHash !== manifest.outboxContentHash ||
      !sameProviderVersions(actual.providerVersions, providerVersions) ||
      actual.contentHash !== manifest.contentHash
    ) {
      throw new Error("Canonical State content does not match its immutable manifest");
    }
    return actual;
  }

  providerVersionsToOnboard(
    currentVersions: readonly ResourceVersionReference[],
  ): ResourceVersionReference[] {
    const current = normalizeProviderVersions(currentVersions);
    const configured = this.initialProviderVersions;
    const configuredIdentity = new Map(
      configured.map((version) => [version.providerId, version.resourceKind]),
    );
    for (const version of current) {
      if (configuredIdentity.get(version.providerId) !== version.resourceKind) {
        throw new Error(
          "Configured Resource Provider removal or identity replacement requires an explicit export-and-retire migration",
        );
      }
    }
    const currentIds = new Set(current.map((version) => version.providerId));
    return configured
      .filter((version) => !currentIds.has(version.providerId))
      .map((version) => structuredClone(version));
  }

  async transitionProviderRegistry(
    agent: Agent,
    current: CanonicalStateReference,
    verifications: readonly ProviderRegistryVerification[],
    generation: number,
  ): Promise<CanonicalStateReference> {
    const additions = this.providerVersionsToOnboard(current.providerVersions);
    if (additions.length === 0) {
      this.assertConfiguredProviderSet(current.providerVersions);
      return current;
    }
    if (!Number.isInteger(generation) || generation < 1) {
      throw new Error("Resource Provider registry generation must be positive");
    }
    const verificationById = new Map(
      verifications.map((verification) => [verification.providerId, verification]),
    );
    for (const addition of additions) {
      const verification = verificationById.get(addition.providerId);
      if (
        !verification ||
        verification.resourceKind !== addition.resourceKind ||
        verification.versionId !== addition.versionId ||
        verification.fingerprint !== addition.fingerprint
      ) {
        throw new Error(
          "Resource Provider onboarding lacks exact immutable source verification for " +
            addition.providerId,
        );
      }
    }
    const latest = await this.readCanonicalForProviderTransition(agent.id);
    this.assertCanonicalReferencesEqual(latest, current);
    const targetProviderVersions = normalizeProviderVersions([
      ...current.providerVersions,
      ...additions,
    ]);
    const transitionDigest = createHash("sha256")
      .update(
        stableJson({
          agentId: agent.id,
          generation,
          sourceStateId: current.stateId,
          sourceContentHash: current.contentHash,
          targetProviderVersions,
        }),
      )
      .digest("hex");
    const transitionId = "registry-" + transitionDigest;
    const targetStateId = "registry-" + transitionDigest.slice(0, 32);
    const journal: ProviderRegistryTransitionV1 = {
      schemaVersion: 1,
      transitionId,
      agentId: agent.id,
      generation,
      phase: "planned",
      sourceStateId: current.stateId,
      sourceContentHash: current.contentHash,
      targetStateId,
      targetContentHash: null,
      sourceProviderVersions: structuredClone(current.providerVersions),
      targetProviderVersions,
      verifications: additions.map((addition) =>
        structuredClone(verificationById.get(addition.providerId)!),
      ),
      createdAt: now(),
    };
    const journalPath = this.providerRegistryTransitionPath(agent.id);
    await this.writeJsonAtomically(journalPath, journal);
    await this.providerRegistryFaultInjector?.("after-plan", agent.id);
    const targetRoot = this.versionRoot(agent.id, targetStateId);
    await rm(targetRoot, { recursive: true, force: true });
    await mkdir(path.dirname(targetRoot), { recursive: true });
    await cp(this.versionRoot(agent.id, current.stateId), targetRoot, {
      recursive: true,
      preserveTimestamps: true,
    });
    const target = await this.buildStateReference(
      agent.id,
      targetStateId,
      current.codexThreadId,
      targetProviderVersions,
    );
    journal.phase = "installed";
    journal.targetContentHash = target.contentHash;
    await this.writeJsonAtomically(journalPath, journal);
    await this.providerRegistryFaultInjector?.("after-install", agent.id);
    await this.replaceCanonicalManifest(agent.id, {
      schemaVersion: 4,
      agentId: agent.id,
      ...target,
      createdAt: now(),
      sourceRunId: transitionId,
    });
    await this.providerRegistryFaultInjector?.("after-manifest", agent.id);
    await rm(journalPath, { force: true });
    return target;
  }

  async nextProviderRegistryGeneration(
    descriptors: readonly ProviderRegistryDescriptor[],
  ): Promise<number> {
    const current = await this.readProviderRegistryState();
    this.assertAdditiveRegistryDescriptors(current.providers, descriptors);
    return sameProviderRegistryDescriptors(current.providers, descriptors)
      ? current.generation
      : current.generation + 1;
  }

  async commitProviderRegistryGeneration(
    descriptors: readonly ProviderRegistryDescriptor[],
    generation: number,
  ): Promise<void> {
    const normalized = normalizeProviderRegistryDescriptors(descriptors);
    const current = await this.readProviderRegistryState();
    this.assertAdditiveRegistryDescriptors(current.providers, normalized);
    const expectedGeneration = sameProviderRegistryDescriptors(
      current.providers,
      normalized,
    )
      ? current.generation
      : current.generation + 1;
    if (generation !== expectedGeneration) {
      throw new Error("Resource Provider registry generation changed concurrently");
    }
    await this.writeJsonAtomically(this.providerRegistryStatePath(), {
      schemaVersion: 1,
      generation,
      providers: normalized,
      updatedAt: now(),
    } satisfies ProviderRegistryStateV1);
  }

  async prepareCandidate(
    agentId: string,
    runId: string,
  ): Promise<CandidateStateReference> {
    const canonical = await this.readCanonical(agentId);
    const root = this.candidateRoot(runId);
    if (await fileExists(root)) {
      throw new Error("Candidate State already exists for Run " + runId);
    }
    const candidateStateId = randomUUID();
    const workspacePath = path.join(root, "workspace");
    const codexHomePath = path.join(root, "codex-home");
    const outboxDirectory = path.join(root, "outbox");
    const outboxPath = path.join(outboxDirectory, "intents.jsonl");
    await mkdir(root, { recursive: false });
    try {
      await Promise.all([
        cp(canonical.workspacePath, workspacePath, {
          recursive: true,
          preserveTimestamps: true,
        }),
        cp(canonical.codexHomePath, codexHomePath, {
          recursive: true,
          preserveTimestamps: true,
        }),
        mkdir(outboxDirectory, { recursive: true }),
        mkdir(path.join(root, "resources"), { recursive: true }),
      ]);
      await this.refreshCodexConfig(codexHomePath);
      const manifest: CandidateManifestV4 = {
        schemaVersion: 4,
        agentId,
        runId,
        candidateStateId,
        canonicalStateIdBefore: canonical.stateId,
        canonicalContentHashBefore: canonical.contentHash,
        canonicalWorkspaceHashBefore: canonical.workspaceContentHash,
        canonicalSessionHashBefore: canonical.sessionContentHash,
        canonicalSqliteHashBefore: canonical.sqliteContentHash,
        canonicalOutboxHashBefore: canonical.outboxContentHash,
        canonicalProviderVersionsBefore: structuredClone(canonical.providerVersions),
        canonicalThreadIdBefore: canonical.codexThreadId,
        candidateThreadId: canonical.codexThreadId,
        repairSourceRunId: null,
        repairReferenceHash: null,
        createdAt: now(),
      };
      await this.writeJson(path.join(root, "candidate.json"), manifest);
      return {
        candidateStateId,
        workspacePath,
        codexHomePath,
        outboxPath,
        canonicalStateIdBefore: canonical.stateId,
        canonicalContentHashBefore: canonical.contentHash,
        canonicalWorkspaceHashBefore: canonical.workspaceContentHash,
        canonicalSessionHashBefore: canonical.sessionContentHash,
        canonicalSqliteHashBefore: canonical.sqliteContentHash,
        canonicalOutboxHashBefore: canonical.outboxContentHash,
        canonicalProviderVersionsBefore: structuredClone(canonical.providerVersions),
        canonicalThreadIdBefore: canonical.codexThreadId,
        runtimeThreadId: canonical.codexThreadId,
        repairReferencePath: null,
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async prepareRepairCandidate(
    agentId: string,
    sourceRunId: string,
    runId: string,
  ): Promise<CandidateStateReference> {
    const sourceRoot = await this.resolveQuarantineRoot(sourceRunId);
    const source = await this.readCandidateAt(sourceRoot, sourceRunId);
    if (source.agentId !== agentId) {
      throw new Error("Quarantine belongs to a different Agent");
    }
    const canonical = await this.readCanonical(agentId);
    if (
      canonical.stateId !== source.canonicalStateIdBefore ||
      canonical.contentHash !== source.canonicalContentHashBefore ||
      canonical.workspaceContentHash !== source.canonicalWorkspaceHashBefore ||
      canonical.sessionContentHash !== source.canonicalSessionHashBefore ||
      canonical.sqliteContentHash !== source.canonicalSqliteHashBefore ||
      canonical.outboxContentHash !== source.canonicalOutboxHashBefore ||
      !sameProviderVersions(
        canonical.providerVersions,
        source.canonicalProviderVersionsBefore,
      ) ||
      canonical.codexThreadId !== source.canonicalThreadIdBefore
    ) {
      throw new Error(
        "Canonical State advanced after this Quarantine; start a new Run against current reality",
      );
    }

    const root = this.candidateRoot(runId);
    if (await fileExists(root)) {
      throw new Error("Candidate State already exists for Run " + runId);
    }
    const candidateStateId = randomUUID();
    const workspacePath = path.join(root, "workspace");
    const codexHomePath = path.join(root, "codex-home");
    const outboxDirectory = path.join(root, "outbox");
    const outboxPath = path.join(outboxDirectory, "intents.jsonl");
    const repairReferencePath = path.join(root, "repair-reference");
    await mkdir(root, { recursive: false });
    try {
      await Promise.all([
        cp(path.join(sourceRoot, "workspace"), workspacePath, {
          recursive: true,
          preserveTimestamps: true,
        }),
        cp(path.join(sourceRoot, "codex-home"), codexHomePath, {
          recursive: true,
          preserveTimestamps: true,
        }),
        cp(canonical.workspacePath, repairReferencePath, {
          recursive: true,
          preserveTimestamps: true,
        }),
        mkdir(outboxDirectory, { recursive: true }),
        mkdir(path.join(root, "resources"), { recursive: true }),
      ]);
      await this.refreshCodexConfig(codexHomePath);
      const manifest: CandidateManifestV4 = {
        schemaVersion: 4,
        agentId,
        runId,
        candidateStateId,
        canonicalStateIdBefore: canonical.stateId,
        canonicalContentHashBefore: canonical.contentHash,
        canonicalWorkspaceHashBefore: canonical.workspaceContentHash,
        canonicalSessionHashBefore: canonical.sessionContentHash,
        canonicalSqliteHashBefore: canonical.sqliteContentHash,
        canonicalOutboxHashBefore: canonical.outboxContentHash,
        canonicalProviderVersionsBefore: structuredClone(canonical.providerVersions),
        canonicalThreadIdBefore: canonical.codexThreadId,
        candidateThreadId: source.candidateThreadId ?? canonical.codexThreadId,
        repairSourceRunId: sourceRunId,
        repairReferenceHash: canonical.workspaceContentHash,
        createdAt: now(),
      };
      await this.writeJson(path.join(root, "candidate.json"), manifest);
      return {
        candidateStateId,
        workspacePath,
        codexHomePath,
        outboxPath,
        canonicalStateIdBefore: canonical.stateId,
        canonicalContentHashBefore: canonical.contentHash,
        canonicalWorkspaceHashBefore: canonical.workspaceContentHash,
        canonicalSessionHashBefore: canonical.sessionContentHash,
        canonicalSqliteHashBefore: canonical.sqliteContentHash,
        canonicalOutboxHashBefore: canonical.outboxContentHash,
        canonicalProviderVersionsBefore: structuredClone(canonical.providerVersions),
        canonicalThreadIdBefore: canonical.codexThreadId,
        runtimeThreadId: manifest.candidateThreadId,
        repairReferencePath,
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async recordCandidateThread(runId: string, threadId: string | null): Promise<void> {
    const manifest = await this.readCandidate(runId);
    if (threadId && !(await this.hasSessionArtifact(this.candidateCodexPath(runId), threadId))) {
      throw new Error(
        "Codex returned thread " + threadId + " without a Candidate session artifact",
      );
    }
    manifest.candidateThreadId = threadId;
    await this.writeJson(path.join(this.candidateRoot(runId), "candidate.json"), manifest);
  }

  async promoteCandidate(
    agentId: string,
    runId: string,
  ): Promise<CanonicalStateReference> {
    const plan = await this.planPromotion(agentId, runId);
    const installed = await this.installPromotion(plan);
    return this.advancePromotion(plan, installed);
  }

  async planPromotion(
    agentId: string,
    runId: string,
    targetProviderVersions?: readonly ResourceVersionReference[],
    resourcePlans: readonly ResourcePromotionPlan[] = [],
  ): Promise<PromotionPlan> {
    const candidate = await this.readCandidate(runId);
    if (candidate.agentId !== agentId) {
      throw new Error("Candidate State belongs to a different Agent");
    }
    const current = await this.readCanonical(agentId);
    if (
      current.stateId !== candidate.canonicalStateIdBefore ||
      current.contentHash !== candidate.canonicalContentHashBefore ||
      current.workspaceContentHash !== candidate.canonicalWorkspaceHashBefore ||
      current.sessionContentHash !== candidate.canonicalSessionHashBefore ||
      current.sqliteContentHash !== candidate.canonicalSqliteHashBefore ||
      current.outboxContentHash !== candidate.canonicalOutboxHashBefore ||
      !sameProviderVersions(
        current.providerVersions,
        candidate.canonicalProviderVersionsBefore,
      ) ||
      current.codexThreadId !== candidate.canonicalThreadIdBefore
    ) {
      throw new Error("Canonical State changed while the Run Transaction was active");
    }

    await Promise.all([
      this.assertResourceTreeSafe(
        this.candidateCodexPath(runId),
        "Candidate Codex session",
      ),
      this.assertResourceTreeSafe(
        path.join(this.candidateRoot(runId), "outbox"),
        "Candidate outbox",
      ),
    ]);
    const normalizedTargets = normalizeProviderVersions(
      targetProviderVersions ?? current.providerVersions,
    );
    this.assertConfiguredProviderSet(normalizedTargets);
    return {
      runId,
      agentId,
      targetStateId: candidate.candidateStateId,
      targetThreadId: candidate.candidateThreadId,
      sourceStateId: current.stateId,
      sourceContentHash: current.contentHash,
      sourceWorkspaceHash: current.workspaceContentHash,
      sourceSessionHash: current.sessionContentHash,
      sourceSqliteHash: current.sqliteContentHash,
      sourceOutboxHash: current.outboxContentHash,
      sourceProviderVersions: structuredClone(current.providerVersions),
      targetProviderVersions: normalizedTargets,
      resourcePlans: resourcePlans.map((plan) => structuredClone(plan)),
      sourceThreadId: current.codexThreadId,
    };
  }

  async installPromotion(plan: PromotionPlan): Promise<CanonicalStateReference> {
    this.assertPromotionPlanIdentifiers(plan);
    const candidateRoot = this.candidateRoot(plan.runId);
    const destinationRoot = this.versionRoot(plan.agentId, plan.targetStateId);
    const candidateExists = await fileExists(candidateRoot);
    const versionExists = await fileExists(destinationRoot);
    if (candidateExists && versionExists) {
      throw new Error("Promotion has both Candidate and installed version state");
    }
    if (!candidateExists && !versionExists) {
      throw new Error("Promotion has neither Candidate nor installed version state");
    }

    if (candidateExists) {
      const candidate = await this.readCandidateAt(
        candidateRoot,
        plan.runId,
        plan.sourceProviderVersions,
      );
      this.assertCandidateMatchesPlan(candidate, plan);
      await Promise.all([
        this.assertResourceTreeSafe(
          this.candidateCodexPath(plan.runId),
          "Candidate Codex session",
        ),
        this.assertResourceTreeSafe(
          path.join(candidateRoot, "outbox"),
          "Candidate outbox",
        ),
        this.assertResourceTreeSafe(
          path.join(candidateRoot, "resources"),
          "Candidate Resource Provider state",
        ),
      ]);
      await rm(path.join(candidateRoot, "repair-reference"), {
        recursive: true,
        force: true,
      });
    }
    await mkdir(path.dirname(destinationRoot), { recursive: true });
    if (candidateExists) await rename(candidateRoot, destinationRoot);

    const stats = await lstat(destinationRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Installed Promotion state is not a safe directory");
    }
    const installedManifest = await this.readCandidateAt(
      destinationRoot,
      plan.runId,
      plan.sourceProviderVersions,
    );
    this.assertCandidateMatchesPlan(installedManifest, plan);
    const installed = await this.buildStateReference(
      plan.agentId,
      plan.targetStateId,
      plan.targetThreadId,
      plan.targetProviderVersions,
    );
    if (installed.stateId !== plan.targetStateId) {
      throw new Error("Installed Promotion state identifier does not match its plan");
    }
    return installed;
  }

  async verifyInstalledPromotion(
    plan: PromotionPlan,
    expected: CanonicalStateReference,
  ): Promise<CanonicalStateReference> {
    const installed = await this.installPromotion(plan);
    this.assertCanonicalReferencesEqual(installed, expected);
    return installed;
  }

  async advancePromotion(
    plan: PromotionPlan,
    installed: CanonicalStateReference,
  ): Promise<CanonicalStateReference> {
    this.assertPromotionPlanIdentifiers(plan);
    if (installed.stateId !== plan.targetStateId) {
      throw new Error("Installed Promotion state does not match the target plan");
    }
    const verifiedInstalled = await this.buildStateReference(
      plan.agentId,
      plan.targetStateId,
      plan.targetThreadId,
      plan.targetProviderVersions,
    );
    this.assertCanonicalReferencesEqual(verifiedInstalled, installed);
    const current = await this.readCanonicalForProviderTransition(plan.agentId);
    if (current.stateId === plan.targetStateId) {
      this.assertCanonicalReferencesEqual(current, installed);
      const raw = JSON.parse(
        await readFile(this.canonicalManifestPath(plan.agentId), "utf8"),
      ) as CanonicalManifestV4;
      if (raw.sourceRunId !== plan.runId) {
        throw new Error("Canonical target belongs to a different Run Transaction");
      }
      return current;
    }
    this.assertSourceMatchesPlan(current, plan);
    await this.replaceCanonicalManifest(plan.agentId, {
      schemaVersion: 4,
      agentId: plan.agentId,
      ...installed,
      createdAt: now(),
      sourceRunId: plan.runId,
    });
    return this.readCanonicalForProviderTransition(plan.agentId);
  }

  async quarantineCandidate(
    runId: string,
    allowHistoricalProviderSubset = false,
  ): Promise<string> {
    const source = this.candidateRoot(runId);
    await this.readCandidateAt(
      source,
      runId,
      allowHistoricalProviderSubset ? null : undefined,
    );
    const destination = this.quarantineRoot(runId);
    if (await fileExists(destination)) {
      throw new Error("Quarantine already exists for Run " + runId);
    }
    await rename(source, destination);
    return destination;
  }

  async cancelCandidate(runId: string): Promise<void> {
    if (!(await fileExists(this.candidateRoot(runId)))) return;
    const root = await this.resolveCandidateRoot(runId);
    await rm(root, { recursive: true, force: false });
  }

  async quarantineInterruptedCandidate(
    runId: string,
  ): Promise<InterruptedCandidateResult> {
    if (!(await fileExists(this.candidateRoot(runId)))) {
      return { quarantinePath: null, error: null };
    }
    try {
      return {
        quarantinePath: await this.quarantineCandidate(runId, true),
        error: null,
      };
    } catch (error) {
      return {
        quarantinePath: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async discardQuarantine(runId: string): Promise<boolean> {
    const root = this.quarantineRoot(runId);
    if (!(await fileExists(root))) return false;
    await this.resolveQuarantineRoot(runId, null);
    await rm(root, { recursive: true, force: false });
    return true;
  }

  async quarantineExists(runId: string): Promise<boolean> {
    if (!safeIdentifierPattern.test(runId)) {
      throw new Error("Unsafe Quarantine identifier");
    }
    const root = this.quarantineRoot(runId);
    if (!(await fileExists(root))) return false;
    await this.resolveQuarantineRoot(runId, null);
    return true;
  }

  async retainedProviderIds(
    runId: string,
    retainedStateRoot: string,
  ): Promise<string[]> {
    this.assertIdentifier(runId, "Run");
    const resolved = path.resolve(retainedStateRoot);
    let root: string;
    if (resolved === path.resolve(this.candidateRoot(runId))) {
      root = await this.resolveCandidateRoot(runId, null);
    } else if (resolved === path.resolve(this.quarantineRoot(runId))) {
      root = await this.resolveQuarantineRoot(runId, null);
    } else {
      throw new Error("Retained provider state path is outside the Run Transaction");
    }
    const candidate = await this.readCandidateAt(root, runId, null);
    return candidate.canonicalProviderVersionsBefore.map(
      (version) => version.providerId,
    );
  }

  async repairReferenceEvidence(
    runId: string,
  ): Promise<{ status: "passed" | "failed" | "error"; summary: string } | null> {
    const candidate = await this.readCandidate(runId);
    if (!candidate.repairReferenceHash) return null;
    try {
      const referencePath = await this.resolveCandidatePath(runId, "repair-reference");
      const actualHash = await this.contentHash(referencePath);
      return actualHash === candidate.repairReferenceHash
        ? {
            status: "passed",
            summary: "The bounded Canonical repair reference remained unchanged",
          }
        : {
            status: "failed",
            summary: "The bounded Canonical repair reference was modified",
          };
    } catch {
      return {
        status: "error",
        summary: "The bounded Canonical repair reference could not be verified",
      };
    }
  }

  async cleanupExpiredState(options: {
    candidateOlderThan: string;
    quarantineOlderThan: string;
    protectedRunIds: Set<string>;
    beforeRemove?: (entry: StateCleanupEntry) => Promise<void>;
  }): Promise<StateCleanupResult> {
    const result: StateCleanupResult = {
      candidateRunIds: [],
      quarantineRunIds: [],
      errors: [],
    };
    const candidateCutoff = Date.parse(options.candidateOlderThan);
    const quarantineCutoff = Date.parse(options.quarantineOlderThan);
    if (!Number.isFinite(candidateCutoff) || !Number.isFinite(quarantineCutoff)) {
      throw new Error("State retention cutoffs must be valid ISO timestamps");
    }
    const scan = async (
      kind: "candidate" | "quarantine",
      cutoff: number,
      removed: string[],
    ) => {
      const base = path.join(
        this.root,
        kind === "candidate" ? ".candidates" : ".quarantine",
      );
      const entries = await readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        const runId = entry.name;
        if (options.protectedRunIds.has(runId)) continue;
        if (!safeIdentifierPattern.test(runId)) {
          result.errors.push("Ignored unsafe retention entry " + runId);
          continue;
        }
        try {
          const root = path.join(base, runId);
          const stats = await lstat(root);
          if (!entry.isDirectory() || !stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error("entry is not a safe directory");
          }
          const manifest = await this.readCandidateAt(root, runId, null);
          const createdAt = Date.parse(manifest.createdAt);
          if (!Number.isFinite(createdAt)) {
            throw new Error("candidate manifest has an invalid creation time");
          }
          if (createdAt >= cutoff) continue;
          if (kind === "candidate") {
            await this.resolveCandidateRoot(runId, null);
          } else {
            await this.resolveQuarantineRoot(runId, null);
          }
          await options.beforeRemove?.({ kind, runId, root });
          await rm(root, { recursive: true, force: false });
          removed.push(runId);
        } catch (error) {
          result.errors.push(
            "Could not clean " +
              kind +
              " " +
              runId +
              ": " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    };
    await scan("candidate", candidateCutoff, result.candidateRunIds);
    await scan("quarantine", quarantineCutoff, result.quarantineRunIds);
    return result;
  }

  async candidateHasPath(runId: string, relativePath: string): Promise<boolean> {
    const candidate = await this.readCandidate(runId);
    const workspacePath = path.join(this.candidateRoot(runId), "workspace");
    const target = path.resolve(workspacePath, relativePath);
    const relative = path.relative(workspacePath, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Candidate path escapes Candidate State");
    }
    if (candidate.runId !== runId) {
      throw new Error("Invalid Candidate State manifest");
    }
    return fileExists(target);
  }

  async candidateWorkspacePath(runId: string): Promise<string> {
    await this.readCandidate(runId);
    return this.resolveCandidatePath(runId, "workspace");
  }

  async candidateCodexHomePath(runId: string): Promise<string> {
    await this.readCandidate(runId);
    return this.resolveCandidatePath(runId, "codex-home");
  }

  async candidateOutboxPath(runId: string): Promise<string> {
    await this.readCandidate(runId);
    const outboxDirectory = await this.resolveCandidatePath(runId, "outbox");
    return path.join(outboxDirectory, "intents.jsonl");
  }

  async candidateResourcesPath(runId: string): Promise<string> {
    await this.readCandidate(runId);
    return this.resolveCandidatePath(runId, "resources");
  }

  async installedResourcesPath(agentId: string, stateId: string): Promise<string> {
    const versionRoot = await realpath(this.versionRoot(agentId, stateId));
    const resourcesPath = await realpath(path.join(versionRoot, "resources"));
    const relative = path.relative(versionRoot, resourcesPath);
    if (relative !== "resources") {
      throw new Error("Installed Resource Provider path escapes the version root");
    }
    return resourcesPath;
  }

  async promotionResourcesPath(plan: PromotionPlan): Promise<string> {
    this.assertPromotionPlanIdentifiers(plan);
    if (await fileExists(this.candidateRoot(plan.runId))) {
      const root = await this.resolveCandidateRoot(
        plan.runId,
        plan.sourceProviderVersions,
      );
      return path.join(root, "resources");
    }
    if (await fileExists(this.versionRoot(plan.agentId, plan.targetStateId))) {
      return this.installedResourcesPath(plan.agentId, plan.targetStateId);
    }
    throw new Error("Promotion has no recoverable Resource Provider state");
  }

  async updateInstructions(agent: Agent): Promise<CanonicalStateReference> {
    const runId = "config-" + randomUUID();
    const candidate = await this.prepareCandidate(agent.id, runId);
    try {
      await this.writeInstructionsAt(candidate.workspacePath, agent);
      return await this.promoteCandidate(agent.id, runId);
    } catch (error) {
      await this.cancelCandidate(runId);
      throw error;
    }
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(this.root, ".deleted", agent.id + "-" + timestamp);
    await rename(this.agentRoot(agent.id), destination);
    return destination;
  }

  async contentHash(rootPath: string): Promise<string> {
    const hash = createHash("sha256");
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(rootPath, absolute).split(path.sep).join("/");
        const stats = await lstat(absolute);
        if (stats.isDirectory()) {
          hash.update("directory\0" + relative + "\0");
          await visit(absolute);
        } else if (stats.isSymbolicLink()) {
          hash.update(
            "symlink\0" + relative + "\0" + (await readlink(absolute)) + "\0",
          );
        } else if (stats.isFile()) {
          hash.update("file\0" + relative + "\0" + stats.size + "\0");
          for await (const chunk of createReadStream(absolute)) hash.update(chunk);
          hash.update("\0");
        } else {
          throw new Error("Unsupported state entry: " + relative);
        }
      }
    };
    await visit(rootPath);
    return "sha256:" + hash.digest("hex");
  }

  private async migrateCanonicalManifest(
    agent: Agent,
    manifest: CanonicalManifestV1,
  ): Promise<CanonicalStateReference> {
    if (
      manifest.agentId !== agent.id ||
      typeof manifest.stateId !== "string" ||
      path.resolve(manifest.workspacePath) !==
        path.resolve(this.versionWorkspacePath(agent.id, manifest.stateId))
    ) {
      throw new Error("Invalid schema 1 canonical manifest for Agent " + agent.id);
    }
    const codexHomePath = this.versionCodexHomePath(agent.id, manifest.stateId);
    await Promise.all([
      mkdir(codexHomePath, { recursive: true }),
      mkdir(this.versionOutboxPath(agent.id, manifest.stateId), {
        recursive: true,
      }),
    ]);
    await this.sqlite.seed(manifest.workspacePath);
    await this.seedCodexHome(codexHomePath);
    const preservedThread = await this.copyLegacySession(
      agent.codexThreadId,
      codexHomePath,
    );
    const canonical = await this.buildStateReference(
      agent.id,
      manifest.stateId,
      preservedThread ? agent.codexThreadId : null,
      [],
    );
    await this.replaceCanonicalManifest(agent.id, {
      schemaVersion: 4,
      agentId: agent.id,
      ...canonical,
      createdAt: manifest.createdAt,
      sourceRunId: manifest.sourceRunId,
    });
    return canonical;
  }

  private async migratePhaseFourManifest(
    agent: Agent,
    manifest: CanonicalManifestV2,
  ): Promise<CanonicalStateReference> {
    if (
      manifest.agentId !== agent.id ||
      typeof manifest.stateId !== "string" ||
      path.resolve(manifest.workspacePath) !==
        path.resolve(this.versionWorkspacePath(agent.id, manifest.stateId))
    ) {
      throw new Error("Invalid schema 2 canonical manifest for Agent " + agent.id);
    }
    await this.sqlite.seed(manifest.workspacePath);
    await mkdir(this.versionOutboxPath(agent.id, manifest.stateId), {
      recursive: true,
    });
    const canonical = await this.buildStateReference(
      agent.id,
      manifest.stateId,
      manifest.codexThreadId,
      [],
    );
    await this.replaceCanonicalManifest(agent.id, {
      schemaVersion: 4,
      agentId: agent.id,
      ...canonical,
      createdAt: manifest.createdAt,
      sourceRunId: manifest.sourceRunId,
    });
    return canonical;
  }

  private async migratePhaseEightManifest(
    agent: Agent,
    manifest: CanonicalManifestV3,
  ): Promise<CanonicalStateReference> {
    if (
      manifest.agentId !== agent.id ||
      typeof manifest.stateId !== "string" ||
      path.resolve(manifest.workspacePath) !==
        path.resolve(this.versionWorkspacePath(agent.id, manifest.stateId))
    ) {
      throw new Error("Invalid schema 3 canonical manifest for Agent " + agent.id);
    }
    const legacy = await this.buildStateReference(
      agent.id,
      manifest.stateId,
      manifest.codexThreadId,
      [],
    );
    if (
      legacy.contentHash !== manifest.contentHash ||
      legacy.workspaceContentHash !== manifest.workspaceContentHash ||
      legacy.sessionContentHash !== manifest.sessionContentHash ||
      legacy.sqliteContentHash !== manifest.sqliteContentHash ||
      legacy.outboxContentHash !== manifest.outboxContentHash
    ) {
      throw new Error("Schema 3 Canonical State does not match its immutable manifest");
    }
    const canonical = await this.buildStateReference(
      agent.id,
      manifest.stateId,
      manifest.codexThreadId,
      [],
    );
    await this.replaceCanonicalManifest(agent.id, {
      schemaVersion: 4,
      agentId: agent.id,
      ...canonical,
      createdAt: manifest.createdAt,
      sourceRunId: manifest.sourceRunId,
    });
    return canonical;
  }

  private async publishInitialState(
    agentId: string,
    stateId: string,
    workspacePath: string,
    codexHomePath: string,
    codexThreadId: string | null,
    sourceRunId: string | null,
    providerVersions: readonly ResourceVersionReference[] = this.initialProviderVersions,
  ): Promise<CanonicalStateReference> {
    const canonical = await this.buildStateReference(
      agentId,
      stateId,
      codexThreadId,
      providerVersions,
    );
    if (
      path.resolve(canonical.workspacePath) !== path.resolve(workspacePath) ||
      path.resolve(canonical.codexHomePath) !== path.resolve(codexHomePath)
    ) {
      throw new Error("Initial Canonical State paths do not match the version layout");
    }
    await this.replaceCanonicalManifest(agentId, {
      schemaVersion: 4,
      agentId,
      ...canonical,
      createdAt: now(),
      sourceRunId,
    });
    return canonical;
  }

  private async buildStateReference(
    agentId: string,
    stateId: string,
    codexThreadId: string | null,
    providerVersions: readonly ResourceVersionReference[] = this.initialProviderVersions,
  ): Promise<CanonicalStateReference> {
    const workspacePath = this.versionWorkspacePath(agentId, stateId);
    const codexHomePath = this.versionCodexHomePath(agentId, stateId);
    const outboxPath = this.versionOutboxPath(agentId, stateId);
    const [
      workspaceContentHash,
      sessionContentHash,
      sqliteSnapshot,
      outboxContentHash,
    ] = await Promise.all([
      this.contentHash(workspacePath),
      this.contentHash(codexHomePath),
      this.sqlite.inspect(workspacePath),
      this.contentHash(outboxPath),
    ]);
    const sqliteContentHash = sqliteSnapshot.contentHash;
    const normalizedProviderVersions = normalizeProviderVersions(providerVersions);
    const legacyFingerprintInput = {
      workspaceContentHash,
      sessionContentHash,
      sqliteContentHash,
      outboxContentHash,
      codexThreadId,
    };
    const fingerprintInput =
      normalizedProviderVersions.length === 0
        ? JSON.stringify(legacyFingerprintInput)
        : stableJson({
            ...legacyFingerprintInput,
            providerVersions: normalizedProviderVersions,
          });
    const contentHash =
      "sha256:" +
      createHash("sha256")
        .update(fingerprintInput)
        .digest("hex");
    return {
      stateId,
      workspacePath,
      codexHomePath,
      outboxPath,
      codexThreadId,
      workspaceContentHash,
      sessionContentHash,
      sqliteContentHash,
      outboxContentHash,
      providerVersions: normalizedProviderVersions,
      contentHash,
    };
  }

  private async readCandidate(runId: string): Promise<CandidateManifestV4> {
    return this.readCandidateAt(this.candidateRoot(runId), runId);
  }

  private async readCandidateAt(
    root: string,
    runId: string,
    expectedProviderVersions: readonly ResourceVersionReference[] | null | undefined =
      undefined,
  ): Promise<CandidateManifestV4> {
    const raw = await readFile(
      path.join(root, "candidate.json"),
      "utf8",
    );
    const manifest = JSON.parse(raw) as CandidateManifestV4;
    if (
      manifest.schemaVersion !== 4 ||
      manifest.runId !== runId ||
      typeof manifest.agentId !== "string" ||
      typeof manifest.candidateStateId !== "string" ||
      typeof manifest.canonicalStateIdBefore !== "string" ||
      typeof manifest.canonicalContentHashBefore !== "string" ||
      typeof manifest.canonicalWorkspaceHashBefore !== "string" ||
      typeof manifest.canonicalSessionHashBefore !== "string" ||
      typeof manifest.canonicalSqliteHashBefore !== "string" ||
      typeof manifest.canonicalOutboxHashBefore !== "string" ||
      !Array.isArray(manifest.canonicalProviderVersionsBefore) ||
      (manifest.canonicalThreadIdBefore !== null &&
        typeof manifest.canonicalThreadIdBefore !== "string") ||
      (manifest.candidateThreadId !== null &&
        typeof manifest.candidateThreadId !== "string") ||
      (manifest.repairSourceRunId !== undefined &&
        manifest.repairSourceRunId !== null &&
        typeof manifest.repairSourceRunId !== "string") ||
      (manifest.repairReferenceHash !== undefined &&
        manifest.repairReferenceHash !== null &&
        typeof manifest.repairReferenceHash !== "string") ||
      typeof manifest.createdAt !== "string"
    ) {
      throw new Error("Invalid Candidate State manifest for Run " + runId);
    }
    const canonicalProviderVersionsBefore = normalizeProviderVersions(
      manifest.canonicalProviderVersionsBefore,
    );
    if (expectedProviderVersions === null) {
      this.assertHistoricalProviderSubset(canonicalProviderVersionsBefore);
    } else if (expectedProviderVersions === undefined) {
      this.assertConfiguredProviderSet(canonicalProviderVersionsBefore);
    } else {
      const expected = normalizeProviderVersions(expectedProviderVersions);
      if (!sameProviderVersions(canonicalProviderVersionsBefore, expected)) {
        throw new Error(
          "Candidate Resource Provider set does not match its expected registry generation",
        );
      }
    }
    return {
      ...manifest,
      canonicalProviderVersionsBefore,
      repairSourceRunId: manifest.repairSourceRunId ?? null,
      repairReferenceHash: manifest.repairReferenceHash ?? null,
    };
  }

  private async replaceCanonicalManifest(
    agentId: string,
    manifest: CanonicalManifestV4,
  ): Promise<void> {
    const target = this.canonicalManifestPath(agentId);
    const temporary = target + "." + randomUUID() + ".tmp";
    await mkdir(path.dirname(target), { recursive: true });
    await this.writeJson(temporary, manifest);
    await rename(temporary, target);
  }

  private async seedCodexHome(codexHomePath: string): Promise<void> {
    await mkdir(codexHomePath, { recursive: true });
    await this.refreshCodexConfig(codexHomePath);
  }

  private async refreshCodexConfig(codexHomePath: string): Promise<void> {
    if (!this.codexTemplateHome) return;
    const source = path.join(this.codexTemplateHome, "config.toml");
    if (!(await fileExists(source))) return;
    const destination = path.join(codexHomePath, "config.toml");
    await rm(destination, { force: true });
    await cp(source, destination, { preserveTimestamps: true });
  }

  private async copyLegacySession(
    threadId: string | null,
    destinationHome: string,
  ): Promise<boolean> {
    if (!threadId || !this.codexTemplateHome) return false;
    const sessionsRoot = path.join(this.codexTemplateHome, "sessions");
    if (!(await fileExists(sessionsRoot))) return false;
    const source = await this.findSessionArtifact(sessionsRoot, threadId);
    if (!source) return false;
    const relative = path.relative(this.codexTemplateHome, source);
    const destination = path.join(destinationHome, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { preserveTimestamps: true });

    const shellSnapshot = path.join(
      this.codexTemplateHome,
      "shell_snapshots",
      threadId + ".sh",
    );
    if (await fileExists(shellSnapshot)) {
      const shellDestination = path.join(
        destinationHome,
        "shell_snapshots",
        threadId + ".sh",
      );
      await mkdir(path.dirname(shellDestination), { recursive: true });
      await cp(shellSnapshot, shellDestination, { preserveTimestamps: true });
    }
    return true;
  }

  private async hasSessionArtifact(
    codexHomePath: string,
    threadId: string,
  ): Promise<boolean> {
    const sessionsRoot = path.join(codexHomePath, "sessions");
    if (!(await fileExists(sessionsRoot))) return false;
    return (await this.findSessionArtifact(sessionsRoot, threadId)) !== null;
  }

  private async findSessionArtifact(
    directory: string,
    threadId: string,
  ): Promise<string | null> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.findSessionArtifact(absolute, threadId);
        if (nested) return nested;
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        entry.name.includes(threadId)
      ) {
        return absolute;
      }
    }
    return null;
  }

  private async assertResourceTreeSafe(
    resourcePath: string,
    label: string,
  ): Promise<void> {
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const stats = await lstat(absolute);
        if (stats.isSymbolicLink()) {
          throw new Error(
            label +
              " contains a symbolic link: " +
              path.relative(resourcePath, absolute).split(path.sep).join("/"),
          );
        }
        if (stats.isDirectory()) await visit(absolute);
      }
    };
    await visit(resourcePath);
  }

  private async resolveCandidatePath(
    runId: string,
    resource:
      | "workspace"
      | "codex-home"
      | "outbox"
      | "resources"
      | "repair-reference",
  ): Promise<string> {
    const candidateRoot = await this.resolveCandidateRoot(runId);
    const resourcePath = await realpath(path.join(this.candidateRoot(runId), resource));
    const relative = path.relative(candidateRoot, resourcePath);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative !== resource
    ) {
      throw new Error("Candidate resource escapes the Candidate State root");
    }
    return resourcePath;
  }

  private async resolveCandidateRoot(
    runId: string,
    expectedProviderVersions: readonly ResourceVersionReference[] | null | undefined =
      undefined,
  ): Promise<string> {
    const unresolved = this.candidateRoot(runId);
    const unresolvedStats = await lstat(unresolved);
    if (!unresolvedStats.isDirectory() || unresolvedStats.isSymbolicLink()) {
      throw new Error("Candidate is not a safe directory");
    }
    const candidateBase = await realpath(path.join(this.root, ".candidates"));
    const root = await realpath(unresolved);
    const relative = path.relative(candidateBase, root);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative !== runId) {
      throw new Error("Candidate path escapes the platform-owned root");
    }
    await this.readCandidateAt(root, runId, expectedProviderVersions);
    return root;
  }

  private async resolveQuarantineRoot(
    runId: string,
    expectedProviderVersions: readonly ResourceVersionReference[] | null | undefined =
      undefined,
  ): Promise<string> {
    const unresolved = this.quarantineRoot(runId);
    const unresolvedStats = await lstat(unresolved);
    if (!unresolvedStats.isDirectory() || unresolvedStats.isSymbolicLink()) {
      throw new Error("Quarantine is not a safe directory");
    }
    const quarantineBase = await realpath(path.join(this.root, ".quarantine"));
    const root = await realpath(unresolved);
    const relative = path.relative(quarantineBase, root);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative !== runId) {
      throw new Error("Quarantine path escapes the platform-owned root");
    }
    await this.readCandidateAt(root, runId, expectedProviderVersions);
    return root;
  }

  private assertPromotionPlanIdentifiers(plan: PromotionPlan): void {
    this.assertIdentifier(plan.runId, "Run");
    this.assertIdentifier(plan.agentId, "Agent");
    this.assertIdentifier(plan.targetStateId, "target state");
    this.assertIdentifier(plan.sourceStateId, "source state");
    if (plan.targetStateId === plan.sourceStateId) {
      throw new Error("Promotion target must differ from its source state");
    }
  }

  private assertCandidateMatchesPlan(
    candidate: CandidateManifestV4,
    plan: PromotionPlan,
  ): void {
    if (
      candidate.runId !== plan.runId ||
      candidate.agentId !== plan.agentId ||
      candidate.candidateStateId !== plan.targetStateId ||
      candidate.candidateThreadId !== plan.targetThreadId ||
      candidate.canonicalStateIdBefore !== plan.sourceStateId ||
      candidate.canonicalContentHashBefore !== plan.sourceContentHash ||
      candidate.canonicalWorkspaceHashBefore !== plan.sourceWorkspaceHash ||
      candidate.canonicalSessionHashBefore !== plan.sourceSessionHash ||
      candidate.canonicalSqliteHashBefore !== plan.sourceSqliteHash ||
      candidate.canonicalOutboxHashBefore !== plan.sourceOutboxHash ||
      !sameProviderVersions(
        candidate.canonicalProviderVersionsBefore,
        plan.sourceProviderVersions,
      ) ||
      candidate.canonicalThreadIdBefore !== plan.sourceThreadId
    ) {
      throw new Error("Candidate State does not match its durable Promotion plan");
    }
  }

  private assertSourceMatchesPlan(
    current: CanonicalStateReference,
    plan: PromotionPlan,
  ): void {
    if (
      current.stateId !== plan.sourceStateId ||
      current.contentHash !== plan.sourceContentHash ||
      current.workspaceContentHash !== plan.sourceWorkspaceHash ||
      current.sessionContentHash !== plan.sourceSessionHash ||
      current.sqliteContentHash !== plan.sourceSqliteHash ||
      current.outboxContentHash !== plan.sourceOutboxHash ||
      !sameProviderVersions(current.providerVersions, plan.sourceProviderVersions) ||
      current.codexThreadId !== plan.sourceThreadId
    ) {
      throw new Error("Canonical State contradicts the durable Promotion source");
    }
  }

  private assertCanonicalReferencesEqual(
    actual: CanonicalStateReference,
    expected: CanonicalStateReference,
  ): void {
    if (
      actual.stateId !== expected.stateId ||
      actual.contentHash !== expected.contentHash ||
      actual.workspaceContentHash !== expected.workspaceContentHash ||
      actual.sessionContentHash !== expected.sessionContentHash ||
      actual.sqliteContentHash !== expected.sqliteContentHash ||
      actual.outboxContentHash !== expected.outboxContentHash ||
      !sameProviderVersions(actual.providerVersions, expected.providerVersions) ||
      actual.codexThreadId !== expected.codexThreadId
    ) {
      throw new Error("Installed Promotion state contradicts its durable fingerprint");
    }
  }

  private assertConfiguredProviderSet(
    versions: readonly ResourceVersionReference[],
  ): void {
    const configured = this.initialProviderVersions.map(
      (version) => version.providerId + "\u0000" + version.resourceKind,
    );
    const actual = versions.map(
      (version) => version.providerId + "\u0000" + version.resourceKind,
    );
    if (
      configured.length !== actual.length ||
      configured.some((value, index) => value !== actual[index])
    ) {
      throw new Error(
        "Canonical Resource Provider set does not match the configured registry",
      );
    }
  }

  private assertHistoricalProviderSubset(
    versions: readonly ResourceVersionReference[],
  ): void {
    const configured = new Map(
      this.initialProviderVersions.map((version) => [
        version.providerId,
        version.resourceKind,
      ]),
    );
    for (const version of versions) {
      if (configured.get(version.providerId) !== version.resourceKind) {
        throw new Error(
          "Historical Candidate references a Resource Provider outside the additive registry",
        );
      }
    }
  }

  private assertIdentifier(value: string, label: string): void {
    if (!safeIdentifierPattern.test(value)) {
      throw new Error(label + " identifier is not safe");
    }
  }

  private async writeInstructionsAt(
    workspacePath: string,
    agent: Agent,
  ): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
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
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(workspacePath, "AGENTS.md"), content, "utf8");
  }

  private async recoverProviderRegistryTransitions(): Promise<void> {
    const entries = await readdir(this.providerRegistryTransitionRoot(), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const journalPath = path.join(this.providerRegistryTransitionRoot(), entry.name);
      const journal = await this.readProviderRegistryTransition(journalPath);
      if (entry.name !== journal.agentId + ".json") {
        throw new Error(
          "Resource Provider registry transition filename contradicts its Agent",
        );
      }
      const manifestPath = this.canonicalManifestPath(journal.agentId);
      if (!(await fileExists(manifestPath))) {
        await rm(this.versionRoot(journal.agentId, journal.targetStateId), {
          recursive: true,
          force: true,
        });
        await rm(journalPath, { force: true });
        continue;
      }
      const current = await this.readCanonicalForProviderTransition(journal.agentId);
      if (
        current.stateId === journal.targetStateId &&
        journal.phase === "installed" &&
        current.contentHash === journal.targetContentHash &&
        sameProviderVersions(current.providerVersions, journal.targetProviderVersions)
      ) {
        await rm(journalPath, { force: true });
        continue;
      }
      if (
        current.stateId === journal.sourceStateId &&
        current.contentHash === journal.sourceContentHash &&
        sameProviderVersions(current.providerVersions, journal.sourceProviderVersions)
      ) {
        await rm(this.versionRoot(journal.agentId, journal.targetStateId), {
          recursive: true,
          force: true,
        });
        await rm(journalPath, { force: true });
        continue;
      }
      throw new Error(
        "Resource Provider registry transition contradicts Canonical State for Agent " +
          journal.agentId,
      );
    }
  }

  private async readProviderRegistryTransition(
    target: string,
  ): Promise<ProviderRegistryTransitionV1> {
    const raw = await readFile(target, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 1_048_576) {
      throw new Error("Resource Provider registry transition exceeds 1 MiB");
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid Resource Provider registry transition journal");
    }
    this.assertExactKeys(
      parsed as Record<string, unknown>,
      providerRegistryTransitionKeys,
      "Resource Provider registry transition journal",
    );
    const value = parsed as ProviderRegistryTransitionV1;
    if (
      value.schemaVersion !== 1 ||
      typeof value.transitionId !== "string" ||
      typeof value.agentId !== "string" ||
      !Number.isInteger(value.generation) ||
      value.generation < 1 ||
      (value.phase !== "planned" && value.phase !== "installed") ||
      typeof value.sourceStateId !== "string" ||
      typeof value.sourceContentHash !== "string" ||
      typeof value.targetStateId !== "string" ||
      (value.targetContentHash !== null &&
        typeof value.targetContentHash !== "string") ||
      !Array.isArray(value.sourceProviderVersions) ||
      !Array.isArray(value.targetProviderVersions) ||
      !Array.isArray(value.verifications) ||
      value.verifications.length > 64 ||
      typeof value.createdAt !== "string" ||
      Number.isNaN(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt
    ) {
      throw new Error("Invalid Resource Provider registry transition journal");
    }
    this.assertIdentifier(value.transitionId, "registry transition");
    this.assertIdentifier(value.agentId, "Agent");
    this.assertIdentifier(value.sourceStateId, "source state");
    this.assertIdentifier(value.targetStateId, "target state");
    if (
      value.sourceStateId === value.targetStateId ||
      !/^sha256:[a-f0-9]{64}$/.test(value.sourceContentHash) ||
      (value.phase === "planned" && value.targetContentHash !== null) ||
      (value.phase === "installed" &&
        (value.targetContentHash === null ||
          !/^sha256:[a-f0-9]{64}$/.test(value.targetContentHash)))
    ) {
      throw new Error("Invalid Resource Provider registry transition fingerprints");
    }
    const sourceProviderVersions = normalizeProviderVersions(
      value.sourceProviderVersions,
    );
    const targetProviderVersions = normalizeProviderVersions(
      value.targetProviderVersions,
    );
    this.assertHistoricalProviderSubset(sourceProviderVersions);
    this.assertHistoricalProviderSubset(targetProviderVersions);
    const sourceById = new Map(
      sourceProviderVersions.map((version) => [version.providerId, version]),
    );
    const targetById = new Map(
      targetProviderVersions.map((version) => [version.providerId, version]),
    );
    for (const source of sourceProviderVersions) {
      const targetVersion = targetById.get(source.providerId);
      if (!targetVersion || !sameProviderVersions([source], [targetVersion])) {
        throw new Error(
          "Resource Provider registry transition is not an exact additive evolution",
        );
      }
    }
    const additions = targetProviderVersions.filter(
      (version) => !sourceById.has(version.providerId),
    );
    if (additions.length === 0) {
      throw new Error("Resource Provider registry transition has no additive delta");
    }
    const verifications = value.verifications.map((verification) => {
      if (
        !verification ||
        typeof verification !== "object" ||
        Array.isArray(verification)
      ) {
        throw new Error("Invalid Resource Provider registry verification");
      }
      this.assertExactKeys(
        verification as unknown as Record<string, unknown>,
        providerRegistryVerificationKeys,
        "Resource Provider registry verification",
      );
      if (
        typeof verification.providerId !== "string" ||
        typeof verification.resourceKind !== "string" ||
        typeof verification.versionId !== "string" ||
        !/^[a-f0-9]{64}$/.test(verification.fingerprint) ||
        typeof verification.summary !== "string" ||
        verification.summary.length > 512 ||
        redactSensitiveText(verification.summary) !== verification.summary
      ) {
        throw new Error("Invalid Resource Provider registry verification");
      }
      return structuredClone(verification);
    });
    const verificationById = new Map(
      verifications.map((verification) => [verification.providerId, verification]),
    );
    if (
      verificationById.size !== verifications.length ||
      verificationById.size !== additions.length
    ) {
      throw new Error(
        "Resource Provider registry transition verification set is inconsistent",
      );
    }
    for (const addition of additions) {
      const verification = verificationById.get(addition.providerId);
      if (
        !verification ||
        verification.resourceKind !== addition.resourceKind ||
        verification.versionId !== addition.versionId ||
        verification.fingerprint !== addition.fingerprint
      ) {
        throw new Error(
          "Resource Provider registry transition verification contradicts its additive delta",
        );
      }
    }
    const transitionDigest = createHash("sha256")
      .update(
        stableJson({
          agentId: value.agentId,
          generation: value.generation,
          sourceStateId: value.sourceStateId,
          sourceContentHash: value.sourceContentHash,
          targetProviderVersions,
        }),
      )
      .digest("hex");
    if (
      value.transitionId !== "registry-" + transitionDigest ||
      value.targetStateId !== "registry-" + transitionDigest.slice(0, 32)
    ) {
      throw new Error(
        "Resource Provider registry transition identifiers contradict its durable plan",
      );
    }
    return {
      ...value,
      sourceProviderVersions,
      targetProviderVersions,
      verifications,
    };
  }

  private async readProviderRegistryState(): Promise<ProviderRegistryStateV1> {
    const target = this.providerRegistryStatePath();
    if (!(await fileExists(target))) {
      return {
        schemaVersion: 1,
        generation: 0,
        providers: [],
        updatedAt: new Date(0).toISOString(),
      };
    }
    const raw = await readFile(target, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 262_144) {
      throw new Error("Resource Provider registry state exceeds 256 KiB");
    }
    const value = JSON.parse(raw) as ProviderRegistryStateV1;
    if (
      value.schemaVersion !== 1 ||
      !Number.isInteger(value.generation) ||
      value.generation < 0 ||
      !Array.isArray(value.providers) ||
      value.providers.length > 64 ||
      typeof value.updatedAt !== "string"
    ) {
      throw new Error("Invalid Resource Provider registry state");
    }
    return {
      ...value,
      providers: normalizeProviderRegistryDescriptors(value.providers),
    };
  }

  private assertAdditiveRegistryDescriptors(
    current: readonly ProviderRegistryDescriptor[],
    target: readonly ProviderRegistryDescriptor[],
  ): void {
    const targetById = new Map(target.map((descriptor) => [descriptor.providerId, descriptor]));
    for (const descriptor of current) {
      const next = targetById.get(descriptor.providerId);
      if (
        !next ||
        next.resourceKind !== descriptor.resourceKind ||
        next.manifestFingerprint !== descriptor.manifestFingerprint
      ) {
        throw new Error(
          "Resource Provider removal or contract replacement requires an explicit export-and-retire migration",
        );
      }
    }
  }

  private async writeJsonAtomically(target: string, value: unknown): Promise<void> {
    const temporary = target + "." + randomUUID() + ".tmp";
    await mkdir(path.dirname(target), { recursive: true });
    await this.writeJson(temporary, value);
    await rename(temporary, target);
  }

  private async writeJson(target: string, value: unknown): Promise<void> {
    await writeFile(target, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private assertExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
    label: string,
  ): void {
    const expected = new Set(keys);
    const actual = Object.keys(value);
    if (
      actual.length !== expected.size ||
      actual.some((key) => !expected.has(key)) ||
      keys.some((key) => !(key in value))
    ) {
      throw new Error(label + " has missing or unknown fields");
    }
  }

  private agentRoot(agentId: string): string {
    this.assertIdentifier(agentId, "Agent");
    return path.join(this.root, agentId);
  }

  private canonicalManifestPath(agentId: string): string {
    return path.join(this.agentRoot(agentId), "canonical.json");
  }

  private providerRegistryStatePath(): string {
    return path.join(this.root, ".resource-registry.json");
  }

  private providerRegistryTransitionRoot(): string {
    return path.join(this.root, ".registry-transitions");
  }

  private providerRegistryTransitionPath(agentId: string): string {
    this.assertIdentifier(agentId, "Agent");
    return path.join(this.providerRegistryTransitionRoot(), agentId + ".json");
  }

  private versionRoot(agentId: string, stateId: string): string {
    this.assertIdentifier(stateId, "state");
    return path.join(this.agentRoot(agentId), "versions", stateId);
  }

  private versionWorkspacePath(agentId: string, stateId: string): string {
    return path.join(this.versionRoot(agentId, stateId), "workspace");
  }

  private versionCodexHomePath(agentId: string, stateId: string): string {
    return path.join(this.versionRoot(agentId, stateId), "codex-home");
  }

  private versionOutboxPath(agentId: string, stateId: string): string {
    return path.join(this.versionRoot(agentId, stateId), "outbox");
  }

  private candidateRoot(runId: string): string {
    this.assertIdentifier(runId, "Run");
    return path.join(this.root, ".candidates", runId);
  }

  private candidateCodexPath(runId: string): string {
    return path.join(this.candidateRoot(runId), "codex-home");
  }

  private quarantineRoot(runId: string): string {
    this.assertIdentifier(runId, "Run");
    return path.join(this.root, ".quarantine", runId);
  }
}

function normalizeProviderVersions(
  values: readonly ResourceVersionReference[],
): ResourceVersionReference[] {
  const normalized = values.map((value) => parseResourceVersionReference(value));
  normalized.sort((left, right) =>
    (left.resourceKind + "\u0000" + left.providerId).localeCompare(
      right.resourceKind + "\u0000" + right.providerId,
    ),
  );
  const providerIds = new Set<string>();
  const resourceKinds = new Set<string>();
  for (const version of normalized) {
    if (providerIds.has(version.providerId)) {
      throw new Error("Duplicate Canonical Resource Provider " + version.providerId);
    }
    if (resourceKinds.has(version.resourceKind)) {
      throw new Error("Duplicate Canonical Resource kind " + version.resourceKind);
    }
    providerIds.add(version.providerId);
    resourceKinds.add(version.resourceKind);
  }
  return normalized;
}

function normalizeProviderRegistryDescriptors(
  values: readonly ProviderRegistryDescriptor[],
): ProviderRegistryDescriptor[] {
  const normalized = values.map((value) => {
    if (
      !value ||
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value.providerId) ||
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value.resourceKind) ||
      !/^[a-f0-9]{64}$/.test(value.manifestFingerprint)
    ) {
      throw new Error("Invalid Resource Provider registry descriptor");
    }
    return structuredClone(value);
  });
  normalized.sort((left, right) =>
    (left.resourceKind + "\u0000" + left.providerId).localeCompare(
      right.resourceKind + "\u0000" + right.providerId,
    ),
  );
  const providerIds = new Set<string>();
  const resourceKinds = new Set<string>();
  for (const descriptor of normalized) {
    if (providerIds.has(descriptor.providerId)) {
      throw new Error(
        "Duplicate Resource Provider registry identifier " + descriptor.providerId,
      );
    }
    if (resourceKinds.has(descriptor.resourceKind)) {
      throw new Error(
        "Duplicate Resource Provider registry kind " + descriptor.resourceKind,
      );
    }
    providerIds.add(descriptor.providerId);
    resourceKinds.add(descriptor.resourceKind);
  }
  return normalized;
}

function sameProviderRegistryDescriptors(
  left: readonly ProviderRegistryDescriptor[],
  right: readonly ProviderRegistryDescriptor[],
): boolean {
  const normalizedLeft = normalizeProviderRegistryDescriptors(left);
  const normalizedRight = normalizeProviderRegistryDescriptors(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every(
      (descriptor, index) =>
        descriptor.providerId === normalizedRight[index]?.providerId &&
        descriptor.resourceKind === normalizedRight[index]?.resourceKind &&
        descriptor.manifestFingerprint ===
          normalizedRight[index]?.manifestFingerprint,
    )
  );
}

function sameProviderVersions(
  left: readonly ResourceVersionReference[],
  right: readonly ResourceVersionReference[],
): boolean {
  return stableJson(normalizeProviderVersions(left)) === stableJson(normalizeProviderVersions(right));
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
