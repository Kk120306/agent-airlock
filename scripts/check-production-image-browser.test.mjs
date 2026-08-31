import assert from "node:assert/strict";
import test from "node:test";

import { verifyProductionImageInBrowser } from "./check-production-image-browser.mjs";

const origin = "http://127.0.0.1:3000";
const authToken = "production-image-test-token-123456";

function browserFixture({
  authenticatedApiCount = 1,
  authenticatedApiStatus = 200,
  authPromptError = null,
  externalRequestUrl = null,
  externalResponseUrl = null,
  externalWebSocketUrl = null,
  fillError = null,
  mounted = true,
  pageError = null,
  readyError = null,
  requestFailed = false,
  responseStatus = 200,
  stylesheetContentType = "text/css; charset=utf-8",
  stylesheetCount = 1,
  stylesheetRuleCount = 80,
} = {}) {
  const listeners = new Map();
  const state = {
    browserClosed: false,
    clicked: false,
    contextOptions: null,
    externalRequestAborted: false,
    externalWebSocketClosed: false,
    filledToken: null,
    launchOptions: null,
    routesInstalledBeforePage: false,
  };
  let routeHandler = null;
  let webSocketRouteHandler = null;
  const emit = (name, value) => listeners.get(name)?.(value);
  const stylesheetResponse = (index) => ({
    headers: () => ({ "content-type": stylesheetContentType }),
    request: () => ({ resourceType: () => "stylesheet" }),
    status: () => responseStatus,
    url: () => `${origin}/assets/index-${index}.css`,
  });
  const apiResponse = (index) => ({
    headers: () => ({ "content-type": "application/json" }),
    request: () => ({ resourceType: () => "fetch" }),
    status: () => authenticatedApiStatus,
    url: () => `${origin}/api/agents${index === 0 ? "" : `?duplicate=${index}`}`,
  });
  const page = {
    on(name, listener) {
      listeners.set(name, listener);
    },
    async goto() {
      for (let index = 0; index < stylesheetCount; index += 1) {
        emit("response", stylesheetResponse(index));
      }
      if (requestFailed) {
        emit("requestfailed", {
          url: () => `${origin}/assets/index.js`,
        });
      }
      if (externalRequestUrl) {
        await routeHandler?.({
          abort: async () => {
            state.externalRequestAborted = true;
          },
          continue: async () => {},
          request: () => ({ url: () => externalRequestUrl }),
        });
        emit("request", { url: () => externalRequestUrl });
      }
      if (externalResponseUrl) {
        emit("response", {
          headers: () => ({ "content-type": "text/plain" }),
          request: () => ({ resourceType: () => "fetch" }),
          status: () => 200,
          url: () => externalResponseUrl,
        });
      }
      if (externalWebSocketUrl) {
        await webSocketRouteHandler?.({
          close: async () => {
            state.externalWebSocketClosed = true;
          },
          connectToServer: () => {},
          url: () => externalWebSocketUrl,
        });
        emit("websocket", { url: () => externalWebSocketUrl });
      }
      if (pageError) emit("pageerror", new Error(pageError));
    },
    getByRole(role, { name }) {
      if (role === "heading" && name === "Enter the access token") {
        return {
          async waitFor() {
            if (authPromptError) throw authPromptError;
          },
        };
      }
      if (role === "button" && name === "Open Airlock") {
        return {
          async click() {
            state.clicked = true;
            for (let index = 0; index < authenticatedApiCount; index += 1) {
              emit("response", apiResponse(index));
            }
          },
        };
      }
      if (
        role === "heading" &&
        name === "Your runtime is ready for an Agent."
      ) {
        return {
          async waitFor() {
            if (readyError) throw readyError;
          },
        };
      }
      throw new Error(`Unexpected role query: ${role} ${name}`);
    },
    getByLabel(name) {
      assert.equal(name, "Access token");
      return {
        async fill(value) {
          if (fillError) throw fillError;
          state.filledToken = value;
        },
      };
    },
    locator(selector) {
      if (selector === ".brand") {
        return {
          getByText(name) {
            assert.equal(name, "Agent Airlock");
            return { waitFor: async () => {} };
          },
        };
      }
      if (selector === "#root") {
        return { evaluate: async () => mounted };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
    async evaluate() {
      return stylesheetRuleCount;
    },
  };
  return {
    launch: async (options) => {
      state.launchOptions = options;
      return {
      async newContext(options) {
        state.contextOptions = options;
        return {
          async route(pattern, handler) {
            assert.equal(pattern, "**/*");
            routeHandler = handler;
          },
          async routeWebSocket(pattern, handler) {
            assert.equal(pattern, "**/*");
            webSocketRouteHandler = handler;
          },
          async newPage() {
            state.routesInstalledBeforePage =
              typeof routeHandler === "function" &&
              typeof webSocketRouteHandler === "function";
            return page;
          },
        };
      },
      async close() {
        state.browserClosed = true;
      },
      };
    },
    state,
  };
}

test("production image browser verifier executes the authenticated React journey", async () => {
  const fixture = browserFixture();
  await verifyProductionImageInBrowser({
    origin,
    authToken,
    launch: fixture.launch,
  });
  assert.equal(fixture.state.filledToken, authToken);
  assert.equal(fixture.state.clicked, true);
  assert.equal(fixture.state.browserClosed, true);
  assert.deepEqual(fixture.state.launchOptions, {
    channel: "chrome",
    headless: true,
  });
  assert.deepEqual(fixture.state.contextOptions, {
    serviceWorkers: "block",
    viewport: { width: 1280, height: 720 },
  });
  assert.equal(fixture.state.routesInstalledBeforePage, true);
});

test("production image browser verifier rejects a missing test token", async () => {
  const fixture = browserFixture();
  await assert.rejects(
    verifyProductionImageInBrowser({
      origin,
      authToken: "too-short",
      launch: fixture.launch,
    }),
    /requires its test token/,
  );
});

test("production image browser verifier rejects unsafe origins", async (context) => {
  for (const unsafeOrigin of [
    "https://127.0.0.1:3000",
    "http://example.com:3000",
    "http://user:password@127.0.0.1:3000",
    "http://127.0.0.1:3000/admin",
    "http://127.0.0.1:3000/?token=secret",
    "http://127.0.0.1:3000/#proof",
  ]) {
    await context.test(unsafeOrigin, async () => {
      const fixture = browserFixture();
      await assert.rejects(
        verifyProductionImageInBrowser({
          origin: unsafeOrigin,
          authToken,
          launch: fixture.launch,
        }),
        /requires a loopback origin/,
      );
      assert.equal(fixture.state.launchOptions, null);
    });
  }
});

test("production image browser verifier rejects every browser-proof mutation", async (context) => {
  for (const [name, mutation] of [
    ["authentication prompt missing", { authPromptError: new Error("missing") }],
    ["authentication input unusable", { fillError: new Error("unusable") }],
    ["ready state missing", { readyError: new Error("missing") }],
    ["React root unmounted", { mounted: false }],
    ["React page error", { pageError: "render failed" }],
    ["same-origin request failed", { requestFailed: true }],
    ["same-origin response failed", { responseStatus: 500 }],
    ["stylesheet missing", { stylesheetCount: 0 }],
    ["stylesheet duplicated", { stylesheetCount: 2 }],
    ["stylesheet content type drifted", { stylesheetContentType: "text/plain" }],
    [
      "stylesheet MIME suffix smuggled",
      { stylesheetContentType: "text/css-bogus" },
    ],
    ["stylesheet rules truncated", { stylesheetRuleCount: 49 }],
    ["authenticated API missing", { authenticatedApiCount: 0 }],
    [
      "successful external request",
      { externalRequestUrl: "https://example.com/tracker" },
    ],
    [
      "successful external response",
      { externalResponseUrl: "https://example.com/tracker" },
    ],
    [
      "successful external WebSocket",
      { externalWebSocketUrl: "wss://example.com/socket" },
    ],
  ]) {
    await context.test(name, async () => {
      const fixture = browserFixture(mutation);
      await assert.rejects(
        verifyProductionImageInBrowser({
          origin,
          authToken,
          launch: fixture.launch,
        }),
      );
      if (name === "successful external request") {
        assert.equal(fixture.state.externalRequestAborted, true);
      }
      if (name === "successful external WebSocket") {
        assert.equal(fixture.state.externalWebSocketClosed, true);
      }
      assert.equal(fixture.state.browserClosed, true);
    });
  }
});
