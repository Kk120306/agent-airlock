#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RuntimeProofError,
  resolveRuntimeProofArtifactPaths,
} from "./runtime-proof-runner.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const artifactRoot = path.join(
  projectRoot,
  ".local",
  "airlock-runtime-proof",
);

function parseArguments(argv) {
  if (argv.length === 0) return { githubOutput: null };
  if (
    argv.length === 2 &&
    argv[0] === "--github-output" &&
    typeof argv[1] === "string" &&
    argv[1].length > 0
  ) {
    return { githubOutput: argv[1] };
  }
  throw new RuntimeProofError("artifact-write-failed");
}

function projectRelativeArtifact(filePath) {
  const relative = path.relative(projectRoot, filePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative) ||
    relative.includes("\n") ||
    relative.includes("\r")
  ) {
    throw new RuntimeProofError("artifact-write-failed");
  }
  return relative.split(path.sep).join("/");
}

try {
  const { githubOutput } = parseArguments(process.argv.slice(2));
  const resolved = await resolveRuntimeProofArtifactPaths({ artifactRoot });
  const resultPath = projectRelativeArtifact(resolved.resultPath);
  const chainPath = projectRelativeArtifact(resolved.chainPath);
  if (githubOutput) {
    await appendFile(
      githubOutput,
      `result_path=${resultPath}\nchain_path=${chainPath}\n`,
      "utf8",
    );
  } else {
    console.log(JSON.stringify({ resultPath, chainPath }));
  }
} catch {
  console.error(
    "Verified Runtime proof artifacts could not be resolved safely.",
  );
  process.exitCode = 1;
}
