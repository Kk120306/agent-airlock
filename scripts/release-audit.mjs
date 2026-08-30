import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { approvedModelArkBoundaryDocuments } from "./modelark-claim-policy.mjs";
import { releaseLockfileDependencyFindings } from "./release-lockfile-policy.mjs";
import {
  approvedReleaseQualityPipeline,
  requiredReleaseWorkspaceScripts,
} from "./release-quality-policy.mjs";
import {
  highConfidenceReachableGitObjectFindings,
  highConfidenceSecretFindings,
} from "./release-secret-policy.mjs";
import { runTrustedGit } from "./trusted-git-exec.mjs";

const projectRoot = path.resolve(".");
const { stdout } = await runTrustedGit(
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: projectRoot,
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024,
  },
);
const trackedFiles = stdout
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const failures = [];

const modelArkStatusFiles = [
  "README.md",
  "docs/demo/DEVPOST_SUBMISSION.md",
  "docs/demo/JUDGE_CHECKLIST.md",
  "docs/demo/SUBMISSION_BRIEF.md",
  "docs/demo/architecture-one-page.md",
  "docs/demo/three-minute-demo.md",
  "docs/product/OUTCOME_ROADMAP.md",
  "docs/product/PRD.md",
];
for (const file of trackedFiles) {
  if (/^\.env(?:\.|$)/.test(path.basename(file)) && file !== ".env.example") {
    failures.push("Tracked environment file: " + file);
  }
  if (path.basename(file) === ".npmrc") {
    failures.push("Tracked project npm configuration: " + file);
  }
}

try {
  for (const secretName of highConfidenceReachableGitObjectFindings(projectRoot)) {
    failures.push(secretName + " in Git history");
  }
} catch {
  failures.push("Git history scan was incomplete or unsafe");
}

for (const file of trackedFiles) {
  let content;
  try {
    content = await readFile(path.join(projectRoot, file), "utf8");
  } catch {
    continue;
  }
  if (/^(?:<{7}|={7}|>{7})(?: |$)/m.test(content)) {
    failures.push("Merge conflict marker: " + file);
  }
  for (const secretName of highConfidenceSecretFindings(content)) {
    failures.push(secretName + ": " + file);
  }
}

for (const markdownFile of trackedFiles.filter((file) => file.endsWith(".md"))) {
  const content = await readFile(path.join(projectRoot, markdownFile), "utf8");
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1]?.trim() ?? "";
    const targetWithoutTitle = rawTarget.startsWith("<")
      ? rawTarget.slice(1, rawTarget.indexOf(">"))
      : rawTarget.split(/\s+["']/)[0];
    const target = decodeURIComponent(targetWithoutTitle.split("#")[0] ?? "");
    if (
      !target ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }
    const resolved = path.resolve(projectRoot, path.dirname(markdownFile), target);
    try {
      await access(resolved);
    } catch {
      failures.push("Broken Markdown target in " + markdownFile + ": " + target);
    }
  }
}

const modelArkStatusDocuments = [];
for (const statusFile of modelArkStatusFiles) {
  if (!trackedFiles.includes(statusFile)) {
    failures.push("Missing ModelArk status document: " + statusFile);
    continue;
  }
  const content = await readFile(path.join(projectRoot, statusFile), "utf8");
  modelArkStatusDocuments.push([statusFile, content]);
}
if (!approvedModelArkBoundaryDocuments(modelArkStatusDocuments)) {
  failures.push(
    "ModelArk status disclosures differ from the approved submission boundary",
  );
}

const readme = await readFile(path.join(projectRoot, "README.md"), "utf8");
if (!readme.includes("must be rerun at judging time")) {
  failures.push("README must disclose that live ModelArk conformance is rerun at judging time");
}

const recordingReleaseDocuments = {
  "README.md": readme,
  "docs/demo/three-minute-demo.md": await readFile(
    path.join(projectRoot, "docs/demo/three-minute-demo.md"),
    "utf8",
  ),
  "docs/demo/JUDGE_CHECKLIST.md": await readFile(
    path.join(projectRoot, "docs/demo/JUDGE_CHECKLIST.md"),
    "utf8",
  ),
};
const requiredRecordingReleaseMarkers = [
  "npm run prove:runtime -- --reset --headed",
  "npm run prove:runtime -- --reset --json",
  "npm run prove:runtime -- --reset --headed --json",
  "npm run audit:release",
  "deadline-aware presentation pacing",
  "hard 180-second recording budget",
  "15-second opening",
  "85-second desktop Outcome Brief",
  "25-second desktop verifier",
  "5-second browser-close reserve",
  "full 115-second post-Run presentation tail",
  "15-second release headroom",
  "recording-timeout",
  "instead of shortening narration",
  "1280 by 720",
  "separate headless 390 by 844 read-only replay",
  "creates no Run",
  "same signed chain",
  "zero-upload verifier evidence",
  "content-addressed immutable result capsule",
  "real-runtime-proof.latest.json",
  "convenience pointer",
];
for (const [documentPath, content] of Object.entries(
  recordingReleaseDocuments,
)) {
  for (const marker of requiredRecordingReleaseMarkers) {
    if (!content.includes(marker)) {
      failures.push(
        "Recording release documentation is missing " +
          JSON.stringify(marker) +
          ": " +
          documentPath,
      );
    }
  }
  if (
    /\b144-second\b/i.test(content) ||
    /fixed presentation pacing keeps/i.test(content)
  ) {
    failures.push(
      "Recording release documentation contains a stale fixed-pacing claim: " +
        documentPath,
    );
  }
}

const packageManifest = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
const releaseManifests = { "package.json": packageManifest };
const releaseWorkspaceScripts = {};
for (const workspaceManifestPath of Object.keys(
  requiredReleaseWorkspaceScripts,
)) {
  const workspaceManifest = JSON.parse(
    await readFile(path.join(projectRoot, workspaceManifestPath), "utf8"),
  );
  releaseManifests[workspaceManifestPath] = workspaceManifest;
  releaseWorkspaceScripts[workspaceManifestPath] = workspaceManifest.scripts;
}
const packageLock = JSON.parse(
  await readFile(path.join(projectRoot, "package-lock.json"), "utf8"),
);
for (const finding of releaseLockfileDependencyFindings(
  packageLock,
  releaseManifests,
)) {
  failures.push("Release dependency lock mismatch: " + finding);
}
const requiredRuntimeProofScripts = {
  "prove:runtime": "node scripts/prove-runtime.mjs",
  "test:recording-outcome":
    "vitest run apps/web/src/recording-outcome-policy.test.ts",
  "test:runtime-proof-artifacts":
    "node --test scripts/runtime-proof-artifact-worker.test.mjs",
  "test:runtime-proof": "node --test scripts/runtime-proof-runner.test.mjs",
};
if (
  packageManifest.scripts?.["audit:submission"] !==
  "node --env-file-if-exists=.env scripts/submission-audit.mjs"
) {
  failures.push(
    "audit:submission must remain the credential-safe zero-network submission handoff",
  );
}
for (const [scriptName, command] of Object.entries(requiredRuntimeProofScripts)) {
  if (packageManifest.scripts?.[scriptName] !== command) {
    failures.push(`${scriptName} must remain exactly: ${command}`);
  }
}
const scriptChecks = packageManifest.scripts?.["check:scripts"];
const scriptCheckCommands =
  typeof scriptChecks === "string" ? scriptChecks.split(" && ") : [];
const hasExactSyntaxCheck = (file) =>
  scriptCheckCommands.includes(`node --check ${file}`);
for (const requiredSubmissionAuditFile of [
  "scripts/modelark-claim-policy.mjs",
  "scripts/modelark-claim-policy.test.mjs",
  "scripts/release-lockfile-policy.mjs",
  "scripts/release-lockfile-policy.test.mjs",
  "scripts/release-quality-policy.mjs",
  "scripts/release-quality-policy.test.mjs",
  "scripts/release-secret-policy.mjs",
  "scripts/release-secret-policy.test.mjs",
  "scripts/submission-artifact-binding.mjs",
  "scripts/submission-artifact-binding.test.mjs",
  "scripts/submission-audit.mjs",
  "scripts/submission-audit.test.mjs",
  "scripts/trusted-git-exec.mjs",
]) {
  if (!trackedFiles.includes(requiredSubmissionAuditFile)) {
    failures.push(
      "Missing tracked submission handoff gate: " +
        requiredSubmissionAuditFile,
    );
  }
  if (
    !hasExactSyntaxCheck(requiredSubmissionAuditFile)
  ) {
    failures.push(
      "check:scripts is missing submission handoff coverage: " +
        requiredSubmissionAuditFile,
    );
  }
}
for (const requiredRuntimeProofCheck of [
  "scripts/runtime-proof-artifact-worker.mjs",
  "scripts/runtime-proof-artifact-worker.test.mjs",
  "scripts/runtime-proof-runner.mjs",
  "scripts/runtime-proof-runner.test.mjs",
  "scripts/prove-runtime.mjs",
  "scripts/runtime-proof-terminal.mjs",
  "scripts/resolve-runtime-proof-artifacts.mjs",
]) {
  if (
    !hasExactSyntaxCheck(requiredRuntimeProofCheck)
  ) {
    failures.push(
      "check:scripts is missing Runtime proof coverage: " +
        requiredRuntimeProofCheck,
    );
  }
}
const scriptTestCommandOffset =
  typeof scriptChecks === "string" ? scriptChecks.lastIndexOf("&& node --test ") : -1;
const scriptTestCommand =
  scriptTestCommandOffset === -1
    ? ""
    : scriptChecks.slice(scriptTestCommandOffset);
if (
  !hasExactSyntaxCheck("scripts/runtime-proof-artifact-worker.test.mjs") ||
  !scriptTestCommand.includes("scripts/runtime-proof-artifact-worker.test.mjs")
) {
  failures.push(
    "check:scripts must syntax-check and execute the Runtime proof artifact worker test",
  );
}
if (
  !approvedReleaseQualityPipeline(
    packageManifest.scripts,
    releaseWorkspaceScripts,
  )
) {
  failures.push(
    "check and audit:release must retain the exact script, typecheck, ModelArk evidence, recording policy, server test, build, and direct release-audit pipeline",
  );
}
const phaseThirteenCommand = packageManifest.scripts?.["check:phase13"];
const requiredPhaseThirteenSteps = [
  "npm run check",
  "npm run test:phase11:ui:mock",
  "npm run test:phase12:real",
  "npm run check:phase13:runtime",
  "npm run audit:release",
];
if (
  typeof phaseThirteenCommand !== "string" ||
  requiredPhaseThirteenSteps.some(
    (required) => !phaseThirteenCommand.includes(required),
  )
) {
  failures.push(
    "check:phase13 must retain quality, adversarial UI, two-instance, real Runtime, and release-audit gates",
  );
}
const releaseWorkflow = await readFile(
  path.join(projectRoot, ".github/workflows/release-proof.yml"),
  "utf8",
);
if (!releaseWorkflow.includes("npm run test:phase12:real")) {
  failures.push("Hosted Release proof is missing: npm run test:phase12:real");
}
const runtimeProofJobMarker = "\n  real-runtime-proof:\n";
const runtimeProofJobOffset = releaseWorkflow.indexOf(runtimeProofJobMarker);
const runtimeProofJob =
  runtimeProofJobOffset === -1
    ? ""
    : releaseWorkflow.slice(runtimeProofJobOffset + runtimeProofJobMarker.length);
if (!runtimeProofJob) {
  failures.push("Hosted Release proof is missing the real-runtime-proof job");
}
for (const requiredRuntimeProofStep of [
  "npm run check:phase13:runtime",
  "npm run prove:runtime -- --reset --json",
  "node scripts/resolve-runtime-proof-artifacts.mjs --github-output",
  "id: runtime-proof-artifacts",
  "name: real-runtime-verified-artifacts",
  "${{ steps.runtime-proof-artifacts.outputs.result_path }}",
  "${{ steps.runtime-proof-artifacts.outputs.chain_path }}",
  "include-hidden-files: true",
  "if-no-files-found: error",
  "retention-days: 14",
  "name: real-runtime-proof-evidence",
  "if: failure()",
  "test-results/",
  "playwright-report/",
  "if-no-files-found: ignore",
]) {
  if (!runtimeProofJob.includes(requiredRuntimeProofStep)) {
    failures.push(
      "Hosted real Runtime proof is missing a required gate or artifact: " +
        requiredRuntimeProofStep,
    );
  }
}
const runtimeProofCommandOffset = runtimeProofJob.indexOf(
  "npm run prove:runtime -- --reset --json",
);
const verifiedArtifactOffset = runtimeProofJob.indexOf(
  "name: real-runtime-verified-artifacts",
);
const resolvedArtifactOffset = runtimeProofJob.indexOf(
  "node scripts/resolve-runtime-proof-artifacts.mjs --github-output",
);
const failureArtifactOffset = runtimeProofJob.indexOf(
  "name: real-runtime-proof-evidence",
);
if (
  runtimeProofCommandOffset === -1 ||
  resolvedArtifactOffset <= runtimeProofCommandOffset ||
  verifiedArtifactOffset <= resolvedArtifactOffset ||
  failureArtifactOffset <= verifiedArtifactOffset
) {
  failures.push(
    "Hosted real Runtime proof must record before uploading verified artifacts and retain failure evidence last",
  );
}
if (!trackedFiles.includes("scripts/check-phase-thirteen.mjs")) {
  failures.push("Missing tracked Phase 13 combined Runtime proof");
}
for (const runtimeProofFile of [
  "scripts/prove-runtime.mjs",
  "scripts/runtime-proof-artifact-worker.mjs",
  "scripts/runtime-proof-artifact-worker.test.mjs",
  "scripts/runtime-proof-terminal.mjs",
  "scripts/resolve-runtime-proof-artifacts.mjs",
  "scripts/runtime-proof-runner.mjs",
  "scripts/runtime-proof-runner.test.mjs",
]) {
  if (!trackedFiles.includes(runtimeProofFile)) {
    failures.push(
      "Missing tracked recording-grade Runtime proof: " + runtimeProofFile,
    );
  }
}
for (const recordingOutcomeFile of [
  "apps/web/src/recording-outcome-policy.ts",
  "apps/web/src/recording-outcome-policy.test.ts",
]) {
  if (!trackedFiles.includes(recordingOutcomeFile)) {
    failures.push(
      "Missing tracked recording Outcome Brief policy: " + recordingOutcomeFile,
    );
  }
}
const runtimeProofRunner = await readFile(
  path.join(projectRoot, "scripts/runtime-proof-runner.mjs"),
  "utf8",
);
const runtimeProofArtifactWorker = await readFile(
  path.join(projectRoot, "scripts/runtime-proof-artifact-worker.mjs"),
  "utf8",
);
const runtimeProofArtifactWorkerTest = await readFile(
  path.join(projectRoot, "scripts/runtime-proof-artifact-worker.test.mjs"),
  "utf8",
);
const runtimeProofRunnerTest = await readFile(
  path.join(projectRoot, "scripts/runtime-proof-runner.test.mjs"),
  "utf8",
);
const realContainerBrowserTest = await readFile(
  path.join(projectRoot, "tests/container-browser/real-container.spec.ts"),
  "utf8",
);
for (const requiredImmutableWorkerMarker of [
  "function installImmutable(request)",
  "linkSync(token.temporaryName, name)",
  "function recoverInterruptedImmutable(name, maximumBytes, expectedBytes)",
  'case "install-immutable":',
]) {
  if (!runtimeProofArtifactWorker.includes(requiredImmutableWorkerMarker)) {
    failures.push(
      "Runtime proof artifact worker is missing immutable publication behavior: " +
        requiredImmutableWorkerMarker,
    );
  }
}
for (const requiredCommitReconciliationMarker of [
  "function cleanupUncommittedReplace(token)",
  "function reconcileReplace(request)",
  'case "reconcile-replace":',
  "fsyncSync(DIRECTORY_DESCRIPTOR);",
]) {
  if (!runtimeProofArtifactWorker.includes(requiredCommitReconciliationMarker)) {
    failures.push(
      "Runtime proof pointer commit is missing exact outcome reconciliation: " +
        requiredCommitReconciliationMarker,
    );
  }
}
for (const requiredCommitBoundaryRegression of [
  "a live commit worker killed after linking but before rename preserves the prior pair",
  "post-rename response loss and cleanup failure preserve the committed pair",
]) {
  if (!runtimeProofRunnerTest.includes(requiredCommitBoundaryRegression)) {
    failures.push(
      "Runtime proof commit-boundary regression is missing: " +
        requiredCommitBoundaryRegression,
    );
  }
}
const artifactCommitReplaceSource = runtimeProofArtifactWorker.slice(
  runtimeProofArtifactWorker.indexOf("function commitReplace(request)"),
  runtimeProofArtifactWorker.indexOf("function discardPrepared(request)"),
);
for (const requiredPostRenameRevalidation of [
  "renameSync(attemptName, name);",
  "expectedIdentity: prepared.status,",
  "expectedLinkCount: 2n,",
  "removePreparedDirectoryEntry(token, prepared);",
]) {
  if (!artifactCommitReplaceSource.includes(requiredPostRenameRevalidation)) {
    failures.push(
      "Runtime proof latest-pointer commit is missing post-rename inode revalidation: " +
        requiredPostRenameRevalidation,
    );
  }
}
for (const requiredWorkerDeadlineMarker of [
  "function validateRecordingDeadlineAt(value)",
  "function assertBeforeRecordingDeadline(recordingDeadlineAt)",
  "request.recordingDeadlineAt",
  "assertBeforeRecordingDeadline(recordingDeadlineAt);",
]) {
  if (!runtimeProofArtifactWorker.includes(requiredWorkerDeadlineMarker)) {
    failures.push(
      "Runtime proof latest-pointer commit is missing its worker-side deadline: " +
        requiredWorkerDeadlineMarker,
    );
  }
}
const interruptedImmutableRecoverySource = runtimeProofArtifactWorker.slice(
  runtimeProofArtifactWorker.indexOf(
    "function recoverInterruptedImmutable(name, maximumBytes, expectedBytes)",
  ),
  runtimeProofArtifactWorker.indexOf("function installImmutable(request)"),
);
for (const requiredInterruptedRecoveryMarker of [
  "matchingTemporaryNames.length !== 1",
  "temporaryDescriptor = openSync(",
  "const afterUnlink = fstatSync(temporaryDescriptor",
  "afterUnlink.nlink !== 1n",
  "readRecoveredImmutableDestination(",
]) {
  if (
    !interruptedImmutableRecoverySource.includes(
      requiredInterruptedRecoveryMarker,
    )
  ) {
    failures.push(
      "Runtime proof immutable publication is missing interrupted-link reconciliation: " +
        requiredInterruptedRecoveryMarker,
    );
  }
}
for (const requiredArtifactWorkerRegression of [
  "commit-replace preserves the validated prepared inode",
  "commit-replace requires an absolute recording deadline",
  "commit-replace cannot publish after pausing past its recording deadline",
  "install-immutable recovers one interrupted temporary hard link",
  "concurrent recovery of one interrupted hard link is idempotent",
  "install-immutable rejects an ambiguous interrupted hard-link set",
]) {
  if (!runtimeProofArtifactWorkerTest.includes(requiredArtifactWorkerRegression)) {
    failures.push(
      "Runtime proof artifact worker regression is missing: " +
        requiredArtifactWorkerRegression,
    );
  }
}
for (const requiredOfflineBoundary of [
  'serviceWorkers: "block"',
  'await context.route("**/*"',
  'await context.routeWebSocket("**/*"',
  "createFailClosedVerifierGuard(context)",
  "createFailClosedVerifierGuard(mobileContext)",
  "mobileGuard.arm();",
  "primaryGuard.arm();",
  'throw new RuntimeProofError("verifier-invalid")',
]) {
  if (!runtimeProofRunner.includes(requiredOfflineBoundary)) {
    failures.push(
      "Recording proof is missing its persistent zero-upload boundary: " +
        requiredOfflineBoundary,
    );
  }
}
for (const requiredContainerOfflineBoundary of [
  "offlineVerifierContext.route(/^https?:\\/\\//",
  "offlineVerifierContext.routeWebSocket(/^wss?:\\/\\//",
  "expect(deniedPostArmHttpRequests).toEqual([])",
  "expect(deniedPostArmWebSockets).toEqual([])",
]) {
  if (!realContainerBrowserTest.includes(requiredContainerOfflineBoundary)) {
    failures.push(
      "Real container browser proof is missing an independent offline network guard: " +
        requiredContainerOfflineBoundary,
    );
  }
}
for (const requiredRecordingDeadlineMarker of [
  "export const RUNTIME_PROOF_RECORDING_BUDGET_MS = 180_000;",
  "export const RUNTIME_PROOF_RUN_POLLING_BUDGET_MS = 35_000;",
  "export const RUNTIME_PROOF_PRESENTATION_TAIL_RESERVE_MS = 5_000;",
  '"opening-cta": 15_000,',
  '"desktop-outcome-brief": 85_000,',
  '"desktop-verifier": 25_000,',
  "export const RUNTIME_PROOF_RECORDING_HEADROOM_MS =",
  "recordingDeadlineAt - RUNTIME_PROOF_POST_RUN_RESERVE_MS",
  "remainingPresentationMilliseconds < requestedMilliseconds",
  'throw new RuntimeProofError("recording-timeout")',
]) {
  if (!runtimeProofRunner.includes(requiredRecordingDeadlineMarker)) {
    failures.push(
      "Recording proof is missing its absolute three-minute pacing contract: " +
        requiredRecordingDeadlineMarker,
    );
  }
}
for (const requiredReadOnlyReplayMarker of [
  "const RUNTIME_PROOF_DESKTOP_VIEWPORT = Object.freeze({",
  "const RUNTIME_PROOF_MOBILE_VIEWPORT = Object.freeze({",
  "runtimeProofReplayUrl({ baseUrl, runs })",
  'url.searchParams.set("recordingSafeRunId", safeRunId);',
  'url.searchParams.set("recordingUnsafeRunId", unsafeRunId);',
  'url.searchParams.set("recordingRepairRunId", repairedRunId);',
  "if (!headless) {",
  "mobileBrowser = await chromium.launch({",
  "const mobileContextOwner = mobileBrowser ?? browser;",
  "mobileContext = await mobileContextOwner.newContext({",
  "assertMatchingRuntimeProofDecisionChainSources(",
  "await browserDriver.assertRecordingBoard(runs);",
]) {
  if (!runtimeProofRunner.includes(requiredReadOnlyReplayMarker)) {
    failures.push(
      "Recording proof is missing its independent read-only mobile replay: " +
        requiredReadOnlyReplayMarker,
    );
  }
}
const recordingViewportSource = runtimeProofRunner.slice(
  runtimeProofRunner.indexOf(
    "const RUNTIME_PROOF_DESKTOP_VIEWPORT = Object.freeze({",
  ),
  runtimeProofRunner.indexOf("function runtimeProofRunIds(runs)"),
);
for (const requiredViewportDimension of [
  "width: 1280,",
  "height: 720,",
  "width: 390,",
  "height: 844,",
]) {
  if (!recordingViewportSource.includes(requiredViewportDimension)) {
    failures.push(
      "Recording proof is missing an exact desktop or replay viewport dimension: " +
        requiredViewportDimension,
    );
  }
}
if (runtimeProofRunner.includes("page.setViewportSize({ width: 390")) {
  failures.push(
    "Recording proof must not resize the headed desktop page for mobile verification",
  );
}
const recordingOutcomePolicy = await readFile(
  path.join(projectRoot, "apps/web/src/recording-outcome-policy.ts"),
  "utf8",
);
const recordingApp = await readFile(
  path.join(projectRoot, "apps/web/src/App.tsx"),
  "utf8",
);
for (const requiredReplayPolicyMarker of [
  "export const recordingReplayQueryParameters",
  "export function parseRecordingReplayRunIds(",
  "export function deriveRecordingReplayHydration(",
  "export function hasExactRecordingDecisionChain(",
]) {
  if (!recordingOutcomePolicy.includes(requiredReplayPolicyMarker)) {
    failures.push(
      "Recording Outcome Brief policy is missing a replay boundary: " +
        requiredReplayPolicyMarker,
    );
  }
}
for (const requiredReadOnlyAppMarker of [
  "if (readOnlyReplayMode || recordingStartGuard) return;",
  "readOnlyReplayMode ||",
  "Boolean(recordingStartGuard) ||",
  'recordingMode && recordingReplaySelection.kind !== "absent"',
]) {
  if (!recordingApp.includes(requiredReadOnlyAppMarker)) {
    failures.push(
      "Recording replay can no longer prove that Run creation is disabled: " +
        requiredReadOnlyAppMarker,
    );
  }
}
const runtimeProofCli = await readFile(
  path.join(projectRoot, "scripts/prove-runtime.mjs"),
  "utf8",
);
const runtimeProofTerminal = await readFile(
  path.join(projectRoot, "scripts/runtime-proof-terminal.mjs"),
  "utf8",
);
const containerBrowserFixture = await readFile(
  path.join(projectRoot, "scripts/run-container-browser-fixture.mjs"),
  "utf8",
);
const acquireLeaseSource = runtimeProofCli.slice(
  runtimeProofCli.indexOf("async function acquireLease()"),
  runtimeProofCli.indexOf("async function releaseLease()"),
);
const abandonedCleanupSource = runtimeProofRunner.slice(
  runtimeProofRunner.indexOf(
    "export async function cleanupAbandonedRuntimeProofSessions({",
  ),
  runtimeProofRunner.indexOf(
    "export async function cleanupRuntimeProofSessionRoot({",
  ),
);
for (const requiredAbandonedCleanupMarker of [
  "readOwnerOnlyPhysicalFile(",
  "parseRuntimeProofSessionMarker(",
  "processExists(marker.ownerPid)",
  'operation: "purge-private-directory"',
  "removeEmptyPrivateDirectory(",
]) {
  if (!abandonedCleanupSource.includes(requiredAbandonedCleanupMarker)) {
    failures.push(
      "Recording reset cleanup is missing a descriptor-anchored ownership gate: " +
        requiredAbandonedCleanupMarker,
    );
  }
}
for (const requiredAbandonedCleanupRegression of [
  "abandoned session cleanup rejects a live marker owner without deleting state",
  "abandoned session cleanup fails closed when the session path is substituted before purge",
  "abandoned session cleanup binds purge to the marker bytes it verified",
]) {
  if (!runtimeProofRunnerTest.includes(requiredAbandonedCleanupRegression)) {
    failures.push(
      "Recording reset cleanup regression is missing: " +
        requiredAbandonedCleanupRegression,
    );
  }
}
if (
  !runtimeProofCli.includes("cleanupAbandonedRuntimeProofSessions({ artifactRoot })") ||
  runtimeProofCli.includes("rm(candidate, { recursive: true")
) {
  failures.push(
    "Recording reset must delegate to descriptor-anchored abandoned-session cleanup",
  );
}
for (const requiredRunnerDeadlineMarker of [
  "assertRuntimeProofRecordingWindow({",
  "beforeCommit: () =>",
  "recordingDeadlineAt,",
]) {
  if (!runtimeProofRunner.includes(requiredRunnerDeadlineMarker)) {
    failures.push(
      "Recording deadline is not retained through final publication: " +
        requiredRunnerDeadlineMarker,
    );
  }
}
for (const requiredCliDeadlineMarker of [
  "recordingDeadlineAt,",
  "signal: browserProofSignal,",
]) {
  if (!runtimeProofCli.includes(requiredCliDeadlineMarker)) {
    failures.push(
      "Recording deadline is not retained through CLI publication: " +
        requiredCliDeadlineMarker,
    );
  }
}
if (
  runtimeProofCli.indexOf("if (recordingTimer !== null) clearTimeout(recordingTimer);") <
  runtimeProofCli.indexOf("await finalizeRuntimeProofPublication({")
) {
  failures.push(
    "Recording deadline timer must remain armed through final publication",
  );
}
for (const requiredDeadlineRegression of [
  "a browser close that crosses the recording deadline cannot publish",
  "publication rechecks the recording deadline at the commit boundary",
]) {
  if (!runtimeProofRunnerTest.includes(requiredDeadlineRegression)) {
    failures.push(
      "Recording deadline regression is missing: " + requiredDeadlineRegression,
    );
  }
}
for (const requiredVisibleRecordingMarker of [
  'data-recording-run-id={outcome.safe.id}',
  'data-recording-run-id={outcome.unsafe.id}',
  'data-recording-run-id={outcome.repaired.id}',
  "data-recording-parent-id={",
  'aria-label="Verified chain summary"',
  'data-recording-proof="signatures"',
  'data-recording-proof="parent-digest"',
  'data-recording-proof="state-handoff"',
  'data-recording-proof="exact-lineage"',
]) {
  if (!recordingApp.includes(requiredVisibleRecordingMarker)) {
    failures.push(
      "Recording UI is missing above-the-fold exact evidence: " +
        requiredVisibleRecordingMarker,
    );
  }
}
for (const requiredViewportAssertionMarker of [
  "async function assertInsideRecordingViewport(",
  "await assertInsideRecordingViewport(field, viewport",
  "async function assertVerifierRecordingSummary({",
  "scrollTop !== 0",
]) {
  if (!runtimeProofRunner.includes(requiredViewportAssertionMarker)) {
    failures.push(
      "Recording gate is missing exact visible-frame enforcement: " +
        requiredViewportAssertionMarker,
    );
  }
}
if (
  acquireLeaseSource.includes("processExists") ||
  acquireLeaseSource.includes("rm(leasePath") ||
  acquireLeaseSource.includes("resetRequested")
) {
  failures.push(
    "Recording proof lease acquisition must fail closed without stale-path reclamation",
  );
}
if (
  !runtimeProofRunner.includes("function runtimeProofProcessExists(pid)") ||
  !runtimeProofCli.includes("await stopRuntimeProofChild(launcher)") ||
  !runtimeProofCli.includes(
    "if (!runtimeProofChildExitSucceeded(launcherOutcome))",
  ) ||
  !runtimeProofCli.includes('throw new RuntimeProofError("stage-timeout")') ||
  !runtimeProofCli.includes("APPLICATION_BUILD_TIMEOUT_MS") ||
  !runtimeProofCli.includes("RUNTIME_IMAGE_BUILD_TIMEOUT_MS") ||
  !runtimeProofCli.includes("RUNTIME_PROOF_RECORDING_BUDGET_MS") ||
  !runtimeProofCli.includes('new RuntimeProofError("recording-timeout")') ||
  !runtimeProofRunner.includes("runRuntimeProofArtifactWorker") ||
  !runtimeProofRunner.includes("anchor.handle.fd") ||
  !runtimeProofRunner.includes('operation: "purge-private-directory"') ||
  runtimeProofRunner.includes("await rm(resolved, { recursive: true") ||
  !runtimeProofRunner.includes("runtimeProofCapsuleFile") ||
  !runtimeProofRunner.includes("ensureCapsuleDirectory") ||
  !runtimeProofRunner.includes("readExistingImmutableChain") ||
  !runtimeProofRunner.includes("assertExistingChainDirectory") ||
  !runtimeProofTerminal.includes("export async function stopRuntimeProofChild") ||
  !runtimeProofTerminal.includes(
    "export function waitForRuntimeProofChildOutcome",
  ) ||
  !containerBrowserFixture.includes("await stopRuntimeProofChild(child")
) {
  failures.push(
    "Recording proof must bound preparation, safely recover sessions, contain immutable chains, and confirm every owned child exit",
  );
}
const fixtureShutdownSource = containerBrowserFixture.slice(
  containerBrowserFixture.indexOf("async function shutdown("),
  containerBrowserFixture.indexOf('for (const signal of ["SIGINT", "SIGTERM"])'),
);
if (
  !fixtureShutdownSource.includes("!configuredProofSessionRoot") ||
  fixtureShutdownSource.includes(
    "rm(configuredProofSessionRoot, { recursive: true, force: true })",
  ) ||
  fixtureShutdownSource.includes("rm(proofRoot, { recursive: true, force: true })")
) {
  failures.push(
    "The inner container fixture must never delete a managed Runtime proof session owned by its launcher",
  );
}
const federationUiProof = await readFile(
  path.join(projectRoot, "tests/phase11-ui/federation-airlock.spec.ts"),
  "utf8",
);
for (const requiredProof of [
  "discovers and resolves a pending Admission after a full browser reload",
  "fails closed when a stale operator contradicts an append-only decision",
  "shows predicted receiver blockers without claiming authoritative validation",
  "PRODUCER CLAIM · NOT RECEIVER AUTHORITY",
  "No predicted metadata blocker",
  "Approval never bypasses receiver Validation",
  "refreshes a stale review after receiver policy rotation without losing the reason",
  "Decision bound to this exact review",
  "Reviewed context ",
]) {
  if (!federationUiProof.includes(requiredProof)) {
    failures.push("Federation operator continuity proof is missing: " + requiredProof);
  }
}
const federationRealProof = await readFile(
  path.join(projectRoot, "tests/phase12-real/federated-browser.spec.ts"),
  "utf8",
);
if (
  !federationRealProof.includes("await page.reload()") ||
  !federationRealProof.includes("Federated approval inbox") ||
  !federationRealProof.includes("Pending Admission review") ||
  !federationRealProof.includes("No predicted metadata blocker") ||
  !federationRealProof.includes("Approval never bypasses receiver Validation") ||
  !federationRealProof.includes("Decision bound to this exact review") ||
  !federationRealProof.includes("Reviewed context sha256:")
) {
  failures.push(
    "Two-instance federation proof must cross receiver reload and inspect the bounded Admission review and receiver preflight",
  );
}
const federationHttpProof = await readFile(
  path.join(projectRoot, "apps/server/src/federated-http.test.ts"),
  "utf8",
);
for (const requiredProof of [
  "predicts protected-path blockers from the exact staged metadata without creating a Run",
  'status: "predicted-blocker"',
  'code: "protected-path-change"',
  "rejects a stale receiver review after Outcome Contract rotation before Candidate preparation",
  "Receiver review context is stale; refresh the Admission before deciding",
  "rotatedDecisionContextDigest",
  "decisionContextDigest,",
]) {
  if (!federationHttpProof.includes(requiredProof)) {
    failures.push("Receiver metadata preflight proof is missing: " + requiredProof);
  }
}
const federationApprovalProof = await readFile(
  path.join(projectRoot, "apps/server/src/federated-approval-journal.test.ts"),
  "utf8",
);
for (const requiredProof of [
  "recovers a legacy decision without inventing reviewed-context evidence",
  "silently changed",
  'schemaVersion: 2,',
  "decisionContextDigest",
]) {
  if (!federationApprovalProof.includes(requiredProof)) {
    failures.push("Durable reviewed-context proof is missing: " + requiredProof);
  }
}

if (failures.length > 0) {
  console.error("Release audit failed:\n" + failures.map((item) => "- " + item).join("\n"));
  process.exit(1);
}

console.log(
  "Release audit passed: " +
    trackedFiles.length +
    " release files, no high-confidence secrets in files or Git history, conflicts, or broken relative Markdown targets.",
);
