import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  it("promotes a passing Candidate State without exposing Canonical State", async () => {
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        requests.push(structuredClone(request));
        await writeFile(path.join(request.workspacePath, "feature.txt"), "accepted\n");
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
      validations: [
        {
          name: "required-paths",
          status: "failed",
          summary: "Required path AGENTS.md is missing",
        },
      ],
    });
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
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(workspaceRoot),
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
    await expect(readFile(path.join(migrated.workspacePath, "legacy.txt"), "utf8"))
      .resolves.toBe("preserved\n");
  });
});
