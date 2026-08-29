import { Buffer } from "node:buffer";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFederatedWorkBundle,
  buildWorkspaceChangeSetEnvelope,
  generatePortableSigningKey,
  sha256Digest,
  signPortableReceipt,
  type FederatedWorkBundle,
  type PortablePromotionEnvelope,
  type WorkspaceChangeOperation,
} from "@agent-airlock/portable-promotion-receipt";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultOutcomeContract } from "./outcome-contract.js";
import type { Agent } from "./types.js";
import {
  WorkspaceManager,
  type FederatedCandidateProvenance,
} from "./workspace.js";
import { WorkspaceFederatedCandidateAdapter } from "./workspace-federated-candidate-adapter.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("WorkspaceFederatedCandidateAdapter", () => {
  it("exports an exact bounded artifact from immutable Canonical versions", async () => {
    const fixture = await createFixture();
    const before = await fixture.manager.readCanonical(fixture.agent.id);
    const exportRun = "export-federated-work";
    const candidate = await fixture.manager.prepareCandidate(
      fixture.agent.id,
      exportRun,
    );
    await Promise.all([
      writeFile(path.join(candidate.workspacePath, "modify.txt"), "modified for export\n"),
      writeFile(path.join(candidate.workspacePath, "added.txt"), "added for export\n"),
      rm(path.join(candidate.workspacePath, "delete.txt")),
    ]);
    const after = await fixture.manager.promoteCandidate(fixture.agent.id, exportRun);

    const artifact = await fixture.manager.buildFederatedWorkspaceArtifact({
      agentId: fixture.agent.id,
      beforeStateId: before.stateId,
      afterStateId: after.stateId,
      baseStateDigest: sha256Digest("whole-agent-before"),
      resultStateDigest: sha256Digest("whole-agent-after"),
    });

    expect(artifact.artifact.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "add", path: "added.txt" }),
        expect.objectContaining({ operation: "delete", path: "delete.txt" }),
        expect.objectContaining({ operation: "modify", path: "modify.txt" }),
      ]),
    );
    const modified = artifact.artifact.operations.find(
      (operation) => operation.operation === "modify" && operation.path === "modify.txt",
    );
    expect(modified).toMatchObject({
      priorContentDigest: sha256Digest("modify-before\n"),
      contentDigest: sha256Digest("modified for export\n"),
    });
    expect(artifact.artifact.baseStateDigest).toBe(
      sha256Digest("whole-agent-before"),
    );
    expect(artifact.artifact.resultStateDigest).toBe(
      sha256Digest("whole-agent-after"),
    );
  });

  it("applies add, modify, delete, and rename only inside an atomic Candidate", async () => {
    const fixture = await createFixture();
    const canonicalBefore = await fixture.manager.readCanonical(fixture.agent.id);
    const modifyBefore = Buffer.from("modify-before\n", "utf8");
    const deleteBefore = Buffer.from("delete-before\n", "utf8");
    const renameBefore = Buffer.from("rename-before\n", "utf8");
    const modifyAfter = Buffer.from("modify-after\n", "utf8");
    const added = Buffer.from("new nested file\n", "utf8");
    const operations: WorkspaceChangeOperation[] = [
      writeOperation("add", "nested/added.txt", added, null),
      {
        operation: "delete",
        path: "delete.txt",
        priorContentDigest: sha256Digest(deleteBefore),
      },
      writeOperation(
        "modify",
        "modify.txt",
        modifyAfter,
        sha256Digest(modifyBefore),
      ),
      {
        operation: "rename",
        fromPath: "rename.txt",
        toPath: "renamed/result.txt",
        contentDigest: sha256Digest(renameBefore),
      },
    ];
    const { bundle, provenance } = await bundleFixture(operations);
    const adapter = new WorkspaceFederatedCandidateAdapter(fixture.manager);

    const candidate = await adapter.prepare({
      agentId: fixture.agent.id,
      runId: "federated-admitted",
      bundle,
      provenance,
    });

    expect(await adapter.inspect({
      agentId: fixture.agent.id,
      runId: "federated-admitted",
      provenance,
    })).toEqual(candidate);
    const workspace = await fixture.manager.candidateWorkspacePath(
      "federated-admitted",
    );
    await expect(readFile(path.join(workspace, "nested/added.txt"), "utf8"))
      .resolves.toBe("new nested file\n");
    await expect(readFile(path.join(workspace, "modify.txt"), "utf8"))
      .resolves.toBe("modify-after\n");
    await expect(readFile(path.join(workspace, "renamed/result.txt"), "utf8"))
      .resolves.toBe("rename-before\n");
    await expect(readFile(path.join(workspace, "delete.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    expect(await fixture.manager.readCanonical(fixture.agent.id)).toEqual(
      canonicalBefore,
    );
    await expect(readFile(path.join(canonicalBefore.workspacePath, "modify.txt"), "utf8"))
      .resolves.toBe("modify-before\n");
    await expect(readFile(path.join(canonicalBefore.workspacePath, "delete.txt"), "utf8"))
      .resolves.toBe("delete-before\n");

    const promoted = await fixture.manager.promoteCandidate(
      fixture.agent.id,
      "federated-admitted",
    );
    expect(promoted.stateId).toBe(candidate.candidateStateId);
    await expect(readFile(path.join(promoted.workspacePath, "nested/added.txt"), "utf8"))
      .resolves.toBe("new nested file\n");
  });

  it("fails stale content preconditions without publishing Candidate or changing Canonical State", async () => {
    const fixture = await createFixture();
    const canonicalBefore = await fixture.manager.readCanonical(fixture.agent.id);
    const replacement = Buffer.from("unsafe replacement\n", "utf8");
    const operations: WorkspaceChangeOperation[] = [
      writeOperation(
        "modify",
        "modify.txt",
        replacement,
        sha256Digest("wrong prior bytes"),
      ),
    ];
    const { bundle, provenance } = await bundleFixture(operations);
    const adapter = new WorkspaceFederatedCandidateAdapter(fixture.manager);

    await expect(adapter.prepare({
      agentId: fixture.agent.id,
      runId: "federated-stale",
      bundle,
      provenance,
    })).rejects.toThrow(/content precondition failed/);

    await expect(adapter.inspect({
      agentId: fixture.agent.id,
      runId: "federated-stale",
      provenance,
    })).resolves.toBeNull();
    expect(await fixture.manager.readCanonical(fixture.agent.id)).toEqual(
      canonicalBefore,
    );
    await expect(
      readdir(path.join(fixture.root, ".federated-preparations")),
    ).resolves.toEqual([]);
  });

  it("rejects a symlink ancestor and removes only the hidden preparation", async () => {
    const fixture = await createFixture({ withSymlink: true });
    const outside = path.join(fixture.root, "outside");
    await mkdir(outside);
    const content = Buffer.from("must stay outside\n", "utf8");
    const { bundle, provenance } = await bundleFixture([
      writeOperation("add", "linked/escaped.txt", content, null),
    ]);
    const adapter = new WorkspaceFederatedCandidateAdapter(fixture.manager);

    await expect(adapter.prepare({
      agentId: fixture.agent.id,
      runId: "federated-symlink",
      bundle,
      provenance,
    })).rejects.toThrow(/safe directory/);

    await expect(readFile(path.join(outside, "escaped.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.inspect({
      agentId: fixture.agent.id,
      runId: "federated-symlink",
      provenance,
    })).resolves.toBeNull();
  });

  it("cleans an interrupted hidden preparation and rejects conflicting published provenance", async () => {
    const fixture = await createFixture();
    const runId = "federated-recovery";
    const interrupted = path.join(
      fixture.root,
      ".federated-preparations",
      runId,
    );
    await mkdir(interrupted);
    await writeFile(path.join(interrupted, "partial.txt"), "partial", "utf8");
    const content = Buffer.from("recovered\n", "utf8");
    const { bundle, provenance } = await bundleFixture([
      writeOperation("add", "recovered.txt", content, null),
    ]);
    const adapter = new WorkspaceFederatedCandidateAdapter(fixture.manager);

    const candidate = await adapter.prepare({
      agentId: fixture.agent.id,
      runId,
      bundle,
      provenance,
    });
    expect(candidate.candidateStateId).toBeTruthy();
    const conflicting = {
      ...provenance,
      policyDigest: sha256Digest("different policy"),
    };
    await expect(adapter.inspect({
      agentId: fixture.agent.id,
      runId,
      provenance: conflicting,
    })).rejects.toThrow(/contradicts federated admission authority/);
  });
});

async function createFixture(
  options: { withSymlink?: boolean } = {},
): Promise<{ root: string; manager: WorkspaceManager; agent: Agent }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-federated-workspace-"));
  temporaryDirectories.push(root);
  const manager = new WorkspaceManager(root);
  await manager.initialize();
  const agent = fixtureAgent();
  await manager.create(agent);
  const setupRun = "setup-canonical";
  const setup = await manager.prepareCandidate(agent.id, setupRun);
  await Promise.all([
    writeFile(path.join(setup.workspacePath, "modify.txt"), "modify-before\n", "utf8"),
    writeFile(path.join(setup.workspacePath, "delete.txt"), "delete-before\n", "utf8"),
    writeFile(path.join(setup.workspacePath, "rename.txt"), "rename-before\n", "utf8"),
  ]);
  if (options.withSymlink) {
    await symlink(path.join(root, "outside"), path.join(setup.workspacePath, "linked"));
  }
  await manager.promoteCandidate(agent.id, setupRun);
  return { root, manager, agent };
}

async function bundleFixture(
  operations: WorkspaceChangeOperation[],
): Promise<{
  bundle: FederatedWorkBundle;
  provenance: FederatedCandidateProvenance;
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
  const artifact = buildWorkspaceChangeSetEnvelope({
    baseStateDigest: receipt.receipt.state.before.compositeHash,
    resultStateDigest: receipt.receipt.state.after.compositeHash,
    operations,
  });
  const bundle = buildFederatedWorkBundle({
    receipt,
    artifact,
    privateKey: key.privateKeyPem,
  });
  return {
    bundle,
    provenance: {
      schemaVersion: 1,
      admissionId: sha256Digest("admission"),
      importIdentifier: sha256Digest("import"),
      producerId: "producer-one",
      receiptDigest: receipt.receiptDigest,
      artifactDigest: artifact.artifactDigest,
      policyId: "receiver-policy",
      policyGeneration: 1,
      policyDigest: sha256Digest("policy"),
    },
  };
}

function writeOperation(
  operation: "add" | "modify",
  targetPath: string,
  content: Buffer,
  priorContentDigest: ReturnType<typeof sha256Digest> | null,
) {
  return {
    operation,
    path: targetPath,
    mediaType: "text/plain",
    encoding: "base64url" as const,
    content: content.toString("base64url"),
    contentDigest: sha256Digest(content),
    byteLength: content.length,
    priorContentDigest,
  };
}

function fixtureAgent(): Agent {
  const timestamp = "2026-08-26T00:00:00.000Z";
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Federated workspace fixture",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "",
    canonicalStateId: "",
    outcomeContract: createDefaultOutcomeContract(1, timestamp),
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
