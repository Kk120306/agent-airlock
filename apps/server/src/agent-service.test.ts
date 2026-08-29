import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import type { AirlockRunner } from "./airlock-runner.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import type { ValidationCommandExecutor } from "./validation-command-runner.js";
import { WorkspaceManager } from "./workspace.js";
import { persistFixtureSession } from "../test/session-fixture.js";
import { waitForRunStatus } from "../test/agent-service-workflow.js";
import { buildPortableReceiptDraft } from "./portable-receipt.js";
import { promotionValidationEvidenceHash } from "./promotion-receipt-evidence.js";
import {
  MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY,
  parseModelArkExecutionProfileDisclosureSummary,
  verifyModelArkExecutionProfileDisclosure,
  verifyPortablePromotionEnvelope,
} from "@agent-airlock/portable-promotion-receipt";

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
  environment: NodeJS.ProcessEnv = {},
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
    ...environment,
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

async function makeLiveModelArkService(): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-modelark-test-"));
  temporaryDirectories.push(root);
  const checkedAt = new Date().toISOString();
  const model = "private-model-value";
  const endpointOrigin = "https://private-modelark.example";
  const sha256 = (value: string) =>
    "sha256:" + createHash("sha256").update(value).digest("hex");
  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    CODEX_BIN: "codex",
    RUNTIME_PROVIDER: "container",
    AIRLOCK_MODELARK_DEMO_MODE: "true",
    AIRLOCK_MODELARK_PREFLIGHT_PROOF: JSON.stringify({
      schema: "agent-airlock/modelark-preflight-proof",
      schemaVersion: 1,
      checkedAt,
      generatedAssistantOutput: true,
      modelCommitment: sha256(model),
      endpointOriginCommitment: sha256(endpointOrigin),
      attemptCount: 2,
      requestCount: 3,
      retryDelayMs: 250,
    }),
    ARK_API_KEY: "private-test-key",
    ARK_MODEL: model,
    ARK_BASE_URL: endpointOrigin + "/api/v3",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    new FakeRunner(),
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("reports ModelArk readiness without disclosing configured environment values", async () => {
    const service = await makeService();
    const info = await service.systemInfo();
    expect(info).toMatchObject({
      arkConfigured: true,
      modelProfileDisclosure: "configured-status-only",
    });
    expect(info).not.toHaveProperty("arkBaseUrl");
    expect(info).not.toHaveProperty("arkModel");
    expect(JSON.stringify(info)).not.toContain("ep-test");
    expect(JSON.stringify(info)).not.toContain("test-key");
  });

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
    const completedRun = service.getRun(run.id);
    const executionProfile = completedRun.transaction?.validations.find(
      (validation) => validation.name === "execution-profile",
    );
    expect(executionProfile).toMatchObject({
      status: "passed",
      required: true,
    });
    expect(executionProfile?.summary).toContain(
      "configured ModelArk Responses profile",
    );
    expect(JSON.stringify(executionProfile)).not.toMatch(/test-key|ep-test/);

    const portable = await service.exportPortableReceipt(run.id, {
      disclosureIdentities: [],
      includeAncestry: false,
      localAnchor: false,
      evmPayload: false,
    });
    expect(portable.availableDisclosures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          required: true,
          summary: expect.stringContaining(
            "configured ModelArk Responses profile",
          ),
        }),
      ]),
    );
  });

  it("exports an exact signed ModelArk profile without replacing the human Run summary", async () => {
    const service = await makeLiveModelArkService();
    const agent = await service.createAgent({ name: "Live profile" });
    const { run } = await service.sendMessage(agent.id, "exercise safe profile");
    await waitForRunStatus(service, run.id, "completed");

    const completed = service.getRun(run.id);
    const validation = completed.transaction?.validations.find(
      (candidate) => candidate.name === "execution-profile",
    );
    expect(validation?.summary).toContain(
      "configured ModelArk Responses profile",
    );

    const preview = await service.exportPortableReceipt(run.id, {
      disclosureIdentities: [],
      includeAncestry: false,
      localAnchor: false,
      evmPayload: false,
    });
    const available = preview.availableDisclosures.find(
      (candidate) =>
        candidate.identity === MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY,
    );
    const claim = parseModelArkExecutionProfileDisclosureSummary(
      available?.summary ?? "",
    );
    expect(claim).toMatchObject({
      attemptCount: 2,
      requestCount: 3,
      retryDelayMs: 250,
    });
    expect(JSON.stringify(preview)).not.toMatch(
      /private-model-value|private-modelark\.example|private-test-key/,
    );

    const disclosed = await service.exportPortableReceipt(run.id, {
      disclosureIdentities: [MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY],
      includeAncestry: false,
      localAnchor: false,
      evmPayload: false,
    });
    expect(verifyPortablePromotionEnvelope(disclosed.envelope).valid).toBe(true);
    expect(
      verifyModelArkExecutionProfileDisclosure(
        disclosed.envelope.disclosures[0],
        disclosed.envelope.receipt.decision.decidedAt,
      ),
    ).toEqual(claim);

    const drifted = structuredClone(completed);
    const driftedValidation = drifted.transaction!.validations.find(
      (candidate) => candidate.name === "execution-profile",
    )!;
    const profile = JSON.parse(driftedValidation.output!);
    profile.runtimeProvider = "local-process";
    driftedValidation.output = JSON.stringify(profile);
    drifted.transaction!.promotionReceipt!.validationEvidenceHash =
      promotionValidationEvidenceHash(drifted.transaction!);
    expect(() =>
      buildPortableReceiptDraft({
        run: drifted,
        candidateSet: null,
        candidateSetRuns: [],
        contractVersion: null,
        previousReceiptDigest: null,
      }),
    ).toThrow(/safe profile/);
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

  it("redacts a ModelArk endpoint identifier from persisted Runtime errors and HTTP projections", async () => {
    const endpointId = "ep-private-endpoint-123";
    const configuredModel = "dola-seed-2-1-turbo-260628";
    const configuredBaseUrl = "https://private-modelark.example/api/v3";
    const configuredApiKey = "private-short-key";
    const service = await makeService(
      {
        run: async () => {
          throw new Error(
            "Runtime transport failed for " +
              endpointId +
              " using " +
              configuredModel +
              " at " +
              configuredBaseUrl +
              " with " +
              configuredApiKey +
              " during step-by-step recovery of an ephemeral worker",
          );
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      undefined,
      {
        ARK_API_KEY: configuredApiKey,
        ARK_MODEL: configuredModel,
        ARK_BASE_URL: configuredBaseUrl,
      },
    );
    const agent = await service.createAgent({ name: "Endpoint-safe failure" });
    const { run } = await service.sendMessage(agent.id, "exercise the Runtime");

    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const [runResponse, agentResponse] = await Promise.all([
      app.inject({ method: "GET", url: "/api/runs/" + run.id }),
      app.inject({ method: "GET", url: "/api/agents/" + agent.id }),
    ]);
    await app.close();

    expect(runResponse.statusCode).toBe(200);
    expect(agentResponse.statusCode).toBe(200);
    const serialized = JSON.stringify({
      run: runResponse.json(),
      agent: agentResponse.json(),
    });
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("step-by-step");
    expect(serialized).toContain("ephemeral worker");
    for (const privateValue of [
      endpointId,
      configuredModel,
      configuredBaseUrl,
      configuredApiKey,
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("redacts configured ModelArk values from restart recovery and legacy nested HTTP projections", async () => {
    const endpointId = "ep-recovery-private-123";
    const configuredModel = "recovery-model-private-value";
    const configuredBaseUrl =
      "https://recovery-private-modelark.example/api/v3";
    const configuredApiKey = "recovery-short-key";
    const service = await makeService(new FakeRunner(), undefined, {
      ARK_API_KEY: configuredApiKey,
      ARK_MODEL: configuredModel,
      ARK_BASE_URL: configuredBaseUrl,
    });
    const agent = await service.createAgent({ name: "Recovery-safe failure" });
    const { run } = await service.sendMessage(agent.id, "complete before restart");
    await waitForRunStatus(service, run.id, "completed");

    const legacyPrivateDetail =
      "provider recovery using " +
      configuredModel +
      " at " +
      configuredBaseUrl +
      " with " +
      configuredApiKey +
      " kept step-by-step evidence for an ephemeral worker";
    const privateRecoveryDetail =
      "provider recovery for " + endpointId + ": " + legacyPrivateDetail;
    const store = (
      service as unknown as {
        store: JsonStore;
      }
    ).store;
    const originalRun = structuredClone(service.getRun(run.id));
    const originalAgent = structuredClone(service.getAgent(agent.id));
    await store.mutate((database) => {
      const storedRun = database.runs.find((candidate) => candidate.id === run.id);
      const storedAgent = database.agents.find(
        (candidate) => candidate.id === agent.id,
      );
      if (!storedRun?.transaction || !storedAgent) {
        throw new Error("recovery redaction fixture is incomplete");
      }
      storedRun.status = "failed";
      storedRun.error = legacyPrivateDetail;
      storedRun.transaction.status = "recovery-error";
      storedRun.transaction.disposition = null;
      storedRun.transaction.recovery.recoveryError = legacyPrivateDetail;
      storedRun.transaction.promotionReceipt = null;
      storedAgent.status = "error";
      storedAgent.lastError = legacyPrivateDetail;
    });

    await (
      service as unknown as {
        sanitizePersistedErrors: () => Promise<void>;
      }
    ).sanitizePersistedErrors();
    const legacyProjection = JSON.stringify({
      run: service.getRun(run.id),
      agent: service.getAgent(agent.id),
    });
    expect(legacyProjection).toContain("[REDACTED]");
    expect(legacyProjection).toContain("step-by-step");
    expect(legacyProjection).toContain("ephemeral worker");
    for (const privateValue of [
      configuredModel,
      configuredBaseUrl,
      configuredApiKey,
    ]) {
      expect(legacyProjection).not.toContain(privateValue);
    }

    await store.mutate((database) => {
      const storedRun = database.runs.find((candidate) => candidate.id === run.id);
      const storedAgent = database.agents.find(
        (candidate) => candidate.id === agent.id,
      );
      if (!storedRun?.transaction || !storedAgent) {
        throw new Error("recovery redaction fixture is incomplete");
      }
      storedRun.status = originalRun.status;
      storedRun.error = originalRun.error;
      storedRun.completedAt = originalRun.completedAt;
      storedRun.transaction = structuredClone(originalRun.transaction!);
      storedAgent.status = originalAgent.status;
      storedAgent.lastError = originalAgent.lastError;
      storedAgent.updatedAt = originalAgent.updatedAt;
    });

    const failureTransaction = structuredClone(
      service.getRun(run.id).transaction!,
    );
    failureTransaction.status = "recovery-error";
    failureTransaction.disposition = null;
    failureTransaction.recovery.recoveredAfterRestart = true;
    failureTransaction.recovery.recoveryError = privateRecoveryDetail;
    failureTransaction.promotionReceipt = null;
    const recoveryRunner = (
      service as unknown as {
        runner: AirlockRunner;
      }
    ).runner;
    recoveryRunner.reconcilePromotions = async () => ({
      recovered: [],
      failures: [
        {
          runId: run.id,
          agentId: agent.id,
          message: privateRecoveryDetail,
          transaction: failureTransaction,
        },
      ],
      protectedRunIds: new Set([run.id]),
    });

    await service.initialize();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const [runResponse, agentResponse] = await Promise.all([
      app.inject({ method: "GET", url: "/api/runs/" + run.id }),
      app.inject({ method: "GET", url: "/api/agents/" + agent.id }),
    ]);
    await app.close();

    expect(runResponse.statusCode).toBe(200);
    expect(agentResponse.statusCode).toBe(200);
    const recoveryProjection = JSON.stringify({
      run: runResponse.json(),
      agent: agentResponse.json(),
    });
    expect(recoveryProjection).toContain("[REDACTED]");
    expect(recoveryProjection).toContain("step-by-step");
    expect(recoveryProjection).toContain("ephemeral worker");
    for (const privateValue of [
      endpointId,
      configuredModel,
      configuredBaseUrl,
      configuredApiKey,
    ]) {
      expect(recoveryProjection).not.toContain(privateValue);
    }
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
