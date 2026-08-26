import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { canonicalize } from "./canonical.js";
import type {
  PortableEvidenceDisclosure,
  PortableEvidenceLeaf,
  ReceiptDigest,
} from "./types.js";
import {
  assertPortableEvidenceDisclosure,
  assertPortableEvidenceLeaf,
  isDigest,
} from "./validation.js";

const EMPTY_TREE_DOMAIN = Buffer.from("agent-airlock-evidence-empty-v1\0", "utf8");

export function evidenceEmptyRoot(): ReceiptDigest {
  return digestBytes(EMPTY_TREE_DOMAIN);
}

export function hashEvidenceLeaf(leaf: PortableEvidenceLeaf): ReceiptDigest {
  assertPortableEvidenceLeaf(leaf);
  return digestBytes(Buffer.concat([Buffer.from([0x00]), Buffer.from(canonicalize(leaf))]));
}

export function buildEvidenceCommitment(leaves: readonly PortableEvidenceLeaf[]): {
  root: ReceiptDigest;
  leaves: PortableEvidenceLeaf[];
  disclosures: PortableEvidenceDisclosure[];
} {
  if (leaves.length > 10_000) throw new Error("Evidence tree exceeds the leaf limit");
  const sorted = leaves.map((leaf) => structuredClone(leaf)).sort((left, right) =>
    Buffer.compare(Buffer.from(left.identity), Buffer.from(right.identity)),
  );
  const identities = new Set<string>();
  for (const leaf of sorted) {
    assertPortableEvidenceLeaf(leaf);
    if (identities.has(leaf.identity)) {
      throw new Error("Evidence tree contains a duplicate leaf identity");
    }
    identities.add(leaf.identity);
  }
  if (sorted.length === 0) {
    return { root: evidenceEmptyRoot(), leaves: [], disclosures: [] };
  }
  const leafHashes = sorted.map(hashEvidenceLeaf);
  const levels = buildLevels(leafHashes);
  const root = levels.at(-1)?.[0];
  if (!root) throw new Error("Evidence tree root is unavailable");
  return {
    root,
    leaves: sorted,
    disclosures: sorted.map((leaf, leafIndex) => ({
      leaf,
      leafIndex,
      totalLeaves: sorted.length,
      siblings: buildSiblings(levels, leafIndex),
    })),
  };
}

export function verifyEvidenceDisclosure(
  disclosure: PortableEvidenceDisclosure,
  expectedRoot: ReceiptDigest,
  expectedLeafCount: number,
): boolean {
  try {
    assertPortableEvidenceDisclosure(disclosure);
    if (
      !isDigest(expectedRoot) ||
      disclosure.totalLeaves !== expectedLeafCount
    ) {
      return false;
    }
    let current = hashEvidenceLeaf(disclosure.leaf);
    let index = disclosure.leafIndex;
    let width = disclosure.totalLeaves;
    let siblingIndex = 0;
    while (width > 1) {
      const isRight = index % 2 === 1;
      const hasSibling = isRight || index + 1 < width;
      if (hasSibling) {
        const sibling = disclosure.siblings[siblingIndex];
        if (!sibling) return false;
        if (
          (isRight && sibling.direction !== "left") ||
          (!isRight && sibling.direction !== "right")
        ) {
          return false;
        }
        current = isRight
          ? hashInternal(sibling.hash, current)
          : hashInternal(current, sibling.hash);
        siblingIndex += 1;
      }
      index = Math.floor(index / 2);
      width = Math.ceil(width / 2);
    }
    return siblingIndex === disclosure.siblings.length && current === expectedRoot;
  } catch {
    return false;
  }
}

function buildLevels(hashes: ReceiptDigest[]): ReceiptDigest[][] {
  const levels = [hashes];
  let current = hashes;
  while (current.length > 1) {
    const next: ReceiptDigest[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index]!;
      const right = current[index + 1];
      next.push(right ? hashInternal(left, right) : left);
    }
    levels.push(next);
    current = next;
  }
  return levels;
}

function buildSiblings(
  levels: readonly ReceiptDigest[][],
  leafIndex: number,
): PortableEvidenceDisclosure["siblings"] {
  const siblings: PortableEvidenceDisclosure["siblings"] = [];
  let index = leafIndex;
  for (const level of levels.slice(0, -1)) {
    if (index % 2 === 1) {
      siblings.push({ direction: "left", hash: level[index - 1]! });
    } else if (index + 1 < level.length) {
      siblings.push({ direction: "right", hash: level[index + 1]! });
    }
    index = Math.floor(index / 2);
  }
  return siblings;
}

function hashInternal(left: ReceiptDigest, right: ReceiptDigest): ReceiptDigest {
  return digestBytes(
    Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from(left.slice("sha256:".length), "hex"),
      Buffer.from(right.slice("sha256:".length), "hex"),
    ]),
  );
}

function digestBytes(value: Uint8Array): ReceiptDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
