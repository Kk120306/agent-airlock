import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const startupScript = fileURLToPath(
  new URL("./start-local-poc.sh", import.meta.url),
);
const child = spawn(startupScript, {
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.once("error", (error) => {
  console.error("Unable to start the local POC:", error.message);
  process.exitCode = 1;
});

child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
