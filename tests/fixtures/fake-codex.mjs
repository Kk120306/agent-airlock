#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("codex-cli baseline-fixture\n");
  process.exit(0);
}

const resumeIndex = args.indexOf("resume");
const resumedThreadId = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
const prompt =
  resumeIndex >= 0
    ? args.slice(resumeIndex + 2).join(" ")
    : (args.at(-1) ?? "");
const threadId = resumedThreadId ?? "baseline-thread";
const destructiveRequest = /delete\s+AGENTS\.md/i.test(prompt);

if (resumedThreadId && resumedThreadId !== "baseline-thread") {
  process.stderr.write("Unexpected thread identifier\n");
  process.exit(2);
}

if (!resumedThreadId) {
  await mkdir(path.join(process.cwd(), "src"), { recursive: true });
  await mkdir(path.join(process.cwd(), "test"), { recursive: true });
  await writeFile(
    path.join(process.cwd(), "src", "hello.ts"),
    'export const hello = () => "hello";\n',
    "utf8",
  );
  await writeFile(
    path.join(process.cwd(), "test", "hello.test.ts"),
    'import { hello } from "../src/hello.js";\n\nif (hello() !== "hello") throw new Error("failed");\n',
    "utf8",
  );
} else if (destructiveRequest) {
  const source = await readFile(path.join(process.cwd(), "src", "hello.ts"), "utf8");
  if (!source.includes('"hello"')) {
    process.stderr.write("Baseline workspace did not persist before destructive turn\n");
    process.exit(3);
  }
  await rm(path.join(process.cwd(), "AGENTS.md"));
  await writeFile(path.join(process.cwd(), "damage.txt"), "must remain quarantined\n");
} else {
  const source = await readFile(path.join(process.cwd(), "src", "hello.ts"), "utf8");
  if (!source.includes('"hello"')) {
    process.stderr.write("Baseline workspace did not persist\n");
    process.exit(3);
  }
}

const output = destructiveRequest
  ? "Attempted the destructive workspace change for: " + prompt
  : resumedThreadId
    ? "Continued baseline-thread with the existing hello-world workspace for: " + prompt
    : "Baseline completed with a TypeScript hello-world source file and test for: " + prompt;

for (const event of [
  { type: "thread.started", thread_id: threadId },
  { type: "item.completed", item: { type: "agent_message", text: output } },
  {
    type: "turn.completed",
    usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 8 },
  },
]) {
  process.stdout.write(JSON.stringify(event) + "\n");
}
