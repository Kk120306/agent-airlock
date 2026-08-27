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

  const systemResponse = await request.get("/api/system");
  expect(await systemResponse.json()).toMatchObject({
    demoMode: false,
    protocolFixtureMode: true,
    modelArkDemoMode: false,
    inferenceMode: "local-responses-protocol-fixture",
    runtimeProvider: "container",
  });

  const pairedProof = page.getByRole("region", { name: "Full safety loop" });
  await expect(
    pairedProof.getByText("Promote. Reject. Repair. Verify."),
  ).toBeVisible();
  await pairedProof.getByRole("button", { name: /Run passing Candidate/ }).click();

  await expect(
    page.getByText("Protocol fixture completed the requested Candidate edit."),
  ).toBeVisible({ timeout: 45_000 });
  const evidence = page.getByRole("article", { name: "Agent Airlock evidence" });
  await expect(evidence.getByRole("heading", { name: "Promoted" })).toBeVisible();
  const judgeProof = evidence.getByRole("region", { name: "Judge proof summary" });
  await expect(
    judgeProof.getByRole("heading", {
      name: "Proof complete: only the validated future became reality",
    }),
  ).toBeVisible();
  await expect(judgeProof.getByText("Candidate isolated", { exact: true })).toBeVisible();
  await expect(judgeProof.getByText("8/8 required Validations passed.")).toBeVisible();
  await expect(judgeProof.getByText("Canonical State advanced", { exact: true }))
    .toBeVisible();

  await evidence.getByText("Inspect complete transaction evidence", { exact: true })
    .click();
  await expect(evidence.getByText("Journal completed", { exact: true })).toBeVisible();
  await expect(evidence.getByText("command:protocol-content", { exact: true }))
    .toBeVisible();

  await evidence.getByRole("button", { name: "Generate and verify proof" }).click();
  await expect(evidence.getByText("Signed proof verified locally", { exact: true }))
    .toBeVisible();
  await expect(
    evidence.getByRole("button", { name: "Download evidence packet" }),
  ).toBeEnabled();

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
  await expect(rejectedProof.getByText("7/8 required Validations passed."))
    .toBeVisible();
  await expect(
    rejectedProof.getByText("Canonical State unchanged", { exact: true }),
  ).toBeVisible();
  await expect(pairedProof.getByText("Run all three stages", { exact: true }))
    .toBeVisible();
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
  await expect(repairedProof.getByText("9/9 required Validations passed."))
    .toBeVisible();
  await expect(
    pairedProof.getByText("Recovery proven", { exact: true }),
  ).toBeVisible();
  await expect(
    pairedProof.getByText("Full recovery loop proven", { exact: true }),
  ).toBeVisible();
  await expect(
    pairedProof.getByText("Rejected future safely repaired", { exact: true }),
  ).toBeVisible();

  await repairedEvidence
    .getByRole("button", { name: "Generate and verify proof" })
    .click();
  await expect(
    repairedEvidence.getByText(
      "One complete chain proves all 2 signed decisions and their Canonical State handoffs.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    repairedEvidence.getByRole("button", {
      name: "Download complete decision chain",
    }),
  ).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(repairedProof).toBeVisible();
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
});
