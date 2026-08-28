import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeManagedRoot,
  buildLiveModelArkDemoEnvironment,
  liveModelArkPrompt,
  seedLiveModelArkDemo,
} from "./modelark-demo-profile.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
const unknownArguments = argumentsList.filter((argument) => argument !== "--reset");
if (unknownArguments.length > 0) {
  throw new Error("Unknown ModelArk demo option: " + unknownArguments.join(", "));
}

const resetRequested = argumentsList.includes("--reset");
const host = "127.0.0.1";
const port = Number.parseInt(process.env.AIRLOCK_MODELARK_DEMO_PORT ?? "3201", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("AIRLOCK_MODELARK_DEMO_PORT must be an integer from 1 through 65535");
}

const stateRoot = assertSafeManagedRoot(
  projectRoot,
  process.env.AIRLOCK_MODELARK_DEMO_DATA_ROOT ??
    path.join(projectRoot, ".local", "airlock-modelark-demo"),
);
const markerPath = path.join(stateRoot, ".agent-airlock-modelark-demo-root");
const markerContent = "Agent Airlock live ModelArk demo state\n";

const existingEntries = await readdir(stateRoot).catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
if (existingEntries && existingEntries.length > 0) {
  const marker = await readFile(markerPath, "utf8").catch(() => null);
  if (marker !== markerContent) {
    throw new Error("Refusing to use a non-Airlock ModelArk demo data root: " + stateRoot);
  }
}
if (resetRequested) await rm(stateRoot, { recursive: true, force: true });
await mkdir(stateRoot, { recursive: true });
await writeFile(markerPath, markerContent, { encoding: "utf8", mode: 0o600 });

const portAvailable = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.unref();
  probe.once("error", () => resolve(false));
  probe.listen({ host, port, exclusive: true }, () => {
    probe.close(() => resolve(true));
  });
});
if (!portAvailable) {
  throw new Error(`The live ModelArk demo port is already in use: http://${host}:${port}`);
}

const child = spawn(path.join(projectRoot, "scripts", "start-local-poc.sh"), [], {
  cwd: projectRoot,
  env: buildLiveModelArkDemoEnvironment(process.env, { host, port, stateRoot }),
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

const baseUrl = `http://${host}:${port}`;
let ready = false;
for (let attempt = 0; attempt < 1_200; attempt += 1) {
  const outcome = await Promise.race([
    fetch(baseUrl + "/api/health")
      .then((response) => (response.ok ? "ready" : "waiting"))
      .catch(() => "waiting"),
    childExit.then(() => "exited"),
  ]);
  if (outcome === "ready") {
    ready = true;
    break;
  }
  if (outcome === "exited") break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

if (!ready) {
  if (!child.killed) child.kill("SIGTERM");
  const outcome = await childExit;
  throw outcome.error instanceof Error
    ? outcome.error
    : new Error("The live ModelArk demo failed its preflight or startup checks");
}

try {
  await seedLiveModelArkDemo(baseUrl);
  console.log("");
  console.log("Agent Airlock live ModelArk proof is ready: " + baseUrl);
  console.log("Inference: provider-backed ModelArk Responses API.");
  console.log("Runtime: real Codex CLI in a disposable container.");
  console.log("Judge action: Run live Candidate.");
  console.log("Falsifiable artifact: modelark-proof.txt must contain exactly modelark-live.");
  console.log("Prompt: " + liveModelArkPrompt);
  console.log("State persists across restart. Add --reset for a clean proof.");
  console.log("");
} catch (error) {
  if (!child.killed) child.kill("SIGTERM");
  throw error;
}

const outcome = await childExit;
if (outcome.error instanceof Error) throw outcome.error;
if (!stopping && outcome.code !== 0) process.exitCode = outcome.code ?? 1;
