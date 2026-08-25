import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
const unknownArguments = argumentsList.filter((argument) => argument !== "--reset");
if (unknownArguments.length > 0) {
  console.error("Unknown demo option: " + unknownArguments.join(", "));
  process.exit(1);
}

const resetRequested = argumentsList.includes("--reset");
const host = "127.0.0.1";
const port = Number.parseInt(process.env.AIRLOCK_DEMO_PORT ?? "3199", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("AIRLOCK_DEMO_PORT must be an integer from 1 through 65535.");
  process.exit(1);
}

const demoRoot = path.resolve(
  process.env.AIRLOCK_DEMO_DATA_ROOT ??
    path.join(projectRoot, ".local", "airlock-demo"),
);
const forbiddenResetTargets = new Set([
  path.parse(demoRoot).root,
  projectRoot,
  os.homedir(),
]);
const markerPath = path.join(demoRoot, ".agent-airlock-demo-root");
const markerContent = "Agent Airlock deterministic demo state\n";
const legacyManagedRoots = new Set([
  path.join(projectRoot, ".local", "airlock-demo"),
  path.join(projectRoot, ".e2e-demo"),
]);

const portAvailable = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.unref();
  probe.once("error", () => resolve(false));
  probe.listen({ host, port, exclusive: true }, () => {
    probe.close(() => resolve(true));
  });
});
if (!portAvailable) {
  console.error(
    "Agent Airlock demo could not start because http://" +
      host +
      ":" +
      port +
      " is already in use.",
  );
  console.error("Set AIRLOCK_DEMO_PORT to another unused loopback port.");
  process.exit(1);
}

if (forbiddenResetTargets.has(demoRoot) || path.dirname(demoRoot) === demoRoot) {
  console.error("Refusing to use an unsafe demo data root: " + demoRoot);
  process.exit(1);
}
const existingEntries = await readdir(demoRoot).catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
if (existingEntries && existingEntries.length > 0) {
  const existingMarker = await readFile(markerPath, "utf8").catch(() => null);
  if (existingMarker !== markerContent && !legacyManagedRoots.has(demoRoot)) {
    console.error("Refusing to use a non-Airlock demo data root: " + demoRoot);
    process.exit(1);
  }
}
if (resetRequested) {
  await rm(demoRoot, { recursive: true, force: true });
}
await mkdir(demoRoot, { recursive: true });
await writeFile(markerPath, markerContent, { encoding: "utf8", mode: 0o600 });

const child = spawn(process.execPath, [path.join(projectRoot, "apps/server/dist/index.js")], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: host,
    PORT: String(port),
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    APP_DATA_DIR: path.join(demoRoot, "data"),
    AGENT_WORKSPACE_ROOT: path.join(demoRoot, "workspaces"),
    CODEX_HOME: path.join(demoRoot, "codex-template"),
    CODEX_BIN: path.join(projectRoot, "tests", "fixtures", "fake-codex.mjs"),
    ARK_API_KEY: "deterministic-local-fixture",
    ARK_MODEL: "local-airlock-demo",
    ARK_BASE_URL: "http://127.0.0.1:1/api/v3",
    RUNTIME_PROVIDER: "local-process",
    AIRLOCK_DEMO_MODE: "true",
    RUNTIME_INSTANCE_ID: "airlock-demo",
  },
  stdio: "inherit",
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    if (!child.killed) child.kill(signal);
  });
}

const childExit = new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: 1, error }));
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

const url = "http://" + host + ":" + port;
let ready = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  const outcome = await Promise.race([
    fetch(url + "/api/health")
      .then((response) => (response.ok ? "ready" : "waiting"))
      .catch(() => "waiting"),
    childExit.then(() => "exited"),
  ]);
  if (outcome === "ready") {
    ready = true;
    break;
  }
  if (outcome === "exited") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (!ready) {
  if (!child.killed) child.kill("SIGTERM");
  const outcome = await childExit;
  console.error(
    "Agent Airlock demo failed before it became ready" +
      (outcome.error instanceof Error ? ": " + outcome.error.message : "."),
  );
  process.exitCode = 1;
} else {
  console.log("");
  console.log("Agent Airlock deterministic demo is ready: " + url);
  console.log("Inference: local protocol fixture only. No ModelArk request or paid inference.");
  console.log("State: " + demoRoot);
  console.log("Hero path:");
  console.log("  1. Promote the multi-resource release.");
  console.log("  2. Quarantine the destructive future and compare fingerprints.");
  console.log("  3. Repair the retained future from bounded evidence.");
  console.log("  4. Continue from the repaired Canonical State.");
  console.log("Restart preserves this demo state. Use npm run demo -- --reset for a clean story.");
  console.log("");
  const outcome = await childExit;
  if (outcome.error instanceof Error) {
    console.error("Agent Airlock demo process failed: " + outcome.error.message);
    process.exitCode = 1;
  } else if (!stopping && outcome.code !== 0) {
    process.exitCode = outcome.code ?? 1;
  }
}
