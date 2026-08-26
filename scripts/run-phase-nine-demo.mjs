import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
const unknownArguments = argumentsList.filter((argument) => argument !== "--reset");
if (unknownArguments.length > 0) {
  process.stderr.write(
    "Unknown Phase 9 demo option: " + unknownArguments.join(", ") + "\n",
  );
  process.exit(1);
}

const demo = spawn(
  process.execPath,
  [path.join(projectRoot, "scripts/run-phase-eight-demo.mjs"), ...argumentsList],
  {
    cwd: projectRoot,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: "inherit",
  },
);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    if (!demo.killed) demo.kill(signal);
  });
}

process.stdout.write(
  "Phase 9 extension: Competing Futures can compare three isolated Candidates and promote exactly one reproducible winner.\n",
);
process.stdout.write(
  "No ModelArk key, paid inference, or public blockchain transaction is used.\n",
);

demo.once("error", (error) => {
  process.stderr.write("Phase 9 demo failed to start: " + error.message + "\n");
  process.exitCode = 1;
});

demo.once("exit", (code, signal) => {
  if (!stopping && code !== 0) {
    process.stderr.write(
      "Phase 9 demo exited with " +
        (signal ? "signal " + signal : "status " + String(code)) +
        ".\n",
    );
    process.exitCode = code ?? 1;
  }
});
