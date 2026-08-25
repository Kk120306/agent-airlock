import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
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

interface Harness {
  root: string;
  service: AgentService;
  workspaces: WorkspaceManager;
}

async function makeHarness(runner: AgentRunner): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-one-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    workspaces,
    runner,
  );
  await service.initialize();
  return { root, service, workspaces };
}

async function waitForRun(service: AgentService, runId: string) {
  await expect
    .poll(() => service.getRun(runId).status, { timeout: 3_000 })
    .toMatch(/^(completed|failed|cancelled)$/);
  return service.getRun(runId);
}

describe("Phase 1 transactional workspace", () => {
  it("promotes accepted reasoning and excludes rejected reasoning from the next turn", async () => {
    let turn = 0;
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        requests.push(structuredClone(request));
        const sessionPath = path.join(
          request.codexHomePath,
          "sessions",
          "fixture",
          "rollout-thread-main.jsonl",
        );
        if (turn === 0) {
          await writeFile(path.join(request.workspacePath, "accepted.txt"), "accepted\n");
          await persistFixtureSession(request, "thread-main", "accepted-reasoning");
          turn += 1;
          return { output: "accepted first turn", threadId: "thread-main", usage: null };
        }

        const memory = await readFile(sessionPath, "utf8");
        expect(memory).toContain("accepted-reasoning");
        if (turn === 1) {
          await persistFixtureSession(request, "thread-main", "rejected-reasoning");
          await rm(path.join(request.workspacePath, "AGENTS.md"));
          turn += 1;
          return { output: "rejected second turn", threadId: "thread-main", usage: null };
        }

        expect(memory).not.toContain("rejected-reasoning");
        await expect(
          readFile(path.join(request.workspacePath, "accepted.txt"), "utf8"),
        ).resolves.toBe("accepted\n");
        await persistFixtureSession(request, "thread-main", "recovered-reasoning");
        turn += 1;
        return { output: "continued accepted future", threadId: "thread-main", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, workspaces } = await makeHarness(runner);
    const agent = await service.createAgent({ name: "Whole Agent" });
    const initial = await workspaces.readCanonical(agent.id);

    const first = await service.sendMessage(agent.id, "create accepted state");
    const firstRun = await waitForRun(service, first.run.id);
    const accepted = await workspaces.readCanonical(agent.id);
    expect(firstRun.transaction?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workspace", disposition: "promoted" }),
        expect.objectContaining({ kind: "codex-session", disposition: "promoted" }),
      ]),
    );
    expect(accepted.codexThreadId).toBe("thread-main");
    expect(accepted.sessionContentHash).not.toBe(initial.sessionContentHash);

    const second = await service.sendMessage(agent.id, "delete AGENTS.md");
    const secondRun = await waitForRun(service, second.run.id);
    const afterRejection = await workspaces.readCanonical(agent.id);
    expect(afterRejection).toEqual(accepted);
    expect(secondRun.transaction?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "workspace",
          disposition: "quarantined",
          fingerprintAfter: accepted.workspaceContentHash,
        }),
        expect.objectContaining({
          kind: "codex-session",
          disposition: "quarantined",
          fingerprintAfter: accepted.sessionContentHash,
        }),
      ]),
    );
    await expect(
      readFile(
        path.join(
          secondRun.transaction?.quarantinePath ?? "",
          "codex-home",
          "sessions",
          "fixture",
          "rollout-thread-main.jsonl",
        ),
        "utf8",
      ),
    ).resolves.toContain("rejected-reasoning");

    const third = await service.sendMessage(agent.id, "continue accepted future");
    const thirdRun = await waitForRun(service, third.run.id);
    expect(thirdRun.output).toBe("continued accepted future");
    expect(turn).toBe(3);
    const runIds = [first.run.id, second.run.id, third.run.id];
    for (const [index, request] of requests.entries()) {
      expect(request.workspacePath).toContain(
        path.join(".candidates", runIds[index] ?? "missing-run"),
      );
      expect(request.codexHomePath).toContain(".candidates");
      expect(request.workspacePath).not.toBe(initial.workspacePath);
      expect(request.codexHomePath).not.toBe(initial.codexHomePath);
      expect(request.workspacePath).not.toBe(accepted.workspacePath);
      expect(request.codexHomePath).not.toBe(accepted.codexHomePath);
    }
  });

  it("promotes a passing Candidate State without exposing Canonical State", async () => {
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        requests.push(structuredClone(request));
        await writeFile(path.join(request.workspacePath, "feature.txt"), "accepted\n");
        await persistFixtureSession(request, "thread-one", "accepted reasoning");
        return { output: "created feature", threadId: "thread-one", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, workspaces } = await makeHarness(runner);
    const agent = await service.createAgent({ name: "Promoter" });
    const before = await workspaces.readCanonical(agent.id);

    const { run } = await service.sendMessage(agent.id, "create a safe feature");
    const completed = await waitForRun(service, run.id);
    const after = await workspaces.readCanonical(agent.id);

    expect(completed.status).toBe("completed");
    expect(completed.transaction).toMatchObject({
      disposition: "promoted",
      canonicalStateIdBefore: before.stateId,
      canonicalStateIdAfter: after.stateId,
      canonicalContentHashBefore: before.contentHash,
      canonicalContentHashAfter: after.contentHash,
    });
    expect(after.stateId).not.toBe(before.stateId);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(requests[0]?.workspacePath).toContain(path.join(".candidates", run.id));
    expect(requests[0]?.workspacePath).not.toBe(before.workspacePath);
    await expect(readFile(path.join(after.workspacePath, "feature.txt"), "utf8"))
      .resolves.toBe("accepted\n");
    await expect(access(path.join(before.workspacePath, "feature.txt"))).rejects.toThrow();
    expect(service.getAgent(agent.id)).toMatchObject({
      workspacePath: after.workspacePath,
      canonicalStateId: after.stateId,
      codexThreadId: "thread-one",
    });
  });

  it("quarantines a destructive candidate and preserves the canonical fingerprint", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        await rm(path.join(request.workspacePath, "AGENTS.md"));
        await writeFile(path.join(request.workspacePath, "damage.txt"), "not accepted\n");
        await persistFixtureSession(request, "rejected-thread", "rejected reasoning");
        return { output: "deleted instructions", threadId: "rejected-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, workspaces } = await makeHarness(runner);
    const agent = await service.createAgent({ name: "Breaker" });
    const before = await workspaces.readCanonical(agent.id);

    const { run } = await service.sendMessage(agent.id, "delete required instructions");
    const completed = await waitForRun(service, run.id);
    const after = await workspaces.readCanonical(agent.id);

    expect(completed.status).toBe("completed");
    expect(completed.transaction).toMatchObject({
      disposition: "quarantined",
      canonicalStateIdBefore: before.stateId,
      canonicalStateIdAfter: before.stateId,
      canonicalContentHashBefore: before.contentHash,
      canonicalContentHashAfter: before.contentHash,
      promotionReceipt: {
        disposition: "quarantined",
        outcomeContractVersion: 1,
      },
    });
    expect(completed.transaction?.validations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "protected-paths",
          status: "failed",
          summary: "Protected paths changed: AGENTS.md",
        }),
        expect.objectContaining({
          name: "required-paths",
          status: "failed",
          summary: "Required path patterns are missing: AGENTS.md",
        }),
      ]),
    );
    expect(after).toEqual(before);
    await expect(readFile(path.join(after.workspacePath, "AGENTS.md"), "utf8"))
      .resolves.toContain("Platform-managed Agent instructions");
    await expect(access(path.join(after.workspacePath, "damage.txt"))).rejects.toThrow();
    expect(completed.transaction?.quarantinePath).toBeTruthy();
    await expect(
      readFile(
        path.join(completed.transaction?.quarantinePath ?? "", "workspace", "damage.txt"),
        "utf8",
      ),
    ).resolves.toBe("not accepted\n");
    expect(service.getAgent(agent.id)).toMatchObject({
      workspacePath: before.workspacePath,
      canonicalStateId: before.stateId,
      codexThreadId: null,
    });
  });

  it("quarantines Runtime failure without changing Canonical State", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "partial.txt"), "partial\n");
        throw new Error("controlled Runtime failure");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, workspaces } = await makeHarness(runner);
    const agent = await service.createAgent({ name: "Failing" });
    const before = await workspaces.readCanonical(agent.id);

    const { run } = await service.sendMessage(agent.id, "fail after writing");
    const failed = await waitForRun(service, run.id);
    const after = await workspaces.readCanonical(agent.id);

    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("controlled Runtime failure");
    expect(failed.transaction?.disposition).toBe("quarantined");
    expect(after).toEqual(before);
    await expect(access(path.join(after.workspacePath, "partial.txt"))).rejects.toThrow();
  });

  it("quarantines a Candidate Codex home that contains a symbolic link", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        await persistFixtureSession(request, "thread-symlink");
        await symlink("/etc/passwd", path.join(request.codexHomePath, "escape"));
        return { output: "session changed", threadId: "thread-symlink", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, workspaces } = await makeHarness(runner);
    const agent = await service.createAgent({ name: "Session containment" });
    const before = await workspaces.readCanonical(agent.id);

    const { run } = await service.sendMessage(agent.id, "create unsafe session link");
    const failed = await waitForRun(service, run.id);

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Candidate Codex session contains a symbolic link");
    expect(failed.transaction?.disposition).toBe("quarantined");
    expect(await workspaces.readCanonical(agent.id)).toEqual(before);
    await expect(
      access(path.join(failed.transaction?.quarantinePath ?? "", "codex-home", "escape")),
    ).resolves.toBeUndefined();
  });

  it("cancels Candidate State without Promotion", async () => {
    let rejectRun!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let candidatePath = "";
    const runner: AgentRunner = {
      run: async (request): Promise<RunnerResult> => {
        candidatePath = request.workspacePath;
        await writeFile(path.join(candidatePath, "cancelled.txt"), "cancelled\n");
        markStarted();
        return new Promise<RunnerResult>((_resolve, reject) => {
          rejectRun = reject;
        });
      },
      cancel: async () => {
        rejectRun(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    };
    const { service, workspaces } = await makeHarness(runner);
    const agent = await service.createAgent({ name: "Cancelled" });
    const before = await workspaces.readCanonical(agent.id);

    const { run } = await service.sendMessage(agent.id, "wait for cancellation");
    await started;
    await service.stopAgent(agent.id);
    const cancelled = service.getRun(run.id);
    const after = await workspaces.readCanonical(agent.id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.transaction?.disposition).toBe("cancelled");
    expect(after).toEqual(before);
    await expect(access(candidatePath)).rejects.toThrow();
    await expect(access(path.join(after.workspacePath, "cancelled.txt"))).rejects.toThrow();
  });

  it("adopts a starter version 1 workspace without losing files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-migration-"));
    temporaryDirectories.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const legacyWorkspace = path.join(workspaceRoot, "11111111-1111-4111-8111-111111111111");
    await mkdir(legacyWorkspace, { recursive: true });
    await writeFile(path.join(legacyWorkspace, "legacy.txt"), "preserved\n");
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "data", "db.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Legacy",
            description: "",
            instructions: "",
            status: "ready",
            workspacePath: legacyWorkspace,
            codexThreadId: "legacy-thread",
            lastError: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        messages: [],
        runs: [],
      }) + "\n",
    );
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: workspaceRoot,
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const legacySessions = path.join(
      config.codexHome,
      "sessions",
      "2026",
      "01",
      "01",
    );
    await mkdir(legacySessions, { recursive: true });
    await writeFile(
      path.join(legacySessions, "rollout-legacy-thread.jsonl"),
      '{"threadId":"legacy-thread","memory":"preserved"}\n',
    );
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(workspaceRoot, config.codexHome),
      {
        run: async () => ({ output: "unused", threadId: null, usage: null }),
        cancel: async () => false,
        isAvailable: async () => true,
      },
    );

    await service.initialize();
    const migrated = service.getAgent("11111111-1111-4111-8111-111111111111");
    expect(migrated.canonicalStateId).toBeTruthy();
    expect(migrated.workspacePath).not.toBe(legacyWorkspace);
    expect(migrated.codexThreadId).toBe("legacy-thread");
    const canonical = await new WorkspaceManager(
      workspaceRoot,
      config.codexHome,
    ).readCanonical(migrated.id);
    await expect(
      readFile(
        path.join(
          canonical.codexHomePath,
          "sessions",
          "2026",
          "01",
          "01",
          "rollout-legacy-thread.jsonl",
        ),
        "utf8",
      ),
    ).resolves.toContain("preserved");
    await expect(readFile(path.join(migrated.workspacePath, "legacy.txt"), "utf8"))
      .resolves.toBe("preserved\n");
  });

  it("resets a legacy thread that has no matching Codex rollout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-session-reset-"));
    temporaryDirectories.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const agentId = "22222222-2222-4222-8222-222222222222";
    const legacyWorkspace = path.join(workspaceRoot, agentId);
    await mkdir(legacyWorkspace, { recursive: true });
    await writeFile(path.join(legacyWorkspace, "legacy.txt"), "preserved\n");
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "data", "db.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: agentId,
            name: "Legacy without rollout",
            description: "",
            instructions: "",
            status: "ready",
            workspacePath: legacyWorkspace,
            codexThreadId: "missing-thread",
            lastError: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        messages: [],
        runs: [],
      }) + "\n",
    );
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: workspaceRoot,
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const workspaces = new WorkspaceManager(workspaceRoot, config.codexHome);
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      workspaces,
      {
        run: async () => ({ output: "unused", threadId: null, usage: null }),
        cancel: async () => false,
        isAvailable: async () => true,
      },
    );

    await service.initialize();

    expect(service.getAgent(agentId).codexThreadId).toBeNull();
    expect((await workspaces.readCanonical(agentId)).codexThreadId).toBeNull();
    await expect(
      readFile(path.join(service.getAgent(agentId).workspacePath, "legacy.txt"), "utf8"),
    ).resolves.toBe("preserved\n");
  });
});
