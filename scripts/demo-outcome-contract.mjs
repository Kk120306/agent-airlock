export function comparableDemoContract(contract) {
  return {
    requiredPaths: contract?.requiredPaths,
    protectedPaths: contract?.protectedPaths,
    maxChangedFiles: contract?.maxChangedFiles,
    maxAddedBytes: contract?.maxAddedBytes,
    secretPatterns: contract?.secretPatterns,
    validationCommands: contract?.validationCommands,
  };
}

const persistedOutcomeContractKeys = Object.freeze([
  "createdAt",
  "maxAddedBytes",
  "maxChangedFiles",
  "protectedPaths",
  "requiredPaths",
  "schemaVersion",
  "secretPatterns",
  "validationCommands",
  "version",
]);

function exactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function canonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function exactPolicyShape(contract) {
  return (
    Array.isArray(contract.requiredPaths) &&
    contract.requiredPaths.every((value) => typeof value === "string") &&
    Array.isArray(contract.protectedPaths) &&
    contract.protectedPaths.every((value) => typeof value === "string") &&
    Number.isSafeInteger(contract.maxChangedFiles) &&
    Number.isSafeInteger(contract.maxAddedBytes) &&
    Array.isArray(contract.secretPatterns) &&
    contract.secretPatterns.every(
      (rule) =>
        exactKeys(rule, ["name", "pattern"]) &&
        typeof rule.name === "string" &&
        typeof rule.pattern === "string",
    ) &&
    Array.isArray(contract.validationCommands) &&
    contract.validationCommands.every(
      (command) =>
        exactKeys(command, ["command", "name", "required", "timeoutMs"]) &&
        typeof command.name === "string" &&
        typeof command.command === "string" &&
        typeof command.required === "boolean" &&
        Number.isSafeInteger(command.timeoutMs),
    )
  );
}

export function comparableExactDemoContract(contract) {
  if (
    !exactKeys(contract, persistedOutcomeContractKeys) ||
    contract.schemaVersion !== 1 ||
    !Number.isSafeInteger(contract.version) ||
    contract.version < 1 ||
    !canonicalTimestamp(contract.createdAt) ||
    !exactPolicyShape(contract)
  ) {
    return null;
  }
  return comparableDemoContract(contract);
}
