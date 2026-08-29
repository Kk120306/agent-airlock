import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFederatedWorkBundle,
  buildWorkspaceChangeSetEnvelope,
  canonicalize,
  generatePortableSigningKey,
  sha256Digest,
  signPortableReceipt,
  type FederatedWorkBundle,
  type PortablePromotionEnvelope,
} from "@agent-airlock/portable-promotion-receipt";
import { afterEach, describe, expect, it } from "vitest";
import {
  FederatedAdmissionCoordinator,
  FederatedAdmissionJournal,
  type FederatedAdmissionRecord,
  type FederatedCandidateAdapter,
} from "./federated-admission-journal.js";
import {
  FEDERATED_WORKSPACE_ARTIFACT_MEDIA_TYPE,
  FEDERATED_WORKSPACE_ARTIFACT_SCHEMA,
  FederatedAdmissionPolicyStore,
  type FederatedAdmissionEvidenceFacts,
  type FederatedAdmissionPolicy,
} from "./federated-admission-policy.js";
import {
  FederatedApprovalCoordinator,
  FederatedApprovalJournal,
  type FederatedApprovalFaultBoundary,
} from "./federated-approval-journal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class MemoryCandidates implements FederatedCandidateAdapter {
  readonly candidates = new Map<string, { candidateStateId: string }>();
  prepareCount = 0;

  async prepare(input: Parameters<FederatedCandidateAdapter["prepare"]>[0]) {
    if (this.candidates.has(input.runId)) {
      throw new Error("duplicate Candidate State");
    }
    this.prepareCount += 1;
    const candidate = { candidateStateId: `candidate-${this.prepareCount}` };
    this.candidates.set(input.runId, candidate);
    return candidate;
  }

  async inspect(input: Parameters<FederatedCandidateAdapter["inspect"]>[0]) {
    return this.candidates.get(input.runId) ?? null;
  }
}

async function fixture(): Promise<{
  bundle: FederatedWorkBundle;
  policy: FederatedAdmissionPolicy;
  facts: FederatedAdmissionEvidenceFacts;
}> {
  const source = await readFile(
    new URL(
      "../../../packages/portable-promotion-receipt/vectors/portable-receipt-v1.golden.json",
      import.meta.url,
    ),
    "utf8",
  );
  const template = (JSON.parse(source) as { envelope: PortablePromotionEnvelope })
    .envelope;
  const key = generatePortableSigningKey();
  const receipt = signPortableReceipt({
    receipt: template.receipt,
    privateKey: key.privateKeyPem,
  });
  const content = Buffer.from("federated approval work\n", "utf8");
  const artifact = buildWorkspaceChangeSetEnvelope({
    baseStateDigest: receipt.receipt.state.before.compositeHash,
    resultStateDigest: receipt.receipt.state.after.compositeHash,
    operations: [
      {
        operation: "add",
        path: "approved.txt",
        mediaType: "text/plain",
        encoding: "base64url",
        content: content.toString("base64url"),
        contentDigest: sha256Digest(content),
        byteLength: content.length,
        priorContentDigest: null,
      },
    ],
  });
  const bundle = buildFederatedWorkBundle({
    receipt,
    artifact,
    privateKey: key.privateKeyPem,
  });
  return {
    bundle,
    policy: {
      schema: "agent-airlock/federated-admission-policy",
      schemaVersion: 1,
      policyId: "receiver-policy",
      generation: 1,
      activatedAt: "2026-08-25T00:00:00.000Z",
      priorPolicyDigest: null,
      receiverOrganizationId: "receiver-org",
      producers: [
        {
          producerId: "producer-one",
          disabled: false,
          authorityKeyIds: [sha256Digest("producer-authority")],
          receiptSigners: [
            {
              keyId: receipt.keyId,
              status: "active",
              validFrom: "2026-08-01T00:00:00.000Z",
              validUntil: null,
            },
          ],
          receiptSchemaVersions: [1],
          artifactSchemas: [FEDERATED_WORKSPACE_ARTIFACT_SCHEMA],
          artifactMediaTypes: [FEDERATED_WORKSPACE_ARTIFACT_MEDIA_TYPE],
          agentAliases: [receipt.receipt.decision.agentId],
          dispositions: [receipt.receipt.decision.disposition],
          builtinResourceKinds: ["workspace"],
          providerIds: [],
          providerResourceKinds: [],
          ancestry: { requireCompleteChain: true, maximumDepth: 3 },
          freshness: {
            maximumReceiptAgeSeconds: 172_800,
            allowOffline: true,
            maximumOnlineHandoffAgeSeconds: 3_600,
          },
          artifactLimits: {
            maximumBytes: 1_000_000,
            digestAlgorithms: ["SHA-256"],
          },
          transparency: {
            mode: "not-required",
            logKeyIds: [],
            pinnedCheckpointDigest: null,
          },
          requireLocalApproval: true,
        },
      ],
    },
    facts: {
      authorityKeyId: sha256Digest("producer-authority"),
      authorityPinned: true,
      completeDecisionChain: true,
      evaluatedAt: "2026-08-27T00:00:00.000Z",
      onlineHandoff: null,
      transparency: null,
      localApprovalGranted: false,
    },
  };
}

async function system(): Promise<{
  root: string;
  policyStore: FederatedAdmissionPolicyStore;
  admissionJournal: FederatedAdmissionJournal;
  approvalJournal: FederatedApprovalJournal;
  candidates: MemoryCandidates;
  pending: FederatedAdmissionRecord;
}> {
  const input = await fixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-approval-"));
  temporaryDirectories.push(root);
  const policyStore = new FederatedAdmissionPolicyStore(path.join(root, "policy"));
  const admissionJournal = new FederatedAdmissionJournal(
    path.join(root, "admissions"),
  );
  const approvalJournal = new FederatedApprovalJournal(path.join(root, "approvals"));
  const candidates = new MemoryCandidates();
  await policyStore.initialize();
  await admissionJournal.initialize();
  await approvalJournal.initialize();
  await policyStore.installAndActivate(input.policy);
  const pending = await new FederatedAdmissionCoordinator(
    policyStore,
    admissionJournal,
    candidates,
    { now: () => "2026-08-27T00:00:01.000Z" },
  ).admit({
    transferId: "transfer-one",
    producerId: "producer-one",
    localAgentId: "local-agent",
    bundle: input.bundle,
    facts: input.facts,
  });
  expect(pending.decision.decision).toBe("pending");
  return {
    root,
    policyStore,
    admissionJournal,
    approvalJournal,
    candidates,
    pending,
  };
}

function decision(
  pending: FederatedAdmissionRecord,
  choice: "approve" | "deny" = "approve",
) {
  return {
    pending,
    decisionContextDigest: sha256Digest("reviewed receiver context"),
    operatorId: "local-control-plane",
    choice,
    reason: choice === "approve" ? "Evidence reviewed" : "Risk rejected",
  };
}

describe("FederatedApprovalCoordinator", () => {
  it("publishes one immutable approval and returns it for exact retries", async () => {
    const state = await system();
    const coordinator = new FederatedApprovalCoordinator(
      state.admissionJournal,
      state.approvalJournal,
      state.candidates,
      { now: () => "2026-08-27T00:00:02.000Z" },
    );

    const first = await coordinator.decide(decision(state.pending));
    const retry = await coordinator.decide(decision(state.pending));

    expect(retry).toEqual(first);
    expect(first.approval.choice).toBe("approve");
    expect(first.approval).toMatchObject({
      schemaVersion: 2,
      decisionContextDigest: sha256Digest("reviewed receiver context"),
    });
    expect(first.plan).toMatchObject({
      phase: "completed",
      candidateStateId: "candidate-1",
    });
    expect(state.candidates.prepareCount).toBe(1);
  });

  it("denies without creating Candidate State", async () => {
    const state = await system();
    const result = await new FederatedApprovalCoordinator(
      state.admissionJournal,
      state.approvalJournal,
      state.candidates,
    ).decide(decision(state.pending, "deny"));

    expect(result.approval.choice).toBe("deny");
    expect(result.plan).toMatchObject({
      phase: "completed",
      candidateRunId: null,
      candidateStateId: null,
    });
    expect(state.candidates.prepareCount).toBe(0);
  });

  it("rejects any contradiction to the immutable first operator decision", async () => {
    const state = await system();
    const coordinator = new FederatedApprovalCoordinator(
      state.admissionJournal,
      state.approvalJournal,
      state.candidates,
    );
    await coordinator.decide(decision(state.pending, "deny"));

    await expect(
      coordinator.decide(decision(state.pending, "approve")),
    ).rejects.toThrow(/conflicts with the immutable first decision/);
    await expect(
      coordinator.decide({
        ...decision(state.pending, "deny"),
        operatorId: "different-operator",
      }),
    ).rejects.toThrow(/conflicts with the immutable first decision/);
    await expect(
      coordinator.decide({
        ...decision(state.pending, "deny"),
        reason: "Different reason",
      }),
    ).rejects.toThrow(/conflicts with the immutable first decision/);
    await expect(
      coordinator.decide({
        ...decision(state.pending, "deny"),
        decisionContextDigest: sha256Digest("different receiver context"),
      }),
    ).rejects.toThrow(/conflicts with the immutable first decision/);
  });

  it("recovers every durable boundary without creating a second Candidate State", async () => {
    const boundaries: FederatedApprovalFaultBoundary[] = [
      "decision-published",
      "candidate-created",
      "candidate-recorded",
      "commit-completed",
    ];
    for (const boundary of boundaries) {
      const state = await system();
      let armed = true;
      const crashing = new FederatedApprovalCoordinator(
        state.admissionJournal,
        state.approvalJournal,
        state.candidates,
        {
          now: () => "2026-08-27T00:00:02.000Z",
          injectFault: (current) => {
            if (armed && current === boundary) {
              armed = false;
              throw new Error(`crash:${boundary}`);
            }
          },
        },
      );
      await expect(
        crashing.decide(decision(state.pending)),
        boundary,
      ).rejects.toThrow(`crash:${boundary}`);

      const restartedJournal = new FederatedApprovalJournal(
        path.join(state.root, "approvals"),
      );
      await restartedJournal.initialize();
      const result = await new FederatedApprovalCoordinator(
        state.admissionJournal,
        restartedJournal,
        state.candidates,
        { now: () => "2026-08-27T00:00:03.000Z" },
      ).decide(decision(state.pending));

      expect(result.plan.phase, boundary).toBe("completed");
      expect(result.plan.candidateStateId, boundary).toBe("candidate-1");
      expect(state.candidates.prepareCount, boundary).toBe(1);
    }
  });

  it("uses the pinned pending Admission after receiver policy changes", async () => {
    const state = await system();
    const active = await state.policyStore.readActive();
    const changed = structuredClone(active.policy);
    changed.generation = 2;
    changed.activatedAt = "2026-08-27T00:00:02.000Z";
    changed.priorPolicyDigest = active.policyDigest;
    changed.producers[0]!.disabled = true;
    await state.policyStore.installAndActivate(changed);

    const result = await new FederatedApprovalCoordinator(
      state.admissionJournal,
      state.approvalJournal,
      state.candidates,
    ).decide(decision(state.pending));

    expect(result.approval.pendingRecordDigest).toBe(state.pending.recordDigest);
    expect(result.plan.phase).toBe("completed");
  });

  it("recovers a legacy decision without inventing reviewed-context evidence", async () => {
    const state = await system();
    const approvalId = sha256Digest(
      "agent-airlock/federated-approval-id/v1\n" + state.pending.admissionId,
    );
    const legacyBody = {
      schema: "agent-airlock/federated-approval-decision" as const,
      schemaVersion: 1 as const,
      approvalId,
      admissionId: state.pending.admissionId,
      importIdentifier: state.pending.importIdentifier,
      pendingRecordDigest: state.pending.recordDigest,
      localAgentId: state.pending.localAgentId,
      operatorId: "local-control-plane",
      choice: "approve" as const,
      reason: "Evidence reviewed",
      decidedAt: "2026-08-27T00:00:02.000Z",
    };
    const legacyRecord = {
      ...legacyBody,
      recordDigest: sha256Digest(canonicalize(legacyBody)),
    };
    await writeFile(
      path.join(
        state.root,
        "approvals",
        "records",
        `${approvalId.slice("sha256:".length)}.json`,
      ),
      canonicalize(legacyRecord) + "\n",
      { mode: 0o600 },
    );

    const restartedJournal = new FederatedApprovalJournal(
      path.join(state.root, "approvals"),
    );
    await restartedJournal.initialize();
    const result = await new FederatedApprovalCoordinator(
      state.admissionJournal,
      restartedJournal,
      state.candidates,
    ).decide(decision(state.pending));

    expect(result.approval.schemaVersion).toBe(1);
    expect("decisionContextDigest" in result.approval).toBe(false);
    expect(result.plan.phase).toBe("completed");
    expect(state.candidates.prepareCount).toBe(1);
  });

  it("fails closed when durable approval evidence is tampered", async () => {
    const recordState = await system();
    const record = await recordState.approvalJournal.begin({
      ...decision(recordState.pending),
      now: "2026-08-27T00:00:02.000Z",
    });
    const recordPath = path.join(
      recordState.root,
      "approvals",
      "records",
      `${record.approval.approvalId.slice("sha256:".length)}.json`,
    );
    const tamperedRecord = JSON.parse(await readFile(recordPath, "utf8"));
    tamperedRecord.decisionContextDigest = sha256Digest("silently changed");
    await writeFile(recordPath, canonicalize(tamperedRecord) + "\n", "utf8");
    await expect(recordState.approvalJournal.listRecords()).rejects.toThrow(
      /digest/,
    );

    const planState = await system();
    const plan = await planState.approvalJournal.begin({
      ...decision(planState.pending),
      now: "2026-08-27T00:00:02.000Z",
    });
    const planPath = path.join(
      planState.root,
      "approvals",
      "plans",
      `${plan.approval.approvalId.slice("sha256:".length)}.json`,
    );
    const tamperedPlan = JSON.parse(await readFile(planPath, "utf8"));
    tamperedPlan.decisionRecordDigest = sha256Digest("wrong decision");
    await writeFile(planPath, canonicalize(tamperedPlan) + "\n", "utf8");
    const restarted = new FederatedApprovalJournal(
      path.join(planState.root, "approvals"),
    );
    await expect(restarted.initialize()).rejects.toThrow(
      /contradicts its immutable decision/,
    );
  });
});
