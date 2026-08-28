import type {
  Agent,
  AgentRun,
  AssuranceProposal,
  CandidateSet,
  FederatedAdmissionPolicySummary,
  FederatedImportResult,
  Message,
  OutcomeContract,
  OutcomeContractVersionRecord,
  PortableReceiptExport,
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
  activeFederatedAdmissionPolicy: () =>
    request<FederatedAdmissionPolicySummary>("/api/federation/policies/active"),
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
  outcomeContractVersions: (id: string) =>
    request<{ versions: OutcomeContractVersionRecord[] }>(
      "/api/agents/" + id + "/outcome-contract/versions",
    ),
  rollbackOutcomeContract: (
    id: string,
    targetVersion: number,
    expectedCurrentVersion: number,
  ) =>
    request<{ outcomeContract: OutcomeContract }>(
      "/api/agents/" + id + "/outcome-contract/rollback",
      {
        method: "POST",
        body: JSON.stringify({ targetVersion, expectedCurrentVersion }),
      },
    ),
  assuranceProposals: (id: string) =>
    request<{ proposals: AssuranceProposal[] }>(
      "/api/agents/" + id + "/assurance-proposals",
    ),
  deriveAssuranceProposal: (id: string) =>
    request<{ proposal: AssuranceProposal | null }>(
      "/api/agents/" + id + "/assurance-proposals/derive",
      { method: "POST" },
    ),
  acceptAssuranceProposal: (id: string, reason: string) =>
    request<{ proposal: AssuranceProposal; outcomeContract: OutcomeContract }>(
      "/api/assurance-proposals/" + id + "/accept",
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
  rejectAssuranceProposal: (id: string, reason: string) =>
    request<{ proposal: AssuranceProposal }>(
      "/api/assurance-proposals/" + id + "/reject",
      { method: "POST", body: JSON.stringify({ reason }) },
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
  importFederatedWork: (
    id: string,
    body: {
      transferId: string;
      producerId: string;
      bundle: unknown;
      trustPolicy: unknown;
    },
  ) =>
    request<FederatedImportResult>("/api/agents/" + id + "/federated-imports", {
      method: "POST",
      body: JSON.stringify(body),
    }),
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
  exportPortableReceipt: (
    id: string,
    body: {
      disclosureIdentities: string[];
      includeAncestry: boolean;
      localAnchor: boolean;
      evmPayload: boolean;
    },
  ) =>
    request<PortableReceiptExport>("/api/runs/" + id + "/portable-receipt", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  exportFederatedWorkBundle: (id: string) =>
    request<{
      bundle: unknown;
      verification: { valid: boolean; receiptDigest: string | null; artifactDigest: string | null };
    }>("/api/runs/" + id + "/federated-work-bundle", { method: "POST" }),
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
