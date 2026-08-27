import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkModelArkLive } from "./check-modelark-live.mjs";

const execFile = promisify(execFileCallback);
const MINIMUM_NODE_MAJOR = 22;
const COMMAND_TIMEOUT_MS = 10_000;
const SESSION_PROBE_TIMEOUT_MS = 45_000;
const sessionProbe = fileURLToPath(
  new URL("./probe-codex-session.sh", import.meta.url),
);
const protocolProbe = fileURLToPath(
  new URL("./probe-codex-protocol.sh", import.meta.url),
);

function configured(environment, name) {
  const value = environment[name]?.trim() ?? "";
  return value.length > 0 && !value.startsWith("replace-");
}

function check(id, label, status, detail) {
  return { id, label, status, detail };
}

async function commandSucceeds(
  commandImplementation,
  command,
  args,
  options = {},
) {
  try {
    await commandImplementation(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
      ...options,
    });
    return true;
  } catch {
    return false;
  }
}

async function findEngine(environment, commandImplementation) {
  const configuredEngine = environment.CONTAINER_ENGINE?.trim();
  const candidates = configuredEngine ? [configuredEngine] : ["docker", "podman"];
  for (const candidate of candidates) {
    if (
      await commandSucceeds(commandImplementation, candidate, ["info"])
    ) {
      return candidate;
    }
  }
  return null;
}

export async function inspectPocReadiness({
  environment = process.env,
  commandImplementation = execFile,
  modelArkCheck = checkModelArkLive,
  nodeVersion = process.versions.node,
} = {}) {
  const checks = [];
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  checks.push(
    check(
      "node",
      "Node.js runtime",
      nodeMajor >= MINIMUM_NODE_MAJOR ? "pass" : "fail",
      nodeMajor >= MINIMUM_NODE_MAJOR
        ? "Node.js meets the 22+ requirement."
        : "Install Node.js 22 or newer.",
    ),
  );

  const hasApiKey = configured(environment, "ARK_API_KEY");
  const hasModel = configured(environment, "ARK_MODEL");
  checks.push(
    check(
      "credentials",
      "ModelArk configuration",
      hasApiKey && hasModel ? "pass" : "fail",
      hasApiKey && hasModel
        ? "An Ark model API key and model identifier are configured. Values are hidden."
        : "Configure ARK_API_KEY and ARK_MODEL in the repository .env file.",
    ),
  );

  if (hasApiKey && hasModel) {
    try {
      const result = await modelArkCheck({ environment });
      checks.push(
        check(
          "modelark",
          "Live ModelArk response",
          "pass",
          `A Responses API request completed after ${result.attemptCount} bounded model attempt${result.attemptCount === 1 ? "" : "s"}, ${result.requestCount ?? result.attemptCount} request${(result.requestCount ?? result.attemptCount) === 1 ? "" : "s"}, and ${result.retryDelayMs ?? 0} ms of provider-directed warm-up. No output or credential was printed.`,
        ),
      );
    } catch (error) {
      checks.push(
        check(
          "modelark",
          "Live ModelArk response",
          "fail",
          error instanceof Error
            ? error.message
            : "The live ModelArk preflight failed.",
        ),
      );
    }
  } else {
    checks.push(
      check(
        "modelark",
        "Live ModelArk response",
        "skip",
        "Skipped until ModelArk configuration is present.",
      ),
    );
  }

  const engine = await findEngine(environment, commandImplementation);
  checks.push(
    check(
      "engine",
      "Container engine",
      engine ? "pass" : "fail",
      engine
        ? "A running Docker-compatible engine is available."
        : "Start Docker, Colima, or Podman.",
    ),
  );

  const runtimeImage =
    environment.CONTAINER_RUNTIME_IMAGE?.trim() || "volc-agent-runtime:local";
  if (!engine) {
    checks.push(
      check(
        "image",
        "Agent Runtime image",
        "skip",
        "Skipped until a container engine is available.",
      ),
      check(
        "runtime",
        "Codex Runtime launch",
        "skip",
        "Skipped until a container engine is available.",
      ),
      check(
        "session",
        "Candidate session isolation",
        "skip",
        "Skipped until a container engine is available.",
      ),
      check(
        "protocol",
        "Codex tool protocol",
        "skip",
        "Skipped until a container engine is available.",
      ),
    );
  } else {
    const imageReady = await commandSucceeds(commandImplementation, engine, [
      "image",
      "inspect",
      runtimeImage,
    ]);
    checks.push(
      check(
        "image",
        "Agent Runtime image",
        imageReady ? "pass" : "fail",
        imageReady
          ? "The configured Runtime image is present."
          : "The Runtime image is missing. Run npm run poc to build it.",
      ),
    );
    if (!imageReady) {
      checks.push(
        check(
          "runtime",
          "Codex Runtime launch",
          "skip",
          "Skipped until the Runtime image is built.",
        ),
        check(
          "session",
          "Candidate session isolation",
          "skip",
          "Skipped until the Runtime image is built.",
        ),
        check(
          "protocol",
          "Codex tool protocol",
          "skip",
          "Skipped until the Runtime image is built.",
        ),
      );
    } else {
      const runtimeReady = await commandSucceeds(commandImplementation, engine, [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--env",
        "CODEX_HOME=/tmp/codex-home",
        runtimeImage,
        "sh",
        "-lc",
        "mkdir -p /tmp/codex-home && codex --version >/dev/null",
      ]);
      checks.push(
        check(
          "runtime",
          "Codex Runtime launch",
          runtimeReady ? "pass" : "fail",
          runtimeReady
            ? "Codex launches inside the hardened disposable container profile."
            : "The Runtime image exists but Codex did not launch successfully.",
        ),
      );
      const sessionReady = await commandSucceeds(
        commandImplementation,
        "bash",
        [sessionProbe],
        {
          timeout: SESSION_PROBE_TIMEOUT_MS,
          env: {
            ...process.env,
            CONTAINER_ENGINE: engine,
            CONTAINER_RUNTIME_IMAGE: runtimeImage,
          },
        },
      );
      checks.push(
        check(
          "session",
          "Candidate session isolation",
          sessionReady ? "pass" : "fail",
          sessionReady
            ? "A copied Candidate CODEX_HOME resumed its thread without mutating the source, while an empty home could not resume it."
            : "The Runtime could not prove isolated Codex session copy and resume behavior.",
        ),
      );
      const protocolReady = await commandSucceeds(
        commandImplementation,
        "bash",
        [protocolProbe],
        {
          timeout: SESSION_PROBE_TIMEOUT_MS,
          env: {
            ...process.env,
            CONTAINER_ENGINE: engine,
            CONTAINER_RUNTIME_IMAGE: runtimeImage,
          },
        },
      );
      checks.push(
        check(
          "protocol",
          "Codex tool protocol",
          protocolReady ? "pass" : "fail",
          protocolReady
            ? "Real Codex completed a two-turn Responses tool call and wrote only to a mounted Candidate workspace."
            : "Real Codex could not complete the local Responses tool-call probe.",
        ),
      );
    }
  }

  return {
    ready: checks.every((item) => item.status === "pass"),
    checks,
  };
}

function render(report) {
  const glyph = { pass: "PASS", fail: "FAIL", skip: "SKIP" };
  for (const item of report.checks) {
    console.log(`[${glyph[item.status]}] ${item.label}: ${item.detail}`);
  }
  console.log(
    report.ready
      ? "[READY] The live Agent Airlock POC prerequisites are proven."
      : "[NOT READY] Fix failed checks, then rerun npm run poc:doctor.",
  );
}

async function main() {
  const report = await inspectPocReadiness();
  render(report);
  if (!report.ready) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      "[FAIL] Readiness inspection failed safely. No credential values were printed.",
    );
    process.exitCode = 1;
  });
}
