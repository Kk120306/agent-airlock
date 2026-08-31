import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { approvedModelArkBoundaryDocuments } from "./modelark-claim-policy.mjs";
import { releaseLockfileDependencyFindings } from "./release-lockfile-policy.mjs";
import { releaseFileInventory } from "./release-index-policy.mjs";
import { inspectJudgeGalleryJpeg } from "./release-image-policy.mjs";
import { approvedLocalComposeIdentityPolicy } from "./release-compose-policy.mjs";
import {
  approvedReleaseExecutionPolicy,
  approvedStoppedRuntimePublicationPolicy,
  releaseExecutionDependencyPaths,
} from "./release-execution-policy.mjs";
import {
  approvedReleaseQualityPipeline,
  requiredReleaseWorkspaceScripts,
} from "./release-quality-policy.mjs";
import {
  highConfidenceReachableGitObjectFindings,
  highConfidenceSecretFindings,
} from "./release-secret-policy.mjs";
import {
  ProductionImageVerificationError,
  verifyProductionImageHttp,
} from "./production-image-verifier.mjs";
import { runTrustedGit } from "./trusted-git-exec.mjs";

const projectRoot = path.resolve(".");
const [cachedInventory, scannedInventory] = await Promise.all([
  runTrustedGit(["ls-files", "-z", "--cached"], {
    cwd: projectRoot,
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024,
  }),
  runTrustedGit(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: projectRoot,
      encoding: "buffer",
      maxBuffer: 20 * 1024 * 1024,
    },
  ),
]);
const { cachedFiles, cachedFileSet, scannedFiles } = releaseFileInventory({
  cachedOutput: cachedInventory.stdout,
  scannedOutput: scannedInventory.stdout,
});
const failures = [];

const validProductionImageDocument =
  '<!doctype html><html><head><title>Agent Airlock</title></head><body><div id="root"></div><script type="module" src="/assets/index-release.js"></script></body></html>';
const validProductionImageScript = "x".repeat(100_000);

function productionImageResponse(body, contentType, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

function productionImageFixtureFetch({
  health = { ok: true, service: "volc-agent-launchpad" },
  healthStatus = 200,
  healthType = "application/json; charset=utf-8",
  document = validProductionImageDocument,
  documentStatus = 200,
  documentType = "text/html; charset=utf-8",
  script = validProductionImageScript,
  scriptStatus = 200,
  scriptType = "text/javascript; charset=utf-8",
} = {}) {
  return async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/health") {
      return productionImageResponse(
        JSON.stringify(health),
        healthType,
        healthStatus,
      );
    }
    if (pathname === "/") {
      return productionImageResponse(document, documentType, documentStatus);
    }
    if (pathname === "/assets/index-release.js") {
      return productionImageResponse(script, scriptType, scriptStatus);
    }
    return productionImageResponse("not found", "text/plain", 404);
  };
}

async function productionImageVerifierRejects(options) {
  try {
    await verifyProductionImageHttp({
      origin: "http://127.0.0.1:3000",
      fetchImpl: productionImageFixtureFetch(options),
    });
    return false;
  } catch (error) {
    return error instanceof ProductionImageVerificationError;
  }
}

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
for (const file of scannedFiles) {
  if (/^\.env(?:\.|$)/.test(path.basename(file)) && file !== ".env.example") {
    failures.push("Tracked environment file: " + file);
  }
  if (path.basename(file) === ".npmrc") {
    failures.push("Tracked project npm configuration: " + file);
  }
}

try {
  for (const secretName of highConfidenceReachableGitObjectFindings(
    projectRoot,
  )) {
    failures.push(secretName + " in Git history");
  }
} catch {
  failures.push("Git history scan was incomplete or unsafe");
}

for (const file of scannedFiles) {
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

for (const markdownFile of scannedFiles.filter((file) =>
  file.endsWith(".md"),
)) {
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
    const resolved = path.resolve(
      projectRoot,
      path.dirname(markdownFile),
      target,
    );
    try {
      await access(resolved);
    } catch {
      failures.push(
        "Broken Markdown target in " + markdownFile + ": " + target,
      );
    }
  }
}

const modelArkStatusDocuments = [];
for (const statusFile of modelArkStatusFiles) {
  if (!cachedFileSet.has(statusFile)) {
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
  failures.push(
    "README must disclose that live ModelArk conformance is rerun at judging time",
  );
}
const requiredJudgeGalleryAssets = [
  "docs/assets/agent-airlock-live-01-overview.jpg",
  "docs/assets/agent-airlock-live-02-quarantine.jpg",
  "docs/assets/agent-airlock-live-03-verified-recovery.jpg",
  "docs/assets/agent-airlock-live-04-zero-upload-verifier.jpg",
];
for (const galleryAsset of requiredJudgeGalleryAssets) {
  if (!cachedFileSet.has(galleryAsset)) {
    failures.push("Missing tracked judge gallery asset: " + galleryAsset);
  }
  if (!readme.includes(galleryAsset)) {
    failures.push("README is missing judge gallery asset: " + galleryAsset);
  }
  try {
    const galleryBytes = await readFile(path.join(projectRoot, galleryAsset));
    if (inspectJudgeGalleryJpeg(galleryBytes) === null) {
      failures.push(
        "Judge gallery asset is not a bounded nontrivial JPEG: " + galleryAsset,
      );
    }
  } catch {
    failures.push("Judge gallery asset could not be read: " + galleryAsset);
  }
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
for (const [scriptName, command] of Object.entries(
  requiredRuntimeProofScripts,
)) {
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
  "scripts/release-compose-policy.mjs",
  "scripts/release-compose-policy.test.mjs",
  "scripts/release-execution-policy.mjs",
  "scripts/release-execution-policy.test.mjs",
  "scripts/release-index-policy.mjs",
  "scripts/release-image-policy.mjs",
  "scripts/production-build-context.mjs",
  "scripts/production-build-context.test.mjs",
  "scripts/production-image-verifier.mjs",
  "scripts/production-image-verifier.test.mjs",
  "scripts/check-production-image-browser.mjs",
  "scripts/check-production-image-browser.test.mjs",
  "scripts/check-production-image-transaction.mjs",
  "scripts/check-production-image-transaction.test.mjs",
  "scripts/production-image-persistence-verifier.mjs",
  "scripts/production-image-persistence-verifier.test.mjs",
  "scripts/production-image-provenance.mjs",
  "scripts/production-image-provenance.test.mjs",
  "scripts/production-gate-cleanup.test.mjs",
  "scripts/submission-artifact-binding.mjs",
  "scripts/submission-artifact-binding.test.mjs",
  "scripts/submission-audit.mjs",
  "scripts/submission-audit.test.mjs",
  "scripts/trusted-git-exec.mjs",
]) {
  if (!cachedFileSet.has(requiredSubmissionAuditFile)) {
    failures.push(
      "Missing tracked submission handoff gate: " + requiredSubmissionAuditFile,
    );
  }
  if (!hasExactSyntaxCheck(requiredSubmissionAuditFile)) {
    failures.push(
      "check:scripts is missing submission handoff coverage: " +
        requiredSubmissionAuditFile,
    );
  }
}
for (const requiredTrackedReleaseBoundary of [
  ".github/workflows/release-proof.yml",
  "Dockerfile",
  "Dockerfile.runtime",
  "docker-compose.yml",
  "scripts/bootstrap-local.sh",
  "scripts/start-local-poc.sh",
  "scripts/deploy-existing-ecs.sh",
  "scripts/check-phase-eleven-docker.sh",
  "deploy/volcengine/main.tf",
  "docs/DEPLOYMENT.md",
]) {
  if (!cachedFileSet.has(requiredTrackedReleaseBoundary)) {
    failures.push(
      "Missing tracked production release boundary: " +
        requiredTrackedReleaseBoundary,
    );
  }
}
for (const releaseExecutionDependencyPath of releaseExecutionDependencyPaths) {
  if (!cachedFileSet.has(releaseExecutionDependencyPath)) {
    failures.push(
      "Missing tracked production execution dependency: " +
        releaseExecutionDependencyPath,
    );
  }
}
if (
  !scriptCheckCommands.includes("bash -n scripts/check-phase-eleven-docker.sh")
) {
  failures.push(
    "check:scripts must syntax-check the shipped production-image Compose gate",
  );
}
if (!cachedFileSet.has("scripts/release-index-policy.mjs")) {
  failures.push("Missing tracked release index provenance gate");
}
if (!cachedFileSet.has("scripts/release-image-policy.mjs")) {
  failures.push("Missing tracked judge gallery validation gate");
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
  if (!hasExactSyntaxCheck(requiredRuntimeProofCheck)) {
    failures.push(
      "check:scripts is missing Runtime proof coverage: " +
        requiredRuntimeProofCheck,
    );
  }
}
const scriptTestCommandOffset =
  typeof scriptChecks === "string"
    ? scriptChecks.lastIndexOf("&& node --test ")
    : -1;
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
for (const requiredProductionGateTest of [
  "scripts/production-build-context.test.mjs",
  "scripts/production-image-verifier.test.mjs",
  "scripts/check-production-image-browser.test.mjs",
  "scripts/check-production-image-transaction.test.mjs",
  "scripts/production-image-persistence-verifier.test.mjs",
  "scripts/production-image-provenance.test.mjs",
  "scripts/release-compose-policy.test.mjs",
  "scripts/release-execution-policy.test.mjs",
  "scripts/production-gate-cleanup.test.mjs",
]) {
  if (!scriptTestCommand.includes(requiredProductionGateTest)) {
    failures.push(
      "check:scripts must execute the release-critical mutation test: " +
        requiredProductionGateTest,
    );
  }
}
if (
  !hasExactSyntaxCheck("scripts/check-production-image-browser.test.mjs") ||
  !scriptTestCommand.includes("scripts/check-production-image-browser.test.mjs")
) {
  failures.push(
    "check:scripts must syntax-check and execute the production image browser mutation test",
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
const composePolicyApproved = approvedLocalComposeIdentityPolicy({
  bootstrapSource: await readFile(
    path.join(projectRoot, "scripts/bootstrap-local.sh"),
    "utf8",
  ),
  composeSource: await readFile(
    path.join(projectRoot, "docker-compose.yml"),
    "utf8",
  ),
  deploymentDocumentSource: await readFile(
    path.join(projectRoot, "docs/DEPLOYMENT.md"),
    "utf8",
  ),
  deploymentSource: await readFile(
    path.join(projectRoot, "scripts/deploy-existing-ecs.sh"),
    "utf8",
  ),
  productGateSource: await readFile(
    path.join(projectRoot, "scripts/check-phase-eleven-docker.sh"),
    "utf8",
  ),
  terraformSource: await readFile(
    path.join(projectRoot, "deploy/volcengine/main.tf"),
    "utf8",
  ),
});
if (!composePolicyApproved) {
  failures.push(
    "Shipped Compose, bootstrap, product gate, and public deployment identity policy is not approved",
  );
}
if (!releaseWorkflow.includes("npm run test:phase12:real")) {
  failures.push("Hosted Release proof is missing: npm run test:phase12:real");
}
const runtimeProofJobMarker = "\n  real-runtime-proof:\n";
const runtimeProofJobOffset = releaseWorkflow.indexOf(runtimeProofJobMarker);
const runtimeProofJob =
  runtimeProofJobOffset === -1
    ? ""
    : releaseWorkflow.slice(
        runtimeProofJobOffset + runtimeProofJobMarker.length,
      );
if (!runtimeProofJob) {
  failures.push("Hosted Release proof is missing the real-runtime-proof job");
}
for (const requiredRuntimeProofStep of [
  "LAUNCHPAD_ENV_FILE=.env.example docker compose config --quiet",
  "bash scripts/check-phase-eleven-docker.sh",
  "PRODUCTION_IMAGE_ARTIFACT_DIRECTORY: ${{ runner.temp }}/agent-airlock-production-image",
  "name: agent-airlock-production-image",
  "agent-airlock-production-image/agent-airlock-production-image.tar",
  "agent-airlock-production-image/agent-airlock-production-image-provenance.json",
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
const productionImageGate = await readFile(
  path.join(projectRoot, "scripts/check-phase-eleven-docker.sh"),
  "utf8",
);
const proveRuntimeSource = await readFile(
  path.join(projectRoot, "scripts/prove-runtime.mjs"),
  "utf8",
);
const runtimeProofTestSource = await readFile(
  path.join(projectRoot, "scripts/runtime-proof-runner.test.mjs"),
  "utf8",
);
const releaseExecutionDependencySources = Object.fromEntries(
  await Promise.all(
    releaseExecutionDependencyPaths.map(async (dependencyPath) => [
      dependencyPath,
      await readFile(path.join(projectRoot, dependencyPath), "utf8"),
    ]),
  ),
);
if (
  !approvedReleaseExecutionPolicy({
    dependencySources: releaseExecutionDependencySources,
    productGateSource: productionImageGate,
    workflowSource: releaseWorkflow,
  })
) {
  failures.push(
    "Hosted workflow and shipped production-image gate do not preserve the approved executable lifecycle",
  );
}
if (
  !approvedStoppedRuntimePublicationPolicy({
    proveRuntimeSource,
    runtimeProofTestSource,
  })
) {
  failures.push(
    "Runtime proof publication is not bound to the stopped physical snapshot boundary",
  );
}
for (const requiredProductionImageGate of [
  'node scripts/production-image-verifier.mjs --origin "$ORIGIN"',
  'node scripts/check-production-image-browser.mjs --origin "$ORIGIN"',
]) {
  if (!productionImageGate.includes(requiredProductionImageGate)) {
    failures.push(
      "Production image gate is missing an executable semantic check: " +
        requiredProductionImageGate,
    );
  }
}
try {
  const accepted = await verifyProductionImageHttp({
    origin: "http://127.0.0.1:3000",
    fetchImpl: productionImageFixtureFetch(),
  });
  if (
    accepted.healthService !== "volc-agent-launchpad" ||
    accepted.scriptPath !== "/assets/index-release.js" ||
    accepted.scriptBytes !== 100_000
  ) {
    failures.push(
      "Production image verifier did not preserve its accepted response contract",
    );
  }
} catch {
  failures.push(
    "Production image verifier rejected the exact accepted response contract",
  );
}
for (const [name, mutation] of [
  ["failed health", { healthStatus: 503 }],
  ["wrong health service", { health: { ok: true, service: "other" } }],
  ["non-JSON health", { healthType: "text/plain" }],
  ["failed document", { documentStatus: 503 }],
  ["non-HTML document", { documentType: "text/plain" }],
  [
    "wrong title",
    {
      document: validProductionImageDocument.replace("Agent Airlock", "Other"),
    },
  ],
  [
    "missing React mount point",
    {
      document: validProductionImageDocument.replace(
        '<div id="root"></div>',
        "",
      ),
    },
  ],
  [
    "cross-origin application script",
    {
      document: validProductionImageDocument.replace(
        "/assets/index-release.js",
        "https://example.com/assets/index-release.js",
      ),
    },
  ],
  [
    "non-module application script",
    {
      document: validProductionImageDocument.replace(
        'type="module"',
        'type="text/javascript"',
      ),
    },
  ],
  ["failed application script", { scriptStatus: 503 }],
  ["non-JavaScript application script", { scriptType: "text/plain" }],
  ["truncated application script", { script: "x".repeat(99_999) }],
]) {
  if (!(await productionImageVerifierRejects(mutation))) {
    failures.push(
      "Production image verifier accepted a weakened response: " + name,
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
if (!cachedFileSet.has("scripts/check-phase-thirteen.mjs")) {
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
  if (!cachedFileSet.has(runtimeProofFile)) {
    failures.push(
      "Missing tracked recording-grade Runtime proof: " + runtimeProofFile,
    );
  }
}
for (const recordingOutcomeFile of [
  "apps/web/src/recording-outcome-policy.ts",
  "apps/web/src/recording-outcome-policy.test.ts",
]) {
  if (!cachedFileSet.has(recordingOutcomeFile)) {
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
  if (
    !runtimeProofArtifactWorker.includes(requiredCommitReconciliationMarker)
  ) {
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
  if (
    !runtimeProofArtifactWorkerTest.includes(requiredArtifactWorkerRegression)
  ) {
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
  !runtimeProofCli.includes(
    "cleanupAbandonedRuntimeProofSessions({ artifactRoot })",
  ) ||
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
  runtimeProofCli.indexOf(
    "if (recordingTimer !== null) clearTimeout(recordingTimer);",
  ) < runtimeProofCli.indexOf("await finalizeRuntimeProofPublication({")
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
  "data-recording-run-id={outcome.safe.id}",
  "data-recording-run-id={outcome.unsafe.id}",
  "data-recording-run-id={outcome.repaired.id}",
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
  !runtimeProofTerminal.includes(
    "export async function stopRuntimeProofChild",
  ) ||
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
  containerBrowserFixture.indexOf(
    'for (const signal of ["SIGINT", "SIGTERM"])',
  ),
);
if (
  !fixtureShutdownSource.includes("!configuredProofSessionRoot") ||
  fixtureShutdownSource.includes(
    "rm(configuredProofSessionRoot, { recursive: true, force: true })",
  ) ||
  fixtureShutdownSource.includes(
    "rm(proofRoot, { recursive: true, force: true })",
  )
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
    failures.push(
      "Federation operator continuity proof is missing: " + requiredProof,
    );
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
  !federationRealProof.includes(
    "Approval never bypasses receiver Validation",
  ) ||
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
    failures.push(
      "Receiver metadata preflight proof is missing: " + requiredProof,
    );
  }
}
const federationApprovalProof = await readFile(
  path.join(projectRoot, "apps/server/src/federated-approval-journal.test.ts"),
  "utf8",
);
for (const requiredProof of [
  "recovers a legacy decision without inventing reviewed-context evidence",
  "silently changed",
  "schemaVersion: 2,",
  "decisionContextDigest",
]) {
  if (!federationApprovalProof.includes(requiredProof)) {
    failures.push(
      "Durable reviewed-context proof is missing: " + requiredProof,
    );
  }
}

if (failures.length > 0) {
  console.error(
    "Release audit failed:\n" + failures.map((item) => "- " + item).join("\n"),
  );
  process.exit(1);
}

console.log(
  "Release audit passed: " +
    cachedFiles.length +
    " cached release files and " +
    scannedFiles.length +
    " scanned candidate files, no high-confidence secrets in files or Git history, conflicts, or broken relative Markdown targets.",
);
