import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, writeCodexConfig } from "./config.js";

function commitment(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

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

const protocolFixtureEnvironment = {
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  AIRLOCK_PROTOCOL_FIXTURE_MODE: "true",
  RUNTIME_PROVIDER: "container",
  CODEX_BIN: "codex",
  ARK_API_KEY: "deterministic-protocol-fixture",
  ARK_MODEL: "protocol-fixture",
  ARK_BASE_URL: "http://host.docker.internal:43994/v1",
} as const;

const productImageProtocolFixtureEnvironment = {
  NODE_ENV: "production",
  HOST: "0.0.0.0",
  APP_AUTH_TOKEN: "phase11-container-verification-token",
  AIRLOCK_DEMO_MODE: "false",
  AIRLOCK_PROTOCOL_FIXTURE_MODE: "true",
  AIRLOCK_MODELARK_DEMO_MODE: "false",
  RUNTIME_PROVIDER: "local-process",
  CODEX_BIN: "codex",
  ARK_API_KEY: "deterministic-protocol-fixture",
  ARK_MODEL: "protocol-fixture",
  ARK_BASE_URL: "http://127.0.0.1:43991/v1",
} as const;

const liveModelArkModel = "ep-live-model";
const liveModelArkBaseUrl = "https://ark.ap-southeast.bytepluses.com/api/v3";
const liveModelArkPreflightProof = {
  schema: "agent-airlock/modelark-preflight-proof",
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  generatedAssistantOutput: true,
  modelCommitment: commitment(liveModelArkModel),
  endpointOriginCommitment: commitment(new URL(liveModelArkBaseUrl).origin),
  attemptCount: 1,
  requestCount: 1,
  retryDelayMs: 0,
};

const liveModelArkDemoEnvironment = {
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  AIRLOCK_MODELARK_DEMO_MODE: "true",
  RUNTIME_PROVIDER: "container",
  CODEX_BIN: "codex",
  ARK_API_KEY: "ark-live-test-key",
  ARK_MODEL: liveModelArkModel,
  ARK_BASE_URL: liveModelArkBaseUrl,
  AIRLOCK_MODELARK_PREFLIGHT_PROOF: JSON.stringify(liveModelArkPreflightProof),
  AIRLOCK_EFFECT_WEBHOOK_URL:
    "http://127.0.0.1:3202/v1/effects/demo-console",
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

describe("Codex tool boundary configuration", () => {
  it("writes a credential-filtered non-login shell policy without persisting the key", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-codex-config-"));
    const configuredKey = "private-key-that-must-not-enter-config";
    try {
      const config = loadConfig({
        NODE_ENV: "test",
        CODEX_HOME: root,
        ARK_API_KEY: configuredKey,
        ARK_MODEL: "ep-test",
      });
      await writeCodexConfig(config);
      const generated = await readFile(path.join(root, "config.toml"), "utf8");

      expect(generated).toContain("allow_login_shell = false");
      expect(generated).toContain("[shell_environment_policy]");
      expect(generated).toContain("ignore_default_excludes = false");
      expect(generated).toContain('"*CREDENTIAL*"');
      expect(generated).toContain('"AIRLOCK_OUTBOX_PATH"');
      expect(generated).toContain("[sandbox_workspace_write]");
      expect(generated).toContain("network_access = false");
      expect(generated).not.toContain(configuredKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("real Codex protocol fixture configuration", () => {
  it("accepts only the complete loopback container profile", () => {
    const config = loadConfig(protocolFixtureEnvironment);
    expect(config.protocolFixtureMode).toBe(true);
    expect(config.demoMode).toBe(false);
  });

  it("accepts the Podman host gateway", () => {
    expect(
      loadConfig({
        ...protocolFixtureEnvironment,
        ARK_BASE_URL: "http://host.containers.internal:43994/v1/",
      }).protocolFixtureMode,
    ).toBe(true);
  });

  it("accepts the exact authenticated product-image profile", () => {
    const config = loadConfig(productImageProtocolFixtureEnvironment);

    expect(config).toMatchObject({
      host: "0.0.0.0",
      authToken: "phase11-container-verification-token",
      arkBaseUrl: "http://127.0.0.1:43991/v1",
      runtimeProvider: "local-process",
      codexBin: "codex",
      protocolFixtureMode: true,
      demoMode: false,
      modelArkDemoMode: false,
    });
  });

  it.each([
    [
      "loopback app host mixed with the product-image profile",
      { HOST: "127.0.0.1" },
    ],
    [
      "container Runtime mixed with the product-image profile",
      { RUNTIME_PROVIDER: "container" },
    ],
    [
      "container gateway mixed with the product-image profile",
      { ARK_BASE_URL: "http://host.docker.internal:43991/v1" },
    ],
    [
      "external inference URL",
      { ARK_BASE_URL: "https://ark.example.com/v1" },
    ],
    [
      "localhost inference alias",
      { ARK_BASE_URL: "http://localhost:43991/v1" },
    ],
    [
      "inference URL without an explicit port",
      { ARK_BASE_URL: "http://127.0.0.1/v1" },
    ],
    [
      "alternate loopback fixture port",
      { ARK_BASE_URL: "http://127.0.0.1:43992/v1" },
    ],
    ["wrong fixture path", { ARK_BASE_URL: "http://127.0.0.1:43991/v2" }],
    [
      "fixture path with a trailing slash",
      { ARK_BASE_URL: "http://127.0.0.1:43991/v1/" },
    ],
    [
      "fixture URL query",
      { ARK_BASE_URL: "http://127.0.0.1:43991/v1?claim=modelark" },
    ],
    ["fixture Codex binary", { CODEX_BIN: "/tmp/fake-codex.mjs" }],
    ["non-fixture key", { ARK_API_KEY: "organizer-key" }],
    ["non-fixture model", { ARK_MODEL: "ep-live-model" }],
  ])("rejects a product-image %s", (_name, override) => {
    expect(() =>
      loadConfig({ ...productImageProtocolFixtureEnvironment, ...override }),
    ).toThrow(/real-Codex protocol fixture profile/);
  });

  it.each([undefined, "short-token"])(
    "requires a strong bearer token for the product-image profile (%s)",
    (authToken) => {
      expect(() =>
        loadConfig({
          ...productImageProtocolFixtureEnvironment,
          APP_AUTH_TOKEN: authToken,
        }),
      ).toThrow(/APP_AUTH_TOKEN/);
    },
  );

  it("cannot make a ModelArk claim from the product-image fixture", () => {
    expect(() =>
      loadConfig({
        ...productImageProtocolFixtureEnvironment,
        AIRLOCK_MODELARK_DEMO_MODE: "true",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it.each([
    ["remote app host", { HOST: "0.0.0.0" }],
    ["external inference URL", { ARK_BASE_URL: "https://ark.example.com/v1" }],
    ["wrong fixture path", { ARK_BASE_URL: "http://host.docker.internal:43994/v2" }],
    ["local-process Runtime", { RUNTIME_PROVIDER: "local-process" }],
    ["fixture Codex binary", { CODEX_BIN: "/tmp/fake-codex.mjs" }],
    ["non-fixture key", { ARK_API_KEY: "organizer-key" }],
    ["non-fixture model", { ARK_MODEL: "ep-live-model" }],
  ])("rejects a %s", (_name, override) => {
    expect(() =>
      loadConfig({ ...protocolFixtureEnvironment, ...override }),
    ).toThrow(/exact real-Codex protocol fixture profile/);
  });

  it("cannot be combined with the fake deterministic demo", () => {
    expect(() =>
      loadConfig({
        ...protocolFixtureEnvironment,
        AIRLOCK_DEMO_MODE: "true",
      }),
    ).toThrow(/mutually exclusive/);
  });
});

describe("live ModelArk judge demo configuration", () => {
  it("accepts the strict loopback control plane and external provider profile", () => {
    const config = loadConfig(liveModelArkDemoEnvironment);
    expect(config.modelArkDemoMode).toBe(true);
    expect(config.demoMode).toBe(false);
    expect(config.protocolFixtureMode).toBe(false);
    expect(config.modelArkPreflightProof).toMatchObject({
      generatedAssistantOutput: true,
      attemptCount: 1,
      requestCount: 1,
    });
    expect(config.externalActionWebhookUrl).toBe(
      "http://127.0.0.1:3202/v1/effects/demo-console",
    );
  });

  it.each([
    ["remote receiver", "https://effects.example.com/v1/effects/demo-console"],
    ["wrong receiver path", "http://127.0.0.1:3202/v1/effects/other"],
    ["receiver credentials", "http://user:pass@127.0.0.1:3202/v1/effects/demo-console"],
  ])("rejects a %s", (_name, webhookUrl) => {
    expect(() =>
      loadConfig({
        ...liveModelArkDemoEnvironment,
        AIRLOCK_EFFECT_WEBHOOK_URL: webhookUrl,
      }),
    ).toThrow(/loopback ModelArk demo receiver/);
  });

  it("shares the BytePlus AP default with the provider preflight", () => {
    const environment = Object.fromEntries(
      Object.entries(liveModelArkDemoEnvironment).filter(
        ([key]) => key !== "ARK_BASE_URL",
      ),
    );
    expect(loadConfig(environment).arkBaseUrl).toBe(liveModelArkBaseUrl);
  });

  it.each([
    ["remote app host", { HOST: "0.0.0.0" }],
    ["loopback inference URL", { ARK_BASE_URL: "https://localhost/api/v3" }],
    ["insecure inference URL", { ARK_BASE_URL: "http://ark.example.com/api/v3" }],
    ["local-process Runtime", { RUNTIME_PROVIDER: "local-process" }],
    ["fixture Codex binary", { CODEX_BIN: "/tmp/fake-codex.mjs" }],
    ["placeholder key", { ARK_API_KEY: "replace-with-key" }],
    ["placeholder model", { ARK_MODEL: "replace-with-endpoint" }],
  ])("rejects a %s", (_name, override) => {
    expect(() =>
      loadConfig({ ...liveModelArkDemoEnvironment, ...override }),
    ).toThrow(/loopback-only live ModelArk container profile/);
  });

  it.each([
    ["missing proof", undefined],
    ["malformed proof", "not-json"],
    [
      "stale proof",
      JSON.stringify({
        ...liveModelArkPreflightProof,
        checkedAt: "2026-08-27T00:00:00.000Z",
      }),
    ],
    [
      "wrong model commitment",
      JSON.stringify({
        ...liveModelArkPreflightProof,
        modelCommitment: commitment("ep-other-model"),
      }),
    ],
    [
      "wrong endpoint commitment",
      JSON.stringify({
        ...liveModelArkPreflightProof,
        endpointOriginCommitment: commitment("https://other.example"),
      }),
    ],
  ])("rejects a %s", (_name, proof) => {
    expect(() =>
      loadConfig({
        ...liveModelArkDemoEnvironment,
        AIRLOCK_MODELARK_PREFLIGHT_PROOF: proof,
      }),
    ).toThrow(/fresh launcher-issued ModelArk preflight proof/);
  });

  it("cannot be combined with a fixture demo", () => {
    expect(() =>
      loadConfig({
        ...liveModelArkDemoEnvironment,
        AIRLOCK_PROTOCOL_FIXTURE_MODE: "true",
      }),
    ).toThrow(/mutually exclusive/);
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

describe("local container host gateway", () => {
  it("is disabled by default and requires an explicit local test opt-in", () => {
    expect(loadConfig({ NODE_ENV: "test" }).containerHostGateway).toBe(false);
    expect(
      loadConfig({
        NODE_ENV: "test",
        CONTAINER_HOST_GATEWAY: "true",
      }).containerHostGateway,
    ).toBe(true);
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
