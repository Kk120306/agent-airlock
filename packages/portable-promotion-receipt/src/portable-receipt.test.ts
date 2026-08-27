import {
  chmod,
  mkdtemp,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  digestPortableReceipt,
  generatePortableSigningKey,
  signPortableReceipt,
} from "./crypto.js";
import { buildEvidenceCommitment } from "./merkle.js";
import {
  loadOrCreatePortableSigningKey,
  loadPortableSigningKey,
  writeNewPortableSigningKey,
} from "./signing-key.js";
import type {
  PortableEvidenceLeaf,
  PortablePromotionEnvelope,
  PortablePromotionReceipt,
  ReceiptDigest,
} from "./types.js";
import { verifyPortablePromotionEnvelope } from "./verifier.js";

describe("Portable Promotion Receipt signing and verification", () => {
  it("verifies a signed receipt with selective disclosure offline", () => {
    const fixture = createFixture();
    const key = generatePortableSigningKey();
    const envelope = signPortableReceipt({
      receipt: fixture.receipt,
      privateKey: key.privateKeyPem,
      disclosures: [fixture.disclosures[1]!],
    });
    const report = verifyPortablePromotionEnvelope(envelope);
    expect(report.valid).toBe(true);
    expect(report.receiptDigest).toBe(digestPortableReceipt(fixture.receipt));
    expect(report.disclosures).toEqual([
      expect.objectContaining({ identity: "validation:secret-scan", valid: true }),
    ]);
    expect(JSON.stringify(envelope)).not.toContain("raw command output");
  });

  it("rejects one-bit content, digest, signature, key, proof, and algorithm changes", () => {
    const fixture = createFixture();
    const firstKey = generatePortableSigningKey();
    const secondKey = generatePortableSigningKey();
    const envelope = signPortableReceipt({
      receipt: fixture.receipt,
      privateKey: firstKey.privateKeyPem,
      disclosures: [fixture.disclosures[0]!],
    });
    const mutations: PortablePromotionEnvelope[] = [];

    const content = structuredClone(envelope);
    content.receipt.decision.agentId = "agent-b";
    mutations.push(content);

    const digest = structuredClone(envelope);
    digest.receiptDigest = flipDigest(digest.receiptDigest);
    mutations.push(digest);

    const signature = structuredClone(envelope);
    signature.signature = flipBase64Url(signature.signature);
    mutations.push(signature);

    const key = structuredClone(envelope);
    key.publicJwk = secondKey.publicJwk;
    key.keyId = secondKey.keyId;
    mutations.push(key);

    const proof = structuredClone(envelope);
    proof.disclosures[0]!.siblings[0]!.direction =
      proof.disclosures[0]!.siblings[0]!.direction === "left" ? "right" : "left";
    mutations.push(proof);

    const algorithm = structuredClone(envelope) as unknown as Record<string, unknown>;
    algorithm.signatureAlgorithm = "ECDSA";
    mutations.push(algorithm as unknown as PortablePromotionEnvelope);

    for (const mutated of mutations) {
      const report = verifyPortablePromotionEnvelope(mutated);
      expect(report.valid).toBe(false);
      expect(report.provenClaims).toEqual([]);
    }
  });

  it.each([
    "token=syntheticcredential123456",
    "cookie=sessioncredential123456",
    "ghp_1234567890abcdefghijklmnop",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature123",
    "https://operator:syntheticcredential123456@example.test/path",
  ])("refuses credential-bearing signed evidence: %s", (credential) => {
    const fixture = createFixture();
    fixture.disclosures[0]!.leaf.summary = credential;
    const key = generatePortableSigningKey();
    expect(() =>
      signPortableReceipt({
        receipt: fixture.receipt,
        privateKey: key.privateKeyPem,
        disclosures: [fixture.disclosures[0]!],
      }),
    ).toThrow(/credential-like/);
  });

  it("preserves historical verification across signing-key rotation", () => {
    const fixture = createFixture();
    const oldKey = generatePortableSigningKey();
    const newKey = generatePortableSigningKey();
    const historical = signPortableReceipt({
      receipt: fixture.receipt,
      privateKey: oldKey.privateKeyPem,
    });
    const current = signPortableReceipt({
      receipt: fixture.receipt,
      privateKey: newKey.privateKeyPem,
    });
    expect(historical.receiptDigest).toBe(current.receiptDigest);
    expect(historical.keyId).not.toBe(current.keyId);
    expect(verifyPortablePromotionEnvelope(historical).valid).toBe(true);
    expect(verifyPortablePromotionEnvelope(current).valid).toBe(true);
  });

  it("stores private keys only in owner-readable regular files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "airlock-portable-key-"));
    const keyPath = path.join(directory, "signing.pem");
    const generated = await writeNewPortableSigningKey(keyPath);
    expect((await loadPortableSigningKey(keyPath)).keyId).toBe(generated.keyId);
    expect(await readFile(keyPath, "utf8")).toContain("PRIVATE KEY");

    if (process.platform !== "win32") {
      await chmod(directory, 0o755);
      await expect(loadPortableSigningKey(keyPath)).rejects.toThrow(
        /parent permissions must not allow group or world access/,
      );
      await chmod(directory, 0o700);
      await chmod(keyPath, 0o640);
      await expect(loadPortableSigningKey(keyPath)).rejects.toThrow(
        /group or world access/,
      );
      await chmod(keyPath, 0o600);
      await writeFile(path.join(directory, "target.pem"), generated.privateKeyPem, {
        mode: 0o600,
      });
      await symlink(path.join(directory, "target.pem"), path.join(directory, "link.pem"));
      await expect(loadPortableSigningKey(path.join(directory, "link.pem"))).rejects.toThrow(
        /regular non-symbolic-link/,
      );
    }
  });

  it("fails closed when a durable signing identity loses or changes its private key", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "airlock-key-identity-"));
    const lostPath = path.join(directory, "lost.pem");
    await writeNewPortableSigningKey(lostPath);
    await unlink(lostPath);
    await expect(loadOrCreatePortableSigningKey(lostPath)).rejects.toThrow(
      /missing while its identity marker remains/,
    );

    const replacedPath = path.join(directory, "replaced.pem");
    await writeNewPortableSigningKey(replacedPath);
    const replacement = generatePortableSigningKey();
    await writeFile(replacedPath, replacement.privateKeyPem, { mode: 0o600 });
    await expect(loadOrCreatePortableSigningKey(replacedPath)).rejects.toThrow(
      /does not match its durable identity marker/,
    );
  });
});

function createFixture() {
  const leaves: PortableEvidenceLeaf[] = [
    {
      schemaVersion: 1,
      identity: "validation:required-paths",
      category: "validation",
      status: "passed",
      required: true,
      durationMs: 3,
      summary: "Required public artifacts are present.",
      valueHash: digest("required-paths-value"),
    },
    {
      schemaVersion: 1,
      identity: "validation:secret-scan",
      category: "validation",
      status: "passed",
      required: true,
      durationMs: 7,
      summary: "No catalog secret detector matched.",
      valueHash: digest("secret-scan-value"),
    },
  ];
  const evidence = buildEvidenceCommitment(leaves);
  const receipt: PortablePromotionReceipt = {
    protocol: {
      schema: "agent-airlock/portable-promotion-receipt",
      schemaVersion: 1,
      canonicalization: "RFC8785",
      digestAlgorithm: "SHA-256",
    },
    decision: {
      runId: "run-a",
      agentId: "agent-a",
      disposition: "promoted",
      decidedAt: "2026-08-26T00:00:00.000Z",
      clockClaim: "signer-clock-not-external-timestamp",
    },
    state: {
      before: {
        stateId: "state-before",
        compositeHash: digest("state-before"),
        builtinResources: [
          { kind: "workspace", fingerprint: digest("workspace-before") },
        ],
        providerResources: [],
      },
      after: {
        stateId: "state-after",
        compositeHash: digest("state-after"),
        builtinResources: [
          { kind: "workspace", fingerprint: digest("workspace-after") },
        ],
        providerResources: [],
      },
    },
    outcomeContract: {
      schemaVersion: 1,
      version: 2,
      digest: digest("contract"),
    },
    validationEvidence: {
      root: evidence.root,
      leafCount: evidence.leaves.length,
      ordering: "canonical-identity-ascending",
    },
    externalActions: {
      commitment: digest("actions"),
      deliveredCount: 1,
    },
    selection: {
      candidateSetId: "candidate-set-a",
      decisionDigest: digest("selection"),
    },
    assurance: {
      proposalId: "proposal-a",
      contractVersion: 2,
    },
    ancestry: {
      rootRunId: "run-a",
      parentRunId: null,
      depth: 0,
      maxDepth: 3,
      previousReceiptDigest: null,
    },
  };
  return { receipt, disclosures: evidence.disclosures };
}

function digest(value: string): ReceiptDigest {
  const hex = Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
  return `sha256:${hex}`;
}

function flipDigest(value: ReceiptDigest): ReceiptDigest {
  const final = value.at(-1) === "0" ? "1" : "0";
  return `${value.slice(0, -1)}${final}` as ReceiptDigest;
}

function flipBase64Url(value: string): string {
  const first = value[0] === "A" ? "B" : "A";
  return `${first}${value.slice(1)}`;
}
