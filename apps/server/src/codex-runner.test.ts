import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildCodexArgs,
  buildCodexEnvironment,
  CodexRunner,
  parseCodexEventLine,
} from "./codex-runner.js";

describe("Codex runner protocol", () => {
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
      "-C",
      "/tmp/workspace",
      "--add-dir",
      "/tmp/candidate-outbox",
      "build a calculator",
    ]);
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
    expect(environment.AIRLOCK_OUTBOX_PATH).toBe(
      "/tmp/candidate-outbox/intents.jsonl",
    );
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
});
