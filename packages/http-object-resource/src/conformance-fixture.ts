import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  JsonValue,
  ResourceConformanceFixture,
} from "@agent-airlock/transactional-resource-sdk";
import {
  fingerprint,
  HttpObjectResourceProvider,
  stableJson,
  versionReference,
} from "./provider.js";

interface StoredObject {
  id: string;
  fingerprint: string;
  value: JsonValue;
  runId?: string;
}

export async function createConformanceFixture(): Promise<ResourceConformanceFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-http-conformance-"));
  const transport = new InMemoryHttpObjectTransport();
  const candidateResourcePath = path.join(root, "candidate");
  let repairCandidatePath: string | null = null;
  await mkdir(candidateResourcePath, { recursive: true });
  const createProvider = () =>
    new HttpObjectResourceProvider({
      baseUrl: "http://conformance.invalid",
      fetcher: transport.fetch,
    });
  const provider = createProvider();
  const context = {
    schemaVersion: 1 as const,
    agentId: "conformance-agent",
    runId: "conformance-run",
    candidateStateId: "conformance-state",
    candidateResourcePath,
    source: transport.initialVersion,
    repairSource: null,
  };
  let disposed = false;
  return {
    provider,
    context,
    async mutateCandidate(_candidate, value) {
      await writeFile(
        path.join(candidateResourcePath, "object.json"),
        stableJson(value) + "\n",
        "utf8",
      );
    },
    readVersion: (reference) => provider.readVersion(reference),
    async readCandidate(candidate) {
      const selectedPath = candidate.candidateId.endsWith("-repair")
        ? repairCandidatePath
        : candidateResourcePath;
      if (!selectedPath) throw new Error("repair Candidate path is unavailable");
      return JSON.parse(
        await readFile(path.join(selectedPath, "object.json"), "utf8"),
      ) as JsonValue;
    },
    candidateExists: (candidate) => provider.candidateExists(candidate.candidateId),
    quarantineExists: (quarantine) =>
      provider.quarantineExists(quarantine.quarantineId),
    async mutableStateExistsForRun(runId) {
      return transport.hasMutableStateForRun(runId);
    },
    async createRepairContext(quarantine) {
      const repairPath = path.join(root, "repair-candidate");
      await mkdir(repairPath, { recursive: true });
      repairCandidatePath = repairPath;
      return {
        schemaVersion: 1,
        agentId: "conformance-agent",
        runId: "conformance-run-repair",
        candidateStateId: "conformance-state-repair",
        candidateResourcePath: repairPath,
        source: transport.initialVersion,
        repairSource: quarantine,
      };
    },
    restartProvider: async () => createProvider(),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      transport.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

class InMemoryHttpObjectTransport {
  readonly initialVersion = versionReference(
    "version-source",
    fingerprint({ release: "canonical" }),
  );

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (this.closed) throw new TypeError("conformance transport is closed");
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
      return found(
        this.quarantines.get(decodeURIComponent(url.pathname.slice(16))) ?? null,
      );
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (method === "POST" && url.pathname === "/v1/candidates") {
      const runId = String(body.runId);
      const sourceVersionId = String(body.sourceVersionId);
      const sourceFingerprint = String(body.sourceFingerprint);
      const source = this.versions.get(sourceVersionId);
      if (!source || source.fingerprint !== sourceFingerprint) {
        return json({ error: "source mismatch" }, 409);
      }
      const candidateId = "candidate-" + runId;
      const value = body.value as JsonValue;
      const candidateFingerprint = fingerprint(value);
      this.candidates.set(candidateId, {
        id: candidateId,
        runId,
        fingerprint: candidateFingerprint,
        value,
      });
      return json({
        schemaVersion: 1,
        candidateId,
        fingerprint: candidateFingerprint,
      });
    }
    if (method === "PUT" && url.pathname.startsWith("/v1/versions/")) {
      const targetVersionId = decodeURIComponent(url.pathname.slice(13));
      const idempotencyKey = new Headers(init?.headers).get("idempotency-key") ?? "";
      const replayTarget = this.idempotency.get(idempotencyKey);
      if (replayTarget) {
        const replay = this.versions.get(replayTarget);
        return replay
          ? json({
              schemaVersion: 1,
              version: versionReference(replay.id, replay.fingerprint),
            })
          : json({ error: "idempotency contradiction" }, 409);
      }
      const value = body.value as JsonValue;
      const targetFingerprint = String(body.targetFingerprint);
      if (fingerprint(value) !== targetFingerprint) {
        return json({ error: "promotion contradiction" }, 409);
      }
      this.versions.set(targetVersionId, {
        id: targetVersionId,
        fingerprint: targetFingerprint,
        value,
      });
      this.idempotency.set(idempotencyKey, targetVersionId);
      return json({
        schemaVersion: 1,
        version: versionReference(targetVersionId, targetFingerprint),
      });
    }
    if (method === "PUT" && url.pathname.startsWith("/v1/quarantines/")) {
      const quarantineId = decodeURIComponent(url.pathname.slice(16));
      const candidateId = String(body.candidateId);
      const candidate = this.candidates.get(candidateId);
      const candidateFingerprint = String(body.candidateFingerprint);
      const value = body.value as JsonValue;
      if (!candidate || fingerprint(value) !== candidateFingerprint) {
        return json({ error: "quarantine contradiction" }, 409);
      }
      this.quarantines.set(quarantineId, {
        id: quarantineId,
        runId: String(body.runId),
        fingerprint: candidateFingerprint,
        value,
      });
      return json({ schemaVersion: 1, quarantineId, fingerprint: candidateFingerprint });
    }
    if (method === "PUT" && url.pathname.startsWith("/v1/discards/")) {
      const runId = decodeURIComponent(url.pathname.slice(13));
      const alreadyDiscarded = this.discardedRuns.has(runId);
      if (typeof body.candidateId === "string") this.candidates.delete(body.candidateId);
      for (const [candidateId, candidate] of this.candidates) {
        if (candidate.runId === runId) this.candidates.delete(candidateId);
      }
      if (typeof body.quarantineId === "string") {
        this.quarantines.delete(body.quarantineId);
      }
      for (const [quarantineId, quarantine] of this.quarantines) {
        if (quarantine.runId === runId) this.quarantines.delete(quarantineId);
      }
      this.discardedRuns.add(runId);
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
        value: { release: "canonical" },
      },
    ],
  ]);
  private readonly candidates = new Map<string, StoredObject>();
  private readonly quarantines = new Map<string, StoredObject>();
  private readonly idempotency = new Map<string, string>();
  private readonly discardedRuns = new Set<string>();
  private closed = false;

  close(): void {
    this.closed = true;
  }

  hasMutableStateForRun(runId: string): boolean {
    return (
      [...this.candidates.values()].some((candidate) => candidate.runId === runId) ||
      [...this.quarantines.values()].some(
        (quarantine) => quarantine.runId === runId,
      )
    );
  }
}

function found(record: StoredObject | null): Response {
  return json({
    schemaVersion: 1,
    found: record !== null,
    record: record
      ? { id: record.id, fingerprint: record.fingerprint, value: record.value }
      : null,
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
