import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const deterministicDemoEnvironment = {
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  AIRLOCK_DEMO_MODE: "true",
  RUNTIME_PROVIDER: "local-process",
  CODEX_BIN: "/project/tests/fixtures/fake-codex.mjs",
  ARK_API_KEY: "deterministic-local-fixture",
  ARK_MODEL: "local-airlock-demo",
  ARK_BASE_URL: "http://127.0.0.1:1/api/v3",
} as const;

describe("deterministic demo configuration", () => {
  it("accepts only the complete loopback fixture profile", () => {
    expect(loadConfig(deterministicDemoEnvironment).demoMode).toBe(true);
  });

  it.each([
    ["remote host", { HOST: "0.0.0.0" }],
    ["remote Ark URL", { ARK_BASE_URL: "https://ark.example.com/api/v3" }],
    ["container Runtime", { RUNTIME_PROVIDER: "container" }],
    ["non-fixture binary", { CODEX_BIN: "codex" }],
    ["non-fixture key", { ARK_API_KEY: "organizer-key" }],
    ["non-fixture model", { ARK_MODEL: "ep-live-model" }],
  ])("rejects a %s", (_name, override) => {
    expect(() =>
      loadConfig({ ...deterministicDemoEnvironment, ...override }),
    ).toThrow(/loopback-only deterministic fixture profile/);
  });
});
