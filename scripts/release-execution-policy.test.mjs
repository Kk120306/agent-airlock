import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  approvedReleaseExecutionPolicy,
  approvedStoppedRuntimePublicationPolicy,
  releaseExecutionDependencyPaths,
} from "./release-execution-policy.mjs";
import { productionImageInputPaths } from "./production-image-provenance.mjs";

const requiredProductionImageInputs = [
  ".dockerignore",
  "Dockerfile",
  "Dockerfile.runtime",
  "docker-compose.yml",
  "docker/codex-runtime/package.json",
  "docker/codex-runtime/package-lock.json",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
];

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseline = {
  dependencySources: Object.fromEntries(
    await Promise.all(
      releaseExecutionDependencyPaths.map(async (dependencyPath) => [
        dependencyPath,
        await readFile(path.join(projectRoot, dependencyPath), "utf8"),
      ]),
    ),
  ),
  productGateSource: await readFile(
    path.join(projectRoot, "scripts/check-phase-eleven-docker.sh"),
    "utf8",
  ),
  proveRuntimeSource: await readFile(
    path.join(projectRoot, "scripts/prove-runtime.mjs"),
    "utf8",
  ),
  runtimeProofTestSource: await readFile(
    path.join(projectRoot, "scripts/runtime-proof-runner.test.mjs"),
    "utf8",
  ),
  workflowSource: await readFile(
    path.join(projectRoot, ".github/workflows/release-proof.yml"),
    "utf8",
  ),
};

function replaceRequired(source, search, replacement) {
  assert.notEqual(
    source.indexOf(search),
    -1,
    `missing fixture marker: ${search}`,
  );
  return source.replace(search, replacement);
}

function replaceNth(source, search, replacement, occurrence) {
  let offset = 0;
  let found = -1;
  for (let count = 0; count < occurrence; count += 1) {
    found = source.indexOf(search, offset);
    assert.notEqual(
      found,
      -1,
      `missing fixture marker occurrence ${occurrence}: ${search}`,
    );
    offset = found + search.length;
  }
  return `${source.slice(0, found)}${replacement}${source.slice(found + search.length)}`;
}

test("release execution policy accepts the shipped workflow and product gate", () => {
  assert.equal(approvedReleaseExecutionPolicy(baseline), true);
});

test("release execution dependency closure includes every exact production image input", () => {
  assert.deepEqual(productionImageInputPaths, requiredProductionImageInputs);
  for (const inputPath of requiredProductionImageInputs) {
    assert.equal(releaseExecutionDependencyPaths.includes(inputPath), true);
  }
});

test("release execution policy rejects every mutated production image input", async (context) => {
  for (const inputPath of requiredProductionImageInputs) {
    await context.test(inputPath, () => {
      assert.equal(
        approvedReleaseExecutionPolicy({
          ...baseline,
          dependencySources: {
            ...baseline.dependencySources,
            [inputPath]: `${baseline.dependencySources[inputPath]}\nrelease-image-input-drift`,
          },
        }),
        false,
      );
    });
  }
});

test("release execution policy locks every executable production gate dependency", async (context) => {
  for (const dependencyPath of releaseExecutionDependencyPaths) {
    await context.test(dependencyPath, () => {
      assert.equal(
        approvedReleaseExecutionPolicy({
          ...baseline,
          dependencySources: {
            ...baseline.dependencySources,
            [dependencyPath]: `${baseline.dependencySources[dependencyPath]}\n// release dependency mutation`,
          },
        }),
        false,
      );
    });
  }
});

test("release execution policy locks the complete workflow graph", async (context) => {
  const mutations = [
    [
      "root BASH_ENV",
      (source) =>
        replaceRequired(
          source,
          'env:\n  CI: "true"',
          'env:\n  CI: "true"\n  BASH_ENV: .github/false-green.sh',
        ),
    ],
    [
      "checkout ref override",
      (source) =>
        replaceRequired(
          source,
          "        with:\n          persist-credentials: false",
          "        with:\n          persist-credentials: false\n          ref: main",
        ),
    ],
    [
      "manual trigger only",
      (source) =>
        replaceRequired(
          source,
          "on:\n  pull_request:\n  push:\n    branches:\n      - main\n  workflow_dispatch:",
          "on:\n  workflow_dispatch:",
        ),
    ],
    [
      "quality job disabled",
      (source) =>
        replaceRequired(
          source,
          "  quality:\n    name: Quality and release audit",
          "  quality:\n    if: false\n    name: Quality and release audit",
        ),
    ],
    [
      "browser proof made non-blocking",
      (source) =>
        replaceRequired(
          source,
          "  browser-proof:\n    name: Production browser proof",
          "  browser-proof:\n    continue-on-error: true\n    name: Production browser proof",
        ),
    ],
    [
      "quoted product step condition",
      (source) =>
        replaceRequired(
          source,
          "      - name: Prove the production image boundary\n        env:",
          '      - name: Prove the production image boundary\n        "if": false\n        env:',
        ),
    ],
    [
      "quoted product step continuation",
      (source) =>
        replaceRequired(
          source,
          "      - name: Prove the production image boundary\n        env:",
          '      - name: Prove the production image boundary\n        "continue-on-error": true\n        env:',
        ),
    ],
    [
      "quoted product step shell",
      (source) =>
        replaceRequired(
          source,
          "      - name: Prove the production image boundary\n        env:",
          '      - name: Prove the production image boundary\n        "shell": echo {0}\n        env:',
        ),
    ],
    [
      "post-product Runtime proof disabled",
      (source) =>
        replaceRequired(
          source,
          "      - name: Build and prove browser to real Runtime to Promotion\n        run:",
          "      - name: Build and prove browser to real Runtime to Promotion\n        if: false\n        run:",
        ),
    ],
    [
      "fresh replay detached from the proof job",
      (source) =>
        replaceRequired(
          source,
          "    needs: real-runtime-proof\n    runs-on: ubuntu-latest",
          "    needs: quality\n    runs-on: ubuntu-latest",
        ),
    ],
    [
      "fresh replay download action changed",
      (source) =>
        replaceRequired(
          source,
          "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
          "actions/download-artifact@main",
        ),
    ],
    [
      "fresh replay absence check removed",
      (source) =>
        replaceRequired(
          source,
          'if docker image inspect "$IMAGE_ID" >/dev/null 2>&1; then',
          'if false; then # docker image inspect "$IMAGE_ID"',
        ),
    ],
    [
      "fresh replay provenance verification removed",
      (source) =>
        replaceRequired(
          source,
          "          node scripts/production-image-provenance.mjs \\\n",
          "          : # node scripts/production-image-provenance.mjs \\\n",
        ),
    ],
    [
      "extra run step",
      (source) =>
        replaceRequired(
          source,
          "      - name: Prove the production image boundary",
          '      - name: Poison release environment\n        run: echo false-green >> "$GITHUB_ENV"\n\n      - name: Prove the production image boundary',
        ),
    ],
    [
      "extra action step",
      (source) =>
        replaceRequired(
          source,
          "      - name: Prove the production image boundary",
          "      - name: Run unapproved action\n        uses: example/unapproved@main\n\n      - name: Prove the production image boundary",
        ),
    ],
  ];
  for (const [name, mutate] of mutations) {
    await context.test(name, () => {
      assert.equal(
        approvedReleaseExecutionPolicy({
          ...baseline,
          workflowSource: mutate(baseline.workflowSource),
        }),
        false,
      );
    });
  }
});

test("release execution policy locks fail-closed product shell semantics", async (context) => {
  const marker = "node scripts/release-compose-policy.mjs --assert-source";
  const mutations = [
    ["fail-fast disabled", `set +e\n${marker}`],
    ["fail-fast disabled through eval", `eval 'set +e'\n${marker}`],
    ["node alias", `shopt -s expand_aliases\nalias node=:\n${marker}`],
    ["node shell function", `node() { return 0; }\n${marker}`],
    ["early decimal zero exit", `exit 00\n${marker}`],
    ["early arithmetic zero exit", `exit "$((0))"\n${marker}`],
    ["multiline false branch", `if false\nthen\n${marker}\nfi\n${marker}`],
    [
      "alternate function scope",
      `function skip_proof {\n${marker}\n}\n${marker}`,
    ],
    ["PATH replacement", `PATH="$HARNESS_ROOT/false-green:$PATH"\n${marker}`],
  ];
  for (const [name, replacement] of mutations) {
    await context.test(name, () => {
      assert.equal(
        approvedReleaseExecutionPolicy({
          ...baseline,
          productGateSource: replaceRequired(
            baseline.productGateSource,
            marker,
            replacement,
          ),
        }),
        false,
      );
    });
  }
});

test("release execution policy ignores commented and inert workflow markers", async (context) => {
  const activeCommand = "          bash scripts/check-phase-eleven-docker.sh";
  for (const [name, replacement] of [
    [
      "commented command",
      "          # bash scripts/check-phase-eleven-docker.sh",
    ],
    ["shell no-op", "          : # bash scripts/check-phase-eleven-docker.sh"],
    [
      "echoed marker",
      "          echo 'bash scripts/check-phase-eleven-docker.sh'",
    ],
    [
      "unconditional success",
      "          true # bash scripts/check-phase-eleven-docker.sh",
    ],
  ]) {
    await context.test(name, () => {
      assert.equal(
        approvedReleaseExecutionPolicy({
          ...baseline,
          workflowSource: replaceRequired(
            baseline.workflowSource,
            activeCommand,
            replacement,
          ),
        }),
        false,
      );
    });
  }

  await context.test("marker in another job", () => {
    let workflowSource = replaceRequired(
      baseline.workflowSource,
      activeCommand,
      `          # ${activeCommand.trim()}`,
    );
    workflowSource = replaceRequired(
      workflowSource,
      "      - name: Run project checks\n        run: npm run check",
      "      - name: Run project checks\n        run: |\n          npm run check\n          bash scripts/check-phase-eleven-docker.sh",
    );
    assert.equal(
      approvedReleaseExecutionPolicy({ ...baseline, workflowSource }),
      false,
    );
  });

  await context.test("command hidden behind a false workflow branch", () => {
    assert.equal(
      approvedReleaseExecutionPolicy({
        ...baseline,
        workflowSource: replaceRequired(
          baseline.workflowSource,
          activeCommand,
          `          if false; then\n${activeCommand}\n          fi`,
        ),
      }),
      false,
    );
  });
});

test("release execution policy rejects commented or inert product proof commands", async (context) => {
  const mutations = [
    [
      "Compose launch",
      (source) =>
        replaceRequired(
          source,
          "  product_compose up --detach --no-build launchpad >/dev/null",
          "  false # product_compose up --detach --no-build launchpad >/dev/null",
        ),
    ],
    [
      "Compose contract assertion",
      (source) =>
        replaceRequired(
          source,
          "\nassert_compose_service_contract\nSOURCE_IDENTITY=",
          "\n: # assert_compose_service_contract\nSOURCE_IDENTITY=",
        ),
    ],
    [
      "committed context materialization",
      (source) =>
        replaceRequired(
          source,
          '\nSOURCE_IDENTITY="$(node scripts/production-build-context.mjs',
          '\nSOURCE_IDENTITY="$(node -e \'process.stdout.write("0".repeat(40)+":"+"0".repeat(40)+":sha256:"+"0".repeat(64))\' # scripts/production-build-context.mjs',
        ),
    ],
    [
      "validated context stream",
      (source) =>
        replaceRequired(
          source,
          'node scripts/production-build-context.mjs \\\n  --stream "$SOURCE_ARCHIVE"',
          "node scripts/production-build-context.mjs \\\n  --stream /dev/null",
        ),
    ],
    [
      "production image owner label",
      (source) =>
        replaceRequired(
          source,
          '    --label "io.codejam.production-gate-image-owner=$GATE_NONCE" \\\n',
          "",
        ),
    ],
    [
      "pre-build attempt boundary",
      (source) =>
        replaceRequired(
          source,
          "IMAGE_BUILD_ATTEMPTED=true\nnode scripts/production-build-context.mjs",
          "node scripts/production-build-context.mjs",
        ),
    ],
    [
      "first Compose start",
      (source) =>
        replaceNth(
          source,
          "\nstart_product_container\n",
          "\n# start_product_container\n",
          1,
        ),
    ],
    [
      "first HTTP proof",
      (source) =>
        replaceNth(
          source,
          '\nnode scripts/production-image-verifier.mjs --origin "$ORIGIN"\n',
          '\n# node scripts/production-image-verifier.mjs --origin "$ORIGIN"\n',
          1,
        ),
    ],
    [
      "browser proof",
      (source) =>
        replaceRequired(
          source,
          '  node scripts/check-production-image-browser.mjs --origin "$ORIGIN"',
          '  false # node scripts/check-production-image-browser.mjs --origin "$ORIGIN"',
        ),
    ],
    [
      "transaction create proof",
      (source) =>
        replaceRequired(
          source,
          "    --mode create \\\n",
          "    --mode inspect \\\n",
        ),
    ],
    [
      "physical create proof",
      (source) =>
        replaceRequired(
          source,
          "  --mode create \\\n",
          "  --mode inspect \\\n",
        ),
    ],
    [
      "Compose stop",
      (source) =>
        replaceRequired(
          source,
          "\nstop_product_container\nstart_product_container\n",
          "\n# stop_product_container\nstart_product_container\n",
        ),
    ],
    [
      "second Compose start",
      (source) =>
        replaceNth(
          source,
          "\nstart_product_container\n",
          "\n# start_product_container\n",
          2,
        ),
    ],
    [
      "second HTTP proof",
      (source) =>
        replaceNth(
          source,
          '\nnode scripts/production-image-verifier.mjs --origin "$ORIGIN"\n',
          '\n# node scripts/production-image-verifier.mjs --origin "$ORIGIN"\n',
          2,
        ),
    ],
    [
      "transaction restart proof",
      (source) =>
        replaceRequired(
          source,
          "    --mode restart \\\n",
          "    --mode inspect \\\n",
        ),
    ],
    [
      "physical restart proof",
      (source) =>
        replaceRequired(
          source,
          "  --mode restart \\\n",
          "  --mode inspect \\\n",
        ),
    ],
    [
      "physical proof workspace sentinel binding",
      (source) =>
        replaceNth(
          source,
          '  --workspace-sentinel-content "$WORKSPACE_SANDBOX_SENTINEL_CONTENT"\n',
          "",
          1,
        ),
    ],
    [
      "physical proof data sentinel binding",
      (source) =>
        replaceNth(
          source,
          '  --data-sentinel-content "$DATA_SANDBOX_SENTINEL_CONTENT" \\\n',
          "",
          1,
        ),
    ],
    [
      "physical restart data sentinel identity",
      (source) =>
        replaceNth(
          source,
          '  --data-sentinel-content "$DATA_SANDBOX_SENTINEL_CONTENT" \\\n',
          '  --data-sentinel-content "protected-data:000000000000000000000000" \\\n',
          2,
        ),
    ],
    [
      "physical restart workspace sentinel identity",
      (source) =>
        replaceNth(
          source,
          '  --workspace-sentinel-content "$WORKSPACE_SANDBOX_SENTINEL_CONTENT"\n',
          '  --workspace-sentinel-content "protected-workspaces:000000000000000000000000"\n',
          2,
        ),
    ],
    [
      "production image provenance export",
      (source) =>
        replaceRequired(
          source,
          "\nexport_production_image_artifacts\n",
          "\n# export_production_image_artifacts\n",
        ),
    ],
  ];
  for (const [name, mutate] of mutations) {
    await context.test(name, () => {
      assert.equal(
        approvedReleaseExecutionPolicy({
          ...baseline,
          productGateSource: mutate(baseline.productGateSource),
        }),
        false,
      );
    });
  }
});

test("release execution policy rejects disabled control flow around intact markers", async (context) => {
  for (const command of [":", "true", "false", "exit 0"]) {
    await context.test(command, () => {
      assert.equal(
        approvedReleaseExecutionPolicy({
          ...baseline,
          productGateSource: replaceRequired(
            baseline.productGateSource,
            "node scripts/release-compose-policy.mjs --assert-source\nassert_compose_service_contract",
            `node scripts/release-compose-policy.mjs --assert-source\n${command}\nassert_compose_service_contract`,
          ),
        }),
        false,
      );
    });
  }
});

test("release execution policy binds the create and restart lifecycle order", () => {
  const transactionCreate = `AIRLOCK_PRODUCTION_IMAGE_AUTH_TOKEN="$AUTH_TOKEN" \\
  node scripts/check-production-image-transaction.mjs \\
    --origin "$ORIGIN" \\
    --mode create \\
    --proof-file "$TRANSACTION_PROOF_FILE"
`;
  const persistenceCreate = `node scripts/production-image-persistence-verifier.mjs \\
  --session-root "$SESSION_ROOT" \\
  --transaction-proof "$TRANSACTION_PROOF_FILE" \\
  --mode create \\
  --snapshot-file "$PHYSICAL_PROOF_FILE" \\
  --data-sentinel-content "$DATA_SANDBOX_SENTINEL_CONTENT" \\
  --workspace-sentinel-content "$WORKSPACE_SANDBOX_SENTINEL_CONTENT"
`;
  let productGateSource = replaceRequired(
    baseline.productGateSource,
    transactionCreate,
    "__TRANSACTION_CREATE__\n",
  );
  productGateSource = replaceRequired(
    productGateSource,
    persistenceCreate,
    transactionCreate,
  );
  productGateSource = replaceRequired(
    productGateSource,
    "__TRANSACTION_CREATE__\n",
    persistenceCreate,
  );
  assert.equal(
    approvedReleaseExecutionPolicy({ ...baseline, productGateSource }),
    false,
  );
});

test("release execution policy rejects required commands in unreachable shell scopes", async (context) => {
  await context.test("Compose launch behind false", () => {
    assert.equal(
      approvedReleaseExecutionPolicy({
        ...baseline,
        productGateSource: replaceRequired(
          baseline.productGateSource,
          "  product_compose up --detach --no-build launchpad >/dev/null",
          "  if false; then\n    product_compose up --detach --no-build launchpad >/dev/null\n  fi",
        ),
      }),
      false,
    );
  });

  await context.test("create proofs behind false", () => {
    let productGateSource = replaceRequired(
      baseline.productGateSource,
      'AIRLOCK_PRODUCTION_IMAGE_AUTH_TOKEN="$AUTH_TOKEN" \\\n  node scripts/check-production-image-transaction.mjs',
      'if false; then\nAIRLOCK_PRODUCTION_IMAGE_AUTH_TOKEN="$AUTH_TOKEN" \\\n  node scripts/check-production-image-transaction.mjs',
    );
    productGateSource = replaceRequired(
      productGateSource,
      '  --workspace-sentinel-content "$WORKSPACE_SANDBOX_SENTINEL_CONTENT"\n\nstop_product_container',
      '  --workspace-sentinel-content "$WORKSPACE_SANDBOX_SENTINEL_CONTENT"\nfi\n\nstop_product_container',
    );
    assert.equal(
      approvedReleaseExecutionPolicy({ ...baseline, productGateSource }),
      false,
    );
  });
});

test("stopped Runtime publication policy accepts the shipped proof boundary", () => {
  assert.equal(approvedStoppedRuntimePublicationPolicy(baseline), true);
});

test("stopped Runtime publication policy rejects shutdown and snapshot bypasses", async (context) => {
  const mutations = [
    [
      "owned launcher tree stop removed",
      (source) =>
        replaceRequired(
          source,
          "await stopOwnedRuntimeProofProcessTree(launcherTree);",
          "await Promise.resolve(launcherTree);",
        ),
    ],
    [
      "launcher exit confirmation removed",
      (source) =>
        replaceRequired(
          source,
          "runtimeProofChildExitSucceeded(launcherOutcome)",
          "Boolean(launcherOutcome)",
        ),
    ],
    [
      "container cleanup removed",
      (source) =>
        replaceRequired(
          source,
          "await cleanupRuntimeContainers();",
          "await Promise.resolve();",
        ),
    ],
    [
      "container cleanup hidden behind false",
      (source) =>
        replaceRequired(
          source,
          "await cleanupRuntimeContainers();",
          "if (false) await cleanupRuntimeContainers();",
        ),
    ],
    [
      "container cleanup early return",
      (source) =>
        replaceRequired(
          source,
          "async function cleanupRuntimeContainers() {",
          "async function cleanupRuntimeContainers() {\n  return;",
        ),
    ],
    [
      "stopped snapshot assertion removed",
      (source) =>
        replaceRequired(
          source,
          "await assertStoppedRuntimeProofSnapshot({",
          "await Promise.resolve({",
        ),
    ],
    [
      "snapshot success assignment removed",
      (source) =>
        replaceRequired(
          source,
          "stoppedSnapshotVerified = true;",
          "stoppedSnapshotVerified = false;",
        ),
    ],
    [
      "session cleanup removed",
      (source) =>
        replaceRequired(
          source,
          "await cleanupRuntimeProofSessionRoot({",
          "await Promise.resolve({",
        ),
    ],
  ];
  for (const [name, mutate] of mutations) {
    await context.test(name, () => {
      assert.equal(
        approvedStoppedRuntimePublicationPolicy({
          ...baseline,
          proveRuntimeSource: mutate(baseline.proveRuntimeSource),
        }),
        false,
      );
    });
  }

  await context.test("container shutdown moved after the snapshot", () => {
    let proveRuntimeSource = replaceRequired(
      baseline.proveRuntimeSource,
      "await cleanupRuntimeContainers();",
      "await Promise.resolve();",
    );
    proveRuntimeSource = replaceRequired(
      proveRuntimeSource,
      "stoppedSnapshotVerified = true;",
      "stoppedSnapshotVerified = true;\n    await cleanupRuntimeContainers();",
    );
    assert.equal(
      approvedStoppedRuntimePublicationPolicy({
        ...baseline,
        proveRuntimeSource,
      }),
      false,
    );
  });

  await context.test(
    "managed session deletion moved before the snapshot",
    () => {
      let proveRuntimeSource = replaceRequired(
        baseline.proveRuntimeSource,
        "await cleanupRuntimeProofSessionRoot({",
        "await Promise.resolve({",
      );
      proveRuntimeSource = replaceRequired(
        proveRuntimeSource,
        "    await assertStoppedRuntimeProofSnapshot({",
        `    await cleanupRuntimeProofSessionRoot({
      artifactRoot,
      sessionRoot: session.sessionRoot,
      nonce: session.nonce,
    });
    await assertStoppedRuntimeProofSnapshot({`,
      );
      assert.equal(
        approvedStoppedRuntimePublicationPolicy({
          ...baseline,
          proveRuntimeSource,
        }),
        false,
      );
    },
  );
});

test("stopped Runtime publication policy requires a positive publication gate", async (context) => {
  for (const [name, replacement] of [
    ["gate removed", "if (!failure && pendingArtifacts && result) {"],
    [
      "gate inverted",
      "if (!failure && pendingArtifacts && result && !stoppedSnapshotVerified) {",
    ],
  ]) {
    await context.test(name, () => {
      assert.equal(
        approvedStoppedRuntimePublicationPolicy({
          ...baseline,
          proveRuntimeSource: replaceRequired(
            baseline.proveRuntimeSource,
            "if (!failure && pendingArtifacts && result && stoppedSnapshotVerified) {",
            replacement,
          ),
        }),
        false,
      );
    });
  }
});

test("stopped Runtime publication policy locks post-recheck Agent and Run mutations", async (context) => {
  for (const [name, search, replacement] of [
    [
      "test title removed",
      "stopped snapshot rejects persisted state created after the live final recheck",
      "stopped snapshot baseline",
    ],
    [
      "extra Agent insertion removed",
      "database.agents.push({",
      "database.agents.concat({",
    ],
    [
      "extra Agent identity removed",
      "agent-created-after-final-live-recheck",
      "unbound-extra-agent",
    ],
    [
      "fourth Run insertion removed",
      "database.runs.push({",
      "database.runs.concat({",
    ],
    [
      "fourth Run identity removed",
      "run-created-after-final-live-recheck",
      "unbound-extra-run",
    ],
    [
      "expected failure removed",
      '      "run-set-invalid",\n    );\n  } finally {',
      '      "startup-failed",\n    );\n  } finally {',
    ],
  ]) {
    await context.test(name, () => {
      assert.equal(
        approvedStoppedRuntimePublicationPolicy({
          ...baseline,
          runtimeProofTestSource: replaceRequired(
            baseline.runtimeProofTestSource,
            search,
            replacement,
          ),
        }),
        false,
      );
    });
  }
});
