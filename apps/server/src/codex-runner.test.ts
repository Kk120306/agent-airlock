import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildCodexArgs,
  buildCodexEnvironment,
  parseCodexEventLine,
} from "./codex-runner.js";

describe("Codex runner protocol", () => {
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
