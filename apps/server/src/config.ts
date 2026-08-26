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
  AIRLOCK_DEMO_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
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
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
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
    demoMode: env.AIRLOCK_DEMO_MODE,
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
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
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
