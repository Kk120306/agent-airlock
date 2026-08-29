import { randomUUID } from "node:crypto";
import {
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";

const leaseSchema = "agent-airlock/modelark-demo-lease";
const takeoverSchema = "agent-airlock/modelark-demo-takeover";
const ownerFileName = "owner.json";
const maximumMarkerBytes = 1_024;
const maximumAcquireAttempts = 32;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function ownedByCurrentUser(status) {
  return (
    typeof process.geteuid !== "function" || status.uid === process.geteuid()
  );
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSafeDirectory(status) {
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    !ownedByCurrentUser(status) ||
    (status.mode & 0o077) !== 0
  ) {
    throw new Error("The ModelArk proof ownership lease is unsafe");
  }
}

function assertSafeMarker(status, allowedLinkCounts = [1]) {
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    !allowedLinkCounts.includes(status.nlink) ||
    !ownedByCurrentUser(status) ||
    (status.mode & 0o077) !== 0 ||
    status.size < 1 ||
    status.size > maximumMarkerBytes
  ) {
    throw new Error("The ModelArk proof ownership marker is unsafe");
  }
}

function readJsonMarker(markerPath, malformedMessage) {
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw new Error(malformedMessage);
  }
}

function claimIdentityPathFor(leasePath, ownerNonce) {
  return `${leasePath}.claim-${ownerNonce}.owner`;
}

function claimMarkerPathFor(leasePath, ownerNonce) {
  return `${leasePath}.claim-${ownerNonce}.json`;
}

function retiredLeasePathFor(leasePath, ownerNonce) {
  return `${leasePath}.retired-${ownerNonce}`;
}

function inspectLease(directoryPath, activeLeasePath = directoryPath) {
  const directory = lstatSync(directoryPath);
  assertSafeDirectory(directory);
  const entries = readdirSync(directoryPath);
  if (entries.length !== 1 || entries[0] !== ownerFileName) {
    throw new Error("The ModelArk proof ownership lease is not exact");
  }
  const ownerPath = path.join(directoryPath, ownerFileName);
  const ownerStatus = lstatSync(ownerPath);
  assertSafeMarker(ownerStatus, [1, 2]);
  const owner = readJsonMarker(
    ownerPath,
    "The ModelArk proof ownership marker is malformed",
  );
  const legacyOwner =
    owner?.schemaVersion === 1 &&
    exactKeys(owner, ["nonce", "ownerPid", "schema", "schemaVersion"]);
  const processGroupBoundOwner =
    owner?.schemaVersion === 2 &&
    exactKeys(owner, [
      "nonce",
      "ownerPid",
      "ownerProcessGroupId",
      "schema",
      "schemaVersion",
    ]);
  const validProcessGroupId =
    owner?.ownerProcessGroupId === null ||
    (Number.isSafeInteger(owner?.ownerProcessGroupId) &&
      owner.ownerProcessGroupId > 0 &&
      owner.ownerProcessGroupId <= 2_147_483_647);
  if (
    (!legacyOwner && !processGroupBoundOwner) ||
    owner.schema !== leaseSchema ||
    !Number.isSafeInteger(owner.ownerPid) ||
    owner.ownerPid < 1 ||
    owner.ownerPid > 2_147_483_647 ||
    (processGroupBoundOwner && !validProcessGroupId) ||
    !uuidPattern.test(owner.nonce ?? "")
  ) {
    throw new Error("The ModelArk proof ownership marker is invalid");
  }

  const claimIdentityPath = claimIdentityPathFor(activeLeasePath, owner.nonce);
  if (ownerStatus.nlink === 2) {
    const claimIdentityStatus = lstatSync(claimIdentityPath);
    assertSafeMarker(claimIdentityStatus, [2]);
    if (!sameFile(ownerStatus, claimIdentityStatus)) {
      throw new Error(
        "The ModelArk proof ownership claim is not bound to its owner",
      );
    }
  }

  return { claimIdentityPath, directory, owner, ownerPath, ownerStatus };
}

function tryInspectLease(leasePath) {
  try {
    return inspectLease(leasePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function defaultProcessGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function canonicalManagedRoot(stateRoot) {
  const requestedRoot = path.resolve(stateRoot);
  const requestedParent = path.dirname(requestedRoot);
  mkdirSync(requestedParent, { recursive: true, mode: 0o700 });

  let rootStatus;
  try {
    rootStatus = lstatSync(requestedRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return path.join(
      realpathSync(requestedParent),
      path.basename(requestedRoot),
    );
  }

  if (rootStatus.isSymbolicLink()) {
    throw new Error(
      "Refusing a symbolic-link alias for the ModelArk demo data root",
    );
  }
  if (!rootStatus.isDirectory()) {
    throw new Error("The ModelArk demo data root is not a directory");
  }
  return realpathSync(requestedRoot);
}

function removeStagedLease(stagingPath) {
  try {
    unlinkSync(path.join(stagingPath, ownerFileName));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    rmdirSync(stagingPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function publishLease({ interleave, leasePath, owner }) {
  const stagingPath = `${leasePath}.staging-${owner.nonce}`;
  mkdirSync(stagingPath, { mode: 0o700 });
  try {
    writeFileSync(
      path.join(stagingPath, ownerFileName),
      JSON.stringify(owner) + "\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    interleave("after-owner-staged", { leasePath, owner, stagingPath });
    renameSync(stagingPath, leasePath);
    return true;
  } catch (error) {
    removeStagedLease(stagingPath);
    if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) return false;
    throw error;
  }
}

function inspectClaimMarker(markerPath, activeLeasePath, ownerNonce) {
  const markerStatus = lstatSync(markerPath);
  assertSafeMarker(markerStatus, [1, 2]);
  const marker = readJsonMarker(
    markerPath,
    "The ModelArk proof ownership takeover marker is malformed",
  );
  if (
    !exactKeys(marker, [
      "claimantNonce",
      "claimantPid",
      "ownerNonce",
      "schema",
      "schemaVersion",
    ]) ||
    marker.schema !== takeoverSchema ||
    marker.schemaVersion !== 1 ||
    marker.ownerNonce !== ownerNonce ||
    !Number.isSafeInteger(marker.claimantPid) ||
    marker.claimantPid < 1 ||
    marker.claimantPid > 2_147_483_647 ||
    !uuidPattern.test(marker.claimantNonce ?? "")
  ) {
    throw new Error("The ModelArk proof ownership takeover marker is invalid");
  }
  if (markerStatus.nlink === 2) {
    const stagingPath = `${activeLeasePath}.takeover-${ownerNonce}-${marker.claimantNonce}.staging`;
    let stagingStatus;
    try {
      stagingStatus = lstatSync(stagingPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const settledMarkerStatus = lstatSync(markerPath);
      assertSafeMarker(settledMarkerStatus, [1]);
      if (!sameFile(markerStatus, settledMarkerStatus)) {
        throw new Error("The ModelArk proof ownership takeover marker changed");
      }
      return marker;
    }
    assertSafeMarker(stagingStatus, [2]);
    if (!sameFile(markerStatus, stagingStatus)) {
      throw new Error("The ModelArk proof ownership takeover marker is unsafe");
    }
  }
  return marker;
}

function establishTakeoverClaim({ existing, interleave, leasePath, owner }) {
  let createdIdentity = false;
  try {
    linkSync(existing.ownerPath, existing.claimIdentityPath);
    createdIdentity = true;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code !== "EEXIST") throw error;
  }

  const claimIdentityStatus = lstatSync(existing.claimIdentityPath);
  assertSafeMarker(claimIdentityStatus, [2]);
  if (!sameFile(claimIdentityStatus, existing.ownerStatus)) {
    if (createdIdentity) unlinkSync(existing.claimIdentityPath);
    const current = tryInspectLease(leasePath);
    if (!current || current.owner.nonce !== existing.owner.nonce) return null;
    throw new Error(
      "The ModelArk proof ownership claim conflicts with its owner",
    );
  }

  const current = tryInspectLease(leasePath);
  if (!current || !sameFile(current.ownerStatus, claimIdentityStatus))
    return null;
  interleave("after-claim-identity", {
    claimIdentityPath: existing.claimIdentityPath,
    leasePath,
    owner,
  });

  const markerPath = claimMarkerPathFor(leasePath, existing.owner.nonce);
  const takeover = {
    schema: takeoverSchema,
    schemaVersion: 1,
    ownerNonce: existing.owner.nonce,
    claimantPid: owner.ownerPid,
    claimantNonce: owner.nonce,
  };
  const markerStagingPath = `${leasePath}.takeover-${existing.owner.nonce}-${owner.nonce}.staging`;
  let createdMarker = false;
  try {
    writeFileSync(markerStagingPath, JSON.stringify(takeover) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      linkSync(markerStagingPath, markerPath);
      createdMarker = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } finally {
    try {
      unlinkSync(markerStagingPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const established = inspectClaimMarker(
    markerPath,
    leasePath,
    existing.owner.nonce,
  );
  interleave("after-claim-marker", {
    claimIdentityPath: existing.claimIdentityPath,
    createdMarker,
    leasePath,
    markerPath,
    owner,
    takeover: established,
  });
  return {
    claimIdentityPath: existing.claimIdentityPath,
    createdMarker,
    markerPath,
    takeover: established,
  };
}

function retireClaimedLease({ claim, existing, interleave, leasePath, owner }) {
  const current = tryInspectLease(leasePath);
  if (!current) return false;
  const claimIdentityStatus = lstatSync(claim.claimIdentityPath);
  if (!sameFile(current.ownerStatus, claimIdentityStatus)) return false;

  const retiredPath = retiredLeasePathFor(leasePath, existing.owner.nonce);
  interleave("before-retire", {
    claimIdentityPath: claim.claimIdentityPath,
    leasePath,
    owner,
    retiredPath,
  });
  try {
    renameSync(leasePath, retiredPath);
  } catch (error) {
    if (!["EEXIST", "ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
    let retired;
    try {
      retired = inspectLease(retiredPath, leasePath);
    } catch (inspectionError) {
      if (inspectionError?.code === "ENOENT") return false;
      throw inspectionError;
    }
    if (!sameFile(retired.ownerStatus, claimIdentityStatus)) {
      throw new Error(
        "The ModelArk retired proof lease conflicts with its owner",
      );
    }
    return false;
  }

  const retired = inspectLease(retiredPath, leasePath);
  if (!sameFile(retired.ownerStatus, claimIdentityStatus)) {
    throw new Error(
      "The ModelArk retired proof lease conflicts with its owner",
    );
  }
  interleave("after-retire", { leasePath, owner, retiredPath });
  return true;
}

function validateRequestedOwner(owner) {
  if (
    !Number.isSafeInteger(owner.ownerPid) ||
    owner.ownerPid < 1 ||
    owner.ownerPid > 2_147_483_647 ||
    !(
      owner.ownerProcessGroupId === null ||
      (Number.isSafeInteger(owner.ownerProcessGroupId) &&
        owner.ownerProcessGroupId > 0 &&
        owner.ownerProcessGroupId <= 2_147_483_647)
    ) ||
    !uuidPattern.test(owner.nonce)
  ) {
    throw new Error("The requested ModelArk proof owner is invalid");
  }
}

function releasePublishedLease({ interleave, leasePath, owner }) {
  const current = inspectLease(leasePath);
  if (
    current.owner.ownerPid !== owner.ownerPid ||
    current.owner.nonce !== owner.nonce
  ) {
    throw new Error("The ModelArk proof ownership lease changed");
  }
  if (current.ownerStatus.nlink !== 1) {
    throw new Error("The ModelArk proof ownership lease is under takeover");
  }

  const releasedPath = `${leasePath}.released-${owner.nonce}`;
  renameSync(leasePath, releasedPath);
  interleave("after-release-retire", { leasePath, owner, releasedPath });
  const released = inspectLease(releasedPath, leasePath);
  if (
    released.owner.ownerPid !== owner.ownerPid ||
    released.owner.nonce !== owner.nonce
  ) {
    throw new Error("The released ModelArk proof ownership lease changed");
  }
  unlinkSync(released.ownerPath);
  rmdirSync(releasedPath);
}

export function releaseModelArkDemoLease({
  stateRoot,
  ownerPid,
  nonce,
  interleave = () => {},
}) {
  const canonicalStateRoot = canonicalManagedRoot(stateRoot);
  const leasePath = canonicalStateRoot + ".active-proof";
  const current = tryInspectLease(leasePath);
  if (
    !current ||
    current.owner.ownerPid !== ownerPid ||
    current.owner.nonce !== nonce
  ) {
    return false;
  }
  releasePublishedLease({
    interleave,
    leasePath,
    owner: { ownerPid, nonce },
  });
  return true;
}

export function acquireModelArkDemoLease({
  stateRoot,
  resetRequested = false,
  ownerPid = process.pid,
  ownerProcessGroupId = null,
  nonce = randomUUID(),
  processExists = defaultProcessExists,
  processGroupExists = defaultProcessGroupExists,
  interleave = () => {},
}) {
  const canonicalStateRoot = canonicalManagedRoot(stateRoot);
  const leasePath = canonicalStateRoot + ".active-proof";
  const owner = {
    schema: leaseSchema,
    schemaVersion: 2,
    ownerPid,
    ownerProcessGroupId,
    nonce,
  };
  validateRequestedOwner(owner);

  for (let attempt = 0; attempt < maximumAcquireAttempts; attempt += 1) {
    if (publishLease({ interleave, leasePath, owner })) {
      let held = true;
      return {
        stateRoot: canonicalStateRoot,
        leasePath,
        release() {
          if (!held) return;
          releasePublishedLease({ interleave, leasePath, owner });
          held = false;
        },
      };
    }

    const existing = tryInspectLease(leasePath);
    if (!existing) continue;
    const ownerProcessExists = processExists(existing.owner.ownerPid);
    const ownerProcessGroupExists =
      existing.owner.schemaVersion === 2 &&
      existing.owner.ownerProcessGroupId !== null &&
      processGroupExists(existing.owner.ownerProcessGroupId);
    if (ownerProcessExists || ownerProcessGroupExists) {
      throw new Error(
        "The ModelArk demo data root is already owned by an active proof",
      );
    }
    if (!resetRequested) {
      throw new Error(
        "The ModelArk demo data root has an abandoned proof lease; rerun with --reset",
      );
    }
    if (existing.owner.schemaVersion !== 2) {
      throw new Error(
        "The abandoned ModelArk proof lease has no process-group identity and cannot be reset safely",
      );
    }
    interleave("after-stale-inspection", { existing, leasePath, owner });

    const claim = establishTakeoverClaim({
      existing,
      interleave,
      leasePath,
      owner,
    });
    if (!claim) continue;
    const claimBelongsToRequester =
      claim.takeover.claimantPid === owner.ownerPid &&
      claim.takeover.claimantNonce === owner.nonce;
    if (!claimBelongsToRequester && processExists(claim.takeover.claimantPid)) {
      throw new Error(
        "The ModelArk demo data root already has an active reset takeover",
      );
    }
    retireClaimedLease({
      claim,
      existing,
      interleave,
      leasePath,
      owner,
    });
  }

  throw new Error("The ModelArk proof ownership lease did not stabilize");
}

export async function acquireModelArkDemoStartupLease({
  host,
  port,
  ...lease
}) {
  const portAvailable = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
  if (!portAvailable) {
    throw new Error(
      `The live ModelArk demo port is already in use: http://${host}:${port}`,
    );
  }
  return acquireModelArkDemoLease(lease);
}
