import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generatePortableSigningKey, sha256Digest, signPortableReceipt } from "./crypto.js";
import {
  buildFederatedWorkBundle,
  parseFederatedWorkBundleJson,
  verifyFederatedWorkBundle,
  verifyFederatedWorkBundleJson,
} from "./federated-work-bundle.js";
import type { PortablePromotionEnvelope } from "./types.js";
import {
  buildWorkspaceChangeSetEnvelope,
  type WorkspaceWriteOperation,
} from "./workspace-change-set.js";

async function fixture() {
  const source = await readFile(
    new URL("../vectors/portable-receipt-v1.golden.json", import.meta.url),
    "utf8",
  );
  const template = (JSON.parse(source) as { envelope: PortablePromotionEnvelope }).envelope;
  const key = generatePortableSigningKey();
  const receipt = signPortableReceipt({
    receipt: template.receipt,
    privateKey: key.privateKeyPem,
  });
  const content = Buffer.from("federated work\n", "utf8");
  const operation: WorkspaceWriteOperation = {
    operation: "add",
    path: "federated.txt",
    mediaType: "text/plain",
    encoding: "base64url",
    content: content.toString("base64url"),
    contentDigest: sha256Digest(content),
    byteLength: content.length,
    priorContentDigest: null,
  };
  const artifact = buildWorkspaceChangeSetEnvelope({
    baseStateDigest: receipt.receipt.state.before.compositeHash,
    resultStateDigest: receipt.receipt.state.after.compositeHash,
    operations: [operation],
  });
  return {
    key,
    receipt,
    artifact,
    bundle: buildFederatedWorkBundle({
      receipt,
      artifact,
      privateKey: key.privateKeyPem,
    }),
  };
}

describe("federated work bundle", () => {
  it("binds one exact artifact and protocol version to the signed receipt key", async () => {
    const { bundle } = await fixture();
    const report = verifyFederatedWorkBundleJson(JSON.stringify(bundle));

    expect(report.valid).toBe(true);
    expect(report.receiptDigest).toBe(bundle.receipt.receiptDigest);
    expect(report.artifactDigest).toBe(bundle.artifact.artifactDigest);
    expect(report.checks.map((check) => check.name)).toEqual([
      "federated-bundle-schema",
      "federated-bundle-receipt",
      "federated-bundle-artifact",
      "federated-bundle-state",
      "federated-bundle-signature",
    ]);
    expect(parseFederatedWorkBundleJson(JSON.stringify(bundle))).toEqual(bundle);
  });

  it("rejects artifact substitution even when the replacement is internally valid", async () => {
    const { bundle, receipt } = await fixture();
    const replacementContent = Buffer.from("different work\n", "utf8");
    bundle.artifact = buildWorkspaceChangeSetEnvelope({
      baseStateDigest: receipt.receipt.state.before.compositeHash,
      resultStateDigest: receipt.receipt.state.after.compositeHash,
      operations: [
        {
          operation: "add",
          path: "different.txt",
          mediaType: "text/plain",
          encoding: "base64url",
          content: replacementContent.toString("base64url"),
          contentDigest: sha256Digest(replacementContent),
          byteLength: replacementContent.length,
          priorContentDigest: null,
        },
      ],
    });

    expect(verifyFederatedWorkBundle(bundle).valid).toBe(false);
  });

  it("rejects wrong-state artifacts, a different signer, and altered binding signatures", async () => {
    const { key, receipt, artifact, bundle } = await fixture();
    const wrongStateArtifact = buildWorkspaceChangeSetEnvelope({
      baseStateDigest: sha256Digest("wrong-base"),
      resultStateDigest: receipt.receipt.state.after.compositeHash,
      operations: artifact.artifact.operations,
    });
    expect(() => buildFederatedWorkBundle({
      receipt,
      artifact: wrongStateArtifact,
      privateKey: key.privateKeyPem,
    })).toThrow();

    const otherKey = generatePortableSigningKey();
    expect(() => buildFederatedWorkBundle({
      receipt,
      artifact,
      privateKey: otherKey.privateKeyPem,
    })).toThrow(/does not match/);

    bundle.signature = (bundle.signature.startsWith("A") ? "B" : "A") + bundle.signature.slice(1);
    expect(verifyFederatedWorkBundle(bundle).valid).toBe(false);
  });

  it("rejects unknown and duplicate JSON fields before cryptographic evaluation", async () => {
    const { bundle } = await fixture();
    (bundle as unknown as Record<string, unknown>).trusted = true;
    expect(verifyFederatedWorkBundleJson(JSON.stringify(bundle)).valid).toBe(false);

    const source = JSON.stringify((await fixture()).bundle);
    expect(verifyFederatedWorkBundleJson(
      source.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    ).valid).toBe(false);
  });
});
