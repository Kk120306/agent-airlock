import { createHash } from "node:crypto";
import type {
  CandidateScorecardEntry,
  CandidateSelectionDecision,
  SelectionContract,
  SelectionCriterion,
  SelectionCriterionKind,
} from "./types.js";

export const SELECTION_CRITERIA = {
  "quality-assertion": {
    kind: "quality-assertion",
    source: "trusted-validation-evaluator",
    direction: "maximize",
    maximum: 1_000_000,
    evaluatorVersion: "airlock-validation-pass-rate-v1",
  },
  "changed-files": {
    kind: "changed-files",
    source: "workspace-change-evidence",
    direction: "minimize",
    maximum: 10_000,
    evaluatorVersion: "airlock-workspace-change-v1",
  },
  "added-bytes": {
    kind: "added-bytes",
    source: "workspace-change-evidence",
    direction: "minimize",
    maximum: 100_000_000,
    evaluatorVersion: "airlock-workspace-change-v1",
  },
  "latency-ms": {
    kind: "latency-ms",
    source: "monotonic-execution-measurement",
    direction: "minimize",
    maximum: 3_600_000,
    evaluatorVersion: "airlock-monotonic-runtime-v1",
  },
  "total-tokens": {
    kind: "total-tokens",
    source: "runtime-usage-response",
    direction: "minimize",
    maximum: 10_000_000,
    evaluatorVersion: "airlock-runtime-usage-v1",
  },
} as const satisfies Record<SelectionCriterionKind, SelectionCriterion>;

export interface CandidateSelectionInput {
  competitorId: string;
  requiredValidationsPassed: boolean;
  exclusions: string[];
  criterionValues: Partial<Record<SelectionCriterionKind, number>>;
}

export function createDefaultSelectionContract(): SelectionContract {
  return {
    schemaVersion: 1,
    criteria: [
      structuredClone(SELECTION_CRITERIA["quality-assertion"]),
      structuredClone(SELECTION_CRITERIA["changed-files"]),
      structuredClone(SELECTION_CRITERIA["added-bytes"]),
      structuredClone(SELECTION_CRITERIA["latency-ms"]),
      structuredClone(SELECTION_CRITERIA["total-tokens"]),
    ],
  };
}

export function assertSelectionContract(value: SelectionContract): void {
  if (value.schemaVersion !== 1 || !Array.isArray(value.criteria)) {
    throw new Error("Selection Contract schema is unsupported");
  }
  if (value.criteria.length < 1 || value.criteria.length > 5) {
    throw new Error("Selection Contract must declare one through five criteria");
  }
  const seen = new Set<string>();
  for (const criterion of value.criteria) {
    const expected = SELECTION_CRITERIA[criterion.kind];
    if (!expected || stableJson(criterion) !== stableJson(expected)) {
      throw new Error("Selection Contract contains an unsupported criterion definition");
    }
    if (seen.has(criterion.kind)) {
      throw new Error("Selection Contract contains duplicate criteria");
    }
    seen.add(criterion.kind);
  }
}

export function selectCandidates(input: {
  candidateSetId: string;
  sourceStateId: string;
  contract: SelectionContract;
  candidates: CandidateSelectionInput[];
}): CandidateSelectionDecision {
  assertSelectionContract(input.contract);
  assertIdentifier(input.candidateSetId, "Candidate Set identifier");
  assertIdentifier(input.sourceStateId, "source state identifier");
  if (input.candidates.length < 1 || input.candidates.length > 8) {
    throw new Error("Selection requires one through eight persisted Candidates");
  }
  const ids = new Set<string>();
  const scorecard = input.candidates.map((candidate) => {
    assertIdentifier(candidate.competitorId, "competitor identifier");
    if (ids.has(candidate.competitorId)) {
      throw new Error("Selection contains duplicate competitor identifiers");
    }
    ids.add(candidate.competitorId);
    const exclusions = normalizeExclusions(candidate);
    const components = input.contract.criteria.flatMap((criterion) => {
      const rawValue = candidate.criterionValues[criterion.kind];
      if (rawValue === undefined) {
        exclusions.push("missing-criterion:" + criterion.kind);
        return [];
      }
      if (
        !Number.isSafeInteger(rawValue) ||
        rawValue < 0 ||
        rawValue > criterion.maximum
      ) {
        throw new Error(
          "Selection criterion " + criterion.kind + " is outside its integer bound",
        );
      }
      return [
        {
          kind: criterion.kind,
          source: criterion.source,
          evaluatorVersion: criterion.evaluatorVersion,
          direction: criterion.direction,
          maximum: criterion.maximum,
          rawValue,
          normalizedValue:
            criterion.direction === "maximize"
              ? rawValue
              : criterion.maximum - rawValue,
        },
      ];
    });
    return {
      competitorId: candidate.competitorId,
      eligible: exclusions.length === 0,
      exclusions: [...new Set(exclusions)].sort(compareUtf8),
      components,
      rank: null,
    } as CandidateScorecardEntry;
  });

  const orderedEligible = scorecard
    .filter((entry) => entry.eligible)
    .sort((left, right) => compareEntries(left, right));
  orderedEligible.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  const orderedCompetitorIds = orderedEligible.map((entry) => entry.competitorId);
  const withoutDigest = {
    schemaVersion: 1 as const,
    candidateSetId: input.candidateSetId,
    sourceStateId: input.sourceStateId,
    orderedCompetitorIds,
    winnerCompetitorId: orderedCompetitorIds[0] ?? null,
    scorecard: scorecard.sort((left, right) =>
      compareUtf8(left.competitorId, right.competitorId),
    ),
    tieBreak: "competitor-id-ascending-byte-order" as const,
  };
  return {
    ...withoutDigest,
    decisionDigest: digest(withoutDigest),
  };
}

export function createQualityAssertion(input: {
  validations: ReadonlyArray<{ status: "passed" | "failed" | "error" }>;
}): number {
  if (input.validations.length === 0) return 0;
  const passed = input.validations.filter(
    (validation) => validation.status === "passed",
  ).length;
  return Math.floor((passed * SELECTION_CRITERIA["quality-assertion"].maximum) /
    input.validations.length);
}

function normalizeExclusions(candidate: CandidateSelectionInput): string[] {
  if (!Array.isArray(candidate.exclusions) || candidate.exclusions.length > 64) {
    throw new Error("Candidate exclusions are not bounded");
  }
  const exclusions = candidate.exclusions.map((exclusion) => {
    if (
      typeof exclusion !== "string" ||
      exclusion.length < 1 ||
      Buffer.byteLength(exclusion, "utf8") > 240
    ) {
      throw new Error("Candidate exclusion is invalid or oversized");
    }
    return exclusion;
  });
  if (!candidate.requiredValidationsPassed) {
    exclusions.push("required-validation-failed");
  }
  return exclusions;
}

function compareEntries(
  left: CandidateScorecardEntry,
  right: CandidateScorecardEntry,
): number {
  for (let index = 0; index < left.components.length; index += 1) {
    const difference =
      (right.components[index]?.normalizedValue ?? -1) -
      (left.components[index]?.normalizedValue ?? -1);
    if (difference !== 0) return difference;
  }
  return compareUtf8(left.competitorId, right.competitorId);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(label + " is invalid");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
