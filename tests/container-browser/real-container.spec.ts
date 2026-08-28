import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("the browser proves real Codex Promotion, Quarantine, and Repair against one Canonical State", async ({
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

  await page.goto("/");
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
  await expect(verifier.getByText("0 API calls · 0 uploads · 4 MB hard limit"))
    .toBeVisible();
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

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Automated Loop Proof", exact: true }),
  ).toBeVisible();
  const automatedGuide = page.getByRole("region", { name: "Full safety loop" });
  await automatedGuide
    .getByRole("button", { name: "Run complete safety loop" })
    .click();
  await expect(
    automatedGuide.getByText("Full signed recovery proof verified", { exact: true }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(
    automatedGuide.getByText("Signed recovery verified", { exact: true }),
  ).toBeVisible();
  await expect(
    automatedGuide.getByText(
      "Two signed decisions, their parent link, and every Canonical State handoff verified locally without an upload.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    automatedGuide.getByText("Safe future promoted", { exact: true }),
  ).toBeVisible();
  await expect(
    automatedGuide.getByText("Unsafe future quarantined", { exact: true }),
  ).toBeVisible();
  await expect(
    automatedGuide.getByText("Rejected future safely repaired", { exact: true }),
  ).toBeVisible();

  const automatedEvidence = page.getByRole("article", {
    name: "Agent Airlock evidence",
  });
  await expect(
    automatedEvidence.getByText("Signed proof verified locally", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    automatedEvidence.getByText(
      "2 signed decisions verified locally with every Canonical State handoff intact.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    automatedEvidence.getByRole("button", {
      name: "Download verified decision chain",
    }),
  ).toBeEnabled();
  await automatedEvidence
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
});
