import { execFile as execFileCallback } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(".");
const { stdout } = await execFile(
  "git",
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
  "docs/demo/JUDGE_CHECKLIST.md",
  "docs/demo/three-minute-demo.md",
  "docs/product/OUTCOME_ROADMAP.md",
  "docs/product/PRD.md",
];
const staleModelArkSuccessClaims = [
  /credentialed ModelArk acceptance journey passed/i,
  /live ModelArk (?:acceptance|conformance|promotion)[^.\n]*(?:passed|complete|verified|successful)/i,
];

for (const file of trackedFiles) {
  if (/^\.env(?:\.|$)/.test(path.basename(file)) && file !== ".env.example") {
    failures.push("Tracked environment file: " + file);
  }
}

const highConfidenceSecrets = [
  { name: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/g },
  { name: "Volcengine access key", pattern: /\bAKLT[A-Za-z0-9]{16,}\b/g },
  {
    name: "private key block",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]{16,}\r?\n)+-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    historyPattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n(?:[ +\-][A-Za-z0-9+/=]{16,}\r?\n)+[ +\-]-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
];

const { stdout: history } = await execFile(
  "git",
  ["log", "-p", "--all", "--no-ext-diff", "--format=commit %H"],
  {
    cwd: projectRoot,
    encoding: "buffer",
    maxBuffer: 100 * 1024 * 1024,
  },
);
const historyText = history.toString("utf8");
for (const scanner of highConfidenceSecrets) {
  const historyPattern = scanner.historyPattern ?? scanner.pattern;
  historyPattern.lastIndex = 0;
  if (historyPattern.test(historyText)) {
    failures.push(scanner.name + " in Git history");
  }
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
  for (const scanner of highConfidenceSecrets) {
    scanner.pattern.lastIndex = 0;
    if (scanner.pattern.test(content)) {
      failures.push(scanner.name + ": " + file);
    }
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

for (const statusFile of modelArkStatusFiles) {
  if (!trackedFiles.includes(statusFile)) {
    failures.push("Missing ModelArk status document: " + statusFile);
    continue;
  }
  const content = await readFile(path.join(projectRoot, statusFile), "utf8");
  for (const pattern of staleModelArkSuccessClaims) {
    if (pattern.test(content)) {
      failures.push("Stale live ModelArk success claim: " + statusFile);
      break;
    }
  }
}

const readme = await readFile(path.join(projectRoot, "README.md"), "utf8");
if (!readme.includes("must be rerun at judging time")) {
  failures.push("README must disclose that live ModelArk conformance is rerun at judging time");
}

const packageManifest = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
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
for (const requiredCommand of [
  "npm run test:phase12:real",
  "npm run check:phase13:runtime",
]) {
  if (!releaseWorkflow.includes(requiredCommand)) {
    failures.push("Hosted Release proof is missing: " + requiredCommand);
  }
}
if (!trackedFiles.includes("scripts/check-phase-thirteen.mjs")) {
  failures.push("Missing tracked Phase 13 combined Runtime proof");
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
