import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { checkModelArkLive } from "./check-modelark-live.mjs";

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    await run(`http://127.0.0.1:${address.port}/api/v3`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("proves a completed Responses API request without returning the key", async () => {
  await withServer(
    async (request, response) => {
      assert.equal(request.url, "/api/v3/responses");
      assert.equal(request.headers.authorization, "Bearer secret-live-key");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "response-1", status: "completed" }));
    },
    async (baseUrl) => {
      const result = await checkModelArkLive({
        environment: {
          ARK_API_KEY: "secret-live-key",
          ARK_MODEL: "dola-seed-test",
          ARK_BASE_URL: baseUrl,
        },
      });
      assert.deepEqual(result, {
        origin: new URL(baseUrl).origin,
        model: "dola-seed-test",
        responseId: "response-1",
        attemptCount: 1,
        requestCount: 1,
        retryDelayMs: 0,
      });
      assert.doesNotMatch(JSON.stringify(result), /secret-live-key/);
    },
  );
});

test("selects an operator-approved fallback after a model-specific failure", async () => {
  const attemptedModels = [];
  await withServer(
    async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      attemptedModels.push(body.model);
      if (body.model === "ep-primary") {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "private account data" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "fallback-response", status: "completed" }));
    },
    async (baseUrl) => {
      const result = await checkModelArkLive({
        environment: {
          ARK_API_KEY: "secret-live-key",
          ARK_MODEL: "ep-primary",
          ARK_MODEL_FALLBACKS: "ep-fallback, ep-unused",
          ARK_BASE_URL: baseUrl,
        },
      });
      assert.deepEqual(attemptedModels, ["ep-primary", "ep-fallback"]);
      assert.equal(result.model, "ep-fallback");
      assert.equal(result.attemptCount, 2);
      assert.equal(result.requestCount, 2);
      assert.equal(result.retryDelayMs, 0);
    },
  );
});

test("stops on authentication failure without trying a fallback", async () => {
  let requestCount = 0;
  await withServer(
    (_request, response) => {
      requestCount += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "private" } }));
    },
    async (baseUrl) => {
      await assert.rejects(
        checkModelArkLive({
          environment: {
            ARK_API_KEY: "secret-live-key",
            ARK_MODEL: "ep-primary",
            ARK_MODEL_FALLBACKS: "ep-fallback",
            ARK_BASE_URL: baseUrl,
          },
        }),
        /authentication failed with HTTP 401/,
      );
      assert.equal(requestCount, 1);
    },
  );
});

test("deduplicates configured models and rejects more than four", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "response-1", status: "completed" }));
    },
    async (baseUrl) => {
      const result = await checkModelArkLive({
        environment: {
          ARK_API_KEY: "secret-live-key",
          ARK_MODEL: "ep-primary",
          ARK_MODEL_FALLBACKS: "ep-primary, ep-primary",
          ARK_BASE_URL: baseUrl,
        },
      });
      assert.equal(result.attemptCount, 1);
      await assert.rejects(
        checkModelArkLive({
          environment: {
            ARK_API_KEY: "secret-live-key",
            ARK_MODEL: "ep-1",
            ARK_MODEL_FALLBACKS: "ep-2,ep-3,ep-4,ep-5",
            ARK_BASE_URL: baseUrl,
          },
        }),
        /at most 4 unique models/,
      );
    },
  );
});

test("turns common provider failures into actionable bounded errors", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "The model is not activated" } }),
      );
    },
    async (baseUrl) => {
      await assert.rejects(
        checkModelArkLive({
          environment: {
            ARK_API_KEY: "secret-live-key",
            ARK_MODEL: "dola-seed-test",
            ARK_BASE_URL: baseUrl,
          },
        }),
        /HTTP 404.*configured model is activated/,
      );
    },
  );
});

test("does not expose provider account metadata in rate-limit errors", async () => {
  let requestCount = 0;
  await withServer(
    (_request, response) => {
      requestCount += 1;
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message:
              "Account 3003612015 reached its limit, request id: req-secret-123",
          },
        }),
      );
    },
    async (baseUrl) => {
      let message = "";
      try {
        await checkModelArkLive({
          environment: {
            ARK_API_KEY: "secret-live-key",
            ARK_MODEL: "dola-seed-test",
            ARK_BASE_URL: baseUrl,
          },
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.match(message, /HTTP 429.*Free Credits Only Mode/);
      assert.doesNotMatch(message, /3003612015|req-secret-123|secret-live-key/);
      assert.equal(requestCount, 1);
    },
  );
});

test("retries only allowlisted transient ModelArk capacity errors", async () => {
  let requestCount = 0;
  const delays = [];
  await withServer(
    (_request, response) => {
      requestCount += 1;
      response.writeHead(requestCount < 3 ? 429 : 200, {
        "content-type": "application/json",
      });
      response.end(
        requestCount < 3
          ? JSON.stringify({
              error: {
                code: "ServerOverloaded",
                message: "private request id and account metadata",
              },
            })
          : JSON.stringify({ id: "response-after-capacity", status: "completed" }),
      );
    },
    async (baseUrl) => {
      const result = await checkModelArkLive({
        environment: {
          ARK_API_KEY: "secret-live-key",
          ARK_MODEL: "dola-seed-test",
          ARK_BASE_URL: baseUrl,
        },
        delayImplementation: async (milliseconds) => {
          delays.push(milliseconds);
        },
      });
      assert.equal(result.responseId, "response-after-capacity");
      assert.equal(requestCount, 3);
      assert.equal(result.requestCount, 3);
      assert.equal(result.retryDelayMs, 4_000);
      assert.deepEqual(delays, [1_000, 3_000]);
    },
  );
});

test("honors numeric Retry-After guidance within a strict delay cap", async () => {
  let requestCount = 0;
  const delays = [];
  await withServer(
    (_request, response) => {
      requestCount += 1;
      response.writeHead(requestCount < 3 ? 429 : 200, {
        "content-type": "application/json",
        "retry-after": requestCount === 1 ? "5" : "999999999999999999999",
      });
      response.end(
        requestCount < 3
          ? JSON.stringify({ error: { code: "RequestBurstTooFast" } })
          : JSON.stringify({ id: "response-after-burst", status: "completed" }),
      );
    },
    async (baseUrl) => {
      const result = await checkModelArkLive({
        environment: {
          ARK_API_KEY: "secret-live-key",
          ARK_MODEL: "dola-seed-test",
          ARK_BASE_URL: baseUrl,
        },
        delayImplementation: async (milliseconds) => {
          delays.push(milliseconds);
        },
      });
      assert.equal(result.responseId, "response-after-burst");
      assert.equal(result.requestCount, 3);
      assert.equal(result.retryDelayMs, 8_000);
      assert.deepEqual(delays, [5_000, 3_000]);
      assert.ok(delays.every((delay) => delay <= 10_000));
    },
  );
});

test("bounds the complete transient warm-up and withholds the provider code", async () => {
  let requestCount = 0;
  const delays = [];
  await withServer(
    (_request, response) => {
      requestCount += 1;
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "30",
      });
      response.end(
        JSON.stringify({
          error: {
            code: "ServerOverloaded",
            message: "account 3003612015 request req-secret-123",
          },
        }),
      );
    },
    async (baseUrl) => {
      let message = "";
      try {
        await checkModelArkLive({
          environment: {
            ARK_API_KEY: "secret-live-key",
            ARK_MODEL: "dola-seed-test",
            ARK_BASE_URL: baseUrl,
          },
          delayImplementation: async (milliseconds) => {
            delays.push(milliseconds);
          },
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.equal(requestCount, 3);
      assert.deepEqual(delays, [10_000, 5_000]);
      assert.equal(delays.reduce((total, delay) => total + delay, 0), 15_000);
      assert.match(message, /bounded warm-up.*temporarily unavailable/);
      assert.doesNotMatch(
        message,
        /ServerOverloaded|3003612015|req-secret-123|secret-live-key/,
      );
    },
  );
});

test("preserves a fallback chance after the shared warm-up budget is exhausted", async () => {
  const attemptedModels = [];
  const delays = [];
  await withServer(
    async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const model = JSON.parse(raw).model;
      attemptedModels.push(model);
      if (model === "ep-primary") {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "30",
        });
        response.end(JSON.stringify({ error: { code: "ServerOverloaded" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "fallback-ready", status: "completed" }));
    },
    async (baseUrl) => {
      const result = await checkModelArkLive({
        environment: {
          ARK_API_KEY: "secret-live-key",
          ARK_MODEL: "ep-primary",
          ARK_MODEL_FALLBACKS: "ep-fallback",
          ARK_BASE_URL: baseUrl,
        },
        delayImplementation: async (milliseconds) => {
          delays.push(milliseconds);
        },
      });
      assert.deepEqual(attemptedModels, [
        "ep-primary",
        "ep-primary",
        "ep-primary",
        "ep-fallback",
      ]);
      assert.deepEqual(delays, [10_000, 5_000]);
      assert.equal(result.model, "ep-fallback");
      assert.equal(result.attemptCount, 2);
      assert.equal(result.requestCount, 4);
      assert.equal(result.retryDelayMs, 15_000);
    },
  );
});
