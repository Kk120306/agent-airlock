import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFederatedWorkBundle,
  buildWorkspaceChangeSetEnvelope,
  generatePortableSigningKey,
  sha256Digest,
  signPortableReceipt,
  signSigningKeyTrustPolicy,
  verifyFederatedWorkBundle,
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
  it("exports a real promoted Run as a self-verifying Federated Work Bundle", async () => {
    const fixture = await createFixture({ allowProducerRun: true });
    const started = await fixture.app.inject({
      method: "POST",
      url: `/api/agents/${fixture.agentId}/messages`,
      payload: { content: "Prepare the bounded producer change." },
    });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id as string;
    await waitForCompletedRun(fixture.service, runId);

    const exported = await fixture.app.inject({
      method: "POST",
      url: `/api/runs/${runId}/federated-work-bundle`,
    });

    expect(exported.statusCode).toBe(200);
    const body = exported.json();
    expect(body.verification.valid).toBe(true);
    expect(verifyFederatedWorkBundle(body.bundle).valid).toBe(true);
    expect(body.bundle.artifact.artifact.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "add",
          path: "producer-release.txt",
        }),
      ]),
    );
    expect(fixture.modelCalls()).toBe(1);
    await fixture.app.close();
  });

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

  it("resumes approval-required work through immutable local operator authority", async () => {
    const fixture = await createFixture();
    fixture.policy.producers[0]!.requireLocalApproval = true;
    await fixture.service.installFederatedAdmissionPolicy(fixture.policy);
    const before = await fixture.workspaces.readCanonical(fixture.agentId);

    const imported = await fixture.app.inject({
      method: "POST",
      url: `/api/agents/${fixture.agentId}/federated-imports`,
      payload: {
        transferId: "transfer-needs-approval",
        producerId: "producer-one",
        bundle: fixture.bundle,
        trustPolicy: fixture.trustPolicy,
      },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({
      admission: {
        decision: { decision: "pending", reason: "approval-required" },
      },
      run: null,
    });
    expect(await fixture.workspaces.readCanonical(fixture.agentId)).toEqual(before);

    const approved = await fixture.app.inject({
      method: "POST",
      url:
        "/api/federation/admissions/" +
        imported.json().admission.admissionId +
        "/decision",
      payload: { choice: "approve", reason: "Verified producer evidence" },
    });
    expect(approved.statusCode).toBe(201);
    expect(approved.json()).toMatchObject({
      approval: {
        choice: "approve",
        operatorId: "local-control-plane",
      },
      run: {
        status: "completed",
        transaction: { status: "promoted", disposition: "promoted" },
      },
    });
    const after = await fixture.workspaces.readCanonical(fixture.agentId);
    expect(after.stateId).not.toBe(before.stateId);
    await expect(readFile(path.join(after.workspacePath, "federated.txt"), "utf8"))
      .resolves.toBe("federated work\n");

    const replay = await fixture.app.inject({
      method: "POST",
      url:
        "/api/federation/admissions/" +
        imported.json().admission.admissionId +
        "/decision",
      payload: { choice: "approve", reason: "Verified producer evidence" },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().approval.recordDigest).toBe(
      approved.json().approval.recordDigest,
    );
    expect(fixture.service.getRuns(fixture.agentId)).toHaveLength(1);
    await fixture.app.close();
  });

  it("keeps a bounded approval inbox actionable across a service restart", async () => {
    const fixture = await createFixture();
    fixture.policy.producers[0]!.requireLocalApproval = true;
    await fixture.service.installFederatedAdmissionPolicy(fixture.policy);
    const imported = await fixture.app.inject({
      method: "POST",
      url: `/api/agents/${fixture.agentId}/federated-imports`,
      payload: {
        transferId: "transfer-inbox-restart",
        producerId: "producer-one",
        bundle: fixture.bundle,
        trustPolicy: fixture.trustPolicy,
      },
    });
    expect(imported.statusCode).toBe(200);

    const beforeRestart = await fixture.app.inject({
      method: "GET",
      url: `/api/agents/${fixture.agentId}/federated-admissions`,
    });
    expect(beforeRestart.statusCode).toBe(200);
    expect(beforeRestart.json()).toMatchObject({
      admissions: [
        {
          state: "pending",
          admission: { transferId: "transfer-inbox-restart" },
          approval: null,
          run: null,
        },
      ],
    });
    expect(beforeRestart.body).not.toContain("federated work");
    expect(beforeRestart.body).not.toContain("privateKey");
    const otherAgent = await fixture.service.createAgent({ name: "Other Receiver" });
    const otherInbox = await fixture.app.inject({
      method: "GET",
      url: `/api/agents/${otherAgent.id}/federated-admissions?limit=1`,
    });
    expect(otherInbox.json()).toEqual({ admissions: [] });
    const invalidLimit = await fixture.app.inject({
      method: "GET",
      url: `/api/agents/${fixture.agentId}/federated-admissions?limit=101`,
    });
    expect(invalidLimit.statusCode).toBe(400);
    await fixture.app.close();

    const restartedWorkspaces = new WorkspaceManager(
      fixture.config.workspaceRoot,
      fixture.config.codexHome,
    );
    const restartedService = new AgentService(
      fixture.config,
      new JsonStore(path.join(fixture.config.dataDirectory, "launchpad.json")),
      restartedWorkspaces,
      fixture.runner,
    );
    await restartedService.initialize();
    const restartedApp = await createApp(fixture.config, restartedService);
    const afterRestart = await restartedApp.inject({
      method: "GET",
      url: `/api/agents/${fixture.agentId}/federated-admissions`,
    });
    expect(afterRestart.json().admissions[0]).toMatchObject({
      state: "pending",
      admission: {
        admissionId: imported.json().admission.admissionId,
        recordDigest: imported.json().admission.recordDigest,
      },
    });

    const approved = await restartedApp.inject({
      method: "POST",
      url:
        "/api/federation/admissions/" +
        imported.json().admission.admissionId +
        "/decision",
      payload: { choice: "approve", reason: "Reviewed after operator handoff" },
    });
    expect(approved.statusCode).toBe(201);
    const terminal = await restartedApp.inject({
      method: "GET",
      url: `/api/agents/${fixture.agentId}/federated-admissions`,
    });
    expect(terminal.json().admissions[0]).toMatchObject({
      state: "promoted",
      approval: { choice: "approve", reason: "Reviewed after operator handoff" },
      run: { status: "completed", disposition: "promoted" },
    });
    await restartedApp.close();
  });

  it("denies approval-required work without creating a Run or changing Canonical", async () => {
    const fixture = await createFixture();
    fixture.policy.producers[0]!.requireLocalApproval = true;
    await fixture.service.installFederatedAdmissionPolicy(fixture.policy);
    const before = await fixture.workspaces.readCanonical(fixture.agentId);
    const imported = await fixture.app.inject({
      method: "POST",
      url: `/api/agents/${fixture.agentId}/federated-imports`,
      payload: {
        transferId: "transfer-denied-locally",
        producerId: "producer-one",
        bundle: fixture.bundle,
        trustPolicy: fixture.trustPolicy,
      },
    });

    const denied = await fixture.app.inject({
      method: "POST",
      url:
        "/api/federation/admissions/" +
        imported.json().admission.admissionId +
        "/decision",
      payload: { choice: "deny", reason: "Unexpected release scope" },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({
      approval: { choice: "deny", operatorId: "local-control-plane" },
      run: null,
    });
    expect(fixture.service.getRuns(fixture.agentId)).toHaveLength(0);
    expect(await fixture.workspaces.readCanonical(fixture.agentId)).toEqual(before);
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

  it("recovers approved Promotion only with both pending Admission and operator decision", async () => {
    let interrupted = false;
    const fixture = await createFixture({
      promotionFaultInjector: (point) => {
        if (point === "after-validated" && !interrupted) {
          interrupted = true;
          throw new Error("simulated approved receiver restart");
        }
      },
    });
    fixture.policy.producers[0]!.requireLocalApproval = true;
    await fixture.service.installFederatedAdmissionPolicy(fixture.policy);
    const before = await fixture.workspaces.readCanonical(fixture.agentId);
    const imported = await fixture.app.inject({
      method: "POST",
      url: `/api/agents/${fixture.agentId}/federated-imports`,
      payload: {
        transferId: "transfer-approved-recovery",
        producerId: "producer-one",
        bundle: fixture.bundle,
        trustPolicy: fixture.trustPolicy,
      },
    });
    expect(imported.statusCode).toBe(200);

    const failed = await fixture.app.inject({
      method: "POST",
      url:
        "/api/federation/admissions/" +
        imported.json().admission.admissionId +
        "/decision",
      payload: { choice: "approve", reason: "Recovery authority reviewed" },
    });
    expect(failed.statusCode).toBe(500);
    expect(await fixture.workspaces.readCanonical(fixture.agentId)).toEqual(before);
    const failedRun = fixture.service.getRuns(fixture.agentId)[0]!;
    expect(failedRun).toMatchObject({
      transaction: { recovery: { journalPhase: "validated" } },
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

    expect(recoveredService.getRun(failedRun.id)).toMatchObject({
      status: "completed",
      transaction: {
        status: "promoted",
        disposition: "promoted",
        recovery: { recoveredAfterRestart: true, journalPhase: "completed" },
      },
    });
    const after = await recoveredWorkspaces.readCanonical(fixture.agentId);
    expect(after.stateId).not.toBe(before.stateId);
  });
});

async function createFixture(
  options: {
    promotionFaultInjector?: PromotionFaultInjector;
    allowProducerRun?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-federated-http-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ...(options.allowProducerRun
      ? { ARK_API_KEY: "test-key", ARK_MODEL: "ep-test" }
      : {}),
  });
  let calls = 0;
  const runner: AgentRunner = {
    run: async (request) => {
      calls += 1;
      if (options.allowProducerRun) {
        await writeFile(
          path.join(request.workspacePath, "producer-release.txt"),
          "portable producer work\n",
        );
        return {
          output: "Producer Candidate completed.",
          threadId: request.threadId,
          usage: { inputTokens: 4, outputTokens: 3 },
        };
      }
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

async function waitForCompletedRun(
  service: AgentService,
  runId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = service.getRun(runId);
    if (run.status === "completed") return;
    if (run.status === "failed" || run.status === "cancelled") {
      throw new Error(run.error ?? "Producer Run did not complete");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Producer Run did not complete before the test deadline");
}
