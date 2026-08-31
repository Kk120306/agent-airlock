import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";

import {
  approvedReleaseQualityPipeline,
  requiredProjectCheck,
  requiredReleaseAudit,
  requiredReleaseWorkspaceScripts,
} from "./release-quality-policy.mjs";
import {
  missingCachedReleaseFiles,
  releaseFileInventory,
} from "./release-index-policy.mjs";
import { inspectJudgeGalleryJpeg } from "./release-image-policy.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageManifest = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
const checkScripts = packageManifest.scripts["check:scripts"];

test("an untracked required release gate cannot satisfy cached provenance", () => {
  const inventory = releaseFileInventory({
    cachedOutput: Buffer.from("README.md\0scripts/release-audit.mjs\0"),
    scannedOutput: Buffer.from(
      "README.md\0scripts/release-audit.mjs\0scripts/new-required-gate.mjs\0",
    ),
  });
  assert.deepEqual(
    missingCachedReleaseFiles(
      ["scripts/release-audit.mjs", "scripts/new-required-gate.mjs"],
      inventory.cachedFileSet,
    ),
    ["scripts/new-required-gate.mjs"],
  );
  assert.ok(inventory.scannedFiles.includes("scripts/new-required-gate.mjs"));
});

test("release inventory fails if candidate scanning omits a cached file", () => {
  assert.throws(
    () =>
      releaseFileInventory({
        cachedOutput: Buffer.from("README.md\0scripts/release-audit.mjs\0"),
        scannedOutput: Buffer.from("README.md\0"),
      }),
    /omitted a cached file/,
  );
});

function galleryJpeg({ width = 1280, height = 720 } = {}) {
  const data = Buffer.alloc(width * height * 4);
  let noise = 0x5f3759df;
  for (let offset = 0; offset < data.length; offset += 4) {
    noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
    data[offset] = noise & 0xff;
    data[offset + 1] = (noise >>> 8) & 0xff;
    data[offset + 2] = (noise >>> 16) & 0xff;
    data[offset + 3] = 0xff;
  }
  return Buffer.from(jpeg.encode({ data, height, width }, 70).data);
}

test("judge gallery policy accepts only bounded decodable JPEG images", () => {
  const valid = galleryJpeg();
  assert.deepEqual(inspectJudgeGalleryJpeg(valid), {
    bytes: valid.length,
    height: 720,
    width: 1280,
  });
  const syntheticHeader = Buffer.alloc(50_000, 0x5a);
  syntheticHeader.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08], 0);
  syntheticHeader.writeUInt16BE(720, 7);
  syntheticHeader.writeUInt16BE(1280, 9);
  syntheticHeader.set([0x03, 0x01, 0x11, 0x00], 11);
  syntheticHeader.set([0xff, 0xd9], syntheticHeader.length - 2);
  const truncatedEntropy = Buffer.concat([
    valid.subarray(0, Math.floor(valid.length / 2)),
    Buffer.from([0xff, 0xd9]),
  ]);
  for (const mutation of [
    valid.subarray(0, 49_999),
    galleryJpeg({ width: 1199 }),
    galleryJpeg({ height: 674 }),
    Buffer.from(valid).fill(0, 0, 2),
    Buffer.from(valid).fill(0, valid.length - 2),
    syntheticHeader,
    truncatedEntropy,
  ]) {
    assert.equal(inspectJudgeGalleryJpeg(mutation), null);
  }
});

const rootScripts = {
  check: requiredProjectCheck,
  "check:scripts": checkScripts,
  dev: "node --env-file=.env ./node_modules/concurrently/dist/bin/concurrently.js -n server,web -c cyan,magenta \"npm run dev -w @launchpad/server\" \"npm run dev -w @launchpad/web\"",
  prebuild:
    "npm run build -w @agent-airlock/transactional-resource-sdk && npm run build -w @agent-airlock/http-object-resource && npm run build -w @agent-airlock/portable-promotion-receipt",
  build: "npm run build -w @launchpad/web && npm run build -w @launchpad/server",
  pretypecheck:
    "npm run build -w @agent-airlock/transactional-resource-sdk && npm run build -w @agent-airlock/http-object-resource && npm run build -w @agent-airlock/portable-promotion-receipt",
  typecheck: "npm run typecheck --workspaces --if-present",
  test: "npm run test --workspaces --if-present",
  "precheck:scripts":
    "npm run build -w @agent-airlock/portable-promotion-receipt",
  "pretest:modelark-evidence":
    "npm run build -w @agent-airlock/portable-promotion-receipt",
  "preverify:modelark-evidence":
    "npm run build -w @agent-airlock/portable-promotion-receipt",
  "verify:modelark-evidence":
    "node --env-file-if-exists=.env scripts/verify-modelark-evidence.mjs",
  "test:modelark-evidence":
    "node --test scripts/verify-modelark-evidence.test.mjs",
  "test:recording-outcome":
    "vitest run apps/web/src/recording-outcome-policy.test.ts",
  "test:e2e": "npm run build && playwright test",
  "test:demo:e2e":
    "npm run build && playwright test --config=playwright.demo.config.ts",
  "test:phase11:ui":
    "npm run test:phase11:ui:mock && npm run test:phase11:ui:real",
  "test:phase11:ui:mock":
    "npm run build && playwright test --config=playwright.phase11-ui.config.ts",
  "test:phase11:ui:real":
    "npm run build && playwright test --config=playwright.phase11-real.config.ts",
  "test:phase12:real":
    "npm run build && playwright test --config=playwright.phase12-real.config.ts",
  "test:container-browser":
    "npm run build && playwright test --config=playwright.container-browser.config.ts",
  "check:phase13:runtime": "node scripts/check-phase-thirteen.mjs",
  "prove:runtime": "node scripts/prove-runtime.mjs",
  "check:phase13":
    "npm run check && npm run test:phase11:ui:mock && npm run test:phase12:real && npm run check:phase13:runtime && npm run audit:release",
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
    "dev",
    "check:scripts",
    "typecheck",
    "test:modelark-evidence",
    "verify:modelark-evidence",
    "test:recording-outcome",
    "test:e2e",
    "test:demo:e2e",
    "test:phase11:ui",
    "test:phase11:ui:mock",
    "test:phase11:ui:real",
    "test:phase12:real",
    "test:container-browser",
    "check:phase13:runtime",
    "prove:runtime",
    "check:phase13",
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
  assert.equal(
    approvedReleaseQualityPipeline(rootScripts, {
      ...workspaceScripts,
      "packages/portable-promotion-receipt/package.json": {
        ...workspaceScripts["packages/portable-promotion-receipt/package.json"],
        test: "true",
      },
    }),
    false,
  );
});

test("rejects a remotely bound Web development proxy", () => {
  assert.equal(
    approvedReleaseQualityPipeline(rootScripts, {
      ...workspaceScripts,
      "apps/web/package.json": {
        ...workspaceScripts["apps/web/package.json"],
        dev: "vite --host 0.0.0.0",
      },
    }),
    false,
  );
});

test("rejects unapproved reachable root lifecycle hooks", () => {
  for (const name of [
    "predev",
    "postdev",
    "precheck",
    "postcheck",
    "postbuild",
    "preaudit:release",
    "postaudit:release",
    "pretest:e2e",
    "pretest:demo:e2e",
    "pretest:phase11:ui",
    "pretest:phase12:real",
    "precheck:phase13:runtime",
    "preprove:runtime",
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
