#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const maximumHealthBytes = 4 * 1024;
const maximumDocumentBytes = 1024 * 1024;
const minimumApplicationScriptBytes = 100_000;
const maximumApplicationScriptBytes = 8 * 1024 * 1024;
const requestTimeoutMilliseconds = 5_000;

function mimeEssence(value) {
  return String(value ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

export class ProductionImageVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProductionImageVerificationError";
  }
}

function verifiedOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProductionImageVerificationError(
      "Production image origin is invalid",
    );
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "::1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ProductionImageVerificationError(
      "Production image verification requires a loopback HTTP origin",
    );
  }
  return url;
}

async function request(origin, pathname, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(new URL(pathname, origin), {
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    });
  } catch {
    throw new ProductionImageVerificationError(
      `Production image request failed: ${pathname}`,
    );
  }
  if (response?.status !== 200) {
    throw new ProductionImageVerificationError(
      `Production image did not return exact HTTP 200: ${pathname}`,
    );
  }
  return response;
}

async function readBoundedBytes(response, maximumBytes, label) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    throw new ProductionImageVerificationError(
      `${label} exceeds its verification boundary`,
    );
  }
  if (!response.body) {
    throw new ProductionImageVerificationError(`${label} has no response body`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ProductionImageVerificationError(
          `${label} exceeds its verification boundary`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedText(response, maximumBytes, label) {
  const bytes = await readBoundedBytes(response, maximumBytes, label);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProductionImageVerificationError(`${label} is not valid UTF-8`);
  }
}

function applicationScriptPath(document, origin) {
  const scriptTags = document.match(/<script\b[^>]*>/gi) ?? [];
  for (const tag of scriptTags) {
    const source = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    const type = tag.match(/\btype=["']([^"']+)["']/i)?.[1];
    if (!source || type !== "module") continue;
    let url;
    try {
      url = new URL(source, origin);
    } catch {
      continue;
    }
    if (
      url.origin === origin.origin &&
      url.pathname.startsWith("/assets/") &&
      url.pathname.endsWith(".js") &&
      !url.search &&
      !url.hash
    ) {
      return url.pathname;
    }
  }
  throw new ProductionImageVerificationError(
    "Production image document has no same-origin module application script",
  );
}

export async function verifyProductionImageHttp({
  origin: rawOrigin,
  fetchImpl = fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new ProductionImageVerificationError(
      "Production image verifier requires a fetch implementation",
    );
  }
  const origin = verifiedOrigin(rawOrigin);
  const healthResponse = await request(origin, "/api/health", fetchImpl);
  if (
    mimeEssence(healthResponse.headers.get("content-type")) !==
      "application/json"
  ) {
    throw new ProductionImageVerificationError(
      "Production image health response is not JSON",
    );
  }
  let health;
  try {
    health = JSON.parse(
      await readBoundedText(
        healthResponse,
        maximumHealthBytes,
        "Production image health response",
      ),
    );
  } catch (error) {
    if (error instanceof ProductionImageVerificationError) throw error;
    throw new ProductionImageVerificationError(
      "Production image health response is invalid JSON",
    );
  }
  if (
    health === null ||
    typeof health !== "object" ||
    Array.isArray(health) ||
    JSON.stringify(Object.keys(health).sort()) !==
      JSON.stringify(["ok", "service"]) ||
    health.ok !== true ||
    health.service !== "volc-agent-launchpad"
  ) {
    throw new ProductionImageVerificationError(
      "Production image health response has the wrong service identity",
    );
  }

  const documentResponse = await request(origin, "/", fetchImpl);
  if (
    mimeEssence(documentResponse.headers.get("content-type")) !== "text/html"
  ) {
    throw new ProductionImageVerificationError(
      "Production image root response is not HTML",
    );
  }
  const document = await readBoundedText(
    documentResponse,
    maximumDocumentBytes,
    "Production image document",
  );
  if (!document.includes("<title>Agent Airlock</title>")) {
    throw new ProductionImageVerificationError(
      "Production image document has the wrong title",
    );
  }
  if (!document.includes('<div id="root"></div>')) {
    throw new ProductionImageVerificationError(
      "Production image document has no React mount point",
    );
  }
  const scriptPath = applicationScriptPath(document, origin);
  const scriptResponse = await request(origin, scriptPath, fetchImpl);
  if (
    !["application/javascript", "text/javascript"].includes(
      mimeEssence(scriptResponse.headers.get("content-type")),
    )
  ) {
    throw new ProductionImageVerificationError(
      "Production image application asset is not JavaScript",
    );
  }
  const scriptBytes = await readBoundedBytes(
    scriptResponse,
    maximumApplicationScriptBytes,
    "Production image application asset",
  );
  if (scriptBytes.byteLength < minimumApplicationScriptBytes) {
    throw new ProductionImageVerificationError(
      "Production image application asset is unexpectedly small",
    );
  }
  return {
    healthService: health.service,
    scriptPath,
    scriptBytes: scriptBytes.byteLength,
  };
}

function parseOriginArgument(argumentsList) {
  if (
    argumentsList.length !== 2 ||
    argumentsList[0] !== "--origin" ||
    !argumentsList[1]
  ) {
    throw new ProductionImageVerificationError(
      "Usage: node scripts/production-image-verifier.mjs --origin http://127.0.0.1:<port>",
    );
  }
  return argumentsList[1];
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await verifyProductionImageHttp({
    origin: parseOriginArgument(process.argv.slice(2)),
  });
  process.stdout.write(
    `Production image HTTP contract passed: ${result.healthService}, ${result.scriptPath}, ${result.scriptBytes} JavaScript bytes.\n`,
  );
}
