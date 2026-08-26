import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
const unknownArguments = argumentsList.filter((argument) => argument !== "--reset");
if (unknownArguments.length > 0) {
  process.stderr.write(
    "Unknown Phase 8 demo option: " + unknownArguments.join(", ") + "\n",
  );
  process.exit(1);
}

const provider = spawn(
  process.execPath,
  [path.join(projectRoot, "packages/http-object-resource/dist/fixture-server-process.js")],
  {
    cwd: projectRoot,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let providerError = "";
provider.stderr.on("data", (chunk) => {
  providerError = (providerError + chunk.toString("utf8")).slice(-4_096);
});

let demo = null;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    if (demo && !demo.killed) demo.kill(signal);
    if (!provider.killed) provider.kill(signal);
  });
}

try {
  const ready = await readProviderReady(provider, () => providerError);
  demo = spawn(
    process.execPath,
    [path.join(projectRoot, "scripts/run-demo.mjs"), ...argumentsList],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        AIRLOCK_HTTP_OBJECT_URL: ready.baseUrl,
        AIRLOCK_HTTP_OBJECT_VERSION_ID: ready.initialVersion.versionId,
        AIRLOCK_HTTP_OBJECT_FINGERPRINT: ready.initialVersion.fingerprint,
      },
      stdio: "inherit",
    },
  );
  process.stdout.write(
    "Phase 8 extension: credential-free remote object provider is active.\n",
  );
  const outcome = await childOutcome(demo);
  if (!stopping && outcome.code !== 0) process.exitCode = outcome.code ?? 1;
} catch (error) {
  process.stderr.write(
    "Phase 8 demo failed before readiness: " +
      (error instanceof Error ? error.message : String(error)) +
      "\n",
  );
  process.exitCode = 1;
} finally {
  if (demo && demo.exitCode === null && !demo.killed) demo.kill("SIGTERM");
  if (provider.exitCode === null && !provider.killed) provider.kill("SIGTERM");
  await Promise.all([waitForExit(demo), waitForExit(provider)]);
}

async function readProviderReady(child, readError) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error("remote object provider fixture timed out"));
    }, 5_000);
    timeout.unref();
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        const value = JSON.parse(output.slice(0, newline));
        if (
          typeof value?.baseUrl !== "string" ||
          typeof value?.initialVersion?.versionId !== "string" ||
          typeof value?.initialVersion?.fingerprint !== "string"
        ) {
          throw new Error("provider readiness payload was incomplete");
        }
        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(
        new Error(
          readError().trim() || "remote object provider fixture exited before readiness",
        ),
      );
    });
  });
}

function childOutcome(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: 1, error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForExit(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1_000);
    timeout.unref();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
