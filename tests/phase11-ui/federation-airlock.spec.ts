import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Agent,
  AgentRun,
  FederatedAdmissionInboxItem,
  FederatedImportResult,
  SystemInfo,
} from "../../apps/web/src/types";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const webDist = path.join(repositoryRoot, "apps", "web", "dist");
const timestamp = "2026-08-28T06:00:00.000Z";
const digest = (character: string) => "sha256:" + character.repeat(64);

const agent: Agent = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Receiver guardian",
  description: "Validates work crossing an organizational boundary.",
  instructions: "Never trust a producer's Promotion decision.",
  status: "ready",
  workspacePath: "/receiver/canonical",
  canonicalStateId: "receiver-state-before",
  outcomeContract: {
    schemaVersion: 1,
    version: 4,
    requiredPaths: ["AGENTS.md", "release.json"],
    protectedPaths: ["AGENTS.md"],
    maxChangedFiles: 20,
    maxAddedBytes: 65_536,
    secretPatterns: [],
    validationCommands: [],
    createdAt: timestamp,
  },
  codexThreadId: "receiver-thread",
  lastError: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const system = {
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
    available: true,
    tokenBudgetEnforcement: "provider-boundary",
    reason: null,
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
  runtime: "Federated receiver fixture",
} satisfies SystemInfo;

const importedRun = {
  id: "federated-run-001",
  agentId: agent.id,
  candidateSetId: null,
  competitorId: null,
  status: "completed",
  prompt: "Federated import from studio-blue",
  output: "Receiver Validation passed and Candidate State was promoted.",
  error: null,
  usage: null,
  startedAt: timestamp,
  completedAt: timestamp,
  createdAt: timestamp,
  transaction: {
    id: "federated-run-001",
    status: "promoted",
    disposition: "promoted",
    candidateStateId: "candidate-federated-001",
    canonicalStateIdBefore: "receiver-state-before",
    canonicalStateIdAfter: "receiver-state-after",
    canonicalContentHashBefore: "a".repeat(64),
    canonicalContentHashAfter: "b".repeat(64),
    outcomeContractVersion: 4,
    outcomeContract: agent.outcomeContract,
    resources: [
      {
        kind: "workspace",
        label: "Workspace",
        disposition: "promoted",
        fingerprintBefore: digest("a"),
        fingerprintAfter: digest("b"),
        summary: "Federated Candidate installed by the receiver.",
      },
    ],
    providerResources: [],
    providerResourceEvents: [],
    sqlite: null,
    externalActions: {
      outboxPath: ".airlock/external-actions.jsonl",
      intents: [],
      deliveredCount: 0,
      bypassDisclosure: "No effect bypass is available.",
    },
    changes: {
      files: [{ path: "release.json", kind: "added", addedBytes: 28 }],
      totalChangedFiles: 1,
      totalAddedBytes: 28,
      truncated: false,
    },
    validations: [
      {
        name: "federated-receiver-import",
        status: "passed",
        required: true,
        summary: "Receiver verified the imported Candidate without invoking a model.",
        durationMs: 0,
        output: null,
      },
      {
        name: "required-paths",
        status: "passed",
        required: true,
        summary: "Receiver required paths are present.",
        durationMs: 2,
        output: null,
      },
    ],
    events: [
      { status: "preparing", at: timestamp, summary: "Receiver admitted signed work." },
      { status: "promoted", at: timestamp, summary: "Federated Promotion completed." },
    ],
    quarantinePath: null,
    quarantineAvailable: false,
    discardedAt: null,
    lineage: {
      rootRunId: "federated-run-001",
      parentRunId: null,
      depth: 0,
      maxDepth: 3,
    },
    recovery: {
      journalPhase: "completed",
      recoveredAfterRestart: false,
      recoveryError: null,
    },
    promotionReceipt: {
      runTransactionId: "federated-run-001",
      disposition: "promoted",
      outcomeContractVersion: 4,
      canonicalStateIdBefore: "receiver-state-before",
      canonicalStateIdAfter: "receiver-state-after",
      canonicalContentHashBefore: "a".repeat(64),
      canonicalContentHashAfter: "b".repeat(64),
      validationEvidenceHash: "c".repeat(64),
      lineage: {
        rootRunId: "federated-run-001",
        parentRunId: null,
        depth: 0,
        maxDepth: 3,
      },
      createdAt: timestamp,
    },
  },
} as AgentRun;

const promoted: FederatedImportResult = {
  admission: {
    schema: "agent-airlock/federated-admission-record",
    schemaVersion: 1,
    admissionId: digest("1"),
    importIdentifier: digest("2"),
    transferId: "judge-transfer-001",
    producerId: "studio-blue",
    localAgentId: agent.id,
    candidateRunId: importedRun.id,
    decision: {
      decision: "admit",
      reason: "admitted",
      policyId: "receiver-production",
      policyGeneration: 7,
      policyDigest: digest("3"),
      producerId: "studio-blue",
      receiptDigest: digest("4"),
      artifactDigest: digest("5"),
      evaluatedAt: timestamp,
      detail: "Admission policy accepted the verified federated work bundle.",
    },
    recordedAt: timestamp,
    recordDigest: digest("6"),
  },
  run: importedRun,
};

const pending: FederatedImportResult = {
  admission: {
    ...promoted.admission,
    candidateRunId: null,
    decision: {
      ...promoted.admission.decision,
      decision: "pending",
      reason: "approval-required",
      detail: "Verified work requires a local operator decision.",
    },
  },
  run: null,
};

const approval = {
  schema: "agent-airlock/federated-approval-decision" as const,
  schemaVersion: 1 as const,
  approvalId: digest("7"),
  admissionId: pending.admission.admissionId,
  importIdentifier: pending.admission.importIdentifier,
  pendingRecordDigest: pending.admission.recordDigest,
  localAgentId: agent.id,
  operatorId: "local-control-plane",
  choice: "approve" as const,
  reason: "Release evidence and scope verified",
  decidedAt: timestamp,
  recordDigest: digest("8"),
};

const pendingReview: NonNullable<FederatedAdmissionInboxItem["review"]> = {
  schemaVersion: 1,
  authority: "producer-claim-non-authoritative",
  producerClaim: {
    runId: "producer-run-001",
    agentId: "producer-agent-001",
    disposition: "promoted",
    decidedAt: timestamp,
    outcomeContractVersion: 4,
  },
  artifact: {
    operationCount: 2,
    displayedOperationCount: 2,
    truncated: false,
    totalPayloadBytes: 1536,
    operations: [
      {
        operation: "modify",
        path: "src/release.ts",
        toPath: null,
        byteLength: 1024,
      },
      {
        operation: "add",
        path: "docs/release-proof.md",
        toPath: null,
        byteLength: 512,
      },
    ],
  },
  resources: {
    builtinBefore: 3,
    builtinAfter: 3,
    providerBefore: 1,
    providerAfter: 1,
  },
  preflight: {
    authority: "metadata-only-not-validation",
    contractVersion: 4,
    status: "no-metadata-blocker",
    affectedPathCount: 2,
    blockers: [],
    deferredChecks: [
      "secret-content-scan",
      "validation-commands",
      "candidate-resource-validation",
    ],
  },
};

const blockedPendingReview: NonNullable<
  FederatedAdmissionInboxItem["review"]
> = {
  ...pendingReview,
  artifact: {
    ...pendingReview.artifact,
    operationCount: 1,
    displayedOperationCount: 1,
    totalPayloadBytes: 384,
    operations: [
      {
        operation: "modify",
        path: "AGENTS.md",
        toPath: null,
        byteLength: 384,
      },
    ],
  },
  preflight: {
    authority: "metadata-only-not-validation",
    contractVersion: 4,
    status: "predicted-blocker",
    affectedPathCount: 1,
    blockers: [
      {
        code: "protected-path-change",
        summary: "1 proposed path matches the receiver protected-path policy",
        paths: ["AGENTS.md"],
      },
    ],
    deferredChecks: [
      "secret-content-scan",
      "validation-commands",
      "candidate-resource-validation",
    ],
  },
};

test("imports signed work through the visible receiver-owned Promotion path", async ({
  page,
}) => {
  const importRequests: unknown[] = [];
  await serveProductionBundle(page, importRequests);
  await page.goto("http://airlock.local/");

  await page.getByRole("button", { name: "Federation" }).click();
  const panel = page.locator("#federation-airlock-panel");
  await expect(
    panel.getByRole("heading", { name: "Import verified work, not remote authority" }),
  ).toBeVisible();
  await expect(panel.getByText("receiver-production · generation 7")).toBeVisible();
  await expect(panel.getByText(/reruns its own Outcome Contract/)).toBeVisible();

  await panel.getByLabel("Transfer identity").fill("judge-transfer-001");
  await panel.getByLabel("Federated Work Bundle").setInputFiles({
    name: "federated-work.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ schema: "agent-airlock/federated-work-bundle" })),
  });
  await panel.getByLabel("Signed Trust Policy").setInputFiles({
    name: "trust-policy.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ schema: "agent-airlock/signed-signing-key-trust-policy" }),
    ),
  });
  await expect(panel.getByText("federated-work.json")).toBeVisible();
  await expect(panel.getByText("trust-policy.json")).toBeVisible();
  await panel.getByRole("button", { name: "Admit into Candidate State" }).click();

  await expect(panel.getByText("PROMOTED BY RECEIVER")).toBeVisible();
  await expect(panel.getByText("Bundle, receipt, authority, and signer scope verified"))
    .toBeVisible();
  await expect(panel.getByText("2 required receiver checks")).toBeVisible();
  await expect(panel.getByText("Receiver Canonical State advanced atomically"))
    .toBeVisible();
  await expect(panel.getByText("No model call runs during import.")).toBeVisible();
  expect(importRequests).toEqual([
    {
      transferId: "judge-transfer-001",
      producerId: "studio-blue",
      bundle: { schema: "agent-airlock/federated-work-bundle" },
      trustPolicy: { schema: "agent-airlock/signed-signing-key-trust-policy" },
    },
  ]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    390,
  );
});

test("resumes a pending Admission through the visible append-only operator gate", async ({
  page,
}) => {
  const decisionRequests: unknown[] = [];
  await serveProductionBundle(page, [], pending, {
    admission: pending.admission,
    approval,
    run: importedRun,
  }, decisionRequests);
  await page.goto("http://airlock.local/");
  await page.getByRole("button", { name: "Federation" }).click();
  const panel = page.locator("#federation-airlock-panel");
  await panel.getByLabel("Transfer identity").fill("judge-pending-001");
  await panel.getByLabel("Federated Work Bundle").setInputFiles({
    name: "pending-work.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ schema: "agent-airlock/federated-work-bundle" })),
  });
  await panel.getByLabel("Signed Trust Policy").setInputFiles({
    name: "pending-policy.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ schema: "agent-airlock/signed-signing-key-trust-policy" })),
  });
  await panel.getByRole("button", { name: "Admit into Candidate State" }).click();

  await expect(panel.getByRole("region", { name: "Local admission decision" }))
    .toBeVisible();
  await expect(panel.getByText(/Canonical State is unchanged/)).toBeVisible();
  await panel.getByLabel("Decision reason").fill(approval.reason);
  await panel.getByRole("button", { name: "Approve into Candidate State" }).click();

  await expect(panel.getByText("PROMOTED BY RECEIVER")).toBeVisible();
  await expect(panel.getByText(approval.recordDigest)).toBeVisible();
  await expect(panel.getByText("Recorded by local-control-plane")).toBeVisible();
  expect(decisionRequests).toEqual([
    { choice: "approve", reason: approval.reason },
  ]);
});

test("discovers and resolves a pending Admission after a full browser reload", async ({
  page,
}) => {
  const decisionRequests: unknown[] = [];
  const pendingInboxItem: FederatedAdmissionInboxItem = {
    admission: pending.admission,
    approval: null,
    review: pendingReview,
    run: null,
    state: "pending",
  };
  await serveProductionBundle(
    page,
    [],
    pending,
    { admission: pending.admission, approval, run: importedRun },
    decisionRequests,
    [pendingInboxItem],
  );
  await page.goto("http://airlock.local/");
  await page.reload();
  await page.getByRole("button", { name: "Federation" }).click();
  const panel = page.locator("#federation-airlock-panel");

  await expect(
    panel.getByRole("region", { name: "Federated approval inbox" }),
  ).toContainText("1 local Admission");
  await panel
    .locator(".federation-inbox-list button")
    .filter({ hasText: "judge-transfer-001" })
    .click();
  const review = panel.getByRole("region", { name: "Pending Admission review" });
  await expect(review.getByText("PRODUCER CLAIM · NOT RECEIVER AUTHORITY"))
    .toBeVisible();
  await expect(review.getByText("src/release.ts")).toBeVisible();
  await expect(review.getByText("docs/release-proof.md")).toBeVisible();
  await expect(review.getByText("No predicted metadata blocker")).toBeVisible();
  await expect(
    review.getByText("Deferred to authoritative Candidate Validation"),
  ).toBeVisible();
  await expect(review.getByText(/Approval never bypasses receiver Validation/))
    .toBeVisible();
  await expect(review.getByText(/Receiver Outcome Contract checks run only after approval/))
    .toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(review).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await expect(panel.getByRole("region", { name: "Local admission decision" }))
    .toBeVisible();
  await panel.getByLabel("Decision reason").fill(approval.reason);
  await panel.getByRole("button", { name: "Approve into Candidate State" }).click();

  await expect(panel.getByText("PROMOTED BY RECEIVER")).toBeVisible();
  expect(decisionRequests).toEqual([
    { choice: "approve", reason: approval.reason },
  ]);
});

test("shows predicted receiver blockers without claiming authoritative validation", async ({
  page,
}) => {
  const pendingInboxItem: FederatedAdmissionInboxItem = {
    admission: pending.admission,
    approval: null,
    review: blockedPendingReview,
    run: null,
    state: "pending",
  };
  await serveProductionBundle(page, [], pending, pending, [], [pendingInboxItem]);
  await page.goto("http://airlock.local/");
  await page.getByRole("button", { name: "Federation" }).click();
  const panel = page.locator("#federation-airlock-panel");
  await panel
    .locator(".federation-inbox-list button")
    .filter({ hasText: "judge-transfer-001" })
    .click();
  const review = panel.getByRole("region", { name: "Pending Admission review" });

  await expect(review.getByText("1 predicted blocker")).toBeVisible();
  await expect(review.getByText("protected path change")).toBeVisible();
  await expect(review.getByText("AGENTS.md", { exact: true }).first()).toBeVisible();
  await expect(review.getByText(/metadata only/)).toBeVisible();
  await expect(review.getByText(/Approval never bypasses receiver Validation/))
    .toBeVisible();
  await expect(panel.getByRole("button", { name: "Approve into Candidate State" }))
    .toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(review).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
});

test("fails closed when a stale operator contradicts an append-only decision", async ({
  page,
}) => {
  const pendingInboxItem: FederatedAdmissionInboxItem = {
    admission: pending.admission,
    approval: null,
    review: pendingReview,
    run: null,
    state: "pending",
  };
  await serveProductionBundle(
    page,
    [],
    pending,
    { status: 409, error: "Federated approval decision conflicts with its immutable record" },
    [],
    [pendingInboxItem],
  );
  await page.goto("http://airlock.local/");
  await page.getByRole("button", { name: "Federation" }).click();
  const panel = page.locator("#federation-airlock-panel");
  await panel
    .locator(".federation-inbox-list button")
    .filter({ hasText: "judge-transfer-001" })
    .click();
  await panel.getByLabel("Decision reason").fill("Contradictory stale review");
  await panel.getByRole("button", { name: "Approve into Candidate State" }).click();

  await expect(panel.getByRole("alert")).toContainText(
    "conflicts with its immutable record",
  );
  await expect(panel.getByText("PROMOTED BY RECEIVER")).toHaveCount(0);
  await expect(panel.getByText("unchanged", { exact: true })).toBeVisible();
});

test("shows a durable denial while Canonical State remains unchanged", async ({ page }) => {
  const deniedApproval = {
    ...approval,
    choice: "deny" as const,
    reason: "Release scope exceeds receiver policy",
  };
  await serveProductionBundle(page, [], pending, {
    admission: pending.admission,
    approval: deniedApproval,
    run: null,
  });
  await page.goto("http://airlock.local/");
  await page.getByRole("button", { name: "Federation" }).click();
  const panel = page.locator("#federation-airlock-panel");
  await panel.getByLabel("Transfer identity").fill("judge-denied-001");
  await panel.getByLabel("Federated Work Bundle").setInputFiles({
    name: "denied-work.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await panel.getByLabel("Signed Trust Policy").setInputFiles({
    name: "denied-policy.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await panel.getByRole("button", { name: "Admit into Candidate State" }).click();
  await panel.getByLabel("Decision reason").fill(deniedApproval.reason);
  await panel.getByRole("button", { name: "Deny and preserve Canonical" }).click();

  await expect(panel.getByText("DENIED BY OPERATOR")).toBeVisible();
  await expect(panel.getByText("unchanged", { exact: true })).toBeVisible();
  await expect(panel.getByText(deniedApproval.recordDigest)).toBeVisible();
  await expect(panel.getByText("PROMOTED BY RECEIVER")).toHaveCount(0);
});

const operatorVisibleRejections = [
  {
    name: "untrusted authority",
    reason: "authority-unpinned",
    detail: "The producer trust-policy authority is not pinned by this receiver.",
  },
  {
    name: "compromised signer",
    reason: "signer-compromised",
    detail: "The producer receipt signer is compromised under receiver policy.",
  },
  {
    name: "wrong Agent scope",
    reason: "agent-scope-mismatch",
    detail: "The signed work is outside the receiver-approved Agent scope.",
  },
  {
    name: "stale receipt",
    reason: "receipt-stale",
    detail: "The producer receipt is older than the receiver freshness limit.",
  },
  {
    name: "protocol downgrade",
    reason: "protocol-not-allowed",
    detail: "The proposed artifact protocol is not allowed by receiver policy.",
  },
  {
    name: "transparency split view",
    reason: "transparency-split-view",
    detail: "The supplied transparency evidence conflicts with the receiver checkpoint.",
  },
] as const;

for (const rejection of operatorVisibleRejections) {
  test(`shows ${rejection.name} rejection with Canonical State unchanged`, async ({
    page,
  }) => {
    const rejected: FederatedImportResult = {
      admission: {
        ...promoted.admission,
        candidateRunId: null,
        decision: {
          ...promoted.admission.decision,
          decision: "reject",
          reason: rejection.reason,
          detail: rejection.detail,
        },
      },
      run: null,
    };
    await serveProductionBundle(page, [], rejected);
    await page.goto("http://airlock.local/");
    await page.getByRole("button", { name: "Federation" }).click();
    const panel = page.locator("#federation-airlock-panel");
    await panel.getByLabel("Transfer identity").fill("judge-rejected-001");
    await panel.getByLabel("Federated Work Bundle").setInputFiles({
      name: "untrusted-work.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ schema: "agent-airlock/federated-work-bundle" }),
      ),
    });
    await panel.getByLabel("Signed Trust Policy").setInputFiles({
      name: "untrusted-policy.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ schema: "agent-airlock/signed-signing-key-trust-policy" }),
      ),
    });
    await panel.getByRole("button", { name: "Admit into Candidate State" }).click();

    await expect(panel.getByText("REJECT")).toBeVisible();
    await expect(panel.getByRole("status").getByText(rejection.detail)).toBeVisible();
    await expect(panel.getByText("unchanged", { exact: true })).toBeVisible();
    await expect(panel.getByText("No mutable Canonical path enters the import Runtime"))
      .toBeVisible();
  });
}

const failClosedImportErrors = [
  {
    name: "artifact tamper",
    status: 400,
    error: "Federated Work Bundle artifact digest is invalid.",
  },
  {
    name: "receipt tamper",
    status: 400,
    error: "Portable receipt signature is invalid.",
  },
  {
    name: "conflicting replay",
    status: 409,
    error: "Transfer identity conflicts with an earlier Admission Record.",
  },
] as const;

for (const failure of failClosedImportErrors) {
  test(`shows ${failure.name} failure before Canonical State can change`, async ({
    page,
  }) => {
    await serveProductionBundle(page, [], failure);
    await page.goto("http://airlock.local/");
    await page.getByRole("button", { name: "Federation" }).click();
    const panel = page.locator("#federation-airlock-panel");
    await panel.getByLabel("Transfer identity").fill("judge-failed-001");
    await panel.getByLabel("Federated Work Bundle").setInputFiles({
      name: "invalid-work.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ schema: "agent-airlock/federated-work-bundle" }),
      ),
    });
    await panel.getByLabel("Signed Trust Policy").setInputFiles({
      name: "receiver-policy.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ schema: "agent-airlock/signed-signing-key-trust-policy" }),
      ),
    });
    await panel.getByRole("button", { name: "Admit into Candidate State" }).click();

    await expect(panel.getByRole("alert")).toHaveText(failure.error);
    await expect(panel.getByText("No mutable Canonical path enters the import Runtime"))
      .toBeVisible();
    await expect(panel.getByText("PROMOTED BY RECEIVER")).toHaveCount(0);
  });
}

type FederatedImportResponse =
  | FederatedImportResult
  | { status: number; error: string };

type FederatedDecisionResponse =
  | FederatedImportResult
  | { status: number; error: string };

async function serveProductionBundle(
  page: Page,
  importRequests: unknown[],
  importResult: FederatedImportResponse = promoted,
  decisionResult?: FederatedDecisionResponse,
  decisionRequests: unknown[] = [],
  inboxItems: FederatedAdmissionInboxItem[] = [],
): Promise<void> {
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
    if (
      url.pathname === "/api/agents/" + agent.id + "/federated-imports" &&
      route.request().method() === "POST"
    ) {
      importRequests.push(route.request().postDataJSON());
      if ("status" in importResult) {
        await route.fulfill({
          status: importResult.status,
          contentType: "application/json",
          body: JSON.stringify({ error: importResult.error }),
        });
        return;
      }
      await route.fulfill({
        status: importResult.run ? 201 : 200,
        contentType: "application/json",
        body: JSON.stringify(importResult),
      });
      return;
    }
    if (
      url.pathname ===
        "/api/agents/" + agent.id + "/federated-admissions" &&
      route.request().method() === "GET"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ admissions: inboxItems }),
      });
      return;
    }
    if (
      url.pathname ===
        "/api/federation/admissions/" + pending.admission.admissionId + "/decision" &&
      route.request().method() === "POST" &&
      decisionResult
    ) {
      decisionRequests.push(route.request().postDataJSON());
      if ("status" in decisionResult) {
        await route.fulfill({
          status: decisionResult.status,
          contentType: "application/json",
          body: JSON.stringify({ error: decisionResult.error }),
        });
        return;
      }
      await route.fulfill({
        status: decisionResult.run ? 201 : 200,
        contentType: "application/json",
        body: JSON.stringify(decisionResult),
      });
      return;
    }
    const body = apiResponse(url.pathname);
    if (body !== null) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not found" });
  });
}

function apiResponse(pathname: string): unknown | null {
  if (pathname === "/api/auth") return { required: false };
  if (pathname === "/api/system") return system;
  if (pathname === "/api/agents") return { agents: [agent] };
  if (pathname === "/api/federation/policies/active") {
    return {
      policy: {
        schema: "agent-airlock/federated-admission-policy",
        schemaVersion: 1,
        policyId: "receiver-production",
        generation: 7,
        activatedAt: timestamp,
        receiverOrganizationId: "receiver-labs",
        producers: [
          {
            producerId: "studio-blue",
            disabled: false,
            requireLocalApproval: false,
          },
        ],
      },
      policyDigest: digest("3"),
    };
  }
  if (pathname === "/api/agents/" + agent.id + "/messages") return { messages: [] };
  if (pathname === "/api/agents/" + agent.id + "/runs") return { runs: [] };
  if (pathname === "/api/agents/" + agent.id + "/candidate-sets") {
    return { candidateSets: [] };
  }
  if (pathname === "/api/agents/" + agent.id + "/assurance-proposals") {
    return { proposals: [] };
  }
  if (pathname === "/api/agents/" + agent.id + "/outcome-contract/versions") {
    return {
      versions: [
        {
          schemaVersion: 1,
          agentId: agent.id,
          contract: agent.outcomeContract,
          provenance: "created",
          sourceProposalId: null,
          rollbackFromVersion: null,
        },
      ],
    };
  }
  return null;
}
