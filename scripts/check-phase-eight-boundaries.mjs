import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(".");
const sdkRoot = path.join(projectRoot, "packages/transactional-resource-sdk");
const providerRoot = path.join(projectRoot, "packages/http-object-resource");
const sdkPackage = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));
const providerPackage = JSON.parse(
  await readFile(path.join(providerRoot, "package.json"), "utf8"),
);
const failures = [];

if (Object.keys(sdkPackage.dependencies ?? {}).length > 0) {
  failures.push("Transactional Resource SDK has runtime dependencies");
}
const providerDependencies = Object.keys(providerPackage.dependencies ?? {});
if (
  providerDependencies.length !== 1 ||
  providerDependencies[0] !== "@agent-airlock/transactional-resource-sdk"
) {
  failures.push("HTTP object provider must depend only on the SDK at runtime");
}

for (const file of await typescriptFiles(path.join(sdkRoot, "src"))) {
  if (file.endsWith(".test.ts")) continue;
  const content = await readFile(file, "utf8");
  for (const specifier of importSpecifiers(content)) {
    if (!specifier.startsWith(".") && !specifier.startsWith("node:")) {
      failures.push("SDK imports disallowed runtime module " + specifier);
    }
  }
  if (content.includes("apps/server")) {
    failures.push("SDK source imports or names the server application");
  }
}

for (const file of await typescriptFiles(path.join(providerRoot, "src"))) {
  if (file.endsWith(".test.ts")) continue;
  const content = await readFile(file, "utf8");
  for (const specifier of importSpecifiers(content)) {
    if (
      !specifier.startsWith(".") &&
      !specifier.startsWith("node:") &&
      specifier !== "@agent-airlock/transactional-resource-sdk"
    ) {
      failures.push("HTTP object provider imports disallowed module " + specifier);
    }
  }
  if (content.includes("apps/server") || content.includes("@launchpad/server")) {
    failures.push("HTTP object provider imports or names the server application");
  }
}

const runnerSource = await readFile(
  path.join(projectRoot, "apps/server/src/airlock-runner.ts"),
  "utf8",
);
if (/http-object|versioned-http-object|HttpObjectResourceProvider/.test(runnerSource)) {
  failures.push("AirlockRunner contains reference-provider-specific lifecycle code");
}

if (failures.length > 0) {
  process.stderr.write(
    "Phase 8 package boundary check failed:\n" +
      failures.map((failure) => "- " + failure).join("\n") +
      "\n",
  );
  process.exit(1);
}

process.stdout.write(
  "Phase 8 package boundaries passed: zero-dependency SDK, SDK-only provider, and provider-neutral AirlockRunner.\n",
);

async function typescriptFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFiles(target)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}

function importSpecifiers(content) {
  return [
    ...content.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g),
  ].map((match) => match[2]);
}
