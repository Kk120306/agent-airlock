import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generatePortableSigningKey, signPortableReceipt } from "./crypto.js";
import {
  buildPortableDecisionChain,
  verifyPortableDecisionChain,
} from "./decision-chain.js";
import { buildPortableEvidencePacket } from "./evidence-packet.js";
import type {
  PortableDecisionChain,
  PortablePromotionEnvelope,
  PortablePromotionReceipt,
} from "./types.js";

async function fixture(
  overrides: Partial<PortablePromotionReceipt["ancestry"]> = {},
): Promise<PortableDecisionChain> {
  const source = await readFile(
    new URL("../vectors/portable-receipt-v1.golden.json", import.meta.url),
    "utf8",
  );
  const template = (JSON.parse(source) as { envelope: PortablePromotionEnvelope }).envelope;
  const key = generatePortableSigningKey();
  const parent = signPortableReceipt({
    receipt: template.receipt,
    privateKey: key.privateKeyPem,
    disclosures: [],
  });
  const childReceipt = structuredClone(template.receipt);
  childReceipt.decision.runId = "run-repair";
  childReceipt.state.before = structuredClone(parent.receipt.state.after);
  childReceipt.ancestry = {
    rootRunId: parent.receipt.decision.runId,
    parentRunId: parent.receipt.decision.runId,
    depth: 1,
    maxDepth: parent.receipt.ancestry.maxDepth,
    previousReceiptDigest: parent.receiptDigest,
    ...overrides,
  };
  const child = signPortableReceipt({
    receipt: childReceipt,
    privateKey: key.privateKeyPem,
    disclosures: [],
  });
  return {
    schema: "agent-airlock/portable-decision-chain",
    schemaVersion: 1,
    packets: [
      buildPortableEvidencePacket({ envelope: parent, anchor: null, evmPayload: null }),
      buildPortableEvidencePacket({ envelope: child, anchor: null, evmPayload: null }),
    ],
  };
}

describe("portable decision chain", () => {
  it("verifies a complete root-to-repair lineage and state handoff", async () => {
    const chain = buildPortableDecisionChain((await fixture()).packets);
    const report = verifyPortableDecisionChain(chain);

    expect(report.valid).toBe(true);
    expect(report.packets).toHaveLength(2);
    expect(report.leafReceiptDigest).toBe(chain.packets[1]!.envelope.receiptDigest);
    expect(report.checks.map((check) => check.name)).toEqual([
      "chain-schema",
      "chain-packets",
      "chain-root",
      "chain-links",
      "chain-state-continuity",
    ]);
  });

  it("rejects a valid child receipt that names the wrong prior digest", async () => {
    const chain = await fixture({ previousReceiptDigest: `sha256:${"ab".repeat(32)}` });
    const report = verifyPortableDecisionChain(chain);

    expect(report.packets.every((packet) => packet.valid)).toBe(true);
    expect(report.valid).toBe(false);
    expect(report.checks.find((check) => check.name === "chain-links")?.valid).toBe(false);
  });

  it("rejects a valid child receipt with a discontinuous starting state", async () => {
    const chain = await fixture();
    const key = generatePortableSigningKey();
    const childReceipt = structuredClone(chain.packets[1]!.envelope.receipt);
    childReceipt.state.before.compositeHash = `sha256:${"cd".repeat(32)}`;
    chain.packets[1]!.envelope = signPortableReceipt({
      receipt: childReceipt,
      privateKey: key.privateKeyPem,
      disclosures: [],
    });
    childReceipt.ancestry.previousReceiptDigest = chain.packets[0]!.envelope.receiptDigest;

    const report = verifyPortableDecisionChain(chain);
    expect(report.valid).toBe(false);
    expect(
      report.checks.find((check) => check.name === "chain-state-continuity")?.valid,
    ).toBe(false);
  });
});
