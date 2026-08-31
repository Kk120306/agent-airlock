import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExternalActionDispatcherScope,
  ExternalActionOutbox,
  HttpExternalActionDispatcher,
  MockExternalActionDispatcher,
  type ExternalActionDeliveryReceipt,
  type ExternalActionDeliveryMode,
  type ParsedExternalActionIntent,
} from "./external-actions.js";

const temporaryDirectories: string[] = [];
const fixtureConsumerId = "00000000-0000-4000-8000-000000000001";

const identityResponse = (consumerId = fixtureConsumerId) =>
  Response.json({
    schema: "agent-airlock/external-action-consumer-identity",
    schemaVersion: 1,
    deliveryMode: "idempotent-http",
    consumerId,
  });

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const notification = (id = "release-ready") =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    type: "demo.notification.requested",
    payload: {
      destination: "demo-console",
      subject: "Release ready",
      body: "Inventory and workspace are ready.",
    },
  });

type ReceiptStoreOverrides = Partial<
  Pick<
    ExternalActionDeliveryReceipt,
    | "idempotencyKey"
    | "runId"
    | "intentId"
    | "destination"
    | "subject"
    | "payloadHash"
  > & {
    type: string;
    deliveryMode: ExternalActionDeliveryMode;
  }
>;

const contradictoryReceiptStore = (
  deliveryMode: ExternalActionDeliveryMode,
  intent: ParsedExternalActionIntent,
  overrides: ReceiptStoreOverrides,
) =>
  JSON.stringify(
    {
      version: 2,
      consumerId: fixtureConsumerId,
      deliveries: [
        {
          idempotencyKey: intent.idempotencyKey,
          runId: "run-1",
          intentId: intent.id,
          type: intent.type,
          destination: intent.payload.destination,
          subject: intent.payload.subject,
          payloadHash: intent.payloadHash,
          deliveredAt: "2026-08-30T00:00:00.000Z",
          deliveryMode,
          ...overrides,
        },
      ],
    },
    null,
    2,
  ) + "\n";

const semanticReceiptMutations = [
  ["idempotency key", { idempotencyKey: `sha256:${"0".repeat(64)}` }],
  ["Run identity", { runId: "different-run" }],
  ["Intent identity", { intentId: "different-intent" }],
  ["destination", { destination: "different-console" }],
  ["subject", { subject: "Different subject" }],
  ["payload commitment", { payloadHash: `sha256:${"0".repeat(64)}` }],
] as const;

const mockStoreBoundaryMutations = [
  ["type", { type: "different.notification.requested" }],
  ["delivery mode", { deliveryMode: "idempotent-http" }],
] as const;

const httpStoreBoundaryMutations = [
  ["type", { type: "different.notification.requested" }],
  ["delivery mode", { deliveryMode: "atomic-local-store" }],
] as const;

describe("External action outbox", () => {
  it("creates a stable run-scoped idempotency key for a valid typed intent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-outbox-"));
    temporaryDirectories.push(root);
    const outboxPath = path.join(root, "intents.jsonl");
    await writeFile(outboxPath, notification() + "\n", "utf8");
    const outbox = new ExternalActionOutbox();

    const first = await outbox.validate(outboxPath, "run-1");
    const second = await outbox.validate(outboxPath, "run-1");
    const anotherRun = await outbox.validate(outboxPath, "run-2");

    expect(first.evidence.status).toBe("passed");
    expect(first.intents[0]?.idempotencyKey).toBe(
      second.intents[0]?.idempotencyKey,
    );
    expect(first.intents[0]?.idempotencyKey).not.toBe(
      anotherRun.intents[0]?.idempotencyKey,
    );
  });

  it("rejects an exact control-plane value before an intent can be delivered", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-outbox-"));
    temporaryDirectories.push(root);
    const sensitiveValue = "raw-auth-value-in-intent";
    const outboxPath = path.join(root, "intents.jsonl");
    await writeFile(
      outboxPath,
      notification().replace(
        "Inventory and workspace are ready.",
        sensitiveValue,
      ) + "\n",
      "utf8",
    );
    const outbox = new ExternalActionOutbox([sensitiveValue]);

    const validation = await outbox.validate(outboxPath, "run-1");

    expect(validation).toMatchObject({
      intents: [],
      evidence: {
        status: "failed",
        summary:
          "External action validation failed: outbox contained a control-plane sensitive value",
      },
    });
    expect(JSON.stringify(validation)).not.toContain(sensitiveValue);
  });

  it.each([
    ["invalid JSON", "{not-json}\n"],
    ["duplicate ids", notification() + "\n" + notification() + "\n"],
    [
      "unsupported type",
      notification().replace("demo.notification.requested", "email.send") + "\n",
    ],
    [
      "oversized payload",
      JSON.stringify({
        schemaVersion: 1,
        id: "oversized",
        type: "demo.notification.requested",
        payload: {
          destination: "demo-console",
          subject: "Too large",
          body: "x".repeat(1_001),
        },
      }) + "\n",
    ],
    [
      "too many intents",
      Array.from({ length: 11 }, (_, index) => notification("intent-" + index)).join(
        "\n",
      ) + "\n",
    ],
  ])("blocks %s", async (_label, content) => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-outbox-"));
    temporaryDirectories.push(root);
    const outboxPath = path.join(root, "intents.jsonl");
    await writeFile(outboxPath, content, "utf8");

    const result = await new ExternalActionOutbox().validate(outboxPath, "run-1");
    expect(result.evidence).toMatchObject({ status: "failed", required: true });
    expect(result.intents).toEqual([]);
  });

  it("blocks a symbolic-link outbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-outbox-"));
    temporaryDirectories.push(root);
    const externalPath = path.join(root, "external.jsonl");
    const outboxPath = path.join(root, "intents.jsonl");
    await writeFile(externalPath, notification() + "\n", "utf8");
    await symlink(externalPath, outboxPath);

    const result = await new ExternalActionOutbox().validate(outboxPath, "run-1");
    expect(result.evidence.summary).toContain("regular file");
  });

  it("claims one durable mock effect under duplicate and concurrent dispatch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-effects-"));
    temporaryDirectories.push(root);
    const outboxPath = path.join(root, "intents.jsonl");
    await writeFile(outboxPath, notification() + "\n", "utf8");
    const intents = (await new ExternalActionOutbox().validate(outboxPath, "run-1"))
      .intents;
    const storePath = path.join(root, "mock-deliveries.json");
    const dispatcher = new MockExternalActionDispatcher(storePath);
    await dispatcher.initialize();

    const [first, second] = await Promise.all([
      dispatcher.dispatch("run-1", intents),
      dispatcher.dispatch("run-1", intents),
    ]);
    const restarted = new MockExternalActionDispatcher(storePath);
    await restarted.initialize();
    const third = await restarted.dispatch("run-1", intents);

    expect(restarted.scope).toEqual(dispatcher.scope);
    expect(first[0]).toEqual(second[0]);
    expect(second[0]).toEqual(third[0]);
    expect(await restarted.list()).toHaveLength(1);
  });

  it.each(semanticReceiptMutations)(
    "rejects a mock receipt whose stored %s is contradictory",
    async (_label, overrides) => {
      const root = await mkdtemp(path.join(tmpdir(), "airlock-effects-"));
      temporaryDirectories.push(root);
      const outboxPath = path.join(root, "intents.jsonl");
      await writeFile(outboxPath, notification() + "\n", "utf8");
      const intents = (
        await new ExternalActionOutbox().validate(outboxPath, "run-1")
      ).intents;
      const intent = intents[0]!;
      const storePath = path.join(root, "mock-deliveries.json");
      await writeFile(
        storePath,
        contradictoryReceiptStore("atomic-local-store", intent, overrides),
        "utf8",
      );
      const originalStore = await readFile(storePath, "utf8");
      const dispatcher = new MockExternalActionDispatcher(storePath);
      await dispatcher.initialize();

      await expect(dispatcher.dispatch("run-1", intents)).rejects.toThrow(
        "contradictory",
      );
      await expect(readFile(storePath, "utf8")).resolves.toBe(originalStore);
    },
  );

  it("reuses a compatible legacy mock receipt without a delivery mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-effects-legacy-"));
    temporaryDirectories.push(root);
    const outboxPath = path.join(root, "intents.jsonl");
    await writeFile(outboxPath, notification() + "\n", "utf8");
    const intents = (
      await new ExternalActionOutbox().validate(outboxPath, "run-1")
    ).intents;
    const intent = intents[0]!;
    const storePath = path.join(root, "mock-deliveries.json");
    const legacy = JSON.parse(
      contradictoryReceiptStore("atomic-local-store", intent, {}),
    ) as {
      version: number;
      consumerId?: string;
      deliveries: Array<Record<string, unknown>>;
    };
    legacy.version = 1;
    delete legacy.consumerId;
    delete legacy.deliveries[0]!.deliveryMode;
    await writeFile(storePath, JSON.stringify(legacy, null, 2) + "\n", "utf8");
    const dispatcher = new MockExternalActionDispatcher(storePath);

    await dispatcher.initialize();
    await expect(dispatcher.dispatch("run-1", intents)).resolves.toMatchObject([
      { idempotencyKey: intent.idempotencyKey, deliveryMode: "atomic-local-store" },
    ]);
    await expect(dispatcher.list()).resolves.toHaveLength(1);
  });

  it("rejects duplicate action identities even when their keys differ", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-effects-duplicate-"));
    temporaryDirectories.push(root);
    const outboxPath = path.join(root, "intents.jsonl");
    await writeFile(outboxPath, notification() + "\n", "utf8");
    const intent = (
      await new ExternalActionOutbox().validate(outboxPath, "run-1")
    ).intents[0]!;
    const store = JSON.parse(
      contradictoryReceiptStore("atomic-local-store", intent, {}),
    ) as { deliveries: Array<Record<string, unknown>> };
    store.deliveries.push({
      ...store.deliveries[0],
      idempotencyKey: `sha256:${"0".repeat(64)}`,
    });
    const storePath = path.join(root, "mock-deliveries.json");
    await writeFile(storePath, JSON.stringify(store, null, 2) + "\n", "utf8");
    const dispatcher = new MockExternalActionDispatcher(storePath);

    await expect(dispatcher.initialize()).rejects.toThrow(
      "duplicate action evidence",
    );
  });

  it.each(mockStoreBoundaryMutations)(
    "rejects a mock receipt whose key matches but %s is invalid",
    async (_label, overrides) => {
      const root = await mkdtemp(path.join(tmpdir(), "airlock-effects-"));
      temporaryDirectories.push(root);
      const outboxPath = path.join(root, "intents.jsonl");
      await writeFile(outboxPath, notification() + "\n", "utf8");
      const intents = (
        await new ExternalActionOutbox().validate(outboxPath, "run-1")
      ).intents;
      const storePath = path.join(root, "mock-deliveries.json");
      await writeFile(
        storePath,
        contradictoryReceiptStore(
          "atomic-local-store",
          intents[0]!,
          overrides,
        ),
        "utf8",
      );
      const dispatcher = new MockExternalActionDispatcher(storePath);

      await expect(dispatcher.initialize()).rejects.toThrow(
        "Unsupported delivery receipt store format",
      );
    },
  );

  it("delivers through HTTP once and reuses the durable receiver receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-http-effects-"));
    temporaryDirectories.push(root);
    const outboxPath = path.join(root, "intents.jsonl");
    await writeFile(outboxPath, notification() + "\n", "utf8");
    const intents = (await new ExternalActionOutbox().validate(outboxPath, "run-1"))
      .intents;
    const intent = intents[0]!;
    let requestCount = 0;
    const fetchStub = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (init?.method === "GET") return identityResponse();
      requestCount += 1;
      expect(init?.headers).toMatchObject({
        "idempotency-key": intent.idempotencyKey,
        "x-agent-airlock-consumer-id": fixtureConsumerId,
      });
      return Response.json({
        schema: "agent-airlock/external-action-delivery-receipt",
        schemaVersion: 1,
        accepted: true,
        receipt: {
          idempotencyKey: intent.idempotencyKey,
          runId: "run-1",
          intentId: intent.id,
          type: intent.type,
          destination: intent.payload.destination,
          subject: intent.payload.subject,
          payloadHash: intent.payloadHash,
          deliveredAt: "2026-08-30T00:00:00.000Z",
        },
      });
    }) as typeof fetch;
    const storePath = path.join(root, "http-delivery-receipts.json");
    const dispatcher = new HttpExternalActionDispatcher(
      "http://127.0.0.1:3202/v1/effects/demo-console",
      storePath,
      "demo-console",
      fetchStub,
    );
    await dispatcher.initialize();

    const first = await dispatcher.dispatch("run-1", intents);
    const second = await dispatcher.dispatch("run-1", intents);
    const restarted = new HttpExternalActionDispatcher(
      "http://127.0.0.1:3202/v1/effects/demo-console",
      storePath,
      "demo-console",
      (async (_input, init) => {
        if (init?.method === "GET") return identityResponse();
        throw new Error("the receiver must not be contacted after local recovery");
      }) as typeof fetch,
    );
    await restarted.initialize();
    const third = await restarted.dispatch("run-1", intents);

    expect(requestCount).toBe(1);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(first[0]?.deliveryMode).toBe("idempotent-http");
    expect(await restarted.list()).toHaveLength(1);
  });

  it.each(semanticReceiptMutations)(
    "rejects an HTTP receipt whose stored %s is contradictory",
    async (_label, overrides) => {
      const root = await mkdtemp(path.join(tmpdir(), "airlock-http-effects-"));
      temporaryDirectories.push(root);
      const outboxPath = path.join(root, "intents.jsonl");
      await writeFile(outboxPath, notification() + "\n", "utf8");
      const intents = (
        await new ExternalActionOutbox().validate(outboxPath, "run-1")
      ).intents;
      const intent = intents[0]!;
      const storePath = path.join(root, "http-delivery-receipts.json");
      await writeFile(
        storePath,
        contradictoryReceiptStore("idempotent-http", intent, overrides),
        "utf8",
      );
      const originalStore = await readFile(storePath, "utf8");
      let requestCount = 0;
      const dispatcher = new HttpExternalActionDispatcher(
        "http://127.0.0.1:3202/v1/effects/demo-console",
        storePath,
        "demo-console",
        (async (_input, init) => {
          if (init?.method === "GET") return identityResponse();
          requestCount += 1;
          throw new Error("the receiver must not be contacted for stored evidence");
        }) as typeof fetch,
      );
      await dispatcher.initialize();

      await expect(dispatcher.dispatch("run-1", intents)).rejects.toThrow(
        "contradictory",
      );
      expect(requestCount).toBe(0);
      await expect(readFile(storePath, "utf8")).resolves.toBe(originalStore);
    },
  );

  it.each(httpStoreBoundaryMutations)(
    "rejects an HTTP receipt whose key matches but %s is invalid",
    async (_label, overrides) => {
      const root = await mkdtemp(path.join(tmpdir(), "airlock-http-effects-"));
      temporaryDirectories.push(root);
      const outboxPath = path.join(root, "intents.jsonl");
      await writeFile(outboxPath, notification() + "\n", "utf8");
      const intents = (
        await new ExternalActionOutbox().validate(outboxPath, "run-1")
      ).intents;
      const storePath = path.join(root, "http-delivery-receipts.json");
      await writeFile(
        storePath,
        contradictoryReceiptStore("idempotent-http", intents[0]!, overrides),
        "utf8",
      );
      let requestCount = 0;
      const dispatcher = new HttpExternalActionDispatcher(
        "http://127.0.0.1:3202/v1/effects/demo-console",
        storePath,
        "demo-console",
        (async () => {
          requestCount += 1;
          throw new Error("the receiver must not be contacted for stored evidence");
        }) as typeof fetch,
      );

      await expect(dispatcher.initialize()).rejects.toThrow(
        "Unsupported delivery receipt store format",
      );
      expect(requestCount).toBe(0);
    },
  );

  it("sends the initialized consumer identity and leaves no receipt when the receiver rolls over before POST", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-http-effects-rollover-"),
    );
    temporaryDirectories.push(root);
    const outboxPath = path.join(root, "intents.jsonl");
    await writeFile(outboxPath, notification() + "\n", "utf8");
    const intents = (
      await new ExternalActionOutbox().validate(outboxPath, "run-1")
    ).intents;
    let posts = 0;
    const dispatcher = new HttpExternalActionDispatcher(
      "http://127.0.0.1:3202/v1/effects/demo-console",
      path.join(root, "http-delivery-receipts.json"),
      "demo-console",
      (async (_input, init) => {
        if (init?.method === "GET") return identityResponse();
        posts += 1;
        expect(init?.headers).toMatchObject({
          "x-agent-airlock-consumer-id": fixtureConsumerId,
        });
        return Response.json(
          { error: "consumer identity conflict" },
          { status: 409 },
        );
      }) as typeof fetch,
    );
    await dispatcher.initialize();

    await expect(dispatcher.dispatch("run-1", intents)).rejects.toThrow(
      /HTTP 409/,
    );
    expect(posts).toBe(1);
    await expect(dispatcher.list()).resolves.toEqual([]);
  });

  it("changes mock scope when the consumer store at the same path is replaced", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-effects-scope-"));
    temporaryDirectories.push(root);
    const storePath = path.join(root, "mock-deliveries.json");
    const first = new MockExternalActionDispatcher(storePath);
    await first.initialize();
    const firstScope = first.scope;
    await rm(storePath);
    const replacement = new MockExternalActionDispatcher(storePath);
    await replacement.initialize();

    expect(replacement.scope).not.toEqual(firstScope);
  });

  it("exposes replacement scope but remains non-operational without POST or mutation when receiver identity changes", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-http-effects-scope-"),
    );
    temporaryDirectories.push(root);
    const storePath = path.join(root, "http-delivery-receipts.json");
    const endpoint = "http://127.0.0.1:3202/v1/effects/demo-console";
    const first = new HttpExternalActionDispatcher(
      endpoint,
      storePath,
      "demo-console",
      (async () => identityResponse(fixtureConsumerId)) as typeof fetch,
    );
    await first.initialize();
    const originalStore = await readFile(storePath, "utf8");
    let posts = 0;
    const replacement = new HttpExternalActionDispatcher(
      endpoint,
      storePath,
      "demo-console",
      (async (_input, init) => {
        if (init?.method === "GET") {
          return identityResponse("00000000-0000-4000-8000-000000000002");
        }
        posts += 1;
        throw new Error("delivery must not be attempted during initialization");
      }) as typeof fetch,
    );

    await expect(replacement.initialize()).resolves.toBeUndefined();
    expect(replacement.scope).toEqual(
      createExternalActionDispatcherScope(
        "idempotent-http",
        "00000000-0000-4000-8000-000000000002\0demo-console",
      ),
    );
    expect(() => replacement.assertOperational()).toThrow(
      /identity does not match the local receipt store/,
    );
    await expect(replacement.dispatch("run-1", [])).rejects.toThrow(
      /identity does not match the local receipt store/,
    );
    await expect(replacement.list()).rejects.toThrow(
      /identity does not match the local receipt store/,
    );
    expect(posts).toBe(0);
    await expect(readFile(storePath, "utf8")).resolves.toBe(originalStore);
  });

  it("binds an empty legacy HTTP receipt store to the current receiver identity", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-http-effects-legacy-scope-"),
    );
    temporaryDirectories.push(root);
    const storePath = path.join(root, "http-delivery-receipts.json");
    await writeFile(
      storePath,
      JSON.stringify({ version: 1, deliveries: [] }, null, 2) + "\n",
      "utf8",
    );
    const dispatcher = new HttpExternalActionDispatcher(
      "http://127.0.0.1:3202/v1/effects/demo-console",
      storePath,
      "demo-console",
      (async () => identityResponse()) as typeof fetch,
    );

    await dispatcher.initialize();

    expect(() => dispatcher.assertOperational()).not.toThrow();
    expect(dispatcher.scope).toEqual(
      createExternalActionDispatcherScope(
        "idempotent-http",
        fixtureConsumerId + "\0demo-console",
      ),
    );
    await expect(
      readFile(storePath, "utf8").then((source) => JSON.parse(source)),
    ).resolves.toEqual({
      version: 2,
      consumerId: fixtureConsumerId,
      deliveries: [],
    });
  });
});
