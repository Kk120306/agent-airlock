import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultOutcomeContract } from "./outcome-contract.js";
import { SqliteResource } from "./sqlite-resource.js";
import type { Agent } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Phase 4 canonical migration", () => {
  it("adds the deterministic SQLite resource to a schema 2 Whole-Agent state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-workspace-v2-"));
    temporaryDirectories.push(root);
    const manager = new WorkspaceManager(root);
    await manager.initialize();
    const timestamp = "2026-08-25T00:00:00.000Z";
    const agent: Agent = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Migrated Agent",
      description: "",
      instructions: "",
      status: "ready",
      workspacePath: "",
      canonicalStateId: "",
      outcomeContract: createDefaultOutcomeContract(1, timestamp),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const created = await manager.create(agent);
    agent.workspacePath = created.workspacePath;
    agent.canonicalStateId = created.stateId;
    await rm(
      path.join(root, agent.id, ".canonical-history", created.stateId + ".json"),
      { force: true },
    );
    await rm(path.join(created.workspacePath, ".airlock"), {
      recursive: true,
      force: true,
    });
    const workspaceContentHash = await manager.contentHash(created.workspacePath);
    const contentHash =
      "sha256:" +
      createHash("sha256")
        .update(
          JSON.stringify({
            workspaceContentHash,
            sessionContentHash: created.sessionContentHash,
            codexThreadId: null,
          }),
        )
        .digest("hex");
    const manifestPath = path.join(root, agent.id, "canonical.json");
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 2,
          agentId: agent.id,
          stateId: created.stateId,
          workspacePath: created.workspacePath,
          codexHomePath: created.codexHomePath,
          codexThreadId: created.codexThreadId,
          workspaceContentHash,
          sessionContentHash: created.sessionContentHash,
          contentHash,
          createdAt: timestamp,
          sourceRunId: null,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const migrated = await manager.ensureCanonical(agent);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      schemaVersion: number;
      providerVersions: unknown[];
    };

    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.providerVersions).toEqual([]);
    const historicalManifest = JSON.parse(
      await readFile(
        path.join(
          root,
          agent.id,
          ".canonical-history",
          created.stateId + ".json",
        ),
        "utf8",
      ),
    ) as { schemaVersion: number };
    expect(historicalManifest.schemaVersion).toBe(4);
    expect((await new SqliteResource().inspect(migrated.workspacePath)).rowCount).toBe(1);
    await expect(manager.ensureCanonical(agent)).resolves.toEqual(migrated);
  });
});
