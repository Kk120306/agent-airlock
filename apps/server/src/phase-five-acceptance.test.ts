import {
  access,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { persistFixtureSession } from "../test/session-fixture.js";
import { waitForRunStatus } from "../test/agent-service-workflow.js";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class RepairFixtureRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    const repair = request.prompt.includes("Agent Airlock Repair Run");
    const unsafe = !repair && request.prompt.includes("unsafe future");
    const failingRepair = repair && request.prompt.includes("remain failing");
    const threadId = request.threadId ?? "repair-thread";

    if (unsafe) {
      await unlink(path.join(request.workspacePath, "AGENTS.md"));
      await writeFile(
        path.join(request.workspacePath, "useful-candidate.txt"),
        "preserve this useful quarantined work\n",
        "utf8",
      );
      this.updateDatabase(request.workspacePath, "rejected");
      await this.writeIntent(request.outboxPath, "unsafe-intent");
      await persistFixtureSession(request, threadId, "quarantined-memory");
      return { output: "unsafe future retained", threadId, usage: null };
    }

    if (repair) {
      if (!request.repairReferencePath) {
        throw new Error("Repair Run did not receive a bounded Canonical reference");
      }
      await expect(
        readFile(path.join(request.workspacePath, "useful-candidate.txt"), "utf8"),
      ).resolves.toContain("preserve this useful quarantined work");
      await expect(access(request.outboxPath)).rejects.toThrow();
      if (!failingRepair) {
        const canonicalInstructions = await readFile(
          path.join(request.repairReferencePath, "AGENTS.md"),
          "utf8",
        );
        await writeFile(
          path.join(request.workspacePath, "AGENTS.md"),
          canonicalInstructions,
          "utf8",
        );
      }
      this.updateDatabase(request.workspacePath, "repaired");
      await this.writeIntent(request.outboxPath, "repair-intent");
      await persistFixtureSession(request, threadId, "repaired-memory");
      return {
        output: failingRepair ? "repair still fails" : "quarantined future repaired",
        threadId,
        usage: null,
      };
    }

    await writeFile(
      path.join(request.workspacePath, "safe-advance.txt"),
      "new accepted reality\n",
      "utf8",
    );
    await persistFixtureSession(request, threadId, "safe-memory");
    return { output: "safe future promoted", threadId, usage: null };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private updateDatabase(workspacePath: string, value: string): void {
    const database = new DatabaseSync(
      path.join(workspacePath, ".airlock", "demo.sqlite"),
    );
    database
      .prepare("UPDATE inventory SET value = ?, updated_at = ? WHERE id = ?")
      .run(value, "2026-08-25T00:00:00.000Z", "demo");
    database.close();
  }

  private async writeIntent(outboxPath: string, id: string): Promise<void> {
    await writeFile(
      outboxPath,
      JSON.stringify({
        schemaVersion: 1,
        id,
        type: "demo.notification.requested",
        payload: {
          destination: "demo-console",
          subject: id,
          body: "Phase 5 fixture",
        },
      }) + "\n",
      "utf8",
    );
  }
}

async function createFixture(maxRepairDepth = 2): Promise<{
  service: AgentService;
  workspaces: WorkspaceManager;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-five-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "fixture-only-key",
    ARK_MODEL: "fixture-only-model",
    AIRLOCK_MAX_REPAIR_DEPTH: String(maxRepairDepth),
  });
  const workspaces = new WorkspaceManager(config.workspaceRoot);
  const service = new AgentService(
    config,
    new JsonStore(path.join(config.dataDirectory, "launchpad.json")),
    workspaces,
    new RepairFixtureRunner(),
  );
  await service.initialize();
  return { service, workspaces };
}

describe("Phase 5 recoverable intelligence", () => {
  it("repairs a quarantined future and promotes its complete lineage", async () => {
    const { service, workspaces } = await createFixture();
    const agent = await service.createAgent({ name: "Recovery Agent" });
    const canonicalBefore = await workspaces.readCanonical(agent.id);

    const rejected = await service.sendMessage(agent.id, "create an unsafe future");
    await waitForRunStatus(service, rejected.run.id, "completed");
    const rejectedRun = service.getRun(rejected.run.id);
    const canonicalAfterRejection = await workspaces.readCanonical(agent.id);

    expect(rejectedRun.transaction).toMatchObject({
      disposition: "quarantined",
      quarantineAvailable: true,
      lineage: {
        rootRunId: rejected.run.id,
        parentRunId: null,
        depth: 0,
        maxDepth: 2,
      },
      externalActions: {
        deliveredCount: 0,
        intents: [{ id: "unsafe-intent", status: "rejected" }],
      },
    });
    expect(canonicalAfterRejection).toEqual(canonicalBefore);
    expect(await service.listExternalEffects()).toEqual([]);

    const repair = await service.repairRun(rejected.run.id);
    await waitForRunStatus(service, repair.run.id, "completed");
    const repairedRun = service.getRun(repair.run.id);
    const repairedCanonical = await workspaces.readCanonical(agent.id);

    expect(repairedRun.transaction).toMatchObject({
      disposition: "promoted",
      quarantineAvailable: false,
      lineage: {
        rootRunId: rejected.run.id,
        parentRunId: rejected.run.id,
        depth: 1,
        maxDepth: 2,
      },
      promotionReceipt: {
        disposition: "promoted",
        lineage: {
          rootRunId: rejected.run.id,
          parentRunId: rejected.run.id,
          depth: 1,
        },
      },
      externalActions: {
        deliveredCount: 1,
        intents: [{ id: "repair-intent", status: "delivered" }],
      },
    });
    expect(repairedCanonical.stateId).not.toBe(canonicalBefore.stateId);
    await expect(
      readFile(
        path.join(repairedCanonical.workspacePath, "useful-candidate.txt"),
        "utf8",
      ),
    ).resolves.toContain("preserve this useful quarantined work");
    await expect(
      readFile(path.join(repairedCanonical.workspacePath, "AGENTS.md"), "utf8"),
    ).resolves.toContain("Platform-managed Agent instructions");
    await expect(
      access(path.join(path.dirname(repairedCanonical.workspacePath), "repair-reference")),
    ).rejects.toThrow();
    expect((await service.listExternalEffects()).map((effect) => effect.intentId)).toEqual([
      "repair-intent",
    ]);
  });

  it("discards mutable Quarantine while retaining bounded evidence", async () => {
    const { service } = await createFixture();
    const agent = await service.createAgent({ name: "Discard Agent" });
    const rejected = await service.sendMessage(agent.id, "create an unsafe future");
    await waitForRunStatus(service, rejected.run.id, "completed");
    const before = service.getRun(rejected.run.id);
    const quarantinePath = before.transaction?.quarantinePath;
    const evidenceHash = before.transaction?.promotionReceipt?.validationEvidenceHash;

    const discarded = await service.discardRun(rejected.run.id);
    const replayed = await service.discardRun(rejected.run.id);

    expect(discarded.transaction).toMatchObject({
      status: "discarded",
      disposition: "discarded",
      quarantineAvailable: false,
      quarantinePath: null,
      promotionReceipt: {
        disposition: "discarded",
        validationEvidenceHash: evidenceHash,
      },
    });
    expect(discarded.transaction?.discardedAt).toBeTruthy();
    expect(replayed.transaction?.discardedAt).toBe(discarded.transaction?.discardedAt);
    await expect(access(quarantinePath ?? "")).rejects.toThrow();
    await expect(service.repairRun(rejected.run.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("fails closed for exhausted and stale repair lineages", async () => {
    const bounded = await createFixture(1);
    const boundedAgent = await bounded.service.createAgent({ name: "Bounded Agent" });
    const rejected = await bounded.service.sendMessage(
      boundedAgent.id,
      "create an unsafe future",
    );
    await waitForRunStatus(bounded.service, rejected.run.id, "completed");
    const failedRepair = await bounded.service.repairRun(
      rejected.run.id,
      "remain failing",
    );
    await waitForRunStatus(
      bounded.service,
      failedRepair.run.id,
      "completed",
    );
    expect(bounded.service.getRun(failedRepair.run.id).transaction).toMatchObject({
      disposition: "quarantined",
      lineage: { depth: 1, maxDepth: 1 },
    });
    await expect(bounded.service.repairRun(failedRepair.run.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(bounded.service.repairRun(rejected.run.id)).rejects.toMatchObject({
      statusCode: 409,
    });

    const stale = await createFixture();
    const staleAgent = await stale.service.createAgent({ name: "Stale Agent" });
    const staleRejected = await stale.service.sendMessage(
      staleAgent.id,
      "create an unsafe future",
    );
    await waitForRunStatus(
      stale.service,
      staleRejected.run.id,
      "completed",
    );
    const advance = await stale.service.sendMessage(staleAgent.id, "advance safely");
    await waitForRunStatus(stale.service, advance.run.id, "completed");
    await expect(stale.service.repairRun(staleRejected.run.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
