import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import {
  generatePortableSigningKey,
  signPolicyAuthorityRotation,
  signSigningKeyTrustPolicy,
  verifyPortableEvidencePacketJson,
  verifyPortablePromotionEnvelopeJson,
} from "@agent-airlock/portable-promotion-receipt";
import type {
  PortablePromotionEnvelope,
  SigningKeyTrustPolicy,
} from "@agent-airlock/portable-promotion-receipt";

test("a real browser exports and independently verifies a Fastify-backed receipt", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Demo step 1: Promote release" }).click();
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Prepared the multi-resource release with workspace/))
    .toBeVisible({ timeout: 15_000 });

  const panel = page.getByRole("region", { name: "Portable trust receipt" });
  await panel.getByRole("checkbox", {
    name: /Append to local transparency log/,
  }).check();
  await panel.getByRole("checkbox", {
    name: /Prepare digest-only EVM calldata/,
  }).check();
  await panel.getByRole("button", { name: "Generate receipt" }).click();
  await expect(panel.getByText("Self-check passed")).toBeVisible();

  const receiptDownloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download receipt JSON" }).click();
  const receiptDownload = await receiptDownloadPromise;
  const receiptPath = await receiptDownload.path();
  expect(receiptPath).not.toBeNull();
  const source = await readFile(receiptPath!, "utf8");
  const report = verifyPortablePromotionEnvelopeJson(source);
  expect(report.valid).toBe(true);
  expect(report.provenClaims.length).toBeGreaterThan(0);

  const packetDownloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download evidence packet" }).click();
  const packetDownload = await packetDownloadPromise;
  const packetPath = await packetDownload.path();
  expect(packetPath).not.toBeNull();
  const packetSource = await readFile(packetPath!, "utf8");
  const packetReport = verifyPortableEvidencePacketJson(packetSource);
  expect(packetReport).toMatchObject({
    valid: true,
    anchor: { valid: true },
    evmPayload: { valid: true },
  });

  const localVerificationRequests: string[] = [];
  const recordRequest = (request: { url(): string }) => {
    if (request.url().includes("/api/")) localVerificationRequests.push(request.url());
  };
  page.on("request", recordRequest);
  await page.getByRole("button", { name: "Verify a receipt" }).click();
  const verifier = page.getByRole("dialog", {
    name: "Verify integrity locally without querying the server",
  });
  await verifier.locator('.receipt-dropzone input[type="file"]').setInputFiles(packetPath!);
  await expect(verifier.getByText("Cryptographic proof valid")).toBeVisible();
  await expect(verifier.getByText("Every included proof matches")).toBeVisible();
  await expect(
    verifier.getByRole("region", { name: "Evidence packet checks" }).getByText("PASS"),
  ).toHaveCount(4);
  expect(localVerificationRequests).toEqual([]);

  const downloadedEnvelope = JSON.parse(source) as PortablePromotionEnvelope;
  const trustPolicy: SigningKeyTrustPolicy = {
    schema: "agent-airlock/signing-key-trust-policy",
    schemaVersion: 1,
    policyId: "judge-policy-v1",
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    keys: [
      {
        keyId: downloadedEnvelope.keyId,
        status: "active",
        validFrom: "2020-01-01T00:00:00.000Z",
        validUntil: null,
        agentIds: [downloadedEnvelope.receipt.decision.agentId],
        dispositions: [downloadedEnvelope.receipt.decision.disposition],
        note: "Judge-approved local demo signer",
      },
    ],
  };
  const policyRootAuthority = generatePortableSigningKey();
  const policyAuthority = generatePortableSigningKey();
  const authorityRotationPath = testInfo.outputPath("authority-rotation.json");
  await writeFile(
    authorityRotationPath,
    JSON.stringify(
      signPolicyAuthorityRotation({
        rotation: {
          schema: "agent-airlock/policy-authority-rotation",
          schemaVersion: 1,
          rotationId: "judge-authority-rotation-1",
          issuedAt: "2020-01-01T00:00:00.000Z",
          effectiveAt: "2020-01-02T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          previousAuthorityKeyId: policyRootAuthority.keyId,
          nextAuthorityKeyId: policyAuthority.keyId,
          nextAuthorityPublicJwk: policyAuthority.publicJwk,
        },
        privateKey: policyRootAuthority.privateKeyPem,
      }),
    ),
    { mode: 0o600 },
  );
  const trustPolicyPath = testInfo.outputPath("judge-trust-policy.json");
  await writeFile(
    trustPolicyPath,
    JSON.stringify(
      signSigningKeyTrustPolicy({
        policy: trustPolicy,
        privateKey: policyAuthority.privateKeyPem,
      }),
    ),
    { mode: 0o600 },
  );
  const trustRegion = verifier.getByRole("region", {
    name: "Organizational trust policy",
  });
  await trustRegion
    .getByRole("textbox", { name: "Trusted policy authority" })
    .fill(policyRootAuthority.keyId);
  await trustRegion
    .getByLabel("Import authority rotation")
    .setInputFiles(authorityRotationPath);
  await expect(verifier.getByText("Authority continuity verified")).toBeVisible();
  await trustRegion
    .getByLabel("Import signed policy")
    .setInputFiles(trustPolicyPath);
  await expect(verifier.getByText("Policy authority verified")).toBeVisible();
  await expect(verifier.getByText("Organizational signer trust passed")).toBeVisible();
  const trustChain = verifier.getByRole("region", { name: "Verified trust chain" });
  await expect(trustChain.getByText("Pinned root")).toBeVisible();
  await expect(trustChain.getByText("Key rotation")).toBeVisible();
  await expect(trustChain.getByText("Continuity verified")).toBeVisible();
  await expect(trustChain.getByText("Scope trusted")).toBeVisible();
  expect(localVerificationRequests).toEqual([]);

  await trustRegion
    .getByRole("textbox", { name: "Trusted policy authority" })
    .fill(`sha256:${"f".repeat(64)}`);
  await expect(verifier.getByText("Policy authority rejected")).toBeVisible();
  await expect(verifier.getByText("Organizational signer trust passed")).not.toBeVisible();
  await trustRegion
    .getByRole("textbox", { name: "Trusted policy authority" })
    .fill(policyRootAuthority.keyId);
  await expect(verifier.getByText("Authority continuity verified")).toBeVisible();
  await expect(verifier.getByText("Policy authority verified")).toBeVisible();
  await expect(verifier.getByText("Organizational signer trust passed")).toBeVisible();
  expect(localVerificationRequests).toEqual([]);

  trustPolicy.keys[0]!.status = "compromised";
  const compromisedPolicyPath = testInfo.outputPath("compromised-trust-policy.json");
  await writeFile(
    compromisedPolicyPath,
    JSON.stringify(
      signSigningKeyTrustPolicy({
        policy: trustPolicy,
        privateKey: policyAuthority.privateKeyPem,
      }),
    ),
    { mode: 0o600 },
  );
  await trustRegion
    .getByLabel("Import signed policy")
    .setInputFiles(compromisedPolicyPath);
  await expect(verifier.getByText("Organizational signer trust failed")).toBeVisible();
  await expect(verifier.getByText(/marks this signing key as compromised/)).toBeVisible();
  expect(localVerificationRequests).toEqual([]);

  const tamperedPacket = JSON.parse(packetSource) as {
    evmPayload: { calldata: string };
  };
  tamperedPacket.evmPayload.calldata = `0xeecdf927${"f".repeat(64)}`;
  const tamperedPacketPath = testInfo.outputPath("tampered-evidence-packet.json");
  await writeFile(tamperedPacketPath, JSON.stringify(tamperedPacket), { mode: 0o600 });
  await verifier
    .locator('.receipt-dropzone input[type="file"]')
    .setInputFiles(tamperedPacketPath);
  await expect(verifier.getByText("Bundled proof mismatch")).toBeVisible();
  await expect(verifier.getByText("Do not rely on this evidence.")).toBeVisible();
  expect(localVerificationRequests).toEqual([]);

  const tampered = JSON.parse(source) as {
    receipt: { outcomeContract: { version: number } };
  };
  tampered.receipt.outcomeContract.version += 1;
  const tamperedPath = testInfo.outputPath("tampered-receipt.json");
  await writeFile(tamperedPath, JSON.stringify(tampered), { mode: 0o600 });
  await verifier.locator('.receipt-dropzone input[type="file"]').setInputFiles(tamperedPath);
  await expect(verifier.getByText("Verification failed")).toBeVisible();
  await expect(verifier.getByText("FAIL", { exact: true })).toBeVisible();
  expect(localVerificationRequests).toEqual([]);
  await verifier.getByRole("button", { name: "Close receipt verifier" }).click();
  page.off("request", recordRequest);

  const anchorDownloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download anchor proof" }).click();
  const anchorDownload = await anchorDownloadPromise;
  const anchorPath = await anchorDownload.path();
  expect(anchorPath).not.toBeNull();
  const anchor = JSON.parse(
    await readFile(anchorPath!, "utf8"),
  ) as Record<string, unknown>;
  expect(anchor).toEqual(
    expect.objectContaining({
      checkpoint: expect.any(Object),
      inclusionProof: expect.any(Object),
    }),
  );

  const evmDownloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download EVM payload" }).click();
  const evmDownload = await evmDownloadPromise;
  const evmPath = await evmDownload.path();
  expect(evmPath).not.toBeNull();
  const evm = JSON.parse(
    await readFile(evmPath!, "utf8"),
  ) as Record<string, unknown>;
  expect(evm).toMatchObject({ networkCalls: 0, fundsSpent: 0 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const mobilePanel = page.getByRole("region", { name: "Portable trust receipt" });
  await expect(mobilePanel).toBeVisible();
  const essentialFontSizes = await mobilePanel
    .locator(
      ".portable-trust-heading p, .portable-options strong, .portable-options small, .portable-trust-levels",
    )
    .evaluateAll((elements) =>
      elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    );
  expect(Math.min(...essentialFontSizes)).toBeGreaterThanOrEqual(12);
  await mobilePanel.getByRole("checkbox", {
    name: /Append to local transparency log/,
  }).check();
  await mobilePanel.getByRole("checkbox", {
    name: /Prepare digest-only EVM calldata/,
  }).check();
  await mobilePanel.getByRole("button", { name: "Generate receipt" }).click();
  await expect(mobilePanel.getByText("Self-check passed")).toBeVisible();

  const mobileReceiptPromise = page.waitForEvent("download");
  await mobilePanel.getByRole("button", { name: "Download receipt JSON" }).click();
  const mobileReceipt = await mobileReceiptPromise;
  const mobileReceiptPath = await mobileReceipt.path();
  expect(mobileReceiptPath).not.toBeNull();
  expect(
    verifyPortablePromotionEnvelopeJson(await readFile(mobileReceiptPath!, "utf8"))
      .valid,
  ).toBe(true);

  await page.getByRole("button", { name: "Verify a receipt" }).click();
  const mobileVerifier = page.getByRole("dialog", {
    name: "Verify integrity locally without querying the server",
  });
  await mobileVerifier
    .locator('.receipt-dropzone input[type="file"]')
    .setInputFiles(mobileReceiptPath!);
  await expect(mobileVerifier.getByText("Cryptographic proof valid")).toBeVisible();
  const mobileTrustRegion = mobileVerifier.getByRole("region", {
    name: "Organizational trust policy",
  });
  await mobileTrustRegion
    .getByRole("textbox", { name: "Trusted policy authority" })
    .fill(policyRootAuthority.keyId);
  await mobileTrustRegion
    .getByLabel("Import authority rotation")
    .setInputFiles(authorityRotationPath);
  await expect(mobileVerifier.getByText("Authority continuity verified")).toBeVisible();
  await mobileTrustRegion
    .getByLabel("Import signed policy")
    .setInputFiles(trustPolicyPath);
  await expect(mobileVerifier.getByText("Policy authority verified")).toBeVisible();
  await expect(mobileVerifier.getByText("Organizational signer trust passed")).toBeVisible();
  const mobileEvidenceFonts = await mobileVerifier
    .locator(
      ".verifier-checks small, .verifier-identities code, .verifier-authority-root span, .verifier-authority-root input, .verifier-policy-verdict small, .verifier-trust-verdict small",
    )
    .evaluateAll((elements) =>
      elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    );
  expect(Math.min(...mobileEvidenceFonts)).toBeGreaterThanOrEqual(10);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  await mobileVerifier.getByRole("button", { name: "Close receipt verifier" }).click();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");

  for (const buttonName of ["Download anchor proof", "Download EVM payload"]) {
    const mobileDownloadPromise = page.waitForEvent("download");
    await mobilePanel.getByRole("button", { name: buttonName }).click();
    const mobileDownload = await mobileDownloadPromise;
    expect(await mobileDownload.path()).not.toBeNull();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    390,
  );
});
