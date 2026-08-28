import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import {
  generatePortableSigningKey,
  signSigningKeyTrustPolicy,
  verifyFederatedWorkBundleJson,
  type FederatedWorkBundle,
  type SigningKeyTrustPolicy,
} from "@agent-airlock/portable-promotion-receipt";

const producerUrl = "http://127.0.0.1:3212";
const receiverUrl = "http://127.0.0.1:3213";

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
        dispositions: [bundle.receipt.receipt.decision.disposition],
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
        dispositions: ["promoted"],
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
        requireLocalApproval: false,
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
  await federationPanel.getByLabel("Transfer identity").fill("browser-handoff-001");
  await federationPanel.getByLabel("Federated Work Bundle").setInputFiles(bundlePath);
  await federationPanel.getByLabel("Signed Trust Policy").setInputFiles(trustPolicyPath);
  await federationPanel.getByRole("button", { name: "Admit into Candidate State" }).click();

  await expect(federationPanel.getByText("PROMOTED BY RECEIVER"))
    .toBeVisible({ timeout: 15_000 });
  await expect(federationPanel.getByText("Receiver Canonical State advanced atomically"))
    .toBeVisible();
  await expect(federationPanel.getByText("No model call runs during import."))
    .toBeVisible();
  const receiverRun = await request.get(receiverUrl + "/api/agents");
  expect(receiverRun.ok()).toBe(true);
});
