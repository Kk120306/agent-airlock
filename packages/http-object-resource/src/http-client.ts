import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { ResourceLifecycleError } from "@agent-airlock/transactional-resource-sdk";

export interface BoundedHttpClientOptions {
  baseUrl: string;
  timeoutMs: number;
  maximumResponseBytes: number;
  socketPath?: string;
  fetcher?: typeof fetch;
}

export class BoundedHttpClient {
  private readonly baseUrl: URL;

  constructor(private readonly options: BoundedHttpClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
      throw new Error("HTTP object provider requires an http or https base URL");
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 10) {
      throw new Error("HTTP object provider timeout must be at least 10 milliseconds");
    }
    if (
      !Number.isInteger(options.maximumResponseBytes) ||
      options.maximumResponseBytes < 1024
    ) {
      throw new Error("HTTP object provider response limit must be at least 1024 bytes");
    }
  }

  async request<T>(
    stage: ResourceLifecycleError["stage"],
    route: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (this.options.socketPath) {
      return this.requestOverSocket<T>(stage, route, init);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timeout.unref();
    try {
      const response = await (this.options.fetcher ?? fetch)(new URL(route, this.baseUrl), {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
      if (!response.ok) {
        throw lifecycleError(
          stage,
          response.status >= 500 ? "provider-unavailable" : "invalid-input",
          response.status >= 500,
          "HTTP object provider rejected the bounded request",
        );
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) {
        throw lifecycleError(
          stage,
          "capability-mismatch",
          false,
          "HTTP object provider returned a non-JSON response",
        );
      }
      const bytes = await readBoundedBody(
        response,
        this.options.maximumResponseBytes,
        stage,
      );
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      } catch (error) {
        throw lifecycleError(
          stage,
          "capability-mismatch",
          false,
          "HTTP object provider returned malformed JSON",
          error,
        );
      }
    } catch (error) {
      if (error instanceof ResourceLifecycleError) throw error;
      if (controller.signal.aborted) {
        throw lifecycleError(
          stage,
          "timeout",
          true,
          "HTTP object provider request timed out",
          error,
        );
      }
      throw lifecycleError(
        stage,
        "provider-unavailable",
        true,
        "HTTP object provider is unavailable",
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestOverSocket<T>(
    stage: ResourceLifecycleError["stage"],
    route: string,
    init: RequestInit,
  ): Promise<T> {
    const target = new URL(route, this.baseUrl);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    headers.accept = "application/json";
    const body = typeof init.body === "string" ? init.body : null;
    if (body !== null) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    return new Promise<T>((resolve, reject) => {
      const request = (target.protocol === "https:" ? requestHttps : requestHttp)(
        {
          socketPath: this.options.socketPath,
          path: target.pathname + target.search,
          method: init.method ?? "GET",
          headers,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            response.resume();
            reject(
              lifecycleError(
                stage,
                status >= 500 ? "provider-unavailable" : "invalid-input",
                status >= 500,
                "HTTP object provider rejected the bounded request",
              ),
            );
            return;
          }
          const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
          if (!contentType.startsWith("application/json")) {
            response.resume();
            reject(
              lifecycleError(
                stage,
                "capability-mismatch",
                false,
                "HTTP object provider returned a non-JSON response",
              ),
            );
            return;
          }
          const declaredLength = Number(response.headers["content-length"]);
          if (
            Number.isFinite(declaredLength) &&
            declaredLength > this.options.maximumResponseBytes
          ) {
            response.destroy();
            reject(
              lifecycleError(
                stage,
                "response-too-large",
                false,
                "HTTP object provider response exceeded its byte limit",
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > this.options.maximumResponseBytes) {
              response.destroy();
              reject(
                lifecycleError(
                  stage,
                  "response-too-large",
                  false,
                  "HTTP object provider response exceeded its byte limit",
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
            } catch (error) {
              reject(
                lifecycleError(
                  stage,
                  "capability-mismatch",
                  false,
                  "HTTP object provider returned malformed JSON",
                  error,
                ),
              );
            }
          });
          response.once("error", (error) => {
            reject(
              lifecycleError(
                stage,
                "provider-unavailable",
                true,
                "HTTP object provider is unavailable",
                error,
              ),
            );
          });
        },
      );
      request.setTimeout(this.options.timeoutMs, () => {
        request.destroy(
          lifecycleError(
            stage,
            "timeout",
            true,
            "HTTP object provider request timed out",
          ),
        );
      });
      request.once("error", (error) => {
        reject(
          error instanceof ResourceLifecycleError
            ? error
            : lifecycleError(
                stage,
                "provider-unavailable",
                true,
                "HTTP object provider is unavailable",
                error,
              ),
        );
      });
      if (body !== null) request.write(body);
      request.end();
    });
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  stage: ResourceLifecycleError["stage"],
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw lifecycleError(
      stage,
      "response-too-large",
      false,
      "HTTP object provider response exceeded its byte limit",
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw lifecycleError(
        stage,
        "response-too-large",
        false,
        "HTTP object provider response exceeded its byte limit",
      );
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function lifecycleError(
  stage: ResourceLifecycleError["stage"],
  code: ResourceLifecycleError["code"],
  retryable: boolean,
  safeSummary: string,
  cause?: unknown,
): ResourceLifecycleError {
  return new ResourceLifecycleError({
    stage,
    code,
    retryable,
    safeSummary,
    cause,
  });
}
