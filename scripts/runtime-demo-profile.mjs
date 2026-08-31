export const realRuntimeProofAgentName = "Real Runtime Proof";
export const realRuntimeProofAgentDescription =
  "Real Codex, isolated Candidate, validated Promotion";
export const realRuntimeProofAgentInstructions =
  "Keep every workspace, SQLite, and deferred-action change inside isolated Candidate State and complete the requested Whole-Agent protocol proof.";
export const productionImageBoundaryPrompt =
  "Apply the production image boundary proof through isolated Candidate State.";

export const productImageStructuralValidationName =
  "protocol-fixture-content";

export const realRuntimeProofContract = Object.freeze({
  requiredPaths: ["AGENTS.md", "protocol-proof.txt"],
  protectedPaths: ["AGENTS.md"],
  maxChangedFiles: 4,
  maxAddedBytes: 65_536,
  secretPatterns: [],
  validationCommands: [],
});
