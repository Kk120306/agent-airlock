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

test("the live ModelArk judge profile refuses the generic preflight bypass", () => {
  const result = spawnSync(path.resolve("scripts/start-local-poc.sh"), [], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      AIRLOCK_MODELARK_DEMO_MODE: "true",
      AIRLOCK_SKIP_MODELARK_PREFLIGHT: "true",
      ARK_API_KEY: "fixture-key",
      ARK_MODEL: "ep-fixture",
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot skip provider preflight/);
});

test("the local POC launcher exports the fallback selected by preflight", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "airlock-poc-fallback-"));
  const fakeBin = path.join(fixtureRoot, "bin");
  const nodePath = path.join(fakeBin, "node");
  const enginePath = path.join(fakeBin, "airlock-model-probe");
  const capturedModelPath = path.join(fixtureRoot, "selected-model.txt");
  const capturedProofPath = path.join(fixtureRoot, "preflight-proof.txt");

  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(fakeBin));
    await writeFile(
      nodePath,
      '#!/bin/sh\nif [ "$1" = "-p" ]; then printf "22"; exit 0; fi\nif [ "$1" = "scripts/check-modelark-live.mjs" ]; then printf \'%s\\n\' \'{"selectedModelIndex":1,"proof":{"schema":"agent-airlock/modelark-preflight-proof","schemaVersion":1,"checkedAt":"2026-08-28T02:00:00.000Z","generatedAssistantOutput":true,"modelCommitment":"sha256:model","endpointOriginCommitment":"sha256:origin","attemptCount":2,"requestCount":2,"retryDelayMs":0}}\'; exit 0; fi\nexec "$AIRLOCK_REAL_NODE" "$@"\n',
      "utf8",
    );
    await writeFile(
      enginePath,
      '#!/bin/sh\nif [ "$1" = "info" ]; then printf "%s" "$ARK_MODEL" > "$AIRLOCK_CAPTURED_MODEL"; printf "%s" "$AIRLOCK_MODELARK_PREFLIGHT_PROOF" > "$AIRLOCK_CAPTURED_PROOF"; exit 1; fi\nexit 98\n',
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
        AIRLOCK_CAPTURED_PROOF: capturedProofPath,
        AIRLOCK_REAL_NODE: process.execPath,
        ARK_API_KEY: "fixture-key",
        ARK_MODEL: "ep-primary",
        ARK_MODEL_FALLBACKS: "ep-selected-fallback",
        CONTAINER_ENGINE: "airlock-model-probe",
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });

    assert.equal(result.status, 1);
    assert.equal(await readFile(capturedModelPath, "utf8"), "ep-selected-fallback");
    assert.deepEqual(JSON.parse(await readFile(capturedProofPath, "utf8")), {
      schema: "agent-airlock/modelark-preflight-proof",
      schemaVersion: 1,
      checkedAt: "2026-08-28T02:00:00.000Z",
      generatedAssistantOutput: true,
      modelCommitment: "sha256:model",
      endpointOriginCommitment: "sha256:origin",
      attemptCount: 2,
      requestCount: 2,
      retryDelayMs: 0,
    });
    assert.match(result.stderr, /Using the operator-approved ModelArk fallback/);
    assert.doesNotMatch(
      result.stderr,
      /modelark-preflight-proof|sha256:model|sha256:origin|ep-primary|ep-selected-fallback/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
