import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type {
  Agent,
  CandidateScoreComponent,
  CandidateSet,
  OutcomeContract,
  SystemInfo,
} from "../../apps/web/src/types.js";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const webDist = path.join(projectRoot, "apps/web/dist");
const timestamp = "2026-08-26T00:00:00.000Z";
const contract: OutcomeContract = {
  schemaVersion: 1,
  version: 3,
  requiredPaths: ["AGENTS.md", "README.md"],
  protectedPaths: ["AGENTS.md"],
  maxChangedFiles: 200,
  maxAddedBytes: 2_097_152,
  secretPatterns: [],
  validationCommands: [],
  createdAt: timestamp,
};
const agent: Agent = {
  id: "agent-phase-nine-ui",
  name: "Future selector",
  description: "A production-bundle Competing Futures fixture",
  instructions: "Select only from isolated valid Candidates.",
  status: "ready",
  workspacePath: "/bounded/canonical/workspace",
  canonicalStateId: "state-selected",
  outcomeContract: contract,
  codexThreadId: "thread-focused-valid",
  lastError: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const system: SystemInfo = {
  demoMode: true,
  inferenceMode: "deterministic-local-fixture",
  arkConfigured: true,
  arkBaseUrl: "http://127.0.0.1:1/api/v3",
  arkModel: "local-airlock-demo",
  codexAvailable: true,
  codexSandboxMode: "workspace-write",
  competingFutures: {
    available: true,
    tokenBudgetEnforcement: "provider-boundary",
    reason: null,
  },
  runtimeProvider: "local-process",
  containerEngine: null,
  runtime: "Production bundle Competing Futures contract",
};

test("the production bundle explains why one valid future won", async ({ page }) => {
  await serveProductionBundle(page);
  await page.goto("http://airlock.local/");

  const evidence = page.getByRole("article", {
    name: "Competing Futures evidence",
  });
  await expect(evidence.getByRole("heading", { name: "One reproducible winner" }))
    .toBeVisible();
  await expect(evidence.getByText("focused-valid", { exact: true })).toBeVisible();
  await expect(evidence.getByText("winner", { exact: true })).toBeVisible();
  await expect(evidence.getByText("Not eligible for Selection")).toBeVisible();
  await expect(evidence.getByText("required-validation-failed")).toBeVisible();
  await expect(evidence.getByText("focused-valid selected")).toBeVisible();
  await expect(
    evidence.getByText("sha256:" + "b".repeat(64), { exact: true }),
  ).toBeVisible();
  await expect(
    evidence.getByText("raw 2 · normalized 9,998", { exact: true }),
  ).toBeVisible();
  await expect(
    evidence.getByText("airlock-workspace-change-v1", { exact: true }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Explore futures" }).click();
  const panel = page.locator("#competing-futures-panel");
  await expect(panel.getByRole("heading", {
    name: "Let isolated approaches compete safely",
  })).toBeVisible();
  await expect(panel.getByText("A faster invalid future can never win.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Run three futures" })).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(evidence).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
});

async function serveProductionBundle(page: Page): Promise<void> {
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
    const response = apiResponse(url.pathname);
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

function apiResponse(pathname: string): unknown {
  if (pathname === "/api/auth") return { required: false };
  if (pathname === "/api/system") return system;
  if (pathname === "/api/agents") return { agents: [agent] };
  if (pathname.endsWith("/messages")) return { messages: [] };
  if (pathname.endsWith("/runs")) return { runs: [] };
  if (pathname.endsWith("/candidate-sets")) return { candidateSets: [candidateSet] };
  if (pathname.endsWith("/assurance-proposals")) return { proposals: [] };
  if (pathname.endsWith("/outcome-contract/versions")) {
    return { versions: [] };
  }
  return null;
}

const scoreComponents = (
  changedFiles: number,
  addedBytes: number,
  totalTokens: number,
): CandidateScoreComponent[] => [
  {
    kind: "quality-assertion",
    source: "trusted-validation-evaluator",
    evaluatorVersion: "airlock-validation-pass-rate-v1",
    direction: "maximize",
    maximum: 1_000_000,
    rawValue: 1_000_000,
    normalizedValue: 1_000_000,
  },
  {
    kind: "changed-files",
    source: "workspace-change-evidence",
    evaluatorVersion: "airlock-workspace-change-v1",
    direction: "minimize",
    maximum: 10_000,
    rawValue: changedFiles,
    normalizedValue: 10_000 - changedFiles,
  },
  {
    kind: "added-bytes",
    source: "workspace-change-evidence",
    evaluatorVersion: "airlock-workspace-change-v1",
    direction: "minimize",
    maximum: 100_000_000,
    rawValue: addedBytes,
    normalizedValue: 100_000_000 - addedBytes,
  },
  {
    kind: "latency-ms",
    source: "monotonic-execution-measurement",
    evaluatorVersion: "airlock-monotonic-runtime-v1",
    direction: "minimize",
    maximum: 3_600_000,
    rawValue: 80,
    normalizedValue: 3_599_920,
  },
  {
    kind: "total-tokens",
    source: "runtime-usage-response",
    evaluatorVersion: "airlock-runtime-usage-v1",
    direction: "minimize",
    maximum: 10_000_000,
    rawValue: totalTokens,
    normalizedValue: 10_000_000 - totalTokens,
  },
];

const candidateSet: CandidateSet = {
  schemaVersion: 1,
  id: "candidate-set-phase-nine-ui",
  agentId: agent.id,
  objective: "Build the smallest complete solution from one shared immutable source.",
  source: {
    stateId: "state-before",
    contentHash: "sha256:" + "a".repeat(64),
    codexThreadId: "thread-before",
  },
  outcomeContract: contract,
  competitors: [
    {
      id: "unsafe-fast",
      runId: "run-unsafe-fast",
      executorProfileId: "standard-v1",
      strategyInstruction: "Finish quickly, subject to required Validation.",
      status: "discarded",
      criterionValues: {},
      exclusions: ["required-validation-failed"],
      evaluationDurationMs: 25,
      loserDisposition: "discarded",
      error: null,
    },
    {
      id: "broad-valid",
      runId: "run-broad-valid",
      executorProfileId: "standard-v1",
      strategyInstruction: "Build a comprehensive valid solution.",
      status: "retained",
      criterionValues: {
        "quality-assertion": 1_000_000,
        "changed-files": 7,
        "added-bytes": 4_000,
        "latency-ms": 95,
        "total-tokens": 42,
      },
      exclusions: [],
      evaluationDurationMs: 95,
      loserDisposition: "retained",
      error: null,
    },
    {
      id: "focused-valid",
      runId: "run-focused-valid",
      executorProfileId: "standard-v1",
      strategyInstruction: "Build the narrowest complete valid solution.",
      status: "promoted",
      criterionValues: {
        "quality-assertion": 1_000_000,
        "changed-files": 2,
        "added-bytes": 600,
        "latency-ms": 80,
        "total-tokens": 26,
      },
      exclusions: [],
      evaluationDurationMs: 80,
      loserDisposition: "winner",
      error: null,
    },
  ],
  maxConcurrency: 3,
  loserPolicy: "retain",
  phase: "completed",
  selectionDecision: {
    winnerCompetitorId: "focused-valid",
    orderedCompetitorIds: ["focused-valid", "broad-valid"],
    scorecard: [
      {
        competitorId: "unsafe-fast",
        eligible: false,
        exclusions: ["required-validation-failed"],
        components: [],
        rank: null,
      },
      {
        competitorId: "broad-valid",
        eligible: true,
        exclusions: [],
        components: scoreComponents(7, 4_000, 42),
        rank: 2,
      },
      {
        competitorId: "focused-valid",
        eligible: true,
        exclusions: [],
        components: scoreComponents(2, 600, 26),
        rank: 1,
      },
    ],
    tieBreak: "competitor-id-ascending-byte-order",
    decisionDigest: "sha256:" + "b".repeat(64),
  },
  selectedCompetitorId: "focused-valid",
  winnerRunId: "run-focused-valid",
  cancellationRequested: false,
  recoveryError: null,
  createdAt: timestamp,
  updatedAt: "2026-08-26T00:00:05.000Z",
  completedAt: "2026-08-26T00:00:05.000Z",
};
