import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertTransactionalResourceConformance,
  runTransactionalResourceConformance,
  type JsonValue,
  type ResourceConformanceFixture,
  type ResourcePrepareContext,
  type ResourceVersionReference,
} from "@agent-airlock/transactional-resource-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  fingerprint,
  HttpObjectResourceProvider,
  stableJson,
  versionReference,
} from "./provider.js";

const temporaryDirectories: string[] = [];
const disposals = new Set<() => Promise<void>>();

afterEach(async () => {
  await Promise.all([...disposals].map((dispose) => dispose()));
  disposals.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("HTTP object Resource Provider", () => {
  it("refuses redirects outside the configured provider boundary", async () => {
    let observedRedirect: RequestRedirect | undefined;
    const provider = new HttpObjectResourceProvider({
      baseUrl: "https://provider.example",
      fetcher: async (_input, init) => {
        observedRedirect = init?.redirect;
        throw new TypeError("redirect refused");
      },
    });
    const root = await mkdtemp(path.join(tmpdir(), "airlock-http-redirect-"));
    temporaryDirectories.push(root);

    await expect(
      provider.prepare({
        schemaVersion: 1,
        agentId: "agent-redirect",
        runId: "run-redirect",
        candidateStateId: "state-redirect",
        candidateResourcePath: root,
        source: versionReference("version-source", "a".repeat(64)),
        repairSource: null,
      }),
    ).rejects.toMatchObject({
      code: "provider-unavailable",
      safeSummary: "HTTP object provider is unavailable",
    });
    expect(observedRedirect).toBe("error");
  });

  it("passes the provider-neutral conformance suite", async () => {
    const report = await runTransactionalResourceConformance(createConformanceFixture);

    expect(report.passed).toBe(true);
    expect(report.cases).toHaveLength(8);
    expect(report.cases.every((item) => item.status === "passed")).toBe(true);
    expect(() => assertTransactionalResourceConformance(report)).not.toThrow();
  });

  it("installs one immutable version for duplicate and concurrent Promotions", async () => {
    const fixture = await createProviderFixture("concurrent");
    const prepared = await fixture.provider.prepare(fixture.context);
    await writeFile(
      path.join(fixture.context.candidateResourcePath, "object.json"),
      '{"release":"concurrent"}\n',
      "utf8",
    );
    const candidateContext = { ...fixture.context, candidate: prepared.candidate };
    const plan = await fixture.provider.planPromotion(candidateContext);
    const versions = await Promise.all(
      Array.from({ length: 8 }, () =>
        fixture.provider.promote({ ...candidateContext, plan }),
      ),
    );

    expect(new Set(versions.map((version) => stableJson(version))).size).toBe(1);
    await expect(fixture.provider.readVersion(versions[0]!)).resolves.toEqual({
      release: "concurrent",
    });
    expect(fixture.remote.stats()).toMatchObject({
      versions: 2,
      idempotencyKeys: 1,
    });
    await expect(
      fixture.newProvider().reconcile({
        schemaVersion: 1,
        agentId: fixture.context.agentId,
        runId: fixture.context.runId,
        plan,
        expectedVersion: versions[0]!,
      }),
    ).resolves.toMatchObject({ status: "installed", version: versions[0] });
  });

  it("cleans run-scoped mutable state when a prepare response is lost", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-http-lost-prepare-"));
    temporaryDirectories.push(root);
    const remote = new MemoryHttpObjectService();
    let loseCandidateResponse = true;
    const provider = new HttpObjectResourceProvider({
      baseUrl: "http://fixture.invalid",
      fetcher: async (input, init) => {
        const response = await remote.fetch(input, init);
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (
          loseCandidateResponse &&
          (init?.method ?? "GET") === "POST" &&
          url.pathname === "/v1/candidates"
        ) {
          loseCandidateResponse = false;
          return new Response("{lost", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return response;
      },
    });
    const context: ResourcePrepareContext = {
      schemaVersion: 1,
      agentId: "agent-lost-prepare",
      runId: "run-lost-prepare",
      candidateStateId: "state-lost-prepare",
      candidateResourcePath: root,
      source: remote.initialVersion,
      repairSource: null,
    };

    await expect(provider.prepare(context)).rejects.toMatchObject({
      code: "capability-mismatch",
    });
    expect(remote.stats().candidates).toBe(1);
    await expect(
      provider.discard({
        ...context,
        candidate: null,
        quarantine: null,
      }),
    ).resolves.toMatchObject({ discarded: true, evidenceRetained: true });
    expect(remote.stats().candidates).toBe(0);
  });

  it("rejects an oversized canonical source before creating a Runtime Candidate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-http-oversized-source-"));
    temporaryDirectories.push(root);
    const value = { padding: "x".repeat(300) } satisfies JsonValue;
    const source = versionReference("version-large", fingerprint(value));
    let candidatePosts = 0;
    const provider = new HttpObjectResourceProvider({
      baseUrl: "http://fixture.invalid",
      maximumObjectBytes: 256,
      fetcher: async (input, init) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if ((init?.method ?? "GET") === "POST") candidatePosts += 1;
        if (url.pathname === "/v1/versions/version-large") {
          return found({
            id: source.versionId,
            fingerprint: source.fingerprint,
            value,
          });
        }
        return json({ error: "unexpected" }, 404);
      },
    });

    await expect(
      provider.prepare({
        schemaVersion: 1,
        agentId: "agent-large",
        runId: "run-large",
        candidateStateId: "state-large",
        candidateResourcePath: root,
        source,
        repairSource: null,
      }),
    ).rejects.toMatchObject({ code: "response-too-large", stage: "prepare" });
    expect(candidatePosts).toBe(0);
    await expect(readFile(path.join(root, "object.json"), "utf8")).rejects.toThrow();
  });

  it.each([
    ["timeout", "timeout"],
    ["oversized", "response-too-large"],
    ["malformed", "capability-mismatch"],
    ["wrong-content-type", "capability-mismatch"],
    ["unavailable", "provider-unavailable"],
    ["tamper", "capability-mismatch"],
  ] as const)("fails closed for %s provider responses", async (mode, code) => {
    const fixture = await createProviderFixture("fault-" + mode, {
      timeoutMs: 40,
      maximumResponseBytes: 4_096,
    });
    fixture.remote.setFault(mode, "/v1/versions/", 1);

    await expect(fixture.provider.prepare(fixture.context)).rejects.toMatchObject({
      name: "ResourceLifecycleError",
      stage: "prepare",
      code,
    });
    await expect(
      readFile(path.join(fixture.context.candidateResourcePath, "object.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("distinguishes source mismatch and provider unavailability without leaking details", async () => {
    const fixture = await createProviderFixture("source-mismatch");
    await expect(
      fixture.provider.prepare({
        ...fixture.context,
        source: { ...fixture.context.source, fingerprint: "a".repeat(64) },
      }),
    ).rejects.toMatchObject({
      code: "source-mismatch",
      retryable: false,
      safeSummary: "Remote object fingerprint contradicted expected version",
    });

    fixture.remote.close();
    await expect(fixture.provider.prepare(fixture.context)).rejects.toMatchObject({
      code: "provider-unavailable",
      retryable: true,
      safeSummary: "HTTP object provider is unavailable",
    });
  });

  it("crosses a real child-process HTTP boundary when socket binding is permitted", async (context) => {
    let fixture: ChildHttpFixture;
    try {
      fixture = await startChildHttpFixture();
    } catch (error) {
      if (String(error).includes("listen EPERM")) {
        context.skip();
        return;
      }
      throw error;
    }
    disposals.add(fixture.close);
    const root = await mkdtemp(path.join(tmpdir(), "airlock-http-child-candidate-"));
    temporaryDirectories.push(root);
    const provider = new HttpObjectResourceProvider({ baseUrl: fixture.baseUrl });
    const prepared = await provider.prepare({
      schemaVersion: 1,
      agentId: "agent-child",
      runId: "run-child",
      candidateStateId: "state-child",
      candidateResourcePath: root,
      source: fixture.initialVersion,
      repairSource: null,
    });

    expect(await provider.candidateExists(prepared.candidate.candidateId)).toBe(true);
    expect(fixture.child.pid).toBeTypeOf("number");
  });
});

interface ProviderFixture {
  remote: MemoryHttpObjectService;
  provider: HttpObjectResourceProvider;
  context: ResourcePrepareContext;
  newProvider(): HttpObjectResourceProvider;
}

async function createProviderFixture(
  label: string,
  options: { timeoutMs?: number; maximumResponseBytes?: number } = {},
): Promise<ProviderFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-http-provider-"));
  temporaryDirectories.push(root);
  const remote = new MemoryHttpObjectService();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = remote.fetch;
  const dispose = async () => {
    if (globalThis.fetch === remote.fetch) globalThis.fetch = previousFetch;
  };
  disposals.add(dispose);
  const candidateResourcePath = path.join(root, "candidate", label);
  await mkdir(candidateResourcePath, { recursive: true });
  const providerOptions = { baseUrl: "http://fixture.invalid", ...options };
  return {
    remote,
    provider: new HttpObjectResourceProvider(providerOptions),
    context: {
      schemaVersion: 1,
      agentId: "agent-" + label,
      runId: "run-" + label,
      candidateStateId: "state-" + label,
      candidateResourcePath,
      source: remote.initialVersion,
      repairSource: null,
    },
    newProvider: () => new HttpObjectResourceProvider(providerOptions),
  };
}

async function createConformanceFixture(): Promise<ResourceConformanceFixture> {
  const fixture = await createProviderFixture("conformance");
  let repairCandidatePath: string | null = null;
  return {
    provider: fixture.provider,
    context: fixture.context,
    async mutateCandidate(_candidate, value) {
      await writeFile(
        path.join(fixture.context.candidateResourcePath, "object.json"),
        stableJson(value) + "\n",
        "utf8",
      );
    },
    readVersion: (reference) => fixture.provider.readVersion(reference),
    async readCandidate(candidate) {
      const selectedPath = candidate.candidateId.endsWith("-repair")
        ? repairCandidatePath
        : fixture.context.candidateResourcePath;
      if (!selectedPath) throw new Error("repair Candidate path is unavailable");
      return JSON.parse(
        await readFile(path.join(selectedPath, "object.json"), "utf8"),
      ) as JsonValue;
    },
    candidateExists: (candidate) =>
      fixture.provider.candidateExists(candidate.candidateId),
    quarantineExists: (quarantine) =>
      fixture.provider.quarantineExists(quarantine.quarantineId),
    async mutableStateExistsForRun(runId) {
      return fixture.remote.hasMutableStateForRun(runId);
    },
    async createRepairContext(quarantine) {
      repairCandidatePath = path.join(
        path.dirname(fixture.context.candidateResourcePath),
        "conformance-repair",
      );
      await mkdir(repairCandidatePath, { recursive: true });
      return {
        ...fixture.context,
        runId: "run-conformance-repair",
        candidateStateId: "state-conformance-repair",
        candidateResourcePath: repairCandidatePath,
        repairSource: quarantine,
      };
    },
    restartProvider: async () => fixture.newProvider(),
    dispose: async () => {
      const disposal = [...disposals].at(-1);
      if (disposal) {
        disposals.delete(disposal);
        await disposal();
      }
    },
  };
}

interface StoredObject {
  id: string;
  fingerprint: string;
  value: JsonValue;
  runId?: string;
}

class MemoryHttpObjectService {
  readonly initialVersion = versionReference(
    "version-source",
    fingerprint({ release: "canonical" }),
  );
  readonly fetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (this.closed) throw new TypeError("fixture unavailable");
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (
      this.fault.mode !== "none" &&
      this.fault.remaining > 0 &&
      url.pathname.startsWith(this.fault.routePrefix)
    ) {
      this.fault.remaining -= 1;
      return this.faultResponse(this.fault.mode, init?.signal ?? null);
    }
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
      const runId = String(body.runId);
      const value = body.value as JsonValue;
      const candidateId = "candidate-" + runId;
      const candidateFingerprint = fingerprint(value);
      this.candidates.set(candidateId, {
        id: candidateId,
        runId,
        fingerprint: candidateFingerprint,
        value,
      });
      return json({ schemaVersion: 1, candidateId, fingerprint: candidateFingerprint });
    }
    if (method === "PUT" && url.pathname.startsWith("/v1/versions/")) {
      const targetId = decodeURIComponent(url.pathname.slice(13));
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
        return json({ error: "contradiction" }, 409);
      }
      this.versions.set(targetId, { id: targetId, fingerprint: targetFingerprint, value });
      this.idempotency.set(key, targetId);
      return json({
        schemaVersion: 1,
        version: versionReference(targetId, targetFingerprint),
      });
    }
    if (method === "PUT" && url.pathname.startsWith("/v1/quarantines/")) {
      const quarantineId = decodeURIComponent(url.pathname.slice(16));
      const value = body.value as JsonValue;
      const candidateFingerprint = String(body.candidateFingerprint);
      this.quarantines.set(quarantineId, {
        id: quarantineId,
        runId: String(body.runId),
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
      for (const [candidateId, candidate] of this.candidates) {
        if (candidate.runId === runId) this.candidates.delete(candidateId);
      }
      if (typeof body.quarantineId === "string") {
        this.quarantines.delete(body.quarantineId);
      }
      for (const [quarantineId, quarantine] of this.quarantines) {
        if (quarantine.runId === runId) this.quarantines.delete(quarantineId);
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
        value: { release: "canonical" },
      },
    ],
  ]);
  private readonly candidates = new Map<string, StoredObject>();
  private readonly quarantines = new Map<string, StoredObject>();
  private readonly idempotency = new Map<string, string>();
  private readonly discarded = new Set<string>();
  private fault = { mode: "none", routePrefix: "/", remaining: 0 };
  private closed = false;

  setFault(mode: string, routePrefix: string, remaining: number): void {
    this.fault = { mode, routePrefix, remaining };
  }

  close(): void {
    this.closed = true;
  }

  stats() {
    return {
      versions: this.versions.size,
      candidates: this.candidates.size,
      quarantines: this.quarantines.size,
      idempotencyKeys: this.idempotency.size,
    };
  }

  hasMutableStateForRun(runId: string): boolean {
    return (
      [...this.candidates.values()].some((candidate) => candidate.runId === runId) ||
      [...this.quarantines.values()].some(
        (quarantine) => quarantine.runId === runId,
      )
    );
  }

  private async faultResponse(mode: string, signal: AbortSignal | null): Promise<Response> {
    if (mode === "timeout") {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 250);
        signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    if (mode === "oversized") return json({ padding: "x".repeat(300_000) });
    if (mode === "malformed") {
      return new Response("{malformed", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (mode === "wrong-content-type") {
      return new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (mode === "unavailable") return json({ error: "unavailable" }, 503);
    if (mode === "tamper") {
      return json({
        schemaVersion: 1,
        found: true,
        record: {
          id: "version-source",
          fingerprint: "f".repeat(64),
          value: { release: "tampered" },
        },
      });
    }
    return json({ schemaVersion: 1 });
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

interface ChildHttpFixture {
  child: ChildProcess;
  baseUrl: string;
  initialVersion: ResourceVersionReference;
  close(): Promise<void>;
}

async function startChildHttpFixture(): Promise<ChildHttpFixture> {
  const child = spawn(
    process.execPath,
    [path.resolve(import.meta.dirname, "../dist/fixture-server-process.js")],
    { env: { NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4_096);
  });
  const line = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("child HTTP fixture timed out")), 3_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        resolve(output.slice(0, newline));
      }
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(stderr));
    });
  });
  const ready = JSON.parse(line) as {
    baseUrl: string;
    initialVersion: ResourceVersionReference;
  };
  let closed = false;
  const close = async () => {
    if (closed || child.exitCode !== null) return;
    closed = true;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const forced = setTimeout(() => child.kill("SIGKILL"), 1_000);
    forced.unref();
    await exited;
    clearTimeout(forced);
  };
  return { child, baseUrl: ready.baseUrl, initialVersion: ready.initialVersion, close };
}
