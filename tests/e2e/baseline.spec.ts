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

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".status-stopped")).toBeVisible();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator(".status-ready")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Baseline Builder", exact: true }))
    .toBeVisible();
  await expect(page.getByText(/Continued baseline-thread with the existing hello-world/))
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
