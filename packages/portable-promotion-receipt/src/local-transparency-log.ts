import type { KeyObject } from "node:crypto";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { canonicalize, parseCanonicalJson } from "./canonical.js";
import type {
  PortableTransparencyLogFile,
  ReceiptDigest,
  SignedTransparencyCheckpoint,
  TransparencyConsistencyProof,
  TransparencyInclusionProof,
} from "./types.js";
import {
  createSignedTransparencyCheckpoint,
  createTransparencyConsistencyProof,
  createTransparencyEntry,
  createTransparencyInclusionProof,
  assertTransparencyEntry,
  TransparencyRootAccumulator,
  verifySignedTransparencyCheckpoint,
  verifyTransparencyEntries,
} from "./transparency.js";
import { signCheckpointDigest, sha256Digest } from "./crypto.js";
import { isDigest } from "./validation.js";

const MAXIMUM_LOG_BYTES = 32 * 1024 * 1024;
const MAXIMUM_LOG_ENTRIES = 100_000;
const MAXIMUM_LOCK_BYTES = 1_024;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const MAXIMUM_LOCK_TURNS = 200_000;
const LOCK_TURN_PATTERN = /^turn-([0-9]{12})$/u;
const LOCK_TURN_TEMPORARY_PATTERN =
  /^\.turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const LOCK_TURN_COMPLETION_TEMPORARY_PATTERN =
  /^\.completion-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const LOCK_TURN_COMPLETION_NAME = "completion.json";

interface TransparencyLockOwner {
  pid: number;
  nonce: string;
  createdAt: string;
}

interface TransparencyLockTurn {
  sequence: number;
  path: string;
  owner: TransparencyLockOwner;
}

class ConcurrentLockReadError extends Error {}

export class LocalTransparencyLog {
  private data: PortableTransparencyLogFile | null = null;

  constructor(
    private readonly filePath: string,
    private readonly privateKey: KeyObject | string | Buffer,
  ) {}

  async initialize(): Promise<void> {
    await this.withFileLock(async () => {
      try {
        this.data = await this.readStrict();
      } catch (error) {
        if (!isMissing(error)) throw error;
        await this.persist(createEmptyLog());
        this.data = await this.readStrict();
      }
    });
  }

  snapshot(): PortableTransparencyLogFile {
    if (!this.data) throw new Error("Local transparency log is not initialized");
    return structuredClone(this.data);
  }

  async append(
    receiptDigest: ReceiptDigest,
    appendedAt = new Date().toISOString(),
  ): Promise<{
    checkpoint: SignedTransparencyCheckpoint;
    inclusionProof: TransparencyInclusionProof;
  }> {
    if (!this.data) throw new Error("Local transparency log is not initialized");
    if (!isDigest(receiptDigest)) throw new Error("Receipt digest is invalid");
    return this.withFileLock(async () => {
      this.data = await this.readStrict();
      const existingIndex = this.data.entries.findIndex(
        (entry) => entry.receiptDigest === receiptDigest,
      );
      if (existingIndex >= 0) {
        return {
          checkpoint: structuredClone(this.data.checkpoints.at(-1)!),
          inclusionProof: createTransparencyInclusionProof(
            this.data.entries.map((entry) => entry.receiptDigest),
            existingIndex,
          ),
        };
      }
      if (this.data.entries.length >= MAXIMUM_LOG_ENTRIES) {
        throw new Error("Local transparency log reached its entry boundary");
      }
      const previousEntry = this.data.entries.at(-1) ?? null;
      const entry = createTransparencyEntry({
        receiptDigest,
        sequence: this.data.entries.length,
        priorEntryHash: previousEntry?.entryHash ?? null,
        appendedAt,
      });
      const receiptDigests = [
        ...this.data.entries.map((item) => item.receiptDigest),
        receiptDigest,
      ];
      const previousCheckpoint = this.data.checkpoints.at(-1) ?? null;
      const checkpoint = createSignedTransparencyCheckpoint({
        receiptDigests,
        priorCheckpointDigest: previousCheckpoint?.checkpointDigest ?? null,
        createdAt: appendedAt,
        privateKey: this.privateKey,
      });
      const next: PortableTransparencyLogFile = {
        ...this.data,
        entries: [...this.data.entries, entry],
        checkpoints: [...this.data.checkpoints, checkpoint],
      };
      assertPortableTransparencyLog(next, this.checkpointKeyId());
      await this.persist(next);
      this.data = next;
      return {
        checkpoint: structuredClone(checkpoint),
        inclusionProof: createTransparencyInclusionProof(
          receiptDigests,
          receiptDigests.length - 1,
        ),
      };
    });
  }

  inclusionProof(receiptDigest: ReceiptDigest): TransparencyInclusionProof {
    if (!this.data) throw new Error("Local transparency log is not initialized");
    const digests = this.data.entries.map((entry) => entry.receiptDigest);
    const index = digests.indexOf(receiptDigest);
    if (index < 0) throw new Error("Receipt digest is not in the local transparency log");
    return createTransparencyInclusionProof(digests, index);
  }

  consistencyProof(fromSize: number): TransparencyConsistencyProof {
    if (!this.data) throw new Error("Local transparency log is not initialized");
    return createTransparencyConsistencyProof(
      this.data.entries.map((entry) => entry.receiptDigest),
      fromSize,
    );
  }

  private async readStrict(): Promise<PortableTransparencyLogFile> {
    const { source } = await readBoundedRegularFile(
      this.filePath,
      MAXIMUM_LOG_BYTES,
      "Local transparency log",
    );
    const parsed = parseCanonicalJson(source, MAXIMUM_LOG_BYTES);
    assertPortableTransparencyLog(parsed, this.checkpointKeyId());
    return parsed;
  }

  private async persist(data: PortableTransparencyLogFile): Promise<void> {
    const serialized = `${canonicalize(data)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_LOG_BYTES) {
      throw new Error("Local transparency log exceeds its byte boundary");
    }
    const destination = path.resolve(this.filePath);
    const directory = path.dirname(destination);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      directory,
      `.${path.basename(destination)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      await rename(temporary, destination);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private checkpointKeyId(): ReceiptDigest {
    return signCheckpointDigest(
      sha256Digest(Buffer.from("checkpoint-key-identity", "utf8")),
      this.privateKey,
    ).keyId;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const legacyLockPath = `${path.resolve(this.filePath)}.lock`;
    const queuePath = `${legacyLockPath}-queue`;
    await mkdir(path.dirname(queuePath), { recursive: true, mode: 0o700 });
    await mkdir(queuePath, { recursive: true, mode: 0o700 });
    await assertRegularDirectory(queuePath, "Local transparency lock queue");
    const deadline = Date.now() + LOCK_WAIT_MS;
    const owner: TransparencyLockOwner = {
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const turn = await allocateLockTurn(queuePath, owner);
    try {
      await waitForLockTurn(queuePath, turn, deadline);
      await waitForLegacyLock(legacyLockPath, deadline);
      return await operation();
    } finally {
      await finishLockTurn(turn, "released");
    }
  }
}

async function allocateLockTurn(
  queuePath: string,
  owner: TransparencyLockOwner,
): Promise<TransparencyLockTurn> {
  while (true) {
    const turns = await listLockTurns(queuePath);
    const sequence = (turns.at(-1)?.sequence ?? 0) + 1;
    if (sequence > MAXIMUM_LOCK_TURNS) {
      throw new Error("Local transparency lock queue reached its turn boundary");
    }
    const name = `turn-${String(sequence).padStart(12, "0")}`;
    const target = path.join(queuePath, name);
    const temporary = path.join(queuePath, `.turn-${owner.nonce}.tmp`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      const handle = await open(path.join(temporary, "owner.json"), "wx", 0o600);
      try {
        await handle.writeFile(canonicalize(owner), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(temporary);
      try {
        await rename(temporary, target);
      } catch (error) {
        if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOTEMPTY")) {
          throw error;
        }
        await removeTemporaryTurn(temporary);
        continue;
      }
      await syncDirectory(queuePath);
      return { sequence, path: target, owner };
    } catch (error) {
      await removeTemporaryTurn(temporary);
      throw error;
    }
  }
}

async function waitForLockTurn(
  queuePath: string,
  turn: TransparencyLockTurn,
  deadline: number,
): Promise<void> {
  while (true) {
    let blocked = false;
    for (const predecessor of await listLockTurns(queuePath)) {
      if (predecessor.sequence >= turn.sequence) break;
      try {
        if (await lockTurnFinished(predecessor.path)) continue;
      } catch (error) {
        if (!(error instanceof ConcurrentLockReadError)) throw error;
        blocked = true;
        break;
      }
      const snapshot = await readLockOwnerSnapshot(
        path.join(predecessor.path, "owner.json"),
      );
      if (
        Date.now() - snapshot.stats.mtimeMs > LOCK_STALE_MS &&
        !isProcessAlive(snapshot.owner.pid)
      ) {
        await finishLockTurn(
          {
            ...predecessor,
            owner: snapshot.owner,
          },
          "abandoned",
        );
        continue;
      }
      blocked = true;
      break;
    }
    if (!blocked) return;
    if (Date.now() >= deadline) {
      throw new Error("Local transparency log lock timed out");
    }
    await delay(20);
  }
}

async function listLockTurns(
  queuePath: string,
): Promise<Array<{ sequence: number; path: string }>> {
  const entries = await readdir(queuePath, { withFileTypes: true });
  const turns: Array<{ sequence: number; path: string }> = [];
  for (const entry of entries) {
    if (
      LOCK_TURN_TEMPORARY_PATTERN.test(entry.name) &&
      entry.isDirectory() &&
      !entry.isSymbolicLink()
    ) {
      continue;
    }
    const match = entry.name.match(LOCK_TURN_PATTERN);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Local transparency lock queue contains an unsafe entry");
    }
    turns.push({
      sequence: Number(match[1]),
      path: path.join(queuePath, entry.name),
    });
  }
  if (turns.length > MAXIMUM_LOCK_TURNS) {
    throw new Error("Local transparency lock queue exceeds its turn boundary");
  }
  turns.sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index]!.sequence !== index + 1) {
      throw new Error("Local transparency lock queue has a missing turn");
    }
  }
  return turns;
}

async function lockTurnFinished(turnPath: string): Promise<boolean> {
  const entries = await readdir(turnPath, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name !== "owner.json" &&
      entry.name !== LOCK_TURN_COMPLETION_NAME &&
      !LOCK_TURN_COMPLETION_TEMPORARY_PATTERN.test(entry.name)
    ) {
      throw new Error("Local transparency lock turn contains an unsafe entry");
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Local transparency lock turn entry is unsafe");
    }
  }
  if (!entries.some((entry) => entry.name === "owner.json")) {
    throw new Error("Local transparency lock turn owner is missing");
  }
  const completion = entries.find(
    (entry) => entry.name === LOCK_TURN_COMPLETION_NAME,
  );
  if (!completion) return false;
  const owner = await readLockOwnerSnapshot(path.join(turnPath, "owner.json"));
  await readLockTurnCompletion(
    path.join(turnPath, LOCK_TURN_COMPLETION_NAME),
    owner.owner.nonce,
  );
  return true;
}

async function finishLockTurn(
  turn: TransparencyLockTurn,
  disposition: "released" | "abandoned",
): Promise<void> {
  const target = path.join(turn.path, LOCK_TURN_COMPLETION_NAME);
  const temporary = path.join(
    turn.path,
    `.completion-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(
      canonicalize({
        schemaVersion: 1,
        disposition,
        ownerNonce: turn.owner.nonce,
        completedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
    await syncDirectory(turn.path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (hasCode(error, "EEXIST")) {
      const completed = await readLockTurnCompletion(
        target,
        turn.owner.nonce,
      );
      if (completed.disposition !== disposition) {
        throw new Error(
          "Local transparency lock turn completion is contradictory",
        );
      }
      return;
    }
    throw error;
  } finally {
    await unlink(temporary).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function readLockTurnCompletion(
  completionPath: string,
  expectedOwnerNonce: string,
): Promise<{ disposition: "released" | "abandoned" }> {
  const { source } = await readBoundedRegularFile(
    completionPath,
    MAXIMUM_LOCK_BYTES,
    "Local transparency lock turn completion",
  );
  const parsed = asRecord(
    parseCanonicalJson(source, MAXIMUM_LOCK_BYTES),
    "Local transparency lock turn completion",
  );
  assertExactKeys(
    parsed,
    ["schemaVersion", "disposition", "ownerNonce", "completedAt"],
    "Local transparency lock turn completion",
  );
  if (
    parsed.schemaVersion !== 1 ||
    (parsed.disposition !== "released" && parsed.disposition !== "abandoned") ||
    parsed.ownerNonce !== expectedOwnerNonce ||
    typeof parsed.completedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.completedAt))
  ) {
    throw new Error("Local transparency lock turn completion is invalid");
  }
  return { disposition: parsed.disposition };
}

async function waitForLegacyLock(
  lockPath: string,
  deadline: number,
): Promise<void> {
  while (true) {
    let snapshot: Awaited<ReturnType<typeof readLockOwnerSnapshot>>;
    try {
      snapshot = await readLockOwnerSnapshot(lockPath);
    } catch (error) {
      if (isMissing(error)) return;
      if (error instanceof ConcurrentLockReadError) {
        if (Date.now() >= deadline) {
          throw new Error("Local transparency log lock timed out");
        }
        await delay(20);
        continue;
      }
      throw error;
    }
    if (
      Date.now() - snapshot.stats.mtimeMs > LOCK_STALE_MS &&
      !isProcessAlive(snapshot.owner.pid)
    ) {
      try {
        await unlink(lockPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Local transparency log lock timed out");
    }
    await delay(20);
  }
}

async function removeTemporaryTurn(temporary: string): Promise<void> {
  await unlink(path.join(temporary, "owner.json")).catch((error) => {
    if (!isMissing(error)) throw error;
  });
  await rmdir(temporary).catch((error) => {
    if (!isMissing(error)) throw error;
  });
}

async function assertRegularDirectory(
  directory: string,
  label: string,
): Promise<void> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory`);
  }
}

async function readLockOwnerSnapshot(lockPath: string): Promise<{
  owner: TransparencyLockOwner;
  stats: Stats;
}> {
  const { source, stats } = await readBoundedRegularFile(
    lockPath,
    MAXIMUM_LOCK_BYTES,
    "Local transparency lock",
  );
  const parsed = asRecord(
    parseCanonicalJson(source, MAXIMUM_LOCK_BYTES),
    "Local transparency lock",
  );
  assertExactKeys(
    parsed,
    ["pid", "nonce", "createdAt"],
    "Local transparency lock",
  );
  if (
    !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    typeof parsed.nonce !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      parsed.nonce,
    ) ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt))
  ) {
    throw new Error("Local transparency lock owner is invalid");
  }
  return {
    owner: parsed as unknown as TransparencyLockOwner,
    stats,
  };
}

async function readBoundedRegularFile(
  filePath: string,
  maximumBytes: number,
  label: string,
): Promise<{
  source: string;
  stats: Stats;
}> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ELOOP")) {
      throw new Error(`${label} must be a regular file`);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size < 1 || before.size > maximumBytes) {
      throw new Error(`${label} exceeds its byte boundary`);
    }
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new ConcurrentLockReadError(`${label} changed while it was being read`);
    }
    return {
      source: buffer.subarray(0, offset).toString("utf8"),
      stats: before,
    };
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

export function assertPortableTransparencyLog(
  value: unknown,
  expectedCheckpointKeyId?: ReceiptDigest,
): asserts value is PortableTransparencyLogFile {
  const log = asRecord(value, "Local transparency log");
  assertExactKeys(
    log,
    ["schema", "schemaVersion", "entries", "checkpoints"],
    "Local transparency log",
  );
  if (
    log.schema !== "agent-airlock/local-transparency-log" ||
    log.schemaVersion !== 1 ||
    !Array.isArray(log.entries) ||
    log.entries.length > MAXIMUM_LOG_ENTRIES ||
    !Array.isArray(log.checkpoints) ||
    log.checkpoints.length !== log.entries.length
  ) {
    throw new Error("Local transparency log identity or entry chain is invalid");
  }
  const entries = log.entries as PortableTransparencyLogFile["entries"];
  entries.forEach(assertTransparencyEntry);
  if (!verifyTransparencyEntries(entries)) {
    throw new Error("Local transparency log entry chain is invalid");
  }
  const checkpoints = log.checkpoints as unknown[];
  const accumulator = new TransparencyRootAccumulator();
  let priorCheckpointDigest: ReceiptDigest | null = null;
  for (let index = 0; index < checkpoints.length; index += 1) {
    assertTransparencyEntry(entries[index]);
    const checkpoint = checkpoints[index] as SignedTransparencyCheckpoint;
    const verification = verifySignedTransparencyCheckpoint(checkpoint);
    const expectedRoot = accumulator.append(entries[index]!.receiptDigest);
    if (
      !verification.valid ||
      (expectedCheckpointKeyId !== undefined &&
        checkpoint.checkpoint.keyId !== expectedCheckpointKeyId) ||
      checkpoint.checkpoint.treeSize !== index + 1 ||
      checkpoint.checkpoint.root !== expectedRoot ||
      checkpoint.checkpoint.priorCheckpointDigest !== priorCheckpointDigest
    ) {
      throw new Error("Local transparency checkpoint chain is invalid");
    }
    priorCheckpointDigest = checkpoint.checkpointDigest;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function createEmptyLog(): PortableTransparencyLogFile {
  return {
    schema: "agent-airlock/local-transparency-log",
    schemaVersion: 1,
    entries: [],
    checkpoints: [],
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${name} contains unknown or missing fields`);
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
