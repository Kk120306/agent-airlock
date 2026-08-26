#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import process from "node:process";
import { parseCanonicalJson } from "./canonical.js";
import { encodeOfflineEvmAnchorPayload } from "./evm.js";
import { writeNewPortableSigningKey } from "./signing-key.js";
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
  if (command === "keygen") {
    const keyPath = arguments_.find((item) => !item.startsWith("--"));
    if (!keyPath) return usage("keygen requires a new private-key path");
    const key = await writeNewPortableSigningKey(keyPath);
    process.stdout.write(
      `${JSON.stringify({ keyId: key.keyId, publicJwk: key.publicJwk }, null, 2)}\n`,
    );
    return 0;
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
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Input must be a regular non-symbolic-link file");
  }
  if (stats.size < 1 || stats.size > maximumBytes) {
    throw new Error("Input exceeds the portable document byte boundary");
  }
  return readFile(filePath, "utf8");
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
      "  agent-airlock-receipt verify-anchor <envelope.json> <anchor-proof.json> [--json]",
      "  agent-airlock-receipt keygen <new-private-key.pem>",
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
