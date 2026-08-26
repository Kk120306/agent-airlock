import type { KeyObject } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rename,
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

interface TransparencyLockOwner {
  pid: number;
  nonce: string;
  createdAt: string;
}

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
    const stats = await lstat(this.filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Local transparency log must be a regular file");
    }
    if (stats.size < 1 || stats.size > MAXIMUM_LOG_BYTES) {
      throw new Error("Local transparency log exceeds its byte boundary");
    }
    const source = await readFile(this.filePath, "utf8");
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
    const lockPath = `${path.resolve(this.filePath)}.lock`;
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    const owner: TransparencyLockOwner = {
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const ownerPath = `${lockPath}.${owner.nonce}.owner`;
    const ownerHandle = await open(ownerPath, "wx", 0o600);
    try {
      await ownerHandle.writeFile(canonicalize(owner), "utf8");
      await ownerHandle.sync();
    } finally {
      await ownerHandle.close();
    }
    let acquired = false;
    while (!acquired) {
      try {
        await link(ownerPath, lockPath);
        acquired = true;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          await unlink(ownerPath).catch(() => undefined);
          throw error;
        }
        try {
          if (await clearDeadStaleLock(lockPath)) continue;
        } catch (lockError) {
          if (isMissing(lockError)) continue;
          await unlink(ownerPath).catch(() => undefined);
          throw lockError;
        }
        if (Date.now() >= deadline) {
          await unlink(ownerPath).catch(() => undefined);
          throw new Error("Local transparency log lock timed out");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      return await operation();
    } finally {
      try {
        await unlinkOwnedLock(lockPath, owner.nonce);
      } finally {
        await unlink(ownerPath).catch(() => undefined);
      }
    }
  }
}

async function clearDeadStaleLock(lockPath: string): Promise<boolean> {
  const before = await lstat(lockPath);
  assertRegularBoundedLock(before);
  if (Date.now() - before.mtimeMs <= LOCK_STALE_MS) return false;
  const owner = await readLockOwner(lockPath);
  if (isProcessAlive(owner.pid)) return false;
  const after = await lstat(lockPath);
  assertRegularBoundedLock(after);
  const currentOwner = await readLockOwner(lockPath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    owner.nonce !== currentOwner.nonce
  ) {
    return false;
  }
  await unlink(lockPath);
  return true;
}

async function unlinkOwnedLock(lockPath: string, nonce: string): Promise<void> {
  try {
    const owner = await readLockOwner(lockPath);
    if (owner.nonce === nonce) await unlink(lockPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function readLockOwner(lockPath: string): Promise<TransparencyLockOwner> {
  const stats = await lstat(lockPath);
  assertRegularBoundedLock(stats);
  const parsed = asRecord(
    parseCanonicalJson(await readFile(lockPath, "utf8"), MAXIMUM_LOCK_BYTES),
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
  return parsed as unknown as TransparencyLockOwner;
}

function assertRegularBoundedLock(stats: Awaited<ReturnType<typeof lstat>>): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Local transparency lock must be a regular file");
  }
  if (stats.size < 1 || stats.size > MAXIMUM_LOCK_BYTES) {
    throw new Error("Local transparency lock exceeds its byte boundary");
  }
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
