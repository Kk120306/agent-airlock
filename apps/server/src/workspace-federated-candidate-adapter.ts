import type {
  FederatedCandidateAdapter,
  FederatedCandidatePreparationProvenance,
} from "./federated-admission-journal.js";
import {
  WorkspaceManager,
  type FederatedCandidateProvenance,
} from "./workspace.js";

export class WorkspaceFederatedCandidateAdapter
  implements FederatedCandidateAdapter
{
  constructor(private readonly workspaces: WorkspaceManager) {}

  async prepare(input: Parameters<FederatedCandidateAdapter["prepare"]>[0]) {
    const candidate = await this.workspaces.prepareFederatedCandidate(
      input.agentId,
      input.runId,
      input.bundle,
      toWorkspaceProvenance(input.provenance),
    );
    return { candidateStateId: candidate.candidateStateId };
  }

  async inspect(input: Parameters<FederatedCandidateAdapter["inspect"]>[0]) {
    return this.workspaces.inspectFederatedCandidate(
      input.agentId,
      input.runId,
      toWorkspaceProvenance(input.provenance),
    );
  }
}

function toWorkspaceProvenance(
  provenance: FederatedCandidatePreparationProvenance,
): FederatedCandidateProvenance {
  return structuredClone(provenance);
}
