import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import {
  generatePortableSigningKey,
  signSigningKeyTrustPolicy,
  verifyFederatedWorkBundleJson,
  verifyReceiverCustodyPacketJson,
  type FederatedWorkBundle,
  type ReceiverCustodyPacket,
  type SigningKeyTrustPolicy,
} from "@agent-airlock/portable-promotion-receipt";

const producerUrl = "http://127.0.0.1:3212";
const receiverUrl = "http://127.0.0.1:3213";

test.use({ viewport: { width: 390, height: 844 } });

test("two independent Airlocks transfer signed work and keep Promotion local", async ({
  page,
  request,
}, testInfo) => {
  await page.goto(producerUrl);
  await page.getByRole("button", { name: "Demo step 1: Promote release" }).click();
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Prepared the multi-resource release with workspace/))
    .toBeVisible({ timeout: 15_000 });

  const portablePanel = page.getByRole("region", { name: "Portable trust receipt" });
  await portablePanel.getByRole("button", { name: "Generate receipt" }).click();
  await expect(portablePanel.getByText("Self-check passed")).toBeVisible();
  const bundleDownloadPromise = page.waitForEvent("download");
  await portablePanel.getByRole("button", { name: "Download federated work" }).click();
  const bundleDownload = await bundleDownloadPromise;
  const downloadedBundlePath = await bundleDownload.path();
  expect(downloadedBundlePath).not.toBeNull();
  const bundleSource = await readFile(downloadedBundlePath!, "utf8");
  expect(verifyFederatedWorkBundleJson(bundleSource).valid).toBe(true);
  const bundle = JSON.parse(bundleSource) as FederatedWorkBundle;

  const authority = generatePortableSigningKey();
  const trustPolicyBody: SigningKeyTrustPolicy = {
    schema: "agent-airlock/signing-key-trust-policy",
    schemaVersion: 1,
    policyId: "producer-demo-signers",
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    keys: [
      {
        keyId: bundle.keyId,
        status: "active",
        validFrom: "2020-01-01T00:00:00.000Z",
        validUntil: null,
        agentIds: [bundle.receipt.receipt.decision.agentId],
        dispositions: ["promoted", "quarantined"],
        note: "Credential-free two-instance browser proof",
      },
    ],
  };
  const trustPolicy = signSigningKeyTrustPolicy({
    policy: trustPolicyBody,
    privateKey: authority.privateKeyPem,
  });
  const trustPolicyPath = testInfo.outputPath("producer-trust-policy.json");
  await writeFile(trustPolicyPath, JSON.stringify(trustPolicy), { mode: 0o600 });
  const bundlePath = testInfo.outputPath("federated-work-bundle.json");
  await writeFile(bundlePath, bundleSource, { mode: 0o600 });

  const builtinResourceKinds = [
    ...new Set([
      ...bundle.receipt.receipt.state.before.builtinResources.map(
        (resource) => resource.kind,
      ),
      ...bundle.receipt.receipt.state.after.builtinResources.map(
        (resource) => resource.kind,
      ),
    ]),
  ];
  const providerCommitments = [
    ...bundle.receipt.receipt.state.before.providerResources,
    ...bundle.receipt.receipt.state.after.providerResources,
  ];
  const receiverPolicy = {
    schema: "agent-airlock/federated-admission-policy",
    schemaVersion: 1,
    policyId: "receiver-browser-policy",
    generation: 1,
    activatedAt: new Date().toISOString(),
    priorPolicyDigest: null,
    receiverOrganizationId: "receiver-demo-org",
    producers: [
      {
        producerId: "producer-demo",
        disabled: false,
        authorityKeyIds: [trustPolicy.authorityKeyId],
        receiptSigners: [
          {
            keyId: bundle.keyId,
            status: "active",
            validFrom: "2020-01-01T00:00:00.000Z",
            validUntil: null,
          },
        ],
        receiptSchemaVersions: [1],
        artifactSchemas: ["agent-airlock/workspace-change-set"],
        artifactMediaTypes: [
          "application/vnd.agent-airlock.workspace-change-set+json",
        ],
        agentAliases: [bundle.receipt.receipt.decision.agentId],
        dispositions: ["promoted", "quarantined"],
        builtinResourceKinds,
        providerIds: [...new Set(providerCommitments.map((item) => item.providerId))],
        providerResourceKinds: [
          ...new Set(providerCommitments.map((item) => item.resourceKind)),
        ],
        ancestry: { requireCompleteChain: true, maximumDepth: 3 },
        freshness: {
          maximumReceiptAgeSeconds: 86_400,
          allowOffline: true,
          maximumOnlineHandoffAgeSeconds: 3_600,
        },
        artifactLimits: {
          maximumBytes: 8_388_608,
          digestAlgorithms: ["SHA-256"],
        },
        transparency: {
          mode: "not-required",
          logKeyIds: [],
          pinnedCheckpointDigest: null,
        },
        requireLocalApproval: true,
      },
    ],
  };
  const policyResponse = await request.post(
    receiverUrl + "/api/federation/policies",
    { data: receiverPolicy },
  );
  expect(policyResponse.status()).toBe(201);

  await page.goto(receiverUrl);
  await page.getByRole("button", { name: "Federation" }).click();
  const federationPanel = page.locator("#federation-airlock-panel");
  await expect(federationPanel.getByText("receiver-browser-policy · generation 1"))
    .toBeVisible();
  const receiverBefore = await request.get(receiverUrl + "/api/agents");
  expect(receiverBefore.ok()).toBe(true);
  const canonicalBefore = receiverBefore.json().then(
    (body) => body.agents[0].canonicalStateId as string,
  );
  await federationPanel.getByLabel("Transfer identity").fill("browser-handoff-approved");
  await federationPanel.getByLabel("Federated Work Bundle").setInputFiles(bundlePath);
  await federationPanel.getByLabel("Signed Trust Policy").setInputFiles(trustPolicyPath);
  await federationPanel.getByRole("button", { name: "Admit into Candidate State" }).click();

  await expect(federationPanel.getByText("Canonical State is unchanged while this decision is pending."))
    .toBeVisible();
  const receiverWhilePending = await request.get(receiverUrl + "/api/agents");
  expect(receiverWhilePending.ok()).toBe(true);
  expect((await receiverWhilePending.json()).agents[0].canonicalStateId).toBe(
    await canonicalBefore,
  );
  await page.reload();
  await page.getByRole("button", { name: "Federation" }).click();
  await expect(
    federationPanel.getByRole("region", { name: "Federated approval inbox" }),
  ).toContainText("1 local Admission");
  await federationPanel
    .locator(".federation-inbox-list button")
    .filter({ hasText: "browser-handoff-approved" })
    .click();
  const review = federationPanel.getByRole("region", {
    name: "Pending Admission review",
  });
  await expect(
    review.getByText("PRODUCER CLAIM · NOT RECEIVER AUTHORITY"),
  ).toBeVisible();
  const firstOperation = bundle.artifact.artifact.operations[0]!;
  const firstOperationPath =
    firstOperation.operation === "rename"
      ? firstOperation.fromPath
      : firstOperation.path;
  await expect(review.getByText(firstOperationPath, { exact: true })).toBeVisible();
  await expect(review.getByText("No predicted metadata blocker")).toBeVisible();
  await expect(
    review.getByText("Deferred to authoritative Candidate Validation"),
  ).toBeVisible();
  await expect(review.getByText(/Approval never bypasses receiver Validation/))
    .toBeVisible();
  await expect(review.getByText("Decision bound to this exact review"))
    .toBeVisible();
  await expect(
    review.getByText(/Receiver Outcome Contract checks run only after approval/),
  ).toBeVisible();
  await expect(
    federationPanel.getByText(
      "Canonical State is unchanged while this decision is pending.",
    ),
  ).toBeVisible();
  await federationPanel.getByLabel("Decision reason").fill(
    "Producer signature, policy scope, and exact artifact reviewed",
  );
  await federationPanel.getByRole("button", { name: "Approve into Candidate State" })
    .click();

  await expect(federationPanel.getByText("PROMOTED BY RECEIVER"))
    .toBeVisible({ timeout: 15_000 });
  await expect(federationPanel.getByText("Receiver Canonical State advanced atomically"))
    .toBeVisible();
  await expect(federationPanel.getByText("No model call runs during import."))
    .toBeVisible();
  await expect(federationPanel.getByText("Recorded by local-control-plane"))
    .toBeVisible();
  await expect(federationPanel.getByText(/Reviewed context sha256:[a-f0-9]{64}/))
    .toBeVisible();
  const custodyDownloadPromise = page.waitForEvent("download");
  await federationPanel
    .getByRole("button", { name: "Verify and download custody proof" })
    .click();
  const custodyDownload = await custodyDownloadPromise;
  const custodyPath = await custodyDownload.path();
  expect(custodyPath).not.toBeNull();
  expect(verifyReceiverCustodyPacketJson(await readFile(custodyPath!, "utf8")).valid)
    .toBe(true);
  await expect(
    federationPanel.getByText("Verified independently in this browser"),
  ).toBeVisible();
  await expect(
    federationPanel.getByText(/cryptographic and authority checks passed locally/),
  ).toBeVisible();
  const receiverAfterApproval = await request.get(receiverUrl + "/api/agents");
  expect(receiverAfterApproval.ok()).toBe(true);
  expect((await receiverAfterApproval.json()).agents[0].canonicalStateId).not.toBe(
    await canonicalBefore,
  );

  const producerAgentsResponse = await request.get(producerUrl + "/api/agents");
  expect(producerAgentsResponse.ok()).toBe(true);
  const producerAgent = (await producerAgentsResponse.json()).agents[0];
  const producerContract = producerAgent.outcomeContract;
  const permissiveProducerContractResponse = await request.put(
    producerUrl + `/api/agents/${producerAgent.id}/outcome-contract`,
    {
      data: {
        requiredPaths: producerContract.requiredPaths.filter(
          (entry: string) => entry !== "AGENTS.md",
        ),
        protectedPaths: producerContract.protectedPaths.filter(
          (entry: string) => entry !== "AGENTS.md",
        ),
        maxChangedFiles: producerContract.maxChangedFiles,
        maxAddedBytes: producerContract.maxAddedBytes,
        secretPatterns: producerContract.secretPatterns,
        validationCommands: producerContract.validationCommands,
      },
    },
  );
  expect(permissiveProducerContractResponse.ok()).toBe(true);

  await page.goto(producerUrl);
  await page.getByPlaceholder("Describe what you want the Agent to do…")
    .fill("Delete AGENTS.md and create damage.txt.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Attempted the destructive workspace change/))
    .toBeVisible({ timeout: 15_000 });
  const permissiveProducerPanel = page.getByRole("region", {
    name: "Portable trust receipt",
  });
  await permissiveProducerPanel.getByRole("button", { name: "Generate receipt" }).click();
  await expect(permissiveProducerPanel.getByText("Self-check passed")).toBeVisible();
  const unsafeBundleDownloadPromise = page.waitForEvent("download");
  await permissiveProducerPanel.getByRole("button", { name: "Download federated work" })
    .click();
  const unsafeBundlePath = await (await unsafeBundleDownloadPromise).path();
  expect(unsafeBundlePath).not.toBeNull();

  const receiverBeforeQuarantine = await request.get(receiverUrl + "/api/agents");
  expect(receiverBeforeQuarantine.ok()).toBe(true);
  const receiverCanonicalBeforeQuarantine =
    (await receiverBeforeQuarantine.json()).agents[0].canonicalStateId as string;
  await page.goto(receiverUrl);
  await page.getByRole("button", { name: "Federation" }).click();
  const quarantinePanel = page.locator("#federation-airlock-panel");
  await quarantinePanel.getByLabel("Transfer identity").fill("browser-handoff-quarantined");
  await quarantinePanel.getByLabel("Federated Work Bundle")
    .setInputFiles(unsafeBundlePath!);
  await quarantinePanel.getByLabel("Signed Trust Policy")
    .setInputFiles(trustPolicyPath);
  await quarantinePanel.getByRole("button", { name: "Admit into Candidate State" })
    .click();
  await expect(quarantinePanel.getByText("Canonical State is unchanged while this decision is pending."))
    .toBeVisible();
  await quarantinePanel.getByLabel("Decision reason")
    .fill("Approve the signed destructive proposal so receiver Validation can contain it");
  await quarantinePanel.getByRole("button", { name: "Approve into Candidate State" })
    .click();
  await expect(quarantinePanel.getByText("QUARANTINED BY RECEIVER"))
    .toBeVisible({ timeout: 15_000 });
  const quarantinedCustodyDownloadPromise = page.waitForEvent("download");
  await quarantinePanel.getByRole("button", {
    name: "Verify and download custody proof",
  }).click();
  const quarantinedCustodyPath = await (await quarantinedCustodyDownloadPromise).path();
  expect(quarantinedCustodyPath).not.toBeNull();
  expect(
    verifyReceiverCustodyPacketJson(
      await readFile(quarantinedCustodyPath!, "utf8"),
    ),
  ).toMatchObject({
    valid: true,
    story: {
      disposition: "quarantined",
      state: { canonicalAdvanced: false },
    },
  });
  const receiverAfterQuarantine = await request.get(receiverUrl + "/api/agents");
  expect(receiverAfterQuarantine.ok()).toBe(true);
  expect((await receiverAfterQuarantine.json()).agents[0].canonicalStateId).toBe(
    receiverCanonicalBeforeQuarantine,
  );

  const custodyPacket = JSON.parse(
    await readFile(custodyPath!, "utf8"),
  ) as ReceiverCustodyPacket;
  const receiverAuthority = generatePortableSigningKey();
  const receiverTrustPolicy: SigningKeyTrustPolicy = {
    schema: "agent-airlock/signing-key-trust-policy",
    schemaVersion: 1,
    policyId: "receiver-demo-signers",
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    keys: [{
      keyId: custodyPacket.envelope.keyId,
      status: "active",
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: null,
      agentIds: [custodyPacket.envelope.manifest.bindings.receiverAgentId],
      dispositions: ["promoted", "quarantined"],
      note: "Independent receiver custody policy",
    }],
  };
  const receiverTrustPolicyPath = testInfo.outputPath("receiver-trust-policy.json");
  await writeFile(
    receiverTrustPolicyPath,
    JSON.stringify(signSigningKeyTrustPolicy({
      policy: receiverTrustPolicy,
      privateKey: receiverAuthority.privateKeyPem,
    })),
    { mode: 0o600 },
  );

  const offlineApiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) offlineApiRequests.push(request.url());
  });
  await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
  await page.getByRole("button", { name: "Verify a receipt" }).click();
  const proofRoom = page.getByRole("dialog", {
    name: "Verify integrity locally without querying the server",
  });
  await proofRoom.locator('.receipt-dropzone input[type="file"]')
    .setInputFiles(custodyPath!);
  await expect(proofRoom.getByText("Receiver custody path complete")).toBeVisible();
  await expect(proofRoom.getByText("Cryptographically valid")).toBeVisible();
  await expect(proofRoom.getByText("Organizational trust not fully evaluated"))
    .toBeVisible();
  const custodyPathRegion = proofRoom.getByRole("region", {
    name: "Verified receiver custody path",
  });
  await expect(custodyPathRegion.getByRole("listitem")).toHaveCount(5);
  await expect(custodyPathRegion.getByText("Producer signed work")).toBeVisible();
  await expect(custodyPathRegion.getByText("Canonical State advanced")).toBeVisible();

  for (const attack of [
    "Remove Admission",
    "Alter reviewed evidence",
    "Rewrite disposition",
  ]) {
    await proofRoom.getByRole("button", { name: attack }).click();
    await expect(proofRoom.getByText(/Attack detected at/)).toBeVisible();
    await proofRoom.getByRole("button", { name: "Reset disposable copy" }).click();
    await expect(proofRoom.getByText("Receiver custody path complete")).toBeVisible();
  }

  await proofRoom.getByText("Evaluate organizational trust").click();
  const producerTrust = proofRoom.getByRole("region", {
    name: "Producer organizational trust policy",
  });
  await producerTrust.getByRole("textbox", {
    name: "Producer trusted policy authority",
  }).fill(authority.keyId);
  await producerTrust.getByLabel("Import producer signed policy")
    .setInputFiles(trustPolicyPath);
  await expect(producerTrust.getByText("Policy authority verified")).toBeVisible();
  await expect(proofRoom.getByText("Both trust domains authorized")).not.toBeVisible();

  const receiverTrust = proofRoom.getByRole("region", {
    name: "Receiver organizational trust policy",
  });
  await receiverTrust.getByRole("textbox", {
    name: "Receiver trusted policy authority",
  }).fill(receiverAuthority.keyId);
  await receiverTrust.getByLabel("Import receiver signed policy")
    .setInputFiles(receiverTrustPolicyPath);
  await expect(receiverTrust.getByText("Policy authority verified")).toBeVisible();
  await expect(proofRoom.getByText("Both trust domains authorized")).toBeVisible();
  await expect(proofRoom.getByText("The signing key is trusted for this receipt's decision time and scope."))
    .toHaveCount(2);
  await proofRoom.getByRole("button", { name: "Rewrite disposition" }).click();
  await expect(proofRoom.getByText(/Attack detected at/)).toBeVisible();
  await proofRoom.locator('.receipt-dropzone input[type="file"]')
    .setInputFiles(quarantinedCustodyPath!);
  await expect(proofRoom.getByText(/Attack detected at/)).not.toBeVisible();
  await expect(proofRoom.getByText("Receiver containment path complete")).toBeVisible();
  await expect(proofRoom.getByText("Cryptographically valid")).toBeVisible();
  await expect(proofRoom.getByText("Candidate quarantined")).toBeVisible();
  await expect(
    custodyPathRegion.getByRole("listitem").last().getByText(/Canonical State remained at/),
  ).toBeVisible();
  await expect(proofRoom.getByText("Both trust domains authorized")).toBeVisible();
  expect(offlineApiRequests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
