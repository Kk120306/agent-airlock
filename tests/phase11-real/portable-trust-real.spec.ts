import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { verifyPortablePromotionEnvelopeJson } from "@agent-airlock/portable-promotion-receipt";

test("a real browser exports and independently verifies a Fastify-backed receipt", async ({
  page,
}) => {
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
