#!/usr/bin/env node

import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
  realRuntimeProofAgentDescription,
  realRuntimeProofAgentInstructions,
  realRuntimeProofContract,
  productionImageBoundaryPrompt,
} from "./runtime-demo-profile.mjs";
import { requireLoopbackOrigin } from "./check-production-image-browser.mjs";

const agentName = "Production Image Container Proof";
const promotionStartSummary = "All required Validations passed";
const canonicalAdvanceSummary =
  "Canonical State advanced before external action delivery";
const promotionCompleteSummary = "Candidate State is now Canonical State";
const proofSchema = "agent-airlock-production-image-transaction-proof/v1";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const maximumApiResponseBytes = 8 * 1024 * 1024;
const maximumProofBytes = 32 * 1024;
const apiRequestTimeoutMilliseconds = 10_000;
const terminalRunStatuses = new Set(["completed", "failed", "cancelled"]);
const expectedResourceKinds = [
  "codex-session",
  "external-actions",
  "sqlite",
  "workspace",
];
const expectedRequiredValidationNames = [
  "change-limits",
  "command:protocol-content",
  "execution-profile",
  "external-action-intents",
  "path-safety",
  "protected-paths",
  "required-paths",
  "secret-patterns",
  "sqlite-resource",
];
const protocolFixtureExecutionSummary =
  "Airlock control plane attested successful execution through real Codex CLI against the local Responses protocol fixture.";

export class ProductionImageTransactionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProductionImageTransactionError";
  }
}

export async function openCompleteTransactionEvidence(evidence) {
  const completeEvidence = evidence.locator("details.judge-evidence-details");
  if ((await completeEvidence.count()) !== 1) {
    fail("Rendered transaction evidence disclosure is missing or ambiguous");
  }
  const summary = completeEvidence
    .locator("summary")
    .getByText("Inspect complete transaction evidence", { exact: true });
  await summary.waitFor({ state: "visible", timeout: 20_000 });
  if (!(await completeEvidence.evaluate((element) => element.open))) {
    await summary.click();
  }
  if (!(await completeEvidence.evaluate((element) => element.open))) {
    fail("Rendered transaction evidence disclosure did not open");
  }
}

function fail(message) {
  throw new ProductionImageTransactionError(message);
}

function finiteTimestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function exactResourceEvidence(transaction) {
  if (!Array.isArray(transaction?.resources)) return false;
  const resources = transaction.resources
    .map((resource) => ({
      disposition: resource?.disposition,
      kind: resource?.kind,
    }))
    .sort((left, right) => String(left.kind).localeCompare(String(right.kind)));
  return (
    resources.length === expectedResourceKinds.length &&
    resources.every(
      (resource, index) =>
        resource.kind === expectedResourceKinds[index] &&
        resource.disposition === "promoted",
    )
  );
}

function exactCanonicalAdvanceChronology(transaction, runCompletedAt) {
  const promotionStarts = transaction?.events?.filter(
    (event) =>
      event?.status === "promoting" && event?.summary === promotionStartSummary,
  );
  const canonicalAdvances = transaction?.events?.filter(
    (event) =>
      event?.status === "promoting" &&
      event?.summary === canonicalAdvanceSummary,
  );
  const promotions = transaction?.events?.filter(
    (event) =>
      event?.status === "promoted" &&
      event?.summary === promotionCompleteSummary,
  );
  const intent = transaction?.externalActions?.intents?.[0];
  if (
    promotionStarts?.length !== 1 ||
    canonicalAdvances?.length !== 1 ||
    promotions?.length !== 1
  ) {
    return false;
  }
  const timestamps = [
    finiteTimestamp(promotionStarts[0].at),
    finiteTimestamp(canonicalAdvances[0].at),
    finiteTimestamp(intent?.deliveredAt),
    finiteTimestamp(promotions[0].at),
    finiteTimestamp(runCompletedAt),
  ];
  const startIndex = transaction.events.indexOf(promotionStarts[0]);
  const canonicalIndex = transaction.events.indexOf(canonicalAdvances[0]);
  const promotedIndex = transaction.events.indexOf(promotions[0]);
  return (
    timestamps.every((timestamp) => timestamp !== null) &&
    startIndex < canonicalIndex &&
    canonicalIndex < promotedIndex &&
    timestamps[0] <= timestamps[1] &&
    timestamps[1] <= timestamps[2] &&
    timestamps[2] <= timestamps[3] &&
    timestamps[3] <= timestamps[4]
  );
}

function exactContract(transaction) {
  const contract = transaction?.outcomeContract;
  return (
    Number.isSafeInteger(transaction?.outcomeContractVersion) &&
    transaction.outcomeContractVersion >= 2 &&
    contract?.version === transaction.outcomeContractVersion &&
    JSON.stringify({
      requiredPaths: contract?.requiredPaths,
      protectedPaths: contract?.protectedPaths,
      maxChangedFiles: contract?.maxChangedFiles,
      maxAddedBytes: contract?.maxAddedBytes,
      secretPatterns: contract?.secretPatterns,
      validationCommands: contract?.validationCommands,
    }) === JSON.stringify(realRuntimeProofContract)
  );
}

function exactValidationEvidence(transaction) {
  const required = transaction?.validations?.filter(
    (validation) => validation?.required === true,
  );
  const executionProfile = required?.find(
    (validation) => validation?.name === "execution-profile",
  );
  let executionAttestation;
  try {
    executionAttestation = JSON.parse(executionProfile?.output ?? "");
  } catch {
    return false;
  }
  return (
    Array.isArray(required) &&
    required.length === expectedRequiredValidationNames.length &&
    required.every((validation) => validation?.status === "passed") &&
    JSON.stringify(required.map((validation) => validation?.name).sort()) ===
      JSON.stringify(expectedRequiredValidationNames) &&
    executionProfile?.summary?.includes(protocolFixtureExecutionSummary) &&
    !executionProfile.summary.toLowerCase().includes("modelark") &&
    executionAttestation?.schemaVersion === 2 &&
    executionAttestation?.attestation === "airlock-control-plane" &&
    executionAttestation?.inferenceMode ===
      "local-responses-protocol-fixture" &&
    executionAttestation?.executor === "codex-cli" &&
    executionAttestation?.runtimeProvider === "local-process" &&
    executionAttestation?.providerProtocol === "responses" &&
    sha256Pattern.test(executionAttestation?.modelCommitment ?? "") &&
    executionAttestation?.preflight === null
  );
}

function exactWorkspaceEvidence(transaction) {
  const files = transaction?.changes?.files;
  const sqlite = transaction?.sqlite;
  const exactSnapshot = (snapshot, value, updatedAt) =>
    sha256Pattern.test(snapshot?.contentHash ?? "") &&
    snapshot?.rowCount === 1 &&
    Array.isArray(snapshot?.rows) &&
    snapshot.rows.length === 1 &&
    JSON.stringify(Object.keys(snapshot.rows[0] ?? {}).sort()) ===
      JSON.stringify(["id", "updatedAt", "value"]) &&
    snapshot.rows[0].id === "demo" &&
    snapshot.rows[0].value === value &&
    snapshot.rows[0].updatedAt === updatedAt;
  return (
    transaction?.changes?.truncated === false &&
    Array.isArray(files) &&
    files.some((change) => change?.path === "protocol-proof.txt") &&
    files.some((change) => change?.path === ".airlock/demo.sqlite") &&
    sqlite?.databasePath === ".airlock/demo.sqlite" &&
    sqlite?.integrity === "passed" &&
    exactSnapshot(sqlite.before, "ready", "1970-01-01T00:00:00.000Z") &&
    exactSnapshot(
      sqlite.candidate,
      "candidate-only",
      "2026-08-28T00:00:00.000Z",
    ) &&
    exactSnapshot(sqlite.after, "candidate-only", "2026-08-28T00:00:00.000Z") &&
    JSON.stringify(sqlite.candidate) === JSON.stringify(sqlite.after)
  );
}

function exactExternalEffect(transaction, runCompletedAt) {
  const effects = transaction?.externalActions;
  const intent = effects?.intents?.[0];
  return (
    effects?.deliveredCount === 1 &&
    Array.isArray(effects?.intents) &&
    effects.intents.length === 1 &&
    intent?.id === "protocol-release-ready" &&
    intent?.type === "demo.notification.requested" &&
    intent?.destination === "demo-console" &&
    intent?.subject === "Protocol release ready" &&
    intent?.status === "delivered" &&
    sha256Pattern.test(intent?.idempotencyKey ?? "") &&
    exactCanonicalAdvanceChronology(transaction, runCompletedAt)
  );
}

function exactReceiptChronology(transaction, runCompletedAt) {
  const intent = transaction?.externalActions?.intents?.[0];
  const receipt = transaction?.promotionReceipt;
  const promotions = transaction?.events?.filter(
    (event) =>
      event?.status === "promoted" &&
      event?.summary === promotionCompleteSummary,
  );
  if (promotions?.length !== 1) return false;
  const timestamps = [
    finiteTimestamp(intent?.deliveredAt),
    finiteTimestamp(receipt?.createdAt),
    finiteTimestamp(promotions[0].at),
    finiteTimestamp(runCompletedAt),
  ];
  return (
    timestamps.every((timestamp) => timestamp !== null) &&
    timestamps[0] <= timestamps[1] &&
    timestamps[1] <= timestamps[2] &&
    timestamps[2] <= timestamps[3]
  );
}

export function assertProductionImageTransaction({ agent, effects, run } = {}) {
  const transaction = run?.transaction;
  const receipt = transaction?.promotionReceipt;
  const intent = transaction?.externalActions?.intents?.[0];
  const effect = effects?.[0];
  if (
    !uuidPattern.test(agent?.id ?? "") ||
    agent?.name !== agentName ||
    agent?.status !== "ready" ||
    !uuidPattern.test(run?.id ?? "") ||
    run?.agentId !== agent.id ||
    transaction?.id !== run.id ||
    run?.status !== "completed" ||
    run?.output !==
      "Protocol fixture completed the requested Candidate edit." ||
    run?.error !== null ||
    finiteTimestamp(run?.completedAt) === null ||
    transaction?.status !== "promoted" ||
    transaction?.disposition !== "promoted" ||
    !uuidPattern.test(transaction?.candidateStateId ?? "") ||
    !uuidPattern.test(transaction?.canonicalStateIdBefore ?? "") ||
    !uuidPattern.test(transaction?.canonicalStateIdAfter ?? "") ||
    transaction.candidateStateId !== transaction.canonicalStateIdAfter ||
    transaction.candidateStateId === transaction.canonicalStateIdBefore ||
    transaction?.canonicalStateIdBefore ===
      transaction?.canonicalStateIdAfter ||
    transaction?.canonicalContentHashBefore ===
      transaction?.canonicalContentHashAfter ||
    !sha256Pattern.test(transaction?.canonicalContentHashBefore ?? "") ||
    !sha256Pattern.test(transaction?.canonicalContentHashAfter ?? "") ||
    agent?.canonicalStateId !== transaction?.canonicalStateIdAfter ||
    !exactContract(transaction) ||
    !exactResourceEvidence(transaction) ||
    !exactValidationEvidence(transaction) ||
    !exactWorkspaceEvidence(transaction) ||
    !exactExternalEffect(transaction, run.completedAt) ||
    !exactReceiptChronology(transaction, run.completedAt) ||
    !Array.isArray(effects) ||
    effects.length !== 1 ||
    effect?.runId !== run.id ||
    effect?.intentId !== intent?.id ||
    effect?.type !== intent?.type ||
    effect?.destination !== intent?.destination ||
    effect?.subject !== intent?.subject ||
    !sha256Pattern.test(effect?.payloadHash ?? "") ||
    effect?.idempotencyKey !== intent?.idempotencyKey ||
    effect?.deliveredAt !== intent?.deliveredAt ||
    effect?.deliveryMode !== "atomic-local-store" ||
    transaction?.recovery?.journalPhase !== "completed" ||
    transaction?.lineage?.rootRunId !== run.id ||
    transaction?.lineage?.parentRunId !== null ||
    transaction?.lineage?.depth !== 0 ||
    receipt?.runTransactionId !== transaction.id ||
    receipt?.disposition !== "promoted" ||
    receipt?.outcomeContractVersion !== transaction.outcomeContractVersion ||
    JSON.stringify(receipt?.lineage) !== JSON.stringify(transaction.lineage) ||
    finiteTimestamp(receipt?.createdAt) === null ||
    finiteTimestamp(receipt.createdAt) > finiteTimestamp(run.completedAt) ||
    receipt?.canonicalStateIdBefore !== transaction.canonicalStateIdBefore ||
    receipt?.canonicalStateIdAfter !== transaction.canonicalStateIdAfter ||
    receipt?.canonicalContentHashBefore !==
      transaction.canonicalContentHashBefore ||
    receipt?.canonicalContentHashAfter !==
      transaction.canonicalContentHashAfter ||
    !sha256Pattern.test(receipt?.validationEvidenceHash ?? "")
  ) {
    fail("Production image Agent transaction evidence is incomplete");
  }
  return {
    schema: proofSchema,
    agentId: agent.id,
    runId: run.id,
    transactionId: transaction.id,
    completedAt: run.completedAt,
    canonicalStateIdAfter: transaction.canonicalStateIdAfter,
    canonicalContentHashAfter: transaction.canonicalContentHashAfter,
    outcomeContractVersion: transaction.outcomeContractVersion,
    validationEvidenceHash: receipt.validationEvidenceHash,
    effectIdempotencyKey: effect.idempotencyKey,
    effectIntentId: effect.intentId,
    effectType: effect.type,
    effectDestination: effect.destination,
    effectSubject: effect.subject,
    effectPayloadHash: effect.payloadHash,
    effectDeliveredAt: effect.deliveredAt,
  };
}

function assertProofBinding(value) {
  const keys = Object.keys(value ?? {}).sort();
  if (
    JSON.stringify(keys) !==
      JSON.stringify(
        [
          "agentId",
          "canonicalContentHashAfter",
          "canonicalStateIdAfter",
          "completedAt",
          "effectDeliveredAt",
          "effectDestination",
          "effectIdempotencyKey",
          "effectIntentId",
          "effectPayloadHash",
          "effectSubject",
          "effectType",
          "outcomeContractVersion",
          "runId",
          "schema",
          "transactionId",
          "validationEvidenceHash",
        ].sort(),
      ) ||
    value.schema !== proofSchema ||
    !uuidPattern.test(value.agentId ?? "") ||
    !uuidPattern.test(value.runId ?? "") ||
    value.transactionId !== value.runId ||
    typeof value.canonicalStateIdAfter !== "string" ||
    value.canonicalStateIdAfter.length < 8 ||
    !sha256Pattern.test(value.canonicalContentHashAfter ?? "") ||
    !sha256Pattern.test(value.validationEvidenceHash ?? "") ||
    !sha256Pattern.test(value.effectIdempotencyKey ?? "") ||
    value.effectIntentId !== "protocol-release-ready" ||
    value.effectType !== "demo.notification.requested" ||
    value.effectDestination !== "demo-console" ||
    value.effectSubject !== "Protocol release ready" ||
    !sha256Pattern.test(value.effectPayloadHash ?? "") ||
    finiteTimestamp(value.completedAt) === null ||
    finiteTimestamp(value.effectDeliveredAt) === null ||
    !Number.isSafeInteger(value.outcomeContractVersion) ||
    value.outcomeContractVersion < 2
  ) {
    fail("Production image restart proof binding is invalid");
  }
  return value;
}

function sameBinding(actual, expected) {
  return Object.keys(expected).every((key) => actual[key] === expected[key]);
}

async function browserRequest(
  page,
  { authToken, body, method = "GET", pathname },
) {
  const result = await page.evaluate(
    async ({
      authToken: token,
      body: requestBody,
      maximumBytes,
      method: verb,
      pathname: route,
      timeoutMilliseconds,
    }) => {
      const headers = token
        ? {
            Authorization: `Bearer ${token}`,
            ...(requestBody === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          }
        : {};
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
      try {
        const response = await fetch(route, {
          body:
            requestBody === undefined ? undefined : JSON.stringify(requestBody),
          headers,
          method: verb,
          signal: controller.signal,
        });
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > maximumBytes) {
          throw new Error("API response exceeded its proof boundary");
        }
        return { status: response.status, text };
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      authToken,
      body,
      maximumBytes: maximumApiResponseBytes,
      method,
      pathname,
      timeoutMilliseconds: apiRequestTimeoutMilliseconds,
    },
  );
  let payload;
  try {
    payload = result.text ? JSON.parse(result.text) : null;
  } catch {
    fail(`Production image API returned invalid JSON for ${pathname}`);
  }
  return { payload, status: result.status };
}

async function requiredBrowserJson(page, options, expectedStatus) {
  const response = await browserRequest(page, options);
  if (response.status !== expectedStatus) {
    fail(
      `Production image API returned ${response.status} for ${options.pathname}`,
    );
  }
  return response.payload;
}

function exactAgentOutcomeContract(agent) {
  const contract = agent?.outcomeContract;
  return (
    contract?.schemaVersion === 1 &&
    contract?.version === 2 &&
    JSON.stringify({
      requiredPaths: contract.requiredPaths,
      protectedPaths: contract.protectedPaths,
      maxChangedFiles: contract.maxChangedFiles,
      maxAddedBytes: contract.maxAddedBytes,
      secretPatterns: contract.secretPatterns,
      validationCommands: contract.validationCommands,
    }) === JSON.stringify(realRuntimeProofContract)
  );
}

async function waitForOneAgent(page, authToken) {
  const deadline = Date.now() + 20_000;
  let agents = null;
  while (Date.now() <= deadline) {
    const payload = await requiredBrowserJson(
      page,
      { authToken, pathname: "/api/agents" },
      200,
    );
    agents = payload?.agents;
    if (Array.isArray(agents) && agents.length === 1) return agents[0];
    if (Array.isArray(agents) && agents.length > 1) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("Production image UI did not create exactly one Agent");
}

async function unlockPage(page, authToken, expectedMode) {
  await page
    .getByRole("heading", { name: "Enter the access token", exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  await page.getByLabel("Access token", { exact: true }).fill(authToken);
  await page.getByRole("button", { name: "Open Airlock", exact: true }).click();
  await page
    .getByText(
      "Real Codex CLI in application container against the local Responses protocol fixture · no ModelArk request or paid inference.",
      { exact: true },
    )
    .waitFor({ state: "visible", timeout: 20_000 });
  await page
    .getByText("Local Responses fixture · application container", {
      exact: true,
    })
    .waitFor({ state: "visible", timeout: 20_000 });
  if (expectedMode === "empty") {
    await page
      .getByRole("heading", {
        name: "Your runtime is ready for an Agent.",
        exact: true,
      })
      .waitFor({ state: "visible", timeout: 20_000 });
  } else if (expectedMode === "configured") {
    await page
      .getByRole("heading", {
        name: "Run the real Agent transaction",
        exact: true,
      })
      .waitFor({ state: "visible", timeout: 20_000 });
    await page
      .getByText(agentName, { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
  } else {
    await page
      .getByText(agentName, { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
  }
}

async function assertRenderedOutcomeContract(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const summary = page.getByLabel("Outcome Contract summary", { exact: true });
  await summary.waitFor({ state: "visible", timeout: 20_000 });
  await summary.getByText("Version 2", { exact: true }).waitFor();
  await summary.getByText("protocol-proof.txt", { exact: true }).waitFor();
  await summary.getByText("4 files · 64.0 KB", { exact: true }).waitFor();
  await summary
    .getByText("0 secret patterns · 1 commands", { exact: true })
    .waitFor();
  if ((await summary.getByText("AGENTS.md", { exact: true }).count()) !== 2) {
    fail(
      "Production image UI did not render the exact Outcome Contract summary",
    );
  }
}

async function assertRenderedTransaction(page, runId) {
  const assistantOutput =
    "Protocol fixture completed the requested Candidate edit.";
  await page
    .locator("article.message-user .message-body")
    .getByText(productionImageBoundaryPrompt, { exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  await page
    .locator("article.message-assistant .message-body")
    .getByText(assistantOutput, { exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  const evidence = page.getByLabel("Agent Airlock evidence", { exact: true });
  await evidence.waitFor({ state: "visible", timeout: 20_000 });
  await evidence
    .getByRole("heading", { name: "Promoted", exact: true })
    .waitFor();
  await evidence
    .getByText("Candidate became Canonical State", { exact: true })
    .waitFor();
  await openCompleteTransactionEvidence(evidence);
  await evidence
    .getByText(`Root ${runId.slice(0, 8)} · no parent`, { exact: true })
    .waitFor();
  const summary = evidence.getByLabel("Judge proof summary", { exact: true });
  await summary
    .getByRole("heading", {
      name: "Proof complete: one validated Whole-Agent future became reality",
      exact: true,
    })
    .waitFor();
  await summary.getByText("Validated", { exact: true }).waitFor();
  await summary
    .getByText("9/9 required Validations passed.", { exact: true })
    .waitFor();
  await summary.getByText("4/4 resources promoted", { exact: true }).waitFor();
  await summary
    .getByText("Effect released during Promotion", { exact: true })
    .waitFor();
  await summary
    .getByText(
      "1 typed effect delivered after Canonical State advanced during Promotion.",
      { exact: true },
    )
    .waitFor();
}

export async function installOriginExactNetworkGuard(context, origin) {
  const violations = [];
  let expectedUnauthorizedResponses = 0;
  const inspect = (rawUrl, kind) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      violations.push(`${kind}:invalid-url`);
      return;
    }
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      violations.push(`${kind}:cross-origin`);
    }
  };
  context.on("request", (request) => inspect(request.url(), "request"));
  context.on("requestfailed", (request) => {
    inspect(request.url(), "requestfailed");
    violations.push("requestfailed:same-origin");
  });
  context.on("response", (response) => {
    inspect(response.url(), "response");
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (
      url.origin !== origin ||
      (response.status() >= 200 && response.status() < 300)
    ) {
      return;
    }
    const request = response.request();
    const headers = request.headers();
    const expectedUnauthorized =
      response.status() === 401 &&
      url.pathname === "/api/agents" &&
      !url.search &&
      !url.hash &&
      request.method() === "GET" &&
      headers.authorization === undefined;
    if (expectedUnauthorized && expectedUnauthorizedResponses === 0) {
      expectedUnauthorizedResponses += 1;
      return;
    }
    violations.push(`response:${response.status()}`);
  });
  await context.route("**/*", async (route) => {
    const before = violations.length;
    inspect(route.request().url(), "request-route");
    if (violations.length > before) {
      await route.abort("blockedbyclient");
    } else {
      const headers = { ...route.request().headers() };
      delete headers["if-modified-since"];
      delete headers["if-none-match"];
      headers["cache-control"] = "no-store";
      headers.pragma = "no-cache";
      await route.continue({ headers });
    }
  });
  await context.routeWebSocket("**/*", async (socket) => {
    const before = violations.length;
    inspect(socket.url(), "websocket-route");
    if (violations.length > before) {
      await socket.close({ code: 1008, reason: "External network blocked" });
    } else {
      socket.connectToServer();
    }
  });
  return {
    attachPage(page) {
      page.on("websocket", (socket) => inspect(socket.url(), "websocket"));
      page.on("pageerror", () => violations.push("pageerror"));
    },
    assert() {
      if (expectedUnauthorizedResponses !== 1) {
        fail(
          "Production image browser did not observe the exact authentication rejection",
        );
      }
      if (violations.length > 0) {
        fail("Production image browser encountered a page or network failure");
      }
    },
  };
}

async function authenticateBrowser({ authToken, browser, mode, origin }) {
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1280, height: 720 },
  });
  const originGuard = await installOriginExactNetworkGuard(context, origin);
  const page = await context.newPage();
  originGuard.attachPage(page);
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const unauthorized = await browserRequest(page, {
    authToken: "",
    pathname: "/api/agents",
  });
  if (unauthorized.status !== 401) {
    fail("Production image API did not enforce authentication");
  }
  await page
    .getByRole("heading", { name: "Enter the access token", exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  await unlockPage(page, authToken, mode === "create" ? "empty" : "completed");
  const mounted = await page
    .locator("#root")
    .evaluate((root) => Boolean(root.firstElementChild));
  if (!mounted) fail("Production image React runtime did not mount");
  return { assertOriginExact: originGuard.assert, page };
}

async function createTransaction({ authToken, page }) {
  const initialAgents = await requiredBrowserJson(
    page,
    { authToken, pathname: "/api/agents" },
    200,
  );
  const initialEffects = await requiredBrowserJson(
    page,
    { authToken, pathname: "/api/effects" },
    200,
  );
  if (
    !Array.isArray(initialAgents?.agents) ||
    initialAgents.agents.length !== 0 ||
    !Array.isArray(initialEffects?.effects) ||
    initialEffects.effects.length !== 0
  ) {
    fail("Production image transaction store was not initially empty");
  }
  await page
    .getByRole("button", { name: "Create your first Agent", exact: true })
    .click();
  const createForm = page.locator("form.modal");
  await createForm
    .getByRole("heading", { name: "Create an Agent", exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  await createForm.getByLabel("Name", { exact: true }).fill(agentName);
  await createForm
    .getByLabel("Description", { exact: true })
    .fill(realRuntimeProofAgentDescription);
  const instructionsControl = createForm.locator("textarea");
  if (
    (await instructionsControl.count()) !== 1 ||
    (await instructionsControl.evaluate((element) =>
      element.closest("label")?.childNodes[0]?.textContent?.trim(),
    )) !== "Instructions"
  ) {
    fail(
      "Production image did not render the exact Agent instructions control",
    );
  }
  await instructionsControl.fill(realRuntimeProofAgentInstructions);
  await createForm
    .getByRole("button", { name: "Create Agent", exact: true })
    .click();
  await page
    .getByRole("heading", { name: agentName, exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  const createdAgent = await waitForOneAgent(page, authToken);
  const agentId = createdAgent?.id;
  if (!uuidPattern.test(agentId ?? "")) {
    fail("Production image did not create a valid Agent");
  }
  // The product intentionally has no general-purpose contract-authoring UI.
  // This authenticated same-origin PUT is the sole setup exception. Agent
  // creation and Run invocation remain visible browser interactions, and the
  // persisted contract is reloaded and rendered before the Run is allowed.
  await requiredBrowserJson(
    page,
    {
      authToken,
      body: realRuntimeProofContract,
      method: "PUT",
      pathname: `/api/agents/${agentId}/outcome-contract`,
    },
    200,
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await unlockPage(page, authToken, "configured");
  const configured = await requiredBrowserJson(
    page,
    { authToken, pathname: `/api/agents/${agentId}` },
    200,
  );
  if (!exactAgentOutcomeContract(configured?.agent)) {
    fail("Production image did not persist the exact Outcome Contract");
  }
  await assertRenderedOutcomeContract(page);
  await page
    .locator('textarea[placeholder="Describe what you want the Agent to do…"]')
    .fill(productionImageBoundaryPrompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const deadline = Date.now() + 120_000;
  let runId = null;
  let run = null;
  while (Date.now() <= deadline) {
    const listed = await requiredBrowserJson(
      page,
      { authToken, pathname: `/api/agents/${agentId}/runs` },
      200,
    );
    const ordinaryRuns = listed?.runs?.filter(
      (candidate) => !candidate?.candidateSetId,
    );
    if (!Array.isArray(ordinaryRuns) || ordinaryRuns.length > 1) {
      fail("Production image UI did not create exactly one ordinary Run");
    }
    run = ordinaryRuns[0] ?? null;
    runId = run?.id ?? null;
    if (terminalRunStatuses.has(run?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!uuidPattern.test(runId ?? "") || !terminalRunStatuses.has(run?.status)) {
    fail("Production image Agent Run did not reach a terminal state");
  }
  if (
    run.status !== "completed" ||
    (run.transaction?.disposition ?? run.transaction?.status) !== "promoted"
  ) {
    const failedValidation = run.transaction?.validations?.find(
      (validation) => validation?.required && validation?.status !== "passed",
    );
    fail(
      `Production image Agent Run reached ${String(run.status)} with ${String(
        run.transaction?.disposition ?? run.transaction?.status,
      )} instead of a completed Promotion${
        failedValidation
          ? `; ${String(failedValidation.name)}: ${String(failedValidation.summary)}`
          : run.error
            ? `; ${String(run.error)}`
            : ""
      }`,
    );
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await unlockPage(page, authToken, "completed");
  await assertRenderedTransaction(page, runId);
  const refreshed = await requiredBrowserJson(
    page,
    { authToken, pathname: `/api/agents/${agentId}` },
    200,
  );
  const agents = await requiredBrowserJson(
    page,
    { authToken, pathname: "/api/agents" },
    200,
  );
  const runs = await requiredBrowserJson(
    page,
    { authToken, pathname: `/api/agents/${agentId}/runs` },
    200,
  );
  const effects = await requiredBrowserJson(
    page,
    { authToken, pathname: "/api/effects" },
    200,
  );
  if (
    agents?.agents?.length !== 1 ||
    runs?.runs?.length !== 1 ||
    JSON.stringify(agents.agents[0]) !== JSON.stringify(refreshed?.agent) ||
    JSON.stringify(runs.runs[0]) !== JSON.stringify(run)
  ) {
    fail(
      "Production image transaction did not produce one exact Agent and Run",
    );
  }
  return assertProductionImageTransaction({
    agent: refreshed?.agent,
    effects: effects?.effects,
    run,
  });
}

async function verifyRestart({ authToken, expected, page }) {
  const agentPayload = await requiredBrowserJson(
    page,
    { authToken, pathname: `/api/agents/${expected.agentId}` },
    200,
  );
  const runPayload = await requiredBrowserJson(
    page,
    { authToken, pathname: `/api/runs/${expected.runId}` },
    200,
  );
  const agentsPayload = await requiredBrowserJson(
    page,
    { authToken, pathname: "/api/agents" },
    200,
  );
  const runsPayload = await requiredBrowserJson(
    page,
    {
      authToken,
      pathname: `/api/agents/${expected.agentId}/runs`,
    },
    200,
  );
  const effectsPayload = await requiredBrowserJson(
    page,
    { authToken, pathname: "/api/effects" },
    200,
  );
  const listedAgent = agentsPayload?.agents?.find(
    (agent) => agent?.id === expected.agentId,
  );
  const listedRun = runsPayload?.runs?.find(
    (run) => run?.id === expected.runId,
  );
  if (
    agentsPayload?.agents?.length !== 1 ||
    runsPayload?.runs?.length !== 1 ||
    JSON.stringify(listedAgent) !== JSON.stringify(agentPayload?.agent) ||
    JSON.stringify(listedRun) !== JSON.stringify(runPayload?.run)
  ) {
    fail("Production image restart lists contradict persisted detail records");
  }
  const actual = assertProductionImageTransaction({
    agent: agentPayload?.agent,
    effects: effectsPayload?.effects,
    run: runPayload?.run,
  });
  if (!sameBinding(actual, expected)) {
    fail("Production image restart changed persisted transaction evidence");
  }
  await assertRenderedTransaction(page, expected.runId);
  return actual;
}

async function writeProofFile(proofFile, proof) {
  const handle = await open(proofFile, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(proof)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readProofFile(proofFile) {
  const metadata = await stat(proofFile);
  if (
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > maximumProofBytes
  ) {
    fail("Production image restart proof file is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(proofFile, "utf8"));
  } catch {
    fail("Production image restart proof file is invalid");
  }
  return assertProofBinding(parsed);
}

export async function verifyProductionImageTransaction({
  authToken,
  mode,
  origin: rawOrigin,
  proofFile,
  launch = (options) => chromium.launch(options),
} = {}) {
  const origin = requireLoopbackOrigin(rawOrigin);
  if (typeof authToken !== "string" || authToken.length < 24) {
    fail("Production image transaction proof requires its test token");
  }
  if (!["create", "restart"].includes(mode)) {
    fail("Production image transaction proof requires create or restart mode");
  }
  if (typeof proofFile !== "string" || !path.isAbsolute(proofFile)) {
    fail("Production image transaction proof requires an absolute proof path");
  }
  const expected = mode === "restart" ? await readProofFile(proofFile) : null;
  const browser = await launch({ channel: "chrome", headless: true });
  try {
    const { assertOriginExact, page } = await authenticateBrowser({
      authToken,
      browser,
      mode,
      origin,
    });
    const proof =
      mode === "create"
        ? await createTransaction({ authToken, page })
        : await verifyRestart({ authToken, expected, page });
    if (mode === "create") await writeProofFile(proofFile, proof);
    assertOriginExact();
    return proof;
  } finally {
    await browser.close();
  }
}

function parseArguments(argumentsList) {
  if (argumentsList.length !== 6) {
    fail(
      "Usage: node scripts/check-production-image-transaction.mjs --origin <loopback-origin> --mode <create|restart> --proof-file <absolute-path>",
    );
  }
  const parsed = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith("--") || !value || parsed.has(key)) {
      fail("Production image transaction proof arguments are invalid");
    }
    parsed.set(key, value);
  }
  if (
    parsed.size !== 3 ||
    !parsed.has("--origin") ||
    !parsed.has("--mode") ||
    !parsed.has("--proof-file")
  ) {
    fail("Production image transaction proof arguments are invalid");
  }
  return {
    mode: parsed.get("--mode"),
    origin: parsed.get("--origin"),
    proofFile: parsed.get("--proof-file"),
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await verifyProductionImageTransaction({
    ...parseArguments(process.argv.slice(2)),
    authToken: process.env.AIRLOCK_PRODUCTION_IMAGE_AUTH_TOKEN ?? "",
  });
  process.stdout.write(
    `Production image ${process.argv.includes("restart") ? "restart" : "create"} transaction proof passed for Agent ${result.agentId} and Run ${result.runId}.\n`,
  );
}
