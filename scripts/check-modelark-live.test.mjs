import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";
import {
  buildModelArkPreflightProof,
  checkModelArkLive,
} from "./check-modelark-live.mjs";

const execFile = promisify(execFileCallback);

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

function completedResponse(id, text = "OK") {
  return {
    id,
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

test("proves a completed Responses API request without returning the key", async () => {
  await withServer(
    async (request, response) => {
      assert.equal(request.url, "/api/v3/responses");
      assert.equal(request.headers.authorization, "Bearer secret-live-key");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completedResponse("response-1")));
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

test("builds a bounded launch handoff without provider-private values", () => {
  const proof = buildModelArkPreflightProof(
    {
      origin: "https://ark.private.example",
      model: "ep-private-model",
      responseId: "private-response-id",
      attemptCount: 2,
      requestCount: 4,
      retryDelayMs: 4_000,
    },
    new Date("2026-08-28T02:00:00.000Z"),
  );
  assert.deepEqual(proof, {
    schema: "agent-airlock/modelark-preflight-proof",
    schemaVersion: 1,
    checkedAt: "2026-08-28T02:00:00.000Z",
    generatedAssistantOutput: true,
    modelCommitment:
      "sha256:3bfdd3b152852c9a60b05833859e6f05c22dd55acf1e87c1b6d3732e73594e03",
    endpointOriginCommitment:
      "sha256:40668476cd880a09d63581066b9c8e187ba72b599f1ccd6ad9348e54a6cd00ae",
    attemptCount: 2,
    requestCount: 4,
    retryDelayMs: 4_000,
  });
  assert.doesNotMatch(
    JSON.stringify(proof),
    /ark\.private\.example|ep-private-model|private-response-id/,
  );
});

test("the launch command emits one parseable redacted handoff", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completedResponse("private-response-id")));
    },
    async (baseUrl) => {
      const { stdout, stderr } = await execFile(
        process.execPath,
        ["scripts/check-modelark-live.mjs", "--launch-result-json"],
        {
          cwd: new URL("..", import.meta.url),
          env: {
            ...process.env,
            ARK_API_KEY: "secret-live-key",
            ARK_MODEL: "ep-private-model",
            ARK_BASE_URL: baseUrl,
          },
        },
      );
      const result = JSON.parse(stdout);
      assert.equal(result.selectedModel, "ep-private-model");
      assert.equal(result.proof.generatedAssistantOutput, true);
      assert.equal(result.proof.requestCount, 1);
      assert.equal(stderr, "");
      assert.doesNotMatch(
        JSON.stringify(result.proof),
        /secret-live-key|ep-private-model|private-response-id|127\.0\.0\.1/,
      );
    },
  );
});

test("rejects a completed response that did not generate assistant text", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "response-without-output",
          status: "completed",
          output: [],
          account: "private-account-metadata",
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
      assert.match(message, /without a non-empty assistant output/);
      assert.doesNotMatch(
        message,
        /response-without-output|private-account-metadata|secret-live-key/,
      );
    },
  );
});

test("rejects whitespace, reasoning, and non-assistant content as model output", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "response-with-invalid-output",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                { type: "reasoning_text", text: "private reasoning" },
                { type: "output_text", text: "   " },
              ],
            },
            {
              type: "message",
              role: "user",
              content: [{ type: "output_text", text: "not model output" }],
            },
          ],
        }),
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
        /without a non-empty assistant output/,
      );
    },
  );
});

test("the command exits non-zero when live output proof fails", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "private-response-id", status: "completed" }),
      );
    },
    async (baseUrl) => {
      let failure;
      try {
        await execFile(process.execPath, ["scripts/check-modelark-live.mjs"], {
          cwd: new URL("..", import.meta.url),
          env: {
            ...process.env,
            ARK_API_KEY: "secret-live-key",
            ARK_MODEL: "dola-seed-test",
            ARK_BASE_URL: baseUrl,
          },
        });
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.code, 1);
      assert.match(failure?.stderr ?? "", /without a non-empty assistant output/);
      assert.doesNotMatch(
        `${failure?.stdout ?? ""}${failure?.stderr ?? ""}`,
        /private-response-id|secret-live-key/,
      );
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
      response.end(JSON.stringify(completedResponse("fallback-response")));
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
      response.end(JSON.stringify(completedResponse("response-1")));
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
          : JSON.stringify(completedResponse("response-after-capacity")),
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
          : JSON.stringify(completedResponse("response-after-burst")),
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
      response.end(JSON.stringify(completedResponse("fallback-ready")));
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
