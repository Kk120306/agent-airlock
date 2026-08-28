import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 32_768;
const MAXIMUM_CONFIGURED_MODELS = 4;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TRANSIENT_RATE_LIMIT_CODES = new Set([
  "ServerOverloaded",
  "RequestBurstTooFast",
]);
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 3_000, 7_000];
const MAXIMUM_RETRY_AFTER_MS = 10_000;
const MAXIMUM_TOTAL_RETRY_DELAY_MS = 15_000;
const MODELARK_PREFLIGHT_PROOF_SCHEMA =
  "agent-airlock/modelark-preflight-proof";

function requiredValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value || value.startsWith("replace-")) {
    throw new Error(`${name} is required for the live ModelArk preflight`);
  }
  return value;
}

function responsesUrl(rawBaseUrl) {
  const url = new URL(rawBaseUrl);
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
  if (url.protocol !== "https:" && !loopback.has(url.hostname)) {
    throw new Error("ARK_BASE_URL must use HTTPS unless it targets loopback");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/responses")) {
    url.pathname += "/responses";
  }
  return url;
}

async function boundedText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("ModelArk preflight response exceeded the safety limit");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function providerMessage(status, errorCode = null) {
  if (status === 401) {
    return "ModelArk authentication failed with HTTP 401. Verify the Ark API key, region, and model configuration.";
  }
  if (status === 404) {
    return "ModelArk returned HTTP 404. Verify that the configured model is activated and available in the selected region.";
  }
  if (status === 429) {
    if (errorCode && TRANSIENT_RATE_LIMIT_CODES.has(errorCode)) {
      return "ModelArk returned HTTP 429 after a bounded warm-up because provider capacity or burst protection is temporarily unavailable. Keep Free Credits Only Mode enabled and retry later.";
    }
    return "ModelArk returned HTTP 429 because the configured inference limit or free quota is unavailable. Keep Free Credits Only Mode enabled and retry later, or configure another operator-approved model that visibly has remaining free quota.";
  }
  return `ModelArk preflight failed with HTTP ${status}. Provider response details were withheld to protect account metadata.`;
}

function configuredModels(environment) {
  const primaryModel = requiredValue(environment, "ARK_MODEL");
  const fallbackModels = (environment.ARK_MODEL_FALLBACKS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const models = [...new Set([primaryModel, ...fallbackModels])];
  if (models.length > MAXIMUM_CONFIGURED_MODELS) {
    throw new Error(
      `ARK_MODEL and ARK_MODEL_FALLBACKS may configure at most ${MAXIMUM_CONFIGURED_MODELS} unique models`,
    );
  }
  for (const model of models) {
    if (!MODEL_PATTERN.test(model)) {
      throw new Error("ARK_MODEL configuration contains unsupported characters");
    }
  }
  return models;
}

async function requestModel({
  apiKey,
  endpoint,
  fetchImplementation,
  model,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: "Reply with exactly OK.",
        max_output_tokens: 64,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`ModelArk preflight timed out after ${timeoutMs} ms`);
    }
    throw new Error(`ModelArk preflight could not reach ${endpoint.origin}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await boundedText(response);
  if (!response.ok) {
    return { response, payload: null, errorCode: safeProviderErrorCode(raw) };
  }
  if (!raw) {
    throw new Error("ModelArk preflight returned an empty response");
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("ModelArk preflight returned malformed JSON");
  }
  return { response, payload, errorCode: null };
}

function safeProviderErrorCode(raw) {
  try {
    const payload = JSON.parse(raw);
    const code = payload?.error?.code ?? payload?.code;
    return typeof code === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(code)
      ? code
      : null;
  } catch {
    return null;
  }
}

function hasGeneratedAssistantOutput(payload) {
  if (!Array.isArray(payload?.output)) return false;
  return payload.output.some(
    (item) =>
      item?.type === "message" &&
      item?.role === "assistant" &&
      Array.isArray(item.content) &&
      item.content.some(
        (content) =>
          content?.type === "output_text" &&
          typeof content.text === "string" &&
          content.text.trim().length > 0,
      ),
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response, retry) {
  const fallbackDelay = TRANSIENT_RETRY_DELAYS_MS[retry];
  const retryAfter = response.headers.get("retry-after")?.trim() ?? "";
  if (!/^\d+$/.test(retryAfter)) return fallbackDelay;
  const providerDelay = Number(retryAfter) * 1_000;
  if (!Number.isSafeInteger(providerDelay)) return fallbackDelay;
  return Math.min(
    Math.max(fallbackDelay, providerDelay),
    MAXIMUM_RETRY_AFTER_MS,
  );
}

export async function checkModelArkLive({
  environment = process.env,
  fetchImplementation = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delayImplementation = wait,
} = {}) {
  const apiKey = requiredValue(environment, "ARK_API_KEY");
  const models = configuredModels(environment);
  const endpoint = responsesUrl(
    environment.ARK_BASE_URL?.trim() ||
      "https://ark.cn-beijing.volces.com/api/v3",
  );
  let requestCount = 0;
  let totalRetryDelayMs = 0;
  for (const [index, model] of models.entries()) {
    let requestResult;
    for (let retry = 0; ; retry += 1) {
      requestResult = await requestModel({
        apiKey,
        endpoint,
        fetchImplementation,
        model,
        timeoutMs,
      });
      requestCount += 1;
      const transient =
        requestResult.response.status === 429 &&
        requestResult.errorCode !== null &&
        TRANSIENT_RATE_LIMIT_CODES.has(requestResult.errorCode);
      if (!transient || retry >= TRANSIENT_RETRY_DELAYS_MS.length) break;
      const delay = Math.min(
        retryDelay(requestResult.response, retry),
        MAXIMUM_TOTAL_RETRY_DELAY_MS - totalRetryDelayMs,
      );
      if (delay <= 0) break;
      await delayImplementation(delay);
      totalRetryDelayMs += delay;
    }
    const { response, payload, errorCode } = requestResult;
    if (!response.ok) {
      const canTryFallback =
        (response.status === 404 || response.status === 429) &&
        index < models.length - 1;
      if (canTryFallback) continue;
      const prefix =
        index > 0
          ? `All ${index + 1} operator-approved ModelArk models were unavailable. `
          : "";
      throw new Error(`${prefix}${providerMessage(response.status, errorCode)}`);
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("ModelArk preflight returned an empty response");
    }
    if (payload.status !== "completed") {
      throw new Error(
        `ModelArk preflight did not complete successfully (status: ${String(payload.status ?? "missing")})`,
      );
    }
    if (!hasGeneratedAssistantOutput(payload)) {
      throw new Error(
        "ModelArk preflight completed without a non-empty assistant output. Verify that the configured model supports the Responses API.",
      );
    }
    return {
      origin: endpoint.origin,
      model,
      responseId:
        typeof payload.id === "string"
          ? payload.id.slice(0, 128)
          : "not-reported",
      attemptCount: index + 1,
      requestCount,
      retryDelayMs: totalRetryDelayMs,
    };
  }
  throw new Error("ModelArk preflight exhausted its configured models");
}

function commitment(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

export function buildModelArkPreflightProof(result, checkedAt = new Date()) {
  return {
    schema: MODELARK_PREFLIGHT_PROOF_SCHEMA,
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    generatedAssistantOutput: true,
    modelCommitment: commitment(result.model),
    endpointOriginCommitment: commitment(result.origin),
    attemptCount: result.attemptCount,
    requestCount: result.requestCount,
    retryDelayMs: result.retryDelayMs,
  };
}

async function main() {
  const result = await checkModelArkLive();
  if (process.argv.includes("--launch-result-json")) {
    process.stdout.write(
      JSON.stringify({
        selectedModel: result.model,
        proof: buildModelArkPreflightProof(result),
      }) + "\n",
    );
    return;
  }
  if (process.argv.includes("--selected-model-only")) {
    process.stdout.write(`${result.model}\n`);
    return;
  }
  console.log(
    `[modelark-preflight] Ready: ${result.model} generated a non-empty Responses API assistant output through ${result.origin}.`,
  );
  if (result.attemptCount > 1) {
    console.log(
      `[modelark-preflight] Selected an operator-approved fallback after ${result.attemptCount} bounded attempts.`,
    );
  }
  console.log(
    "[modelark-preflight] Credential value and model output were intentionally not printed.",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[modelark-preflight] ${error.message}`);
    process.exitCode = 1;
  });
}
