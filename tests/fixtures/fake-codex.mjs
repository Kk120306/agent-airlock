#!/usr/bin/env node

import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
const repairRequest = /Agent Airlock Repair Run/i.test(prompt);
const destructiveRequest = !repairRequest && /delete\s+AGENTS\.md/i.test(prompt);
const multiResourceRequest = /multi-resource release/i.test(prompt);
const codexHome = process.env.CODEX_HOME;
const outboxPath = process.env.AIRLOCK_OUTBOX_PATH;
const repairReferencePath = process.env.AIRLOCK_REPAIR_REFERENCE_PATH;

if (!codexHome) {
  process.stderr.write("CODEX_HOME is required\n");
  process.exit(2);
}

const sessionDirectory = path.join(codexHome, "sessions", "fixture");
const sessionPath = path.join(sessionDirectory, "rollout-" + threadId + ".jsonl");

if (resumedThreadId && resumedThreadId !== "baseline-thread") {
  process.stderr.write("Unexpected thread identifier\n");
  process.exit(2);
}

await mkdir(sessionDirectory, { recursive: true });

if (resumedThreadId) {
  let acceptedMemory;
  try {
    acceptedMemory = await readFile(sessionPath, "utf8");
  } catch {
    process.stderr.write("Accepted session artifact did not persist\n");
    process.exit(4);
  }
  if (!acceptedMemory.includes("accepted-memory")) {
    process.stderr.write("Accepted reasoning did not persist\n");
    process.exit(5);
  }
  if (
    repairRequest &&
    !acceptedMemory.includes("rejected-memory")
  ) {
    process.stderr.write("Repair Run did not resume quarantined Agent memory\n");
    process.exit(6);
  }
  if (
    !repairRequest &&
    acceptedMemory.includes("rejected-memory") &&
    !acceptedMemory.includes("repaired-memory")
  ) {
    process.stderr.write("Rejected reasoning leaked into the next turn\n");
    process.exit(6);
  }
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
}

if (repairRequest) {
  if (!repairReferencePath) {
    process.stderr.write("AIRLOCK_REPAIR_REFERENCE_PATH is required\n");
    process.exit(7);
  }
  const canonicalInstructions = await readFile(
    path.join(repairReferencePath, "AGENTS.md"),
    "utf8",
  );
  await writeFile(
    path.join(process.cwd(), "AGENTS.md"),
    canonicalInstructions,
    "utf8",
  );
  const retainedDamage = await readFile(
    path.join(process.cwd(), "damage.txt"),
    "utf8",
  );
  if (!retainedDamage.includes("must remain quarantined")) {
    process.stderr.write("Useful quarantined workspace changes did not carry into repair\n");
    process.exit(8);
  }
  const database = new DatabaseSync(
    path.join(process.cwd(), ".airlock", "demo.sqlite"),
  );
  database
    .prepare("UPDATE inventory SET value = ?, updated_at = ? WHERE id = ?")
    .run("repaired", "2026-08-25T00:01:00.000Z", "demo");
  database.close();
  if (!outboxPath) throw new Error("AIRLOCK_OUTBOX_PATH is required");
  await writeFile(
    outboxPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "repair-ready",
      type: "demo.notification.requested",
      payload: {
        destination: "demo-console",
        subject: "Repair accepted",
        body: "The quarantined future was repaired and is ready.",
      },
    }) + "\n",
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
  const database = new DatabaseSync(
    path.join(process.cwd(), ".airlock", "demo.sqlite"),
  );
  database
    .prepare("UPDATE inventory SET value = ?, updated_at = ? WHERE id = ?")
    .run("rejected", "2026-08-25T00:00:00.000Z", "demo");
  database.close();
  if (!outboxPath) throw new Error("AIRLOCK_OUTBOX_PATH is required");
  await writeFile(
    outboxPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "unsafe-notice",
      type: "demo.notification.requested",
      payload: {
        destination: "demo-console",
        subject: "Unsafe change",
        body: "This effect must remain rejected.",
      },
    }) + "\n",
    "utf8",
  );
} else if (multiResourceRequest) {
  const database = new DatabaseSync(
    path.join(process.cwd(), ".airlock", "demo.sqlite"),
  );
  database
    .prepare("UPDATE inventory SET value = ?, updated_at = ? WHERE id = ?")
    .run("shipped", "2026-08-25T00:00:00.000Z", "demo");
  database.close();
  await writeFile(
    path.join(process.cwd(), "release.txt"),
    "workspace, data, and effect prepared\n",
    "utf8",
  );
  if (!outboxPath) throw new Error("AIRLOCK_OUTBOX_PATH is required");
  await writeFile(
    outboxPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "release-ready",
      type: "demo.notification.requested",
      payload: {
        destination: "demo-console",
        subject: "Release ready",
        body: "The accepted multi-resource release is ready.",
      },
    }) + "\n",
    "utf8",
  );
} else if (resumedThreadId) {
  const source = await readFile(path.join(process.cwd(), "src", "hello.ts"), "utf8");
  if (!source.includes('"hello"')) {
    process.stderr.write("Baseline workspace did not persist\n");
    process.exit(3);
  }
}

await appendFile(
  sessionPath,
  JSON.stringify({
    threadId,
    memory: destructiveRequest
      ? "rejected-memory"
      : repairRequest
        ? "repaired-memory"
        : "accepted-memory",
    prompt,
  }) + "\n",
  "utf8",
);

const output = destructiveRequest
  ? "Attempted the destructive workspace change for: " + prompt
  : repairRequest
    ? "Repaired the quarantined future using bounded Validation evidence and preserved its useful workspace and data changes."
  : multiResourceRequest
    ? "Prepared the multi-resource release with workspace, SQLite, and deferred notification changes for: " +
      prompt
  : resumedThreadId
    ? "Continued baseline-thread with the existing hello-world workspace and accepted memory for: " +
      prompt
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
