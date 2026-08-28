import { Buffer } from "node:buffer";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  type ReceiptDigest,
} from "@agent-airlock/portable-promotion-receipt";
import { afterEach, describe, expect, it } from "vitest";
import {
  FEDERATED_WORKSPACE_ARTIFACT_MEDIA_TYPE,
  FEDERATED_WORKSPACE_ARTIFACT_SCHEMA,
  FederatedAdmissionPolicyStore,
  digestFederatedAdmissionPolicy,
  evaluateFederatedAdmissionPolicy,
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
  const content = Buffer.from("federated work\n", "utf8");
  const artifact = buildWorkspaceChangeSetEnvelope({
    baseStateDigest: receipt.receipt.state.before.compositeHash,
    resultStateDigest: receipt.receipt.state.after.compositeHash,
    operations: [
      {
        operation: "add",
        path: "federated.txt",
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
  const authorityKeyId = sha256Digest("producer-authority");
  const policy: FederatedAdmissionPolicy = {
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
        authorityKeyIds: [authorityKeyId],
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
        artifactLimits: { maximumBytes: 1_000_000, digestAlgorithms: ["SHA-256"] },
        transparency: {
          mode: "not-required",
          logKeyIds: [],
          pinnedCheckpointDigest: null,
        },
        requireLocalApproval: false,
      },
    ],
  };
  return {
    bundle,
    policy,
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

function decide(input: Awaited<ReturnType<typeof fixture>>) {
  return evaluateFederatedAdmissionPolicy({
    policy: input.policy,
    producerId: "producer-one",
    bundle: input.bundle,
    facts: input.facts,
  });
}

describe("federated admission policy", () => {
  it("admits one exact valid offline bundle and records the policy generation", async () => {
    const input = await fixture();
    const decision = decide(input);

    expect(decision).toMatchObject({
      decision: "admit",
      reason: "admitted",
      policyId: input.policy.policyId,
      policyGeneration: 1,
      policyDigest: digestFederatedAdmissionPolicy(input.policy),
      receiptDigest: input.bundle.receipt.receiptDigest,
      artifactDigest: input.bundle.artifact.artifactDigest,
    });
  });

  it("fails closed across the receiver-controlled policy dimensions", async () => {
    const cases: Array<{
      name: string;
      reason: string;
      mutate: (input: Awaited<ReturnType<typeof fixture>>) => void;
      producerId?: string;
    }> = [
      { name: "future policy", reason: "policy-not-active", mutate: (x) => { x.policy.activatedAt = "2026-08-28T00:00:00.000Z"; } },
      { name: "unknown producer", reason: "producer-untrusted", producerId: "producer-two", mutate: () => undefined },
      { name: "disabled producer", reason: "producer-disabled", mutate: (x) => { x.policy.producers[0]!.disabled = true; } },
      { name: "unpinned authority", reason: "authority-unpinned", mutate: (x) => { x.facts.authorityPinned = false; } },
      { name: "wrong authority", reason: "authority-unpinned", mutate: (x) => { x.facts.authorityKeyId = sha256Digest("other-authority"); } },
      { name: "unknown signer", reason: "signer-scope-mismatch", mutate: (x) => { x.policy.producers[0]!.receiptSigners[0]!.keyId = sha256Digest("other-signer"); } },
      { name: "compromised signer", reason: "signer-compromised", mutate: (x) => { x.policy.producers[0]!.receiptSigners[0]!.status = "compromised"; } },
      { name: "signer window", reason: "signer-window-mismatch", mutate: (x) => { x.policy.producers[0]!.receiptSigners[0]!.validFrom = "2026-08-27T00:00:00.000Z"; } },
      { name: "protocol", reason: "protocol-not-allowed", mutate: (x) => { x.policy.producers[0]!.artifactSchemas = ["example/other-artifact"]; } },
      { name: "media type", reason: "artifact-type-not-allowed", mutate: (x) => { x.policy.producers[0]!.artifactMediaTypes = ["application/example+json"]; } },
      { name: "Agent alias", reason: "agent-scope-mismatch", mutate: (x) => { x.policy.producers[0]!.agentAliases = ["other-agent"]; } },
      { name: "disposition", reason: "disposition-scope-mismatch", mutate: (x) => { x.policy.producers[0]!.dispositions = ["quarantined"]; } },
      { name: "resource", reason: "resource-scope-mismatch", mutate: (x) => { x.policy.producers[0]!.builtinResourceKinds = []; } },
      { name: "ancestry", reason: "ancestry-incomplete", mutate: (x) => { x.facts.completeDecisionChain = false; } },
      { name: "future receipt", reason: "receipt-clock-invalid", mutate: (x) => { x.facts.evaluatedAt = "2026-08-25T12:00:00.000Z"; } },
      { name: "stale receipt", reason: "receipt-stale", mutate: (x) => { x.policy.producers[0]!.freshness.maximumReceiptAgeSeconds = 1; } },
      { name: "offline prohibited", reason: "offline-transfer-not-allowed", mutate: (x) => { x.policy.producers[0]!.freshness.allowOffline = false; } },
      { name: "artifact size", reason: "artifact-size-exceeded", mutate: (x) => { x.policy.producers[0]!.artifactLimits.maximumBytes = 1; } },
      { name: "digest algorithm", reason: "digest-algorithm-not-allowed", mutate: (x) => { x.policy.producers[0]!.artifactLimits.digestAlgorithms = []; } },
    ];

    for (const testCase of cases) {
      const input = await fixture();
      testCase.mutate(input);
      const result = evaluateFederatedAdmissionPolicy({
        policy: input.policy,
        producerId: testCase.producerId ?? "producer-one",
        bundle: input.bundle,
        facts: input.facts,
      });
      expect(result.reason, testCase.name).toBe(testCase.reason);
      expect(result.decision, testCase.name).toBe("reject");
    }
  });

  it("checks online handoff, transparency consistency, split view, and approval", async () => {
    const input = await fixture();
    const rule = input.policy.producers[0]!;
    rule.freshness.allowOffline = false;
    input.facts.onlineHandoff = {
      valid: true,
      issuedAt: "2026-08-26T23:30:00.000Z",
      expiresAt: "2026-08-27T00:30:00.000Z",
    };
    const checkpoint = sha256Digest("checkpoint");
    const logKey = sha256Digest("log-key");
    rule.transparency = {
      mode: "consistency-required",
      logKeyIds: [logKey],
      pinnedCheckpointDigest: checkpoint,
    };
    input.facts.transparency = {
      included: true,
      consistent: true,
      splitView: false,
      logKeyId: logKey,
      priorCheckpointDigest: checkpoint,
    };
    rule.requireLocalApproval = true;

    expect(decide(input)).toMatchObject({ decision: "pending", reason: "approval-required" });
    input.facts.localApprovalGranted = true;
    expect(decide(input)).toMatchObject({ decision: "admit", reason: "admitted" });
    input.facts.transparency.splitView = true;
    expect(decide(input).reason).toBe("transparency-split-view");
    input.facts.transparency.splitView = false;
    input.facts.transparency.consistent = false;
    expect(decide(input).reason).toBe("transparency-inconsistent");
    input.facts.transparency.consistent = true;
    input.facts.onlineHandoff.valid = false;
    expect(decide(input).reason).toBe("online-handoff-invalid");
  });

  it("rejects a cryptographically altered bundle before evaluating trust policy", async () => {
    const input = await fixture();
    input.bundle.signature =
      (input.bundle.signature.startsWith("A") ? "B" : "A") +
      input.bundle.signature.slice(1);

    expect(decide(input)).toMatchObject({ decision: "reject", reason: "bundle-invalid" });
  });
});

describe("FederatedAdmissionPolicyStore", () => {
  it("publishes immutable chained generations and preserves historical bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "airlock-policy-"));
    temporaryDirectories.push(root);
    const store = new FederatedAdmissionPolicyStore(root);
    await store.initialize();
    const first = (await fixture()).policy;
    const installedFirst = await store.installAndActivate(first);

    expect(await store.readActive()).toEqual(installedFirst);
    expect(await store.installAndActivate(first)).toEqual(installedFirst);

    const second = structuredClone(first);
    second.generation = 2;
    second.priorPolicyDigest = installedFirst.policyDigest;
    second.activatedAt = "2026-08-27T00:00:00.000Z";
    second.producers[0]!.requireLocalApproval = true;
    const installedSecond = await store.installAndActivate(second);

    expect((await store.readActive()).policy.generation).toBe(2);
    expect(
      await store.readGeneration(first.policyId, 1, installedFirst.policyDigest),
    ).toEqual(first);
    expect(installedSecond.policyDigest).not.toBe(installedFirst.policyDigest);
  });

  it("rejects gaps, identity changes, malformed pointers, and tampered history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "airlock-policy-"));
    temporaryDirectories.push(root);
    const store = new FederatedAdmissionPolicyStore(root);
    await store.initialize();
    const first = (await fixture()).policy;
    const installed = await store.installAndActivate(first);

    const gap = structuredClone(first);
    gap.generation = 3;
    gap.priorPolicyDigest = installed.policyDigest;
    await expect(store.installAndActivate(gap)).rejects.toThrow(/extend/);

    const changedIdentity = structuredClone(first);
    changedIdentity.generation = 2;
    changedIdentity.priorPolicyDigest = installed.policyDigest;
    changedIdentity.policyId = "different-policy";
    await expect(store.installAndActivate(changedIdentity)).rejects.toThrow(/extend/);

    await writeFile(path.join(root, "active.json"), "{}\n", "utf8");
    await expect(store.readActive()).rejects.toThrow(/pointer/);

    const policyDirectory = path.join(root, "policies", first.policyId);
    const [fileName] = await readdir(policyDirectory);
    await writeFile(
      path.join(policyDirectory, fileName!),
      canonicalize({ ...first, activatedAt: "2026-08-24T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    await expect(
      store.readGeneration(first.policyId, 1, installed.policyDigest),
    ).rejects.toThrow(/contradict/);
  });

  it("requires generation one for a fresh store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "airlock-policy-"));
    temporaryDirectories.push(root);
    const store = new FederatedAdmissionPolicyStore(root);
    await store.initialize();
    const policy = (await fixture()).policy;
    policy.generation = 2;
    policy.priorPolicyDigest = sha256Digest("prior") as ReceiptDigest;

    await expect(store.installAndActivate(policy)).rejects.toThrow(/generation 1/);
  });
});
