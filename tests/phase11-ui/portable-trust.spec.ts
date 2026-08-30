import { expect, test, type Download, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Agent,
  AgentRun,
  PortablePromotionEnvelope,
  PortableReceiptExport,
  SystemInfo,
} from "../../apps/web/src/types";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const webDist = path.join(repositoryRoot, "apps", "web", "dist");
const timestamp = "2026-08-26T02:00:00.000Z";
const sha256 = (value: string) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");
const goldenDocument = JSON.parse(
  await readFile(
    path.join(
      repositoryRoot,
      "packages",
      "portable-promotion-receipt",
      "vectors",
      "portable-receipt-v1.golden.json",
    ),
    "utf8",
  ),
) as { envelope: PortablePromotionEnvelope };

const agent: Agent = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Portable guardian",
  description: "Exports proof without exporting private work.",
  instructions: "Preserve the Airlock trust boundary.",
  status: "ready",
  workspacePath: "/bounded/workspace",
  canonicalStateId: "state-after",
  outcomeContract: {
    schemaVersion: 1,
    version: 2,
    requiredPaths: ["AGENTS.md", "README.md"],
    protectedPaths: ["AGENTS.md"],
    maxChangedFiles: 200,
    maxAddedBytes: 2_097_152,
    secretPatterns: [],
    validationCommands: [],
    createdAt: timestamp,
  },
  codexThreadId: "thread-portable",
  lastError: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const run = {
  id: "run-golden",
  agentId: agent.id,
  candidateSetId: null,
  competitorId: null,
  status: "completed",
  prompt: "Private operator objective that must not enter the receipt.",
  output: "Private Runtime output that must not enter the receipt.",
  error: null,
  usage: { inputTokens: 8, outputTokens: 5 },
  createdAt: timestamp,
  transaction: {
    id: "transaction-golden",
    status: "promoted",
    disposition: "promoted",
    canonicalStateIdBefore: "state-before",
    canonicalStateIdAfter: "state-after",
    canonicalContentHashBefore: "a".repeat(64),
    canonicalContentHashAfter: "b".repeat(64),
    outcomeContractVersion: 2,
    resources: [],
    providerResources: [],
    providerResourceEvents: [],
    changes: { totalChangedFiles: 0, totalAddedBytes: 0, files: [], truncated: false },
    validations: [
      {
        name: "execution-profile",
        status: "passed",
        required: true,
        summary:
          "Airlock control plane attested successful execution through real Codex CLI against the configured ModelArk Responses profile. Model identity is committed without disclosure as sha256:123456789abc.",
        durationMs: 0,
        output: null,
      },
      {
        name: "required-paths",
        status: "passed",
        required: true,
        summary: "Required public artifacts are present.",
        durationMs: 5,
        output: null,
      },
    ],
    sqlite: null,
    externalActions: {
      intents: [],
      deliveredCount: 0,
      bypassDisclosure: "No effect bypass is available.",
    },
    events: [{ status: "promoted", at: timestamp, summary: "Promotion completed." }],
    quarantineAvailable: false,
    lineage: {
      rootRunId: "run-golden",
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
      validationEvidenceHash: "c".repeat(64),
      disposition: "promoted",
    },
  },
} as unknown as AgentRun;

const system: SystemInfo = {
  demoMode: false,
  protocolFixtureMode: false,
  modelArkDemoMode: false,
  modelArkPreflight: null,
  externalActionDelivery: {
    mode: "atomic-local-store",
    destination: "demo-console",
    transport: "platform-local-store",
    idempotency: "atomic-store-enforced",
  },
  inferenceMode: "modelark",
  arkConfigured: false,
  modelProfileDisclosure: "configured-status-only",
  codexAvailable: true,
  codexSandboxMode: "workspace-write",
  competingFutures: {
    available: false,
    tokenBudgetEnforcement: "unsupported",
    reason: "The Runner cannot enforce provider-boundary token allowances.",
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
  runtime: "Production bundle Portable Trust contract",
};

test("exports a private-by-default receipt and explains the proof boundary", async ({
  page,
}) => {
  const requests: Array<Record<string, unknown>> = [];
  await serveProductionBundle(page, requests);
  await page.goto("http://airlock.local/");

  const panel = page.getByRole("region", { name: "Portable trust receipt" });
  await expect(
    panel.getByRole("heading", { name: "Export a signed decision statement" }),
  ).toBeVisible();
  await expect(panel.getByText(/It proves key possession, not that the reported state existed/))
    .toBeVisible();
  await expect(panel.getByText(/Always included: stable Run and Agent identifiers/))
    .toBeVisible();
  await expect(panel.getByText(/A signature is sufficient for ordinary offline verification/))
    .toBeVisible();
  await panel.getByRole("button", { name: "Generate receipt" }).click();
  await expect(panel.getByText("Self-check passed")).toBeVisible();
  expect(requests[0]).toEqual({
    disclosureIdentities: [],
    includeAncestry: true,
    localAnchor: false,
    evmPayload: false,
  });
  await expect(panel.getByText("The verifier does not prove that Runtime isolation was sufficient."))
    .toBeVisible();
  await expect(panel.getByText(goldenDocument.envelope.receiptDigest)).toBeVisible();

  await panel.getByText("Disclose signed evidence (0/2 selected)").click();
  await expect(
    panel.getByText(
      "The signed Merkle root commits to 2 Validation leaves: 1 required and 1 optional. Only selected redacted leaves and their inclusion proofs enter the downloaded envelope.",
    ),
  ).toBeVisible();
  await expect(panel.getByText("Evidence commitment required · passed required"))
    .toBeVisible();
  await expect(panel.getByText("Evidence commitment optional · passed optional"))
    .toBeVisible();
  await expect(panel.getByText("0/1 required selected", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Nothing is disclosed unless you deliberately select/))
    .toBeVisible();
  await panel.getByRole("button", { name: "Select all required" }).click();
  await expect(panel.getByText("Disclose signed evidence (1/2 selected)")).toBeVisible();
  await expect(panel.getByText("1/1 required selected", { exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: /required · passed required/ }))
    .toBeChecked();
  await expect(panel.getByRole("checkbox", { name: /optional · passed optional/ }))
    .not.toBeChecked();
  await panel.getByRole("button", { name: "Clear selection" }).click();
  await expect(panel.getByText("Disclose signed evidence (0/2 selected)")).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: /required · passed required/ }))
    .not.toBeChecked();
  await panel.getByRole("button", { name: "Select all required" }).click();
  await panel.getByRole("checkbox", { name: /Append to local transparency log/ }).check();
  await panel.getByRole("checkbox", { name: /Prepare digest-only EVM calldata/ }).check();
  await expect(
    panel.getByRole("button", { name: "Download receipt JSON" }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "Regenerate receipt" }).click();
  expect(requests[1]).toEqual({
    disclosureIdentities: ["validation:required-paths"],
    includeAncestry: true,
    localAnchor: true,
    evmPayload: true,
  });
  await expect(panel.getByText(/Local checkpoint 1/)).toBeVisible();
  await expect(panel.getByText(/0 network calls/)).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download receipt JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("agent-airlock-receipt-run-golden.json");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const downloaded = Buffer.concat(chunks).toString("utf8");
  expect(JSON.parse(downloaded)).toEqual(
    expect.objectContaining({
      receiptDigest: goldenDocument.envelope.receiptDigest,
      disclosures: [expect.objectContaining({ leaf: expect.any(Object) })],
    }),
  );
  expect(downloaded).not.toMatch(/Private operator objective|Private Runtime output|PRIVATE KEY/);

  const federatedDownloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download federated work" }).click();
  const federatedDownload = await federatedDownloadPromise;
  expect(federatedDownload.suggestedFilename()).toBe(
    "agent-airlock-federated-work-run-golden.json",
  );
  expect(JSON.parse(await readDownload(federatedDownload))).toEqual({
    schema: "agent-airlock/federated-work-bundle",
    schemaVersion: 1,
  });

  const packetDownloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download evidence packet" }).click();
  const packetDownload = await packetDownloadPromise;
  expect(packetDownload.suggestedFilename()).toBe(
    "agent-airlock-evidence-run-golden.json",
  );
  expect(JSON.parse(await readDownload(packetDownload))).toMatchObject({
    schema: "agent-airlock/portable-evidence-packet",
    schemaVersion: 1,
    envelope: { receiptDigest: goldenDocument.envelope.receiptDigest },
    anchor: expect.any(Object),
    evmPayload: { networkCalls: 0, fundsSpent: 0 },
  });

  const anchorDownloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download anchor proof" }).click();
  const anchorDownload = await anchorDownloadPromise;
  expect(anchorDownload.suggestedFilename()).toBe(
    "agent-airlock-anchor-run-golden.json",
  );
  expect(
    JSON.parse(await readDownload(anchorDownload)),
  ).toEqual(
    expect.objectContaining({
      checkpoint: expect.any(Object),
      inclusionProof: expect.any(Object),
    }),
  );

  const evmDownloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download EVM payload" }).click();
  const evmDownload = await evmDownloadPromise;
  expect(evmDownload.suggestedFilename()).toBe(
    "agent-airlock-evm-payload-run-golden.json",
  );
  expect(JSON.parse(await readDownload(evmDownload))).toMatchObject({
    methodSignature: "anchor(bytes32)",
    networkCalls: 0,
    fundsSpent: 0,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const mobilePanel = page.getByRole("region", { name: "Portable trust receipt" });
  await expect(mobilePanel).toBeVisible();
  const essentialFontSizes = await mobilePanel
    .locator(
      ".portable-trust-heading p, .portable-options strong, .portable-options small, .portable-trust-levels",
    )
    .evaluateAll((elements) =>
      elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    );
  expect(Math.min(...essentialFontSizes)).toBeGreaterThanOrEqual(12);
  await mobilePanel.getByRole("button", { name: "Generate receipt" }).click();
  await expect(mobilePanel.getByText("Self-check passed")).toBeVisible();
  await mobilePanel.getByText(/Disclose signed evidence/).click();
  await mobilePanel.getByRole("button", { name: "Select all required" }).click();
  await expect(mobilePanel.getByText("1/1 required selected", { exact: true })).toBeVisible();
  await mobilePanel.getByRole("checkbox", {
    name: /Append to local transparency log/,
  }).check();
  await mobilePanel.getByRole("checkbox", {
    name: /Prepare digest-only EVM calldata/,
  }).check();
  await mobilePanel.getByRole("button", { name: "Regenerate receipt" }).click();
  await expect(mobilePanel.getByText(/Local checkpoint 1/)).toBeVisible();
  for (const buttonName of [
    "Download receipt JSON",
    "Download anchor proof",
    "Download EVM payload",
  ]) {
    const mobileDownloadPromise = page.waitForEvent("download");
    await mobilePanel.getByRole("button", { name: buttonName }).click();
    const mobileDownload = await mobileDownloadPromise;
    expect(await readDownload(mobileDownload)).not.toHaveLength(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    390,
  );
});

test("fails closed while reverifying a previously accepted receipt", async ({
  page,
}) => {
  await serveProductionBundle(page, []);
  await page.goto("http://airlock.local/");

  const panel = page.getByRole("region", { name: "Portable trust receipt" });
  await panel.getByRole("button", { name: "Generate receipt" }).click();
  await expect(panel.getByText("Self-check passed", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Download receipt JSON" }),
  ).toBeEnabled();

  let releaseReverification!: () => void;
  const reverificationGate = new Promise<void>((resolve) => {
    releaseReverification = resolve;
  });
  await page.route(
    "**/api/runs/run-golden/portable-receipt",
    async (route) => {
      await reverificationGate;
      await route.fallback();
    },
  );

  await panel.getByRole("button", { name: "Regenerate receipt" }).click();
  await expect(panel.getByText("Checking receipt", { exact: true })).toBeVisible();
  await expect(panel.locator(".portable-result")).toHaveAttribute(
    "data-valid",
    "false",
  );
  await expect(
    panel.getByRole("button", { name: "Download receipt JSON" }),
  ).toBeDisabled();

  releaseReverification();
  await expect(panel.getByText("Self-check passed", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Download receipt JSON" }),
  ).toBeEnabled();
});

test("rejects downloads when browser verification contradicts the server self-check", async ({
  page,
}) => {
  await serveProductionBundle(page, [], { current: run }, undefined, system, {
    portableReceiptTransform: (exported) => {
      const tampered = structuredClone(exported);
      tampered.packet.envelope.receipt.decision.decidedAt =
        "2026-08-26T00:00:01.000Z";
      return tampered;
    },
  });
  await page.goto("http://airlock.local/");

  const panel = page.getByRole("region", { name: "Portable trust receipt" });
  await panel.getByRole("button", { name: "Generate receipt" }).click();

  await expect(
    panel.getByText("Receipt verification failed", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Self-check passed", { exact: true }),
  ).toHaveCount(0);
  await expect(panel.locator(".portable-result")).toHaveAttribute(
    "data-valid",
    "false",
  );
  await expect(
    panel.getByText("Server-reported claims not accepted locally", {
      exact: true,
    }),
  ).toBeVisible();
  for (const buttonName of [
    "Download receipt JSON",
    "Download evidence packet",
    "Download federated work",
  ]) {
    await expect(panel.getByRole("button", { name: buttonName })).toBeDisabled();
  }
});

test("presents the live ModelArk judge path as provider-backed and falsifiable", async ({
  page,
}) => {
  const liveRequests: Array<Record<string, unknown>> = [];
  const liveSystem: SystemInfo = {
    ...system,
    modelArkDemoMode: true,
    modelArkPreflight: {
      checkedAt: "2026-08-28T02:00:00.000Z",
      generatedAssistantOutput: true,
      attemptCount: 1,
      requestCount: 1,
      retryDelayMs: 0,
    },
    arkConfigured: true,
    externalActionDelivery: {
      mode: "idempotent-http",
      destination: "demo-console",
      transport: "loopback-http",
      idempotency: "receiver-enforced",
    },
    runtimeProvider: "container",
    containerEngine: "docker",
    runtime: "Codex CLI in docker Runtime",
  };
  const liveRun = structuredClone(run) as AgentRun;
  const liveCheckedAt = new Date().toISOString();
  const liveCompletedAt = new Date(Date.parse(liveCheckedAt) + 1_000).toISOString();
  liveRun.createdAt = liveCheckedAt;
  liveRun.completedAt = liveCompletedAt;
  liveRun.prompt =
    "Create modelark-proof.txt containing exactly modelark-live followed by a newline. Then use Node.js built-in node:sqlite to update the inventory row with id demo in .airlock/demo.sqlite so value is modelark-live and updated_at is 2026-08-28T00:00:00.000Z. Append exactly one demo.notification.requested JSON object to AIRLOCK_OUTBOX_PATH with id modelark-live-ready, destination demo-console, subject ModelArk release ready, and body The live Whole-Agent Candidate passed. Use no dependencies. Verify the file and database values before finishing.";
  const transaction = liveRun.transaction!;
  transaction.id = liveRun.id;
  transaction.assuranceEvidenceVersion = 1;
  transaction.candidateStateId = "candidate-modelark-live";
  transaction.quarantinePath = null;
  transaction.discardedAt = null;
  transaction.canonicalStateIdBefore = "state-modelark-before";
  transaction.canonicalStateIdAfter = "state-modelark-after";
  transaction.canonicalContentHashBefore = "sha256:" + "1".repeat(64);
  transaction.canonicalContentHashAfter = "sha256:" + "2".repeat(64);
  const liveStateValidationCommand = [
    'test "$(cat modelark-proof.txt)" = modelark-live',
    "node --no-warnings --experimental-sqlite --input-type=module -e 'import { DatabaseSync } from \"node:sqlite\"; const database = new DatabaseSync(\".airlock/demo.sqlite\"); const row = database.prepare(\"SELECT value, updated_at FROM inventory WHERE id = ?\").get(\"demo\"); database.close(); if (row?.value !== \"modelark-live\" || row?.updated_at !== \"2026-08-28T00:00:00.000Z\") process.exit(1);'",
  ].join(" && ");
  transaction.outcomeContractVersion = 1;
  transaction.outcomeContract = {
    schemaVersion: 1,
    version: 1,
    requiredPaths: ["AGENTS.md", "modelark-proof.txt"],
    protectedPaths: ["AGENTS.md"],
    maxChangedFiles: 4,
    maxAddedBytes: 65_536,
    secretPatterns: [
      {
        name: "ark-api-key-assignment",
        pattern: "ARK_API_KEY\\s*[:=]\\s*['\\\"]?[^\\s'\\\"]{8,}",
      },
      {
        name: "ark-model-api-key",
        pattern:
          "\\bark-[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}-[A-Za-z0-9]{4,}\\b",
      },
      {
        name: "bearer-token",
        pattern: "Bearer\\s+[A-Za-z0-9._~+/-]{12,}=*",
      },
    ],
    validationCommands: [
      {
        name: "modelark-live-state",
        command: liveStateValidationCommand,
        required: true,
        timeoutMs: 10_000,
      },
    ],
    createdAt: liveCheckedAt,
  };
  const liveSnapshot = {
    contentHash: "",
    rowCount: 1,
    rows: [
      {
        id: "demo",
        value: "modelark-live",
        updatedAt: "2026-08-28T00:00:00.000Z",
      },
    ],
  };
  liveSnapshot.contentHash = sha256(JSON.stringify(liveSnapshot.rows));
  const liveResources: Array<
    [
      NonNullable<AgentRun["transaction"]>["resources"][number]["kind"],
      string,
      string,
    ]
  > = [
    ["workspace", "Workspace", "sha256:" + "3".repeat(64)],
    ["codex-session", "Agent memory", "sha256:" + "4".repeat(64)],
    ["sqlite", "SQLite data", liveSnapshot.contentHash],
    ["external-actions", "External actions", ""],
  ];
  transaction.resources = liveResources.map(([kind, label, fingerprintAfter]) => ({
    kind,
    label,
    disposition: "promoted" as const,
    fingerprintBefore: "sha256:" + "0".repeat(64),
    fingerprintAfter,
    summary: kind + " promoted",
  }));
  transaction.providerResources = [];
  transaction.providerResourceEvents = [];
  transaction.sqlite = {
    databasePath: ".airlock/demo.sqlite",
    integrity: "passed",
    before: { ...liveSnapshot, contentHash: "sha256:" + "5".repeat(64) },
    candidate: liveSnapshot,
    after: liveSnapshot,
  };
  const normalizedPayload = JSON.stringify({
    destination: "demo-console",
    subject: "ModelArk release ready",
    body: "The live Whole-Agent Candidate passed.",
  });
  const liveIdempotencyKey = sha256(
    [
      liveRun.id,
      "modelark-live-ready",
      "demo.notification.requested",
      normalizedPayload,
    ].join("\0"),
  );
  const deliveredAt = liveCompletedAt;
  transaction.resources[3]!.fingerprintAfter = sha256(
    JSON.stringify([{ idempotencyKey: liveIdempotencyKey, deliveredAt }]),
  );
  transaction.externalActions = {
    outboxPath: "Candidate State/outbox/intents.jsonl",
    intents: [
      {
        id: "modelark-live-ready",
        type: "demo.notification.requested",
        destination: "demo-console",
        subject: "ModelArk release ready",
        idempotencyKey: liveIdempotencyKey,
        status: "delivered",
        deliveredAt,
      },
    ],
    deliveredCount: 1,
    bypassDisclosure: "No effect bypass is available.",
  };
  const validExecutionProfile = {
    schemaVersion: 2,
    attestation: "airlock-control-plane",
    inferenceMode: "modelark",
    executor: "codex-cli",
    runtimeProvider: "container",
    providerProtocol: "responses",
    modelCommitment: "sha256:" + "a".repeat(64),
    preflight: {
      checkedAt: liveCheckedAt,
      generatedAssistantOutput: true,
      endpointOriginCommitment: "sha256:" + "b".repeat(64),
      attemptCount: 1,
      requestCount: 1,
      retryDelayMs: 0,
    },
  };
  const liveValidationNames = [
    "path-safety",
    "protected-paths",
    "required-paths",
    "change-limits",
    "secret-patterns",
    "command:modelark-live-state",
    "sqlite-resource",
    "external-action-intents",
  ];
  transaction.validations = [
    {
      name: "execution-profile",
      status: "passed",
      required: true,
      summary:
        "A fresh provider preflight generated assistant output in 1 bounded request. Airlock control plane attested successful execution through real Codex CLI against the configured ModelArk Responses profile.",
      durationMs: 0,
      output: JSON.stringify(validExecutionProfile),
    },
    ...liveValidationNames.map((validation) => ({
      name: validation,
      status: "passed" as const,
      required: true,
      summary: validation + " passed",
      durationMs: 1,
      output: null,
    })),
  ];
  transaction.recovery = {
    journalPhase: "completed",
    recoveredAfterRestart: false,
    recoveryError: null,
  };
  transaction.promotionReceipt = {
    runTransactionId: liveRun.id,
    disposition: "promoted",
    outcomeContractVersion: transaction.outcomeContractVersion,
    canonicalStateIdBefore: transaction.canonicalStateIdBefore,
    canonicalStateIdAfter: transaction.canonicalStateIdAfter!,
    canonicalContentHashBefore: transaction.canonicalContentHashBefore,
    canonicalContentHashAfter: transaction.canonicalContentHashAfter!,
    validationEvidenceHash: "sha256:" + "6".repeat(64),
    lineage: transaction.lineage,
    createdAt: liveCompletedAt,
  };
  const liveExecutionProfile = transaction.validations[0]!;
  const validLiveRun = structuredClone(liveRun);
  const liveRunState = { current: liveRun };
  await serveProductionBundle(
    page,
    liveRequests,
    liveRunState,
    undefined,
    liveSystem,
    { origin: "http://localhost" },
  );
  await page.goto("http://localhost/");

  await expect(
    page.getByText("AIRLOCK-ATTESTED MODELARK RUN", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Fresh preflight generated assistant output in 1 bounded request/),
  ).toBeVisible();
  const guide = page.getByRole("region", { name: "Live ModelArk proof" });
  await expect(guide.getByText("Model decides. Contract verifies.")).toBeVisible();
  await expect(
    guide.getByText("Airlock-attested live execution", { exact: true }),
  ).toBeVisible();
  await expect(guide.getByRole("button", { name: /Run another live Candidate/ }))
    .toBeVisible();
  await expect(guide.getByText("Preflight + Runtime bound")).toBeVisible();
  await expect(
    guide.getByText("Airlock attested preflight, Runtime profile, and Promotion"),
  ).toBeVisible();
  await expect(
    guide.locator(`[data-airlock-run-id="${liveRun.id}"]`),
  ).toBeVisible();
  await expect(page.getByText(/not BytePlus-signed telemetry/)).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Promotion complete: one validated Whole-Agent future became reality",
    }),
  ).toBeVisible();
  await expect(page.getByText("Independent proof")).toBeVisible();
  const liveProof = page.getByRole("region", { name: "Judge proof summary" });
  await expect(liveProof.getByText("4/4 resources promoted", { exact: true }))
    .toBeVisible();
  await expect(liveProof.getByText("Effect released after Promotion", { exact: true }))
    .toBeVisible();
  await expect(liveProof.getByText("1 typed effect delivered only after Canonical State advanced."))
    .toBeVisible();

  await guide.getByRole("button", { name: /Run another live Candidate/ }).click();
  await expect.poll(() => liveRequests.length).toBe(1);
  expect(liveRequests[0]).toEqual({
    content: "Create modelark-proof.txt containing exactly modelark-live followed by a newline. Then use Node.js built-in node:sqlite to update the inventory row with id demo in .airlock/demo.sqlite so value is modelark-live and updated_at is 2026-08-28T00:00:00.000Z. Append exactly one demo.notification.requested JSON object to AIRLOCK_OUTBOX_PATH with id modelark-live-ready, destination demo-console, subject ModelArk release ready, and body The live Whole-Agent Candidate passed. Use no dependencies. Verify the file and database values before finishing.",
  });

  const invalidProfiles = [
    { ...validExecutionProfile, unexpected: true },
    { ...validExecutionProfile, executor: "other" },
    { ...validExecutionProfile, runtimeProvider: "local-process" },
    { ...validExecutionProfile, providerProtocol: "chat-completions" },
    {
      ...validExecutionProfile,
      preflight: {
        ...validExecutionProfile.preflight,
        checkedAt: "2020-01-01T00:00:00.000Z",
      },
    },
    {
      ...validExecutionProfile,
      preflight: {
        ...validExecutionProfile.preflight,
        checkedAt: "2026-08-29T08:00:00.000+08:00",
      },
    },
    {
      ...validExecutionProfile,
      preflight: { ...validExecutionProfile.preflight, attemptCount: 0 },
    },
    {
      ...validExecutionProfile,
      preflight: { ...validExecutionProfile.preflight, requestCount: 0 },
    },
    {
      ...validExecutionProfile,
      preflight: { ...validExecutionProfile.preflight, retryDelayMs: 15_001 },
    },
    {
      ...validExecutionProfile,
      preflight: {
        ...validExecutionProfile.preflight,
        generatedAssistantOutput: false,
      },
    },
  ];
  for (const invalidProfile of invalidProfiles) {
    liveExecutionProfile.output = JSON.stringify(invalidProfile);
    await page.reload();
    const unboundGuide = page.getByRole("region", {
      name: "Live ModelArk proof",
    });
    await expect(
      unboundGuide.getByText("Promotion complete; provider binding unavailable"),
    ).toBeVisible();
  }

  liveExecutionProfile.required = false;
  liveExecutionProfile.output = JSON.stringify(validExecutionProfile);
  await page.reload();
  const unboundGuide = page.getByRole("region", { name: "Live ModelArk proof" });
  await expect(
    unboundGuide.getByText(/cannot attest that Run to the live provider/),
  ).toBeVisible();
  await expect(
    unboundGuide.getByText("Live-provider Promotion attested by Airlock"),
  ).toHaveCount(0);

  const semanticDrifts: Array<(candidate: AgentRun) => void> = [
    (candidate) => {
      candidate.prompt = "Perform a different ModelArk task.";
    },
    (candidate) => {
      candidate.transaction!.outcomeContract.maxChangedFiles = 5;
    },
    (candidate) => {
      const validations = candidate.transaction!.validations;
      [validations[1], validations[2]] = [validations[2]!, validations[1]!];
    },
    (candidate) => {
      candidate.transaction!.resources[0]!.label = "Generic workspace";
    },
    (candidate) => {
      candidate.transaction!.sqlite!.after!.rows[0]!.value = "other";
    },
    (candidate) => {
      candidate.transaction!.externalActions.intents[0]!.idempotencyKey =
        "sha256:" + "f".repeat(64);
    },
    (candidate) => {
      candidate.transaction!.recovery.journalPhase = "canonical-advanced";
    },
    (candidate) => {
      candidate.transaction!.promotionReceipt!.canonicalStateIdAfter =
        "state-other";
    },
    (candidate) => {
      candidate.transaction!.canonicalStateIdAfter =
        candidate.transaction!.canonicalStateIdBefore;
    },
  ];
  for (const mutate of semanticDrifts) {
    const driftedRun = structuredClone(validLiveRun);
    mutate(driftedRun);
    liveRunState.current = driftedRun;
    await page.reload();
    const driftedGuide = page.getByRole("region", {
      name: "Live ModelArk proof",
    });
    await expect(
      driftedGuide.getByText("Promotion complete; provider binding unavailable"),
    ).toBeVisible();
    await expect(driftedGuide.getByText("Preflight + Runtime bound")).toHaveCount(0);
  }
});

test("invalidates a generated receipt when the Run decision changes", async ({
  page,
}) => {
  const quarantined = structuredClone(run);
  quarantined.transaction!.status = "quarantined";
  quarantined.transaction!.disposition = "quarantined";
  quarantined.transaction!.quarantineAvailable = true;
  quarantined.transaction!.promotionReceipt = {
    ...quarantined.transaction!.promotionReceipt!,
    disposition: "quarantined",
    createdAt: "2026-08-26T02:00:01.000Z",
  } as NonNullable<AgentRun["transaction"]>["promotionReceipt"];
  const runState = { current: quarantined };
  await serveProductionBundle(page, [], runState);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("http://airlock.local/");

  const panel = page.getByRole("region", { name: "Portable trust receipt" });
  await panel.getByRole("button", { name: "Generate receipt" }).click();
  await expect(panel.getByRole("button", { name: "Download receipt JSON" }))
    .toBeEnabled();
  await page.getByRole("button", { name: "Discard Quarantine" }).click();

  await expect(page.getByRole("heading", { name: "Discarded" })).toBeVisible();
  const refreshedPanel = page.getByRole("region", { name: "Portable trust receipt" });
  await expect(refreshedPanel.getByRole("button", { name: "Generate receipt" }))
    .toBeVisible();
  await expect(
    refreshedPanel.getByRole("button", { name: "Download receipt JSON" }),
  ).toHaveCount(0);
});

test("focuses a historical repaired Run and retries its proof after a transient failure", async ({
  page,
}) => {
  const safeRun = structuredClone(run);
  safeRun.id = "run-safe";
  safeRun.createdAt = "2026-08-26T02:00:00.000Z";
  safeRun.transaction!.id = "transaction-safe";
  safeRun.transaction!.lineage = {
    rootRunId: safeRun.id,
    parentRunId: null,
    depth: 0,
    maxDepth: 3,
  };
  const resourceKinds: Array<
    NonNullable<AgentRun["transaction"]>["resources"][number]["kind"]
  > = [
    "workspace",
    "codex-session",
    "sqlite",
    "external-actions",
  ];
  safeRun.transaction!.resources = resourceKinds.map((kind) => ({
    kind,
    label: kind,
    disposition: "promoted" as const,
    fingerprintBefore: "sha256:" + "a".repeat(64),
    fingerprintAfter: "sha256:" + "b".repeat(64),
    summary: `${kind} promoted.`,
  }));
  safeRun.transaction!.sqlite = {
    databasePath: ".airlock/demo.sqlite",
    integrity: "passed",
    before: null,
    candidate: null,
    after: {
      contentHash: "sha256:" + "b".repeat(64),
      rowCount: 1,
      rows: [
        {
          id: "demo",
          value: "candidate-only",
          updatedAt: timestamp,
        },
      ],
    },
  };
  safeRun.transaction!.externalActions = {
    outboxPath: "outbox/intents.jsonl",
    intents: [
      {
        id: "safe-effect",
        type: "demo.notification.requested",
        destination: "demo-console",
        subject: "Safe release",
        idempotencyKey: "safe-effect-key",
        status: "delivered",
        deliveredAt: timestamp,
      },
    ],
    deliveredCount: 1,
    bypassDisclosure: "No effect bypass is available.",
  };

  const unsafeRun = structuredClone(run);
  unsafeRun.id = "run-unsafe";
  unsafeRun.createdAt = "2026-08-26T02:00:01.000Z";
  unsafeRun.transaction!.id = "transaction-unsafe";
  unsafeRun.transaction!.status = "quarantined";
  unsafeRun.transaction!.disposition = "quarantined";
  unsafeRun.transaction!.canonicalStateIdAfter =
    unsafeRun.transaction!.canonicalStateIdBefore;
  unsafeRun.transaction!.canonicalContentHashAfter =
    unsafeRun.transaction!.canonicalContentHashBefore;
  unsafeRun.transaction!.quarantineAvailable = true;
  unsafeRun.transaction!.lineage = {
    rootRunId: unsafeRun.id,
    parentRunId: null,
    depth: 0,
    maxDepth: 3,
  };

  const repairedRun = structuredClone(run);
  repairedRun.id = "run-repaired";
  repairedRun.createdAt = "2026-08-26T02:00:02.000Z";
  repairedRun.transaction!.id = "transaction-repaired";
  repairedRun.transaction!.lineage = {
    rootRunId: unsafeRun.id,
    parentRunId: unsafeRun.id,
    depth: 1,
    maxDepth: 3,
  };

  const requests: Array<Record<string, unknown>> = [];
  const transientFailures = { remaining: 1 };
  await serveProductionBundle(
    page,
    requests,
    { current: safeRun },
    undefined,
    {
      ...system,
      protocolFixtureMode: true,
      inferenceMode: "local-responses-protocol-fixture",
    },
    {
      origin: "http://localhost",
      runs: [safeRun, repairedRun, unsafeRun],
      portableReceiptFailures: transientFailures,
    },
  );
  await page.goto("http://localhost/");

  const guide = page.getByRole("region", { name: "Full safety loop" });
  await expect.poll(() => requests.length).toBe(0);
  await expect(
    guide.getByRole("button", { name: "Verify signed recovery" }),
  ).toBeVisible();

  await guide.getByRole("button", { name: "Verify signed recovery" }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(
    guide.getByRole("button", { name: "Retry signed verification" }),
  ).toBeVisible();

  await guide.getByRole("button", { name: "Retry signed verification" }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(guide.getByText("Signed recovery verified", { exact: true }))
    .toBeVisible();
  await expect(
    page.getByText("Portable proof service is temporarily unavailable.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await page.waitForTimeout(250);
  expect(requests).toHaveLength(2);
});

test("stops an in-flight safety loop when the operator switches Agents", async ({
  page,
}) => {
  const safeRun = structuredClone(run);
  safeRun.id = "run-agent-switch-safe";
  safeRun.agentId = agent.id;
  safeRun.transaction!.resources = (
    ["workspace", "codex-session", "sqlite", "external-actions"] as const
  ).map((kind) => ({
    kind,
    label: kind,
    disposition: "promoted" as const,
    fingerprintBefore: "sha256:" + "a".repeat(64),
    fingerprintAfter: "sha256:" + "b".repeat(64),
    summary: `${kind} promoted.`,
  }));
  safeRun.transaction!.sqlite = {
    databasePath: ".airlock/demo.sqlite",
    integrity: "passed",
    before: null,
    candidate: null,
    after: {
      contentHash: "sha256:" + "b".repeat(64),
      rowCount: 1,
      rows: [{ id: "demo", value: "candidate-only", updatedAt: timestamp }],
    },
  };
  safeRun.transaction!.externalActions = {
    outboxPath: "outbox/intents.jsonl",
    intents: [
      {
        id: "agent-switch-safe-effect",
        type: "demo.notification.requested",
        destination: "demo-console",
        subject: "Safe release",
        idempotencyKey: "agent-switch-safe-effect-key",
        status: "delivered",
        deliveredAt: timestamp,
      },
    ],
    deliveredCount: 1,
    bypassDisclosure: "No effect bypass is available.",
  };
  const secondAgent: Agent = {
    ...agent,
    id: "22222222-2222-4222-8222-222222222222",
    name: "Second guardian",
    workspacePath: "/bounded/second-workspace",
    canonicalStateId: "second-state",
    codexThreadId: "thread-second",
  };
  const requests: Array<Record<string, unknown>> = [];
  await serveProductionBundle(
    page,
    requests,
    { current: safeRun },
    undefined,
    {
      ...system,
      protocolFixtureMode: true,
      inferenceMode: "local-responses-protocol-fixture",
    },
    {
      agents: [agent, secondAgent],
      runs: [safeRun],
      runsByAgentId: {
        [agent.id]: [],
        [secondAgent.id]: [],
      },
    },
  );
  await page.goto("http://airlock.local/");

  const guide = page.getByRole("region", { name: "Full safety loop" });
  await guide.getByRole("button", { name: "Run complete safety loop" }).click();
  await expect.poll(() => requests.length).toBe(1);
  const secondAgentButton = page.getByRole("button", {
    name: /Second guardian/,
  });
  await secondAgentButton.click();
  await expect(secondAgentButton).toHaveClass(/selected/);

  await page.waitForTimeout(1_250);
  expect(requests).toHaveLength(1);
  await expect(page.locator(`[data-airlock-run-id="${safeRun.id}"]`))
    .toHaveCount(0);
  await expect(page.getByText("Verifying signed recovery", { exact: true }))
    .toHaveCount(0);
});

test("ignores a delayed receipt response after the Run decision changes", async ({
  page,
}) => {
  const quarantined = structuredClone(run);
  quarantined.transaction!.status = "quarantined";
  quarantined.transaction!.disposition = "quarantined";
  quarantined.transaction!.quarantineAvailable = true;
  quarantined.transaction!.promotionReceipt = {
    ...quarantined.transaction!.promotionReceipt!,
    disposition: "quarantined",
    createdAt: "2026-08-26T02:00:01.000Z",
  } as NonNullable<AgentRun["transaction"]>["promotionReceipt"];
  const runState = { current: quarantined };
  let releaseExport!: () => void;
  const exportGate = new Promise<void>((resolve) => {
    releaseExport = resolve;
  });
  await serveProductionBundle(page, [], runState, exportGate);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("http://airlock.local/");

  const panel = page.getByRole("region", { name: "Portable trust receipt" });
  await panel.getByRole("button", { name: "Generate receipt" }).click();
  await expect(panel.getByRole("button", { name: "Loading" })).toBeVisible();
  await page.getByRole("button", { name: "Discard Quarantine" }).click();
  await expect(page.getByRole("heading", { name: "Discarded" })).toBeVisible();

  const delayedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        "/api/runs/run-golden/portable-receipt",
  );
  releaseExport();
  await delayedResponse;
  const refreshedPanel = page.getByRole("region", {
    name: "Portable trust receipt",
  });
  await expect(refreshedPanel.getByText("Self-check passed")).toHaveCount(0);
  await expect(
    refreshedPanel.getByRole("button", { name: "Download receipt JSON" }),
  ).toHaveCount(0);
});

async function readDownload(
  download: Download,
): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function serveProductionBundle(
  page: Page,
  requests: Array<Record<string, unknown>>,
  runState: { current: AgentRun } = { current: run },
  exportGate?: Promise<void>,
  systemState: SystemInfo = system,
  options: {
    origin?: string;
    runs?: AgentRun[];
    agents?: Agent[];
    runsByAgentId?: Record<string, AgentRun[]>;
    portableReceiptFailures?: { remaining: number };
    portableReceiptTransform?: (
      exported: PortableReceiptExport,
    ) => PortableReceiptExport;
  } = {},
): Promise<void> {
  const origin = options.origin ?? "http://airlock.local";
  await page.route(`${origin}/**`, async (route) => {
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
      route.request().method() === "POST" &&
      url.pathname.endsWith("/messages")
    ) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const requestedAgentId =
        url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/)?.[1] ??
        agent.id;
      requests.push(body);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          run: runState.current,
          message: {
            id: "message-live",
            agentId: requestedAgentId,
            role: "user",
            content: body.content,
            createdAt: timestamp,
          },
        }),
      });
      return;
    }
    const portableReceiptRunIds = new Set(
      (options.runs ?? [runState.current]).map((candidate) => candidate.id),
    );
    const portableReceiptRunId = url.pathname.match(
      /^\/api\/runs\/([^/]+)\/portable-receipt$/,
    )?.[1];
    if (
      route.request().method() === "POST" &&
      portableReceiptRunId !== undefined &&
      portableReceiptRunIds.has(portableReceiptRunId)
    ) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      requests.push(body);
      const portableReceiptFailures = options.portableReceiptFailures;
      if (portableReceiptFailures && portableReceiptFailures.remaining > 0) {
        portableReceiptFailures.remaining -= 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Portable proof service is temporarily unavailable." }),
        });
        return;
      }
      await exportGate;
      const portableReceipt = portableExport(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          options.portableReceiptTransform?.(portableReceipt) ??
            portableReceipt,
        ),
      });
      return;
    }
    if (
      route.request().method() === "POST" &&
      url.pathname === "/api/runs/run-golden/federated-work-bundle"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          bundle: {
            schema: "agent-airlock/federated-work-bundle",
            schemaVersion: 1,
          },
          verification: {
            valid: true,
            receiptDigest: goldenDocument.envelope.receiptDigest,
            artifactDigest: "sha256:" + "f".repeat(64),
          },
        }),
      });
      return;
    }
    if (
      route.request().method() === "POST" &&
      url.pathname === "/api/runs/run-golden/discard"
    ) {
      const discarded = structuredClone(runState.current);
      discarded.transaction!.status = "discarded";
      discarded.transaction!.disposition = "discarded";
      discarded.transaction!.quarantineAvailable = false;
      discarded.transaction!.promotionReceipt = {
        ...discarded.transaction!.promotionReceipt!,
        disposition: "discarded",
        createdAt: "2026-08-26T02:00:02.000Z",
      } as NonNullable<AgentRun["transaction"]>["promotionReceipt"];
      runState.current = discarded;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run: discarded }),
      });
      return;
    }
    const response = apiResponse(
      url.pathname,
      runState.current,
      systemState,
      options.runs,
      options.agents,
      options.runsByAgentId,
    );
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

function apiResponse(
  pathname: string,
  activeRun: AgentRun,
  systemState: SystemInfo,
  runs: AgentRun[] = [activeRun],
  agents: Agent[] = [agent],
  runsByAgentId?: Record<string, AgentRun[]>,
): unknown {
  if (pathname === "/api/auth") return { required: false };
  if (pathname === "/api/system") return systemState;
  if (pathname === "/api/agents") return { agents };
  if (pathname.endsWith("/messages")) return { messages: [] };
  const agentRunsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/runs$/);
  if (agentRunsMatch) {
    return { runs: runsByAgentId?.[agentRunsMatch[1]!] ?? runs };
  }
  if (pathname === `/api/runs/${activeRun.id}`) return { run: activeRun };
  if (pathname.endsWith("/candidate-sets")) return { candidateSets: [] };
  if (pathname.endsWith("/assurance-proposals")) return { proposals: [] };
  if (pathname.endsWith("/outcome-contract/versions")) return { versions: [] };
  return null;
}

function portableExport(body: Record<string, unknown>): PortableReceiptExport {
  const includeDisclosure =
    Array.isArray(body.disclosureIdentities) && body.disclosureIdentities.length > 0;
  const envelope = structuredClone(goldenDocument.envelope);
  if (!includeDisclosure) envelope.disclosures = [];
  const anchor = body.localAnchor
    ? {
        checkpoint: {
          checkpoint: {
            treeSize: 1,
            root: "sha256:" + "2".repeat(64),
            keyId: "sha256:" + "3".repeat(64),
          },
          checkpointDigest: "sha256:" + "4".repeat(64),
        },
        inclusionProof: { leafIndex: 0, treeSize: 1 },
      }
    : null;
  const evmPayload = body.evmPayload
    ? {
        methodSignature: "anchor(bytes32)" as const,
        functionSelector: "0xeecdf927",
        receiptDigest: envelope.receiptDigest,
        calldata: "0xeecdf927" + "18".repeat(32),
        privacyClaim: "receipt-digest-only" as const,
        networkCalls: 0 as const,
        fundsSpent: 0 as const,
      }
    : null;
  return {
    envelope,
    verification: {
      valid: true,
      checks: [{ name: "signature", valid: true, detail: "Valid Ed25519 signature." }],
      commitments: {
        resources: 1,
        outcomeContract: true,
        validationEvidence: true,
        externalActions: true,
        selection: false,
        assurance: false,
        ancestry: true,
      },
      provenClaims: [
        "The receipt content has the reported SHA-256 digest.",
        "The included Ed25519 key signed the domain-separated receipt digest.",
      ],
      unsupportedClaims: [
        "The verifier does not prove that Runtime isolation was sufficient.",
        "The verifier does not assign organizational trust to the signing key.",
      ],
    },
    availableDisclosureIdentities: [
      "validation:required-paths",
      "validation:optional-check",
    ],
    availableDisclosures: [
      {
        identity: "validation:required-paths",
        category: "validation",
        status: "passed",
        required: true,
        summary: "Required public artifacts are present.",
      },
      {
        identity: "validation:optional-check",
        category: "validation",
        status: "passed",
        required: false,
        summary: "Optional operator evidence is available.",
      },
    ],
    anchor,
    evmPayload,
    packet: {
      schema: "agent-airlock/portable-evidence-packet",
      schemaVersion: 1,
      envelope,
      anchor,
      evmPayload,
    } as unknown as PortableReceiptExport["packet"],
    decisionChain: null,
  };
}
