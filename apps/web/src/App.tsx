import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  createReceiverCustodyTamperedCopy,
  evaluateSigningKeyTrust,
  evaluateReceiverCustodyTrustInBrowser,
  verifyPortableDecisionChainJsonInBrowser,
  verifyPortableEvidencePacketJsonInBrowser,
  verifySignedPolicyAuthorityRotationEnvelopeJsonInBrowser,
  verifySignedSigningKeyTrustPolicyEnvelopeJsonInBrowser,
  verifyPortablePromotionEnvelopeJsonInBrowser,
  verifyReceiverCustodyPacketJsonInBrowser,
} from "@agent-airlock/portable-promotion-receipt/browser";
import type {
  PortablePromotionEnvelope,
  PortableDecisionChain,
  PortableDecisionChainVerificationReport,
  PortableEvidencePacket,
  PortableEvidencePacketVerificationReport,
  PolicyAuthorityRotationVerificationReport,
  PortableVerificationReport,
  ReceiptDigest,
  ReceiverCustodyPacket,
  ReceiverCustodyTamperAttack,
  ReceiverCustodyTrustReport,
  ReceiverCustodyVerificationReport,
  SigningKeyTrustPolicy,
  TrustPolicyVerificationReport,
} from "@agent-airlock/portable-promotion-receipt";
import { api, ApiError, setAuthToken } from "./api";
import {
  advancesCanonicalState,
  deriveRecordingReplayHydration,
  hasDistinctRepairEffectKey,
  hasExactRecordingDecisionChain,
  hasExactRecordingEffect,
  hasExactRecordingResources,
  hasExactFreshRecordingRunIds,
  hasRepairRecordingLineage,
  hasRootRecordingLineage,
  hasValidTerminalRecordingRun,
  parseRecordingReplayRunIds,
  type RecordingReplayRunIds,
} from "./recording-outcome-policy";
import {
  findCompleteLiveModelArkPromotion,
  liveModelArkPrompt,
} from "./live-modelark-outcome-policy";
import type {
  Agent,
  AgentRun,
  AssuranceOperation,
  AssuranceProposal,
  CandidateSet,
  FederatedAdmissionInboxItem,
  FederatedImportResult,
  Message,
  OutcomeContractVersionRecord,
  PortableReceiptExport,
  RunTransaction,
  SystemInfo,
} from "./types";

const MAXIMUM_FEDERATED_BUNDLE_FILE_BYTES = 9 * 1_048_576;
const MAXIMUM_TRUST_POLICY_FILE_BYTES = 262_144;

function downloadJsonArtifact(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const starterPrompts = [
  "Build a dependency-free Node.js OrderGuard CLI using only built-in modules and node:test. Do not run npm install or create node_modules. Read local JSON, reject invalid orders, summarize valid revenue by status, add sample data and tests, run the tests, and summarize the result.",
  "Inspect this workspace and explain what you would improve first without changing files or installing dependencies.",
  "Demonstrate Airlock rejection by creating damage.txt and deleting the protected AGENTS.md file.",
];

const protocolFixturePrompts = {
  promote:
    "Create protocol-proof.txt with candidate-only, set SQLite row demo in .airlock/demo.sqlite to candidate-only, and queue typed effect protocol-release-ready for delivery only after Promotion.",
  challenge:
    "Attempt the unsafe protocol change for the rejection proof: set protocol-proof.txt and SQLite row demo to unsafe-candidate, then queue typed effect protocol-unsafe. Required Validation must decide whether anything is promoted.",
} as const;

function provesWholeAgentPromotion(
  run: AgentRun,
  expectedDatabaseValue: string,
) {
  const transaction = run.transaction;
  if (!transaction || transaction.disposition !== "promoted") return false;
  const databaseValue = transaction.sqlite?.after?.rows.find(
    (row) => row.id === "demo",
  )?.value;
  const resourceKinds = new Set(
    transaction.resources
      .filter((resource) => resource.disposition === "promoted")
      .map((resource) => resource.kind),
  );
  return (
    databaseValue === expectedDatabaseValue &&
    transaction.externalActions.deliveredCount === 1 &&
    transaction.externalActions.intents.length === 1 &&
    transaction.externalActions.intents[0]?.status === "delivered" &&
    ["workspace", "codex-session", "sqlite", "external-actions"].every((kind) =>
      resourceKinds.has(kind as RunTransaction["resources"][number]["kind"]),
    )
  );
}

const demoHeroPrompts = {
  promote: "Prepare the multi-resource release.",
  challenge: "Delete AGENTS.md and create damage.txt.",
  continue: "Confirm recovery from the repaired Canonical State.",
} as const;

const demoHeroSteps = [
  {
    id: "promote",
    number: "01",
    label: "Promote release",
    detail: "Commit code, data, memory, and one effect",
    prompt: demoHeroPrompts.promote,
  },
  {
    id: "challenge",
    number: "02",
    label: "Challenge safety",
    detail: "Quarantine a destructive future",
    prompt: demoHeroPrompts.challenge,
  },
  {
    id: "repair",
    number: "03",
    label: "Repair future",
    detail: "Reuse bounded evidence and lineage",
    prompt: null,
  },
  {
    id: "continue",
    number: "04",
    label: "Prove continuity",
    detail: "Continue from repaired Canonical State",
    prompt: demoHeroPrompts.continue,
  },
] as const;

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small, prefer existing or built-in tools, and do not install dependencies unless I explicitly request it. Explain the result.",
};

const defaultExplorationObjective =
  "Build the smallest complete solution, preserve every required file, and explain the validation result.";

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function shortHash(value: string | null): string {
  if (!value) return "pending";
  return value.startsWith("sha256:") ? value.slice(7, 19) : value.slice(0, 12);
}

function formatBytes(value: number): string {
  if (value < 1_024) return value + " B";
  if (value < 1_048_576) return (value / 1_024).toFixed(1) + " KB";
  return (value / 1_048_576).toFixed(1) + " MB";
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

type PortableVerifierArtifact =
  | PortablePromotionEnvelope
  | PortableEvidencePacket
  | PortableDecisionChain
  | ReceiverCustodyPacket;

type AutomaticProofState = {
  runId: string;
  requestNonce: number;
  status: "requested" | "verified" | "failed";
  error?: string;
  artifact?: PortableVerifierArtifact;
  decisionCount?: number;
  leafReceiptDigest?: ReceiptDigest | null;
};

type AutomaticProofVerification = {
  valid: boolean;
  error?: string;
  artifact?: PortableVerifierArtifact;
  decisionCount: number;
  leafReceiptDigest?: ReceiptDigest | null;
};

type RecordingAttemptRunIds = RecordingReplayRunIds;

type RecordingAttempt = {
  baselineRunIds: string[];
  agentId: string;
  canonicalStateId: string;
  runIds: RecordingAttemptRunIds | null;
};

function JudgeProofSummary({
  transaction,
  modelArkProofMode = false,
}: {
  transaction: NonNullable<AgentRun["transaction"]>;
  modelArkProofMode?: boolean;
}) {
  const disposition = transaction.disposition ?? transaction.status;
  const requiredValidations = transaction.validations.filter(
    (validation) => validation.required,
  );
  const passedRequired = requiredValidations.filter(
    (validation) => validation.status === "passed",
  ).length;
  const terminal = [
    "promoted",
    "quarantined",
    "discarded",
    "cancelled",
    "recovery-error",
  ].includes(disposition);
  const promoted = disposition === "promoted";
  const quarantined = disposition === "quarantined";
  const repaired = promoted && transaction.lineage.depth > 0;
  const candidatePrepared = transaction.events.some(
    (event) => event.status === "executing" || event.status === "validating",
  );
  const builtInResourceKinds: RunTransaction["resources"][number]["kind"][] = [
    "workspace",
    "codex-session",
    "sqlite",
    "external-actions",
  ];
  const coherentResourceCount = builtInResourceKinds.filter((kind) =>
    transaction.resources.some(
      (resource) =>
        resource.kind === kind && resource.disposition === disposition,
    ),
  ).length;
  const deliveredEffects = transaction.externalActions.deliveredCount;

  return (
    <section className="judge-proof-summary" aria-label="Judge proof summary">
      <header>
        <div>
          <span className="eyebrow">End-to-end proof</span>
          <h4>
            {repaired
              ? "Recovery complete: retained work became a validated future"
              : promoted
              ? modelArkProofMode
                ? "Promotion complete: one validated Whole-Agent future became reality"
                : "Proof complete: one validated Whole-Agent future became reality"
              : quarantined
                ? "Unsafe future blocked: accepted reality did not move"
              : terminal
                ? "Promotion blocked: Canonical State stayed protected"
                : "Real transaction in progress"}
          </h4>
        </div>
        <span className={promoted ? "proof-verdict passed" : "proof-verdict"}>
          {promoted
            ? modelArkProofMode
              ? "Promoted"
              : "Validated"
            : terminal
              ? "Protected"
              : "Running"}
        </span>
      </header>
      <ol>
        <li data-state={candidatePrepared || terminal ? "passed" : "active"}>
          <span>{candidatePrepared || terminal ? "✓" : "1"}</span>
          <div>
            <strong>
              {repaired ? "Quarantine lineage retained" : "Candidate isolated"}
            </strong>
            <small>
              {repaired
                ? `Repair ${transaction.lineage.depth} is linked to rejected Run ${transaction.lineage.parentRunId?.slice(0, 8)}.`
                : "Real Codex received Candidate State, never mutable Canonical State."}
            </small>
          </div>
        </li>
        <li data-state={promoted ? "passed" : terminal ? "blocked" : "active"}>
          <span>{promoted ? "✓" : terminal ? "!" : "2"}</span>
          <div>
            <strong>Outcome Contract enforced</strong>
            <small>
              {requiredValidations.length === 0
                ? "Required Validation evidence is pending."
                : `${passedRequired}/${requiredValidations.length} required Validations passed.`}
            </small>
          </div>
        </li>
        <li
          data-state={
            promoted || quarantined
              ? "passed"
              : terminal
                ? "blocked"
                : "pending"
          }
        >
          <span>{promoted ? "✓" : terminal ? "✓" : "3"}</span>
          <div>
            <strong>
              {promoted || quarantined
              ? `${coherentResourceCount}/4 resources ${promoted ? "promoted" : "quarantined"}`
              : terminal
                ? "Canonical State unchanged"
                  : "Promotion decision"}
            </strong>
            <small>
              {promoted
                ? `Workspace, session, SQLite, and outbox advanced together. Canonical State ${shortHash(transaction.canonicalContentHashBefore)} to ${shortHash(transaction.canonicalContentHashAfter)}.`
                : terminal
                  ? `Canonical State ${shortHash(transaction.canonicalContentHashBefore)} remained ${shortHash(transaction.canonicalContentHashAfter)}.`
                  : "Promotion remains impossible until every required Validation passes."}
            </small>
          </div>
        </li>
        <li data-state={promoted || terminal ? "passed" : "pending"}>
          <span>{promoted || terminal ? "✓" : "4"}</span>
          <div>
            <strong>
              {promoted
                ? "Effect released after Promotion"
                : "External effects held back"}
            </strong>
            <small>
              {promoted
                ? `${deliveredEffects} typed effect${deliveredEffects === 1 ? "" : "s"} delivered only after Canonical State advanced.`
                : terminal
                  ? `${deliveredEffects} effects delivered from this rejected future.`
                  : "Candidate intents remain deferred until Promotion completes."}
            </small>
          </div>
        </li>
      </ol>
    </section>
  );
}

function ProtocolScenarioGuide({
  runs,
  busy,
  onRun,
  onRepair,
  onRequestProof,
  automaticProof,
  recordingMode = false,
  readOnlyReplayMode = false,
  recordingRunIds = null,
  onRecordingAttemptStart,
  onRecordingAttemptComplete,
}: {
  runs: AgentRun[];
  busy: boolean;
  onRun: (prompt: string) => Promise<AgentRun | null>;
  onRepair: (runId: string) => Promise<AgentRun | null>;
  onRequestProof: (runId: string) => void;
  automaticProof: AutomaticProofState | null;
  recordingMode?: boolean;
  readOnlyReplayMode?: boolean;
  recordingRunIds?: RecordingAttemptRunIds | null;
  onRecordingAttemptStart?: () => void;
  onRecordingAttemptComplete?: (runIds: RecordingAttemptRunIds) => void;
}) {
  const [automationStage, setAutomationStage] = useState<
    "promote" | "quarantine" | "repair" | "verify" | null
  >(null);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const scenarioRuns = recordingMode
    ? recordingRunIds
      ? runs.filter((run) =>
          [
            recordingRunIds.safeRunId,
            recordingRunIds.unsafeRunId,
            recordingRunIds.repairedRunId,
          ].includes(run.id),
        )
      : []
    : runs;
  const promoted = scenarioRuns.find(
    (run) =>
      !run.candidateSetId &&
      run.transaction?.disposition === "promoted" &&
      run.transaction.lineage.depth === 0 &&
      provesWholeAgentPromotion(run, "candidate-only"),
  );
  const quarantined = scenarioRuns.find(
    (run) =>
      !run.candidateSetId && run.transaction?.disposition === "quarantined",
  );
  const repaired = scenarioRuns.find(
    (run) =>
      !run.candidateSetId &&
      run.transaction?.disposition === "promoted" &&
      run.transaction.lineage.depth > 0,
  );
  const pairedComplete = promoted?.transaction && quarantined?.transaction;
  const complete = pairedComplete && repaired?.transaction;
  const repairedProofStatus =
    repaired && automaticProof?.runId === repaired.id
      ? automaticProof.status
      : null;
  const recordingStageOrder = {
    promote: 0,
    quarantine: 1,
    repair: 2,
    verify: 3,
  } as const;
  const scenarioStageState = (
    stage: "promote" | "quarantine" | "repair",
    evidenceComplete: boolean,
  ): "pending" | "active" | "complete" => {
    if (evidenceComplete) return "complete";
    if (!recordingMode || automationStage === null) return "pending";
    const currentIndex = recordingStageOrder[automationStage];
    const stageIndex = recordingStageOrder[stage];
    if (currentIndex === stageIndex) return "active";
    return currentIndex > stageIndex ? "complete" : "pending";
  };
  const promotedStageState = scenarioStageState("promote", Boolean(promoted));
  const quarantinedStageState = scenarioStageState(
    "quarantine",
    Boolean(quarantined),
  );
  const repairedStageState = scenarioStageState("repair", Boolean(repaired));

  useEffect(() => {
    if (repairedProofStatus === "verified") {
      setAutomationStage(null);
      setAutomationError(null);
    } else if (repairedProofStatus === "failed") {
      setAutomationStage(null);
      setAutomationError(
        automaticProof?.error ??
          "Recovery completed, but the signed decision chain did not verify.",
      );
    }
  }, [automaticProof?.error, repairedProofStatus]);

  const runCompleteLoop = async () => {
    if (readOnlyReplayMode) return;
    if (recordingMode) onRecordingAttemptStart?.();
    setAutomationError(null);
    setAutomationStage("promote");
    try {
      const safeRun = recordingMode
        ? await onRun(protocolFixturePrompts.promote)
        : (promoted ?? (await onRun(protocolFixturePrompts.promote)));
      if (!safeRun || !provesWholeAgentPromotion(safeRun, "candidate-only")) {
        setAutomationError(
          "Safety loop stopped: the passing Candidate did not produce the required Whole-Agent Promotion.",
        );
        return;
      }

      setAutomationStage("quarantine");
      const rejectedRun = recordingMode
        ? await onRun(protocolFixturePrompts.challenge)
        : (quarantined ?? (await onRun(protocolFixturePrompts.challenge)));
      if (rejectedRun?.transaction?.disposition !== "quarantined") {
        setAutomationError(
          "Safety loop stopped: the invalid Candidate did not produce the required Quarantine decision.",
        );
        return;
      }

      if (recordingMode || !repaired) {
        setAutomationStage("repair");
        const repairRun = await onRepair(rejectedRun.id);
        if (
          repairRun?.transaction?.disposition !== "promoted" ||
          repairRun.transaction.lineage.depth < 1
        ) {
          setAutomationError(
            "Safety loop stopped: the retained Candidate did not produce a promoted Repair lineage.",
          );
          return;
        }
        setAutomationStage("verify");
        if (recordingMode) {
          onRecordingAttemptComplete?.({
            safeRunId: safeRun.id,
            unsafeRunId: rejectedRun.id,
            repairedRunId: repairRun.id,
          });
        }
        onRequestProof(repairRun.id);
      }
    } finally {
      setAutomationStage((current) => (current === "verify" ? current : null));
    }
  };
  const automationLabel =
    automationStage === "promote"
      ? "Running safe Candidate"
      : automationStage === "quarantine"
        ? "Proving rejection"
        : automationStage === "repair"
          ? "Repairing retained Candidate"
          : automationStage === "verify"
            ? "Verifying signed lineage"
            : readOnlyReplayMode
              ? "Loading read-only proof"
              : recordingMode
                ? "Prove this release is safe"
                : "Run complete safety loop";

  return (
    <section className="protocol-scenario-guide" aria-label="Full safety loop">
      <header>
        <div>
          <span className="eyebrow">Full safety loop</span>
          <strong>Promote. Reject. Repair. Verify.</strong>
        </div>
        {repairedProofStatus === "verified" ? (
          <span>Signed recovery verified</span>
        ) : complete ? (
          repairedProofStatus === "requested" ? (
            <span>Verifying signed recovery</span>
          ) : (
            <button
              type="button"
              className="button button-primary protocol-run-all"
              onClick={() => repaired && onRequestProof(repaired.id)}
              disabled={busy || automationStage !== null || !repaired}
            >
              {!recordingMode && <span aria-hidden="true">↻</span>}
              {repairedProofStatus === "failed"
                ? "Retry signed verification"
                : "Verify signed recovery"}
            </button>
          )
        ) : (
          <button
            type="button"
            className="button button-primary protocol-run-all"
            onClick={() => void runCompleteLoop()}
            disabled={readOnlyReplayMode || busy || automationStage !== null}
            aria-busy={automationStage !== null}
          >
            {automationStage ? (
              <Spinner />
            ) : !recordingMode ? (
              <span aria-hidden="true">▶</span>
            ) : null}
            {automationLabel}
          </button>
        )}
      </header>
      <span
        className="protocol-progress-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {automationStage === null
          ? ""
          : `Safety proof progress: ${automationLabel}.`}
      </span>
      <div className="protocol-scenario-actions">
        <button
          type="button"
          data-state={promotedStageState}
          data-complete={promotedStageState === "complete"}
          aria-current={promotedStageState === "active" ? "step" : undefined}
          onClick={() => {
            setAutomationError(null);
            void onRun(protocolFixturePrompts.promote);
          }}
          disabled={recordingMode || busy || automationStage !== null}
        >
          <span>{promotedStageState === "complete" ? "✓" : "1"}</span>
          <div>
            <strong>
              {promotedStageState === "complete"
                ? "Safe future promoted"
                : "Run passing Candidate"}
            </strong>
            <small>
              Codex updates protocol-proof.txt, the SQLite demo row, memory,
              and one typed deferred effect.
            </small>
          </div>
        </button>
        <button
          type="button"
          data-state={quarantinedStageState}
          data-complete={quarantinedStageState === "complete"}
          aria-current={
            quarantinedStageState === "active" ? "step" : undefined
          }
          onClick={() => {
            setAutomationError(null);
            void onRun(protocolFixturePrompts.challenge);
          }}
          disabled={
            recordingMode || busy || automationStage !== null || !promoted
          }
        >
          <span>{quarantinedStageState === "complete" ? "✓" : "2"}</span>
          <div>
            <strong>
              {quarantinedStageState === "complete"
                ? "Unsafe future quarantined"
                : "Run failing Candidate"}
            </strong>
            <small>
              command:protocol-content fails; all four Candidate resources stay
              quarantined and zero effects ship.
            </small>
          </div>
        </button>
        <button
          type="button"
          data-state={repairedStageState}
          data-complete={repairedStageState === "complete"}
          aria-current={repairedStageState === "active" ? "step" : undefined}
          onClick={() => {
            setAutomationError(null);
            if (quarantined) void onRepair(quarantined.id);
          }}
          disabled={
            recordingMode ||
            busy ||
            automationStage !== null ||
            !quarantined ||
            Boolean(repaired)
          }
        >
          <span>{repairedStageState === "complete" ? "✓" : "3"}</span>
          <div>
            <strong>
              {repairedStageState === "complete"
                ? "Rejected future safely repaired"
                : "Repair retained Candidate"}
            </strong>
            <small>
              A fresh child fixes protocol-proof.txt and SQLite from bounded
              failure evidence, then queues a new typed effect.
            </small>
          </div>
        </button>
      </div>
      {automationError && (
        <div className="protocol-automation-error" role="alert">
          <strong>Automatic proof stopped safely</strong>
          <span>{automationError}</span>
        </div>
      )}
      {pairedComplete && (
        <div className="protocol-paired-verdict" role="status">
          <span aria-hidden="true">✓</span>
          <div>
            <strong>
              {repairedProofStatus === "verified"
                ? "Full signed recovery proof verified"
                : complete
                  ? repairedProofStatus === "requested"
                    ? "Verifying signed recovery chain"
                    : repairedProofStatus === "failed"
                      ? "Signed recovery verification failed"
                      : "Recovery lineage ready for verification"
                  : "Airlock controlled both outcomes"}
            </strong>
            <small>
              {repairedProofStatus === "verified"
                ? "Two signed decisions, their parent link, and every Canonical State handoff verified locally without an upload."
                : complete
                ? repairedProofStatus === "failed"
                  ? "The retained lineage remains intact, but Airlock will not claim independent proof until local verification succeeds."
                  : "The rejected parent and promoted repair child now form one decision lineage ready for signed, independent verification."
                : "The valid Candidate advanced Canonical State. The invalid Candidate left its fingerprint unchanged."}
            </small>
          </div>
          <code>
            {shortHash(quarantined.transaction!.canonicalContentHashBefore)} ={" "}
            {shortHash(quarantined.transaction!.canonicalContentHashAfter)}
          </code>
        </div>
      )}
    </section>
  );
}

type RecordingOutcome = {
  safe: AgentRun & { transaction: RunTransaction };
  unsafe: AgentRun & { transaction: RunTransaction };
  repaired: AgentRun & { transaction: RunTransaction };
  safeRequired: { passed: number; total: number };
  unsafeRequired: { passed: number; total: number };
  repairedRequired: { passed: number; total: number };
};

function requiredValidationResult(transaction: RunTransaction) {
  const required = transaction.validations.filter(
    (validation) => validation.required,
  );
  return {
    passed: required.filter((validation) => validation.status === "passed")
      .length,
    total: required.length,
  };
}

function hasExactProtocolProofChange(transaction: RunTransaction): boolean {
  return (
    transaction.changes?.files.filter(
      (change) => change.path === "protocol-proof.txt",
    ).length === 1
  );
}

function deriveRecordingOutcome(
  runs: AgentRun[],
  automaticProof: AutomaticProofState | null,
  recordingAttempt: RecordingAttempt | null,
): RecordingOutcome | null {
  if (
    !recordingAttempt?.runIds ||
    automaticProof?.status !== "verified" ||
    automaticProof.decisionCount !== 2 ||
    automaticProof.artifact?.schema !==
      "agent-airlock/portable-decision-chain" ||
    automaticProof.artifact.packets.length !== 2 ||
    !automaticProof.leafReceiptDigest
  ) {
    return null;
  }

  const { safeRunId, unsafeRunId, repairedRunId } = recordingAttempt.runIds;
  const attemptRunIds = [safeRunId, unsafeRunId, repairedRunId];
  if (
    new Set(attemptRunIds).size !== 3 ||
    !hasExactFreshRecordingRunIds(
      runs.map((run) => run.id),
      recordingAttempt.baselineRunIds,
      attemptRunIds,
    ) ||
    automaticProof.runId !== repairedRunId
  ) {
    return null;
  }

  const repairedCandidate = runs.find((run) => run.id === repairedRunId);
  if (!repairedCandidate?.transaction) return null;
  const repaired = repairedCandidate as RecordingOutcome["repaired"];

  const unsafeCandidate = runs.find((run) => run.id === unsafeRunId);
  if (!unsafeCandidate?.transaction) return null;
  const unsafe = unsafeCandidate as RecordingOutcome["unsafe"];

  const safeCandidate = runs.find((run) => run.id === safeRunId);
  if (!safeCandidate?.transaction) return null;
  const safe = safeCandidate as RecordingOutcome["safe"];

  const safeRequired = requiredValidationResult(safe.transaction);
  const unsafeRequired = requiredValidationResult(unsafe.transaction);
  const unsafeFailedRequired = unsafe.transaction.validations.some(
    (validation) =>
      validation.name === "command:protocol-content" &&
      validation.required &&
      validation.status === "failed",
  );
  const repairedRequired = requiredValidationResult(repaired.transaction);
  const contractIdentity = JSON.stringify(safe.transaction.outcomeContract);
  const safeSqliteCandidate = safe.transaction.sqlite?.candidate?.rows.find(
    (row) => row.id === "demo",
  );
  const safeSqliteAfter = safe.transaction.sqlite?.after?.rows.find(
    (row) => row.id === "demo",
  );
  const unsafeSqliteCandidate = unsafe.transaction.sqlite?.candidate?.rows.find(
    (row) => row.id === "demo",
  );
  const unsafeSqliteAfter = unsafe.transaction.sqlite?.after?.rows.find(
    (row) => row.id === "demo",
  );
  const repairedSqliteCandidate =
    repaired.transaction.sqlite?.candidate?.rows.find(
      (row) => row.id === "demo",
    );
  const repairedSqliteAfter = repaired.transaction.sqlite?.after?.rows.find(
    (row) => row.id === "demo",
  );
  const safeCreatedAt = Date.parse(safe.createdAt);
  const unsafeCreatedAt = Date.parse(unsafe.createdAt);
  const repairedCreatedAt = Date.parse(repaired.createdAt);
  const coherent =
    [safe, unsafe, repaired].every(
      (run) =>
        run.status === "completed" &&
        run.candidateSetId === null &&
        run.competitorId === null,
    ) &&
    safe.agentId === recordingAttempt.agentId &&
    safe.agentId === unsafe.agentId &&
    safe.agentId === repaired.agentId &&
    safe.transaction.canonicalStateIdBefore ===
      recordingAttempt.canonicalStateId &&
    hasValidTerminalRecordingRun(safe, "promoted") &&
    hasValidTerminalRecordingRun(unsafe, "quarantined") &&
    hasValidTerminalRecordingRun(repaired, "promoted") &&
    [safeCreatedAt, unsafeCreatedAt, repairedCreatedAt].every(
      Number.isFinite,
    ) &&
    safeCreatedAt < unsafeCreatedAt &&
    unsafeCreatedAt < repairedCreatedAt &&
    safe.transaction.disposition === "promoted" &&
    hasRootRecordingLineage(safe) &&
    advancesCanonicalState(safe.transaction) &&
    safeRequired.total > 0 &&
    safeRequired.passed === safeRequired.total &&
    unsafe.transaction.disposition === "quarantined" &&
    hasRootRecordingLineage(unsafe) &&
    unsafeFailedRequired &&
    repaired.transaction.disposition === "promoted" &&
    hasRepairRecordingLineage(repaired, unsafe) &&
    advancesCanonicalState(repaired.transaction) &&
    repairedRequired.total > 0 &&
    repairedRequired.passed === repairedRequired.total &&
    safe.transaction.outcomeContractVersion ===
      unsafe.transaction.outcomeContractVersion &&
    safe.transaction.outcomeContractVersion ===
      repaired.transaction.outcomeContractVersion &&
    JSON.stringify(unsafe.transaction.outcomeContract) === contractIdentity &&
    JSON.stringify(repaired.transaction.outcomeContract) === contractIdentity &&
    hasExactRecordingResources(safe.transaction, "promoted") &&
    hasExactRecordingResources(unsafe.transaction, "quarantined") &&
    hasExactRecordingResources(repaired.transaction, "promoted") &&
    hasExactProtocolProofChange(safe.transaction) &&
    hasExactProtocolProofChange(unsafe.transaction) &&
    safe.transaction.canonicalStateIdAfter ===
      unsafe.transaction.canonicalStateIdBefore &&
    safe.transaction.canonicalContentHashAfter ===
      unsafe.transaction.canonicalContentHashBefore &&
    unsafe.transaction.canonicalStateIdAfter ===
      unsafe.transaction.canonicalStateIdBefore &&
    unsafe.transaction.canonicalContentHashAfter ===
      unsafe.transaction.canonicalContentHashBefore &&
    unsafe.transaction.canonicalStateIdAfter ===
      repaired.transaction.canonicalStateIdBefore &&
    unsafe.transaction.canonicalContentHashAfter ===
      repaired.transaction.canonicalContentHashBefore &&
    hasExactRecordingEffect(safe.transaction, {
      id: "protocol-release-ready",
      type: "demo.notification.requested",
      status: "delivered",
      deliveredCount: 1,
    }) &&
    safe.transaction.recovery.journalPhase === "completed" &&
    safeSqliteCandidate?.value === "candidate-only" &&
    safeSqliteAfter?.value === "candidate-only" &&
    hasExactRecordingEffect(unsafe.transaction, {
      id: "protocol-unsafe",
      type: "demo.notification.requested",
      status: "rejected",
      deliveredCount: 0,
    }) &&
    unsafeSqliteCandidate?.value === "unsafe-candidate" &&
    unsafeSqliteAfter?.value === "candidate-only" &&
    hasExactRecordingEffect(repaired.transaction, {
      id: "protocol-repair-ready",
      type: "demo.notification.requested",
      status: "delivered",
      deliveredCount: 1,
    }) &&
    repaired.transaction.recovery.journalPhase === "completed" &&
    repairedSqliteCandidate?.value === "candidate-only" &&
    repairedSqliteAfter?.value === "candidate-only" &&
    hasDistinctRepairEffectKey(
      safe.transaction,
      unsafe.transaction,
      repaired.transaction,
    ) &&
    hasExactRecordingDecisionChain(
      automaticProof.artifact,
      unsafe,
      repaired,
      automaticProof.leafReceiptDigest,
    );

  return coherent
    ? { safe, unsafe, repaired, safeRequired, unsafeRequired, repairedRequired }
    : null;
}

function RecordingOutcomeBrief({
  outcome,
  system,
  agentStatus,
  onOpenVerifier,
  onContinue,
}: {
  outcome: RecordingOutcome;
  system: SystemInfo;
  agentStatus: Agent["status"] | null;
  onOpenVerifier: () => void;
  onContinue: () => void;
}) {
  const safeTransaction = outcome.safe.transaction;
  const unsafeTransaction = outcome.unsafe.transaction;
  const repairedTransaction = outcome.repaired.transaction;
  const safeFile = safeTransaction.changes!.files.find(
    (change) => change.path === "protocol-proof.txt",
  )!.path;
  const unsafeFile = unsafeTransaction.changes!.files.find(
    (change) => change.path === "protocol-proof.txt",
  )!.path;
  const safeSqliteRow = safeTransaction.sqlite?.after?.rows.find(
    (row) => row.id === "demo",
  );
  const unsafeSqliteRow = unsafeTransaction.sqlite?.candidate?.rows.find(
    (row) => row.id === "demo",
  );
  const repairedSqliteRow = repairedTransaction.sqlite?.after?.rows.find(
    (row) => row.id === "demo",
  );
  const failedRequiredValidation = unsafeTransaction.validations.find(
    (validation) => validation.required && validation.status === "failed",
  );
  const safeEffect = safeTransaction.externalActions.intents[0];
  const unsafeEffect = unsafeTransaction.externalActions.intents[0];
  const repairedEffect = repairedTransaction.externalActions.intents[0];

  return (
    <section className="recording-outcome" aria-label="Verified Outcome Brief">
      <header className="recording-outcome-heading">
        <div>
          <span className="eyebrow">Verified Outcome Brief</span>
          <h1>Three Runs. One rule: only validated state moves.</h1>
          <p>
            Persisted Run transactions prove all three outcomes. The
            independently verified signed chain proves the Quarantine-to-Repair
            handoff.
          </p>
        </div>
        <span className="recording-verdict">Transactional safety proven</span>
      </header>

      <div className="recording-boundary" role="note">
        <div>
          <strong>Disclosed execution boundary</strong>
          <p>
            {system.runtime} · local deterministic Responses fixture · no
            ModelArk request or paid inference
          </p>
        </div>
      </div>

      <div className="recording-outcome-grid">
        <article data-outcome="promoted">
          <header>
            <span>01 · SAFE ROOT · RUN {outcome.safe.id.slice(0, 8)}</span>
            <strong>Promotion</strong>
          </header>
          <h2>A valid Whole-Agent Candidate promoted atomically.</h2>
          <ul>
            <li data-evidence="exact">
              <strong>
                {safeTransaction.resources.length}/4 resources ·{" "}
                {outcome.safeRequired.passed}/{outcome.safeRequired.total}{" "}
                required
              </strong>
              <span>every required check passed before Promotion</span>
            </li>
            <li data-evidence="exact">
              <strong>
                File {safeFile} · SQLite {safeSqliteRow?.id} ={" "}
                {safeSqliteRow?.value}
              </strong>
              <span>
                workspace file + {safeTransaction.sqlite?.databasePath} row
                promoted
              </span>
            </li>
            <li data-evidence="exact">
              <strong>{safeEffect?.type}</strong>
              <span>{safeEffect?.id} delivered only after Promotion</span>
            </li>
          </ul>
          <div
            className="recording-exact-run"
            data-recording-run-id={outcome.safe.id}
          >
            <span>Exact evidence</span>
            <code>
              Canonical {shortHash(safeTransaction.canonicalContentHashBefore).slice(0, 8)}
              {" → "}
              {shortHash(safeTransaction.canonicalContentHashAfter).slice(0, 8)}
            </code>
            <code>Run {outcome.safe.id}</code>
          </div>
        </article>

        <article data-outcome="quarantined">
          <header>
            <span>
              02 · UNSAFE FUTURE · RUN {outcome.unsafe.id.slice(0, 8)}
            </span>
            <strong>Quarantine</strong>
          </header>
          <h2>One failed check kept Canonical State unchanged.</h2>
          <ul>
            <li data-evidence="exact">
              <strong>{failedRequiredValidation?.name}</strong>
              <span>
                decisive required Validation failed ·{" "}
                {unsafeTransaction.resources.length}/4 quarantined
              </span>
            </li>
            <li data-evidence="exact">
              <strong>
                {shortHash(unsafeTransaction.canonicalContentHashBefore).slice(
                  0,
                  8,
                )}{" "}
                ={" "}
                {shortHash(unsafeTransaction.canonicalContentHashAfter).slice(
                  0,
                  8,
                )}{" "}
                · {unsafeTransaction.externalActions.deliveredCount} effects
              </strong>
              <span>Canonical State stayed byte-for-byte unchanged</span>
            </li>
            <li data-evidence="exact">
              <strong>
                File {unsafeFile} · SQLite {unsafeSqliteRow?.id} ={" "}
                {unsafeSqliteRow?.value}
              </strong>
              <span>
                {unsafeTransaction.sqlite?.databasePath} + {unsafeEffect?.id}{" "}
                {unsafeEffect?.status}
              </span>
            </li>
          </ul>
          <div
            className="recording-exact-run"
            data-recording-run-id={outcome.unsafe.id}
          >
            <span>Exact evidence</span>
            <code>Run {outcome.unsafe.id}</code>
          </div>
        </article>

        <article data-outcome="repaired">
          <header>
            <span>
              03 · REPAIRED CHILD · RUN {outcome.repaired.id.slice(0, 8)}
            </span>
            <strong>Promotion</strong>
          </header>
          <h2>A fresh child repaired and promoted the retained Candidate.</h2>
          <ul>
            <li data-evidence="exact">
              <strong>
                {repairedTransaction.resources.length}/4 +{" "}
                {repairedTransaction.externalActions.deliveredCount} fresh
                effect · {outcome.repairedRequired.passed}/
                {outcome.repairedRequired.total} required
              </strong>
              <span>fresh child passed every check before Promotion</span>
            </li>
            <li data-evidence="exact">
              <strong>
                Validation {"command:protocol-content"} · SQLite{" "}
                {repairedSqliteRow?.id} = {repairedSqliteRow?.value}
              </strong>
              <span>
                repaired from parent{" "}
                {repairedTransaction.lineage.parentRunId!.slice(0, 8)} · depth{" "}
                {repairedTransaction.lineage.depth}
              </span>
            </li>
            <li data-evidence="exact">
              <strong>{repairedEffect?.type}</strong>
              <span>{repairedEffect?.id} delivered with a fresh key</span>
            </li>
          </ul>
          <div
            className="recording-exact-run recording-exact-run-lineage"
            data-recording-run-id={outcome.repaired.id}
            data-recording-parent-id={
              repairedTransaction.lineage.parentRunId ?? undefined
            }
          >
            <span>Exact evidence</span>
            <code>
              Canonical {shortHash(repairedTransaction.canonicalContentHashBefore).slice(0, 8)}
              {" → "}
              {shortHash(repairedTransaction.canonicalContentHashAfter).slice(0, 8)}
            </code>
            <code>Run {outcome.repaired.id}</code>
            <code>Parent {repairedTransaction.lineage.parentRunId}</code>
          </div>
        </article>

        <article data-outcome="verified">
          <header>
            <span>04 · PORTABLE TRUST</span>
            <strong>Verified</strong>
          </header>
          <h2>An independent verifier can check the recovery chain.</h2>
          <ul>
            <li>
              <strong>2</strong>
              <span>Quarantine-to-Repair signed decisions linked</span>
            </li>
            <li>
              <strong>Local</strong>
              <span>browser cryptographic check passed</span>
            </li>
            <li>
              <strong>All</strong>
              <span>parent links and state handoffs verified</span>
            </li>
          </ul>
          <button
            type="button"
            className="button button-primary recording-verifier-button"
            onClick={onOpenVerifier}
          >
            Inspect in zero-upload verifier
          </button>
        </article>
      </div>

      <footer>
        <span>
          Candidate State (attempted future) → Outcome Contract → Canonical
          State (accepted reality) or Quarantine
        </span>
        <div className="recording-continuation">
          {agentStatus !== null && (
            <strong>Agent remains {agentStatus.toUpperCase()}</strong>
          )}
          <button
            type="button"
            className="button button-ghost"
            onClick={onContinue}
          >
            Continue in Playground
          </button>
        </div>
      </footer>
    </section>
  );
}

function LiveModelArkGuide({
  runs,
  busy,
  onRun,
}: {
  runs: AgentRun[];
  busy: boolean;
  onRun: (prompt: string) => void;
}) {
  const [qualification, setQualification] = useState<{
    source: AgentRun[] | null;
    run: AgentRun | null;
  }>({ source: null, run: null });
  useEffect(() => {
    let cancelled = false;
    void findCompleteLiveModelArkPromotion(runs)
      .then((run) => {
        if (!cancelled) setQualification({ source: runs, run });
      })
      .catch(() => {
        if (!cancelled) setQualification({ source: runs, run: null });
      });
    return () => {
      cancelled = true;
    };
  }, [runs]);
  const promoted = qualification.source === runs ? qualification.run : null;
  const partialPromotion = runs.find(
    (run) => !run.candidateSetId && run.transaction?.disposition === "promoted",
  );
  const displayedRun = promoted ?? partialPromotion;
  const completed = promoted !== null;
  const preflightBound = promoted !== null;

  return (
    <section
      className="protocol-scenario-guide modelark-live-guide"
      aria-label="Live ModelArk proof"
    >
      <header>
        <div>
          <span className="eyebrow">Airlock-attested live execution</span>
          <strong>Model decides. Contract verifies.</strong>
        </div>
        <span>
          {preflightBound
            ? "Preflight + Runtime bound"
            : partialPromotion
              ? "Whole-Agent proof incomplete"
              : "One judge action"}
        </span>
      </header>
      <div className="protocol-scenario-actions">
        <button
          type="button"
          data-complete={completed}
          onClick={() => onRun(liveModelArkPrompt)}
          disabled={busy}
        >
          <span>{completed ? "✓" : "1"}</span>
          <div>
            <strong>
              {completed ? "Run another live Candidate" : "Run live Candidate"}
            </strong>
            <small>
              ModelArk must prepare code, data, memory, and one deferred effect.
            </small>
          </div>
        </button>
      </div>
      {displayedRun?.transaction && (
        <div
          className="protocol-paired-verdict"
          role="status"
          data-airlock-run-id={displayedRun.id}
        >
          <span aria-hidden="true">✓</span>
          <div>
            <strong>
              {preflightBound
                ? "Airlock attested preflight, Runtime profile, and Promotion"
                : "Promotion complete; provider binding unavailable"}
            </strong>
            <small>
              {preflightBound
                ? "The Promotion Receipt binds fresh generated-output preflight facts and the model identifier commitment to four promoted resources and one post-Promotion effect. Independent packet verification completes in the proof command."
                : "The isolated Candidate advanced Canonical State, but this view cannot attest that Run to the live provider without its required execution-profile evidence."}
            </small>
          </div>
          <code>
            {shortHash(displayedRun.transaction.canonicalContentHashAfter)}
          </code>
        </div>
      )}
    </section>
  );
}

function EvidenceDetails({
  compact,
  children,
}: {
  compact: boolean;
  children: ReactNode;
}) {
  if (!compact) return <>{children}</>;
  return (
    <details className="judge-evidence-details">
      <summary>
        <span>
          <strong>Inspect complete transaction evidence</strong>
          <small>Resources, timeline, Validations, and workspace changes</small>
        </span>
        <span aria-hidden="true">＋</span>
      </summary>
      <div>{children}</div>
    </details>
  );
}

function PortableProofDetails({
  compact,
  children,
}: {
  compact: boolean;
  children: ReactNode;
}) {
  if (!compact) return <>{children}</>;
  return (
    <details className="portable-proof-details">
      <summary>Inspect cryptographic claims and identifiers</summary>
      <div>{children}</div>
    </details>
  );
}

const custodyNonClaims = [
  "This proof does not establish that Runtime isolation was sufficient.",
  "This proof does not establish that the receiver Outcome Contract was sufficient.",
  "This proof does not establish that Validation commands were trustworthy.",
  "This proof does not establish that either signer clock was externally synchronized.",
  "A mathematically valid included key is not organizationally trusted by default.",
  "Transparency or blockchain publication cannot grant Admission or Promotion authority.",
];

function compactProofId(value: string): string {
  return value.length > 24 ? `${value.slice(0, 13)}…${value.slice(-8)}` : value;
}

function CustodyPolicyControl({
  role,
  onPolicy,
}: {
  role: "Producer" | "Receiver";
  onPolicy: (policy: SigningKeyTrustPolicy | null) => void;
}) {
  const [authorityFingerprint, setAuthorityFingerprint] = useState("");
  const [rotationSource, setRotationSource] = useState<string | null>(null);
  const [rotationFilename, setRotationFilename] = useState<string | null>(null);
  const [rotationReport, setRotationReport] =
    useState<PolicyAuthorityRotationVerificationReport | null>(null);
  const [policySource, setPolicySource] = useState<string | null>(null);
  const [policyFilename, setPolicyFilename] = useState<string | null>(null);
  const [policyReport, setPolicyReport] =
    useState<TrustPolicyVerificationReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const trustedRoot = authorityFingerprint.trim();
    if (rotationSource === null || !/^sha256:[a-f0-9]{64}$/.test(trustedRoot)) {
      setRotationReport(null);
      return () => {
        cancelled = true;
      };
    }
    void verifySignedPolicyAuthorityRotationEnvelopeJsonInBrowser(
      rotationSource,
      [trustedRoot as ReceiptDigest],
    ).then((next) => {
      if (!cancelled) setRotationReport(next);
    });
    return () => {
      cancelled = true;
    };
  }, [authorityFingerprint, rotationSource]);

  useEffect(() => {
    let cancelled = false;
    const trustedRoot = authorityFingerprint.trim();
    if (policySource === null || !/^sha256:[a-f0-9]{64}$/.test(trustedRoot)) {
      setPolicyReport(null);
      onPolicy(null);
      return () => {
        cancelled = true;
      };
    }
    const roots = [
      trustedRoot as ReceiptDigest,
      ...(rotationReport?.valid && rotationReport.nextAuthorityKeyId
        ? [rotationReport.nextAuthorityKeyId]
        : []),
    ];
    void verifySignedSigningKeyTrustPolicyEnvelopeJsonInBrowser(
      policySource,
      roots,
    ).then((next) => {
      if (cancelled) return;
      setPolicyReport(next);
      onPolicy(next.valid ? next.policy : null);
    });
    return () => {
      cancelled = true;
    };
  }, [authorityFingerprint, onPolicy, policySource, rotationReport]);

  const readArtifact = async (
    file: File | undefined,
    maximumBytes: number,
    kind: "rotation" | "policy",
  ) => {
    if (!file) return;
    setError(null);
    if (file.size < 1 || file.size > maximumBytes) {
      setError(
        `${role} ${kind} file is empty or exceeds its local byte limit.`,
      );
      return;
    }
    try {
      const source = await file.text();
      if (kind === "rotation") {
        setRotationFilename(file.name);
        setRotationSource(source);
      } else {
        setPolicyFilename(file.name);
        setPolicySource(source);
      }
    } catch {
      setError(
        `The browser could not read the ${role.toLowerCase()} ${kind} file.`,
      );
    }
  };

  return (
    <section
      className="custody-trust-domain"
      aria-label={`${role} organizational trust policy`}
      data-state={
        policyReport?.valid ? "verified" : policyReport ? "rejected" : "empty"
      }
    >
      <div className="custody-trust-domain-heading">
        <span>{role}</span>
        <strong>
          {policyReport?.valid
            ? "Policy authority verified"
            : policyReport
              ? "Policy authority rejected"
              : "Trust not evaluated"}
        </strong>
      </div>
      <label className="verifier-authority-root">
        <span>{role} trusted policy authority</span>
        <input
          type="text"
          value={authorityFingerprint}
          onChange={(event) => setAuthorityFingerprint(event.target.value)}
          placeholder="sha256: authority fingerprint"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <div className="custody-trust-files">
        <label
          className="verifier-policy-file"
          data-loaded={rotationSource !== null}
        >
          <input
            type="file"
            aria-label={`Import ${role.toLowerCase()} authority rotation`}
            accept="application/json,.json"
            onChange={(event) =>
              void readArtifact(event.target.files?.[0], 65_536, "rotation")
            }
          />
          <span>{rotationFilename ?? "Optional rotation"}</span>
        </label>
        <label
          className="verifier-policy-file"
          data-loaded={policySource !== null}
        >
          <input
            type="file"
            aria-label={`Import ${role.toLowerCase()} signed policy`}
            accept="application/json,.json"
            onChange={(event) =>
              void readArtifact(event.target.files?.[0], 131_072, "policy")
            }
          />
          <span>{policyFilename ?? "Import signed policy"}</span>
        </label>
      </div>
      {rotationReport && (
        <small>
          {rotationReport.valid
            ? "Authority continuity verified."
            : rotationReport.checks.find((check) => !check.valid)?.detail}
        </small>
      )}
      {policyReport && !policyReport.valid && (
        <small>
          {policyReport.checks.find((check) => !check.valid)?.detail}
        </small>
      )}
      {error && <small role="alert">{error}</small>}
    </section>
  );
}

function CustodyProofRoom({
  packet,
  report,
}: {
  packet: ReceiverCustodyPacket;
  report: ReceiverCustodyVerificationReport;
}) {
  const [producerPolicy, setProducerPolicy] =
    useState<SigningKeyTrustPolicy | null>(null);
  const [receiverPolicy, setReceiverPolicy] =
    useState<SigningKeyTrustPolicy | null>(null);
  const [trustReport, setTrustReport] =
    useState<ReceiverCustodyTrustReport | null>(null);
  const [tamperReport, setTamperReport] =
    useState<ReceiverCustodyVerificationReport | null>(null);
  const [tamperAttack, setTamperAttack] =
    useState<ReceiverCustodyTamperAttack | null>(null);
  const [tamperBusy, setTamperBusy] = useState(false);
  const verdictRef = useRef<HTMLDivElement | null>(null);
  const tamperRef = useRef<HTMLDivElement | null>(null);
  const onProducerPolicy = useCallback(
    (policy: SigningKeyTrustPolicy | null) => setProducerPolicy(policy),
    [],
  );
  const onReceiverPolicy = useCallback(
    (policy: SigningKeyTrustPolicy | null) => setReceiverPolicy(policy),
    [],
  );

  useEffect(() => {
    verdictRef.current?.focus();
  }, [report]);

  useEffect(() => {
    let cancelled = false;
    if (!producerPolicy && !receiverPolicy) {
      setTrustReport(null);
      return () => {
        cancelled = true;
      };
    }
    void evaluateReceiverCustodyTrustInBrowser(packet, {
      producer: producerPolicy,
      receiver: receiverPolicy,
    }).then((next) => {
      if (!cancelled) setTrustReport(next);
    });
    return () => {
      cancelled = true;
    };
  }, [packet, producerPolicy, receiverPolicy]);

  const runAttack = async (attack: ReceiverCustodyTamperAttack) => {
    setTamperBusy(true);
    setTamperAttack(attack);
    try {
      const copy = createReceiverCustodyTamperedCopy(packet, attack);
      setTamperReport(
        await verifyReceiverCustodyPacketJsonInBrowser(JSON.stringify(copy)),
      );
      window.setTimeout(() => tamperRef.current?.focus(), 0);
    } finally {
      setTamperBusy(false);
    }
  };

  const story = report.story;
  const failedCheck =
    tamperReport?.checks.find((check) => !check.valid) ?? null;
  const trustComplete =
    trustReport?.policiesDistinct === true &&
    trustReport.producer?.trusted === true &&
    trustReport.receiver?.trusted === true;

  if (!report.valid || !story) {
    const failed = report.checks.find((check) => !check.valid);
    return (
      <div className="custody-proof-room" data-valid="false">
        <div
          className="verifier-verdict"
          ref={verdictRef}
          tabIndex={-1}
          role="alert"
        >
          <span aria-hidden="true">!</span>
          <div>
            <strong>Custody proof rejected</strong>
            <small>
              {failed?.detail ?? "Do not rely on this custody evidence."}
            </small>
          </div>
        </div>
        <details className="custody-proof-details">
          <summary>Inspect failed cryptographic checks</summary>
          <div className="verifier-checks">
            {report.checks.map((check) => (
              <div key={check.name} data-valid={check.valid}>
                <span>{check.valid ? "PASS" : "FAIL"}</span>
                <div>
                  <strong>{check.name}</strong>
                  <small>{check.detail}</small>
                </div>
              </div>
            ))}
          </div>
        </details>
      </div>
    );
  }

  const nodes = [
    {
      name: "Producer signed work",
      detail: `${story.producer.producerId} · ${compactProofId(story.producer.receiptDigest)}`,
    },
    {
      name: "Receiver admitted evidence",
      detail: `Admission ${compactProofId(story.authority.admissionId)}`,
    },
    {
      name:
        story.approval === "operator-approved"
          ? "Local operator approved"
          : "Local policy admitted automatically",
      detail: story.authority.decisionContextDigest
        ? `Review ${compactProofId(story.authority.decisionContextDigest)}`
        : "No human Approval Decision was required",
    },
    {
      name: "Receiver Validation and authority",
      detail: `Evidence ${compactProofId(story.authority.validationEvidenceRoot)}`,
    },
    {
      name:
        story.disposition === "promoted"
          ? "Canonical State advanced"
          : "Candidate quarantined",
      detail:
        story.disposition === "promoted"
        ? `Accepted ${story.state.afterStateId}`
        : `Canonical State remained at ${story.state.beforeStateId}`,
    },
  ];

  return (
    <div className="custody-proof-room" data-valid="true">
      <div
        className="custody-primary-verdict"
        ref={verdictRef}
        tabIndex={-1}
        role="status"
      >
        <span aria-hidden="true">✓</span>
        <div>
          <strong>
            {story.disposition === "promoted"
              ? "Receiver custody path complete"
              : "Receiver containment path complete"}
          </strong>
          <small>
            {story.disposition === "promoted"
              ? "Canonical State advanced to the verified receiver state."
              : "Canonical State remained at the verified before-state."}
          </small>
        </div>
        <div
          className="custody-verdict-pills"
          aria-label="Independent verdicts"
        >
          <span data-state="valid">Cryptographically valid</span>
          <span
            data-state={
              trustComplete ? "valid" : trustReport ? "failed" : "neutral"
            }
          >
            {trustComplete
              ? "Both trust domains authorized"
              : trustReport && !trustReport.policiesDistinct
                ? "Trust domains must differ"
                : "Organizational trust not fully evaluated"}
          </span>
        </div>
      </div>

      <section
        className="custody-story"
        aria-label="Verified receiver custody path"
      >
        <div>
          <span className="eyebrow">Verified causal path</span>
          <strong>
            One signed handoff, five independently checked custody hops
          </strong>
        </div>
        <ol>
          {nodes.map((node, index) => (
            <li key={node.name}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{node.name}</strong>
                <small>{node.detail}</small>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <details className="custody-trust" open={false}>
        <summary>Evaluate organizational trust</summary>
        <p>
          Supply producer and receiver policy roots separately. The packet
          cannot authorize either signer or prefill either evaluator-controlled
          root.
        </p>
        <div className="custody-trust-grid">
          <CustodyPolicyControl role="Producer" onPolicy={onProducerPolicy} />
          <CustodyPolicyControl role="Receiver" onPolicy={onReceiverPolicy} />
        </div>
        <div className="custody-role-verdicts">
          {(["producer", "receiver"] as const).map((role) => {
            const result = trustReport?.[role] ?? null;
            return (
              <div
                key={role}
                data-state={
                  result ? (result.trusted ? "valid" : "failed") : "neutral"
                }
              >
                <strong>{role === "producer" ? "Producer" : "Receiver"}</strong>
                <small>{result?.detail ?? "Trust not evaluated"}</small>
              </div>
            );
          })}
        </div>
      </details>

      <section
        className="custody-tamper-lab"
        aria-label="Disposable custody proof attacks"
      >
        <div>
          <span className="eyebrow">Tamper lab</span>
          <strong>Attack a disposable copy</strong>
          <small>
            The imported original remains verified and unchanged in memory.
          </small>
        </div>
        <div className="custody-attack-actions">
          <button
            type="button"
            disabled={tamperBusy}
            onClick={() => void runAttack("remove-admission")}
          >
            Remove Admission
          </button>
          <button
            type="button"
            disabled={tamperBusy}
            onClick={() => void runAttack("alter-reviewed-evidence")}
          >
            Alter reviewed evidence
          </button>
          <button
            type="button"
            disabled={tamperBusy}
            onClick={() => void runAttack("rewrite-disposition")}
          >
            Rewrite disposition
          </button>
        </div>
        {tamperReport && (
          <div
            className="custody-attack-result"
            ref={tamperRef}
            tabIndex={-1}
            role="status"
          >
            <span aria-hidden="true">!</span>
            <div>
              <strong>
                Attack detected at {failedCheck?.name ?? "custody boundary"}
              </strong>
              <small>
                {failedCheck?.detail ?? "The disposable copy was rejected."}
              </small>
              <button
                type="button"
                onClick={() => {
                  setTamperAttack(null);
                  setTamperReport(null);
                }}
              >
                Reset disposable copy
              </button>
            </div>
          </div>
        )}
        {tamperAttack && !tamperReport && (
          <small>Verifying disposable attack locally…</small>
        )}
      </section>

      <details className="custody-proof-details">
        <summary>Inspect cryptographic checks and commitments</summary>
        <div className="verifier-checks">
          {report.checks.map((check) => (
            <div key={check.name} data-valid={check.valid}>
              <span>PASS</span>
              <div>
                <strong>{check.name}</strong>
                <small>{check.detail}</small>
              </div>
            </div>
          ))}
        </div>
        <div className="verifier-identities">
          <div>
            <span>Producer receipt</span>
            <code>{story.producer.receiptDigest}</code>
          </div>
          <div>
            <span>Receiver receipt</span>
            <code>{story.receiver.receiptDigest}</code>
          </div>
          <div>
            <span>Before state</span>
            <code>{story.state.beforeCompositeHash}</code>
          </div>
          <div>
            <span>After state</span>
            <code>{story.state.afterCompositeHash}</code>
          </div>
        </div>
      </details>

      <details className="verifier-limitations">
        <summary>What this proof does not establish</summary>
        <ul>
          {custodyNonClaims.map((claim) => (
            <li key={claim}>{claim}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function ReceiptVerifier({
  initialArtifact,
  agentStatus,
  onClose,
}: {
  initialArtifact: PortableVerifierArtifact | null;
  agentStatus: Agent["status"] | null;
  onClose: () => void;
}) {
  const openerRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const dialogRef = useRef<HTMLElement | null>(null);
  const [report, setReport] = useState<PortableVerificationReport | null>(null);
  const [packetReport, setPacketReport] =
    useState<PortableEvidencePacketVerificationReport | null>(null);
  const [chainReport, setChainReport] =
    useState<PortableDecisionChainVerificationReport | null>(null);
  const [decisionChain, setDecisionChain] =
    useState<PortableDecisionChain | null>(null);
  const [envelope, setEnvelope] = useState<PortablePromotionEnvelope | null>(
    null,
  );
  const [custodyPacket, setCustodyPacket] =
    useState<ReceiverCustodyPacket | null>(null);
  const [custodyReport, setCustodyReport] =
    useState<ReceiverCustodyVerificationReport | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trustPolicySource, setTrustPolicySource] = useState<string | null>(
    null,
  );
  const [trustPolicyReport, setTrustPolicyReport] =
    useState<TrustPolicyVerificationReport | null>(null);
  const [authorityFingerprint, setAuthorityFingerprint] = useState("");
  const [authorityRotationSource, setAuthorityRotationSource] = useState<
    string | null
  >(null);
  const [authorityRotationReport, setAuthorityRotationReport] =
    useState<PolicyAuthorityRotationVerificationReport | null>(null);
  const [authorityRotationFilename, setAuthorityRotationFilename] = useState<
    string | null
  >(null);
  const [authorityRotationError, setAuthorityRotationError] = useState<
    string | null
  >(null);
  const [trustPolicyFilename, setTrustPolicyFilename] = useState<string | null>(
    null,
  );
  const [trustPolicyError, setTrustPolicyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState<"approve" | "deny" | null>(
    null,
  );
  const [approvalReason, setApprovalReason] = useState("");

  const verifySource = useCallback(
    async (source: string, sourceName: string) => {
    setFilename(sourceName);
    setReport(null);
    setPacketReport(null);
    setChainReport(null);
    setDecisionChain(null);
    setEnvelope(null);
    setCustodyPacket(null);
    setCustodyReport(null);
    setError(null);
    setBusy(true);
    try {
      const parsed = JSON.parse(source) as PortableVerifierArtifact;
        if (
          parsed.schema === "agent-airlock/portable-receiver-chain-of-custody"
        ) {
        const nextCustodyReport =
          await verifyReceiverCustodyPacketJsonInBrowser(source);
        setCustodyPacket(parsed);
        setCustodyReport(nextCustodyReport);
      } else if (parsed.schema === "agent-airlock/portable-decision-chain") {
        const nextChainReport =
          await verifyPortableDecisionChainJsonInBrowser(source);
        const leafPacket = parsed.packets.at(-1);
        const leafPacketReport = nextChainReport.packets.at(-1) ?? null;
        setChainReport(nextChainReport);
        setDecisionChain(parsed);
        setPacketReport(leafPacketReport);
        setReport(leafPacketReport?.receipt ?? null);
        if (leafPacket) setEnvelope(leafPacket.envelope);
        if (!leafPacketReport) {
          setError("The browser could not verify this decision chain.");
        }
      } else if (parsed.schema === "agent-airlock/portable-evidence-packet") {
        const nextPacketReport =
          await verifyPortableEvidencePacketJsonInBrowser(source);
        setPacketReport(nextPacketReport);
        setReport(nextPacketReport.receipt);
        if (nextPacketReport.valid) setEnvelope(parsed.envelope);
      } else {
          const nextReport =
            await verifyPortablePromotionEnvelopeJsonInBrowser(source);
        setReport(nextReport);
        if (nextReport.valid) setEnvelope(parsed);
      }
    } catch {
      setError("The browser could not read this receipt file.");
    } finally {
      setBusy(false);
    }
    },
    [],
  );

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (
        event.shiftKey &&
        (active === first || !dialogRef.current.contains(active))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !dialogRef.current.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    dialogRef.current
      ?.querySelector<HTMLElement>("[data-verifier-close]")
      ?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      openerRef.current?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (!initialArtifact) return;
    const sourceName =
      initialArtifact.schema === "agent-airlock/portable-decision-chain"
      ? "Generated decision chain"
      : initialArtifact.schema === "agent-airlock/portable-evidence-packet"
        ? "Generated evidence packet"
          : initialArtifact.schema ===
              "agent-airlock/portable-receiver-chain-of-custody"
          ? "Generated receiver custody proof"
          : "Generated receipt";
    void verifySource(JSON.stringify(initialArtifact), sourceName);
  }, [initialArtifact, verifySource]);

  useEffect(() => {
    let cancelled = false;
    const trustedRoot = authorityFingerprint.trim();
    if (
      trustPolicySource === null ||
      !/^sha256:[a-f0-9]{64}$/.test(trustedRoot)
    ) {
      setTrustPolicyReport(null);
      return () => {
        cancelled = true;
      };
    }
    void verifySignedSigningKeyTrustPolicyEnvelopeJsonInBrowser(
      trustPolicySource,
      [
        trustedRoot as ReceiptDigest,
        ...(authorityRotationReport?.valid &&
        authorityRotationReport.nextAuthorityKeyId &&
        authorityRotationReport.nextAuthorityKeyId !== trustedRoot
          ? [authorityRotationReport.nextAuthorityKeyId]
          : []),
      ],
    ).then((nextReport) => {
      if (!cancelled) setTrustPolicyReport(nextReport);
    });
    return () => {
      cancelled = true;
    };
  }, [authorityFingerprint, authorityRotationReport, trustPolicySource]);

  useEffect(() => {
    let cancelled = false;
    const trustedRoot = authorityFingerprint.trim();
    if (
      authorityRotationSource === null ||
      !/^sha256:[a-f0-9]{64}$/.test(trustedRoot)
    ) {
      setAuthorityRotationReport(null);
      return () => {
        cancelled = true;
      };
    }
    void verifySignedPolicyAuthorityRotationEnvelopeJsonInBrowser(
      authorityRotationSource,
      [trustedRoot as ReceiptDigest],
    ).then((nextReport) => {
      if (!cancelled) setAuthorityRotationReport(nextReport);
    });
    return () => {
      cancelled = true;
    };
  }, [authorityFingerprint, authorityRotationSource]);

  const verifyFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size < 1 || file.size > 16 * 1_048_576) {
      setError(
        "Choose a non-empty receiver custody proof no larger than 16 MB, or another portable proof no larger than 4 MB.",
      );
      return;
    }
    try {
      await verifySource(await file.text(), file.name);
    } catch {
      setError("The browser could not read this receipt file.");
    }
  };

  const importTrustPolicy = async (file: File | undefined) => {
    if (!file) return;
    setTrustPolicyFilename(file.name);
    setTrustPolicySource(null);
    setTrustPolicyReport(null);
    setTrustPolicyError(null);
    if (file.size < 1 || file.size > 131_072) {
      setTrustPolicyError(
        "Choose a non-empty signed trust policy no larger than 128 KB.",
      );
      return;
    }
    try {
      setTrustPolicySource(await file.text());
    } catch (reason) {
      setTrustPolicyError(
        reason instanceof Error
          ? reason.message
          : "The trust policy is invalid.",
      );
    }
  };

  const importAuthorityRotation = async (file: File | undefined) => {
    if (!file) return;
    setAuthorityRotationFilename(file.name);
    setAuthorityRotationSource(null);
    setAuthorityRotationReport(null);
    setAuthorityRotationError(null);
    if (file.size < 1 || file.size > 65_536) {
      setAuthorityRotationError(
        "Choose a non-empty signed authority rotation no larger than 64 KB.",
      );
      return;
    }
    try {
      setAuthorityRotationSource(await file.text());
    } catch (reason) {
      setAuthorityRotationError(
        reason instanceof Error
          ? reason.message
          : "The authority rotation is invalid.",
      );
    }
  };

  const evidenceValid = report
    ? (chainReport?.valid ?? packetReport?.valid ?? report.valid)
    : false;
  const organizationalTrustEvaluations =
    report && envelope && trustPolicyReport?.valid && trustPolicyReport.policy
      ? (
          decisionChain?.packets.map((packet) => packet.envelope) ?? [envelope]
        ).map((candidateEnvelope) =>
          evaluateSigningKeyTrust(
            candidateEnvelope,
            trustPolicyReport.policy!,
            {
              cryptographicValid: evidenceValid,
            },
          ),
        )
      : [];
  const failedOrganizationalTrust = organizationalTrustEvaluations.find(
    (evaluation) => !evaluation.trusted,
  );
  const organizationalTrust =
    organizationalTrustEvaluations.length > 0
    ? {
        trusted: failedOrganizationalTrust === undefined,
        detail: failedOrganizationalTrust
          ? failedOrganizationalTrust.detail
          : decisionChain && organizationalTrustEvaluations.length > 1
            ? `The signed policy authorizes all ${organizationalTrustEvaluations.length} receipt signers in this decision chain.`
            : organizationalTrustEvaluations[0]!.detail,
        policyId: organizationalTrustEvaluations[0]!.policyId,
      }
    : null;
  const recordingChainRoot = decisionChain?.packets[0]?.envelope ?? null;
  const recordingChainLeaf = decisionChain?.packets.at(-1)?.envelope ?? null;
  const recordingHandoffHash = recordingChainRoot
    ? shortHash(recordingChainRoot.receipt.state.after.compositeHash)
    : null;

  return (
    <div className="modal-backdrop verifier-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="receipt-verifier"
        role="dialog"
        aria-modal="true"
        aria-labelledby="receipt-verifier-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="receipt-verifier-heading">
          <div>
            <span className="eyebrow">Independent verifier</span>
            <h2 id="receipt-verifier-title">
              Verify integrity locally without querying the server
            </h2>
            <p>
              Your file stays in this browser. Web Crypto checks the canonical
              SHA-256 digest, Ed25519 signature, included key identity,
              disclosed Merkle proofs, complete Repair lineage, transparency
              inclusion, and digest-only calldata when present.
            </p>
          </div>
          <button
            type="button"
            data-verifier-close
            aria-label="Close receipt verifier"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="verifier-boundary" role="note">
          <span>LOCAL ONLY</span>
          <strong>
            0 API calls · 0 uploads
            {chainReport?.valid
              ? ` · ${chainReport.packets.length} signed decisions linked`
              : ""}
            {" · 16 MB custody / 4 MB other proofs"}
          </strong>
          {agentStatus !== null && (
            <small>Agent remains {agentStatus.toUpperCase()}</small>
          )}
        </div>

        {chainReport?.valid && recordingChainRoot && recordingChainLeaf && (
          <section
            className="verifier-recording-proof"
            aria-label="Verified chain summary"
          >
            <div data-recording-proof="signatures">
              <span>Signatures</span>
              <strong>
                {chainReport.packets.filter((packet) => packet.valid).length}/
                {chainReport.packets.length} valid
              </strong>
            </div>
            <div data-recording-proof="parent-digest">
              <span>Parent receipt digest link</span>
              <strong>PASS</strong>
            </div>
            <div data-recording-proof="state-handoff">
              <span>Canonical State handoff</span>
              <code>
                {recordingHandoffHash?.slice(0, 12)} ={" "}
                {shortHash(
                  recordingChainLeaf.receipt.state.before.compositeHash,
                ).slice(0, 12)}
              </code>
            </div>
            <div data-recording-proof="exact-lineage">
              <span>Exact parent link</span>
              <code>
                Parent {recordingChainRoot.receipt.decision.runId} → Repair{" "}
                {recordingChainLeaf.receipt.decision.runId}
              </code>
            </div>
          </section>
        )}

        <label
          className="receipt-dropzone"
          data-loaded={filename !== null}
          data-generated={initialArtifact !== null}
        >
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => void verifyFile(event.target.files?.[0])}
          />
          <span aria-hidden="true">⌁</span>
          <strong>
            {initialArtifact
              ? "Generated decision chain loaded"
              : (filename ??
                "Choose a receipt, custody proof, packet, or decision chain")}
          </strong>
          <small>
            {busy
              ? "Verifying locally…"
              : initialArtifact
                ? "Verified directly from the exact generated artifact"
                : "Select an exported Agent Airlock JSON file"}
          </small>
        </label>

        {error && (
          <div className="verifier-error" role="alert">
            {error}
          </div>
        )}

        {custodyPacket && custodyReport && (
          <CustodyProofRoom packet={custodyPacket} report={custodyReport} />
        )}

        {report && (
          <div className="verifier-report" data-valid={evidenceValid}>
            <div className="verifier-verdict">
              <span aria-hidden="true">{evidenceValid ? "✓" : "!"}</span>
              <div>
                <strong>
                  {evidenceValid
                    ? "Cryptographic proof valid"
                    : "Verification failed"}
                </strong>
                <small>
                  {evidenceValid
                    ? packetReport
                      ? chainReport
                        ? "Every receipt, parent link, and state handoff agrees."
                        : "The receipt and every bundled proof agree."
                      : "This exact statement was signed by the included key."
                    : "Do not rely on this evidence."}
                </small>
              </div>
            </div>

            {chainReport && (
              <section
                className="verifier-packet"
                aria-label="Decision chain checks"
              >
                <div>
                  <span className="eyebrow">Complete decision chain</span>
                  <strong>
                    {chainReport.valid
                      ? `${chainReport.packets.length} signed decisions linked`
                      : "Decision chain broken"}
                  </strong>
                  <small>
                    The browser independently checks every receipt, exact parent
                    digest, lineage depth, and Canonical State handoff from root
                    to leaf.
                  </small>
                </div>
                <div className="verifier-checks">
                  {chainReport.checks.map((check) => (
                <div key={check.name} data-valid={check.valid}>
                  <span>{check.valid ? "PASS" : "FAIL"}</span>
                  <div>
                    <strong>{check.name}</strong>
                    <small>{check.detail}</small>
                  </div>
                </div>
              ))}
            </div>
              </section>
            )}

            <div
              className="verifier-checks"
              aria-label="Receipt verification checks"
            >
              {report.checks.map((check) => (
                    <div key={check.name} data-valid={check.valid}>
                      <span>{check.valid ? "PASS" : "FAIL"}</span>
                      <div>
                        <strong>{check.name}</strong>
                        <small>{check.detail}</small>
                      </div>
                    </div>
                  ))}
                </div>

            {packetReport && (
              <section
                className="verifier-packet"
                aria-label="Evidence packet checks"
              >
                <div>
                  <span className="eyebrow">Evidence packet</span>
                  <strong>
                    {packetReport.valid
                      ? "Every included proof matches"
                      : "Bundled proof mismatch"}
                  </strong>
                  <small>
                    Optional proofs are never silently ignored. Any included
                    invalid proof rejects the packet.
                  </small>
                </div>
                <div className="verifier-checks">
                  {packetReport.checks.map((check) => (
                    <div key={check.name} data-valid={check.valid}>
                      <span>{check.valid ? "PASS" : "FAIL"}</span>
                      <div>
                        <strong>{check.name}</strong>
                        <small>{check.detail}</small>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <div className="verifier-identities">
              <div>
                <span>Receipt digest</span>
                <code>{report.receiptDigest ?? "unavailable"}</code>
              </div>
              <div>
                <span>Signing key</span>
                <code>{report.keyId ?? "unavailable"}</code>
              </div>
            </div>

            {envelope &&
              packetReport?.valid &&
              envelope.receipt.ancestry.parentRunId !== null && (
                <section
                  className="verifier-lineage-proof"
                  aria-label="Signed ancestry commitment"
                >
                  <div>
                    <span className="eyebrow">Signed ancestry</span>
                    <strong>Repair lineage committed</strong>
                    <small>
                      {decisionChain
                        ? "The complete chain includes this parent and validates its exact receipt digest and Canonical State handoff."
                        : "This receipt names its parent Run and prior receipt digest. Import the parent receipt separately to validate the complete chain."}
                    </small>
                  </div>
                  <dl>
                    <div>
                      <dt>Depth</dt>
                      <dd>{envelope.receipt.ancestry.depth}</dd>
                    </div>
                    <div>
                      <dt>Parent Run</dt>
                      <dd>
                        <code>{envelope.receipt.ancestry.parentRunId}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Prior receipt</dt>
                      <dd>
                        <code>
                          {envelope.receipt.ancestry.previousReceiptDigest ??
                            "unavailable"}
                        </code>
                      </dd>
                    </div>
                  </dl>
                </section>
              )}

            {evidenceValid && (
              <section
                className="verifier-trust-policy"
                aria-label="Organizational trust policy"
              >
                <div>
                  <span className="eyebrow">Optional second verdict</span>
                  <strong>
                    {decisionChain
                      ? "Does your organization trust every signer in this chain?"
                      : "Does your organization trust this signer?"}
                  </strong>
                  <small>
                    Pin the authority fingerprint received out of band,
                    optionally prove continuity to a rotated key, then import
                    its signed policy. No file can authorize itself.
                  </small>
                </div>
                <div className="verifier-trust-inputs">
                  <label className="verifier-authority-root">
                    <span>Trusted policy authority</span>
                    <input
                      type="text"
                      value={authorityFingerprint}
                      onChange={(event) =>
                        setAuthorityFingerprint(event.target.value)
                      }
                      placeholder="sha256: authority fingerprint"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </label>
                  <label
                    className="verifier-policy-file"
                    data-loaded={authorityRotationSource !== null}
                  >
                    <input
                      type="file"
                      aria-label="Import authority rotation"
                      accept="application/json,.json"
                      onChange={(event) =>
                        void importAuthorityRotation(event.target.files?.[0])
                      }
                    />
                    <span>
                      {authorityRotationFilename ??
                        "Optional authority rotation"}
                    </span>
                  </label>
                  <label
                    className="verifier-policy-file"
                    data-loaded={trustPolicySource !== null}
                  >
                    <input
                      type="file"
                      aria-label="Import signed policy"
                      accept="application/json,.json"
                      onChange={(event) =>
                        void importTrustPolicy(event.target.files?.[0])
                      }
                    />
                    <span>{trustPolicyFilename ?? "Import signed policy"}</span>
                  </label>
                </div>
              </section>
            )}

            {trustPolicyError && (
              <div className="verifier-error" role="alert">
                {trustPolicyError}
              </div>
            )}

            {authorityRotationError && (
              <div className="verifier-error" role="alert">
                {authorityRotationError}
              </div>
            )}

            {authorityRotationReport && (
              <div
                className="verifier-policy-verdict"
                data-authorized={authorityRotationReport.valid}
                role="status"
              >
                <strong>
                  {authorityRotationReport.valid
                    ? "Authority continuity verified"
                    : "Authority rotation rejected"}
                </strong>
                <small>
                  {authorityRotationReport.valid
                    ? "The pinned authority signed an effective transition to the policy's authority key."
                    : authorityRotationReport.checks.find(
                        (check) => !check.valid,
                      )?.detail}
                </small>
              </div>
            )}

            {trustPolicyReport && (
              <div
                className="verifier-policy-verdict"
                data-authorized={trustPolicyReport.valid}
                role="status"
              >
                <strong>
                  {trustPolicyReport.valid
                    ? "Policy authority verified"
                    : "Policy authority rejected"}
                </strong>
                <small>
                  {trustPolicyReport.valid
                    ? "Its digest, Ed25519 signature, and pinned authority fingerprint all match."
                    : trustPolicyReport.checks.find((check) => !check.valid)
                        ?.detail}
                </small>
              </div>
            )}

            {organizationalTrust && (
              <div
                className="verifier-trust-verdict"
                data-trusted={organizationalTrust.trusted}
                role="status"
              >
                <span aria-hidden="true">
                  {organizationalTrust.trusted ? "✓" : "!"}
                </span>
                <div>
                  <strong>
                    {organizationalTrust.trusted
                      ? decisionChain
                        ? "All chain signers trusted"
                        : "Organizational signer trust passed"
                      : "Organizational signer trust failed"}
                  </strong>
                  <small>{organizationalTrust.detail}</small>
                  <code>{organizationalTrust.policyId}</code>
                </div>
              </div>
            )}

            {trustPolicyReport && (
              <section
                className="verifier-trust-chain"
                aria-label="Verified trust chain"
              >
                <div className="verifier-chain-heading">
                  <span className="eyebrow">Decision path</span>
                  <strong>
                    {decisionChain
                      ? "Why every chain signer is or is not trusted"
                      : "Why this signer is or is not trusted"}
                  </strong>
                </div>
                <div className="verifier-chain-steps">
                  <div
                    className="verifier-chain-node"
                    data-valid={/^sha256:[a-f0-9]{64}$/.test(
                      authorityFingerprint.trim(),
                    )}
                  >
                    <span>01</span>
                    <strong>Pinned root</strong>
                    <small>Evaluator supplied</small>
                  </div>
                  {authorityRotationSource !== null && (
                    <>
                      <i aria-hidden="true">→</i>
                      <div
                        className="verifier-chain-node"
                        data-valid={authorityRotationReport?.valid === true}
                      >
                        <span>02</span>
                        <strong>Key rotation</strong>
                        <small>
                          {authorityRotationReport?.valid
                            ? "Continuity verified"
                            : "Transition rejected"}
                        </small>
                      </div>
                    </>
                  )}
                  <i aria-hidden="true">→</i>
                  <div
                    className="verifier-chain-node"
                    data-valid={trustPolicyReport.valid}
                  >
                    <span>
                      {authorityRotationSource !== null ? "03" : "02"}
                    </span>
                    <strong>Signed policy</strong>
                    <small>
                      {trustPolicyReport.valid
                        ? "Authority verified"
                        : "Rejected"}
                    </small>
                  </div>
                  <i aria-hidden="true">→</i>
                  <div
                    className="verifier-chain-node"
                    data-valid={organizationalTrust?.trusted === true}
                  >
                    <span>
                      {authorityRotationSource !== null ? "04" : "03"}
                    </span>
                    <strong>
                      {decisionChain
                        ? `${decisionChain.packets.length} receipt signers`
                        : "Receipt signer"}
                    </strong>
                    <small>
                      {organizationalTrust?.trusted
                        ? "Scope trusted"
                        : organizationalTrust
                          ? "Trust failed"
                          : "Not authorized"}
                    </small>
                  </div>
                </div>
              </section>
            )}

            <details className="verifier-limitations">
              <summary>What this proof does not establish</summary>
              <ul>
                {report.unsupportedClaims.map((claim) => (
                  <li key={claim}>{claim}</li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </section>
    </div>
  );
}

function PortableTrustExport({
  runId,
  evidenceRevision,
  judgeProofMode = false,
  automaticProofRequestNonce = null,
  onError,
  onVerifyArtifact,
  onAutomaticProofResult,
}: {
  runId: string;
  evidenceRevision: string;
  judgeProofMode?: boolean;
  automaticProofRequestNonce?: number | null;
  onError: (message: string) => void;
  onVerifyArtifact?: (artifact: PortableVerifierArtifact) => void;
  onAutomaticProofResult?: (
    runId: string,
    verification: AutomaticProofVerification,
  ) => void;
}) {
  const [result, setResult] = useState<PortableReceiptExport | null>(null);
  const [availableDisclosures, setAvailableDisclosures] = useState<
    PortableReceiptExport["availableDisclosures"]
  >([]);
  const [selectedDisclosures, setSelectedDisclosures] = useState<string[]>([]);
  const [localAnchor, setLocalAnchor] = useState(false);
  const [evmPayload, setEvmPayload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [federatedExportBusy, setFederatedExportBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const requestGeneration = useRef(0);
  const automaticGenerationRequest = useRef<string | null>(null);

  useEffect(() => {
    requestGeneration.current += 1;
    setResult(null);
    setAvailableDisclosures([]);
    setSelectedDisclosures([]);
    setLocalAnchor(false);
    setEvmPayload(false);
    setBusy(false);
    setDirty(false);
  }, [runId, evidenceRevision]);

  const generate = async () => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setBusy(true);
    try {
      const exported = await api.exportPortableReceipt(runId, {
        disclosureIdentities: selectedDisclosures,
        includeAncestry: true,
        localAnchor,
        evmPayload,
      });
      const artifact = exported.decisionChain ?? exported.packet;
      const browserReport = exported.decisionChain
        ? await verifyPortableDecisionChainJsonInBrowser(
            JSON.stringify(exported.decisionChain),
          )
        : await verifyPortableEvidencePacketJsonInBrowser(
            JSON.stringify(exported.packet),
          );
      if (requestGeneration.current !== generation) return;
      setResult(exported);
      setAvailableDisclosures(exported.availableDisclosures);
      setDirty(false);
      const valid = exported.verification.valid && browserReport.valid;
      onAutomaticProofResult?.(runId, {
        valid,
        error: valid
          ? undefined
          : "The generated decision chain failed local browser verification.",
        artifact,
        decisionCount: exported.decisionChain?.packets.length ?? 1,
        leafReceiptDigest: exported.decisionChain
          ? (browserReport as PortableDecisionChainVerificationReport)
              .leafReceiptDigest
          : null,
      });
    } catch (reason) {
      if (requestGeneration.current === generation) {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        onError(message);
        onAutomaticProofResult?.(runId, {
          valid: false,
          error: message,
          decisionCount: 0,
        });
      }
    } finally {
      if (requestGeneration.current === generation) setBusy(false);
    }
  };

  const exportFederatedBundle = async () => {
    setFederatedExportBusy(true);
    try {
      const exported = await api.exportFederatedWorkBundle(runId);
      if (!exported.verification.valid) {
        throw new Error("The federated bundle failed its server self-check.");
      }
      downloadJson(
        exported.bundle,
        `agent-airlock-federated-work-${runId}.json`,
      );
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFederatedExportBusy(false);
    }
  };

  useEffect(() => {
    if (automaticProofRequestNonce === null) return;
    const requestIdentity = `${runId}:${automaticProofRequestNonce}`;
    if (automaticGenerationRequest.current === requestIdentity) return;
    automaticGenerationRequest.current = requestIdentity;
    void generate();
  }, [automaticProofRequestNonce, runId]);

  const invalidatePendingExport = () => {
    requestGeneration.current += 1;
    setBusy(false);
    setDirty(true);
  };

  const downloadJson = (value: unknown, filename: string) => {
    if (!result || dirty) return;
    const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const toggleDisclosure = (identity: string, checked: boolean) => {
    setSelectedDisclosures((current) =>
      checked
        ? [...current, identity].sort()
        : current.filter((candidate) => candidate !== identity),
    );
    invalidatePendingExport();
  };

  const optionalPublicationControls = (
    <>
      <div className="portable-options">
        <label>
          <input
            type="checkbox"
            checked={localAnchor}
            onChange={(event) => {
              setLocalAnchor(event.target.checked);
              invalidatePendingExport();
            }}
          />
          <span>
            <strong>Append to local transparency log</strong>
            <small>
              Lets cooperating observers retain checkpoints and detect later log
              rewrites. Receipt validity never depends on it.
            </small>
          </span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={evmPayload}
            onChange={(event) => {
              setEvmPayload(event.target.checked);
              invalidatePendingExport();
            }}
          />
          <span>
            <strong>Prepare digest-only EVM calldata</strong>
            <small>
              For mutually distrusting organizations that need shared
              publication evidence. No chain call, wallet, RPC, or funds are
              used.
            </small>
          </span>
        </label>
      </div>
      <p className="portable-trust-levels">
        A signature is sufficient for ordinary offline verification. A retained
        checkpoint adds rewrite detection, while a public anchor only adds
        shared publication evidence. Neither makes a false statement true or
        grants the signer authority.
      </p>
    </>
  );
  const hasDecisionChain = (result?.decisionChain?.packets.length ?? 0) > 1;
  const proofVerified = result?.verification.valid === true && !dirty;
  const requiredDisclosureCount = availableDisclosures.filter(
    (disclosure) => disclosure.required,
  ).length;
  const optionalDisclosureCount =
    availableDisclosures.length - requiredDisclosureCount;
  const requiredDisclosureIdentities = availableDisclosures
    .filter((disclosure) => disclosure.required)
    .map((disclosure) => disclosure.identity);
  const selectedRequiredCount = requiredDisclosureIdentities.filter(
    (identity) => selectedDisclosures.includes(identity),
  ).length;
  const allRequiredSelected =
    requiredDisclosureCount > 0 &&
    selectedRequiredCount === requiredDisclosureCount;

  const evidenceCommitmentLabel = (identity: string) => {
    const separator = identity.lastIndexOf(":");
    const commitment = identity.slice(separator + 1, separator + 9);
    return `Evidence commitment ${commitment}`;
  };

  const selectAllRequiredDisclosures = () => {
    setSelectedDisclosures((current) =>
      [...new Set([...current, ...requiredDisclosureIdentities])].sort(),
    );
    invalidatePendingExport();
  };

  const clearDisclosures = () => {
    setSelectedDisclosures([]);
    invalidatePendingExport();
  };

  return (
    <section className="portable-trust" aria-label="Portable trust receipt">
      <header className="portable-trust-heading">
        <div>
          <span className="eyebrow">
            {judgeProofMode ? "Independent proof" : "Portable Trust"}
          </span>
          <h4>
            {judgeProofMode
              ? proofVerified
                ? hasDecisionChain
                  ? "Signed recovery independently verified"
                  : "Signed decision independently verified"
                : "Make this decision independently verifiable"
              : "Export a signed decision statement"}
          </h4>
          <p>
            {judgeProofMode
              ? proofVerified
                ? hasDecisionChain
                  ? "Two signed decisions, their parent link, and every Canonical State handoff verified locally."
                  : "The signed decision and its private-by-default evidence packet verified locally."
                : "Generate a private-by-default evidence packet and verify its signature locally before download."
              : "Offline verification proves that the included Ed25519 key signed the canonical content. It proves key possession, not that the reported state existed or was reported truthfully."}
          </p>
          {!judgeProofMode && (
            <p>
              Always included: stable Run and Agent identifiers, timestamps,
              state and resource fingerprints, and evidence hashes. Raw prompts,
              outputs, credentials, and local paths always stay out. Only
              bounded redacted Validation leaves are opt-in.
            </p>
          )}
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={() => void generate()}
          disabled={busy}
        >
          {busy ? (
            <Spinner />
          ) : result ? (
            judgeProofMode ? (
              proofVerified ? (
                "Reverify proof"
              ) : (
                "Regenerate proof"
              )
            ) : (
              "Regenerate receipt"
            )
          ) : judgeProofMode ? (
            "Generate and verify proof"
          ) : (
            "Generate receipt"
          )}
        </button>
      </header>

      {judgeProofMode ? (
        <details className="portable-advanced-options">
          <summary>Add transparency or blockchain publication evidence</summary>
          {optionalPublicationControls}
        </details>
      ) : (
        optionalPublicationControls
      )}

      {availableDisclosures.length > 0 && (
        <details className="portable-disclosures">
          <summary>
            Disclose signed evidence ({selectedDisclosures.length}/
            {availableDisclosures.length} selected)
          </summary>
          <p>
            The signed Merkle root commits to {availableDisclosures.length}{" "}
            Validation
            {availableDisclosures.length === 1 ? " leaf" : " leaves"}:{" "}
            {requiredDisclosureCount}
            {" required and "}
            {optionalDisclosureCount} optional. Only selected redacted leaves
            and their inclusion proofs enter the downloaded envelope.
          </p>
          <div className="portable-disclosure-actions">
            <span>
              <strong>
                {selectedRequiredCount}/{requiredDisclosureCount} required
                selected
              </strong>
              <small>
                Nothing is disclosed unless you deliberately select and
                regenerate it.
              </small>
            </span>
            <div>
              <button
                type="button"
                className="button button-ghost"
                onClick={selectAllRequiredDisclosures}
                disabled={allRequiredSelected}
              >
                Select all required
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={clearDisclosures}
                disabled={selectedDisclosures.length === 0}
              >
                Clear selection
              </button>
            </div>
          </div>
          <div className="portable-disclosure-grid">
            {availableDisclosures.map((disclosure) => (
              <label key={disclosure.identity}>
                <input
                  type="checkbox"
                  checked={selectedDisclosures.includes(disclosure.identity)}
                  onChange={(event) =>
                    toggleDisclosure(disclosure.identity, event.target.checked)
                  }
                />
                <span>
                  <strong>
                    {evidenceCommitmentLabel(disclosure.identity)} ·{" "}
                    {disclosure.status}{" "}
                    {disclosure.required ? "required" : "optional"}
                  </strong>
                  <small>{disclosure.summary ?? disclosure.category}</small>
                </span>
              </label>
            ))}
          </div>
        </details>
      )}

      {result && (
        <div className="portable-result" data-valid={result.verification.valid}>
          <div className="portable-result-status">
            <span aria-hidden="true">
              {result.verification.valid ? "✓" : "!"}
            </span>
            <div>
              <strong>
                {result.verification.valid
                  ? judgeProofMode
                    ? "Signed proof verified locally"
                    : "Self-check passed"
                  : "Receipt verification failed"}
              </strong>
              <small>
                {dirty
                  ? "Options changed. Regenerate before downloading."
                  : hasDecisionChain
                    ? judgeProofMode
                      ? `${result.decisionChain!.packets.length} signed decisions verified locally with every Canonical State handoff intact.`
                      : `One complete chain proves all ${result.decisionChain!.packets.length} signed decisions and their Canonical State handoffs.`
                  : judgeProofMode
                    ? "The signed decision and evidence packet verified locally for independent offline inspection."
                  : result.anchor && result.evmPayload
                    ? "One packet contains the signed receipt, checkpoint proof, and digest-only EVM calldata."
                    : result.anchor
                      ? "One packet contains the signed receipt and checkpoint proof."
                      : result.evmPayload
                        ? "One packet contains the signed receipt and digest-only EVM calldata."
                        : "One packet contains the signed receipt for independent offline verification."}
              </small>
            </div>
            {!judgeProofMode && (
              <button
                type="button"
                className="button button-ghost"
                onClick={() =>
                  downloadJson(
                    result.envelope,
                    `agent-airlock-receipt-${runId}.json`,
                  )
                }
                disabled={dirty || !result.verification.valid}
              >
                Download receipt JSON
              </button>
            )}
            {!judgeProofMode &&
              result.envelope.receipt.decision.disposition === "promoted" && (
              <button
                type="button"
                className="button button-ghost"
                onClick={() => void exportFederatedBundle()}
                  disabled={
                    dirty || !result.verification.valid || federatedExportBusy
                  }
              >
                  {federatedExportBusy ? (
                    <Spinner />
                  ) : (
                    "Download federated work"
                  )}
              </button>
            )}
            {(!judgeProofMode || !hasDecisionChain) && (
              <button
                type="button"
                className={`button ${hasDecisionChain ? "button-ghost" : "button-primary"}`}
                onClick={() =>
                  downloadJson(
                    result.packet,
                    `agent-airlock-evidence-${runId}.json`,
                  )
                }
                disabled={dirty || !result.verification.valid}
              >
                {judgeProofMode
                  ? "Download verified evidence packet"
                  : "Download evidence packet"}
              </button>
            )}
            {hasDecisionChain && (
              <button
                type="button"
                className="button button-primary"
                onClick={() =>
                  downloadJson(
                    result.decisionChain,
                    `agent-airlock-decision-chain-${runId}.json`,
                  )
                }
                disabled={dirty || !result.verification.valid}
              >
                {judgeProofMode
                  ? "Download verified decision chain"
                  : "Download complete decision chain"}
              </button>
            )}
            {judgeProofMode && onVerifyArtifact && (
              <button
                type="button"
                className="button button-ghost"
                onClick={() =>
                  onVerifyArtifact(result.decisionChain ?? result.packet)
                }
                disabled={dirty || !result.verification.valid}
              >
                Inspect in zero-upload verifier
              </button>
            )}
          </div>
          <PortableProofDetails compact={judgeProofMode}>
          <div className="portable-identities">
            <div>
              <span>Receipt digest</span>
              <code>{result.envelope.receiptDigest}</code>
            </div>
            <div>
              <span>Signing key</span>
              <code>{result.envelope.keyId}</code>
            </div>
          </div>
          <div className="portable-claims">
            <div>
              <strong>Cryptographically supported</strong>
              <ul>
                {result.verification.provenClaims.map((claim) => (
                  <li key={claim}>{claim}</li>
                ))}
              </ul>
            </div>
            <div>
              <strong>Not proven by this receipt</strong>
              <ul>
                {result.verification.unsupportedClaims.map((claim) => (
                  <li key={claim}>{claim}</li>
                ))}
              </ul>
            </div>
          </div>
          {(result.anchor || result.evmPayload) && (
            <div className="portable-optional-proof">
              {result.anchor && (
                <div>
                  <span>
                      Local checkpoint{" "}
                      {result.anchor.checkpoint.checkpoint.treeSize} ·{" "}
                    {shortHash(result.anchor.checkpoint.checkpoint.root)}
                  </span>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={dirty || !result.verification.valid}
                    onClick={() =>
                      downloadJson(
                        result.anchor,
                        `agent-airlock-anchor-${runId}.json`,
                      )
                    }
                  >
                    Download anchor proof
                  </button>
                </div>
              )}
              {result.evmPayload && (
                <div>
                  <span>
                    EVM {result.evmPayload.methodSignature} ·{" "}
                    {result.evmPayload.networkCalls} network calls ·{" "}
                    {result.evmPayload.fundsSpent} funds spent
                  </span>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={dirty || !result.verification.valid}
                    onClick={() =>
                      downloadJson(
                        result.evmPayload,
                        `agent-airlock-evm-payload-${runId}.json`,
                      )
                    }
                  >
                    Download EVM payload
                  </button>
                </div>
              )}
            </div>
          )}
          </PortableProofDetails>
        </div>
      )}
    </section>
  );
}

function assuranceOperationLabel(operation: AssuranceOperation): string {
  switch (operation.kind) {
    case "add-required-path":
      return "Require " + operation.path;
    case "add-protected-path":
      return "Protect " + operation.path;
    case "lower-max-changed-files":
      return "Lower changed-file limit to " + operation.maximum;
    case "lower-max-added-bytes":
      return "Lower added-byte limit to " + formatBytes(operation.maximum);
    case "add-catalog-secret":
      return "Add trusted secret detector " + operation.name;
    case "make-command-required":
      return "Make " + operation.name + " required";
  }
}

function AssuranceInbox({
  proposals,
  busy,
  onDerive,
  onAccept,
  onReject,
}: {
  proposals: AssuranceProposal[];
  busy: boolean;
  onDerive: () => void;
  onAccept: (proposal: AssuranceProposal) => void;
  onReject: (proposal: AssuranceProposal) => void;
}) {
  return (
    <section className="assurance-inbox" aria-label="Adaptive Assurance inbox">
      <header className="assurance-heading">
        <div>
          <span className="eyebrow">Adaptive Assurance</span>
          <h3>Evidence can recommend. Only you can change policy.</h3>
          <p>
            Deterministic suggestions use bounded Run evidence and simulate
            history without reopening Candidate State.
          </p>
        </div>
        <button
          className="button button-primary"
          onClick={onDerive}
          disabled={busy}
        >
          {busy ? <Spinner /> : "Scan retained evidence"}
        </button>
      </header>
      {proposals.length === 0 ? (
        <div className="assurance-empty">
          No proposal is ready. Three independent supporting lineages are
          required for the first rules.
        </div>
      ) : (
        <div className="assurance-list">
          {proposals.map((proposal) => {
            const exactChanges = new Set(
              proposal.simulation.results
                .filter(
                  (result) =>
                    result.classification === "exact" &&
                    result.counterfactualDisposition !== null &&
                    result.counterfactualDisposition !==
                      result.priorDisposition,
                )
                .map((result) => result.runId),
            ).size;
            const unknown = proposal.simulation.results.filter(
              (result) => result.classification === "unknown",
            ).length;
            return (
              <article
                className="assurance-card"
                key={proposal.id}
                data-state={proposal.state}
              >
                <div className="assurance-card-title">
                  <div>
                    <span
                      className={
                        "assurance-state assurance-state-" + proposal.state
                      }
                    >
                      {proposal.state}
                    </span>
                    <strong>
                      Proposal against Outcome Contract v
                      {proposal.baseContractVersion}
                    </strong>
                  </div>
                  <code>{shortHash(proposal.proposalDigest)}</code>
                </div>
                <ul className="assurance-operations">
                  {proposal.operations.map((operation) => (
                    <li key={assuranceOperationLabel(operation)}>
                      <span>+</span>
                      <strong>{assuranceOperationLabel(operation)}</strong>
                    </li>
                  ))}
                </ul>
                <div className="assurance-impact">
                  <div>
                    <strong>
                      {
                        new Set(
                          proposal.citations.map((item) => item.rootRunId),
                        ).size
                      }
                    </strong>
                    <span>supporting lineages</span>
                  </div>
                  <div>
                    <strong>{exactChanges}</strong>
                    <span>historical outcomes changed</span>
                  </div>
                  <div>
                    <strong>{unknown}</strong>
                    <span>unknown, never guessed</span>
                  </div>
                </div>
                <details className="assurance-proof">
                  <summary>Inspect citations and simulation proof</summary>
                  <section aria-label="Proposal citations">
                    {proposal.citations.map((citation) => (
                      <p key={citation.operationKey + citation.runId}>
                        <code>{citation.runId}</code>
                        <span>{citation.evidenceSelector}</span>
                        <small>
                          {shortHash(citation.evidenceHash)} ·{" "}
                          {citation.derivationRule}
                        </small>
                      </p>
                    ))}
                  </section>
                  <section
                    className="assurance-simulation-results"
                    aria-label="Historical simulation results"
                  >
                    {proposal.simulation.results.map((result) => (
                      <p key={result.operationKey + result.runId}>
                        <code>{result.runId}</code>
                        <span>
                          <strong>{result.classification}</strong>
                          {" · "}
                          {result.priorDisposition ?? "no prior disposition"}
                          {" to "}
                          {result.counterfactualDisposition ?? "not determined"}
                        </span>
                        <small>
                          {result.operationKey}
                          {result.missingInputs.length > 0
                            ? " · missing: " + result.missingInputs.join(", ")
                            : " · complete retained inputs"}
                        </small>
                      </p>
                    ))}
                  </section>
                  <footer>
                    Simulation {proposal.simulation.engineVersion} ·{" "}
                    {proposal.simulation.results.length} bounded results ·{" "}
                    {shortHash(proposal.simulation.digest)}
                  </footer>
                </details>
                {proposal.decision && (
                  <p className="assurance-decision">
                    {proposal.decision.action}{" "}
                    {formatTime(proposal.decision.decidedAt)}
                    {proposal.decision.reason
                      ? " · " + proposal.decision.reason
                      : ""}
                  </p>
                )}
                {proposal.state === "ready" && (
                  <footer className="assurance-actions">
                    <button
                      className="button button-ghost"
                      onClick={() => onReject(proposal)}
                      disabled={busy}
                    >
                      Reject
                    </button>
                    <button
                      className="button button-primary"
                      onClick={() => onAccept(proposal)}
                      disabled={busy}
                    >
                      Review and accept
                    </button>
                  </footer>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CandidateSetEvidence({
  candidateSet,
  actionBusy,
  onCancel,
  portableTrustAvailable,
  onPortableError,
}: {
  candidateSet: CandidateSet;
  actionBusy: boolean;
  onCancel: () => void;
  portableTrustAvailable: boolean;
  onPortableError: (message: string) => void;
}) {
  const terminal = ["completed", "stale", "recovery-error"].includes(
    candidateSet.phase,
  );
  const scoreByCompetitor = new Map(
    candidateSet.selectionDecision?.scorecard.map((score) => [
      score.competitorId,
      score,
    ]) ?? [],
  );
  const winner = candidateSet.selectedCompetitorId;
  return (
    <article
      className={
        "candidate-set-card" +
        (candidateSet.phase === "recovery-error" ||
        candidateSet.phase === "stale"
          ? " candidate-set-attention"
          : "")
      }
      aria-label="Competing Futures evidence"
      data-phase={candidateSet.phase}
    >
      <header className="candidate-set-heading">
        <div>
          <span className="eyebrow">Competing Futures</span>
          <h3>
            {winner
              ? "One reproducible winner"
              : terminal
                ? "No future was promoted"
                : "Exploring isolated futures"}
          </h3>
          <p>{candidateSet.objective}</p>
        </div>
        <div className="candidate-set-phase">
          {!terminal && <Spinner />}
          <strong>{candidateSet.phase.replaceAll("-", " ")}</strong>
          <span>
            {candidateSet.competitors.length} siblings ·{" "}
            {candidateSet.maxConcurrency} concurrent
          </span>
        </div>
      </header>

      <div className="candidate-source-proof">
        <div>
          <span>Shared immutable source</span>
          <code>{shortHash(candidateSet.source.contentHash)}</code>
        </div>
        <div>
          <span>Snapshotted policy</span>
          <strong>
            Outcome Contract v{candidateSet.outcomeContract.version}
          </strong>
        </div>
        <div>
          <span>Loser policy</span>
          <strong>{candidateSet.loserPolicy}</strong>
        </div>
      </div>

      <div className="candidate-grid">
        {candidateSet.competitors.map((competitor) => {
          const score = scoreByCompetitor.get(competitor.id);
          const isWinner = competitor.id === winner;
          return (
            <article
              key={competitor.id}
              className={
                "candidate-card" +
                (isWinner ? " candidate-winner" : "") +
                (score && !score.eligible ? " candidate-ineligible" : "")
              }
            >
              <header>
                <div>
                  <span>
                    {score?.rank ? "Rank " + score.rank : "Candidate"}
                  </span>
                  <strong>{competitor.id}</strong>
                </div>
                <span
                  className={
                    "candidate-status candidate-status-" + competitor.status
                  }
                >
                  {isWinner ? "winner" : competitor.status}
                </span>
              </header>
              <p>{competitor.strategyInstruction}</p>
              {score?.eligible ? (
                <div className="candidate-score-list">
                  {score.components.map((component) => (
                    <div key={component.kind}>
                      <span>
                        {component.kind.replaceAll("-", " ")} ·{" "}
                        {component.direction}
                      </span>
                      <strong>
                        raw {component.rawValue.toLocaleString()} · normalized{" "}
                        {component.normalizedValue.toLocaleString()}
                      </strong>
                      <small>{component.evaluatorVersion}</small>
                    </div>
                  ))}
                </div>
              ) : score ? (
                <div className="candidate-exclusion" role="status">
                  <strong>Not eligible for Selection</strong>
                  <span>{score.exclusions.join(" · ")}</span>
                </div>
              ) : (
                <div className="candidate-pending">
                  <span className="pulse" /> Required Validations and scores are
                  pending
                </div>
              )}
              {competitor.loserDisposition !== "pending" &&
                competitor.loserDisposition !== "winner" && (
                  <footer>Loser state {competitor.loserDisposition}</footer>
                )}
            </article>
          );
        })}
      </div>

      {candidateSet.selectionDecision && (
        <footer className="selection-proof">
          <div>
            <span className="eyebrow">Deterministic decision</span>
            <strong>
              {candidateSet.selectionDecision.winnerCompetitorId
                ? candidateSet.selectionDecision.winnerCompetitorId +
                  " selected"
                : "No eligible Candidate"}
            </strong>
            <p>
              Lexicographic normalized scores, then ascending competitor ID.
            </p>
          </div>
          <code className="selection-digest">
            {candidateSet.selectionDecision.decisionDigest}
          </code>
        </footer>
      )}
      {candidateSet.recoveryError && (
        <p className="candidate-set-error" role="alert">
          {candidateSet.recoveryError}
        </p>
      )}
      {portableTrustAvailable &&
        candidateSet.phase === "completed" &&
        candidateSet.winnerRunId && (
          <PortableTrustExport
            runId={candidateSet.winnerRunId}
            evidenceRevision={candidateSet.selectionDecision!.decisionDigest}
            onError={onPortableError}
          />
        )}
      {!candidateSet.selectionDecision && !terminal && (
        <button
          type="button"
          className="button button-ghost candidate-cancel"
          onClick={onCancel}
          disabled={actionBusy || candidateSet.cancellationRequested}
        >
          {candidateSet.cancellationRequested
            ? "Cancellation requested"
            : "Cancel exploration"}
        </button>
      )}
    </article>
  );
}

function AirlockEvidence({
  run,
  actionBusy,
  onRepair,
  onDiscard,
  portableTrustAvailable,
  judgeProofMode,
  modelArkProofMode,
  automaticProofRequestNonce,
  onPortableError,
  onVerifyArtifact,
  onAutomaticProofResult,
}: {
  run: AgentRun;
  actionBusy: boolean;
  onRepair: () => void;
  onDiscard: () => void;
  portableTrustAvailable: boolean;
  judgeProofMode: boolean;
  modelArkProofMode: boolean;
  automaticProofRequestNonce: number | null;
  onPortableError: (message: string) => void;
  onVerifyArtifact: (artifact: PortableVerifierArtifact) => void;
  onAutomaticProofResult: (
    runId: string,
    verification: AutomaticProofVerification,
  ) => void;
}) {
  const transaction = run.transaction;
  if (!transaction) return null;
  const disposition = transaction.disposition ?? transaction.status;
  const recoveryFailed = transaction.status === "recovery-error";
  const visualDisposition = recoveryFailed ? "recovery-error" : disposition;
  const decisiveValidation = transaction.validations.find(
    (validation) => validation.required && validation.status !== "passed",
  );
  const providerPreparationFailed = transaction.providerResourceEvents.some(
    (event) => event.stage === "prepare" && event.status === "failed",
  );
  const providerRepairUnavailable =
    providerPreparationFailed ||
    (transaction.providerResources.length > 0 &&
      transaction.providerResources.some((resource) => !resource.quarantine));
  const compactJudgeEvidence =
    judgeProofMode && ["promoted", "quarantined"].includes(disposition);
  const title = recoveryFailed
      ? "Recovery needs attention"
      : disposition === "promoted"
      ? "Promoted"
      : disposition === "quarantined"
        ? "Quarantined"
        : disposition === "discarded"
          ? "Discarded"
        : disposition === "cancelled"
          ? "Cancelled"
          : "Airlock evaluating";
  const outcome = recoveryFailed
      ? "Airlock found contradictory recovery evidence and failed closed"
      : disposition === "promoted"
      ? "Candidate became Canonical State"
      : disposition === "quarantined"
        ? "Canonical State unchanged"
        : disposition === "discarded"
          ? "Mutable Quarantine removed; decision evidence retained"
        : disposition === "cancelled"
          ? "Candidate discarded before Promotion"
          : "Canonical State remains protected during this Run";

  return (
    <article
      className={
        "airlock-card airlock-" +
        visualDisposition +
        (judgeProofMode ? " airlock-judge-proof" : "")
      }
      aria-label="Agent Airlock evidence"
      data-disposition={visualDisposition}
    >
      <header className="airlock-heading">
        <div>
          <span className="eyebrow">Agent Airlock</span>
          <div className="airlock-title-row">
            <h3>{title}</h3>
            <span className="contract-badge">
              Outcome Contract v{transaction.outcomeContractVersion}
            </span>
          </div>
          <p>{outcome}</p>
        </div>
        <span className="airlock-shield" aria-hidden="true">
          {recoveryFailed
            ? "!"
            : disposition === "promoted"
            ? "✓"
            : disposition === "quarantined"
              ? "!"
              : disposition === "discarded"
                ? "×"
                : "◇"}
        </span>
      </header>

      {judgeProofMode && (
        <JudgeProofSummary
          transaction={transaction}
          modelArkProofMode={modelArkProofMode}
        />
      )}

      <EvidenceDetails compact={compactJudgeEvidence}>
      <section className="repair-lineage" aria-label="Recovery evidence">
        <div>
          <span className="eyebrow">Recovery lineage</span>
          <strong>
            {transaction.lineage.depth === 0
              ? "Original Run"
              : "Repair " +
                transaction.lineage.depth +
                " of " +
                transaction.lineage.maxDepth}
          </strong>
          <p>
            Root {transaction.lineage.rootRunId.slice(0, 8)}
            {transaction.lineage.parentRunId
              ? " · parent " + transaction.lineage.parentRunId.slice(0, 8)
              : " · no parent"}
          </p>
        </div>
        {disposition === "quarantined" && transaction.quarantineAvailable && (
          <div className="quarantine-actions">
            <button
              className="button button-primary"
              onClick={onRepair}
              disabled={
                actionBusy ||
                providerRepairUnavailable ||
                transaction.lineage.depth >= transaction.lineage.maxDepth
              }
            >
              {actionBusy ? <Spinner /> : "Repair this future"}
            </button>
            <button
              className="button button-ghost"
              onClick={onDiscard}
              disabled={actionBusy}
            >
              Discard Quarantine
            </button>
          </div>
        )}
          {disposition === "quarantined" && providerRepairUnavailable && (
            <p className="repair-limit" role="status">
              A provider retained this Candidate for cleanup only. Discard it
              after the provider recovers.
            </p>
          )}
        {disposition === "quarantined" &&
          !providerRepairUnavailable &&
          transaction.lineage.depth >= transaction.lineage.maxDepth && (
            <p className="repair-limit" role="status">
              Repair depth exhausted. Inspect or discard this Quarantine.
            </p>
          )}
        {transaction.recovery.journalPhase &&
          disposition !== "quarantined" && (
            <div
              className={
                "journal-proof" +
                  (transaction.recovery.recoveryError
                    ? " journal-proof-error"
                    : "")
              }
              role={transaction.recovery.recoveryError ? "alert" : "status"}
            >
              <span className="eyebrow">Durable Promotion</span>
              <strong>
                {transaction.recovery.recoveryError
                  ? "Recovery failed closed"
                  : transaction.recovery.recoveredAfterRestart
                    ? "Recovered after restart"
                    : "Journal " + transaction.recovery.journalPhase}
              </strong>
              <p>
                {transaction.recovery.recoveryError ??
                    "Phase " +
                      transaction.recovery.journalPhase.replaceAll("-", " ")}
              </p>
            </div>
          )}
      </section>

      {decisiveValidation && (
        <div className="decisive-validation" role="alert">
          <span>Decisive Validation</span>
          <strong>{decisiveValidation.name}</strong>
          <p>{decisiveValidation.summary}</p>
        </div>
      )}

      <div className="airlock-metrics">
        <div>
          <span>Canonical fingerprint</span>
          <strong>{shortHash(transaction.canonicalContentHashAfter)}</strong>
          <small>
            {transaction.canonicalContentHashAfter ===
            transaction.canonicalContentHashBefore
              ? "unchanged"
                : "advanced from " +
                  shortHash(transaction.canonicalContentHashBefore)}
          </small>
        </div>
        <div>
          <span>Changed files</span>
            <strong>
              {transaction.changes?.totalChangedFiles ?? "pending"}
            </strong>
            <small>
              {formatBytes(transaction.changes?.totalAddedBytes ?? 0)} changed
              payload
            </small>
        </div>
        <div>
          <span>Validation result</span>
          <strong>
              {
                transaction.validations.filter(
                  (item) => item.status === "passed",
                ).length
              }
              /{transaction.validations.length || "pending"}
          </strong>
          <small>required failures block Promotion</small>
        </div>
      </div>

      {transaction.resources.length > 0 && (
          <section
            className="resource-ledger"
            aria-label="Transactional resources"
          >
          <div className="resource-ledger-heading">
            <h4>Whole-Agent state</h4>
              <span>
                one decision across {transaction.resources.length} resources
              </span>
          </div>
          <div className="resource-ledger-grid">
            {transaction.resources.map((resource) => (
              <article key={resource.kind}>
                <div>
                  <span>{resource.label}</span>
                  <strong>{resource.disposition ?? "pending"}</strong>
                </div>
                <code>{shortHash(resource.fingerprintAfter)}</code>
                <p>{resource.summary}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {transaction.providerResources.length > 0 && (
        <section
          className="provider-resource-ledger"
          aria-label="Registered Transactional Resources"
        >
          <div className="resource-ledger-heading">
            <div>
              <span className="eyebrow">Provider registry</span>
              <h4>Transactional Resources</h4>
            </div>
            <span>
              {transaction.providerResources.length} required provider
              {transaction.providerResources.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="provider-resource-grid">
            {transaction.providerResources.map((resource) => {
                const providerEvents =
                  transaction.providerResourceEvents.filter(
                (event) => event.providerId === resource.providerId,
              );
              const target = resource.installedVersion ?? resource.source;
              const degraded =
                resource.capabilities.promotionVisibility === "best-effort" ||
                resource.capabilities.promotionIdempotency === "none" ||
                resource.capabilities.reconciliation !== "forward";
              return (
                <article key={resource.providerId}>
                  <header>
                    <div>
                        <span className="provider-kind">
                          {resource.resourceKind}
                        </span>
                      <strong>{resource.label}</strong>
                      <code>{resource.providerId}</code>
                    </div>
                    <span
                      className={
                        "provider-disposition provider-" +
                        (resource.disposition ?? "pending")
                      }
                    >
                      {resource.disposition ?? "pending"}
                    </span>
                  </header>
                  <div className="provider-version-row">
                    <div>
                      <span>Version</span>
                      <strong>{target.versionId}</strong>
                    </div>
                    <code>{shortHash(target.fingerprint)}</code>
                  </div>
                  <div className="provider-fingerprint-flow">
                    <code>{shortHash(resource.source.fingerprint)}</code>
                    <span aria-hidden="true">→</span>
                    <code>
                      {shortHash(
                        resource.installedVersion?.fingerprint ??
                          resource.change?.fingerprintCandidate ??
                          resource.candidate.candidateFingerprint,
                      )}
                    </code>
                  </div>
                  <div className="provider-guarantees">
                      <span>
                        {resource.required ? "required-v1" : "optional"}
                      </span>
                    <span>{resource.capabilities.isolation}</span>
                    <span>{resource.capabilities.promotionVisibility}</span>
                    <span>{resource.capabilities.runtimeAccess}</span>
                    <span>{resource.capabilities.reconciliation}</span>
                  </div>
                  <p>{resource.summary}</p>
                    <p
                      className={
                        degraded
                          ? "provider-caveat degraded"
                          : "provider-caveat"
                      }
                    >
                    {degraded
                      ? "This provider declares degraded guarantees and cannot silently claim all-or-nothing Promotion."
                      : "Canonical manifest acceptance is authoritative; distributed atomic commit is not claimed."}
                  </p>
                  <details>
                    <summary>
                      Inspect {resource.validations.length} Validation
                        {resource.validations.length === 1 ? "" : "s"} and{" "}
                        {providerEvents.length}
                      {" lifecycle events"}
                    </summary>
                    <div className="provider-details-grid">
                      <div>
                        <span className="eyebrow">Validation evidence</span>
                        {resource.validations.length === 0 ? (
                          <p>No provider Validation has completed.</p>
                        ) : (
                          resource.validations.map((validation) => (
                            <p key={validation.name}>
                                <strong>{validation.status}</strong>{" "}
                                {validation.name} - {validation.summary}
                            </p>
                          ))
                        )}
                      </div>
                      <div>
                        <span className="eyebrow">Lifecycle evidence</span>
                        {providerEvents.map((event, index) => (
                          <p key={event.stage + event.at + index}>
                              <strong>{event.status}</strong> {event.stage} -{" "}
                              {event.summary}
                          </p>
                        ))}
                      </div>
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
        </section>
      )}

        {(transaction.sqlite ||
          transaction.externalActions.intents.length > 0) && (
          <section
            className="multi-resource-disposition"
            aria-label="Data and effects evidence"
          >
          <article>
            <span className="eyebrow">SQLite snapshot</span>
            <div className="disposition-title">
              <strong>
                {transaction.sqlite?.after
                  ? transaction.sqlite.after.rowCount +
                    " row" +
                    (transaction.sqlite.after.rowCount === 1 ? "" : "s")
                  : "pending"}
              </strong>
                <code>
                  {shortHash(transaction.sqlite?.after?.contentHash ?? null)}
                </code>
            </div>
            <p>
              {transaction.sqlite?.candidate && transaction.sqlite.before
                ? transaction.sqlite.candidate.contentHash ===
                  transaction.sqlite.before.contentHash
                  ? "Candidate data matched the prior Canonical snapshot."
                  : transaction.disposition === "promoted"
                    ? "Candidate data was accepted with the whole Agent."
                    : "Candidate data changed, but Canonical data remained unchanged."
                : "Waiting for bounded query evidence."}
            </p>
            {transaction.sqlite?.candidate?.rows.slice(0, 3).map((row) => (
              <div className="sqlite-row" key={row.id}>
                <code>{row.id}</code>
                <span>{row.value}</span>
              </div>
            ))}
          </article>
          <article>
            <span className="eyebrow">Deferred effects</span>
            <div className="disposition-title">
                <strong>
                  {transaction.externalActions.deliveredCount} delivered
                </strong>
                <span>
                  {transaction.externalActions.intents.length} requested
                </span>
            </div>
            <p>
              Effects are claimed only after the Canonical manifest advances.
            </p>
            {transaction.externalActions.intents.length === 0 ? (
                <div className="effect-row">
                  <span>No intent requested</span>
                </div>
            ) : (
              transaction.externalActions.intents.map((intent) => (
                <div className="effect-row" key={intent.idempotencyKey}>
                  <div>
                    <code>{intent.id}</code>
                    <span>{intent.destination}</span>
                  </div>
                  <strong className={"effect-status effect-" + intent.status}>
                    {intent.status}
                  </strong>
                </div>
              ))
            )}
          </article>
          <p className="boundary-disclosure">
            {transaction.externalActions.bypassDisclosure}
          </p>
        </section>
      )}

      <div className="airlock-columns">
        <section className="evidence-section">
          <h4>Run timeline</h4>
          <ol className="airlock-timeline">
            {transaction.events.map((event, index) => (
              <li key={event.status + event.at + index}>
                <span className="timeline-marker" />
                <div>
                  <strong>{event.status}</strong>
                  <p>{event.summary}</p>
                </div>
                <time>{formatTime(event.at)}</time>
              </li>
            ))}
          </ol>
        </section>

        <section className="evidence-section">
          <h4>Validation evidence</h4>
          {transaction.validations.length === 0 ? (
              <p className="evidence-empty">
                Validations begin after Runtime execution.
              </p>
          ) : (
            <ul className="validation-list">
              {transaction.validations.map((validation) => (
                  <li
                    key={validation.name}
                    className={"validation-" + validation.status}
                  >
                  <span className="validation-icon">
                    {validation.status === "passed" ? "✓" : "!"}
                  </span>
                  <div>
                    <div className="validation-name">
                      <strong>{validation.name}</strong>
                        <span>
                          {validation.required ? "required" : "optional"}
                        </span>
                    </div>
                    <p>{validation.summary}</p>
                    {validation.output && <pre>{validation.output}</pre>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {transaction.changes && transaction.changes.files.length > 0 && (
        <details className="change-evidence">
          <summary>
            Inspect {transaction.changes.totalChangedFiles} workspace change
            {transaction.changes.totalChangedFiles === 1 ? "" : "s"}
          </summary>
          <ul>
            {transaction.changes.files.map((change) => (
              <li key={change.path}>
                  <span className={"change-kind change-" + change.kind}>
                    {change.kind}
                  </span>
                <code>{change.path}</code>
                <small>{formatBytes(change.addedBytes)}</small>
              </li>
            ))}
          </ul>
          {transaction.changes.truncated && (
            <p>Only the first 200 paths are retained in evidence.</p>
          )}
        </details>
      )}
      </EvidenceDetails>

      {transaction.promotionReceipt && (
        <>
          <footer className="receipt-row">
            <span>Promotion Receipt</span>
            <code>
              {shortHash(transaction.promotionReceipt.validationEvidenceHash)}
            </code>
            <small>{transaction.promotionReceipt.disposition}</small>
          </footer>
          {portableTrustAvailable && !recoveryFailed && (
            <PortableTrustExport
              runId={run.id}
              evidenceRevision={[
                transaction.disposition,
                transaction.promotionReceipt.createdAt,
                transaction.promotionReceipt.validationEvidenceHash,
              ].join(":")}
              judgeProofMode={judgeProofMode}
              automaticProofRequestNonce={automaticProofRequestNonce}
              onError={onPortableError}
              onVerifyArtifact={onVerifyArtifact}
              onAutomaticProofResult={onAutomaticProofResult}
            />
          )}
        </>
      )}
    </article>
  );
}

async function readFederationArtifact(
  file: File,
  maximumBytes: number,
  label: string,
): Promise<{ filename: string; value: unknown }> {
  if (file.size === 0 || file.size > maximumBytes) {
    throw new Error(
      label +
        " must be non-empty and no larger than " +
        formatBytes(maximumBytes) +
        ".",
    );
  }
  const source = await file.text();
  try {
    return { filename: file.name, value: JSON.parse(source) as unknown };
  } catch {
    throw new Error(label + " is not valid JSON.");
  }
}

function FederationAirlock({
  agent,
  disabled,
  onImported,
  onVerifyArtifact,
}: {
  agent: Agent;
  disabled: boolean;
  onImported: (result: FederatedImportResult) => Promise<void>;
  onVerifyArtifact: (artifact: ReceiverCustodyPacket) => void;
}) {
  const [policy, setPolicy] = useState<Awaited<
    ReturnType<typeof api.activeFederatedAdmissionPolicy>
  > | null>(null);
  const [producerId, setProducerId] = useState("");
  const [transferId, setTransferId] = useState(
    () =>
      "browser-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10),
  );
  const [bundle, setBundle] = useState<unknown>(null);
  const [bundleFilename, setBundleFilename] = useState<string | null>(null);
  const [trustPolicy, setTrustPolicy] = useState<unknown>(null);
  const [trustPolicyFilename, setTrustPolicyFilename] = useState<string | null>(
    null,
  );
  const [result, setResult] = useState<FederatedImportResult | null>(null);
  const [inbox, setInbox] = useState<FederatedAdmissionInboxItem[]>([]);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [selectedInboxItem, setSelectedInboxItem] =
    useState<FederatedAdmissionInboxItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState<"approve" | "deny" | null>(
    null,
  );
  const [approvalReason, setApprovalReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [custodyBusy, setCustodyBusy] = useState(false);
  const [custodyVerification, setCustodyVerification] =
    useState<ReceiverCustodyVerificationReport | null>(null);
  const [custodyPacket, setCustodyPacket] =
    useState<ReceiverCustodyPacket | null>(null);

  const loadInbox = useCallback(async () => {
    setInboxBusy(true);
    try {
      const response = await api.federatedAdmissions(agent.id);
      setInbox(response.admissions);
      setSelectedInboxItem((current) =>
        current
          ? (response.admissions.find(
              (item) =>
                item.admission.admissionId === current.admission.admissionId,
            ) ?? null)
          : null,
      );
      return response.admissions;
    } finally {
      setInboxBusy(false);
    }
  }, [agent.id]);

  useEffect(() => {
    let active = true;
    void api
      .activeFederatedAdmissionPolicy()
      .then((next) => {
        if (!active) return;
        setPolicy(next);
        setProducerId(
          next.policy.producers.find((producer) => !producer.disabled)
            ?.producerId ?? "",
        );
      })
      .catch((reason) => {
        if (active) {
          setLocalError(
            reason instanceof Error
              ? reason.message
              : "The receiver admission policy is unavailable.",
          );
        }
      });
    void loadInbox().catch((reason) => {
      if (active) {
        setLocalError(
          reason instanceof Error
            ? reason.message
            : "The federated approval inbox is unavailable.",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [loadInbox]);

  const importWork = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bundle || !trustPolicy || !producerId || !transferId.trim()) return;
    setBusy(true);
    setLocalError(null);
    setResult(null);
    try {
      const imported = await api.importFederatedWork(agent.id, {
        transferId: transferId.trim(),
        producerId,
        bundle,
        trustPolicy,
      });
      setSelectedInboxItem(null);
      setResult(imported);
      await onImported(imported);
      const admissions = await loadInbox();
      setSelectedInboxItem(
        admissions.find(
          (item) =>
            item.admission.admissionId === imported.admission.admissionId,
        ) ?? null,
      );
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const decidePendingAdmission = async (choice: "approve" | "deny") => {
    const decisionContextDigest =
      result?.approval?.decisionContextDigest ??
      selectedInboxItem?.review?.decisionContextDigest;
    if (!result?.admission || !approvalReason.trim() || !decisionContextDigest)
      return;
    setDecisionBusy(choice);
    setLocalError(null);
    try {
      const decided = await api.decideFederatedAdmission(
        result.admission.admissionId,
        { choice, reason: approvalReason.trim(), decisionContextDigest },
      );
      setSelectedInboxItem(null);
      setResult(decided);
      await onImported(decided);
      await loadInbox();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes("review context is stale")) {
        await loadInbox().catch(() => undefined);
      }
      setLocalError(message);
    } finally {
      setDecisionBusy(null);
    }
  };

  const admission = result?.admission;
  const transaction = result?.run?.transaction;
  const requiredValidations =
    transaction?.validations.filter((validation) => validation.required) ?? [];
  const receiverValidationPassed =
    requiredValidations.length > 0 &&
    requiredValidations.every((validation) => validation.status === "passed");
  const selectedTerminalValidation =
    selectedInboxItem?.state === "promoted" ||
    selectedInboxItem?.state === "quarantined";
  const currentRunId =
    result?.run?.id ??
    selectedInboxItem?.run?.id ??
    admission?.candidateRunId ??
    null;
  const disposition =
    transaction?.disposition ??
    (selectedInboxItem?.state === "promoted" ||
    selectedInboxItem?.state === "quarantined"
      ? selectedInboxItem.state
      : null);

  useEffect(() => {
    setCustodyVerification(null);
    setCustodyPacket(null);
  }, [currentRunId]);

  const exportReceiverCustody = async () => {
    if (
      !currentRunId ||
      (disposition !== "promoted" && disposition !== "quarantined")
    )
      return;
    setCustodyBusy(true);
    setLocalError(null);
    try {
      const exported = await api.exportReceiverCustody(currentRunId);
      if (!exported.verification.valid) {
        throw new Error("The receiver rejected its own custody closure.");
      }
      const source = JSON.stringify(exported.packet);
      const browserReport =
        await verifyReceiverCustodyPacketJsonInBrowser(source);
      setCustodyVerification(browserReport);
      if (!browserReport.valid) {
        throw new Error(
          "The browser independently rejected the custody closure.",
        );
      }
      setCustodyPacket(exported.packet);
      downloadJsonArtifact(
        exported.packet,
        `agent-airlock-receiver-custody-${currentRunId}.json`,
      );
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCustodyBusy(false);
    }
  };
  const pipeline = [
    {
      label: "Verify",
      detail: admission
        ? admission.decision.decision === "admit" ||
          result?.approval?.choice === "approve"
          ? "Bundle, receipt, authority, and signer scope verified"
          : result?.approval?.choice === "deny"
            ? "Local operator denied the immutable pending Admission"
            : admission.decision.detail
        : "Cryptographic bundle and organizational authority",
      state: admission
        ? admission.decision.decision === "admit" ||
          result?.approval?.choice === "approve"
          ? "passed"
          : result?.approval?.choice === "deny"
            ? "rejected"
          : admission.decision.decision
        : "waiting",
    },
    {
      label: "Isolate",
      detail: currentRunId
        ? "Receiver Candidate " + currentRunId.slice(0, 12)
        : "No mutable Canonical path enters the import Runtime",
      state: currentRunId ? "passed" : "waiting",
    },
    {
      label: "Validate",
      detail: transaction
        ? requiredValidations.length + " required receiver checks"
        : selectedTerminalValidation
          ? "Receiver checks completed; Run retains full evidence"
        : "Receiver Outcome Contract controls eligibility",
      state:
        transaction || selectedTerminalValidation
        ? receiverValidationPassed
          ? "passed"
          : selectedInboxItem?.state === "promoted"
            ? "passed"
            : "rejected"
        : "waiting",
    },
    {
      label: disposition === "quarantined" ? "Quarantine" : "Promote",
      detail:
        disposition === "promoted"
          ? "Receiver Canonical State advanced atomically"
          : disposition === "quarantined"
            ? "Canonical State remained unchanged"
            : "Only validated Candidate State may become Canonical",
      state:
        disposition === "promoted"
          ? "passed"
          : disposition === "quarantined"
            ? "rejected"
            : "waiting",
    },
  ];

  return (
    <form className="federation-panel" onSubmit={importWork}>
      <div className="federation-heading">
        <div>
          <span className="eyebrow">Federation Airlock</span>
          <h3>Import verified work, not remote authority</h3>
        </div>
        <p>
          Another organization can propose a signed state transition. This
          receiver independently admits it into Candidate State, reruns its own
          Outcome Contract, and owns the final Promotion decision.
        </p>
      </div>

      <div className="federation-policy" data-ready={policy !== null}>
        <span>{policy ? "ACTIVE RECEIVER POLICY" : "RECEIVER POLICY"}</span>
        <strong>
          {policy
            ? policy.policy.policyId +
              " · generation " +
              policy.policy.generation
            : "Loading durable policy..."}
        </strong>
        <code>
          {policy?.policyDigest ?? "Policy is required before import"}
        </code>
      </div>

      <section
        className="federation-inbox"
        aria-label="Federated approval inbox"
      >
        <div className="federation-inbox-heading">
          <div>
            <span className="eyebrow">Durable approval inbox</span>
            <strong>
              {inbox.length} local Admission{inbox.length === 1 ? "" : "s"}
            </strong>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={inboxBusy}
            onClick={() =>
              void loadInbox().catch((reason) => setLocalError(String(reason)))
            }
          >
            {inboxBusy ? <Spinner /> : "Refresh inbox"}
          </button>
        </div>
        {inbox.length === 0 ? (
          <p>
            No receiver Admissions yet. Imported work will remain discoverable
            here after reload.
          </p>
        ) : (
          <div className="federation-inbox-list">
            {inbox.map((item) => (
              <button
                type="button"
                key={item.admission.admissionId}
                data-state={item.state}
                aria-pressed={
                  selectedInboxItem?.admission.admissionId ===
                  item.admission.admissionId
                }
                onClick={() => {
                  setSelectedInboxItem(item);
                  setResult({
                    admission: item.admission,
                    approval: item.approval ?? undefined,
                    run: null,
                  });
                  setApprovalReason(item.approval?.reason ?? "");
                  setLocalError(null);
                }}
              >
                <span>{item.state.toUpperCase()}</span>
                <strong>{item.admission.transferId}</strong>
                <small>
                  {item.admission.producerId} · {item.admission.recordedAt}
                </small>
              </button>
            ))}
          </div>
        )}
      </section>

      {selectedInboxItem?.review && (
        <section
          className="federation-review"
          aria-label="Pending Admission review"
        >
          <div className="federation-review-heading">
            <div>
              <span className="eyebrow">Evidence-first review</span>
              <strong>
                {selectedInboxItem.review.artifact.operationCount} proposed
                operation
                {selectedInboxItem.review.artifact.operationCount === 1
                  ? ""
                  : "s"}
              </strong>
            </div>
            <span>PRODUCER CLAIM · NOT RECEIVER AUTHORITY</span>
          </div>
          <div className="federation-review-claim">
            <div>
              <span>Claimed Run</span>
              <code>{selectedInboxItem.review.producerClaim.runId}</code>
            </div>
            <div>
              <span>Claimed Agent</span>
              <code>{selectedInboxItem.review.producerClaim.agentId}</code>
            </div>
            <div>
              <span>Claimed result</span>
              <strong>
                {selectedInboxItem.review.producerClaim.disposition}
              </strong>
            </div>
            <div>
              <span>Payload</span>
              <strong>
                {formatBytes(
                  selectedInboxItem.review.artifact.totalPayloadBytes,
                )}
              </strong>
            </div>
          </div>
          <div className="federation-review-operations">
            {selectedInboxItem.review.artifact.operations.map((operation) => (
              <div key={operation.operation + ":" + operation.path}>
                <span data-operation={operation.operation}>
                  {operation.operation.toUpperCase()}
                </span>
                <code>
                  {operation.path}
                  {operation.toPath ? " → " + operation.toPath : ""}
                </code>
                <small>
                  {operation.byteLength === null
                    ? "no embedded payload"
                    : formatBytes(operation.byteLength)}
                </small>
              </div>
            ))}
          </div>
          <div
            className="federation-preflight"
            data-status={selectedInboxItem.review.preflight.status}
          >
            <div>
              <span>Receiver metadata preflight</span>
              <strong>
                {selectedInboxItem.review.preflight.status ===
                "no-metadata-blocker"
                  ? "No predicted metadata blocker"
                  : selectedInboxItem.review.preflight.blockers.length +
                    " predicted blocker" +
                    (selectedInboxItem.review.preflight.blockers.length === 1
                      ? ""
                      : "s")}
              </strong>
              <small>
                Outcome Contract v
                {selectedInboxItem.review.preflight.contractVersion} · {" "}
                {selectedInboxItem.review.preflight.affectedPathCount} affected path
                {selectedInboxItem.review.preflight.affectedPathCount === 1
                  ? ""
                  : "s"}
              </small>
            </div>
            {selectedInboxItem.review.preflight.blockers.map((blocker) => (
              <div className="federation-preflight-blocker" key={blocker.code}>
                <span>{blocker.code.replaceAll("-", " ")}</span>
                <strong>{blocker.summary}</strong>
                {blocker.paths.length > 0 && (
                  <code>{blocker.paths.join(", ")}</code>
                )}
              </div>
            ))}
            <div className="federation-preflight-deferred">
              <span>Deferred to authoritative Candidate Validation</span>
              <div>
                {selectedInboxItem.review.preflight.deferredChecks.map(
                  (check) => (
                  <small key={check}>{check.replaceAll("-", " ")}</small>
                  ),
                )}
              </div>
            </div>
            <p>
              This preflight uses metadata only. Approval never bypasses
              receiver Validation or grants Promotion.
            </p>
          </div>
          <div className="federation-review-binding">
            <span>Decision bound to this exact review</span>
            <code>
              {selectedInboxItem.review.decisionContextDigest.slice(0, 19)}...
            </code>
            <small>
              If the Admission or receiver Outcome Contract changes, this screen
              must refresh before a decision can be recorded.
            </small>
          </div>
          {selectedInboxItem.review.artifact.truncated && (
            <p>
              Showing{" "}
              {selectedInboxItem.review.artifact.displayedOperationCount} of{" "}
              {selectedInboxItem.review.artifact.operationCount} operations.
            </p>
          )}
          <p>
            Receiver Outcome Contract checks run only after approval. This
            summary contains metadata, never staged file content.
          </p>
        </section>
      )}

      <div
        className="federation-pipeline"
        aria-label="Federated import pipeline"
      >
        {pipeline.map((stage, index) => (
          <div key={stage.label} data-state={stage.state}>
            <span>
              {stage.state === "passed"
                ? "✓"
                : stage.state === "rejected" || stage.state === "reject"
                  ? "!"
                  : index + 1}
            </span>
            <strong>{stage.label}</strong>
            <small>{stage.detail}</small>
          </div>
        ))}
      </div>

      <div className="federation-inputs">
        <label>
          Trusted producer
          <select
            value={producerId}
            onChange={(event) => setProducerId(event.target.value)}
            disabled={!policy || busy}
            required
          >
            <option value="">Choose a producer</option>
            {policy?.policy.producers.map((producer) => (
              <option
                key={producer.producerId}
                value={producer.producerId}
                disabled={producer.disabled}
              >
                {producer.producerId}
                {producer.disabled ? " (disabled)" : ""}
                {producer.requireLocalApproval ? " (approval required)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Transfer identity
          <input
            value={transferId}
            onChange={(event) => setTransferId(event.target.value)}
            pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
            maxLength={128}
            disabled={busy}
            required
          />
        </label>
        <label className="federation-file" data-loaded={bundle !== null}>
          <span>Federated Work Bundle</span>
          <strong>{bundleFilename ?? "Choose signed bundle JSON"}</strong>
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void readFederationArtifact(
                file,
                MAXIMUM_FEDERATED_BUNDLE_FILE_BYTES,
                "Federated Work Bundle",
              )
                .then((artifact) => {
                  setBundle(artifact.value);
                  setBundleFilename(artifact.filename);
                  setLocalError(null);
                  setResult(null);
                })
                .catch((reason) =>
                  setLocalError(String(reason.message ?? reason)),
                );
            }}
          />
        </label>
        <label className="federation-file" data-loaded={trustPolicy !== null}>
          <span>Signed Trust Policy</span>
          <strong>
            {trustPolicyFilename ?? "Choose authority policy JSON"}
          </strong>
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void readFederationArtifact(
                file,
                MAXIMUM_TRUST_POLICY_FILE_BYTES,
                "Signed Trust Policy",
              )
                .then((artifact) => {
                  setTrustPolicy(artifact.value);
                  setTrustPolicyFilename(artifact.filename);
                  setLocalError(null);
                  setResult(null);
                })
                .catch((reason) =>
                  setLocalError(String(reason.message ?? reason)),
                );
            }}
          />
        </label>
      </div>

      {localError && (
        <div className="federation-error" role="alert">
          {localError}
        </div>
      )}
      {admission && (
        <div
          className="federation-verdict"
          data-decision={admission.decision.decision}
          data-disposition={disposition ?? "none"}
          role="status"
        >
          <div>
            <span>
              {disposition === "promoted"
                ? "PROMOTED BY RECEIVER"
                : disposition === "quarantined"
                  ? "QUARANTINED BY RECEIVER"
                  : result?.approval?.choice === "deny"
                    ? "DENIED BY OPERATOR"
                  : admission.decision.decision.toUpperCase()}
            </span>
            <strong>
              {result?.approval?.reason ?? admission.decision.detail}
            </strong>
          </div>
          <dl>
            <div>
              <dt>Admission</dt>
              <dd>{admission.admissionId.slice(0, 19)}...</dd>
            </div>
            <div>
              <dt>Policy</dt>
              <dd>generation {admission.decision.policyGeneration}</dd>
            </div>
            <div>
              <dt>Run</dt>
              <dd>
                {result.run?.id.slice(0, 16) ??
                  selectedInboxItem?.run?.id.slice(0, 16) ??
                  "none"}
              </dd>
            </div>
            <div>
              <dt>Canonical</dt>
              <dd>{disposition === "promoted" ? "advanced" : "unchanged"}</dd>
            </div>
          </dl>
        </div>
      )}

      {currentRunId &&
        (disposition === "promoted" || disposition === "quarantined") && (
        <section
          className="federation-custody"
          data-verified={custodyVerification?.valid === true}
          aria-label="Receiver chain of custody"
        >
          <div>
            <span className="eyebrow">Portable receiver closure</span>
            <strong>
              {custodyVerification?.valid
                ? "Verified independently in this browser"
                : "Close the producer-to-receiver authority path"}
            </strong>
            <p>
                One downloadable proof binds the producer signature, receiver
                Admission, operator approval when required, terminal authority,
                and receiver receipt.
            </p>
          </div>
          <div className="federation-custody-domains">
              <span>
                <i>1</i> Producer trust domain
              </span>
            <b aria-hidden="true">→</b>
              <span>
                <i>2</i> Receiver trust domain
              </span>
          </div>
          {custodyVerification?.valid && (
            <small>
                {custodyVerification.checks.length} cryptographic and authority
                checks passed locally.
            </small>
          )}
          <button
            type="button"
            className="button button-primary"
            disabled={custodyBusy}
            onClick={() => void exportReceiverCustody()}
          >
              {custodyBusy ? (
                <Spinner />
              ) : custodyVerification?.valid ? (
                "Verify and download again"
              ) : (
                "Verify and download custody proof"
              )}
          </button>
          {custodyVerification?.valid && custodyPacket && (
            <button
              type="button"
              className="button button-ghost"
              onClick={() => onVerifyArtifact(custodyPacket)}
            >
              Open offline proof room
            </button>
          )}
        </section>
      )}

      {admission?.decision.decision === "pending" &&
        (!result?.approval ||
          (result.approval.choice === "approve" &&
            !result.run &&
            selectedInboxItem?.state === "approved")) && (
          <section
            className="federation-approval"
            aria-label="Local admission decision"
          >
          <div>
            <span className="eyebrow">Local operator gate</span>
              <strong>
                Canonical State is unchanged while this decision is pending.
              </strong>
            <p>
                Review the verified producer, policy generation, and immutable
                Admission digest. Your first decision is append-only and exact
                retries reuse it.
            </p>
          </div>
          <label>
            Decision reason
            <textarea
              value={approvalReason}
              onChange={(event) => setApprovalReason(event.target.value)}
              maxLength={512}
              placeholder="Record why this exact transfer is safe or unsafe"
                disabled={
                  decisionBusy !== null ||
                  result?.approval?.choice === "approve"
                }
              required
            />
          </label>
          <div className="federation-approval-actions">
            {!result?.approval && (
              <button
                type="button"
                className="button"
                disabled={
                  !approvalReason.trim() ||
                    !(
                      result?.approval?.decisionContextDigest ??
                      selectedInboxItem?.review?.decisionContextDigest
                    ) ||
                  decisionBusy !== null
                }
                onClick={() => void decidePendingAdmission("deny")}
              >
                  {decisionBusy === "deny" ? (
                    <Spinner />
                  ) : (
                    "Deny and preserve Canonical"
                  )}
              </button>
            )}
            <button
              type="button"
              className="button button-primary"
              disabled={
                !approvalReason.trim() ||
                  !(
                    result?.approval?.decisionContextDigest ??
                    selectedInboxItem?.review?.decisionContextDigest
                  ) ||
                decisionBusy !== null
              }
              onClick={() => void decidePendingAdmission("approve")}
            >
              {decisionBusy === "approve" ? (
                <Spinner />
              ) : result?.approval?.choice === "approve" ? (
                "Resume approved Candidate"
              ) : (
                "Approve into Candidate State"
              )}
            </button>
          </div>
        </section>
      )}

      {result?.approval && (
        <div
          className="federation-decision-evidence"
          data-choice={result.approval.choice}
        >
          <span>
            {result.approval.choice === "approve" ? "APPROVED" : "DENIED"}
          </span>
          <strong>{result.approval.reason}</strong>
          <code>{result.approval.recordDigest}</code>
          {result.approval.decisionContextDigest ? (
            <small>
              Reviewed context {result.approval.decisionContextDigest}
            </small>
          ) : (
            <small>Legacy decision - no reviewed-context commitment</small>
          )}
          <small>Recorded by {result.approval.operatorId}</small>
        </div>
      )}

      <div className="federation-actions">
        <span>
          No model call runs during import. Exact retries reuse durable
          admission and decision evidence.
        </span>
        <button
          className="button button-primary"
          disabled={
            disabled ||
            busy ||
            !policy ||
            !producerId ||
            !transferId.trim() ||
            !bundle ||
            !trustPolicy
          }
        >
          {busy ? <Spinner /> : "Admit into Candidate State"}
        </button>
      </div>
    </form>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showReceiptVerifier, setShowReceiptVerifier] = useState(false);
  const [verifierArtifact, setVerifierArtifact] =
    useState<PortableVerifierArtifact | null>(null);
  const closeReceiptVerifier = useCallback(() => {
    setShowReceiptVerifier(false);
    setVerifierArtifact(null);
  }, []);
  const [automaticProof, setAutomaticProof] =
    useState<AutomaticProofState | null>(null);
  const [recordingAttempt, setRecordingAttempt] =
    useState<RecordingAttempt | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [activeCandidateSet, setActiveCandidateSet] =
    useState<CandidateSet | null>(null);
  const [assuranceProposals, setAssuranceProposals] = useState<
    AssuranceProposal[]
  >([]);
  const [contractVersions, setContractVersions] = useState<
    OutcomeContractVersionRecord[]
  >([]);
  const [showAssurance, setShowAssurance] = useState(false);
  const [showExplore, setShowExplore] = useState(false);
  const [showFederation, setShowFederation] = useState(false);
  const [explorationObjective, setExplorationObjective] = useState(
    defaultExplorationObjective,
  );
  const [loserPolicy, setLoserPolicy] = useState<"retain" | "discard">(
    "retain",
  );
  const [airlockActionBusy, setAirlockActionBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestAutomaticProof = useCallback(
    (runId: string) => {
      setError(null);
      setActiveRun((current) =>
        current?.id === runId
          ? current
          : (runs.find((run) => run.id === runId) ?? current),
      );
      setAutomaticProof((current) => ({
        runId,
        requestNonce: current?.runId === runId ? current.requestNonce + 1 : 1,
        status: "requested",
      }));
    },
    [runs],
  );
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [recordingDismissed, setRecordingDismissed] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const pollingCandidateSetIds = useRef(new Set<string>());
  const recordingReplayRequestRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const recordingRequested =
    new URLSearchParams(window.location.search).get("recording") === "1";
  const recordingReplaySelection = useMemo(
    () => parseRecordingReplayRunIds(window.location.search),
    [],
  );
  const recordingMode =
    recordingRequested &&
    !recordingDismissed &&
    system?.protocolFixtureMode === true;
  const recordingOutcome = useMemo(
    () =>
      recordingMode
        ? deriveRecordingOutcome(runs, automaticProof, recordingAttempt)
        : null,
    [automaticProof, recordingAttempt, recordingMode, runs],
  );

  const demoStepCompletion = useMemo(() => {
    const assistantOutputs = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content.toLowerCase());
    return {
      promote: assistantOutputs.some((output) =>
        output.includes("prepared the multi-resource release"),
      ),
      challenge: assistantOutputs.some((output) =>
        output.includes("attempted the destructive workspace change"),
      ),
      repair: assistantOutputs.some((output) =>
        output.includes("repaired the quarantined future"),
      ),
      continue: assistantOutputs.some(
        (output) =>
          output.includes("continued baseline-thread") &&
          output.includes("confirm recovery"),
      ),
    };
  }, [messages]);

  const runInProgress =
    activeRun != null && ["queued", "running"].includes(activeRun.status);
  const candidateSetInProgress =
    activeCandidateSet != null &&
    !["completed", "stale", "recovery-error"].includes(
      activeCandidateSet.phase,
    );
  const demoActionBusy =
    busy ||
    airlockActionBusy ||
    selected?.status === "busy" ||
    runInProgress ||
    candidateSetInProgress;
  const canRepairActiveFuture =
    activeRun?.status === "completed" &&
    activeRun.transaction?.disposition === "quarantined" &&
    activeRun.transaction.quarantineAvailable;

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        if (required) {
          setAuthRequired(true);
          return;
        }
        await bootstrap();
        if (mountedRef.current) setAuthRequired(false);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    recordingReplayRequestRef.current = null;
    setAutomaticProof(null);
    setRecordingAttempt(null);
    setActiveRun(null);
    setActiveCandidateSet(null);
    setShowExplore(false);
    setShowFederation(false);
    setShowAssurance(false);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      setRuns([]);
      setAssuranceProposals([]);
      setContractVersions([]);
      return;
    }
    void Promise.all([
      refreshMessages(selectedId),
      api.runs(selectedId),
      api.candidateSets(selectedId),
      api.assuranceProposals(selectedId),
      api.outcomeContractVersions(selectedId),
    ])
      .then(
        ([, result, candidateSetsResult, assuranceResult, versionsResult]) => {
          if (selectedIdRef.current !== selectedId) return;
          const latest = result.runs.find((run) => !run.candidateSetId) ?? null;
          setRuns(result.runs);
          setActiveRun(latest);
          const latestCandidateSet =
            candidateSetsResult.candidateSets[0] ?? null;
          setActiveCandidateSet(latestCandidateSet);
          setAssuranceProposals(assuranceResult.proposals);
          setContractVersions(versionsResult.versions);
          if (latest && ["queued", "running"].includes(latest.status)) {
            void pollRun(latest.id, selectedId).catch((reason) =>
              setError(
                reason instanceof Error ? reason.message : String(reason),
              ),
            );
          }
          if (
            latestCandidateSet &&
            !["completed", "stale", "recovery-error"].includes(
              latestCandidateSet.phase,
            )
          ) {
            void pollCandidateSet(latestCandidateSet.id, selectedId).catch(
              (reason) =>
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                ),
            );
          }
        },
      )
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (
      !recordingMode ||
      system?.protocolFixtureMode !== true ||
      !selected
    ) {
      return;
    }
    const hydration = deriveRecordingReplayHydration(
      runs,
      recordingReplaySelection,
    );
    if (!hydration || hydration.agentId !== selected.id) return;

    const replayIdentity = [
      hydration.agentId,
      hydration.runIds.safeRunId,
      hydration.runIds.unsafeRunId,
      hydration.runIds.repairedRunId,
    ].join(":");
    if (recordingReplayRequestRef.current === replayIdentity) return;
    recordingReplayRequestRef.current = replayIdentity;
    setRecordingAttempt({
      agentId: hydration.agentId,
      baselineRunIds: hydration.baselineRunIds,
      canonicalStateId: hydration.canonicalStateId,
      runIds: hydration.runIds,
    });
    requestAutomaticProof(hydration.repairedRun.id);
  }, [
    recordingMode,
    recordingReplaySelection,
    requestAutomaticProof,
    runs,
    selected,
    system?.protocolFixtureMode,
  ]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    if (messages.length > 0 || activeRun || activeCandidateSet) {
      messageEnd.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, activeRun, activeCandidateSet]);

  useEffect(() => {
    const transaction = activeRun?.transaction;
    if (
      recordingMode ||
      !system?.protocolFixtureMode ||
      activeRun?.status !== "completed" ||
      transaction?.disposition !== "promoted" ||
      transaction.lineage.depth < 1
    ) {
      return;
    }
    setAutomaticProof((current) =>
      current?.runId === activeRun.id
        ? current
        : { runId: activeRun.id, requestNonce: 1, status: "requested" },
    );
  }, [
    activeRun?.id,
    activeRun?.status,
    activeRun?.transaction?.disposition,
    activeRun?.transaction?.lineage.depth,
    recordingMode,
    system?.protocolFixtureMode,
  ]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (
      !window.confirm(
        "Delete " + selected.name + "? Its workspace will be archived.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (
    runId: string,
    agentId: string,
  ): Promise<AgentRun | null> => {
    if (pollingRunIds.current.has(runId)) return null;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return null;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          const [, , runResult] = await Promise.all([
            refreshMessages(agentId),
            refreshAgents(),
            api.runs(agentId),
          ]);
          if (selectedIdRef.current === agentId) setRuns(runResult.runs);
          return result.run;
        }
      }
      return null;
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const pollCandidateSet = async (candidateSetId: string, agentId: string) => {
    if (pollingCandidateSetIds.current.has(candidateSetId)) return;
    pollingCandidateSetIds.current.add(candidateSetId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        if (!mountedRef.current) return;
        const result = await api.candidateSet(candidateSetId);
        if (selectedIdRef.current === agentId) {
          setActiveCandidateSet(result.candidateSet);
        }
        if (
          ["completed", "stale", "recovery-error"].includes(
            result.candidateSet.phase,
          )
        ) {
          await refreshAgents();
          return;
        }
      }
    } finally {
      pollingCandidateSetIds.current.delete(candidateSetId);
    }
  };

  const exploreCompetingFutures = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !explorationObjective.trim()) return;
    setAirlockActionBusy(true);
    setError(null);
    try {
      const result = await api.createCandidateSet(selected.id, {
        objective: explorationObjective.trim(),
        competitors: [
          {
            id: "unsafe-fast",
            executorProfileId: "standard-v1",
            strategyInstruction:
              "Finish quickly, but every required Validation still controls eligibility.",
          },
          {
            id: "broad-valid",
            executorProfileId: "standard-v1",
            strategyInstruction:
              "Pursue a comprehensive valid implementation and verify the whole surface.",
          },
          {
            id: "focused-valid",
            executorProfileId: "standard-v1",
            strategyInstruction:
              "Pursue the narrowest complete implementation with minimal file and byte changes.",
          },
        ],
        maxConcurrency: 3,
        loserPolicy,
      });
      setActiveCandidateSet(result.candidateSet);
      setShowExplore(false);
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollCandidateSet(result.candidateSet.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshAgents();
    } finally {
      setAirlockActionBusy(false);
    }
  };

  const cancelCompetingFutures = async () => {
    if (!activeCandidateSet) return;
    setAirlockActionBusy(true);
    setError(null);
    try {
      const result = await api.cancelCandidateSet(activeCandidateSet.id);
      setActiveCandidateSet(result.candidateSet);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAirlockActionBusy(false);
    }
  };

  const refreshAssurance = async (agentId: string) => {
    const [proposalResult, versionResult] = await Promise.all([
      api.assuranceProposals(agentId),
      api.outcomeContractVersions(agentId),
    ]);
    if (selectedIdRef.current === agentId) {
      setAssuranceProposals(proposalResult.proposals);
      setContractVersions(versionResult.versions);
    }
  };

  const deriveAssurance = async () => {
    if (!selected) return;
    setAirlockActionBusy(true);
    setError(null);
    try {
      const result = await api.deriveAssuranceProposal(selected.id);
      await refreshAssurance(selected.id);
      if (!result.proposal) {
        setError(
          "No recurring pattern reached the deterministic support threshold yet.",
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAirlockActionBusy(false);
    }
  };

  const acceptAssurance = async (proposal: AssuranceProposal) => {
    if (!selected) return;
    const changes = proposal.operations
      .map(assuranceOperationLabel)
      .join("\n- ");
    if (
      !window.confirm(
        "Accept this monotonic policy change for future Runs only?\n\n- " +
          changes,
      )
    ) {
      return;
    }
    const reason =
      window.prompt(
        "Record an operator reason for acceptance:",
        "Reviewed bounded evidence",
      ) ?? "";
    setAirlockActionBusy(true);
    setError(null);
    try {
      await api.acceptAssuranceProposal(proposal.id, reason);
      await Promise.all([refreshAgents(), refreshAssurance(selected.id)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshAssurance(selected.id);
    } finally {
      setAirlockActionBusy(false);
    }
  };

  const rejectAssurance = async (proposal: AssuranceProposal) => {
    if (!selected) return;
    const reason = window.prompt(
      "Why reject this proposal?",
      "Needs more context",
    );
    if (reason === null) return;
    setAirlockActionBusy(true);
    setError(null);
    try {
      await api.rejectAssuranceProposal(proposal.id, reason);
      await refreshAssurance(selected.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setAirlockActionBusy(false);
    }
  };

  const rollbackContract = async (target: OutcomeContractVersionRecord) => {
    if (!selected) return;
    const current = selected.outcomeContract;
    const removedRequiredPaths = current.requiredPaths.filter(
      (item) => !target.contract.requiredPaths.includes(item),
    );
    const removedProtections = current.protectedPaths.filter(
      (item) => !target.contract.protectedPaths.includes(item),
    );
    const removedSecretRules = current.secretPatterns
      .filter(
        (rule) =>
          !target.contract.secretPatterns.some(
            (candidate) =>
              candidate.name === rule.name &&
              candidate.pattern === rule.pattern,
          ),
      )
      .map((rule) => rule.name);
    const removedRequiredCommands = current.validationCommands
      .filter(
        (command) =>
          command.required &&
          !target.contract.validationCommands.some(
            (candidate) =>
              candidate.name === command.name &&
              candidate.command === command.command &&
              candidate.timeoutMs === command.timeoutMs &&
              candidate.required,
          ),
      )
      .map((command) => command.name);
    const raisedLimits = [
      target.contract.maxChangedFiles > current.maxChangedFiles
        ? "changed files " +
          current.maxChangedFiles +
          " to " +
          target.contract.maxChangedFiles
        : null,
      target.contract.maxAddedBytes > current.maxAddedBytes
        ? "added bytes " +
          formatBytes(current.maxAddedBytes) +
          " to " +
          formatBytes(target.contract.maxAddedBytes)
        : null,
    ].filter(Boolean);
    const warning = [
      removedRequiredPaths.length
        ? "Required paths removed: " + removedRequiredPaths.join(", ")
        : "No required paths removed.",
      removedProtections.length
        ? "Protections removed: " + removedProtections.join(", ")
        : "No protected paths removed.",
      removedSecretRules.length
        ? "Secret rules removed or changed: " + removedSecretRules.join(", ")
        : "No secret rules removed or changed.",
      removedRequiredCommands.length
        ? "Required validations removed or changed: " +
          removedRequiredCommands.join(", ")
        : "No required validations removed or changed.",
      raisedLimits.length
        ? "Limits raised: " + raisedLimits.join(", ")
        : "No limits raised.",
      "A new version will be created. Historical contracts and receipts remain unchanged.",
    ].join("\n");
    if (
      !window.confirm(
        "Roll back rule content from version " +
          target.contract.version +
          "?\n\n" +
          warning,
      )
    ) {
      return;
    }
    setAirlockActionBusy(true);
    setError(null);
    try {
      await api.rollbackOutcomeContract(
        selected.id,
        target.contract.version,
        current.version,
      );
      await Promise.all([refreshAgents(), refreshAssurance(selected.id)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAirlockActionBusy(false);
    }
  };

  const runPrompt = async (content: string): Promise<AgentRun | null> => {
    if (!selected || !content.trim()) return null;
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setRuns((current) => [result.run, ...current]);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      return await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
      return null;
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    await runPrompt(prompt.trim());
  };

  const repairActiveRun = async (
    sourceRunId = activeRun?.id,
  ): Promise<AgentRun | null> => {
    if (!selected || !sourceRunId) return null;
    setAirlockActionBusy(true);
    setError(null);
    try {
      const result = await api.repairRun(sourceRunId);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setRuns((current) => [result.run, ...current]);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      return await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshAgents();
      return null;
    } finally {
      setAirlockActionBusy(false);
    }
  };

  const discardActiveRun = async () => {
    if (!activeRun) return;
    if (
      !window.confirm(
        "Discard this mutable Quarantine? Its bounded decision evidence will remain.",
      )
    ) {
      return;
    }
    setAirlockActionBusy(true);
    setError(null);
    try {
      const result = await api.discardRun(activeRun.id);
      setActiveRun(result.run);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAirlockActionBusy(false);
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Airlock</span>
          <h1>Connecting to the control plane</h1>
          {error ? (
            <div className="error-banner" role="alert">
              {error}
            </div>
          ) : (
            <Spinner />
          )}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Airlock</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button
            className="button button-primary"
            disabled={busy || !authInput.trim()}
          >
            {busy ? <Spinner /> : "Open Airlock"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className={recordingMode ? "app-shell recording-mode" : "app-shell"}>
      {!recordingMode && (
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Airlock</strong>
            <span>
              {system?.demoMode
                ? "Free local proof · no network model"
                : system?.protocolFixtureMode
                  ? "Real Runtime proof · local inference"
                  : system?.modelArkDemoMode
                    ? "Live ModelArk proof · isolated Runtime"
                : system?.runtimeProvider === "container"
                  ? "Local container · Codex CLI"
                  : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
                className={
                  "agent-card " + (agent.id === selectedId ? "selected" : "")
                }
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
                <div className="agent-avatar">
                  {agent.name.slice(0, 1).toUpperCase()}
                </div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.demoMode
              ? "No paid inference"
              : system?.protocolFixtureMode
                  ? "Local Responses fixture · " +
                    (system.containerEngine ?? "container")
                : system?.modelArkDemoMode
                    ? "Provider-backed ModelArk · " +
                      (system.containerEngine ?? "container")
                  : (system?.arkConfigured
                      ? "Configured ModelArk profile"
                      : "ModelArk profile not configured") +
                      (system?.containerEngine
                        ? " · " + system.containerEngine
                        : "")}
          </span>
        </div>
        {system?.portableTrust.available && (
          <button
            type="button"
            className="button verify-receipt-button"
            onClick={() => {
              setVerifierArtifact(null);
              setShowReceiptVerifier(true);
            }}
          >
            <span aria-hidden="true">✓</span>
            Verify a receipt
          </button>
        )}
      </aside>
      )}

      <main className="main">
        {system?.demoMode ? (
          <div className="demo-mode-banner" role="status">
            <span>FREE LOCAL DEMO</span>
            <div>
              <strong>Deterministic protocol fixture</strong>
              <p>No ModelArk request or paid inference is active.</p>
            </div>
          </div>
        ) : null}

        {system?.protocolFixtureMode ? (
          <div className="protocol-mode-banner" role="status">
            <span>TRACK 1 · AGENT LAUNCHPAD</span>
            <div>
              <strong>
                Reusable Agent Airlock middleware automatically protects every
                Agent Run
              </strong>
              <p>
                Real Codex CLI in a disposable container · local deterministic
                Responses fixture · no ModelArk request or paid inference.
              </p>
            </div>
          </div>
        ) : null}

        {system?.modelArkDemoMode ? (
          <div className="live-mode-banner" role="status">
            <span>AIRLOCK-ATTESTED MODELARK RUN</span>
            <div>
              <strong>
                Live provider inference observed by Agent Airlock
              </strong>
              <p>
                Fresh preflight generated assistant output in{" "}
                {system.modelArkPreflight?.requestCount ?? 0} bounded request
                {system.modelArkPreflight?.requestCount === 1 ? "" : "s"}.
                Output and credentials remain private. This is not
                BytePlus-signed telemetry.
              </p>
            </div>
          </div>
        ) : null}

        {!system?.demoMode &&
        !system?.protocolFixtureMode &&
        !system?.modelArkDemoMode &&
        system?.arkConfigured &&
        system?.codexAvailable ? (
          <div className="live-mode-banner" role="status">
            <span>LIVE MODELARK</span>
            <div>
              <strong>
                Provider-backed inference through an isolated Runtime
              </strong>
              <p>
                Every turn still works in Candidate State until required
                Validations pass.
              </p>
            </div>
          </div>
        ) : null}

        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {recordingOutcome && system ? (
          <RecordingOutcomeBrief
            outcome={recordingOutcome}
            system={system}
            agentStatus={selected?.status ?? null}
            onOpenVerifier={() => {
              if (!automaticProof?.artifact) return;
              setVerifierArtifact(automaticProof.artifact);
              setShowReceiptVerifier(true);
            }}
            onContinue={() => {
              setRecordingAttempt(null);
              setAutomaticProof(null);
              setRecordingDismissed(true);
              const nextUrl = new URL(window.location.href);
              nextUrl.searchParams.delete("recording");
              window.history.replaceState({}, "", nextUrl);
            }}
          />
        ) : selected ? (
          <>
            {!recordingMode && (
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                  <p>
                    {selected.description ||
                      "A Codex coding Agent in an isolated workspace."}
                  </p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>
            )}

            {!recordingMode && showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>
                    ×
                  </button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) =>
                        setForm({ ...form, name: event.target.value })
                      }
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <section
                  className="contract-overview"
                  aria-label="Outcome Contract summary"
                >
                  <div className="contract-overview-heading">
                    <div>
                      <span className="eyebrow">Promotion rules</span>
                      <h3>Outcome Contract</h3>
                    </div>
                    <span className="contract-badge">
                      Version {selected.outcomeContract.version}
                    </span>
                  </div>
                  <div className="contract-rules">
                    <div>
                      <span>Required paths</span>
                      <div className="rule-tags">
                        {selected.outcomeContract.requiredPaths.map((rule) => (
                          <code key={rule}>{rule}</code>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span>Protected paths</span>
                      <div className="rule-tags">
                        {selected.outcomeContract.protectedPaths.map((rule) => (
                          <code key={rule}>{rule}</code>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span>Change budget</span>
                      <strong>
                        {selected.outcomeContract.maxChangedFiles} files ·{" "}
                        {formatBytes(selected.outcomeContract.maxAddedBytes)}
                      </strong>
                    </div>
                    <div>
                      <span>Safety checks</span>
                      <strong>
                        {selected.outcomeContract.secretPatterns.length} secret
                        patterns ·{" "}
                        {selected.outcomeContract.validationCommands.length}{" "}
                        commands
                      </strong>
                    </div>
                  </div>
                  <p>
                    Every Run snapshots this version. Required failures enter
                    Quarantine and leave Canonical State unchanged.
                  </p>
                  {contractVersions.length > 1 && (
                    <details className="contract-history">
                      <summary>Version history and rollback</summary>
                      <div>
                        {contractVersions.map((record) => (
                          <div key={record.contract.version}>
                            <span>
                              <strong>v{record.contract.version}</strong>
                              {" · "}
                              {record.provenance}
                            </span>
                            {record.contract.version !==
                              selected.outcomeContract.version && (
                              <button
                                type="button"
                                className="button button-ghost"
                                disabled={airlockActionBusy}
                                onClick={() => void rollbackContract(record)}
                              >
                                Restore rule content
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </section>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section
              className={
                "playground" +
                (system?.protocolFixtureMode || system?.modelArkDemoMode
                  ? " protocol-proof-playground"
                  : "") +
                ((system?.protocolFixtureMode || system?.modelArkDemoMode) &&
                messages.length === 0 &&
                !activeRun &&
                !activeCandidateSet
                  ? " protocol-proof-standby"
                  : "")
              }
            >
              <div className="playground-header">
                <div
                  className={
                    "playground-topbar" +
                    (system?.protocolFixtureMode || system?.modelArkDemoMode
                      ? " protocol-proof-topbar"
                      : "")
                  }
                >
                  <div>
                    <span className="eyebrow">Playground</span>
                    <h2>
                      {system?.demoMode
                        ? "Prove one Agent future is safe"
                        : system?.protocolFixtureMode
                          ? "Prove transactional safety for a real Agent Run"
                          : system?.modelArkDemoMode
                            ? "Prove a live ModelArk change is safe"
                        : "Build something with your Agent"}
                    </h2>
                    {recordingMode && (
                      <div
                        className="recording-agent-context"
                        aria-label="Recording Agent context"
                      >
                        <strong>{selected.name}</strong>
                        <StatusPill status={selected.status} />
                        <span>
                          Outcome Contract v{selected.outcomeContract.version}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="playground-state">
                    {!recordingMode && (
                    <button
                      type="button"
                      className="federation-toggle"
                      onClick={() => setShowFederation((current) => !current)}
                        disabled={
                          demoActionBusy || selected.status === "stopped"
                        }
                      aria-expanded={showFederation}
                      aria-controls="federation-airlock-panel"
                    >
                      <span aria-hidden="true">⇄</span>
                      Federation
                    </button>
                    )}
                    {system?.protocolFixtureMode || system?.modelArkDemoMode ? (
                      <div
                        className="proof-route"
                        aria-label="Judge proof path"
                      >
                        <span>Run</span>
                        <i aria-hidden="true">→</i>
                        <span>Validate</span>
                        <i aria-hidden="true">→</i>
                        <span>Promote</span>
                        <i aria-hidden="true">→</i>
                        <span>Verify</span>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="assurance-toggle"
                          onClick={() =>
                            setShowAssurance((current) => !current)
                          }
                          aria-expanded={showAssurance}
                          aria-controls="assurance-inbox"
                        >
                          <span aria-hidden="true">⌁</span>
                          Assurance
                          {assuranceProposals.filter(
                            (proposal) => proposal.state === "ready",
                          ).length > 0 && (
                            <strong>
                              {
                                assuranceProposals.filter(
                                  (proposal) => proposal.state === "ready",
                                ).length
                              }
                            </strong>
                          )}
                        </button>
                        <button
                          type="button"
                          className="explore-button"
                          onClick={() => setShowExplore((current) => !current)}
                          disabled={
                            selected.status === "stopped" ||
                            demoActionBusy ||
                            candidateSetInProgress ||
                            system?.competingFutures.available === false
                          }
                          title={system?.competingFutures.reason ?? undefined}
                          aria-expanded={showExplore}
                          aria-controls="competing-futures-panel"
                        >
                          <span aria-hidden="true">◇</span>
                          Explore futures
                        </button>
                        {system?.competingFutures.available === false && (
                          <small className="capability-reason" role="status">
                            {system.competingFutures.reason}
                          </small>
                        )}
                      </>
                    )}
                    {!recordingMode && (
                      <>
                    <span className="contract-badge">
                      Outcome Contract v{selected.outcomeContract.version}
                    </span>
                    <div className="session-info">
                      <span className="pulse" />
                          {selected.codexThreadId
                            ? "Session connected"
                            : "New session"}
                    </div>
                      </>
                    )}
                  </div>
                </div>

                {showFederation && (
                  <div id="federation-airlock-panel">
                    <FederationAirlock
                      key={selected.id}
                      agent={selected}
                      disabled={demoActionBusy || selected.status === "stopped"}
                      onImported={async (imported) => {
                        if (imported.run) {
                          setActiveRun(imported.run);
                          setRuns((current) => [
                            imported.run!,
                            ...current.filter(
                              (run) => run.id !== imported.run!.id,
                            ),
                          ]);
                        }
                        await refreshAgents();
                      }}
                      onVerifyArtifact={(artifact) => {
                        setVerifierArtifact(artifact);
                        setShowReceiptVerifier(true);
                      }}
                    />
                  </div>
                )}

                {showAssurance && (
                  <div id="assurance-inbox">
                    <AssuranceInbox
                      proposals={assuranceProposals}
                      busy={airlockActionBusy}
                      onDerive={() => void deriveAssurance()}
                      onAccept={(proposal) => void acceptAssurance(proposal)}
                      onReject={(proposal) => void rejectAssurance(proposal)}
                    />
                  </div>
                )}

                {showExplore && (
                  <form
                    className="explore-panel"
                    id="competing-futures-panel"
                    onSubmit={exploreCompetingFutures}
                  >
                    <div className="explore-intro">
                      <div>
                        <span className="eyebrow">Competing Futures</span>
                        <h3>Let isolated approaches compete safely</h3>
                      </div>
                      <p>
                        All three start from the same immutable source and
                        policy. Required Validation controls eligibility, then a
                        deterministic score selects exactly one future for
                        Promotion.
                      </p>
                    </div>
                    <label className="explore-objective">
                      Objective
                      <textarea
                        value={explorationObjective}
                        onChange={(event) =>
                          setExplorationObjective(event.target.value)
                        }
                        rows={2}
                        maxLength={4_000}
                        required
                      />
                    </label>
                    <div
                      className="explore-strategies"
                      aria-label="Competing strategies"
                    >
                      <div>
                        <span>01</span>
                        <strong>Unsafe fast</strong>
                        <small>Proves safety outranks speed</small>
                      </div>
                      <div>
                        <span>02</span>
                        <strong>Broad valid</strong>
                        <small>Complete, but changes more</small>
                      </div>
                      <div>
                        <span>03</span>
                        <strong>Focused valid</strong>
                        <small>Smallest complete future</small>
                      </div>
                    </div>
                    <div className="explore-controls">
                      <label>
                        Loser evidence
                        <select
                          value={loserPolicy}
                          onChange={(event) =>
                            setLoserPolicy(
                              event.target.value as "retain" | "discard",
                            )
                          }
                        >
                          <option value="retain">Retain isolated state</option>
                          <option value="discard">
                            Keep proof, discard state
                          </option>
                        </select>
                      </label>
                      <div className="explore-safety">
                        <strong>Absolute safety gate</strong>
                        <span>A faster invalid future can never win.</span>
                      </div>
                      <div className="explore-actions">
                        <button
                          type="button"
                          className="button button-ghost"
                          onClick={() => setShowExplore(false)}
                        >
                          Close
                        </button>
                        <button
                          className="button button-primary"
                          disabled={
                            !explorationObjective.trim() || demoActionBusy
                          }
                        >
                          {airlockActionBusy ? (
                            <Spinner />
                          ) : (
                            "Run three futures"
                          )}
                        </button>
                      </div>
                    </div>
                  </form>
                )}

                {system?.demoMode ? (
                  <section
                    className="demo-guide"
                    aria-label="Four-step demo proof"
                  >
                    <div className="demo-guide-heading">
                      <span className="eyebrow">Judge path</span>
                      <p>
                        Stage each prompt, then send it. Repair runs directly
                        from Quarantine.
                      </p>
                    </div>
                    <div className="demo-step-list">
                      {demoHeroSteps.map((step, index) => {
                        const completed = demoStepCompletion[step.id];
                        const prerequisiteMet =
                          index === 0 ||
                          demoStepCompletion[demoHeroSteps[index - 1].id];
                        const disabled =
                          demoActionBusy ||
                          completed ||
                          !prerequisiteMet ||
                          (step.id === "repair" && !canRepairActiveFuture);
                        return (
                          <button
                            type="button"
                            className={
                              completed ? "demo-step completed" : "demo-step"
                            }
                            key={step.id}
                            disabled={disabled}
                            aria-label={
                              "Demo step " + (index + 1) + ": " + step.label
                            }
                            onClick={() => {
                              if (step.id === "repair") {
                                void repairActiveRun();
                              } else if (step.prompt) {
                                setPrompt(step.prompt);
                              }
                            }}
                          >
                            <span className="demo-step-number">
                              {completed ? "✓" : step.number}
                            </span>
                            <span>
                              <strong>{step.label}</strong>
                              <small>{step.detail}</small>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ) : null}
                {system?.protocolFixtureMode ? (
                  <ProtocolScenarioGuide
                    runs={runs}
                    busy={demoActionBusy}
                    onRun={runPrompt}
                    onRepair={repairActiveRun}
                    onRequestProof={requestAutomaticProof}
                    automaticProof={automaticProof}
                    recordingMode={recordingMode}
                    readOnlyReplayMode={
                      recordingMode && recordingReplaySelection.kind !== "absent"
                    }
                    recordingRunIds={recordingAttempt?.runIds ?? null}
                    onRecordingAttemptStart={() => {
                      setAutomaticProof(null);
                      setRecordingAttempt({
                        baselineRunIds: runs.map((run) => run.id),
                        agentId: selected.id,
                        canonicalStateId: selected.canonicalStateId,
                        runIds: null,
                      });
                    }}
                    onRecordingAttemptComplete={(runIds) => {
                      setRecordingAttempt((current) =>
                        current ? { ...current, runIds } : null,
                      );
                    }}
                  />
                ) : null}
                {system?.modelArkDemoMode ? (
                  <LiveModelArkGuide
                    runs={runs}
                    busy={demoActionBusy}
                    onRun={(content) => void runPrompt(content)}
                  />
                ) : null}
              </div>

              <div
                className={
                  "messages" +
                  (recordingMode ? " recording-proof-engine" : "") +
                  ((system?.protocolFixtureMode || system?.modelArkDemoMode) &&
                  messages.length === 0 &&
                  !activeRun &&
                  !activeCandidateSet
                    ? " protocol-proof-standby-messages"
                    : "")
                }
              >
                {messages.length === 0 && !activeRun && !activeCandidateSet ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>
                      {system?.demoMode
                        ? "Start with the safe multi-resource release"
                        : system?.protocolFixtureMode
                          ? "Run the real container transaction"
                          : system?.modelArkDemoMode
                            ? "Run the live provider proof"
                        : `What should ${selected.name} build?`}
                    </h3>
                    <p>
                      {system?.demoMode
                        ? "This local fixture demonstrates transactional Promotion, Quarantine, Repair, and session continuity without calling a network model."
                        : system?.protocolFixtureMode
                          ? "Real Codex will make a tool call inside an isolated Candidate workspace. Airlock validates the result before it can replace Canonical State."
                          : system?.modelArkDemoMode
                            ? "ModelArk directs real Codex tools inside an isolated Candidate. The exact output is checked independently before Promotion."
                        : "Live ModelArk inference can inspect files, write code, and run commands, while Airlock keeps every change isolated until Validation and Promotion."}
                    </p>
                    <div className="prompt-grid">
                      {(system?.demoMode
                        ? Object.values(demoHeroPrompts)
                        : system?.protocolFixtureMode
                          ? Object.values(protocolFixturePrompts)
                          : system?.modelArkDemoMode
                            ? [liveModelArkPrompt]
                          : starterPrompts
                      ).map((item) => (
                          <button key={item} onClick={() => setPrompt(item)}>
                            <span>↗</span>
                            {item}
                          </button>
                        ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article
                      className={"message message-" + message.role}
                      key={message.id}
                    >
                      <div className="message-meta">
                        <strong>
                          {message.role === "user" ? "You" : selected.name}
                        </strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun &&
                  ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                {activeRun && (
                  <AirlockEvidence
                    run={activeRun}
                    actionBusy={airlockActionBusy}
                    onRepair={() => void repairActiveRun()}
                    onDiscard={() => void discardActiveRun()}
                    portableTrustAvailable={
                      system?.portableTrust.available === true
                    }
                    judgeProofMode={
                      system?.protocolFixtureMode === true ||
                      system?.modelArkDemoMode === true
                    }
                    modelArkProofMode={system?.modelArkDemoMode === true}
                    automaticProofRequestNonce={
                      activeRun.id === automaticProof?.runId &&
                      automaticProof.status === "requested"
                        ? automaticProof.requestNonce
                        : null
                    }
                    onPortableError={setError}
                    onVerifyArtifact={(artifact) => {
                      setVerifierArtifact(artifact);
                      setShowReceiptVerifier(true);
                    }}
                    onAutomaticProofResult={(runId, verification) => {
                      setAutomaticProof((current) =>
                        current?.runId === runId
                          ? {
                              ...current,
                              status: verification.valid
                                ? "verified"
                                : "failed",
                              error: verification.error,
                              artifact: verification.artifact,
                              decisionCount: verification.decisionCount,
                              leafReceiptDigest:
                                verification.leafReceiptDigest,
                            }
                          : current,
                      );
                    }}
                  />
                )}
                {activeCandidateSet && (
                  <CandidateSetEvidence
                    candidateSet={activeCandidateSet}
                    actionBusy={airlockActionBusy}
                    onCancel={() => void cancelCompetingFutures()}
                    portableTrustAvailable={
                      system?.portableTrust.available === true
                    }
                    onPortableError={setError}
                  />
                )}
                <div ref={messageEnd} />
              </div>

              {!recordingMode && (
              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    candidateSetInProgress ||
                      (activeRun != null &&
                        ["queued", "running"].includes(activeRun.status))
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                      Enter to send · Shift + Enter for newline ·{" "}
                      {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      candidateSetInProgress ||
                        (activeRun != null &&
                          ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
              )}
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Airlock</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>
              Create a workspace, give Codex a job, and continue the
              conversation here.
            </p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setShowCreate(false)}
        >
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>
                  Each Agent gets a persistent folder and a resumable Codex
                  session.
                </p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>
                ×
              </button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showReceiptVerifier && (
        <ReceiptVerifier
          initialArtifact={verifierArtifact}
          agentStatus={selected?.status ?? null}
          onClose={closeReceiptVerifier}
        />
      )}
    </div>
  );
}
