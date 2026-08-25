import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("exposes the bounded Outcome Contract update boundary", async () => {
    let received: unknown = null;
    const contractService = {
      updateOutcomeContract: async (_id: string, input: unknown) => {
        received = input;
        return { schemaVersion: 1, version: 2, ...input };
      },
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), contractService);
    const payload = {
      requiredPaths: ["AGENTS.md"],
      protectedPaths: ["AGENTS.md"],
      maxChangedFiles: 50,
      maxAddedBytes: 100_000,
      secretPatterns: [{ name: "token", pattern: "token=[^\\s]+" }],
      validationCommands: [
        { name: "test", command: "npm test", required: true, timeoutMs: 30_000 },
      ],
    };

    const accepted = await app.inject({
      method: "PUT",
      url: "/api/agents/11111111-1111-4111-8111-111111111111/outcome-contract",
      payload,
    });
    const rejected = await app.inject({
      method: "PUT",
      url: "/api/agents/11111111-1111-4111-8111-111111111111/outcome-contract",
      payload: {
        ...payload,
        validationCommands: [
          { name: "test", command: "npm test", required: true, timeoutMs: 999 },
        ],
      },
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ outcomeContract: { version: 2 } });
    expect(received).toEqual(payload);
    expect(rejected.statusCode).toBe(400);
    await app.close();
  });

  it("exposes path-free Repair Run and discard operations", async () => {
    const calls: Array<{ operation: string; id: string; objective?: string }> = [];
    const recoveryService = {
      repairRun: async (id: string, objective?: string) => {
        calls.push({ operation: "repair", id, ...(objective ? { objective } : {}) });
        return { run: { id: "repair-run" }, message: { id: "message" } };
      },
      discardRun: async (id: string) => {
        calls.push({ operation: "discard", id });
        return { id, transaction: { disposition: "discarded" } };
      },
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), recoveryService);
    const runId = "11111111-1111-4111-8111-111111111111";

    const repaired = await app.inject({
      method: "POST",
      url: "/api/runs/" + runId + "/repair",
      payload: { objective: "Restore only the failed protected path" },
    });
    const discarded = await app.inject({
      method: "POST",
      url: "/api/runs/" + runId + "/discard",
    });

    expect(repaired.statusCode).toBe(202);
    expect(discarded.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        operation: "repair",
        id: runId,
        objective: "Restore only the failed protected path",
      },
      { operation: "discard", id: runId },
    ]);
    await app.close();
  });
});
