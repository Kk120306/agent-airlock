import {
  assessRequiredResourceEligibility,
  parseResourceVersionReference,
  validateTransactionalResourceProvider,
  type ResourceProviderManifest,
  type RuntimeAccess,
  type ResourceVersionReference,
  type TransactionalResourceProvider,
} from "@agent-airlock/transactional-resource-sdk";

export interface RegisteredResourceProvider {
  provider: TransactionalResourceProvider;
  manifest: ResourceProviderManifest;
  initialVersion: ResourceVersionReference;
  required: boolean;
}

export interface ResourceRegistration {
  provider: TransactionalResourceProvider;
  initialVersion: ResourceVersionReference;
  required?: boolean;
}

export interface ResourceRegistryOptions {
  supportedRuntimeAccess?: readonly RuntimeAccess[];
}

export class ResourceRegistry {
  private readonly entries: RegisteredResourceProvider[];
  private readonly byProviderId = new Map<string, RegisteredResourceProvider>();
  private readonly byResourceKind = new Map<string, RegisteredResourceProvider>();
  private readonly byEnvironmentName = new Map<string, RegisteredResourceProvider>();

  constructor(
    registrations: readonly ResourceRegistration[] = [],
    options: ResourceRegistryOptions = {},
  ) {
    const supportedRuntimeAccess = new Set(
      options.supportedRuntimeAccess ?? ["none", "read-only", "read-write"],
    );
    const entries = registrations.map((registration) => {
      const manifest = validateTransactionalResourceProvider(registration.provider);
      const initialVersion = parseResourceVersionReference(
        registration.initialVersion,
        manifest,
      );
      const required = registration.required ?? true;
      if (!supportedRuntimeAccess.has(manifest.capabilities.runtimeAccess)) {
        throw new Error(
          "Resource Provider " +
            manifest.providerId +
            " requires unsupported Runtime access " +
            manifest.capabilities.runtimeAccess,
        );
      }
      if (!required) {
        throw new Error(
          "Optional Resource Providers are not supported by the all-or-nothing Run transaction",
        );
      }
      const eligibility = assessRequiredResourceEligibility(manifest.capabilities);
      if (!eligibility.eligible) {
        throw new Error(
          "Required Resource Provider " +
            manifest.providerId +
            " has incompatible Capability Claims: " +
            eligibility.reasons.join("; "),
        );
      }
      return {
        provider: registration.provider,
        manifest,
        initialVersion,
        required,
      };
    });
    entries.sort((left, right) =>
      resourceOrderKey(left.manifest).localeCompare(resourceOrderKey(right.manifest)),
    );
    for (const entry of entries) {
      const providerId = entry.manifest.providerId;
      const resourceKind = entry.manifest.resourceKind;
      const environmentName = resourceEnvironmentName(providerId);
      if (this.byProviderId.has(providerId)) {
        throw new Error("Duplicate Resource Provider identifier " + providerId);
      }
      if (this.byResourceKind.has(resourceKind)) {
        throw new Error("Duplicate Resource Provider kind " + resourceKind);
      }
      if (this.byEnvironmentName.has(environmentName)) {
        throw new Error(
          "Resource Provider identifiers collide at Runtime environment name " +
            environmentName,
        );
      }
      this.byProviderId.set(providerId, entry);
      this.byResourceKind.set(resourceKind, entry);
      this.byEnvironmentName.set(environmentName, entry);
    }
    this.entries = entries;
  }

  list(): readonly RegisteredResourceProvider[] {
    return this.entries;
  }

  get(providerId: string): RegisteredResourceProvider {
    const entry = this.byProviderId.get(providerId);
    if (!entry) throw new Error("Unknown Resource Provider " + providerId);
    return entry;
  }

  manifests(): ResourceProviderManifest[] {
    return this.entries.map((entry) => structuredClone(entry.manifest));
  }

  initialVersions(): ResourceVersionReference[] {
    return this.entries.map((entry) => structuredClone(entry.initialVersion));
  }
}

function resourceOrderKey(manifest: ResourceProviderManifest): string {
  return manifest.resourceKind + "\u0000" + manifest.providerId;
}

export function resourceEnvironmentName(providerId: string): string {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(providerId)) {
    throw new Error("Resource Provider identifier is unsafe for Runtime environment");
  }
  return (
    "AIRLOCK_RESOURCE_" +
    providerId.replaceAll(".", "_").replaceAll("-", "_").toUpperCase() +
    "_PATH"
  );
}
