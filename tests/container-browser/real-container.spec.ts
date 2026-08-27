import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("the browser drives a real Codex Candidate through Validation and Promotion", async ({
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

  const systemResponse = await request.get("/api/system");
  expect(await systemResponse.json()).toMatchObject({
    demoMode: false,
    protocolFixtureMode: true,
    inferenceMode: "local-responses-protocol-fixture",
    runtimeProvider: "container",
  });

  const composer = page.getByPlaceholder("Describe what you want the Agent to do…");
  await composer.fill("Create protocol-proof.txt.");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(
    page.getByText("Protocol fixture completed the requested Candidate edit."),
  ).toBeVisible({ timeout: 45_000 });
  const evidence = page.getByRole("article", { name: "Agent Airlock evidence" });
  await expect(evidence.getByRole("heading", { name: "Promoted" })).toBeVisible();
  await expect(evidence.getByText("Journal completed", { exact: true })).toBeVisible();
  await expect(evidence.getByText("command:protocol-content", { exact: true }))
    .toBeVisible();

  const runsResponse = await request.get(`/api/agents/${agentId}/runs`);
  const runs = (await runsResponse.json()) as {
    runs: Array<{
      status: string;
      transaction: {
        disposition: string;
        canonicalStateIdBefore: string;
        canonicalStateIdAfter: string;
        validations: Array<{ name: string; status: string; required: boolean }>;
      };
    }>;
  };
  const run = runs.runs[0];
  expect(run).toMatchObject({
    status: "completed",
    transaction: {
      disposition: "promoted",
      canonicalStateIdBefore: created.agent.canonicalStateId,
      canonicalStateIdAfter: expect.any(String),
    },
  });
  expect(run?.transaction.canonicalStateIdAfter).not.toBe(
    run?.transaction.canonicalStateIdBefore,
  );
  expect(run?.transaction.validations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "command:protocol-content",
        status: "passed",
        required: true,
      }),
    ]),
  );

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
});
