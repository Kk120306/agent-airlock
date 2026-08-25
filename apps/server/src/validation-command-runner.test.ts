import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildValidationContainerArgs,
  ContainerValidationCommandExecutor,
} from "./validation-command-runner.js";
import type { ValidationCommand } from "./types.js";

const temporaryDirectories: string[] = [];

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
      const workspace = await mkdtemp(path.join(tmpdir(), "airlock-real-container-"));
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
