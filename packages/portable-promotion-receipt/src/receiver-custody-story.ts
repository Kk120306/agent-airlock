import type { FederatedWorkBundle } from "./federated-work-bundle.js";
import type {
  ReceiverCustodyBindings,
  ReceiverCustodyRecordRole,
  ReceiverCustodyVerifiedStory,
} from "./receiver-custody.js";
import type { PortablePromotionEnvelope } from "./types.js";

export function buildReceiverCustodyVerifiedStory(
  bindings: ReceiverCustodyBindings,
  records: Map<ReceiverCustodyRecordRole, unknown>,
): ReceiverCustodyVerifiedStory {
  const bundle = records.get("producer-work-bundle") as FederatedWorkBundle;
  const receiverEnvelope = records.get(
    "receiver-promotion-envelope",
  ) as PortablePromotionEnvelope;
  const before = receiverEnvelope.receipt.state.before;
  const after = receiverEnvelope.receipt.state.after;
  return {
    disposition: bindings.disposition,
    approval: bindings.approvalDecisionDigest === null
      ? "automatic"
      : "operator-approved",
    producer: {
      producerId: bindings.producerId,
      keyId: bundle.receipt.keyId,
      receiptDigest: bindings.producerReceiptDigest,
      artifactDigest: bindings.artifactDigest,
    },
    receiver: {
      agentId: bindings.receiverAgentId,
      runId: bindings.receiverRunId,
      keyId: receiverEnvelope.keyId,
      receiptDigest: bindings.receiverReceiptDigest,
    },
    authority: {
      admissionId: bindings.admissionId,
      admissionRecordDigest: bindings.admissionRecordDigest,
      approvalDecisionDigest: bindings.approvalDecisionDigest,
      decisionContextDigest: bindings.decisionContextDigest,
      terminalAuthorityDigest: bindings.terminalAuthorityDigest,
      outcomeContractDigest: bindings.outcomeContractDigest,
      validationEvidenceRoot: bindings.validationEvidenceRoot,
    },
    state: {
      canonicalAdvanced: bindings.disposition === "promoted",
      beforeStateId: before.stateId,
      afterStateId: after.stateId,
      beforeCompositeHash: before.compositeHash,
      afterCompositeHash: after.compositeHash,
    },
  };
}
