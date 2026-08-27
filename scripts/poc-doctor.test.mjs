import assert from "node:assert/strict";
import test from "node:test";
import { inspectPocReadiness } from "./poc-doctor.mjs";

const configuredEnvironment = {
  ARK_API_KEY: "secret-key-that-must-stay-hidden",
  ARK_MODEL: "secret-model-that-must-stay-hidden",
  ARK_BASE_URL: "https://ark.example.test/api/v3",
};

test("proves each live prerequisite without returning configured values", async () => {
  const commands = [];
  const report = await inspectPocReadiness({
    environment: configuredEnvironment,
    commandImplementation: async (command, args) => {
      commands.push([command, ...args]);
    },
    modelArkCheck: async () => ({
      attemptCount: 1,
      requestCount: 3,
      retryDelayMs: 4_000,
    }),
    nodeVersion: "22.14.0",
  });

  assert.equal(report.ready, true);
  assert.deepEqual(
    report.checks.map(({ id, status }) => [id, status]),
    [
      ["node", "pass"],
      ["credentials", "pass"],
      ["modelark", "pass"],
      ["engine", "pass"],
      ["image", "pass"],
      ["runtime", "pass"],
      ["session", "pass"],
      ["protocol", "pass"],
    ],
  );
  assert.equal(commands[0][0], "docker");
  assert.match(
    report.checks.find(({ id }) => id === "modelark")?.detail ?? "",
    /1 bounded model attempt, 3 requests, and 4000 ms/,
  );
  assert.match(commands.at(-3).join(" "), /--network none/);
  assert.match(commands.at(-2).join(" "), /probe-codex-session\.sh/);
  assert.match(commands.at(-1).join(" "), /probe-codex-protocol\.sh/);
  assert.doesNotMatch(
    JSON.stringify(report),
    /secret-key-that-must-stay-hidden|secret-model-that-must-stay-hidden/,
  );
});

test("separates provider capacity failure from a healthy container Runtime", async () => {
  const report = await inspectPocReadiness({
    environment: configuredEnvironment,
    commandImplementation: async () => {},
    modelArkCheck: async () => {
      throw new Error(
        "ModelArk returned HTTP 429 because free capacity is unavailable.",
      );
    },
    nodeVersion: "22.14.0",
  });

  assert.equal(report.ready, false);
  assert.equal(
    report.checks.find(({ id }) => id === "modelark")?.status,
    "fail",
  );
  assert.equal(
    report.checks.find(({ id }) => id === "runtime")?.status,
    "pass",
  );
});

test("skips dependent checks when configuration and engine are absent", async () => {
  const report = await inspectPocReadiness({
    environment: {},
    commandImplementation: async () => {
      throw new Error("not installed");
    },
    modelArkCheck: async () => {
      throw new Error("must not run");
    },
    nodeVersion: "20.0.0",
  });

  assert.equal(report.ready, false);
  assert.deepEqual(
    report.checks.map(({ id, status }) => [id, status]),
    [
      ["node", "fail"],
      ["credentials", "fail"],
      ["modelark", "skip"],
      ["engine", "fail"],
      ["image", "skip"],
      ["runtime", "skip"],
      ["session", "skip"],
      ["protocol", "skip"],
    ],
  );
});
