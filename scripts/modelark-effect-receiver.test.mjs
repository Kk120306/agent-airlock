import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
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

async function postDelivery(url, request) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": request.idempotencyKey,
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
    const firstResponse = await postDelivery(receiver.url, request);
    const secondResponse = await postDelivery(receiver.url, request);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    const first = await firstResponse.json();
    const second = await secondResponse.json();
    assert.deepEqual(second, first);
    assert.equal(first.receipt.idempotencyKey, request.idempotencyKey);
    assert.equal(first.receipt.destination, "demo-console");
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.deliveries.length, 1);

    await receiver.close();
    receiver = await startModelArkEffectReceiver({
      host: "127.0.0.1",
      port: 0,
      filePath,
    });
    const replayResponse = await postDelivery(receiver.url, request);
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
    const response = await postDelivery(receiver.url, request);
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
    const failed = await postDelivery(receiver.url, request);
    assert.equal(failed.status, 503);
    assert.equal(
      JSON.parse(await readFile(filePath, "utf8")).deliveries.length,
      0,
    );

    const retried = await postDelivery(receiver.url, request);
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
