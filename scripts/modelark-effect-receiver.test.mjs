import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startModelArkEffectReceiver } from "./modelark-effect-receiver.mjs";

function commitment(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function deliveryRequest() {
  const runId = "run-live";
  const intent = {
    id: "modelark-live-ready",
    type: "demo.notification.requested",
    destination: "demo-console",
    subject: "ModelArk release ready",
    body: "The live Whole-Agent Candidate passed.",
  };
  const normalizedPayload = JSON.stringify({
    destination: intent.destination,
    subject: intent.subject,
    body: intent.body,
  });
  const payloadHash = commitment(normalizedPayload);
  const idempotencyKey = commitment(
    [runId, intent.id, intent.type, normalizedPayload].join("\0"),
  );
  return {
    idempotencyKey,
    body: {
      schema: "agent-airlock/external-action-delivery-request",
      schemaVersion: 1,
      runId,
      intent: { ...intent, payloadHash },
    },
  };
}

async function readIdentity(receiver) {
  const response = await fetch(receiver.identityUrl);
  assert.equal(response.status, 200);
  const identity = await response.json();
  assert.deepEqual(Object.keys(identity).sort(), [
    "consumerId",
    "deliveryMode",
    "schema",
    "schemaVersion",
  ]);
  assert.equal(
    identity.schema,
    "agent-airlock/external-action-consumer-identity",
  );
  assert.equal(identity.schemaVersion, 1);
  assert.equal(identity.deliveryMode, "idempotent-http");
  assert.match(
    identity.consumerId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  return identity;
}

async function postDelivery(url, request, consumerId) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": request.idempotencyKey,
      "x-agent-airlock-consumer-id": consumerId,
    },
    body: JSON.stringify(request.body),
  });
}

test("the ModelArk effect receiver performs one durable HTTP delivery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-http-effect-"));
  const filePath = path.join(root, "deliveries.json");
  const request = deliveryRequest();
  let receiver = await startModelArkEffectReceiver({
    host: "127.0.0.1",
    port: 0,
    filePath,
  });
  try {
    const identity = await readIdentity(receiver);
    const firstResponse = await postDelivery(
      receiver.url,
      request,
      identity.consumerId,
    );
    const secondResponse = await postDelivery(
      receiver.url,
      request,
      identity.consumerId,
    );
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    const first = await firstResponse.json();
    const second = await secondResponse.json();
    assert.deepEqual(second, first);
    assert.equal(first.receipt.idempotencyKey, request.idempotencyKey);
    assert.equal(first.receipt.destination, "demo-console");
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.consumerId, identity.consumerId);
    assert.equal(persisted.deliveries.length, 1);

    await receiver.close();
    receiver = await startModelArkEffectReceiver({
      host: "127.0.0.1",
      port: 0,
      filePath,
    });
    const restartedIdentity = await readIdentity(receiver);
    assert.deepEqual(restartedIdentity, identity);
    const replayResponse = await postDelivery(
      receiver.url,
      request,
      restartedIdentity.consumerId,
    );
    assert.equal(replayResponse.status, 200);
    assert.deepEqual(await replayResponse.json(), first);
  } finally {
    await receiver.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("the ModelArk effect receiver rejects a forged idempotency key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-http-effect-"));
  const receiver = await startModelArkEffectReceiver({
    host: "127.0.0.1",
    port: 0,
    filePath: path.join(root, "deliveries.json"),
  });
  try {
    const request = deliveryRequest();
    request.idempotencyKey = commitment("forged");
    const identity = await readIdentity(receiver);
    const response = await postDelivery(
      receiver.url,
      request,
      identity.consumerId,
    );
    assert.equal(response.status, 400);
  } finally {
    await receiver.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed receipt commit is not acknowledged from memory on retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-http-effect-"));
  const filePath = path.join(root, "deliveries.json");
  let commitAttempt = 0;
  const receiver = await startModelArkEffectReceiver({
    host: "127.0.0.1",
    port: 0,
    filePath,
    persistenceOperations: {
      beforeCommit() {
        commitAttempt += 1;
        if (commitAttempt === 2) {
          throw new Error("simulated receipt commit failure");
        }
      },
    },
  });
  try {
    const request = deliveryRequest();
    const identity = await readIdentity(receiver);
    const failed = await postDelivery(
      receiver.url,
      request,
      identity.consumerId,
    );
    assert.equal(failed.status, 503);
    assert.equal(
      JSON.parse(await readFile(filePath, "utf8")).deliveries.length,
      0,
    );

    const retried = await postDelivery(
      receiver.url,
      request,
      identity.consumerId,
    );
    assert.equal(retried.status, 200);
    const accepted = await retried.json();
    assert.equal(accepted.receipt.idempotencyKey, request.idempotencyKey);
    assert.equal(
      JSON.parse(await readFile(filePath, "utf8")).deliveries.length,
      1,
    );
  } finally {
    await receiver.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the ModelArk effect receiver identity is stable for the same store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-http-effect-"));
  const filePath = path.join(root, "deliveries.json");
  let receiver = await startModelArkEffectReceiver({
    host: "127.0.0.1",
    port: 0,
    filePath,
  });
  try {
    const beforeRestart = await readIdentity(receiver);
    await receiver.close();
    receiver = await startModelArkEffectReceiver({
      host: "127.0.0.1",
      port: 0,
      filePath,
    });
    const afterRestart = await readIdentity(receiver);
    assert.deepEqual(afterRestart, beforeRestart);
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.consumerId, beforeRestart.consumerId);
  } finally {
    await receiver.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a replaced ModelArk effect receiver store gets a new identity and rejects a stale handshake", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-http-effect-"));
  const filePath = path.join(root, "deliveries.json");
  const request = deliveryRequest();
  let receiver = await startModelArkEffectReceiver({
    host: "127.0.0.1",
    port: 0,
    filePath,
  });
  try {
    const originalIdentity = await readIdentity(receiver);
    await receiver.close();
    await unlink(filePath);
    receiver = await startModelArkEffectReceiver({
      host: "127.0.0.1",
      port: 0,
      filePath,
    });
    const replacementIdentity = await readIdentity(receiver);
    assert.notEqual(replacementIdentity.consumerId, originalIdentity.consumerId);

    const staleResponse = await postDelivery(
      receiver.url,
      request,
      originalIdentity.consumerId,
    );
    assert.equal(staleResponse.status, 409);
    assert.deepEqual(await staleResponse.json(), {
      error: "consumer identity conflict",
    });
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.consumerId, replacementIdentity.consumerId);
    assert.equal(persisted.deliveries.length, 0);
  } finally {
    await receiver.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy receiver store gains an identity without losing receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-http-effect-"));
  const filePath = path.join(root, "deliveries.json");
  const request = deliveryRequest();
  let receiver = await startModelArkEffectReceiver({
    host: "127.0.0.1",
    port: 0,
    filePath,
  });
  try {
    const originalIdentity = await readIdentity(receiver);
    const acceptedResponse = await postDelivery(
      receiver.url,
      request,
      originalIdentity.consumerId,
    );
    assert.equal(acceptedResponse.status, 200);
    const accepted = await acceptedResponse.json();
    await receiver.close();

    const currentDatabase = JSON.parse(await readFile(filePath, "utf8"));
    await writeFile(
      filePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          deliveries: currentDatabase.deliveries,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    receiver = await startModelArkEffectReceiver({
      host: "127.0.0.1",
      port: 0,
      filePath,
    });
    const migratedIdentity = await readIdentity(receiver);
    const replayResponse = await postDelivery(
      receiver.url,
      request,
      migratedIdentity.consumerId,
    );
    assert.equal(replayResponse.status, 200);
    assert.deepEqual(await replayResponse.json(), accepted);
    const migratedDatabase = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(migratedDatabase.schemaVersion, 2);
    assert.equal(migratedDatabase.consumerId, migratedIdentity.consumerId);
    assert.deepEqual(migratedDatabase.deliveries, currentDatabase.deliveries);
  } finally {
    await receiver.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("the ModelArk effect receiver rejects a symlinked store directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-http-effect-"));
  const outside = path.join(root, "outside");
  const linked = path.join(root, "linked");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, linked);
  try {
    await assert.rejects(
      startModelArkEffectReceiver({
        host: "127.0.0.1",
        port: 0,
        filePath: path.join(linked, "deliveries.json"),
      }),
      /store directory is not owner-controlled/,
    );
    await assert.rejects(readFile(path.join(outside, "deliveries.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
