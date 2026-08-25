import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { SqliteResource } from "./sqlite-resource.js";
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

class MultiResourceFixtureRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    const database = new DatabaseSync(
      path.join(request.workspacePath, ".airlock", "demo.sqlite"),
    );
    const rejected = request.prompt.includes("unsafe");
    database
      .prepare("UPDATE inventory SET value = ?, updated_at = ? WHERE id = ?")
      .run(
        rejected ? "rejected" : "shipped",
        "2026-08-25T00:00:00.000Z",
        "demo",
      );
    database.close();
    await writeFile(
      request.outboxPath,
      JSON.stringify({
        schemaVersion: 1,
        id: rejected ? "unsafe-notice" : "release-ready",
        type: "demo.notification.requested",
        payload: {
          destination: "demo-console",
          subject: rejected ? "Unsafe change" : "Release ready",
          body: "Fixture notification",
        },
      }) + "\n",
      "utf8",
    );
    if (rejected) {
      await unlink(path.join(request.workspacePath, "AGENTS.md"));
    } else {
      await writeFile(
        path.join(request.workspacePath, "release.txt"),
        "workspace, data, and effect prepared\n",
        "utf8",
      );
    }
    const threadId = request.threadId ?? "phase-four-thread";
    await persistFixtureSession(request, threadId);
    return { output: "multi-resource fixture complete", threadId, usage: null };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe("Phase 4 multi-resource acceptance", () => {
  it("promotes all resources together and rejects all resources together", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-four-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "fixture-only-key",
      ARK_MODEL: "fixture-only-model",
    });
    const workspaces = new WorkspaceManager(config.workspaceRoot);
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "launchpad.json")),
      workspaces,
      new MultiResourceFixtureRunner(),
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Release Agent" });

    const accepted = await service.sendMessage(
      agent.id,
      "prepare the safe multi-resource release",
    );
    await expect.poll(() => service.getRun(accepted.run.id).status).toBe("completed");
    const acceptedRun = service.getRun(accepted.run.id);
    const acceptedState = await workspaces.readCanonical(agent.id);
    const acceptedDatabase = await new SqliteResource().inspect(
      acceptedState.workspacePath,
    );

    expect(acceptedRun.transaction).toMatchObject({
      disposition: "promoted",
      resources: [
        { kind: "workspace", disposition: "promoted" },
        { kind: "codex-session", disposition: "promoted" },
        { kind: "sqlite", disposition: "promoted" },
        { kind: "external-actions", disposition: "promoted" },
      ],
      externalActions: {
        deliveredCount: 1,
        intents: [{ id: "release-ready", status: "delivered" }],
      },
    });
    expect(acceptedDatabase.rows[0]?.value).toBe("shipped");
    expect(acceptedState.sqliteContentHash).toBe(acceptedDatabase.contentHash);
    await expect(
      readFile(path.join(acceptedState.outboxPath, "intents.jsonl"), "utf8"),
    ).resolves.toContain("release-ready");
    expect(await service.listExternalEffects()).toHaveLength(1);

    const rejected = await service.sendMessage(
      agent.id,
      "make an unsafe multi-resource change",
    );
    await expect.poll(() => service.getRun(rejected.run.id).status).toBe("completed");
    const rejectedRun = service.getRun(rejected.run.id);
    const canonicalAfterRejection = await workspaces.readCanonical(agent.id);
    const databaseAfterRejection = await new SqliteResource().inspect(
      canonicalAfterRejection.workspacePath,
    );

    expect(rejectedRun.transaction).toMatchObject({
      disposition: "quarantined",
      canonicalStateIdBefore: acceptedState.stateId,
      canonicalStateIdAfter: acceptedState.stateId,
      externalActions: {
        deliveredCount: 0,
        intents: [{ id: "unsafe-notice", status: "rejected" }],
      },
    });
    expect(databaseAfterRejection.rows[0]?.value).toBe("shipped");
    await expect(
      readFile(
        path.join(
          rejectedRun.transaction?.quarantinePath ?? "",
          "outbox",
          "intents.jsonl",
        ),
        "utf8",
      ),
    ).resolves.toContain("unsafe-notice");
    expect(await service.listExternalEffects()).toHaveLength(1);
  });
});
