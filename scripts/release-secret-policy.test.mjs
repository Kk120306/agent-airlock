import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  highConfidenceReachableGitObjectFindings,
  highConfidenceSecretFindings,
} from "./release-secret-policy.mjs";
import { trustedGitExecutable } from "./trusted-git-exec.mjs";

const execFile = promisify(execFileCallback);

const syntheticFixtureKey =
  "ark-11111111-2222-3333-4444-555555555555-test1";
const unapprovedSyntheticKey = [
  "ark-a1b2c3d4",
  "1111",
  "2222",
  "3333",
  "abcdef123456",
  "k9LmN",
].join("-");

async function createHistoryRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-release-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (argumentsList, options = {}) =>
    execFile(trustedGitExecutable, argumentsList, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    });
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Airlock Test"]);
  await git(["config", "user.email", "airlock-test@example.invalid"]);
  return { git, root };
}

async function commitAll(git, message) {
  await git(["add", "--all"]);
  await git(["commit", "--quiet", "-m", message]);
}

function assertHistoryScanFailsClosed(runGitSync) {
  assert.throws(
    () =>
      highConfidenceReachableGitObjectFindings("/unused", { runGitSync }),
    (error) =>
      error?.code === "RELEASE_HISTORY_SCAN_FAILED" &&
      /^Git history could not be scanned safely:/.test(error.message),
  );
}

test("detects an Ark model API key in a release file", () => {
  assert.deepEqual(
    highConfidenceSecretFindings(`ARK_API_KEY=${unapprovedSyntheticKey}`),
    ["ModelArk API key"],
  );
});

test("detects an Ark model API key in Git patch history", () => {
  assert.deepEqual(
    highConfidenceSecretFindings(`+Authorization: Bearer ${unapprovedSyntheticKey}`, {
      history: true,
    }),
    ["ModelArk API key"],
  );
});

test("allows only the exact known synthetic Ark fixture value", () => {
  assert.deepEqual(highConfidenceSecretFindings(syntheticFixtureKey), []);
  assert.deepEqual(
    highConfidenceSecretFindings(`${syntheticFixtureKey}x`),
    ["ModelArk API key"],
  );
});

test("preserves the existing high-confidence secret classes", () => {
  assert.deepEqual(
    highConfidenceSecretFindings(
      [
        "sk-" + "abcdefghijklmnopqrstuvwxyz1234567890",
        "AKLT" + "abcdefghijklmnop",
      ].join(" "),
    ),
    ["OpenAI-style secret", "Volcengine access key"],
  );
});

test("scans a deleted reachable blob without invoking a hostile textconv", async (t) => {
  const { git, root } = await createHistoryRepository(t);
  const secretPath = path.join(root, "historical.bin");
  await writeFile(path.join(root, ".gitattributes"), "*.bin diff=hostile\n");
  await writeFile(secretPath, Buffer.from(`\0${unapprovedSyntheticKey}\0`));
  await commitAll(git, "add historical binary fixture");

  const invocationMarker = path.join(root, ".git", "textconv-invoked");
  const textconv = path.join(root, ".git", "hostile-textconv.sh");
  await writeFile(
    textconv,
    `#!/bin/sh\nprintf invoked > ${JSON.stringify(invocationMarker)}\nprintf sanitized\n`,
  );
  await chmod(textconv, 0o700);
  await git(["config", "diff.hostile.textconv", textconv]);
  await unlink(secretPath);
  await commitAll(git, "delete historical binary fixture");

  assert.deepEqual(highConfidenceReachableGitObjectFindings(root), [
    "ModelArk API key",
  ]);
  await assert.rejects(access(invocationMarker), { code: "ENOENT" });
  await assert.rejects(readFile(secretPath), { code: "ENOENT" });
});

test("scans a deleted -diff binary blob with replacement objects disabled", async (t) => {
  const { git, root } = await createHistoryRepository(t);
  const secretPath = path.join(root, "hidden.bin");
  await writeFile(path.join(root, ".gitattributes"), "hidden.bin -diff\n");
  await writeFile(secretPath, Buffer.from(`binary\0${unapprovedSyntheticKey}\0`));
  await commitAll(git, "add hidden binary fixture");
  const originalBlob = (
    await git(["rev-parse", "HEAD:hidden.bin"])
  ).stdout.trim();

  await unlink(secretPath);
  await commitAll(git, "delete hidden binary fixture");
  const cleanObjectSource = path.join(root, ".git", "clean-object");
  await writeFile(cleanObjectSource, "sanitized\n");
  const cleanBlob = (
    await git(["hash-object", "-w", cleanObjectSource])
  ).stdout.trim();
  await git(["replace", originalBlob, cleanBlob]);

  assert.deepEqual(highConfidenceReachableGitObjectFindings(root), [
    "ModelArk API key",
  ]);
  await assert.rejects(readFile(secretPath), { code: "ENOENT" });
});

test("preserves raw commit and annotated-tag message coverage", async (t) => {
  const { git, root } = await createHistoryRepository(t);
  await writeFile(path.join(root, "README.md"), "safe fixture\n");
  await git(["add", "README.md"]);
  await git(["commit", "--quiet", "-m", unapprovedSyntheticKey]);
  const openAiStyleSecret = "sk-" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
  await git(["tag", "-a", "history-metadata", "-m", openAiStyleSecret]);

  assert.deepEqual(
    new Set(highConfidenceReachableGitObjectFindings(root)),
    new Set(["ModelArk API key", "OpenAI-style secret"]),
  );
});

test("fails closed on malformed or oversized reachable-object output", () => {
  assertHistoryScanFailsClosed(() => Buffer.from("not-an-object-id\n"));

  const objectId = "a".repeat(40);
  let call = 0;
  assertHistoryScanFailsClosed(() => {
    call += 1;
    return call === 1
      ? Buffer.from(objectId + "\n")
      : Buffer.from(`${objectId} blob ${16 * 1024 * 1024 + 1}\n`);
  });
});
