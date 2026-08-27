import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("the browser drives a real Codex Candidate through Validation and Promotion", async ({
  page,
  request,
}) => {
  const createdResponse = await request.post("/api/agents", {
    data: {
      name: "Browser Container Proof",
      description: "Real Codex, isolated Candidate, validated Promotion",
      instructions: "Keep every change inside isolated Candidate State.",
    },
  });
  expect(createdResponse.status()).toBe(201);
  const created = (await createdResponse.json()) as {
    agent: {
      id: string;
      canonicalStateId: string;
      workspacePath: string;
    };
  };
  const agentId = created.agent.id;

  const contractResponse = await request.put(
    `/api/agents/${agentId}/outcome-contract`,
    {
      data: {
        requiredPaths: ["AGENTS.md", "protocol-proof.txt"],
        protectedPaths: ["AGENTS.md"],
        maxChangedFiles: 4,
        maxAddedBytes: 4_096,
        secretPatterns: [],
        validationCommands: [
          {
            name: "protocol-content",
            command: "test \"$(cat protocol-proof.txt)\" = candidate-only",
            required: true,
            timeoutMs: 10_000,
          },
        ],
      },
    },
  );
  expect(contractResponse.ok()).toBe(true);

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Browser Container Proof", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Local container · Codex CLI", { exact: true }))
    .toBeVisible();

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
