import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import type { ValidationCommandExecutor } from "./validation-command-runner.js";
import { WorkspaceManager } from "./workspace.js";
import { persistFixtureSession } from "../test/session-fixture.js";
import { waitForRunStatus } from "../test/agent-service-workflow.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    const threadId = request.threadId ?? "fake-thread";
    await persistFixtureSession(request, threadId);
    return {
      output: "Completed: " + request.prompt,
      threadId,
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class InterruptingArchiveWorkspaceManager extends WorkspaceManager {
  private interrupted = false;

  override async archiveAgent(
    agentId: string,
    audit?: Parameters<WorkspaceManager["archiveAgent"]>[1],
  ): Promise<string> {
    const archived = await super.archiveAgent(agentId, audit);
    if (!this.interrupted) {
      this.interrupted = true;
      throw new Error("simulated process interruption after workspace archive");
    }
    return archived;
  }
}

class RecoveryOrderWorkspaceManager extends WorkspaceManager {
  readonly recoveryOrder: string[] = [];

  override async archiveAgent(
    agentId: string,
    audit?: Parameters<WorkspaceManager["archiveAgent"]>[1],
  ): Promise<string> {
    this.recoveryOrder.push("agent-deletion");
    return super.archiveAgent(agentId, audit);
  }

  override async recoverProviderRegistryTransitions(): Promise<void> {
    this.recoveryOrder.push("registry-transition");
    return super.recoverProviderRegistryTransitions();
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  validationCommandExecutor?: ValidationCommandExecutor,
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    validationCommandExecutor,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    const deleted = await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
    const audit = JSON.parse(
      await readFile(
        path.join(deleted.archivedWorkspace, ".airlock-archive-audit.json"),
        "utf8",
      ),
    ) as { schemaVersion: number; agentId: string };
    expect(audit).toMatchObject({ schemaVersion: 2, agentId: agent.id });
  });

  it("completes an interrupted Agent deletion after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-delete-recovery-"));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, "data");
    const workspaceRoot = path.join(root, "workspaces");
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dataDirectory,
      AGENT_WORKSPACE_ROOT: workspaceRoot,
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const databasePath = path.join(dataDirectory, "db.json");
    const first = new AgentService(
      config,
      new JsonStore(databasePath),
      new InterruptingArchiveWorkspaceManager(workspaceRoot),
      new FakeRunner(),
    );
    await first.initialize();
    const agent = await first.createAgent({ name: "Crash safe delete" });

    await expect(first.deleteAgent(agent.id)).rejects.toThrow(
      "simulated process interruption",
    );
    expect(first.getAgent(agent.id).id).toBe(agent.id);
    expect(await readdir(path.join(dataDirectory, "agent-deletion-journal"))).toEqual([
      agent.id + ".json",
    ]);

    const recoveryWorkspaces = new RecoveryOrderWorkspaceManager(workspaceRoot);
    const restarted = new AgentService(
      config,
      new JsonStore(databasePath),
      recoveryWorkspaces,
      new FakeRunner(),
    );
    await restarted.initialize();

    expect(restarted.listAgents()).toEqual([]);
    expect(await readdir(path.join(dataDirectory, "agent-deletion-journal"))).toEqual(
      [],
    );
    const archivedEntries = await readdir(path.join(workspaceRoot, ".deleted"));
    expect(archivedEntries).toHaveLength(1);
    const audit = JSON.parse(
      await readFile(
        path.join(
          workspaceRoot,
          ".deleted",
          archivedEntries[0]!,
          ".airlock-archive-audit.json",
        ),
        "utf8",
      ),
    ) as { schemaVersion: number; agentId: string };
    expect(audit).toEqual(
      expect.objectContaining({ schemaVersion: 2, agentId: agent.id }),
    );
    expect(recoveryWorkspaces.recoveryOrder).toEqual([
      "agent-deletion",
      "registry-transition",
    ]);
  });

  it.each(["missing", "malformed", "changed"] as const)(
    "fails closed when an archived deletion tombstone is %s",
    async (mutation) => {
      const root = await mkdtemp(path.join(tmpdir(), "launchpad-delete-tamper-"));
      temporaryDirectories.push(root);
      const dataDirectory = path.join(root, "data");
      const workspaceRoot = path.join(root, "workspaces");
      const config = loadConfig({
        NODE_ENV: "test",
        APP_DATA_DIR: dataDirectory,
        AGENT_WORKSPACE_ROOT: workspaceRoot,
        CODEX_HOME: path.join(root, "codex"),
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
      });
      const databasePath = path.join(dataDirectory, "db.json");
      const first = new AgentService(
        config,
        new JsonStore(databasePath),
        new InterruptingArchiveWorkspaceManager(workspaceRoot),
        new FakeRunner(),
      );
      await first.initialize();
      const agent = await first.createAgent({ name: "Tamper-safe delete" });
      await expect(first.deleteAgent(agent.id)).rejects.toThrow(
        "simulated process interruption",
      );
      const archivedEntry = (
        await readdir(path.join(workspaceRoot, ".deleted"))
      )[0]!;
      const auditPath = path.join(
        workspaceRoot,
        ".deleted",
        archivedEntry,
        ".airlock-archive-audit.json",
      );
      if (mutation === "missing") {
        await rm(auditPath);
      } else if (mutation === "malformed") {
        await writeFile(auditPath, "{not-json\n");
      } else {
        const audit = JSON.parse(await readFile(auditPath, "utf8")) as {
          aggregate: { evidenceDigest: string };
        };
        audit.aggregate.evidenceDigest = "sha256:" + "f".repeat(64);
        await writeFile(auditPath, JSON.stringify(audit, null, 2) + "\n");
      }

      const restarted = new AgentService(
        config,
        new JsonStore(databasePath),
        new WorkspaceManager(workspaceRoot),
        new FakeRunner(),
      );
      await expect(restarted.initialize()).rejects.toThrow();
      expect(restarted.getAgent(agent.id).id).toBe(agent.id);
      expect(
        await readdir(path.join(dataDirectory, "agent-deletion-journal")),
      ).toEqual([agent.id + ".json"]);
    },
  );

  it("fails deletion closed when the active Agent workspace is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-delete-symlink-"));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, "data");
    const workspaceRoot = path.join(root, "workspaces");
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dataDirectory,
      AGENT_WORKSPACE_ROOT: workspaceRoot,
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(dataDirectory, "db.json")),
      new WorkspaceManager(workspaceRoot),
      new FakeRunner(),
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Symlink-safe delete" });
    const external = path.join(root, "external-host-state");
    await mkdir(external);
    await rm(path.join(workspaceRoot, agent.id), { recursive: true });
    await symlink(external, path.join(workspaceRoot, agent.id));

    await expect(service.deleteAgent(agent.id)).rejects.toThrow(
      "Active Agent workspace is not a regular directory",
    );
    expect(service.getAgent(agent.id).id).toBe(agent.id);
    await expect(
      service.updateOutcomeContract(agent.id, {
        requiredPaths: agent.outcomeContract.requiredPaths,
        protectedPaths: agent.outcomeContract.protectedPaths,
        maxChangedFiles: agent.outcomeContract.maxChangedFiles,
        maxAddedBytes: agent.outcomeContract.maxAddedBytes,
        secretPatterns: agent.outcomeContract.secretPatterns,
        validationCommands: agent.outcomeContract.validationCommands,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(service.getAgent(agent.id).outcomeContract.version).toBe(1);
    await expect(
      readFile(path.join(external, ".airlock-archive-audit.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(dataDirectory, "agent-deletion-journal"))).toEqual([
      agent.id + ".json",
    ]);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await waitForRunStatus(service, run.id, "completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("persists a safe actionable error when ModelArk free capacity is exhausted", async () => {
    const service = await makeService({
      run: async () => {
        throw new Error(
          "429 Too Many Requests: account 3003612015 reached its inference limit; request id: req-secret-123; Bearer ark-secret-live-key",
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Private failure" });
    const { run } = await service.sendMessage(agent.id, "exercise the live model");

    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    const failedRun = service.getRun(run.id);
    const failedAgent = service.getAgent(agent.id);
    expect(failedRun.error).toContain(
      "ModelArk temporarily unavailable because its configured inference limit",
    );
    expect(failedRun.error).toContain("Canonical State remains unchanged");
    expect(failedAgent.lastError).toBe(failedRun.error);
    expect(JSON.stringify({ failedRun, failedAgent })).not.toMatch(
      /3003612015|req-secret-123|ark-secret-live-key/,
    );

    const store = (
      service as unknown as {
        store: JsonStore;
      }
    ).store;
    await store.mutate((database) => {
      const storedRun = database.runs.find((candidate) => candidate.id === run.id);
      const storedAgent = database.agents.find(
        (candidate) => candidate.id === agent.id,
      );
      if (storedRun) {
        storedRun.error =
          "HTTP 429: account 3003612015; request id: req-secret-123";
      }
      if (storedAgent) {
        storedAgent.lastError =
          "HTTP 429: account 3003612015; request id: req-secret-123";
      }
    });

    await service.initialize();
    expect(JSON.stringify(service.getRun(run.id))).not.toMatch(
      /3003612015|req-secret-123/,
    );
    expect(JSON.stringify(service.getAgent(agent.id))).not.toMatch(
      /3003612015|req-secret-123/,
    );
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: async (request) => {
        const result = await pending;
        if (result.threadId) await persistFixtureSession(request, result.threadId);
        return result;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await waitForRunStatus(service, accepted.value.run.id, "completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: async (request) => {
        const result = await pending;
        if (result.threadId) await persistFixtureSession(request, result.threadId);
        return result;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await waitForRunStatus(service, run.id, "completed");
  });

  it("versions Outcome Contracts for future Runs without rewriting history", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Versioned" });
    const first = await service.sendMessage(agent.id, "first contract");
    await waitForRunStatus(service, first.run.id, "completed");

    const current = service.getAgent(agent.id).outcomeContract;
    const updated = await service.updateOutcomeContract(agent.id, {
      requiredPaths: [...current.requiredPaths, "src/**"],
      protectedPaths: current.protectedPaths,
      maxChangedFiles: current.maxChangedFiles,
      maxAddedBytes: current.maxAddedBytes,
      secretPatterns: current.secretPatterns,
      validationCommands: current.validationCommands,
    });
    const second = await service.sendMessage(agent.id, "second contract");
    await waitForRunStatus(service, second.run.id, "completed");

    expect(updated.version).toBe(2);
    expect(service.getRun(first.run.id).transaction).toMatchObject({
      outcomeContractVersion: 1,
      outcomeContract: { version: 1, requiredPaths: ["AGENTS.md", "README.md"] },
    });
    expect(service.getRun(second.run.id).transaction).toMatchObject({
      outcomeContractVersion: 2,
      disposition: "quarantined",
      outcomeContract: {
        version: 2,
        requiredPaths: ["AGENTS.md", "README.md", "src/**"],
      },
    });
  });

  it("rejects Outcome Contract changes while a Run owns the Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: async (request) => {
        const result = await pending;
        if (result.threadId) await persistFixtureSession(request, result.threadId);
        return result;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy contract" });
    const { run } = await service.sendMessage(agent.id, "hold the lock");
    const current = agent.outcomeContract;

    await expect(
      service.updateOutcomeContract(agent.id, {
        requiredPaths: current.requiredPaths,
        protectedPaths: current.protectedPaths,
        maxChangedFiles: current.maxChangedFiles,
        maxAddedBytes: current.maxAddedBytes,
        secretPatterns: current.secretPatterns,
        validationCommands: current.validationCommands,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    finish({ output: "done", threadId: "thread", usage: null });
    await waitForRunStatus(service, run.id, "completed");
  });

  it.each([
    [true, "quarantined"],
    [false, "promoted"],
  ] as const)(
    "treats a failing required=%s command as %s",
    async (required, expectedDisposition) => {
      const service = await makeService(
        new FakeRunner(),
        {
          execute: async () => ({
            exitCode: 1,
            output: "controlled failure",
            durationMs: 2,
            timedOut: false,
            outputExceeded: false,
          }),
        },
      );
      const agent = await service.createAgent({ name: "Command severity" });
      const current = agent.outcomeContract;
      await service.updateOutcomeContract(agent.id, {
        requiredPaths: current.requiredPaths,
        protectedPaths: current.protectedPaths,
        maxChangedFiles: current.maxChangedFiles,
        maxAddedBytes: current.maxAddedBytes,
        secretPatterns: current.secretPatterns,
        validationCommands: [
          { name: "test", command: "npm test", required, timeoutMs: 30_000 },
        ],
      });

      const { run } = await service.sendMessage(agent.id, "validate command severity");
      await waitForRunStatus(service, run.id, "completed");
      const completed = service.getRun(run.id);

      expect(completed.transaction?.disposition).toBe(expectedDisposition);
      expect(completed.transaction?.validations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "command:test",
            required,
            status: "failed",
          }),
        ]),
      );
    },
  );

  it.each([
    {
      label: "symlink",
      validation: "path-safety",
      mutate: (request: RunnerRequest) =>
        symlink("/etc/passwd", path.join(request.workspacePath, "escape")),
      maxChangedFiles: 200,
      maxAddedBytes: 2_097_152,
    },
    {
      label: "required path",
      validation: "required-paths",
      mutate: (request: RunnerRequest) =>
        rm(path.join(request.workspacePath, "README.md")),
      maxChangedFiles: 200,
      maxAddedBytes: 2_097_152,
    },
    {
      label: "outbox symlink",
      validation: "external-action-intents",
      mutate: (request: RunnerRequest) =>
        symlink("/etc/passwd", request.outboxPath),
      maxChangedFiles: 200,
      maxAddedBytes: 2_097_152,
    },
    {
      label: "change limit",
      validation: "change-limits",
      mutate: async (request: RunnerRequest) => {
        await writeFile(path.join(request.workspacePath, "one.txt"), "one\n");
        await writeFile(path.join(request.workspacePath, "two.txt"), "two\n");
      },
      maxChangedFiles: 1,
      maxAddedBytes: 2_097_152,
    },
    {
      label: "added byte limit",
      validation: "change-limits",
      mutate: (request: RunnerRequest) =>
        writeFile(path.join(request.workspacePath, "bytes.txt"), "bytes\n"),
      maxChangedFiles: 200,
      maxAddedBytes: 0,
    },
    {
      label: "secret pattern",
      validation: "secret-patterns",
      mutate: (request: RunnerRequest) =>
        writeFile(
          path.join(request.workspacePath, "leak.txt"),
          "ARK_API_KEY=must-never-promote-12345\n",
        ),
      maxChangedFiles: 200,
      maxAddedBytes: 2_097_152,
    },
  ])(
    "prevents Promotion after a $label failure",
    async ({ validation, mutate, maxChangedFiles, maxAddedBytes }) => {
      const service = await makeService({
        run: async (request) => {
          await mutate(request);
          await persistFixtureSession(request, "future-thread");
          return { output: "candidate changed", threadId: "future-thread", usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      });
      const agent = await service.createAgent({ name: "Structural gate" });
      if (
        maxChangedFiles !== agent.outcomeContract.maxChangedFiles ||
        maxAddedBytes !== agent.outcomeContract.maxAddedBytes
      ) {
        const current = agent.outcomeContract;
        await service.updateOutcomeContract(agent.id, {
          requiredPaths: current.requiredPaths,
          protectedPaths: current.protectedPaths,
          maxChangedFiles,
          maxAddedBytes,
          secretPatterns: current.secretPatterns,
          validationCommands: current.validationCommands,
        });
      }

      const { run } = await service.sendMessage(agent.id, "exercise structural gate");
      await waitForRunStatus(service, run.id, "completed");
      const transaction = service.getRun(run.id).transaction;

      expect(transaction).toMatchObject({
        disposition: "quarantined",
        canonicalStateIdAfter: transaction?.canonicalStateIdBefore,
        canonicalContentHashAfter: transaction?.canonicalContentHashBefore,
      });
      expect(transaction?.validations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: validation, required: true, status: "failed" }),
        ]),
      );
      expect(service.getAgent(agent.id).codexThreadId).toBeNull();
    },
  );
});
