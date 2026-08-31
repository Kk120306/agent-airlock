import { createHash } from "node:crypto";

export const requiredProjectCheck = Object.freeze([
  "npm run check:scripts",
  "npm run typecheck",
  "npm run test:modelark-evidence",
  "npm run test:recording-outcome",
  "npm run test",
  "npm run build",
]).join(" && ");

export const requiredReleaseAudit = "node scripts/release-audit.mjs";

const requiredCheckScriptsDigest =
  "sha256:8196ef73bfa5ad2dfb169d68b471e28ff2c9d30acf4a335ede9f99cdf38bd2fa";

const requiredRootDelegates = Object.freeze({
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
});

const reachableRootTargets = Object.freeze([
  "dev",
  "check",
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
]);

const allowedRootLifecycleHooks = Object.freeze([
  "precheck:scripts",
  "pretypecheck",
  "pretest:modelark-evidence",
  "preverify:modelark-evidence",
  "prebuild",
]);

export const requiredReleaseWorkspaceScripts = Object.freeze({
  "apps/server/package.json": Object.freeze({
    dev: "tsx watch src/index.ts",
    build: "tsc -p tsconfig.json",
    typecheck: "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit",
    test: "vitest run --testTimeout=150000 --hookTimeout=150000",
  }),
  "apps/web/package.json": Object.freeze({
    dev: "vite --host 127.0.0.1",
    build: "tsc -b && vite build",
    typecheck: "tsc -b --pretty false",
  }),
  "packages/transactional-resource-sdk/package.json": Object.freeze({
    build: "tsc -p tsconfig.json",
    typecheck: "tsc -p tsconfig.json --noEmit",
    test: "vitest run",
  }),
  "packages/http-object-resource/package.json": Object.freeze({
    build: "tsc -p tsconfig.json",
    typecheck: "tsc -p tsconfig.json --noEmit",
    test: "npm run build && vitest run",
  }),
  "packages/portable-promotion-receipt/package.json": Object.freeze({
    build: "tsc -p tsconfig.json",
    typecheck: "tsc -p tsconfig.json --noEmit",
    test: "vitest run",
  }),
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requiredScriptsMatch(actual, required) {
  return Object.entries(required).every(
    ([name, command]) => actual?.[name] === command,
  );
}

function lifecycleHooksApproved(actual, _reachableTargets, allowedHooks = []) {
  if (
    actual === null ||
    typeof actual !== "object" ||
    Array.isArray(actual)
  ) {
    return false;
  }
  const allowed = new Set(allowedHooks);
  return Object.keys(actual).every(
    (name) => !/^(?:pre|post)/u.test(name) || allowed.has(name),
  );
}

export function approvedReleaseQualityPipeline(
  scripts,
  workspaceScripts = {},
) {
  return (
    scripts !== null &&
    typeof scripts === "object" &&
    !Array.isArray(scripts) &&
    scripts.check === requiredProjectCheck &&
    sha256(scripts["check:scripts"] ?? "") === requiredCheckScriptsDigest &&
    requiredScriptsMatch(scripts, requiredRootDelegates) &&
    lifecycleHooksApproved(
      scripts,
      reachableRootTargets,
      allowedRootLifecycleHooks,
    ) &&
    Object.entries(requiredReleaseWorkspaceScripts).every(
      ([manifestPath, required]) => {
        const actual = workspaceScripts[manifestPath];
        return (
          requiredScriptsMatch(actual, required) &&
          lifecycleHooksApproved(actual, Object.keys(required))
        );
      },
    )
  );
}
