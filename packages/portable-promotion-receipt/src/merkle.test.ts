import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildEvidenceCommitment, verifyEvidenceDisclosure } from "./merkle.js";
import type { PortableEvidenceLeaf, ReceiptDigest } from "./types.js";

describe("portable evidence Merkle commitments", () => {
  it.each([0, 1, 2, 3, 8])("verifies every disclosure in a %i-leaf tree", (count) => {
    const commitment = buildEvidenceCommitment(
      Array.from({ length: count }, (_, index) => leaf(index)),
    );
    expect(commitment.leaves.map((item) => item.identity)).toEqual(
      Array.from({ length: count }, (_, index) => `validation:v-${index}`),
    );
    for (const disclosure of commitment.disclosures) {
      expect(
        verifyEvidenceDisclosure(disclosure, commitment.root, count),
      ).toBe(true);
    }
  });

  it("rejects duplicate identities and proof-order confusion", () => {
    expect(() => buildEvidenceCommitment([leaf(0), leaf(0)])).toThrow(
      /duplicate leaf identity/,
    );
    const commitment = buildEvidenceCommitment([leaf(0), leaf(1), leaf(2)]);
    const changed = structuredClone(commitment.disclosures[1]!);
    changed.siblings.reverse();
    expect(verifyEvidenceDisclosure(changed, commitment.root, 3)).toBe(false);
  });
});

function leaf(index: number): PortableEvidenceLeaf {
  return {
    schemaVersion: 1,
    identity: `validation:v-${index}`,
    category: "validation",
    status: "passed",
    required: true,
    durationMs: index,
    summary: `Evidence ${index}`,
    valueHash: digest(`value-${index}`),
  };
}

function digest(value: string): ReceiptDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
