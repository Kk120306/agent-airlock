import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { digestPortableReceipt } from "./crypto.js";
import type { PortablePromotionEnvelope } from "./types.js";
import { verifyPortablePromotionEnvelopeJson } from "./verifier.js";

describe("published portable receipt golden vector", () => {
  it("verifies with only the envelope and included public key", async () => {
    const source = await readFile(
      new URL("../vectors/portable-receipt-v1.golden.json", import.meta.url),
      "utf8",
    );
    const document = JSON.parse(source) as { envelope: PortablePromotionEnvelope };
    const report = verifyPortablePromotionEnvelopeJson(
      JSON.stringify(document.envelope),
    );
    expect(report.valid).toBe(true);
    expect(digestPortableReceipt(document.envelope.receipt)).toBe(
      "sha256:1838711acf64d074c54994e72a44039de30e5766dde874acd29fd68ce305c965",
    );
    expect(source).not.toContain("PRIVATE KEY");
  });
});
