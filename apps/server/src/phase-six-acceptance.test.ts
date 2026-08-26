import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunTransaction,
  type PromotionFaultInjector,
  type PromotionFaultPoint,
} from "./airlock-runner.js";
import { AgentService } from "./agent-service.js";
import { loadConfig, type AppConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
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

class DurablePromotionFixtureRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    const rejected = request.prompt.includes("unsafe");
    const database = new DatabaseSync(
      path.join(request.workspacePath, ".airlock", "demo.sqlite"),
    );
    database
      .prepare("UPDATE inventory SET value = ?, updated_at = ? WHERE id = ?")
      .run(
        rejected ? "rejected" : "durable",
        "2026-08-25T00:00:00.000Z",
        "demo",
      );
    database.close();
    await writeFile(
      request.outboxPath,
      JSON.stringify({
        schemaVersion: 1,
        id: rejected ? "unsafe-intent" : "durable-intent",
        type: "demo.notification.requested",
        payload: {
          destination: "demo-console",
          subject: rejected ? "Rejected" : "Durable Promotion",
          body: "Phase 6 deterministic fixture",
        },
      }) + "\n",
      "utf8",
    );
    if (rejected) {
      await rm(path.join(request.workspacePath, "AGENTS.md"));
    } else {
      await writeFile(
        path.join(request.workspacePath, "durable.txt"),
        "one accepted future\n",
        "utf8",
      );
    }
    const threadId = request.threadId ?? "durable-thread";
    await persistFixtureSession(request, threadId, "durable-memory");
    return {
      output: "durable Promotion fixture completed",
      threadId,
      usage: { inputTokens: 8, outputTokens: 4 },
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

interface Fixture {
  root: string;
  config: AppConfig;
  store: JsonStore;
  workspaces: WorkspaceManager;
  service: AgentService;
}

async function createFixture(
  root?: string,
  fault?: PromotionFaultInjector,
  retentionHours?: number,
): Promise<Fixture> {
  const fixtureRoot =
    root ?? (await mkdtemp(path.join(tmpdir(), "airlock-phase-six-")));
  if (!root) temporaryDirectories.push(fixtureRoot);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(fixtureRoot, "data"),
    AGENT_WORKSPACE_ROOT: path.join(fixtureRoot, "workspaces"),
    CODEX_HOME: path.join(fixtureRoot, "codex"),
    ARK_API_KEY: "fixture-only-key",
    ARK_MODEL: "fixture-only-model",
    AIRLOCK_CANDIDATE_RETENTION_HOURS: String(retentionHours ?? 24),
    AIRLOCK_QUARANTINE_RETENTION_HOURS: String(retentionHours ?? 168),
  });
  const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
  const workspaces = new WorkspaceManager(config.workspaceRoot);
  const service = new AgentService(
    config,
    store,
    workspaces,
    new DurablePromotionFixtureRunner(),
    undefined,
    fault,
  );
  await service.initialize();
  return { root: fixtureRoot, config, store, workspaces, service };
}

async function waitForTerminal(service: AgentService, runId: string) {
  await expect
    .poll(() => service.getRun(runId).status, { timeout: 5_000 })
    .toMatch(/^(completed|failed|cancelled)$/);
  return service.getRun(runId);
}

const faultPoints: PromotionFaultPoint[] = [
  "after-validated",
  "after-version-install",
  "after-version-installed",
  "after-canonical-advance",
  "after-canonical-advanced",
  "after-effect-dispatch",
  "after-effects-delivered",
  "after-completed",
];

describe("Phase 6 durable Promotion recovery", () => {
  it.each(faultPoints)("converges after a crash at %s", async (faultPoint) => {
    let injected = false;
    const first = await createFixture(undefined, (point) => {
      if (!injected && point === faultPoint) {
        injected = true;
        throw new Error("simulated process crash at " + point);
      }
    });
    const agent = await first.service.createAgent({ name: "Durable Agent" });
    const source = await first.workspaces.readCanonical(agent.id);
    const started = await first.service.sendMessage(
      agent.id,
      "prepare one durable multi-resource Promotion",
    );
    const interrupted = await waitForTerminal(first.service, started.run.id);
    expect(interrupted.status).toBe("failed");
    expect(interrupted.error).toContain("requires durable reconciliation");

    const recovered = await createFixture(first.root);
    const completed = recovered.service.getRun(started.run.id);
    const canonical = await recovered.workspaces.readCanonical(agent.id);

    expect(completed).toMatchObject({
      status: "completed",
      error: null,
      transaction: {
        disposition: "promoted",
        status: "promoted",
        recovery: {
          journalPhase: "completed",
          recoveredAfterRestart: true,
          recoveryError: null,
        },
        externalActions: {
          deliveredCount: 1,
          intents: [{ id: "durable-intent", status: "delivered" }],
        },
      },
    });
    expect(canonical.stateId).not.toBe(source.stateId);
    await expect(
      readFile(path.join(canonical.workspacePath, "durable.txt"), "utf8"),
    ).resolves.toBe("one accepted future\n");
    expect(await recovered.service.listExternalEffects()).toHaveLength(1);
    expect(
      await readdir(path.join(first.config.workspaceRoot, agent.id, "versions")),
    ).toHaveLength(2);

    const replayed = await createFixture(first.root);
    expect(await replayed.service.listExternalEffects()).toHaveLength(1);
    expect(replayed.service.getMessages(agent.id).filter((message) => message.role === "assistant"))
      .toHaveLength(1);
    expect(
      await readdir(path.join(first.config.workspaceRoot, agent.id, "versions")),
    ).toHaveLength(2);
  });

  it("retains a valid pre-decision Candidate in Quarantine after restart", async () => {
    const first = await createFixture();
    const agent = await first.service.createAgent({ name: "Interrupted Agent" });
    const canonical = await first.workspaces.readCanonical(agent.id);
    const runId = "interrupted-run";
    const candidate = await first.workspaces.prepareCandidate(agent.id, runId);
    await writeFile(
      path.join(candidate.workspacePath, "partial.txt"),
      "valuable partial work\n",
      "utf8",
    );
    const transaction = createRunTransaction(
      runId,
      canonical,
      agent.outcomeContract,
    );
    transaction.candidateStateId = candidate.candidateStateId;
    transaction.status = "executing";
    await first.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (storedAgent) storedAgent.status = "busy";
      database.runs.push({
        id: runId,
        agentId: agent.id,
        status: "running",
        prompt: "interrupted work",
        output: null,
        error: null,
        usage: null,
        transaction,
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
      });
    });

    const restarted = await createFixture(first.root);
    const retained = restarted.service.getRun(runId);
    const after = await restarted.workspaces.readCanonical(agent.id);

    expect(retained).toMatchObject({
      status: "failed",
      transaction: {
        disposition: "quarantined",
        quarantineAvailable: true,
      },
    });
    expect(after).toEqual(canonical);
    await expect(
      readFile(
        path.join(
          retained.transaction?.quarantinePath ?? "",
          "workspace",
          "partial.txt",
        ),
        "utf8",
      ),
    ).resolves.toBe("valuable partial work\n");
  });

  it("fails closed when installed state contradicts its durable journal", async () => {
    const first = await createFixture(undefined, (point) => {
      if (point === "after-version-installed") {
        throw new Error("stop before canonical advance");
      }
    });
    const agent = await first.service.createAgent({ name: "Contradiction Agent" });
    const source = await first.workspaces.readCanonical(agent.id);
    const started = await first.service.sendMessage(agent.id, "prepare durable state");
    await waitForTerminal(first.service, started.run.id);
    const journal = JSON.parse(
      await readFile(
        path.join(
          first.config.dataDirectory,
          "promotion-journal",
          started.run.id + ".json",
        ),
        "utf8",
      ),
    ) as { plan: { targetStateId: string } };
    await writeFile(
      path.join(
        first.config.workspaceRoot,
        agent.id,
        "versions",
        journal.plan.targetStateId,
        "workspace",
        "tampered.txt",
      ),
      "contradiction\n",
      "utf8",
    );

    const restarted = await createFixture(first.root);
    const failed = restarted.service.getRun(started.run.id);

    expect(failed).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        recovery: {
          journalPhase: "version-installed",
          recoveredAfterRestart: false,
          recoveryError: expect.stringContaining("contradicts"),
        },
      },
    });
    expect(restarted.service.getAgent(agent.id)).toMatchObject({ status: "error" });
    expect(await restarted.workspaces.readCanonical(agent.id)).toEqual(source);
    expect(await restarted.service.listExternalEffects()).toEqual([]);
  });

  it("expires only unprotected Quarantine state and retains its evidence", async () => {
    const first = await createFixture();
    const agent = await first.service.createAgent({ name: "Retention Agent" });
    const canonical = await first.workspaces.readCanonical(agent.id);
    const rejected = await first.service.sendMessage(agent.id, "make an unsafe future");
    await waitForTerminal(first.service, rejected.run.id);
    const before = first.service.getRun(rejected.run.id);
    const quarantinePath = before.transaction?.quarantinePath ?? "";
    const manifestPath = path.join(quarantinePath, "candidate.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    manifest.createdAt = "2000-01-01T00:00:00.000Z";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    const sentinel = path.join(first.root, "unrelated-sentinel.txt");
    await writeFile(sentinel, "must survive\n", "utf8");
    const evidenceHash = before.transaction?.promotionReceipt?.validationEvidenceHash;

    const restarted = await createFixture(first.root, undefined, 0.000001);
    const expired = restarted.service.getRun(rejected.run.id);

    expect(expired.transaction).toMatchObject({
      disposition: "discarded",
      quarantineAvailable: false,
      promotionReceipt: { validationEvidenceHash: evidenceHash },
    });
    await expect(access(quarantinePath)).rejects.toThrow();
    await expect(readFile(sentinel, "utf8")).resolves.toBe("must survive\n");
    expect(await restarted.workspaces.readCanonical(agent.id)).toEqual(canonical);
  });

  it("rejects unsafe identifiers and never traverses a cleanup symlink", async () => {
    const fixture = await createFixture();
    const external = await mkdtemp(path.join(tmpdir(), "airlock-external-"));
    temporaryDirectories.push(external);
    const sentinel = path.join(external, "sentinel.txt");
    await writeFile(sentinel, "outside state\n", "utf8");
    await symlink(
      external,
      path.join(fixture.config.workspaceRoot, ".quarantine", "symlink-run"),
    );

    await expect(
      fixture.workspaces.discardQuarantine("../outside"),
    ).rejects.toThrow(/identifier is not safe/);
    const cleanup = await fixture.workspaces.cleanupExpiredState({
      candidateOlderThan: "2100-01-01T00:00:00.000Z",
      quarantineOlderThan: "2100-01-01T00:00:00.000Z",
      protectedRunIds: new Set(),
    });

    expect(cleanup.errors).toEqual([
      expect.stringContaining("symlink-run"),
    ]);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("outside state\n");
  });
});
