import { describe, expect, it } from "vitest";
import {
  createDefaultOutcomeContract,
  createNextOutcomeContract,
} from "./outcome-contract.js";
import type { OutcomeContractInput } from "./types.js";

const validInput = (): OutcomeContractInput => {
  const contract = createDefaultOutcomeContract();
  return {
    requiredPaths: contract.requiredPaths,
    protectedPaths: contract.protectedPaths,
    maxChangedFiles: contract.maxChangedFiles,
    maxAddedBytes: contract.maxAddedBytes,
    secretPatterns: contract.secretPatterns,
    validationCommands: contract.validationCommands,
  };
};

describe("Outcome Contract", () => {
  it("creates a new immutable version from bounded data", () => {
    const current = createDefaultOutcomeContract(4, "2026-01-01T00:00:00.000Z");
    const input = validInput();
    input.requiredPaths.push("src/**");

    const next = createNextOutcomeContract(current, input);

    expect(next).toMatchObject({
      schemaVersion: 1,
      version: 5,
      requiredPaths: ["AGENTS.md", "README.md", "src/**"],
    });
    expect(current.requiredPaths).toEqual(["AGENTS.md", "README.md"]);
    input.requiredPaths.push("after-creation.txt");
    expect(next.requiredPaths).not.toContain("after-creation.txt");
  });

  it.each([
    ["absolute path", (input: OutcomeContractInput) => input.requiredPaths.push("/etc/passwd")],
    ["parent path", (input: OutcomeContractInput) => input.protectedPaths.push("../secret")],
    ["duplicate path", (input: OutcomeContractInput) => input.requiredPaths.push("README.md")],
    ["invalid regex", (input: OutcomeContractInput) => input.secretPatterns.push({ name: "bad", pattern: "[" })],
    ["invalid command name", (input: OutcomeContractInput) => input.validationCommands.push({ name: "bad name", command: "true", required: true, timeoutMs: 1_000 })],
    ["short timeout", (input: OutcomeContractInput) => input.validationCommands.push({ name: "test", command: "true", required: true, timeoutMs: 999 })],
    ["unsafe file limit", (input: OutcomeContractInput) => { input.maxChangedFiles = 0; }],
  ])("rejects an %s", (_label, mutate) => {
    const input = validInput();
    mutate(input);
    expect(() => createNextOutcomeContract(createDefaultOutcomeContract(), input))
      .toThrow();
  });
});
