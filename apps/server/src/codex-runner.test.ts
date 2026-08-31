import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildCodexArgs,
  buildCodexEnvironment,
  buildCodexToolBoundaryArgs,
  CodexRunner,
  assertTrustedTokenBudget,
  parseCodexEventLine,
} from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("isolates availability probe artifacts from the persistent Codex template", async () => {
    const testRoot = await mkdtemp(
      path.join(tmpdir(), "agent-airlock-codex-runner-test-"),
    );
    const codexHome = path.join(testRoot, "codex-home");
    const probeRecordPath = path.join(testRoot, "probe-home.txt");
    const codexBin = path.join(testRoot, "fake-codex.mjs");
    await mkdir(codexHome);
    await writeFile(path.join(codexHome, "config.toml"), "model = \"test\"\n");
    await writeFile(
      codexBin,
      `#!/usr/bin/env node
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const codexHome = process.env.CODEX_HOME;
if (!codexHome) process.exit(2);
const argDirectory = path.join(codexHome, "tmp", "arg0", "codex-arg0-test");
await mkdir(argDirectory, { recursive: true });
await writeFile(path.join(argDirectory, ".lock"), "");
await symlink("/dev/null", path.join(argDirectory, "applypatch"));
await symlink("/dev/null", path.join(argDirectory, "apply_patch"));
await symlink("/dev/null", path.join(argDirectory, "codex-execve-wrapper"));
await writeFile(${JSON.stringify(probeRecordPath)}, codexHome);
process.stdout.write("codex-test 1.0.0\\n");
`,
      { mode: 0o700 },
    );
    await chmod(codexBin, 0o700);

    try {
      const config = loadConfig({
        NODE_ENV: "test",
        CODEX_BIN: codexBin,
        CODEX_HOME: codexHome,
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
      });

      await expect(new CodexRunner(config).isAvailable()).resolves.toBe(true);
      await expect(readdir(codexHome)).resolves.toEqual(["config.toml"]);
      const probeCodexHome = await readFile(probeRecordPath, "utf8");
      await expect(access(probeCodexHome)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("fails before process launch for unenforceable read-only provider bindings", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const runner = new CodexRunner(config);

    await expect(
      runner.run({
        agentId: "agent-read-only",
        workspacePath: "/tmp/workspace",
        codexHomePath: "/tmp/codex-home",
        outboxPath: "/tmp/outbox/intents.jsonl",
        prompt: "do not mutate",
        threadId: null,
        resourceBindings: [
          {
            providerId: "read-only-object",
            hostPath: "/tmp/resource/object.json",
            runtimePath: "/airlock/resources/read-only-object/object.json",
            access: "read-only",
          },
        ],
      }),
    ).rejects.toThrow(/cannot enforce read-only/);
  });

  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        codexHomePath: "/tmp/candidate-codex-home",
        outboxPath: "/tmp/candidate-outbox/intents.jsonl",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      ...buildCodexToolBoundaryArgs(),
      "-C",
      "/tmp/workspace",
      "--add-dir",
      "/tmp/candidate-outbox",
      "build a calculator",
    ]);
  });

  it("forces a credential-free non-login environment for model-issued tools", () => {
    const args = buildCodexToolBoundaryArgs();
    const serialized = args.join(" ");

    expect(serialized).toContain("allow_login_shell=false");
    expect(serialized).toContain("shell_environment_policy.inherit=\"all\"");
    expect(serialized).toContain(
      "shell_environment_policy.ignore_default_excludes=false",
    );
    expect(serialized).toContain("*KEY*");
    expect(serialized).toContain("*SECRET*");
    expect(serialized).toContain("*TOKEN*");
    expect(serialized).toContain("*PASSWORD*");
    expect(serialized).toContain("*CREDENTIAL*");
    expect(serialized).toContain("AIRLOCK_OUTBOX_PATH");
    expect(serialized).toContain("AIRLOCK_REPAIR_REFERENCE_PATH");
    expect(serialized).toContain("AIRLOCK_MAXIMUM_TOTAL_TOKENS");
    expect(serialized).toContain("sandbox_workspace_write.network_access=false");
  });

  it("preserves an explicit Candidate-local resource binding for tools", () => {
    const serialized = buildCodexToolBoundaryArgs([
      "AIRLOCK_RESOURCE_POLICY_BUNDLE_PATH",
    ]).join(" ");

    expect(serialized).toContain("AIRLOCK_RESOURCE_POLICY_BUNDLE_PATH");
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        codexHomePath: "/tmp/candidate-codex-home",
        outboxPath: "/tmp/candidate-outbox/intents.jsonl",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("exposes a bounded repair reference only for Repair Runs", () => {
    const request = {
      agentId: "agent",
      workspacePath: "/tmp/workspace",
      codexHomePath: "/tmp/candidate-codex-home",
      outboxPath: "/tmp/candidate-outbox/intents.jsonl",
      repairReferencePath: "/tmp/candidate/repair-reference",
      prompt: "repair",
      threadId: "thread-123",
    };
    const args = buildCodexArgs(request, "workspace-write");
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const environment = buildCodexEnvironment(
      config,
      request.codexHomePath,
      request.outboxPath,
      request.repairReferencePath,
    );

    expect(args).toContain("/tmp/candidate/repair-reference");
    expect(environment.AIRLOCK_REPAIR_REFERENCE_PATH).toBe(
      "/tmp/candidate/repair-reference",
    );
  });

  it("uses the Candidate State Codex home instead of the global template", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/global-template",
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });

    const environment = buildCodexEnvironment(
      config,
      "/tmp/candidate-session",
      "/tmp/candidate-outbox/intents.jsonl",
    );

    expect(environment.CODEX_HOME).toBe("/tmp/candidate-session");
    expect(environment.CODEX_HOME).not.toBe(config.codexHome);
    expect(environment.HOME).toBe("/tmp");
    expect(environment.AIRLOCK_OUTBOX_PATH).toBe(
      "/tmp/candidate-outbox/intents.jsonl",
    );
  });

  it("transports a Candidate Set token allowance only to the zero-cost demo fixture", () => {
    const demoConfig = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      CODEX_BIN: "/tmp/fake-codex.mjs",
      ARK_API_KEY: "deterministic-local-fixture",
      ARK_MODEL: "local-airlock-demo",
      ARK_BASE_URL: "http://127.0.0.1:1/api/v3",
      AIRLOCK_DEMO_MODE: "true",
      RUNTIME_PROVIDER: "local-process",
    });
    const productionConfig = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const budget = { schemaVersion: 1 as const, maximumTotalTokens: 37 };

    expect(
      buildCodexEnvironment(
        demoConfig,
        "/tmp/candidate-session",
        undefined,
        undefined,
        [],
        budget,
      ).AIRLOCK_MAXIMUM_TOTAL_TOKENS,
    ).toBe("37");
    expect(
      buildCodexEnvironment(
        productionConfig,
        "/tmp/candidate-session",
        undefined,
        undefined,
        [],
        budget,
      ).AIRLOCK_MAXIMUM_TOTAL_TOKENS,
    ).toBeUndefined();
    expect(new CodexRunner(demoConfig).tokenBudgetEnforcement).toBe(
      "provider-boundary",
    );
    expect(new CodexRunner(productionConfig).tokenBudgetEnforcement).toBeUndefined();
  });

  it("exposes provider resources through derived local bindings", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const resourceBindings = [
      {
        providerId: "acceptance-object",
        hostPath: "/tmp/candidate/resources/acceptance-object/object.json",
        runtimePath: "/airlock/resources/acceptance-object/object.json",
        access: "read-write" as const,
      },
    ];
    const request = {
      agentId: "agent",
      workspacePath: "/tmp/workspace",
      codexHomePath: "/tmp/candidate-codex-home",
      outboxPath: "/tmp/candidate-outbox/intents.jsonl",
      prompt: "update the object",
      threadId: null,
      resourceBindings,
    };

    const args = buildCodexArgs(request, "workspace-write");
    const environment = buildCodexEnvironment(
      config,
      request.codexHomePath,
      request.outboxPath,
      undefined,
      resourceBindings,
    );

    expect(args).toContain(
      "/tmp/candidate/resources/acceptance-object/object.json",
    );
    expect(environment.AIRLOCK_RESOURCE_ACCEPTANCE_OBJECT_PATH).toBe(
      "/tmp/candidate/resources/acceptance-object/object.json",
    );
    expect(environment.AIRLOCK_RESOURCE_ACCEPTANCE_OBJECT_PATH).not.toContain(
      "/airlock/resources/",
    );
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("fails closed when trusted usage exceeds or omits a reserved token allowance", () => {
    const request = {
      agentId: "agent",
      workspacePath: "/tmp/workspace",
      codexHomePath: "/tmp/candidate-codex-home",
      outboxPath: "/tmp/candidate-outbox/intents.jsonl",
      prompt: "bounded future",
      threadId: null,
      tokenBudget: { schemaVersion: 1 as const, maximumTotalTokens: 12 },
    };

    expect(() =>
      assertTrustedTokenBudget(request, { inputTokens: 8, outputTokens: 4 }),
    ).not.toThrow();
    expect(() =>
      assertTrustedTokenBudget(request, { inputTokens: 8, outputTokens: 5 }),
    ).toThrow(/exceeded/);
    expect(() => assertTrustedTokenBudget(request, null)).toThrow(/omitted/);
  });
});
