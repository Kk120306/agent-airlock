#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";

const DIRECTORY_DESCRIPTOR = 3;
const MAXIMUM_INPUT_BYTES = 6_500_000;
const MAXIMUM_OUTPUT_BYTES = 6_500_000;
const COMMIT_REPLACE_MAXIMUM_ATTEMPTS = 32;
const LEAF_NAME_PATTERN = /^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const TEMPORARY_NAME_PATTERN = /^\.runtime-proof-tmp-[0-9]+-[a-f0-9-]{36}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function fail() {
  process.stdout.write('{"ok":false}\n');
  process.exitCode = 1;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function validateLeafName(name) {
  if (
    typeof name !== "string" ||
    !LEAF_NAME_PATTERN.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error("invalid leaf");
  }
  return name;
}

function validateTemporaryName(name) {
  if (typeof name !== "string" || !TEMPORARY_NAME_PATTERN.test(name)) {
    throw new Error("invalid temporary leaf");
  }
  return name;
}

function validateDirectoryEntryName(name) {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw new Error("invalid directory entry");
  }
  return name;
}

function validateMaximumBytes(value) {
  if (!Number.isInteger(value) || value < 1 || value > 4_194_304) {
    throw new Error("invalid byte boundary");
  }
  return value;
}

function validateRecordingDeadlineAt(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("invalid recording deadline");
  }
  return value;
}

function assertBeforeRecordingDeadline(recordingDeadlineAt) {
  const observedAt = Date.now();
  if (!Number.isSafeInteger(observedAt) || observedAt >= recordingDeadlineAt) {
    throw new Error("recording deadline reached");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownedByCurrentUser(status) {
  return (
    typeof process.geteuid !== "function" ||
    status.uid === BigInt(process.geteuid())
  );
}

function assertAnchoredDirectory(request) {
  const descriptor = fstatSync(DIRECTORY_DESCRIPTOR, { bigint: true });
  const current = statSync(".", { bigint: true });
  if (
    !descriptor.isDirectory() ||
    !current.isDirectory() ||
    !ownedByCurrentUser(descriptor) ||
    !ownedByCurrentUser(current) ||
    (descriptor.mode & 0o077n) !== 0n ||
    (current.mode & 0o077n) !== 0n ||
    !sameIdentity(descriptor, current) ||
    String(descriptor.dev) !== request.anchorDev ||
    String(descriptor.ino) !== request.anchorIno
  ) {
    throw new Error("directory identity changed");
  }
  return descriptor;
}

function readOwnerOnlyLeaf(
  name,
  maximumBytes,
  allowMissing = true,
  allowTemporaryName = false,
  { expectedIdentity = null, expectedLinkCount = 1n, expectedMode = null } = {},
) {
  name = allowTemporaryName
    ? validateTemporaryName(name)
    : validateLeafName(name);
  maximumBytes = validateMaximumBytes(maximumBytes);
  let before;
  try {
    before = lstatSync(name, { bigint: true });
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !ownedByCurrentUser(before) ||
    before.nlink !== expectedLinkCount ||
    (before.mode & 0o077n) !== 0n ||
    (expectedIdentity !== null && !sameIdentity(before, expectedIdentity)) ||
    (expectedMode !== null && before.mode !== expectedMode) ||
    before.size > BigInt(maximumBytes)
  ) {
    throw new Error("unsafe file");
  }
  const descriptor = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      !ownedByCurrentUser(opened) ||
      opened.nlink !== expectedLinkCount ||
      (opened.mode & 0o077n) !== 0n ||
      opened.mode !== before.mode ||
      !sameIdentity(before, opened) ||
      opened.size > BigInt(maximumBytes)
    ) {
      throw new Error("unsafe opened file");
    }
    const expectedBytes = Number(opened.size);
    const bytes = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const bytesRead = readSync(
        descriptor,
        bytes,
        offset,
        expectedBytes - offset,
        offset,
      );
      if (bytesRead === 0) throw new Error("short file read");
      offset += bytesRead;
    }
    const overflowProbe = Buffer.alloc(1);
    if (readSync(descriptor, overflowProbe, 0, 1, offset) !== 0) {
      throw new Error("file exceeded boundary");
    }
    const openedAfter = fstatSync(descriptor, { bigint: true });
    if (
      !openedAfter.isFile() ||
      !ownedByCurrentUser(openedAfter) ||
      openedAfter.nlink !== expectedLinkCount ||
      (openedAfter.mode & 0o077n) !== 0n ||
      openedAfter.mode !== before.mode ||
      !sameIdentity(before, openedAfter) ||
      openedAfter.size !== BigInt(offset)
    ) {
      throw new Error("file changed during read");
    }
    const after = lstatSync(name, { bigint: true });
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      !ownedByCurrentUser(after) ||
      after.nlink !== expectedLinkCount ||
      (after.mode & 0o077n) !== 0n ||
      after.mode !== before.mode ||
      !sameIdentity(before, after) ||
      after.size !== BigInt(offset)
    ) {
      throw new Error("file path changed during read");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function decodeBoundedContent(content, maximumBytes) {
  if (typeof content !== "string" || content.length > MAXIMUM_INPUT_BYTES) {
    throw new Error("invalid content");
  }
  const bytes = Buffer.from(content, "base64");
  if (
    bytes.length < 1 ||
    bytes.length > validateMaximumBytes(maximumBytes) ||
    bytes.toString("base64") !== content
  ) {
    throw new Error("invalid encoded content");
  }
  return bytes;
}

function validateToken(token) {
  if (
    !exactKeys(token, ["device", "digest", "inode", "size", "temporaryName"]) ||
    !/^[0-9]{1,20}$/.test(token.device ?? "") ||
    !SHA256_PATTERN.test(token.digest ?? "") ||
    !/^[0-9]{1,20}$/.test(token.inode ?? "") ||
    !Number.isInteger(token.size) ||
    token.size < 1 ||
    token.size > 4_194_304
  ) {
    throw new Error("invalid token");
  }
  validateTemporaryName(token.temporaryName);
  return token;
}

function tokenIdentity(token) {
  token = validateToken(token);
  return {
    dev: BigInt(token.device),
    ino: BigInt(token.inode),
  };
}

function writePreparedLeaf(bytes) {
  const temporaryName = `.runtime-proof-tmp-${process.pid}-${randomUUID()}`;
  let descriptor = null;
  let created = false;
  try {
    descriptor = openSync(
      temporaryName,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    let offset = 0;
    while (offset < bytes.length) {
      const bytesWritten = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesWritten === 0) throw new Error("short file write");
      offset += bytesWritten;
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const stored = fstatSync(descriptor, { bigint: true });
    if (
      !stored.isFile() ||
      !ownedByCurrentUser(stored) ||
      stored.nlink !== 1n ||
      (stored.mode & 0o7777n) !== 0o600n ||
      stored.size !== BigInt(bytes.length)
    ) {
      throw new Error("unsafe prepared file");
    }
    closeSync(descriptor);
    descriptor = null;
    fsyncSync(DIRECTORY_DESCRIPTOR);
    return {
      device: String(stored.dev),
      temporaryName,
      digest: sha256(bytes),
      inode: String(stored.ino),
      size: bytes.length,
    };
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (created) {
      try {
        unlinkSync(temporaryName);
      } catch {}
    }
    throw error;
  }
}

function openPreparedLeaf(token) {
  token = validateToken(token);
  const expectedIdentity = tokenIdentity(token);
  const descriptor = openSync(
    token.temporaryName,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const expected = fstatSync(descriptor, { bigint: true });
    if (
      !expected.isFile() ||
      !ownedByCurrentUser(expected) ||
      expected.nlink !== 1n ||
      (expected.mode & 0o7777n) !== 0o600n ||
      !sameIdentity(expected, expectedIdentity) ||
      expected.size !== BigInt(token.size)
    ) {
      throw new Error("unsafe prepared file");
    }
    const bytes = readOwnerOnlyLeaf(
      token.temporaryName,
      token.size,
      false,
      true,
      { expectedIdentity, expectedMode: expected.mode },
    );
    const retained = fstatSync(descriptor, { bigint: true });
    if (
      !retained.isFile() ||
      !ownedByCurrentUser(retained) ||
      retained.nlink !== 1n ||
      retained.mode !== expected.mode ||
      !sameIdentity(expected, retained) ||
      retained.size !== BigInt(token.size) ||
      bytes.length !== token.size ||
      sha256(bytes) !== token.digest
    ) {
      throw new Error("prepared file changed");
    }
    return { bytes, descriptor, status: retained };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertPreparedLeaf(token) {
  const prepared = openPreparedLeaf(token);
  try {
    return prepared.bytes;
  } finally {
    closeSync(prepared.descriptor);
  }
}

function prepareReplace(request) {
  validateLeafName(request.name);
  const bytes = decodeBoundedContent(request.content, request.maximumBytes);
  return { token: writePreparedLeaf(bytes) };
}

function commitReplace(request) {
  const name = validateLeafName(request.name);
  const token = validateToken(request.token);
  const recordingDeadlineAt = validateRecordingDeadlineAt(
    request.recordingDeadlineAt,
  );
  const prepared = openPreparedLeaf(token);
  try {
    for (
      let attempt = 0;
      attempt < COMMIT_REPLACE_MAXIMUM_ATTEMPTS;
      attempt += 1
    ) {
      const retained = readOwnerOnlyLeaf(
        token.temporaryName,
        token.size,
        false,
        true,
        {
          expectedIdentity: prepared.status,
          expectedMode: prepared.status.mode,
        },
      );
      if (sha256(retained) !== token.digest) {
        throw new Error("prepared file changed before commit");
      }
      const attemptName = `.runtime-proof-tmp-${process.pid}-${randomUUID()}`;
      linkSync(token.temporaryName, attemptName);
      if (
        process.env.AGENT_AIRLOCK_TEST_PAUSE_AFTER_COMMIT_LINK === "1" &&
        request.testPauseAfterLink === true
      ) {
        writeSync(4, Buffer.from("linked\n", "utf8"));
        process.kill(process.pid, "SIGSTOP");
      }
      try {
        const linked = readOwnerOnlyLeaf(attemptName, token.size, false, true, {
          expectedIdentity: prepared.status,
          expectedLinkCount: 2n,
          expectedMode: prepared.status.mode,
        });
        if (sha256(linked) !== token.digest) {
          throw new Error("commit link changed");
        }
        assertBeforeRecordingDeadline(recordingDeadlineAt);
        renameSync(attemptName, name);
      } catch (error) {
        try {
          const attemptStatus = lstatSync(attemptName, { bigint: true });
          if (sameIdentity(prepared.status, attemptStatus)) {
            unlinkSync(attemptName);
          }
        } catch {}
        throw error;
      }
      try {
        const committed = readOwnerOnlyLeaf(name, token.size, false, false, {
          expectedIdentity: prepared.status,
          expectedLinkCount: 2n,
          expectedMode: prepared.status.mode,
        });
        if (
          committed.length !== token.size ||
          sha256(committed) !== token.digest
        ) {
          throw new Error("committed file changed");
        }
        removePreparedDirectoryEntry(token, prepared);
        fsyncSync(DIRECTORY_DESCRIPTOR);
        return { committed: true };
      } catch (error) {
        const displaced = fstatSync(prepared.descriptor, { bigint: true });
        if (
          displaced.isFile() &&
          ownedByCurrentUser(displaced) &&
          displaced.nlink === 1n &&
          displaced.mode === prepared.status.mode &&
          sameIdentity(prepared.status, displaced) &&
          displaced.size === BigInt(token.size)
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("commit could not reach a stable destination");
  } finally {
    closeSync(prepared.descriptor);
  }
}

function cleanupUncommittedReplace(token) {
  token = validateToken(token);
  const expectedIdentity = tokenIdentity(token);
  const preparedDescriptor = openSync(
    token.temporaryName,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const initialStatus = fstatSync(preparedDescriptor, { bigint: true });
    if (
      !initialStatus.isFile() ||
      !ownedByCurrentUser(initialStatus) ||
      initialStatus.nlink < 1n ||
      initialStatus.nlink > BigInt(COMMIT_REPLACE_MAXIMUM_ATTEMPTS + 1) ||
      (initialStatus.mode & 0o7777n) !== 0o600n ||
      !sameIdentity(initialStatus, expectedIdentity) ||
      initialStatus.size !== BigInt(token.size)
    ) {
      throw new Error("unsafe uncommitted replacement");
    }
    const preparedBytes = readOwnerOnlyLeaf(
      token.temporaryName,
      token.size,
      false,
      true,
      {
        expectedIdentity,
        expectedLinkCount: initialStatus.nlink,
        expectedMode: initialStatus.mode,
      },
    );
    if (
      preparedBytes.length !== token.size ||
      sha256(preparedBytes) !== token.digest
    ) {
      throw new Error("uncommitted replacement content changed");
    }
    const attemptNames = [];
    for (const entry of readdirSync(".", { withFileTypes: true })) {
      if (
        entry.name === token.temporaryName ||
        !TEMPORARY_NAME_PATTERN.test(entry.name) ||
        entry.isSymbolicLink()
      ) {
        continue;
      }
      let entryStatus;
      try {
        entryStatus = lstatSync(entry.name, { bigint: true });
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (sameIdentity(entryStatus, expectedIdentity)) {
        attemptNames.push(entry.name);
      }
    }
    if (BigInt(attemptNames.length + 1) !== initialStatus.nlink) {
      throw new Error("uncommitted replacement links are ambiguous");
    }
    for (const attemptName of attemptNames) {
      const retainedBefore = fstatSync(preparedDescriptor, { bigint: true });
      const attemptBytes = readOwnerOnlyLeaf(
        attemptName,
        token.size,
        false,
        true,
        {
          expectedIdentity,
          expectedLinkCount: retainedBefore.nlink,
          expectedMode: initialStatus.mode,
        },
      );
      if (
        attemptBytes.length !== token.size ||
        sha256(attemptBytes) !== token.digest
      ) {
        throw new Error("uncommitted attempt content changed");
      }
      const attemptStatus = lstatSync(attemptName, { bigint: true });
      if (
        !attemptStatus.isFile() ||
        attemptStatus.isSymbolicLink() ||
        !ownedByCurrentUser(attemptStatus) ||
        attemptStatus.nlink !== retainedBefore.nlink ||
        attemptStatus.mode !== initialStatus.mode ||
        !sameIdentity(attemptStatus, expectedIdentity) ||
        attemptStatus.size !== BigInt(token.size)
      ) {
        throw new Error("uncommitted attempt path changed");
      }
      unlinkSync(attemptName);
      const retainedAfter = fstatSync(preparedDescriptor, { bigint: true });
      if (
        !sameIdentity(retainedAfter, expectedIdentity) ||
        retainedAfter.nlink !== retainedBefore.nlink - 1n
      ) {
        throw new Error("uncommitted attempt cleanup changed another file");
      }
    }
    fsyncSync(DIRECTORY_DESCRIPTOR);
    const retainedBytes = readOwnerOnlyLeaf(
      token.temporaryName,
      token.size,
      false,
      true,
      {
        expectedIdentity,
        expectedLinkCount: 1n,
        expectedMode: initialStatus.mode,
      },
    );
    if (
      retainedBytes.length !== token.size ||
      sha256(retainedBytes) !== token.digest
    ) {
      throw new Error("uncommitted replacement cleanup changed content");
    }
  } finally {
    closeSync(preparedDescriptor);
  }
}

function reconcileReplace(request) {
  const name = validateLeafName(request.name);
  const token = validateToken(request.token);
  const expectedIdentity = tokenIdentity(token);
  let destinationStatus;
  try {
    destinationStatus = lstatSync(name, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      cleanupUncommittedReplace(token);
      return { committed: false };
    }
    throw error;
  }
  if (
    !destinationStatus.isFile() ||
    destinationStatus.isSymbolicLink() ||
    !ownedByCurrentUser(destinationStatus) ||
    (destinationStatus.mode & 0o077n) !== 0n
  ) {
    throw new Error("unsafe replacement destination");
  }
  if (!sameIdentity(destinationStatus, expectedIdentity)) {
    cleanupUncommittedReplace(token);
    return { committed: false };
  }
  if (
    ![1n, 2n].includes(destinationStatus.nlink) ||
    (destinationStatus.mode & 0o7777n) !== 0o600n ||
    destinationStatus.size !== BigInt(token.size)
  ) {
    throw new Error("committed replacement identity is unsafe");
  }
  const destinationBytes = readOwnerOnlyLeaf(name, token.size, false, false, {
    expectedIdentity,
    expectedLinkCount: destinationStatus.nlink,
    expectedMode: destinationStatus.mode,
  });
  if (
    destinationBytes.length !== token.size ||
    sha256(destinationBytes) !== token.digest
  ) {
    throw new Error("committed replacement content changed");
  }
  if (destinationStatus.nlink === 2n) {
    const preparedDescriptor = openSync(
      token.temporaryName,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const preparedStatus = fstatSync(preparedDescriptor, { bigint: true });
      if (
        !preparedStatus.isFile() ||
        !ownedByCurrentUser(preparedStatus) ||
        preparedStatus.nlink !== 2n ||
        preparedStatus.mode !== destinationStatus.mode ||
        !sameIdentity(preparedStatus, expectedIdentity) ||
        preparedStatus.size !== BigInt(token.size)
      ) {
        throw new Error("prepared replacement link changed");
      }
      const preparedBytes = readOwnerOnlyLeaf(
        token.temporaryName,
        token.size,
        false,
        true,
        {
          expectedIdentity,
          expectedLinkCount: 2n,
          expectedMode: preparedStatus.mode,
        },
      );
      if (
        preparedBytes.length !== token.size ||
        sha256(preparedBytes) !== token.digest
      ) {
        throw new Error("prepared replacement content changed");
      }
      unlinkSync(token.temporaryName);
      const retained = fstatSync(preparedDescriptor, { bigint: true });
      if (!sameIdentity(retained, expectedIdentity) || retained.nlink !== 1n) {
        throw new Error("prepared replacement cleanup changed another file");
      }
    } finally {
      closeSync(preparedDescriptor);
    }
  } else {
    try {
      const unexpectedPrepared = lstatSync(token.temporaryName, {
        bigint: true,
      });
      if (unexpectedPrepared) {
        throw new Error("committed replacement retained a prepared path");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  fsyncSync(DIRECTORY_DESCRIPTOR);
  const durableBytes = readOwnerOnlyLeaf(name, token.size, false, false, {
    expectedIdentity,
    expectedLinkCount: 1n,
    expectedMode: destinationStatus.mode,
  });
  if (
    durableBytes.length !== token.size ||
    sha256(durableBytes) !== token.digest
  ) {
    throw new Error("durable replacement changed");
  }
  return { committed: true };
}

function discardPrepared(request) {
  const token = validateToken(request.token);
  try {
    assertPreparedLeaf(token);
    unlinkSync(token.temporaryName);
    fsyncSync(DIRECTORY_DESCRIPTOR);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { discarded: true };
}

function removePreparedDirectoryEntry(token, prepared) {
  const openedBefore = fstatSync(prepared.descriptor, { bigint: true });
  if (
    !openedBefore.isFile() ||
    !ownedByCurrentUser(openedBefore) ||
    openedBefore.nlink > 2n ||
    openedBefore.mode !== prepared.status.mode ||
    !sameIdentity(prepared.status, openedBefore) ||
    openedBefore.size !== BigInt(token.size)
  ) {
    throw new Error("unsafe prepared cleanup");
  }
  let pathStatus;
  try {
    pathStatus = lstatSync(token.temporaryName, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" && openedBefore.nlink <= 1n) return;
    throw error;
  }
  if (
    !pathStatus.isFile() ||
    pathStatus.isSymbolicLink() ||
    !ownedByCurrentUser(pathStatus) ||
    pathStatus.mode !== prepared.status.mode ||
    !sameIdentity(prepared.status, pathStatus) ||
    pathStatus.nlink !== openedBefore.nlink ||
    pathStatus.size !== BigInt(token.size)
  ) {
    throw new Error("prepared path changed before cleanup");
  }
  unlinkSync(token.temporaryName);
  const openedAfter = fstatSync(prepared.descriptor, { bigint: true });
  if (
    !sameIdentity(prepared.status, openedAfter) ||
    openedAfter.nlink !== openedBefore.nlink - 1n
  ) {
    throw new Error("prepared cleanup changed another file");
  }
}

function readRecoveredImmutableDestination(
  name,
  maximumBytes,
  expectedBytes,
  expectedIdentity,
) {
  const recovered = readOwnerOnlyLeaf(name, maximumBytes, false, false, {
    expectedIdentity,
    expectedMode: expectedIdentity.mode,
  });
  if (!recovered.equals(expectedBytes)) {
    throw new Error("recovered immutable mismatch");
  }
  fsyncSync(DIRECTORY_DESCRIPTOR);
  return recovered;
}

function recoverInterruptedImmutable(name, maximumBytes, expectedBytes) {
  let destinationStatus;
  try {
    destinationStatus = lstatSync(name, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (destinationStatus.nlink === 1n) {
    return readOwnerOnlyLeaf(name, maximumBytes, false);
  }
  if (
    !destinationStatus.isFile() ||
    destinationStatus.isSymbolicLink() ||
    !ownedByCurrentUser(destinationStatus) ||
    destinationStatus.nlink !== 2n ||
    (destinationStatus.mode & 0o077n) !== 0n ||
    destinationStatus.size !== BigInt(expectedBytes.length)
  ) {
    throw new Error("unsafe interrupted immutable file");
  }
  let destinationBytes;
  try {
    destinationBytes = readOwnerOnlyLeaf(name, maximumBytes, false, false, {
      expectedIdentity: destinationStatus,
      expectedLinkCount: 2n,
      expectedMode: destinationStatus.mode,
    });
  } catch (error) {
    try {
      return readRecoveredImmutableDestination(
        name,
        maximumBytes,
        expectedBytes,
        destinationStatus,
      );
    } catch {}
    throw error;
  }
  if (!destinationBytes.equals(expectedBytes)) {
    throw new Error("interrupted immutable mismatch");
  }
  const matchingTemporaryNames = [];
  for (const entry of readdirSync(".", { withFileTypes: true })) {
    if (
      entry.name === name ||
      !TEMPORARY_NAME_PATTERN.test(entry.name) ||
      entry.isSymbolicLink()
    ) {
      continue;
    }
    let status;
    try {
      status = lstatSync(entry.name, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (sameIdentity(destinationStatus, status)) {
      matchingTemporaryNames.push(entry.name);
    }
  }
  if (matchingTemporaryNames.length !== 1) {
    if (matchingTemporaryNames.length === 0) {
      try {
        return readRecoveredImmutableDestination(
          name,
          maximumBytes,
          expectedBytes,
          destinationStatus,
        );
      } catch {}
    }
    throw new Error("interrupted immutable link is ambiguous");
  }
  const temporaryName = matchingTemporaryNames[0];
  let temporaryBytes;
  try {
    temporaryBytes = readOwnerOnlyLeaf(
      temporaryName,
      maximumBytes,
      false,
      true,
      {
        expectedIdentity: destinationStatus,
        expectedLinkCount: 2n,
        expectedMode: destinationStatus.mode,
      },
    );
  } catch (error) {
    try {
      return readRecoveredImmutableDestination(
        name,
        maximumBytes,
        expectedBytes,
        destinationStatus,
      );
    } catch {}
    throw error;
  }
  if (!temporaryBytes.equals(expectedBytes)) {
    throw new Error("interrupted immutable temporary mismatch");
  }
  let temporaryDescriptor;
  try {
    temporaryDescriptor = openSync(
      temporaryName,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    try {
      return readRecoveredImmutableDestination(
        name,
        maximumBytes,
        expectedBytes,
        destinationStatus,
      );
    } catch {}
    throw error;
  }
  try {
    const pinned = fstatSync(temporaryDescriptor, { bigint: true });
    if (sameIdentity(destinationStatus, pinned) && pinned.nlink === 1n) {
      return readRecoveredImmutableDestination(
        name,
        maximumBytes,
        expectedBytes,
        destinationStatus,
      );
    }
    if (
      !pinned.isFile() ||
      !ownedByCurrentUser(pinned) ||
      !sameIdentity(destinationStatus, pinned) ||
      pinned.nlink !== 2n ||
      pinned.mode !== destinationStatus.mode ||
      pinned.size !== BigInt(expectedBytes.length)
    ) {
      throw new Error("interrupted immutable temporary changed");
    }
    let beforeUnlink;
    try {
      beforeUnlink = lstatSync(temporaryName, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return readRecoveredImmutableDestination(
          name,
          maximumBytes,
          expectedBytes,
          destinationStatus,
        );
      }
      throw error;
    }
    if (!sameIdentity(pinned, beforeUnlink) || beforeUnlink.nlink !== 2n) {
      try {
        return readRecoveredImmutableDestination(
          name,
          maximumBytes,
          expectedBytes,
          destinationStatus,
        );
      } catch {}
      throw new Error("interrupted immutable path changed");
    }
    try {
      unlinkSync(temporaryName);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return readRecoveredImmutableDestination(
          name,
          maximumBytes,
          expectedBytes,
          destinationStatus,
        );
      }
      throw error;
    }
    const afterUnlink = fstatSync(temporaryDescriptor, { bigint: true });
    if (!sameIdentity(pinned, afterUnlink) || afterUnlink.nlink !== 1n) {
      throw new Error("interrupted immutable recovery failed");
    }
  } finally {
    closeSync(temporaryDescriptor);
  }
  return readRecoveredImmutableDestination(
    name,
    maximumBytes,
    expectedBytes,
    destinationStatus,
  );
}

function installImmutable(request) {
  const name = validateLeafName(request.name);
  const bytes = decodeBoundedContent(request.content, request.maximumBytes);
  const existing = recoverInterruptedImmutable(
    name,
    request.maximumBytes,
    bytes,
  );
  if (existing !== null) {
    if (!existing.equals(bytes)) throw new Error("immutable mismatch");
    return { installed: false };
  }
  const token = writePreparedLeaf(bytes);
  let prepared = null;
  let linked = false;
  try {
    prepared = openPreparedLeaf(token);
    try {
      linkSync(token.temporaryName, name);
      linked = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (linked) {
      const linkedStatus = fstatSync(prepared.descriptor, { bigint: true });
      if (
        !sameIdentity(prepared.status, linkedStatus) ||
        ![1n, 2n].includes(linkedStatus.nlink)
      ) {
        throw new Error("immutable link changed");
      }
      const linkedBytes = readOwnerOnlyLeaf(
        name,
        request.maximumBytes,
        false,
        false,
        {
          expectedIdentity: prepared.status,
          expectedLinkCount: linkedStatus.nlink,
          expectedMode: prepared.status.mode,
        },
      );
      if (!linkedBytes.equals(bytes)) {
        throw new Error("immutable link mismatch");
      }
    }
    removePreparedDirectoryEntry(token, prepared);
    fsyncSync(DIRECTORY_DESCRIPTOR);
    const installed = recoverInterruptedImmutable(
      name,
      request.maximumBytes,
      bytes,
    );
    if (!installed.equals(bytes)) throw new Error("immutable mismatch");
    return { installed: linked };
  } finally {
    if (prepared !== null) {
      try {
        removePreparedDirectoryEntry(token, prepared);
      } catch {}
      closeSync(prepared.descriptor);
    } else {
      try {
        discardPrepared({ token });
      } catch {}
    }
  }
}

function ensurePrivateDirectory(request) {
  const name = validateLeafName(request.name);
  try {
    mkdirSync(name, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const before = lstatSync(name, { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !ownedByCurrentUser(before)
  ) {
    throw new Error("unsafe directory");
  }
  const descriptor = openSync(
    name,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isDirectory() ||
      !ownedByCurrentUser(opened) ||
      !sameIdentity(before, opened)
    ) {
      throw new Error("unsafe opened directory");
    }
    fchmodSync(descriptor, 0o700);
    fsyncSync(descriptor);
    const secured = fstatSync(descriptor, { bigint: true });
    if (
      !secured.isDirectory() ||
      !ownedByCurrentUser(secured) ||
      !sameIdentity(before, secured) ||
      (secured.mode & 0o077n) !== 0n
    ) {
      throw new Error("directory hardening failed");
    }
    const after = lstatSync(name, { bigint: true });
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !ownedByCurrentUser(after) ||
      !sameIdentity(before, after) ||
      (after.mode & 0o077n) !== 0n
    ) {
      throw new Error("directory path changed");
    }
    fsyncSync(DIRECTORY_DESCRIPTOR);
    return { dev: String(secured.dev), ino: String(secured.ino) };
  } finally {
    closeSync(descriptor);
  }
}

function removeOwnerOnlyLeaf(request) {
  const name = validateLeafName(request.name);
  const maximumBytes = validateMaximumBytes(request.maximumBytes);
  const existing = readOwnerOnlyLeaf(name, maximumBytes);
  if (existing === null) return { removed: false };
  unlinkSync(name);
  fsyncSync(DIRECTORY_DESCRIPTOR);
  return { removed: true };
}

function removeEmptyPrivateDirectory(request) {
  const name = validateLeafName(request.name);
  let before;
  try {
    before = lstatSync(name, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: false };
    throw error;
  }
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !ownedByCurrentUser(before) ||
    (before.mode & 0o077n) !== 0n
  ) {
    throw new Error("unsafe directory");
  }
  const descriptor = openSync(
    name,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isDirectory() ||
      !ownedByCurrentUser(opened) ||
      !sameIdentity(before, opened) ||
      (opened.mode & 0o077n) !== 0n
    ) {
      throw new Error("unsafe opened directory");
    }
  } finally {
    closeSync(descriptor);
  }
  rmdirSync(name);
  fsyncSync(DIRECTORY_DESCRIPTOR);
  return { removed: true };
}

function purgePrivateDirectory(request) {
  const markerName = validateLeafName(request.markerName);
  const markerBytes = decodeBoundedContent(
    request.markerContent,
    request.maximumBytes,
  );
  const storedMarker = readOwnerOnlyLeaf(
    markerName,
    request.maximumBytes,
    false,
  );
  if (!storedMarker.equals(markerBytes)) {
    throw new Error("owner marker changed");
  }
  for (const entry of readdirSync(".", { withFileTypes: true })) {
    validateDirectoryEntryName(entry.name);
    rmSync(entry.name, {
      recursive: entry.isDirectory() && !entry.isSymbolicLink(),
      force: false,
      maxRetries: 0,
    });
  }
  if (readdirSync(".").length !== 0) {
    throw new Error("directory cleanup incomplete");
  }
  fsyncSync(DIRECTORY_DESCRIPTOR);
  return { purged: true };
}

async function readInput() {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    totalBytes += chunk.length;
    if (totalBytes > MAXIMUM_INPUT_BYTES) throw new Error("input too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
}

try {
  const request = await readInput();
  if (
    !request ||
    typeof request !== "object" ||
    typeof request.anchorDev !== "string" ||
    typeof request.anchorIno !== "string" ||
    typeof request.operation !== "string"
  ) {
    throw new Error("invalid request");
  }
  assertAnchoredDirectory(request);
  let value;
  switch (request.operation) {
    case "read": {
      const bytes = readOwnerOnlyLeaf(request.name, request.maximumBytes);
      value = { content: bytes?.toString("base64") ?? null };
      break;
    }
    case "prepare-replace":
      value = prepareReplace(request);
      break;
    case "commit-replace":
      value = commitReplace(request);
      break;
    case "reconcile-replace":
      value = reconcileReplace(request);
      break;
    case "discard-prepared":
      value = discardPrepared(request);
      break;
    case "install-immutable":
      value = installImmutable(request);
      break;
    case "ensure-private-directory":
      value = ensurePrivateDirectory(request);
      break;
    case "remove-owner-only-leaf":
      value = removeOwnerOnlyLeaf(request);
      break;
    case "remove-empty-private-directory":
      value = removeEmptyPrivateDirectory(request);
      break;
    case "purge-private-directory":
      value = purgePrivateDirectory(request);
      break;
    default:
      throw new Error("unknown operation");
  }
  assertAnchoredDirectory(request);
  const output = JSON.stringify({ ok: true, ...value }) + "\n";
  if (Buffer.byteLength(output, "utf8") > MAXIMUM_OUTPUT_BYTES) {
    throw new Error("output too large");
  }
  process.stdout.write(output);
} catch {
  fail();
}
