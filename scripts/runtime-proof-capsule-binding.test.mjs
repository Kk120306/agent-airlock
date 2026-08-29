import assert from "node:assert/strict";
import test from "node:test";

import { assertRuntimeProofCapsuleChainBinding } from "./runtime-proof-capsule-binding.mjs";

const hashes = Array.from({ length: 4 }, (_, index) =>
  "sha256:" + String(index + 1).repeat(64),
);

function fixture() {
  const result = {
    leafReceiptDigest: hashes[3],
    runs: {
      promotion: {
        runId: "promotion",
        disposition: "promoted",
        canonicalStateIdBefore: "state-zero",
        canonicalStateIdAfter: "state-one",
        canonicalContentHashBefore: hashes[0],
        canonicalContentHashAfter: hashes[1],
      },
      quarantine: {
        runId: "quarantine",
        disposition: "quarantined",
        canonicalStateIdBefore: "state-one",
        canonicalStateIdAfter: "state-one",
        canonicalContentHashBefore: hashes[1],
        canonicalContentHashAfter: hashes[1],
      },
      repair: {
        runId: "repair",
        disposition: "promoted",
        canonicalStateIdBefore: "state-one",
        canonicalStateIdAfter: "state-two",
        canonicalContentHashBefore: hashes[1],
        canonicalContentHashAfter: hashes[2],
      },
    },
  };
  const parentReceiptDigest = "sha256:" + "9".repeat(64);
  const chainDocument = {
    packets: [
      {
        envelope: {
          receiptDigest: parentReceiptDigest,
          receipt: {
            decision: { runId: "quarantine", disposition: "quarantined" },
            state: {
              before: { stateId: "state-one", compositeHash: hashes[1] },
              after: { stateId: "state-one", compositeHash: hashes[1] },
            },
            ancestry: {
              rootRunId: "quarantine",
              parentRunId: null,
              depth: 0,
              previousReceiptDigest: null,
            },
          },
        },
      },
      {
        envelope: {
          receiptDigest: hashes[3],
          receipt: {
            decision: { runId: "repair", disposition: "promoted" },
            state: {
              before: { stateId: "state-one", compositeHash: hashes[1] },
              after: { stateId: "state-two", compositeHash: hashes[2] },
            },
            ancestry: {
              rootRunId: "quarantine",
              parentRunId: "quarantine",
              depth: 1,
              previousReceiptDigest: parentReceiptDigest,
            },
          },
        },
      },
    ],
  };
  return { result, chainDocument };
}

test("binds every chain-backed capsule state field and labels Promotion honestly", () => {
  const value = fixture();
  assert.deepEqual(assertRuntimeProofCapsuleChainBinding(value), {
    chainBackedRuns: ["quarantine", "repair"],
    promotionClaim: "runner-observed-capsule-not-signed",
  });
});

for (const [label, mutate] of [
  ["quarantine Run", (value) => (value.result.runs.quarantine.runId = "other")],
  ["quarantine disposition", (value) => (value.chainDocument.packets[0].envelope.receipt.decision.disposition = "promoted")],
  ["quarantine state before", (value) => (value.result.runs.quarantine.canonicalStateIdBefore = "other")],
  ["quarantine hash before", (value) => (value.result.runs.quarantine.canonicalContentHashBefore = hashes[0])],
  ["quarantine state after", (value) => (value.result.runs.quarantine.canonicalStateIdAfter = "other")],
  ["quarantine hash after", (value) => (value.result.runs.quarantine.canonicalContentHashAfter = hashes[0])],
  ["repair Run", (value) => (value.result.runs.repair.runId = "other")],
  ["repair disposition", (value) => (value.chainDocument.packets[1].envelope.receipt.decision.disposition = "quarantined")],
  ["repair state before", (value) => (value.result.runs.repair.canonicalStateIdBefore = "other")],
  ["repair hash before", (value) => (value.result.runs.repair.canonicalContentHashBefore = hashes[0])],
  ["repair state after", (value) => (value.result.runs.repair.canonicalStateIdAfter = "other")],
  ["repair hash after", (value) => (value.result.runs.repair.canonicalContentHashAfter = hashes[0])],
  ["root ancestry", (value) => (value.chainDocument.packets[1].envelope.receipt.ancestry.rootRunId = "other")],
  ["parent ancestry", (value) => (value.chainDocument.packets[1].envelope.receipt.ancestry.parentRunId = "other")],
  ["receipt ancestry", (value) => (value.chainDocument.packets[1].envelope.receipt.ancestry.previousReceiptDigest = hashes[0])],
  ["leaf receipt", (value) => (value.result.leafReceiptDigest = hashes[0])],
  ["state handoff", (value) => (value.chainDocument.packets[1].envelope.receipt.state.before.stateId = "other")],
  ["Promotion continuity", (value) => (value.result.runs.promotion.canonicalStateIdAfter = "other")],
]) {
  test(`rejects drifted ${label}`, () => {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => assertRuntimeProofCapsuleChainBinding(value),
      /Runtime proof/,
    );
  });
}
