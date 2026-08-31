#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

export function requireLoopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Production image browser proof requires a loopback origin");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "::1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Production image browser proof requires a loopback origin");
  }
  return url.origin;
}

function mimeEssence(value) {
  return String(value ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function networkOrigin(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return "invalid";
  }
}

function parseOrigin(argumentsList) {
  if (
    argumentsList.length !== 2 ||
    argumentsList[0] !== "--origin" ||
    !argumentsList[1]
  ) {
    throw new Error(
      "Usage: node scripts/check-production-image-browser.mjs --origin http://127.0.0.1:<port>",
    );
  }
  return requireLoopbackOrigin(argumentsList[1]);
}

export async function verifyProductionImageInBrowser({
  origin,
  authToken,
  launch = (options) => chromium.launch(options),
} = {}) {
  origin = requireLoopbackOrigin(origin);
  if (typeof authToken !== "string" || authToken.length < 24) {
    throw new Error("Production image browser proof requires its test token");
  }
  const browser = await launch({ channel: "chrome", headless: true });
  const pageErrors = [];
  const failedResponses = [];
  const failedRequests = [];
  const stylesheetResponses = [];
  const authenticatedAgentResponses = [];
  const unexpectedNetwork = [];
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1280, height: 720 },
    });
    await context.route("**/*", async (route) => {
      const requestOrigin = networkOrigin(route.request().url());
      if (requestOrigin !== null && requestOrigin !== origin) {
        unexpectedNetwork.push(route.request().url());
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await context.routeWebSocket("**/*", async (socket) => {
      if (networkOrigin(socket.url()) !== origin) {
        unexpectedNetwork.push(socket.url());
        await socket.close({ code: 1008, reason: "External network blocked" });
        return;
      }
      socket.connectToServer();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      const requestOrigin = networkOrigin(request.url());
      if (requestOrigin !== null && requestOrigin !== origin) {
        unexpectedNetwork.push(request.url());
      }
    });
    page.on("requestfailed", (request) => {
      if (networkOrigin(request.url()) === origin) {
        failedRequests.push(request.url());
      }
    });
    page.on("websocket", (socket) => {
      if (networkOrigin(socket.url()) !== origin) {
        unexpectedNetwork.push(socket.url());
      }
    });
    page.on("response", (response) => {
      const request = response.request();
      const responseOrigin = networkOrigin(response.url());
      if (responseOrigin !== null && responseOrigin !== origin) {
        unexpectedNetwork.push(response.url());
        return;
      }
      if (responseOrigin !== origin) return;
      if (response.status() >= 400) failedResponses.push(response.url());
      const responseUrl = new URL(response.url());
      if (
        responseUrl.pathname === "/api/agents" &&
        responseUrl.search === "" &&
        response.status() === 200
      ) {
        authenticatedAgentResponses.push(response.url());
      }
      if (request.resourceType() === "stylesheet") {
        stylesheetResponses.push({
          contentType: response.headers()["content-type"] ?? "",
          status: response.status(),
          url: response.url(),
        });
      }
    });
    await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await page
      .getByRole("heading", { name: "Enter the access token", exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.getByLabel("Access token", { exact: true }).fill(authToken);
    await page
      .getByRole("button", { name: "Open Airlock", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "Your runtime is ready for an Agent.",
        exact: true,
      })
      .waitFor({ state: "visible", timeout: 20_000 });
    await page
      .locator(".brand")
      .getByText("Agent Airlock", { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
    const mounted = await page.locator("#root").evaluate((root) =>
      Boolean(root.firstElementChild),
    );
    const stylesheetRuleCount = await page.evaluate(() =>
      Array.from(document.styleSheets).reduce((total, stylesheet) => {
        try {
          return total + stylesheet.cssRules.length;
        } catch {
          return total;
        }
      }, 0),
    );
    const stylesheetValid =
      stylesheetResponses.length === 1 &&
      stylesheetResponses[0].status === 200 &&
      mimeEssence(stylesheetResponses[0].contentType) === "text/css" &&
      stylesheetRuleCount >= 50;
    if (
      !mounted ||
      !stylesheetValid ||
      authenticatedAgentResponses.length < 1 ||
      unexpectedNetwork.length > 0 ||
      pageErrors.length > 0 ||
      failedRequests.length > 0 ||
      failedResponses.length > 0
    ) {
      throw new Error(
        pageErrors.length > 0
          ? "Production image React runtime raised a page error"
          : unexpectedNetwork.length > 0
            ? "Production image browser attempted unexpected external network access"
            : authenticatedAgentResponses.length < 1
              ? "Production image browser did not observe an authenticated Agent API response"
          : failedRequests.length > 0 || failedResponses.length > 0
            ? "Production image browser journey observed a failed request"
            : !stylesheetValid
              ? "Production image stylesheet did not load completely"
              : "Production image React runtime did not mount",
      );
    }
  } finally {
    await browser.close();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await verifyProductionImageInBrowser({
    origin: parseOrigin(process.argv.slice(2)),
    authToken: process.env.AIRLOCK_PRODUCTION_IMAGE_AUTH_TOKEN ?? "",
  });
  process.stdout.write(
    "Production image Playwright proof passed: React and CSS loaded, authentication completed, and the control plane reached its ready state.\n",
  );
}
