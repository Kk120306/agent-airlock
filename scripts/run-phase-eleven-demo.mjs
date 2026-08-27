import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argumentsList = process.argv.slice(2);
const unknownArguments = argumentsList.filter((argument) => argument !== "--reset");
if (unknownArguments.length > 0) {
  process.stderr.write(
    "Unknown Phase 11 demo option: " + unknownArguments.join(", ") + "\n",
  );
  process.exit(1);
}

const demo = spawn(
  process.execPath,
  [path.join(projectRoot, "scripts/run-phase-ten-demo.mjs"), ...argumentsList],
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
  "Phase 11 extension: complete a Run, open Portable Trust, and generate a private-by-default signed receipt.\n",
);
process.stdout.write(
  "Download the JSON and verify it with `node packages/portable-promotion-receipt/dist/cli.js verify <file>`.\n",
);
process.stdout.write(
  "Selective evidence, the local transparency log, and digest-only EVM calldata are optional. Receipt validity never depends on an anchor.\n",
);
process.stdout.write(
  "The entire trust path is local and offline. It makes no ModelArk, provider, blockchain, wallet, or paid-service call.\n",
);

demo.once("error", (error) => {
  process.stderr.write("Phase 11 demo failed to start: " + error.message + "\n");
  process.exitCode = 1;
});

demo.once("exit", (code, signal) => {
  if (!stopping && code !== 0) {
    process.stderr.write(
      "Phase 11 demo exited with " +
        (signal ? "signal " + signal : "status " + String(code)) +
        ".\n",
    );
    process.exitCode = code ?? 1;
  }
});
