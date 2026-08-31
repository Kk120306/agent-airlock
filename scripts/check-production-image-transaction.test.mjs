import assert from "node:assert/strict";
import test from "node:test";

import { realRuntimeProofContract } from "./runtime-demo-profile.mjs";
import {
  ProductionImageTransactionError,
  assertProductionImageTransaction,
  installOriginExactNetworkGuard,
  openCompleteTransactionEvidence,
} from "./check-production-image-transaction.mjs";

const agentId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const beforeStateId = "33333333-3333-4333-8333-333333333333";
const afterStateId = "44444444-4444-4444-8444-444444444444";
const hash = (character) => `sha256:${character.repeat(64)}`;

function evidenceDisclosureFixture({ count = 1, opens = true } = {}) {
  let open = false;
  const summary = {
    async click() {
      if (opens) open = true;
    },
    async waitFor() {},
  };
  const details = {
    async count() {
      return count;
    },
    async evaluate() {
      return open;
    },
    locator(selector) {
      assert.equal(selector, "summary");
      return {
        getByText(text, options) {
          assert.equal(text, "Inspect complete transaction evidence");
          assert.deepEqual(options, { exact: true });
          return summary;
        },
      };
    },
  };
  return {
    locator(selector) {
      assert.equal(selector, "details.judge-evidence-details");
      return details;
    },
  };
}

test("transaction browser opens the exact complete evidence disclosure", async () => {
  await openCompleteTransactionEvidence(evidenceDisclosureFixture());
});

test("transaction browser rejects missing or non-openable evidence disclosures", async () => {
  await assert.rejects(
    openCompleteTransactionEvidence(evidenceDisclosureFixture({ count: 0 })),
    ProductionImageTransactionError,
  );
  await assert.rejects(
    openCompleteTransactionEvidence(
      evidenceDisclosureFixture({ opens: false }),
    ),
    ProductionImageTransactionError,
  );
});

function fixture() {
  const completedAt = "2026-08-31T00:00:04.000Z";
  const transaction = {
    id: runId,
    status: "promoted",
    disposition: "promoted",
    candidateStateId: afterStateId,
    canonicalStateIdBefore: beforeStateId,
    canonicalStateIdAfter: afterStateId,
    canonicalContentHashBefore: hash("a"),
    canonicalContentHashAfter: hash("b"),
    outcomeContractVersion: 2,
    outcomeContract: {
      schemaVersion: 1,
      version: 2,
      createdAt: "2026-08-31T00:00:00.000Z",
      ...structuredClone(realRuntimeProofContract),
    },
    resources: ["workspace", "codex-session", "sqlite", "external-actions"].map(
      (kind) => ({ kind, disposition: "promoted" }),
    ),
    validations: [
      "path-safety",
      "protected-paths",
      "required-paths",
      "change-limits",
      "secret-patterns",
      "protocol-fixture-content",
      "sqlite-resource",
      "external-action-intents",
    ].map((name) => ({ name, required: true, status: "passed" })),
    changes: {
      truncated: false,
      files: [{ path: "protocol-proof.txt" }, { path: ".airlock/demo.sqlite" }],
    },
    sqlite: {
      databasePath: ".airlock/demo.sqlite",
      integrity: "passed",
      before: {
        contentHash: hash("6"),
        rowCount: 1,
        rows: [
          {
            id: "demo",
            value: "ready",
            updatedAt: "1970-01-01T00:00:00.000Z",
          },
        ],
      },
      candidate: {
        contentHash: hash("7"),
        rowCount: 1,
        rows: [
          {
            id: "demo",
            value: "candidate-only",
            updatedAt: "2026-08-28T00:00:00.000Z",
          },
        ],
      },
      after: {
        contentHash: hash("7"),
        rowCount: 1,
        rows: [
          {
            id: "demo",
            value: "candidate-only",
            updatedAt: "2026-08-28T00:00:00.000Z",
          },
        ],
      },
    },
    externalActions: {
      deliveredCount: 1,
      intents: [
        {
          id: "protocol-release-ready",
          type: "demo.notification.requested",
          destination: "demo-console",
          subject: "Protocol release ready",
          status: "delivered",
          idempotencyKey: hash("d"),
          deliveredAt: "2026-08-31T00:00:03.000Z",
        },
      ],
    },
    events: [
      {
        status: "promoting",
        summary: "All required Validations passed",
        at: "2026-08-31T00:00:01.000Z",
      },
      {
        status: "promoting",
        summary: "Canonical State advanced before external action delivery",
        at: "2026-08-31T00:00:02.000Z",
      },
      {
        status: "promoted",
        summary: "Candidate State is now Canonical State",
        at: completedAt,
      },
    ],
    recovery: { journalPhase: "completed" },
    lineage: { rootRunId: runId, parentRunId: null, depth: 0 },
    promotionReceipt: {
      runTransactionId: runId,
      disposition: "promoted",
      outcomeContractVersion: 2,
      canonicalStateIdBefore: beforeStateId,
      canonicalStateIdAfter: afterStateId,
      canonicalContentHashBefore: hash("a"),
      canonicalContentHashAfter: hash("b"),
      validationEvidenceHash: hash("c"),
      lineage: { rootRunId: runId, parentRunId: null, depth: 0 },
      createdAt: completedAt,
    },
  };
  transaction.validations.push({
    name: "execution-profile",
    required: true,
    status: "passed",
    summary:
      "Airlock control plane attested successful execution through real Codex CLI against the local Responses protocol fixture. Model identity is committed without disclosure.",
    output: JSON.stringify({
      schemaVersion: 2,
      attestation: "airlock-control-plane",
      inferenceMode: "local-responses-protocol-fixture",
      executor: "codex-cli",
      runtimeProvider: "local-process",
      providerProtocol: "responses",
      modelCommitment: hash("e"),
      preflight: null,
    }),
  });
  return {
    agent: {
      id: agentId,
      name: "Production Image Container Proof",
      status: "ready",
      canonicalStateId: afterStateId,
    },
    run: {
      id: runId,
      agentId,
      status: "completed",
      output: "Protocol fixture completed the requested Candidate edit.",
      error: null,
      completedAt,
      transaction,
    },
    effects: [
      {
        runId,
        intentId: "protocol-release-ready",
        type: "demo.notification.requested",
        destination: "demo-console",
        subject: "Protocol release ready",
        payloadHash: hash("f"),
        idempotencyKey: hash("d"),
        deliveredAt: "2026-08-31T00:00:03.000Z",
        deliveryMode: "atomic-local-store",
      },
    ],
  };
}

test("production image transaction verifier accepts complete persisted evidence", () => {
  const result = assertProductionImageTransaction(fixture());
  assert.deepEqual(result, {
    schema: "agent-airlock-production-image-transaction-proof/v1",
    agentId,
    runId,
    transactionId: runId,
    completedAt: "2026-08-31T00:00:04.000Z",
    canonicalStateIdAfter: afterStateId,
    canonicalContentHashAfter: hash("b"),
    outcomeContractVersion: 2,
    validationEvidenceHash: hash("c"),
    effectIdempotencyKey: hash("d"),
    effectIntentId: "protocol-release-ready",
    effectType: "demo.notification.requested",
    effectDestination: "demo-console",
    effectSubject: "Protocol release ready",
    effectPayloadHash: hash("f"),
    effectDeliveredAt: "2026-08-31T00:00:03.000Z",
  });
});

function browserBoundaryFixture() {
  const contextListeners = new Map();
  const pageListeners = new Map();
  const context = {
    on(name, listener) {
      const listeners = contextListeners.get(name) ?? [];
      listeners.push(listener);
      contextListeners.set(name, listeners);
    },
    async route() {},
    async routeWebSocket() {},
  };
  const page = {
    on(name, listener) {
      const listeners = pageListeners.get(name) ?? [];
      listeners.push(listener);
      pageListeners.set(name, listeners);
    },
  };
  const emit = (listeners, name, value) => {
    for (const listener of listeners.get(name) ?? []) listener(value);
  };
  const request = ({
    authorization,
    method = "GET",
    url = "http://127.0.0.1:3000/api/agents",
  } = {}) => ({
    headers: () => (authorization === undefined ? {} : { authorization }),
    method: () => method,
    url: () => url,
  });
  const response = ({ authorization, method, status = 401, url } = {}) => {
    const responseRequest = request({ authorization, method, url });
    return {
      request: () => responseRequest,
      status: () => status,
      url: responseRequest.url,
    };
  };
  return {
    context,
    emitContext: (name, value) => emit(contextListeners, name, value),
    emitPage: (name, value) => emit(pageListeners, name, value),
    page,
    request,
    response,
  };
}

test("transaction browser boundary accepts one exact unauthenticated API rejection", async () => {
  const fixture = browserBoundaryFixture();
  const guard = await installOriginExactNetworkGuard(
    fixture.context,
    "http://127.0.0.1:3000",
  );
  guard.attachPage(fixture.page);
  fixture.emitContext("response", fixture.response());
  assert.doesNotThrow(() => guard.assert());
});

test("transaction browser boundary rejects page and network failures", async (context) => {
  for (const [name, mutate] of [
    ["missing authentication rejection", () => {}],
    [
      "duplicate authentication rejection",
      (fixture) => fixture.emitContext("response", fixture.response()),
    ],
    [
      "page error",
      (fixture) => fixture.emitPage("pageerror", new Error("render failed")),
    ],
    [
      "same-origin request failure",
      (fixture) =>
        fixture.emitContext(
          "requestfailed",
          fixture.request({
            url: "http://127.0.0.1:3000/assets/index.js",
          }),
        ),
    ],
    [
      "same-origin redirect response",
      (fixture) =>
        fixture.emitContext(
          "response",
          fixture.response({
            authorization: "Bearer test",
            status: 302,
          }),
        ),
    ],
    [
      "same-origin server response",
      (fixture) =>
        fixture.emitContext(
          "response",
          fixture.response({
            authorization: "Bearer test",
            status: 500,
          }),
        ),
    ],
    [
      "cross-origin response",
      (fixture) =>
        fixture.emitContext(
          "response",
          fixture.response({
            status: 200,
            url: "https://example.com/tracker",
          }),
        ),
    ],
  ]) {
    await context.test(name, async () => {
      const fixture = browserBoundaryFixture();
      const guard = await installOriginExactNetworkGuard(
        fixture.context,
        "http://127.0.0.1:3000",
      );
      guard.attachPage(fixture.page);
      if (name !== "missing authentication rejection") {
        fixture.emitContext("response", fixture.response());
      }
      mutate(fixture);
      assert.throws(() => guard.assert(), ProductionImageTransactionError);
    });
  }
});

test("production image transaction verifier rejects evidence mutations", async (context) => {
  const mutations = [
    ["nonterminal Run", (value) => (value.run.status = "running")],
    ["failed Run", (value) => (value.run.error = "Codex failed")],
    [
      "unchanged Canonical State",
      (value) => (value.run.transaction.canonicalStateIdAfter = beforeStateId),
    ],
    [
      "missing Candidate State identity",
      (value) => (value.run.transaction.candidateStateId = null),
    ],
    [
      "Candidate State target mismatch",
      (value) =>
        (value.run.transaction.candidateStateId =
          "55555555-5555-4555-8555-555555555555"),
    ],
    ["missing resource", (value) => value.run.transaction.resources.pop()],
    [
      "failed validation",
      (value) => (value.run.transaction.validations[0].status = "failed"),
    ],
    [
      "missing required validation",
      (value) => value.run.transaction.validations.pop(),
    ],
    [
      "dishonest ModelArk execution profile",
      (value) => {
        const profile = value.run.transaction.validations.find(
          (validation) => validation.name === "execution-profile",
        );
        profile.summary = profile.summary.replace(
          "local Responses protocol fixture",
          "configured ModelArk Responses profile",
        );
        profile.output = profile.output.replace(
          "local-responses-protocol-fixture",
          "modelark",
        );
      },
    ],
    [
      "missing protocol file evidence",
      (value) => value.run.transaction.changes.files.shift(),
    ],
    [
      "missing SQLite evidence",
      (value) => (value.run.transaction.sqlite.after.rows = []),
    ],
    [
      "extra SQLite row",
      (value) =>
        value.run.transaction.sqlite.after.rows.push({
          id: "extra",
          value: "candidate-only",
          updatedAt: "2026-08-28T00:00:00.000Z",
        }),
    ],
    [
      "SQLite row timestamp drift",
      (value) =>
        (value.run.transaction.sqlite.after.rows[0].updatedAt =
          "2026-08-28T00:00:01.000Z"),
    ],
    [
      "undelivered effect",
      (value) =>
        (value.run.transaction.externalActions.intents[0].status = "deferred"),
    ],
    ["missing effect receipt", (value) => value.effects.pop()],
    [
      "effect payload receipt drift",
      (value) => (value.effects[0].payloadHash = "sha256:0"),
    ],
    [
      "missing Canonical advance event",
      (value) => value.run.transaction.events.splice(1, 1),
    ],
    [
      "late Canonical advance",
      (value) =>
        (value.run.transaction.events[1].at = "2026-08-31T00:00:03.500Z"),
    ],
    [
      "out-of-order Canonical advance event",
      (value) =>
        ([value.run.transaction.events[0], value.run.transaction.events[1]] = [
          value.run.transaction.events[1],
          value.run.transaction.events[0],
        ]),
    ],
    [
      "invented promotion-start summary",
      (value) =>
        (value.run.transaction.events[0].summary = "Promotion started"),
    ],
    [
      "invented promotion-completion summary",
      (value) =>
        (value.run.transaction.events[2].summary = "Promotion completed"),
    ],
    [
      "promotion after Run completion",
      (value) =>
        (value.run.transaction.events[2].at = "2026-08-31T00:00:05.000Z"),
    ],
    [
      "receipt before effect delivery",
      (value) =>
        (value.run.transaction.promotionReceipt.createdAt =
          "2026-08-31T00:00:02.500Z"),
    ],
    [
      "incomplete recovery journal",
      (value) => (value.run.transaction.recovery.journalPhase = "promoting"),
    ],
    [
      "receipt binding drift",
      (value) =>
        (value.run.transaction.promotionReceipt.canonicalStateIdAfter =
          "different-state"),
    ],
    [
      "receipt contract version drift",
      (value) =>
        (value.run.transaction.promotionReceipt.outcomeContractVersion = 1),
    ],
    [
      "receipt lineage drift",
      (value) =>
        (value.run.transaction.promotionReceipt.lineage.rootRunId = agentId),
    ],
  ];
  for (const [name, mutate] of mutations) {
    await context.test(name, () => {
      const value = fixture();
      mutate(value);
      assert.throws(
        () => assertProductionImageTransaction(value),
        /transaction evidence is incomplete/,
      );
    });
  }
});
