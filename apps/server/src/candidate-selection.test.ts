import { describe, expect, it } from "vitest";
import {
  createDefaultSelectionContract,
  selectCandidates,
} from "./candidate-selection.js";

const candidate = (
  competitorId: string,
  values: Partial<Record<
    "quality-assertion" | "changed-files" | "added-bytes" | "latency-ms" | "total-tokens",
    number
  >>,
  requiredValidationsPassed = true,
) => ({
  competitorId,
  requiredValidationsPassed,
  exclusions: [],
  criterionValues: values,
});

const completeValues = {
  "quality-assertion": 900_000,
  "changed-files": 2,
  "added-bytes": 100,
  "latency-ms": 20,
  "total-tokens": 50,
};

describe("Candidate Selection", () => {
  it("excludes failed required Validation regardless of a better score", () => {
    const decision = selectCandidates({
      candidateSetId: "set-1",
      sourceStateId: "state-1",
      contract: createDefaultSelectionContract(),
      candidates: [
        candidate("unsafe-fast", {
          "quality-assertion": 1_000_000,
          "changed-files": 0,
          "added-bytes": 0,
          "latency-ms": 1,
          "total-tokens": 1,
        }, false),
        candidate("focused-valid", completeValues),
      ],
    });
    expect(decision.winnerCompetitorId).toBe("focused-valid");
    expect(decision.scorecard.find((entry) => entry.competitorId === "unsafe-fast"))
      .toMatchObject({
        eligible: false,
        rank: null,
        exclusions: ["required-validation-failed"],
      });
  });

  it("is independent of scheduling order and uses UTF-8 identifier order last", () => {
    const first = selectCandidates({
      candidateSetId: "set-1",
      sourceStateId: "state-1",
      contract: createDefaultSelectionContract(),
      candidates: [candidate("beta", completeValues), candidate("alpha", completeValues)],
    });
    const second = selectCandidates({
      candidateSetId: "set-1",
      sourceStateId: "state-1",
      contract: createDefaultSelectionContract(),
      candidates: [candidate("alpha", completeValues), candidate("beta", completeValues)],
    });
    expect(first).toEqual(second);
    expect(first.orderedCompetitorIds).toEqual(["alpha", "beta"]);
    expect(first.winnerCompetitorId).toBe("alpha");
  });

  it("rejects missing, floating-point, negative, oversized, duplicate, and forged criteria", () => {
    const contract = createDefaultSelectionContract();
    expect(() => selectCandidates({
      candidateSetId: "set-1",
      sourceStateId: "state-1",
      contract,
      candidates: [candidate("missing", { "quality-assertion": 1 })],
    })).not.toThrow();
    const missing = selectCandidates({
      candidateSetId: "set-1",
      sourceStateId: "state-1",
      contract,
      candidates: [candidate("missing", { "quality-assertion": 1 })],
    });
    expect(missing.winnerCompetitorId).toBeNull();
    for (const invalid of [-1, 1.5, 1_000_001, Number.NaN]) {
      expect(() => selectCandidates({
        candidateSetId: "set-1",
        sourceStateId: "state-1",
        contract,
        candidates: [candidate("invalid", { ...completeValues, "quality-assertion": invalid })],
      })).toThrow(/integer bound/);
    }
    expect(() => selectCandidates({
      candidateSetId: "set-1",
      sourceStateId: "state-1",
      contract,
      candidates: [candidate("same", completeValues), candidate("same", completeValues)],
    })).toThrow(/duplicate competitor/);
    const forged = createDefaultSelectionContract();
    forged.criteria[0]!.maximum = 2_000_000;
    expect(() => selectCandidates({
      candidateSetId: "set-1",
      sourceStateId: "state-1",
      contract: forged,
      candidates: [candidate("forged", completeValues)],
    })).toThrow(/unsupported criterion/);
  });

  it("produces a byte-identical digest for byte-identical evidence", () => {
    const input = {
      candidateSetId: "set-1",
      sourceStateId: "state-1",
      contract: createDefaultSelectionContract(),
      candidates: [candidate("focused", completeValues)],
    };
    expect(selectCandidates(input)).toEqual(selectCandidates(structuredClone(input)));
    expect(selectCandidates(input).decisionDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
