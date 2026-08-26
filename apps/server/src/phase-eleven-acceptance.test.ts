import {
  verifyPortablePromotionEnvelope,
  verifySignedTransparencyCheckpoint,
  verifyTransparencyInclusion,
  type PortablePromotionEnvelope,
} from "@agent-airlock/portable-promotion-receipt";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistFixtureSession } from "../test/session-fixture.js";
import {
  DeterministicJsonProvider,
  jsonVersionReference,
} from "../test/deterministic-json-provider.js";
import {
  waitForCandidateSetCompletion,
  waitForRunTransactionStatus,
} from "../test/agent-service-workflow.js";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { ResourceCoordinator } from "./resource-coordinator.js";
import { ResourceRegistry } from "./resource-registry.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { promotionValidationEvidenceHash } from "./promotion-receipt-evidence.js";
import {
  createDefaultSelectionContract,
  stableJson,
} from "./candidate-selection.js";
import {
  PortableDecisionJournal,
  portableDecisionTransactionHash,
} from "./portable-decision-journal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class PassingReceiptRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    const threadId = request.threadId ?? "portable-thread";
    await persistFixtureSession(request, threadId);
    return {
      output: "Portable receipt fixture completed.",
      threadId,
      usage: { inputTokens: 8, outputTokens: 5 },
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class QuarantineThenRepairRunner extends PassingReceiptRunner {
  private callCount = 0;

  override async run(request: RunnerRequest): Promise<RunnerResult> {
    this.callCount += 1;
    if (this.callCount === 1) {
      await rm(path.join(request.workspacePath, "README.md"));
    } else {
      await writeFile(
        path.join(request.workspacePath, "README.md"),
        "# Restored by the bounded Repair fixture\n",
      );
    }
    return super.run(request);
  }
}

class BoundedReceiptRunner extends PassingReceiptRunner {
  readonly tokenBudgetEnforcement = "provider-boundary" as const;
}

class ThreeQuarantinesThenPassRunner extends PassingReceiptRunner {
  private callCount = 0;

  override async run(request: RunnerRequest): Promise<RunnerResult> {
    this.callCount += 1;
    if (this.callCount <= 3) {
      await rm(path.join(request.workspacePath, "README.md"));
    }
    return super.run(request);
  }
}

class GatedReceiptRunner extends PassingReceiptRunner {
  private releaseExecution!: () => void;
  private signalExecutionStarted!: () => void;
  private readonly executionGate = new Promise<void>((resolve) => {
    this.releaseExecution = resolve;
  });
  private readonly executionStarted = new Promise<void>((resolve) => {
    this.signalExecutionStarted = resolve;
  });

  release(): void {
    this.releaseExecution();
  }

  waitUntilStarted(): Promise<void> {
    return this.executionStarted;
  }

  override async run(request: RunnerRequest): Promise<RunnerResult> {
    this.signalExecutionStarted();
    await this.executionGate;
    return super.run(request);
  }
}

class InterruptedDiscardWorkspace extends WorkspaceManager {
  override async discardQuarantine(): Promise<boolean> {
    throw new Error("simulated interruption after Discard authority");
  }
}

class ProviderReceiptRunner extends PassingReceiptRunner {
  override async run(request: RunnerRequest): Promise<RunnerResult> {
    const objectPath = request.resourceBindings?.find(
      (binding) => binding.providerId === "portable-json",
    )?.hostPath;
    if (!objectPath)
      throw new Error("Runtime did not receive the JSON provider binding");
    await writeFile(objectPath, '{"release":"portable-promoted"}\n', "utf8");
    return super.run(request);
  }
}

describe("Phase 11 Portable Trust acceptance", () => {
  it("synchronizes every authority namespace entry in its immediate parent", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-eleven-namespace-sync-"),
    );
    temporaryDirectories.push(root);
    const authorityRoot = path.join(root, "portable-decision-journal");
    const journal = new PortableDecisionJournal(authorityRoot);
    const internals = journal as unknown as {
      syncDirectory: (directory: string) => Promise<void>;
    };
    const syncDirectory = internals.syncDirectory.bind(journal);
    const synchronizedDirectories: string[] = [];
    internals.syncDirectory = async (directory) => {
      synchronizedDirectories.push(path.resolve(directory));
      await syncDirectory(directory);
    };

    await journal.initialize();

    expect(synchronizedDirectories.slice(0, 3)).toEqual([
      path.resolve(root),
      path.resolve(authorityRoot),
      path.resolve(authorityRoot),
    ]);
    expect(
      (await lstat(path.join(authorityRoot, ".candidate-sets"))).isDirectory(),
    ).toBe(true);
    expect(
      (await lstat(path.join(authorityRoot, ".discard-cleanup"))).isDirectory(),
    ).toBe(true);
  });

  it("exports, self-verifies, anchors, and ABI-encodes one promoted Run over HTTP", async () => {
    const harness = await makeHarness(new PassingReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable winner",
    });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Create a portable trust receipt without a network.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
    expect(harness.service.getAgent(agent.id).status).toBe("ready");

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {
        disclosureIdentities: [],
        includeAncestry: true,
        localAnchor: true,
        evmPayload: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json() as PortableExportResponse;
    expect(result.verification.valid).toBe(true);
    expect(verifyPortablePromotionEnvelope(result.envelope).valid).toBe(true);
    expect(result.envelope.receipt.decision.disposition).toBe("promoted");
    expect(result.envelope.disclosures).toEqual([]);
    expect(result.availableDisclosureIdentities.length).toBeGreaterThan(0);
    expect(
      verifySignedTransparencyCheckpoint(result.anchor!.checkpoint).valid,
    ).toBe(true);
    expect(
      verifyTransparencyInclusion(
        result.anchor!.inclusionProof,
        result.anchor!.checkpoint.checkpoint,
      ),
    ).toBe(true);
    expect(result.evmPayload).toMatchObject({
      receiptDigest: result.envelope.receiptDigest,
      privacyClaim: "receipt-digest-only",
      networkCalls: 0,
      fundsSpent: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE KEY|Create a portable trust receipt|Portable receipt fixture completed|\/Users\/|\/private\//,
    );

    const repeated = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: { localAnchor: true },
    });
    const repeatedResult = repeated.json() as PortableExportResponse;
    expect(repeatedResult.envelope).toEqual(result.envelope);
    expect(repeatedResult.anchor!.checkpoint.checkpoint.treeSize).toBe(1);
  });

  it("chains a Repair to its quarantined parent and preserves old signatures after Discard", async () => {
    const harness = await makeHarness(new QuarantineThenRepairRunner());
    const agent = await harness.service.createAgent({
      name: "Portable ancestry",
    });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Trigger the bounded rejection fixture.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      admitted.run.id,
      "quarantined",
      agent.id,
    );

    const parentResponse = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    expect(parentResponse.statusCode, parentResponse.body).toBe(200);
    const parent = parentResponse.json() as PortableExportResponse;
    expect(parent.envelope.receipt.decision.disposition).toBe("quarantined");

    const repairResponse = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/repair`,
      payload: { objective: "Restore the required public artifact." },
    });
    expect(repairResponse.statusCode).toBe(202);
    const repairRunId = (repairResponse.json() as { run: { id: string } }).run
      .id;
    await waitForRunTransactionStatus(
      harness.service,
      repairRunId,
      "promoted",
      agent.id,
    );
    const childResponse = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${repairRunId}/portable-receipt`,
      payload: { includeAncestry: true },
    });
    expect(childResponse.statusCode, childResponse.body).toBe(200);
    const child = childResponse.json() as PortableExportResponse;
    expect(child.envelope.receipt.ancestry.previousReceiptDigest).toBe(
      parent.envelope.receiptDigest,
    );

    const discardResponse = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/discard`,
    });
    expect(discardResponse.statusCode, discardResponse.body).toBe(200);
    const discardedResponse = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    const discarded = discardedResponse.json() as PortableExportResponse;
    expect(discarded.envelope.receipt.decision.disposition).toBe("discarded");
    expect(discarded.envelope.receiptDigest).not.toBe(
      parent.envelope.receiptDigest,
    );
    expect(verifyPortablePromotionEnvelope(parent.envelope).valid).toBe(true);
    expect(verifyPortablePromotionEnvelope(discarded.envelope).valid).toBe(
      true,
    );

    const repeatedChildResponse = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${repairRunId}/portable-receipt`,
      payload: { includeAncestry: true },
    });
    expect(repeatedChildResponse.statusCode, repeatedChildResponse.body).toBe(
      200,
    );
    const repeatedChild =
      repeatedChildResponse.json() as PortableExportResponse;
    expect(repeatedChild.envelope.receiptDigest).toBe(
      child.envelope.receiptDigest,
    );
    expect(repeatedChild.envelope.receipt.ancestry.previousReceiptDigest).toBe(
      parent.envelope.receiptDigest,
    );
  });

  it("commits the durable Candidate Set selection into the winner receipt", async () => {
    const harness = await makeHarness(new BoundedReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable selection",
    });
    const admission = await harness.app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/candidate-sets`,
      payload: {
        objective: "Select one bounded future and export its decision proof.",
        competitors: [
          {
            id: "alpha",
            executorProfileId: "standard-v1",
            strategyInstruction: "Produce the narrowest valid future.",
          },
          {
            id: "beta",
            executorProfileId: "standard-v1",
            strategyInstruction: "Produce another valid bounded future.",
          },
        ],
        maxConcurrency: 2,
        loserPolicy: "discard",
      },
    });
    expect(admission.statusCode).toBe(202);
    const candidateSetId = (
      admission.json() as { candidateSet: { id: string } }
    ).candidateSet.id;
    await waitForCandidateSetCompletion(
      harness.service,
      candidateSetId,
      agent.id,
    );
    const candidateSet = harness.service.getCandidateSet(candidateSetId);
    expect(candidateSet.winnerRunId).not.toBeNull();

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${candidateSet.winnerRunId}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json() as PortableExportResponse;
    expect(result.envelope.receipt.selection).toEqual({
      candidateSetId,
      decisionDigest: `sha256:${candidateSet.selectionDecision!.decisionDigest}`,
    });
    expect(result.verification.commitments.selection).toBe(true);
  });

  it("composes retained-loser Discard with direct and historical receipts", async () => {
    const harness = await makeHarness(new BoundedReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable retained loser",
    });
    const admission = await harness.app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/candidate-sets`,
      payload: {
        objective: "Retain one losing future for later audited disposal.",
        competitors: [
          {
            id: "alpha",
            executorProfileId: "standard-v1",
            strategyInstruction: "Produce a minimal valid future.",
          },
          {
            id: "beta",
            executorProfileId: "standard-v1",
            strategyInstruction: "Produce a second valid future.",
          },
        ],
        maxConcurrency: 2,
        loserPolicy: "retain",
      },
    });
    expect(admission.statusCode, admission.body).toBe(202);
    const candidateSetId = (
      admission.json() as { candidateSet: { id: string } }
    ).candidateSet.id;
    await waitForCandidateSetCompletion(
      harness.service,
      candidateSetId,
      agent.id,
    );
    const retained = harness.service
      .getCandidateSet(candidateSetId)
      .competitors.find(
        (competitor) => competitor.loserDisposition === "retained",
      );
    expect(retained).toBeDefined();

    const parentResponse = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${retained!.runId}/portable-receipt`,
      payload: {},
    });
    expect(parentResponse.statusCode, parentResponse.body).toBe(200);
    const parent = parentResponse.json() as PortableExportResponse;
    expect(parent.envelope.receipt.decision.disposition).toBe("quarantined");

    const discardedRun = await harness.service.discardRun(retained!.runId);
    expect(discardedRun.transaction?.disposition).toBe("discarded");
    expect(
      harness.service
        .getCandidateSet(candidateSetId)
        .competitors.find((competitor) => competitor.id === retained!.id),
    ).toMatchObject({ status: "discarded", loserDisposition: "discarded" });
    const directAfterDiscard = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${retained!.runId}/portable-receipt`,
      payload: {},
    });
    expect(directAfterDiscard.statusCode, directAfterDiscard.body).toBe(200);
    expect(
      directAfterDiscard.json<PortableExportResponse>().envelope.receipt
        .decision.disposition,
    ).toBe("discarded");

    expect(verifyPortablePromotionEnvelope(parent.envelope).valid).toBe(true);
    expect(
      verifyPortablePromotionEnvelope(
        directAfterDiscard.json<PortableExportResponse>().envelope,
      ).valid,
    ).toBe(true);
  });

  it("atomically recovers a retained loser after Discard authority precedes removal", async () => {
    const harness = await makeHarness(new BoundedReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Atomic retained-loser recovery",
    });
    const admission = await harness.service.createCandidateSet(agent.id, {
      objective: "Recover one authorized loser Discard atomically.",
      competitors: [
        {
          id: "alpha",
          executorProfileId: "standard-v1",
          strategyInstruction: "Produce a minimal valid future.",
        },
        {
          id: "beta",
          executorProfileId: "standard-v1",
          strategyInstruction: "Produce a second valid future.",
        },
      ],
      selectionContract: createDefaultSelectionContract(),
      maxConcurrency: 2,
      budget: {
        maxDurationMsPerCompetitor: 600_000,
        maxTotalTokens: 2_000_000,
        maxTotalChangedBytes: 200_000_000,
      },
      loserPolicy: "retain",
    });
    await waitForCandidateSetCompletion(
      harness.service,
      admission.candidateSet.id,
      agent.id,
    );
    const retained = harness.service
      .getCandidateSet(admission.candidateSet.id)
      .competitors.find(
        (competitor) => competitor.loserDisposition === "retained",
      );
    if (!retained) throw new Error("Fixture retained no losing Candidate");
    const quarantinePath = harness.service.getRun(retained.runId).transaction
      ?.quarantinePath;
    if (!quarantinePath) throw new Error("Fixture retained no Quarantine path");

    const interrupted = new AgentService(
      harness.config,
      new JsonStore(path.join(harness.config.dataDirectory, "db.json")),
      new InterruptedDiscardWorkspace(harness.config.workspaceRoot),
      new BoundedReceiptRunner(),
    );
    await interrupted.initialize();
    await expect(interrupted.discardRun(retained.runId)).rejects.toThrow(
      "simulated interruption after Discard authority",
    );
    expect(
      interrupted
        .getCandidateSet(admission.candidateSet.id)
        .competitors.find((competitor) => competitor.id === retained.id),
    ).toMatchObject({ status: "retained", loserDisposition: "retained" });
    expect((await lstat(quarantinePath)).isDirectory()).toBe(true);

    const restartedStore = new JsonStore(
      path.join(harness.config.dataDirectory, "db.json"),
    );
    const restarted = new AgentService(
      harness.config,
      restartedStore,
      new WorkspaceManager(harness.config.workspaceRoot),
      new BoundedReceiptRunner(),
    );
    await restarted.initialize();
    const snapshot = restartedStore.snapshot();
    expect(
      snapshot.runs.find((run) => run.id === retained.runId)?.transaction
        ?.disposition,
    ).toBe("discarded");
    expect(
      snapshot.candidateSets
        .find((candidateSet) => candidateSet.id === admission.candidateSet.id)
        ?.competitors.find((competitor) => competitor.id === retained.id),
    ).toMatchObject({ status: "discarded", loserDisposition: "discarded" });
    await expect(lstat(quarantinePath)).rejects.toThrow();
  });

  it("binds an operator-accepted Assurance Proposal to future Run receipts", async () => {
    const harness = await makeHarness(new ThreeQuarantinesThenPassRunner());
    const agent = await harness.service.createAgent({
      name: "Portable assurance",
    });
    for (let index = 0; index < 3; index += 1) {
      const admitted = await harness.service.sendMessage(
        agent.id,
        `Collect independent bounded evidence ${index + 1}.`,
      );
      await waitForRunTransactionStatus(
        harness.service,
        admitted.run.id,
        "quarantined",
        agent.id,
      );
      expect(harness.service.getAgent(agent.id).status).toBe("ready");
    }
    const proposal = await harness.service.deriveAssuranceProposal(agent.id);
    expect(proposal).not.toBeNull();
    const accepted = await harness.service.acceptAssuranceProposal(
      proposal!.id,
      "Reviewed three independent retained lineages.",
    );
    expect(accepted.outcomeContract.version).toBe(2);

    const admitted = await harness.service.sendMessage(
      agent.id,
      "Run under the accepted contract without changing Canonical State.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json() as PortableExportResponse;
    expect(result.envelope.receipt.assurance).toEqual({
      proposalId: proposal!.id,
      contractVersion: 2,
    });
    expect(result.verification.commitments.assurance).toBe(true);
  });

  it("refuses an export with incomplete durable evidence as a retryable conflict", async () => {
    const runner = new GatedReceiptRunner();
    const harness = await makeHarness(runner);
    const agent = await harness.service.createAgent({
      name: "Portable conflict",
    });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Hold this Runtime before durable decision evidence exists.",
    );
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(
      /complete, versioned, contradiction-free/,
    );

    runner.release();
    await waitForRunTransactionStatus(
      harness.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
  });

  it("records immutable authority before persisting a restart-created cancellation", async () => {
    const runner = new GatedReceiptRunner();
    const first = await makeHarness(runner);
    const agent = await first.service.createAgent({
      name: "Restart authority",
    });
    const admitted = await first.service.sendMessage(
      agent.id,
      "Interrupt this Run after Candidate creation.",
    );
    const candidateRoot = path.join(
      first.config.workspaceRoot,
      ".candidates",
      admitted.run.id,
    );
    await runner.waitUntilStarted();
    expect((await lstat(candidateRoot)).isDirectory()).toBe(true);
    await rm(candidateRoot, { recursive: true });

    const restartedStore = new JsonStore(
      path.join(first.config.dataDirectory, "db.json"),
    );
    const restarted = new AgentService(
      first.config,
      restartedStore,
      new WorkspaceManager(first.config.workspaceRoot),
      new PassingReceiptRunner(),
    );
    await restarted.initialize();
    expect(restarted.getRun(admitted.run.id)).toMatchObject({
      status: "cancelled",
      transaction: {
        status: "cancelled",
        disposition: "cancelled",
      },
    });
    const app = await createApp(first.config, restarted);
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it("replays the exact Discard authority after interruption before mutable publication", async () => {
    const first = await makeHarness(new QuarantineThenRepairRunner());
    const agent = await first.service.createAgent({
      name: "Exact Discard replay",
    });
    const admitted = await first.service.sendMessage(
      agent.id,
      "Retain this invalid Candidate before an interrupted Discard.",
    );
    await waitForRunTransactionStatus(
      first.service,
      admitted.run.id,
      "quarantined",
      agent.id,
    );

    const interrupted = new AgentService(
      first.config,
      new JsonStore(path.join(first.config.dataDirectory, "db.json")),
      new InterruptedDiscardWorkspace(first.config.workspaceRoot),
      new PassingReceiptRunner(),
    );
    await interrupted.initialize();
    await expect(interrupted.discardRun(admitted.run.id)).rejects.toThrow(
      /simulated interruption after Discard authority/,
    );

    expect(interrupted.getRun(admitted.run.id).transaction?.disposition).toBe(
      "quarantined",
    );
    expect(
      (
        await lstat(
          path.join(first.config.workspaceRoot, ".quarantine", admitted.run.id),
        )
      ).isDirectory(),
    ).toBe(true);
    const authorityDirectory = path.join(
      first.config.dataDirectory,
      "portable-decision-journal",
      admitted.run.id,
    );
    const authorities = await Promise.all(
      (await readdir(authorityDirectory))
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) =>
          JSON.parse(
            await readFile(path.join(authorityDirectory, entry), "utf8"),
          ),
        ),
    );
    const discardedAuthority = authorities.find(
      (authority) => authority.disposition === "discarded",
    );
    expect(discardedAuthority).toBeDefined();

    const restarted = new AgentService(
      first.config,
      new JsonStore(path.join(first.config.dataDirectory, "db.json")),
      new WorkspaceManager(first.config.workspaceRoot),
      new PassingReceiptRunner(),
    );
    await restarted.initialize();
    const recovered = restarted.getRun(admitted.run.id);
    expect(stableJson(recovered.transaction)).toBe(
      stableJson(discardedAuthority.transaction),
    );
    expect(recovered).toMatchObject({
      status: "failed",
      transaction: {
        status: "discarded",
        disposition: "discarded",
      },
    });
    const app = await createApp(first.config, restarted);
    const receipt = await app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    expect(receipt.statusCode, receipt.body).toBe(200);
  });

  it("rejects every contradictory durable Promotion Receipt authority field before signing", async () => {
    const harness = await makeHarness(new PassingReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable authority",
    });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Create a complete source for authority mutation checks.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );

    const mutations: Array<(receipt: Record<string, unknown>) => void> = [
      (receipt) => {
        receipt.disposition = "quarantined";
      },
      (receipt) => {
        receipt.outcomeContractVersion = 999;
      },
      (receipt) => {
        receipt.canonicalStateIdBefore = "forged-before";
      },
      (receipt) => {
        receipt.canonicalStateIdAfter = "forged-after";
      },
      (receipt) => {
        receipt.canonicalContentHashBefore = `sha256:${"a".repeat(64)}`;
      },
      (receipt) => {
        receipt.canonicalContentHashAfter = `sha256:${"b".repeat(64)}`;
      },
      (receipt) => {
        receipt.validationEvidenceHash = `sha256:${"c".repeat(64)}`;
      },
      (receipt) => {
        receipt.lineage = {
          rootRunId: "forged-root",
          parentRunId: null,
          depth: 0,
          maxDepth: 2,
        };
      },
      (receipt) => {
        receipt.hiddenAuthority = "forged";
      },
    ];
    for (const mutateReceipt of mutations) {
      await expect(
        harness.store.mutate((database) => {
          const transaction = database.runs.find(
            (run) => run.id === admitted.run.id,
          )!.transaction!;
          mutateReceipt(
            transaction.promotionReceipt as unknown as Record<string, unknown>,
          );
        }),
      ).rejects.toThrow(/Promotion Receipt/);
    }
    await expectFileMissing(harness.config.portableSigningKeyPath);
  });

  it("rejects incomplete Validation and contradictory action evidence before key creation", async () => {
    for (const mutation of ["validation", "actions"] as const) {
      const harness = await makeHarness(new PassingReceiptRunner());
      const agent = await harness.service.createAgent({
        name: `Portable ${mutation} matrix`,
      });
      const admitted = await harness.service.sendMessage(
        agent.id,
        "Create terminal evidence before mutating one signed projection.",
      );
      await waitForRunTransactionStatus(
        harness.service,
        admitted.run.id,
        "promoted",
        agent.id,
      );
      await harness.store.mutate((database) => {
        const transaction = database.runs.find(
          (run) => run.id === admitted.run.id,
        )!.transaction!;
        if (mutation === "validation") {
          transaction.validations = transaction.validations.filter(
            (validation) => validation.name !== "required-paths",
          );
          transaction.promotionReceipt!.validationEvidenceHash =
            promotionValidationEvidenceHash(transaction);
        } else {
          transaction.externalActions.deliveredCount = 999;
        }
      });
      const response = await harness.app.inject({
        method: "POST",
        url: `/api/runs/${admitted.run.id}/portable-receipt`,
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      await expectFileMissing(harness.config.portableSigningKeyPath);
    }
  });

  it("physically verifies immutable historical state before signing", async () => {
    const harness = await makeHarness(new PassingReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable physical state",
    });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Promote a state that will be independently checked before export.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
    const stateId = harness.service.getRun(admitted.run.id).transaction!
      .canonicalStateIdAfter!;
    await writeFile(
      path.join(
        harness.config.workspaceRoot,
        agent.id,
        "versions",
        stateId,
        "workspace",
        "README.md",
      ),
      "# Tampered after Promotion\n",
    );
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(
      /immutable historical/,
    );
    await expectFileMissing(harness.config.portableSigningKeyPath);
  });

  it("recomputes the outbox-bound composite hash before signing", async () => {
    const harness = await makeHarness(new PassingReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable outbox authority",
    });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Promote state before a historical outbox corruption check.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
    const stateId = harness.service.getRun(admitted.run.id).transaction!
      .canonicalStateIdAfter!;
    await writeFile(
      path.join(
        harness.config.workspaceRoot,
        agent.id,
        "versions",
        stateId,
        "outbox",
        "forged.json",
      ),
      "{}\n",
    );
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(
      /immutable historical/,
    );
    await expectFileMissing(harness.config.portableSigningKeyPath);
  });

  it("rejects coordinated Run Transaction and embedded receipt corruption", async () => {
    const harness = await makeHarness(new PassingReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable decision journal",
    });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Create immutable decision authority before coordinated corruption.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
    await harness.store.mutate((database) => {
      const transaction = database.runs.find(
        (run) => run.id === admitted.run.id,
      )!.transaction!;
      const forged = `sha256:${"f".repeat(64)}`;
      transaction.canonicalContentHashAfter = forged;
      transaction.promotionReceipt!.canonicalContentHashAfter = forged;
    });
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(
      /decision authority|immutable historical/,
    );
    await expectFileMissing(harness.config.portableSigningKeyPath);
  });

  it("keeps execution admission closed after terminal authority recovery fails", async () => {
    const first = await makeHarness(new PassingReceiptRunner());
    const agent = await first.service.createAgent({
      name: "Closed terminal recovery",
    });
    const admitted = await first.service.sendMessage(
      agent.id,
      "Create authority before a restart-time corruption check.",
    );
    await waitForRunTransactionStatus(
      first.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
    const authorityDirectory = path.join(
      first.config.dataDirectory,
      "portable-decision-journal",
      admitted.run.id,
    );
    const authorityFile = (await readdir(authorityDirectory)).find((entry) =>
      entry.endsWith(".json"),
    )!;
    const authorityPath = path.join(authorityDirectory, authorityFile);
    const authority = JSON.parse(await readFile(authorityPath, "utf8"));
    authority.transaction.canonicalStateIdAfter = "contradictory-state";
    await writeFile(authorityPath, JSON.stringify(authority) + "\n", "utf8");

    const restarted = new AgentService(
      first.config,
      new JsonStore(path.join(first.config.dataDirectory, "db.json")),
      new WorkspaceManager(first.config.workspaceRoot),
      new PassingReceiptRunner(),
    );
    await restarted.initialize();
    expect(restarted.getAgent(agent.id)).toMatchObject({ status: "error" });
    expect(restarted.getRun(admitted.run.id)).toMatchObject({
      status: "failed",
      transaction: { status: "recovery-error" },
    });
    await expect(
      restarted.sendMessage(agent.id, "This must remain blocked."),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(restarted.startAgent(agent.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("keeps registry and Agent admission closed when a terminal Run projection is missing", async () => {
    const first = await makeHarness(new PassingReceiptRunner());
    const agent = await first.service.createAgent({
      name: "Missing terminal projection",
    });
    const admitted = await first.service.sendMessage(
      agent.id,
      "Create authority before deleting the mutable transaction projection.",
    );
    await waitForRunTransactionStatus(
      first.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
    await first.store.mutate((database) => {
      database.runs.find((run) => run.id === admitted.run.id)!.transaction =
        null;
    });

    const restarted = new AgentService(
      first.config,
      new JsonStore(path.join(first.config.dataDirectory, "db.json")),
      new WorkspaceManager(first.config.workspaceRoot),
      new PassingReceiptRunner(),
    );
    await restarted.initialize();
    expect(restarted.getAgent(agent.id)).toMatchObject({ status: "error" });
    expect(restarted.getRun(admitted.run.id)).toMatchObject({
      status: "failed",
      transaction: null,
      error: expect.stringContaining(
        "Immutable terminal decision recovery failed",
      ),
    });
    await expect(
      restarted.sendMessage(agent.id, "This must remain blocked."),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("rejects two individually valid but conflicting terminal authorities", async () => {
    const first = await makeHarness(new PassingReceiptRunner());
    const agent = await first.service.createAgent({
      name: "Ambiguous terminal authority",
    });
    const admitted = await first.service.sendMessage(
      agent.id,
      "Create one valid authority before an ambiguity injection.",
    );
    await waitForRunTransactionStatus(
      first.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
    const authorityDirectory = path.join(
      first.config.dataDirectory,
      "portable-decision-journal",
      admitted.run.id,
    );
    const authorityFile = (await readdir(authorityDirectory)).find((entry) =>
      entry.endsWith(".json"),
    )!;
    const original = JSON.parse(
      await readFile(path.join(authorityDirectory, authorityFile), "utf8"),
    );
    const conflictingTransaction = structuredClone(original.transaction);
    conflictingTransaction.events.at(-1).summary =
      "A contradictory but internally hashed terminal history";
    const transactionEvidenceHash = portableDecisionTransactionHash(
      conflictingTransaction,
    );
    const unsigned = {
      schemaVersion: 1,
      transactionEvidenceHash,
      parentAuthorityDigest: original.parentAuthorityDigest,
      candidateSetAuthorityDigest: original.candidateSetAuthorityDigest,
      runId: original.runId,
      agentId: original.agentId,
      disposition: original.disposition,
      decidedAt: original.decidedAt,
    };
    const authorityDigest =
      "sha256:" +
      createHash("sha256").update(stableJson(unsigned)).digest("hex");
    await writeFile(
      path.join(
        authorityDirectory,
        authorityDigest.replace("sha256:", "sha256-") + ".json",
      ),
      JSON.stringify({
        ...unsigned,
        authorityDigest,
        transaction: conflictingTransaction,
      }) + "\n",
      "utf8",
    );

    const restarted = new AgentService(
      first.config,
      new JsonStore(path.join(first.config.dataDirectory, "db.json")),
      new WorkspaceManager(first.config.workspaceRoot),
      new PassingReceiptRunner(),
    );
    await restarted.initialize();
    expect(restarted.getAgent(agent.id)).toMatchObject({ status: "error" });
    expect(restarted.getRun(admitted.run.id)).toMatchObject({
      status: "failed",
      transaction: { status: "recovery-error" },
    });
    await expect(
      restarted.exportPortableReceipt(admitted.run.id, {
        disclosureIdentities: [],
        includeAncestry: false,
        localAnchor: false,
        evmPayload: false,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it.each(["parentAuthorityDigest", "candidateSetAuthorityDigest"] as const)(
    "rejects same-transaction authorities with conflicting %s",
    async (contextField) => {
      const first = await makeHarness(new PassingReceiptRunner());
      const agent = await first.service.createAgent({
        name: "Ambiguous authority context",
      });
      const admitted = await first.service.sendMessage(
        agent.id,
        "Create authority before a context-conflict injection.",
      );
      await waitForRunTransactionStatus(
        first.service,
        admitted.run.id,
        "promoted",
        agent.id,
      );
      const authorityDirectory = path.join(
        first.config.dataDirectory,
        "portable-decision-journal",
        admitted.run.id,
      );
      const authorityFile = (await readdir(authorityDirectory)).find((entry) =>
        entry.endsWith(".json"),
      )!;
      const original = JSON.parse(
        await readFile(path.join(authorityDirectory, authorityFile), "utf8"),
      );
      const conflictingDigest = `sha256:${"e".repeat(64)}`;
      const unsigned = {
        schemaVersion: original.schemaVersion,
        transactionEvidenceHash: original.transactionEvidenceHash,
        parentAuthorityDigest: original.parentAuthorityDigest,
        candidateSetAuthorityDigest: original.candidateSetAuthorityDigest,
        runId: original.runId,
        agentId: original.agentId,
        disposition: original.disposition,
        decidedAt: original.decidedAt,
      };
      unsigned[contextField] = conflictingDigest;
      const authorityDigest =
        "sha256:" +
        createHash("sha256").update(stableJson(unsigned)).digest("hex");
      await writeFile(
        path.join(
          authorityDirectory,
          authorityDigest.replace("sha256:", "sha256-") + ".json",
        ),
        JSON.stringify({
          ...unsigned,
          authorityDigest,
          transaction: original.transaction,
        }) + "\n",
        "utf8",
      );

      const restarted = new AgentService(
        first.config,
        new JsonStore(path.join(first.config.dataDirectory, "db.json")),
        new WorkspaceManager(first.config.workspaceRoot),
        new PassingReceiptRunner(),
      );
      await restarted.initialize();
      expect(restarted.getAgent(agent.id)).toMatchObject({ status: "error" });
      expect(restarted.getRun(admitted.run.id)).toMatchObject({
        status: "failed",
        transaction: { status: "recovery-error" },
      });
      await expect(
        restarted.exportPortableReceipt(admitted.run.id, {
          disclosureIdentities: [],
          includeAncestry: false,
          localAnchor: false,
          evmPayload: false,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    },
  );

  it("rejects forged provider evidence in a Promotion recovery authority", async () => {
    const first = await makeHarness(new PassingReceiptRunner());
    const agent = await first.service.createAgent({
      name: "Strict Promotion recovery authority",
    });
    const admitted = await first.service.sendMessage(
      agent.id,
      "Create authority before a forged recovery suffix.",
    );
    await waitForRunTransactionStatus(
      first.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
    const authorityDirectory = path.join(
      first.config.dataDirectory,
      "portable-decision-journal",
      admitted.run.id,
    );
    const authorityFile = (await readdir(authorityDirectory)).find((entry) =>
      entry.endsWith(".json"),
    )!;
    const original = JSON.parse(
      await readFile(path.join(authorityDirectory, authorityFile), "utf8"),
    );
    const recoveredTransaction = structuredClone(original.transaction);
    recoveredTransaction.recovery.recoveredAfterRestart = true;
    recoveredTransaction.providerResourceEvents.push({
      schemaVersion: 1,
      providerId: "forged-provider",
      resourceKind: "forged-kind",
      stage: "reconcile",
      status: "passed",
      summary: "Forged provider reconciliation",
      at: new Date().toISOString(),
    });
    const transactionEvidenceHash =
      portableDecisionTransactionHash(recoveredTransaction);
    const unsigned = {
      schemaVersion: original.schemaVersion,
      transactionEvidenceHash,
      parentAuthorityDigest: original.parentAuthorityDigest,
      candidateSetAuthorityDigest: original.candidateSetAuthorityDigest,
      runId: original.runId,
      agentId: original.agentId,
      disposition: original.disposition,
      decidedAt: original.decidedAt,
    };
    const authorityDigest =
      "sha256:" +
      createHash("sha256").update(stableJson(unsigned)).digest("hex");
    await writeFile(
      path.join(
        authorityDirectory,
        authorityDigest.replace("sha256:", "sha256-") + ".json",
      ),
      JSON.stringify({
        ...unsigned,
        authorityDigest,
        transaction: recoveredTransaction,
      }) + "\n",
      "utf8",
    );

    const restarted = new AgentService(
      first.config,
      new JsonStore(path.join(first.config.dataDirectory, "db.json")),
      new WorkspaceManager(first.config.workspaceRoot),
      new PassingReceiptRunner(),
    );
    await restarted.initialize();
    expect(restarted.getAgent(agent.id)).toMatchObject({ status: "error" });
    expect(restarted.getRun(admitted.run.id)).toMatchObject({
      status: "failed",
      transaction: { status: "recovery-error" },
    });
  });

  it("rejects forged provider evidence in a Discard authority", async () => {
    const first = await makeHarness(new QuarantineThenRepairRunner());
    const agent = await first.service.createAgent({
      name: "Strict Discard authority",
    });
    const admitted = await first.service.sendMessage(
      agent.id,
      "Create a Quarantine before a forged Discard suffix.",
    );
    await waitForRunTransactionStatus(
      first.service,
      admitted.run.id,
      "quarantined",
      agent.id,
    );
    await first.service.discardRun(admitted.run.id);

    const authorityDirectory = path.join(
      first.config.dataDirectory,
      "portable-decision-journal",
      admitted.run.id,
    );
    const authorityRecords = await Promise.all(
      (await readdir(authorityDirectory))
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => ({
          entry,
          authority: JSON.parse(
            await readFile(path.join(authorityDirectory, entry), "utf8"),
          ),
        })),
    );
    const discarded = authorityRecords.find(
      ({ authority }) => authority.disposition === "discarded",
    );
    if (!discarded) throw new Error("Discard authority fixture is missing");
    await rm(path.join(authorityDirectory, discarded.entry));

    const forgedTransaction = structuredClone(discarded.authority.transaction);
    forgedTransaction.providerResourceEvents.push({
      schemaVersion: 1,
      providerId: "forged-provider",
      resourceKind: "forged-kind",
      stage: "discard",
      status: "passed",
      summary: "Forged provider Discard",
      at: new Date().toISOString(),
    });
    const transactionEvidenceHash =
      portableDecisionTransactionHash(forgedTransaction);
    const unsigned = {
      schemaVersion: discarded.authority.schemaVersion,
      transactionEvidenceHash,
      parentAuthorityDigest: discarded.authority.parentAuthorityDigest,
      candidateSetAuthorityDigest:
        discarded.authority.candidateSetAuthorityDigest,
      runId: discarded.authority.runId,
      agentId: discarded.authority.agentId,
      disposition: discarded.authority.disposition,
      decidedAt: discarded.authority.decidedAt,
    };
    const authorityDigest =
      "sha256:" +
      createHash("sha256").update(stableJson(unsigned)).digest("hex");
    await writeFile(
      path.join(
        authorityDirectory,
        authorityDigest.replace("sha256:", "sha256-") + ".json",
      ),
      JSON.stringify({
        ...unsigned,
        authorityDigest,
        transaction: forgedTransaction,
      }) + "\n",
      "utf8",
    );

    const restarted = new AgentService(
      first.config,
      new JsonStore(path.join(first.config.dataDirectory, "db.json")),
      new WorkspaceManager(first.config.workspaceRoot),
      new PassingReceiptRunner(),
    );
    await restarted.initialize();
    expect(restarted.getAgent(agent.id)).toMatchObject({ status: "error" });
    expect(restarted.getRun(admitted.run.id)).toMatchObject({
      status: "failed",
      transaction: { status: "recovery-error" },
    });
  });

  it("rejects a symbolic-link substitution at the decision authority boundary", async () => {
    const harness = await makeHarness(new PassingReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable authority confinement",
    });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Create decision authority before a directory substitution check.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
    const runAuthorityDirectory = path.join(
      harness.config.dataDirectory,
      "portable-decision-journal",
      admitted.run.id,
    );
    const displacedDirectory = runAuthorityDirectory + ".displaced";
    await rename(runAuthorityDirectory, displacedDirectory);
    await symlink(displacedDirectory, runAuthorityDirectory, "dir");

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(
      /decision authority/,
    );
    await expectFileMissing(harness.config.portableSigningKeyPath);
  });

  it("rejects replacement of the pinned decision authority root", async () => {
    const harness = await makeHarness(new PassingReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable authority root confinement",
    });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Create decision authority before replacing its pinned root.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      admitted.run.id,
      "promoted",
      agent.id,
    );
    const authorityRoot = path.join(
      harness.config.dataDirectory,
      "portable-decision-journal",
    );
    const displacedRoot = authorityRoot + ".displaced";
    await rename(authorityRoot, displacedRoot);
    await symlink(displacedRoot, authorityRoot, "dir");

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(
      /decision authority/,
    );
    await expectFileMissing(harness.config.portableSigningKeyPath);
  });

  it("cleans every crash-stage authority remnant before publishing the next decision", async () => {
    const harness = await makeHarness(new QuarantineThenRepairRunner());
    const agent = await harness.service.createAgent({
      name: "Crash-safe authority",
    });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Retain one Candidate before crash-remnant cleanup.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      admitted.run.id,
      "quarantined",
      agent.id,
    );
    const authorityDirectory = path.join(
      harness.config.dataDirectory,
      "portable-decision-journal",
      admitted.run.id,
    );
    const published = (await readdir(authorityDirectory)).find((name) =>
      name.endsWith(".json"),
    )!;
    await writeFile(
      path.join(
        authorityDirectory,
        ".authority-00000000-0000-4000-8000-000000000001.tmp",
      ),
      "",
    );
    await writeFile(
      path.join(
        authorityDirectory,
        ".authority-00000000-0000-4000-8000-000000000002.tmp",
      ),
      '{"partial":',
    );
    await writeFile(
      path.join(
        authorityDirectory,
        ".authority-00000000-0000-4000-8000-000000000003.tmp",
      ),
      '{"complete":"but-unpublished"}\n',
    );
    await link(
      path.join(authorityDirectory, published),
      path.join(
        authorityDirectory,
        ".authority-00000000-0000-4000-8000-000000000004.tmp",
      ),
    );

    const discarded = await harness.service.discardRun(admitted.run.id);
    expect(discarded.transaction?.disposition).toBe("discarded");
    expect(
      (await readdir(authorityDirectory)).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${admitted.run.id}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it("cleans historical-manifest crash remnants before the next Promotion", async () => {
    const harness = await makeHarness(new PassingReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Crash-safe history",
    });
    const first = await harness.service.sendMessage(
      agent.id,
      "Publish one historical Canonical manifest.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      first.run.id,
      "promoted",
      agent.id,
    );
    expect(harness.service.getAgent(agent.id).status).toBe("ready");
    const historyDirectory = path.join(
      harness.config.workspaceRoot,
      agent.id,
      ".canonical-history",
    );
    const published = (await readdir(historyDirectory)).find((name) =>
      name.endsWith(".json"),
    )!;
    await writeFile(
      path.join(
        historyDirectory,
        ".canonical-history-00000000-0000-4000-8000-000000000001.tmp",
      ),
      '{"partial":',
    );
    await link(
      path.join(historyDirectory, published),
      path.join(
        historyDirectory,
        ".canonical-history-00000000-0000-4000-8000-000000000002.tmp",
      ),
    );

    const second = await harness.service.sendMessage(
      agent.id,
      "Publish the next state after recovering immutable history.",
    );
    await waitForRunTransactionStatus(
      harness.service,
      second.run.id,
      "promoted",
      agent.id,
    );
    expect(harness.service.getAgent(agent.id).status).toBe("ready");
    expect(
      (await readdir(historyDirectory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("exports exact source and installed versions from a real Resource Provider", async () => {
    const harness = await makeProviderHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${harness.runId}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const exported = response.json<PortableExportResponse>();
    expect(exported.envelope.receipt.state.before.providerResources).toEqual([
      expect.objectContaining({
        providerId: "portable-json",
        versionId: "version-initial",
      }),
    ]);
    expect(exported.envelope.receipt.state.after.providerResources).toEqual([
      expect.objectContaining({
        providerId: "portable-json",
        versionId: "version-" + harness.runId,
      }),
    ]);
  });

  it.each([
    "installed-version",
    "installed-fingerprint",
    "required-provider-validation",
    "historical-provider-vector",
  ] as const)(
    "rejects %s corruption before creating a signing key",
    async (kind) => {
      const harness = await makeProviderHarness();
      if (kind === "historical-provider-vector") {
        const manifestPath = path.join(
          harness.config.workspaceRoot,
          harness.agentId,
          ".canonical-history",
          harness.stateId + ".json",
        );
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          providerVersions: Array<{ versionId: string }>;
        };
        manifest.providerVersions[0]!.versionId = "forged-history-version";
        await writeFile(manifestPath, JSON.stringify(manifest) + "\n");
      } else {
        await harness.store.mutate((database) => {
          const resource = database.runs.find(
            (run) => run.id === harness.runId,
          )!.transaction!.providerResources[0]!;
          if (kind === "installed-version") {
            resource.installedVersion!.versionId = "forged-installed-version";
          } else if (kind === "installed-fingerprint") {
            resource.installedVersion!.fingerprint = "f".repeat(64);
          } else {
            resource.validations = [];
          }
        });
      }
      const response = await harness.app.inject({
        method: "POST",
        url: `/api/runs/${harness.runId}/portable-receipt`,
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      await expectFileMissing(harness.config.portableSigningKeyPath);
    },
  );

  it("replays Candidate Selection and validates the winner seal before signing", async () => {
    const harness = await makeHarness(new BoundedReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable sealed winner",
    });
    const admission = await harness.app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/candidate-sets`,
      payload: {
        objective: "Select one winner for an adversarial source check.",
        competitors: [
          {
            id: "alpha",
            executorProfileId: "standard-v1",
            strategyInstruction: "Produce one valid future.",
          },
          {
            id: "beta",
            executorProfileId: "standard-v1",
            strategyInstruction: "Produce another valid future.",
          },
        ],
        maxConcurrency: 2,
        loserPolicy: "discard",
      },
    });
    const candidateSetId = admission.json<{ candidateSet: { id: string } }>()
      .candidateSet.id;
    await waitForCandidateSetCompletion(
      harness.service,
      candidateSetId,
      agent.id,
    );
    const winnerRunId =
      harness.service.getCandidateSet(candidateSetId).winnerRunId!;
    await harness.store.mutate((database) => {
      database.runs.find((run) => run.id === winnerRunId)!.output =
        "Forged output after the winner seal.";
    });
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${winnerRunId}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(
      /Selection evidence/,
    );
    await expectFileMissing(harness.config.portableSigningKeyPath);
  });

  it("binds a coordinated winner-seal rewrite to immutable Candidate authority", async () => {
    const harness = await makeHarness(new BoundedReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable sealed authority",
    });
    const admission = await harness.app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/candidate-sets`,
      payload: {
        objective: "Select one winner before coordinated seal corruption.",
        competitors: [
          {
            id: "alpha",
            executorProfileId: "standard-v1",
            strategyInstruction: "Produce one valid future.",
          },
          {
            id: "beta",
            executorProfileId: "standard-v1",
            strategyInstruction: "Produce another valid future.",
          },
        ],
        maxConcurrency: 2,
        loserPolicy: "discard",
      },
    });
    const candidateSetId = admission.json<{ candidateSet: { id: string } }>()
      .candidateSet.id;
    await waitForCandidateSetCompletion(
      harness.service,
      candidateSetId,
      agent.id,
    );
    const winnerRunId =
      harness.service.getCandidateSet(candidateSetId).winnerRunId!;
    await harness.store.mutate((database) => {
      const candidateSet = database.candidateSets.find(
        (candidate) => candidate.id === candidateSetId,
      )!;
      const winner = candidateSet.competitors.find(
        (competitor) => competitor.runId === winnerRunId,
      )!;
      winner.seal!.transactionEvidenceHash = `sha256:${"e".repeat(64)}`;
      const { sealDigest: _oldDigest, ...unsigned } = winner.seal!;
      winner.seal!.sealDigest =
        "sha256:" +
        createHash("sha256").update(stableJson(unsigned)).digest("hex");
    });
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${winnerRunId}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(
      /decision authority|Candidate Set/,
    );
    await expectFileMissing(harness.config.portableSigningKeyPath);
  });

  it("binds loser cleanup policy to immutable Candidate authority", async () => {
    const harness = await makeHarness(new BoundedReceiptRunner());
    const agent = await harness.service.createAgent({
      name: "Portable loser policy authority",
    });
    const admission = await harness.app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/candidate-sets`,
      payload: {
        objective: "Bind irreversible loser cleanup to the selected policy.",
        competitors: [
          {
            id: "alpha",
            executorProfileId: "standard-v1",
            strategyInstruction: "Produce one valid future.",
          },
          {
            id: "beta",
            executorProfileId: "standard-v1",
            strategyInstruction: "Produce another valid future.",
          },
        ],
        maxConcurrency: 2,
        loserPolicy: "retain",
      },
    });
    expect(admission.statusCode, admission.body).toBe(202);
    const candidateSetId = admission.json<{ candidateSet: { id: string } }>()
      .candidateSet.id;
    await waitForCandidateSetCompletion(
      harness.service,
      candidateSetId,
      agent.id,
    );
    const winnerRunId =
      harness.service.getCandidateSet(candidateSetId).winnerRunId!;
    await harness.store.mutate((database) => {
      const candidateSet = database.candidateSets.find(
        (candidate) => candidate.id === candidateSetId,
      )!;
      candidateSet.loserPolicy = "discard";
    });

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${winnerRunId}/portable-receipt`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(
      /decision authority|Candidate Set/,
    );
    await expectFileMissing(harness.config.portableSigningKeyPath);
  });

  it.skipIf(process.platform === "win32")(
    "fails optional trust storage closed without leaking operator paths",
    async () => {
      const harness = await makeHarness(new PassingReceiptRunner());
      const agent = await harness.service.createAgent({
        name: "Portable custody",
      });
      const admitted = await harness.service.sendMessage(
        agent.id,
        "Create complete evidence before exercising trust-storage failures.",
      );
      await waitForRunTransactionStatus(
        harness.service,
        admitted.run.id,
        "promoted",
        agent.id,
      );

      const initial = await harness.app.inject({
        method: "POST",
        url: `/api/runs/${admitted.run.id}/portable-receipt`,
        payload: { localAnchor: true },
      });
      expect(initial.statusCode, initial.body).toBe(200);

      await writeFile(harness.config.transparencyLogPath, "tampered-log\n");
      const anchored = await harness.app.inject({
        method: "POST",
        url: `/api/runs/${admitted.run.id}/portable-receipt`,
        payload: { localAnchor: true },
      });
      expect(anchored.statusCode).toBe(503);
      expect(anchored.json()).toEqual({
        error: "Local transparency anchoring is unavailable",
      });
      expect(anchored.body).not.toContain(harness.config.transparencyLogPath);

      const signatureOnly = await harness.app.inject({
        method: "POST",
        url: `/api/runs/${admitted.run.id}/portable-receipt`,
        payload: {},
      });
      expect(signatureOnly.statusCode, signatureOnly.body).toBe(200);
      expect(
        verifyPortablePromotionEnvelope(
          signatureOnly.json<PortableExportResponse>().envelope,
        ).valid,
      ).toBe(true);

      await chmod(harness.config.portableSigningKeyPath, 0o644);
      const unsafeKey = await harness.app.inject({
        method: "POST",
        url: `/api/runs/${admitted.run.id}/portable-receipt`,
        payload: {},
      });
      expect(unsafeKey.statusCode).toBe(503);
      expect(unsafeKey.json()).toEqual({
        error: "Portable receipt signing is unavailable",
      });
      expect(unsafeKey.body).not.toContain(
        harness.config.portableSigningKeyPath,
      );
      expect(
        harness.service.getRun(admitted.run.id).transaction?.disposition,
      ).toBe("promoted");
    },
  );
});

async function makeHarness(
  runner: AgentRunner,
  resourceCoordinator?: ResourceCoordinator,
) {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-phase-eleven-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "phase-eleven-fixture-key",
    ARK_MODEL: "phase-eleven-fixture-model",
  });
  const store = new JsonStore(path.join(config.dataDirectory, "db.json"));
  const workspaces = new WorkspaceManager(
    config.workspaceRoot,
    undefined,
    undefined,
    resourceCoordinator?.initialVersions(),
  );
  const service = new AgentService(
    config,
    store,
    workspaces,
    runner,
    undefined,
    undefined,
    resourceCoordinator,
  );
  await service.initialize();
  const app = await createApp(config, service);
  return { app, config, service, store };
}

async function makeProviderHarness() {
  const provider = new DeterministicJsonProvider();
  const initialValue = { release: "portable-canonical" };
  provider.versions.set("version-initial", initialValue);
  const coordinator = new ResourceCoordinator(
    new ResourceRegistry([
      {
        provider,
        initialVersion: jsonVersionReference("version-initial", initialValue),
      },
    ]),
  );
  const harness = await makeHarness(new ProviderReceiptRunner(), coordinator);
  const agent = await harness.service.createAgent({
    name: "Portable provider",
  });
  const admitted = await harness.service.sendMessage(
    agent.id,
    "Promote a Candidate with a registered Resource Provider.",
  );
  await waitForRunTransactionStatus(
    harness.service,
    admitted.run.id,
    "promoted",
    agent.id,
  );
  const transaction = harness.service.getRun(admitted.run.id).transaction!;
  return {
    ...harness,
    agentId: agent.id,
    runId: admitted.run.id,
    stateId: transaction.canonicalStateIdAfter!,
  };
}

async function expectFileMissing(filePath: string): Promise<void> {
  await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

interface PortableExportResponse {
  envelope: PortablePromotionEnvelope;
  verification: {
    valid: boolean;
    commitments: { selection: boolean; assurance: boolean };
  };
  availableDisclosureIdentities: string[];
  anchor: {
    checkpoint: Parameters<typeof verifySignedTransparencyCheckpoint>[0] & {
      checkpoint: { treeSize: number };
    };
    inclusionProof: Parameters<typeof verifyTransparencyInclusion>[0];
  } | null;
  evmPayload: {
    receiptDigest: string;
    privacyClaim: string;
    networkCalls: number;
    fundsSpent: number;
  } | null;
}
