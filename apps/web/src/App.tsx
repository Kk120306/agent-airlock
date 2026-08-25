import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentRun, Message, SystemInfo } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

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
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

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

function AirlockEvidence({
  run,
  actionBusy,
  onRepair,
  onDiscard,
}: {
  run: AgentRun;
  actionBusy: boolean;
  onRepair: () => void;
  onDiscard: () => void;
}) {
  const transaction = run.transaction;
  if (!transaction) return null;
  const disposition = transaction.disposition ?? transaction.status;
  const recoveryFailed = transaction.status === "recovery-error";
  const visualDisposition = recoveryFailed ? "recovery-error" : disposition;
  const decisiveValidation = transaction.validations.find(
    (validation) => validation.required && validation.status !== "passed",
  );
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
      className={"airlock-card airlock-" + visualDisposition}
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
                actionBusy || transaction.lineage.depth >= transaction.lineage.maxDepth
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

      {transaction.promotionReceipt && (
        <footer className="receipt-row">
          <span>Promotion Receipt</span>
          <code>{shortHash(transaction.promotionReceipt.validationEvidenceHash)}</code>
          <small>{transaction.promotionReceipt.disposition}</small>
        </footer>
      )}
    </article>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [airlockActionBusy, setAirlockActionBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
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
  const demoActionBusy =
    busy || airlockActionBusy || selected?.status === "busy" || runInProgress;
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
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
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
    if (messages.length > 0 || activeRun) {
      messageEnd.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, activeRun]);

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
              : (system?.arkModel ?? "Ark model not configured") +
                (system?.containerEngine ? " · " + system.containerEngine : "")}
          </span>
        </div>
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
                </section>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-header">
                <div className="playground-topbar">
                  <div>
                    <span className="eyebrow">Playground</span>
                    <h2>
                      {system?.demoMode
                        ? "Prove one Agent future is safe"
                        : "Build something with your Agent"}
                    </h2>
                  </div>
                  <div className="playground-state">
                    <span className="contract-badge">
                      Outcome Contract v{selected.outcomeContract.version}
                    </span>
                    <div className="session-info">
                      <span className="pulse" />
                      {selected.codexThreadId ? "Session connected" : "New session"}
                    </div>
                  </div>
                </div>

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
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>
                      {system?.demoMode
                        ? "Start with the safe multi-resource release"
                        : `What should ${selected.name} build?`}
                    </h3>
                    <p>
                      {system?.demoMode
                        ? "This local fixture demonstrates transactional Promotion, Quarantine, Repair, and session continuity without calling a network model."
                        : "The Agent can inspect files, write code, run commands, and continue the same Codex session across messages."}
                    </p>
                    <div className="prompt-grid">
                      {(system?.demoMode ? Object.values(demoHeroPrompts) : starterPrompts).map(
                        (item) => (
                          <button key={item} onClick={() => setPrompt(item)}>
                            <span>↗</span>
                            {item}
                          </button>
                        ),
                      )}
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
    </div>
  );
}
