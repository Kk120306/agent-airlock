import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface AgentProjection {
  id: string;
  outcomeContract: { version: number };
}

interface RunProjection {
  id: string;
  status: string;
  transaction: { outcomeContractVersion: number } | null;
}

test("advice changes only future Runs after explicit browser acceptance", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const agent = await readAgent(request);
  expect(agent.outcomeContract.version).toBe(1);

  const historicalRunIds: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/messages"),
    );
    await page
      .getByPlaceholder("Describe what you want the Agent to do…")
      .fill("Delete README.md and record why.");
    await page.getByRole("button", { name: "Send message" }).click();
    const response = await responsePromise;
    const body = (await response.json()) as { run: { id: string } };
    historicalRunIds.push(body.run.id);
    const historicalRun = await waitForRun(request, body.run.id, "completed");
    expect(historicalRun.transaction?.disposition).toBe("quarantined");
  }

  await page.getByRole("button", { name: /Assurance/ }).click();
  const inbox = page.getByRole("region", { name: "Adaptive Assurance inbox" });
  const deriveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/assurance-proposals/derive"),
  );
  await inbox.getByRole("button", { name: "Scan retained evidence" }).click();
  expect((await deriveResponse).ok()).toBe(true);
  await expect(inbox.getByText("Protect README.md")).toBeVisible();

  expect((await readAgent(request)).outcomeContract.version).toBe(1);
  for (const runId of historicalRunIds) {
    expect((await readRun(request, runId)).transaction?.outcomeContractVersion).toBe(
      1,
    );
  }

  const acceptResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/accept"),
  );
  const acceptDialogs = handleAcceptanceDialogs(page);
  await inbox.getByRole("button", { name: "Review and accept" }).click();
  expect((await acceptResponse).ok()).toBe(true);
  await acceptDialogs;
  await expect.poll(async () => (await readAgent(request)).outcomeContract.version).toBe(
    2,
  );

  const futureResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/messages"),
  );
  await page
    .getByPlaceholder("Describe what you want the Agent to do…")
    .fill("Continue with a safe future-only change.");
  await page.getByRole("button", { name: "Send message" }).click();
  const futureRunId = ((await (await futureResponse).json()) as {
    run: { id: string };
  }).run.id;
  const futureRun = await waitForRun(request, futureRunId, "completed");
  expect(futureRun.transaction?.outcomeContractVersion).toBe(2);
  for (const runId of historicalRunIds) {
    expect((await readRun(request, runId)).transaction?.outcomeContractVersion).toBe(
      1,
    );
  }

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText("Version history and rollback").click();
  const rollbackResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/outcome-contract/rollback"),
  );
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Restore rule content" }).last().click();
  expect((await rollbackResponse).ok()).toBe(true);
  await expect.poll(async () => (await readAgent(request)).outcomeContract.version).toBe(
    3,
  );
});

async function handleAcceptanceDialogs(page: Page): Promise<void> {
  let handled = 0;
  await new Promise<void>((resolve) => {
    const handler = (dialog: import("@playwright/test").Dialog) => {
      handled += 1;
      void dialog
        .accept(
          dialog.type() === "prompt"
            ? "Browser-reviewed bounded evidence"
            : undefined,
        )
        .then(() => {
          if (handled === 2) {
            page.off("dialog", handler);
            resolve();
          }
        });
    };
    page.on("dialog", handler);
  });
}

async function readAgent(request: APIRequestContext): Promise<AgentProjection> {
  const response = await request.get("/api/agents");
  expect(response.ok()).toBe(true);
  const agents = (await response.json()) as { agents: AgentProjection[] };
  const agent = agents.agents[0];
  if (!agent) throw new Error("The deterministic Phase 10 Agent is unavailable");
  return agent;
}

async function readRun(
  request: APIRequestContext,
  runId: string,
): Promise<RunProjection> {
  const response = await request.get("/api/runs/" + runId);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { run: RunProjection }).run;
}

async function waitForRun(
  request: APIRequestContext,
  runId: string,
  expectedStatus: string,
): Promise<RunProjection> {
  await expect.poll(async () => (await readRun(request, runId)).status, {
    timeout: 15_000,
  }).toBe(expectedStatus);
  return readRun(request, runId);
}
