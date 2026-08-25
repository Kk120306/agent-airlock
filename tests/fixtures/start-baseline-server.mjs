import { rm } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const testRoot = path.join(projectRoot, ".e2e-baseline");

await rm(testRoot, { recursive: true, force: true });

Object.assign(process.env, {
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  PORT: "3199",
  LOG_LEVEL: "warn",
  APP_DATA_DIR: path.join(testRoot, "data"),
  AGENT_WORKSPACE_ROOT: path.join(testRoot, "workspaces"),
  CODEX_HOME: path.join(testRoot, "codex-home"),
  CODEX_BIN: path.join(projectRoot, "tests", "fixtures", "fake-codex.mjs"),
  ARK_API_KEY: "baseline-fixture-key",
  ARK_MODEL: "ep-baseline-fixture",
  RUNTIME_PROVIDER: "local-process",
});

await import("../../apps/server/dist/index.js");
