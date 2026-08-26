import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatePortableSigningKey } from "./crypto.js";
import { LocalTransparencyLog } from "./local-transparency-log.js";
import {
  verifySignedTransparencyCheckpoint,
  verifyTransparencyConsistency,
  verifyTransparencyInclusion,
} from "./transparency.js";
import type { ReceiptDigest } from "./types.js";

describe("durable local transparency log", () => {
  it("reopens an append-only chain and serves offline proofs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "airlock-log-"));
    const filePath = path.join(directory, "transparency.json");
    const key = generatePortableSigningKey();
    const log = new LocalTransparencyLog(filePath, key.privateKeyPem);
    await log.initialize();
    const first = await log.append(digest("first"), "2026-08-26T00:00:00.000Z");
    await log.append(digest("second"), "2026-08-26T00:00:01.000Z");
    const third = await log.append(digest("third"), "2026-08-26T00:00:02.000Z");

    const reopened = new LocalTransparencyLog(filePath, key.privateKeyPem);
    await reopened.initialize();
    const snapshot = reopened.snapshot();
    expect(snapshot.entries).toHaveLength(3);
    expect(verifySignedTransparencyCheckpoint(third.checkpoint).valid).toBe(true);
    expect(
      verifyTransparencyInclusion(
        reopened.inclusionProof(digest("second")),
        third.checkpoint.checkpoint,
      ),
    ).toBe(true);
    expect(
      verifyTransparencyConsistency({
        proof: reopened.consistencyProof(1),
        from: first.checkpoint,
        to: third.checkpoint,
      }),
    ).toBe(true);
  });

  it("fails closed when a persisted entry is changed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "airlock-log-tamper-"));
    const filePath = path.join(directory, "transparency.json");
    const key = generatePortableSigningKey();
    const log = new LocalTransparencyLog(filePath, key.privateKeyPem);
    await log.initialize();
    await log.append(digest("first"), "2026-08-26T00:00:00.000Z");
    const source = await readFile(filePath, "utf8");
    await writeFile(filePath, source.replace(digest("first"), digest("forged")));
    const reopened = new LocalTransparencyLog(filePath, key.privateKeyPem);
    await expect(reopened.initialize()).rejects.toThrow(/entry chain|checkpoint chain/);
  });

  it("rejects unknown uncommitted fields in persisted entries", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "airlock-log-fields-"));
    const filePath = path.join(directory, "transparency.json");
    const key = generatePortableSigningKey();
    const log = new LocalTransparencyLog(filePath, key.privateKeyPem);
    await log.initialize();
    await log.append(digest("first"), "2026-08-26T00:00:00.000Z");
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    parsed.entries[0]!.privateKey = "synthetic credential material";
    await writeFile(filePath, JSON.stringify(parsed));
    await expect(
      new LocalTransparencyLog(filePath, key.privateKeyPem).initialize(),
    ).rejects.toThrow(/unknown or missing fields/);
  });

  it("binds the complete log history to one authorized checkpoint key", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "airlock-log-key-"));
    const filePath = path.join(directory, "transparency.json");
    const original = generatePortableSigningKey();
    const replacement = generatePortableSigningKey();
    const log = new LocalTransparencyLog(filePath, original.privateKeyPem);
    await log.initialize();
    await log.append(digest("first"), "2026-08-26T00:00:00.000Z");
    await expect(
      new LocalTransparencyLog(filePath, replacement.privateKeyPem).initialize(),
    ).rejects.toThrow(/checkpoint chain/);
  });

  it("serializes concurrent appenders across process-local instances", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "airlock-log-race-"));
    const filePath = path.join(directory, "transparency.json");
    const key = generatePortableSigningKey();
    const first = new LocalTransparencyLog(filePath, key.privateKeyPem);
    const second = new LocalTransparencyLog(filePath, key.privateKeyPem);
    await Promise.all([first.initialize(), second.initialize()]);
    await Promise.all([
      first.append(digest("first"), "2026-08-26T00:00:00.000Z"),
      second.append(digest("second"), "2026-08-26T00:00:01.000Z"),
    ]);
    const reopened = new LocalTransparencyLog(filePath, key.privateKeyPem);
    await reopened.initialize();
    expect(
      reopened.snapshot().entries.map((entry) => entry.receiptDigest).sort(),
    ).toEqual([digest("first"), digest("second")].sort());
  });

  it("recovers an old lock only after its recorded process has exited", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "airlock-log-dead-lock-"));
    const filePath = path.join(directory, "transparency.json");
    const lockPath = `${filePath}.lock`;
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const exitedPid = child.pid!;
    await once(child, "exit");
    await writeFile(
      lockPath,
      JSON.stringify({
        createdAt: "2026-08-26T00:00:00.000Z",
        nonce: "00000000-0000-4000-8000-000000000000",
        pid: exitedPid,
      }),
      { mode: 0o600 },
    );
    await utimes(lockPath, new Date(0), new Date(0));
    const key = generatePortableSigningKey();
    const log = new LocalTransparencyLog(filePath, key.privateKeyPem);

    await log.initialize();
    await log.append(digest("after-recovery"));

    expect(log.snapshot().entries).toHaveLength(1);
  });

  it("elects one stale-lock reclaimer while concurrent contenders keep retrying", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "airlock-log-election-"));
    const filePath = path.join(directory, "transparency.json");
    const lockPath = `${filePath}.lock`;
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const exitedPid = child.pid!;
    await once(child, "exit");
    await writeFile(
      lockPath,
      JSON.stringify({
        createdAt: "2026-08-26T00:00:00.000Z",
        nonce: "00000000-0000-4000-8000-000000000000",
        pid: exitedPid,
      }),
      { mode: 0o600 },
    );
    await utimes(lockPath, new Date(0), new Date(0));
    const key = generatePortableSigningKey();
    const logs = Array.from(
      { length: 8 },
      () => new LocalTransparencyLog(filePath, key.privateKeyPem),
    );

    await Promise.all(logs.map((log) => log.initialize()));
    await Promise.all(
      logs.map((log, index) =>
        log.append(
          digest(`contender-${index}`),
          `2026-08-26T00:00:${String(index).padStart(2, "0")}.000Z`,
        ),
      ),
    );

    const reopened = new LocalTransparencyLog(filePath, key.privateKeyPem);
    await reopened.initialize();
    expect(reopened.snapshot().entries).toHaveLength(logs.length);
  });

  it("recovers when an earlier reclaimer was interrupted", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "airlock-log-dead-reclaimer-"),
    );
    const filePath = path.join(directory, "transparency.json");
    const lockPath = `${filePath}.lock`;
    const deadNonce = "00000000-0000-4000-8000-000000000001";
    const deadClaimPath = `${lockPath}.reclaim.${deadNonce}.claim`;
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const exitedPid = child.pid!;
    await once(child, "exit");
    const deadOwner = JSON.stringify({
      createdAt: "2026-08-26T00:00:00.000Z",
      nonce: "00000000-0000-4000-8000-000000000000",
      pid: exitedPid,
    });
    await writeFile(lockPath, deadOwner, { mode: 0o600 });
    await writeFile(
      deadClaimPath,
      JSON.stringify({
        createdAt: "2026-08-26T00:00:00.000Z",
        nonce: deadNonce,
        pid: exitedPid,
      }),
      { mode: 0o600 },
    );
    await writeFile(`${lockPath}.reclaim`, "interrupted legacy mutex", {
      mode: 0o600,
    });
    await Promise.all([
      utimes(lockPath, new Date(0), new Date(0)),
      utimes(deadClaimPath, new Date(0), new Date(0)),
    ]);

    const key = generatePortableSigningKey();
    const log = new LocalTransparencyLog(filePath, key.privateKeyPem);
    await log.initialize();
    await log.append(digest("after-reclaimer-recovery"));

    expect(log.snapshot().entries).toHaveLength(1);
  });
});

function digest(value: string): ReceiptDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
