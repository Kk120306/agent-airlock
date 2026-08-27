import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type {
  Agent,
  AgentRun,
  OutcomeContract,
  RunTransaction,
  SystemInfo,
} from "../../apps/web/src/types.js";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const webDist = path.join(projectRoot, "apps/web/dist");
const timestamp = "2026-08-26T00:00:00.000Z";
const contract: OutcomeContract = {
  schemaVersion: 1,
  version: 1,
  requiredPaths: ["AGENTS.md", "README.md"],
  protectedPaths: ["AGENTS.md"],
  maxChangedFiles: 200,
  maxAddedBytes: 2_097_152,
  secretPatterns: [],
  validationCommands: [],
  createdAt: timestamp,
};
const agent: Agent = {
  id: "agent-phase-eight-ui",
  name: "Provider evidence",
  description: "A production-bundle provider evidence fixture",
  instructions: "Remain inside Candidate State.",
  status: "ready",
  workspacePath: "/bounded/canonical/workspace",
  canonicalStateId: "state-after",
  outcomeContract: contract,
  codexThreadId: "thread-provider",
  lastError: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const system: SystemInfo = {
  demoMode: false,
  protocolFixtureMode: false,
  inferenceMode: "modelark",
  arkConfigured: true,
  arkBaseUrl: "http://127.0.0.1:1/api/v3",
  arkModel: "local-ui-contract",
  codexAvailable: true,
  codexSandboxMode: "workspace-write",
  competingFutures: {
    available: false,
    tokenBudgetEnforcement: "unsupported",
    reason: "The configured Runner cannot enforce total-token allowances before or at inference",
  },
  portableTrust: {
    available: true,
    receiptSchema: "agent-airlock/portable-promotion-receipt@1",
    signatureAlgorithm: "Ed25519",
    verification: "offline-self-contained",
    evidenceDisclosure: "selective-merkle-proof",
    localTransparency: "optional",
    evmPayload: "offline-digest-only",
    networkRequired: false,
  },
  runtimeProvider: "local-process",
  containerEngine: null,
  runtime: "Production bundle UI contract",
};

test("the production bundle renders exact provider Promotion guarantees", async ({
  page,
}) => {
  await serveProductionBundle(page, runWithProvider("promoted"));
  await page.goto("http://airlock.local/");

  const evidence = page.getByRole("article", { name: "Agent Airlock evidence" });
  await expect(evidence.getByRole("heading", { name: "Promoted" })).toBeVisible();
  const panel = evidence.getByRole("region", {
    name: "Registered Transactional Resources",
  });
  await expect(panel.getByText("Remote versioned object")).toBeVisible();
  await expect(panel.getByText("http-object", { exact: true })).toBeVisible();
  await expect(panel.getByText("required-v1", { exact: true })).toBeVisible();
  await expect(panel.getByText("canonical-manifest", { exact: true })).toBeVisible();
  await expect(panel.getByText("forward", { exact: true })).toBeVisible();
  await expect(panel.getByText("promoted", { exact: true })).toBeVisible();
  await expect(
    panel.getByText(
      "Canonical manifest acceptance is authoritative; distributed atomic commit is not claimed.",
    ),
  ).toBeVisible();

  await panel.getByText(/Inspect 1 Validation and 6 lifecycle events/).click();
  await expect(panel.getByText("passed bounded-json-object")).toBeVisible();
  await expect(panel.getByText("passed reconcile")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("the provider evidence disables impossible Repair after preparation cleanup failure", async ({
  page,
}) => {
  await serveProductionBundle(page, runWithProvider("cleanup-only"));
  await page.goto("http://airlock.local/");

  const evidence = page.getByRole("article", { name: "Agent Airlock evidence" });
  await expect(evidence.getByRole("heading", { name: "Quarantined" })).toBeVisible();
  await expect(evidence.getByRole("button", { name: "Repair this future" })).toBeDisabled();
  await expect(
    evidence.getByText(
      "A provider retained this Candidate for cleanup only. Discard it after the provider recovers.",
    ),
  ).toBeVisible();
  await expect(evidence.getByRole("button", { name: "Discard Quarantine" })).toBeEnabled();
});

async function serveProductionBundle(page: Page, run: AgentRun): Promise<void> {
  await page.route("http://airlock.local/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      await route.fulfill({
        contentType: "text/html",
        body: await readFile(path.join(webDist, "index.html"), "utf8"),
      });
      return;
    }
    if (url.pathname.startsWith("/assets/")) {
      await route.fulfill({ path: path.join(webDist, url.pathname) });
      return;
    }
    const response = apiResponse(url.pathname, run);
    if (response) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(response),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not found" });
  });
}

function apiResponse(pathname: string, run: AgentRun): unknown {
  if (pathname === "/api/auth") return { required: false };
  if (pathname === "/api/system") return system;
  if (pathname === "/api/agents") return { agents: [agent] };
  if (pathname.endsWith("/messages")) return { messages: [] };
  if (pathname.endsWith("/candidate-sets")) return { candidateSets: [] };
  if (pathname.endsWith("/runs")) return { runs: [run] };
  if (pathname.endsWith("/assurance-proposals")) return { proposals: [] };
  if (pathname.endsWith("/outcome-contract/versions")) {
    return { versions: [] };
  }
  return null;
}

function runWithProvider(mode: "promoted" | "cleanup-only"): AgentRun {
  const promoted = mode === "promoted";
  const transaction = baseTransaction(promoted);
  return {
    id: "run-phase-eight-ui",
    agentId: agent.id,
    candidateSetId: null,
    competitorId: null,
    status: "completed",
    prompt: "Exercise registered provider evidence.",
    output: "Provider lifecycle completed through the real Airlock evidence shape.",
    error: null,
    usage: { inputTokens: 12, outputTokens: 8 },
    transaction,
    createdAt: timestamp,
  };
}

function baseTransaction(promoted: boolean): RunTransaction {
  const before = "a".repeat(64);
  const after = "b".repeat(64);
  const disposition = promoted ? "promoted" : "quarantined";
  const lifecycleStages = promoted
    ? ["prepare", "runtime", "describe", "validate", "plan-promotion", "reconcile"]
    : ["prepare", "discard"];
  return {
    id: "run-phase-eight-ui",
    status: disposition,
    disposition,
    candidateStateId: "candidate-provider-ui",
    canonicalStateIdBefore: "state-before",
    canonicalStateIdAfter: promoted ? "state-after" : "state-before",
    canonicalContentHashBefore: "sha256:" + before,
    canonicalContentHashAfter: "sha256:" + (promoted ? after : before),
    outcomeContractVersion: 1,
    outcomeContract: contract,
    resources: [],
    providerResources: [
      {
        schemaVersion: 1,
        providerId: "http-object",
        resourceKind: "versioned-http-object",
        label: "Remote versioned object",
        required: true,
        capabilities: {
          schemaVersion: 1,
          isolation: "provider-branch",
          promotionVisibility: "canonical-manifest",
          promotionIdempotency: "run-keyed",
          reconciliation: "forward",
          quarantine: "retained",
          discard: "idempotent",
          repair: "fork",
          runtimeAccess: "read-write",
        },
        source: { versionId: "version-source", fingerprint: before },
        candidate: {
          candidateId: "candidate-provider-ui",
          candidateFingerprint: after,
        },
        runtimeBinding: { relativePath: "object.json", access: "read-write" },
        change: {
          changed: true,
          fingerprintBefore: before,
          fingerprintCandidate: after,
          summary: "Candidate JSON object changed",
        },
        validations: [
          {
            name: "bounded-json-object",
            status: "passed",
            required: true,
            summary: "Candidate is a bounded JSON object",
            durationMs: 1,
            output: null,
          },
        ],
        promotionPlan: promoted
          ? {
              idempotencyKey: "airlock:v1:" + after,
              targetVersionId: "version-accepted",
              targetFingerprint: after,
            }
          : null,
        installedVersion: promoted
          ? { versionId: "version-accepted", fingerprint: after }
          : null,
        quarantine: null,
        disposition,
        summary: promoted
          ? "Remote immutable version accepted through Canonical State"
          : "Provider Candidate retained for cleanup only",
      },
    ],
    providerResourceEvents: lifecycleStages.map((stage, index) => ({
      schemaVersion: 1 as const,
      providerId: "http-object",
      resourceKind: "versioned-http-object",
      stage: stage as RunTransaction["providerResourceEvents"][number]["stage"],
      status:
        !promoted && stage === "prepare" ? ("failed" as const) : ("passed" as const),
      summary:
        !promoted && stage === "prepare"
          ? "Resource Provider failed prepare"
          : "Resource Provider passed " + stage,
      at: new Date(Date.parse(timestamp) + index * 1_000).toISOString(),
    })),
    sqlite: null,
    externalActions: {
      outboxPath: "Candidate State/outbox/intents.jsonl",
      intents: [],
      deliveredCount: 0,
      bypassDisclosure: "Direct Runtime network traffic is outside this interface.",
    },
    changes: null,
    validations: [],
    events: [
      { status: "preparing", at: timestamp, summary: "Prepared Candidate State" },
      {
        status: disposition,
        at: "2026-08-26T00:00:06.000Z",
        summary: promoted ? "Candidate promoted" : "Candidate quarantined",
      },
    ],
    quarantinePath: promoted ? null : "/bounded/quarantine/run-phase-eight-ui",
    quarantineAvailable: !promoted,
    discardedAt: null,
    lineage: {
      rootRunId: "run-phase-eight-ui",
      parentRunId: null,
      depth: 0,
      maxDepth: 2,
    },
    recovery: {
      journalPhase: promoted ? "completed" : null,
      recoveredAfterRestart: false,
      recoveryError: null,
    },
    promotionReceipt: {
      runTransactionId: "run-phase-eight-ui",
      disposition,
      outcomeContractVersion: 1,
      canonicalStateIdBefore: "state-before",
      canonicalStateIdAfter: promoted ? "state-after" : "state-before",
      canonicalContentHashBefore: "sha256:" + before,
      canonicalContentHashAfter: "sha256:" + (promoted ? after : before),
      validationEvidenceHash: "sha256:" + after,
      lineage: {
        rootRunId: "run-phase-eight-ui",
        parentRunId: null,
        depth: 0,
        maxDepth: 2,
      },
      createdAt: "2026-08-26T00:00:06.000Z",
    },
  };
}
