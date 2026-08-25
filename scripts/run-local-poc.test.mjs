import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
