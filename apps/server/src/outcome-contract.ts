import { HttpError } from "./errors.js";
import type { OutcomeContract, OutcomeContractInput } from "./types.js";

const DEFAULT_SECRET_PATTERNS = [
  {
    name: "ark-api-key-assignment",
    pattern: "ARK_API_KEY\\s*[:=]\\s*['\\\"]?[^\\s'\\\"]{8,}",
  },
  {
    name: "bearer-token",
    pattern: "Bearer\\s+[A-Za-z0-9._~+/-]{12,}=*",
  },
];

export function createDefaultOutcomeContract(
  version = 1,
  createdAt = new Date().toISOString(),
): OutcomeContract {
  return {
    schemaVersion: 1,
    version,
    requiredPaths: ["AGENTS.md", "README.md"],
    protectedPaths: ["AGENTS.md"],
    maxChangedFiles: 200,
    maxAddedBytes: 2_097_152,
    secretPatterns: structuredClone(DEFAULT_SECRET_PATTERNS),
    validationCommands: [],
    createdAt,
  };
}

export function createLegacyPhaseOneContract(
  createdAt = new Date().toISOString(),
): OutcomeContract {
  return {
    schemaVersion: 1,
    version: 1,
    requiredPaths: ["AGENTS.md"],
    protectedPaths: [],
    maxChangedFiles: 10_000,
    maxAddedBytes: 1_073_741_824,
    secretPatterns: [],
    validationCommands: [],
    createdAt,
  };
}

export function createNextOutcomeContract(
  current: OutcomeContract,
  input: OutcomeContractInput,
): OutcomeContract {
  validateOutcomeContractInput(input);
  return {
    schemaVersion: 1,
    version: current.version + 1,
    requiredPaths: [...input.requiredPaths],
    protectedPaths: [...input.protectedPaths],
    maxChangedFiles: input.maxChangedFiles,
    maxAddedBytes: input.maxAddedBytes,
    secretPatterns: structuredClone(input.secretPatterns),
    validationCommands: structuredClone(input.validationCommands),
    createdAt: new Date().toISOString(),
  };
}

export function validateOutcomeContractInput(input: OutcomeContractInput): void {
  if (
    !Number.isInteger(input.maxChangedFiles) ||
    input.maxChangedFiles < 1 ||
    input.maxChangedFiles > 10_000 ||
    !Number.isInteger(input.maxAddedBytes) ||
    input.maxAddedBytes < 0 ||
    input.maxAddedBytes > 1_073_741_824
  ) {
    throw new HttpError(400, "Outcome Contract limits are outside the safe range");
  }
  if (
    input.requiredPaths.length > 100 ||
    input.protectedPaths.length > 100 ||
    input.secretPatterns.length > 50 ||
    input.validationCommands.length > 20
  ) {
    throw new HttpError(400, "Outcome Contract contains too many rules");
  }
  for (const pattern of [...input.requiredPaths, ...input.protectedPaths]) {
    if (
      !pattern ||
      pattern.startsWith("/") ||
      pattern.includes("\\") ||
      pattern.split("/").includes("..")
    ) {
      throw new HttpError(400, "Outcome Contract contains an unsafe path pattern");
    }
    if (pattern.length > 240) {
      throw new HttpError(400, "Outcome Contract path patterns are too long");
    }
  }
  if (new Set(input.requiredPaths).size !== input.requiredPaths.length) {
    throw new HttpError(400, "Outcome Contract required paths must be unique");
  }
  if (new Set(input.protectedPaths).size !== input.protectedPaths.length) {
    throw new HttpError(400, "Outcome Contract protected paths must be unique");
  }
  for (const secretPattern of input.secretPatterns) {
    validateRuleName(secretPattern.name);
    if (!secretPattern.pattern || secretPattern.pattern.length > 1_000) {
      throw new HttpError(400, "Outcome Contract secret pattern is too long");
    }
    try {
      new RegExp(secretPattern.pattern, "g");
    } catch {
      throw new HttpError(
        400,
        "Outcome Contract secret pattern is not a valid regular expression: " +
          secretPattern.name,
      );
    }
  }
  for (const command of input.validationCommands) {
    validateRuleName(command.name);
    if (
      !command.command.trim() ||
      command.command.length > 2_000 ||
      !Number.isInteger(command.timeoutMs) ||
      command.timeoutMs < 1_000 ||
      command.timeoutMs > 300_000
    ) {
      throw new HttpError(400, "Outcome Contract command is outside the safe range");
    }
  }
  const names = [
    ...input.secretPatterns.map((pattern) => "secret:" + pattern.name),
    ...input.validationCommands.map((command) => "command:" + command.name),
  ];
  if (new Set(names).size !== names.length) {
    throw new HttpError(400, "Outcome Contract names must be unique");
  }
}

function validateRuleName(name: string): void {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) {
    throw new HttpError(400, "Outcome Contract rule names are invalid");
  }
}
