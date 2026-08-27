import os from "node:os";
import path from "node:path";

export const liveModelArkAgentName = "Live ModelArk Proof";
export const liveModelArkPrompt =
  "Create modelark-proof.txt containing exactly modelark-live followed by a newline. Use no dependencies. Verify the file content before finishing.";

export const liveModelArkContract = Object.freeze({
  requiredPaths: ["AGENTS.md", "modelark-proof.txt"],
  protectedPaths: ["AGENTS.md"],
  maxChangedFiles: 4,
  maxAddedBytes: 4_096,
  secretPatterns: [],
  validationCommands: [
    {
      name: "modelark-live-content",
      command: 'test "$(cat modelark-proof.txt)" = modelark-live',
      required: true,
      timeoutMs: 10_000,
    },
  ],
});

export function assertSafeManagedRoot(projectRoot, stateRoot) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedStateRoot = path.resolve(stateRoot);
  const forbidden = new Set([
    path.parse(resolvedStateRoot).root,
    resolvedProjectRoot,
    os.homedir(),
  ]);
  if (forbidden.has(resolvedStateRoot) || path.dirname(resolvedStateRoot) === resolvedStateRoot) {
    throw new Error("Refusing to use an unsafe ModelArk demo data root: " + resolvedStateRoot);
  }
  return resolvedStateRoot;
}

export function comparableContract(contract) {
  return {
    requiredPaths: contract.requiredPaths,
    protectedPaths: contract.protectedPaths,
    maxChangedFiles: contract.maxChangedFiles,
    maxAddedBytes: contract.maxAddedBytes,
    secretPatterns: contract.secretPatterns,
    validationCommands: contract.validationCommands,
  };
}
