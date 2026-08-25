import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import type { ValidationCommand } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_VALIDATION_OUTPUT_BYTES = 65_536;

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
