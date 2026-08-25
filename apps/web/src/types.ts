export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type RunTransactionStatus =
  | "preparing"
  | "executing"
  | "validating"
  | "promoting"
  | "promoted"
  | "quarantined"
  | "cancelled";

export interface OutcomeContract {
  schemaVersion: 1;
  version: number;
  requiredPaths: string[];
  protectedPaths: string[];
  maxChangedFiles: number;
  maxAddedBytes: number;
  secretPatterns: Array<{ name: string; pattern: string }>;
  validationCommands: Array<{
    name: string;
    command: string;
    required: boolean;
    timeoutMs: number;
  }>;
  createdAt: string;
}

export interface RunTransaction {
  id: string;
  status: RunTransactionStatus;
  disposition: "promoted" | "quarantined" | "cancelled" | null;
  candidateStateId: string | null;
  canonicalStateIdBefore: string;
  canonicalStateIdAfter: string | null;
  canonicalContentHashBefore: string;
  canonicalContentHashAfter: string | null;
  outcomeContractVersion: number;
  outcomeContract: OutcomeContract;
  changes: {
    files: Array<{
      path: string;
      kind: "added" | "modified" | "deleted";
      addedBytes: number;
    }>;
    totalChangedFiles: number;
    totalAddedBytes: number;
    truncated: boolean;
  } | null;
  validations: Array<{
    name: string;
    status: "passed" | "failed" | "error";
    required: boolean;
    summary: string;
    durationMs: number;
    output: string | null;
  }>;
  events: Array<{
    status: RunTransactionStatus;
    at: string;
    summary: string;
  }>;
  quarantinePath: string | null;
  promotionReceipt: {
    runTransactionId: string;
    disposition: "promoted" | "quarantined" | "cancelled";
    outcomeContractVersion: number;
    canonicalStateIdBefore: string;
    canonicalStateIdAfter: string;
    canonicalContentHashBefore: string;
    canonicalContentHashAfter: string;
    validationEvidenceHash: string;
    createdAt: string;
  } | null;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  canonicalStateId: string;
  outcomeContract: OutcomeContract;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  transaction: RunTransaction | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
