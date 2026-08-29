import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("the browser proves real Codex Promotion, Quarantine, and Repair against one Canonical State", async ({
  browser,
  page,
  request,
}) => {
  const seededResponse = await request.get("/api/agents");
  const seeded = (await seededResponse.json()) as {
    agents: Array<{
      id: string;
      name: string;
      canonicalStateId: string;
      workspacePath: string;
    }>;
  };
  expect(seeded.agents).toHaveLength(1);
  const created = { agent: seeded.agents[0] };
  expect(created.agent.name).toBe("Real Runtime Proof");
  const agentId = created.agent.id;

  let releaseSystemRequest = () => {};
  const systemRequestGate = new Promise<void>((resolve) => {
    releaseSystemRequest = resolve;
  });
  await page.route("**/api/system", async (route) => {
    await systemRequestGate;
    await route.continue();
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Connecting to the control plane" }),
  ).toBeVisible();
  await expect(page.getByText("Runtime configuration needed", { exact: true }))
    .not.toBeVisible();
  releaseSystemRequest();
  await expect(page.locator(".brand").getByText("Agent Airlock", { exact: true }))
    .toBeVisible();
  await expect(page.getByText("REAL RUNTIME PROOF", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Real Codex CLI in a disposable container", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Local deterministic Responses fixture. No ModelArk request or paid inference.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Real Runtime Proof", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Local container · Codex CLI", { exact: true }))
    .not.toBeVisible();
  await expect(
    page.getByText("Real Runtime proof · local inference", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Prove a real Agent change is safe" }),
  ).toBeVisible();
  await expect(page.getByLabel("Judge proof path")).toContainText(
    "Run→Validate→Promote→Verify",
  );
  await expect(page.getByText(/cannot enforce total-token allowances/))
    .not.toBeVisible();
  await expect(page.getByRole("button", { name: "Explore futures" }))
    .not.toBeVisible();

  await page.setViewportSize({ width: 590, height: 1024 });
  const standbyPlayground = page.locator(".protocol-proof-standby");
  await expect(standbyPlayground).toBeVisible();
  const composerBox = await page.locator(".composer").boundingBox();
  expect(composerBox).not.toBeNull();
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(1024);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(590);
  await page.setViewportSize({ width: 1280, height: 720 });

  const systemResponse = await request.get("/api/system");
  const system = await systemResponse.json();
  expect(system).toMatchObject({
    demoMode: false,
    protocolFixtureMode: true,
    modelArkDemoMode: false,
    inferenceMode: "local-responses-protocol-fixture",
    modelProfileDisclosure: "configured-status-only",
    runtimeProvider: "container",
  });
  expect(system).not.toHaveProperty("arkBaseUrl");
  expect(system).not.toHaveProperty("arkModel");

  const pairedProof = page.getByRole("region", { name: "Full safety loop" });
  await expect(
    pairedProof.getByText("Promote. Reject. Repair. Verify."),
  ).toBeVisible();
  await expect(
    pairedProof.getByRole("button", { name: "Run complete safety loop" }),
  ).toBeEnabled();
  const proofCardCopy = pairedProof.locator(".protocol-scenario-actions small");
  await expect(proofCardCopy).toHaveCount(3);
  expect(
    await proofCardCopy.evaluateAll((elements) =>
      elements.every((element) => {
        const style = window.getComputedStyle(element);
        return (
          style.whiteSpace === "normal" &&
          element.scrollWidth <= element.clientWidth &&
          element.scrollHeight <= element.clientHeight
        );
      }),
    ),
  ).toBe(true);
  await pairedProof.getByRole("button", { name: /Run passing Candidate/ }).click();

  await expect(
    page.getByText("Protocol fixture completed the requested Candidate edit."),
  ).toBeVisible({ timeout: 45_000 });
  const evidence = page.getByRole("article", { name: "Agent Airlock evidence" });
  await expect(evidence.getByRole("heading", { name: "Promoted" })).toBeVisible();
  const judgeProof = evidence.getByRole("region", { name: "Judge proof summary" });
  await expect(
    judgeProof.getByRole("heading", {
      name: "Proof complete: one validated Whole-Agent future became reality",
    }),
  ).toBeVisible();
  await expect(judgeProof.getByText("Candidate isolated", { exact: true })).toBeVisible();
  await expect(judgeProof.getByText("9/9 required Validations passed.")).toBeVisible();
  await expect(judgeProof.getByText("4/4 resources promoted", { exact: true }))
    .toBeVisible();
  await expect(
    judgeProof.getByText("Effect released after Promotion", { exact: true }),
  ).toBeVisible();
  await expect(judgeProof.getByText("1 typed effect delivered only after Canonical State advanced."))
    .toBeVisible();
  const judgeProofItems = judgeProof.locator("li");
  await expect(judgeProofItems).toHaveCount(4);
  expect(
    new Set(
      await judgeProofItems.evaluateAll((items) =>
        items.map((item) => Math.round(item.getBoundingClientRect().top)),
      ),
    ).size,
  ).toBe(1);

  await evidence.getByText("Inspect complete transaction evidence", { exact: true })
    .click();
  await expect(evidence.getByText("Journal completed", { exact: true })).toBeVisible();
  await expect(evidence.getByText("command:protocol-content", { exact: true }))
    .toBeVisible();
  await expect(evidence.getByText("candidate-only", { exact: true })).toBeVisible();
  await expect(evidence.getByText("1 delivered", { exact: true })).toBeVisible();
  await expect(evidence.getByText("protocol-release-ready", { exact: true }))
    .toBeVisible();

  await evidence.getByRole("button", { name: "Generate and verify proof" }).click();
  await expect(evidence.getByText("Signed proof verified locally", { exact: true }))
    .toBeVisible();
  await expect(
    evidence.getByRole("heading", {
      name: "Signed decision independently verified",
    }),
  ).toBeVisible();
  await expect(evidence.getByRole("button", { name: "Reverify proof" }))
    .toBeEnabled();
  await expect(
    evidence.getByRole("button", { name: "Download verified evidence packet" }),
  ).toBeEnabled();
  await expect(evidence.getByRole("button", { name: "Download receipt JSON" }))
    .not.toBeVisible();

  await expect(
    pairedProof.getByRole("button", { name: /Safe future promoted/ }),
  ).toBeVisible();
  await pairedProof.getByRole("button", { name: /Run failing Candidate/ }).click();
  await expect(
    page.getByText("Protocol fixture completed the deliberately invalid Candidate edit."),
  ).toBeVisible({ timeout: 45_000 });

  const rejectedEvidence = page.getByRole("article", {
    name: "Agent Airlock evidence",
  });
  await expect(
    rejectedEvidence.getByRole("heading", { name: "Quarantined" }),
  ).toBeVisible();
  const rejectedProof = rejectedEvidence.getByRole("region", {
    name: "Judge proof summary",
  });
  await expect(
    rejectedProof.getByRole("heading", {
      name: "Unsafe future blocked: accepted reality did not move",
    }),
  ).toBeVisible();
  await expect(rejectedProof.getByText("8/9 required Validations passed."))
    .toBeVisible();
  await expect(rejectedProof.getByText("4/4 resources quarantined", { exact: true }))
    .toBeVisible();
  await expect(rejectedProof.getByText("External effects held back", { exact: true }))
    .toBeVisible();
  await expect(rejectedProof.getByText("0 effects delivered from this rejected future."))
    .toBeVisible();
  await expect(
    pairedProof.getByRole("button", { name: "Run complete safety loop" }),
  ).toBeEnabled();
  await expect(
    pairedProof.getByText("Airlock controlled both outcomes", { exact: true }),
  ).toBeVisible();

  await rejectedEvidence
    .getByText("Inspect complete transaction evidence", { exact: true })
    .click();
  await expect(
    rejectedEvidence.getByText("command:protocol-content", { exact: true }).first(),
  ).toBeVisible();
  await rejectedEvidence
    .getByRole("button", { name: "Generate and verify proof" })
    .click();
  await expect(
    rejectedEvidence.getByText("Signed proof verified locally", { exact: true }),
  ).toBeVisible();

  const rejectedRunsResponse = await request.get(`/api/agents/${agentId}/runs`);
  const rejectedRuns = (await rejectedRunsResponse.json()) as {
    runs: Array<{
      id: string;
      transaction: {
        disposition: string;
        canonicalStateIdAfter: string;
        canonicalContentHashAfter: string;
      };
    }>;
  };
  const rejectedParent = rejectedRuns.runs.find(
    (run) => run.transaction.disposition === "quarantined",
  );
  expect(rejectedParent).toBeDefined();

  await pairedProof.getByRole("button", { name: /Repair retained Candidate/ }).click();
  await expect(
    page.getByText(
      "Protocol fixture repaired the retained Candidate from bounded failure evidence.",
    ),
  ).toBeVisible({ timeout: 45_000 });

  const repairedEvidence = page.getByRole("article", {
    name: "Agent Airlock evidence",
  });
  await expect(
    repairedEvidence.getByRole("heading", { name: "Promoted" }),
  ).toBeVisible();
  const repairedProof = repairedEvidence.getByRole("region", {
    name: "Judge proof summary",
  });
  await expect(
    repairedProof.getByRole("heading", {
      name: "Recovery complete: retained work became a validated future",
    }),
  ).toBeVisible();
  await expect(
    repairedProof.getByText("Quarantine lineage retained", { exact: true }),
  ).toBeVisible();
  await expect(
    repairedProof.getByText(`rejected Run ${rejectedParent!.id.slice(0, 8)}`, {
      exact: false,
    }),
  ).toBeVisible();
  await expect(repairedProof.getByText("10/10 required Validations passed."))
    .toBeVisible();
  await expect(repairedProof.getByText("4/4 resources promoted", { exact: true }))
    .toBeVisible();
  await expect(repairedProof.getByText("Effect released after Promotion", { exact: true }))
    .toBeVisible();
  await expect(repairedProof.getByText("1 typed effect delivered only after Canonical State advanced."))
    .toBeVisible();
  await expect(
    pairedProof.getByText("Rejected future safely repaired", { exact: true }),
  ).toBeVisible();

  await expect(
    repairedEvidence.getByText(
      "2 signed decisions verified locally with every Canonical State handoff intact.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    pairedProof.getByText("Full signed recovery proof verified", { exact: true }),
  ).toBeVisible();
  await expect(
    pairedProof.getByText("Signed recovery verified", { exact: true }),
  ).toBeVisible();
  await expect(
    repairedEvidence.getByRole("button", {
      name: "Download verified decision chain",
    }),
  ).toBeEnabled();
  await expect(
    repairedEvidence.getByRole("heading", {
      name: "Signed recovery independently verified",
    }),
  ).toBeVisible();
  await repairedEvidence.getByText("Disclose signed evidence (0/11 selected)").click();
  await expect(
    repairedEvidence.getByText(/commits to 11 Validation leaves: 10 required and 1 optional/),
  ).toBeVisible();
  await expect(
    repairedEvidence.getByText(/Evidence commitment [a-f0-9]{8} · passed required/).first(),
  ).toBeVisible();
  await expect(
    repairedEvidence.getByText("0/10 required selected", { exact: true }),
  ).toBeVisible();
  await repairedEvidence.getByRole("button", { name: "Select all required" }).click();
  await expect(
    repairedEvidence.getByText("Disclose signed evidence (10/11 selected)"),
  ).toBeVisible();
  await expect(
    repairedEvidence.getByText("10/10 required selected", { exact: true }),
  ).toBeVisible();
  await expect(
    repairedEvidence.getByRole("button", { name: "Download verified decision chain" }),
  ).toBeDisabled();
  await expect(
    repairedEvidence.getByRole("button", { name: "Inspect in zero-upload verifier" }),
  ).toBeDisabled();
  await repairedEvidence.getByRole("button", { name: "Regenerate proof" }).click();
  await expect(
    repairedEvidence.getByText(
      "2 signed decisions verified locally with every Canonical State handoff intact.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    repairedEvidence.getByRole("button", { name: "Download verified evidence packet" }),
  ).not.toBeVisible();
  await repairedEvidence
    .getByRole("button", { name: "Inspect in zero-upload verifier" })
    .click();
  const verifier = page.getByRole("dialog", { name: "Verify trust without trusting this server" });
  await expect(
    verifier.getByText(
      "0 API calls · 0 uploads · 2 signed decisions linked · 16 MB custody / 4 MB other proofs",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    verifier.getByText("Verified directly from the exact generated artifact", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(verifier.getByText("Cryptographic proof valid", { exact: true }))
    .toBeVisible();
  await expect(verifier.getByText("2 signed decisions linked", { exact: true }))
    .toBeVisible();
  await expect(
    verifier.getByText("Every receipt, parent link, and state handoff agrees.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    verifier.getByText(
      "The complete chain includes this parent and validates its exact receipt digest and Canonical State handoff.",
      { exact: true },
    ),
  ).toBeVisible();
  await verifier.getByRole("button", { name: "Close receipt verifier" }).click();

  await page.reload();
  const reloadedGuide = page.getByRole("region", { name: "Full safety loop" });
  const reloadedEvidence = page.getByRole("article", {
    name: "Agent Airlock evidence",
  });
  await expect(
    reloadedGuide.getByText("Full signed recovery proof verified", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    reloadedGuide.getByText("Signed recovery verified", { exact: true }),
  ).toBeVisible();
  await expect(
    reloadedEvidence.getByText(
      "2 signed decisions verified locally with every Canonical State handoff intact.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    reloadedEvidence.getByRole("button", { name: "Generate and verify proof" }),
  ).not.toBeVisible();
  await expect(
    reloadedEvidence.getByRole("heading", {
      name: "Signed recovery independently verified",
    }),
  ).toBeVisible();
  await expect(
    reloadedEvidence.getByText("Make this decision independently verifiable", {
      exact: true,
    }),
  ).not.toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    reloadedEvidence.getByRole("region", { name: "Judge proof summary" }),
  ).toBeVisible();
  expect(
    await pairedProof
      .locator(".protocol-scenario-actions small")
      .first()
      .evaluate((element) => getComputedStyle(element).whiteSpace),
  ).toBe("normal");
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);

  let historicalReceiptRequests = 0;
  const trackHistoricalReceiptRequests = (browserRequest: {
    method: () => string;
    url: () => string;
  }) => {
    if (
      browserRequest.method() === "POST" &&
      new URL(browserRequest.url()).pathname.endsWith("/portable-receipt")
    ) {
      historicalReceiptRequests += 1;
    }
  };
  page.on("request", trackHistoricalReceiptRequests);
  await page.goto("/?recording=1");
  const historicalRecordingGuide = page.getByRole("region", {
    name: "Full safety loop",
  });
  await expect(
    page.getByRole("region", { name: "Verified Outcome Brief" }),
  ).toHaveCount(0);
  await expect(
    historicalRecordingGuide.getByRole("button", {
      name: "Prove this release is safe",
    }),
  ).toBeEnabled();
  await page.waitForTimeout(750);
  expect(historicalReceiptRequests).toBe(0);
  page.off("request", trackHistoricalReceiptRequests);

  const runsResponse = await request.get(`/api/agents/${agentId}/runs`);
  const runs = (await runsResponse.json()) as {
    runs: Array<{
      id: string;
      status: string;
      transaction: {
        disposition: string;
        canonicalStateIdBefore: string;
        canonicalStateIdAfter: string;
        canonicalContentHashBefore: string;
        canonicalContentHashAfter: string;
        quarantinePath: string | null;
        lineage: { depth: number; parentRunId: string | null };
        validations: Array<{ name: string; status: string; required: boolean }>;
        resources: Array<{ kind: string; disposition: string }>;
        sqlite: {
          before: { rows: Array<{ id: string; value: string }> };
          candidate: { rows: Array<{ id: string; value: string }> };
          after: { rows: Array<{ id: string; value: string }> };
        };
        externalActions: {
          deliveredCount: number;
          intents: Array<{ id: string; status: string }>;
        };
      };
    }>;
  };
  const promotedRun = runs.runs.find(
    (run) =>
      run.transaction.disposition === "promoted" &&
      run.transaction.lineage.depth === 0,
  );
  const quarantinedRun = runs.runs.find(
    (run) => run.transaction.disposition === "quarantined",
  );
  expect(promotedRun).toMatchObject({
    status: "completed",
    transaction: {
      disposition: "promoted",
      canonicalStateIdBefore: created.agent.canonicalStateId,
      canonicalStateIdAfter: expect.any(String),
    },
  });
  expect(promotedRun?.transaction.canonicalStateIdAfter).not.toBe(
    promotedRun?.transaction.canonicalStateIdBefore,
  );
  expect(promotedRun?.transaction.validations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "command:protocol-content",
        status: "passed",
        required: true,
      }),
    ]),
  );
  expect(promotedRun?.transaction.sqlite.after.rows).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "demo", value: "candidate-only" })]),
  );
  expect(promotedRun?.transaction.externalActions).toMatchObject({
    deliveredCount: 1,
    intents: [{ id: "protocol-release-ready", status: "delivered" }],
  });
  expect(promotedRun?.transaction.resources).toEqual(
    expect.arrayContaining(
      ["workspace", "codex-session", "sqlite", "external-actions"].map((kind) =>
        expect.objectContaining({ kind, disposition: "promoted" }),
      ),
    ),
  );
  expect(quarantinedRun).toMatchObject({
    status: "completed",
    transaction: {
      disposition: "quarantined",
      canonicalStateIdBefore: promotedRun?.transaction.canonicalStateIdAfter,
      canonicalStateIdAfter: promotedRun?.transaction.canonicalStateIdAfter,
      quarantinePath: expect.any(String),
    },
  });
  expect(quarantinedRun?.transaction.canonicalContentHashAfter).toBe(
    quarantinedRun?.transaction.canonicalContentHashBefore,
  );
  expect(quarantinedRun?.transaction.validations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "command:protocol-content",
        status: "failed",
        required: true,
      }),
    ]),
  );
  expect(quarantinedRun?.transaction.sqlite.candidate.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "demo", value: "unsafe-candidate" }),
    ]),
  );
  expect(quarantinedRun?.transaction.sqlite.after.rows).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "demo", value: "candidate-only" })]),
  );
  expect(quarantinedRun?.transaction.externalActions).toMatchObject({
    deliveredCount: 0,
    intents: [{ id: "protocol-unsafe", status: "rejected" }],
  });
  const repairedRun = runs.runs.find(
    (run) =>
      run.transaction.disposition === "promoted" &&
      run.transaction.lineage.depth === 1,
  );
  expect(repairedRun).toMatchObject({
    status: "completed",
    transaction: {
      disposition: "promoted",
      canonicalStateIdBefore: quarantinedRun?.transaction.canonicalStateIdAfter,
      lineage: {
        depth: 1,
        parentRunId: quarantinedRun?.id,
      },
    },
  });
  expect(repairedRun?.transaction.canonicalStateIdAfter).not.toBe(
    repairedRun?.transaction.canonicalStateIdBefore,
  );
  expect(repairedRun?.transaction.validations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "command:protocol-content",
        status: "passed",
        required: true,
      }),
    ]),
  );
  expect(repairedRun?.transaction.sqlite.after.rows).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "demo", value: "candidate-only" })]),
  );
  expect(repairedRun?.transaction.externalActions).toMatchObject({
    deliveredCount: 1,
    intents: [{ id: "protocol-repair-ready", status: "delivered" }],
  });

  const chainResponse = await request.post(
    `/api/runs/${repairedRun!.id}/portable-receipt`,
    { data: { includeAncestry: true } },
  );
  expect(chainResponse.ok()).toBe(true);
  const chainExport = (await chainResponse.json()) as {
    verification: { valid: boolean };
    decisionChain: {
      packets: Array<{
        envelope: { receipt: { decision: { disposition: string } } };
      }>;
    };
  };
  expect(chainExport.verification.valid).toBe(true);
  expect(
    chainExport.decisionChain.packets.map(
      (packet) => packet.envelope.receipt.decision.disposition,
    ),
  ).toEqual(["quarantined", "promoted"]);

  const agentResponse = await request.get(`/api/agents/${agentId}`);
  const promoted = (await agentResponse.json()) as {
    agent: { workspacePath: string; codexThreadId: string | null };
  };
  expect(promoted.agent.codexThreadId).toEqual(expect.any(String));
  expect(
    await readFile(
      path.join(promoted.agent.workspacePath, "protocol-proof.txt"),
      "utf8",
    ),
  ).toBe("candidate-only\n");
  expect(
    await readFile(
      path.join(
        quarantinedRun!.transaction.quarantinePath!,
        "workspace",
        "protocol-proof.txt",
      ),
      "utf8",
    ),
  ).toBe("unsafe-candidate\n");

  const automatedAgentResponse = await request.post("/api/agents", {
    data: {
      name: "Automated Loop Proof",
      description: "One action proves Promotion, Quarantine, and Repair",
      instructions:
        "Keep every change inside isolated Candidate State and complete the requested Whole-Agent protocol proof.",
    },
  });
  expect(automatedAgentResponse.ok()).toBe(true);
  const automatedAgent = (await automatedAgentResponse.json()) as {
    agent: { id: string };
  };
  const automatedContractResponse = await request.put(
    `/api/agents/${automatedAgent.agent.id}/outcome-contract`,
    {
      data: {
        requiredPaths: ["AGENTS.md", "protocol-proof.txt"],
        protectedPaths: ["AGENTS.md"],
        maxChangedFiles: 4,
        maxAddedBytes: 65_536,
        secretPatterns: [],
        validationCommands: [
          {
            name: "protocol-content",
            command: [
              'test "$(cat protocol-proof.txt)" = candidate-only',
              "node --no-warnings --experimental-sqlite --input-type=module -e 'import { DatabaseSync } from \"node:sqlite\"; const database = new DatabaseSync(\".airlock/demo.sqlite\"); const row = database.prepare(\"SELECT value FROM inventory WHERE id = ?\").get(\"demo\"); database.close(); if (row?.value !== \"candidate-only\") process.exit(1);'",
            ].join(" && "),
            required: true,
            timeoutMs: 10_000,
          },
        ],
      },
    },
  );
  expect(automatedContractResponse.ok()).toBe(true);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?recording=1");
  await expect(page).toHaveTitle("Agent Airlock");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "Agent Airlock validates isolated Agent futures before they can become Canonical State.",
  );
  await expect(page.getByRole("button", { name: "Create Agent" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Federation" })).not.toBeVisible();
  const recordingContext = page.getByLabel("Recording Agent context");
  await expect(
    recordingContext.getByText("Automated Loop Proof", { exact: true }),
  ).toBeVisible();
  await expect(recordingContext.locator(".status")).toBeVisible();
  await expect(recordingContext.getByText(/Outcome Contract v\d+/)).toBeVisible();
  const automatedGuide = page.getByRole("region", { name: "Full safety loop" });
  const proveReleaseButton = automatedGuide.getByRole("button", {
    name: "Prove this release is safe",
  });
  const runAllButton = automatedGuide.locator(".protocol-run-all");
  const recordingStages = automatedGuide.locator(
    ".protocol-scenario-actions > button",
  );
  const safeStage = recordingStages.nth(0);
  const quarantineStage = recordingStages.nth(1);
  const repairStage = recordingStages.nth(2);
  await expect(
    page.getByRole("region", { name: "Verified Outcome Brief" }),
  ).toHaveCount(0);
  expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  await expect(proveReleaseButton).toHaveCSS("min-height", "44px");
  await expect(recordingStages).toHaveCount(3);
  await expect(safeStage).toHaveAttribute("data-state", "pending");
  await expect(quarantineStage).toHaveAttribute("data-state", "pending");
  await expect(repairStage).toHaveAttribute("data-state", "pending");
  await expect(safeStage).not.toHaveAttribute("aria-current", "step");
  await expect(safeStage).toHaveCSS("opacity", "1");

  const mobileContext = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 },
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(page.url());
  const mobileProveButton = mobilePage
    .getByRole("region", { name: "Full safety loop" })
    .getByRole("button", { name: "Prove this release is safe" });
  await mobileProveButton.scrollIntoViewIfNeeded();
  const mobileProveButtonBox = await mobileProveButton.boundingBox();
  expect(mobileProveButtonBox).not.toBeNull();
  expect(mobileProveButtonBox!.x).toBeGreaterThanOrEqual(0);
  expect(mobileProveButtonBox!.x + mobileProveButtonBox!.width)
    .toBeLessThanOrEqual(390);
  expect(mobileProveButtonBox!.height).toBeGreaterThanOrEqual(38);
  expect(
    await mobilePage.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  const primaryReceiptResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/portable-receipt") &&
      response.ok(),
  );
  await proveReleaseButton.click();
  const progressAnnouncement = automatedGuide.locator(
    ".protocol-progress-announcement",
  );
  await expect(runAllButton).toHaveAttribute("aria-busy", "true");
  await expect(safeStage).toHaveAttribute("data-state", "active");
  await expect(safeStage).toHaveAttribute("aria-current", "step");
  await expect(progressAnnouncement).toHaveText(
    "Safety proof progress: Running safe Candidate.",
  );
  await expect(runAllButton).toContainText("Proving rejection", {
    timeout: 30_000,
  });
  await expect(safeStage).toHaveAttribute("data-state", "complete");
  await expect(safeStage).not.toHaveAttribute("aria-current", "step");
  await expect(quarantineStage).toHaveAttribute("data-state", "active");
  await expect(quarantineStage).toHaveAttribute("aria-current", "step");
  await expect(progressAnnouncement).toHaveText(
    "Safety proof progress: Proving rejection.",
  );
  await expect(runAllButton).toContainText(
    "Repairing retained Candidate",
    { timeout: 30_000 },
  );
  await expect(quarantineStage).toHaveAttribute("data-state", "complete");
  await expect(quarantineStage).not.toHaveAttribute("aria-current", "step");
  await expect(repairStage).toHaveAttribute("data-state", "active");
  await expect(repairStage).toHaveAttribute("aria-current", "step");
  await expect(progressAnnouncement).toHaveText(
    "Safety proof progress: Repairing retained Candidate.",
  );

  const outcomeBrief = page.getByRole("region", {
    name: "Verified Outcome Brief",
  });
  await expect(
    outcomeBrief.getByRole("heading", {
      name: "One release. Three futures. Only validated reality moves.",
    }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(
    outcomeBrief.getByText("Release proven safe", { exact: true }),
  ).toBeVisible();
  await expect(
    outcomeBrief.getByText("Disclosed execution boundary", { exact: true }),
  ).toBeVisible();
  await expect(
    outcomeBrief.getByText(
      `${system.runtime} · local deterministic Responses fixture · no ModelArk request or paid inference`,
      { exact: true },
    ),
  ).toBeVisible();
  const visibleRunLabels = await outcomeBrief
    .locator(".recording-outcome-grid article > header > span")
    .allTextContents();
  expect(visibleRunLabels.filter((label) => /RUN [a-f0-9]{8}$/i.test(label)))
    .toHaveLength(3);
  const promotedOutcome = outcomeBrief.locator('article[data-outcome="promoted"]');
  await expect(promotedOutcome.getByText("9/9", { exact: true })).toBeVisible();
  await expect(promotedOutcome.getByText("4/4 + 1", { exact: true })).toBeVisible();
  await expect(promotedOutcome.getByText("resources promoted + post-Promotion effect", { exact: true }))
    .toBeVisible();
  await expect(promotedOutcome.getByText("Canonical fingerprint advanced", {
    exact: true,
  })).toBeVisible();
  const quarantinedOutcome = outcomeBrief.locator(
    'article[data-outcome="quarantined"]',
  );
  await expect(
    quarantinedOutcome.getByText("1 failed · 4/4 quarantined", { exact: true }),
  ).toBeVisible();
  await expect(
    quarantinedOutcome.getByText(
      "required Validation blocked every resource",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(quarantinedOutcome.getByText("identical Canonical fingerprint", {
    exact: true,
  })).toBeVisible();
  await expect(quarantinedOutcome.getByText("0", { exact: true })).toBeVisible();
  await expect(quarantinedOutcome.getByText("effects delivered", { exact: true }))
    .toBeVisible();
  const repairedOutcome = outcomeBrief.locator('article[data-outcome="repaired"]');
  await expect(repairedOutcome.getByText("10/10 passed · Depth 1", { exact: true }))
    .toBeVisible();
  await expect(repairedOutcome.getByText("4/4 + 1", { exact: true })).toBeVisible();
  await expect(repairedOutcome.getByText("Canonical fingerprint advanced", {
    exact: true,
  })).toBeVisible();
  const verifiedOutcome = outcomeBrief.locator('article[data-outcome="verified"]');
  await expect(verifiedOutcome.getByText("signed decisions linked", { exact: true }))
    .toBeVisible();
  await expect(verifiedOutcome.getByText("browser cryptographic check passed", {
    exact: true,
  })).toBeVisible();
  const outcomeBox = await outcomeBrief.boundingBox();
  expect(outcomeBox).not.toBeNull();
  expect(outcomeBox!.y + outcomeBox!.height).toBeLessThanOrEqual(720);
  expect(await page.evaluate(() => document.documentElement.scrollHeight))
    .toBeLessThanOrEqual(720);
  expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });

  const primaryReceiptPayload = (await (
    await primaryReceiptResponsePromise
  ).json()) as { decisionChain: unknown };
  const primaryChainSource = JSON.stringify(
    primaryReceiptPayload.decisionChain,
  );

  await outcomeBrief
    .getByRole("button", { name: "Inspect in zero-upload verifier" })
    .click();
  const automatedVerifier = page.getByRole("dialog", {
    name: "Verify trust without trusting this server",
  });
  await expect(
    automatedVerifier.getByText("Cryptographic proof valid", { exact: true }),
  ).toBeVisible();
  await expect(
    automatedVerifier.getByText("2 signed decisions linked", { exact: true }),
  ).toBeVisible();
  await expect(
    automatedVerifier.getByText(
      "Every receipt, parent link, and state handoff agrees.",
      { exact: true },
    ),
  ).toBeVisible();
  await automatedVerifier
    .getByRole("button", { name: "Close receipt verifier" })
    .click();

  const threeRunResponse = await request.get(
    `/api/agents/${automatedAgent.agent.id}/runs`,
  );
  const threeRunPayload = (await threeRunResponse.json()) as {
    runs: Array<{
      id: string;
      candidateSetId: string | null;
      transaction: {
        disposition: string;
        lineage: { depth: number };
      };
    }>;
  };
  const ordinaryRuns = threeRunPayload.runs.filter(
    (run) => run.candidateSetId === null,
  );
  expect(ordinaryRuns).toHaveLength(3);
  const safeReplayRun = ordinaryRuns.find(
    (run) =>
      run.transaction.disposition === "promoted" &&
      run.transaction.lineage.depth === 0,
  );
  const unsafeReplayRun = ordinaryRuns.find(
    (run) => run.transaction.disposition === "quarantined",
  );
  const repairedReplayRun = ordinaryRuns.find(
    (run) =>
      run.transaction.disposition === "promoted" &&
      run.transaction.lineage.depth === 1,
  );
  expect(safeReplayRun).toBeDefined();
  expect(unsafeReplayRun).toBeDefined();
  expect(repairedReplayRun).toBeDefined();

  let mobileReceiptRequests = 0;
  mobilePage.on("request", (browserRequest) => {
    if (
      browserRequest.method() === "POST" &&
      new URL(browserRequest.url()).pathname.endsWith("/portable-receipt")
    ) {
      mobileReceiptRequests += 1;
    }
  });
  const mobileReceiptResponsePromise = mobilePage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/portable-receipt") &&
      response.ok(),
  );
  const replayUrl = new URL(page.url());
  replayUrl.search = "";
  replayUrl.searchParams.set("recording", "1");
  replayUrl.searchParams.set("recordingSafeRunId", safeReplayRun!.id);
  replayUrl.searchParams.set("recordingUnsafeRunId", unsafeReplayRun!.id);
  replayUrl.searchParams.set("recordingRepairRunId", repairedReplayRun!.id);
  await mobilePage.goto(replayUrl.toString());
  const mobileOutcomeBrief = mobilePage.getByRole("region", {
    name: "Verified Outcome Brief",
  });
  await expect(mobileOutcomeBrief).toBeVisible({ timeout: 30_000 });
  const mobileReceiptPayload = (await (
    await mobileReceiptResponsePromise
  ).json()) as { decisionChain: unknown };
  expect(mobileReceiptRequests).toBe(1);
  expect(JSON.stringify(mobileReceiptPayload.decisionChain)).toBe(
    primaryChainSource,
  );
  expect(
    await mobilePage.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const mobileOutcomeCardsFit = await mobileOutcomeBrief
    .locator(".recording-outcome-grid article")
    .evaluateAll((cards) =>
      cards.every((card) => {
        const rect = card.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth && rect.width > 0;
      }),
    );
  expect(mobileOutcomeCardsFit).toBe(true);

  const mobileVerifierButton = mobileOutcomeBrief.getByRole("button", {
    name: "Inspect in zero-upload verifier",
  });
  await mobileVerifierButton.scrollIntoViewIfNeeded();
  const mobileVerifierButtonBox = await mobileVerifierButton.boundingBox();
  expect(mobileVerifierButtonBox).not.toBeNull();
  expect(mobileVerifierButtonBox!.x).toBeGreaterThanOrEqual(0);
  expect(mobileVerifierButtonBox!.x + mobileVerifierButtonBox!.width)
    .toBeLessThanOrEqual(390);
  expect(mobileVerifierButtonBox!.height).toBeGreaterThanOrEqual(44);
  await mobileVerifierButton.click();
  const mobileVerifier = mobilePage.getByRole("dialog", {
    name: "Verify trust without trusting this server",
  });
  await expect(
    mobileVerifier.getByText("Cryptographic proof valid", { exact: true }),
  ).toBeVisible();
  await expect(
    mobileVerifier.getByText("2 signed decisions linked", { exact: true }),
  ).toBeVisible();
  await expect(mobileVerifier.getByText(/0 API calls/)).toBeVisible();
  const mobileVerifierBox = await mobileVerifier.boundingBox();
  expect(mobileVerifierBox).not.toBeNull();
  expect(mobileVerifierBox!.x).toBeGreaterThanOrEqual(0);
  expect(mobileVerifierBox!.x + mobileVerifierBox!.width).toBeLessThanOrEqual(390);
  expect(
    await mobilePage.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await mobileVerifier
    .getByRole("button", { name: "Close receipt verifier" })
    .click();

  expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  await expect(outcomeBrief).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1280);

  const malformedReplayUrl = new URL(replayUrl);
  malformedReplayUrl.searchParams.delete("recordingRepairRunId");
  await mobilePage.goto(malformedReplayUrl.toString());
  await expect(
    mobilePage.getByRole("region", { name: "Verified Outcome Brief" }),
  ).toHaveCount(0);
  await expect(
    mobilePage.getByRole("button", { name: "Loading read-only proof" }),
  ).toBeDisabled();
  await mobilePage.waitForTimeout(250);
  expect(mobileReceiptRequests).toBe(1);
  const replayRunResponse = await request.get(
    `/api/agents/${automatedAgent.agent.id}/runs`,
  );
  const replayRunPayload = (await replayRunResponse.json()) as {
    runs: unknown[];
  };
  expect(replayRunPayload.runs).toHaveLength(3);
  await mobileContext.close();

  let replayedReceiptRequests = 0;
  const trackReplayedReceiptRequests = (browserRequest: {
    method: () => string;
    url: () => string;
  }) => {
    if (
      browserRequest.method() === "POST" &&
      new URL(browserRequest.url()).pathname.endsWith("/portable-receipt")
    ) {
      replayedReceiptRequests += 1;
    }
  };
  page.on("request", trackReplayedReceiptRequests);
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Verified Outcome Brief" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Prove this release is safe" }),
  ).toBeEnabled();
  await page.waitForTimeout(750);
  expect(replayedReceiptRequests).toBe(0);
  page.off("request", trackReplayedReceiptRequests);

  await page.route("**/api/system", async (route) => {
    const response = await route.fetch();
    const reportedSystem = await response.json();
    await route.fulfill({
      response,
      json: {
        ...reportedSystem,
        protocolFixtureMode: false,
        inferenceMode: "modelark",
      },
    });
  });
  await page.reload();
  await expect(page.locator(".recording-mode")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create Agent" })).toBeVisible();
  await page.unroute("**/api/system");

  const automatedRunsResponse = await request.get(
    `/api/agents/${automatedAgent.agent.id}/runs`,
  );
  const automatedRuns = (await automatedRunsResponse.json()) as {
    runs: Array<{
      transaction: {
        disposition: string;
        lineage: { depth: number };
      };
    }>;
  };
  expect(automatedRuns.runs).toHaveLength(3);
  expect(
    automatedRuns.runs.map((run) => [
      run.transaction.disposition,
      run.transaction.lineage.depth,
    ]),
  ).toEqual([
    ["promoted", 1],
    ["quarantined", 0],
    ["promoted", 0],
  ]);

  const offlineVerifierContext = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1280, height: 720 },
  });
  const offlineVerifierPage = await offlineVerifierContext.newPage();
  const offlineReceiptResponsePromise = offlineVerifierPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/portable-receipt") &&
      response.ok(),
  );
  await offlineVerifierPage.goto(replayUrl.toString());
  await offlineReceiptResponsePromise;
  const offlineOutcomeBrief = offlineVerifierPage.getByRole("region", {
    name: "Verified Outcome Brief",
  });
  await expect(offlineOutcomeBrief).toBeVisible({ timeout: 30_000 });
  const offlineVerifierButton = offlineOutcomeBrief.getByRole("button", {
    name: "Inspect in zero-upload verifier",
  });
  await expect(offlineVerifierButton).toBeEnabled();
  await offlineVerifierPage.waitForLoadState("networkidle");

  const deniedPostArmHttpRequests: Array<{ method: string; url: string }> = [];
  const deniedPostArmWebSockets: string[] = [];
  await offlineVerifierContext.route(/^https?:\/\//, async (route) => {
    deniedPostArmHttpRequests.push({
      method: route.request().method(),
      url: route.request().url(),
    });
    await route.abort("internetdisconnected");
  });
  await offlineVerifierContext.routeWebSocket(/^wss?:\/\//, async (webSocket) => {
    deniedPostArmWebSockets.push(webSocket.url());
    await webSocket.close({
      code: 1008,
      reason: "Offline verifier network boundary",
    });
  });
  await offlineVerifierButton.click();

  const guardedOfflineVerifier = offlineVerifierPage.getByRole("dialog", {
    name: "Verify trust without trusting this server",
  });
  await expect(
    guardedOfflineVerifier.getByText("Cryptographic proof valid", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    guardedOfflineVerifier.getByText("2 signed decisions linked", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(guardedOfflineVerifier.getByText(/0 API calls/)).toBeVisible();
  await guardedOfflineVerifier
    .getByRole("button", { name: "Close receipt verifier" })
    .click();
  await offlineVerifierContext.close();

  expect(deniedPostArmHttpRequests).toEqual([]);
  expect(deniedPostArmWebSockets).toEqual([]);
});
