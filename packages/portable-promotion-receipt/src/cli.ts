#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import process from "node:process";
import { parseCanonicalJson } from "./canonical.js";
import { encodeOfflineEvmAnchorPayload } from "./evm.js";
import { verifyPortableEvidencePacketJson } from "./evidence-packet.js";
import { verifyPortableDecisionChainJson } from "./decision-chain.js";
import { writeNewPortableSigningKey } from "./signing-key.js";
import { loadPortableSigningKey } from "./signing-key.js";
import {
  signPolicyAuthorityRotation,
  signSigningKeyTrustPolicy,
  verifySignedPolicyAuthorityRotationEnvelope,
  verifySignedSigningKeyTrustPolicyEnvelope,
} from "./crypto.js";
import {
  parsePolicyAuthorityRotationJson,
  parseSignedPolicyAuthorityRotationEnvelopeJson,
} from "./authority-rotation.js";
import {
  parseSignedSigningKeyTrustPolicyEnvelopeJson,
  parseSigningKeyTrustPolicyJson,
} from "./trust-policy.js";
import {
  assertTransparencyInclusionProof,
  verifySignedTransparencyCheckpoint,
  verifyTransparencyInclusion,
} from "./transparency.js";
import type {
  SignedTransparencyCheckpoint,
  TransparencyInclusionProof,
} from "./types.js";
import { verifyPortablePromotionEnvelopeJson } from "./verifier.js";
import { safePortableDiagnostic } from "./validation.js";

async function main(): Promise<number> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "verify") {
    const inputPath = arguments_.find((item) => !item.startsWith("--"));
    if (!inputPath) return usage("verify requires an envelope JSON path");
    const source = await readBoundedRegularFile(inputPath);
    const report = verifyPortablePromotionEnvelopeJson(source);
    if (arguments_.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(renderHumanReport(report));
    }
    return report.valid ? 0 : 1;
  }
  if (command === "verify-packet") {
    const inputPath = arguments_.find((item) => !item.startsWith("--"));
    if (!inputPath) return usage("verify-packet requires an evidence-packet JSON path");
    const report = verifyPortableEvidencePacketJson(
      await readBoundedRegularFile(inputPath, 2_097_152),
    );
    if (arguments_.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Portable evidence packet: ${report.valid ? "VALID" : "INVALID"}`,
          ...report.checks.map(
            (check) =>
              `  ${check.valid ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
          ),
          "",
        ].join("\n"),
      );
    }
    return report.valid ? 0 : 1;
  }
  if (command === "verify-chain") {
    const inputPath = arguments_.find((item) => !item.startsWith("--"));
    if (!inputPath) return usage("verify-chain requires a decision-chain JSON path");
    const report = verifyPortableDecisionChainJson(
      await readBoundedRegularFile(inputPath, 4_194_304),
    );
    if (arguments_.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Portable decision chain: ${report.valid ? "VALID" : "INVALID"}`,
          `Signed decisions: ${report.packets.length}`,
          `Leaf receipt: ${report.leafReceiptDigest ?? "unavailable"}`,
          ...report.checks.map(
            (check) =>
              `  ${check.valid ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
          ),
          "",
        ].join("\n"),
      );
    }
    return report.valid ? 0 : 1;
  }
  if (command === "keygen") {
    const keyPath = arguments_.find((item) => !item.startsWith("--"));
    if (!keyPath) return usage("keygen requires a new private-key path");
    const key = await writeNewPortableSigningKey(keyPath);
    process.stdout.write(
      `${JSON.stringify({ keyId: key.keyId, publicJwk: key.publicJwk }, null, 2)}\n`,
    );
    return 0;
  }
  if (command === "sign-policy") {
    const paths = arguments_.filter((item) => !item.startsWith("--"));
    if (paths.length !== 2) {
      return usage("sign-policy requires a policy JSON path and authority private-key path");
    }
    const [policyPath, keyPath] = paths as [string, string];
    const policy = parseSigningKeyTrustPolicyJson(
      await readBoundedRegularFile(policyPath, 65_536),
    );
    const key = await loadPortableSigningKey(keyPath);
    process.stdout.write(
      `${JSON.stringify(signSigningKeyTrustPolicy({ policy, privateKey: key.privateKeyPem }), null, 2)}\n`,
    );
    return 0;
  }
  if (command === "sign-authority-rotation") {
    const paths = arguments_.filter((item) => !item.startsWith("--"));
    if (paths.length !== 2) {
      return usage(
        "sign-authority-rotation requires a rotation JSON path and current authority private-key path",
      );
    }
    const [rotationPath, keyPath] = paths as [string, string];
    const rotation = parsePolicyAuthorityRotationJson(
      await readBoundedRegularFile(rotationPath, 32_768),
    );
    const key = await loadPortableSigningKey(keyPath);
    process.stdout.write(
      `${JSON.stringify(signPolicyAuthorityRotation({ rotation, privateKey: key.privateKeyPem }), null, 2)}\n`,
    );
    return 0;
  }
  if (command === "verify-authority-rotation") {
    const rotationPath = arguments_[0];
    const authorityIndex = arguments_.indexOf("--authority");
    const authorityKeyId =
      authorityIndex >= 0 ? arguments_[authorityIndex + 1] : undefined;
    if (!rotationPath || rotationPath.startsWith("--") || !authorityKeyId) {
      return usage(
        "verify-authority-rotation requires a signed rotation path and --authority fingerprint",
      );
    }
    const envelope = parseSignedPolicyAuthorityRotationEnvelopeJson(
      await readBoundedRegularFile(rotationPath, 65_536),
    );
    const report = verifySignedPolicyAuthorityRotationEnvelope(
      envelope,
      [authorityKeyId as `sha256:${string}`],
    );
    if (arguments_.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Policy authority rotation: ${report.valid ? "AUTHORIZED" : "REJECTED"}`,
          `Rotation digest: ${report.rotationDigest ?? "unavailable"}`,
          `Previous authority: ${report.previousAuthorityKeyId ?? "unavailable"}`,
          `Next authority: ${report.nextAuthorityKeyId ?? "unavailable"}`,
          ...report.checks.map(
            (check) => `  ${check.valid ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
          ),
          "",
        ].join("\n"),
      );
    }
    return report.valid ? 0 : 1;
  }
  if (command === "verify-policy") {
    const policyPath = arguments_[0];
    const authorityIndex = arguments_.indexOf("--authority");
    const authorityKeyId =
      authorityIndex >= 0 ? arguments_[authorityIndex + 1] : undefined;
    if (!policyPath || policyPath.startsWith("--") || !authorityKeyId) {
      return usage("verify-policy requires a signed policy path and --authority fingerprint");
    }
    const envelope = parseSignedSigningKeyTrustPolicyEnvelopeJson(
      await readBoundedRegularFile(policyPath, 131_072),
    );
    const trustedAuthorityKeyIds = [authorityKeyId as `sha256:${string}`];
    const rotationIndex = arguments_.indexOf("--rotation");
    const rotationPath = rotationIndex >= 0 ? arguments_[rotationIndex + 1] : undefined;
    let rotationReport = null;
    if (rotationIndex >= 0 && !rotationPath) {
      return usage("--rotation requires a signed authority-rotation path");
    }
    if (rotationPath) {
      const rotationEnvelope = parseSignedPolicyAuthorityRotationEnvelopeJson(
        await readBoundedRegularFile(rotationPath, 65_536),
      );
      rotationReport = verifySignedPolicyAuthorityRotationEnvelope(
        rotationEnvelope,
        trustedAuthorityKeyIds,
      );
      if (rotationReport.valid && rotationReport.nextAuthorityKeyId) {
        trustedAuthorityKeyIds.push(rotationReport.nextAuthorityKeyId);
      }
    }
    const report = verifySignedSigningKeyTrustPolicyEnvelope(
      envelope,
      trustedAuthorityKeyIds,
    );
    const valid = report.valid && (rotationReport?.valid ?? true);
    if (arguments_.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify(rotationReport ? { valid, rotation: rotationReport, policy: report } : report, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        [
          `Signed trust policy: ${valid ? "AUTHORIZED" : "REJECTED"}`,
          ...(rotationReport
            ? [
                `Authority rotation: ${rotationReport.valid ? "AUTHORIZED" : "REJECTED"}`,
                ...rotationReport.checks.map(
                  (check) =>
                    `  ${check.valid ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
                ),
              ]
            : []),
          `Policy digest: ${report.policyDigest ?? "unavailable"}`,
          `Authority key: ${report.authorityKeyId ?? "unavailable"}`,
          ...report.checks.map(
            (check) => `  ${check.valid ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
          ),
          "",
        ].join("\n"),
      );
    }
    return valid ? 0 : 1;
  }
  if (command === "verify-anchor") {
    const paths = arguments_.filter((item) => !item.startsWith("--"));
    if (paths.length !== 2) {
      return usage("verify-anchor requires an envelope and anchor-proof JSON path");
    }
    const [envelopePath, anchorPath] = paths as [string, string];
    const envelopeReport = verifyPortablePromotionEnvelopeJson(
      await readBoundedRegularFile(envelopePath),
    );
    const anchor = parseAnchorProof(await readBoundedRegularFile(anchorPath));
    const checkpointReport = verifySignedTransparencyCheckpoint(
      anchor.checkpoint,
    );
    const digestMatches =
      envelopeReport.receiptDigest !== null &&
      anchor.inclusionProof.receiptDigest === envelopeReport.receiptDigest;
    const inclusionValid =
      checkpointReport.valid &&
      digestMatches &&
      verifyTransparencyInclusion(
        anchor.inclusionProof,
        anchor.checkpoint.checkpoint,
      );
    const report = {
      valid: envelopeReport.valid && checkpointReport.valid && inclusionValid,
      receipt: envelopeReport,
      checkpoint: checkpointReport,
      checks: [
        {
          name: "anchor-receipt-digest",
          valid: digestMatches,
          detail: digestMatches
            ? "The inclusion proof names the verified receipt digest."
            : "The inclusion proof does not name the verified receipt digest.",
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
    if (arguments_.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Portable receipt anchor: ${report.valid ? "VALID" : "INVALID"}`,
          ...report.checks.map(
            (check) =>
              `  ${check.valid ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
          ),
          "",
        ].join("\n"),
      );
    }
    return report.valid ? 0 : 1;
  }
  if (command === "evm-payload") {
    const digest = arguments_.find((item) => !item.startsWith("--"));
    if (!digest) return usage("evm-payload requires a sha256 receipt digest");
    const payload = encodeOfflineEvmAnchorPayload(
      digest as `sha256:${string}`,
    );
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  return usage();
}

async function readBoundedRegularFile(
  filePath: string,
  maximumBytes = 1_048_576,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ELOOP")) {
      throw new Error("Input must be a regular non-symbolic-link file");
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error("Input must be a regular non-symbolic-link file");
    }
    if (before.size < 1 || before.size > maximumBytes) {
      throw new Error("Input exceeds the portable document byte boundary");
    }
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("Input changed while it was being read");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function renderHumanReport(
  report: ReturnType<typeof verifyPortablePromotionEnvelopeJson>,
): string {
  const lines = [
    `Portable Promotion Receipt: ${report.valid ? "VALID" : "INVALID"}`,
    `Receipt digest: ${report.receiptDigest ?? "unavailable"}`,
    `Signing key: ${report.keyId ?? "unavailable"}`,
    "",
    "Checks:",
    ...report.checks.map(
      (check) => `  ${check.valid ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
    ),
    "",
    "Cryptographically supported claims:",
    ...report.provenClaims.map((claim) => `  - ${claim}`),
    "",
    "Unsupported claims:",
    ...report.unsupportedClaims.map((claim) => `  - ${claim}`),
  ];
  return `${lines.join("\n")}\n`;
}

function usage(error?: string): number {
  if (error) process.stderr.write(`Error: ${error}\n\n`);
  process.stderr.write(
    [
      "Usage:",
      "  agent-airlock-receipt verify <envelope.json> [--json]",
      "  agent-airlock-receipt verify-packet <evidence-packet.json> [--json]",
      "  agent-airlock-receipt verify-chain <decision-chain.json> [--json]",
      "  agent-airlock-receipt verify-anchor <envelope.json> <anchor-proof.json> [--json]",
      "  agent-airlock-receipt keygen <new-private-key.pem>",
      "  agent-airlock-receipt sign-policy <policy.json> <authority-private-key.pem>",
      "  agent-airlock-receipt sign-authority-rotation <rotation.json> <current-authority-private-key.pem>",
      "  agent-airlock-receipt verify-authority-rotation <signed-rotation.json> --authority <sha256:fingerprint> [--json]",
      "  agent-airlock-receipt verify-policy <signed-policy.json> --authority <sha256:fingerprint> [--rotation <signed-rotation.json>] [--json]",
      "  agent-airlock-receipt evm-payload <sha256:receipt-digest>",
      "",
    ].join("\n"),
  );
  return 2;
}

function parseAnchorProof(source: string): {
  checkpoint: SignedTransparencyCheckpoint;
  inclusionProof: TransparencyInclusionProof;
} {
  const value = parseCanonicalJson(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Anchor proof must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "checkpoint" ||
    keys[1] !== "inclusionProof"
  ) {
    throw new Error("Anchor proof contains unknown or missing fields");
  }
  assertTransparencyInclusionProof(record.inclusionProof);
  return record as unknown as {
    checkpoint: SignedTransparencyCheckpoint;
    inclusionProof: TransparencyInclusionProof;
  };
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `Portable receipt command failed: ${safePortableDiagnostic(error)}\n`,
    );
    process.exitCode = 1;
  });
