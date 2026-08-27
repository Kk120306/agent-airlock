import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fingerprint,
  HttpObjectResourceProvider,
  versionReference,
} from "@agent-airlock/http-object-resource";
import type { JsonValue } from "@agent-airlock/transactional-resource-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { ResourceCoordinator } from "./resource-coordinator.js";
import { ResourceRegistry } from "./resource-registry.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { persistFixtureSession } from "../test/session-fixture.js";

const temporaryDirectories: string[] = [];
const fetchRestorations: Array<() => void> = [];

afterEach(async () => {
  fetchRestorations.splice(0).reverse().forEach((restore) => restore());
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Phase 8 HTTP object provider acceptance", () => {
  it("promotes and rejects a remote object under the same Run disposition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-http-acceptance-"));
    temporaryDirectories.push(root);
    const remote = new RemoteObjectFixture();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = remote.fetch;
    fetchRestorations.push(() => {
      if (globalThis.fetch === remote.fetch) globalThis.fetch = previousFetch;
    });
    const provider = new HttpObjectResourceProvider({
      baseUrl: "http://fixture.invalid",
    });
    const coordinator = new ResourceCoordinator(
      new ResourceRegistry([
        { provider, initialVersion: remote.initialVersion },
      ]),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const workspaces = new WorkspaceManager(
      config.workspaceRoot,
      undefined,
      undefined,
      coordinator.initialVersions(),
    );
    let turn = 0;
    const runner: AgentRunner = {
      run: async (request) => {
        const binding = request.resourceBindings?.find(
          (item) => item.providerId === "http-object",
        );
        if (!binding) throw new Error("HTTP provider binding was not exposed");
        expect(binding.runtimePath).toBe(
          "/airlock/resources/http-object/object.json",
        );
        if (turn === 0) {
          await writeFile(binding.hostPath, '{"release":"remote-accepted"}\n', "utf8");
          await writeFile(path.join(request.workspacePath, "accepted.txt"), "accepted\n");
        } else {
          await writeFile(binding.hostPath, '{"release":"remote-rejected"}\n', "utf8");
          await unlink(path.join(request.workspacePath, "AGENTS.md"));
        }
        await persistFixtureSession(request, "thread-http-object", "turn-" + turn);
        turn += 1;
        return {
          output: "remote fixture turn " + turn,
          threadId: "thread-http-object",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      workspaces,
      runner,
      undefined,
      undefined,
      coordinator,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "HTTP object acceptance" });

    const promoted = await service.sendMessage(agent.id, "promote remote object");
    const promotedRun = await waitForRun(service, promoted.run.id);
    const canonicalAfterPromotion = await workspaces.readCanonical(agent.id);
    expect(promotedRun.transaction).toMatchObject({
      disposition: "promoted",
      providerResources: [
        {
          providerId: "http-object",
          disposition: "promoted",
          installedVersion: {
            versionId: canonicalAfterPromotion.providerVersions[0]?.versionId,
          },
        },
      ],
    });
    expect(remote.stats()).toEqual({
      versions: 2,
      candidates: 1,
      quarantines: 0,
      idempotencyKeys: 1,
    });
    await expect(
      provider.readVersion(canonicalAfterPromotion.providerVersions[0]!),
    ).resolves.toEqual({ release: "remote-accepted" });

    const rejected = await service.sendMessage(agent.id, "reject remote object");
    const rejectedRun = await waitForRun(service, rejected.run.id);
    expect(rejectedRun.transaction).toMatchObject({
      disposition: "quarantined",
      providerResources: [
        {
          providerId: "http-object",
          disposition: "quarantined",
          quarantine: { runId: rejected.run.id },
        },
      ],
    });
    expect(remote.stats()).toMatchObject({ versions: 2, quarantines: 1 });
    await expect(workspaces.readCanonical(agent.id)).resolves.toEqual(
      canonicalAfterPromotion,
    );

    const discarded = await service.discardRun(rejected.run.id);
    expect(discarded.transaction).toMatchObject({
      disposition: "discarded",
      providerResources: [{ disposition: "discarded" }],
    });
    expect(remote.stats()).toMatchObject({ versions: 2, quarantines: 0 });
    await expect(workspaces.readCanonical(agent.id)).resolves.toEqual(
      canonicalAfterPromotion,
    );
  });
});

interface StoredObject {
  id: string;
  fingerprint: string;
  value: JsonValue;
}

class RemoteObjectFixture {
  readonly initialVersion = versionReference(
    "version-source",
    fingerprint({ release: "remote-canonical" }),
  );
  readonly fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname.startsWith("/v1/versions/")) {
      return found(this.versions.get(decodeURIComponent(url.pathname.slice(13))) ?? null);
    }
    if (method === "GET" && url.pathname.startsWith("/v1/candidates/")) {
      return found(this.candidates.get(decodeURIComponent(url.pathname.slice(15))) ?? null);
    }
    if (method === "GET" && url.pathname.startsWith("/v1/quarantines/")) {
      return found(this.quarantines.get(decodeURIComponent(url.pathname.slice(16))) ?? null);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (method === "POST" && url.pathname === "/v1/candidates") {
      const candidateId = "candidate-" + String(body.runId);
      const value = body.value as JsonValue;
      const candidateFingerprint = fingerprint(value);
      this.candidates.set(candidateId, {
        id: candidateId,
        fingerprint: candidateFingerprint,
        value,
      });
      return json({ schemaVersion: 1, candidateId, fingerprint: candidateFingerprint });
    }
    if (method === "PUT" && url.pathname.startsWith("/v1/versions/")) {
      const versionId = decodeURIComponent(url.pathname.slice(13));
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      const replay = this.idempotency.get(key);
      if (replay) {
        const installed = this.versions.get(replay)!;
        return json({
          schemaVersion: 1,
          version: versionReference(installed.id, installed.fingerprint),
        });
      }
      const value = body.value as JsonValue;
      const targetFingerprint = String(body.targetFingerprint);
      if (fingerprint(value) !== targetFingerprint) {
        return json({ error: "fingerprint contradiction" }, 409);
      }
      this.versions.set(versionId, {
        id: versionId,
        fingerprint: targetFingerprint,
        value,
      });
      this.idempotency.set(key, versionId);
      return json({
        schemaVersion: 1,
        version: versionReference(versionId, targetFingerprint),
      });
    }
    if (method === "PUT" && url.pathname.startsWith("/v1/quarantines/")) {
      const quarantineId = decodeURIComponent(url.pathname.slice(16));
      const value = body.value as JsonValue;
      const candidateFingerprint = String(body.candidateFingerprint);
      this.quarantines.set(quarantineId, {
        id: quarantineId,
        fingerprint: candidateFingerprint,
        value,
      });
      return json({
        schemaVersion: 1,
        quarantineId,
        fingerprint: candidateFingerprint,
      });
    }
    if (method === "PUT" && url.pathname.startsWith("/v1/discards/")) {
      const runId = decodeURIComponent(url.pathname.slice(13));
      const alreadyDiscarded = this.discarded.has(runId);
      if (typeof body.candidateId === "string") this.candidates.delete(body.candidateId);
      if (typeof body.quarantineId === "string") {
        this.quarantines.delete(body.quarantineId);
      }
      this.discarded.add(runId);
      return json({
        schemaVersion: 1,
        discarded: true,
        alreadyDiscarded,
        evidenceRetained: true,
      });
    }
    return json({ error: "not found" }, 404);
  };

  private readonly versions = new Map<string, StoredObject>([
    [
      this.initialVersion.versionId,
      {
        id: this.initialVersion.versionId,
        fingerprint: this.initialVersion.fingerprint,
        value: { release: "remote-canonical" },
      },
    ],
  ]);
  private readonly candidates = new Map<string, StoredObject>();
  private readonly quarantines = new Map<string, StoredObject>();
  private readonly idempotency = new Map<string, string>();
  private readonly discarded = new Set<string>();

  stats() {
    return {
      versions: this.versions.size,
      candidates: this.candidates.size,
      quarantines: this.quarantines.size,
      idempotencyKeys: this.idempotency.size,
    };
  }
}

function found(record: StoredObject | null): Response {
  return json({ schemaVersion: 1, found: record !== null, record });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitForRun(service: AgentService, runId: string) {
  await expect
    .poll(() => service.getRun(runId).status, { timeout: 3_000 })
    .toMatch(/^(completed|failed|cancelled)$/);
  return service.getRun(runId);
}
