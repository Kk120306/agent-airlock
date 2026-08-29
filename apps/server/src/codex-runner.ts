import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { resourceEnvironmentName } from "./resource-registry.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export function buildCodexEnvironment(
  config: AppConfig,
  codexHomePath: string,
  outboxPath?: string,
  repairReferencePath?: string | null,
  resourceBindings: RunnerRequest["resourceBindings"] = [],
  tokenBudget: RunnerRequest["tokenBudget"] = undefined,
): NodeJS.ProcessEnv {
  const inheritedNames = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "TERM",
  ] as const;
  const environment: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHomePath,
    ARK_API_KEY: config.arkApiKey,
    NO_COLOR: "1",
    ...(outboxPath ? { AIRLOCK_OUTBOX_PATH: outboxPath } : {}),
    ...(repairReferencePath
      ? { AIRLOCK_REPAIR_REFERENCE_PATH: repairReferencePath }
      : {}),
    ...(config.demoMode && tokenBudget
      ? {
          AIRLOCK_MAXIMUM_TOTAL_TOKENS: String(
            tokenBudget.maximumTotalTokens,
          ),
        }
      : {}),
  };
  for (const binding of resourceBindings) {
    environment[resourceEnvironmentName(binding.providerId)] = binding.hostPath;
  }
  for (const name of inheritedNames) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
  outboxDirectory = path.dirname(request.outboxPath),
  repairReferencePath = request.repairReferencePath,
  resourcePaths = request.resourceBindings?.map((binding) => binding.hostPath) ?? [],
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
    "--add-dir",
    outboxDirectory,
    ...(repairReferencePath ? ["--add-dir", repairReferencePath] : []),
    ...resourcePaths.flatMap((resourcePath) => ["--add-dir", resourcePath]),
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export function parseCodexEventLine(line: string, parsed: ParsedEvents): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
  }
}

export class CodexRunner implements AgentRunner {
  readonly tokenBudgetEnforcement: "provider-boundary" | undefined;
  private readonly active = new Map<
    string,
    {
      agentId: string;
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {
    this.tokenBudgetEnforcement = config.demoMode
      ? "provider-boundary"
      : undefined;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: buildCodexEnvironment(this.config, this.config.codexHome),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string, executionId?: string): Promise<boolean> {
    const scoped = executionId ? this.active.get(executionId) : null;
    const active = scoped
      ? scoped.agentId === agentId
        ? [scoped]
        : []
      : executionId
        ? []
        : [...this.active.values()].filter(
            (execution) => execution.agentId === agentId,
          );
    if (active.length === 0) return false;
    for (const execution of active) {
      execution.cancelled = true;
      this.terminate(execution);
    }
    await Promise.all(active.map((execution) => execution.settled));
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const executionId = request.executionId ?? request.agentId;
    if (this.active.has(executionId)) {
      throw new Error("Execution already has an active Codex process");
    }
    if (request.resourceBindings?.some((binding) => binding.access === "read-only")) {
      throw new Error(
        "Local-process Runtime cannot enforce read-only Transactional Resource bindings",
      );
    }

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: buildCodexEnvironment(
        this.config,
        request.codexHomePath,
        request.outboxPath,
        request.repairReferencePath,
        request.resourceBindings,
        request.tokenBudget,
      ),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      agentId: request.agentId,
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(executionId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(line, parsed);
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed);
      }
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      assertTrustedTokenBudget(request, parsed.usage);
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(executionId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

}

export function assertTrustedTokenBudget(
  request: RunnerRequest,
  usage: RunUsage | null,
): void {
  if (!request.tokenBudget) return;
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (
    request.tokenBudget.schemaVersion !== 1 ||
    !Number.isSafeInteger(request.tokenBudget.maximumTotalTokens) ||
    request.tokenBudget.maximumTotalTokens < 1 ||
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    (inputTokens ?? -1) < 0 ||
    (outputTokens ?? -1) < 0
  ) {
    throw new Error("Codex omitted trusted total-token budget evidence");
  }
  if (
    (inputTokens as number) + (outputTokens as number) >
    request.tokenBudget.maximumTotalTokens
  ) {
    throw new Error("Codex exceeded its reserved total-token allowance");
  }
}
