import { Buffer } from "node:buffer";
import type { KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import {
  publicJwkFingerprint,
  sha256Digest,
  signCheckpointDigest,
  verifyPortableSignature,
} from "./crypto.js";
import type {
  ReceiptDigest,
  SignedTransparencyCheckpoint,
  TransparencyCheckpoint,
  TransparencyConsistencyProof,
  TransparencyEntry,
  TransparencyInclusionProof,
  TransparencyVerificationReport,
  VerificationCheck,
} from "./types.js";
import {
  assertPortablePublicJwk,
  decodeCanonicalBase64Url,
  isDigest,
  safePortableDiagnostic,
} from "./validation.js";

const ENTRY_DOMAIN = Buffer.from("agent-airlock-transparency-entry-v1\0", "utf8");
const LEAF_DOMAIN = Buffer.from("agent-airlock-transparency-leaf-v1\0", "utf8");
const NODE_DOMAIN = Buffer.from("agent-airlock-transparency-node-v1\0", "utf8");
const EMPTY_DOMAIN = Buffer.from("agent-airlock-transparency-empty-v1\0", "utf8");

export function createTransparencyEntry(input: {
  receiptDigest: ReceiptDigest;
  sequence: number;
  priorEntryHash: ReceiptDigest | null;
  appendedAt: string;
}): TransparencyEntry {
  if (
    !isDigest(input.receiptDigest) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    (input.priorEntryHash !== null && !isDigest(input.priorEntryHash)) ||
    !isTimestamp(input.appendedAt)
  ) {
    throw new Error("Transparency entry input is invalid");
  }
  const unsigned = {
    schemaVersion: 1 as const,
    sequence: input.sequence,
    receiptDigest: input.receiptDigest,
    priorEntryHash: input.priorEntryHash,
    appendedAt: input.appendedAt,
  };
  return {
    ...unsigned,
    entryHash: sha256Digest(
      Buffer.concat([ENTRY_DOMAIN, Buffer.from(canonicalize(unsigned), "utf8")]),
    ),
  };
}

export function verifyTransparencyEntries(
  entries: readonly TransparencyEntry[],
): boolean {
  try {
    const receipts = new Set<ReceiptDigest>();
    let priorEntryHash: ReceiptDigest | null = null;
    for (let sequence = 0; sequence < entries.length; sequence += 1) {
      const entry = entries[sequence];
      assertTransparencyEntry(entry);
      if (!entry || entry.sequence !== sequence || receipts.has(entry.receiptDigest)) {
        return false;
      }
      const expected = createTransparencyEntry({
        receiptDigest: entry.receiptDigest,
        sequence,
        priorEntryHash,
        appendedAt: entry.appendedAt,
      });
      if (
        expected.entryHash !== entry.entryHash ||
        entry.priorEntryHash !== priorEntryHash
      ) {
        return false;
      }
      receipts.add(entry.receiptDigest);
      priorEntryHash = entry.entryHash;
    }
    return true;
  } catch {
    return false;
  }
}

export function transparencyRoot(
  receiptDigests: readonly ReceiptDigest[],
): ReceiptDigest {
  if (receiptDigests.length > 100_000) {
    throw new Error("Transparency tree exceeds its entry boundary");
  }
  if (receiptDigests.length === 0) return sha256Digest(EMPTY_DOMAIN);
  let level = receiptDigests.map(hashTransparencyLeaf);
  while (level.length > 1) {
    const next: ReceiptDigest[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1];
      next.push(right ? hashTransparencyNode(left, right) : left);
    }
    level = next;
  }
  return level[0]!;
}

export class TransparencyRootAccumulator {
  private readonly frontier: Array<ReceiptDigest | null> = [];
  private count = 0;

  append(receiptDigest: ReceiptDigest): ReceiptDigest {
    let hash = hashTransparencyLeaf(receiptDigest);
    let height = 0;
    while (this.frontier[height]) {
      hash = hashTransparencyNode(this.frontier[height]!, hash);
      this.frontier[height] = null;
      height += 1;
    }
    this.frontier[height] = hash;
    this.count += 1;
    return this.root();
  }

  root(): ReceiptDigest {
    if (this.count === 0) return sha256Digest(EMPTY_DOMAIN);
    let root: ReceiptDigest | null = null;
    for (let height = 0; height < this.frontier.length; height += 1) {
      const subtree = this.frontier[height];
      if (!subtree) continue;
      root = root === null ? subtree : hashTransparencyNode(subtree, root);
    }
    return root!;
  }
}

export function createSignedTransparencyCheckpoint(input: {
  receiptDigests: readonly ReceiptDigest[];
  priorCheckpointDigest: ReceiptDigest | null;
  createdAt: string;
  privateKey: KeyObject | string | Buffer;
}): SignedTransparencyCheckpoint {
  if (
    (input.priorCheckpointDigest !== null &&
      !isDigest(input.priorCheckpointDigest)) ||
    !isTimestamp(input.createdAt)
  ) {
    throw new Error("Transparency checkpoint input is invalid");
  }
  const key = signCheckpointDigest(
    sha256Digest(Buffer.from("checkpoint-key-probe", "utf8")),
    input.privateKey,
  );
  const checkpoint: TransparencyCheckpoint = {
    schema: "agent-airlock/portable-transparency-checkpoint",
    schemaVersion: 1,
    treeSize: input.receiptDigests.length,
    root: transparencyRoot(input.receiptDigests),
    priorCheckpointDigest: input.priorCheckpointDigest,
    createdAt: input.createdAt,
    keyId: key.keyId,
  };
  const checkpointDigest = sha256Digest(
    Buffer.from(canonicalize(checkpoint), "utf8"),
  );
  const signed = signCheckpointDigest(checkpointDigest, input.privateKey);
  return {
    checkpoint,
    checkpointDigest,
    signatureAlgorithm: "Ed25519",
    signature: signed.signature,
    publicJwk: signed.publicJwk,
  };
}

export function verifySignedTransparencyCheckpoint(
  value: unknown,
): TransparencyVerificationReport {
  const checks: VerificationCheck[] = [];
  try {
    const signed = assertSignedCheckpoint(value);
    const expectedDigest = sha256Digest(
      Buffer.from(canonicalize(signed.checkpoint), "utf8"),
    );
    addCheck(
      checks,
      "checkpoint-digest",
      expectedDigest === signed.checkpointDigest,
      "The canonical checkpoint digest must match.",
    );
    const expectedKeyId = publicJwkFingerprint(signed.publicJwk);
    addCheck(
      checks,
      "checkpoint-key",
      expectedKeyId === signed.checkpoint.keyId,
      "The checkpoint key identifier must match its public JWK.",
    );
    addCheck(
      checks,
      "checkpoint-signature",
      verifyPortableSignature({
        digest: signed.checkpointDigest,
        signature: signed.signature,
        publicJwk: signed.publicJwk,
        domain: "checkpoint",
      }),
      "The domain-separated checkpoint signature must verify.",
    );
    return {
      valid: checks.every((check) => check.valid),
      splitView: false,
      checks,
    };
  } catch (error) {
    return {
      valid: false,
      splitView: false,
      checks: [
        {
          name: "checkpoint-schema",
          valid: false,
          detail:
            "The checkpoint is structurally invalid: " +
            safePortableDiagnostic(error),
        },
      ],
    };
  }
}

export function createTransparencyInclusionProof(
  receiptDigests: readonly ReceiptDigest[],
  leafIndex: number,
): TransparencyInclusionProof {
  if (
    !Number.isSafeInteger(leafIndex) ||
    leafIndex < 0 ||
    leafIndex >= receiptDigests.length
  ) {
    throw new Error("Transparency inclusion index is invalid");
  }
  let level = receiptDigests.map(hashTransparencyLeaf);
  let index = leafIndex;
  const siblings: TransparencyInclusionProof["siblings"] = [];
  while (level.length > 1) {
    if (index % 2 === 1) {
      siblings.push({ direction: "left", hash: level[index - 1]! });
    } else if (index + 1 < level.length) {
      siblings.push({ direction: "right", hash: level[index + 1]! });
    }
    const next: ReceiptDigest[] = [];
    for (let offset = 0; offset < level.length; offset += 2) {
      const left = level[offset]!;
      const right = level[offset + 1];
      next.push(right ? hashTransparencyNode(left, right) : left);
    }
    level = next;
    index = Math.floor(index / 2);
  }
  return {
    receiptDigest: receiptDigests[leafIndex]!,
    leafIndex,
    treeSize: receiptDigests.length,
    siblings,
  };
}

export function verifyTransparencyInclusion(
  proof: TransparencyInclusionProof,
  checkpoint: TransparencyCheckpoint,
): boolean {
  try {
    assertTransparencyInclusionProof(proof);
    assertTransparencyCheckpoint(checkpoint);
    if (
      !isDigest(proof.receiptDigest) ||
      proof.treeSize !== checkpoint.treeSize ||
      proof.leafIndex < 0 ||
      proof.leafIndex >= proof.treeSize ||
      proof.siblings.length > 32
    ) {
      return false;
    }
    let hash = hashTransparencyLeaf(proof.receiptDigest);
    let index = proof.leafIndex;
    let width = proof.treeSize;
    let siblingIndex = 0;
    while (width > 1) {
      const right = index % 2 === 1;
      const hasSibling = right || index + 1 < width;
      if (hasSibling) {
        const sibling = proof.siblings[siblingIndex];
        if (
          !sibling ||
          !isDigest(sibling.hash) ||
          (right && sibling.direction !== "left") ||
          (!right && sibling.direction !== "right")
        ) {
          return false;
        }
        hash = right
          ? hashTransparencyNode(sibling.hash, hash)
          : hashTransparencyNode(hash, sibling.hash);
        siblingIndex += 1;
      }
      index = Math.floor(index / 2);
      width = Math.ceil(width / 2);
    }
    return siblingIndex === proof.siblings.length && hash === checkpoint.root;
  } catch {
    return false;
  }
}

export function createTransparencyConsistencyProof(
  receiptDigests: readonly ReceiptDigest[],
  fromSize: number,
): TransparencyConsistencyProof {
  if (
    !Number.isSafeInteger(fromSize) ||
    fromSize < 0 ||
    fromSize > receiptDigests.length
  ) {
    throw new Error("Transparency consistency range is invalid");
  }
  receiptDigests.forEach((digest) => {
    if (!isDigest(digest)) throw new Error("Transparency digest is invalid");
  });
  return {
    fromSize,
    toSize: receiptDigests.length,
    receiptDigests: [...receiptDigests],
  };
}

export function verifyTransparencyConsistency(input: {
  proof: TransparencyConsistencyProof;
  from: SignedTransparencyCheckpoint;
  to: SignedTransparencyCheckpoint;
}): boolean {
  const { proof, from, to } = input;
  try {
    assertTransparencyConsistencyProof(proof);
    if (
      !verifySignedTransparencyCheckpoint(from).valid ||
      !verifySignedTransparencyCheckpoint(to).valid ||
      from.checkpoint.keyId !== to.checkpoint.keyId
    ) {
      return false;
    }
    const fromCheckpoint = from.checkpoint;
    const toCheckpoint = to.checkpoint;
    return (
      proof.fromSize === fromCheckpoint.treeSize &&
      proof.toSize === toCheckpoint.treeSize &&
      proof.receiptDigests.length === proof.toSize &&
      proof.receiptDigests.every(isDigest) &&
      transparencyRoot(proof.receiptDigests.slice(0, proof.fromSize)) ===
        fromCheckpoint.root &&
      transparencyRoot(proof.receiptDigests) === toCheckpoint.root &&
      (toCheckpoint.treeSize === fromCheckpoint.treeSize
        ? toCheckpoint.priorCheckpointDigest ===
          fromCheckpoint.priorCheckpointDigest
        : toCheckpoint.priorCheckpointDigest !== null)
    );
  } catch {
    return false;
  }
}

export function detectTransparencySplitView(
  left: SignedTransparencyCheckpoint,
  right: SignedTransparencyCheckpoint,
): boolean {
  const leftValid = verifySignedTransparencyCheckpoint(left).valid;
  const rightValid = verifySignedTransparencyCheckpoint(right).valid;
  return (
    leftValid &&
    rightValid &&
    left.checkpoint.keyId === right.checkpoint.keyId &&
    left.checkpoint.treeSize === right.checkpoint.treeSize &&
    left.checkpoint.root !== right.checkpoint.root
  );
}

function hashTransparencyLeaf(digest: ReceiptDigest): ReceiptDigest {
  if (!isDigest(digest)) throw new Error("Transparency leaf digest is invalid");
  return sha256Digest(
    Buffer.concat([
      LEAF_DOMAIN,
      Buffer.from(digest.slice("sha256:".length), "hex"),
    ]),
  );
}

function hashTransparencyNode(
  left: ReceiptDigest,
  right: ReceiptDigest,
): ReceiptDigest {
  return sha256Digest(
    Buffer.concat([
      NODE_DOMAIN,
      Buffer.from(left.slice("sha256:".length), "hex"),
      Buffer.from(right.slice("sha256:".length), "hex"),
    ]),
  );
}

function assertSignedCheckpoint(value: unknown): SignedTransparencyCheckpoint {
  const signed = asRecord(value, "Signed transparency checkpoint");
  assertExactKeys(
    signed,
    [
      "checkpoint",
      "checkpointDigest",
      "signatureAlgorithm",
      "signature",
      "publicJwk",
    ],
    "Signed transparency checkpoint",
  );
  assertTransparencyCheckpoint(signed.checkpoint);
  const checkpoint = signed.checkpoint as unknown as Record<string, unknown>;
  if (
    checkpoint.schema !== "agent-airlock/portable-transparency-checkpoint" ||
    checkpoint.schemaVersion !== 1 ||
    !Number.isSafeInteger(checkpoint.treeSize) ||
    (checkpoint.treeSize as number) < 0 ||
    (checkpoint.treeSize as number) > 100_000 ||
    !isDigest(checkpoint.root) ||
    !(
      checkpoint.priorCheckpointDigest === null ||
      isDigest(checkpoint.priorCheckpointDigest)
    ) ||
    !isTimestamp(checkpoint.createdAt) ||
    !isDigest(checkpoint.keyId) ||
    !isDigest(signed.checkpointDigest) ||
    signed.signatureAlgorithm !== "Ed25519" ||
    typeof signed.signature !== "string" ||
    decodeCanonicalBase64Url(signed.signature, 64).length !== 64
  ) {
    throw new Error("Signed transparency checkpoint is invalid");
  }
  assertPortablePublicJwk(signed.publicJwk);
  return signed as unknown as SignedTransparencyCheckpoint;
}

export function assertTransparencyEntry(
  value: unknown,
): asserts value is TransparencyEntry {
  const entry = asRecord(value, "Transparency entry");
  assertExactKeys(
    entry,
    [
      "schemaVersion",
      "sequence",
      "receiptDigest",
      "priorEntryHash",
      "appendedAt",
      "entryHash",
    ],
    "Transparency entry",
  );
  if (
    entry.schemaVersion !== 1 ||
    !Number.isSafeInteger(entry.sequence) ||
    (entry.sequence as number) < 0 ||
    !isDigest(entry.receiptDigest) ||
    !(entry.priorEntryHash === null || isDigest(entry.priorEntryHash)) ||
    !isTimestamp(entry.appendedAt) ||
    !isDigest(entry.entryHash)
  ) {
    throw new Error("Transparency entry is invalid");
  }
}

export function assertTransparencyCheckpoint(
  value: unknown,
): asserts value is TransparencyCheckpoint {
  const checkpoint = asRecord(value, "Transparency checkpoint");
  assertExactKeys(
    checkpoint,
    [
      "schema",
      "schemaVersion",
      "treeSize",
      "root",
      "priorCheckpointDigest",
      "createdAt",
      "keyId",
    ],
    "Transparency checkpoint",
  );
  if (
    checkpoint.schema !== "agent-airlock/portable-transparency-checkpoint" ||
    checkpoint.schemaVersion !== 1 ||
    !Number.isSafeInteger(checkpoint.treeSize) ||
    (checkpoint.treeSize as number) < 0 ||
    (checkpoint.treeSize as number) > 100_000 ||
    !isDigest(checkpoint.root) ||
    !(checkpoint.priorCheckpointDigest === null ||
      isDigest(checkpoint.priorCheckpointDigest)) ||
    !isTimestamp(checkpoint.createdAt) ||
    !isDigest(checkpoint.keyId)
  ) {
    throw new Error("Transparency checkpoint is invalid");
  }
}

export function assertTransparencyInclusionProof(
  value: unknown,
): asserts value is TransparencyInclusionProof {
  const proof = asRecord(value, "Transparency inclusion proof");
  assertExactKeys(
    proof,
    ["receiptDigest", "leafIndex", "treeSize", "siblings"],
    "Transparency inclusion proof",
  );
  if (
    !isDigest(proof.receiptDigest) ||
    !Number.isSafeInteger(proof.leafIndex) ||
    (proof.leafIndex as number) < 0 ||
    !Number.isSafeInteger(proof.treeSize) ||
    (proof.treeSize as number) < 1 ||
    (proof.treeSize as number) > 100_000 ||
    (proof.leafIndex as number) >= (proof.treeSize as number) ||
    !Array.isArray(proof.siblings) ||
    proof.siblings.length > 32
  ) {
    throw new Error("Transparency inclusion proof is invalid");
  }
  for (const value of proof.siblings) {
    const sibling = asRecord(value, "Transparency inclusion sibling");
    assertExactKeys(sibling, ["direction", "hash"], "Transparency inclusion sibling");
    if (!['left', 'right'].includes(String(sibling.direction)) || !isDigest(sibling.hash)) {
      throw new Error("Transparency inclusion sibling is invalid");
    }
  }
}

export function assertTransparencyConsistencyProof(
  value: unknown,
): asserts value is TransparencyConsistencyProof {
  const proof = asRecord(value, "Transparency consistency proof");
  assertExactKeys(
    proof,
    ["fromSize", "toSize", "receiptDigests"],
    "Transparency consistency proof",
  );
  if (
    !Number.isSafeInteger(proof.fromSize) ||
    (proof.fromSize as number) < 0 ||
    !Number.isSafeInteger(proof.toSize) ||
    (proof.toSize as number) < (proof.fromSize as number) ||
    (proof.toSize as number) > 100_000 ||
    !Array.isArray(proof.receiptDigests) ||
    proof.receiptDigests.length !== proof.toSize ||
    !proof.receiptDigests.every(isDigest)
  ) {
    throw new Error("Transparency consistency proof is invalid");
  }
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${name} contains unknown or missing fields`);
  }
}

function addCheck(
  checks: VerificationCheck[],
  name: string,
  valid: boolean,
  detail: string,
): void {
  checks.push({ name, valid, detail });
}
