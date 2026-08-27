import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  fingerprint,
  stableJson,
  versionReference,
} from "./provider.js";
import type {
  JsonValue,
  ResourceVersionReference,
} from "@agent-airlock/transactional-resource-sdk";

interface StoredObject {
  id: string;
  fingerprint: string;
  value: JsonValue;
  runId?: string;
}

interface CandidateObject extends StoredObject {
  runId: string;
  sourceVersionId: string;
  sourceFingerprint: string;
}

type FaultMode =
  | "none"
  | "timeout"
  | "oversized"
  | "malformed"
  | "wrong-content-type"
  | "unavailable"
  | "tamper";

export interface HttpObjectFixtureServer {
  baseUrl: string;
  initialVersion: ResourceVersionReference;
  close(): Promise<void>;
}

export async function startHttpObjectFixtureServer(options: {
  host?: string;
  port?: number;
  socketPath?: string;
} = {}): Promise<HttpObjectFixtureServer> {
  const host = options.host ?? "127.0.0.1";
  const initialValue = { release: "canonical" } satisfies JsonValue;
  const initialVersion = versionReference(
    "version-source",
    fingerprint(initialValue),
  );
  const versions = new Map<string, StoredObject>([
    [
      initialVersion.versionId,
      {
        id: initialVersion.versionId,
        fingerprint: initialVersion.fingerprint,
        value: initialValue,
      },
    ],
  ]);
  const candidates = new Map<string, CandidateObject>();
  const quarantines = new Map<string, StoredObject>();
  const discardedRuns = new Set<string>();
  const idempotency = new Map<string, string>();
  let fault: { mode: FaultMode; routePrefix: string; remaining: number } = {
    mode: "none",
    routePrefix: "/",
    remaining: 0,
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      if (request.method === "PUT" && url.pathname === "/v1/admin/fault") {
        const body = await readBody(request);
        const mode = body.mode;
        const routePrefix = body.routePrefix;
        const remaining = body.remaining;
        if (
          !isFaultMode(mode) ||
          typeof routePrefix !== "string" ||
          !routePrefix.startsWith("/") ||
          !Number.isInteger(remaining) ||
          (remaining as number) < 0 ||
          (remaining as number) > 100
        ) {
          return sendJson(response, 400, { error: "invalid fault configuration" });
        }
        fault = { mode, routePrefix, remaining: remaining as number };
        return sendJson(response, 200, { schemaVersion: 1, configured: true });
      }
      if (
        fault.mode !== "none" &&
        fault.remaining > 0 &&
        url.pathname.startsWith(fault.routePrefix)
      ) {
        fault.remaining -= 1;
        if (await sendFault(response, fault.mode)) return;
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/stats") {
        return sendJson(response, 200, {
          schemaVersion: 1,
          versions: versions.size,
          candidates: candidates.size,
          quarantines: quarantines.size,
          discardedRuns: discardedRuns.size,
          idempotencyKeys: idempotency.size,
        });
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/versions/")) {
        return sendFound(
          response,
          versions.get(decodeId(url.pathname, "/v1/versions/")) ?? null,
        );
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/candidates/")) {
        return sendFound(
          response,
          candidates.get(decodeId(url.pathname, "/v1/candidates/")) ?? null,
        );
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/v1/quarantines/")
      ) {
        return sendFound(
          response,
          quarantines.get(decodeId(url.pathname, "/v1/quarantines/")) ?? null,
        );
      }
      if (request.method === "POST" && url.pathname === "/v1/candidates") {
        const body = await readBody(request);
        const value = requireJsonValue(body.value);
        const runId = requireId(body.runId);
        const sourceVersionId = requireId(body.sourceVersionId);
        const sourceFingerprint = requireFingerprint(body.sourceFingerprint);
        const source = versions.get(sourceVersionId);
        if (!source || source.fingerprint !== sourceFingerprint) {
          return sendJson(response, 409, { error: "source mismatch" });
        }
        const candidateId = "candidate-" + runId;
        const candidateFingerprint = fingerprint(value);
        const existing = candidates.get(candidateId);
        if (existing && existing.fingerprint !== candidateFingerprint) {
          return sendJson(response, 409, { error: "candidate contradiction" });
        }
        candidates.set(candidateId, {
          id: candidateId,
          runId,
          sourceVersionId,
          sourceFingerprint,
          fingerprint: candidateFingerprint,
          value,
        });
        return sendJson(response, 200, {
          schemaVersion: 1,
          candidateId,
          fingerprint: candidateFingerprint,
        });
      }
      if (request.method === "PUT" && url.pathname.startsWith("/v1/versions/")) {
        const targetVersionId = decodeId(url.pathname, "/v1/versions/");
        const idempotencyKey = request.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string" || idempotencyKey.length > 160) {
          return sendJson(response, 400, { error: "idempotency key required" });
        }
        const replayTarget = idempotency.get(idempotencyKey);
        if (replayTarget) {
          const replay = versions.get(replayTarget);
          if (!replay || replayTarget !== targetVersionId) {
            return sendJson(response, 409, { error: "idempotency contradiction" });
          }
          return sendJson(response, 200, {
            schemaVersion: 1,
            version: versionReference(replay.id, replay.fingerprint),
          });
        }
        const body = await readBody(request);
        const candidateId = requireId(body.candidateId);
        const sourceVersionId = requireId(body.sourceVersionId);
        const sourceFingerprint = requireFingerprint(body.sourceFingerprint);
        const targetFingerprint = requireFingerprint(body.targetFingerprint);
        const value = requireJsonValue(body.value);
        const candidate = candidates.get(candidateId);
        const source = versions.get(sourceVersionId);
        if (
          !candidate ||
          !source ||
          candidate.sourceVersionId !== sourceVersionId ||
          candidate.sourceFingerprint !== sourceFingerprint ||
          source.fingerprint !== sourceFingerprint ||
          fingerprint(value) !== targetFingerprint
        ) {
          return sendJson(response, 409, { error: "promotion contradiction" });
        }
        const existing = versions.get(targetVersionId);
        if (existing && existing.fingerprint !== targetFingerprint) {
          return sendJson(response, 409, { error: "immutable version contradiction" });
        }
        versions.set(targetVersionId, {
          id: targetVersionId,
          fingerprint: targetFingerprint,
          value,
        });
        idempotency.set(idempotencyKey, targetVersionId);
        return sendJson(response, 200, {
          schemaVersion: 1,
          version: versionReference(targetVersionId, targetFingerprint),
        });
      }
      if (
        request.method === "PUT" &&
        url.pathname.startsWith("/v1/quarantines/")
      ) {
        const quarantineId = decodeId(url.pathname, "/v1/quarantines/");
        const body = await readBody(request);
        const candidateId = requireId(body.candidateId);
        const candidateFingerprint = requireFingerprint(body.candidateFingerprint);
        const value = requireJsonValue(body.value);
        const candidate = candidates.get(candidateId);
        if (!candidate || fingerprint(value) !== candidateFingerprint) {
          return sendJson(response, 409, { error: "quarantine contradiction" });
        }
        const existing = quarantines.get(quarantineId);
        if (existing && existing.fingerprint !== candidateFingerprint) {
          return sendJson(response, 409, { error: "quarantine is immutable" });
        }
        quarantines.set(quarantineId, {
          id: quarantineId,
          runId: candidate.runId,
          fingerprint: candidateFingerprint,
          value,
        });
        return sendJson(response, 200, {
          schemaVersion: 1,
          quarantineId,
          fingerprint: candidateFingerprint,
        });
      }
      if (request.method === "PUT" && url.pathname.startsWith("/v1/discards/")) {
        const runId = decodeId(url.pathname, "/v1/discards/");
        const body = await readBody(request);
        const alreadyDiscarded = discardedRuns.has(runId);
        if (typeof body.candidateId === "string") candidates.delete(body.candidateId);
        for (const [candidateId, candidate] of candidates) {
          if (candidate.runId === runId) candidates.delete(candidateId);
        }
        if (typeof body.quarantineId === "string") {
          quarantines.delete(body.quarantineId);
        }
        for (const [quarantineId, quarantine] of quarantines) {
          if (quarantine.runId === runId) quarantines.delete(quarantineId);
        }
        discardedRuns.add(runId);
        return sendJson(response, 200, {
          schemaVersion: 1,
          discarded: true,
          alreadyDiscarded,
          evidenceRetained: true,
        });
      }
      return sendJson(response, 404, { error: "not found" });
    } catch {
      return sendJson(response, 400, { error: "invalid bounded request" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (options.socketPath) {
      server.listen(options.socketPath, () => resolve());
    } else {
      server.listen(options.port ?? 0, host, () => resolve());
    }
  });
  const address = server.address();
  if (!address) throw new Error("Fixture server did not expose an address");
  return {
    baseUrl:
      typeof address === "string"
        ? "http://fixture.invalid"
        : "http://" + host + ":" + address.port,
    initialVersion,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function sendFound(response: ServerResponse, record: StoredObject | null): void {
  sendJson(response, 200, {
    schemaVersion: 1,
    found: record !== null,
    record: record
      ? {
          id: record.id,
          fingerprint: record.fingerprint,
          value: record.value,
        }
      : null,
  });
}

async function sendFault(response: ServerResponse, mode: FaultMode): Promise<boolean> {
  if (mode === "none") return false;
  if (mode === "timeout") {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!response.destroyed) sendJson(response, 200, { schemaVersion: 1 });
    return true;
  }
  if (mode === "oversized") {
    sendJson(response, 200, { padding: "x".repeat(300_000) });
    return true;
  }
  if (mode === "malformed") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{malformed");
    return true;
  }
  if (mode === "wrong-content-type") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("not json");
    return true;
  }
  if (mode === "unavailable") {
    sendJson(response, 503, { error: "temporarily unavailable" });
    return true;
  }
  if (mode === "tamper") {
    sendJson(response, 200, {
      schemaVersion: 1,
      found: true,
      record: {
        id: "version-source",
        fingerprint: "f".repeat(64),
        value: { release: "tampered" },
      },
    });
    return true;
  }
  return false;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 131_072) throw new Error("request too large");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function decodeId(pathname: string, prefix: string): string {
  const decoded = decodeURIComponent(pathname.slice(prefix.length));
  return requireId(decoded);
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new Error("invalid identifier");
  }
  return value;
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("invalid fingerprint");
  }
  return value;
}

function requireJsonValue(value: unknown): JsonValue {
  const normalized = JSON.parse(JSON.stringify(value)) as JsonValue;
  if (Buffer.byteLength(stableJson(normalized), "utf8") > 65_536) {
    throw new Error("object too large");
  }
  return normalized;
}

function isFaultMode(value: unknown): value is FaultMode {
  return [
    "none",
    "timeout",
    "oversized",
    "malformed",
    "wrong-content-type",
    "unavailable",
    "tamper",
  ].includes(String(value));
}
