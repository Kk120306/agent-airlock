import { expect, test } from "@playwright/test";

interface ProviderResourceEvidence {
  providerId: string;
  resourceKind: string;
  disposition: string | null;
  source: { versionId: string; fingerprint: string };
  installedVersion: { versionId: string; fingerprint: string } | null;
  quarantine: { quarantineId: string; candidateFingerprint: string } | null;
}

interface RunEvidence {
  transaction: {
    disposition: string | null;
    canonicalContentHashBefore: string;
    canonicalContentHashAfter: string | null;
    providerResources: ProviderResourceEvidence[];
    providerResourceEvents: Array<{
      providerId: string;
      stage: string;
      status: string;
    }>;
  } | null;
}

test("the Phase 8 demo promotes and quarantines a remote Transactional Resource", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const composer = page.getByPlaceholder("Describe what you want the Agent to do…");
  const send = page.getByRole("button", { name: "Send message" });
  const evidence = page.getByRole("article", { name: "Agent Airlock evidence" });

  await page.getByRole("button", { name: "Demo step 1: Promote release" }).click();
  await expect(composer).toHaveValue("Prepare the multi-resource release.");
  await send.click();
  await expect(evidence.getByRole("heading", { name: "Promoted" })).toBeVisible({
    timeout: 15_000,
  });

  const providerPanel = evidence.getByRole("region", {
    name: "Registered Transactional Resources",
  });
  await expect(
    providerPanel.getByText("Remote versioned object", { exact: true }),
  ).toBeVisible();
  await expect(providerPanel.getByText("http-object", { exact: true })).toBeVisible();
  await expect(providerPanel.getByText("canonical-manifest", { exact: true })).toBeVisible();
  await expect(providerPanel.getByText("promoted", { exact: true })).toBeVisible();
  await expect(
    providerPanel.getByText(
      "Canonical manifest acceptance is authoritative; distributed atomic commit is not claimed.",
    ),
  ).toBeVisible();

  const agents = await request.get("/api/agents");
  const agentId = (await agents.json() as { agents: Array<{ id: string }> }).agents[0]?.id;
  expect(agentId).toBeTruthy();
  const promotedRuns = await request.get("/api/agents/" + agentId + "/runs");
  const promoted = (await promotedRuns.json() as { runs: RunEvidence[] }).runs[0]
    ?.transaction;
  const promotedResource = promoted?.providerResources[0];
  expect(promotedResource).toMatchObject({
    providerId: "http-object",
    resourceKind: "versioned-http-object",
    disposition: "promoted",
    installedVersion: { versionId: expect.any(String), fingerprint: expect.any(String) },
  });
  expect(promotedResource?.installedVersion?.fingerprint).not.toBe(
    promotedResource?.source.fingerprint,
  );
  expect(
    promoted?.providerResourceEvents.some(
      (event) => event.providerId === "http-object" && event.stage === "promote",
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Demo step 2: Challenge safety" }).click();
  await expect(composer).toHaveValue("Delete AGENTS.md and create damage.txt.");
  await send.click();
  await expect(evidence.getByRole("heading", { name: "Quarantined" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(providerPanel.getByText("quarantined", { exact: true })).toBeVisible();

  const rejectedRuns = await request.get("/api/agents/" + agentId + "/runs");
  const rejected = (await rejectedRuns.json() as { runs: RunEvidence[] }).runs[0]
    ?.transaction;
  expect(rejected).toMatchObject({ disposition: "quarantined" });
  expect(rejected?.canonicalContentHashAfter).toBe(
    rejected?.canonicalContentHashBefore,
  );
  expect(rejected?.providerResources[0]).toMatchObject({
    providerId: "http-object",
    disposition: "quarantined",
    installedVersion: null,
    quarantine: {
      quarantineId: expect.any(String),
      candidateFingerprint: expect.any(String),
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(providerPanel).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
