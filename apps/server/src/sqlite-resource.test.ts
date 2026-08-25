import {
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteResource } from "./sqlite-resource.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SQLite transactional resource", () => {
  it("seeds and snapshots the allowlisted inventory schema deterministically", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "airlock-sqlite-"));
    temporaryDirectories.push(workspace);
    const resource = new SqliteResource();

    await resource.seed(workspace);
    const first = await resource.inspect(workspace);
    const second = await resource.inspect(workspace);

    expect(first).toEqual(second);
    expect(first.rows).toEqual([
      {
        id: "demo",
        value: "ready",
        updatedAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("accepts a bounded inventory update and rejects schema expansion", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "airlock-sqlite-"));
    temporaryDirectories.push(workspace);
    const resource = new SqliteResource();
    await resource.seed(workspace);
    const database = new DatabaseSync(resource.pathFor(workspace));
    database
      .prepare("UPDATE inventory SET value = ?, updated_at = ? WHERE id = ?")
      .run("shipped", "2026-08-25T00:00:00.000Z", "demo");
    database.close();
    expect((await resource.validate(workspace)).evidence.status).toBe("passed");
    expect(
      (
        await resource.validate(workspace, [
          { name: "release-state", pattern: "shipped" },
        ])
      ).evidence.summary,
    ).toContain("release-state");

    const expanded = new DatabaseSync(resource.pathFor(workspace));
    expanded.exec("CREATE TABLE unapproved (id TEXT)");
    expanded.close();
    const invalid = await resource.validate(workspace);
    expect(invalid.evidence).toMatchObject({
      status: "failed",
      required: true,
    });
    expect(invalid.evidence.summary).toContain("allowlist");
  });

  it("rejects a symbolic-link database", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "airlock-sqlite-"));
    const external = await mkdtemp(path.join(tmpdir(), "airlock-sqlite-external-"));
    temporaryDirectories.push(workspace, external);
    const resource = new SqliteResource();
    await resource.seed(external);
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.join(workspace, ".airlock"), { recursive: true }),
    );
    await symlink(resource.pathFor(external), resource.pathFor(workspace));

    expect((await resource.validate(workspace)).evidence.status).toBe("failed");
  });

  it("rejects malformed and oversized database files", async () => {
    const malformed = await mkdtemp(path.join(tmpdir(), "airlock-sqlite-bad-"));
    const oversized = await mkdtemp(path.join(tmpdir(), "airlock-sqlite-large-"));
    temporaryDirectories.push(malformed, oversized);
    const resource = new SqliteResource();
    await resource.seed(malformed);
    await writeFile(resource.pathFor(malformed), "not a sqlite database", "utf8");
    expect((await resource.validate(malformed)).evidence.status).toBe("failed");

    await resource.seed(oversized);
    await truncate(resource.pathFor(oversized), 8 * 1024 * 1024 + 1);
    expect((await resource.validate(oversized)).evidence.summary).toContain(
      "8 MiB",
    );
  });
});
