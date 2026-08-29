import { spawn } from "node:child_process";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
if (argumentsList.length > 0) {
  throw new Error(
    "Unknown Phase 13 release-proof option: " + argumentsList.join(", "),
  );
}

async function commandWorks(command) {
  try {
    await execFile(command, ["info"], {
      cwd: projectRoot,
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function detectEngine() {
  const configured = process.env.CONTAINER_ENGINE?.trim();
  const candidates = configured ? [configured] : ["docker", "podman"];
  for (const candidate of candidates) {
    if (await commandWorks(candidate)) return candidate;
  }
  throw new Error(
    "Phase 13 requires a running Docker, Colima Docker context, or Podman engine",
  );
}

async function run(command, args, environment = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          command +
            " failed " +
            (signal ? "with signal " + signal : "with status " + String(code)),
        ),
      );
    });
  });
}

const engine = await detectEngine();
const image = process.env.CONTAINER_RUNTIME_IMAGE?.trim() || "volc-agent-runtime:local";
process.stdout.write(
  "Phase 13 combined Runtime proof using " + engine + " and image " + image + ".\n",
);
await run(engine, [
  "build",
  "--file",
  path.join(projectRoot, "Dockerfile.runtime"),
  "--tag",
  image,
  projectRoot,
]);
await run(
  "npm",
  ["run", "test:container-browser"],
  {
    ...process.env,
    CONTAINER_ENGINE: engine,
    CONTAINER_RUNTIME_IMAGE: image,
  },
);
process.stdout.write(
  "Phase 13 combined Runtime proof passed through the real browser-to-container-to-Promotion path.\n",
);
