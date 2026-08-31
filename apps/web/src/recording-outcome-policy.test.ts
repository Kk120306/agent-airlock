import { describe, expect, it } from "vitest";
import type {
  PortableDecisionChain,
  PortablePromotionEnvelope,
  PortablePromotionReceipt,
  ReceiptDigest,
} from "@agent-airlock/portable-promotion-receipt";
import type { AgentRun, RunTransaction } from "./types";
import { valueForSelectedAgent } from "./agent-selection-policy";
import {
  advancesCanonicalState,
  beginRequestGeneration,
  deriveRecordingReplayHydration,
  getPortableProofDisplayState,
  hasDistinctRepairEffectKey,
  hasExactRecordingDecisionChain,
  hasExactRecordingEffect,
  hasExactRecordingResources,
  hasExactFreshRecordingRunIds,
  hasLocallyVerifiedPortableProof,
  hasRepairRecordingLineage,
  hasRootRecordingLineage,
  hasValidTerminalRecordingRun,
  invalidateRequestGeneration,
  isCurrentRequestGeneration,
  isPortableProofActionable,
  isSafeRecordingIdentifier,
  parseRecordingReplayRunIds,
  recordingResourceKinds,
} from "./recording-outcome-policy";

type TerminalRecordingRun = AgentRun & { transaction: RunTransaction };

describe("selected Agent state isolation", () => {
  const agentARun = { agentId: "agent-a", id: "run-a" };
  const agentACandidateSet = { agentId: "agent-a", id: "set-a" };

  it("hides Run and Candidate Set state as soon as selection changes", () => {
    expect(valueForSelectedAgent("agent-a", agentARun)).toBe(agentARun);
    expect(valueForSelectedAgent("agent-a", agentACandidateSet)).toBe(
      agentACandidateSet,
    );
    expect(valueForSelectedAgent("agent-b", agentARun)).toBeNull();
    expect(
      valueForSelectedAgent("agent-b", agentACandidateSet),
    ).toBeNull();
    expect(valueForSelectedAgent(null, agentARun)).toBeNull();
    expect(valueForSelectedAgent(null, agentACandidateSet)).toBeNull();
  });
});

const beforeHash = "sha256:" + "1".repeat(64);
const afterHash = "sha256:" + "2".repeat(64);
const repairedHash = "sha256:" + "3".repeat(64);
const recordingProtocolValidationCommand = [
  'test "$(cat protocol-proof.txt)" = candidate-only',
  "node --no-warnings --experimental-sqlite --input-type=module -e 'import { DatabaseSync } from \"node:sqlite\"; const database = new DatabaseSync(\".airlock/demo.sqlite\"); const row = database.prepare(\"SELECT value FROM inventory WHERE id = ?\").get(\"demo\"); database.close(); if (row?.value !== \"candidate-only\") process.exit(1);'",
].join(" && ");
const recordingOutcomeContract = {
  schemaVersion: 1,
  version: 1,
  requiredPaths: ["AGENTS.md", "protocol-proof.txt"],
  protectedPaths: ["AGENTS.md"],
  maxChangedFiles: 4,
  maxAddedBytes: 65_536,
  secretPatterns: [],
  validationCommands: [
    {
      name: "protocol-content",
      command: recordingProtocolValidationCommand,
      required: true,
      timeoutMs: 10_000,
    },
  ],
  createdAt: "2026-08-27T00:00:00.000Z",
} as RunTransaction["outcomeContract"];

function digest(character: string): ReceiptDigest {
  return `sha256:${character.repeat(64)}`;
}

function recordingTransaction({
  disposition = "promoted",
  effectId = "protocol-release-ready",
  effectStatus = "delivered",
  effectKey = "effect-key",
  deliveredAt = "2026-08-28T00:00:01.000Z",
  includePromotionEvents = effectStatus === "delivered",
}: {
  disposition?: "promoted" | "quarantined";
  effectId?: string;
  effectStatus?: "delivered" | "rejected";
  effectKey?: string;
  deliveredAt?: string | null;
  includePromotionEvents?: boolean;
} = {}): RunTransaction {
  const candidateValue =
    disposition === "quarantined" ? "unsafe-candidate" : "candidate-only";
  return {
    id: "run-safe",
    status: disposition,
    disposition,
    outcomeContractVersion: 1,
    outcomeContract: recordingOutcomeContract,
    canonicalStateIdBefore: "state-before",
    canonicalStateIdAfter:
      disposition === "promoted" ? "state-after" : "state-before",
    canonicalContentHashBefore: beforeHash,
    canonicalContentHashAfter:
      disposition === "promoted" ? afterHash : beforeHash,
    resources: resources(disposition),
    changes: {
      files: [
        {
          path: "protocol-proof.txt",
          kind: "added",
          addedBytes: 14,
        },
      ],
      totalChangedFiles: 1,
      totalAddedBytes: 14,
      truncated: false,
    },
    validations: [
      {
        name: "command:protocol-content",
        status: disposition === "quarantined" ? "failed" : "passed",
        required: true,
        summary: "Protocol content checked",
        durationMs: 1,
        output: null,
      },
    ],
    sqlite: {
      databasePath: ".airlock/demo.sqlite",
      integrity: "passed",
      before: null,
      candidate: {
        contentHash: digest("6"),
        rowCount: 1,
        rows: [
          {
            id: "demo",
            value: candidateValue,
            updatedAt: "2026-08-28T00:00:00.000Z",
          },
        ],
      },
      after: {
        contentHash: disposition === "quarantined" ? afterHash : repairedHash,
        rowCount: 1,
        rows: [
          {
            id: "demo",
            value: "candidate-only",
            updatedAt: "2026-08-28T00:00:02.000Z",
          },
        ],
      },
    },
    externalActions: {
      outboxPath: ".airlock/external-actions.jsonl",
      intents: [
        {
          id: effectId,
          type: "demo.notification.requested",
          destination: "demo://protocol-proof",
          subject: effectId,
          idempotencyKey: effectKey,
          status: effectStatus,
          deliveredAt,
        },
      ],
      deliveredCount: effectStatus === "delivered" ? 1 : 0,
      bypassDisclosure: "No mutable external channel was available.",
    },
    events: includePromotionEvents
      ? [
          {
            status: "promoting",
            at: "2026-08-28T00:00:00.000Z",
            summary: "Promoting",
          },
          {
            status: "promoting",
            at: "2026-08-28T00:00:00.500Z",
            summary:
              "Canonical State advanced before external action delivery",
          },
          {
            status: "promoted",
            at: "2026-08-28T00:00:02.000Z",
            summary: "Promoted",
          },
        ]
      : [
          {
            status: "quarantined",
            at: "2026-08-28T00:00:02.000Z",
            summary: "Quarantined",
          },
        ],
    lineage: {
      rootRunId: "run-safe",
      parentRunId: null,
      depth: 0,
      maxDepth: 2,
    },
    recovery: {
      journalPhase: disposition === "promoted" ? "completed" : null,
      recoveredAfterRestart: false,
      recoveryError: null,
    },
  } as RunTransaction;
}

function recordingRun({
  id = "run-safe",
  agentId = "agent-safe",
  candidateSetId = null,
  competitorId = null,
  createdAt = "2026-08-28T00:00:00.000Z",
  transaction = recordingTransaction(),
}: {
  id?: string;
  agentId?: string;
  candidateSetId?: string | null;
  competitorId?: string | null;
  createdAt?: string;
  transaction?: RunTransaction;
} = {}): TerminalRecordingRun {
  return {
    id,
    agentId,
    candidateSetId,
    competitorId,
    createdAt,
    status: "completed",
    transaction: { ...transaction, id },
  } as TerminalRecordingRun;
}

function withRecordingReceipt(
  run: TerminalRecordingRun,
): TerminalRecordingRun {
  const transaction = run.transaction;
  return {
    ...run,
    transaction: {
      ...transaction,
      promotionReceipt: {
        runTransactionId: transaction.id,
        disposition: transaction.disposition!,
        outcomeContractVersion: transaction.outcomeContractVersion,
        canonicalStateIdBefore: transaction.canonicalStateIdBefore,
        canonicalStateIdAfter: transaction.canonicalStateIdAfter!,
        canonicalContentHashBefore: transaction.canonicalContentHashBefore,
        canonicalContentHashAfter: transaction.canonicalContentHashAfter!,
        validationEvidenceHash: digest("a"),
        lineage: { ...transaction.lineage },
        createdAt: run.createdAt,
      },
    },
  };
}

function recordingReplayRuns(): {
  safe: TerminalRecordingRun;
  unsafe: TerminalRecordingRun;
  repaired: TerminalRecordingRun;
} {
  const safe = recordingRun({
    createdAt: "2026-08-28T00:00:00.000Z",
  });
  const unsafe = recordingRun({
    id: "run-unsafe",
    createdAt: "2026-08-28T00:00:01.000Z",
    transaction: {
      ...recordingTransaction({
        disposition: "quarantined",
        effectId: "protocol-unsafe",
        effectStatus: "rejected",
        effectKey: "unsafe-key",
        deliveredAt: null,
      }),
      canonicalStateIdBefore: "state-after",
      canonicalStateIdAfter: "state-after",
      canonicalContentHashBefore: afterHash,
      canonicalContentHashAfter: afterHash,
      lineage: {
        rootRunId: "run-unsafe",
        parentRunId: null,
        depth: 0,
        maxDepth: 2,
      },
    },
  });
  const repaired = recordingRun({
    id: "run-repair",
    createdAt: "2026-08-28T00:00:02.000Z",
    transaction: {
      ...recordingTransaction({
        effectId: "protocol-repair-ready",
        effectKey: "repair-key",
      }),
      canonicalStateIdBefore: "state-after",
      canonicalStateIdAfter: "state-repaired",
      canonicalContentHashBefore: afterHash,
      canonicalContentHashAfter: repairedHash,
      changes: {
        files: [
          {
            path: ".airlock/demo.sqlite",
            kind: "modified",
            addedBytes: 0,
          },
        ],
        totalChangedFiles: 1,
        totalAddedBytes: 0,
        truncated: false,
      },
      lineage: {
        rootRunId: "run-unsafe",
        parentRunId: "run-unsafe",
        depth: 1,
        maxDepth: 2,
      },
    },
  });
  return {
    safe: withRecordingReceipt(safe),
    unsafe: withRecordingReceipt(unsafe),
    repaired: withRecordingReceipt(repaired),
  };
}

function recordingReceipt(
  run: TerminalRecordingRun,
  disposition: "promoted" | "quarantined",
  previousReceiptDigest: ReceiptDigest | null,
): PortablePromotionReceipt {
  const transaction = run.transaction;
  return {
    protocol: {
      schema: "agent-airlock/portable-promotion-receipt",
      schemaVersion: 1,
      canonicalization: "RFC8785",
      digestAlgorithm: "SHA-256",
    },
    decision: {
      runId: run.id,
      agentId: run.agentId,
      disposition,
      decidedAt: run.createdAt,
      clockClaim: "signer-clock-not-external-timestamp",
    },
    state: {
      before: {
        stateId: transaction.canonicalStateIdBefore,
        compositeHash: transaction.canonicalContentHashBefore as ReceiptDigest,
        builtinResources: [],
        providerResources: [],
      },
      after: {
        stateId: transaction.canonicalStateIdAfter!,
        compositeHash: transaction.canonicalContentHashAfter! as ReceiptDigest,
        builtinResources: [],
        providerResources: [],
      },
    },
    outcomeContract: {
      schemaVersion: 1,
      version: 1,
      digest: digest("6"),
    },
    validationEvidence: {
      root: digest("7"),
      leafCount: 1,
      ordering: "canonical-identity-ascending",
    },
    externalActions: {
      commitment: digest("8"),
      deliveredCount: transaction.externalActions.deliveredCount,
    },
    selection: null,
    assurance: null,
    ancestry: {
      ...transaction.lineage,
      previousReceiptDigest,
    },
  };
}

function recordingEnvelope(
  receipt: PortablePromotionReceipt,
  receiptDigest: ReceiptDigest,
): PortablePromotionEnvelope {
  return {
    schema: "agent-airlock/portable-promotion-envelope",
    schemaVersion: 1,
    receipt,
    receiptDigest,
    signatureAlgorithm: "Ed25519",
    signature: "test-signature",
    keyId: digest("9"),
    publicJwk: { crv: "Ed25519", kty: "OKP", x: "test-public-key" },
    disclosures: [],
  };
}

function recordingDecisionChain(
  unsafe: TerminalRecordingRun,
  repaired: TerminalRecordingRun,
): PortableDecisionChain {
  const parentDigest = digest("4");
  return {
    schema: "agent-airlock/portable-decision-chain",
    schemaVersion: 1,
    packets: [
      {
        schema: "agent-airlock/portable-evidence-packet",
        schemaVersion: 1,
        envelope: recordingEnvelope(
          recordingReceipt(unsafe, "quarantined", null),
          parentDigest,
        ),
        anchor: null,
        evmPayload: null,
      },
      {
        schema: "agent-airlock/portable-evidence-packet",
        schemaVersion: 1,
        envelope: recordingEnvelope(
          recordingReceipt(repaired, "promoted", parentDigest),
          digest("5"),
        ),
        anchor: null,
        evmPayload: null,
      },
    ],
  };
}

function transactionWithResources(
  resources: RunTransaction["resources"],
): RunTransaction {
  return {
    resources,
    canonicalStateIdBefore: "state-before",
    canonicalStateIdAfter: "state-after",
    canonicalContentHashBefore: "sha256:before",
    canonicalContentHashAfter: "sha256:after",
  } as RunTransaction;
}

function resources(
  disposition: "promoted" | "quarantined",
): RunTransaction["resources"] {
  return recordingResourceKinds.map((kind) => ({
    kind,
    label: kind,
    disposition,
    fingerprintBefore: null,
    fingerprintAfter: null,
    summary: kind,
  }));
}

describe("portable proof local verification", () => {
  it("requires both the server self-check and browser verifier", () => {
    expect(
      hasLocallyVerifiedPortableProof({
        serverVerificationValid: true,
        browserVerificationValid: true,
        dirty: false,
      }),
    ).toBe(true);
    expect(
      hasLocallyVerifiedPortableProof({
        serverVerificationValid: true,
        browserVerificationValid: false,
        dirty: false,
      }),
    ).toBe(false);
    expect(
      hasLocallyVerifiedPortableProof({
        serverVerificationValid: false,
        browserVerificationValid: true,
        dirty: false,
      }),
    ).toBe(false);
    expect(
      hasLocallyVerifiedPortableProof({
        serverVerificationValid: true,
        browserVerificationValid: null,
        dirty: false,
      }),
    ).toBe(false);
    expect(
      hasLocallyVerifiedPortableProof({
        serverVerificationValid: true,
        browserVerificationValid: true,
        dirty: true,
      }),
    ).toBe(false);
  });

  it("distinguishes in-flight and stale proofs from failed proofs", () => {
    expect(
      getPortableProofDisplayState({
        hasResult: true,
        verificationValid: false,
        busy: true,
        dirty: false,
      }),
    ).toBe("verifying");
    expect(
      getPortableProofDisplayState({
        hasResult: true,
        verificationValid: false,
        busy: false,
        dirty: true,
      }),
    ).toBe("stale");
    expect(
      getPortableProofDisplayState({
        hasResult: true,
        verificationValid: false,
        busy: false,
        dirty: false,
      }),
    ).toBe("failed");
    expect(
      getPortableProofDisplayState({
        hasResult: true,
        verificationValid: true,
        busy: false,
        dirty: false,
      }),
    ).toBe("verified");
    expect(
      getPortableProofDisplayState({
        hasResult: false,
        verificationValid: true,
        busy: false,
        dirty: false,
      }),
    ).toBe("empty");

    expect(isPortableProofActionable("verified")).toBe(true);
    expect(isPortableProofActionable("verifying")).toBe(false);
    expect(isPortableProofActionable("stale")).toBe(false);
    expect(isPortableProofActionable("failed")).toBe(false);
  });

  it("accepts only the latest async completion and fails closed on teardown", async () => {
    const state = { current: 0 };
    const older = beginRequestGeneration(state);
    const newer = beginRequestGeneration(state);
    const committed: string[] = [];
    let releaseOlder!: () => void;
    let releaseNewer!: () => void;
    const olderResult = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const newerResult = new Promise<void>((resolve) => {
      releaseNewer = resolve;
    });
    const commitWhenCurrent = async (
      generation: number,
      value: string,
      completion: Promise<void>,
    ) => {
      await completion;
      if (isCurrentRequestGeneration(state, generation)) {
        committed.push(value);
      }
    };
    const olderCompletion = commitWhenCurrent(older, "older", olderResult);
    const newerCompletion = commitWhenCurrent(newer, "newer", newerResult);

    expect(isCurrentRequestGeneration(state, older)).toBe(false);
    expect(isCurrentRequestGeneration(state, newer)).toBe(true);

    releaseNewer();
    await newerCompletion;
    releaseOlder();
    await olderCompletion;
    expect(committed).toEqual(["newer"]);

    let releaseUnmounted!: () => void;
    const unmountedResult = new Promise<void>((resolve) => {
      releaseUnmounted = resolve;
    });
    const unmounted = beginRequestGeneration(state);
    const unmountedCompletion = commitWhenCurrent(
      unmounted,
      "unmounted",
      unmountedResult,
    );
    invalidateRequestGeneration(state);
    releaseUnmounted();
    await unmountedCompletion;
    expect(isCurrentRequestGeneration(state, unmounted)).toBe(false);
    expect(committed).toEqual(["newer"]);
  });
});

describe("recording outcome fail-closed policy", () => {
  it("binds the verified two-packet chain to the displayed Quarantine and Repair", () => {
    const { unsafe, repaired } = recordingReplayRuns();
    const chain = recordingDecisionChain(unsafe, repaired);

    expect(
      hasExactRecordingDecisionChain(
        chain,
        unsafe,
        repaired,
        chain.packets[1]!.envelope.receiptDigest,
      ),
    ).toBe(true);
  });

  it("rejects contradictory receipt dispositions", () => {
    const { unsafe, repaired } = recordingReplayRuns();
    const chain = recordingDecisionChain(unsafe, repaired);
    chain.packets[0]!.envelope.receipt.decision.disposition = "promoted";

    expect(
      hasExactRecordingDecisionChain(
        chain,
        unsafe,
        repaired,
        chain.packets[1]!.envelope.receiptDigest,
      ),
    ).toBe(false);
  });

  it("rejects any Canonical State identifier or content-hash contradiction", () => {
    const { unsafe, repaired } = recordingReplayRuns();
    const mutations: Array<(chain: PortableDecisionChain) => void> = [
      (chain) => {
        chain.packets[0]!.envelope.receipt.state.before.stateId = "wrong-state";
      },
      (chain) => {
        chain.packets[0]!.envelope.receipt.state.before.compositeHash =
          digest("a");
      },
      (chain) => {
        chain.packets[0]!.envelope.receipt.state.after.stateId = "wrong-state";
      },
      (chain) => {
        chain.packets[0]!.envelope.receipt.state.after.compositeHash =
          digest("b");
      },
      (chain) => {
        chain.packets[1]!.envelope.receipt.state.before.stateId = "wrong-state";
      },
      (chain) => {
        chain.packets[1]!.envelope.receipt.state.before.compositeHash =
          digest("c");
      },
      (chain) => {
        chain.packets[1]!.envelope.receipt.state.after.stateId = "wrong-state";
      },
      (chain) => {
        chain.packets[1]!.envelope.receipt.state.after.compositeHash =
          digest("d");
      },
    ];

    for (const mutate of mutations) {
      const chain = recordingDecisionChain(unsafe, repaired);
      mutate(chain);
      expect(
        hasExactRecordingDecisionChain(
          chain,
          unsafe,
          repaired,
          chain.packets[1]!.envelope.receiptDigest,
        ),
      ).toBe(false);
    }
  });

  it("rejects contradictory root, parent, prior-digest, and leaf-digest links", () => {
    const { unsafe, repaired } = recordingReplayRuns();
    const mutations: Array<(chain: PortableDecisionChain) => void> = [
      (chain) => {
        chain.packets[0]!.envelope.receipt.ancestry.rootRunId = "wrong-root";
      },
      (chain) => {
        chain.packets[0]!.envelope.receipt.ancestry.previousReceiptDigest =
          digest("a");
      },
      (chain) => {
        chain.packets[1]!.envelope.receipt.ancestry.rootRunId = "wrong-root";
      },
      (chain) => {
        chain.packets[1]!.envelope.receipt.ancestry.parentRunId =
          "wrong-parent";
      },
      (chain) => {
        chain.packets[1]!.envelope.receipt.ancestry.previousReceiptDigest =
          digest("b");
      },
    ];

    for (const mutate of mutations) {
      const chain = recordingDecisionChain(unsafe, repaired);
      mutate(chain);
      expect(
        hasExactRecordingDecisionChain(
          chain,
          unsafe,
          repaired,
          chain.packets[1]!.envelope.receiptDigest,
        ),
      ).toBe(false);
    }

    const chain = recordingDecisionChain(unsafe, repaired);
    expect(
      hasExactRecordingDecisionChain(
        chain,
        unsafe,
        repaired,
        digest("f"),
      ),
    ).toBe(false);
  });

  it("fails closed when a required receipt field is missing at runtime", () => {
    const { unsafe, repaired } = recordingReplayRuns();
    const malformedChains = [
      (() => {
        const chain = recordingDecisionChain(unsafe, repaired);
        delete (
          chain.packets[0]!.envelope.receipt as unknown as { state?: unknown }
        ).state;
        return chain;
      })(),
      (() => {
        const chain = recordingDecisionChain(unsafe, repaired);
        delete (chain as unknown as { packets?: unknown }).packets;
        return chain;
      })(),
      (() => {
        const chain = recordingDecisionChain(unsafe, repaired);
        delete (chain.packets[1] as unknown as { envelope?: unknown }).envelope;
        return chain;
      })(),
    ];

    for (const chain of malformedChains) {
      expect(() =>
        hasExactRecordingDecisionChain(
          chain,
          unsafe,
          repaired,
          digest("5"),
        ),
      ).not.toThrow();
      expect(
        hasExactRecordingDecisionChain(
          chain,
          unsafe,
          repaired,
          digest("5"),
        ),
      ).toBe(false);
    }
  });

  it("preserves a bare recording query without requesting replay", () => {
    expect(parseRecordingReplayRunIds("?recording=1")).toEqual({
      kind: "absent",
    });
  });

  it("accepts exactly one safe, unsafe, and Repair Run identifier", () => {
    expect(
      parseRecordingReplayRunIds(
        "?recording=1&recordingSafeRunId=run-safe&recordingUnsafeRunId=run-unsafe&recordingRepairRunId=run-repair",
      ),
    ).toEqual({
      kind: "valid",
      runIds: {
        safeRunId: "run-safe",
        unsafeRunId: "run-unsafe",
        repairedRunId: "run-repair",
      },
    });
  });

  it("rejects partial, repeated, malformed, and duplicate replay values", () => {
    expect(
      parseRecordingReplayRunIds(
        "?recordingSafeRunId=run-safe&recordingUnsafeRunId=run-unsafe",
      ),
    ).toEqual({ kind: "invalid" });
    expect(
      parseRecordingReplayRunIds(
        "?recordingSafeRunId=run-safe&recordingSafeRunId=run-other&recordingUnsafeRunId=run-unsafe&recordingRepairRunId=run-repair",
      ),
    ).toEqual({ kind: "invalid" });
    expect(
      parseRecordingReplayRunIds(
        "?recordingSafeRunId=run%20safe&recordingUnsafeRunId=run-unsafe&recordingRepairRunId=run-repair",
      ),
    ).toEqual({ kind: "invalid" });
    expect(
      parseRecordingReplayRunIds(
        "?recordingSafeRunId=run-safe&recordingUnsafeRunId=run-safe&recordingRepairRunId=run-repair",
      ),
    ).toEqual({ kind: "invalid" });
  });

  it("hydrates replay identity from exactly three verified ordinary Runs", () => {
    const { safe, unsafe, repaired } = recordingReplayRuns();
    const candidateSetRun = recordingRun({
      id: "candidate-set-run",
      candidateSetId: "candidate-set-1",
      competitorId: "competitor-1",
    });
    const selection = parseRecordingReplayRunIds(
      "?recordingSafeRunId=run-safe&recordingUnsafeRunId=run-unsafe&recordingRepairRunId=run-repair",
    );

    const hydration = deriveRecordingReplayHydration(
      [repaired, unsafe, safe, candidateSetRun],
      selection,
    );

    expect(hydration).toMatchObject({
      agentId: "agent-safe",
      baselineRunIds: ["candidate-set-run"],
      canonicalStateId: "state-before",
      runIds: {
        safeRunId: "run-safe",
        unsafeRunId: "run-unsafe",
        repairedRunId: "run-repair",
      },
    });
    expect(hydration?.repairedRun).toBe(repaired);
  });

  it("rejects unknown Runs, extra ordinary Runs, and incoherent replay lineage", () => {
    const { safe, unsafe, repaired } = recordingReplayRuns();
    const selection = parseRecordingReplayRunIds(
      "?recordingSafeRunId=run-safe&recordingUnsafeRunId=run-unsafe&recordingRepairRunId=run-repair",
    );
    const unknownSelection = parseRecordingReplayRunIds(
      "?recordingSafeRunId=unknown-safe&recordingUnsafeRunId=unknown-unsafe&recordingRepairRunId=unknown-repair",
    );
    expect(
      deriveRecordingReplayHydration(
        [repaired, unsafe, safe],
        unknownSelection,
      ),
    ).toBeNull();
    expect(
      deriveRecordingReplayHydration(
        [
          repaired,
          unsafe,
          safe,
          recordingRun({ id: "unexpected-ordinary-run" }),
        ],
        selection,
      ),
    ).toBeNull();
    expect(
      deriveRecordingReplayHydration(
        [
          {
            ...repaired,
            transaction: {
              ...repaired.transaction,
              lineage: {
                ...repaired.transaction.lineage,
                parentRunId: safe.id,
              },
            },
          },
          unsafe,
          safe,
        ],
        selection,
      ),
    ).toBeNull();
  });

  it("rejects replay Runs without exact export receipt evidence", () => {
    const replay = recordingReplayRuns();
    const selection = parseRecordingReplayRunIds(
      "?recordingSafeRunId=run-safe&recordingUnsafeRunId=run-unsafe&recordingRepairRunId=run-repair",
    );

    for (const missing of ["safe", "unsafe", "repaired"] as const) {
      const runs = [replay.repaired, replay.unsafe, replay.safe].map((run) =>
        run === replay[missing]
          ? {
              ...run,
              transaction: { ...run.transaction, promotionReceipt: null },
            }
          : run,
      );
      expect(deriveRecordingReplayHydration(runs, selection)).toBeNull();
    }
  });

  it("rejects exact-fact replay drift before portable receipt export", () => {
    const selection = parseRecordingReplayRunIds(
      "?recordingSafeRunId=run-safe&recordingUnsafeRunId=run-unsafe&recordingRepairRunId=run-repair",
    );
    const mutations: Array<
      [string, (replay: ReturnType<typeof recordingReplayRuns>) => void]
    > = [
      ["safe required Validation", (replay) => {
        replay.safe.transaction.validations[0]!.status = "failed";
      }],
      ["safe named protocol Validation", (replay) => {
        replay.safe.transaction.validations[0]!.name = "command:other";
      }],
      ["unsafe decisive Validation", (replay) => {
        replay.unsafe.transaction.validations[0]!.name = "command:other";
      }],
      ["missing Repair protocol Validation", (replay) => {
        replay.repaired.transaction.validations = [];
      }],
      ["renamed Repair protocol Validation", (replay) => {
        replay.repaired.transaction.validations[0]!.name = "command:other";
      }],
      ["non-required Repair protocol Validation", (replay) => {
        replay.repaired.transaction.validations[0]!.required = false;
      }],
      ["failed Repair protocol Validation", (replay) => {
        replay.repaired.transaction.validations[0]!.status = "failed";
      }],
      ["Outcome Contract content", (replay) => {
        replay.repaired.transaction.outcomeContract = {
          ...replay.repaired.transaction.outcomeContract,
          maxChangedFiles:
            replay.repaired.transaction.outcomeContract.maxChangedFiles + 1,
        };
      }],
      ["coherent Outcome Contract policy drift", (replay) => {
        for (const run of [replay.safe, replay.unsafe, replay.repaired]) {
          run.transaction.outcomeContract = {
            ...run.transaction.outcomeContract,
            maxChangedFiles: 5,
          };
        }
      }],
      ["Outcome Contract object version drift", (replay) => {
        for (const run of [replay.safe, replay.unsafe, replay.repaired]) {
          run.transaction.outcomeContract = {
            ...run.transaction.outcomeContract,
            version: 2,
          };
        }
      }],
      ["Outcome Contract shape drift", (replay) => {
        for (const run of [replay.safe, replay.unsafe, replay.repaired]) {
          run.transaction.outcomeContract = {
            ...run.transaction.outcomeContract,
            unexpectedPolicyField: true,
          } as RunTransaction["outcomeContract"];
        }
      }],
      ["resource set", (replay) => {
        replay.unsafe.transaction.resources.pop();
      }],
      ["safe protocol change", (replay) => {
        replay.safe.transaction.changes!.files[0]!.path = "other.txt";
      }],
      ["SQLite Candidate value", (replay) => {
        replay.unsafe.transaction.sqlite!.candidate!.rows[0]!.value =
          "candidate-only";
      }],
      ["Promotion journal", (replay) => {
        replay.repaired.transaction.recovery.journalPhase = null;
      }],
      ["effect identity", (replay) => {
        replay.safe.transaction.externalActions.intents[0]!.id =
          "protocol-other";
      }],
      ["effect delivery timing", (replay) => {
        replay.safe.transaction.externalActions.intents[0]!.deliveredAt =
          "2026-08-27T23:59:59.000Z";
      }],
      ["missing Canonical advance timing evidence", (replay) => {
        replay.safe.transaction.events = replay.safe.transaction.events.filter(
          (event) =>
            event.summary !==
            "Canonical State advanced before external action delivery",
        );
      }],
      ["duplicate Canonical advance timing evidence", (replay) => {
        const canonicalAdvance = replay.safe.transaction.events.find(
          (event) =>
            event.summary ===
            "Canonical State advanced before external action delivery",
        );
        replay.safe.transaction.events.push(structuredClone(canonicalAdvance!));
      }],
      ["malformed Canonical advance timestamp", (replay) => {
        const canonicalAdvance = replay.safe.transaction.events.find(
          (event) =>
            event.summary ===
            "Canonical State advanced before external action delivery",
        );
        canonicalAdvance!.at = "not-a-timestamp";
      }],
      ["effect delivered before Canonical advance", (replay) => {
        const canonicalAdvance = replay.safe.transaction.events.find(
          (event) =>
            event.summary ===
            "Canonical State advanced before external action delivery",
        );
        canonicalAdvance!.at = "2026-08-28T00:00:01.500Z";
      }],
      ["Repair effect key", (replay) => {
        replay.repaired.transaction.externalActions.intents[0]!.idempotencyKey =
          replay.safe.transaction.externalActions.intents[0]!.idempotencyKey;
      }],
      ["Run chronology", (replay) => {
        replay.repaired.createdAt = replay.unsafe.createdAt;
      }],
    ];

    for (const [name, mutate] of mutations) {
      const replay = structuredClone(recordingReplayRuns());
      mutate(replay);
      expect(
        deriveRecordingReplayHydration(
          [replay.repaired, replay.unsafe, replay.safe],
          selection,
        ),
        name,
      ).toBeNull();
    }
  });

  it("accepts exactly one expected resource of the required disposition", () => {
    expect(
      hasExactRecordingResources(
        transactionWithResources(resources("promoted")),
        "promoted",
      ),
    ).toBe(true);
  });

  it("rejects duplicate, missing, extra, or wrongly disposed resources", () => {
    const valid = resources("promoted");
    expect(
      hasExactRecordingResources(
        transactionWithResources([...valid, valid[0]!]),
        "promoted",
      ),
    ).toBe(false);
    expect(
      hasExactRecordingResources(
        transactionWithResources(valid.slice(0, -1)),
        "promoted",
      ),
    ).toBe(false);
    expect(
      hasExactRecordingResources(
        transactionWithResources(
          valid.map((resource, index) =>
            index === 0
              ? { ...resource, disposition: "quarantined" }
              : resource,
          ),
        ),
        "promoted",
      ),
    ).toBe(false);
  });

  it("rejects a safe root that does not advance both state identity and content", () => {
    const advanced = transactionWithResources(resources("promoted"));
    expect(advancesCanonicalState(advanced)).toBe(true);
    expect(
      advancesCanonicalState({
        ...advanced,
        canonicalStateIdAfter: advanced.canonicalStateIdBefore,
      }),
    ).toBe(false);
    expect(
      advancesCanonicalState({
        ...advanced,
        canonicalContentHashAfter: advanced.canonicalContentHashBefore,
      }),
    ).toBe(false);
  });

  it("rejects a stale, incomplete, duplicate, or extra recording Run set", () => {
    const baseline = [
      "historical-safe",
      "historical-unsafe",
      "historical-repair",
    ];
    const attempt = ["safe", "unsafe", "repair"];
    expect(
      hasExactFreshRecordingRunIds(
        [...baseline, ...attempt],
        baseline,
        attempt,
      ),
    ).toBe(true);
    expect(
      hasExactFreshRecordingRunIds(
        [...baseline, ...attempt, "unexpected"],
        baseline,
        attempt,
      ),
    ).toBe(false);
    expect(
      hasExactFreshRecordingRunIds(
        [...baseline, "safe", "unsafe"],
        baseline,
        attempt,
      ),
    ).toBe(false);
    expect(
      hasExactFreshRecordingRunIds(
        [...baseline, "safe", "unsafe", "repair"],
        baseline,
        ["safe", "safe", "repair"],
      ),
    ).toBe(false);
  });

  it("requires terminal Run and transaction status to equal the disposition", () => {
    const promoted = recordingRun();
    expect(hasValidTerminalRecordingRun(promoted, "promoted")).toBe(true);
    expect(
      hasValidTerminalRecordingRun(
        recordingRun({
          transaction: {
            ...promoted.transaction,
            status: "quarantined",
          },
        }),
        "promoted",
      ),
    ).toBe(false);
    expect(
      hasValidTerminalRecordingRun(
        {
          ...promoted,
          status: "failed",
        },
        "promoted",
      ),
    ).toBe(false);
  });

  it("requires the exact root Run identity for both roots and Repairs", () => {
    const safe = recordingRun();
    expect(hasRootRecordingLineage(safe)).toBe(true);
    expect(
      hasRootRecordingLineage(
        recordingRun({
          transaction: {
            ...safe.transaction,
            lineage: {
              ...safe.transaction.lineage,
              rootRunId: "another-root",
            },
          },
        }),
      ),
    ).toBe(false);

    const rejected = recordingRun({
      id: "run-rejected",
      transaction: {
        ...recordingTransaction({
          disposition: "quarantined",
          effectId: "protocol-unsafe",
          effectStatus: "rejected",
          effectKey: "rejected-key",
          deliveredAt: null,
        }),
        lineage: {
          rootRunId: "run-rejected",
          parentRunId: null,
          depth: 0,
          maxDepth: 2,
        },
      },
    });
    const repair = recordingRun({
      id: "run-repair",
      transaction: {
        ...recordingTransaction({
          effectId: "protocol-repair-ready",
          effectKey: "repair-key",
        }),
        lineage: {
          rootRunId: rejected.id,
          parentRunId: rejected.id,
          depth: 1,
          maxDepth: 2,
        },
      },
    });
    expect(hasRepairRecordingLineage(repair, rejected)).toBe(true);
    expect(
      hasRepairRecordingLineage(
        recordingRun({
          id: repair.id,
          transaction: {
            ...repair.transaction,
            lineage: {
              ...repair.transaction.lineage,
              rootRunId: "another-root",
            },
          },
        }),
        rejected,
      ),
    ).toBe(false);
  });

  it("rejects unsafe Run, state, and effect identifiers", () => {
    const valid = recordingRun();
    expect(isSafeRecordingIdentifier(valid.id)).toBe(true);
    expect(isSafeRecordingIdentifier("contains whitespace")).toBe(false);
    expect(
      hasValidTerminalRecordingRun(
        recordingRun({ id: "unsafe run" }),
        "promoted",
      ),
    ).toBe(false);
    expect(
      hasValidTerminalRecordingRun(
        recordingRun({
          transaction: {
            ...valid.transaction,
            canonicalStateIdAfter: "unsafe state",
          },
        }),
        "promoted",
      ),
    ).toBe(false);
    expect(
      hasExactRecordingEffect(
        {
          ...valid.transaction,
          externalActions: {
            ...valid.transaction.externalActions,
            intents: [
              {
                ...valid.transaction.externalActions.intents[0]!,
                idempotencyKey: "unsafe key",
              },
            ],
          },
        },
        {
          id: "protocol-release-ready",
          status: "delivered",
          deliveredCount: 1,
        },
      ),
    ).toBe(false);
  });

  it("requires exact Promotion-start, Canonical-advance, and terminal timing evidence", () => {
    const valid = recordingTransaction();
    const expectation = {
      id: "protocol-release-ready",
      status: "delivered" as const,
      deliveredCount: 1 as const,
    };
    expect(hasExactRecordingEffect(valid, expectation)).toBe(true);
    expect(
      hasExactRecordingEffect(
        {
          ...valid,
          events: [...valid.events, valid.events[0]!],
        },
        expectation,
      ),
    ).toBe(false);
    expect(
      hasExactRecordingEffect(
        {
          ...valid,
          events: valid.events.filter((event) => event.status !== "promoted"),
        },
        expectation,
      ),
    ).toBe(false);
    expect(
      hasExactRecordingEffect(
        {
          ...valid,
          externalActions: {
            ...valid.externalActions,
            intents: [
              {
                ...valid.externalActions.intents[0]!,
                deliveredAt: "2026-08-28T00:00:03.000Z",
              },
            ],
          },
        },
        expectation,
      ),
    ).toBe(false);
  });

  it("rejects a quarantined effect when Promotion lifecycle evidence exists", () => {
    const rejected = recordingTransaction({
      disposition: "quarantined",
      effectId: "protocol-unsafe",
      effectStatus: "rejected",
      effectKey: "rejected-key",
      deliveredAt: null,
      includePromotionEvents: true,
    });
    const expectation = {
      id: "protocol-unsafe",
      status: "rejected" as const,
      deliveredCount: 0 as const,
    };
    expect(
      hasExactRecordingEffect(
        {
          ...rejected,
          events: rejected.events.filter(
            (event) =>
              event.status !== "promoting" && event.status !== "promoted",
          ),
        },
        expectation,
      ),
    ).toBe(true);
    expect(hasExactRecordingEffect(rejected, expectation)).toBe(false);
  });

  it("requires the Repair effect key to differ from safe and rejected keys", () => {
    const safe = recordingTransaction({ effectKey: "safe-key" });
    const rejected = recordingTransaction({
      disposition: "quarantined",
      effectId: "protocol-unsafe",
      effectStatus: "rejected",
      effectKey: "rejected-key",
      deliveredAt: null,
    });
    const repair = recordingTransaction({
      effectId: "protocol-repair-ready",
      effectKey: "repair-key",
    });
    expect(hasDistinctRepairEffectKey(safe, rejected, repair)).toBe(true);
    expect(
      hasDistinctRepairEffectKey(safe, rejected, {
        ...repair,
        externalActions: {
          ...repair.externalActions,
          intents: [
            {
              ...repair.externalActions.intents[0]!,
              idempotencyKey: "safe-key",
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      hasDistinctRepairEffectKey(safe, rejected, {
        ...repair,
        externalActions: {
          ...repair.externalActions,
          intents: [
            {
              ...repair.externalActions.intents[0]!,
              idempotencyKey: "rejected-key",
            },
          ],
        },
      }),
    ).toBe(false);
  });
});
