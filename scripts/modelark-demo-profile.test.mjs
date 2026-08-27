import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeManagedRoot,
  comparableContract,
  liveModelArkContract,
  liveModelArkPrompt,
} from "./modelark-demo-profile.mjs";

test("the live proof is observable and enforced independently of model narration", () => {
  assert.match(liveModelArkPrompt, /modelark-proof\.txt/);
  assert.deepEqual(liveModelArkContract.requiredPaths, [
    "AGENTS.md",
    "modelark-proof.txt",
  ]);
  assert.deepEqual(liveModelArkContract.protectedPaths, ["AGENTS.md"]);
  assert.equal(liveModelArkContract.validationCommands[0].required, true);
  assert.match(liveModelArkContract.validationCommands[0].command, /modelark-live/);
  assert.deepEqual(comparableContract(liveModelArkContract), liveModelArkContract);
});

test("managed state refuses broad destructive roots", () => {
  const projectRoot = path.resolve("/tmp/agent-airlock-project");
  assert.throws(() => assertSafeManagedRoot(projectRoot, projectRoot), /unsafe/);
  assert.throws(() => assertSafeManagedRoot(projectRoot, os.homedir()), /unsafe/);
  assert.equal(
    assertSafeManagedRoot(projectRoot, path.join(projectRoot, ".local", "modelark")),
    path.join(projectRoot, ".local", "modelark"),
  );
});
