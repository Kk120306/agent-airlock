import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
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

class PersistentFixtureRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    if (request.threadId === null) {
      await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
      await writeFile(
        path.join(request.workspacePath, "src", "hello.ts"),
        'export const hello = () => "hello";\n',
        "utf8",
      );
    } else {
      const source = await readFile(
        path.join(request.workspacePath, "src", "hello.ts"),
        "utf8",
      );
      if (!source.includes('"hello"')) throw new Error("Workspace did not persist");
    }
    return {
      output: request.threadId ? "continued baseline" : "created baseline",
      threadId: request.threadId ?? "baseline-thread",
      usage: { inputTokens: 4, outputTokens: 2 },
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe("Phase 0 baseline acceptance", () => {
  it("preserves lifecycle, conversation, thread, and workspace across restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-baseline-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "baseline-key",
      ARK_MODEL: "ep-baseline",
    });
    const runner = new PersistentFixtureRunner();
    const createService = async () => {
      const service = new AgentService(
        config,
        new JsonStore(path.join(root, "data", "db.json")),
        new WorkspaceManager(path.join(root, "workspaces")),
        runner,
      );
      await service.initialize();
      return service;
    };

    const firstService = await createService();
    const firstApp = await createApp(config, firstService);
    const created = await firstApp.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Baseline Builder" },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json<{ agent: { id: string } }>().agent.id;

    const firstTurn = await firstApp.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "create hello world" },
    });
    expect(firstTurn.statusCode).toBe(202);
    const firstRunId = firstTurn.json<{ run: { id: string } }>().run.id;
    await expect.poll(() => firstService.getRun(firstRunId).status).toBe("completed");

    const secondTurn = await firstApp.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "continue from the same source" },
    });
    expect(secondTurn.statusCode).toBe(202);
    const secondRunId = secondTurn.json<{ run: { id: string } }>().run.id;
    await expect.poll(() => firstService.getRun(secondRunId).status).toBe("completed");
    expect(runner.requests.map((request) => request.threadId)).toEqual([
      null,
      "baseline-thread",
    ]);

    expect(
      (await firstApp.inject({
        method: "POST",
        url: "/api/agents/" + agentId + "/stop",
      })).json<{ agent: { status: string } }>().agent.status,
    ).toBe("stopped");
    expect(
      (await firstApp.inject({
        method: "POST",
        url: "/api/agents/" + agentId + "/start",
      })).json<{ agent: { status: string } }>().agent.status,
    ).toBe("ready");
    const workspacePath = firstService.getAgent(agentId).workspacePath;
    await expect(readFile(path.join(workspacePath, "src", "hello.ts"), "utf8"))
      .resolves.toContain('"hello"');
    await firstApp.close();

    const restartedService = await createService();
    expect(restartedService.getAgent(agentId)).toMatchObject({
      status: "ready",
      codexThreadId: "baseline-thread",
      workspacePath,
    });
    expect(restartedService.getMessages(agentId).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(restartedService.getRuns(agentId)).toHaveLength(2);
    await expect(readFile(path.join(workspacePath, "src", "hello.ts"), "utf8"))
      .resolves.toContain('"hello"');
  });
});
