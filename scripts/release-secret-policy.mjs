import { runTrustedGitSync } from "./trusted-git-exec.mjs";

const maximumReachableObjectListBytes = 32 * 1024 * 1024;
const maximumReachableObjectCount = 100_000;
const maximumReachableObjectBytes = 16 * 1024 * 1024;
const maximumReachableObjectContentBytes = 128 * 1024 * 1024;
const maximumBatchHeaderBytesPerObject = 160;

const syntheticSecretAllowlist = Object.freeze([
  "ark-11111111-2222-3333-4444-555555555555-test1",
]);

const highConfidenceSecretDefinitions = Object.freeze([
  Object.freeze({
    name: "OpenAI-style secret",
    pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/g,
  }),
  Object.freeze({
    name: "Volcengine access key",
    pattern: /\bAKLT[A-Za-z0-9]{16,}\b/g,
  }),
  Object.freeze({
    name: "ModelArk API key",
    pattern:
      /\bark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9]{5,}\b/gi,
    allowlist: syntheticSecretAllowlist,
  }),
  Object.freeze({
    name: "private key block",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]{16,}\r?\n)+-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    historyPattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n(?:[ +\-][A-Za-z0-9+/=]{16,}\r?\n)+[ +\-]-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  }),
]);

function clonePattern(pattern) {
  return new RegExp(pattern.source, pattern.flags);
}

function containsUnapprovedMatch(content, definition, history) {
  const pattern = clonePattern(
    history && definition.historyPattern
      ? definition.historyPattern
      : definition.pattern,
  );
  const allowed = new Set(definition.allowlist ?? []);
  for (const match of content.matchAll(pattern)) {
    if (!allowed.has(match[0])) return true;
  }
  return false;
}

export function highConfidenceSecretFindings(content, { history = false } = {}) {
  if (typeof content !== "string") return [];
  return highConfidenceSecretDefinitions
    .filter((definition) =>
      containsUnapprovedMatch(content, definition, history),
    )
    .map((definition) => definition.name);
}

function failClosedHistoryScan(reason) {
  const error = new Error("Git history could not be scanned safely: " + reason);
  error.code = "RELEASE_HISTORY_SCAN_FAILED";
  throw error;
}

function outputBuffer(result, operation) {
  const output = Buffer.isBuffer(result) ? result : Buffer.from(result ?? "");
  if (output.length === 0 && operation !== "object-list") {
    failClosedHistoryScan(operation + " returned no output");
  }
  return output;
}

function parseReachableObjectIds(output) {
  if (output.length > maximumReachableObjectListBytes) {
    failClosedHistoryScan("reachable object list exceeded its byte bound");
  }
  if (output.length === 0) return [];
  if (output.at(-1) !== 0x0a) {
    failClosedHistoryScan("reachable object list was truncated");
  }

  const lines = output.toString("ascii").split("\n");
  lines.pop();
  if (lines.length > maximumReachableObjectCount) {
    failClosedHistoryScan("reachable object count exceeded its bound");
  }

  const expectedWidth = lines[0]?.length;
  const seen = new Set();
  for (const objectId of lines) {
    if (
      (expectedWidth !== 40 && expectedWidth !== 64) ||
      objectId.length !== expectedWidth ||
      !/^[0-9a-f]+$/.test(objectId) ||
      seen.has(objectId)
    ) {
      failClosedHistoryScan("reachable object list was malformed");
    }
    seen.add(objectId);
  }
  return lines;
}

function nextBatchHeader(output, offset) {
  const newline = output.indexOf(0x0a, offset);
  if (
    newline === -1 ||
    newline - offset <= 0 ||
    newline - offset > maximumBatchHeaderBytesPerObject
  ) {
    failClosedHistoryScan("raw object header was malformed or oversized");
  }
  return {
    header: output.subarray(offset, newline).toString("ascii"),
    nextOffset: newline + 1,
  };
}

function scanRawReachableObjects(output, objectIds) {
  const findings = new Set();
  let contentBytes = 0;
  let offset = 0;

  for (const expectedObjectId of objectIds) {
    const { header, nextOffset } = nextBatchHeader(output, offset);
    const match =
      /^([0-9a-f]{40}|[0-9a-f]{64}) (blob|commit|tag|tree) ([0-9]+)$/.exec(
        header,
      );
    if (!match || match[1] !== expectedObjectId) {
      failClosedHistoryScan("raw object stream did not match its object list");
    }

    const size = Number(match[3]);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > maximumReachableObjectBytes
    ) {
      failClosedHistoryScan("a reachable object exceeded its byte bound");
    }
    contentBytes += size;
    if (contentBytes > maximumReachableObjectContentBytes) {
      failClosedHistoryScan("reachable object content exceeded its total byte bound");
    }

    const contentEnd = nextOffset + size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      failClosedHistoryScan("raw object stream was truncated or malformed");
    }
    const content = output.subarray(nextOffset, contentEnd).toString("utf8");
    for (const secretName of highConfidenceSecretFindings(content)) {
      findings.add(secretName);
    }
    offset = contentEnd + 1;
  }

  if (offset !== output.length) {
    failClosedHistoryScan("raw object stream contained unexpected trailing data");
  }
  return [...findings];
}

export function highConfidenceReachableGitObjectFindings(
  projectRoot,
  { runGitSync = runTrustedGitSync } = {},
) {
  let objectListOutput;
  try {
    objectListOutput = outputBuffer(
      runGitSync(
        ["rev-list", "--objects", "--all", "--no-object-names"],
        {
          cwd: projectRoot,
          encoding: "buffer",
          maxBuffer: maximumReachableObjectListBytes,
        },
      ),
      "object-list",
    );
  } catch (error) {
    if (error?.code === "RELEASE_HISTORY_SCAN_FAILED") throw error;
    failClosedHistoryScan("reachable object enumeration failed");
  }

  const objectIds = parseReachableObjectIds(objectListOutput);
  if (objectIds.length === 0) return [];

  const input = Buffer.from(objectIds.join("\n") + "\n", "ascii");
  const maximumBatchOutputBytes =
    maximumReachableObjectContentBytes +
    objectIds.length * maximumBatchHeaderBytesPerObject;
  let batchOutput;
  try {
    batchOutput = outputBuffer(
      runGitSync(["cat-file", "--batch"], {
        cwd: projectRoot,
        encoding: "buffer",
        input,
        maxBuffer: maximumBatchOutputBytes,
      }),
      "raw object scan",
    );
  } catch (error) {
    if (error?.code === "RELEASE_HISTORY_SCAN_FAILED") throw error;
    failClosedHistoryScan("raw object scan failed or exceeded its byte bound");
  }

  return scanRawReachableObjects(batchOutput, objectIds);
}
