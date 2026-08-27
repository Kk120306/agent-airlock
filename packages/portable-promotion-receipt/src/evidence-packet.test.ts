import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generatePortableSigningKey } from "./crypto.js";
import {
  buildPortableEvidencePacket,
  verifyPortableEvidencePacket,
  verifyPortableEvidencePacketJson,
} from "./evidence-packet.js";
import { encodeOfflineEvmAnchorPayload } from "./evm.js";
import {
  createSignedTransparencyCheckpoint,
  createTransparencyInclusionProof,
} from "./transparency.js";
import type { PortableEvidencePacket, PortablePromotionEnvelope } from "./types.js";

async function fixture(): Promise<PortableEvidencePacket> {
  const source = await readFile(
    new URL("../vectors/portable-receipt-v1.golden.json", import.meta.url),
    "utf8",
  );
  const envelope = (JSON.parse(source) as { envelope: PortablePromotionEnvelope }).envelope;
  const key = generatePortableSigningKey();
  const checkpoint = createSignedTransparencyCheckpoint({
    receiptDigests: [envelope.receiptDigest],
    priorCheckpointDigest: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    privateKey: key.privateKeyPem,
  });
  return buildPortableEvidencePacket({
    envelope,
    anchor: {
      checkpoint,
      inclusionProof: createTransparencyInclusionProof([envelope.receiptDigest], 0),
    },
    evmPayload: encodeOfflineEvmAnchorPayload(envelope.receiptDigest),
  });
}

describe("portable evidence packet", () => {
  it("verifies every included proof against one signed receipt", async () => {
    const packet = await fixture();
    const report = verifyPortableEvidencePacketJson(JSON.stringify(packet));

    expect(report).toMatchObject({
      valid: true,
      anchor: { valid: true },
      evmPayload: { valid: true },
    });
    expect(report.checks.map((check) => check.name)).toEqual([
      "packet-schema",
      "packet-receipt",
      "packet-anchor",
      "packet-evm-payload",
    ]);
  });

  it("rejects cross-receipt proofs, altered calldata, and unknown fields", async () => {
    const wrongAnchor = structuredClone(await fixture());
    wrongAnchor.anchor!.inclusionProof.receiptDigest = `sha256:${"ab".repeat(32)}`;
    expect(verifyPortableEvidencePacket(wrongAnchor).valid).toBe(false);

    const wrongCalldata = structuredClone(await fixture());
    wrongCalldata.evmPayload!.calldata = `0xeecdf927${"cd".repeat(32)}`;
    expect(verifyPortableEvidencePacket(wrongCalldata).valid).toBe(false);

    const extra = structuredClone(await fixture()) as unknown as Record<string, unknown>;
    extra.trusted = true;
    expect(verifyPortableEvidencePacket(extra).valid).toBe(false);
  });

  it("keeps evaluator trust material outside the packet", async () => {
    const packet = await fixture();
    const source = JSON.stringify(packet);

    expect(source).not.toMatch(/trustPolicy|authorityRotation|privateKey|prompt|output/i);
  });
});
