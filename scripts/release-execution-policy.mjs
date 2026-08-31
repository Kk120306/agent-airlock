import { createHash } from "node:crypto";

import ts from "typescript";

const approvedReleaseSourceDigests = Object.freeze({
  productGateSource:
    "fcc50b79634c7caeeccba19d353b5fb3502d024b81b49a8e6dff89e69bafa27f",
  proveRuntimeSource:
    "f9d96158196a8165ed39eaba2e4d139538970cac09624a794606ba45a7690521",
  runtimeProofTestSource:
    "d0e99ce70eac6b9dbad24678337d9a146ee916d56094a226fa0ba3943805b7b4",
  workflowSource:
    "5652876cff63c7d9bf2d889189801730ca3d9721cf91bc6d705da19f127a007f",
});

export const releaseExecutionDependencyPaths = Object.freeze([
  ".dockerignore",
  "Dockerfile",
  "Dockerfile.runtime",
  "docker-compose.yml",
  "docker/codex-runtime/package-lock.json",
  "docker/codex-runtime/package.json",
  "package-lock.json",
  "package.json",
  "playwright.container-browser.config.ts",
  "scripts/check-phase-thirteen.mjs",
  "scripts/check-production-image-browser.mjs",
  "scripts/check-production-image-browser.test.mjs",
  "scripts/check-production-image-transaction.mjs",
  "scripts/check-production-image-transaction.test.mjs",
  "scripts/container-browser-fixture-startup.mjs",
  "scripts/container-browser-fixture-startup.test.mjs",
  "scripts/demo-outcome-contract.mjs",
  "scripts/judge-readiness.mjs",
  "scripts/modelark-demo-profile.mjs",
  "scripts/production-build-context.mjs",
  "scripts/production-build-context.test.mjs",
  "scripts/production-gate-cleanup.test.mjs",
  "scripts/production-image-persistence-verifier.mjs",
  "scripts/production-image-persistence-verifier.test.mjs",
  "scripts/production-image-provenance.mjs",
  "scripts/production-image-provenance.test.mjs",
  "scripts/production-image-verifier.mjs",
  "scripts/production-image-verifier.test.mjs",
  "scripts/release-compose-policy.mjs",
  "scripts/release-compose-policy.test.mjs",
  "scripts/run-container-browser-fixture.mjs",
  "scripts/runtime-demo-profile.mjs",
  "scripts/runtime-proof-terminal.mjs",
  "scripts/runtime-source-provenance.mjs",
  "scripts/runtime-source-provenance.test.mjs",
  "scripts/trusted-git-exec.mjs",
  "tests/container-browser/global-teardown.ts",
  "tests/container-browser/real-container.spec.ts",
  "tests/fixtures/responses-protocol-server.mjs",
  "tsconfig.base.json",
]);

const approvedReleaseDependencyClosureDigest =
  "0cbb63c6b0153dd514fb790203a9724178d07b82984514cbd7686fe846eade4c";

function approvedSourceDigest(name, source) {
  return (
    typeof source === "string" &&
    createHash("sha256").update(source, "utf8").digest("hex") ===
      approvedReleaseSourceDigests[name]
  );
}

function approvedDependencyClosure(dependencySources) {
  if (
    !dependencySources ||
    typeof dependencySources !== "object" ||
    Array.isArray(dependencySources)
  ) {
    return false;
  }
  const providedPaths = Object.keys(dependencySources).sort();
  if (
    providedPaths.length !== releaseExecutionDependencyPaths.length ||
    providedPaths.some(
      (dependencyPath, index) =>
        dependencyPath !== releaseExecutionDependencyPaths[index],
    )
  ) {
    return false;
  }
  const closure = [];
  for (const dependencyPath of releaseExecutionDependencyPaths) {
    const source = dependencySources[dependencyPath];
    if (typeof source !== "string") return false;
    closure.push([
      dependencyPath,
      createHash("sha256").update(source, "utf8").digest("hex"),
    ]);
  }
  return (
    createHash("sha256")
      .update(JSON.stringify(closure), "utf8")
      .digest("hex") === approvedReleaseDependencyClosureDigest
  );
}

function indentation(line) {
  return line.match(/^[ \t]*/u)?.[0].replaceAll("\t", "  ").length ?? 0;
}

function activeYamlLine(line) {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith("#");
}

function workflowJobRunSteps(source, jobName) {
  if (typeof source !== "string" || typeof jobName !== "string") return [];
  const lines = source.split(/\r?\n/u);
  const jobs = lines
    .map((line, index) => ({ index, line }))
    .filter(
      ({ line }) =>
        activeYamlLine(line) && /^jobs:\s*(?:#.*)?$/u.test(line.trim()),
    );
  if (jobs.length !== 1 || indentation(jobs[0].line) !== 0) return [];

  const jobsIndex = jobs[0].index;
  let jobsEnd = lines.length;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    if (activeYamlLine(lines[index]) && indentation(lines[index]) === 0) {
      jobsEnd = index;
      break;
    }
  }

  const escapedJobName = jobName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const jobPattern = new RegExp(`^${escapedJobName}:\\s*(?:#.*)?$`, "u");
  const jobMatches = [];
  for (let index = jobsIndex + 1; index < jobsEnd; index += 1) {
    const line = lines[index];
    if (
      activeYamlLine(line) &&
      indentation(line) === 2 &&
      jobPattern.test(line.trim())
    ) {
      jobMatches.push(index);
    }
  }
  if (jobMatches.length !== 1) return [];

  const jobIndex = jobMatches[0];
  let jobEnd = jobsEnd;
  for (let index = jobIndex + 1; index < jobsEnd; index += 1) {
    if (activeYamlLine(lines[index]) && indentation(lines[index]) <= 2) {
      jobEnd = index;
      break;
    }
  }

  const jobDirectives = lines
    .slice(jobIndex + 1, jobEnd)
    .filter((line) => activeYamlLine(line) && indentation(line) === 4)
    .map((line) => line.trim());
  if (
    jobDirectives.some(
      (line) => line.startsWith("if:") || line.startsWith("continue-on-error:"),
    )
  ) {
    return [];
  }
  const stepsIndexes = [];
  for (let index = jobIndex + 1; index < jobEnd; index += 1) {
    if (lines[index] === "    steps:") stepsIndexes.push(index);
  }
  if (stepsIndexes.length !== 1) return [];
  const stepsIndex = stepsIndexes[0];
  const stepStarts = [];
  for (let index = stepsIndex + 1; index < jobEnd; index += 1) {
    if (
      activeYamlLine(lines[index]) &&
      indentation(lines[index]) === 6 &&
      lines[index].trim().startsWith("- ")
    ) {
      stepStarts.push(index);
    }
  }
  const runSteps = [];
  for (let stepNumber = 0; stepNumber < stepStarts.length; stepNumber += 1) {
    const stepStart = stepStarts[stepNumber];
    const stepEnd = stepStarts[stepNumber + 1] ?? jobEnd;
    const direct = lines
      .slice(stepStart, stepEnd)
      .filter(
        (line, offset) =>
          activeYamlLine(line) && indentation(line) === (offset === 0 ? 6 : 8),
      )
      .map((line) => line.trim().replace(/^-\s+/u, ""));
    if (
      direct.some(
        (line) =>
          line.startsWith("if:") ||
          line.startsWith("continue-on-error:") ||
          line.startsWith("shell:"),
      )
    ) {
      continue;
    }
    for (let index = stepStart; index < stepEnd; index += 1) {
      const line = lines[index];
      if (!activeYamlLine(line)) continue;
      const match = line.match(/^(\s*)run:\s*(.*?)\s*$/u);
      if (!match || indentation(line) !== 8) continue;
      const runIndent = indentation(line);
      const value = match[2];
      if (value === "|" || value === "|-" || value === "|+") {
        const block = [];
        let blockIndent = null;
        let cursor = index + 1;
        for (; cursor < jobEnd; cursor += 1) {
          const blockLine = lines[cursor];
          if (
            activeYamlLine(blockLine) &&
            indentation(blockLine) <= runIndent
          ) {
            break;
          }
          if (blockLine.trim().length > 0) {
            blockIndent ??= indentation(blockLine);
          }
          block.push(blockLine);
        }
        if (blockIndent !== null && blockIndent > runIndent) {
          runSteps.push({
            name:
              direct
                .find((entry) => entry.startsWith("name:"))
                ?.slice(5)
                .trim() ?? null,
            source: block
              .map((blockLine) =>
                blockLine.slice(Math.min(blockIndent, blockLine.length)),
              )
              .join("\n"),
          });
        }
        index = cursor - 1;
        continue;
      }
      if (value === ">" || value === ">-" || value === ">+") {
        return [];
      }
      if (value.length > 0 && !value.startsWith("#")) {
        runSteps.push({
          name:
            direct
              .find((entry) => entry.startsWith("name:"))
              ?.slice(5)
              .trim() ?? null,
          source: value,
        });
      }
    }
  }
  return runSteps;
}

function workflowJobSection(source, jobName) {
  if (
    typeof source !== "string" ||
    typeof jobName !== "string" ||
    source.includes("\t")
  ) {
    return null;
  }
  const lines = source.split(/\r?\n/u);
  const jobsIndex = lines.findIndex((line) => line === "jobs:");
  if (jobsIndex < 0) return null;
  let jobsEnd = lines.length;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    if (activeYamlLine(lines[index]) && indentation(lines[index]) === 0) {
      jobsEnd = index;
      break;
    }
  }
  const jobStarts = [];
  for (let index = jobsIndex + 1; index < jobsEnd; index += 1) {
    const match = lines[index].match(/^  ([a-z0-9-]+):\s*$/u);
    if (match) jobStarts.push({ index, name: match[1] });
  }
  const matches = jobStarts.filter(({ name }) => name === jobName);
  if (matches.length !== 1) return null;
  const jobStart = matches[0].index;
  const next =
    jobStarts.find(({ index }) => index > jobStart)?.index ?? jobsEnd;
  return {
    jobNames: jobStarts.map(({ name }) => name),
    lines: lines.slice(jobStart, next),
  };
}

function exactDirectives(lines, indent) {
  return lines
    .filter((line) => activeYamlLine(line) && indentation(line) === indent)
    .map((line) => line.trim().replace(/^-\s+/u, ""));
}

function workflowStepSections(jobLines) {
  const stepsIndex = jobLines.findIndex((line) => line === "    steps:");
  if (stepsIndex < 0) return [];
  const starts = [];
  for (let index = stepsIndex + 1; index < jobLines.length; index += 1) {
    if (
      activeYamlLine(jobLines[index]) &&
      indentation(jobLines[index]) === 6 &&
      jobLines[index].trim().startsWith("- ")
    ) {
      starts.push(index);
    }
  }
  return starts.map((start, index) =>
    jobLines.slice(start, starts[index + 1] ?? jobLines.length),
  );
}

function workflowStepDirectives(step) {
  return step
    .filter(
      (line, index) =>
        activeYamlLine(line) && indentation(line) === (index === 0 ? 6 : 8),
    )
    .map((line) => line.trim().replace(/^-\s+/u, ""));
}

function oneExactLine(lines, expected) {
  return lines.filter((line) => line === expected).length === 1;
}

function approvedFreshProductionImageReplay(source) {
  const section = workflowJobSection(source, "production-image-replay");
  if (
    !section ||
    JSON.stringify(section.jobNames) !==
      JSON.stringify([
        "quality",
        "browser-proof",
        "real-runtime-proof",
        "production-image-replay",
      ]) ||
    JSON.stringify(exactDirectives(section.lines.slice(1), 4)) !==
      JSON.stringify([
        "name: Fresh-runner production image replay",
        "needs: real-runtime-proof",
        "runs-on: ubuntu-latest",
        "timeout-minutes: 20",
        "steps:",
      ])
  ) {
    return false;
  }
  const steps = workflowStepSections(section.lines);
  if (steps.length !== 4) return false;
  const expectedDirectives = [
    [
      "name: Check out the exact revision",
      "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "with:",
    ],
    [
      "name: Use Node.js 22",
      "uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
      "with:",
    ],
    [
      "name: Download the exact tested production image",
      "uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
      "with:",
    ],
    [
      "name: Replay the retained image on the fresh Docker engine",
      "env:",
      "run: |",
    ],
  ];
  if (
    steps.some(
      (step, index) =>
        JSON.stringify(workflowStepDirectives(step)) !==
        JSON.stringify(expectedDirectives[index]),
    ) ||
    !oneExactLine(steps[0], "          persist-credentials: false") ||
    exactDirectives(steps[0], 10).length !== 1 ||
    !oneExactLine(steps[1], "          node-version: 22") ||
    exactDirectives(steps[1], 10).length !== 1 ||
    !oneExactLine(steps[2], "          name: agent-airlock-production-image") ||
    !oneExactLine(
      steps[2],
      "          path: ${{ runner.temp }}/agent-airlock-production-image",
    ) ||
    exactDirectives(steps[2], 10).length !== 2 ||
    !oneExactLine(
      steps[3],
      "          PRODUCTION_IMAGE_ARTIFACT_DIRECTORY: ${{ runner.temp }}/agent-airlock-production-image",
    )
  ) {
    return false;
  }
  const replaySteps = workflowJobRunSteps(source, "production-image-replay");
  const replay = replaySteps.find(
    ({ name }) =>
      name === "Replay the retained image on the fresh Docker engine",
  );
  if (!replay || replaySteps.length !== 1) return false;
  const requiredRunFragments = [
    "docker info >/dev/null",
    'PROVENANCE_PATH="$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY/agent-airlock-production-image-provenance.json"',
    'if docker image inspect "$IMAGE_ID" >/dev/null 2>&1; then',
    'node scripts/production-image-provenance.mjs \\\n  --verify "$PROVENANCE_PATH" \\\n  --artifact-directory "$PRODUCTION_IMAGE_ARTIFACT_DIRECTORY"',
    'LOADED_IMAGE_ID="$(docker image inspect --format \'{{.Id}}\' "$IMAGE_ID")"',
    'if [ "$LOADED_IMAGE_ID" != "$IMAGE_ID" ]; then',
  ];
  return requiredRunFragments.every(
    (fragment) => replay.source.split(fragment).length === 2,
  );
}

function stripShellComment(line, state) {
  let value = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (state.singleQuoted) {
      value += character;
      if (character === "'") state.singleQuoted = false;
      continue;
    }
    if (state.doubleQuoted) {
      value += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        state.doubleQuoted = false;
      }
      continue;
    }
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      value += character;
      escaped = true;
      continue;
    }
    if (character === "'") {
      state.singleQuoted = true;
      value += character;
      continue;
    }
    if (character === '"') {
      state.doubleQuoted = true;
      value += character;
      continue;
    }
    if (
      character === "#" &&
      (index === 0 || /[\s;&|()]/u.test(line[index - 1]))
    ) {
      break;
    }
    value += character;
  }
  return value;
}

function normalizeShellCommand(value) {
  return value.trim().replace(/\s+/gu, " ");
}

export function executableShellLogicalCommands(source) {
  if (typeof source !== "string") return [];
  const commands = [];
  const state = { doubleQuoted: false, singleQuoted: false };
  let buffer = "";
  let startLine = null;
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const cleaned = stripShellComment(lines[index], state).trim();
    if (cleaned.length === 0 && buffer.length === 0) continue;
    startLine ??= index + 1;
    const continued =
      !state.singleQuoted && !state.doubleQuoted && /\\\s*$/u.test(cleaned);
    const fragment = continued ? cleaned.replace(/\\\s*$/u, "") : cleaned;
    if (fragment.length > 0)
      buffer += `${buffer.length > 0 ? " " : ""}${fragment}`;
    if (continued || state.singleQuoted || state.doubleQuoted) continue;
    const command = normalizeShellCommand(buffer);
    if (command.length > 0) commands.push({ command, line: startLine });
    buffer = "";
    startLine = null;
  }
  if (buffer.trim().length > 0 || state.singleQuoted || state.doubleQuoted)
    return [];

  const scope = [];
  return commands.map((entry) => {
    const command = entry.command;
    if (
      command === "}" ||
      command === "fi" ||
      command === "done" ||
      command === "esac" ||
      command === ")"
    ) {
      if (scope.length === 0) return { ...entry, scope: ["invalid-close"] };
      scope.pop();
    }
    const scoped = { ...entry, scope: [...scope] };
    const functionMatch = command.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{$/u,
    );
    if (functionMatch) {
      scope.push(`function:${functionMatch[1]}`);
    } else if (/^if\b.*;\s*then$/u.test(command)) {
      scope.push("if");
    } else if (/^(?:for|select|until|while)\b.*;\s*do$/u.test(command)) {
      scope.push("loop");
    } else if (/^case\b.*\bin$/u.test(command)) {
      scope.push("case");
    } else if (command === "{") {
      scope.push("group");
    } else if (command === "(") {
      scope.push("subshell");
    }
    return scoped;
  });
}

function exactlyOneIndex(commands, expected) {
  const matches = commands
    .map(({ command }, index) => ({ command, index }))
    .filter(({ command }) => command === expected);
  return matches.length === 1 ? matches[0].index : -1;
}

function exactlyTwoIndexes(commands, expected) {
  const matches = commands
    .map(({ command }, index) => ({ command, index }))
    .filter(({ command }) => command === expected)
    .map(({ index }) => index);
  return matches.length === 2 ? matches : [];
}

function strictlyIncreasing(values) {
  return values.every(
    (value, index) => index === 0 || values[index - 1] < value,
  );
}

export function approvedReleaseExecutionPolicy({
  workflowSource,
  productGateSource,
  dependencySources,
} = {}) {
  if (
    !approvedSourceDigest("workflowSource", workflowSource) ||
    !approvedSourceDigest("productGateSource", productGateSource) ||
    !approvedDependencyClosure(dependencySources) ||
    !approvedFreshProductionImageReplay(workflowSource)
  ) {
    return false;
  }
  const workflowSteps = workflowJobRunSteps(
    workflowSource,
    "real-runtime-proof",
  );
  const productProofSteps = workflowSteps
    .map((step) => ({
      ...step,
      commands: executableShellLogicalCommands(step.source),
    }))
    .filter(
      ({ commands }) =>
        exactlyOneIndex(
          commands,
          "bash scripts/check-phase-eleven-docker.sh",
        ) >= 0,
    );
  if (
    productProofSteps.length !== 1 ||
    productProofSteps[0].name !== "Prove the production image boundary" ||
    productProofSteps[0].commands.length !== 2 ||
    productProofSteps[0].commands[0].command !==
      "LAUNCHPAD_ENV_FILE=.env.example docker compose config --quiet" ||
    productProofSteps[0].commands[1].command !==
      "bash scripts/check-phase-eleven-docker.sh" ||
    productProofSteps[0].commands.some(({ scope }) => scope.length !== 0)
  ) {
    return false;
  }

  const commands = executableShellLogicalCommands(productGateSource);
  if (commands.length === 0 || commands[0]?.command !== "set -euo pipefail") {
    return false;
  }
  const deniedCommands = new Set([":", "true", "false", "exit 0"]);
  const deniedFunctionNames = new Set(["bash", "docker", "node", "npm", "npx"]);
  if (
    commands.some(
      ({ command, scope }) =>
        deniedCommands.has(command) ||
        /^set\s+\+/u.test(command) ||
        /^set\s+\+o(?:\s|$)/u.test(command) ||
        ((command === "exit" || command === "exit 0") && scope.length === 0) ||
        (command.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{$/u) &&
          deniedFunctionNames.has(
            command.match(/^([A-Za-z_][A-Za-z0-9_]*)/u)?.[1],
          )),
    )
  ) {
    return false;
  }

  const composeUp = exactlyOneIndex(
    commands,
    "product_compose up --detach --no-build launchpad >/dev/null",
  );
  const contract = exactlyOneIndex(commands, "assert_compose_service_contract");
  const sourceContract = exactlyOneIndex(
    commands,
    "node scripts/release-compose-policy.mjs --assert-source",
  );
  const materializeBuildContext = exactlyOneIndex(
    commands,
    'SOURCE_IDENTITY="$(node scripts/production-build-context.mjs --root "$PROJECT_ROOT" --output "$SOURCE_ARCHIVE")"',
  );
  const build = exactlyOneIndex(
    commands,
    'node scripts/production-build-context.mjs --stream "$SOURCE_ARCHIVE" --sha256 "$SOURCE_ARCHIVE_SHA256" | docker image build --build-arg "NODE_IMAGE=$CONTAINER_RUNTIME_BASE_IMAGE" --build-arg "DEBIAN_MIRROR=$CONTAINER_APT_MIRROR" --build-arg "DEBIAN_SECURITY_MIRROR=$CONTAINER_APT_SECURITY_MIRROR" --label "org.opencontainers.image.revision=$SOURCE_COMMIT" --label "io.agent-airlock.source-tree=$SOURCE_TREE" --label "io.codejam.production-gate-image-owner=$GATE_NONCE" --file Dockerfile --tag "$IMAGE_TAG" - >/dev/null',
  );
  const imageBuildAttempted = exactlyOneIndex(
    commands,
    "IMAGE_BUILD_ATTEMPTED=true",
  );
  const starts = exactlyTwoIndexes(commands, "start_product_container");
  const fixtures = exactlyTwoIndexes(commands, "start_protocol_fixture");
  const stop = exactlyOneIndex(commands, "stop_product_container");
  const http = exactlyTwoIndexes(
    commands,
    'node scripts/production-image-verifier.mjs --origin "$ORIGIN"',
  );
  const browser = exactlyOneIndex(
    commands,
    'AIRLOCK_PRODUCTION_IMAGE_AUTH_TOKEN="$AUTH_TOKEN" node scripts/check-production-image-browser.mjs --origin "$ORIGIN"',
  );
  const transactionCreate = exactlyOneIndex(
    commands,
    'AIRLOCK_PRODUCTION_IMAGE_AUTH_TOKEN="$AUTH_TOKEN" node scripts/check-production-image-transaction.mjs --origin "$ORIGIN" --mode create --proof-file "$TRANSACTION_PROOF_FILE"',
  );
  const persistenceCreate = exactlyOneIndex(
    commands,
    'node scripts/production-image-persistence-verifier.mjs --session-root "$SESSION_ROOT" --transaction-proof "$TRANSACTION_PROOF_FILE" --mode create --snapshot-file "$PHYSICAL_PROOF_FILE" --data-sentinel-content "$DATA_SANDBOX_SENTINEL_CONTENT" --workspace-sentinel-content "$WORKSPACE_SANDBOX_SENTINEL_CONTENT"',
  );
  const transactionRestart = exactlyOneIndex(
    commands,
    'AIRLOCK_PRODUCTION_IMAGE_AUTH_TOKEN="$AUTH_TOKEN" node scripts/check-production-image-transaction.mjs --origin "$ORIGIN" --mode restart --proof-file "$TRANSACTION_PROOF_FILE"',
  );
  const persistenceRestart = exactlyOneIndex(
    commands,
    'node scripts/production-image-persistence-verifier.mjs --session-root "$SESSION_ROOT" --transaction-proof "$TRANSACTION_PROOF_FILE" --mode restart --snapshot-file "$PHYSICAL_PROOF_FILE" --data-sentinel-content "$DATA_SANDBOX_SENTINEL_CONTENT" --workspace-sentinel-content "$WORKSPACE_SANDBOX_SENTINEL_CONTENT"',
  );
  const provenanceExport = exactlyOneIndex(
    commands,
    "export_production_image_artifacts",
  );
  const required = [
    composeUp,
    contract,
    sourceContract,
    materializeBuildContext,
    build,
    imageBuildAttempted,
    ...starts,
    ...fixtures,
    stop,
    ...http,
    browser,
    transactionCreate,
    persistenceCreate,
    transactionRestart,
    persistenceRestart,
    provenanceExport,
  ];
  if (
    required.some((index) => index < 0) ||
    starts.length !== 2 ||
    fixtures.length !== 2 ||
    http.length !== 2
  ) {
    return false;
  }
  const startFunction = exactlyOneIndex(
    commands,
    "start_product_container() {",
  );
  const contractFunction = exactlyOneIndex(
    commands,
    "assert_compose_service_contract() {",
  );
  const contractVerifier = exactlyOneIndex(
    commands,
    'product_compose config --format json | EXPECTED_IMAGE="$IMAGE_TAG" EXPECTED_USER="$HOST_UID:$HOST_GID" EXPECTED_PROJECT_ROOT="$PROJECT_ROOT" EXPECTED_DATA="$SESSION_ROOT/data" EXPECTED_WORKSPACES="$SESSION_ROOT/workspaces" EXPECTED_CODEX_HOME="$SESSION_ROOT/codex-home" EXPECTED_COMPOSE_PROJECT="$GATE_COMPOSE_PROJECT" EXPECTED_OWNER="$GATE_NONCE" node scripts/release-compose-policy.mjs --assert-resolved',
  );
  const productWait = exactlyOneIndex(commands, "wait_for_product_container");
  const artifactFunction = exactlyOneIndex(
    commands,
    "export_production_image_artifacts() {",
  );
  const immutableImageSave = exactlyOneIndex(
    commands,
    'docker image save --output "$archive_path" "$IMAGE_ID"',
  );
  if (
    startFunction < 0 ||
    productWait < 0 ||
    commands[composeUp]?.scope.join("/") !==
      "function:start_product_container" ||
    commands[productWait]?.scope.join("/") !==
      "function:start_product_container" ||
    composeUp >= productWait ||
    contractFunction < 0 ||
    contractVerifier < 0 ||
    artifactFunction < 0 ||
    immutableImageSave < 0 ||
    commands[immutableImageSave]?.scope.join("/") !==
      "function:export_production_image_artifacts" ||
    commands[contractVerifier]?.scope.join("/") !==
      "function:assert_compose_service_contract"
  ) {
    return false;
  }
  for (const index of [
    contract,
    sourceContract,
    materializeBuildContext,
    build,
    imageBuildAttempted,
    ...starts,
    ...fixtures,
    stop,
    ...http,
    browser,
    transactionCreate,
    persistenceCreate,
    transactionRestart,
    persistenceRestart,
    provenanceExport,
  ]) {
    if (commands[index].scope.length !== 0) return false;
  }
  return strictlyIncreasing([
    sourceContract,
    contract,
    materializeBuildContext,
    imageBuildAttempted,
    build,
    starts[0],
    fixtures[0],
    http[0],
    browser,
    transactionCreate,
    persistenceCreate,
    stop,
    starts[1],
    fixtures[1],
    http[1],
    transactionRestart,
    persistenceRestart,
    provenanceExport,
  ]);
}

function parseJavaScript(source, fileName) {
  if (typeof source !== "string") return null;
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  return file.parseDiagnostics.length === 0 ? file : null;
}

function descendants(root, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return matches;
}

function identifierCall(node, name) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  );
}

function directAwaitedCall(node, name) {
  return (
    identifierCall(node, name) &&
    ts.isAwaitExpression(node.parent) &&
    node.parent.expression === node
  );
}

function exactNamedImport(file, moduleName, importedName) {
  const matches = file.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          (element.propertyName?.text ?? element.name.text) === importedName &&
          element.name.text === importedName,
      ),
  );
  return matches.length === 1;
}

function namedDeclarations(file, name) {
  return descendants(
    file,
    (node) =>
      (ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name,
  );
}

function exactUnshadowedImport(file, moduleName, name) {
  return (
    exactNamedImport(file, moduleName, name) &&
    namedDeclarations(file, name).length === 0
  );
}

function exactTopLevelFunction(file, name) {
  const declarations = namedDeclarations(file, name);
  return declarations.length === 1 &&
    ts.isFunctionDeclaration(declarations[0]) &&
    declarations[0].parent === file
    ? declarations[0]
    : null;
}

function enclosing(node, predicate) {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (predicate(cursor)) return cursor;
  }
  return null;
}

function blockStatementIndex(node) {
  const statement = enclosing(node, (candidate) => ts.isStatement(candidate));
  const block = statement?.parent;
  if (!statement || !block || !ts.isBlock(block)) return null;
  return { block, index: block.statements.indexOf(statement), statement };
}

function conjuncts(expression) {
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [...conjuncts(expression.left), ...conjuncts(expression.right)];
  }
  return [expression];
}

function exactIdentifier(expression, name) {
  return ts.isIdentifier(expression) && expression.text === name;
}

function negatedIdentifier(expression, name) {
  return (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken &&
    exactIdentifier(expression.operand, name)
  );
}

function containsNode(outer, inner) {
  return outer.pos <= inner.pos && inner.end <= outer.end;
}

function directAwaitedCallTryStatement(call) {
  if (!ts.isAwaitExpression(call.parent)) return null;
  const statement = call.parent.parent;
  if (!ts.isExpressionStatement(statement)) return null;
  const block = statement.parent;
  if (!ts.isBlock(block) || block.statements.length !== 1) return null;
  const tryStatement = block.parent;
  return ts.isTryStatement(tryStatement) && tryStatement.tryBlock === block
    ? tryStatement
    : null;
}

function hasCleanupFailureThrow(ifStatement) {
  if (!ts.isPrefixUnaryExpression(ifStatement.expression)) return false;
  if (ifStatement.expression.operator !== ts.SyntaxKind.ExclamationToken)
    return false;
  if (
    !identifierCall(
      ifStatement.expression.operand,
      "runtimeProofChildExitSucceeded",
    )
  ) {
    return false;
  }
  const call = ifStatement.expression.operand;
  if (
    call.arguments.length !== 1 ||
    !exactIdentifier(call.arguments[0], "launcherOutcome")
  ) {
    return false;
  }
  return (
    descendants(
      ifStatement.thenStatement,
      (node) =>
        ts.isThrowStatement(node) &&
        descendants(
          node,
          (candidate) =>
            ts.isNewExpression(candidate) &&
            exactIdentifier(candidate.expression, "RuntimeProofError") &&
            candidate.arguments?.some(
              (argument) =>
                ts.isStringLiteral(argument) &&
                argument.text === "cleanup-failed",
            ),
        ).length === 1,
    ).length === 1
  );
}

function approvedPostRecheckMutationTest(source) {
  const file = parseJavaScript(source, "runtime-proof-runner.test.mjs");
  if (!file) return false;
  const title =
    "stopped snapshot rejects persisted state created after the live final recheck";
  const tests = descendants(
    file,
    (node) =>
      identifierCall(node, "test") &&
      node.arguments.length >= 2 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === title,
  );
  if (tests.length !== 1) return false;
  const testCall = tests[0];
  const callback = testCall.arguments[1];
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
    return false;
  }
  if (
    !ts.isBlock(callback.body) ||
    !exactUnshadowedImport(
      file,
      "./runtime-proof-runner.mjs",
      "assertStoppedRuntimeProofSnapshot",
    ) ||
    !exactTopLevelFunction(file, "expectFailure") ||
    descendants(callback, (node) => ts.isReturnStatement(node)).length > 0 ||
    namedDeclarations(callback, "assertStoppedRuntimeProofSnapshot").length >
      0 ||
    namedDeclarations(callback, "expectFailure").length > 0
  ) {
    return false;
  }
  const snapshotCalls = descendants(callback, (node) =>
    identifierCall(node, "assertStoppedRuntimeProofSnapshot"),
  );
  const fourthRunPushes = descendants(
    callback,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      descendants(
        node,
        (candidate) =>
          ts.isStringLiteral(candidate) &&
          candidate.text === "run-created-after-final-live-recheck",
      ).length === 1,
  );
  const extraAgentPushes = descendants(
    callback,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      descendants(node.expression.expression, (candidate) =>
        exactIdentifier(candidate, "agents"),
      ).length === 1 &&
      descendants(
        node,
        (candidate) =>
          ts.isStringLiteral(candidate) &&
          candidate.text === "agent-created-after-final-live-recheck",
      ).length === 1,
  );
  const extraAgentPops = descendants(
    callback,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "pop" &&
      descendants(node.expression.expression, (candidate) =>
        exactIdentifier(candidate, "agents"),
      ).length === 1,
  );
  const expectedFailures = descendants(
    callback,
    (node) =>
      identifierCall(node, "expectFailure") &&
      node.arguments.some(
        (argument) =>
          ts.isStringLiteral(argument) && argument.text === "run-set-invalid",
      ) &&
      descendants(node, (candidate) =>
        identifierCall(candidate, "assertStoppedRuntimeProofSnapshot"),
      ).length === 1,
  );
  if (
    snapshotCalls.length !== 3 ||
    extraAgentPushes.length !== 1 ||
    extraAgentPops.length !== 1 ||
    fourthRunPushes.length !== 1 ||
    expectedFailures.length !== 2
  ) {
    return false;
  }
  const firstSnapshotStatement = blockStatementIndex(snapshotCalls[0]);
  const extraAgentStatement = blockStatementIndex(extraAgentPushes[0]);
  const firstFailureStatement = blockStatementIndex(expectedFailures[0]);
  const extraAgentPopStatement = blockStatementIndex(extraAgentPops[0]);
  const fourthRunStatement = blockStatementIndex(fourthRunPushes[0]);
  const secondFailureStatement = blockStatementIndex(expectedFailures[1]);
  return (
    expectedFailures.every((call) =>
      directAwaitedCall(call, "expectFailure"),
    ) &&
    firstSnapshotStatement?.block === extraAgentStatement?.block &&
    extraAgentStatement?.block === firstFailureStatement?.block &&
    firstFailureStatement?.block === extraAgentPopStatement?.block &&
    extraAgentPopStatement?.block === fourthRunStatement?.block &&
    fourthRunStatement?.block === secondFailureStatement?.block &&
    strictlyIncreasing([
      firstSnapshotStatement.index,
      extraAgentStatement.index,
      firstFailureStatement.index,
      extraAgentPopStatement.index,
      fourthRunStatement.index,
      secondFailureStatement.index,
    ]) &&
    snapshotCalls[0].pos < extraAgentPushes[0].pos &&
    extraAgentPushes[0].pos < snapshotCalls[1].pos &&
    snapshotCalls[1].pos < extraAgentPops[0].pos &&
    extraAgentPops[0].pos < fourthRunPushes[0].pos &&
    fourthRunPushes[0].pos < snapshotCalls[2].pos
  );
}

export function approvedStoppedRuntimePublicationPolicy({
  proveRuntimeSource,
  runtimeProofTestSource,
} = {}) {
  if (
    !approvedSourceDigest("proveRuntimeSource", proveRuntimeSource) ||
    !approvedSourceDigest("runtimeProofTestSource", runtimeProofTestSource)
  ) {
    return false;
  }
  const file = parseJavaScript(proveRuntimeSource, "prove-runtime.mjs");
  if (!file || !approvedPostRecheckMutationTest(runtimeProofTestSource))
    return false;

  const runnerImports = [
    "RuntimeProofError",
    "assertStoppedRuntimeProofSnapshot",
    "cleanupRuntimeProofSessionRoot",
    "finalizeRuntimeProofPublication",
  ];
  const terminalImports = [
    "runtimeProofChildExitSucceeded",
    "runtimeProofChildHasExited",
    "stopOwnedRuntimeProofProcessTree",
    "stopRuntimeProofChild",
  ];
  if (
    runnerImports.some(
      (name) =>
        !exactUnshadowedImport(file, "./runtime-proof-runner.mjs", name),
    ) ||
    terminalImports.some(
      (name) =>
        !exactUnshadowedImport(file, "./runtime-proof-terminal.mjs", name),
    ) ||
    namedDeclarations(file, "stoppedSnapshotVerified").length !== 1 ||
    namedDeclarations(file, "launcherOutcome").length !== 1 ||
    namedDeclarations(file, "launcherExit").length !== 1 ||
    namedDeclarations(file, "ownedChildren").length !== 1
  ) {
    return false;
  }
  const containerCleanupFunction = exactTopLevelFunction(
    file,
    "cleanupRuntimeContainers",
  );
  if (
    !containerCleanupFunction ||
    descendants(containerCleanupFunction, (node) => ts.isReturnStatement(node))
      .length !== 1 ||
    descendants(containerCleanupFunction, (node) =>
      identifierCall(node, "execFile"),
    ).length !== 2 ||
    descendants(
      containerCleanupFunction,
      (node) =>
        ts.isStringLiteral(node) &&
        node.text === "label=io.codejam.launchpad=agent-runtime",
    ).length !== 1 ||
    descendants(
      containerCleanupFunction,
      (node) => ts.isStringLiteral(node) && node.text === "rm",
    ).length !== 1
  ) {
    return false;
  }

  const progressCleanup = descendants(
    file,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      exactIdentifier(node.expression.expression, "progress") &&
      node.expression.name.text === "emit" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "cleanup",
  );
  const stoppedDeclarations = descendants(
    file,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "stoppedSnapshotVerified" &&
      node.initializer?.kind === ts.SyntaxKind.FalseKeyword,
  );
  const ownedTreeStops = descendants(file, (node) =>
    directAwaitedCall(node, "stopOwnedRuntimeProofProcessTree"),
  );
  const childStops = descendants(file, (node) =>
    directAwaitedCall(node, "stopRuntimeProofChild"),
  );
  const launcherOutcomes = descendants(
    file,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "launcherOutcome" &&
      ts.isAwaitExpression(node.initializer) &&
      exactIdentifier(node.initializer.expression, "launcherExit"),
  );
  const launcherSuccessChecks = descendants(
    file,
    (node) => ts.isIfStatement(node) && hasCleanupFailureThrow(node),
  );
  const containerCleanup = descendants(file, (node) =>
    directAwaitedCall(node, "cleanupRuntimeContainers"),
  );
  const snapshots = descendants(file, (node) =>
    directAwaitedCall(node, "assertStoppedRuntimeProofSnapshot"),
  );
  const sessionCleanup = descendants(file, (node) =>
    directAwaitedCall(node, "cleanupRuntimeProofSessionRoot"),
  );
  const publications = descendants(file, (node) =>
    directAwaitedCall(node, "finalizeRuntimeProofPublication"),
  );
  const stoppedAssignments = descendants(
    file,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      exactIdentifier(node.left, "stoppedSnapshotVerified") &&
      node.right.kind === ts.SyntaxKind.TrueKeyword,
  );
  if (
    progressCleanup.length !== 1 ||
    stoppedDeclarations.length !== 1 ||
    ownedTreeStops.length !== 1 ||
    launcherOutcomes.length !== 1 ||
    launcherSuccessChecks.length !== 1 ||
    containerCleanup.length !== 1 ||
    snapshots.length !== 1 ||
    sessionCleanup.length !== 1 ||
    publications.length !== 1 ||
    stoppedAssignments.length !== 1
  ) {
    return false;
  }

  const remainingChildLoop = childStops.find((call) => {
    const loop = enclosing(call, (node) => ts.isForOfStatement(node));
    return (
      loop &&
      descendants(loop.expression, (node) =>
        exactIdentifier(node, "ownedChildren"),
      ).length === 1 &&
      descendants(loop.statement, (node) =>
        identifierCall(node, "runtimeProofChildHasExited"),
      ).length >= 1
    );
  });
  if (!remainingChildLoop) return false;

  const containerCleanupTry = directAwaitedCallTryStatement(
    containerCleanup[0],
  );
  if (
    !containerCleanupTry ||
    !ts.isSourceFile(containerCleanupTry.parent) ||
    !containerCleanupTry.catchClause ||
    descendants(
      containerCleanupTry.catchClause.block,
      (node) =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        exactIdentifier(node.left, "runtimeCleanupConfirmed") &&
        node.right.kind === ts.SyntaxKind.FalseKeyword,
    ).length !== 1 ||
    descendants(containerCleanupTry.catchClause.block, (node) =>
      identifierCall(node, "recordCleanupFailure"),
    ).length !== 1
  ) {
    return false;
  }

  const snapshotStatement = blockStatementIndex(snapshots[0]);
  const assignmentStatement = blockStatementIndex(stoppedAssignments[0]);
  if (
    !snapshotStatement ||
    !assignmentStatement ||
    snapshotStatement.block !== assignmentStatement.block ||
    assignmentStatement.index !== snapshotStatement.index + 1
  ) {
    return false;
  }

  const publicationIf = enclosing(publications[0], (node) =>
    ts.isIfStatement(node),
  );
  if (
    !publicationIf ||
    !containsNode(publicationIf.thenStatement, publications[0])
  ) {
    return false;
  }
  const publicationConjuncts = conjuncts(publicationIf.expression);
  if (
    !publicationConjuncts.some((expression) =>
      exactIdentifier(expression, "stoppedSnapshotVerified"),
    ) ||
    publicationConjuncts.some((expression) =>
      negatedIdentifier(expression, "stoppedSnapshotVerified"),
    )
  ) {
    return false;
  }
  const negativeGuard = descendants(
    file,
    (node) =>
      ts.isIfStatement(node) &&
      conjuncts(node.expression).some((expression) =>
        negatedIdentifier(expression, "stoppedSnapshotVerified"),
      ) &&
      descendants(
        node.thenStatement,
        (candidate) =>
          ts.isBinaryExpression(candidate) &&
          candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          exactIdentifier(candidate.left, "failure"),
      ).length >= 1,
  );
  if (negativeGuard.length !== 1) return false;

  return strictlyIncreasing([
    progressCleanup[0].pos,
    ownedTreeStops[0].pos,
    launcherOutcomes[0].pos,
    launcherSuccessChecks[0].pos,
    remainingChildLoop.pos,
    containerCleanup[0].pos,
    snapshots[0].pos,
    stoppedAssignments[0].pos,
    sessionCleanup[0].pos,
    negativeGuard[0].pos,
    publicationIf.pos,
    publications[0].pos,
  ]);
}
