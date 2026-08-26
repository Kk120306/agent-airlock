import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HttpObjectResourceProvider,
  fingerprint,
  versionReference,
} from "@agent-airlock/http-object-resource";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { AirlockRunner } from "./airlock-runner.js";
import { stableJson } from "./candidate-selection.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { ResourceCoordinator } from "./resource-coordinator.js";
import { ResourceRegistry } from "./resource-registry.js";
import { JsonStore } from "./store.js";
import type {
  AgentRunner,
  CandidateSelectionDecision,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { persistFixtureSession } from "../test/session-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class CompetingFuturesRunner implements AgentRunner {
  readonly tokenBudgetEnforcement = "provider-boundary" as const;
  readonly requests: RunnerRequest[] = [];
  active = 0;
  maximumActive = 0;
  consumedTokens = 0;

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      const competitor = request.prompt.match(/Competitor ([A-Za-z0-9._:-]+)\./)?.[1];
      if (!competitor) throw new Error("fixture did not receive competitor identity");
      if (competitor === "credential-error") {
        throw new Error("password=phase-nine-secret-value");
      }
      const usage = {
        inputTokens: competitor === "focused-valid" ? 20 : 30,
        outputTokens: 10,
      };
      const totalTokens = usage.inputTokens + usage.outputTokens;
      if (
        request.tokenBudget &&
        totalTokens > request.tokenBudget.maximumTotalTokens
      ) {
        throw new Error("fixture refused a call above its trusted token allowance");
      }
      this.consumedTokens += totalTokens;
      await new Promise((resolve) => setTimeout(resolve, competitor === "broad-valid" ? 8 : 4));
      if (competitor.startsWith("unsafe-")) {
        await unlink(path.join(request.workspacePath, "AGENTS.md"));
        await writeFile(path.join(request.workspacePath, "unsafe.txt"), "unsafe\n");
      } else if (competitor === "broad-valid") {
        await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
        await Promise.all([
          writeFile(path.join(request.workspacePath, "src", "broad-a.ts"), "export const a = 1;\n"),
          writeFile(path.join(request.workspacePath, "src", "broad-b.ts"), "export const b = 2;\n"),
          writeFile(path.join(request.workspacePath, "broad-notes.md"), "broad future\n"),
        ]);
      } else {
        await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
        await writeFile(
          path.join(request.workspacePath, "src", "winner.ts"),
          "export const selected = 'focused-valid';\n",
        );
      }
      await writeFile(
        request.outboxPath,
        JSON.stringify({
          schemaVersion: 1,
          id: competitor + "-effect",
          type: "demo.notification.requested",
          payload: {
            destination: "operator",
            subject: competitor,
            body: "Candidate effect from " + competitor,
          },
        }) + "\n",
      );
      const threadId = "thread-" + competitor;
      await persistFixtureSession(request, threadId, competitor);
      return {
        output: "evaluated " + competitor,
        threadId,
        usage,
      };
    } finally {
      this.active -= 1;
    }
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class TamperingWorkspaceManager extends WorkspaceManager {
  private tampered = false;

  override async candidateWorkspacePath(
    runId: string,
    allowHistoricalProviderSubset = false,
  ): Promise<string> {
    const workspacePath = await super.candidateWorkspacePath(
      runId,
      allowHistoricalProviderSubset,
    );
    if (allowHistoricalProviderSubset && !this.tampered) {
      this.tampered = true;
      await appendFile(
        path.join(workspacePath, "src", "winner.ts"),
        "// changed after Selection\n",
        "utf8",
      );
    }
    return workspacePath;
  }
}

describe("Phase 9 Competing Futures acceptance", () => {
  it("rejects an unsupported production Runner before any competitor can spend tokens", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-token-cap-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex-template"),
      CODEX_BIN: fileURLToPath(
        new URL("../../../tests/fixtures/fake-codex.mjs", import.meta.url),
      ),
      ARK_API_KEY: "configured-but-must-not-be-used",
      ARK_MODEL: "configured-but-must-not-be-used",
      AIRLOCK_DEMO_MODE: "false",
      RUNTIME_PROVIDER: "local-process",
    });
    const runner = createRunner(config);
    expect(runner.tokenBudgetEnforcement).toBeUndefined();
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(config.workspaceRoot, config.codexHome),
      runner,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "No unbounded competitors" });

    await expect(
      service.createCandidateSet(agent.id, {
        objective: "This request must fail before a Runtime process starts",
        competitors: [
          {
            id: "one",
            executorProfileId: "standard-v1",
            strategyInstruction: "Explore the first bounded approach.",
          },
          {
            id: "two",
            executorProfileId: "standard-v1",
            strategyInstruction: "Explore the second bounded approach.",
          },
        ],
        selectionContract: createDefaultSelectionContractForTest(),
        maxConcurrency: 2,
        budget: {
          maxDurationMsPerCompetitor: 600_000,
          maxTotalTokens: 2,
          maxTotalChangedBytes: 200_000_000,
        },
        loserPolicy: "discard",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("model-provider boundary"),
    });
    expect(service.getCandidateSets(agent.id)).toEqual([]);
  });

  it("runs the zero-cost Codex protocol fixture through the HTTP-to-Runtime seam", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-demo-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex-template"),
      CODEX_BIN: fileURLToPath(
        new URL("../../../tests/fixtures/fake-codex.mjs", import.meta.url),
      ),
      ARK_API_KEY: "deterministic-local-fixture",
      ARK_MODEL: "local-airlock-demo",
      ARK_BASE_URL: "http://127.0.0.1:1/api/v3",
      AIRLOCK_DEMO_MODE: "true",
      RUNTIME_PROVIDER: "local-process",
      HOST: "127.0.0.1",
    });
    const workspaces = new WorkspaceManager(config.workspaceRoot, config.codexHome);
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      createRunner(config),
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "No-cost Competing Futures" },
    });
    const agentId = created.json<{ agent: { id: string } }>().agent.id;
    const admitted = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/candidate-sets",
      payload: {
        objective: "Build the smallest complete solution without paid inference",
        competitors: [
          {
            id: "unsafe-fast",
            executorProfileId: "standard-v1",
            strategyInstruction: "Finish quickly, subject to required Validation.",
          },
          {
            id: "broad-valid",
            executorProfileId: "standard-v1",
            strategyInstruction: "Build a comprehensive valid solution.",
          },
          {
            id: "focused-valid",
            executorProfileId: "standard-v1",
            strategyInstruction: "Build the narrowest complete valid solution.",
          },
        ],
        maxConcurrency: 3,
        loserPolicy: "discard",
      },
    });
    expect(admitted.statusCode).toBe(202);
    const candidateSetId = admitted.json<{ candidateSet: { id: string } }>()
      .candidateSet.id;
    await expect
      .poll(() => service.getCandidateSet(candidateSetId).phase, { timeout: 15_000 })
      .toBe("completed");

    const candidateSet = service.getCandidateSet(candidateSetId);
    expect(candidateSet.selectedCompetitorId).toBe("focused-valid");
    expect(candidateSet.competitors.find((item) => item.id === "unsafe-fast"))
      .toMatchObject({ status: "discarded", loserDisposition: "discarded" });
    const canonical = await workspaces.readCanonical(agentId);
    await expect(
      readFile(path.join(canonical.workspacePath, "src", "selected-future.ts"), "utf8"),
    ).resolves.toContain("focused-valid");
    expect((await service.listExternalEffects()).map((effect) => effect.intentId))
      .toEqual(["focused-valid-effect"]);
    await app.close();
  });

  it("cancels one over-budget Runtime without stopping a valid sibling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-budget-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex-template"),
      CODEX_BIN: fileURLToPath(
        new URL("../../../tests/fixtures/fake-codex.mjs", import.meta.url),
      ),
      ARK_API_KEY: "deterministic-local-fixture",
      ARK_MODEL: "local-airlock-demo",
      ARK_BASE_URL: "http://127.0.0.1:1/api/v3",
      AIRLOCK_DEMO_MODE: "true",
      RUNTIME_PROVIDER: "local-process",
      HOST: "127.0.0.1",
    });
    const workspaces = new WorkspaceManager(config.workspaceRoot, config.codexHome);
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      createRunner(config),
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Bounded Competing Futures" },
    });
    const agentId = created.json<{ agent: { id: string } }>().agent.id;
    const startedAt = Date.now();
    const admitted = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/candidate-sets",
      payload: {
        objective: "Select a valid future without waiting for a hung sibling",
        competitors: [
          {
            id: "slow-valid",
            executorProfileId: "standard-v1",
            strategyInstruction: "Explore carefully but respect the duration budget.",
          },
          {
            id: "focused-valid",
            executorProfileId: "standard-v1",
            strategyInstruction: "Build the narrowest complete valid solution.",
          },
        ],
        maxConcurrency: 2,
        budget: {
          maxDurationMsPerCompetitor: 1_000,
          maxTotalTokens: 2_000_000,
          maxTotalChangedBytes: 200_000_000,
        },
        loserPolicy: "discard",
      },
    });
    expect(admitted.statusCode).toBe(202);
    const candidateSetId = admitted.json<{ candidateSet: { id: string } }>()
      .candidateSet.id;
    await expect
      .poll(() => service.getCandidateSet(candidateSetId).phase, { timeout: 8_000 })
      .toBe("completed");

    const candidateSet = service.getCandidateSet(candidateSetId);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(candidateSet.selectedCompetitorId).toBe("focused-valid");
    expect(candidateSet.competitors.find((item) => item.id === "slow-valid"))
      .toMatchObject({
        exclusions: ["competitor-budget:duration-ms"],
        loserDisposition: "discarded",
      });
    expect((await service.listExternalEffects()).map((effect) => effect.intentId))
      .toEqual(["focused-valid-effect"]);
    await app.close();
  });

  it("rejects an aggregate token budget that cannot reserve every Runtime before any paid call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-token-reserve-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "phase-nine-fixture-key",
      ARK_MODEL: "phase-nine-fixture-model",
    });
    const runner = new CompetingFuturesRunner();
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(config.workspaceRoot),
      runner,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Preflight token reserve" });

    await expect(
      service.createCandidateSet(agent.id, {
        objective: "Never start work without an aggregate token reservation",
        competitors: [
          {
            id: "one",
            executorProfileId: "standard-v1",
            strategyInstruction: "Try one bounded strategy.",
          },
          {
            id: "two",
            executorProfileId: "standard-v1",
            strategyInstruction: "Try another bounded strategy.",
          },
        ],
        selectionContract: createDefaultSelectionContractForTest(),
        maxConcurrency: 2,
        budget: {
          maxDurationMsPerCompetitor: 600_000,
          maxTotalTokens: 1,
          maxTotalChangedBytes: 200_000_000,
        },
        loserPolicy: "discard",
      }),
    ).rejects.toThrow(/cannot reserve one token per competitor/);
    expect(runner.requests).toHaveLength(0);
    expect(service.getCandidateSets(agent.id)).toHaveLength(0);
  });

  it("evaluates isolated siblings, excludes an invalid future, and promotes one deterministic winner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "phase-nine-fixture-key",
      ARK_MODEL: "phase-nine-fixture-model",
    });
    const runner = new CompetingFuturesRunner();
    const workspaces = new WorkspaceManager(config.workspaceRoot);
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      runner,
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Competing Futures" },
    });
    const agentId = created.json<{ agent: { id: string } }>().agent.id;
    const admitted = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/candidate-sets",
      payload: {
        objective: "Implement the smallest valid TypeScript outcome",
        competitors: [
          {
            id: "unsafe-fast",
            executorProfileId: "standard-v1",
            strategyInstruction: "Finish quickly even if the approach is risky.",
          },
          {
            id: "broad-valid",
            executorProfileId: "standard-v1",
            strategyInstruction: "Implement a broad valid solution.",
          },
          {
            id: "focused-valid",
            executorProfileId: "standard-v1",
            strategyInstruction: "Implement the narrowest complete valid solution.",
          },
        ],
        maxConcurrency: 3,
        budget: {
          maxDurationMsPerCompetitor: 600_000,
          maxTotalTokens: 120,
          maxTotalChangedBytes: 200_000_000,
        },
        loserPolicy: "retain",
      },
    });
    expect(admitted.statusCode).toBe(202);
    const candidateSetId = admitted.json<{
      candidateSet: { id: string };
    }>().candidateSet.id;
    await expect
      .poll(() => service.getCandidateSet(candidateSetId).phase, { timeout: 10_000 })
      .toBe("completed");

    const candidateSet = service.getCandidateSet(candidateSetId);
    expect(
      runner.requests.reduce(
        (total, request) =>
          total + (request.tokenBudget?.maximumTotalTokens ?? 0),
        0,
      ),
    ).toBe(candidateSet.budget.maxTotalTokens);
    expect(
      runner.requests.every(
        (request) =>
          request.tokenBudget?.schemaVersion === 1 &&
          (request.tokenBudget.maximumTotalTokens ?? 0) >= 1,
      ),
    ).toBe(true);
    expect(runner.consumedTokens).toBeLessThanOrEqual(
      candidateSet.budget.maxTotalTokens,
    );
    expect(candidateSet.selectedCompetitorId).toBe("focused-valid");
    expect(candidateSet.selectionDecision).toMatchObject({
      winnerCompetitorId: "focused-valid",
      tieBreak: "competitor-id-ascending-byte-order",
    });
    expect(
      candidateSet.selectionDecision?.scorecard.find(
        (entry) => entry.competitorId === "unsafe-fast",
      ),
    ).toMatchObject({
      eligible: false,
      rank: null,
      exclusions: expect.arrayContaining(["required-validation-failed"]),
    });
    expect(
      candidateSet.selectionDecision?.scorecard.find(
        (entry) => entry.competitorId === "focused-valid",
      )?.rank,
    ).toBe(1);
    expect(runner.maximumActive).toBeGreaterThan(1);
    expect(new Set(runner.requests.map((request) => request.workspacePath)).size).toBe(3);
    expect(new Set(runner.requests.map((request) => request.codexHomePath)).size).toBe(3);
    expect(new Set(runner.requests.map((request) => request.outboxPath)).size).toBe(3);

    const canonical = await workspaces.readCanonical(agentId);
    await expect(
      readFile(path.join(canonical.workspacePath, "src", "winner.ts"), "utf8"),
    ).resolves.toContain("focused-valid");
    await expect(
      access(path.join(canonical.workspacePath, "src", "broad-a.ts")),
    ).rejects.toThrow();
    expect(canonical.codexThreadId).toBe("thread-focused-valid");
    const effects = await service.listExternalEffects();
    expect(effects.map((effect) => effect.intentId)).toEqual([
      "focused-valid-effect",
    ]);
    const losers = candidateSet.competitors.filter(
      (competitor) => competitor.id !== "focused-valid",
    );
    expect(losers.every((competitor) => competitor.status === "retained")).toBe(true);
    for (const loser of losers) {
      const run = service.getRun(loser.runId);
      expect(run.transaction).toMatchObject({
        disposition: "quarantined",
        quarantineAvailable: true,
      });
      await expect(service.repairRun(run.id)).rejects.toMatchObject({
        statusCode: 409,
      });
    }
    const replay = service.getCandidateSet(candidateSetId).selectionDecision;
    expect(replay?.decisionDigest).toBe(candidateSet.selectionDecision?.decisionDigest);
    await app.close();
  });

  it("recovers the persisted winner through the existing Promotion journal and dispatches only its effect", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-restart-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "phase-nine-fixture-key",
      ARK_MODEL: "phase-nine-fixture-model",
    });
    const runner = new CompetingFuturesRunner();
    const createService = async (injectFault: boolean) => {
      const service = new AgentService(
        config,
        new JsonStore(path.join(config.dataDirectory, "db.json")),
        new WorkspaceManager(config.workspaceRoot),
        runner,
        undefined,
        injectFault
          ? (point) => {
              if (point === "after-validated") {
                throw new Error("simulated selected-winner interruption");
              }
            }
          : undefined,
      );
      await service.initialize();
      return service;
    };
    const first = await createService(true);
    const agent = await first.createAgent({ name: "Recover one winner" });
    const admitted = await first.createCandidateSet(agent.id, {
      objective: "Promote exactly one winner after restart",
      competitors: [
        {
          id: "broad-valid",
          executorProfileId: "standard-v1",
          strategyInstruction: "Implement a broad valid solution.",
        },
        {
          id: "focused-valid",
          executorProfileId: "standard-v1",
          strategyInstruction: "Implement the narrowest complete valid solution.",
        },
      ],
      selectionContract: createDefaultSelectionContractForTest(),
      maxConcurrency: 2,
      budget: {
        maxDurationMsPerCompetitor: 600_000,
        maxTotalTokens: 2_000_000,
        maxTotalChangedBytes: 200_000_000,
      },
      loserPolicy: "discard",
    });
    await expect
      .poll(() => first.getCandidateSet(admitted.candidateSet.id).phase)
      .toBe("promoting");
    expect(first.getCandidateSet(admitted.candidateSet.id).selectedCompetitorId)
      .toBe("focused-valid");

    const restarted = await createService(false);
    const recovered = restarted.getCandidateSet(admitted.candidateSet.id);
    expect(recovered.phase).toBe("completed");
    expect(recovered.selectedCompetitorId).toBe("focused-valid");
    expect(recovered.competitors.find((item) => item.id === "broad-valid"))
      .toMatchObject({ status: "discarded", loserDisposition: "discarded" });
    expect((await restarted.listExternalEffects()).map((effect) => effect.intentId))
      .toEqual(["focused-valid-effect"]);
    const canonical = await new WorkspaceManager(config.workspaceRoot).readCanonical(
      agent.id,
    );
    await expect(
      readFile(path.join(canonical.workspacePath, "src", "winner.ts"), "utf8"),
    ).resolves.toContain("focused-valid");
  });

  it("refuses Promotion recovery when the durable Selection Decision contradicts its journal authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-authority-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "data", "db.json");
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "phase-nine-fixture-key",
      ARK_MODEL: "phase-nine-fixture-model",
    });
    const runner = new CompetingFuturesRunner();
    const firstWorkspaces = new WorkspaceManager(config.workspaceRoot);
    const first = new AgentService(
      config,
      new JsonStore(databasePath),
      firstWorkspaces,
      runner,
      undefined,
      (point) => {
        if (point === "after-validated") {
          throw new Error("simulated authority-bound Promotion interruption");
        }
      },
    );
    await first.initialize();
    const agent = await first.createAgent({ name: "Authority-bound winner" });
    const source = await firstWorkspaces.readCanonical(agent.id);
    const admitted = await first.createCandidateSet(agent.id, {
      objective: "Recover only the exact persisted Selection Decision winner",
      competitors: [
        {
          id: "broad-valid",
          executorProfileId: "standard-v1",
          strategyInstruction: "Implement a broad valid solution.",
        },
        {
          id: "focused-valid",
          executorProfileId: "standard-v1",
          strategyInstruction: "Implement the narrowest complete valid solution.",
        },
      ],
      selectionContract: createDefaultSelectionContractForTest(),
      maxConcurrency: 2,
      budget: {
        maxDurationMsPerCompetitor: 600_000,
        maxTotalTokens: 2_000_000,
        maxTotalChangedBytes: 200_000_000,
      },
      loserPolicy: "discard",
    });
    await expect
      .poll(() => first.getCandidateSet(admitted.candidateSet.id).phase)
      .toBe("promoting");
    await expect(first.deleteAgent(agent.id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Promotion recovery"),
    });
    expect(first.getAgent(agent.id).id).toBe(agent.id);

    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as {
      candidateSets: Array<{
        id: string;
        selectedCompetitorId: string | null;
        winnerRunId: string | null;
        selectionDecision: CandidateSelectionDecision | null;
      }>;
    };
    const corrupted = persisted.candidateSets.find(
      (candidateSet) => candidateSet.id === admitted.candidateSet.id,
    );
    if (!corrupted?.selectionDecision) throw new Error("fixture decision missing");
    corrupted.selectionDecision.winnerCompetitorId = "broad-valid";
    corrupted.selectionDecision.orderedCompetitorIds = [
      "broad-valid",
      "focused-valid",
    ];
    corrupted.selectedCompetitorId = "broad-valid";
    corrupted.winnerRunId = admitted.runs.find(
      (run) => run.competitorId === "broad-valid",
    )?.id ?? null;
    const { decisionDigest: _discardedDigest, ...unsignedDecision } =
      corrupted.selectionDecision;
    corrupted.selectionDecision.decisionDigest = createHash("sha256")
      .update(stableJson(unsignedDecision))
      .digest("hex");
    await writeFile(databasePath, JSON.stringify(persisted, null, 2) + "\n", "utf8");

    const initialValue = { release: "must-not-onboard" };
    const initialVersion = versionReference(
      "version-blocked",
      fingerprint(initialValue),
    );
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([
        {
          provider: new HttpObjectResourceProvider({
            baseUrl: "http://provider.internal",
            fetcher: async () =>
              new Response(
                JSON.stringify({
                  schemaVersion: 1,
                  found: true,
                  record: {
                    id: initialVersion.versionId,
                    fingerprint: initialVersion.fingerprint,
                    value: initialValue,
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
          }),
          initialVersion,
        },
      ]),
    );
    const restartedWorkspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    const restarted = new AgentService(
      config,
      new JsonStore(databasePath),
      restartedWorkspaces,
      runner,
      undefined,
      undefined,
      coordinator,
    );
    await restarted.initialize();

    expect(restarted.getCandidateSet(admitted.candidateSet.id)).toMatchObject({
      phase: "recovery-error",
      recoveryError: expect.stringContaining("deterministic replay"),
    });
    const canonical = await restartedWorkspaces.readCanonicalForProviderTransition(
      agent.id,
    );
    expect(canonical.stateId).toBe(source.stateId);
    expect(canonical.contentHash).toBe(source.contentHash);
    expect(canonical.providerVersions).toEqual([]);
    expect(await restarted.listExternalEffects()).toEqual([]);
    await expect(restarted.createAgent({ name: "Must remain blocked" })).rejects
      .toMatchObject({ statusCode: 503 });
  });

  it("finishes an older-generation Candidate Set before onboarding a new provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-upgrade-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "phase-nine-fixture-key",
      ARK_MODEL: "phase-nine-fixture-model",
    });
    const runner = new CompetingFuturesRunner();
    const first = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(config.workspaceRoot),
      runner,
      undefined,
      (point) => {
        if (point === "after-validated") {
          throw new Error("simulated prior-generation winner interruption");
        }
      },
    );
    await first.initialize();
    const agent = await first.createAgent({ name: "Upgrade-safe futures" });
    const admitted = await first.createCandidateSet(agent.id, {
      objective: "Recover one old-generation winner before adding a provider",
      competitors: [
        {
          id: "broad-valid",
          executorProfileId: "standard-v1",
          strategyInstruction: "Implement a broad valid solution.",
        },
        {
          id: "focused-valid",
          executorProfileId: "standard-v1",
          strategyInstruction: "Implement the narrowest complete valid solution.",
        },
      ],
      selectionContract: createDefaultSelectionContractForTest(),
      maxConcurrency: 2,
      budget: {
        maxDurationMsPerCompetitor: 600_000,
        maxTotalTokens: 2_000_000,
        maxTotalChangedBytes: 200_000_000,
      },
      loserPolicy: "discard",
    });
    await expect
      .poll(() => first.getCandidateSet(admitted.candidateSet.id).phase)
      .toBe("promoting");

    const initialValue = { release: "canonical" };
    const initialVersion = versionReference(
      "version-source",
      fingerprint(initialValue),
    );
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          found: true,
          record: {
            id: initialVersion.versionId,
            fingerprint: initialVersion.fingerprint,
            value: initialValue,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([
        {
          provider: new HttpObjectResourceProvider({
            baseUrl: "http://provider.internal",
            fetcher,
          }),
          initialVersion,
        },
      ]),
    );
    const restartedWorkspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    const restarted = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      restartedWorkspaces,
      runner,
      undefined,
      undefined,
      coordinator,
    );
    await restarted.initialize();

    const recovered = restarted.getCandidateSet(admitted.candidateSet.id);
    expect(recovered.recoveryError).toBeNull();
    expect(recovered).toMatchObject({
      phase: "completed",
      selectedCompetitorId: "focused-valid",
    });
    expect(recovered.competitors.find((item) => item.id === "broad-valid"))
      .toMatchObject({ status: "discarded", loserDisposition: "discarded" });
    const canonical = await restartedWorkspaces.readCanonical(agent.id);
    expect(canonical.providerVersions).toEqual([initialVersion]);
    expect((await restarted.listExternalEffects()).map((effect) => effect.intentId))
      .toEqual(["focused-valid-effect"]);
  });

  it("reconciles the physical loser disposition after a terminal-update crash", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-loser-crash-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "phase-nine-fixture-key",
      ARK_MODEL: "phase-nine-fixture-model",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(config.workspaceRoot),
      new CompetingFuturesRunner(),
    );
    await service.initialize();
    const airlockRunner = (service as unknown as { runner: AirlockRunner }).runner;

    for (const policy of ["retain", "discard"] as const) {
      const agent = await service.createAgent({ name: "Loser crash " + policy });
      const admitted = await service.createCandidateSet(agent.id, {
        objective: "Recover a physically completed " + policy + " disposition",
        competitors: [
          {
            id: "broad-valid",
            executorProfileId: "standard-v1",
            strategyInstruction: "Implement a broad valid solution.",
          },
          {
            id: "focused-valid",
            executorProfileId: "standard-v1",
            strategyInstruction: "Implement the narrowest complete valid solution.",
          },
        ],
        selectionContract: createDefaultSelectionContractForTest(),
        maxConcurrency: 2,
        budget: {
          maxDurationMsPerCompetitor: 600_000,
          maxTotalTokens: 2_000_000,
          maxTotalChangedBytes: 200_000_000,
        },
        loserPolicy: policy,
      });
      await expect
        .poll(() => service.getCandidateSet(admitted.candidateSet.id).phase)
        .toBe("completed");

      const loser = service.getCandidateSet(admitted.candidateSet.id).competitors.find(
        (competitor) => competitor.id === "broad-valid",
      );
      const loserRun = loser ? service.getRun(loser.runId) : null;
      expect(loserRun?.transaction?.disposition).toBe(
        policy === "retain" ? "quarantined" : "discarded",
      );
      const interrupted = structuredClone(loserRun?.transaction);
      if (!interrupted) throw new Error("Fixture loser transaction is missing");
      interrupted.status = "sealed";
      interrupted.disposition = null;
      interrupted.quarantinePath = null;
      interrupted.quarantineAvailable = false;
      interrupted.discardedAt = null;
      interrupted.promotionReceipt = null;

      const recovered = await airlockRunner.disposeSealedCandidate(
        agent.id,
        interrupted,
        policy,
        async () => undefined,
      );
      expect(recovered).toMatchObject({
        status: policy === "retain" ? "quarantined" : "discarded",
        disposition: policy === "retain" ? "quarantined" : "discarded",
        quarantineAvailable: policy === "retain",
      });
    }
  });

  it("fails closed on selected-winner seal tampering without promoting a runner-up", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-tamper-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "phase-nine-fixture-key",
      ARK_MODEL: "phase-nine-fixture-model",
    });
    const workspaces = new TamperingWorkspaceManager(config.workspaceRoot);
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      new CompetingFuturesRunner(),
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "No fallback after tamper" });
    const source = await workspaces.readCanonical(agent.id);
    const admitted = await service.createCandidateSet(agent.id, {
      objective: "Never substitute a runner-up after the decision is persisted",
      competitors: [
        {
          id: "broad-valid",
          executorProfileId: "standard-v1",
          strategyInstruction: "Implement a broad valid solution.",
        },
        {
          id: "focused-valid",
          executorProfileId: "standard-v1",
          strategyInstruction: "Implement the narrowest complete valid solution.",
        },
      ],
      selectionContract: createDefaultSelectionContractForTest(),
      maxConcurrency: 2,
      budget: {
        maxDurationMsPerCompetitor: 600_000,
        maxTotalTokens: 2_000_000,
        maxTotalChangedBytes: 200_000_000,
      },
      loserPolicy: "retain",
    });
    await expect
      .poll(() => service.getCandidateSet(admitted.candidateSet.id).phase)
      .toBe("recovery-error");

    const failed = service.getCandidateSet(admitted.candidateSet.id);
    expect(failed.selectedCompetitorId).toBe("focused-valid");
    expect(failed.recoveryError).toContain(
      "Selected Candidate workspace changed after it was sealed",
    );
    expect(failed.competitors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "focused-valid",
          status: "retained",
          loserDisposition: "retained",
        }),
        expect.objectContaining({
          id: "broad-valid",
          status: "retained",
          loserDisposition: "retained",
        }),
      ]),
    );
    const canonical = await workspaces.readCanonical(agent.id);
    expect(canonical.stateId).toBe(source.stateId);
    expect(canonical.contentHash).toBe(source.contentHash);
    await expect(
      access(path.join(canonical.workspacePath, "src", "winner.ts")),
    ).rejects.toThrow();
    await expect(
      access(path.join(canonical.workspacePath, "src", "broad-a.ts")),
    ).rejects.toThrow();
    expect(await service.listExternalEffects()).toEqual([]);
  });

  it("turns pre-decision cancellation into a durable no-winner result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-cancel-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "phase-nine-fixture-key",
      ARK_MODEL: "phase-nine-fixture-model",
    });
    const workspaces = new WorkspaceManager(config.workspaceRoot);
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      new CompetingFuturesRunner(),
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Cancelled futures" });
    const source = await workspaces.readCanonical(agent.id);
    const admitted = await service.createCandidateSet(agent.id, {
      objective: "Do not select after cancellation",
      competitors: [
        {
          id: "broad-valid",
          executorProfileId: "standard-v1",
          strategyInstruction: "Implement a broad valid solution.",
        },
        {
          id: "focused-valid",
          executorProfileId: "standard-v1",
          strategyInstruction: "Implement the narrowest complete valid solution.",
        },
      ],
      selectionContract: createDefaultSelectionContractForTest(),
      maxConcurrency: 1,
      budget: {
        maxDurationMsPerCompetitor: 600_000,
        maxTotalTokens: 2_000_000,
        maxTotalChangedBytes: 200_000_000,
      },
      loserPolicy: "discard",
    });
    await service.cancelCandidateSet(admitted.candidateSet.id);
    await expect
      .poll(() => service.getCandidateSet(admitted.candidateSet.id).phase)
      .toBe("completed");

    const cancelled = service.getCandidateSet(admitted.candidateSet.id);
    expect(cancelled.cancellationRequested).toBe(true);
    expect(cancelled.selectedCompetitorId).toBeNull();
    expect(cancelled.selectionDecision).toMatchObject({
      winnerCompetitorId: null,
      orderedCompetitorIds: [],
    });
    expect(
      cancelled.selectionDecision?.scorecard.every((entry) => !entry.eligible),
    ).toBe(true);
    for (const competitor of cancelled.competitors) {
      const transaction = service.getRun(competitor.runId).transaction;
      expect(transaction?.disposition).not.toBeNull();
      expect([
        "cancelled",
        "discarded",
        "quarantined",
      ]).toContain(transaction?.disposition);
      expect(transaction?.promotionReceipt).not.toBeNull();
    }
    const canonical = await workspaces.readCanonical(agent.id);
    expect(canonical.stateId).toBe(source.stateId);
    expect(canonical.contentHash).toBe(source.contentHash);
    expect(await service.listExternalEffects()).toEqual([]);
  });

  it("records no winner when every sibling fails required Validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-invalid-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "phase-nine-fixture-key",
      ARK_MODEL: "phase-nine-fixture-model",
    });
    const workspaces = new WorkspaceManager(config.workspaceRoot);
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      new CompetingFuturesRunner(),
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "No valid future" });
    const source = await workspaces.readCanonical(agent.id);
    const admitted = await service.createCandidateSet(agent.id, {
      objective: "Reject every future that removes required instructions",
      competitors: [
        {
          id: "unsafe-a",
          executorProfileId: "standard-v1",
          strategyInstruction: "Try one unsafe shortcut.",
        },
        {
          id: "unsafe-b",
          executorProfileId: "standard-v1",
          strategyInstruction: "Try another unsafe shortcut.",
        },
        {
          id: "credential-error",
          executorProfileId: "standard-v1",
          strategyInstruction: "Fail without retaining sensitive Runtime evidence.",
        },
      ],
      selectionContract: createDefaultSelectionContractForTest(),
      maxConcurrency: 2,
      budget: {
        maxDurationMsPerCompetitor: 600_000,
        maxTotalTokens: 2_000_000,
        maxTotalChangedBytes: 200_000_000,
      },
      loserPolicy: "discard",
    });
    await expect
      .poll(() => service.getCandidateSet(admitted.candidateSet.id).phase)
      .toBe("completed");

    const candidateSet = service.getCandidateSet(admitted.candidateSet.id);
    expect(candidateSet.selectedCompetitorId).toBeNull();
    expect(candidateSet.selectionDecision?.winnerCompetitorId).toBeNull();
    expect(candidateSet.selectionDecision?.scorecard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          competitorId: "unsafe-a",
          eligible: false,
          rank: null,
        }),
        expect.objectContaining({
          competitorId: "unsafe-b",
          eligible: false,
          rank: null,
        }),
        expect.objectContaining({
          competitorId: "credential-error",
          eligible: false,
          rank: null,
        }),
      ]),
    );
    expect(JSON.stringify(candidateSet)).not.toContain("phase-nine-secret-value");
    expect(JSON.stringify(service.getRuns(agent.id))).not.toContain(
      "phase-nine-secret-value",
    );
    const canonical = await workspaces.readCanonical(agent.id);
    expect(canonical.stateId).toBe(source.stateId);
    expect(canonical.contentHash).toBe(source.contentHash);
    expect(await service.listExternalEffects()).toEqual([]);
  });

  it("rejects unknown admission fields at the HTTP boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-nine-http-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "phase-nine-fixture-key",
      ARK_MODEL: "phase-nine-fixture-model",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(config.workspaceRoot),
      new CompetingFuturesRunner(),
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await service.createAgent({ name: "Strict admission" });
    const response = await app.inject({
      method: "POST",
      url: "/api/agents/" + created.id + "/candidate-sets",
      payload: {
        objective: "Strictly reject unknown authority",
        competitors: [
          { id: "one", executorProfileId: "standard-v1", strategyInstruction: "one" },
          { id: "two", executorProfileId: "standard-v1", strategyInstruction: "two" },
        ],
        hiddenJudgePrompt: "choose one",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.getCandidateSets(created.id)).toHaveLength(0);
    await app.close();
  });
});

function createDefaultSelectionContractForTest() {
  return {
    schemaVersion: 1 as const,
    criteria: [
      {
        kind: "quality-assertion" as const,
        source: "trusted-validation-evaluator" as const,
        direction: "maximize" as const,
        maximum: 1_000_000,
        evaluatorVersion: "airlock-validation-pass-rate-v1",
      },
      {
        kind: "changed-files" as const,
        source: "workspace-change-evidence" as const,
        direction: "minimize" as const,
        maximum: 10_000,
        evaluatorVersion: "airlock-workspace-change-v1",
      },
      {
        kind: "added-bytes" as const,
        source: "workspace-change-evidence" as const,
        direction: "minimize" as const,
        maximum: 100_000_000,
        evaluatorVersion: "airlock-workspace-change-v1",
      },
      {
        kind: "latency-ms" as const,
        source: "monotonic-execution-measurement" as const,
        direction: "minimize" as const,
        maximum: 3_600_000,
        evaluatorVersion: "airlock-monotonic-runtime-v1",
      },
      {
        kind: "total-tokens" as const,
        source: "runtime-usage-response" as const,
        direction: "minimize" as const,
        maximum: 10_000_000,
        evaluatorVersion: "airlock-runtime-usage-v1",
      },
    ],
  };
}
