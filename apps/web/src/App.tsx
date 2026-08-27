import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  evaluateSigningKeyTrust,
  verifyPortableDecisionChainJsonInBrowser,
  verifyPortableEvidencePacketJsonInBrowser,
  verifySignedPolicyAuthorityRotationEnvelopeJsonInBrowser,
  verifySignedSigningKeyTrustPolicyEnvelopeJsonInBrowser,
  verifyPortablePromotionEnvelopeJsonInBrowser,
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
  TrustPolicyVerificationReport,
} from "@agent-airlock/portable-promotion-receipt";
import { api, ApiError, setAuthToken } from "./api";
import type {
  Agent,
  AgentRun,
  AssuranceOperation,
  AssuranceProposal,
  CandidateSet,
  Message,
  OutcomeContractVersionRecord,
  PortableReceiptExport,
  SystemInfo,
} from "./types";

const starterPrompts = [
  "Build a dependency-free Node.js OrderGuard CLI using only built-in modules and node:test. Do not run npm install or create node_modules. Read local JSON, reject invalid orders, summarize valid revenue by status, add sample data and tests, run the tests, and summarize the result.",
  "Inspect this workspace and explain what you would improve first without changing files or installing dependencies.",
  "Demonstrate Airlock rejection by creating damage.txt and deleting the protected AGENTS.md file.",
];

const protocolFixturePrompts = ["Create protocol-proof.txt."];

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

function JudgeProofSummary({
  transaction,
}: {
  transaction: NonNullable<AgentRun["transaction"]>;
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
  const candidatePrepared = transaction.events.some(
    (event) => event.status === "executing" || event.status === "validating",
  );

  return (
    <section className="judge-proof-summary" aria-label="Judge proof summary">
      <header>
        <div>
          <span className="eyebrow">End-to-end proof</span>
          <h4>
            {promoted
              ? "Proof complete: only the validated future became reality"
              : terminal
                ? "Promotion blocked: Canonical State stayed protected"
                : "Real transaction in progress"}
          </h4>
        </div>
        <span className={promoted ? "proof-verdict passed" : "proof-verdict"}>
          {promoted ? "Verified" : terminal ? "Protected" : "Running"}
        </span>
      </header>
      <ol>
        <li data-state={candidatePrepared || terminal ? "passed" : "active"}>
          <span>{candidatePrepared || terminal ? "✓" : "1"}</span>
          <div>
            <strong>Candidate isolated</strong>
            <small>Real Codex received Candidate State, never mutable Canonical State.</small>
          </div>
        </li>
        <li data-state={promoted ? "passed" : terminal ? "blocked" : "active"}>
          <span>{promoted ? "✓" : "2"}</span>
          <div>
            <strong>Outcome Contract enforced</strong>
            <small>
              {requiredValidations.length === 0
                ? "Required Validation evidence is pending."
                : `${passedRequired}/${requiredValidations.length} required Validations passed.`}
            </small>
          </div>
        </li>
        <li data-state={promoted ? "passed" : terminal ? "blocked" : "pending"}>
          <span>{promoted ? "✓" : "3"}</span>
          <div>
            <strong>{promoted ? "Canonical State advanced" : "Promotion decision"}</strong>
            <small>
              {promoted
                ? `${shortHash(transaction.canonicalContentHashBefore)} to ${shortHash(transaction.canonicalContentHashAfter)}.`
                : terminal
                  ? "The prior Canonical fingerprint remains authoritative."
                  : "Promotion remains impossible until every required Validation passes."}
            </small>
          </div>
        </li>
      </ol>
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

function ReceiptVerifier({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<PortableVerificationReport | null>(null);
  const [packetReport, setPacketReport] =
    useState<PortableEvidencePacketVerificationReport | null>(null);
  const [chainReport, setChainReport] =
    useState<PortableDecisionChainVerificationReport | null>(null);
  const [decisionChain, setDecisionChain] =
    useState<PortableDecisionChain | null>(null);
  const [envelope, setEnvelope] = useState<PortablePromotionEnvelope | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trustPolicySource, setTrustPolicySource] = useState<string | null>(null);
  const [trustPolicyReport, setTrustPolicyReport] =
    useState<TrustPolicyVerificationReport | null>(null);
  const [authorityFingerprint, setAuthorityFingerprint] = useState("");
  const [authorityRotationSource, setAuthorityRotationSource] =
    useState<string | null>(null);
  const [authorityRotationReport, setAuthorityRotationReport] =
    useState<PolicyAuthorityRotationVerificationReport | null>(null);
  const [authorityRotationFilename, setAuthorityRotationFilename] =
    useState<string | null>(null);
  const [authorityRotationError, setAuthorityRotationError] =
    useState<string | null>(null);
  const [trustPolicyFilename, setTrustPolicyFilename] = useState<string | null>(null);
  const [trustPolicyError, setTrustPolicyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

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
    setFilename(file.name);
    setReport(null);
    setPacketReport(null);
    setChainReport(null);
    setDecisionChain(null);
    setEnvelope(null);
    setError(null);
    if (file.size < 1 || file.size > 4_194_304) {
      setError("Choose a non-empty receipt, evidence packet, or decision chain no larger than 4 MB.");
      return;
    }
    setBusy(true);
    try {
      const source = await file.text();
      const parsed = JSON.parse(source) as { schema?: unknown };
      if (parsed.schema === "agent-airlock/portable-decision-chain") {
        const nextChainReport =
          await verifyPortableDecisionChainJsonInBrowser(source);
        const chain = parsed as PortableDecisionChain;
        const leafPacket = chain.packets.at(-1);
        const leafPacketReport = nextChainReport.packets.at(-1) ?? null;
        setChainReport(nextChainReport);
        setDecisionChain(chain);
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
        if (nextPacketReport.valid) {
          setEnvelope((parsed as PortableEvidencePacket).envelope);
        }
      } else {
        const nextReport = await verifyPortablePromotionEnvelopeJsonInBrowser(source);
        setReport(nextReport);
        if (nextReport.valid) {
          setEnvelope(parsed as PortablePromotionEnvelope);
        }
      }
    } catch {
      setError("The browser could not read this receipt file.");
    } finally {
      setBusy(false);
    }
  };

  const importTrustPolicy = async (file: File | undefined) => {
    if (!file) return;
    setTrustPolicyFilename(file.name);
    setTrustPolicySource(null);
    setTrustPolicyReport(null);
    setTrustPolicyError(null);
    if (file.size < 1 || file.size > 131_072) {
      setTrustPolicyError("Choose a non-empty signed trust policy no larger than 128 KB.");
      return;
    }
    try {
      setTrustPolicySource(await file.text());
    } catch (reason) {
      setTrustPolicyError(
        reason instanceof Error ? reason.message : "The trust policy is invalid.",
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
      ? (decisionChain?.packets.map((packet) => packet.envelope) ?? [envelope]).map(
          (candidateEnvelope) =>
            evaluateSigningKeyTrust(candidateEnvelope, trustPolicyReport.policy!, {
              cryptographicValid: evidenceValid,
            }),
        )
      : [];
  const failedOrganizationalTrust = organizationalTrustEvaluations.find(
    (evaluation) => !evaluation.trusted,
  );
  const organizationalTrust = organizationalTrustEvaluations.length > 0
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

  return (
    <div className="modal-backdrop verifier-backdrop" onMouseDown={onClose}>
      <section
        className="receipt-verifier"
        role="dialog"
        aria-modal="true"
        aria-labelledby="receipt-verifier-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="receipt-verifier-heading">
          <div>
            <span className="eyebrow">Independent verifier</span>
            <h2 id="receipt-verifier-title">Verify trust without trusting this server</h2>
            <p>
              Your file stays in this browser. Web Crypto checks the canonical SHA-256
              digest, Ed25519 signature, included key identity, disclosed Merkle proofs,
              complete Repair lineage, transparency inclusion, and digest-only calldata
              when present.
            </p>
          </div>
          <button type="button" aria-label="Close receipt verifier" onClick={onClose}>×</button>
        </header>

        <div className="verifier-boundary" role="note">
          <span>LOCAL ONLY</span>
          <strong>0 API calls · 0 uploads · 4 MB hard limit</strong>
        </div>

        <label className="receipt-dropzone" data-loaded={filename !== null}>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => void verifyFile(event.target.files?.[0])}
          />
          <span aria-hidden="true">⌁</span>
          <strong>{filename ?? "Choose a receipt, packet, or decision chain"}</strong>
          <small>
            {busy ? "Verifying locally…" : "Select an exported Agent Airlock JSON file"}
          </small>
        </label>

        {error && <div className="verifier-error" role="alert">{error}</div>}

        {report && (
          <div className="verifier-report" data-valid={evidenceValid}>
            <div className="verifier-verdict">
              <span aria-hidden="true">{evidenceValid ? "✓" : "!"}</span>
              <div>
                <strong>{evidenceValid ? "Cryptographic proof valid" : "Verification failed"}</strong>
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

            <div className="verifier-checks" aria-label="Receipt verification checks">
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
              <section className="verifier-packet" aria-label="Evidence packet checks">
                <div>
                  <span className="eyebrow">Evidence packet</span>
                  <strong>
                    {packetReport.valid
                      ? "Every included proof matches"
                      : "Bundled proof mismatch"}
                  </strong>
                  <small>
                    Optional proofs are never silently ignored. Any included invalid proof
                    rejects the packet.
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

            {chainReport && (
              <section className="verifier-packet" aria-label="Decision chain checks">
                <div>
                  <span className="eyebrow">Complete decision chain</span>
                  <strong>
                    {chainReport.valid
                      ? `${chainReport.packets.length} signed decisions linked`
                      : "Decision chain broken"}
                  </strong>
                  <small>
                    The browser independently checks every receipt, exact parent digest,
                    lineage depth, and Canonical State handoff from root to leaf.
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
                      This receipt names its parent Run and prior receipt digest. Import
                      the parent receipt separately to validate the complete chain.
                    </small>
                  </div>
                  <dl>
                    <div>
                      <dt>Depth</dt>
                      <dd>{envelope.receipt.ancestry.depth}</dd>
                    </div>
                    <div>
                      <dt>Parent Run</dt>
                      <dd><code>{envelope.receipt.ancestry.parentRunId}</code></dd>
                    </div>
                    <div>
                      <dt>Prior receipt</dt>
                      <dd>
                        <code>
                          {envelope.receipt.ancestry.previousReceiptDigest ?? "unavailable"}
                        </code>
                      </dd>
                    </div>
                  </dl>
                </section>
              )}

            {evidenceValid && (
              <section className="verifier-trust-policy" aria-label="Organizational trust policy">
                <div>
                  <span className="eyebrow">Optional second verdict</span>
                  <strong>
                    {decisionChain
                      ? "Does your organization trust every signer in this chain?"
                      : "Does your organization trust this signer?"}
                  </strong>
                  <small>
                    Pin the authority fingerprint received out of band, optionally prove
                    continuity to a rotated key, then import its signed policy. No file can
                    authorize itself.
                  </small>
                </div>
                <div className="verifier-trust-inputs">
                  <label className="verifier-authority-root">
                    <span>Trusted policy authority</span>
                    <input
                      type="text"
                      value={authorityFingerprint}
                      onChange={(event) => setAuthorityFingerprint(event.target.value)}
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
                      {authorityRotationFilename ?? "Optional authority rotation"}
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
                      onChange={(event) => void importTrustPolicy(event.target.files?.[0])}
                    />
                    <span>{trustPolicyFilename ?? "Import signed policy"}</span>
                  </label>
                </div>
              </section>
            )}

            {trustPolicyError && (
              <div className="verifier-error" role="alert">{trustPolicyError}</div>
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
                    : authorityRotationReport.checks.find((check) => !check.valid)
                        ?.detail}
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
                    : trustPolicyReport.checks.find((check) => !check.valid)?.detail}
                </small>
              </div>
            )}

            {organizationalTrust && (
              <div
                className="verifier-trust-verdict"
                data-trusted={organizationalTrust.trusted}
                role="status"
              >
                <span aria-hidden="true">{organizationalTrust.trusted ? "✓" : "!"}</span>
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
              <section className="verifier-trust-chain" aria-label="Verified trust chain">
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
                    <span>{authorityRotationSource !== null ? "03" : "02"}</span>
                    <strong>Signed policy</strong>
                    <small>
                      {trustPolicyReport.valid ? "Authority verified" : "Rejected"}
                    </small>
                  </div>
                  <i aria-hidden="true">→</i>
                  <div
                    className="verifier-chain-node"
                    data-valid={organizationalTrust?.trusted === true}
                  >
                    <span>{authorityRotationSource !== null ? "04" : "03"}</span>
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
                {report.unsupportedClaims.map((claim) => <li key={claim}>{claim}</li>)}
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
  onError,
}: {
  runId: string;
  evidenceRevision: string;
  judgeProofMode?: boolean;
  onError: (message: string) => void;
}) {
  const [result, setResult] = useState<PortableReceiptExport | null>(null);
  const [availableDisclosures, setAvailableDisclosures] = useState<
    PortableReceiptExport["availableDisclosures"]
  >([]);
  const [selectedDisclosures, setSelectedDisclosures] = useState<string[]>([]);
  const [localAnchor, setLocalAnchor] = useState(false);
  const [evmPayload, setEvmPayload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const requestGeneration = useRef(0);

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
      if (requestGeneration.current !== generation) return;
      setResult(exported);
      setAvailableDisclosures(exported.availableDisclosures);
      setDirty(false);
    } catch (reason) {
      if (requestGeneration.current === generation) {
        onError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (requestGeneration.current === generation) setBusy(false);
    }
  };

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
              Lets cooperating observers retain checkpoints and detect later log rewrites.
              Receipt validity never depends on it.
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
              For mutually distrusting organizations that need shared publication evidence.
              No chain call, wallet, RPC, or funds are used.
            </small>
          </span>
        </label>
      </div>
      <p className="portable-trust-levels">
        A signature is sufficient for ordinary offline verification. A retained checkpoint
        adds rewrite detection, while a public anchor only adds shared publication evidence.
        Neither makes a false statement true or grants the signer authority.
      </p>
    </>
  );

  return (
    <section className="portable-trust" aria-label="Portable trust receipt">
      <header className="portable-trust-heading">
        <div>
          <span className="eyebrow">
            {judgeProofMode ? "Independent proof" : "Portable Trust"}
          </span>
          <h4>
            {judgeProofMode
              ? "Make this decision independently verifiable"
              : "Export a signed decision statement"}
          </h4>
          <p>
            {judgeProofMode
              ? "Generate a private-by-default evidence packet and verify its signature locally before download."
              : "Offline verification proves that the included Ed25519 key signed the canonical content. It proves key possession, not that the reported state existed or was reported truthfully."}
          </p>
          {!judgeProofMode && (
            <p>
              Always included: stable Run and Agent identifiers, timestamps, state and resource
              fingerprints, and evidence hashes. Raw prompts, outputs, credentials, and local
              paths always stay out. Only bounded redacted Validation leaves are opt-in.
            </p>
          )}
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={() => void generate()}
          disabled={busy}
        >
          {busy
            ? <Spinner />
            : result
              ? judgeProofMode
                ? "Regenerate proof"
                : "Regenerate receipt"
              : judgeProofMode
                ? "Generate and verify proof"
                : "Generate receipt"}
        </button>
      </header>

      {judgeProofMode ? (
        <details className="portable-advanced-options">
          <summary>Add transparency or blockchain publication evidence</summary>
          {optionalPublicationControls}
        </details>
      ) : optionalPublicationControls}

      {availableDisclosures.length > 0 && (
        <details className="portable-disclosures">
          <summary>
            Selectively disclose Validation evidence ({selectedDisclosures.length}/
            {availableDisclosures.length})
          </summary>
          <p>
            The signed Merkle root commits to every leaf. Only selected leaves and their
            inclusion proofs enter the downloaded envelope.
          </p>
          <div>
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
                    {disclosure.status} {disclosure.required ? "required" : "optional"}
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
            <span aria-hidden="true">{result.verification.valid ? "✓" : "!"}</span>
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
                  : result.decisionChain && result.decisionChain.packets.length > 1
                    ? `One complete chain proves all ${result.decisionChain.packets.length} signed decisions and their Canonical State handoffs.`
                  : result.anchor && result.evmPayload
                    ? "One packet contains the signed receipt, checkpoint proof, and digest-only EVM calldata."
                    : result.anchor
                      ? "One packet contains the signed receipt and checkpoint proof."
                      : result.evmPayload
                        ? "One packet contains the signed receipt and digest-only EVM calldata."
                        : "One packet contains the signed receipt for independent offline verification."}
              </small>
            </div>
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
            <button
              type="button"
              className={`button ${result.decisionChain && result.decisionChain.packets.length > 1 ? "button-ghost" : "button-primary"}`}
              onClick={() =>
                downloadJson(
                  result.packet,
                  `agent-airlock-evidence-${runId}.json`,
                )
              }
              disabled={dirty || !result.verification.valid}
            >
              Download evidence packet
            </button>
            {result.decisionChain && result.decisionChain.packets.length > 1 && (
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
                Download complete decision chain
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
                    Local checkpoint {result.anchor.checkpoint.checkpoint.treeSize} ·{" "}
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
            Deterministic suggestions use bounded Run evidence and simulate history without reopening Candidate State.
          </p>
        </div>
        <button className="button button-primary" onClick={onDerive} disabled={busy}>
          {busy ? <Spinner /> : "Scan retained evidence"}
        </button>
      </header>
      {proposals.length === 0 ? (
        <div className="assurance-empty">
          No proposal is ready. Three independent supporting lineages are required for the first rules.
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
                    result.counterfactualDisposition !== result.priorDisposition,
                )
                .map((result) => result.runId),
            ).size;
            const unknown = proposal.simulation.results.filter(
              (result) => result.classification === "unknown",
            ).length;
            return (
              <article className="assurance-card" key={proposal.id} data-state={proposal.state}>
                <div className="assurance-card-title">
                  <div>
                    <span className={"assurance-state assurance-state-" + proposal.state}>
                      {proposal.state}
                    </span>
                    <strong>Proposal against Outcome Contract v{proposal.baseContractVersion}</strong>
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
                  <div><strong>{new Set(proposal.citations.map((item) => item.rootRunId)).size}</strong><span>supporting lineages</span></div>
                  <div><strong>{exactChanges}</strong><span>historical outcomes changed</span></div>
                  <div><strong>{unknown}</strong><span>unknown, never guessed</span></div>
                </div>
                <details className="assurance-proof">
                  <summary>Inspect citations and simulation proof</summary>
                  <section aria-label="Proposal citations">
                    {proposal.citations.map((citation) => (
                      <p key={citation.operationKey + citation.runId}>
                        <code>{citation.runId}</code>
                        <span>{citation.evidenceSelector}</span>
                        <small>{shortHash(citation.evidenceHash)} · {citation.derivationRule}</small>
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
                    Simulation {proposal.simulation.engineVersion} · {proposal.simulation.results.length} bounded results · {shortHash(proposal.simulation.digest)}
                  </footer>
                </details>
                {proposal.decision && (
                  <p className="assurance-decision">
                    {proposal.decision.action} {formatTime(proposal.decision.decidedAt)}
                    {proposal.decision.reason ? " · " + proposal.decision.reason : ""}
                  </p>
                )}
                {proposal.state === "ready" && (
                  <footer className="assurance-actions">
                    <button className="button button-ghost" onClick={() => onReject(proposal)} disabled={busy}>
                      Reject
                    </button>
                    <button className="button button-primary" onClick={() => onAccept(proposal)} disabled={busy}>
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
        (candidateSet.phase === "recovery-error" || candidateSet.phase === "stale"
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
          <span>{candidateSet.competitors.length} siblings · {candidateSet.maxConcurrency} concurrent</span>
        </div>
      </header>

      <div className="candidate-source-proof">
        <div>
          <span>Shared immutable source</span>
          <code>{shortHash(candidateSet.source.contentHash)}</code>
        </div>
        <div>
          <span>Snapshotted policy</span>
          <strong>Outcome Contract v{candidateSet.outcomeContract.version}</strong>
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
                  <span>{score?.rank ? "Rank " + score.rank : "Candidate"}</span>
                  <strong>{competitor.id}</strong>
                </div>
                <span className={"candidate-status candidate-status-" + competitor.status}>
                  {isWinner ? "winner" : competitor.status}
                </span>
              </header>
              <p>{competitor.strategyInstruction}</p>
              {score?.eligible ? (
                <div className="candidate-score-list">
                  {score.components.map((component) => (
                    <div key={component.kind}>
                      <span>
                        {component.kind.replaceAll("-", " ")} · {component.direction}
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
                  <span className="pulse" /> Required Validations and scores are pending
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
                ? candidateSet.selectionDecision.winnerCompetitorId + " selected"
                : "No eligible Candidate"}
            </strong>
            <p>Lexicographic normalized scores, then ascending competitor ID.</p>
          </div>
          <code className="selection-digest">
            {candidateSet.selectionDecision.decisionDigest}
          </code>
        </footer>
      )}
      {candidateSet.recoveryError && (
        <p className="candidate-set-error" role="alert">{candidateSet.recoveryError}</p>
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
          {candidateSet.cancellationRequested ? "Cancellation requested" : "Cancel exploration"}
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
  onPortableError,
}: {
  run: AgentRun;
  actionBusy: boolean;
  onRepair: () => void;
  onDiscard: () => void;
  portableTrustAvailable: boolean;
  judgeProofMode: boolean;
  onPortableError: (message: string) => void;
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
  const compactJudgeEvidence = judgeProofMode && disposition === "promoted";
  const title =
    recoveryFailed
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
  const outcome =
    recoveryFailed
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

      {judgeProofMode && <JudgeProofSummary transaction={transaction} />}

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
        {disposition === "quarantined" &&
          providerRepairUnavailable && (
            <p className="repair-limit" role="status">
              A provider retained this Candidate for cleanup only. Discard it after the
              provider recovers.
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
                (transaction.recovery.recoveryError ? " journal-proof-error" : "")
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
                  "Phase " + transaction.recovery.journalPhase.replaceAll("-", " ")}
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
              : "advanced from " + shortHash(transaction.canonicalContentHashBefore)}
          </small>
        </div>
        <div>
          <span>Changed files</span>
          <strong>{transaction.changes?.totalChangedFiles ?? "pending"}</strong>
          <small>{formatBytes(transaction.changes?.totalAddedBytes ?? 0)} changed payload</small>
        </div>
        <div>
          <span>Validation result</span>
          <strong>
            {transaction.validations.filter((item) => item.status === "passed").length}/
            {transaction.validations.length || "pending"}
          </strong>
          <small>required failures block Promotion</small>
        </div>
      </div>

      {transaction.resources.length > 0 && (
        <section className="resource-ledger" aria-label="Transactional resources">
          <div className="resource-ledger-heading">
            <h4>Whole-Agent state</h4>
            <span>one decision across {transaction.resources.length} resources</span>
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
              const providerEvents = transaction.providerResourceEvents.filter(
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
                      <span className="provider-kind">{resource.resourceKind}</span>
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
                    <span>{resource.required ? "required-v1" : "optional"}</span>
                    <span>{resource.capabilities.isolation}</span>
                    <span>{resource.capabilities.promotionVisibility}</span>
                    <span>{resource.capabilities.runtimeAccess}</span>
                    <span>{resource.capabilities.reconciliation}</span>
                  </div>
                  <p>{resource.summary}</p>
                  <p className={degraded ? "provider-caveat degraded" : "provider-caveat"}>
                    {degraded
                      ? "This provider declares degraded guarantees and cannot silently claim all-or-nothing Promotion."
                      : "Canonical manifest acceptance is authoritative; distributed atomic commit is not claimed."}
                  </p>
                  <details>
                    <summary>
                      Inspect {resource.validations.length} Validation
                      {resource.validations.length === 1 ? "" : "s"} and {providerEvents.length}
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
                              <strong>{validation.status}</strong> {validation.name} -{" "}
                              {validation.summary}
                            </p>
                          ))
                        )}
                      </div>
                      <div>
                        <span className="eyebrow">Lifecycle evidence</span>
                        {providerEvents.map((event, index) => (
                          <p key={event.stage + event.at + index}>
                            <strong>{event.status}</strong> {event.stage} - {event.summary}
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

      {(transaction.sqlite || transaction.externalActions.intents.length > 0) && (
        <section className="multi-resource-disposition" aria-label="Data and effects evidence">
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
              <code>{shortHash(transaction.sqlite?.after?.contentHash ?? null)}</code>
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
              <strong>{transaction.externalActions.deliveredCount} delivered</strong>
              <span>{transaction.externalActions.intents.length} requested</span>
            </div>
            <p>
              Effects are claimed only after the Canonical manifest advances.
            </p>
            {transaction.externalActions.intents.length === 0 ? (
              <div className="effect-row"><span>No intent requested</span></div>
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
            <p className="evidence-empty">Validations begin after Runtime execution.</p>
          ) : (
            <ul className="validation-list">
              {transaction.validations.map((validation) => (
                <li key={validation.name} className={"validation-" + validation.status}>
                  <span className="validation-icon">
                    {validation.status === "passed" ? "✓" : "!"}
                  </span>
                  <div>
                    <div className="validation-name">
                      <strong>{validation.name}</strong>
                      <span>{validation.required ? "required" : "optional"}</span>
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
                <span className={"change-kind change-" + change.kind}>{change.kind}</span>
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
            <code>{shortHash(transaction.promotionReceipt.validationEvidenceHash)}</code>
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
              onError={onPortableError}
            />
          )}
        </>
      )}
    </article>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showReceiptVerifier, setShowReceiptVerifier] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [activeCandidateSet, setActiveCandidateSet] = useState<CandidateSet | null>(null);
  const [assuranceProposals, setAssuranceProposals] = useState<AssuranceProposal[]>([]);
  const [contractVersions, setContractVersions] = useState<
    OutcomeContractVersionRecord[]
  >([]);
  const [showAssurance, setShowAssurance] = useState(false);
  const [showExplore, setShowExplore] = useState(false);
  const [explorationObjective, setExplorationObjective] = useState(
    defaultExplorationObjective,
  );
  const [loserPolicy, setLoserPolicy] = useState<"retain" | "discard">("retain");
  const [airlockActionBusy, setAirlockActionBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const pollingCandidateSetIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
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
    !["completed", "stale", "recovery-error"].includes(activeCandidateSet.phase);
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
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setActiveCandidateSet(null);
    setShowExplore(false);
    setShowAssurance(false);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
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
      .then(([, result, candidateSetsResult, assuranceResult, versionsResult]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs.find((run) => !run.candidateSetId) ?? null;
        setActiveRun(latest);
        const latestCandidateSet = candidateSetsResult.candidateSets[0] ?? null;
        setActiveCandidateSet(latestCandidateSet);
        setAssuranceProposals(assuranceResult.proposals);
        setContractVersions(versionsResult.versions);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
        if (
          latestCandidateSet &&
          !["completed", "stale", "recovery-error"].includes(
            latestCandidateSet.phase,
          )
        ) {
          void pollCandidateSet(latestCandidateSet.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

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
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
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

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
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
        if (["completed", "stale", "recovery-error"].includes(result.candidateSet.phase)) {
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
    const changes = proposal.operations.map(assuranceOperationLabel).join("\n- ");
    if (
      !window.confirm(
        "Accept this monotonic policy change for future Runs only?\n\n- " + changes,
      )
    ) {
      return;
    }
    const reason = window.prompt("Record an operator reason for acceptance:", "Reviewed bounded evidence") ?? "";
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
    const reason = window.prompt("Why reject this proposal?", "Needs more context");
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
              candidate.name === rule.name && candidate.pattern === rule.pattern,
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
        ? "changed files " + current.maxChangedFiles + " to " + target.contract.maxChangedFiles
        : null,
      target.contract.maxAddedBytes > current.maxAddedBytes
        ? "added bytes " + formatBytes(current.maxAddedBytes) + " to " + formatBytes(target.contract.maxAddedBytes)
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
      raisedLimits.length ? "Limits raised: " + raisedLimits.join(", ") : "No limits raised.",
      "A new version will be created. Historical contracts and receipts remain unchanged.",
    ].join("\n");
    if (!window.confirm("Roll back rule content from version " + target.contract.version + "?\n\n" + warning)) {
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

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const repairActiveRun = async () => {
    if (!selected || !activeRun) return;
    setAirlockActionBusy(true);
    setError(null);
    try {
      const result = await api.repairRun(activeRun.id);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshAgents();
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
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
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
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.demoMode
                ? "Free local proof · no network model"
                : system?.protocolFixtureMode
                  ? "Real Runtime proof · local inference"
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
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
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
                ? "Local Responses fixture · " + (system.containerEngine ?? "container")
              : (system?.arkModel ?? "Ark model not configured") +
                (system?.containerEngine ? " · " + system.containerEngine : "")}
          </span>
        </div>
        {system?.portableTrust.available && (
          <button
            type="button"
            className="button verify-receipt-button"
            onClick={() => setShowReceiptVerifier(true)}
          >
            <span aria-hidden="true">✓</span>
            Verify a receipt
          </button>
        )}
      </aside>

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
            <span>REAL RUNTIME PROOF</span>
            <div>
              <strong>Real Codex CLI in a disposable container</strong>
              <p>Local deterministic Responses fixture. No ModelArk request or paid inference.</p>
            </div>
          </div>
        ) : null}

        {!system?.demoMode &&
        !system?.protocolFixtureMode &&
        system?.arkConfigured &&
        system?.codexAvailable ? (
          <div className="live-mode-banner" role="status">
            <span>LIVE MODELARK</span>
            <div>
              <strong>Provider-backed inference through an isolated Runtime</strong>
              <p>
                Every turn still works in Candidate State until required Validations pass.
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

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
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

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
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
                <section className="contract-overview" aria-label="Outcome Contract summary">
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
                        {selected.outcomeContract.maxChangedFiles} files · {formatBytes(
                          selected.outcomeContract.maxAddedBytes,
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>Safety checks</span>
                      <strong>
                        {selected.outcomeContract.secretPatterns.length} secret patterns · {" "}
                        {selected.outcomeContract.validationCommands.length} commands
                      </strong>
                    </div>
                  </div>
                  <p>
                    Every Run snapshots this version. Required failures enter Quarantine and
                    leave Canonical State unchanged.
                  </p>
                  {contractVersions.length > 1 && (
                    <details className="contract-history">
                      <summary>Version history and rollback</summary>
                      <div>
                        {contractVersions.map((record) => (
                          <div key={record.contract.version}>
                            <span>
                              <strong>v{record.contract.version}</strong>
                              {" · "}{record.provenance}
                            </span>
                            {record.contract.version !== selected.outcomeContract.version && (
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
                (system?.protocolFixtureMode ? " protocol-proof-playground" : "")
              }
            >
              <div className="playground-header">
                <div
                  className={
                    "playground-topbar" +
                    (system?.protocolFixtureMode ? " protocol-proof-topbar" : "")
                  }
                >
                  <div>
                    <span className="eyebrow">Playground</span>
                    <h2>
                      {system?.demoMode
                        ? "Prove one Agent future is safe"
                        : system?.protocolFixtureMode
                          ? "Prove a real Agent change is safe"
                        : "Build something with your Agent"}
                    </h2>
                  </div>
                  <div className="playground-state">
                    {system?.protocolFixtureMode ? (
                      <div className="proof-route" aria-label="Judge proof path">
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
                          onClick={() => setShowAssurance((current) => !current)}
                          aria-expanded={showAssurance}
                          aria-controls="assurance-inbox"
                        >
                          <span aria-hidden="true">⌁</span>
                          Assurance
                          {assuranceProposals.filter((proposal) => proposal.state === "ready").length > 0 && (
                            <strong>
                              {assuranceProposals.filter((proposal) => proposal.state === "ready").length}
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
                    <span className="contract-badge">
                      Outcome Contract v{selected.outcomeContract.version}
                    </span>
                    <div className="session-info">
                      <span className="pulse" />
                      {selected.codexThreadId ? "Session connected" : "New session"}
                    </div>
                  </div>
                </div>

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
                        All three start from the same immutable source and policy.
                        Required Validation controls eligibility, then a deterministic score selects exactly one future for Promotion.
                      </p>
                    </div>
                    <label className="explore-objective">
                      Objective
                      <textarea
                        value={explorationObjective}
                        onChange={(event) => setExplorationObjective(event.target.value)}
                        rows={2}
                        maxLength={4_000}
                        required
                      />
                    </label>
                    <div className="explore-strategies" aria-label="Competing strategies">
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
                            setLoserPolicy(event.target.value as "retain" | "discard")
                          }
                        >
                          <option value="retain">Retain isolated state</option>
                          <option value="discard">Keep proof, discard state</option>
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
                          disabled={!explorationObjective.trim() || demoActionBusy}
                        >
                          {airlockActionBusy ? <Spinner /> : "Run three futures"}
                        </button>
                      </div>
                    </div>
                  </form>
                )}

                {system?.demoMode ? (
                  <section className="demo-guide" aria-label="Four-step demo proof">
                    <div className="demo-guide-heading">
                      <span className="eyebrow">Judge path</span>
                      <p>Stage each prompt, then send it. Repair runs directly from Quarantine.</p>
                    </div>
                    <div className="demo-step-list">
                      {demoHeroSteps.map((step, index) => {
                        const completed = demoStepCompletion[step.id];
                        const prerequisiteMet =
                          index === 0 || demoStepCompletion[demoHeroSteps[index - 1].id];
                        const disabled =
                          demoActionBusy ||
                          completed ||
                          !prerequisiteMet ||
                          (step.id === "repair" && !canRepairActiveFuture);
                        return (
                          <button
                            type="button"
                            className={completed ? "demo-step completed" : "demo-step"}
                            key={step.id}
                            disabled={disabled}
                            aria-label={"Demo step " + (index + 1) + ": " + step.label}
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
              </div>

              <div className="messages">
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
                        : `What should ${selected.name} build?`}
                    </h3>
                    <p>
                      {system?.demoMode
                        ? "This local fixture demonstrates transactional Promotion, Quarantine, Repair, and session continuity without calling a network model."
                        : system?.protocolFixtureMode
                          ? "Real Codex will make a tool call inside an isolated Candidate workspace. Airlock validates the result before it can replace Canonical State."
                        : "Live ModelArk inference can inspect files, write code, and run commands, while Airlock keeps every change isolated until Validation and Promotion."}
                    </p>
                    <div className="prompt-grid">
                      {(system?.demoMode
                        ? Object.values(demoHeroPrompts)
                        : system?.protocolFixtureMode
                          ? protocolFixturePrompts
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
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
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
                    portableTrustAvailable={system?.portableTrust.available === true}
                    judgeProofMode={system?.protocolFixtureMode === true}
                    onPortableError={setError}
                  />
                )}
                {activeCandidateSet && (
                  <CandidateSetEvidence
                    candidateSet={activeCandidateSet}
                    actionBusy={airlockActionBusy}
                    onCancel={() => void cancelCompetingFutures()}
                    portableTrustAvailable={system?.portableTrust.available === true}
                    onPortableError={setError}
                  />
                )}
                <div ref={messageEnd} />
              </div>

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
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      candidateSetInProgress ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
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
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
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
        <ReceiptVerifier onClose={() => setShowReceiptVerifier(false)} />
      )}
    </div>
  );
}
