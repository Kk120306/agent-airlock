import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { SQLITE_RELATIVE_PATH } from "./sqlite-resource.js";
import type { ValidationCommand } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_VALIDATION_OUTPUT_BYTES = 65_536;
const MAX_PRODUCT_FIXTURE_PROOF_BYTES = 64;
const MAX_PRODUCT_FIXTURE_DATABASE_BYTES = 4 * 1024 * 1024;
const PRODUCT_FIXTURE_VALIDATION_ROOT_PATTERN = /^\.validation-[A-Za-z0-9]{6}$/;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const PRODUCT_IMAGE_PROTOCOL_VALIDATION_COMMAND = [
  'test "$(cat protocol-proof.txt)" = candidate-only',
  "node --no-warnings --experimental-sqlite --input-type=module -e 'import { DatabaseSync } from \"node:sqlite\"; const database = new DatabaseSync(\".airlock/demo.sqlite\"); const row = database.prepare(\"SELECT value FROM inventory WHERE id = ?\").get(\"demo\"); database.close(); if (row?.value !== \"candidate-only\") process.exit(1);'",
].join(" && ");

export interface ValidationCommandResult {
  exitCode: number;
  output: string;
  durationMs: number;
  timedOut: boolean;
  outputExceeded: boolean;
}

export interface ValidationCommandExecutor {
  execute(
    workspacePath: string,
    command: ValidationCommand,
    runId: string,
  ): Promise<ValidationCommandResult>;
}

function exactProductImageFixtureProfile(config: AppConfig): boolean {
  return (
    config.protocolFixtureMode &&
    config.runtimeProvider === "local-process" &&
    config.host === "0.0.0.0" &&
    config.authToken.length >= 24 &&
    !config.authToken.startsWith("replace-") &&
    config.codexBin === "codex" &&
    config.arkApiKey === "deterministic-protocol-fixture" &&
    config.arkModel === "protocol-fixture" &&
    config.arkBaseUrl === "http://127.0.0.1:43991/v1"
  );
}

export function createValidationCommandExecutor(
  config: AppConfig,
): ValidationCommandExecutor {
  return exactProductImageFixtureProfile(config)
    ? new ProductImageFixtureValidationCommandExecutor(config.workspaceRoot)
    : new ContainerValidationCommandExecutor(config);
}

async function boundedRegularFile(
  physicalWorkspacePath: string,
  relativePath: string,
  maximumBytes: number,
): Promise<string> {
  const targetPath = path.join(physicalWorkspacePath, relativePath);
  const [metadata, physicalTargetPath] = await Promise.all([
    lstat(targetPath),
    realpath(targetPath),
  ]);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    metadata.size > maximumBytes ||
    physicalTargetPath !== targetPath
  ) {
    throw new Error("Product-image fixture Validation artifact is unsafe");
  }
  return targetPath;
}

export class ProductImageFixtureValidationCommandExecutor
  implements ValidationCommandExecutor
{
  constructor(private readonly workspaceRoot: string) {}

  async execute(
    workspacePath: string,
    command: ValidationCommand,
    runId: string,
  ): Promise<ValidationCommandResult> {
    const startedAt = Date.now();
    if (
      command.name !== "protocol-content" ||
      command.command !== PRODUCT_IMAGE_PROTOCOL_VALIDATION_COMMAND ||
      command.required !== true ||
      command.timeoutMs !== 10_000
    ) {
      throw new Error(
        "Product-image fixture Validation requires the exact approved command",
      );
    }
    const physicalWorkspacePath = await this.validationWorkspacePath(
      workspacePath,
      runId,
    );
    const proofPath = await boundedRegularFile(
      physicalWorkspacePath,
      "protocol-proof.txt",
      MAX_PRODUCT_FIXTURE_PROOF_BYTES,
    );
    const airlockDirectory = path.join(physicalWorkspacePath, ".airlock");
    const [airlockMetadata, physicalAirlockDirectory] = await Promise.all([
      lstat(airlockDirectory),
      realpath(airlockDirectory),
    ]);
    if (
      !airlockMetadata.isDirectory() ||
      airlockMetadata.isSymbolicLink() ||
      physicalAirlockDirectory !== airlockDirectory
    ) {
      throw new Error("Product-image fixture SQLite parent is unsafe");
    }
    const databasePath = await boundedRegularFile(
      physicalWorkspacePath,
      SQLITE_RELATIVE_PATH,
      MAX_PRODUCT_FIXTURE_DATABASE_BYTES,
    );
    const proofValue = (await readFile(proofPath, "utf8")).replace(/\n+$/u, "");
    let databaseValue: unknown;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT value FROM inventory WHERE id = ?")
        .get("demo") as { value?: unknown } | undefined;
      databaseValue = row?.value;
    } finally {
      database.close();
    }
    const durationMs = Date.now() - startedAt;
    const timedOut = durationMs > command.timeoutMs;
    return {
      exitCode:
        !timedOut &&
        proofValue === "candidate-only" &&
        databaseValue === "candidate-only"
          ? 0
          : 1,
      output: "",
      durationMs,
      timedOut,
      outputExceeded: false,
    };
  }

  private async validationWorkspacePath(
    workspacePath: string,
    runId: string,
  ): Promise<string> {
    if (
      !SAFE_RUN_ID_PATTERN.test(runId) ||
      runId === "." ||
      runId === ".."
    ) {
      throw new Error("Product-image fixture Validation Run identity is unsafe");
    }
    const expectedCandidateRoot = path.join(
      await realpath(this.workspaceRoot),
      ".candidates",
      runId,
    );
    const [candidateMetadata, physicalCandidateRoot] = await Promise.all([
      lstat(expectedCandidateRoot),
      realpath(expectedCandidateRoot),
    ]);
    const [workspaceMetadata, physicalWorkspacePath] = await Promise.all([
      lstat(workspacePath),
      realpath(workspacePath),
    ]);
    const validationRoot = path.dirname(physicalWorkspacePath);
    const validationMetadata = await lstat(validationRoot);
    if (
      !candidateMetadata.isDirectory() ||
      candidateMetadata.isSymbolicLink() ||
      physicalCandidateRoot !== expectedCandidateRoot ||
      !workspaceMetadata.isDirectory() ||
      workspaceMetadata.isSymbolicLink() ||
      path.basename(physicalWorkspacePath) !== "workspace" ||
      !validationMetadata.isDirectory() ||
      validationMetadata.isSymbolicLink() ||
      !PRODUCT_FIXTURE_VALIDATION_ROOT_PATTERN.test(path.basename(validationRoot)) ||
      path.dirname(validationRoot) !== physicalCandidateRoot
    ) {
      throw new Error(
        "Product-image fixture Validation requires a disposable Candidate copy",
      );
    }
    return physicalWorkspacePath;
  }
}

export function validationContainerName(runId: string): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 36);
  return "airlock-validation-" + safeRunId + "-" + randomUUID().slice(0, 8);
}

export function buildValidationContainerArgs(
  workspacePath: string,
  command: ValidationCommand,
  runId: string,
  config: AppConfig,
  name = validationContainerName(runId),
): string[] {
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.airlock=validation",
    "--label",
    "io.codejam.run-id=" + runId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "none",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--env",
    "HOME=/tmp",
    "--env",
    "CODEX_HOME=/tmp/codex-home",
    "--env",
    "NPM_CONFIG_CACHE=/tmp/npm-cache",
    "--env",
    "CI=1",
    "--env",
    "NO_COLOR=1",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--mount",
    "type=bind,src=" + workspacePath + ",dst=/workspace",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "/bin/sh",
    "-lc",
    command.command,
  ];
}

export class ContainerValidationCommandExecutor
  implements ValidationCommandExecutor
{
  constructor(private readonly config: AppConfig) {}

  async execute(
    workspacePath: string,
    command: ValidationCommand,
    runId: string,
  ): Promise<ValidationCommandResult> {
    const startedAt = Date.now();
    const name = validationContainerName(runId);
    const child = spawn(
      this.config.containerEngine,
      buildValidationContainerArgs(
        workspacePath,
        command,
        runId,
        this.config,
        name,
      ),
      {
        cwd: workspacePath,
        env: this.childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let removing: Promise<void> | null = null;
    const removeContainer = () => {
      removing ??= execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", name],
        { timeout: 8_000, env: this.childEnvironment() },
      )
        .then(() => undefined)
        .catch(() => {
          child.kill("SIGKILL");
        });
      return removing;
    };
    const consume = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_VALIDATION_OUTPUT_BYTES) {
        outputExceeded = true;
        void removeContainer();
        return;
      }
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const timeout = setTimeout(() => {
      timedOut = true;
      void removeContainer();
    }, command.timeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (removing) await removing;
      return {
        exitCode,
        output: output.slice(0, MAX_VALIDATION_OUTPUT_BYTES),
        durationMs: Date.now() - startedAt,
        timedOut,
        outputExceeded,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
