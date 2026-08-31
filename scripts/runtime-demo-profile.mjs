export const realRuntimeProofAgentName = "Real Runtime Proof";
export const realRuntimeProofAgentDescription =
  "Real Codex, isolated Candidate, validated Promotion";
export const realRuntimeProofAgentInstructions =
  "Keep every workspace, SQLite, and deferred-action change inside isolated Candidate State and complete the requested Whole-Agent protocol proof.";
export const productionImageBoundaryPrompt =
  "Apply the production image boundary proof through isolated Candidate State.";

export const productImageStructuralValidationName =
  "protocol-fixture-content";

const protocolValidationCommand = [
  'test "$(cat protocol-proof.txt)" = candidate-only',
  "node --no-warnings --experimental-sqlite --input-type=module -e 'import { DatabaseSync } from \"node:sqlite\"; const database = new DatabaseSync(\".airlock/demo.sqlite\"); const row = database.prepare(\"SELECT value FROM inventory WHERE id = ?\").get(\"demo\"); database.close(); if (row?.value !== \"candidate-only\") process.exit(1);'",
].join(" && ");

export const realRuntimeProofContract = Object.freeze({
  requiredPaths: ["AGENTS.md", "protocol-proof.txt"],
  protectedPaths: ["AGENTS.md"],
  maxChangedFiles: 4,
  maxAddedBytes: 65_536,
  secretPatterns: [],
  validationCommands: [
    {
      name: "protocol-content",
      command: protocolValidationCommand,
      required: true,
      timeoutMs: 10_000,
    },
  ],
});

export const productionImageRuntimeProofContract = Object.freeze({
  requiredPaths: ["AGENTS.md", "protocol-proof.txt"],
  protectedPaths: ["AGENTS.md"],
  maxChangedFiles: 4,
  maxAddedBytes: 65_536,
  secretPatterns: [],
  validationCommands: [],
});
