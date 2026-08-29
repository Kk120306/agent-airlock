import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { waitForRunStatus } from "../test/agent-service-workflow.js";
import { persistFixtureSession } from "../test/session-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class SharedPlatformRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    const rejected = request.prompt.includes("invalid Candidate");
    await writeFile(
      path.join(request.workspacePath, "agent-state.txt"),
      request.agentId + ":" + (rejected ? "rejected" : "accepted") + "\n",
      "utf8",
    );
    if (rejected) {
      await unlink(path.join(request.workspacePath, "AGENTS.md"));
    }
    const threadId = request.threadId ?? "thread-" + request.agentId;
    await persistFixtureSession(request, threadId);
    return {
      output: rejected ? "invalid Candidate prepared" : "Candidate prepared",
      threadId,
      usage: null,
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

describe("Track 1 reusable platform middleware", () => {
  it("isolates different Agents behind the same Candidate State boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-track-one-reuse-"));
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
    const platformRunner = new SharedPlatformRunner();
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "launchpad.json")),
      workspaces,
      platformRunner,
    );
    await service.initialize();

    const [releaseAgent, migrationAgent] = await Promise.all([
      service.createAgent({ name: "Release Agent" }),
      service.createAgent({ name: "Migration Agent" }),
    ]);
    const initialCanonical = await Promise.all([
      workspaces.readCanonical(releaseAgent.id),
      workspaces.readCanonical(migrationAgent.id),
    ]);

    const accepted = await Promise.all([
      service.sendMessage(releaseAgent.id, "prepare accepted release"),
      service.sendMessage(migrationAgent.id, "prepare accepted migration"),
    ]);
    await Promise.all(
      accepted.map(({ run }) => waitForRunStatus(service, run.id, "completed")),
    );

    const acceptedCanonical = await Promise.all([
      workspaces.readCanonical(releaseAgent.id),
      workspaces.readCanonical(migrationAgent.id),
    ]);
    expect(acceptedCanonical[0].stateId).not.toBe(initialCanonical[0].stateId);
    expect(acceptedCanonical[1].stateId).not.toBe(initialCanonical[1].stateId);
    await expect(
      readFile(
        path.join(acceptedCanonical[0].workspacePath, "agent-state.txt"),
        "utf8",
      ),
    ).resolves.toBe(releaseAgent.id + ":accepted\n");
    await expect(
      readFile(
        path.join(acceptedCanonical[1].workspacePath, "agent-state.txt"),
        "utf8",
      ),
    ).resolves.toBe(migrationAgent.id + ":accepted\n");

    const rejected = await Promise.all([
      service.sendMessage(
        releaseAgent.id,
        "prepare invalid Candidate for release",
      ),
      service.sendMessage(
        migrationAgent.id,
        "prepare invalid Candidate for migration",
      ),
    ]);
    await Promise.all(
      rejected.map(({ run }) => waitForRunStatus(service, run.id, "completed")),
    );

    const canonicalAfterRejection = await Promise.all([
      workspaces.readCanonical(releaseAgent.id),
      workspaces.readCanonical(migrationAgent.id),
    ]);
    expect(canonicalAfterRejection).toEqual(acceptedCanonical);
    for (const [index, { run }] of rejected.entries()) {
      const agent = index === 0 ? releaseAgent : migrationAgent;
      const transaction = service.getRun(run.id).transaction;
      expect(transaction).toMatchObject({
        disposition: "quarantined",
        canonicalStateIdBefore: acceptedCanonical[index]!.stateId,
        canonicalStateIdAfter: acceptedCanonical[index]!.stateId,
        canonicalContentHashBefore: acceptedCanonical[index]!.contentHash,
        canonicalContentHashAfter: acceptedCanonical[index]!.contentHash,
      });
      await expect(
        readFile(
          path.join(
            transaction?.quarantinePath ?? "",
            "workspace",
            "agent-state.txt",
          ),
          "utf8",
        ),
      ).resolves.toBe(agent.id + ":rejected\n");
    }

    const candidateBoundary = await realpath(
      path.join(config.workspaceRoot, ".candidates"),
    );
    const canonicalRoots = await Promise.all(
      acceptedCanonical.map((canonical) =>
        realpath(path.dirname(canonical.workspacePath)),
      ),
    );
    expect(platformRunner.requests).toHaveLength(4);
    expect(
      new Set(platformRunner.requests.map((request) => request.agentId)),
    ).toEqual(new Set([releaseAgent.id, migrationAgent.id]));
    expect(
      new Set(
        platformRunner.requests.map((request) =>
          path.dirname(request.workspacePath),
        ),
      ).size,
    ).toBe(4);
    for (const request of platformRunner.requests) {
      const candidateRoot = path.dirname(request.workspacePath);
      expect(
        isWithin(candidateBoundary, candidateRoot),
        candidateRoot + " must be inside " + candidateBoundary,
      ).toBe(true);
      expect(path.dirname(request.codexHomePath)).toBe(candidateRoot);
      expect(path.dirname(path.dirname(request.outboxPath))).toBe(candidateRoot);
      expect(request.repairReferencePath ?? null).toBeNull();
      for (const writablePath of [
        request.workspacePath,
        request.codexHomePath,
        request.outboxPath,
      ]) {
        for (const canonicalRoot of canonicalRoots) {
          expect(isWithin(canonicalRoot, writablePath)).toBe(false);
        }
      }
    }
  });
});
