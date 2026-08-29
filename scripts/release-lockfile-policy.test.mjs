import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  approvedReleaseLockfile,
  releaseLockfileDependencyFindings,
} from "./release-lockfile-policy.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifestPaths = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/http-object-resource/package.json",
  "packages/portable-promotion-receipt/package.json",
  "packages/transactional-resource-sdk/package.json",
];

const packageLock = JSON.parse(
  await readFile(path.join(projectRoot, "package-lock.json"), "utf8"),
);
const manifestsByPath = Object.fromEntries(
  await Promise.all(
    manifestPaths.map(async (manifestPath) => [
      manifestPath,
      JSON.parse(
        await readFile(path.join(projectRoot, manifestPath), "utf8"),
      ),
    ]),
  ),
);

test("accepts the release manifests only when their dependency specs match the lockfile", () => {
  assert.equal(approvedReleaseLockfile(packageLock, manifestsByPath), true);
  assert.deepEqual(
    releaseLockfileDependencyFindings(packageLock, manifestsByPath),
    [],
  );
});

test("rejects a root concurrently spec that was changed without regenerating the lockfile", () => {
  const changedManifests = structuredClone(manifestsByPath);
  changedManifests["package.json"].devDependencies.concurrently = "^99.0.0";

  assert.deepEqual(
    releaseLockfileDependencyFindings(packageLock, changedManifests),
    [
      "package.json devDependencies.concurrently does not match package-lock.json",
    ],
  );
});

test("rejects a workspace dependency spec that was changed without regenerating the lockfile", () => {
  const changedManifests = structuredClone(manifestsByPath);
  changedManifests["apps/server/package.json"].dependencies.fastify = "^99.0.0";

  assert.deepEqual(
    releaseLockfileDependencyFindings(packageLock, changedManifests),
    [
      "apps/server/package.json dependencies.fastify does not match package-lock.json",
    ],
  );
});

test("rejects stale lockfile dependencies and missing workspace package entries", () => {
  const staleLock = structuredClone(packageLock);
  staleLock.packages["apps/web"].dependencies["stale-release-dependency"] =
    "1.0.0";
  assert.deepEqual(
    releaseLockfileDependencyFindings(staleLock, manifestsByPath),
    [
      "package-lock.json complete resolved graph differs from the reviewed digest",
      "apps/web/package.json dependencies.stale-release-dependency does not match package-lock.json",
    ],
  );

  const missingWorkspaceLock = structuredClone(packageLock);
  delete missingWorkspaceLock.packages["apps/server"];
  assert.deepEqual(
    releaseLockfileDependencyFindings(
      missingWorkspaceLock,
      manifestsByPath,
    ),
    [
      "package-lock.json complete resolved graph differs from the reviewed digest",
      "apps/server/package.json has no matching package-lock.json packages entry",
    ],
  );
});

test("rejects deletion or forgery anywhere in the complete resolved lock graph", () => {
  for (const mutate of [
    (lock) => delete lock.packages["node_modules/concurrently"],
    (lock) => {
      lock.packages["node_modules/concurrently"].version = "99.0.0";
    },
    (lock) => delete lock.packages["node_modules/chalk"],
    (lock) => {
      lock.packages["node_modules/concurrently"].integrity = "sha512-AAAA";
    },
  ]) {
    const changedLock = structuredClone(packageLock);
    mutate(changedLock);
    assert.equal(
      approvedReleaseLockfile(changedLock, manifestsByPath),
      false,
    );
    assert.equal(
      releaseLockfileDependencyFindings(changedLock, manifestsByPath).includes(
        "package-lock.json complete resolved graph differs from the reviewed digest",
      ),
      true,
    );
  }
});

test("fails closed on malformed dependency maps", () => {
  const malformedLock = structuredClone(packageLock);
  malformedLock.packages[""].devDependencies = ["concurrently"];

  assert.deepEqual(
    releaseLockfileDependencyFindings(malformedLock, manifestsByPath),
    [
      "package-lock.json complete resolved graph differs from the reviewed digest",
      "package-lock.json packages[\"\"] devDependencies must be an object",
    ],
  );
});
