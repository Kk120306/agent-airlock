import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResourceVersionReference } from "@agent-airlock/transactional-resource-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultOutcomeContract } from "./outcome-contract.js";
import type { Agent } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Phase 8 canonical manifest migration", () => {
  it("materializes the registry once and preserves its bytes across unchanged restarts", async () => {
    const root = await temporaryRoot();
    const registryPath = path.join(root, ".resource-registry.json");
    const empty = new WorkspaceManager(root);
    await empty.initialize();

    await expect(access(registryPath)).rejects.toThrow();
    await empty.commitProviderRegistryGeneration([], 0);
    await expect(access(registryPath)).resolves.toBeUndefined();

    const materialized = JSON.parse(await readFile(registryPath, "utf8")) as {
      schemaVersion: number;
      generation: number;
      providers: unknown[];
      updatedAt: string;
    };
    expect(materialized).toMatchObject({
      schemaVersion: 1,
      generation: 0,
      providers: [],
    });
    expect(materialized.updatedAt).not.toBe(new Date(0).toISOString());

    const priorTimestamp = "2000-01-01T00:00:00.000Z";
    await writeFile(
      registryPath,
      JSON.stringify({ ...materialized, updatedAt: priorTimestamp }, null, 2) +
        "\n",
      "utf8",
    );
    const beforeRestart = await readFile(registryPath, "utf8");
    const restartedEmpty = new WorkspaceManager(root);
    await restartedEmpty.initialize();
    const unchangedGeneration =
      await restartedEmpty.nextProviderRegistryGeneration([]);
    await restartedEmpty.commitProviderRegistryGeneration(
      [],
      unchangedGeneration,
    );

    expect(unchangedGeneration).toBe(0);
    await expect(readFile(registryPath, "utf8")).resolves.toBe(beforeRestart);

    const alpha = providerVersion("provider-a", "alpha", "a".repeat(64));
    const descriptors = [descriptor(alpha, "1".repeat(64))];
    const changedGeneration =
      await restartedEmpty.nextProviderRegistryGeneration(descriptors);
    await restartedEmpty.commitProviderRegistryGeneration(
      descriptors,
      changedGeneration,
    );
    const changedBytes = await readFile(registryPath, "utf8");
    const changed = JSON.parse(changedBytes) as {
      generation: number;
      updatedAt: string;
    };

    expect(changed.generation).toBe(1);
    expect(Date.parse(changed.updatedAt)).toBeGreaterThan(
      Date.parse(priorTimestamp),
    );
    expect(changedBytes).not.toBe(beforeRestart);

    const restartedPopulated = new WorkspaceManager(
      root,
      undefined,
      undefined,
      [alpha],
    );
    await restartedPopulated.initialize();
    await restartedPopulated.commitProviderRegistryGeneration(descriptors, 1);
    await expect(readFile(registryPath, "utf8")).resolves.toBe(changedBytes);
  });

  it("upgrades schema 3 only after verifying its legacy composite fingerprint", async () => {
    const root = await temporaryRoot();
    const agent = fixtureAgent();
    const legacyManager = new WorkspaceManager(root);
    await legacyManager.initialize();
    const legacy = await legacyManager.create(agent);
    const manifestPath = path.join(root, agent.id, "canonical.json");
    const versionFour = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const { providerVersions: _providerVersions, ...schemaThreeFields } = versionFour;
    await writeFile(
      manifestPath,
      JSON.stringify({ ...schemaThreeFields, schemaVersion: 3 }, null, 2) + "\n",
      "utf8",
    );

    const initialVersion = providerVersion("provider-a", "alpha", "a".repeat(64));
    const manager = new WorkspaceManager(root, undefined, undefined, [initialVersion]);
    const migrationAgent = {
      ...agent,
      workspacePath: legacy.workspacePath,
      canonicalStateId: legacy.stateId,
    };
    const migratedBase = await manager.ensureCanonicalForProviderTransition(
      migrationAgent,
    );
    expect(migratedBase.providerVersions).toEqual([]);
    const migrated = await manager.transitionProviderRegistry(
      migrationAgent,
      migratedBase,
      [verification(initialVersion)],
      1,
    );
    const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(persisted.schemaVersion).toBe(4);
    expect(migrated.providerVersions).toEqual([initialVersion]);
    expect(migrated.contentHash).not.toBe(legacy.contentHash);
    await expect(manager.readCanonical(agent.id)).resolves.toEqual(migrated);
  });

  it("onboards providers additively with a persisted generation and rejects removal or replacement", async () => {
    const root = await temporaryRoot();
    const agent = fixtureAgent();
    const empty = new WorkspaceManager(root);
    await empty.initialize();
    const original = await empty.create(agent);
    const alpha = providerVersion("provider-a", "alpha", "a".repeat(64));
    const alphaManager = new WorkspaceManager(root, undefined, undefined, [alpha]);
    await alphaManager.initialize();
    const generationOne = await alphaManager.nextProviderRegistryGeneration([
      descriptor(alpha, "1".repeat(64)),
    ]);
    const withAlpha = await alphaManager.transitionProviderRegistry(
      agent,
      await alphaManager.ensureCanonicalForProviderTransition(agent),
      [verification(alpha)],
      generationOne,
    );
    await alphaManager.commitProviderRegistryGeneration(
      [descriptor(alpha, "1".repeat(64))],
      generationOne,
    );

    expect(generationOne).toBe(1);
    expect(withAlpha.stateId).not.toBe(original.stateId);
    expect(withAlpha.workspaceContentHash).toBe(original.workspaceContentHash);
    expect(withAlpha.providerVersions).toEqual([alpha]);

    const zeta = providerVersion("provider-b", "zeta", "b".repeat(64));
    const expanded = new WorkspaceManager(root, undefined, undefined, [zeta, alpha]);
    await expanded.initialize();
    const descriptors = [
      descriptor(alpha, "1".repeat(64)),
      descriptor(zeta, "2".repeat(64)),
    ];
    const generationTwo = await expanded.nextProviderRegistryGeneration(descriptors);
    const withBoth = await expanded.transitionProviderRegistry(
      agent,
      await expanded.ensureCanonicalForProviderTransition(agent),
      [verification(zeta)],
      generationTwo,
    );
    await expanded.commitProviderRegistryGeneration(descriptors, generationTwo);

    expect(generationTwo).toBe(2);
    expect(withBoth.providerVersions).toHaveLength(2);
    expect(withBoth.workspaceContentHash).toBe(original.workspaceContentHash);

    const removed = new WorkspaceManager(root, undefined, undefined, [alpha]);
    await removed.initialize();
    await expect(
      removed.nextProviderRegistryGeneration([descriptor(alpha, "1".repeat(64))]),
    ).rejects.toThrow(/removal or contract replacement/);

    await expect(
      expanded.nextProviderRegistryGeneration([
        descriptor(alpha, "f".repeat(64)),
        descriptor(zeta, "2".repeat(64)),
      ]),
    ).rejects.toThrow(/removal or contract replacement/);
  });

  it.each([
    "after-plan",
    "after-install",
    "after-history",
    "after-manifest",
  ] as const)(
    "recovers an interrupted provider registry transition at %s",
    async (faultPoint) => {
      const root = await temporaryRoot();
      const agent = fixtureAgent();
      const empty = new WorkspaceManager(root);
      await empty.initialize();
      const original = await empty.create(agent);
      const alpha = providerVersion("provider-a", "alpha", "c".repeat(64));
      const interrupted = new WorkspaceManager(
        root,
        undefined,
        undefined,
        [alpha],
        (point) => {
          if (point === faultPoint) throw new Error("simulated registry crash");
        },
      );
      await interrupted.initialize();
      const base = await interrupted.ensureCanonicalForProviderTransition(agent);
      await expect(
        interrupted.transitionProviderRegistry(
          agent,
          base,
          [verification(alpha)],
          1,
        ),
      ).rejects.toThrow(/simulated registry crash/);

      const restarted = new WorkspaceManager(root, undefined, undefined, [alpha]);
      await restarted.initialize();
      const recoveredBase = await restarted.ensureCanonicalForProviderTransition(agent);
      const recovered =
        recoveredBase.providerVersions.length === 0
          ? await restarted.transitionProviderRegistry(
              agent,
              recoveredBase,
              [verification(alpha)],
              1,
            )
          : recoveredBase;

      expect(recovered.providerVersions).toEqual([alpha]);
      expect(recovered.workspaceContentHash).toBe(original.workspaceContentHash);
      await expect(restarted.readCanonical(agent.id)).resolves.toEqual(recovered);
      await expect(
        readFile(path.join(root, ".registry-transitions", agent.id + ".json")),
      ).rejects.toThrow();
    },
  );

  it("reuses the Candidate timestamp after historical publication precedes Canonical replacement", async () => {
    const root = await temporaryRoot();
    const agent = fixtureAgent();
    const manager = new WorkspaceManager(root);
    await manager.initialize();
    const source = await manager.create(agent);
    const runId = "crash-idempotent-promotion";
    await manager.prepareCandidate(agent.id, runId);
    const plan = await manager.planPromotion(agent.id, runId);
    const installed = await manager.installPromotion(plan);
    const candidateManifest = JSON.parse(
      await readFile(
        path.join(
          root,
          agent.id,
          "versions",
          installed.stateId,
          "candidate.json",
        ),
        "utf8",
      ),
    ) as { createdAt: string };
    const historyDirectory = path.join(
      root,
      agent.id,
      ".canonical-history",
    );
    const historicalPath = path.join(historyDirectory, installed.stateId + ".json");
    await mkdir(historyDirectory, { recursive: true });
    await writeFile(
      historicalPath,
      JSON.stringify({
        schemaVersion: 4,
        agentId: agent.id,
        ...installed,
        createdAt: candidateManifest.createdAt,
        sourceRunId: runId,
      }) + "\n",
      "utf8",
    );

    await expect(manager.readCanonical(agent.id)).resolves.toEqual(source);
    const promoted = await manager.advancePromotion(plan, installed);
    expect(promoted).toEqual(installed);
    await expect(manager.readCanonical(agent.id)).resolves.toEqual(installed);
  });

  it.each([
    {
      label: "a target that aliases the source",
      mutate: (journal: Record<string, unknown>) => {
        journal.targetStateId = journal.sourceStateId;
      },
    },
    {
      label: "an altered transition identifier",
      mutate: (journal: Record<string, unknown>) => {
        journal.transitionId = "registry-" + "f".repeat(64);
      },
    },
    {
      label: "a missing verification",
      mutate: (journal: Record<string, unknown>) => {
        journal.verifications = [];
      },
    },
    {
      label: "an additional verification",
      mutate: (journal: Record<string, unknown>) => {
        const verifications = journal.verifications as Record<string, unknown>[];
        journal.verifications = [
          ...verifications,
          structuredClone(verifications[0]!),
        ];
      },
    },
    {
      label: "a mismatched verification",
      mutate: (journal: Record<string, unknown>) => {
        const verifications = journal.verifications as Record<string, unknown>[];
        verifications[0]!.fingerprint = "e".repeat(64);
      },
    },
    {
      label: "an unknown journal field",
      mutate: (journal: Record<string, unknown>) => {
        journal.deleteThisState = true;
      },
    },
    {
      label: "an unknown verification field",
      mutate: (journal: Record<string, unknown>) => {
        const verifications = journal.verifications as Record<string, unknown>[];
        verifications[0]!.credential = "hidden";
      },
    },
  ])(
    "rejects a forged planned transition with $label before deleting state",
    async ({ mutate }) => {
      const root = await temporaryRoot();
      const agent = fixtureAgent();
      const empty = new WorkspaceManager(root);
      await empty.initialize();
      const original = await empty.create(agent);
      const alpha = providerVersion("provider-a", "alpha", "d".repeat(64));
      const interrupted = new WorkspaceManager(
        root,
        undefined,
        undefined,
        [alpha],
        (point) => {
          if (point === "after-plan") throw new Error("simulated registry crash");
        },
      );
      await interrupted.initialize();
      await expect(
        interrupted.transitionProviderRegistry(
          agent,
          await interrupted.ensureCanonicalForProviderTransition(agent),
          [verification(alpha)],
          1,
        ),
      ).rejects.toThrow(/simulated registry crash/);
      const journalPath = path.join(
        root,
        ".registry-transitions",
        agent.id + ".json",
      );
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<
        string,
        unknown
      >;
      mutate(journal);
      await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n", "utf8");

      const restarted = new WorkspaceManager(root, undefined, undefined, [alpha]);
      await expect(restarted.initialize()).rejects.toThrow();
      await expect(access(original.workspacePath)).resolves.toBeUndefined();
      await expect(empty.readCanonical(agent.id)).resolves.toEqual(original);
    },
  );

  it("rejects a forged transition targeting a distinct historical immutable state", async () => {
    const root = await temporaryRoot();
    const agent = fixtureAgent();
    const empty = new WorkspaceManager(root);
    await empty.initialize();
    const historical = await empty.create(agent);
    const current = await empty.updateInstructions({
      ...agent,
      workspacePath: historical.workspacePath,
      canonicalStateId: historical.stateId,
      instructions: "Create a second immutable state",
    });
    const alpha = providerVersion("provider-a", "alpha", "e".repeat(64));
    const interrupted = new WorkspaceManager(
      root,
      undefined,
      undefined,
      [alpha],
      (point) => {
        if (point === "after-plan") throw new Error("simulated registry crash");
      },
    );
    await interrupted.initialize();
    await expect(
      interrupted.transitionProviderRegistry(
        agent,
        await interrupted.ensureCanonicalForProviderTransition(agent),
        [verification(alpha)],
        1,
      ),
    ).rejects.toThrow(/simulated registry crash/);
    const journalPath = path.join(
      root,
      ".registry-transitions",
      agent.id + ".json",
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<
      string,
      unknown
    >;
    journal.targetStateId = historical.stateId;
    await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n", "utf8");

    const restarted = new WorkspaceManager(root, undefined, undefined, [alpha]);
    await expect(restarted.initialize()).rejects.toThrow();
    await expect(access(historical.workspacePath)).resolves.toBeUndefined();
    await expect(access(current.workspacePath)).resolves.toBeUndefined();
    await expect(empty.readCanonical(agent.id)).resolves.toEqual(current);
  });

  it.each([null, "sha256:invalid"])(
    "rejects an installed transition with target hash %s without deleting the installed state",
    async (targetContentHash) => {
      const root = await temporaryRoot();
      const agent = fixtureAgent();
      const empty = new WorkspaceManager(root);
      await empty.initialize();
      const original = await empty.create(agent);
      const alpha = providerVersion("provider-a", "alpha", "f".repeat(64));
      const interrupted = new WorkspaceManager(
        root,
        undefined,
        undefined,
        [alpha],
        (point) => {
          if (point === "after-install") throw new Error("simulated registry crash");
        },
      );
      await interrupted.initialize();
      await expect(
        interrupted.transitionProviderRegistry(
          agent,
          await interrupted.ensureCanonicalForProviderTransition(agent),
          [verification(alpha)],
          1,
        ),
      ).rejects.toThrow(/simulated registry crash/);
      const journalPath = path.join(
        root,
        ".registry-transitions",
        agent.id + ".json",
      );
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<
        string,
        unknown
      >;
      const targetStateId = journal.targetStateId as string;
      journal.targetContentHash = targetContentHash;
      await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n", "utf8");

      const restarted = new WorkspaceManager(root, undefined, undefined, [alpha]);
      await expect(restarted.initialize()).rejects.toThrow();
      await expect(access(original.workspacePath)).resolves.toBeUndefined();
      await expect(
        access(path.join(root, agent.id, "versions", targetStateId, "workspace")),
      ).resolves.toBeUndefined();
      await expect(empty.readCanonical(agent.id)).resolves.toEqual(original);
    },
  );

  it("normalizes provider order and metadata before computing Canonical State", async () => {
    const root = await temporaryRoot();
    const agent = fixtureAgent();
    const alpha = providerVersion("provider-b", "alpha", "b".repeat(64));
    const zeta = providerVersion("provider-a", "zeta", "c".repeat(64));
    const manager = new WorkspaceManager(root, undefined, undefined, [zeta, alpha]);
    await manager.initialize();
    const canonical = await manager.create(agent);

    expect(canonical.providerVersions.map((version) => version.resourceKind)).toEqual([
      "alpha",
      "zeta",
    ]);
    const restarted = new WorkspaceManager(root, undefined, undefined, [alpha, zeta]);
    await expect(restarted.readCanonical(agent.id)).resolves.toEqual(canonical);
  });

  it("rejects registry drift instead of silently dropping a Canonical resource", async () => {
    const root = await temporaryRoot();
    const agent = fixtureAgent();
    const initialVersion = providerVersion("provider-a", "alpha", "d".repeat(64));
    const manager = new WorkspaceManager(root, undefined, undefined, [initialVersion]);
    await manager.initialize();
    await manager.create(agent);

    const missingRegistry = new WorkspaceManager(root);
    await expect(missingRegistry.readCanonical(agent.id)).rejects.toThrow(
      /does not match the configured registry/,
    );
  });
});

function fixtureAgent(): Agent {
  const timestamp = "2026-08-26T00:00:00.000Z";
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Migration fixture",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "",
    canonicalStateId: "",
    outcomeContract: createDefaultOutcomeContract(1, timestamp),
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function providerVersion(
  providerId: string,
  resourceKind: string,
  fingerprint: string,
): ResourceVersionReference {
  return {
    schemaVersion: 1,
    providerId,
    resourceKind,
    versionId: "version-initial",
    fingerprint,
    metadata: { fixture: true },
  };
}

function verification(version: ResourceVersionReference) {
  return {
    providerId: version.providerId,
    resourceKind: version.resourceKind,
    versionId: version.versionId,
    fingerprint: version.fingerprint,
    summary: "Immutable onboarding source verified",
  };
}

function descriptor(
  version: ResourceVersionReference,
  manifestFingerprint: string,
) {
  return {
    providerId: version.providerId,
    resourceKind: version.resourceKind,
    manifestFingerprint,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-eight-migration-"));
  temporaryDirectories.push(root);
  return root;
}
