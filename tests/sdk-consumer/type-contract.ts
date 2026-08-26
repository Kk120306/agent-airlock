import type {
  ResourceCapabilityClaim,
  TransactionalResourceProvider,
} from "@agent-airlock/transactional-resource-sdk";

const invalidCapability: ResourceCapabilityClaim = {
  schemaVersion: 1,
  isolation: "candidate-copy",
  // @ts-expect-error Distributed atomicity is deliberately not a supported claim.
  promotionVisibility: "distributed-atomic",
  promotionIdempotency: "run-keyed",
  reconciliation: "forward",
  quarantine: "retained",
  discard: "idempotent",
  repair: "fork",
  runtimeAccess: "none",
};

// @ts-expect-error Every lifecycle hook is mandatory.
const incompleteProvider: TransactionalResourceProvider = {
  manifest: {} as TransactionalResourceProvider["manifest"],
};

void invalidCapability;
void incompleteProvider;
