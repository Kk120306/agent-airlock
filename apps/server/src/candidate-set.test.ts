import { describe, expect, it } from "vitest";
import { createDefaultSelectionContract } from "./candidate-selection.js";
import {
  DEFAULT_CANDIDATE_SET_BUDGET,
  validateCandidateSetInput,
} from "./candidate-set.js";

const validInput = () => ({
  objective: "Implement the same objective through isolated approaches",
  competitors: [
    {
      id: "broad-valid",
      executorProfileId: "standard-v1",
      strategyInstruction: "Prefer broad, comprehensive changes.",
    },
    {
      id: "focused-valid",
      executorProfileId: "standard-v1",
      strategyInstruction: "Prefer the narrowest complete change.",
    },
  ],
  selectionContract: createDefaultSelectionContract(),
  maxConcurrency: 2,
  budget: structuredClone(DEFAULT_CANDIDATE_SET_BUDGET),
  loserPolicy: "retain" as const,
});

describe("Candidate Set admission", () => {
  it("normalizes a bounded credential-free request", () => {
    const accepted = validateCandidateSetInput(validInput());
    expect(accepted).toMatchObject({
      objective: "Implement the same objective through isolated approaches",
      maxConcurrency: 2,
      loserPolicy: "retain",
    });
  });

  it("rejects duplicate competitors, unknown profiles, unsafe bounds, and credentials", () => {
    const duplicate = validInput();
    duplicate.competitors[1]!.id = duplicate.competitors[0]!.id;
    expect(() => validateCandidateSetInput(duplicate)).toThrow(/duplicate/);

    const profile = validInput();
    profile.competitors[0]!.executorProfileId = "runtime-selected";
    expect(() => validateCandidateSetInput(profile)).toThrow(/trusted executor/);

    const concurrency = validInput();
    concurrency.maxConcurrency = 8;
    expect(() => validateCandidateSetInput(concurrency)).toThrow(/concurrency/);

    const credential = validInput();
    credential.competitors[0]!.strategyInstruction =
      "authorization=Bearer secretvalue123456789";
    expect(() => validateCandidateSetInput(credential)).toThrow(/credential-like/);
  });
});
