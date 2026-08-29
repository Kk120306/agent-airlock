import { describe, expect, it } from "vitest";
import { canonicalize, utf8Bytes } from "./canonical.js";
import { sha256Digest } from "./crypto.js";
import {
  buildModelArkExecutionProfileDisclosureSummary,
  MODELARK_EXECUTION_PROFILE_DISCLOSURE_SCHEMA,
  MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY,
  MODELARK_EXECUTION_PROFILE_SAFE_PROFILE,
  parseModelArkExecutionProfileDisclosureSummary,
  verifyModelArkExecutionProfileDisclosure,
  type ModelArkExecutionProfileDisclosureClaim,
} from "./modelark-execution-profile.js";
import type {
  PortableEvidenceDisclosure,
  ReceiptDigest,
} from "./types.js";

describe("ModelArk execution-profile disclosure", () => {
  it("builds a bounded canonical claim for the exact safe profile", () => {
    const summary = buildModelArkExecutionProfileDisclosureSummary(
      createAttestation(),
    );
    const expected = createClaim();

    expect(summary).toBe(canonicalize(expected));
    expect(utf8Bytes(summary).length).toBeLessThanOrEqual(500);
    expect(parseModelArkExecutionProfileDisclosureSummary(summary)).toEqual(
      expected,
    );
    expect(summary).not.toContain("https:");
    expect(summary).not.toContain("ep-");
  });

  it("publishes the deterministic identity of the core execution-profile Validation", () => {
    const expected =
      "validation:" +
      sha256Digest("core\u0000execution-profile").slice("sha256:".length);
    expect(MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY).toBe(expected);
  });

  it.each([
    ["schema version", (value: Record<string, unknown>) => (value.schemaVersion = 1)],
    ["attestation", (value: Record<string, unknown>) => (value.attestation = "provider")],
    ["inference mode", (value: Record<string, unknown>) => (value.inferenceMode = "fixture")],
    ["executor", (value: Record<string, unknown>) => (value.executor = "other")],
    ["Runtime", (value: Record<string, unknown>) => (value.runtimeProvider = "local-process")],
    ["protocol", (value: Record<string, unknown>) => (value.providerProtocol = "chat")],
  ])("rejects an unsafe attestation %s", (_label, mutate) => {
    const attestation = createAttestation() as unknown as Record<string, unknown>;
    mutate(attestation);
    expect(() =>
      buildModelArkExecutionProfileDisclosureSummary(attestation),
    ).toThrow(/safe profile/);
  });

  it("rejects unknown or missing attestation and preflight fields", () => {
    const extraAttestation = {
      ...createAttestation(),
      provider: "private-provider-value",
    };
    expect(() =>
      buildModelArkExecutionProfileDisclosureSummary(extraAttestation),
    ).toThrow(/unknown or missing fields/);

    const missingAttestation = createAttestation() as Record<string, unknown>;
    delete missingAttestation.executor;
    expect(() =>
      buildModelArkExecutionProfileDisclosureSummary(missingAttestation),
    ).toThrow(/unknown or missing fields/);

    const extraPreflight = createAttestation();
    (extraPreflight.preflight as Record<string, unknown>).rawEndpoint =
      "https://private.example";
    expect(() =>
      buildModelArkExecutionProfileDisclosureSummary(extraPreflight),
    ).toThrow(/unknown or missing fields/);
  });

  it("rejects noncanonical JSON and non-exact claim keys", () => {
    const summary = buildModelArkExecutionProfileDisclosureSummary(
      createAttestation(),
    );
    expect(() =>
      parseModelArkExecutionProfileDisclosureSummary(
        JSON.stringify(JSON.parse(summary), null, 2),
      ),
    ).toThrow(/not canonical JSON/);

    const extra = { ...createClaim(), extra: true };
    expect(() =>
      parseModelArkExecutionProfileDisclosureSummary(canonicalize(extra)),
    ).toThrow(/unknown or missing fields/);

    const missing = createClaim() as unknown as Record<string, unknown>;
    delete missing.checkedAt;
    expect(() =>
      parseModelArkExecutionProfileDisclosureSummary(canonicalize(missing)),
    ).toThrow(/unknown or missing fields/);
  });

  it.each([
    ["schema", { schema: "agent-airlock:other" }],
    ["schema version", { schemaVersion: 2 }],
    ["profile", { profile: "airlock-control-plane:modelark" }],
  ])("rejects an unsupported %s", (_label, replacement) => {
    expect(() =>
      parseModelArkExecutionProfileDisclosureSummary(
        canonicalize({ ...createClaim(), ...replacement }),
      ),
    ).toThrow(/unsupported/);
  });

  it.each([
    ["model without digest", { modelCommitment: "ep-private-model" }],
    ["uppercase model digest", { modelCommitment: digest("A") }],
    [
      "raw endpoint",
      { endpointOriginCommitment: "https://private.example" },
    ],
    ["offset timestamp", { checkedAt: "2026-08-26T08:00:00.000+08:00" }],
    ["invalid timestamp", { checkedAt: "2026-02-30T00:00:00.000Z" }],
    ["zero attempts", { attemptCount: 0 }],
    ["too many attempts", { attemptCount: 5 }],
    ["zero requests", { requestCount: 0 }],
    ["too many requests", { requestCount: 17 }],
    ["negative retry delay", { retryDelayMs: -1 }],
    ["excessive retry delay", { retryDelayMs: 15_001 }],
    ["non-integer count", { requestCount: "2" }],
    ["fewer requests than attempts", { attemptCount: 3, requestCount: 2 }],
  ])("rejects invalid claim values: %s", (_label, replacement) => {
    expect(() =>
      parseModelArkExecutionProfileDisclosureSummary(
        canonicalize({ ...createClaim(), ...replacement }),
      ),
    ).toThrow();
  });

  it("rejects unsafe preflight values before creating a disclosure", () => {
    const rawModel = createAttestation();
    rawModel.modelCommitment = "ep-private-model";
    expect(() =>
      buildModelArkExecutionProfileDisclosureSummary(rawModel),
    ).toThrow(/SHA-256 commitment/);

    const noGeneratedOutput = createAttestation();
    noGeneratedOutput.preflight.generatedAssistantOutput = false;
    expect(() =>
      buildModelArkExecutionProfileDisclosureSummary(noGeneratedOutput),
    ).toThrow(/generated assistant output/);

    const countDrift = createAttestation();
    countDrift.preflight.attemptCount = 3;
    countDrift.preflight.requestCount = 2;
    expect(() =>
      buildModelArkExecutionProfileDisclosureSummary(countDrift),
    ).toThrow(/lower than its attempt count/);
  });

  it("verifies exact leaf semantics within the signed decision-time window", () => {
    const disclosure = createDisclosure();
    expect(
      verifyModelArkExecutionProfileDisclosure(
        disclosure,
        "2026-08-26T02:00:00.000Z",
      ),
    ).toEqual(createClaim());

    const futureTolerance = createDisclosure();
    expect(
      verifyModelArkExecutionProfileDisclosure(
        futureTolerance,
        "2026-08-25T23:59:00.000Z",
      ),
    ).toEqual(createClaim());
  });

  it.each([
    ["identity", (leaf: PortableEvidenceDisclosure["leaf"]) => (leaf.identity = "validation:other")],
    ["category", (leaf: PortableEvidenceDisclosure["leaf"]) => (leaf.category = "resource")],
    ["status", (leaf: PortableEvidenceDisclosure["leaf"]) => (leaf.status = "recorded")],
    ["required flag", (leaf: PortableEvidenceDisclosure["leaf"]) => (leaf.required = false)],
    ["duration", (leaf: PortableEvidenceDisclosure["leaf"]) => (leaf.durationMs = 1)],
  ])("rejects a disclosure with the wrong leaf %s", (_label, mutate) => {
    const disclosure = createDisclosure();
    mutate(disclosure.leaf);
    expect(() =>
      verifyModelArkExecutionProfileDisclosure(
        disclosure,
        "2026-08-26T00:01:00.000Z",
      ),
    ).toThrow(/required safe Validation/);
  });

  it("rejects a missing summary and decision-time drift", () => {
    const missing = createDisclosure();
    missing.leaf.summary = null;
    expect(() =>
      verifyModelArkExecutionProfileDisclosure(
        missing,
        "2026-08-26T00:01:00.000Z",
      ),
    ).toThrow(/summary is missing/);

    expect(() =>
      verifyModelArkExecutionProfileDisclosure(
        createDisclosure(),
        "2026-08-26T02:00:00.001Z",
      ),
    ).toThrow(/decision-time window/);
    expect(() =>
      verifyModelArkExecutionProfileDisclosure(
        createDisclosure(),
        "2026-08-25T23:58:59.999Z",
      ),
    ).toThrow(/decision-time window/);
    expect(() =>
      verifyModelArkExecutionProfileDisclosure(
        createDisclosure(),
        "2026-08-26T08:00:00.000+08:00",
      ),
    ).toThrow(/canonical UTC timestamp/);
  });
});

function createAttestation() {
  return {
    schemaVersion: 2,
    attestation: "airlock-control-plane",
    inferenceMode: "modelark",
    executor: "codex-cli",
    runtimeProvider: "container",
    providerProtocol: "responses",
    modelCommitment: digest("a"),
    preflight: {
      checkedAt: "2026-08-26T00:00:00.000Z",
      generatedAssistantOutput: true,
      endpointOriginCommitment: digest("b"),
      attemptCount: 2,
      requestCount: 4,
      retryDelayMs: 4_000,
    },
  };
}

function createClaim(): ModelArkExecutionProfileDisclosureClaim {
  return {
    schema: MODELARK_EXECUTION_PROFILE_DISCLOSURE_SCHEMA,
    schemaVersion: 1,
    profile: MODELARK_EXECUTION_PROFILE_SAFE_PROFILE,
    modelCommitment: digest("a") as ReceiptDigest,
    checkedAt: "2026-08-26T00:00:00.000Z",
    endpointOriginCommitment: digest("b") as ReceiptDigest,
    attemptCount: 2,
    requestCount: 4,
    retryDelayMs: 4_000,
  };
}

function createDisclosure(): PortableEvidenceDisclosure {
  return {
    leaf: {
      schemaVersion: 1,
      identity: MODELARK_EXECUTION_PROFILE_EVIDENCE_IDENTITY,
      category: "validation",
      status: "passed",
      required: true,
      durationMs: 0,
      summary: buildModelArkExecutionProfileDisclosureSummary(
        createAttestation(),
      ),
      valueHash: digest("c") as ReceiptDigest,
    },
    leafIndex: 0,
    totalLeaves: 1,
    siblings: [],
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
