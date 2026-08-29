import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./check-phase-eight-clean-clone.mjs", import.meta.url),
  "utf8",
);

test("clean-clone workspaces stay below the Docker-shared project root", () => {
  assert.match(
    source,
    /path\.join\(projectRoot, "\.local", "clean-clones"\)/,
  );
  assert.doesNotMatch(source, /os\.tmpdir\(\)/);
});

test("clean-clone source checks use the shared exact Git byte boundary twice", () => {
  assert.match(source, /assertGitSourceMatchesHead/);
  assert.match(
    source,
    /"ls-files", "--cached", "--full-name", "-v", "-z"|assertGitSourceMatchesHead/,
  );
  assert.match(source, /"--porcelain=v1"/);
  assert.match(source, /"-z"/);
  assert.match(source, /"--untracked-files=all"/);
  assert.match(source, /"--ignore-submodules=none"/);
  assert.equal(
    source.match(/inspectCleanSource\(projectRoot\)/g)?.length,
    2,
  );
});
