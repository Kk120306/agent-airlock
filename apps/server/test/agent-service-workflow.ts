import { expect } from "vitest";
import type { AgentService } from "../src/agent-service.js";
import type {
  CandidateSetPhase,
  RunStatus,
  RunTransactionStatus,
} from "../src/types.js";

// The server test command reserves 150 seconds for four sequential terminal
// workflows, each with one semantic poll and one execution-quiescence poll,
// plus setup, assertions, and teardown headroom.
export const agentWorkflowTimeoutMs = 15_000;

type TerminalRunStatus = Extract<
  RunStatus,
  "completed" | "failed" | "cancelled"
>;

type TerminalRunTransactionStatus = Extract<
  RunTransactionStatus,
  "promoted" | "quarantined" | "discarded" | "recovery-error" | "cancelled"
>;

const terminalCandidateSetPhases = new Set<CandidateSetPhase>([
  "completed",
  "stale",
  "recovery-error",
]);

type TerminalCandidateSetPhase = Extract<
  CandidateSetPhase,
  "completed" | "stale" | "recovery-error"
>;

type AgentServiceExecutionState = {
  activeExecutions: Map<string, Promise<void>>;
};

function hasActiveExecution(service: AgentService, agentId: string): boolean {
  return (service as unknown as AgentServiceExecutionState).activeExecutions.has(
    agentId,
  );
}

export async function waitForAgentExecutionToStop(
  service: AgentService,
  agentId: string,
): Promise<void> {
  await expect
    .poll(() => !hasActiveExecution(service, agentId), {
      timeout: agentWorkflowTimeoutMs,
    })
    .toBe(true);
}

export async function waitForRunStatus(
  service: AgentService,
  runId: string,
  expectedStatus: TerminalRunStatus,
): Promise<void> {
  await expect
    .poll(() => service.getRun(runId).status, {
      timeout: agentWorkflowTimeoutMs,
    })
    .toBe(expectedStatus);
  await waitForAgentExecutionToStop(service, service.getRun(runId).agentId);
}

export async function waitForRunToFinish(
  service: AgentService,
  runId: string,
) {
  await expect
    .poll(() => service.getRun(runId).status, {
      timeout: agentWorkflowTimeoutMs,
    })
    .toMatch(/^(completed|failed|cancelled)$/);
  await waitForAgentExecutionToStop(service, service.getRun(runId).agentId);
  return service.getRun(runId);
}

export async function waitForRunTransactionStatus(
  service: AgentService,
  runId: string,
  expectedStatus: TerminalRunTransactionStatus,
  expectedAgentId?: string,
): Promise<void> {
  await expect
    .poll(() => service.getRun(runId).transaction?.status, {
      timeout: agentWorkflowTimeoutMs,
    })
    .toBe(expectedStatus);
  const agentId = service.getRun(runId).agentId;
  if (expectedAgentId) expect(agentId).toBe(expectedAgentId);
  await waitForAgentExecutionToStop(service, agentId);
}

export async function waitForCandidateSetPhase(
  service: AgentService,
  candidateSetId: string,
  expectedPhase: CandidateSetPhase,
  expectedAgentId?: string,
): Promise<void> {
  await expect
    .poll(() => service.getCandidateSet(candidateSetId).phase, {
      timeout: agentWorkflowTimeoutMs,
    })
    .toBe(expectedPhase);
  if (terminalCandidateSetPhases.has(expectedPhase)) {
    const agentId = service.getCandidateSet(candidateSetId).agentId;
    if (expectedAgentId) expect(agentId).toBe(expectedAgentId);
    await waitForAgentExecutionToStop(service, agentId);
  }
}

export async function waitForCandidateSetCompletion(
  service: AgentService,
  candidateSetId: string,
  expectedAgentId?: string,
): Promise<void> {
  await waitForCandidateSetPhase(
    service,
    candidateSetId,
    "completed",
    expectedAgentId,
  );
}

export async function waitForCandidateSetTerminalPhase(
  service: AgentService,
  candidateSetId: string,
  expectedPhase: TerminalCandidateSetPhase,
  expectedAgentId?: string,
): Promise<void> {
  await waitForCandidateSetPhase(
    service,
    candidateSetId,
    expectedPhase,
    expectedAgentId,
  );
}

export async function waitForCandidateSetRecoveryError(
  service: AgentService,
  candidateSetId: string,
  expectedAgentId?: string,
): Promise<void> {
  await expect
    .poll(() => service.getCandidateSet(candidateSetId).recoveryError, {
      timeout: agentWorkflowTimeoutMs,
    })
    .not.toBeNull();
  const agentId = service.getCandidateSet(candidateSetId).agentId;
  if (expectedAgentId) expect(agentId).toBe(expectedAgentId);
  await waitForAgentExecutionToStop(service, agentId);
}
