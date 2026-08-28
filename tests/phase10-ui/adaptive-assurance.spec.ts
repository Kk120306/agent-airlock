import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Agent,
  AssuranceProposal,
  OutcomeContractVersionRecord,
  SystemInfo,
} from "../../apps/web/src/types";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const webDist = path.join(repositoryRoot, "apps", "web", "dist");
const timestamp = "2026-08-26T01:00:00.000Z";

const agent: Agent = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Release guardian",
  description: "Learns only through operator-reviewed evidence.",
  instructions: "Protect release integrity.",
  status: "ready",
  workspacePath: "/bounded/workspace",
  canonicalStateId: "state-one",
  outcomeContract: {
    schemaVersion: 1,
    version: 2,
    requiredPaths: ["AGENTS.md", "README.md", "release.json"],
    protectedPaths: ["AGENTS.md", "README.md"],
    maxChangedFiles: 100,
    maxAddedBytes: 1_048_576,
    secretPatterns: [{ name: "private-key", pattern: "PRIVATE KEY" }],
    validationCommands: [
      {
        name: "lint",
        command: "npm run lint",
        required: true,
        timeoutMs: 30_000,
      },
    ],
    createdAt: timestamp,
  },
  codexThreadId: null,
  lastError: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const proposal: AssuranceProposal = {
  schemaVersion: 1,
  id: "a".repeat(64),
  agentId: agent.id,
  state: "ready",
  baseContractVersion: 2,
  baseContractHash: "sha256:" + "b".repeat(64),
  operations: [{ kind: "add-protected-path", path: "README.md" }],
  citations: ["one", "two", "three"].map((suffix) => ({
    operationKey: "add-protected-path:README.md",
    runId: "run-" + suffix,
    rootRunId: "root-" + suffix,
    evidenceSelector: "transaction.changes.files[path=README.md]",
    evidenceHash: "sha256:" + "c".repeat(64),
    derivationRule: "deleted-path-recurrence-v1",
  })),
  simulation: {
    engineId: "agent-airlock-historical-simulator",
    engineVersion: 1,
    results: ["one", "two", "three"].map((suffix) => ({
      operationKey: "add-protected-path:README.md",
      runId: "run-" + suffix,
      classification: "exact" as const,
      priorDisposition: "promoted" as const,
      counterfactualDisposition: "quarantined" as const,
      missingInputs: [],
      resultHash: "sha256:" + "d".repeat(64),
    })),
    digest: "sha256:" + "e".repeat(64),
  },
  proposalDigest: "sha256:" + "a".repeat(64),
  decision: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const versions: OutcomeContractVersionRecord[] = [
  {
    schemaVersion: 1,
    agentId: agent.id,
    contract: agent.outcomeContract,
    provenance: "created",
    sourceProposalId: null,
    rollbackFromVersion: null,
  },
  {
    schemaVersion: 1,
    agentId: agent.id,
    contract: {
      schemaVersion: 1,
      version: 1,
      requiredPaths: ["AGENTS.md", "README.md"],
      protectedPaths: ["AGENTS.md"],
      maxChangedFiles: 200,
      maxAddedBytes: 2_097_152,
      secretPatterns: [],
      validationCommands: [],
      createdAt: timestamp,
    },
    provenance: "created",
    sourceProposalId: null,
    rollbackFromVersion: null,
  },
];

const system: SystemInfo = {
  demoMode: false,
  protocolFixtureMode: false,
  modelArkDemoMode: false,
  modelArkPreflight: null,
  inferenceMode: "modelark",
  arkConfigured: false,
  arkBaseUrl: "https://ark.example.invalid",
  arkModel: null,
  codexAvailable: true,
  codexSandboxMode: "workspace-write",
  competingFutures: {
    available: false,
    tokenBudgetEnforcement: "unsupported",
    reason: "The configured Runner cannot enforce token budgets at the provider boundary.",
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
  runtime: "local",
};

test("shows reviewable advice, citations, simulation, and operator authority", async ({
  page,
}) => {
  await serveProductionBundle(page);
  await page.goto("http://airlock.local/");

  const toggle = page.getByRole("button", { name: /Assurance/ });
  await expect(toggle).toContainText("1");
  await toggle.click();
  const inbox = page.getByRole("region", { name: "Adaptive Assurance inbox" });
  await expect(
    inbox.getByRole("heading", {
      name: "Evidence can recommend. Only you can change policy.",
    }),
  ).toBeVisible();
  await expect(inbox.getByText("Protect README.md")).toBeVisible();
  await expect(inbox.getByText("3", { exact: true }).first()).toBeVisible();
  await expect(inbox.getByText("historical outcomes changed")).toBeVisible();
  await inbox.getByText("Inspect citations and simulation proof").click();
  await expect(
    inbox
      .getByRole("region", { name: "Proposal citations" })
      .getByText("run-one", { exact: true }),
  ).toBeVisible();
  await expect(
    inbox
      .getByRole("region", { name: "Historical simulation results" })
      .getByText("run-one", { exact: true }),
  ).toBeVisible();
  await expect(inbox.getByText("exact", { exact: true }).first()).toBeVisible();
  await expect(inbox.getByText("promoted to quarantined").first()).toBeVisible();
  await expect(inbox.getByText("complete retained inputs").first()).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Reject" })).toBeEnabled();
  await expect(inbox.getByRole("button", { name: "Review and accept" })).toBeEnabled();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText("Version history and rollback").click();
  const rollbackClick = page.getByRole("button", { name: "Restore rule content" });
  const dialogPromise = page.waitForEvent("dialog");
  const clickPromise = rollbackClick.click();
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain("Required paths removed: release.json");
  expect(dialog.message()).toContain("Protections removed: README.md");
  expect(dialog.message()).toContain("Secret rules removed or changed: private-key");
  expect(dialog.message()).toContain("Required validations removed or changed: lint");
  expect(dialog.message()).toContain("changed files 100 to 200");
  await dialog.dismiss();
  await clickPromise;

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inbox).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    390,
  );
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
  if (pathname.endsWith("/candidate-sets")) return { candidateSets: [] };
  if (pathname.endsWith("/assurance-proposals")) return { proposals: [proposal] };
  if (pathname.endsWith("/outcome-contract/versions")) return { versions };
  return null;
}
