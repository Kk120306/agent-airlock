import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildValidationContainerArgs,
  ContainerValidationCommandExecutor,
  createValidationCommandExecutor,
  PRODUCT_IMAGE_PROTOCOL_VALIDATION_COMMAND,
  ProductImageFixtureValidationCommandExecutor,
} from "./validation-command-runner.js";
import type { ValidationCommand } from "./types.js";

const temporaryDirectories: string[] = [];
const sharedContainerTestRoot = fileURLToPath(
  new URL("../../../.local/container-tests/", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const command: ValidationCommand = {
  name: "test",
  command: "npm test",
  required: true,
  timeoutMs: 1_000,
};

const productFixtureCommand: ValidationCommand = {
  name: "protocol-content",
  command: PRODUCT_IMAGE_PROTOCOL_VALIDATION_COMMAND,
  required: true,
  timeoutMs: 10_000,
};

async function makeProductFixtureValidationWorkspace(runId: string): Promise<{
  root: string;
  workspace: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-product-validation-"));
  temporaryDirectories.push(root);
  const candidateRoot = path.join(root, ".candidates", runId);
  await mkdir(candidateRoot, { recursive: true });
  const validationRoot = await mkdtemp(path.join(candidateRoot, ".validation-"));
  const workspace = path.join(validationRoot, "workspace");
  await mkdir(path.join(workspace, ".airlock"), { recursive: true });
  await writeFile(path.join(workspace, "protocol-proof.txt"), "candidate-only\n");
  const database = new DatabaseSync(path.join(workspace, ".airlock", "demo.sqlite"));
  database.exec(
    "CREATE TABLE inventory (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  database
    .prepare("INSERT INTO inventory (id, value, updated_at) VALUES (?, ?, ?)")
    .run("demo", "candidate-only", "2026-08-28T00:00:00.000Z");
  database.close();
  return { root, workspace };
}

describe("Validation command container", () => {
  it("mounts only a run-owned validation workspace with no credentials", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CONTAINER_ENGINE: "docker",
      CONTAINER_RUNTIME_IMAGE: "airlock-test:local",
      ARK_API_KEY: "must-not-cross-boundary",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/private/codex-home",
    });

    const args = buildValidationContainerArgs(
      "/tmp/workspaces/.candidates/run-1/.validation/workspace",
      command,
      "run-1",
      config,
      "airlock-validation-test",
    );
    const serialized = args.join(" ");

    expect(serialized).toContain("--network none");
    expect(serialized).toContain("--read-only");
    expect(serialized).toContain("--cap-drop ALL");
    expect(serialized).toContain("no-new-privileges");
    expect(serialized).toContain("src=/tmp/workspaces/.candidates/run-1/.validation/workspace,dst=/workspace");
    expect(serialized).not.toContain("must-not-cross-boundary");
    expect(serialized).not.toContain("ARK_API_KEY");
    expect(serialized).not.toContain("/private/codex-home");
    expect(args.filter((argument) => argument.startsWith("type=bind"))).toHaveLength(1);
  });

  it("terminates commands at the duration and output boundaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-fake-container-"));
    temporaryDirectories.push(root);
    const engine = path.join(root, "fake-container.mjs");
    await writeFile(
      engine,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'rm') process.exit(1);",
        "const command = args.at(-1);",
        "if (command === 'flood') process.stdout.write('x'.repeat(70000));",
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    await chmod(engine, 0o755);
    const config = loadConfig({
      NODE_ENV: "test",
      CONTAINER_ENGINE: engine,
      CONTAINER_RUNTIME_IMAGE: "unused",
    });
    const executor = new ContainerValidationCommandExecutor(config);

    const timed = await executor.execute(
      root,
      { ...command, command: "wait", timeoutMs: 40 },
      "run-timeout",
    );
    const flooded = await executor.execute(
      root,
      { ...command, command: "flood", timeoutMs: 2_000 },
      "run-output",
    );

    expect(timed.timedOut).toBe(true);
    expect(timed.durationMs).toBeLessThan(2_000);
    expect(flooded.outputExceeded).toBe(true);
    expect(Buffer.byteLength(flooded.output)).toBeLessThanOrEqual(65_536);
  });

  it.runIf(process.env.AIRLOCK_TEST_CONTAINER === "1")(
    "executes a real isolated Runtime command without host credentials",
    async () => {
      await mkdir(sharedContainerTestRoot, { recursive: true });
      const workspace = await mkdtemp(
        path.join(sharedContainerTestRoot, "airlock-real-container-"),
      );
      temporaryDirectories.push(workspace);
      const config = loadConfig({
        NODE_ENV: "test",
        CONTAINER_ENGINE: "docker",
        CONTAINER_RUNTIME_IMAGE: "volc-agent-runtime:local",
        ARK_API_KEY: "must-not-cross-boundary",
        ARK_MODEL: "ep-test",
      });
      const executor = new ContainerValidationCommandExecutor(config);

      const result = await executor.execute(
        workspace,
        {
          name: "real-container",
          command:
            "test -z \"${ARK_API_KEY:-}\" && " +
            "! touch /root-filesystem-write 2>/dev/null && " +
            "printf container-ok > validation-wrote.txt",
          required: true,
          timeoutMs: 10_000,
        },
        "real-container-run",
      );

      expect(result).toMatchObject({
        exitCode: 0,
        timedOut: false,
        outputExceeded: false,
      });
      await expect(access(path.join(workspace, "validation-wrote.txt"))).resolves
        .toBeUndefined();
    },
    20_000,
  );
});

describe("Product-image fixture Validation command", () => {
  it("selects the trusted exact executor only for the shipped product fixture", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-validation-profile-"));
    temporaryDirectories.push(root);
    const base = {
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      AIRLOCK_PROTOCOL_FIXTURE_MODE: "true",
      CODEX_BIN: "codex",
      ARK_API_KEY: "deterministic-protocol-fixture",
      ARK_MODEL: "protocol-fixture",
    } as const;
    const productConfig = loadConfig({
      ...base,
      HOST: "0.0.0.0",
      APP_AUTH_TOKEN: "phase11-container-verification-token",
      ARK_BASE_URL: "http://127.0.0.1:43991/v1",
      RUNTIME_PROVIDER: "local-process",
      CONTAINER_ENGINE: "missing-inside-product-image",
    });
    const containerConfig = loadConfig({
      ...base,
      HOST: "127.0.0.1",
      ARK_BASE_URL: "http://host.docker.internal:43991/v1",
      RUNTIME_PROVIDER: "container",
    });
    const defaultConfig = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "default-data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "default-workspaces"),
      CODEX_HOME: path.join(root, "default-codex"),
    });

    expect(createValidationCommandExecutor(productConfig)).toBeInstanceOf(
      ProductImageFixtureValidationCommandExecutor,
    );
    for (const mutation of [
      { protocolFixtureMode: false },
      { runtimeProvider: "container" as const },
      { host: "127.0.0.1" },
      { authToken: "short" },
      { codexBin: "/tmp/fake-codex" },
      { arkApiKey: "different" },
      { arkModel: "different" },
      { arkBaseUrl: "http://127.0.0.1:43992/v1" },
    ]) {
      expect(
        createValidationCommandExecutor({ ...productConfig, ...mutation }),
      ).toBeInstanceOf(ContainerValidationCommandExecutor);
    }
    expect(createValidationCommandExecutor(containerConfig)).toBeInstanceOf(
      ContainerValidationCommandExecutor,
    );
    expect(createValidationCommandExecutor(defaultConfig)).toBeInstanceOf(
      ContainerValidationCommandExecutor,
    );
  });

  it("passes the exact file and SQLite assertions on a disposable Candidate copy", async () => {
    const runId = "run-product-proof";
    const { root, workspace } =
      await makeProductFixtureValidationWorkspace(runId);
    const executor = new ProductImageFixtureValidationCommandExecutor(root);

    await expect(
      executor.execute(workspace, productFixtureCommand, runId),
    ).resolves.toMatchObject({
      exitCode: 0,
      output: "",
      timedOut: false,
      outputExceeded: false,
    });
  });

  it.each([
    ["name", { name: "different" }],
    [
      "command",
      { command: PRODUCT_IMAGE_PROTOCOL_VALIDATION_COMMAND + " && true" },
    ],
    ["severity", { required: false }],
    ["timeout", { timeoutMs: 9_999 }],
  ] as const)(
    "rejects a changed %s before inspecting Candidate State",
    async (_name, mutation) => {
      const executor = new ProductImageFixtureValidationCommandExecutor("/unused");

      await expect(
        executor.execute(
          "/unused",
          { ...productFixtureCommand, ...mutation },
          "run-product-proof",
        ),
      ).rejects.toThrow("exact approved command");
    },
  );

  it("fails changed proof content and changed SQLite content", async () => {
    const runId = "run-product-mutation";
    const { root, workspace } =
      await makeProductFixtureValidationWorkspace(runId);
    const executor = new ProductImageFixtureValidationCommandExecutor(root);
    const proofPath = path.join(workspace, "protocol-proof.txt");
    const databasePath = path.join(workspace, ".airlock", "demo.sqlite");

    await writeFile(proofPath, "not-candidate-only\n");
    await expect(
      executor.execute(workspace, productFixtureCommand, runId),
    ).resolves.toMatchObject({ exitCode: 1 });
    await writeFile(proofPath, "candidate-only\n");
    const database = new DatabaseSync(databasePath);
    database
      .prepare("UPDATE inventory SET value = ? WHERE id = ?")
      .run("not-candidate-only", "demo");
    database.close();
    await expect(
      executor.execute(workspace, productFixtureCommand, runId),
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  it("rejects a workspace outside the Run-owned disposable validation root", async () => {
    const runId = "run-product-path";
    const { root } = await makeProductFixtureValidationWorkspace(runId);
    const canonicalWorkspace = path.join(root, "canonical", "workspace");
    await mkdir(canonicalWorkspace, { recursive: true });
    const executor = new ProductImageFixtureValidationCommandExecutor(root);

    await expect(
      executor.execute(canonicalWorkspace, productFixtureCommand, runId),
    ).rejects.toThrow("disposable Candidate copy");
  });
});
