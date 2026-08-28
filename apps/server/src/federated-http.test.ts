import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFederatedWorkBundle,
  buildWorkspaceChangeSetEnvelope,
  generatePortableSigningKey,
  sha256Digest,
  signPortableReceipt,
  signSigningKeyTrustPolicy,
  type PortablePromotionEnvelope,
  type SigningKeyTrustPolicy,
} from "@agent-airlock/portable-promotion-receipt";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { PromotionFaultInjector } from "./airlock-runner.js";
import {
  FEDERATED_WORKSPACE_ARTIFACT_MEDIA_TYPE,
  FEDERATED_WORKSPACE_ARTIFACT_SCHEMA,
  type FederatedAdmissionPolicy,
} from "./federated-admission-policy.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("federated HTTP execution", () => {
  it("admits, validates, and promotes remote work through receiver-owned authority", async () => {
    const fixture = await createFixture();
    const before = await fixture.workspaces.readCanonical(fixture.agentId);

    const policyResponse = await fixture.app.inject({
      method: "POST",
      url: "/api/federation/policies",
      payload: fixture.policy,
    });
    expect(policyResponse.statusCode).toBe(201);

    const imported = await fixture.app.inject({
      method: "POST",
      url: `/api/agents/${fixture.agentId}/federated-imports`,
      payload: {
        transferId: "transfer-winning-demo",
        producerId: "producer-one",
        bundle: fixture.bundle,
        trustPolicy: fixture.trustPolicy,
      },
    });

    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({
      admission: {
        decision: { decision: "admit", reason: "admitted" },
        producerId: "producer-one",
      },
      run: {
        status: "completed",
        transaction: { status: "promoted", disposition: "promoted" },
      },
    });
    expect(fixture.modelCalls()).toBe(0);
    const after = await fixture.workspaces.readCanonical(fixture.agentId);
    expect(after.stateId).not.toBe(before.stateId);
    await expect(readFile(path.join(after.workspacePath, "federated.txt"), "utf8"))
      .resolves.toBe("federated work\n");

    const replay = await fixture.app.inject({
      method: "POST",
      url: `/api/agents/${fixture.agentId}/federated-imports`,
      payload: {
        transferId: "transfer-winning-demo",
        producerId: "producer-one",
        bundle: fixture.bundle,
        trustPolicy: fixture.trustPolicy,
      },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().admission.recordDigest).toBe(
      imported.json().admission.recordDigest,
    );
    expect(replay.json().run.id).toBe(imported.json().run.id);
    expect(fixture.service.getRuns(fixture.agentId)).toHaveLength(1);
    await fixture.app.close();
  });

  it("rejects an unpinned trust authority without creating Candidate or changing Canonical", async () => {
    const fixture = await createFixture();
    await fixture.service.installFederatedAdmissionPolicy(fixture.policy);
    const before = await fixture.workspaces.readCanonical(fixture.agentId);
    const otherAuthority = generatePortableSigningKey();
    const untrustedPolicy = signSigningKeyTrustPolicy({
      policy: fixture.trustPolicy.policy,
      privateKey: otherAuthority.privateKeyPem,
    });

    const rejected = await fixture.app.inject({
      method: "POST",
      url: `/api/agents/${fixture.agentId}/federated-imports`,
      payload: {
        transferId: "transfer-untrusted",
        producerId: "producer-one",
        bundle: fixture.bundle,
        trustPolicy: untrustedPolicy,
      },
    });

    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      admission: {
        decision: { decision: "reject", reason: "authority-unpinned" },
      },
      run: null,
    });
    expect(await fixture.workspaces.readCanonical(fixture.agentId)).toEqual(before);
    expect(fixture.service.getRuns(fixture.agentId)).toHaveLength(0);
    await fixture.app.close();
  });

  it("quarantines admitted work that fails the receiver Outcome Contract", async () => {
    const fixture = await createFixture();
    await fixture.service.installFederatedAdmissionPolicy(fixture.policy);
    const before = await fixture.workspaces.readCanonical(fixture.agentId);
    const protectedContent = await readFile(
      path.join(before.workspacePath, "AGENTS.md"),
    );
    const artifact = buildWorkspaceChangeSetEnvelope({
      baseStateDigest: fixture.receipt.receipt.state.before.compositeHash,
      resultStateDigest: fixture.receipt.receipt.state.after.compositeHash,
      operations: [
        {
          operation: "delete",
          path: "AGENTS.md",
          priorContentDigest: sha256Digest(protectedContent),
        },
      ],
    });
    const unsafeBundle = buildFederatedWorkBundle({
      receipt: fixture.receipt,
      artifact,
      privateKey: fixture.receiptPrivateKey,
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/agents/${fixture.agentId}/federated-imports`,
      payload: {
        transferId: "transfer-fails-local-contract",
        producerId: "producer-one",
        bundle: unsafeBundle,
        trustPolicy: fixture.trustPolicy,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      admission: { decision: { decision: "admit" } },
      run: {
        status: "completed",
        transaction: {
          status: "quarantined",
          disposition: "quarantined",
          quarantineAvailable: true,
        },
      },
    });
    expect(await fixture.workspaces.readCanonical(fixture.agentId)).toEqual(before);
    expect(response.json().run.transaction.validations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "protected-paths",
          status: "failed",
          required: true,
        }),
      ]),
    );
    await fixture.app.close();
  });

  it("recovers an interrupted federated Promotion only with matching Admission authority", async () => {
    let interrupted = false;
    const fixture = await createFixture({
      promotionFaultInjector: (point) => {
        if (point === "after-validated" && !interrupted) {
          interrupted = true;
          throw new Error("simulated receiver restart");
        }
      },
    });
    await fixture.service.installFederatedAdmissionPolicy(fixture.policy);
    const before = await fixture.workspaces.readCanonical(fixture.agentId);

    const failed = await fixture.app.inject({
      method: "POST",
      url: `/api/agents/${fixture.agentId}/federated-imports`,
      payload: {
        transferId: "transfer-recovery",
        producerId: "producer-one",
        bundle: fixture.bundle,
        trustPolicy: fixture.trustPolicy,
      },
    });
    expect(failed.statusCode).toBe(500);
    expect(await fixture.workspaces.readCanonical(fixture.agentId)).toEqual(before);
    const failedRun = fixture.service.getRuns(fixture.agentId)[0];
    expect(failedRun).toMatchObject({
      status: "failed",
      transaction: {
        status: "promoting",
        recovery: { journalPhase: "validated" },
      },
    });
    await fixture.app.close();

    const recoveredWorkspaces = new WorkspaceManager(
      fixture.config.workspaceRoot,
      fixture.config.codexHome,
    );
    const recoveredService = new AgentService(
      fixture.config,
      new JsonStore(path.join(fixture.config.dataDirectory, "launchpad.json")),
      recoveredWorkspaces,
      fixture.runner,
    );
    await recoveredService.initialize();

    const recovered = recoveredService.getRun(failedRun!.id);
    expect(recovered).toMatchObject({
      status: "completed",
      transaction: {
        status: "promoted",
        disposition: "promoted",
        recovery: { recoveredAfterRestart: true, journalPhase: "completed" },
      },
    });
    const after = await recoveredWorkspaces.readCanonical(fixture.agentId);
    await expect(readFile(path.join(after.workspacePath, "federated.txt"), "utf8"))
      .resolves.toBe("federated work\n");
  });
});

async function createFixture(
  options: { promotionFaultInjector?: PromotionFaultInjector } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-federated-http-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
  });
  let calls = 0;
  const runner: AgentRunner = {
    run: async () => {
      calls += 1;
      throw new Error("Federated import must not invoke the model Runtime");
    },
    cancel: async () => false,
    isAvailable: async () => true,
  };
  const workspaces = new WorkspaceManager(config.workspaceRoot, config.codexHome);
  const service = new AgentService(
    config,
    new JsonStore(path.join(config.dataDirectory, "launchpad.json")),
    workspaces,
    runner,
    undefined,
    options.promotionFaultInjector,
  );
  await service.initialize();
  const agent = await service.createAgent({ name: "Federated Receiver" });
  const app = await createApp(config, service);

  const source = await readFile(
    new URL(
      "../../../packages/portable-promotion-receipt/vectors/portable-receipt-v1.golden.json",
      import.meta.url,
    ),
    "utf8",
  );
  const template = (JSON.parse(source) as { envelope: PortablePromotionEnvelope })
    .envelope;
  const receiptKey = generatePortableSigningKey();
  const receipt = signPortableReceipt({
    receipt: template.receipt,
    privateKey: receiptKey.privateKeyPem,
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
    privateKey: receiptKey.privateKeyPem,
  });
  const authority = generatePortableSigningKey();
  const trustPolicyBody: SigningKeyTrustPolicy = {
    schema: "agent-airlock/signing-key-trust-policy",
    schemaVersion: 1,
    policyId: "producer-one-signers",
    issuedAt: "2026-08-25T00:00:00.000Z",
    expiresAt: null,
    keys: [
      {
        keyId: receipt.keyId,
        status: "active",
        validFrom: "2026-08-25T00:00:00.000Z",
        validUntil: null,
        agentIds: [receipt.receipt.decision.agentId],
        dispositions: [receipt.receipt.decision.disposition],
        note: "TechJam federation producer",
      },
    ],
  };
  const trustPolicy = signSigningKeyTrustPolicy({
    policy: trustPolicyBody,
    privateKey: authority.privateKeyPem,
  });
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
        authorityKeyIds: [trustPolicy.authorityKeyId],
        receiptSigners: [
          {
            keyId: receipt.keyId,
            status: "active",
            validFrom: "2026-08-25T00:00:00.000Z",
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
          maximumReceiptAgeSeconds: 604_800,
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
        requireLocalApproval: false,
      },
    ],
  };
  return {
    app,
    config,
    runner,
    service,
    workspaces,
    agentId: agent.id,
    bundle,
    receipt,
    receiptPrivateKey: receiptKey.privateKeyPem,
    trustPolicy,
    policy,
    modelCalls: () => calls,
  };
}
