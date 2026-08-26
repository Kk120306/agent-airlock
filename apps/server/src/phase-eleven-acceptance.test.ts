import {
  verifyPortablePromotionEnvelope,
  verifySignedTransparencyCheckpoint,
  verifyTransparencyInclusion,
  type PortablePromotionEnvelope,
} from "@agent-airlock/portable-promotion-receipt";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistFixtureSession } from "../test/session-fixture.js";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { promotionValidationEvidenceHash } from "./promotion-receipt-evidence.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
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
  private readonly executionGate = new Promise<void>((resolve) => {
    this.releaseExecution = resolve;
  });

  release(): void {
    this.releaseExecution();
  }

  override async run(request: RunnerRequest): Promise<RunnerResult> {
    await this.executionGate;
    return super.run(request);
  }
}

describe("Phase 11 Portable Trust acceptance", () => {
  it("exports, self-verifies, anchors, and ABI-encodes one promoted Run over HTTP", async () => {
    const harness = await makeHarness(new PassingReceiptRunner());
    const agent = await harness.service.createAgent({ name: "Portable winner" });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Create a portable trust receipt without a network.",
    );
    await expect
      .poll(() => harness.service.getRun(admitted.run.id).transaction?.status)
      .toBe("promoted");

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
    expect(verifySignedTransparencyCheckpoint(result.anchor!.checkpoint).valid).toBe(
      true,
    );
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
    const agent = await harness.service.createAgent({ name: "Portable ancestry" });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Trigger the bounded rejection fixture.",
    );
    await expect
      .poll(() => harness.service.getRun(admitted.run.id).transaction?.status)
      .toBe("quarantined");

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
    const repairRunId = (repairResponse.json() as { run: { id: string } }).run.id;
    await expect
      .poll(() => harness.service.getRun(repairRunId).transaction?.status)
      .toBe("promoted");
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
    expect(discarded.envelope.receiptDigest).not.toBe(parent.envelope.receiptDigest);
    expect(verifyPortablePromotionEnvelope(parent.envelope).valid).toBe(true);
    expect(verifyPortablePromotionEnvelope(discarded.envelope).valid).toBe(true);
  });

  it("commits the durable Candidate Set selection into the winner receipt", async () => {
    const harness = await makeHarness(new BoundedReceiptRunner());
    const agent = await harness.service.createAgent({ name: "Portable selection" });
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
    await expect
      .poll(() => harness.service.getCandidateSet(candidateSetId).phase)
      .toBe("completed");
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

  it("binds an operator-accepted Assurance Proposal to future Run receipts", async () => {
    const harness = await makeHarness(new ThreeQuarantinesThenPassRunner());
    const agent = await harness.service.createAgent({ name: "Portable assurance" });
    for (let index = 0; index < 3; index += 1) {
      const admitted = await harness.service.sendMessage(
        agent.id,
        `Collect independent bounded evidence ${index + 1}.`,
      );
      await expect
        .poll(
          () =>
            harness.service.getRun(admitted.run.id).transaction?.status,
        )
        .toBe("quarantined");
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
    await expect
      .poll(() => harness.service.getRun(admitted.run.id).transaction?.status)
      .toBe("promoted");
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
    const agent = await harness.service.createAgent({ name: "Portable conflict" });
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
    await expect
      .poll(() => harness.service.getRun(admitted.run.id).transaction?.status)
      .toBe("promoted");
  });

  it("rejects every contradictory durable Promotion Receipt authority field before signing", async () => {
    const harness = await makeHarness(new PassingReceiptRunner());
    const agent = await harness.service.createAgent({ name: "Portable authority" });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Create a complete source for authority mutation checks.",
    );
    await expect
      .poll(() => harness.service.getRun(admitted.run.id).transaction?.status)
      .toBe("promoted");

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
      await expect
        .poll(() => harness.service.getRun(admitted.run.id).transaction?.status)
        .toBe("promoted");
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
    const agent = await harness.service.createAgent({ name: "Portable physical state" });
    const admitted = await harness.service.sendMessage(
      agent.id,
      "Promote a state that will be independently checked before export.",
    );
    await expect
      .poll(() => harness.service.getRun(admitted.run.id).transaction?.status)
      .toBe("promoted");
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
    expect(response.json<{ error: string }>().error).toMatch(/immutable historical/);
    await expectFileMissing(harness.config.portableSigningKeyPath);
  });

  it("replays Candidate Selection and validates the winner seal before signing", async () => {
    const harness = await makeHarness(new BoundedReceiptRunner());
    const agent = await harness.service.createAgent({ name: "Portable sealed winner" });
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
    await expect
      .poll(() => harness.service.getCandidateSet(candidateSetId).phase)
      .toBe("completed");
    const winnerRunId = harness.service.getCandidateSet(candidateSetId).winnerRunId!;
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
    expect(response.json<{ error: string }>().error).toMatch(/Selection evidence/);
    await expectFileMissing(harness.config.portableSigningKeyPath);
  });

  it.skipIf(process.platform === "win32")(
    "fails optional trust storage closed without leaking operator paths",
    async () => {
      const harness = await makeHarness(new PassingReceiptRunner());
      const agent = await harness.service.createAgent({ name: "Portable custody" });
      const admitted = await harness.service.sendMessage(
        agent.id,
        "Create complete evidence before exercising trust-storage failures.",
      );
      await expect
        .poll(() => harness.service.getRun(admitted.run.id).transaction?.status)
        .toBe("promoted");

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
      expect(unsafeKey.body).not.toContain(harness.config.portableSigningKeyPath);
      expect(harness.service.getRun(admitted.run.id).transaction?.disposition).toBe(
        "promoted",
      );
    },
  );
});

async function makeHarness(runner: AgentRunner) {
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
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(config.workspaceRoot),
    runner,
  );
  await service.initialize();
  const app = await createApp(config, service);
  return { app, config, service, store };
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
