import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("the local POC launcher passes .env values to the startup script", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-poc-env-"));
  const fixtureEnv = path.join(fixtureRoot, ".env");

  try {
    await writeFile(
      fixtureEnv,
      "ARK_API_KEY=fixture-key\nARK_MODEL=ep-fixture\n",
      "utf8",
    );
    const environment = { ...process.env };
    delete environment.ARK_API_KEY;
    delete environment.ARK_MODEL;
    environment.CONTAINER_ENGINE = "airlock-env-probe-no-such-engine";
    environment.AIRLOCK_SKIP_MODELARK_PREFLIGHT = "true";

    const result = spawnSync(
      process.execPath,
      [
        `--env-file=${fixtureEnv}`,
        path.resolve("scripts/run-local-poc.mjs"),
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: environment,
      },
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CONTAINER_ENGINE=airlock-env-probe-no-such-engine was not found/,
    );
    assert.doesNotMatch(result.stderr, /ARK_API_KEY and ARK_MODEL are required/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("the local POC launcher exports the fallback selected by preflight", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-poc-fallback-"));
  const fakeBin = path.join(fixtureRoot, "bin");
  const nodePath = path.join(fakeBin, "node");
  const enginePath = path.join(fakeBin, "airlock-model-probe");
  const capturedModelPath = path.join(fixtureRoot, "selected-model.txt");

  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(fakeBin));
    await writeFile(
      nodePath,
      '#!/bin/sh\nif [ "$1" = "-p" ]; then printf "22"; exit 0; fi\nif [ "$1" = "scripts/check-modelark-live.mjs" ]; then printf "ep-selected-fallback\\n"; exit 0; fi\nexit 97\n',
      "utf8",
    );
    await writeFile(
      enginePath,
      '#!/bin/sh\nif [ "$1" = "info" ]; then printf "%s" "$ARK_MODEL" > "$AIRLOCK_CAPTURED_MODEL"; exit 1; fi\nexit 98\n',
      "utf8",
    );
    await chmod(nodePath, 0o755);
    await chmod(enginePath, 0o755);

    const result = spawnSync(path.resolve("scripts/start-local-poc.sh"), [], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        AIRLOCK_CAPTURED_MODEL: capturedModelPath,
        ARK_API_KEY: "fixture-key",
        ARK_MODEL: "ep-primary",
        ARK_MODEL_FALLBACKS: "ep-selected-fallback",
        CONTAINER_ENGINE: "airlock-model-probe",
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });

    assert.equal(result.status, 1);
    assert.equal(await readFile(capturedModelPath, "utf8"), "ep-selected-fallback");
    assert.match(result.stderr, /Using the operator-approved ModelArk fallback/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
