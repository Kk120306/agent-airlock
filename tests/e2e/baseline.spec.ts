import { expect, test } from "@playwright/test";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

test("preserves the complete starter Playground journey", async ({ page, request }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Your runtime is ready for an Agent." }))
    .toBeVisible();
  await page.locator(".create-button").click();
  await page.getByLabel("Name").fill("Baseline Builder");
  await page.getByLabel("Description").fill("Locks the starter journey");
  await page.getByRole("button", { name: "Create Agent", exact: true }).last().click();

  await expect(page.getByRole("heading", { name: "Baseline Builder", exact: true }))
    .toBeVisible();
  const composer = page.getByPlaceholder("Describe what you want the Agent to do…");
  await composer.fill("Create a TypeScript hello-world CLI, add a test, and run it.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Baseline completed with a TypeScript hello-world/))
    .toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Session connected")).toBeVisible();

  await composer.fill("Confirm that the same source file is still present.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Continued baseline-thread with the existing hello-world/))
    .toBeVisible({ timeout: 15_000 });

  const agentBeforeRejectionResponse = await request.get("/api/agents");
  expect(agentBeforeRejectionResponse.ok()).toBe(true);
  const agentBeforeRejection = (
    await agentBeforeRejectionResponse.json() as {
      agents: Array<{
        id: string;
        workspacePath: string;
        canonicalStateId: string;
      }>;
    }
  ).agents[0];
  expect(agentBeforeRejection).toBeTruthy();

  await composer.fill("Delete AGENTS.md and create damage.txt.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Attempted the destructive workspace change/))
    .toBeVisible({ timeout: 15_000 });
  const evidence = page.getByRole("article", { name: "Agent Airlock evidence" });
  await expect(evidence.getByRole("heading", { name: "Quarantined" })).toBeVisible();
  await expect(evidence.getByText("Canonical State unchanged")).toBeVisible();
  await expect(evidence.getByText("Decisive Validation")).toBeVisible();
  await expect(evidence.getByText("protected-paths", { exact: true }).first()).toBeVisible();
  await expect(evidence.getByText("Outcome Contract v1")).toBeVisible();

  const runsResponse = await request.get(
    "/api/agents/" + (agentBeforeRejection?.id ?? "") + "/runs",
  );
  expect(runsResponse.ok()).toBe(true);
  const quarantinedRun = (
    await runsResponse.json() as {
      runs: Array<{
        transaction: {
          disposition: string;
          canonicalStateIdBefore: string;
          canonicalStateIdAfter: string;
          canonicalContentHashBefore: string;
          canonicalContentHashAfter: string;
          promotionReceipt: { disposition: string };
        } | null;
      }>;
    }
  ).runs[0];
  expect(quarantinedRun?.transaction).toMatchObject({
    disposition: "quarantined",
    canonicalStateIdBefore: agentBeforeRejection?.canonicalStateId,
    canonicalStateIdAfter: agentBeforeRejection?.canonicalStateId,
    promotionReceipt: { disposition: "quarantined" },
  });
  expect(quarantinedRun?.transaction?.canonicalContentHashAfter)
    .toBe(quarantinedRun?.transaction?.canonicalContentHashBefore);

  const agentAfterRejectionResponse = await request.get("/api/agents");
  const agentAfterRejection = (
    await agentAfterRejectionResponse.json() as {
      agents: Array<{ workspacePath: string; canonicalStateId: string }>;
    }
  ).agents[0];
  expect(agentAfterRejection).toMatchObject({
    workspacePath: agentBeforeRejection?.workspacePath,
    canonicalStateId: agentBeforeRejection?.canonicalStateId,
  });
  await expect(
    readFile(path.join(agentAfterRejection?.workspacePath ?? "", "AGENTS.md"), "utf8"),
  ).resolves.toContain("Platform-managed Agent instructions");
  await expect(
    access(path.join(agentAfterRejection?.workspacePath ?? "", "damage.txt")),
  ).rejects.toThrow();

  await composer.fill("Confirm recovery from the unchanged Canonical State.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Continued baseline-thread.*Confirm recovery/))
    .toBeVisible({ timeout: 15_000 });
  await expect(evidence.getByRole("heading", { name: "Promoted" })).toBeVisible();
  await expect(evidence.getByText("Candidate became Canonical State")).toBeVisible();

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".status-stopped")).toBeVisible();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator(".status-ready")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Baseline Builder", exact: true }))
    .toBeVisible();
  await expect(page.getByText(/Continued baseline-thread.*Confirm recovery/))
    .toBeVisible();
  await expect(page.getByText("Session connected")).toBeVisible();

  const response = await request.get("/api/agents");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    agents: Array<{ workspacePath: string; codexThreadId: string | null }>;
  };
  expect(body.agents).toHaveLength(1);
  expect(body.agents[0]?.codexThreadId).toBe("baseline-thread");
  const workspacePath = body.agents[0]?.workspacePath;
  expect(workspacePath).toBeTruthy();
  await access(path.join(workspacePath ?? "", "src", "hello.ts"));
  await expect(
    readFile(path.join(workspacePath ?? "", "src", "hello.ts"), "utf8"),
  ).resolves.toContain('"hello"');
});
