import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANONICAL_ADVANCE_EVIDENCE_SUMMARY,
  createRunTransaction,
  type PromotionFaultInjector,
  type PromotionFaultPoint,
} from "./airlock-runner.js";
import { AgentService } from "./agent-service.js";
import { loadConfig, type AppConfig } from "./config.js";
import type {
  ExternalActionDeliveryMode,
  ExternalActionDeliveryReceipt,
  ExternalActionDispatcher,
  ExternalActionDispatcherScope,
  ParsedExternalActionIntent,
} from "./external-actions.js";
import {
  createExternalActionDispatcherScope,
  HttpExternalActionDispatcher,
} from "./external-actions.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { persistFixtureSession } from "../test/session-fixture.js";
import { waitForRunToFinish } from "../test/agent-service-workflow.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class DurablePromotionFixtureRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    const rejected = request.prompt.includes("unsafe");
    const database = new DatabaseSync(
      path.join(request.workspacePath, ".airlock", "demo.sqlite"),
    );
    database
      .prepare("UPDATE inventory SET value = ?, updated_at = ? WHERE id = ?")
      .run(
        rejected ? "rejected" : "durable",
        "2026-08-25T00:00:00.000Z",
        "demo",
      );
    database.close();
    await writeFile(
      request.outboxPath,
      JSON.stringify({
        schemaVersion: 1,
        id: rejected ? "unsafe-intent" : "durable-intent",
        type: "demo.notification.requested",
        payload: {
          destination: "demo-console",
          subject: rejected ? "Rejected" : "Durable Promotion",
          body: "Phase 6 deterministic fixture",
        },
      }) + "\n",
      "utf8",
    );
    if (rejected) {
      await rm(path.join(request.workspacePath, "AGENTS.md"));
    } else {
      await writeFile(
        path.join(request.workspacePath, "durable.txt"),
        "one accepted future\n",
        "utf8",
      );
    }
    const threadId = request.threadId ?? "durable-thread";
    await persistFixtureSession(request, threadId, "durable-memory");
    return {
      output: "durable Promotion fixture completed",
      threadId,
      usage: { inputTokens: 8, outputTokens: 4 },
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

interface Fixture {
  root: string;
  config: AppConfig;
  store: JsonStore;
  workspaces: WorkspaceManager;
  service: AgentService;
}

async function createFixture(
  root?: string,
  fault?: PromotionFaultInjector,
  retentionHours?: number,
  externalActionDispatcher?: ExternalActionDispatcher,
  initialize = true,
): Promise<Fixture> {
  const fixtureRoot =
    root ?? (await mkdtemp(path.join(tmpdir(), "airlock-phase-six-")));
  if (!root) temporaryDirectories.push(fixtureRoot);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(fixtureRoot, "data"),
    AGENT_WORKSPACE_ROOT: path.join(fixtureRoot, "workspaces"),
    CODEX_HOME: path.join(fixtureRoot, "codex"),
    ARK_API_KEY: "fixture-only-key",
    ARK_MODEL: "fixture-only-model",
    AIRLOCK_CANDIDATE_RETENTION_HOURS: String(retentionHours ?? 24),
    AIRLOCK_QUARANTINE_RETENTION_HOURS: String(retentionHours ?? 168),
  });
  const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
  const workspaces = new WorkspaceManager(config.workspaceRoot);
  const service = new AgentService(
    config,
    store,
    workspaces,
    new DurablePromotionFixtureRunner(),
    undefined,
    fault,
    undefined,
    externalActionDispatcher,
  );
  if (initialize) await service.initialize();
  return { root: fixtureRoot, config, store, workspaces, service };
}

class AcceptedThenInterruptedDispatcher implements ExternalActionDispatcher {
  calls = 0;
  readonly scope: ExternalActionDispatcherScope;

  constructor(
    readonly deliveryMode: ExternalActionDeliveryMode,
    readonly consumerIdentity: string,
  ) {
    this.scope = createExternalActionDispatcherScope(
      deliveryMode,
      consumerIdentity,
    );
  }

  async initialize(): Promise<void> {}

  assertOperational(): void {}

  async dispatch(): Promise<ExternalActionDeliveryReceipt[]> {
    this.calls += 1;
    throw new Error(
      "simulated process interruption after the first consumer accepted delivery",
    );
  }

  async list(): Promise<ExternalActionDeliveryReceipt[]> {
    return [];
  }
}

class RecordingExternalActionDispatcher implements ExternalActionDispatcher {
  calls = 0;
  readonly scope: ExternalActionDispatcherScope;
  private receipts: ExternalActionDeliveryReceipt[] = [];

  constructor(
    readonly deliveryMode: ExternalActionDeliveryMode,
    readonly consumerIdentity: string,
  ) {
    this.scope = createExternalActionDispatcherScope(
      deliveryMode,
      consumerIdentity,
    );
  }

  async initialize(): Promise<void> {}

  assertOperational(): void {}

  async dispatch(
    runId: string,
    intents: ParsedExternalActionIntent[],
  ): Promise<ExternalActionDeliveryReceipt[]> {
    this.calls += 1;
    if (this.receipts.length === 0) {
      this.receipts = intents.map((intent) => ({
        idempotencyKey: intent.idempotencyKey,
        runId,
        intentId: intent.id,
        type: intent.type,
        destination: intent.payload.destination,
        subject: intent.payload.subject,
        payloadHash: intent.payloadHash,
        deliveredAt: new Date().toISOString(),
        deliveryMode: this.deliveryMode,
      }));
    }
    return structuredClone(this.receipts);
  }

  async list(): Promise<ExternalActionDeliveryReceipt[]> {
    return structuredClone(this.receipts);
  }
}

class IdempotentReceiverFixture {
  readonly requestKeys: string[] = [];
  private readonly receipts = new Map<
    string,
    ExternalActionDeliveryReceipt
  >();

  get acceptedCount(): number {
    return this.receipts.size;
  }

  deliver(
    runId: string,
    intents: ParsedExternalActionIntent[],
  ): ExternalActionDeliveryReceipt[] {
    return intents.map((intent) => {
      this.requestKeys.push(intent.idempotencyKey);
      const existing = this.receipts.get(intent.idempotencyKey);
      if (existing) return structuredClone(existing);
      const receipt: ExternalActionDeliveryReceipt = {
        idempotencyKey: intent.idempotencyKey,
        runId,
        intentId: intent.id,
        type: intent.type,
        destination: intent.payload.destination,
        subject: intent.payload.subject,
        payloadHash: intent.payloadHash,
        deliveredAt: new Date().toISOString(),
        deliveryMode: "idempotent-http",
      };
      this.receipts.set(intent.idempotencyKey, receipt);
      return structuredClone(receipt);
    });
  }
}

class ReceiverBackedExternalActionDispatcher
  implements ExternalActionDispatcher
{
  readonly deliveryMode = "idempotent-http" as const;
  readonly scope: ExternalActionDispatcherScope;
  private readonly localReceipts = new Map<
    string,
    ExternalActionDeliveryReceipt
  >();

  constructor(
    consumerId: string,
    private readonly receiver: IdempotentReceiverFixture,
    private readonly interruptAfterAcceptance = false,
  ) {
    this.scope = createExternalActionDispatcherScope(
      this.deliveryMode,
      consumerId + "\0demo-console",
    );
  }

  async initialize(): Promise<void> {}

  assertOperational(): void {}

  async dispatch(
    runId: string,
    intents: ParsedExternalActionIntent[],
  ): Promise<ExternalActionDeliveryReceipt[]> {
    const cached = intents.map((intent) =>
      this.localReceipts.get(intent.idempotencyKey),
    );
    if (cached.every((receipt) => receipt !== undefined)) {
      return structuredClone(cached as ExternalActionDeliveryReceipt[]);
    }
    const receipts = this.receiver.deliver(runId, intents);
    if (this.interruptAfterAcceptance) {
      throw new Error(
        "simulated process interruption before the sender persisted its receipt",
      );
    }
    for (const receipt of receipts) {
      this.localReceipts.set(receipt.idempotencyKey, receipt);
    }
    return receipts;
  }

  async list(): Promise<ExternalActionDeliveryReceipt[]> {
    return structuredClone([...this.localReceipts.values()]);
  }
}

async function downgradePromotionJournalToLegacy(
  root: string,
  runId: string,
): Promise<void> {
  const journalPath = path.join(
    root,
    "data",
    "promotion-journal",
    runId + ".json",
  );
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<
    string,
    unknown
  >;
  journal.schemaVersion = 2;
  delete journal.externalActionScope;
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n", "utf8");
}

function createReceiverFetch(
  consumerId: string,
  onDelivery: () => void,
): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") {
      return Response.json({
        schema: "agent-airlock/external-action-consumer-identity",
        schemaVersion: 1,
        deliveryMode: "idempotent-http",
        consumerId,
      });
    }
    onDelivery();
    const request = JSON.parse(String(init?.body)) as {
      runId: string;
      intent: {
        id: string;
        type: "demo.notification.requested";
        destination: string;
        subject: string;
        payloadHash: string;
      };
    };
    return Response.json({
      schema: "agent-airlock/external-action-delivery-receipt",
      schemaVersion: 1,
      accepted: true,
      receipt: {
        idempotencyKey: (init?.headers as Record<string, string>)[
          "idempotency-key"
        ],
        runId: request.runId,
        intentId: request.intent.id,
        type: request.intent.type,
        destination: request.intent.destination,
        subject: request.intent.subject,
        payloadHash: request.intent.payloadHash,
        deliveredAt: "2026-08-30T00:00:00.000Z",
      },
    });
  }) as typeof fetch;
}

async function waitForTerminal(service: AgentService, runId: string) {
  return waitForRunToFinish(service, runId);
}

const faultPoints: PromotionFaultPoint[] = [
  "after-validated",
  "after-version-install",
  "after-version-installed",
  "after-canonical-advance",
  "after-canonical-advanced",
  "after-effect-dispatch",
  "after-effects-delivered",
  "after-completed",
];

describe("Phase 6 durable Promotion recovery", () => {
  it.each(faultPoints)("converges after a crash at %s", async (faultPoint) => {
    let injected = false;
    const first = await createFixture(undefined, (point) => {
      if (!injected && point === faultPoint) {
        injected = true;
        throw new Error("simulated process crash at " + point);
      }
    });
    const agent = await first.service.createAgent({ name: "Durable Agent" });
    const source = await first.workspaces.readCanonical(agent.id);
    const started = await first.service.sendMessage(
      agent.id,
      "prepare one durable multi-resource Promotion",
    );
    const interrupted = await waitForTerminal(first.service, started.run.id);
    expect(interrupted.status).toBe("failed");
    expect(interrupted.error).toContain("requires durable reconciliation");
    const interruptedJournal = JSON.parse(
      await readFile(
        path.join(
          first.config.dataDirectory,
          "promotion-journal",
          started.run.id + ".json",
        ),
        "utf8",
      ),
    ) as { transaction: { events: Array<{ summary: string }> } };
    const canonicalAdvanceEvents = interruptedJournal.transaction.events.filter(
      (event) => event.summary === CANONICAL_ADVANCE_EVIDENCE_SUMMARY,
    );
    expect(canonicalAdvanceEvents).toHaveLength(
      [
        "after-canonical-advance",
        "after-canonical-advanced",
        "after-effect-dispatch",
        "after-effects-delivered",
        "after-completed",
      ].includes(faultPoint)
        ? 1
        : 0,
    );

    const recovered = await createFixture(first.root);
    const completed = recovered.service.getRun(started.run.id);
    const canonical = await recovered.workspaces.readCanonical(agent.id);

    expect(completed).toMatchObject({
      status: "completed",
      error: null,
      transaction: {
        disposition: "promoted",
        status: "promoted",
        recovery: {
          journalPhase: "completed",
          recoveredAfterRestart: true,
          recoveryError: null,
        },
        externalActions: {
          deliveredCount: 1,
          intents: [{ id: "durable-intent", status: "delivered" }],
        },
      },
    });
    const completedTransaction = completed.transaction!;
    const completedAdvanceEvents = completedTransaction.events.filter(
      (event) => event.summary === CANONICAL_ADVANCE_EVIDENCE_SUMMARY,
    );
    expect(completedAdvanceEvents).toHaveLength(1);
    const canonicalAdvanceAt = Date.parse(completedAdvanceEvents[0]!.at);
    const deliveredAt = Date.parse(
      completedTransaction.externalActions.intents[0]!.deliveredAt!,
    );
    const promotedIndex = completedTransaction.events.findIndex(
      (event) => event.status === "promoted",
    );
    expect(Number.isFinite(canonicalAdvanceAt)).toBe(true);
    expect(deliveredAt).toBeGreaterThanOrEqual(canonicalAdvanceAt);
    expect(completedTransaction.events.indexOf(completedAdvanceEvents[0]!)).toBeLessThan(
      promotedIndex,
    );
    expect(canonical.stateId).not.toBe(source.stateId);
    await expect(
      readFile(path.join(canonical.workspacePath, "durable.txt"), "utf8"),
    ).resolves.toBe("one accepted future\n");
    expect(await recovered.service.listExternalEffects()).toHaveLength(1);
    expect(
      await readdir(path.join(first.config.workspaceRoot, agent.id, "versions")),
    ).toHaveLength(2);

    const replayed = await createFixture(first.root);
    expect(await replayed.service.listExternalEffects()).toHaveLength(1);
    expect(replayed.service.getMessages(agent.id).filter((message) => message.role === "assistant"))
      .toHaveLength(1);
    expect(
      replayed.service
        .getRun(started.run.id)
        .transaction!.events.filter(
          (event) => event.summary === CANONICAL_ADVANCE_EVIDENCE_SUMMARY,
        ),
    ).toHaveLength(1);
    expect(
      await readdir(path.join(first.config.workspaceRoot, agent.id, "versions")),
    ).toHaveLength(2);
  });

  it.each([
    {
      name: "HTTP delivery to the local mock consumer",
      nextMode: "atomic-local-store" as const,
      nextIdentity: "mock:/different-delivery-store",
    },
    {
      name: "one HTTP endpoint to another endpoint",
      nextMode: "idempotent-http" as const,
      nextIdentity: "http://127.0.0.1:3203/v1/effects/demo-console",
    },
  ])(
    "fails recovery closed when the external-action consumer changes from $name",
    async ({ nextMode, nextIdentity }) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "airlock-phase-six-effect-scope-"),
      );
      temporaryDirectories.push(root);
      const accepted = new AcceptedThenInterruptedDispatcher(
        "idempotent-http",
        "http://127.0.0.1:3202/v1/effects/demo-console",
      );
      const first = await createFixture(root, undefined, undefined, accepted);
      const agent = await first.service.createAgent({
        name: "Effect Consumer Scope Agent",
      });

      const started = await first.service.sendMessage(
        agent.id,
        "promote before the accepted effect acknowledgement is persisted",
      );
      const interrupted = await waitForTerminal(first.service, started.run.id);
      const canonical = await first.workspaces.readCanonical(agent.id);

      expect(accepted.calls).toBe(1);
      expect(interrupted).toMatchObject({
        status: "failed",
        transaction: {
          status: "promoting",
          disposition: "promoted",
          recovery: { journalPhase: "canonical-advanced" },
        },
      });

      const secondConsumer = new RecordingExternalActionDispatcher(
        nextMode,
        nextIdentity,
      );
      const restarted = await createFixture(
        root,
        undefined,
        undefined,
        secondConsumer,
      );
      const failed = restarted.service.getRun(started.run.id);

      expect(secondConsumer.calls).toBe(0);
      expect(await restarted.workspaces.readCanonical(agent.id)).toEqual(
        canonical,
      );
      expect(failed).toMatchObject({
        status: "failed",
        transaction: {
          status: "recovery-error",
          disposition: "promoted",
          promotionReceipt: null,
          recovery: {
            recoveryError: expect.stringContaining(
              "external-action consumer scope",
            ),
          },
        },
      });
      await expect(restarted.service.listExternalEffects()).resolves.toEqual([]);
      await expect(restarted.service.startAgent(agent.id)).rejects.toThrow(
        /unresolved Candidate disposition evidence/,
      );
    },
  );

  it("replays the same key to the same HTTP consumer after acceptance without a sender receipt", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-http-ambiguous-replay-"),
    );
    temporaryDirectories.push(root);
    const consumerId = "00000000-0000-4000-8000-000000000001";
    const receiver = new IdempotentReceiverFixture();
    const first = await createFixture(
      root,
      undefined,
      undefined,
      new ReceiverBackedExternalActionDispatcher(consumerId, receiver, true),
    );
    const agent = await first.service.createAgent({
      name: "Ambiguous HTTP Replay Agent",
    });
    const started = await first.service.sendMessage(
      agent.id,
      "promote across the receiver acknowledgement crash window",
    );
    const interrupted = await waitForTerminal(first.service, started.run.id);

    expect(interrupted).toMatchObject({
      status: "failed",
      transaction: {
        recovery: { journalPhase: "canonical-advanced" },
      },
    });
    expect(receiver.requestKeys).toHaveLength(1);
    expect(receiver.acceptedCount).toBe(1);

    const restarted = await createFixture(
      root,
      undefined,
      undefined,
      new ReceiverBackedExternalActionDispatcher(consumerId, receiver),
    );

    expect(restarted.service.getRun(started.run.id)).toMatchObject({
      status: "completed",
      transaction: {
        status: "promoted",
        externalActions: {
          deliveredCount: 1,
          intents: [{ id: "durable-intent", status: "delivered" }],
        },
        recovery: {
          journalPhase: "completed",
          recoveredAfterRestart: true,
          recoveryError: null,
        },
      },
    });
    expect(receiver.requestKeys).toHaveLength(2);
    expect(new Set(receiver.requestKeys)).toHaveLength(1);
    expect(receiver.acceptedCount).toBe(1);
    const recoveredTransaction = restarted.service.getRun(started.run.id)
      .transaction!;
    const recoveredAdvanceEvents = recoveredTransaction.events.filter(
      (event) => event.summary === CANONICAL_ADVANCE_EVIDENCE_SUMMARY,
    );
    expect(recoveredAdvanceEvents).toHaveLength(1);
    expect(
      Date.parse(recoveredTransaction.externalActions.intents[0]!.deliveredAt!),
    ).toBeGreaterThanOrEqual(Date.parse(recoveredAdvanceEvents[0]!.at));
    await expect(restarted.service.listExternalEffects()).resolves.toHaveLength(1);
  });

  it("records recovery-error before refusing startup when the HTTP receiver store is replaced at the same URL", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-http-store-rollover-"),
    );
    temporaryDirectories.push(root);
    const endpoint = "http://127.0.0.1:3202/v1/effects/demo-console";
    const receiptStore = path.join(root, "data", "http-receipts.json");
    const originalConsumerId = "00000000-0000-4000-8000-000000000001";
    const replacementConsumerId = "00000000-0000-4000-8000-000000000002";
    let originalPosts = 0;
    let replacementPosts = 0;
    const originalDispatcher = new HttpExternalActionDispatcher(
      endpoint,
      receiptStore,
      "demo-console",
      createReceiverFetch(originalConsumerId, () => {
        originalPosts += 1;
      }),
    );
    const first = await createFixture(
      root,
      (point) => {
        if (point === "after-effect-dispatch") {
          throw new Error("simulated crash after receiver acceptance");
        }
      },
      undefined,
      originalDispatcher,
    );
    const agent = await first.service.createAgent({
      name: "HTTP Consumer Rollover Agent",
    });
    const started = await first.service.sendMessage(
      agent.id,
      "promote before the receiver store is replaced",
    );
    await expect(waitForTerminal(first.service, started.run.id)).resolves.toMatchObject({
      status: "failed",
      transaction: {
        recovery: { journalPhase: "canonical-advanced" },
      },
    });
    expect(originalPosts).toBe(1);
    const originalReceiptStore = await readFile(receiptStore, "utf8");
    const canonicalBeforeRestart = await first.workspaces.readCanonical(agent.id);

    const replacementDispatcher = new HttpExternalActionDispatcher(
      endpoint,
      receiptStore,
      "demo-console",
      createReceiverFetch(replacementConsumerId, () => {
        replacementPosts += 1;
      }),
    );
    const restarted = await createFixture(
      root,
      undefined,
      undefined,
      replacementDispatcher,
      false,
    );
    await expect(restarted.service.initialize()).rejects.toThrow(
      /identity does not match the local receipt store/,
    );

    expect(replacementPosts).toBe(0);
    expect(replacementDispatcher.scope).toEqual(
      createExternalActionDispatcherScope(
        "idempotent-http",
        replacementConsumerId + "\0demo-console",
      ),
    );
    await expect(readFile(receiptStore, "utf8")).resolves.toBe(
      originalReceiptStore,
    );
    await expect(restarted.workspaces.readCanonical(agent.id)).resolves.toEqual(
      canonicalBeforeRestart,
    );
    expect(restarted.service.getRun(started.run.id)).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        disposition: "promoted",
        recovery: {
          recoveryError: expect.stringContaining(
            "identity does not match the local receipt store",
          ),
        },
      },
    });
    expect(restarted.service.getAgent(agent.id)).toMatchObject({
      status: "error",
    });
    await expect(
      readFile(
        path.join(
          root,
          "data",
          "promotion-journal",
          started.run.id + ".json",
        ),
        "utf8",
      ).then((source) => JSON.parse(source)),
    ).resolves.toMatchObject({
      transaction: {
        status: "recovery-error",
        recovery: {
          recoveryError: expect.stringContaining(
            "identity does not match the local receipt store",
          ),
        },
      },
    });
    await expect(
      restarted.service.sendMessage(agent.id, "must remain blocked"),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(restarted.service.startAgent(agent.id)).rejects.toThrow(
      /unresolved Candidate disposition evidence/,
    );
  });

  it.each([
    ["after-validated", "validated"],
    ["after-version-installed", "version-installed"],
  ] as const)(
    "blocks legacy %s recovery before workspace movement when the HTTP consumer changes",
    async (faultPoint, expectedPhase) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "airlock-phase-six-http-legacy-rollover-"),
      );
      temporaryDirectories.push(root);
      const endpoint = "http://127.0.0.1:3202/v1/effects/demo-console";
      const receiptStore = path.join(root, "data", "http-receipts.json");
      const originalConsumerId = "00000000-0000-4000-8000-000000000001";
      const replacementConsumerId = "00000000-0000-4000-8000-000000000002";
      let posts = 0;
      const first = await createFixture(
        root,
        (point) => {
          if (point === faultPoint) {
            throw new Error("simulated pre-effect restart");
          }
        },
        undefined,
        new HttpExternalActionDispatcher(
          endpoint,
          receiptStore,
          "demo-console",
          createReceiverFetch(originalConsumerId, () => {
            posts += 1;
          }),
        ),
      );
      const agent = await first.service.createAgent({
        name: "Legacy HTTP Consumer Rollover Agent",
      });
      const started = await first.service.sendMessage(
        agent.id,
        "recover no movement across a legacy consumer rollover",
      );
      await expect(waitForTerminal(first.service, started.run.id)).resolves.toMatchObject({
        status: "failed",
        transaction: {
          recovery: { journalPhase: expectedPhase },
        },
      });
      expect(posts).toBe(0);
      await downgradePromotionJournalToLegacy(root, started.run.id);
      const canonicalBeforeRestart = await first.workspaces.readCanonical(agent.id);
      const originalReceiptStore = await readFile(receiptStore, "utf8");

      const restarted = await createFixture(
        root,
        undefined,
        undefined,
        new HttpExternalActionDispatcher(
          endpoint,
          receiptStore,
          "demo-console",
          createReceiverFetch(replacementConsumerId, () => {
            posts += 1;
          }),
        ),
        false,
      );
      const installPromotion = vi.spyOn(
        restarted.workspaces,
        "installPromotion",
      );
      const advancePromotion = vi.spyOn(
        restarted.workspaces,
        "advancePromotion",
      );

      await expect(restarted.service.initialize()).rejects.toThrow(
        /identity does not match the local receipt store/,
      );

      expect(installPromotion).not.toHaveBeenCalled();
      expect(advancePromotion).not.toHaveBeenCalled();
      expect(posts).toBe(0);
      await expect(readFile(receiptStore, "utf8")).resolves.toBe(
        originalReceiptStore,
      );
      await expect(restarted.workspaces.readCanonical(agent.id)).resolves.toEqual(
        canonicalBeforeRestart,
      );
      expect(restarted.service.getRun(started.run.id)).toMatchObject({
        status: "failed",
        transaction: {
          status: "recovery-error",
          recovery: {
            journalPhase: expectedPhase,
            recoveryError: expect.stringContaining(
              "identity does not match the local receipt store",
            ),
          },
        },
      });
      await expect(
        readFile(
          path.join(
            root,
            "data",
            "promotion-journal",
            started.run.id + ".json",
          ),
          "utf8",
        ).then((source) => JSON.parse(source)),
      ).resolves.toMatchObject({
        schemaVersion: 2,
        phase: expectedPhase,
        transaction: {
          status: "recovery-error",
        },
      });
    },
  );

  it("fails recovery closed before delivery when the journal consumer scope is tampered", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-tampered-scope-"),
    );
    temporaryDirectories.push(root);
    const consumerId = "00000000-0000-4000-8000-000000000001";
    const originalDispatcher = new RecordingExternalActionDispatcher(
      "idempotent-http",
      consumerId,
    );
    const first = await createFixture(
      root,
      (point) => {
        if (point === "after-version-installed") {
          throw new Error("simulated crash before effect delivery");
        }
      },
      undefined,
      originalDispatcher,
    );
    const agent = await first.service.createAgent({
      name: "Tampered Consumer Scope Agent",
    });
    const started = await first.service.sendMessage(
      agent.id,
      "promote while the dispatcher scope is tampered",
    );
    await waitForTerminal(first.service, started.run.id);
    expect(originalDispatcher.calls).toBe(0);
    const journalPath = path.join(
      root,
      "data",
      "promotion-journal",
      started.run.id + ".json",
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      externalActionScope: { consumerScopeDigest: string };
    };
    journal.externalActionScope.consumerScopeDigest =
      "sha256:" + "0".repeat(64);
    await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n", "utf8");
    const recoveryDispatcher = new RecordingExternalActionDispatcher(
      "idempotent-http",
      consumerId,
    );

    const restarted = await createFixture(
      root,
      undefined,
      undefined,
      recoveryDispatcher,
    );

    expect(recoveryDispatcher.calls).toBe(0);
    expect(restarted.service.getRun(started.run.id)).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        recovery: {
          recoveryError: expect.stringContaining(
            "external-action consumer scope",
          ),
        },
      },
    });
  });

  it("fails recovery closed when the mock consumer store is replaced at the same path", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-mock-store-rollover-"),
    );
    temporaryDirectories.push(root);
    const first = await createFixture(root, (point) => {
      if (point === "after-effect-dispatch") {
        throw new Error("simulated crash after mock consumer acceptance");
      }
    });
    const agent = await first.service.createAgent({
      name: "Mock Consumer Rollover Agent",
    });
    const started = await first.service.sendMessage(
      agent.id,
      "promote before the mock consumer store is replaced",
    );
    await waitForTerminal(first.service, started.run.id);
    const storePath = path.join(root, "data", "mock-deliveries.json");
    const originalStore = JSON.parse(await readFile(storePath, "utf8")) as {
      consumerId: string;
      deliveries: unknown[];
    };
    expect(originalStore.deliveries).toHaveLength(1);
    await rm(storePath);

    const restarted = await createFixture(root);
    const replacementStore = JSON.parse(
      await readFile(storePath, "utf8"),
    ) as { consumerId: string; deliveries: unknown[] };

    expect(replacementStore.consumerId).not.toBe(originalStore.consumerId);
    expect(replacementStore.deliveries).toEqual([]);
    expect(restarted.service.getRun(started.run.id)).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        recovery: {
          recoveryError: expect.stringContaining(
            "external-action consumer scope",
          ),
        },
      },
    });
  });

  it("adopts dispatcher scope for a legacy journal before effect delivery", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-legacy-safe-scope-"),
    );
    temporaryDirectories.push(root);
    const first = await createFixture(root, (point) => {
      if (point === "after-version-installed") {
        throw new Error("simulated crash before effect delivery");
      }
    });
    const agent = await first.service.createAgent({
      name: "Legacy Safe Scope Agent",
    });
    const started = await first.service.sendMessage(
      agent.id,
      "promote from an unambiguous legacy journal",
    );
    await waitForTerminal(first.service, started.run.id);
    await downgradePromotionJournalToLegacy(root, started.run.id);

    const restarted = await createFixture(root);

    expect(restarted.service.getRun(started.run.id)).toMatchObject({
      status: "completed",
      transaction: {
        status: "promoted",
        recovery: {
          journalPhase: "completed",
          recoveredAfterRestart: true,
          recoveryError: null,
        },
      },
    });
    await expect(restarted.service.listExternalEffects()).resolves.toHaveLength(1);
    await expect(
      readFile(
        path.join(root, "data", "promotion-journal", started.run.id + ".json"),
        "utf8",
      ).then((source) => JSON.parse(source)),
    ).resolves.toMatchObject({ schemaVersion: 3 });
  });

  it("fails a legacy post-effect journal closed without replaying delivery", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-legacy-ambiguous-scope-"),
    );
    temporaryDirectories.push(root);
    const first = await createFixture(root, (point) => {
      if (point === "after-effect-dispatch") {
        throw new Error("simulated crash after effect delivery");
      }
    });
    const agent = await first.service.createAgent({
      name: "Legacy Ambiguous Scope Agent",
    });
    const started = await first.service.sendMessage(
      agent.id,
      "promote from an ambiguous legacy journal",
    );
    await waitForTerminal(first.service, started.run.id);
    await downgradePromotionJournalToLegacy(root, started.run.id);

    const restarted = await createFixture(root);

    expect(restarted.service.getRun(started.run.id)).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        recovery: {
          recoveryError: expect.stringContaining(
            "Legacy Promotion journal has no external-action consumer scope",
          ),
        },
      },
    });
    await expect(restarted.service.listExternalEffects()).resolves.toHaveLength(1);
  });

  it("fails closed when the Promotion journal becomes unreadable after Canonical advances", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-corrupt-journal-"),
    );
    temporaryDirectories.push(root);
    let injected = false;
    const first = await createFixture(root, async (point, runId) => {
      if (!injected && point === "after-canonical-advance") {
        injected = true;
        await writeFile(
          path.join(
            root,
            "data",
            "promotion-journal",
            runId + ".json",
          ),
          "{not-json}\n",
          "utf8",
        );
      }
    });
    const agent = await first.service.createAgent({
      name: "Unreadable Journal Agent",
    });
    const source = await first.workspaces.readCanonical(agent.id);

    const started = await first.service.sendMessage(
      agent.id,
      "promote while the durable journal becomes unreadable",
    );
    const failed = await waitForTerminal(first.service, started.run.id);
    const canonical = await first.workspaces.readCanonical(agent.id);

    expect(injected).toBe(true);
    expect(canonical.stateId).not.toBe(source.stateId);
    await expect(
      readFile(path.join(canonical.workspacePath, "durable.txt"), "utf8"),
    ).resolves.toBe("one accepted future\n");
    expect(failed).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        disposition: "promoted",
        canonicalStateIdAfter: canonical.stateId,
        canonicalContentHashAfter: canonical.contentHash,
        promotionReceipt: null,
        recovery: {
          journalPhase: "version-installed",
          recoveryError: expect.stringContaining(
            "Promotion journal is unreadable",
          ),
        },
      },
    });
    await expect(first.service.startAgent(agent.id)).rejects.toThrow(
      /unresolved Candidate disposition evidence/,
    );

    const restarted = await createFixture(root);
    expect(restarted.service.getRun(started.run.id)).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        disposition: "promoted",
        canonicalStateIdAfter: canonical.stateId,
        canonicalContentHashAfter: canonical.contentHash,
        promotionReceipt: null,
      },
    });
    await expect(restarted.service.startAgent(agent.id)).rejects.toThrow(
      /unresolved Candidate disposition evidence/,
    );
  });

  it("fails closed when the Promotion journal disappears after Canonical advances", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-missing-journal-"),
    );
    temporaryDirectories.push(root);
    let injected = false;
    const first = await createFixture(root, async (point, runId) => {
      if (!injected && point === "after-canonical-advance") {
        injected = true;
        await rm(
          path.join(
            root,
            "data",
            "promotion-journal",
            runId + ".json",
          ),
        );
      }
    });
    const agent = await first.service.createAgent({
      name: "Missing Journal Agent",
    });
    const source = await first.workspaces.readCanonical(agent.id);

    const started = await first.service.sendMessage(
      agent.id,
      "promote while the durable journal disappears",
    );
    const failed = await waitForTerminal(first.service, started.run.id);
    const canonical = await first.workspaces.readCanonical(agent.id);

    expect(injected).toBe(true);
    expect(canonical.stateId).not.toBe(source.stateId);
    await expect(
      readFile(path.join(canonical.workspacePath, "durable.txt"), "utf8"),
    ).resolves.toBe("one accepted future\n");
    expect(failed).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        disposition: "promoted",
        canonicalStateIdAfter: canonical.stateId,
        canonicalContentHashAfter: canonical.contentHash,
        promotionReceipt: null,
        recovery: {
          journalPhase: "version-installed",
          recoveryError: expect.stringContaining(
            "Promotion journal is missing",
          ),
        },
      },
    });
    await expect(first.service.startAgent(agent.id)).rejects.toThrow(
      /unresolved Candidate disposition evidence/,
    );

    const restarted = await createFixture(root);
    expect(restarted.service.getRun(started.run.id)).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        disposition: "promoted",
        canonicalStateIdAfter: canonical.stateId,
        canonicalContentHashAfter: canonical.contentHash,
        promotionReceipt: null,
      },
    });
    await expect(restarted.service.startAgent(agent.id)).rejects.toThrow(
      /unresolved Candidate disposition evidence/,
    );
  });

  it("fails closed when an existing Promotion journal disappears before Canonical advances", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-missing-installed-journal-"),
    );
    temporaryDirectories.push(root);
    let injected = false;
    const first = await createFixture(root, async (point, runId) => {
      if (!injected && point === "after-version-installed") {
        injected = true;
        await rm(
          path.join(
            root,
            "data",
            "promotion-journal",
            runId + ".json",
          ),
        );
        throw new Error("Promotion journal disappeared after installation");
      }
    });
    const agent = await first.service.createAgent({
      name: "Missing Installed Journal Agent",
    });
    const canonicalBefore = await first.workspaces.readCanonical(agent.id);

    const started = await first.service.sendMessage(
      agent.id,
      "install while the durable journal disappears",
    );
    const failed = await waitForTerminal(first.service, started.run.id);
    const canonicalAfter = await first.workspaces.readCanonical(agent.id);

    expect(injected).toBe(true);
    expect(canonicalAfter).toEqual(canonicalBefore);
    expect(failed).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        disposition: null,
        canonicalStateIdAfter: null,
        canonicalContentHashAfter: null,
        promotionReceipt: null,
        quarantinePath: null,
        quarantineAvailable: false,
        recovery: {
          journalPhase: "version-installed",
          recoveryError: expect.stringContaining(
            "Promotion journal is missing",
          ),
        },
      },
    });
    await expect(first.service.listExternalEffects()).resolves.toEqual([]);
    await expect(first.service.startAgent(agent.id)).rejects.toThrow(
      /unresolved Candidate disposition evidence/,
    );
  });

  it("fails closed across restart when Canonical advanced but its Promotion journal is missing", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-missing-restart-journal-"),
    );
    temporaryDirectories.push(root);
    const first = await createFixture(root);
    const agent = await first.service.createAgent({
      name: "Missing Restart Journal Agent",
    });
    const canonicalBefore = await first.workspaces.readCanonical(agent.id);
    const runId = "missing-restart-journal-run";
    const candidate = await first.workspaces.prepareCandidate(agent.id, runId);
    const transaction = createRunTransaction(
      runId,
      canonicalBefore,
      agent.outcomeContract,
    );
    transaction.candidateStateId = candidate.candidateStateId;
    transaction.status = "promoting";
    transaction.recovery.journalPhase = "version-installed";
    const plan = await first.workspaces.planPromotion(agent.id, runId);
    const installed = await first.workspaces.installPromotion(plan);
    const canonicalAfter = await first.workspaces.advancePromotion(
      plan,
      installed,
    );
    await first.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (storedAgent) storedAgent.status = "busy";
      database.runs.push({
        id: runId,
        agentId: agent.id,
        candidateSetId: null,
        competitorId: null,
        status: "running",
        prompt: "interrupted approved Promotion",
        output: null,
        error: null,
        usage: null,
        transaction,
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
      });
    });

    expect(canonicalAfter.stateId).toBe(candidate.candidateStateId);
    const restarted = await createFixture(root);
    const failed = restarted.service.getRun(runId);

    expect(await restarted.workspaces.readCanonical(agent.id)).toEqual(
      canonicalAfter,
    );
    expect(failed).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        disposition: "promoted",
        canonicalStateIdAfter: canonicalAfter.stateId,
        canonicalContentHashAfter: canonicalAfter.contentHash,
        promotionReceipt: null,
        quarantinePath: null,
        quarantineAvailable: false,
        recovery: {
          journalPhase: "version-installed",
          recoveredAfterRestart: true,
          recoveryError: expect.stringContaining(
            "Promotion journal is missing",
          ),
        },
      },
    });
    await expect(restarted.service.listExternalEffects()).resolves.toEqual([]);
    await expect(restarted.service.startAgent(agent.id)).rejects.toThrow(
      /unresolved Candidate disposition evidence/,
    );
  });

  it("fails closed across restart when Canonical advanced but its Promotion journal is corrupt", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-corrupt-restart-journal-"),
    );
    temporaryDirectories.push(root);
    const first = await createFixture(root);
    const agent = await first.service.createAgent({
      name: "Corrupt Restart Journal Agent",
    });
    const canonicalBefore = await first.workspaces.readCanonical(agent.id);
    const runId = "corrupt-restart-journal-run";
    const candidate = await first.workspaces.prepareCandidate(agent.id, runId);
    const transaction = createRunTransaction(
      runId,
      canonicalBefore,
      agent.outcomeContract,
    );
    transaction.candidateStateId = candidate.candidateStateId;
    transaction.status = "promoting";
    transaction.recovery.journalPhase = "version-installed";
    const plan = await first.workspaces.planPromotion(agent.id, runId);
    const installed = await first.workspaces.installPromotion(plan);
    const canonicalAfter = await first.workspaces.advancePromotion(
      plan,
      installed,
    );
    await writeFile(
      path.join(
        root,
        "data",
        "promotion-journal",
        runId + ".json",
      ),
      "{not-json}\n",
      "utf8",
    );
    await first.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (storedAgent) storedAgent.status = "busy";
      database.runs.push({
        id: runId,
        agentId: agent.id,
        candidateSetId: null,
        competitorId: null,
        status: "running",
        prompt: "interrupted approved Promotion with corrupt journal",
        output: null,
        error: null,
        usage: null,
        transaction,
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
      });
    });

    expect(canonicalAfter.stateId).toBe(candidate.candidateStateId);
    const restarted = await createFixture(root);
    const failed = restarted.service.getRun(runId);

    expect(await restarted.workspaces.readCanonical(agent.id)).toEqual(
      canonicalAfter,
    );
    expect(failed).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        disposition: "promoted",
        canonicalStateIdAfter: canonicalAfter.stateId,
        canonicalContentHashAfter: canonicalAfter.contentHash,
        promotionReceipt: null,
        quarantinePath: null,
        quarantineAvailable: false,
        recovery: {
          journalPhase: "version-installed",
          recoveredAfterRestart: true,
          recoveryError: expect.stringContaining(
            "Promotion journal is corrupt",
          ),
        },
      },
    });
    await expect(restarted.service.listExternalEffects()).resolves.toEqual([]);
    await expect(restarted.service.startAgent(agent.id)).rejects.toThrow(
      /unresolved Candidate disposition evidence/,
    );
  });

  it("recovers physical Canonical evidence when advancement commits before returning", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "airlock-phase-six-post-rename-failure-"),
    );
    temporaryDirectories.push(root);
    const first = await createFixture(root);
    const originalAdvance = first.workspaces.advancePromotion.bind(
      first.workspaces,
    );
    first.workspaces.advancePromotion = async (plan, installed) => {
      await originalAdvance(plan, installed);
      await rm(
        path.join(
          root,
          "data",
          "promotion-journal",
          plan.runId + ".json",
        ),
      );
      throw new Error("Canonical advancement acknowledgement was lost");
    };
    const agent = await first.service.createAgent({
      name: "Post Rename Failure Agent",
    });
    const canonicalBefore = await first.workspaces.readCanonical(agent.id);

    const started = await first.service.sendMessage(
      agent.id,
      "promote before the canonical acknowledgement is lost",
    );
    const failed = await waitForTerminal(first.service, started.run.id);
    const canonicalAfter = await first.workspaces.readCanonical(agent.id);

    expect(canonicalAfter.stateId).not.toBe(canonicalBefore.stateId);
    expect(failed).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        disposition: "promoted",
        canonicalStateIdAfter: canonicalAfter.stateId,
        canonicalContentHashAfter: canonicalAfter.contentHash,
        promotionReceipt: null,
        recovery: {
          journalPhase: "version-installed",
          recoveryError: expect.stringContaining(
            "Promotion journal is missing",
          ),
        },
      },
    });
    await expect(first.service.listExternalEffects()).resolves.toEqual([]);
  });

  it("retains a valid pre-decision Candidate in Quarantine after restart", async () => {
    const first = await createFixture();
    const agent = await first.service.createAgent({ name: "Interrupted Agent" });
    const canonical = await first.workspaces.readCanonical(agent.id);
    const runId = "interrupted-run";
    const candidate = await first.workspaces.prepareCandidate(agent.id, runId);
    await writeFile(
      path.join(candidate.workspacePath, "partial.txt"),
      "valuable partial work\n",
      "utf8",
    );
    const transaction = createRunTransaction(
      runId,
      canonical,
      agent.outcomeContract,
    );
    transaction.candidateStateId = candidate.candidateStateId;
    transaction.status = "executing";
    await first.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (storedAgent) storedAgent.status = "busy";
      database.runs.push({
        id: runId,
        agentId: agent.id,
        candidateSetId: null,
        competitorId: null,
        status: "running",
        prompt: "interrupted work",
        output: null,
        error: null,
        usage: null,
        transaction,
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
      });
    });

    const restarted = await createFixture(first.root);
    const retained = restarted.service.getRun(runId);
    const after = await restarted.workspaces.readCanonical(agent.id);

    expect(retained).toMatchObject({
      status: "failed",
      transaction: {
        disposition: "quarantined",
        quarantineAvailable: true,
      },
    });
    expect(after).toEqual(canonical);
    await expect(
      readFile(
        path.join(
          retained.transaction?.quarantinePath ?? "",
          "workspace",
          "partial.txt",
        ),
        "utf8",
      ),
    ).resolves.toBe("valuable partial work\n");
  });

  it("fails closed when installed state contradicts its durable journal", async () => {
    const first = await createFixture(undefined, (point) => {
      if (point === "after-version-installed") {
        throw new Error("stop before canonical advance");
      }
    });
    const agent = await first.service.createAgent({ name: "Contradiction Agent" });
    const source = await first.workspaces.readCanonical(agent.id);
    const started = await first.service.sendMessage(agent.id, "prepare durable state");
    await waitForTerminal(first.service, started.run.id);
    const journal = JSON.parse(
      await readFile(
        path.join(
          first.config.dataDirectory,
          "promotion-journal",
          started.run.id + ".json",
        ),
        "utf8",
      ),
    ) as { plan: { targetStateId: string } };
    await writeFile(
      path.join(
        first.config.workspaceRoot,
        agent.id,
        "versions",
        journal.plan.targetStateId,
        "workspace",
        "tampered.txt",
      ),
      "contradiction\n",
      "utf8",
    );

    const restarted = await createFixture(first.root);
    const failed = restarted.service.getRun(started.run.id);

    expect(failed).toMatchObject({
      status: "failed",
      transaction: {
        status: "recovery-error",
        recovery: {
          journalPhase: "version-installed",
          recoveredAfterRestart: false,
          recoveryError: expect.stringContaining("contradicts"),
        },
      },
    });
    expect(restarted.service.getAgent(agent.id)).toMatchObject({ status: "error" });
    expect(await restarted.workspaces.readCanonical(agent.id)).toEqual(source);
    expect(await restarted.service.listExternalEffects()).toEqual([]);
  });

  it("expires only unprotected Quarantine state and retains its evidence", async () => {
    const first = await createFixture();
    const agent = await first.service.createAgent({ name: "Retention Agent" });
    const canonical = await first.workspaces.readCanonical(agent.id);
    const rejected = await first.service.sendMessage(agent.id, "make an unsafe future");
    await waitForTerminal(first.service, rejected.run.id);
    const before = first.service.getRun(rejected.run.id);
    const quarantinePath = before.transaction?.quarantinePath ?? "";
    const manifestPath = path.join(quarantinePath, "candidate.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    manifest.createdAt = "2000-01-01T00:00:00.000Z";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    const sentinel = path.join(first.root, "unrelated-sentinel.txt");
    await writeFile(sentinel, "must survive\n", "utf8");
    const evidenceHash = before.transaction?.promotionReceipt?.validationEvidenceHash;

    const restarted = await createFixture(first.root, undefined, 0.000001);
    const expired = restarted.service.getRun(rejected.run.id);

    expect(expired.transaction).toMatchObject({
      disposition: "discarded",
      quarantineAvailable: false,
      promotionReceipt: { validationEvidenceHash: evidenceHash },
    });
    await expect(access(quarantinePath)).rejects.toThrow();
    await expect(readFile(sentinel, "utf8")).resolves.toBe("must survive\n");
    expect(await restarted.workspaces.readCanonical(agent.id)).toEqual(canonical);
  });

  it("rejects unsafe identifiers and never traverses a cleanup symlink", async () => {
    const fixture = await createFixture();
    const external = await mkdtemp(path.join(tmpdir(), "airlock-external-"));
    temporaryDirectories.push(external);
    const sentinel = path.join(external, "sentinel.txt");
    await writeFile(sentinel, "outside state\n", "utf8");
    await symlink(
      external,
      path.join(fixture.config.workspaceRoot, ".quarantine", "symlink-run"),
    );

    await expect(
      fixture.workspaces.discardQuarantine("../outside"),
    ).rejects.toThrow(/identifier is not safe/);
    const cleanup = await fixture.workspaces.cleanupExpiredState({
      candidateOlderThan: "2100-01-01T00:00:00.000Z",
      quarantineOlderThan: "2100-01-01T00:00:00.000Z",
      protectedRunIds: new Set(),
    });

    expect(cleanup.errors).toEqual([
      expect.stringContaining("symlink-run"),
    ]);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("outside state\n");
  });
});
