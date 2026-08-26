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
    panel.getByRole("heading", { name: "Carry the decision proof beyond this server" }),
  ).toBeVisible();
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
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    390,
  );
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
      url.pathname === "/api/runs/run-golden/portable-receipt"
    ) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      requests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(portableExport(body)),
      });
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
  if (pathname.endsWith("/runs")) return { runs: [run] };
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
    anchor: body.localAnchor
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
      : null,
    evmPayload: body.evmPayload
      ? {
          methodSignature: "anchor(bytes32)",
          functionSelector: "0xeecdf927",
          receiptDigest: envelope.receiptDigest,
          calldata: "0xeecdf927" + "18".repeat(32),
          privacyClaim: "receipt-digest-only",
          networkCalls: 0,
          fundsSpent: 0,
        }
      : null,
  };
}
