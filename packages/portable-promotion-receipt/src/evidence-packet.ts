import { canonicalize, parseCanonicalJson, utf8Bytes } from "./canonical.js";
import { encodeOfflineEvmAnchorPayload } from "./evm.js";
import {
  assertTransparencyInclusionProof,
  verifySignedTransparencyCheckpoint,
  verifyTransparencyInclusion,
} from "./transparency.js";
import type {
  OfflineEvmAnchorPayload,
  PortableEvidencePacket,
  PortableEvidencePacketVerificationReport,
  SignedTransparencyCheckpoint,
  VerificationCheck,
} from "./types.js";
import {
  assertPortablePromotionEnvelope,
  isDigest,
  safePortableDiagnostic,
} from "./validation.js";
import { verifyPortablePromotionEnvelope } from "./verifier.js";

export const MAXIMUM_PORTABLE_EVIDENCE_PACKET_BYTES = 2_097_152;

export function buildPortableEvidencePacket(input: {
  envelope: PortableEvidencePacket["envelope"];
  anchor: PortableEvidencePacket["anchor"];
  evmPayload: PortableEvidencePacket["evmPayload"];
}): PortableEvidencePacket {
  const packet: PortableEvidencePacket = {
    schema: "agent-airlock/portable-evidence-packet",
    schemaVersion: 1,
    envelope: structuredClone(input.envelope),
    anchor: structuredClone(input.anchor),
    evmPayload: structuredClone(input.evmPayload),
  };
  const report = verifyPortableEvidencePacket(packet);
  if (!report.valid) {
    throw new Error("Portable evidence packet failed its own offline verification");
  }
  return packet;
}

export function assertPortableEvidencePacket(
  value: unknown,
): asserts value is PortableEvidencePacket {
  const packet = asRecord(value, "Portable evidence packet");
  assertExactKeys(
    packet,
    ["schema", "schemaVersion", "envelope", "anchor", "evmPayload"],
    "Portable evidence packet",
  );
  if (
    packet.schema !== "agent-airlock/portable-evidence-packet" ||
    packet.schemaVersion !== 1
  ) {
    throw new Error("Portable evidence packet protocol is unsupported");
  }
  assertPortablePromotionEnvelope(packet.envelope);
  if (packet.anchor !== null) assertAnchor(packet.anchor);
  if (packet.evmPayload !== null) assertOfflineEvmAnchorPayload(packet.evmPayload);
  if (utf8Bytes(JSON.stringify(value)).length > MAXIMUM_PORTABLE_EVIDENCE_PACKET_BYTES) {
    throw new Error("Portable evidence packet exceeds the byte limit");
  }
}

export function parsePortableEvidencePacketJson(
  source: string,
  maximumBytes = MAXIMUM_PORTABLE_EVIDENCE_PACKET_BYTES,
): PortableEvidencePacket {
  const value = parseCanonicalJson(source, maximumBytes);
  assertPortableEvidencePacket(value);
  return value;
}

export function verifyPortableEvidencePacket(
  value: unknown,
): PortableEvidencePacketVerificationReport {
  let packet: PortableEvidencePacket;
  try {
    assertPortableEvidencePacket(value);
    packet = value;
  } catch (error) {
    return invalidPacketReport(error);
  }

  const receipt = verifyPortablePromotionEnvelope(packet.envelope);
  const checks: VerificationCheck[] = [
    {
      name: "packet-schema",
      valid: true,
      detail: "The packet uses the exact supported version 1 schema.",
    },
    {
      name: "packet-receipt",
      valid: receipt.valid,
      detail: receipt.valid
        ? "The bundled signed receipt is valid."
        : "The bundled signed receipt is invalid.",
    },
  ];

  let anchor: PortableEvidencePacketVerificationReport["anchor"] = null;
  if (packet.anchor) {
    const checkpoint = verifySignedTransparencyCheckpoint(packet.anchor.checkpoint);
    const digestMatches =
      receipt.receiptDigest !== null &&
      packet.anchor.inclusionProof.receiptDigest === receipt.receiptDigest;
    const inclusionValid =
      checkpoint.valid &&
      digestMatches &&
      verifyTransparencyInclusion(
        packet.anchor.inclusionProof,
        packet.anchor.checkpoint.checkpoint,
      );
    anchor = {
      valid: checkpoint.valid && digestMatches && inclusionValid,
      splitView: false,
      checks: [
        ...checkpoint.checks,
        {
          name: "anchor-receipt-digest",
          valid: digestMatches,
          detail: digestMatches
            ? "The inclusion proof names the bundled receipt digest."
            : "The inclusion proof names a different receipt digest.",
        },
        {
          name: "anchor-inclusion",
          valid: inclusionValid,
          detail: inclusionValid
            ? "The receipt digest is included in the signed checkpoint root."
            : "The receipt digest inclusion proof is invalid.",
        },
      ],
    };
    checks.push({
      name: "packet-anchor",
      valid: anchor.valid,
      detail: anchor.valid
        ? "The bundled transparency proof is valid for this receipt."
        : "The bundled transparency proof is invalid for this receipt.",
    });
  }

  const evmPayload = packet.evmPayload
    ? verifyOfflineEvmPayload(packet.evmPayload, receipt.receiptDigest)
    : null;
  if (evmPayload) {
    checks.push({
      name: "packet-evm-payload",
      valid: evmPayload.valid,
      detail: evmPayload.valid
        ? "The bundled calldata encodes only this receipt digest without network or funds."
        : "The bundled calldata does not exactly encode this receipt digest.",
    });
  }

  return {
    valid: checks.every((check) => check.valid),
    receipt,
    anchor,
    evmPayload,
    checks,
  };
}

export function verifyPortableEvidencePacketJson(
  source: string,
  maximumBytes = MAXIMUM_PORTABLE_EVIDENCE_PACKET_BYTES,
): PortableEvidencePacketVerificationReport {
  try {
    return verifyPortableEvidencePacket(
      parsePortableEvidencePacketJson(source, maximumBytes),
    );
  } catch (error) {
    return invalidPacketReport(error);
  }
}

export function assertOfflineEvmAnchorPayload(
  value: unknown,
): asserts value is OfflineEvmAnchorPayload {
  const payload = asRecord(value, "Offline EVM anchor payload");
  assertExactKeys(
    payload,
    [
      "schema",
      "schemaVersion",
      "methodSignature",
      "functionSelector",
      "receiptDigest",
      "calldata",
      "privacyClaim",
      "networkCalls",
      "fundsSpent",
    ],
    "Offline EVM anchor payload",
  );
  if (
    payload.schema !== "agent-airlock/offline-evm-anchor-payload" ||
    payload.schemaVersion !== 1 ||
    payload.methodSignature !== "anchor(bytes32)" ||
    payload.functionSelector !== "0xeecdf927" ||
    !isDigest(payload.receiptDigest) ||
    typeof payload.calldata !== "string" ||
    !/^0x[a-f0-9]{72}$/.test(payload.calldata) ||
    payload.privacyClaim !== "receipt-digest-only" ||
    payload.networkCalls !== 0 ||
    payload.fundsSpent !== 0
  ) {
    throw new Error("Offline EVM anchor payload is invalid");
  }
}

function verifyOfflineEvmPayload(
  payload: OfflineEvmAnchorPayload,
  receiptDigest: PortableEvidencePacketVerificationReport["receipt"]["receiptDigest"],
): { valid: boolean; checks: VerificationCheck[] } {
  const digestMatches = receiptDigest !== null && payload.receiptDigest === receiptDigest;
  const expected = receiptDigest ? encodeOfflineEvmAnchorPayload(receiptDigest) : null;
  const encodingMatches =
    expected !== null && canonicalize(payload) === canonicalize(expected);
  const checks: VerificationCheck[] = [
    {
      name: "evm-receipt-digest",
      valid: digestMatches,
      detail: digestMatches
        ? "The EVM payload names the bundled receipt digest."
        : "The EVM payload names a different receipt digest.",
    },
    {
      name: "evm-calldata",
      valid: encodingMatches,
      detail: encodingMatches
        ? "The calldata is the exact anchor(bytes32) encoding of the receipt digest."
        : "The calldata or zero-side-effect claims do not match the canonical encoding.",
    },
  ];
  return { valid: checks.every((check) => check.valid), checks };
}

function assertAnchor(value: unknown): asserts value is {
  checkpoint: SignedTransparencyCheckpoint;
  inclusionProof: PortableEvidencePacket["anchor"] extends infer T
    ? T extends { inclusionProof: infer P }
      ? P
      : never
    : never;
} {
  const anchor = asRecord(value, "Portable transparency anchor");
  assertExactKeys(anchor, ["checkpoint", "inclusionProof"], "Portable transparency anchor");
  verifySignedTransparencyCheckpoint(anchor.checkpoint);
  assertTransparencyInclusionProof(anchor.inclusionProof);
}

function invalidPacketReport(error: unknown): PortableEvidencePacketVerificationReport {
  return {
    valid: false,
    receipt: verifyPortablePromotionEnvelope(null),
    anchor: null,
    evmPayload: null,
    checks: [
      {
        name: "packet-schema",
        valid: false,
        detail:
          "The portable evidence packet is structurally invalid: " +
          safePortableDiagnostic(error),
      },
    ],
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
