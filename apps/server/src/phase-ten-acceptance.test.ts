import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { createRunTransaction } from "./airlock-runner.js";
import {
  applyAssuranceOperations,
  deriveAssuranceProposal,
  outcomeContractHash,
  verifyAssuranceProposalIntegrity,
} from "./assurance.js";
import { stableJson } from "./candidate-selection.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createDefaultOutcomeContract } from "./outcome-contract.js";
import { JsonStore } from "./store.js";
import type {
  AgentRun,
  AgentRunner,
  CanonicalStateReference,
  OutcomeContract,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const runner: AgentRunner = {
  run: async () => ({ output: "unused", threadId: null, usage: null }),
  cancel: async () => false,
  isAvailable: async () => true,
};

const canonical: CanonicalStateReference = {
  stateId: "state-one",
  workspacePath: "/bounded/workspace",
  codexHomePath: "/bounded/codex",
  outboxPath: "/bounded/outbox",
  codexThreadId: null,
  workspaceContentHash: "sha256:" + "1".repeat(64),
  sessionContentHash: "sha256:" + "2".repeat(64),
  sqliteContentHash: "sha256:" + "3".repeat(64),
  outboxContentHash: "sha256:" + "4".repeat(64),
  providerVersions: [],
  contentHash: "sha256:" + "5".repeat(64),
};

function deletedPathRun(
  agentId: string,
  runId: string,
  rootRunId: string,
  contract: OutcomeContract,
): AgentRun {
  const transaction = createRunTransaction(runId, canonical, contract);
  transaction.status = "quarantined";
  transaction.disposition = "quarantined";
  transaction.lineage.rootRunId = rootRunId;
  if (rootRunId !== runId) {
    transaction.lineage.parentRunId = rootRunId;
    transaction.lineage.depth = 1;
  }
  transaction.changes = {
    files: [{ path: "README.md", kind: "deleted", addedBytes: 0 }],
    totalChangedFiles: 1,
    totalAddedBytes: 0,
    truncated: false,
  };
  transaction.validations = [
    {
      name: "required-paths",
      status: "failed",
      required: true,
      summary: "Required path is missing",
      durationMs: 1,
      output: null,
    },
  ];
  return {
    id: runId,
    agentId,
    candidateSetId: null,
    competitorId: null,
    status: "failed",
    prompt: "redacted from assurance evidence",
    output: null,
    error: "Outcome Contract rejected Candidate State",
    usage: null,
    transaction,
    startedAt: "2026-08-26T00:00:00.000Z",
    completedAt: "2026-08-26T00:00:01.000Z",
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

function optionalCommandFailureRun(
  agentId: string,
  runId: string,
  contract: OutcomeContract,
): AgentRun {
  const transaction = createRunTransaction(runId, canonical, contract);
  transaction.status = "promoted";
  transaction.disposition = "promoted";
  transaction.changes = {
    files: [],
    totalChangedFiles: 0,
    totalAddedBytes: 0,
    truncated: false,
  };
  transaction.validations = [
    {
      name: "command:lint",
      status: "failed",
      required: false,
      summary: "Validation command exited with code 1",
      durationMs: 1,
      output: null,
    },
  ];
  return {
    id: runId,
    agentId,
    candidateSetId: null,
    competitorId: null,
    status: "completed",
    prompt: "redacted from assurance evidence",
    output: null,
    error: null,
    usage: null,
    transaction,
    startedAt: "2026-08-26T00:00:00.000Z",
    completedAt: "2026-08-26T00:00:01.000Z",
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

function limitEvidenceRun(
  agentId: string,
  runId: string,
  rootRunId: string,
  contract: OutcomeContract,
  totalChangedFiles: number,
  totalAddedBytes: number,
  promoted: boolean,
): AgentRun {
  const transaction = createRunTransaction(runId, canonical, contract);
  transaction.status = promoted ? "promoted" : "quarantined";
  transaction.disposition = promoted ? "promoted" : "quarantined";
  transaction.lineage.rootRunId = rootRunId;
  if (rootRunId !== runId) {
    transaction.lineage.parentRunId = rootRunId;
    transaction.lineage.depth = 1;
  }
  transaction.changes = {
    files: [],
    totalChangedFiles,
    totalAddedBytes,
    truncated: false,
  };
  transaction.validations = [
    {
      name: "change-limits",
      status: promoted ? "passed" : "failed",
      required: true,
      summary: promoted ? "Within limits" : "Exceeded a limit",
      durationMs: 1,
      output: null,
    },
  ];
  return {
    id: runId,
    agentId,
    candidateSetId: null,
    competitorId: null,
    status: promoted ? "completed" : "failed",
    prompt: "redacted from assurance evidence",
    output: null,
    error: promoted ? null : "Outcome Contract rejected Candidate State",
    usage: null,
    transaction,
    startedAt: "2026-08-26T00:00:00.000Z",
    completedAt: "2026-08-26T00:00:01.000Z",
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

async function makeHarness(): Promise<{
  config: AppConfig;
  root: string;
  service: AgentService;
  store: JsonStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-ten-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return { config, root, service, store };
}

describe("Phase 10 Adaptive Assurance", () => {
  it("derives the same bounded proposal from the same unique lineages", () => {
    const contract = createDefaultOutcomeContract(
      1,
      "2026-08-26T00:00:00.000Z",
    );
    const runs = [
      deletedPathRun("agent-one", "run-one", "root-one", contract),
      deletedPathRun("agent-one", "run-one-repair", "root-one", contract),
      deletedPathRun("agent-one", "run-two", "root-two", contract),
      deletedPathRun("agent-one", "run-three", "root-three", contract),
    ];
    const incomplete = deletedPathRun(
      "agent-one",
      "run-unknown",
      "root-unknown",
      contract,
    );
    incomplete.status = "completed";
    incomplete.transaction!.status = "promoted";
    incomplete.transaction!.disposition = "promoted";
    incomplete.transaction!.changes = null;
    runs.push(incomplete);

    const first = deriveAssuranceProposal(
      "agent-one",
      contract,
      runs,
      "2026-08-26T01:00:00.000Z",
    );
    const second = deriveAssuranceProposal(
      "agent-one",
      contract,
      [...runs].reverse(),
      "2026-08-26T02:00:00.000Z",
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(second?.proposalDigest).toBe(first?.proposalDigest);
    expect(first?.operations).toEqual([
      { kind: "add-protected-path", path: "README.md" },
    ]);
    expect(first?.citations).toHaveLength(3);
    expect(new Set(first?.citations.map((citation) => citation.rootRunId)).size).toBe(
      3,
    );
    expect(first?.simulation.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-two",
          classification: "exact",
          counterfactualDisposition: "quarantined",
        }),
      ]),
    );
    expect(first?.simulation.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-unknown",
          classification: "unknown",
          counterfactualDisposition: null,
          missingInputs: ["transaction.changes"],
        }),
      ]),
    );
  });

  it("does not let repair siblings inflate support", () => {
    const contract = createDefaultOutcomeContract();
    const proposal = deriveAssuranceProposal("agent-one", contract, [
      deletedPathRun("agent-one", "run-one", "root-one", contract),
      deletedPathRun("agent-one", "run-one-repair", "root-one", contract),
      deletedPathRun("agent-one", "run-two", "root-two", contract),
    ]);
    expect(proposal).toBeNull();
  });

  it("does not derive advice from text that exceeds durable byte boundaries", () => {
    const contract = createDefaultOutcomeContract();
    const oversizedPath = "界".repeat(100) + ".md";
    const runs = ["one", "two", "three"].map((suffix) => {
      const run = deletedPathRun(
        "agent-one",
        "run-" + suffix,
        "root-" + suffix,
        contract,
      );
      run.transaction!.changes!.files[0]!.path = oversizedPath;
      return run;
    });

    expect(deriveAssuranceProposal("agent-one", contract, runs)).toBeNull();
  });

  it("requires exact historical command identity before counting or simulating support", () => {
    const contract: OutcomeContract = {
      ...createDefaultOutcomeContract(),
      validationCommands: [
        {
          name: "lint",
          command: "npm run lint",
          required: false,
          timeoutMs: 1_000,
        },
      ],
    };
    const incompatibleContract: OutcomeContract = {
      ...contract,
      validationCommands: [
        {
          name: "lint",
          command: "npm run legacy-lint",
          required: false,
          timeoutMs: 1_000,
        },
      ],
    };
    const incompatibleRuns = ["one", "two", "three"].map((suffix) =>
      optionalCommandFailureRun(
        "agent-one",
        "legacy-" + suffix,
        incompatibleContract,
      ),
    );

    expect(
      deriveAssuranceProposal("agent-one", contract, incompatibleRuns),
    ).toBeNull();

    const proposal = deriveAssuranceProposal("agent-one", contract, [
      ...incompatibleRuns.slice(0, 1),
      ...["one", "two", "three"].map((suffix) =>
        optionalCommandFailureRun("agent-one", "current-" + suffix, contract),
      ),
    ]);
    expect(proposal?.operations).toEqual([
      expect.objectContaining({
        kind: "make-command-required",
        name: "lint",
        timeoutMs: 1_000,
      }),
    ]);
    expect(proposal?.simulation.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "legacy-one",
          classification: "unknown",
          counterfactualDisposition: null,
          missingInputs: ["matching Outcome Contract command identity"],
        }),
      ]),
    );
  });

  it("derives each resource limit only from a cited metric-specific cohort", () => {
    const contract: OutcomeContract = {
      ...createDefaultOutcomeContract(),
      maxChangedFiles: 10,
      maxAddedBytes: 1_000,
    };
    const runs = [
      limitEvidenceRun("agent-one", "failed-one", "failed-root-one", contract, 1, 1_500, false),
      limitEvidenceRun("agent-one", "failed-two", "failed-root-two", contract, 1, 1_600, false),
      limitEvidenceRun("agent-one", "success-one", "success-root-one", contract, 1, 400, true),
      limitEvidenceRun("agent-one", "success-two", "success-root-two", contract, 1, 500, true),
      limitEvidenceRun("agent-one", "success-three", "success-root-three", contract, 1, 450, true),
      limitEvidenceRun("agent-one", "success-high", "success-root-high", contract, 1, 800, true),
    ];

    const proposal = deriveAssuranceProposal("agent-one", contract, runs);
    expect(proposal?.operations).toEqual([
      { kind: "lower-max-added-bytes", maximum: 800 },
    ]);
    expect(proposal?.citations).toHaveLength(5);
    expect(proposal?.citations.map((citation) => citation.runId)).toContain(
      "success-high",
    );
  });

  it("can recommend only an exact trusted secret catalog rule", () => {
    const contract = createDefaultOutcomeContract();
    const runs = ["one", "two"].map((suffix) => {
      const run = deletedPathRun(
        "agent-one",
        "run-" + suffix,
        "root-" + suffix,
        contract,
      );
      run.status = "completed";
      run.transaction!.status = "promoted";
      run.transaction!.disposition = "promoted";
      run.transaction!.changes = null;
      run.transaction!.validations = [
        {
          name: "assurance-catalog-rule:private-key-block:v1",
          status: "failed",
          required: false,
          summary: "Trusted catalog detector matched in 1 changed file(s)",
          durationMs: 1,
          output: null,
        },
      ];
      return run;
    });
    const incomplete = deletedPathRun(
      "agent-one",
      "run-incomplete",
      "root-incomplete",
      contract,
    );
    incomplete.status = "completed";
    incomplete.transaction!.status = "promoted";
    incomplete.transaction!.disposition = "promoted";
    incomplete.transaction!.changes = null;
    incomplete.transaction!.validations = [
      {
        name: "assurance-catalog-rule:private-key-block:v1",
        status: "error",
        required: false,
        summary: "Trusted catalog detector lacks complete bounded file evidence",
        durationMs: 1,
        output: null,
      },
    ];
    runs.push(incomplete);
    const proposal = deriveAssuranceProposal("agent-one", contract, runs);
    expect(proposal?.operations).toEqual([
      expect.objectContaining({
        kind: "add-catalog-secret",
        catalogId: "agent-airlock-secret-catalog",
        catalogVersion: 1,
        name: "private-key-block",
      }),
    ]);
    expect(proposal?.citations).toHaveLength(2);
    expect(proposal?.simulation.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "exact",
          priorDisposition: "promoted",
          counterfactualDisposition: "quarantined",
        }),
      ]),
    );
    expect(proposal?.simulation.results).toContainEqual(
      expect.objectContaining({
        runId: "run-incomplete",
        classification: "unknown",
        counterfactualDisposition: null,
        missingInputs: ["complete trusted catalog secret evaluator result"],
      }),
    );
  });

  it("persists, restarts, and accepts a trusted catalog proposal", async () => {
    const { service, store, config, root } = await makeHarness();
    const agent = await service.createAgent({ name: "Catalog persistence" });
    await store.mutate((database) => {
      for (const suffix of ["one", "two"]) {
        const run = deletedPathRun(
          agent.id,
          "catalog-" + suffix,
          "catalog-root-" + suffix,
          agent.outcomeContract,
        );
        run.status = "completed";
        run.transaction!.status = "promoted";
        run.transaction!.disposition = "promoted";
        run.transaction!.changes = null;
        run.transaction!.validations = [
          {
            name: "assurance-catalog-rule:private-key-block:v1",
            status: "failed",
            required: false,
            summary: "Trusted catalog detector matched in 1 changed file(s)",
            durationMs: 1,
            output: null,
          },
        ];
        database.runs.push(run);
      }
    });
    const proposal = await service.deriveAssuranceProposal(agent.id);
    const restarted = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await restarted.initialize();

    expect(restarted.listAssuranceProposals(agent.id)[0]).toMatchObject({
      id: proposal!.id,
      state: "ready",
    });
    const accepted = await restarted.acceptAssuranceProposal(
      proposal!.id,
      "Reviewed trusted catalog evidence",
    );
    expect(accepted.outcomeContract.version).toBe(2);
    expect(accepted.outcomeContract.secretPatterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "private-key-block" }),
      ]),
    );
  });

  it("rejects malformed durable Run evidence before it can steer assurance", async () => {
    const { service, store } = await makeHarness();
    const agent = await service.createAgent({ name: "Strict evidence" });
    await store.mutate((database) => {
      database.runs.push(
        deletedPathRun(
          agent.id,
          "strict-run",
          "strict-root",
          agent.outcomeContract,
        ),
      );
    });

    const mutations: Array<(run: AgentRun) => void> = [
      (run) => {
        run.transaction!.disposition = "forged" as never;
      },
      (run) => {
        run.transaction!.lineage.depth = -1;
      },
      (run) => {
        run.transaction!.changes!.totalChangedFiles = 0;
      },
      (run) => {
        run.transaction!.validations[0]!.status = "trusted" as never;
      },
      (run) => {
        run.transaction!.outcomeContract.validationCommands = [
          {
            name: "lint",
            command: "npm run lint",
            required: false,
            timeoutMs: "fast" as never,
          },
        ];
      },
    ];
    for (const mutateRun of mutations) {
      await expect(
        store.mutate((database) => {
          mutateRun(database.runs[0]!);
        }),
      ).rejects.toThrow();
      expect(store.snapshot().runs[0]?.transaction?.disposition).toBe(
        "quarantined",
      );
    }
  });

  it("rejects incomplete Validation evidence instead of treating absence as false", async () => {
    const { service, store, config, root } = await makeHarness();
    const created = await service.createAgent({ name: "Complete evidence" });
    const contract = await service.updateOutcomeContract(created.id, {
      requiredPaths: created.outcomeContract.requiredPaths,
      protectedPaths: created.outcomeContract.protectedPaths,
      maxChangedFiles: created.outcomeContract.maxChangedFiles,
      maxAddedBytes: created.outcomeContract.maxAddedBytes,
      secretPatterns: created.outcomeContract.secretPatterns,
      validationCommands: [
        {
          name: "lint",
          command: "npm run lint",
          required: false,
          timeoutMs: 1_000,
        },
      ],
    });
    await store.mutate((database) => {
      for (const suffix of ["one", "two", "three"]) {
        const run = optionalCommandFailureRun(
          created.id,
          "incomplete-" + suffix,
          contract,
        );
        run.status = "failed";
        run.transaction!.status = "quarantined";
        run.transaction!.disposition = "quarantined";
        run.transaction!.validations.unshift({
          name: "required-paths",
          status: "failed",
          required: true,
          summary: "Required path is missing",
          durationMs: 1,
          output: null,
        });
        database.runs.push(run);
      }
    });
    const databasePath = path.join(root, "data", "db.json");
    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as {
      runs: Array<{ transaction: { validations: Array<Record<string, unknown>> } }>;
    };
    for (const run of persisted.runs) {
      delete run.transaction.validations[0]!.required;
    }
    await writeFile(databasePath, JSON.stringify(persisted) + "\n");

    const restarted = new AgentService(
      config,
      new JsonStore(databasePath),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await expect(restarted.initialize()).rejects.toThrow(
      /Validation evidence contains unknown or missing fields/,
    );
  });

  it("applies the total Proposal byte bound during integrity verification", () => {
    const contract = createDefaultOutcomeContract();
    const proposal = deriveAssuranceProposal(
      "agent-one",
      contract,
      [
        deletedPathRun("agent-one", "run-one", "root-one", contract),
        deletedPathRun("agent-one", "run-two", "root-two", contract),
        deletedPathRun("agent-one", "run-three", "root-three", contract),
      ],
    )!;
    const operationKey = proposal.citations[0]!.operationKey;
    proposal.simulation.results = Array.from({ length: 1_000 }, (_, index) => {
      const unsigned = {
        operationKey,
        runId: "oversized-" + String(index).padStart(4, "0"),
        classification: "unknown" as const,
        priorDisposition: null,
        counterfactualDisposition: null,
        missingInputs: ["x".repeat(220)],
      };
      return {
        ...unsigned,
        resultHash:
          "sha256:" +
          createHash("sha256").update(stableJson(unsigned)).digest("hex"),
      };
    });

    expect(Buffer.byteLength(stableJson(proposal), "utf8")).toBeGreaterThan(
      200_000,
    );
    expect(() => verifyAssuranceProposalIntegrity(proposal)).toThrow(
      "exceeds its persisted evidence bound",
    );
  });

  it("accepts advice atomically as a new future-only contract version", async () => {
    const { service, store } = await makeHarness();
    const agent = await service.createAgent({ name: "Adaptive" });
    await store.mutate((database) => {
      database.runs.push(
        deletedPathRun(agent.id, "run-one", "root-one", agent.outcomeContract),
        deletedPathRun(agent.id, "run-two", "root-two", agent.outcomeContract),
        deletedPathRun(agent.id, "run-three", "root-three", agent.outcomeContract),
      );
    });

    const proposal = await service.deriveAssuranceProposal(agent.id);
    expect(proposal?.state).toBe("ready");
    expect(service.getAgent(agent.id).outcomeContract.version).toBe(1);

    const accepted = await service.acceptAssuranceProposal(
      proposal!.id,
      "Protect a repeatedly deleted required artifact",
    );

    expect(accepted.proposal.state).toBe("accepted");
    expect(accepted.outcomeContract).toMatchObject({
      version: 2,
      protectedPaths: ["AGENTS.md", "README.md"],
    });
    expect(service.listOutcomeContractVersions(agent.id)).toHaveLength(2);
    expect(store.snapshot().runs[0]?.transaction?.outcomeContractVersion).toBe(1);
  });

  it("rejects proposal tampering and arbitrary catalog controls", async () => {
    const { service, store } = await makeHarness();
    const agent = await service.createAgent({ name: "Tamper evident" });
    await store.mutate((database) => {
      database.runs.push(
        deletedPathRun(agent.id, "run-one", "root-one", agent.outcomeContract),
        deletedPathRun(agent.id, "run-two", "root-two", agent.outcomeContract),
        deletedPathRun(agent.id, "run-three", "root-three", agent.outcomeContract),
      );
    });
    const proposal = await service.deriveAssuranceProposal(agent.id);
    await expect(
      store.mutate((database) => {
        const persisted = database.assuranceProposals.find(
          (candidate) => candidate.id === proposal!.id,
        )!;
        const operation = persisted.operations[0];
        if (operation?.kind === "add-protected-path") {
          operation.path = "forged.md";
        }
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(service.listAssuranceProposals(agent.id)[0]).toMatchObject({
      id: proposal!.id,
      state: "ready",
      operations: [{ kind: "add-protected-path", path: "README.md" }],
    });
    expect(service.getAgent(agent.id).outcomeContract).toEqual(agent.outcomeContract);
    expect(() =>
      applyAssuranceOperations(agent.outcomeContract, [
        {
          kind: "add-catalog-secret",
          catalogId: "operator-supplied",
          catalogVersion: 1,
          name: "exfiltrate",
          pattern: ".*",
        },
      ]),
    ).toThrow("catalog reference is invalid");
  });

  it("marks stale advice without silently rebasing it", async () => {
    const { service, store } = await makeHarness();
    const agent = await service.createAgent({ name: "Stale" });
    await store.mutate((database) => {
      database.runs.push(
        deletedPathRun(agent.id, "run-one", "root-one", agent.outcomeContract),
        deletedPathRun(agent.id, "run-two", "root-two", agent.outcomeContract),
        deletedPathRun(agent.id, "run-three", "root-three", agent.outcomeContract),
      );
    });
    const proposal = await service.deriveAssuranceProposal(agent.id);
    const current = service.getAgent(agent.id).outcomeContract;
    await service.updateOutcomeContract(agent.id, {
      requiredPaths: current.requiredPaths,
      protectedPaths: current.protectedPaths,
      maxChangedFiles: current.maxChangedFiles - 1,
      maxAddedBytes: current.maxAddedBytes,
      secretPatterns: current.secretPatterns,
      validationCommands: current.validationCommands,
    });

    await expect(
      service.acceptAssuranceProposal(proposal!.id, "accept stale advice"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(service.listAssuranceProposals(agent.id)[0]).toMatchObject({
      state: "stale",
      baseContractVersion: 1,
      baseContractHash: outcomeContractHash(current),
    });
  });

  it("retains rejection and rolls back by creating another immutable version", async () => {
    const { service, store, config, root } = await makeHarness();
    const agent = await service.createAgent({ name: "Reversible" });
    await store.mutate((database) => {
      database.runs.push(
        deletedPathRun(agent.id, "run-one", "root-one", agent.outcomeContract),
        deletedPathRun(agent.id, "run-two", "root-two", agent.outcomeContract),
        deletedPathRun(agent.id, "run-three", "root-three", agent.outcomeContract),
      );
    });
    const proposal = await service.deriveAssuranceProposal(agent.id);
    const rejected = await service.rejectAssuranceProposal(
      proposal!.id,
      "Insufficient business context",
    );
    expect(rejected.state).toBe("rejected");
    expect(service.getAgent(agent.id).outcomeContract.version).toBe(1);

    const current = service.getAgent(agent.id).outcomeContract;
    const versionTwo = await service.updateOutcomeContract(agent.id, {
      requiredPaths: current.requiredPaths,
      protectedPaths: [...current.protectedPaths, "README.md"],
      maxChangedFiles: current.maxChangedFiles,
      maxAddedBytes: current.maxAddedBytes,
      secretPatterns: current.secretPatterns,
      validationCommands: current.validationCommands,
    });
    const rolledBack = await service.rollbackOutcomeContract(
      agent.id,
      1,
      versionTwo.version,
    );
    expect(rolledBack).toMatchObject({
      version: 3,
      protectedPaths: ["AGENTS.md"],
    });
    expect(service.listOutcomeContractVersions(agent.id).map((item) => item.contract.version))
      .toEqual([3, 2, 1]);

    const restarted = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await restarted.initialize();
    expect(restarted.listAssuranceProposals(agent.id)[0]).toMatchObject({
      state: "rejected",
      decision: { reason: "Insufficient business context" },
    });
    expect(restarted.getAgent(agent.id).outcomeContract.version).toBe(3);
  });

  it("serializes proposal derivation and rejection against Agent deletion", async () => {
    const { service, store } = await makeHarness();
    const agent = await service.createAgent({ name: "Deletion serialization" });
    await store.mutate((database) => {
      for (const suffix of ["one", "two"]) {
        const run = deletedPathRun(
          agent.id,
          "run-" + suffix,
          "root-" + suffix,
          agent.outcomeContract,
        );
        run.status = "completed";
        run.transaction!.status = "promoted";
        run.transaction!.disposition = "promoted";
        run.transaction!.changes = null;
        run.transaction!.validations = [
          {
            name: "assurance-catalog-rule:private-key-block:v1",
            status: "failed",
            required: false,
            summary: "Trusted catalog detector matched in 1 changed file(s)",
            durationMs: 1,
            output: null,
          },
        ];
        database.runs.push(run);
      }
    });
    const proposal = await service.deriveAssuranceProposal(agent.id);
    const deletion = service.deleteAgent(agent.id);

    await expect(service.deriveAssuranceProposal(agent.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      service.rejectAssuranceProposal(proposal!.id, "race with deletion"),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(deletion).resolves.toEqual({
      archivedWorkspace: expect.stringContaining(".deleted"),
    });
  });

  it("strictly rejects hidden authority nested inside persisted advice", async () => {
    const { service, store, root } = await makeHarness();
    const agent = await service.createAgent({ name: "Strict parser" });
    await store.mutate((database) => {
      database.runs.push(
        deletedPathRun(agent.id, "run-one", "root-one", agent.outcomeContract),
        deletedPathRun(agent.id, "run-two", "root-two", agent.outcomeContract),
        deletedPathRun(agent.id, "run-three", "root-three", agent.outcomeContract),
      );
    });
    await service.deriveAssuranceProposal(agent.id);
    const databasePath = path.join(root, "data", "db.json");
    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as {
      assuranceProposals: Array<{ operations: Array<Record<string, unknown>> }>;
    };
    persisted.assuranceProposals[0]!.operations[0]!.hiddenAuthority = "apply";
    await writeFile(databasePath, JSON.stringify(persisted) + "\n");

    await expect(new JsonStore(databasePath).initialize()).rejects.toThrow(
      "Assurance path operation contains unknown or missing fields",
    );
  });

  it("exposes an explicit strict HTTP review boundary", async () => {
    const { service, store, config, root } = await makeHarness();
    const agent = await service.createAgent({ name: "HTTP review" });
    await store.mutate((database) => {
      database.runs.push(
        deletedPathRun(agent.id, "run-one", "root-one", agent.outcomeContract),
        deletedPathRun(agent.id, "run-two", "root-two", agent.outcomeContract),
        deletedPathRun(agent.id, "run-three", "root-three", agent.outcomeContract),
      );
    });
    const app = await createApp(config, service);
    try {
      const derived = await app.inject({
        method: "POST",
        url: "/api/agents/" + agent.id + "/assurance-proposals/derive",
      });
      expect(derived.statusCode).toBe(200);
      const proposalId = derived.json<{ proposal: { id: string } }>().proposal.id;

      const credential = "ARK_API_KEY=operator-reason-must-not-persist";
      for (const action of ["accept", "reject"] as const) {
        const unsafeDecision = await app.inject({
          method: "POST",
          url: "/api/assurance-proposals/" + proposalId + "/" + action,
          payload: { reason: credential },
        });
        expect(unsafeDecision.statusCode).toBe(400);
      }
      expect(service.listAssuranceProposals(agent.id)[0]?.state).toBe("ready");
      expect(
        await readFile(path.join(root, "data", "db.json"), "utf8"),
      ).not.toContain(credential);

      const oversizedUtf8 = await app.inject({
        method: "POST",
        url: "/api/assurance-proposals/" + proposalId + "/reject",
        payload: { reason: "界".repeat(200) },
      });
      expect(oversizedUtf8.statusCode).toBe(400);
      expect(service.listAssuranceProposals(agent.id)[0]?.state).toBe("ready");

      const forged = await app.inject({
        method: "POST",
        url: "/api/assurance-proposals/" + proposalId + "/accept",
        payload: { reason: "reviewed", automaticApproval: true },
      });
      expect(forged.statusCode).toBe(400);
      expect(service.getAgent(agent.id).outcomeContract.version).toBe(1);

      const accepted = await app.inject({
        method: "POST",
        url: "/api/assurance-proposals/" + proposalId + "/accept",
        payload: { reason: "Reviewed bounded citations" },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({
        proposal: { state: "accepted" },
        outcomeContract: { version: 2 },
      });
    } finally {
      await app.close();
    }
  });
});
