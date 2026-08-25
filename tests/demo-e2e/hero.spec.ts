import { expect, test } from "@playwright/test";

interface AgentSummary {
  id: string;
  canonicalStateId: string;
  workspacePath: string;
}

interface TransactionSummary {
  disposition: string;
  canonicalStateIdBefore: string;
  canonicalStateIdAfter: string;
  canonicalContentHashBefore: string;
  canonicalContentHashAfter: string;
  resources: Array<{
    kind: string;
    disposition: string;
    fingerprintBefore: string | null;
    fingerprintAfter: string | null;
  }>;
  lineage: {
    parentRunId: string | null;
    depth: number;
  };
}

test("the free judge demo proves promotion, quarantine, repair, and continuity", async ({
  page,
  request,
}) => {
  await page.goto("/");

  const demoBanner = page.locator(".demo-mode-banner");
  await expect(demoBanner).toContainText("FREE LOCAL DEMO");
  await expect(demoBanner).toContainText("No ModelArk request or paid inference is active.");
  await expect(page.getByRole("heading", { name: "Airlock Demo", exact: true }))
    .toBeVisible();
  await expect(page.getByRole("region", { name: "Four-step demo proof" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const welcomeHeading = page.getByRole("heading", {
    name: "Start with the safe multi-resource release",
  });
  await expect(welcomeHeading).toBeVisible();
  const cleanMobileClipping = await welcomeHeading.evaluate((heading) => {
    const messages = heading.closest(".messages");
    const headingRect = heading.getBoundingClientRect();
    const messagesRect = messages?.getBoundingClientRect();
    return {
      headingTop: headingRect.top,
      headingBottom: headingRect.bottom,
      messagesTop: messagesRect?.top ?? 0,
      messagesBottom: messagesRect?.bottom ?? 0,
    };
  });
  expect(cleanMobileClipping.headingTop).toBeGreaterThanOrEqual(
    cleanMobileClipping.messagesTop,
  );
  expect(cleanMobileClipping.headingBottom).toBeLessThanOrEqual(
    cleanMobileClipping.messagesBottom,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();

  const initialAgents = await request.get("/api/agents");
  expect(initialAgents.ok()).toBe(true);
  const initialAgent = (
    await initialAgents.json() as { agents: AgentSummary[] }
  ).agents[0];
  expect(initialAgent).toBeTruthy();

  const composer = page.getByPlaceholder("Describe what you want the Agent to do…");
  const send = page.getByRole("button", { name: "Send message" });
  const evidence = page.getByRole("article", { name: "Agent Airlock evidence" });
  const resources = evidence.getByRole("region", { name: "Transactional resources" });

  await page.getByRole("button", { name: "Demo step 1: Promote release" }).click();
  await expect(composer).toHaveValue("Prepare the multi-resource release.");
  await send.click();
  await expect(page.getByText(/Prepared the multi-resource release with workspace/))
    .toBeVisible({ timeout: 15_000 });
  await expect(evidence.getByRole("heading", { name: "Promoted" })).toBeVisible();
  await expect(evidence.getByText("Journal completed", { exact: true })).toBeVisible();
  await expect(resources.getByText("one decision across 4 resources")).toBeVisible();
  await expect(resources.getByText("promoted", { exact: true })).toHaveCount(4);
  await expect(evidence.getByText("1 delivered", { exact: true })).toBeVisible();

  const promotedAgent = (
    await (await request.get("/api/agents")).json() as { agents: AgentSummary[] }
  ).agents[0];
  expect(promotedAgent?.canonicalStateId).not.toBe(initialAgent?.canonicalStateId);
  const promotedCanonicalStateId = promotedAgent?.canonicalStateId;

  const effectsAfterPromotion = (
    await (await request.get("/api/effects")).json() as {
      effects: Array<{ intentId: string }>;
    }
  ).effects;
  expect(effectsAfterPromotion.map((effect) => effect.intentId)).toEqual([
    "release-ready",
  ]);

  await page.getByRole("button", { name: "Demo step 2: Challenge safety" }).click();
  await expect(composer).toHaveValue("Delete AGENTS.md and create damage.txt.");
  await send.click();
  await expect(page.getByText(/Attempted the destructive workspace change/))
    .toBeVisible({ timeout: 15_000 });
  await expect(evidence.getByRole("heading", { name: "Quarantined" })).toBeVisible();
  await expect(evidence.getByText("Canonical State unchanged")).toBeVisible();
  await expect(resources.getByText("quarantined", { exact: true })).toHaveCount(4);

  const agentAfterChallenge = (
    await (await request.get("/api/agents")).json() as { agents: AgentSummary[] }
  ).agents[0];
  expect(agentAfterChallenge?.canonicalStateId).toBe(promotedCanonicalStateId);
  const runsAfterChallenge = (
    await (
      await request.get("/api/agents/" + (initialAgent?.id ?? "") + "/runs")
    ).json() as { runs: Array<{ transaction: TransactionSummary | null }> }
  ).runs;
  const quarantined = runsAfterChallenge[0]?.transaction;
  expect(quarantined).toMatchObject({
    disposition: "quarantined",
    canonicalStateIdBefore: promotedCanonicalStateId,
    canonicalStateIdAfter: promotedCanonicalStateId,
  });
  expect(quarantined?.canonicalContentHashAfter).toBe(
    quarantined?.canonicalContentHashBefore,
  );
  for (const resource of quarantined?.resources ?? []) {
    expect(resource.fingerprintAfter).toBe(resource.fingerprintBefore);
  }
  expect(
    (await (await request.get("/api/effects")).json() as { effects: unknown[] }).effects,
  ).toHaveLength(1);

  const repairStep = page.getByRole("button", { name: "Demo step 3: Repair future" });
  await expect(repairStep).toBeEnabled();
  await repairStep.click();
  await expect(page.getByText(/Repaired the quarantined future using bounded Validation evidence/))
    .toBeVisible({ timeout: 15_000 });
  await expect(evidence.getByRole("heading", { name: "Promoted" })).toBeVisible();
  await expect(evidence.getByText("Repair 1 of 2", { exact: true })).toBeVisible();
  await expect(evidence.getByText("Journal completed", { exact: true })).toBeVisible();
  await expect(resources.getByText("promoted", { exact: true })).toHaveCount(4);

  const effectsAfterRepair = (
    await (await request.get("/api/effects")).json() as {
      effects: Array<{ intentId: string }>;
    }
  ).effects;
  expect(effectsAfterRepair.map((effect) => effect.intentId)).toEqual([
    "release-ready",
    "repair-ready",
  ]);
  const repairedRuns = (
    await (
      await request.get("/api/agents/" + (initialAgent?.id ?? "") + "/runs")
    ).json() as { runs: Array<{ transaction: TransactionSummary | null }> }
  ).runs;
  expect(repairedRuns[0]?.transaction?.lineage).toMatchObject({
    parentRunId: expect.any(String),
    depth: 1,
  });

  await page.getByRole("button", { name: "Demo step 4: Prove continuity" }).click();
  await expect(composer).toHaveValue(
    "Confirm recovery from the repaired Canonical State.",
  );
  await send.click();
  await expect(page.getByText(/Continued baseline-thread.*Confirm recovery/))
    .toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Session connected")).toBeVisible();

  const seededAgentId = initialAgent?.id;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Airlock Demo", exact: true }))
    .toBeVisible();
  await expect(page.getByText(/Continued baseline-thread.*Confirm recovery/)).toBeVisible();
  const persistedAgent = (
    await (await request.get("/api/agents")).json() as { agents: AgentSummary[] }
  ).agents[0];
  expect(persistedAgent?.id).toBe(seededAgentId);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(demoBanner).toBeVisible();
  await expect(page.getByRole("region", { name: "Four-step demo proof" })).toBeVisible();
  const viewportMetrics = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(viewportMetrics.documentWidth).toBeLessThanOrEqual(viewportMetrics.viewportWidth);
});
