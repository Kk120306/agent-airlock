function parseNullSeparatedPaths(output) {
  return Buffer.from(output)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

export function releaseFileInventory({ cachedOutput, scannedOutput }) {
  const cachedFiles = parseNullSeparatedPaths(cachedOutput);
  const scannedFiles = parseNullSeparatedPaths(scannedOutput);
  const scanned = new Set(scannedFiles);
  if (cachedFiles.some((file) => !scanned.has(file))) {
    throw new Error("Release scan inventory omitted a cached file");
  }
  return {
    cachedFiles,
    cachedFileSet: new Set(cachedFiles),
    scannedFiles,
  };
}

export function missingCachedReleaseFiles(requiredFiles, cachedFileSet) {
  if (!(cachedFileSet instanceof Set)) {
    throw new TypeError("Cached release file inventory must be a Set");
  }
  return requiredFiles.filter((file) => !cachedFileSet.has(file));
}
