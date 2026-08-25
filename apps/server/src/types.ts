export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type RunTransactionStatus =
  | "preparing"
  | "executing"
  | "validating"
  | "promoting"
  | "promoted"
  | "quarantined"
  | "cancelled";
export type RunTransactionDisposition = "promoted" | "quarantined" | "cancelled";
export type ValidationStatus = "passed" | "failed" | "error";

export interface CanonicalStateReference {
  stateId: string;
  workspacePath: string;
  contentHash: string;
}

export interface RunTransactionEvent {
  status: RunTransactionStatus;
  at: string;
  summary: string;
}

export interface ValidationEvidence {
  name: string;
  status: ValidationStatus;
  summary: string;
  durationMs: number;
  output: string | null;
}

export interface WorkspaceChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  addedBytes: number;
}

export interface WorkspaceChangeSummary {
  files: WorkspaceChange[];
  totalChangedFiles: number;
  totalAddedBytes: number;
  truncated: boolean;
}

export interface RunTransaction {
  id: string;
  status: RunTransactionStatus;
  disposition: RunTransactionDisposition | null;
  candidateStateId: string | null;
  canonicalStateIdBefore: string;
  canonicalStateIdAfter: string | null;
  canonicalContentHashBefore: string;
  canonicalContentHashAfter: string | null;
  outcomeContractVersion: number;
  changes: WorkspaceChangeSummary | null;
  validations: ValidationEvidence[];
  events: RunTransactionEvent[];
  quarantinePath: string | null;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  canonicalStateId: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  transaction: RunTransaction | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
