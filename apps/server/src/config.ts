import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  AIRLOCK_MAX_REPAIR_DEPTH: z.coerce.number().int().min(1).max(5).default(2),
  AIRLOCK_CANDIDATE_RETENTION_HOURS: z.coerce
    .number()
    .positive()
    .max(8_760)
    .default(24),
  AIRLOCK_QUARANTINE_RETENTION_HOURS: z.coerce
    .number()
    .positive()
    .max(8_760)
    .default(168),
  AIRLOCK_PORTABLE_SIGNING_KEY_PATH: z.string().min(1).max(4_096).optional(),
  AIRLOCK_TRANSPARENCY_SIGNING_KEY_PATH: z.string().min(1).max(4_096).optional(),
  AIRLOCK_TRANSPARENCY_LOG_PATH: z.string().min(1).max(4_096).optional(),
  AIRLOCK_DEMO_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  AIRLOCK_PROTOCOL_FIXTURE_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  AIRLOCK_MODELARK_DEMO_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  AIRLOCK_MODELARK_PREFLIGHT_PROOF: z.string().max(4_096).optional(),
  AIRLOCK_HTTP_OBJECT_URL: z.string().url().optional(),
  AIRLOCK_HTTP_OBJECT_SOCKET: z.string().min(1).optional(),
  AIRLOCK_HTTP_OBJECT_VERSION_ID: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
    .optional(),
  AIRLOCK_HTTP_OBJECT_FINGERPRINT: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  CONTAINER_HOST_GATEWAY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  AIRLOCK_OPERATOR_ID: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    .default("local-control-plane"),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.ap-southeast.bytepluses.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const modelArkPreflightProofSchema = z
  .object({
    schema: z.literal("agent-airlock/modelark-preflight-proof"),
    schemaVersion: z.literal(1),
    checkedAt: z.string().datetime({ offset: true }),
    generatedAssistantOutput: z.literal(true),
    modelCommitment: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    endpointOriginCommitment: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    attemptCount: z.number().int().min(1).max(4),
    requestCount: z.number().int().min(1).max(16),
    retryDelayMs: z.number().int().min(0).max(15_000),
  })
  .strict();

const MODELARK_PREFLIGHT_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const MODELARK_PREFLIGHT_FUTURE_TOLERANCE_MS = 60_000;

function sha256Commitment(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function parseModelArkPreflightProof(
  raw: string | undefined,
  model: string,
  endpointOrigin: string,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    throw new Error(
      "AIRLOCK_MODELARK_DEMO_MODE requires a fresh launcher-issued ModelArk preflight proof",
    );
  }
  const proof = modelArkPreflightProofSchema.safeParse(parsed);
  if (!proof.success) {
    throw new Error(
      "AIRLOCK_MODELARK_DEMO_MODE requires a fresh launcher-issued ModelArk preflight proof",
    );
  }
  const checkedAtMs = Date.parse(proof.data.checkedAt);
  const ageMs = Date.now() - checkedAtMs;
  const valid =
    ageMs >= -MODELARK_PREFLIGHT_FUTURE_TOLERANCE_MS &&
    ageMs <= MODELARK_PREFLIGHT_MAX_AGE_MS &&
    proof.data.requestCount >= proof.data.attemptCount &&
    proof.data.modelCommitment === sha256Commitment(model) &&
    proof.data.endpointOriginCommitment === sha256Commitment(endpointOrigin);
  if (!valid) {
    throw new Error(
      "AIRLOCK_MODELARK_DEMO_MODE requires a fresh launcher-issued ModelArk preflight proof",
    );
  }
  return proof.data;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  const activeDemoModes = [
    env.AIRLOCK_DEMO_MODE,
    env.AIRLOCK_PROTOCOL_FIXTURE_MODE,
    env.AIRLOCK_MODELARK_DEMO_MODE,
  ].filter(Boolean).length;
  let modelArkPreflightProof: z.infer<
    typeof modelArkPreflightProofSchema
  > | null = null;
  if (activeDemoModes > 1) {
    throw new Error(
      "Airlock demo modes are mutually exclusive",
    );
  }
  if (env.AIRLOCK_DEMO_MODE) {
    const arkHostname = new URL(env.ARK_BASE_URL).hostname;
    const demoProfileValid =
      loopbackHosts.has(env.HOST) &&
      loopbackHosts.has(arkHostname) &&
      env.RUNTIME_PROVIDER === "local-process" &&
      path.basename(env.CODEX_BIN) === "fake-codex.mjs" &&
      env.ARK_API_KEY?.trim() === "deterministic-local-fixture" &&
      env.ARK_MODEL?.trim() === "local-airlock-demo";
    if (!demoProfileValid) {
      throw new Error(
        "AIRLOCK_DEMO_MODE requires the loopback-only deterministic fixture profile from npm run demo",
      );
    }
  }
  if (env.AIRLOCK_PROTOCOL_FIXTURE_MODE) {
    const arkUrl = new URL(env.ARK_BASE_URL);
    const fixtureHosts = new Set([
      "host.docker.internal",
      "host.containers.internal",
    ]);
    const protocolFixtureProfileValid =
      loopbackHosts.has(env.HOST) &&
      fixtureHosts.has(arkUrl.hostname) &&
      arkUrl.protocol === "http:" &&
      arkUrl.pathname.replace(/\/+$/, "") === "/v1" &&
      env.RUNTIME_PROVIDER === "container" &&
      env.CODEX_BIN === "codex" &&
      env.ARK_API_KEY?.trim() === "deterministic-protocol-fixture" &&
      env.ARK_MODEL?.trim() === "protocol-fixture";
    if (!protocolFixtureProfileValid) {
      throw new Error(
        "AIRLOCK_PROTOCOL_FIXTURE_MODE requires the loopback-only real-Codex protocol fixture profile",
      );
    }
  }
  if (env.AIRLOCK_MODELARK_DEMO_MODE) {
    const arkUrl = new URL(env.ARK_BASE_URL);
    const liveDemoProfileValid =
      loopbackHosts.has(env.HOST) &&
      arkUrl.protocol === "https:" &&
      !loopbackHosts.has(arkUrl.hostname) &&
      env.RUNTIME_PROVIDER === "container" &&
      env.CODEX_BIN === "codex" &&
      Boolean(env.ARK_API_KEY?.trim()) &&
      !env.ARK_API_KEY?.trim().startsWith("replace-") &&
      Boolean(env.ARK_MODEL?.trim()) &&
      !env.ARK_MODEL?.trim().includes("replace-");
    if (!liveDemoProfileValid) {
      throw new Error(
        "AIRLOCK_MODELARK_DEMO_MODE requires the loopback-only live ModelArk container profile",
      );
    }
    modelArkPreflightProof = parseModelArkPreflightProof(
      env.AIRLOCK_MODELARK_PREFLIGHT_PROOF,
      env.ARK_MODEL?.trim() ?? "",
      arkUrl.origin,
    );
  }
  if (!loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  const httpObjectValues = [
    env.AIRLOCK_HTTP_OBJECT_URL,
    env.AIRLOCK_HTTP_OBJECT_VERSION_ID,
    env.AIRLOCK_HTTP_OBJECT_FINGERPRINT,
  ];
  if (httpObjectValues.some(Boolean) && !httpObjectValues.every(Boolean)) {
    throw new Error(
      "AIRLOCK_HTTP_OBJECT_URL, AIRLOCK_HTTP_OBJECT_VERSION_ID, and AIRLOCK_HTTP_OBJECT_FINGERPRINT must be configured together",
    );
  }
  if (env.AIRLOCK_HTTP_OBJECT_SOCKET && !env.AIRLOCK_HTTP_OBJECT_URL) {
    throw new Error(
      "AIRLOCK_HTTP_OBJECT_SOCKET requires AIRLOCK_HTTP_OBJECT_URL and an initial version",
    );
  }
  const portableSigningKeyPath = path.resolve(
    env.AIRLOCK_PORTABLE_SIGNING_KEY_PATH ??
      path.join(env.APP_DATA_DIR, "keys", "portable-receipt-ed25519.pem"),
  );
  const transparencySigningKeyPath = path.resolve(
    env.AIRLOCK_TRANSPARENCY_SIGNING_KEY_PATH ??
      path.join(env.APP_DATA_DIR, "keys", "portable-transparency-ed25519.pem"),
  );
  const transparencyLogPath = path.resolve(
    env.AIRLOCK_TRANSPARENCY_LOG_PATH ??
      path.join(
        env.APP_DATA_DIR,
        "transparency",
        "portable-transparency-log.json",
      ),
  );
  const trustCustodyPaths = [
    portableSigningKeyPath,
    portableSigningKeyPath + ".key-id.json",
    transparencySigningKeyPath,
    transparencySigningKeyPath + ".key-id.json",
    transparencyLogPath,
    transparencyLogPath + ".lock",
  ];
  if (new Set(trustCustodyPaths).size !== trustCustodyPaths.length) {
    throw new Error(
      "Portable receipt keys, identity markers, and transparency storage must use distinct paths",
    );
  }
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    maxRepairDepth: env.AIRLOCK_MAX_REPAIR_DEPTH,
    candidateRetentionMs: env.AIRLOCK_CANDIDATE_RETENTION_HOURS * 60 * 60 * 1_000,
    quarantineRetentionMs:
      env.AIRLOCK_QUARANTINE_RETENTION_HOURS * 60 * 60 * 1_000,
    portableSigningKeyPath,
    transparencySigningKeyPath,
    transparencyLogPath,
    demoMode: env.AIRLOCK_DEMO_MODE,
    protocolFixtureMode: env.AIRLOCK_PROTOCOL_FIXTURE_MODE,
    modelArkDemoMode: env.AIRLOCK_MODELARK_DEMO_MODE,
    modelArkPreflightProof,
    httpObjectResource:
      env.AIRLOCK_HTTP_OBJECT_URL &&
      env.AIRLOCK_HTTP_OBJECT_VERSION_ID &&
      env.AIRLOCK_HTTP_OBJECT_FINGERPRINT
        ? {
            baseUrl: env.AIRLOCK_HTTP_OBJECT_URL,
            socketPath: env.AIRLOCK_HTTP_OBJECT_SOCKET
              ? path.resolve(env.AIRLOCK_HTTP_OBJECT_SOCKET)
              : null,
            initialVersionId: env.AIRLOCK_HTTP_OBJECT_VERSION_ID,
            initialFingerprint: env.AIRLOCK_HTTP_OBJECT_FINGERPRINT,
          }
        : null,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    containerHostGateway: env.CONTAINER_HOST_GATEWAY,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    operatorId: env.AIRLOCK_OPERATOR_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
