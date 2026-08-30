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
  "sha256:68644d60ff11d72bbf3e1236b3be5834c398ee163490ac5b318bf474d96928a6";

const requiredRootDelegates = Object.freeze({
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
});

const reachableRootTargets = Object.freeze([
  "check",
  "check:scripts",
  "typecheck",
  "test:modelark-evidence",
  "test:recording-outcome",
  "test",
  "build",
]);

const allowedRootLifecycleHooks = Object.freeze([
  "precheck:scripts",
  "pretypecheck",
  "pretest:modelark-evidence",
  "prebuild",
]);

export const requiredReleaseWorkspaceScripts = Object.freeze({
  "apps/server/package.json": Object.freeze({
    build: "tsc -p tsconfig.json",
    typecheck: "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit",
    test: "vitest run --testTimeout=150000 --hookTimeout=150000",
  }),
  "apps/web/package.json": Object.freeze({
    build: "tsc -b && vite build",
    typecheck: "tsc -b --pretty false",
  }),
  "packages/transactional-resource-sdk/package.json": Object.freeze({
    build: "tsc -p tsconfig.json",
    typecheck: "tsc -p tsconfig.json --noEmit",
  }),
  "packages/http-object-resource/package.json": Object.freeze({
    build: "tsc -p tsconfig.json",
    typecheck: "tsc -p tsconfig.json --noEmit",
  }),
  "packages/portable-promotion-receipt/package.json": Object.freeze({
    build: "tsc -p tsconfig.json",
    typecheck: "tsc -p tsconfig.json --noEmit",
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

function lifecycleHooksApproved(actual, reachableTargets, allowedHooks = []) {
  if (
    actual === null ||
    typeof actual !== "object" ||
    Array.isArray(actual)
  ) {
    return false;
  }
  const reachableHooks = new Set(
    reachableTargets.flatMap((target) => [`pre${target}`, `post${target}`]),
  );
  const allowed = new Set(allowedHooks);
  return Object.keys(actual).every(
    (name) => !reachableHooks.has(name) || allowed.has(name),
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
