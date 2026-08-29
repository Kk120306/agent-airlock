import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  approvedReleaseQualityPipeline,
  requiredProjectCheck,
  requiredReleaseAudit,
  requiredReleaseWorkspaceScripts,
} from "./release-quality-policy.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageManifest = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
const checkScripts = packageManifest.scripts["check:scripts"];

const rootScripts = {
  check: requiredProjectCheck,
  "check:scripts": checkScripts,
  prebuild:
    "npm run build -w @agent-airlock/transactional-resource-sdk && npm run build -w @agent-airlock/http-object-resource && npm run build -w @agent-airlock/portable-promotion-receipt",
  build: "npm run build -w @launchpad/web && npm run build -w @launchpad/server",
  pretypecheck:
    "npm run build -w @agent-airlock/transactional-resource-sdk && npm run build -w @agent-airlock/http-object-resource && npm run build -w @agent-airlock/portable-promotion-receipt",
  typecheck: "npm run typecheck --workspaces --if-present",
  test: "npm run test -w @launchpad/server",
  "precheck:scripts":
    "npm run build -w @agent-airlock/portable-promotion-receipt",
  "pretest:modelark-evidence":
    "npm run build -w @agent-airlock/portable-promotion-receipt",
  "test:modelark-evidence":
    "node --test scripts/verify-modelark-evidence.test.mjs",
  "test:recording-outcome":
    "vitest run apps/web/src/recording-outcome-policy.test.ts",
  "audit:release": requiredReleaseAudit,
};

const workspaceScripts = Object.fromEntries(
  Object.entries(requiredReleaseWorkspaceScripts).map(([file, scripts]) => [
    file,
    { ...scripts },
  ]),
);

test("approves only the exact complete release quality pipeline", () => {
  assert.equal(
    approvedReleaseQualityPipeline({
      ...rootScripts,
    }, workspaceScripts),
    true,
  );
});

test("rejects a shortened quality alias despite a passing build", () => {
  assert.equal(
    approvedReleaseQualityPipeline({
      ...rootScripts,
      check: "npm run test:recording-outcome && npm run build",
    }, workspaceScripts),
    false,
  );
});

test("rejects a release-audit alias that bypasses the auditor", () => {
  assert.equal(
    approvedReleaseQualityPipeline({
      ...rootScripts,
      "audit:release": "true",
    }, workspaceScripts),
    false,
  );
});

test("rejects weakened delegated root and workspace commands", () => {
  for (const name of [
    "check:scripts",
    "typecheck",
    "test:modelark-evidence",
    "test:recording-outcome",
    "test",
    "build",
  ]) {
    assert.equal(
      approvedReleaseQualityPipeline(
        { ...rootScripts, [name]: "true" },
        workspaceScripts,
      ),
      false,
      name,
    );
  }
  assert.equal(
    approvedReleaseQualityPipeline(rootScripts, {
      ...workspaceScripts,
      "apps/server/package.json": {
        ...workspaceScripts["apps/server/package.json"],
        test: "true",
      },
    }),
    false,
  );
});

test("rejects unapproved reachable root lifecycle hooks", () => {
  for (const name of ["precheck", "postcheck", "postbuild"]) {
    assert.equal(
      approvedReleaseQualityPipeline(
        { ...rootScripts, [name]: "true" },
        workspaceScripts,
      ),
      false,
      name,
    );
  }
});

test("rejects reachable workspace lifecycle hooks", () => {
  assert.equal(
    approvedReleaseQualityPipeline(rootScripts, {
      ...workspaceScripts,
      "apps/server/package.json": {
        ...workspaceScripts["apps/server/package.json"],
        pretest: "true",
      },
    }),
    false,
  );
});
