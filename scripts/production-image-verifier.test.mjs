import assert from "node:assert/strict";
import test from "node:test";

import {
  ProductionImageVerificationError,
  verifyProductionImageHttp,
} from "./production-image-verifier.mjs";

const validDocument = `<!doctype html><html><head><title>Agent Airlock</title></head><body><div id="root"></div><script type="module" src="/assets/index-release.js"></script></body></html>`;
const validScript = "x".repeat(100_000);

function response(body, contentType, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

function fixtureFetch({
  health = { ok: true, service: "volc-agent-launchpad" },
  healthStatus = 200,
  healthType = "application/json; charset=utf-8",
  document = validDocument,
  documentStatus = 200,
  documentType = "text/html; charset=utf-8",
  script = validScript,
  scriptStatus = 200,
  scriptType = "text/javascript; charset=utf-8",
} = {}) {
  return async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/health") {
      return response(JSON.stringify(health), healthType, healthStatus);
    }
    if (pathname === "/") {
      return response(document, documentType, documentStatus);
    }
    if (pathname === "/assets/index-release.js") {
      return response(script, scriptType, scriptStatus);
    }
    return response("not found", "text/plain", 404);
  };
}

async function rejectsFixture(options) {
  await assert.rejects(
    verifyProductionImageHttp({
      origin: "http://127.0.0.1:3000",
      fetchImpl: fixtureFetch(options),
    }),
    ProductionImageVerificationError,
  );
}

test("accepts the exact production image HTTP contract", async () => {
  assert.deepEqual(
    await verifyProductionImageHttp({
      origin: "http://127.0.0.1:3000",
      fetchImpl: fixtureFetch(),
    }),
    {
      healthService: "volc-agent-launchpad",
      scriptPath: "/assets/index-release.js",
      scriptBytes: 100_000,
    },
  );
});

test("rejects every weakened production image response", async (context) => {
  const mutations = [
    ["failed health", { healthStatus: 503 }],
    ["created health", { healthStatus: 201 }],
    ["wrong health service", { health: { ok: true, service: "other" } }],
    [
      "health response leaks an API key",
      {
        health: {
          apiKey: "deterministic-protocol-fixture",
          ok: true,
          service: "volc-agent-launchpad",
        },
      },
    ],
    [
      "health response has an extra nested field",
      {
        health: {
          ok: true,
          runtime: { provider: "local-process" },
          service: "volc-agent-launchpad",
        },
      },
    ],
    ["non-JSON health", { healthType: "text/plain" }],
    ["smuggled JSON MIME", { healthType: "application/not-json" }],
    ["failed document", { documentStatus: 503 }],
    ["accepted document", { documentStatus: 202 }],
    ["non-HTML document", { documentType: "text/plain" }],
    ["smuggled HTML MIME", { documentType: "text/html-malformed" }],
    [
      "wrong title",
      { document: validDocument.replace("Agent Airlock", "Other") },
    ],
    [
      "missing React mount point",
      { document: validDocument.replace('<div id="root"></div>', "") },
    ],
    [
      "cross-origin application script",
      {
        document: validDocument.replace(
          "/assets/index-release.js",
          "https://example.com/assets/index-release.js",
        ),
      },
    ],
    [
      "non-module application script",
      { document: validDocument.replace('type="module"', 'type="text/javascript"') },
    ],
    ["failed application script", { scriptStatus: 503 }],
    ["partial application script", { scriptStatus: 206 }],
    ["non-JavaScript application script", { scriptType: "text/plain" }],
    [
      "smuggled JavaScript MIME",
      { scriptType: "application/notjavascript" },
    ],
    ["truncated application script", { script: "x".repeat(99_999) }],
  ];
  for (const [name, options] of mutations) {
    await context.test(name, () => rejectsFixture(options));
  }
});

test("rejects non-loopback and credential-bearing origins", async () => {
  for (const origin of [
    "https://example.com",
    "http://127.0.0.1:3000/path",
    "http://user:password@127.0.0.1:3000",
  ]) {
    await assert.rejects(
      verifyProductionImageHttp({ origin, fetchImpl: fixtureFetch() }),
      ProductionImageVerificationError,
    );
  }
});
