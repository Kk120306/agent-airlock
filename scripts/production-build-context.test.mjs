import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Writable } from "node:stream";

import {
  materializeProductionBuildContext,
  streamProductionBuildContext,
} from "./production-build-context.mjs";

const execFile = promisify(execFileCallback);

async function withRepository(operation) {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "airlock-production-context-"),
  );
  const projectRoot = path.join(fixtureRoot, "project");
  const git = (argumentsList, options = {}) =>
    execFile("/usr/bin/git", argumentsList, {
      cwd: projectRoot,
      encoding: "utf8",
      ...options,
    });
  try {
    await mkdir(path.join(projectRoot, "apps/web/public"), { recursive: true });
    await mkdir(path.join(projectRoot, "apps/server/src"), { recursive: true });
    await mkdir(path.join(projectRoot, "scripts"), { recursive: true });
    await execFile("/usr/bin/git", ["init", "-b", "main", projectRoot]);
    await git(["config", "user.email", "airlock@example.test"]);
    await git(["config", "user.name", "Agent Airlock Test"]);
    await git([
      "remote",
      "add",
      "origin",
      "https://github.com/Kk120306/agent-airlock.git",
    ]);
    await Promise.all([
      writeFile(
        path.join(projectRoot, ".gitignore"),
        "apps/web/public/.env.*\n",
      ),
      writeFile(path.join(projectRoot, "Dockerfile"), "COPY apps ./apps\n"),
      writeFile(
        path.join(projectRoot, "apps/web/public/tracked.txt"),
        "tracked:$Format:%H$\n",
      ),
      writeFile(
        path.join(projectRoot, "apps/server/src/tracked.ts"),
        "export const tracked = true;\n",
      ),
      writeFile(
        path.join(projectRoot, "scripts/executable.sh"),
        "#!/usr/bin/env bash\nexit 0\n",
      ),
    ]);
    await chmod(path.join(projectRoot, "scripts/executable.sh"), 0o755);
    await git(["add", "."]);
    await git(["commit", "-m", "accepted production source"]);
    await operation({ fixtureRoot, git, projectRoot });
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
}

test("materializes only exact committed HEAD bytes for the Docker context", async () => {
  await withRepository(async ({ fixtureRoot, git, projectRoot }) => {
    await writeFile(
      path.join(projectRoot, ".git/info/exclude"),
      "apps/server/src/ignored-build-input.ts\n",
    );
    await Promise.all([
      writeFile(
        path.join(projectRoot, "apps/web/public/.env.production.local"),
        "PUBLIC_SECRET=must-not-ship\n",
      ),
      writeFile(
        path.join(projectRoot, "apps/server/src/ignored-build-input.ts"),
        "export const ignoredSecret = 'must-not-ship';\n",
      ),
    ]);
    const { stdout: status } = await git([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    assert.equal(
      status,
      "",
      "the exploit fixture must be invisible to Git status",
    );

    const archivePath = path.join(fixtureRoot, "production-context.tar");
    const result = await materializeProductionBuildContext({
      archivePath,
      projectRoot,
    });
    const { stdout: listing } = await execFile("tar", ["-tf", archivePath], {
      encoding: "utf8",
    });
    assert.match(listing, /^Dockerfile$/mu);
    assert.match(listing, /^apps\/web\/public\/tracked\.txt$/mu);
    assert.doesNotMatch(listing, /\.env\.production\.local/u);
    assert.doesNotMatch(listing, /ignored-build-input\.ts/u);
    assert.match(result.commitOid, /^[a-f0-9]{40}$/u);
    assert.match(result.treeOid, /^[a-f0-9]{40}$/u);
    assert.equal(result.archiveBytes, (await readFile(archivePath)).length);
    const streamed = [];
    await streamProductionBuildContext({
      archivePath,
      expectedSha256: result.archiveSha256,
      output: new Writable({
        write(chunk, _encoding, callback) {
          streamed.push(Buffer.from(chunk));
          callback();
        },
      }),
    });
    assert.deepEqual(Buffer.concat(streamed), await readFile(archivePath));
  });
});

test("rejects local archive attributes that rewrite or omit committed bytes", async () => {
  await withRepository(async ({ fixtureRoot, projectRoot }) => {
    const attributesPath = path.join(projectRoot, ".git/info/attributes");
    await writeFile(
      attributesPath,
      "apps/web/public/tracked.txt export-subst\n",
    );
    await assert.rejects(
      materializeProductionBuildContext({
        archivePath: path.join(fixtureRoot, "substituted-context.tar"),
        projectRoot,
      }),
      /file bytes do not match HEAD/u,
    );

    await writeFile(
      attributesPath,
      "apps/server/src/tracked.ts export-ignore\n",
    );
    await assert.rejects(
      materializeProductionBuildContext({
        archivePath: path.join(fixtureRoot, "omitted-context.tar"),
        projectRoot,
      }),
      /archive does not match the HEAD tree/u,
    );
  });
});

test("fails closed if committed HEAD changes while the context is materialized", async () => {
  await withRepository(async ({ fixtureRoot, git, projectRoot }) => {
    let changed = false;
    const execute = async (command, argumentsList, options) => {
      const result = await execFile(command, argumentsList, options);
      if (!changed && argumentsList[0] === "archive") {
        changed = true;
        await writeFile(
          path.join(projectRoot, "apps/server/src/tracked.ts"),
          "export const tracked = 'new commit';\n",
        );
        await git(["add", "apps/server/src/tracked.ts"]);
        await git(["commit", "-m", "move HEAD during context capture"]);
      }
      return result;
    };
    await assert.rejects(
      materializeProductionBuildContext({
        archivePath: path.join(fixtureRoot, "drifted-context.tar"),
        exec: execute,
        projectRoot,
      }),
      /source changed during execution/u,
    );
  });
});

test("rejects ordinary uncommitted build inputs instead of claiming HEAD", async () => {
  await withRepository(async ({ fixtureRoot, projectRoot }) => {
    await writeFile(
      path.join(projectRoot, "ordinary-untracked.txt"),
      "drift\n",
    );
    await assert.rejects(
      materializeProductionBuildContext({
        archivePath: path.join(fixtureRoot, "dirty-context.tar"),
        projectRoot,
      }),
      /clean source tree/u,
    );
  });
});

test("refuses to stream archive bytes that changed after validation", async () => {
  await withRepository(async ({ fixtureRoot, projectRoot }) => {
    const archivePath = path.join(fixtureRoot, "changed-context.tar");
    const result = await materializeProductionBuildContext({
      archivePath,
      projectRoot,
    });
    const bytes = await readFile(archivePath);
    bytes[tarMutationOffset(bytes)] ^= 0x01;
    await writeFile(archivePath, bytes);
    await assert.rejects(
      streamProductionBuildContext({
        archivePath,
        expectedSha256: result.archiveSha256,
        output: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      }),
      /changed while streaming/u,
    );
  });
});

function tarMutationOffset(bytes) {
  const minimum = 1024;
  assert.ok(bytes.length > minimum);
  return minimum;
}
