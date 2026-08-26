import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePortableSigningKey } from "./crypto.js";
import {
  createSignedTransparencyCheckpoint,
  createTransparencyConsistencyProof,
  createTransparencyEntry,
  createTransparencyInclusionProof,
  detectTransparencySplitView,
  verifySignedTransparencyCheckpoint,
  verifyTransparencyConsistency,
  verifyTransparencyEntries,
  verifyTransparencyInclusion,
  TransparencyRootAccumulator,
  transparencyRoot,
} from "./transparency.js";
import type { ReceiptDigest } from "./types.js";

describe("local transparency proofs", () => {
  it("verifies hash chaining, signed checkpoints, inclusion, and consistency", () => {
    const digests = [digest("a"), digest("b"), digest("c")];
    const entries: ReturnType<typeof createTransparencyEntry>[] = [];
    for (const [sequence, receiptDigest] of digests.entries()) {
      entries.push(
        createTransparencyEntry({
        receiptDigest,
        sequence,
          priorEntryHash: sequence === 0 ? null : entries[sequence - 1]!.entryHash,
        appendedAt: `2026-08-26T00:00:0${sequence}.000Z`,
        }),
      );
    }
    expect(verifyTransparencyEntries(entries)).toBe(true);

    const key = generatePortableSigningKey();
    const first = createSignedTransparencyCheckpoint({
      receiptDigests: digests.slice(0, 1),
      priorCheckpointDigest: null,
      createdAt: "2026-08-26T00:00:03.000Z",
      privateKey: key.privateKeyPem,
    });
    const current = createSignedTransparencyCheckpoint({
      receiptDigests: digests,
      priorCheckpointDigest: first.checkpointDigest,
      createdAt: "2026-08-26T00:00:04.000Z",
      privateKey: key.privateKeyPem,
    });
    expect(verifySignedTransparencyCheckpoint(first).valid).toBe(true);
    expect(verifySignedTransparencyCheckpoint(current).valid).toBe(true);
    expect(
      verifyTransparencyInclusion(
        createTransparencyInclusionProof(digests, 1),
        current.checkpoint,
      ),
    ).toBe(true);
    expect(
      verifyTransparencyConsistency({
        proof: createTransparencyConsistencyProof(digests, 1),
        from: first,
        to: current,
      }),
    ).toBe(true);
  });

  it("rejects a mathematically consistent proof across different log identities", () => {
    const digests = [digest("a"), digest("b")];
    const firstKey = generatePortableSigningKey();
    const secondKey = generatePortableSigningKey();
    const first = createSignedTransparencyCheckpoint({
      receiptDigests: digests.slice(0, 1),
      priorCheckpointDigest: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      privateKey: firstKey.privateKeyPem,
    });
    const current = createSignedTransparencyCheckpoint({
      receiptDigests: digests,
      priorCheckpointDigest: first.checkpointDigest,
      createdAt: "2026-08-26T00:00:01.000Z",
      privateKey: secondKey.privateKeyPem,
    });

    expect(verifySignedTransparencyCheckpoint(first).valid).toBe(true);
    expect(verifySignedTransparencyCheckpoint(current).valid).toBe(true);
    expect(
      verifyTransparencyConsistency({
        proof: createTransparencyConsistencyProof(digests, 1),
        from: first,
        to: current,
      }),
    ).toBe(false);
  });

  it("detects two valid same-size checkpoints with different roots", () => {
    const key = generatePortableSigningKey();
    const left = createSignedTransparencyCheckpoint({
      receiptDigests: [digest("left")],
      priorCheckpointDigest: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      privateKey: key.privateKeyPem,
    });
    const right = createSignedTransparencyCheckpoint({
      receiptDigests: [digest("right")],
      priorCheckpointDigest: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      privateKey: key.privateKeyPem,
    });
    expect(detectTransparencySplitView(left, right)).toBe(true);
  });

  it("rejects unknown fields throughout transparency proofs", () => {
    const digests = [digest("a"), digest("b")];
    const key = generatePortableSigningKey();
    const checkpoint = createSignedTransparencyCheckpoint({
      receiptDigests: digests,
      priorCheckpointDigest: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      privateKey: key.privateKeyPem,
    });
    const proof = createTransparencyInclusionProof(digests, 0) as unknown as Record<
      string,
      unknown
    >;
    proof.privateKey = "uncommitted content";
    expect(
      verifyTransparencyInclusion(
        proof as never,
        checkpoint.checkpoint,
      ),
    ).toBe(false);

    const nested = createTransparencyInclusionProof(digests, 0);
    (nested.siblings[0] as unknown as Record<string, unknown>).prompt =
      "uncommitted content";
    expect(verifyTransparencyInclusion(nested, checkpoint.checkpoint)).toBe(false);
  });

  it("reconstructs every prefix root incrementally", () => {
    const accumulator = new TransparencyRootAccumulator();
    const digests = Array.from({ length: 1_024 }, (_, index) =>
      digest(`entry-${index}`),
    );
    for (let index = 0; index < digests.length; index += 1) {
      expect(accumulator.append(digests[index]!)).toBe(
        transparencyRoot(digests.slice(0, index + 1)),
      );
    }
  });
});

function digest(value: string): ReceiptDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
