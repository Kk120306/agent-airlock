export type ReceiptDigest = `sha256:${string}`;

export type PortableDisposition =
  | "promoted"
  | "quarantined"
  | "discarded"
  | "cancelled";

export interface BuiltinResourceCommitment {
  kind: string;
  fingerprint: ReceiptDigest;
}

export interface ProviderResourceCommitment {
  providerId: string;
  resourceKind: string;
  versionId: string;
  fingerprint: ReceiptDigest;
}

export interface PortableStateCommitment {
  stateId: string;
  compositeHash: ReceiptDigest;
  builtinResources: BuiltinResourceCommitment[];
  providerResources: ProviderResourceCommitment[];
}

export interface PortableEvidenceLeaf {
  schemaVersion: 1;
  identity: string;
  category: "validation" | "resource" | "external-action" | "selection";
  status: "passed" | "failed" | "skipped" | "error" | "recorded";
  required: boolean;
  durationMs: number | null;
  summary: string | null;
  valueHash: ReceiptDigest;
}

export interface PortableEvidenceSibling {
  direction: "left" | "right";
  hash: ReceiptDigest;
}

export interface PortableEvidenceDisclosure {
  leaf: PortableEvidenceLeaf;
  leafIndex: number;
  totalLeaves: number;
  siblings: PortableEvidenceSibling[];
}

export interface PortablePromotionReceipt {
  protocol: {
    schema: "agent-airlock/portable-promotion-receipt";
    schemaVersion: 1;
    canonicalization: "RFC8785";
    digestAlgorithm: "SHA-256";
  };
  decision: {
    runId: string;
    agentId: string;
    disposition: PortableDisposition;
    decidedAt: string;
    clockClaim: "signer-clock-not-external-timestamp";
  };
  state: {
    before: PortableStateCommitment;
    after: PortableStateCommitment;
  };
  outcomeContract: {
    schemaVersion: number;
    version: number;
    digest: ReceiptDigest;
  };
  validationEvidence: {
    root: ReceiptDigest;
    leafCount: number;
    ordering: "canonical-identity-ascending";
  };
  externalActions: {
    commitment: ReceiptDigest;
    deliveredCount: number;
  };
  selection: {
    candidateSetId: string;
    decisionDigest: ReceiptDigest;
  } | null;
  assurance: {
    proposalId: string;
    contractVersion: number;
  } | null;
  ancestry: {
    rootRunId: string;
    parentRunId: string | null;
    depth: number;
    maxDepth: number;
    previousReceiptDigest: ReceiptDigest | null;
  };
}

export interface PortablePublicJwk {
  crv: "Ed25519";
  kty: "OKP";
  x: string;
}

export interface PortablePromotionEnvelope {
  schema: "agent-airlock/portable-promotion-envelope";
  schemaVersion: 1;
  receipt: PortablePromotionReceipt;
  receiptDigest: ReceiptDigest;
  signatureAlgorithm: "Ed25519";
  signature: string;
  keyId: ReceiptDigest;
  publicJwk: PortablePublicJwk;
  disclosures: PortableEvidenceDisclosure[];
}

export interface VerificationCheck {
  name: string;
  valid: boolean;
  detail: string;
}

export interface PortableVerificationReport {
  valid: boolean;
  checks: VerificationCheck[];
  receiptDigest: ReceiptDigest | null;
  keyId: ReceiptDigest | null;
  commitments: {
    resources: number;
    outcomeContract: boolean;
    validationEvidence: boolean;
    externalActions: boolean;
    selection: boolean;
    assurance: boolean;
    ancestry: boolean;
  };
  disclosures: Array<{
    identity: string;
    valid: boolean;
    detail: string;
  }>;
  provenClaims: string[];
  unsupportedClaims: string[];
}

export type SigningKeyTrustStatus = "active" | "retired" | "compromised";

export interface SigningKeyTrustRule {
  keyId: ReceiptDigest;
  status: SigningKeyTrustStatus;
  validFrom: string;
  validUntil: string | null;
  agentIds: string[];
  dispositions: PortableDisposition[];
  note: string | null;
}

export interface SigningKeyTrustPolicy {
  schema: "agent-airlock/signing-key-trust-policy";
  schemaVersion: 1;
  policyId: string;
  issuedAt: string;
  expiresAt: string | null;
  keys: SigningKeyTrustRule[];
}

export interface SignedSigningKeyTrustPolicyEnvelope {
  schema: "agent-airlock/signed-signing-key-trust-policy";
  schemaVersion: 1;
  policy: SigningKeyTrustPolicy;
  policyDigest: ReceiptDigest;
  signatureAlgorithm: "Ed25519";
  signature: string;
  authorityKeyId: ReceiptDigest;
  authorityPublicJwk: PortablePublicJwk;
}

export interface TrustPolicyVerificationReport {
  valid: boolean;
  cryptographicallyValid: boolean;
  authorityTrusted: boolean;
  checks: VerificationCheck[];
  policy: SigningKeyTrustPolicy | null;
  policyDigest: ReceiptDigest | null;
  authorityKeyId: ReceiptDigest | null;
}

export interface PolicyAuthorityRotation {
  schema: "agent-airlock/policy-authority-rotation";
  schemaVersion: 1;
  rotationId: string;
  issuedAt: string;
  effectiveAt: string;
  expiresAt: string | null;
  previousAuthorityKeyId: ReceiptDigest;
  nextAuthorityKeyId: ReceiptDigest;
  nextAuthorityPublicJwk: PortablePublicJwk;
}

export interface SignedPolicyAuthorityRotationEnvelope {
  schema: "agent-airlock/signed-policy-authority-rotation";
  schemaVersion: 1;
  rotation: PolicyAuthorityRotation;
  rotationDigest: ReceiptDigest;
  signatureAlgorithm: "Ed25519";
  signature: string;
  previousAuthorityPublicJwk: PortablePublicJwk;
}

export interface PolicyAuthorityRotationVerificationReport {
  valid: boolean;
  cryptographicallyValid: boolean;
  previousAuthorityTrusted: boolean;
  temporallyValid: boolean;
  checks: VerificationCheck[];
  rotation: PolicyAuthorityRotation | null;
  rotationDigest: ReceiptDigest | null;
  previousAuthorityKeyId: ReceiptDigest | null;
  nextAuthorityKeyId: ReceiptDigest | null;
}

export type OrganizationalTrustStatus =
  | "trusted"
  | "historically-trusted"
  | "untrusted"
  | "compromised"
  | "policy-not-yet-effective"
  | "policy-expired"
  | "outside-validity-window"
  | "scope-mismatch"
  | "cryptographic-proof-invalid";

export interface OrganizationalTrustReport {
  trusted: boolean;
  status: OrganizationalTrustStatus;
  policyId: string;
  keyId: ReceiptDigest;
  detail: string;
}

export interface PortableSigningKeyMaterial {
  privateKeyPem: string;
  publicJwk: PortablePublicJwk;
  keyId: ReceiptDigest;
}

export interface TransparencyEntry {
  schemaVersion: 1;
  sequence: number;
  receiptDigest: ReceiptDigest;
  priorEntryHash: ReceiptDigest | null;
  appendedAt: string;
  entryHash: ReceiptDigest;
}

export interface TransparencyCheckpoint {
  schema: "agent-airlock/portable-transparency-checkpoint";
  schemaVersion: 1;
  treeSize: number;
  root: ReceiptDigest;
  priorCheckpointDigest: ReceiptDigest | null;
  createdAt: string;
  keyId: ReceiptDigest;
}

export interface SignedTransparencyCheckpoint {
  checkpoint: TransparencyCheckpoint;
  checkpointDigest: ReceiptDigest;
  signatureAlgorithm: "Ed25519";
  signature: string;
  publicJwk: PortablePublicJwk;
}

export interface TransparencyInclusionProof {
  receiptDigest: ReceiptDigest;
  leafIndex: number;
  treeSize: number;
  siblings: PortableEvidenceSibling[];
}

export interface TransparencyConsistencyProof {
  fromSize: number;
  toSize: number;
  receiptDigests: ReceiptDigest[];
}

export interface TransparencyVerificationReport {
  valid: boolean;
  splitView: boolean;
  checks: VerificationCheck[];
}

export interface PortableTransparencyLogFile {
  schema: "agent-airlock/local-transparency-log";
  schemaVersion: 1;
  entries: TransparencyEntry[];
  checkpoints: SignedTransparencyCheckpoint[];
}

export interface OfflineEvmAnchorPayload {
  schema: "agent-airlock/offline-evm-anchor-payload";
  schemaVersion: 1;
  methodSignature: "anchor(bytes32)";
  functionSelector: string;
  receiptDigest: ReceiptDigest;
  calldata: string;
  privacyClaim: "receipt-digest-only";
  networkCalls: 0;
  fundsSpent: 0;
}

export interface PortableEvidencePacket {
  schema: "agent-airlock/portable-evidence-packet";
  schemaVersion: 1;
  envelope: PortablePromotionEnvelope;
  anchor: {
    checkpoint: SignedTransparencyCheckpoint;
    inclusionProof: TransparencyInclusionProof;
  } | null;
  evmPayload: OfflineEvmAnchorPayload | null;
}

export interface PortableEvidencePacketVerificationReport {
  valid: boolean;
  receipt: PortableVerificationReport;
  anchor: TransparencyVerificationReport | null;
  evmPayload: {
    valid: boolean;
    checks: VerificationCheck[];
  } | null;
  checks: VerificationCheck[];
}

export interface PortableDecisionChain {
  schema: "agent-airlock/portable-decision-chain";
  schemaVersion: 1;
  packets: PortableEvidencePacket[];
}

export interface PortableDecisionChainVerificationReport {
  valid: boolean;
  packets: PortableEvidencePacketVerificationReport[];
  checks: VerificationCheck[];
  leafReceiptDigest: ReceiptDigest | null;
}
