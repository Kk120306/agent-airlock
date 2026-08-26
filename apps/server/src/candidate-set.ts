import { redactSensitiveText } from "@agent-airlock/transactional-resource-sdk";
import { assertSelectionContract } from "./candidate-selection.js";
import type {
  CandidateSetBudget,
  CreateCandidateSetInput,
} from "./types.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const trustedExecutorProfiles = new Set(["standard-v1"]);

export const DEFAULT_CANDIDATE_SET_BUDGET: CandidateSetBudget = {
  maxDurationMsPerCompetitor: 600_000,
  maxTotalTokens: 2_000_000,
  maxTotalChangedBytes: 200_000_000,
};

export function validateCandidateSetInput(
  input: CreateCandidateSetInput,
): CreateCandidateSetInput {
  const objective = assertSafeText(input.objective, "objective", 1, 50_000);
  if (!Array.isArray(input.competitors) || input.competitors.length < 2 ||
      input.competitors.length > 8) {
    throw new Error("Candidate Set must contain two through eight competitors");
  }
  const identifiers = new Set<string>();
  const competitors = input.competitors.map((competitor) => {
    if (!identifierPattern.test(competitor.id)) {
      throw new Error("Competitor identifier is invalid");
    }
    if (identifiers.has(competitor.id)) {
      throw new Error("Candidate Set contains duplicate competitor identifiers");
    }
    identifiers.add(competitor.id);
    if (!trustedExecutorProfiles.has(competitor.executorProfileId)) {
      throw new Error("Competitor uses an unsupported trusted executor profile");
    }
    return {
      id: competitor.id,
      executorProfileId: competitor.executorProfileId,
      strategyInstruction: assertSafeText(
        competitor.strategyInstruction,
        "strategy instruction",
        1,
        4_000,
      ),
    };
  });
  assertSelectionContract(input.selectionContract);
  if (
    !Number.isSafeInteger(input.maxConcurrency) ||
    input.maxConcurrency < 1 ||
    input.maxConcurrency > Math.min(4, competitors.length)
  ) {
    throw new Error("Candidate Set concurrency must be between one and four competitors");
  }
  assertBudget(input.budget, competitors.length);
  if (input.loserPolicy !== "retain" && input.loserPolicy !== "discard") {
    throw new Error("Candidate Set loser policy is unsupported");
  }
  return {
    objective,
    competitors,
    selectionContract: structuredClone(input.selectionContract),
    maxConcurrency: input.maxConcurrency,
    budget: structuredClone(input.budget),
    loserPolicy: input.loserPolicy,
  };
}

function assertBudget(
  budget: CandidateSetBudget,
  competitorCount: number,
): void {
  if (
    !budget ||
    !Number.isSafeInteger(budget.maxDurationMsPerCompetitor) ||
    budget.maxDurationMsPerCompetitor < 1_000 ||
    budget.maxDurationMsPerCompetitor > 3_600_000 ||
    !Number.isSafeInteger(budget.maxTotalTokens) ||
    budget.maxTotalTokens < competitorCount ||
    budget.maxTotalTokens > 10_000_000 ||
    !Number.isSafeInteger(budget.maxTotalChangedBytes) ||
    budget.maxTotalChangedBytes < 0 ||
    budget.maxTotalChangedBytes > 800_000_000
  ) {
    throw new Error(
      "Candidate Set budget is invalid, cannot reserve one token per competitor, or is outside its fixed bounds",
    );
  }
}

function assertSafeText(
  value: string,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  if (typeof value !== "string") throw new Error("Candidate Set " + label + " is invalid");
  const normalized = value.trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw new Error("Candidate Set " + label + " is empty or oversized");
  }
  if (redactSensitiveText(normalized) !== normalized) {
    throw new Error("Candidate Set " + label + " contains credential-like content");
  }
  return normalized;
}
