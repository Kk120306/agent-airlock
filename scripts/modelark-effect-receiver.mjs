import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const deliveryPath = "/v1/effects/demo-console";
const identityPath = deliveryPath + "/identity";
const healthPath = "/health";
const maximumRequestBytes = 16 * 1024;
const safeIdentifierPattern = /^[A-Za-z0-9._-]{1,64}$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function commitment(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function validateDeliveryRequest(value, idempotencyKey) {
  if (
    !hasExactKeys(value, ["schema", "schemaVersion", "runId", "intent"]) ||
    value.schema !== "agent-airlock/external-action-delivery-request" ||
    value.schemaVersion !== 1 ||
    !safeIdentifierPattern.test(value.runId ?? "") ||
    !hasExactKeys(value.intent, [
      "id",
      "type",
      "destination",
      "subject",
      "body",
      "payloadHash",
    ]) ||
    !safeIdentifierPattern.test(value.intent.id ?? "") ||
    value.intent.type !== "demo.notification.requested" ||
    value.intent.destination !== "demo-console" ||
    typeof value.intent.subject !== "string" ||
    value.intent.subject.trim() !== value.intent.subject ||
    value.intent.subject.length < 1 ||
    value.intent.subject.length > 120 ||
    typeof value.intent.body !== "string" ||
    value.intent.body.length < 1 ||
    value.intent.body.length > 1_000 ||
    !sha256Pattern.test(value.intent.payloadHash ?? "") ||
    !sha256Pattern.test(idempotencyKey ?? "")
  ) {
    throw new Error("invalid delivery request");
  }
  const normalizedPayload = JSON.stringify({
    destination: value.intent.destination,
    subject: value.intent.subject,
    body: value.intent.body,
  });
  const expectedPayloadHash = commitment(normalizedPayload);
  const expectedIdempotencyKey = commitment(
    [
      value.runId,
      value.intent.id,
      value.intent.type,
      normalizedPayload,
    ].join("\0"),
  );
  if (
    value.intent.payloadHash !== expectedPayloadHash ||
    idempotencyKey !== expectedIdempotencyKey
  ) {
    throw new Error("delivery commitments do not match");
  }
  return value;
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maximumRequestBytes) {
      throw new Error("request is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sameReceiptRequest(receipt, request) {
  return (
    receipt.runId === request.runId &&
    receipt.intentId === request.intent.id &&
    receipt.type === request.intent.type &&
    receipt.destination === request.intent.destination &&
    receipt.subject === request.intent.subject &&
    receipt.payloadHash === request.intent.payloadHash
  );
}

function isFiniteTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validatePersistedReceipt(receipt) {
  if (
    !hasExactKeys(receipt, [
      "idempotencyKey",
      "runId",
      "intentId",
      "type",
      "destination",
      "subject",
      "payloadHash",
      "deliveredAt",
    ]) ||
    !sha256Pattern.test(receipt.idempotencyKey ?? "") ||
    !safeIdentifierPattern.test(receipt.runId ?? "") ||
    !safeIdentifierPattern.test(receipt.intentId ?? "") ||
    receipt.type !== "demo.notification.requested" ||
    receipt.destination !== "demo-console" ||
    typeof receipt.subject !== "string" ||
    receipt.subject.trim() !== receipt.subject ||
    receipt.subject.length < 1 ||
    receipt.subject.length > 120 ||
    !sha256Pattern.test(receipt.payloadHash ?? "") ||
    !isFiniteTimestamp(receipt.deliveredAt)
  ) {
    throw new Error("ModelArk effect receiver store contains invalid evidence");
  }
}

export async function startModelArkEffectReceiver({
  host,
  port,
  filePath,
  persistenceOperations = {},
}) {
  const storeDirectory = path.dirname(filePath);
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  const directoryStatus = await lstat(storeDirectory);
  if (
    !directoryStatus.isDirectory() ||
    directoryStatus.isSymbolicLink() ||
    (directoryStatus.mode & 0o077) !== 0 ||
    (typeof process.geteuid === "function" &&
      directoryStatus.uid !== process.geteuid())
  ) {
    throw new Error(
      "ModelArk effect receiver store directory is not owner-controlled",
    );
  }
  let database;
  let databaseNeedsCommit = false;
  if (await exists(filePath)) {
    const status = await lstat(filePath);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      (status.mode & 0o077) !== 0 ||
      (typeof process.geteuid === "function" && status.uid !== process.geteuid())
    ) {
      throw new Error("ModelArk effect receiver store is not a regular file");
    }
    database = JSON.parse(await readFile(filePath, "utf8"));
    const isLegacyDatabase =
      hasExactKeys(database, ["schemaVersion", "deliveries"]) &&
      database.schemaVersion === 1 &&
      Array.isArray(database.deliveries);
    const isCurrentDatabase =
      hasExactKeys(database, ["schemaVersion", "consumerId", "deliveries"]) &&
      database.schemaVersion === 2 &&
      uuidV4Pattern.test(database.consumerId ?? "") &&
      Array.isArray(database.deliveries);
    if (!isLegacyDatabase && !isCurrentDatabase) {
      throw new Error("ModelArk effect receiver store is malformed");
    }
    const keys = new Set();
    for (const receipt of database.deliveries) {
      validatePersistedReceipt(receipt);
      if (keys.has(receipt.idempotencyKey)) {
        throw new Error("ModelArk effect receiver store contains a duplicate");
      }
      keys.add(receipt.idempotencyKey);
    }
    if (isLegacyDatabase) {
      database = {
        schemaVersion: 2,
        consumerId: randomUUID(),
        deliveries: database.deliveries,
      };
      databaseNeedsCommit = true;
    }
  } else {
    database = {
      schemaVersion: 2,
      consumerId: randomUUID(),
      deliveries: [],
    };
    databaseNeedsCommit = true;
  }

  let queue = Promise.resolve();
  async function persist(nextDatabase) {
    const temporary = filePath + "." + randomUUID() + ".tmp";
    try {
      await writeFile(
        temporary,
        JSON.stringify(nextDatabase, null, 2) + "\n",
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
      await persistenceOperations.beforeCommit?.({ temporary, filePath });
      await rename(temporary, filePath);
    } catch (error) {
      await unlink(temporary).catch((cleanupError) => {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      });
      throw error;
    }
  }
  if (databaseNeedsCommit) await persist(database);

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === healthPath) {
        sendJson(response, 200, {
          ok: true,
          service: "agent-airlock-modelark-effect-receiver",
        });
        return;
      }
      if (request.method === "GET" && request.url === identityPath) {
        sendJson(response, 200, {
          schema: "agent-airlock/external-action-consumer-identity",
          schemaVersion: 1,
          deliveryMode: "idempotent-http",
          consumerId: database.consumerId,
        });
        return;
      }
      if (request.method !== "POST" || request.url !== deliveryPath) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      if (
        request.headers["x-agent-airlock-consumer-id"] !== database.consumerId
      ) {
        sendJson(response, 409, { error: "consumer identity conflict" });
        return;
      }
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string") {
        sendJson(response, 400, { error: "invalid delivery request" });
        return;
      }
      let decoded;
      try {
        decoded = JSON.parse(await readRequestBody(request));
      } catch {
        sendJson(response, 400, { error: "invalid delivery request" });
        return;
      }
      let validated;
      try {
        validated = validateDeliveryRequest(decoded, idempotencyKey);
      } catch {
        sendJson(response, 400, { error: "invalid delivery request" });
        return;
      }
      const operation = queue.then(async () => {
        const existing = database.deliveries.find(
          (delivery) => delivery.idempotencyKey === idempotencyKey,
        );
        if (existing) {
          if (!sameReceiptRequest(existing, validated)) {
            return { conflict: true };
          }
          return { receipt: existing };
        }
        const receipt = {
          idempotencyKey,
          runId: validated.runId,
          intentId: validated.intent.id,
          type: validated.intent.type,
          destination: validated.intent.destination,
          subject: validated.intent.subject,
          payloadHash: validated.intent.payloadHash,
          deliveredAt: new Date().toISOString(),
        };
        const nextDatabase = {
          schemaVersion: 2,
          consumerId: database.consumerId,
          deliveries: [...database.deliveries, receipt],
        };
        await persist(nextDatabase);
        database = nextDatabase;
        return { receipt };
      });
      queue = operation.then(
        () => undefined,
        () => undefined,
      );
      let result;
      try {
        result = await operation;
      } catch {
        sendJson(response, 503, { error: "delivery unavailable" });
        return;
      }
      if (result.conflict) {
        sendJson(response, 409, { error: "idempotency conflict" });
        return;
      }
      sendJson(response, 200, {
        schema: "agent-airlock/external-action-delivery-receipt",
        schemaVersion: 1,
        accepted: true,
        receipt: result.receipt,
      });
    })().catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "receiver failure" });
      } else {
        response.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new Error("ModelArk effect receiver did not bind a TCP port");
  }

  return {
    url: `http://${host}:${address.port}${deliveryPath}`,
    identityUrl: `http://${host}:${address.port}${identityPath}`,
    async close() {
      await queue;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
