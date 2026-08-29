import { createHash } from "node:crypto";
import { redactSensitiveText } from "@agent-airlock/transactional-resource-sdk";
import { stableJson } from "./candidate-selection.js";
import { HttpError } from "./errors.js";
import {
  createNextOutcomeContract,
  validateOutcomeContractInput,
} from "./outcome-contract.js";
import type {
  AgentRun,
  AssuranceCitation,
  AssuranceOperation,
  AssuranceProposal,
  AssuranceSimulation,
  AssuranceSimulationResult,
  OutcomeContract,
  OutcomeContractInput,
} from "./types.js";

const MAXIMUM_HISTORICAL_RUNS = 200;
const MAXIMUM_OPERATIONS = 10;
const MAXIMUM_CITATIONS = 80;
const MAXIMUM_PROPOSAL_BYTES = 200_000;

export const ASSURANCE_SECRET_CATALOG = {
  catalogId: "agent-airlock-secret-catalog",
  version: 1,
  rules: [
    {
      name: "private-key-block",
      pattern: "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    },
  ],
} as const;

export function outcomeContractHash(contract: OutcomeContract): string {
  return digest(contract);
}

export function assuranceOperationKey(operation: AssuranceOperation): string {
  switch (operation.kind) {
    case "add-required-path":
      return operation.kind + ":" + operation.path;
    case "add-protected-path":
      return operation.kind + ":" + operation.path;
    case "lower-max-changed-files":
    case "lower-max-added-bytes":
      return operation.kind + ":" + operation.maximum;
    case "add-catalog-secret":
      return operation.kind + "|" + operation.catalogId + "|" + operation.name;
    case "make-command-required":
      return operation.kind + ":" + operation.name;
  }
}

export function deriveAssuranceProposal(
  agentId: string,
  baseContract: OutcomeContract,
  allRuns: AgentRun[],
  createdAt = new Date().toISOString(),
): AssuranceProposal | null {
  const runs = allRuns
    .filter(
      (run) =>
        run.agentId === agentId &&
        run.transaction?.assuranceEvidenceVersion === 1 &&
        run.transaction.disposition,
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(-MAXIMUM_HISTORICAL_RUNS);
  const operationCandidates: Array<{
    operation: AssuranceOperation;
    citations: AssuranceCitation[];
  }> = [];

  const deletedPaths = new Map<string, Map<string, AgentRun>>();
  for (const run of runs) {
    const transaction = run.transaction;
    if (!transaction || transaction.disposition !== "quarantined") continue;
    for (const change of transaction.changes?.files ?? []) {
      if (change.kind !== "deleted") continue;
      const byLineage = deletedPaths.get(change.path) ?? new Map<string, AgentRun>();
      const existing = byLineage.get(transaction.lineage.rootRunId);
      if (!existing || run.id.localeCompare(existing.id) < 0) {
        byLineage.set(transaction.lineage.rootRunId, run);
      }
      deletedPaths.set(change.path, byLineage);
    }
  }
  for (const [candidatePath, byLineage] of [...deletedPaths].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      byLineage.size < 3 ||
      Buffer.byteLength(candidatePath, "utf8") > 240 ||
      redactSensitiveText(candidatePath) !== candidatePath ||
      candidatePath.startsWith("/") ||
      candidatePath.includes("\\") ||
      candidatePath.split("/").includes("..")
    ) {
      continue;
    }
    const support = [...byLineage.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 3);
    const pathOperations: AssuranceOperation[] = [];
    if (!baseContract.requiredPaths.includes(candidatePath)) {
      pathOperations.push({ kind: "add-required-path", path: candidatePath });
    }
    if (!baseContract.protectedPaths.includes(candidatePath)) {
      pathOperations.push({ kind: "add-protected-path", path: candidatePath });
    }
    for (const operation of pathOperations) {
      const operationKey = assuranceOperationKey(operation);
      operationCandidates.push({
        operation,
        citations: support.map((run) => ({
          operationKey,
          runId: run.id,
          rootRunId: run.transaction!.lineage.rootRunId,
          evidenceSelector: "transaction.changes.files[path=" + candidatePath + "]",
          evidenceHash: digest(
            run.transaction!.changes!.files.find(
              (change) => change.path === candidatePath && change.kind === "deleted",
            ),
          ),
          derivationRule: "deleted-path-recurrence-v1",
        })),
      });
    }
  }

  const optionalFailures = new Map<string, Map<string, AgentRun>>();
  for (const run of runs) {
    const transaction = run.transaction;
    if (!transaction) continue;
    const requiredFailure = transaction.validations.some(
      (validation) => validation.required && validation.status !== "passed",
    );
    if (requiredFailure) continue;
    for (const validation of transaction.validations) {
      if (
        validation.required ||
        validation.status === "passed" ||
        !validation.name.startsWith("command:")
      ) {
        continue;
      }
      const name = validation.name.slice("command:".length);
      const command = baseContract.validationCommands.find(
        (candidate) => candidate.name === name && !candidate.required,
      );
      const historicalCommand = transaction.outcomeContract.validationCommands.find(
        (candidate) => candidate.name === name && !candidate.required,
      );
      if (
        !command ||
        !historicalCommand ||
        historicalCommand.timeoutMs !== command.timeoutMs ||
        commandHash(historicalCommand.command, historicalCommand.timeoutMs) !==
          commandHash(command.command, command.timeoutMs)
      ) {
        continue;
      }
      const byLineage = optionalFailures.get(name) ?? new Map<string, AgentRun>();
      const existing = byLineage.get(transaction.lineage.rootRunId);
      if (!existing || run.id.localeCompare(existing.id) < 0) {
        byLineage.set(transaction.lineage.rootRunId, run);
      }
      optionalFailures.set(name, byLineage);
    }
  }
  for (const [name, byLineage] of [...optionalFailures].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (byLineage.size < 3) continue;
    const command = baseContract.validationCommands.find(
      (candidate) => candidate.name === name && !candidate.required,
    );
    if (!command) continue;
    const operation: AssuranceOperation = {
      kind: "make-command-required",
      name,
      commandHash: commandHash(command.command, command.timeoutMs),
      timeoutMs: command.timeoutMs,
    };
    const operationKey = assuranceOperationKey(operation);
    operationCandidates.push({
      operation,
      citations: [...byLineage.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, 3)
        .map((run) => {
          const validation = run.transaction!.validations.find(
            (candidate) => candidate.name === "command:" + name,
          )!;
          return {
            operationKey,
            runId: run.id,
            rootRunId: run.transaction!.lineage.rootRunId,
            evidenceSelector: "transaction.validations[name=command:" + name + "]",
            evidenceHash: digest({
              name: validation.name,
              status: validation.status,
              required: validation.required,
              summary: validation.summary,
              commandHash: commandHash(command.command, command.timeoutMs),
              timeoutMs: command.timeoutMs,
            }),
            derivationRule: "optional-command-failure-recurrence-v1",
          };
        }),
    });
  }

  const catalogSecretFailures = new Map<string, Map<string, AgentRun>>();
  for (const run of runs) {
    const transaction = run.transaction;
    if (!transaction) continue;
    for (const validation of transaction.validations) {
      const match = validation.name.match(
        /^assurance-catalog-rule:([a-zA-Z0-9_.-]+):v1$/,
      );
      if (!match || validation.status !== "failed") continue;
      const name = match[1]!;
      const trusted = ASSURANCE_SECRET_CATALOG.rules.find(
        (rule) => rule.name === name,
      );
      if (
        !trusted ||
        baseContract.secretPatterns.some((rule) => rule.name === trusted.name)
      ) {
        continue;
      }
      const byLineage =
        catalogSecretFailures.get(name) ?? new Map<string, AgentRun>();
      const existing = byLineage.get(transaction.lineage.rootRunId);
      if (!existing || run.id.localeCompare(existing.id) < 0) {
        byLineage.set(transaction.lineage.rootRunId, run);
      }
      catalogSecretFailures.set(name, byLineage);
    }
  }
  for (const [name, byLineage] of [...catalogSecretFailures].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (byLineage.size < 2) continue;
    const trusted = ASSURANCE_SECRET_CATALOG.rules.find(
      (rule) => rule.name === name,
    );
    if (!trusted) continue;
    const operation: AssuranceOperation = {
      kind: "add-catalog-secret",
      catalogId: ASSURANCE_SECRET_CATALOG.catalogId,
      catalogVersion: ASSURANCE_SECRET_CATALOG.version,
      name: trusted.name,
      pattern: trusted.pattern,
    };
    const operationKey = assuranceOperationKey(operation);
    operationCandidates.push({
      operation,
      citations: [...byLineage.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, 2)
        .map((run) => {
          const validation = run.transaction!.validations.find(
            (candidate) =>
              candidate.name === "assurance-catalog-rule:" + name + ":v1",
          )!;
          return {
            operationKey,
            runId: run.id,
            rootRunId: run.transaction!.lineage.rootRunId,
            evidenceSelector:
              "transaction.validations[name=assurance-catalog-rule:" +
              name +
              ":v1]",
            evidenceHash: digest({
              name: validation.name,
              status: validation.status,
              required: validation.required,
              summary: validation.summary,
            }),
            derivationRule: "catalog-secret-recurrence-v1",
          };
        }),
    });
  }

  for (const metric of ["changed-files", "added-bytes"] as const) {
    const observedValue = (run: AgentRun): number =>
      metric === "changed-files"
        ? run.transaction!.changes!.totalChangedFiles
        : run.transaction!.changes!.totalAddedBytes;
    const historicalMaximum = (run: AgentRun): number =>
      metric === "changed-files"
        ? run.transaction!.outcomeContract.maxChangedFiles
        : run.transaction!.outcomeContract.maxAddedBytes;
    const failed = runs.filter((run) => {
      const transaction = run.transaction;
      return Boolean(
        transaction?.changes &&
          transaction.validations.some(
            (validation) =>
              validation.name === "change-limits" &&
              validation.status === "failed",
          ) &&
          observedValue(run) > historicalMaximum(run),
      );
    });
    const successful = runs.filter(
      (run) =>
        run.transaction?.disposition === "promoted" &&
        run.transaction.changes &&
        run.transaction.validations.some(
          (validation) =>
            validation.name === "change-limits" &&
            validation.status === "passed",
        ),
    );
    const citedFailed = uniqueRootRuns(failed).slice(0, 2);
    const failedRoots = new Set(
      citedFailed.map((run) => run.transaction!.lineage.rootRunId),
    );
    const citedSuccessful = uniqueRootRuns(successful)
      .filter((run) => !failedRoots.has(run.transaction!.lineage.rootRunId))
      .sort(
        (left, right) =>
          observedValue(right) - observedValue(left) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, 3);
    if (citedFailed.length < 2 || citedSuccessful.length < 3) {
      continue;
    }
    const values = citedSuccessful.map(observedValue);
    const maximum = Math.max(...values, metric === "changed-files" ? 1 : 0);
    const currentMaximum =
      metric === "changed-files"
        ? baseContract.maxChangedFiles
        : baseContract.maxAddedBytes;
    if (maximum >= currentMaximum) continue;
    const operation: AssuranceOperation =
      metric === "changed-files"
        ? { kind: "lower-max-changed-files", maximum }
        : { kind: "lower-max-added-bytes", maximum };
    const operationKey = assuranceOperationKey(operation);
    const supporting = [...citedFailed, ...citedSuccessful];
    operationCandidates.push({
      operation,
      citations: supporting.map((run) => ({
        operationKey,
        runId: run.id,
        rootRunId: run.transaction!.lineage.rootRunId,
        evidenceSelector:
          metric === "changed-files"
            ? "transaction.changes.totalChangedFiles+outcomeContract.maxChangedFiles"
            : "transaction.changes.totalAddedBytes+outcomeContract.maxAddedBytes",
        evidenceHash: digest({
          role: failedRoots.has(run.transaction!.lineage.rootRunId)
            ? "overflow"
            : "promoted-support",
          observed: observedValue(run),
          historicalMaximum: historicalMaximum(run),
          changeLimitsStatus: run.transaction!.validations.find(
            (validation) => validation.name === "change-limits",
          )!.status,
          disposition: run.transaction!.disposition,
        }),
        derivationRule:
          metric === "changed-files"
            ? "changed-file-limit-recurrence-v1"
            : "added-byte-limit-recurrence-v1",
      })),
    });
  }

  const selected = operationCandidates
    .sort((left, right) =>
      assuranceOperationKey(left.operation).localeCompare(
        assuranceOperationKey(right.operation),
      ),
    )
    .slice(0, MAXIMUM_OPERATIONS);
  if (selected.length === 0) return null;
  const operations = selected.map((candidate) => candidate.operation);
  const citations = selected
    .flatMap((candidate) => candidate.citations)
    .sort(compareCitations)
    .slice(0, MAXIMUM_CITATIONS);
  const simulation = simulateAssuranceProposal(operations, runs);
  const proposalDigest = digest({
    schemaVersion: 1,
    agentId,
    baseContractVersion: baseContract.version,
    baseContractHash: outcomeContractHash(baseContract),
    generatorId: "agent-airlock-deterministic-detector",
    generatorVersion: 1,
    operations,
    citations,
    simulationDigest: simulation.digest,
  });
  const proposal: AssuranceProposal = {
    schemaVersion: 1,
    id: proposalDigest.slice("sha256:".length),
    agentId,
    state: "ready",
    baseContractVersion: baseContract.version,
    baseContractHash: outcomeContractHash(baseContract),
    generatorId: "agent-airlock-deterministic-detector",
    generatorVersion: 1,
    operations,
    citations,
    simulation,
    proposalDigest,
    decision: null,
    createdAt,
    updatedAt: createdAt,
  };
  verifyAssuranceProposalIntegrity(proposal);
  return proposal;
}

export function simulateAssuranceProposal(
  operations: AssuranceOperation[],
  runs: AgentRun[],
): AssuranceSimulation {
  const results = operations
    .flatMap((operation) =>
      runs.map((run) => simulateOperation(operation, run)),
    )
    .sort((left, right) =>
      left.operationKey.localeCompare(right.operationKey) ||
      left.runId.localeCompare(right.runId),
    );
  return {
    engineId: "agent-airlock-historical-simulator",
    engineVersion: 1,
    results,
    digest: simulationDigest(results),
  };
}

export function verifyAssuranceProposalIntegrity(
  proposal: AssuranceProposal,
): void {
  if (Buffer.byteLength(stableJson(proposal), "utf8") > MAXIMUM_PROPOSAL_BYTES) {
    throw new HttpError(409, "Assurance Proposal exceeds its persisted evidence bound");
  }
  const operationKeys = proposal.operations.map(assuranceOperationKey);
  if (
    proposal.operations.length < 1 ||
    proposal.operations.length > MAXIMUM_OPERATIONS ||
    proposal.citations.length > MAXIMUM_CITATIONS ||
    operationKeys.some((key, index) => index > 0 && key <= operationKeys[index - 1]!)
  ) {
    throw new HttpError(409, "Assurance Proposal operation order is invalid");
  }
  for (const citation of proposal.citations) {
    if (!operationKeys.includes(citation.operationKey)) {
      throw new HttpError(409, "Assurance Proposal citation has no operation");
    }
  }
  if (
    proposal.citations.some(
      (citation, index) =>
        index > 0 && compareCitations(proposal.citations[index - 1]!, citation) >= 0,
    )
  ) {
    throw new HttpError(409, "Assurance Proposal citation order is invalid");
  }
  for (const result of proposal.simulation.results) {
    const { resultHash: persistedResultHash, ...unsigned } = result;
    if (persistedResultHash !== digest(unsigned)) {
      throw new HttpError(409, "Assurance simulation result was modified");
    }
  }
  if (proposal.simulation.digest !== simulationDigest(proposal.simulation.results)) {
    throw new HttpError(409, "Assurance simulation digest was modified");
  }
  const expectedDigest = digest({
    schemaVersion: proposal.schemaVersion,
    agentId: proposal.agentId,
    baseContractVersion: proposal.baseContractVersion,
    baseContractHash: proposal.baseContractHash,
    generatorId: proposal.generatorId,
    generatorVersion: proposal.generatorVersion,
    operations: proposal.operations,
    citations: proposal.citations,
    simulationDigest: proposal.simulation.digest,
  });
  if (
    proposal.proposalDigest !== expectedDigest ||
    proposal.id !== expectedDigest.slice("sha256:".length)
  ) {
    throw new HttpError(409, "Assurance Proposal digest was modified");
  }
}

export function applyAssuranceOperations(
  base: OutcomeContract,
  operations: AssuranceOperation[],
): OutcomeContract {
  const input: OutcomeContractInput = {
    requiredPaths: [...base.requiredPaths],
    protectedPaths: [...base.protectedPaths],
    maxChangedFiles: base.maxChangedFiles,
    maxAddedBytes: base.maxAddedBytes,
    secretPatterns: structuredClone(base.secretPatterns),
    validationCommands: structuredClone(base.validationCommands),
  };
  for (const operation of operations) {
    switch (operation.kind) {
      case "add-required-path":
        if (!input.requiredPaths.includes(operation.path)) {
          input.requiredPaths.push(operation.path);
        }
        break;
      case "add-protected-path":
        if (!input.protectedPaths.includes(operation.path)) {
          input.protectedPaths.push(operation.path);
        }
        break;
      case "lower-max-changed-files":
        input.maxChangedFiles = Math.min(input.maxChangedFiles, operation.maximum);
        break;
      case "lower-max-added-bytes":
        input.maxAddedBytes = Math.min(input.maxAddedBytes, operation.maximum);
        break;
      case "add-catalog-secret": {
        const trusted = ASSURANCE_SECRET_CATALOG.rules.find(
          (rule) => rule.name === operation.name,
        );
        if (
          operation.catalogId !== ASSURANCE_SECRET_CATALOG.catalogId ||
          operation.catalogVersion !== ASSURANCE_SECRET_CATALOG.version ||
          !trusted ||
          trusted.pattern !== operation.pattern
        ) {
          throw new HttpError(409, "Assurance Proposal secret catalog reference is invalid");
        }
        if (!input.secretPatterns.some((rule) => rule.name === trusted.name)) {
          input.secretPatterns.push({ ...trusted });
        }
        break;
      }
      case "make-command-required": {
        const command = input.validationCommands.find(
          (candidate) => candidate.name === operation.name,
        );
        if (
          !command ||
          command.timeoutMs !== operation.timeoutMs ||
          commandHash(command.command, command.timeoutMs) !== operation.commandHash
        ) {
          throw new HttpError(409, "Assurance Proposal command identity is invalid");
        }
        command.required = true;
        break;
      }
    }
  }
  input.requiredPaths.sort();
  input.protectedPaths.sort();
  input.secretPatterns.sort((left, right) => left.name.localeCompare(right.name));
  input.validationCommands.sort((left, right) => left.name.localeCompare(right.name));
  validateOutcomeContractInput(input);
  const next = createNextOutcomeContract(base, input);
  assertMonotonicStrengthening(base, next);
  return next;
}

export function assertMonotonicStrengthening(
  base: OutcomeContract,
  proposed: OutcomeContract,
): void {
  let strictlyStronger = false;
  for (const requiredPath of base.requiredPaths) {
    if (!proposed.requiredPaths.includes(requiredPath)) {
      throw new HttpError(409, "Assurance Proposal removes a required path");
    }
  }
  for (const protectedPath of base.protectedPaths) {
    if (!proposed.protectedPaths.includes(protectedPath)) {
      throw new HttpError(409, "Assurance Proposal removes a protected path");
    }
  }
  if (
    proposed.maxChangedFiles > base.maxChangedFiles ||
    proposed.maxAddedBytes > base.maxAddedBytes
  ) {
    throw new HttpError(409, "Assurance Proposal raises an Outcome Contract limit");
  }
  strictlyStronger ||= proposed.maxChangedFiles < base.maxChangedFiles;
  strictlyStronger ||= proposed.maxAddedBytes < base.maxAddedBytes;
  strictlyStronger ||= proposed.requiredPaths.length > base.requiredPaths.length;
  strictlyStronger ||= proposed.protectedPaths.length > base.protectedPaths.length;
  for (const rule of base.secretPatterns) {
    if (
      !proposed.secretPatterns.some(
        (candidate) => candidate.name === rule.name && candidate.pattern === rule.pattern,
      )
    ) {
      throw new HttpError(409, "Assurance Proposal changes an existing secret rule");
    }
  }
  strictlyStronger ||= proposed.secretPatterns.length > base.secretPatterns.length;
  for (const command of base.validationCommands) {
    const next = proposed.validationCommands.find(
      (candidate) => candidate.name === command.name,
    );
    if (
      !next ||
      next.command !== command.command ||
      next.timeoutMs !== command.timeoutMs ||
      (command.required && !next.required)
    ) {
      throw new HttpError(409, "Assurance Proposal changes an existing Validation command");
    }
    strictlyStronger ||= !command.required && next.required;
  }
  strictlyStronger ||=
    proposed.validationCommands.length > base.validationCommands.length;
  if (!strictlyStronger) {
    throw new HttpError(409, "Assurance Proposal is not strictly stronger");
  }
}

function simulateOperation(
  operation: AssuranceOperation,
  run: AgentRun,
): AssuranceSimulationResult {
  const transaction = run.transaction;
  const operationKey = assuranceOperationKey(operation);
  const priorDisposition = transaction?.disposition ?? null;
  let classification: AssuranceSimulationResult["classification"] = "unknown";
  let counterfactualDisposition: AssuranceSimulationResult["counterfactualDisposition"] =
    null;
  let missingInputs: string[] = [];
  if (!transaction) {
    missingInputs = ["transaction"];
  } else if (
    operation.kind === "add-protected-path" ||
    operation.kind === "add-required-path"
  ) {
    const changes = transaction.changes;
    if (!changes) {
      missingInputs = ["transaction.changes"];
    } else {
      const change = changes.files.find(
        (candidate) =>
          candidate.path === operation.path &&
          (operation.kind === "add-protected-path" || candidate.kind === "deleted"),
      );
      if (change) {
        classification = "exact";
        counterfactualDisposition = "quarantined";
      } else if (changes.truncated) {
        missingInputs = ["complete transaction.changes.files"];
      } else if (operation.kind === "add-protected-path") {
        classification = "exact";
        counterfactualDisposition = priorDisposition;
      } else {
        missingInputs = ["historical required-path evaluator result"];
      }
    }
  } else if (
    operation.kind === "lower-max-changed-files" ||
    operation.kind === "lower-max-added-bytes"
  ) {
    if (!transaction.changes) {
      missingInputs = ["transaction.changes"];
    } else {
      classification = "exact";
      const observed =
        operation.kind === "lower-max-changed-files"
          ? transaction.changes.totalChangedFiles
          : transaction.changes.totalAddedBytes;
      counterfactualDisposition =
        observed > operation.maximum ? "quarantined" : priorDisposition;
    }
  } else if (operation.kind === "make-command-required") {
    const historicalCommand = transaction.outcomeContract.validationCommands.find(
      (candidate) => candidate.name === operation.name,
    );
    const validation = transaction.validations.find(
      (candidate) => candidate.name === "command:" + operation.name,
    );
    if (
      !historicalCommand ||
      historicalCommand.timeoutMs !== operation.timeoutMs ||
      commandHash(historicalCommand.command, historicalCommand.timeoutMs) !==
        operation.commandHash
    ) {
      missingInputs = ["matching Outcome Contract command identity"];
    } else if (!validation) {
      missingInputs = ["matching Validation command result"];
    } else {
      classification = "exact";
      counterfactualDisposition =
        validation.status === "passed" ? priorDisposition : "quarantined";
    }
  } else if (operation.kind === "add-catalog-secret") {
    const validation = transaction.validations.find(
      (candidate) =>
        candidate.name ===
        "assurance-catalog-rule:" + operation.name + ":v1",
    );
    if (!validation) {
      missingInputs = ["matching trusted catalog secret evaluator result"];
    } else if (validation.status === "passed") {
      classification = "exact";
      counterfactualDisposition = priorDisposition;
    } else if (validation.status === "failed") {
      classification = "exact";
      counterfactualDisposition = "quarantined";
    } else {
      missingInputs = ["complete trusted catalog secret evaluator result"];
    }
  }
  if (
    classification === "unknown" &&
    transaction?.disposition === "quarantined"
  ) {
    classification = "conservative";
  }
  const unsigned = {
    operationKey,
    runId: run.id,
    classification,
    priorDisposition,
    counterfactualDisposition,
    missingInputs,
  };
  return { ...unsigned, resultHash: digest(unsigned) };
}

function simulationDigest(results: AssuranceSimulationResult[]): string {
  return digest({
    engineId: "agent-airlock-historical-simulator",
    engineVersion: 1,
    results,
  });
}

function compareCitations(
  left: AssuranceCitation,
  right: AssuranceCitation,
): number {
  return (
    left.operationKey.localeCompare(right.operationKey) ||
    left.runId.localeCompare(right.runId) ||
    left.evidenceSelector.localeCompare(right.evidenceSelector)
  );
}

function uniqueRootRuns(runs: AgentRun[]): AgentRun[] {
  const byRoot = new Map<string, AgentRun>();
  for (const run of [...runs].sort((left, right) => left.id.localeCompare(right.id))) {
    const rootRunId = run.transaction?.lineage.rootRunId;
    if (rootRunId && !byRoot.has(rootRunId)) byRoot.set(rootRunId, run);
  }
  return [...byRoot.values()];
}

function commandHash(command: string, timeoutMs: number): string {
  return digest({ command, timeoutMs });
}

function digest(value: unknown): string {
  return "sha256:" + createHash("sha256").update(stableJson(value)).digest("hex");
}
