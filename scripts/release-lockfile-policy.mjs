import { createHash } from "node:crypto";

export const releaseDependencySections = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

export const reviewedReleaseLockfileDigest =
  "sha256:e47b2bc0cd9376cba8b36b0751d32c559eb370bd0d499dfe65e468afae6912de";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function lockPackagePath(manifestPath) {
  if (manifestPath === "package.json") return "";
  if (
    typeof manifestPath !== "string" ||
    !manifestPath.endsWith("/package.json") ||
    manifestPath.includes("\\") ||
    manifestPath.includes("\0") ||
    manifestPath.startsWith("/") ||
    manifestPath.split("/").some((component) =>
      component === "" || component === "." || component === ".."
    )
  ) {
    return null;
  }
  return manifestPath.slice(0, -"/package.json".length);
}

function dependencySpecs(value, location, findings) {
  if (value === undefined) return new Map();
  if (!isRecord(value)) {
    findings.push(`${location} must be an object`);
    return null;
  }

  const specs = new Map();
  for (const dependencyName of Object.keys(value).sort()) {
    const spec = value[dependencyName];
    if (typeof spec !== "string" || spec.length === 0) {
      findings.push(`${location}.${dependencyName} must be a non-empty string`);
      continue;
    }
    specs.set(dependencyName, spec);
  }
  return specs;
}

export function releaseLockfileDependencyFindings(
  packageLock,
  manifestsByPath,
) {
  const findings = [];
  if (!isRecord(packageLock)) {
    return ["package-lock.json must contain an object"];
  }
  if (sha256(JSON.stringify(packageLock)) !== reviewedReleaseLockfileDigest) {
    findings.push(
      "package-lock.json complete resolved graph differs from the reviewed digest",
    );
  }
  if (!Number.isInteger(packageLock.lockfileVersion) || packageLock.lockfileVersion < 2) {
    findings.push("package-lock.json must use a packages-aware lockfile version");
  }
  if (!isRecord(packageLock.packages)) {
    findings.push("package-lock.json packages must contain an object");
    return findings;
  }
  if (!isRecord(manifestsByPath)) {
    findings.push("release manifests must contain an object keyed by path");
    return findings;
  }

  const manifestEntries = Object.entries(manifestsByPath).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  if (manifestEntries.length === 0) {
    findings.push("release manifests must include package.json");
    return findings;
  }

  for (const [manifestPath, manifest] of manifestEntries) {
    const packagePath = lockPackagePath(manifestPath);
    if (packagePath === null) {
      findings.push(`${manifestPath} is not a canonical package manifest path`);
      continue;
    }
    if (!isRecord(manifest)) {
      findings.push(`${manifestPath} must contain an object`);
      continue;
    }
    if (!Object.hasOwn(packageLock.packages, packagePath)) {
      findings.push(
        `${manifestPath} has no matching package-lock.json packages entry`,
      );
      continue;
    }

    const lockPackage = packageLock.packages[packagePath];
    if (!isRecord(lockPackage)) {
      findings.push(
        `${manifestPath} package-lock.json packages entry must contain an object`,
      );
      continue;
    }

    for (const section of releaseDependencySections) {
      const manifestValue = Object.hasOwn(manifest, section)
        ? manifest[section]
        : undefined;
      const lockValue = Object.hasOwn(lockPackage, section)
        ? lockPackage[section]
        : undefined;
      const manifestSpecs = dependencySpecs(
        manifestValue,
        `${manifestPath} ${section}`,
        findings,
      );
      const lockSpecs = dependencySpecs(
        lockValue,
        `package-lock.json packages[${JSON.stringify(packagePath)}] ${section}`,
        findings,
      );
      if (manifestSpecs === null || lockSpecs === null) continue;

      const dependencyNames = [...new Set([
        ...manifestSpecs.keys(),
        ...lockSpecs.keys(),
      ])].sort();
      for (const dependencyName of dependencyNames) {
        if (manifestSpecs.get(dependencyName) !== lockSpecs.get(dependencyName)) {
          findings.push(
            `${manifestPath} ${section}.${dependencyName} does not match package-lock.json`,
          );
        }
      }
    }
  }

  return findings;
}

export function approvedReleaseLockfile(packageLock, manifestsByPath) {
  return releaseLockfileDependencyFindings(packageLock, manifestsByPath).length === 0;
}
