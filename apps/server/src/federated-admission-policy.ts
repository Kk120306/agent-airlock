import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  canonicalize,
  parseCanonicalJson,
  sha256Digest,
  verifyFederatedWorkBundle,
  type FederatedWorkBundle,
  type ReceiptDigest,
} from "@agent-airlock/portable-promotion-receipt";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ARTIFACT_SCHEMA = "agent-airlock/workspace-change-set";
const ARTIFACT_MEDIA_TYPE =
  "application/vnd.agent-airlock.workspace-change-set+json";
const MAXIMUM_POLICY_BYTES = 262_144;

export type FederatedTransparencyMode =
  | "not-required"
  | "inclusion-required"
  | "consistency-required";

export interface FederatedAdmissionSignerRule {
  keyId: ReceiptDigest;
  status: "active" | "retired" | "compromised";
  validFrom: string;
  validUntil: string | null;
}

export interface FederatedAdmissionProducerRule {
  producerId: string;
  disabled: boolean;
  authorityKeyIds: ReceiptDigest[];
  receiptSigners: FederatedAdmissionSignerRule[];
  receiptSchemaVersions: number[];
  artifactSchemas: string[];
  artifactMediaTypes: string[];
  agentAliases: string[];
  dispositions: Array<"promoted" | "quarantined" | "discarded" | "cancelled">;
  builtinResourceKinds: string[];
  providerIds: string[];
  providerResourceKinds: string[];
  ancestry: {
    requireCompleteChain: boolean;
    maximumDepth: number;
  };
  freshness: {
    maximumReceiptAgeSeconds: number;
    allowOffline: boolean;
    maximumOnlineHandoffAgeSeconds: number | null;
  };
  artifactLimits: {
    maximumBytes: number;
    digestAlgorithms: Array<"SHA-256">;
  };
  transparency: {
    mode: FederatedTransparencyMode;
    logKeyIds: ReceiptDigest[];
    pinnedCheckpointDigest: ReceiptDigest | null;
  };
  requireLocalApproval: boolean;
}

export interface FederatedAdmissionPolicy {
  schema: "agent-airlock/federated-admission-policy";
  schemaVersion: 1;
  policyId: string;
  generation: number;
  activatedAt: string;
  priorPolicyDigest: ReceiptDigest | null;
  receiverOrganizationId: string;
  producers: FederatedAdmissionProducerRule[];
}

export interface FederatedAdmissionEvidenceFacts {
  authorityKeyId: ReceiptDigest;
  authorityPinned: boolean;
  completeDecisionChain: boolean;
  evaluatedAt: string;
  onlineHandoff: null | {
    valid: boolean;
    issuedAt: string;
    expiresAt: string;
  };
  transparency: null | {
    included: boolean;
    consistent: boolean;
    splitView: boolean;
    logKeyId: ReceiptDigest;
    priorCheckpointDigest: ReceiptDigest | null;
  };
  localApprovalGranted: boolean;
}

export type FederatedAdmissionReason =
  | "admitted"
  | "bundle-invalid"
  | "policy-not-active"
  | "producer-untrusted"
  | "producer-disabled"
  | "authority-unpinned"
  | "signer-scope-mismatch"
  | "signer-compromised"
  | "signer-window-mismatch"
  | "protocol-not-allowed"
  | "artifact-type-not-allowed"
  | "agent-scope-mismatch"
  | "disposition-scope-mismatch"
  | "resource-scope-mismatch"
  | "ancestry-incomplete"
  | "ancestry-depth-exceeded"
  | "receipt-clock-invalid"
  | "receipt-stale"
  | "offline-transfer-not-allowed"
  | "online-handoff-invalid"
  | "artifact-size-exceeded"
  | "digest-algorithm-not-allowed"
  | "transparency-required"
  | "transparency-log-untrusted"
  | "transparency-base-missing"
  | "transparency-inconsistent"
  | "transparency-split-view"
  | "approval-required";

export interface FederatedAdmissionPolicyDecision {
  decision: "admit" | "reject" | "pending";
  reason: FederatedAdmissionReason;
  policyId: string;
  policyGeneration: number;
  policyDigest: ReceiptDigest;
  producerId: string;
  receiptDigest: ReceiptDigest;
  artifactDigest: ReceiptDigest;
  evaluatedAt: string;
  detail: string;
}

export function parseFederatedAdmissionPolicyJson(
  source: string,
  maximumBytes = MAXIMUM_POLICY_BYTES,
): FederatedAdmissionPolicy {
  const value = parseCanonicalJson(source, maximumBytes);
  assertFederatedAdmissionPolicy(value);
  return value;
}

export function digestFederatedAdmissionPolicy(
  policy: FederatedAdmissionPolicy,
): ReceiptDigest {
  assertFederatedAdmissionPolicy(policy);
  return sha256Digest(new TextEncoder().encode(canonicalize(policy)));
}

export function assertFederatedAdmissionPolicy(
  value: unknown,
): asserts value is FederatedAdmissionPolicy {
  const policy = asRecord(value, "Federated Admission Policy");
  assertExactKeys(
    policy,
    [
      "schema",
      "schemaVersion",
      "policyId",
      "generation",
      "activatedAt",
      "priorPolicyDigest",
      "receiverOrganizationId",
      "producers",
    ],
    "Federated Admission Policy",
  );
  if (
    policy.schema !== "agent-airlock/federated-admission-policy" ||
    policy.schemaVersion !== 1 ||
    !isIdentifier(policy.policyId) ||
    !Number.isSafeInteger(policy.generation) ||
    (policy.generation as number) < 1 ||
    !isTimestamp(policy.activatedAt) ||
    !(policy.priorPolicyDigest === null || isDigest(policy.priorPolicyDigest)) ||
    !isIdentifier(policy.receiverOrganizationId) ||
    !Array.isArray(policy.producers) ||
    policy.producers.length > 256
  ) {
    throw new Error("Federated Admission Policy identity or bounds are invalid");
  }
  const generation = policy.generation as number;
  if (
    (generation === 1 && policy.priorPolicyDigest !== null) ||
    (generation > 1 && policy.priorPolicyDigest === null)
  ) {
    throw new Error("Federated Admission Policy generation chain is invalid");
  }
  let previousProducerId = "";
  for (const rawRule of policy.producers) {
    const rule = validateProducerRule(rawRule);
    if (rule.producerId <= previousProducerId) {
      throw new Error("Federated Admission Policy producers must be unique and sorted");
    }
    previousProducerId = rule.producerId;
  }
  if (Buffer.byteLength(canonicalize(policy), "utf8") > MAXIMUM_POLICY_BYTES) {
    throw new Error("Federated Admission Policy exceeds the byte limit");
  }
}

export function evaluateFederatedAdmissionPolicy(input: {
  policy: FederatedAdmissionPolicy;
  producerId: string;
  bundle: FederatedWorkBundle;
  facts: FederatedAdmissionEvidenceFacts;
}): FederatedAdmissionPolicyDecision {
  assertFederatedAdmissionPolicy(input.policy);
  if (!isIdentifier(input.producerId)) {
    throw new Error("Federated producer identity is invalid");
  }
  if (!isTimestamp(input.facts.evaluatedAt)) {
    throw new Error("Federated admission evaluation time is invalid");
  }
  const bundleReport = verifyFederatedWorkBundle(input.bundle);
  const policyDigest = digestFederatedAdmissionPolicy(input.policy);
  const base = {
    policyId: input.policy.policyId,
    policyGeneration: input.policy.generation,
    policyDigest,
    producerId: input.producerId,
    receiptDigest: bundleReport.receiptDigest ?? input.bundle.receipt.receiptDigest,
    artifactDigest: bundleReport.artifactDigest ?? input.bundle.artifact.artifactDigest,
    evaluatedAt: input.facts.evaluatedAt,
  };
  const reject = (
    reason: Exclude<FederatedAdmissionReason, "admitted" | "approval-required">,
    detail: string,
  ): FederatedAdmissionPolicyDecision => ({
    ...base,
    decision: "reject",
    reason,
    detail,
  });
  if (!bundleReport.valid) {
    return reject("bundle-invalid", "The signed receipt and artifact bundle is invalid.");
  }
  const evaluatedAt = Date.parse(input.facts.evaluatedAt);
  if (evaluatedAt < Date.parse(input.policy.activatedAt)) {
    return reject("policy-not-active", "The selected policy generation is not active yet.");
  }
  const rule = input.policy.producers.find(
    (candidate) => candidate.producerId === input.producerId,
  );
  if (!rule) return reject("producer-untrusted", "No exact local producer rule exists.");
  if (rule.disabled) return reject("producer-disabled", "The local producer rule is disabled.");
  if (
    !input.facts.authorityPinned ||
    !rule.authorityKeyIds.includes(input.facts.authorityKeyId)
  ) {
    return reject("authority-unpinned", "The producer trust-policy authority is not locally pinned.");
  }
  const signer = rule.receiptSigners.find(
    (candidate) => candidate.keyId === input.bundle.receipt.keyId,
  );
  if (!signer) return reject("signer-scope-mismatch", "The receipt signer is outside the exact local scope.");
  if (signer.status === "compromised") {
    return reject("signer-compromised", "Current local policy marks the receipt signer compromised.");
  }
  const decidedAt = Date.parse(input.bundle.receipt.receipt.decision.decidedAt);
  if (
    decidedAt < Date.parse(signer.validFrom) ||
    (signer.validUntil !== null && decidedAt > Date.parse(signer.validUntil))
  ) {
    return reject("signer-window-mismatch", "The receipt decision falls outside the signer window.");
  }
  const artifactProtocol = input.bundle.artifact.artifact.protocol;
  if (
    !rule.receiptSchemaVersions.includes(input.bundle.receipt.schemaVersion) ||
    !rule.artifactSchemas.includes(artifactProtocol.schema)
  ) {
    return reject("protocol-not-allowed", "The receipt or artifact protocol is not explicitly allowed.");
  }
  if (!rule.artifactMediaTypes.includes(ARTIFACT_MEDIA_TYPE)) {
    return reject("artifact-type-not-allowed", "The workspace artifact media type is not explicitly allowed.");
  }
  const decision = input.bundle.receipt.receipt.decision;
  if (!rule.agentAliases.includes(decision.agentId)) {
    return reject("agent-scope-mismatch", "The receipt Agent alias is outside the local producer scope.");
  }
  if (!rule.dispositions.includes(decision.disposition)) {
    return reject("disposition-scope-mismatch", "The upstream disposition is outside the local producer scope.");
  }
  const after = input.bundle.receipt.receipt.state.after;
  if (
    after.builtinResources.some(
      (resource) => !rule.builtinResourceKinds.includes(resource.kind),
    ) ||
    after.providerResources.some(
      (resource) =>
        !rule.providerIds.includes(resource.providerId) ||
        !rule.providerResourceKinds.includes(resource.resourceKind),
    )
  ) {
    return reject("resource-scope-mismatch", "A committed resource is outside the exact local scope.");
  }
  const ancestry = input.bundle.receipt.receipt.ancestry;
  if (rule.ancestry.requireCompleteChain && !input.facts.completeDecisionChain) {
    return reject("ancestry-incomplete", "The local rule requires a complete Portable Decision Chain.");
  }
  if (ancestry.depth > rule.ancestry.maximumDepth) {
    return reject("ancestry-depth-exceeded", "The receipt ancestry exceeds the local depth bound.");
  }
  if (decidedAt > evaluatedAt) {
    return reject("receipt-clock-invalid", "The signer-clock decision time is later than receiver evaluation.");
  }
  if (evaluatedAt - decidedAt > rule.freshness.maximumReceiptAgeSeconds * 1_000) {
    return reject("receipt-stale", "The receipt exceeds the local freshness bound.");
  }
  if (input.facts.onlineHandoff === null) {
    if (!rule.freshness.allowOffline) {
      return reject("offline-transfer-not-allowed", "The local rule requires a receiver-issued online handoff.");
    }
  } else {
    const handoff = input.facts.onlineHandoff;
    const issuedAt = Date.parse(handoff.issuedAt);
    const expiresAt = Date.parse(handoff.expiresAt);
    const maximumAge = rule.freshness.maximumOnlineHandoffAgeSeconds;
    if (
      !handoff.valid ||
      !isTimestamp(handoff.issuedAt) ||
      !isTimestamp(handoff.expiresAt) ||
      maximumAge === null ||
      issuedAt > evaluatedAt ||
      expiresAt < evaluatedAt ||
      expiresAt - issuedAt > maximumAge * 1_000
    ) {
      return reject("online-handoff-invalid", "The receiver-issued online handoff is invalid or expired.");
    }
  }
  const artifactByteLength = Buffer.byteLength(
    canonicalize(input.bundle.artifact.artifact),
    "utf8",
  );
  if (artifactByteLength > rule.artifactLimits.maximumBytes) {
    return reject("artifact-size-exceeded", "The artifact exceeds the local byte bound.");
  }
  if (!rule.artifactLimits.digestAlgorithms.includes("SHA-256")) {
    return reject("digest-algorithm-not-allowed", "The artifact digest algorithm is not explicitly allowed.");
  }
  const transparency = input.facts.transparency;
  if (rule.transparency.mode !== "not-required") {
    if (!transparency?.included) {
      return reject("transparency-required", "The local rule requires valid transparency inclusion.");
    }
    if (!rule.transparency.logKeyIds.includes(transparency.logKeyId)) {
      return reject("transparency-log-untrusted", "The transparency log key is outside local scope.");
    }
    if (transparency.splitView) {
      return reject("transparency-split-view", "The presented checkpoint conflicts with receiver state.");
    }
    if (rule.transparency.mode === "consistency-required") {
      if (
        rule.transparency.pinnedCheckpointDigest === null ||
        transparency.priorCheckpointDigest === null
      ) {
        return reject("transparency-base-missing", "Consistency requires one receiver-pinned prior checkpoint.");
      }
      if (
        transparency.priorCheckpointDigest !==
          rule.transparency.pinnedCheckpointDigest ||
        !transparency.consistent
      ) {
        return reject("transparency-inconsistent", "The checkpoint does not extend the pinned receiver view.");
      }
    }
  }
  if (rule.requireLocalApproval && !input.facts.localApprovalGranted) {
    return {
      ...base,
      decision: "pending",
      reason: "approval-required",
      detail: "Every machine check passed, but local approval is still required.",
    };
  }
  return {
    ...base,
    decision: "admit",
    reason: "admitted",
    detail: "The bundle passed the exact receiver-controlled policy generation.",
  };
}

interface ActivePolicyPointer {
  schemaVersion: 1;
  policyId: string;
  generation: number;
  policyDigest: ReceiptDigest;
}

export class FederatedAdmissionPolicyStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.policyRoot(), { recursive: true, mode: 0o700 });
  }

  async installAndActivate(
    policy: FederatedAdmissionPolicy,
  ): Promise<{ policy: FederatedAdmissionPolicy; policyDigest: ReceiptDigest }> {
    let result!: { policy: FederatedAdmissionPolicy; policyDigest: ReceiptDigest };
    const operation = this.queue.then(async () => {
      assertFederatedAdmissionPolicy(policy);
      const policyDigest = digestFederatedAdmissionPolicy(policy);
      const current = await this.readActiveOrNull();
      if (current === null) {
        if (policy.generation !== 1 || policy.priorPolicyDigest !== null) {
          throw new Error("The first Federated Admission Policy must be generation 1");
        }
      } else if (
        policy.generation === current.policy.generation &&
        policyDigest === current.policyDigest
      ) {
        result = {
          policy: structuredClone(current.policy),
          policyDigest: current.policyDigest,
        };
        return;
      } else if (
        policy.policyId !== current.policy.policyId ||
        policy.receiverOrganizationId !== current.policy.receiverOrganizationId ||
        policy.generation !== current.policy.generation + 1 ||
        policy.priorPolicyDigest !== current.policyDigest
      ) {
        throw new Error("Federated Admission Policy does not extend the active generation");
      }
      const directory = this.policyDirectory(policy.policyId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = this.policyPath(policy.policyId, policy.generation, policyDigest);
      await this.publishImmutable(target, policy);
      const pointer: ActivePolicyPointer = {
        schemaVersion: 1,
        policyId: policy.policyId,
        generation: policy.generation,
        policyDigest,
      };
      await this.replaceActive(pointer);
      result = { policy: structuredClone(policy), policyDigest };
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async readActive(): Promise<{
    policy: FederatedAdmissionPolicy;
    policyDigest: ReceiptDigest;
  }> {
    const active = await this.readActiveOrNull();
    if (!active) throw new Error("No active Federated Admission Policy exists");
    return active;
  }

  async readGeneration(
    policyId: string,
    generation: number,
    policyDigest: ReceiptDigest,
  ): Promise<FederatedAdmissionPolicy> {
    if (!isIdentifier(policyId) || !Number.isSafeInteger(generation) || generation < 1 || !isDigest(policyDigest)) {
      throw new Error("Federated Admission Policy reference is invalid");
    }
    const source = await readFile(
      this.policyPath(policyId, generation, policyDigest),
      "utf8",
    );
    const policy = parseFederatedAdmissionPolicyJson(source);
    if (
      policy.policyId !== policyId ||
      policy.generation !== generation ||
      digestFederatedAdmissionPolicy(policy) !== policyDigest
    ) {
      throw new Error("Federated Admission Policy bytes contradict their reference");
    }
    return structuredClone(policy);
  }

  private async readActiveOrNull(): Promise<null | {
    policy: FederatedAdmissionPolicy;
    policyDigest: ReceiptDigest;
  }> {
    let source: string;
    try {
      source = await readFile(this.activePath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const pointer = JSON.parse(source) as ActivePolicyPointer;
    if (
      pointer.schemaVersion !== 1 ||
      !isIdentifier(pointer.policyId) ||
      !Number.isSafeInteger(pointer.generation) ||
      pointer.generation < 1 ||
      !isDigest(pointer.policyDigest) ||
      Object.keys(pointer).sort().join(",") !==
        ["generation", "policyDigest", "policyId", "schemaVersion"].sort().join(",")
    ) {
      throw new Error("Active Federated Admission Policy pointer is invalid");
    }
    const policy = await this.readGeneration(
      pointer.policyId,
      pointer.generation,
      pointer.policyDigest,
    );
    return { policy, policyDigest: pointer.policyDigest };
  }

  private async publishImmutable(
    target: string,
    value: FederatedAdmissionPolicy,
  ): Promise<void> {
    const source = canonicalize(value) + "\n";
    try {
      const existing = await readFile(target, "utf8");
      if (existing !== source) {
        throw new Error("Federated Admission Policy generation already exists with different bytes");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = path.join(path.dirname(target), `.policy-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
      await link(temporary, target);
      await syncDirectory(path.dirname(target));
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async replaceActive(pointer: ActivePolicyPointer): Promise<void> {
    const temporary = path.join(this.root, `.active-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    let closed = false;
    try {
      await handle.writeFile(canonicalize(pointer) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      closed = true;
      await rename(temporary, this.activePath());
      await syncDirectory(this.root);
    } catch (error) {
      if (!closed) await handle.close().catch(() => undefined);
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private policyRoot(): string {
    return path.join(this.root, "policies");
  }

  private policyDirectory(policyId: string): string {
    return path.join(this.policyRoot(), policyId);
  }

  private policyPath(
    policyId: string,
    generation: number,
    digest: ReceiptDigest,
  ): string {
    return path.join(
      this.policyDirectory(policyId),
      `${String(generation).padStart(8, "0")}-${digest.slice("sha256:".length)}.json`,
    );
  }

  private activePath(): string {
    return path.join(this.root, "active.json");
  }
}

function validateProducerRule(value: unknown): FederatedAdmissionProducerRule {
  const rule = asRecord(value, "Federated producer rule");
  assertExactKeys(
    rule,
    [
      "producerId",
      "disabled",
      "authorityKeyIds",
      "receiptSigners",
      "receiptSchemaVersions",
      "artifactSchemas",
      "artifactMediaTypes",
      "agentAliases",
      "dispositions",
      "builtinResourceKinds",
      "providerIds",
      "providerResourceKinds",
      "ancestry",
      "freshness",
      "artifactLimits",
      "transparency",
      "requireLocalApproval",
    ],
    "Federated producer rule",
  );
  if (
    !isIdentifier(rule.producerId) ||
    typeof rule.disabled !== "boolean" ||
    typeof rule.requireLocalApproval !== "boolean"
  ) {
    throw new Error("Federated producer rule identity is invalid");
  }
  assertSortedUnique(rule.authorityKeyIds, "Policy authority scope", isDigest, 64, false);
  assertSortedUnique(rule.receiptSchemaVersions, "Receipt schema scope", isPositiveInteger, 8, false);
  assertSortedUnique(rule.artifactSchemas, "Artifact schema scope", isProtocolIdentifier, 16, false);
  assertSortedUnique(rule.artifactMediaTypes, "Artifact media-type scope", isMediaType, 16, false);
  assertSortedUnique(rule.agentAliases, "Agent alias scope", isIdentifier, 256, false);
  assertSortedUnique(rule.dispositions, "Disposition scope", isDisposition, 4, false);
  assertSortedUnique(rule.builtinResourceKinds, "Built-in resource scope", isIdentifier, 256, true);
  assertSortedUnique(rule.providerIds, "Provider scope", isIdentifier, 256, true);
  assertSortedUnique(rule.providerResourceKinds, "Provider resource scope", isIdentifier, 256, true);
  if (!Array.isArray(rule.receiptSigners) || rule.receiptSigners.length === 0 || rule.receiptSigners.length > 256) {
    throw new Error("Federated receipt signer scope is invalid");
  }
  let previousKeyId = "";
  for (const rawSigner of rule.receiptSigners) {
    const signer = asRecord(rawSigner, "Federated receipt signer");
    assertExactKeys(signer, ["keyId", "status", "validFrom", "validUntil"], "Federated receipt signer");
    if (
      !isDigest(signer.keyId) ||
      !["active", "retired", "compromised"].includes(String(signer.status)) ||
      !isTimestamp(signer.validFrom) ||
      !(signer.validUntil === null || isTimestamp(signer.validUntil)) ||
      (signer.validUntil !== null && Date.parse(String(signer.validUntil)) <= Date.parse(String(signer.validFrom))) ||
      (signer.status === "retired" && signer.validUntil === null) ||
      String(signer.keyId) <= previousKeyId
    ) {
      throw new Error("Federated receipt signer rule is invalid or unsorted");
    }
    previousKeyId = String(signer.keyId);
  }
  validateNestedRule(rule);
  return rule as unknown as FederatedAdmissionProducerRule;
}

function validateNestedRule(rule: Record<string, unknown>): void {
  const ancestry = asRecord(rule.ancestry, "Federated ancestry rule");
  assertExactKeys(ancestry, ["requireCompleteChain", "maximumDepth"], "Federated ancestry rule");
  if (typeof ancestry.requireCompleteChain !== "boolean" || !Number.isSafeInteger(ancestry.maximumDepth) || (ancestry.maximumDepth as number) < 0 || (ancestry.maximumDepth as number) > 32) {
    throw new Error("Federated ancestry rule is invalid");
  }
  const freshness = asRecord(rule.freshness, "Federated freshness rule");
  assertExactKeys(freshness, ["maximumReceiptAgeSeconds", "allowOffline", "maximumOnlineHandoffAgeSeconds"], "Federated freshness rule");
  if (
    !Number.isSafeInteger(freshness.maximumReceiptAgeSeconds) ||
    (freshness.maximumReceiptAgeSeconds as number) < 1 ||
    (freshness.maximumReceiptAgeSeconds as number) > 31_536_000 ||
    typeof freshness.allowOffline !== "boolean" ||
    !(freshness.maximumOnlineHandoffAgeSeconds === null ||
      (Number.isSafeInteger(freshness.maximumOnlineHandoffAgeSeconds) &&
        (freshness.maximumOnlineHandoffAgeSeconds as number) >= 1 &&
        (freshness.maximumOnlineHandoffAgeSeconds as number) <= 86_400))
  ) {
    throw new Error("Federated freshness rule is invalid");
  }
  const limits = asRecord(rule.artifactLimits, "Federated artifact limits");
  assertExactKeys(limits, ["maximumBytes", "digestAlgorithms"], "Federated artifact limits");
  if (!Number.isSafeInteger(limits.maximumBytes) || (limits.maximumBytes as number) < 1 || (limits.maximumBytes as number) > 8_388_608) {
    throw new Error("Federated artifact byte limit is invalid");
  }
  assertSortedUnique(limits.digestAlgorithms, "Artifact digest scope", (value) => value === "SHA-256", 1, true);
  const transparency = asRecord(rule.transparency, "Federated transparency rule");
  assertExactKeys(transparency, ["mode", "logKeyIds", "pinnedCheckpointDigest"], "Federated transparency rule");
  if (!['not-required', 'inclusion-required', 'consistency-required'].includes(String(transparency.mode))) {
    throw new Error("Federated transparency mode is invalid");
  }
  assertSortedUnique(transparency.logKeyIds, "Transparency log scope", isDigest, 64, transparency.mode === "not-required");
  if (!(transparency.pinnedCheckpointDigest === null || isDigest(transparency.pinnedCheckpointDigest))) {
    throw new Error("Federated transparency checkpoint is invalid");
  }
  if (
    (transparency.mode === "consistency-required") !==
    (transparency.pinnedCheckpointDigest !== null)
  ) {
    throw new Error("Federated consistency mode requires exactly one pinned checkpoint");
  }
}

function assertSortedUnique(
  value: unknown,
  name: string,
  validate: (item: unknown) => boolean,
  maximum: number,
  allowEmpty: boolean,
): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maximum || !value.every(validate)) {
    throw new Error(`${name} is invalid`);
  }
  for (let index = 1; index < value.length; index += 1) {
    if (String(value[index - 1]) >= String(value[index])) {
      throw new Error(`${name} must be unique and sorted`);
    }
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isProtocolIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9./-]{0,127}$/.test(value);
}

function isMediaType(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 64;
}

function isDisposition(value: unknown): boolean {
  return ["promoted", "quarantined", "discarded", "cancelled"].includes(String(value));
}

function isDigest(value: unknown): value is ReceiptDigest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const FEDERATED_WORKSPACE_ARTIFACT_SCHEMA = ARTIFACT_SCHEMA;
export const FEDERATED_WORKSPACE_ARTIFACT_MEDIA_TYPE = ARTIFACT_MEDIA_TYPE;
