import { parseCanonicalJson, utf8Bytes } from "./canonical.js";
import {
  assertPortableEvidencePacket,
  verifyPortableEvidencePacket,
} from "./evidence-packet.js";
import type {
  PortableDecisionChain,
  PortableDecisionChainVerificationReport,
  VerificationCheck,
} from "./types.js";
import { safePortableDiagnostic } from "./validation.js";

export const MAXIMUM_PORTABLE_DECISION_CHAIN_BYTES = 4_194_304;
export const MAXIMUM_PORTABLE_DECISION_CHAIN_PACKETS = 32;

export function buildPortableDecisionChain(
  packets: PortableDecisionChain["packets"],
): PortableDecisionChain {
  const chain: PortableDecisionChain = {
    schema: "agent-airlock/portable-decision-chain",
    schemaVersion: 1,
    packets: structuredClone(packets),
  };
  const report = verifyPortableDecisionChain(chain);
  if (!report.valid) {
    throw new Error("Portable decision chain failed its own offline verification");
  }
  return chain;
}

export function assertPortableDecisionChain(
  value: unknown,
): asserts value is PortableDecisionChain {
  const chain = asRecord(value, "Portable decision chain");
  assertExactKeys(chain, ["schema", "schemaVersion", "packets"], "Portable decision chain");
  if (
    chain.schema !== "agent-airlock/portable-decision-chain" ||
    chain.schemaVersion !== 1
  ) {
    throw new Error("Portable decision chain protocol is unsupported");
  }
  if (
    !Array.isArray(chain.packets) ||
    chain.packets.length < 1 ||
    chain.packets.length > MAXIMUM_PORTABLE_DECISION_CHAIN_PACKETS
  ) {
    throw new Error("Portable decision chain packet count is invalid");
  }
  for (const packet of chain.packets) assertPortableEvidencePacket(packet);
  if (utf8Bytes(JSON.stringify(value)).length > MAXIMUM_PORTABLE_DECISION_CHAIN_BYTES) {
    throw new Error("Portable decision chain exceeds the byte limit");
  }
}

export function parsePortableDecisionChainJson(
  source: string,
  maximumBytes = MAXIMUM_PORTABLE_DECISION_CHAIN_BYTES,
): PortableDecisionChain {
  const value = parseCanonicalJson(source, maximumBytes);
  assertPortableDecisionChain(value);
  return value;
}

export function verifyPortableDecisionChain(
  value: unknown,
): PortableDecisionChainVerificationReport {
  let chain: PortableDecisionChain;
  try {
    assertPortableDecisionChain(value);
    chain = value;
  } catch (error) {
    return invalidChainReport(error);
  }

  const packets = chain.packets.map((packet) => verifyPortableEvidencePacket(packet));
  const checks: VerificationCheck[] = [
    {
      name: "chain-schema",
      valid: true,
      detail: "The decision chain uses the exact supported version 1 schema.",
    },
    {
      name: "chain-packets",
      valid: packets.every((packet) => packet.valid),
      detail: packets.every((packet) => packet.valid)
        ? `All ${packets.length} bundled evidence packets are valid.`
        : "At least one bundled evidence packet is invalid.",
    },
  ];

  const first = chain.packets[0]!.envelope;
  const root = first.receipt.ancestry;
  const rootValid =
    root.depth === 0 &&
    root.parentRunId === null &&
    root.previousReceiptDigest === null &&
    root.rootRunId === first.receipt.decision.runId;
  checks.push({
    name: "chain-root",
    valid: rootValid,
    detail: rootValid
      ? "The first receipt is the signed root of this complete lineage."
      : "The first receipt is not a valid lineage root.",
  });

  let linksValid = true;
  let stateContinuityValid = true;
  for (let index = 1; index < chain.packets.length; index += 1) {
    const previous = chain.packets[index - 1]!.envelope;
    const current = chain.packets[index]!.envelope;
    const ancestry = current.receipt.ancestry;
    linksValid &&=
      current.receipt.decision.agentId === first.receipt.decision.agentId &&
      ancestry.rootRunId === root.rootRunId &&
      ancestry.parentRunId === previous.receipt.decision.runId &&
      ancestry.depth === previous.receipt.ancestry.depth + 1 &&
      ancestry.maxDepth === root.maxDepth &&
      ancestry.previousReceiptDigest === previous.receiptDigest;
    stateContinuityValid &&=
      current.receipt.state.before.stateId === previous.receipt.state.after.stateId &&
      current.receipt.state.before.compositeHash ===
        previous.receipt.state.after.compositeHash;
  }
  const leaf = chain.packets.at(-1)!.envelope;
  const completeLength = leaf.receipt.ancestry.depth + 1 === chain.packets.length;
  checks.push({
    name: "chain-links",
    valid: linksValid && completeLength,
    detail:
      linksValid && completeLength
        ? "Every child names the exact prior receipt digest and signed parent Run."
        : "The chain is incomplete, reordered, or contains a broken parent digest link.",
  });
  checks.push({
    name: "chain-state-continuity",
    valid: stateContinuityValid,
    detail: stateContinuityValid
      ? "Every child begins from the exact Canonical State committed by its parent."
      : "A child does not begin from its parent's committed Canonical State.",
  });

  return {
    valid: checks.every((check) => check.valid),
    packets,
    checks,
    leafReceiptDigest: packets.at(-1)?.receipt.receiptDigest ?? null,
  };
}

export function verifyPortableDecisionChainJson(
  source: string,
  maximumBytes = MAXIMUM_PORTABLE_DECISION_CHAIN_BYTES,
): PortableDecisionChainVerificationReport {
  try {
    return verifyPortableDecisionChain(parsePortableDecisionChainJson(source, maximumBytes));
  } catch (error) {
    return invalidChainReport(error);
  }
}

function invalidChainReport(error: unknown): PortableDecisionChainVerificationReport {
  return {
    valid: false,
    packets: [],
    checks: [
      {
        name: "chain-schema",
        valid: false,
        detail: "The portable decision chain is structurally invalid: " + safePortableDiagnostic(error),
      },
    ],
    leafReceiptDigest: null,
  };
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
