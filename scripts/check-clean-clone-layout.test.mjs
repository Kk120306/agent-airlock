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
