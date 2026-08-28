import { expect, test, type Download, type Page } from "@playwright/test";
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
  inferenceMode: "modelark",
  arkConfigured: false,
  arkBaseUrl: "https://ark.example.invalid",
  arkModel: null,
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

  await panel.getByText(/Selectively disclose Validation evidence/).click();
  await panel.getByRole("checkbox", { name: /passed required/ }).check();
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
  await mobilePanel.getByText(/Selectively disclose Validation evidence/).click();
  await mobilePanel.getByRole("checkbox", { name: /passed required/ }).check();
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

test("presents the live ModelArk judge path as provider-backed and falsifiable", async ({
  page,
}) => {
  const liveRequests: Array<Record<string, unknown>> = [];
  const liveSystem: SystemInfo = {
    ...system,
    modelArkDemoMode: true,
    arkConfigured: true,
    arkModel: "ep-live-model",
    runtimeProvider: "container",
    containerEngine: "docker",
    runtime: "Codex CLI in docker Runtime",
  };
  const liveRun = structuredClone(run) as AgentRun;
  liveRun.transaction!.resources = [
    "workspace",
    "codex-session",
    "sqlite",
    "external-actions",
  ].map((kind) => ({
    kind: kind as NonNullable<AgentRun["transaction"]>["resources"][number]["kind"],
    label: kind,
    disposition: "promoted" as const,
    fingerprintBefore: "a".repeat(64),
    fingerprintAfter: "b".repeat(64),
    summary: kind + " promoted",
  }));
  const liveSnapshot = {
    contentHash: "c".repeat(64),
    rowCount: 1,
    rows: [
      {
        id: "demo",
        value: "modelark-live",
        updatedAt: "2026-08-28T00:00:00.000Z",
      },
    ],
  };
  liveRun.transaction!.sqlite = {
    databasePath: ".airlock/demo.sqlite",
    integrity: "passed",
    before: { ...liveSnapshot, contentHash: "d".repeat(64) },
    candidate: liveSnapshot,
    after: liveSnapshot,
  };
  liveRun.transaction!.externalActions = {
    outboxPath: "outbox/intents.jsonl",
    intents: [
      {
        id: "modelark-live-ready",
        type: "demo.notification.requested",
        destination: "demo-console",
        subject: "ModelArk release ready",
        idempotencyKey: "e".repeat(64),
        status: "delivered",
        deliveredAt: timestamp,
      },
    ],
    deliveredCount: 1,
    bypassDisclosure: "No effect bypass is available.",
  };
  await serveProductionBundle(
    page,
    liveRequests,
    { current: liveRun },
    undefined,
    liveSystem,
  );
  await page.goto("http://airlock.local/");

  await expect(page.getByText("LIVE MODELARK PROOF", { exact: true })).toBeVisible();
  const guide = page.getByRole("region", { name: "Live ModelArk proof" });
  await expect(guide.getByText("Model decides. Contract verifies.")).toBeVisible();
  await expect(guide.getByRole("button", { name: /Run another live Candidate/ }))
    .toBeVisible();
  await expect(guide.getByText("Live profile attested")).toBeVisible();
  await expect(guide.getByText("ModelArk profile and Promotion proven")).toBeVisible();
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
      route.request().method() === "POST" &&
      url.pathname.endsWith("/messages")
    ) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      requests.push(body);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          run: runState.current,
          message: {
            id: "message-live",
            agentId: agent.id,
            role: "user",
            content: body.content,
            createdAt: timestamp,
          },
        }),
      });
      return;
    }
    if (
      route.request().method() === "POST" &&
      url.pathname === "/api/runs/run-golden/portable-receipt"
    ) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      requests.push(body);
      await exportGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(portableExport(body)),
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
    const response = apiResponse(url.pathname, runState.current, systemState);
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
): unknown {
  if (pathname === "/api/auth") return { required: false };
  if (pathname === "/api/system") return systemState;
  if (pathname === "/api/agents") return { agents: [agent] };
  if (pathname.endsWith("/messages")) return { messages: [] };
  if (pathname.endsWith("/runs")) return { runs: [activeRun] };
  if (pathname === "/api/runs/run-golden") return { run: activeRun };
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
    availableDisclosureIdentities: ["validation:required-paths"],
    availableDisclosures: [
      {
        identity: "validation:required-paths",
        category: "validation",
        status: "passed",
        required: true,
        summary: "Required public artifacts are present.",
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
  };
}
