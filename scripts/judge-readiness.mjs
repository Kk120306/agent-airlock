import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { comparableExactDemoContract } from "./demo-outcome-contract.mjs";
import {
  liveModelArkContract,
  liveModelArkAgentDescription,
  liveModelArkAgentInstructions,
  liveModelArkAgentName,
} from "./modelark-demo-profile.mjs";
import {
  realRuntimeProofAgentDescription,
  realRuntimeProofAgentInstructions,
  realRuntimeProofAgentName,
  realRuntimeProofContract,
} from "./runtime-demo-profile.mjs";

const reportSchema = "agent-airlock/judge-readiness-report";
const supportedModes = new Set(["runtime", "modelark"]);

function readinessCheck(id, label, status, detail) {
  return { id, label, status, detail };
}

function digestReport(mode, checks) {
  const committed = JSON.stringify({
    schema: reportSchema,
    schemaVersion: 1,
    mode,
    checks,
  });
  return "sha256:" + createHash("sha256").update(committed).digest("hex");
}

function completeReport(mode, checks) {
  return {
    schema: reportSchema,
    schemaVersion: 1,
    mode,
    ready: checks.every((item) => item.status === "pass"),
    checks,
    evidenceDigest: digestReport(mode, checks),
  };
}

export function normalizeLocalDemoUrl(value) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Judge readiness accepts only a plain local HTTP origin");
  }
  return parsed.origin;
}

async function requestJson(baseUrl, pathname, fetchImpl) {
  const response = await fetchImpl(baseUrl + pathname, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Local control-plane request failed");
  return response.json();
}

function detectedMode(system) {
  if (
    system?.protocolFixtureMode === true &&
    system?.modelArkDemoMode === false &&
    system?.inferenceMode === "local-responses-protocol-fixture"
  ) {
    return "runtime";
  }
  if (
    system?.modelArkDemoMode === true &&
    system?.protocolFixtureMode === false &&
    system?.inferenceMode === "modelark"
  ) {
    return "modelark";
  }
  return "unsupported";
}

function expectedAgent(mode) {
  return mode === "runtime"
    ? {
        name: realRuntimeProofAgentName,
        description: realRuntimeProofAgentDescription,
        instructions: realRuntimeProofAgentInstructions,
        contract: realRuntimeProofContract,
      }
    : {
        name: liveModelArkAgentName,
        description: liveModelArkAgentDescription,
        instructions: liveModelArkAgentInstructions,
        contract: liveModelArkContract,
      };
}

export async function inspectJudgeReadiness({
  baseUrl = "http://127.0.0.1:3200",
  expectedMode = null,
  expectedAgentId = null,
  fetchImpl = fetch,
} = {}) {
  const safeBaseUrl = normalizeLocalDemoUrl(baseUrl);
  if (expectedMode !== null && !supportedModes.has(expectedMode)) {
    throw new Error("Judge readiness mode must be runtime or modelark");
  }
  let health;
  let system;
  let agents;
  try {
    [health, system, { agents }] = await Promise.all([
      requestJson(safeBaseUrl, "/api/health", fetchImpl),
      requestJson(safeBaseUrl, "/api/system", fetchImpl),
      requestJson(safeBaseUrl, "/api/agents", fetchImpl),
    ]);
  } catch {
    const mode = expectedMode ?? "runtime";
    return completeReport(mode, [
      readinessCheck(
        "control-plane",
        "Local control plane",
        "fail",
        "The requested local demo origin did not return complete readiness evidence.",
      ),
    ]);
  }

  const mode = detectedMode(system);
  const evaluatedMode = expectedMode ?? (supportedModes.has(mode) ? mode : "runtime");
  const profile = expectedAgent(evaluatedMode);
  const matches = Array.isArray(agents)
    ? agents.filter((agent) => agent?.name === profile.name)
    : [];
  const agent = matches.length === 1 ? matches[0] : null;
  const contract = agent?.outcomeContract;
  const contractMatches =
    contract !== null &&
    typeof contract === "object" &&
    JSON.stringify(comparableExactDemoContract(contract)) ===
      JSON.stringify(profile.contract);
  const profileReady =
    mode === evaluatedMode &&
    (evaluatedMode !== "modelark" ||
      (system?.arkConfigured === true &&
        system?.modelArkPreflight?.generatedAssistantOutput === true &&
        typeof system.modelArkPreflight.checkedAt === "string" &&
        Number.isInteger(system.modelArkPreflight.attemptCount) &&
        system.modelArkPreflight.attemptCount >= 1 &&
        Number.isInteger(system.modelArkPreflight.requestCount) &&
        system.modelArkPreflight.requestCount >=
          system.modelArkPreflight.attemptCount));
  const runtimeReady =
    system?.runtimeProvider === "container" &&
    system?.codexAvailable === true &&
    typeof system?.containerEngine === "string" &&
    system.containerEngine.length > 0;
  const trustReady =
    system?.portableTrust?.available === true &&
    system.portableTrust.signatureAlgorithm === "Ed25519" &&
    system.portableTrust.verification === "offline-self-contained" &&
    system.portableTrust.networkRequired === false;
  const identityReady =
    agent !== null &&
    (expectedAgentId === null || agent.id === expectedAgentId) &&
    agent.description === profile.description &&
    agent.instructions === profile.instructions;
  const lifecycleReady = agent?.status === "ready";

  return completeReport(evaluatedMode, [
    readinessCheck(
      "control-plane",
      "Local control plane",
      health?.ok === true ? "pass" : "fail",
      health?.ok === true
        ? "The local health boundary responded successfully."
        : "The local health boundary did not report ready.",
    ),
    readinessCheck(
      "demo-profile",
      "Judge demo profile",
      profileReady ? "pass" : "fail",
      profileReady
        ? evaluatedMode === "runtime"
          ? "The no-cost real Runtime proof profile is active."
          : `The credentialed ModelArk proof profile is active after a provider preflight generated assistant output in ${system.modelArkPreflight.requestCount} bounded request${system.modelArkPreflight.requestCount === 1 ? "" : "s"}.`
        : "The active server does not match the requested judge proof profile.",
    ),
    readinessCheck(
      "container-runtime",
      "Disposable Codex Runtime",
      runtimeReady ? "pass" : "fail",
      runtimeReady
        ? "Real Codex is available through the configured disposable container engine."
        : "The container Runtime or Codex availability proof is incomplete.",
    ),
    readinessCheck(
      "portable-trust",
      "Portable trust",
      trustReady ? "pass" : "fail",
      trustReady
        ? "Ed25519 receipts support self-contained offline verification without network access."
        : "The expected portable receipt verification profile is unavailable.",
    ),
    readinessCheck(
      "managed-agent",
      "Managed proof Agent",
      identityReady ? "pass" : "fail",
      identityReady
        ? "Exactly one launcher-managed proof Agent has the expected identity."
        : "The launcher-managed proof Agent is missing, duplicated, or changed.",
    ),
    readinessCheck(
      "outcome-contract",
      "Outcome Contract",
      contractMatches ? "pass" : "fail",
      contractMatches
        ? "The exact paths, resource limits, secret policy, and required state Validation are installed."
        : "The managed Outcome Contract no longer matches the guaranteed judge path.",
    ),
    readinessCheck(
      "agent-lifecycle",
      "Agent lifecycle",
      lifecycleReady ? "pass" : "fail",
      lifecycleReady
        ? "The proof Agent is ready to accept the first Candidate Run."
        : "The proof Agent must be returned to ready state before judging.",
    ),
  ]);
}

export function assertJudgeReadiness(report) {
  if (report.ready) return report;
  const failed = report.checks
    .filter((item) => item.status !== "pass")
    .map((item) => item.label)
    .join(", ");
  throw new Error("Judge readiness failed: " + (failed || "unknown check"));
}

export function renderJudgeReadiness(report) {
  for (const item of report.checks) {
    console.log(`[${item.status === "pass" ? "PASS" : "FAIL"}] ${item.label}: ${item.detail}`);
  }
  console.log("Readiness evidence: " + report.evidenceDigest);
  console.log(
    report.ready
      ? `[READY] ${report.checks.length}/${report.checks.length} judge-path checks passed.`
      : "[NOT READY] Fix failed checks before beginning the demo.",
  );
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const urlArgument = args.find((argument) => argument.startsWith("--url="));
  const modeArgument = args.find((argument) => argument.startsWith("--mode="));
  const unknown = args.filter(
    (argument) =>
      argument !== "--json" &&
      !argument.startsWith("--url=") &&
      !argument.startsWith("--mode="),
  );
  if (unknown.length > 0) {
    throw new Error("Unknown judge readiness option: " + unknown.join(", "));
  }
  const report = await inspectJudgeReadiness({
    baseUrl: urlArgument?.slice("--url=".length) || "http://127.0.0.1:3200",
    expectedMode: modeArgument?.slice("--mode=".length) || null,
  });
  if (json) console.log(JSON.stringify(report, null, 2));
  else renderJudgeReadiness(report);
  if (!report.ready) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
