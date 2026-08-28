import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { canonicalize, parseCanonicalJson, utf8Bytes } from "./canonical.js";
import {
  exportPortablePublicJwk,
  publicJwkFingerprint,
  sha256Digest,
} from "./crypto.js";
import type {
  PortablePromotionEnvelope,
  ReceiptDigest,
  VerificationCheck,
} from "./types.js";
import {
  assertPortablePromotionEnvelope,
  decodeCanonicalBase64Url,
  isDigest,
  safePortableDiagnostic,
} from "./validation.js";
import { verifyPortablePromotionEnvelope } from "./verifier.js";
import type { WorkspaceChangeSetEnvelope } from "./workspace-change-set.js";
import {
  assertWorkspaceChangeSetEnvelope,
  MAXIMUM_WORKSPACE_CHANGE_SET_BYTES,
} from "./workspace-change-set.js";

const SIGNATURE_DOMAIN = Buffer.from(
  "agent-airlock-federated-work-binding-v1\0",
  "utf8",
);
export const MAXIMUM_FEDERATED_WORK_BUNDLE_BYTES =
  MAXIMUM_WORKSPACE_CHANGE_SET_BYTES + 1_048_576;

export interface FederatedWorkBinding {
  schema: "agent-airlock/federated-work-binding";
  schemaVersion: 1;
  receiptDigest: ReceiptDigest;
  artifactDigest: ReceiptDigest;
  artifactProtocol: {
    schema: "agent-airlock/workspace-change-set";
    schemaVersion: 1;
    pathSemantics: "normalized-relative-posix-nfc";
  };
  baseStateDigest: ReceiptDigest;
  resultStateDigest: ReceiptDigest;
}

export interface FederatedWorkBundle {
  schema: "agent-airlock/federated-work-bundle";
  schemaVersion: 1;
  receipt: PortablePromotionEnvelope;
  artifact: WorkspaceChangeSetEnvelope;
  binding: FederatedWorkBinding;
  bindingDigest: ReceiptDigest;
  signatureAlgorithm: "Ed25519";
  signature: string;
  keyId: ReceiptDigest;
}

export interface FederatedWorkBundleVerificationReport {
  valid: boolean;
  receiptDigest: ReceiptDigest | null;
  artifactDigest: ReceiptDigest | null;
  keyId: ReceiptDigest | null;
  checks: VerificationCheck[];
}

export function buildFederatedWorkBundle(input: {
  receipt: PortablePromotionEnvelope;
  artifact: WorkspaceChangeSetEnvelope;
  privateKey: KeyObject | string | Buffer;
}): FederatedWorkBundle {
  const receiptReport = verifyPortablePromotionEnvelope(input.receipt);
  if (!receiptReport.valid) throw new Error("Federated work receipt is invalid");
  assertWorkspaceChangeSetEnvelope(input.artifact);
  assertStateBinding(input.receipt, input.artifact);
  const privateKey = asEd25519PrivateKey(input.privateKey);
  const signerKeyId = publicJwkFingerprint(exportPortablePublicJwk(privateKey));
  if (signerKeyId !== input.receipt.keyId) {
    throw new Error("Federated work binding signer does not match the receipt signer");
  }
  const binding = createBinding(input.receipt, input.artifact);
  const bindingDigest = sha256Digest(utf8Bytes(canonicalize(binding)));
  const bundle: FederatedWorkBundle = {
    schema: "agent-airlock/federated-work-bundle",
    schemaVersion: 1,
    receipt: structuredClone(input.receipt),
    artifact: structuredClone(input.artifact),
    binding,
    bindingDigest,
    signatureAlgorithm: "Ed25519",
    signature: sign(null, signatureMessage(bindingDigest), privateKey).toString("base64url"),
    keyId: signerKeyId,
  };
  assertFederatedWorkBundle(bundle);
  return bundle;
}

export function parseFederatedWorkBundleJson(
  source: string,
  maximumBytes = MAXIMUM_FEDERATED_WORK_BUNDLE_BYTES,
): FederatedWorkBundle {
  const value = parseCanonicalJson(source, maximumBytes);
  assertFederatedWorkBundle(value);
  return value;
}

export function assertFederatedWorkBundle(
  value: unknown,
): asserts value is FederatedWorkBundle {
  const bundle = asRecord(value, "Federated Work Bundle");
  assertExactKeys(
    bundle,
    [
      "schema",
      "schemaVersion",
      "receipt",
      "artifact",
      "binding",
      "bindingDigest",
      "signatureAlgorithm",
      "signature",
      "keyId",
    ],
    "Federated Work Bundle",
  );
  if (
    bundle.schema !== "agent-airlock/federated-work-bundle" ||
    bundle.schemaVersion !== 1 ||
    bundle.signatureAlgorithm !== "Ed25519" ||
    !isDigest(bundle.bindingDigest) ||
    !isDigest(bundle.keyId) ||
    typeof bundle.signature !== "string" ||
    decodeCanonicalBase64Url(bundle.signature, 64).length !== 64
  ) {
    throw new Error("Federated Work Bundle identity or signature bounds are invalid");
  }
  assertPortablePromotionEnvelope(bundle.receipt);
  assertWorkspaceChangeSetEnvelope(bundle.artifact);
  const binding = assertBinding(bundle.binding);
  const receipt = bundle.receipt as PortablePromotionEnvelope;
  const artifact = bundle.artifact as WorkspaceChangeSetEnvelope;
  if (canonicalize(binding) !== canonicalize(createBinding(receipt, artifact))) {
    throw new Error("Federated work binding contradicts its receipt or artifact");
  }
  if (bundle.bindingDigest !== sha256Digest(utf8Bytes(canonicalize(binding)))) {
    throw new Error("Federated work binding digest does not match its content");
  }
  assertStateBinding(receipt, artifact);
  if (bundle.keyId !== receipt.keyId) {
    throw new Error("Federated work binding key does not match the receipt key");
  }
  if (utf8Bytes(canonicalize(bundle)).length > MAXIMUM_FEDERATED_WORK_BUNDLE_BYTES) {
    throw new Error("Federated Work Bundle exceeds the byte limit");
  }
}

export function verifyFederatedWorkBundle(
  value: unknown,
): FederatedWorkBundleVerificationReport {
  let bundle: FederatedWorkBundle;
  try {
    assertFederatedWorkBundle(value);
    bundle = value;
  } catch (error) {
    return invalidReport(error);
  }
  const receipt = verifyPortablePromotionEnvelope(bundle.receipt);
  const signatureValid = verify(
    null,
    signatureMessage(bundle.bindingDigest),
    createPublicKey({
      key: bundle.receipt.publicJwk as JsonWebKey,
      format: "jwk",
    }),
    Buffer.from(bundle.signature, "base64url"),
  );
  const checks: VerificationCheck[] = [
    {
      name: "federated-bundle-schema",
      valid: true,
      detail: "The bundle uses the exact supported version 1 schema.",
    },
    {
      name: "federated-bundle-receipt",
      valid: receipt.valid,
      detail: receipt.valid
        ? "The producer receipt is cryptographically valid."
        : "The producer receipt is invalid.",
    },
    {
      name: "federated-bundle-artifact",
      valid: true,
      detail: "The artifact is canonical, bounded, and matches its digest.",
    },
    {
      name: "federated-bundle-state",
      valid: true,
      detail: "The artifact base and result match the signed receipt state transition.",
    },
    {
      name: "federated-bundle-signature",
      valid: signatureValid,
      detail: signatureValid
        ? "The receipt signer bound the exact artifact digest and protocol version."
        : "The artifact binding signature is invalid.",
    },
  ];
  return {
    valid: checks.every((check) => check.valid),
    receiptDigest: bundle.receipt.receiptDigest,
    artifactDigest: bundle.artifact.artifactDigest,
    keyId: bundle.keyId,
    checks,
  };
}

export function verifyFederatedWorkBundleJson(
  source: string,
  maximumBytes = MAXIMUM_FEDERATED_WORK_BUNDLE_BYTES,
): FederatedWorkBundleVerificationReport {
  try {
    return verifyFederatedWorkBundle(parseFederatedWorkBundleJson(source, maximumBytes));
  } catch (error) {
    return invalidReport(error);
  }
}

function createBinding(
  receipt: PortablePromotionEnvelope,
  artifact: WorkspaceChangeSetEnvelope,
): FederatedWorkBinding {
  return {
    schema: "agent-airlock/federated-work-binding",
    schemaVersion: 1,
    receiptDigest: receipt.receiptDigest,
    artifactDigest: artifact.artifactDigest,
    artifactProtocol: {
      schema: artifact.artifact.protocol.schema,
      schemaVersion: artifact.artifact.protocol.schemaVersion,
      pathSemantics: artifact.artifact.protocol.pathSemantics,
    },
    baseStateDigest: artifact.artifact.baseStateDigest,
    resultStateDigest: artifact.artifact.resultStateDigest,
  };
}

function assertBinding(value: unknown): FederatedWorkBinding {
  const binding = asRecord(value, "Federated work binding");
  assertExactKeys(
    binding,
    [
      "schema",
      "schemaVersion",
      "receiptDigest",
      "artifactDigest",
      "artifactProtocol",
      "baseStateDigest",
      "resultStateDigest",
    ],
    "Federated work binding",
  );
  const protocol = asRecord(binding.artifactProtocol, "Federated artifact protocol");
  assertExactKeys(
    protocol,
    ["schema", "schemaVersion", "pathSemantics"],
    "Federated artifact protocol",
  );
  if (
    binding.schema !== "agent-airlock/federated-work-binding" ||
    binding.schemaVersion !== 1 ||
    !isDigest(binding.receiptDigest) ||
    !isDigest(binding.artifactDigest) ||
    !isDigest(binding.baseStateDigest) ||
    !isDigest(binding.resultStateDigest) ||
    protocol.schema !== "agent-airlock/workspace-change-set" ||
    protocol.schemaVersion !== 1 ||
    protocol.pathSemantics !== "normalized-relative-posix-nfc"
  ) {
    throw new Error("Federated work binding is invalid");
  }
  return binding as unknown as FederatedWorkBinding;
}

function assertStateBinding(
  receipt: PortablePromotionEnvelope,
  artifact: WorkspaceChangeSetEnvelope,
): void {
  if (
    artifact.artifact.baseStateDigest !== receipt.receipt.state.before.compositeHash ||
    artifact.artifact.resultStateDigest !== receipt.receipt.state.after.compositeHash
  ) {
    throw new Error("Federated artifact does not match the signed receipt state transition");
  }
}

function signatureMessage(bindingDigest: ReceiptDigest): Buffer {
  return Buffer.concat([
    SIGNATURE_DOMAIN,
    Buffer.from(bindingDigest.slice("sha256:".length), "hex"),
  ]);
}

function asEd25519PrivateKey(value: KeyObject | string | Buffer): KeyObject {
  const key = value instanceof KeyObject ? value : createPrivateKey(value);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Federated work binding key must be an Ed25519 private key");
  }
  return key;
}

function invalidReport(error: unknown): FederatedWorkBundleVerificationReport {
  return {
    valid: false,
    receiptDigest: null,
    artifactDigest: null,
    keyId: null,
    checks: [
      {
        name: "federated-bundle-schema",
        valid: false,
        detail: safePortableDiagnostic(error),
      },
    ],
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}
