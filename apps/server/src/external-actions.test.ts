import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExternalActionOutbox,
  HttpExternalActionDispatcher,
  MockExternalActionDispatcher,
} from "./external-actions.js";

const temporaryDirectories: string[] = [];

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

    expect(first[0]).toEqual(second[0]);
    expect(second[0]).toEqual(third[0]);
    expect(await restarted.list()).toHaveLength(1);
  });

  it("delivers through HTTP once and reuses the durable receiver receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-http-effects-"));
    temporaryDirectories.push(root);
    const outboxPath = path.join(root, "intents.jsonl");
    await writeFile(outboxPath, notification() + "\n", "utf8");
    const intents = (await new ExternalActionOutbox().validate(outboxPath, "run-1"))
      .intents;
    const intent = intents[0]!;
    let requestCount = 0;
    const fetchStub = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1;
      expect(init?.headers).toMatchObject({
        "idempotency-key": intent.idempotencyKey,
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
      (async () => {
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
});
