import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { canonicalize } from "./canonical.js";
import type {
  PortableEvidenceDisclosure,
  PortablePromotionEnvelope,
  PortablePromotionReceipt,
  PortablePublicJwk,
  PortableSigningKeyMaterial,
  ReceiptDigest,
} from "./types.js";
import {
  assertPortablePromotionEnvelope,
  assertPortablePromotionReceipt,
  assertPortablePublicJwk,
  decodeCanonicalBase64Url,
} from "./validation.js";

const RECEIPT_SIGNATURE_DOMAIN = Buffer.from(
  "agent-airlock-portable-receipt-signature-v1\0",
  "utf8",
);
const CHECKPOINT_SIGNATURE_DOMAIN = Buffer.from(
  "agent-airlock-portable-transparency-checkpoint-signature-v1\0",
  "utf8",
);

export function sha256Digest(value: string | Uint8Array): ReceiptDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestPortableReceipt(
  receipt: PortablePromotionReceipt,
): ReceiptDigest {
  assertPortablePromotionReceipt(receipt);
  return sha256Digest(Buffer.from(canonicalize(receipt), "utf8"));
}

export function publicJwkFingerprint(jwk: PortablePublicJwk): ReceiptDigest {
  assertPortablePublicJwk(jwk);
  return sha256Digest(Buffer.from(canonicalize(jwk), "utf8"));
}

export function generatePortableSigningKey(): PortableSigningKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = exportPortablePublicJwk(publicKey);
  return {
    privateKeyPem: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
    publicJwk,
    keyId: publicJwkFingerprint(publicJwk),
  };
}

export function exportPortablePublicJwk(
  key: KeyObject | string | Buffer,
): PortablePublicJwk {
  const parsed = key instanceof KeyObject ? key : createPublicKey(key);
  const publicKey = parsed.type === "public" ? parsed : createPublicKey(parsed);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Portable receipt signing key must be Ed25519");
  }
  const exported = publicKey.export({ format: "jwk" });
  const publicJwk = {
    crv: exported.crv,
    kty: exported.kty,
    x: exported.x,
  };
  assertPortablePublicJwk(publicJwk);
  return publicJwk;
}

export function signPortableReceipt(input: {
  receipt: PortablePromotionReceipt;
  privateKey: KeyObject | string | Buffer;
  disclosures?: readonly PortableEvidenceDisclosure[];
}): PortablePromotionEnvelope {
  assertPortablePromotionReceipt(input.receipt);
  const privateKey = asEd25519PrivateKey(input.privateKey);
  const publicJwk = exportPortablePublicJwk(privateKey);
  const receiptDigest = digestPortableReceipt(input.receipt);
  const signature = sign(
    null,
    signatureMessage(RECEIPT_SIGNATURE_DOMAIN, receiptDigest),
    privateKey,
  ).toString("base64url");
  const envelope: PortablePromotionEnvelope = {
    schema: "agent-airlock/portable-promotion-envelope",
    schemaVersion: 1,
    receipt: structuredClone(input.receipt),
    receiptDigest,
    signatureAlgorithm: "Ed25519",
    signature,
    keyId: publicJwkFingerprint(publicJwk),
    publicJwk,
    disclosures: structuredClone([...(input.disclosures ?? [])]),
  };
  assertPortablePromotionEnvelope(envelope);
  return envelope;
}

export function verifyPortableSignature(input: {
  digest: ReceiptDigest;
  signature: string;
  publicJwk: PortablePublicJwk;
  domain?: "receipt" | "checkpoint";
}): boolean {
  try {
    assertPortablePublicJwk(input.publicJwk);
    const signatureBytes = decodeCanonicalBase64Url(input.signature, 64);
    if (signatureBytes.length !== 64) return false;
    const publicKey = createPublicKey({
      key: { ...input.publicJwk } as JsonWebKey,
      format: "jwk",
    });
    return verify(
      null,
      signatureMessage(
        input.domain === "checkpoint"
          ? CHECKPOINT_SIGNATURE_DOMAIN
          : RECEIPT_SIGNATURE_DOMAIN,
        input.digest,
      ),
      publicKey,
      signatureBytes,
    );
  } catch {
    return false;
  }
}

export function signCheckpointDigest(
  digest: ReceiptDigest,
  privateKeyInput: KeyObject | string | Buffer,
): { signature: string; publicJwk: PortablePublicJwk; keyId: ReceiptDigest } {
  const privateKey = asEd25519PrivateKey(privateKeyInput);
  const publicJwk = exportPortablePublicJwk(privateKey);
  return {
    signature: sign(
      null,
      signatureMessage(CHECKPOINT_SIGNATURE_DOMAIN, digest),
      privateKey,
    ).toString("base64url"),
    publicJwk,
    keyId: publicJwkFingerprint(publicJwk),
  };
}

function signatureMessage(domain: Buffer, digest: ReceiptDigest): Buffer {
  return Buffer.concat([
    domain,
    Buffer.from(digest.slice("sha256:".length), "hex"),
  ]);
}

function asEd25519PrivateKey(
  input: KeyObject | string | Buffer,
): KeyObject {
  const key = input instanceof KeyObject ? input : createPrivateKey(input);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Portable receipt signing key must be an Ed25519 private key");
  }
  return key;
}
