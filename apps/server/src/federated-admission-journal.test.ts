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
  type FederatedAdmissionFaultBoundary,
  type FederatedCandidateAdapter,
} from "./federated-admission-journal.js";
import {
  FEDERATED_WORKSPACE_ARTIFACT_MEDIA_TYPE,
  FEDERATED_WORKSPACE_ARTIFACT_SCHEMA,
  FederatedAdmissionPolicyStore,
  type FederatedAdmissionEvidenceFacts,
  type FederatedAdmissionPolicy,
} from "./federated-admission-policy.js";

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

  async prepare(input: { agentId: string; runId: string; bundle: FederatedWorkBundle }) {
    expect(input.agentId).toBe("local-agent");
    expect(input.bundle.schemaVersion).toBe(1);
    if (this.candidates.has(input.runId)) throw new Error("duplicate Candidate State");
    this.prepareCount += 1;
    const candidate = { candidateStateId: `candidate-${this.prepareCount}` };
    this.candidates.set(input.runId, candidate);
    return candidate;
  }

  async inspect(runId: string) {
    return this.candidates.get(runId) ?? null;
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
  const template = (JSON.parse(source) as { envelope: PortablePromotionEnvelope }).envelope;
  const key = generatePortableSigningKey();
  const receipt = signPortableReceipt({ receipt: template.receipt, privateKey: key.privateKeyPem });
  const content = Buffer.from("federated work\n", "utf8");
  const artifact = buildWorkspaceChangeSetEnvelope({
    baseStateDigest: receipt.receipt.state.before.compositeHash,
    resultStateDigest: receipt.receipt.state.after.compositeHash,
    operations: [{
      operation: "add",
      path: "federated.txt",
      mediaType: "text/plain",
      encoding: "base64url",
      content: content.toString("base64url"),
      contentDigest: sha256Digest(content),
      byteLength: content.length,
      priorContentDigest: null,
    }],
  });
  const bundle = buildFederatedWorkBundle({ receipt, artifact, privateKey: key.privateKeyPem });
  const authorityKeyId = sha256Digest("producer-authority");
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
      producers: [{
        producerId: "producer-one",
        disabled: false,
        authorityKeyIds: [authorityKeyId],
        receiptSigners: [{
          keyId: receipt.keyId,
          status: "active",
          validFrom: "2026-08-01T00:00:00.000Z",
          validUntil: null,
        }],
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
        artifactLimits: { maximumBytes: 1_000_000, digestAlgorithms: ["SHA-256"] },
        transparency: { mode: "not-required", logKeyIds: [], pinnedCheckpointDigest: null },
        requireLocalApproval: false,
      }],
    },
    facts: {
      authorityKeyId,
      authorityPinned: true,
      completeDecisionChain: true,
      evaluatedAt: "2026-08-27T00:00:00.000Z",
      onlineHandoff: null,
      transparency: null,
      localApprovalGranted: false,
    },
  };
}

async function system(input: Awaited<ReturnType<typeof fixture>>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-admission-"));
  temporaryDirectories.push(root);
  const policyStore = new FederatedAdmissionPolicyStore(path.join(root, "policy"));
  const journal = new FederatedAdmissionJournal(path.join(root, "journal"));
  await policyStore.initialize();
  await journal.initialize();
  await policyStore.installAndActivate(input.policy);
  return { root, policyStore, journal, candidates: new MemoryCandidates() };
}

function request(input: Awaited<ReturnType<typeof fixture>>, producerId = "producer-one") {
  return {
    transferId: "transfer-one",
    producerId,
    localAgentId: "local-agent",
    bundle: input.bundle,
    facts: input.facts,
  };
}

describe("FederatedAdmissionCoordinator", () => {
  it("publishes one admitted record and returns it for exact retries", async () => {
    const input = await fixture();
    const state = await system(input);
    const coordinator = new FederatedAdmissionCoordinator(
      state.policyStore,
      state.journal,
      state.candidates,
      { now: () => "2026-08-27T00:00:01.000Z" },
    );

    const first = await coordinator.admit(request(input));
    const retry = await coordinator.admit(request(input));

    expect(first).toEqual(retry);
    expect(first.decision.decision).toBe("admit");
    expect(first.candidateRunId).toMatch(/^federated-[a-f0-9]{48}$/);
    expect(state.candidates.candidates.get(first.candidateRunId!)).toEqual({
      candidateStateId: "candidate-1",
    });
    expect(state.candidates.prepareCount).toBe(1);
    expect((await state.journal.readByTransfer("transfer-one"))?.phase).toBe("completed");

    const recordPath = path.join(
      state.root,
      "journal",
      "records",
      `${first.importIdentifier.slice("sha256:".length)}.json`,
    );
    const tampered = structuredClone(first);
    tampered.decision.detail = "silently changed";
    await writeFile(recordPath, canonicalize(tampered) + "\n", "utf8");
    await expect(state.journal.readRecord(first.importIdentifier)).rejects.toThrow(/digest/);
  });

  it("recovers every durable boundary without creating a second Candidate State", async () => {
    const boundaries: FederatedAdmissionFaultBoundary[] = [
      "plan-published",
      "candidate-created",
      "candidate-recorded",
      "admission-record-published",
      "commit-completed",
    ];
    for (const boundary of boundaries) {
      const input = await fixture();
      const state = await system(input);
      let armed = true;
      const crashing = new FederatedAdmissionCoordinator(
        state.policyStore,
        state.journal,
        state.candidates,
        {
          now: () => "2026-08-27T00:00:01.000Z",
          injectFault: (current) => {
            if (armed && current === boundary) {
              armed = false;
              throw new Error(`crash:${boundary}`);
            }
          },
        },
      );
      await expect(crashing.admit(request(input)), boundary).rejects.toThrow(`crash:${boundary}`);
      if (boundary === "admission-record-published") {
        expect(state.candidates.prepareCount, boundary).toBe(0);
      }

      const restartedJournal = new FederatedAdmissionJournal(path.join(state.root, "journal"));
      await restartedJournal.initialize();
      const restarted = new FederatedAdmissionCoordinator(
        state.policyStore,
        restartedJournal,
        state.candidates,
        { now: () => "2026-08-27T00:00:02.000Z" },
      );
      const record = await restarted.admit(request(input));

      expect(record.decision.decision, boundary).toBe("admit");
      expect(state.candidates.prepareCount, boundary).toBe(1);
      expect((await restartedJournal.readByTransfer("transfer-one"))?.phase, boundary).toBe("completed");
    }
  });

  it("records rejection and pending approval without publishing Candidate State", async () => {
    const rejectedInput = await fixture();
    const rejectedState = await system(rejectedInput);
    const rejectedCoordinator = new FederatedAdmissionCoordinator(
      rejectedState.policyStore,
      rejectedState.journal,
      rejectedState.candidates,
    );
    const rejected = await rejectedCoordinator.admit(request(rejectedInput, "producer-two"));
    expect(rejected.decision).toMatchObject({ decision: "reject", reason: "producer-untrusted" });
    expect(rejected.candidateRunId).toBeNull();
    expect(rejectedState.candidates.prepareCount).toBe(0);

    const pendingInput = await fixture();
    pendingInput.policy.producers[0]!.requireLocalApproval = true;
    const pendingState = await system(pendingInput);
    const pendingCoordinator = new FederatedAdmissionCoordinator(
      pendingState.policyStore,
      pendingState.journal,
      pendingState.candidates,
    );
    const pending = await pendingCoordinator.admit(request(pendingInput));
    expect(pending.decision).toMatchObject({ decision: "pending", reason: "approval-required" });
    expect(pending.candidateRunId).toBeNull();
    expect(pendingState.candidates.prepareCount).toBe(0);
  });

  it("pins the original decision across policy changes and rejects transfer reuse", async () => {
    const input = await fixture();
    const state = await system(input);
    const coordinator = new FederatedAdmissionCoordinator(
      state.policyStore,
      state.journal,
      state.candidates,
    );
    const first = await coordinator.admit(request(input));

    const secondPolicy = structuredClone(input.policy);
    secondPolicy.generation = 2;
    secondPolicy.priorPolicyDigest = (await state.policyStore.readActive()).policyDigest;
    secondPolicy.activatedAt = "2026-08-26T00:00:00.000Z";
    secondPolicy.producers[0]!.disabled = true;
    await state.policyStore.installAndActivate(secondPolicy);

    expect(await coordinator.admit(request(input))).toEqual(first);
    const changedEvidence = structuredClone(input);
    changedEvidence.facts.localApprovalGranted = true;
    await expect(coordinator.admit(request(changedEvidence))).rejects.toThrow(/changed receiver evidence/);
    const changedAgentRequest = { ...request(input), localAgentId: "other-local-agent" };
    await expect(coordinator.admit(changedAgentRequest)).rejects.toThrow(/changed receiver evidence/);
    const conflicting = structuredClone(input);
    conflicting.bundle.artifact.artifactDigest = sha256Digest("different-artifact");
    await expect(coordinator.admit(request(conflicting))).rejects.toThrow(/conflicts/);
    expect(state.candidates.prepareCount).toBe(1);
  });
});
