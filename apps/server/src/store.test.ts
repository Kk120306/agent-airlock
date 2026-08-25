import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("migrates starter version 1 data to version 4", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-migration-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "agent-1",
            name: "Legacy",
            description: "",
            instructions: "",
            status: "ready",
            workspacePath: "/tmp/legacy",
            codexThreadId: null,
            lastError: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        messages: [],
        runs: [
          {
            id: "run-1",
            agentId: "agent-1",
            status: "completed",
            prompt: "hello",
            output: "done",
            error: null,
            usage: null,
            startedAt: "2026-01-01T00:00:01.000Z",
            completedAt: "2026-01-01T00:00:02.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }) + "\n",
    );
    const store = new JsonStore(filePath);

    await store.initialize();

    expect(store.snapshot()).toMatchObject({
      version: 4,
      agents: [
        {
          canonicalStateId: "",
          outcomeContract: { schemaVersion: 1, version: 2 },
        },
      ],
      runs: [{ transaction: null }],
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 4 });
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });

  it("migrates Phase 1 transactions without inventing historical evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-v2-migration-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        agents: [
          {
            id: "agent-2",
            name: "Phase One",
            description: "",
            instructions: "",
            status: "ready",
            workspacePath: "/tmp/phase-one",
            canonicalStateId: "state-1",
            codexThreadId: null,
            lastError: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        messages: [],
        runs: [
          {
            id: "run-2",
            agentId: "agent-2",
            status: "completed",
            prompt: "hello",
            output: "done",
            error: null,
            usage: null,
            transaction: {
              id: "run-2",
              status: "promoted",
              disposition: "promoted",
              candidateStateId: "state-2",
              canonicalStateIdBefore: "state-1",
              canonicalStateIdAfter: "state-2",
              canonicalContentHashBefore: "sha256:before",
              canonicalContentHashAfter: "sha256:after",
              outcomeContractVersion: 1,
              changes: null,
              validations: [
                {
                  name: "required-paths",
                  status: "passed",
                  summary: "present",
                  durationMs: 1,
                  output: null,
                },
              ],
              events: [],
              quarantinePath: null,
            },
            startedAt: "2026-01-02T00:00:01.000Z",
            completedAt: "2026-01-02T00:00:02.000Z",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      }) + "\n",
    );

    const store = new JsonStore(filePath);
    await store.initialize();

    expect(store.snapshot()).toMatchObject({
      version: 4,
      agents: [
        {
          outcomeContract: {
            schemaVersion: 1,
            version: 2,
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        },
      ],
      runs: [
        {
          transaction: {
            outcomeContract: { version: 1, requiredPaths: ["AGENTS.md"] },
            promotionReceipt: null,
            resources: [],
            validations: [{ required: true }],
          },
        },
      ],
    });
  });

  it("migrates Phase 2 data without inventing Whole-Agent evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-v3-migration-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 3,
        agents: [],
        messages: [],
        runs: [
          {
            id: "phase-2-run",
            transaction: {
              id: "phase-2-run",
              disposition: "promoted",
              validations: [{ name: "required-paths", status: "passed" }],
            },
          },
        ],
      }) + "\n",
    );

    const store = new JsonStore(filePath);
    await store.initialize();

    expect(store.snapshot()).toMatchObject({
      version: 4,
      runs: [{ transaction: { id: "phase-2-run", resources: [] } }],
    });
  });
});
