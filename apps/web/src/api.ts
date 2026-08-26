import type {
  Agent,
  AgentRun,
  CandidateSet,
  Message,
  OutcomeContract,
  SystemInfo,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  updateOutcomeContract: (
    id: string,
    body: Omit<OutcomeContract, "schemaVersion" | "version" | "createdAt">,
  ) =>
    request<{ outcomeContract: OutcomeContract }>(
      "/api/agents/" + id + "/outcome-contract",
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    ),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  candidateSets: (id: string) =>
    request<{ candidateSets: CandidateSet[] }>(
      "/api/agents/" + id + "/candidate-sets",
    ),
  createCandidateSet: (
    id: string,
    body: {
      objective: string;
      competitors: Array<{
        id: string;
        executorProfileId: "standard-v1";
        strategyInstruction: string;
      }>;
      maxConcurrency: number;
      loserPolicy: "retain" | "discard";
    },
  ) =>
    request<{ candidateSet: CandidateSet; runs: AgentRun[] }>(
      "/api/agents/" + id + "/candidate-sets",
      { method: "POST", body: JSON.stringify(body) },
    ),
  candidateSet: (id: string) =>
    request<{ candidateSet: CandidateSet }>("/api/candidate-sets/" + id),
  cancelCandidateSet: (id: string) =>
    request<{ candidateSet: CandidateSet }>(
      "/api/candidate-sets/" + id + "/cancel",
      { method: "POST" },
    ),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  repairRun: (id: string, objective?: string) =>
    request<{ run: AgentRun; message: Message }>("/api/runs/" + id + "/repair", {
      method: "POST",
      body: JSON.stringify(objective ? { objective } : {}),
    }),
  discardRun: (id: string) =>
    request<{ run: AgentRun }>("/api/runs/" + id + "/discard", {
      method: "POST",
    }),
};
