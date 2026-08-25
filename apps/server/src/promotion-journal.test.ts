import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunTransaction } from "./airlock-runner.js";
import { createDefaultOutcomeContract } from "./outcome-contract.js";
import { PromotionJournal } from "./promotion-journal.js";
import type { CanonicalStateReference } from "./types.js";
import type { PromotionPlan } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const source: CanonicalStateReference = {
  stateId: "source-state",
  workspacePath: "/platform/source/workspace",
  codexHomePath: "/platform/source/codex-home",
  outboxPath: "/platform/source/outbox",
  codexThreadId: "thread-one",
  workspaceContentHash: "sha256:workspace-source",
  sessionContentHash: "sha256:session-source",
  sqliteContentHash: "sha256:sqlite-source",
  outboxContentHash: "sha256:outbox-source",
  contentHash: "sha256:source",
};

const target: CanonicalStateReference = {
  ...source,
  stateId: "target-state",
  workspacePath: "/platform/target/workspace",
  codexHomePath: "/platform/target/codex-home",
  outboxPath: "/platform/target/outbox",
  workspaceContentHash: "sha256:workspace-target",
  sessionContentHash: "sha256:session-target",
  sqliteContentHash: "sha256:sqlite-target",
  outboxContentHash: "sha256:outbox-target",
  contentHash: "sha256:target",
};

const plan: PromotionPlan = {
  runId: "run-one",
  agentId: "agent-one",
  targetStateId: target.stateId,
  targetThreadId: target.codexThreadId,
  sourceStateId: source.stateId,
  sourceContentHash: source.contentHash,
  sourceWorkspaceHash: source.workspaceContentHash,
  sourceSessionHash: source.sessionContentHash,
  sourceSqliteHash: source.sqliteContentHash,
  sourceOutboxHash: source.outboxContentHash,
  sourceThreadId: source.codexThreadId,
};

describe("PromotionJournal", () => {
  it("persists bounded identity and enforces monotonic phases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-journal-"));
    temporaryDirectories.push(root);
    const journal = new PromotionJournal(root);
    await journal.initialize();
    const transaction = createRunTransaction(
      plan.runId,
      source,
      createDefaultOutcomeContract(),
    );

    const validated = await journal.begin({
      plan,
      transaction,
      result: {
        output: "secret Runtime output that must not enter the journal",
        threadId: target.codexThreadId,
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    });

    expect(validated).toMatchObject({
      phase: "validated",
      recoveryResult: {
        threadId: "thread-one",
        usage: { inputTokens: 4, outputTokens: 2 },
      },
      transaction: { recovery: { journalPhase: "validated" } },
    });
    expect(validated.recoveryResult.output).not.toContain("secret Runtime output");
    await expect(
      journal.advance(plan.runId, "canonical-advanced", {
        transaction: validated.transaction,
        targetCanonical: target,
      }),
    ).rejects.toThrow(/cannot advance/);

    const installed = await journal.advance(plan.runId, "version-installed", {
      transaction: validated.transaction,
      targetCanonical: target,
    });
    expect((await journal.read(plan.runId)).phase).toBe("version-installed");
    expect(installed.targetCanonical).toEqual(target);
    await expect(
      journal.advance(plan.runId, "version-installed", {
        transaction: validated.transaction,
        targetCanonical: target,
      }),
    ).resolves.toEqual(installed);
  });

  it("reports a corrupt record without trusting its contents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "airlock-journal-corrupt-"));
    temporaryDirectories.push(root);
    const journal = new PromotionJournal(root);
    await journal.initialize();
    await writeFile(path.join(root, "run-corrupt.json"), "{not-json}\n", "utf8");

    const scan = await journal.scan();

    expect(scan.records).toEqual([]);
    expect(scan.errors).toEqual([
      expect.objectContaining({
        runId: "run-corrupt",
        message: expect.stringContaining("corrupt"),
      }),
    ]);
  });
});
