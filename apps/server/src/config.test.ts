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

describe("HTTP object Resource Provider configuration", () => {
  it("accepts one complete credential-free initial version", () => {
    expect(
      loadConfig({
        NODE_ENV: "test",
        AIRLOCK_HTTP_OBJECT_URL: "http://127.0.0.1:4500",
        AIRLOCK_HTTP_OBJECT_VERSION_ID: "version-source",
        AIRLOCK_HTTP_OBJECT_FINGERPRINT: "a".repeat(64),
      }).httpObjectResource,
    ).toEqual({
      baseUrl: "http://127.0.0.1:4500",
      socketPath: null,
      initialVersionId: "version-source",
      initialFingerprint: "a".repeat(64),
    });
  });

  it.each([
    ["URL only", { AIRLOCK_HTTP_OBJECT_URL: "http://127.0.0.1:4500" }],
    [
      "version only",
      {
        AIRLOCK_HTTP_OBJECT_VERSION_ID: "version-source",
        AIRLOCK_HTTP_OBJECT_FINGERPRINT: "a".repeat(64),
      },
    ],
    ["socket only", { AIRLOCK_HTTP_OBJECT_SOCKET: "/tmp/object.sock" }],
  ])("rejects incomplete %s configuration", (_label, environment) => {
    expect(() => loadConfig({ NODE_ENV: "test", ...environment })).toThrow(
      /AIRLOCK_HTTP_OBJECT/,
    );
  });
});

describe("operator authority exposure", () => {
  it("defaults unauthenticated development to loopback", () => {
    expect(loadConfig({ NODE_ENV: "development" }).host).toBe("127.0.0.1");
  });

  it("requires a strong bearer token before listening beyond loopback", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "development", HOST: "0.0.0.0" }),
    ).toThrow(/APP_AUTH_TOKEN/);
    expect(
      loadConfig({
        NODE_ENV: "development",
        HOST: "0.0.0.0",
        APP_AUTH_TOKEN: "local-network-operator-token-123",
      }).authToken,
    ).toBe("local-network-operator-token-123");
  });

  it("does not weaken non-loopback authentication in test mode", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "test", HOST: "0.0.0.0" }),
    ).toThrow(/APP_AUTH_TOKEN/);
    expect(
      loadConfig({
        NODE_ENV: "test",
        HOST: "0.0.0.0",
        APP_AUTH_TOKEN: "test-network-operator-token-123",
      }).authToken,
    ).toBe("test-network-operator-token-123");
  });
});

describe("portable receipt key custody", () => {
  it("keeps signing material in an operator-addressable file outside metadata", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: "/tmp/airlock-portable-data",
      AIRLOCK_PORTABLE_SIGNING_KEY_PATH: "/tmp/airlock-operator/receipt.pem",
      AIRLOCK_TRANSPARENCY_SIGNING_KEY_PATH:
        "/tmp/airlock-operator/transparency.pem",
      AIRLOCK_TRANSPARENCY_LOG_PATH: "/tmp/airlock-operator/log.json",
    });
    expect(config.portableSigningKeyPath).toBe(
      "/tmp/airlock-operator/receipt.pem",
    );
    expect(config.transparencyLogPath).toBe("/tmp/airlock-operator/log.json");
    expect(config.transparencySigningKeyPath).toBe(
      "/tmp/airlock-operator/transparency.pem",
    );
    expect(config.portableSigningKeyPath).not.toContain("db.json");
  });

  it.each([
    [
      "direct key reuse",
      {
        AIRLOCK_PORTABLE_SIGNING_KEY_PATH: "/tmp/airlock/shared.pem",
        AIRLOCK_TRANSPARENCY_SIGNING_KEY_PATH: "/tmp/airlock/shared.pem",
      },
    ],
    [
      "normalized key reuse",
      {
        AIRLOCK_PORTABLE_SIGNING_KEY_PATH: "/tmp/airlock/keys/../shared.pem",
        AIRLOCK_TRANSPARENCY_SIGNING_KEY_PATH: "/tmp/airlock/shared.pem",
      },
    ],
    [
      "identity marker collision",
      {
        AIRLOCK_PORTABLE_SIGNING_KEY_PATH: "/tmp/airlock/receipt.pem",
        AIRLOCK_TRANSPARENCY_LOG_PATH:
          "/tmp/airlock/receipt.pem.key-id.json",
      },
    ],
  ])("rejects %s across trust roles", (_label, override) => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        APP_DATA_DIR: "/tmp/airlock/custody",
        ...override,
      }),
    ).toThrow(/distinct paths/);
  });
});
